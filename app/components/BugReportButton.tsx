"use client";

import { useEffect, useRef, useState } from "react";
import { BugAntIcon, XMarkIcon, PaperClipIcon } from "@heroicons/react/24/outline";

const MAX_FILE_BYTES = 2 * 1024 * 1024; // 2 MB

type Props = {
  userQuery: string;
  scryfallQuery: string;
};

type Status = "idle" | "loading" | "success" | "error";

export default function BugReportButton({ userQuery, scryfallQuery }: Props) {
  const [open, setOpen] = useState(false);
  const [description, setDescription] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [errorMsg, setErrorMsg] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const descRef = useRef<HTMLTextAreaElement>(null);

  // Focus description when modal opens
  useEffect(() => {
    if (open) {
      setTimeout(() => descRef.current?.focus(), 50);
    }
  }, [open]);

  // Auto-close after success
  useEffect(() => {
    if (status === "success") {
      const t = setTimeout(() => {
        setOpen(false);
        setStatus("idle");
        setDescription("");
        setFile(null);
        setFileError("");
      }, 2500);
      return () => clearTimeout(t);
    }
  }, [status]);

  // Close modal on Escape
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") handleClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open]);

  const handleClose = () => {
    if (status === "loading") return;
    setOpen(false);
    setStatus("idle");
    setDescription("");
    setFile(null);
    setFileError("");
    setErrorMsg("");
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const picked = e.target.files?.[0] ?? null;
    setFileError("");
    if (!picked) {
      setFile(null);
      return;
    }
    if (!picked.type.startsWith("image/")) {
      setFileError("Only image files are accepted.");
      setFile(null);
      e.target.value = "";
      return;
    }
    if (picked.size > MAX_FILE_BYTES) {
      setFileError("Screenshot must be 2 MB or smaller.");
      setFile(null);
      e.target.value = "";
      return;
    }
    setFile(picked);
  };

  const toBase64 = (f: File): Promise<string> =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = reject;
      reader.readAsDataURL(f);
    });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!description.trim()) return;

    setStatus("loading");
    setErrorMsg("");

    try {
      const screenshot = file ? await toBase64(file) : undefined;

      const res = await fetch("/api/report-bug", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description, userQuery, scryfallQuery, screenshot }),
      });

      const data = await res.json();
      if (!res.ok) {
        setErrorMsg(data.error || "Something went wrong. Please try again.");
        setStatus("error");
        return;
      }

      setStatus("success");
    } catch {
      setErrorMsg("Failed to connect. Please try again.");
      setStatus("error");
    }
  };

  if (!userQuery) return null;

  return (
    <>
      {/* Floating trigger button */}
      <button
        onClick={() => setOpen(true)}
        aria-label="Report a bug or faulty search"
        title="Report a bug"
        className="fixed bottom-[4.5rem] right-6 z-50 rounded-lg border border-gray-300 bg-gray-100/80 p-2 text-gray-700 shadow-sm backdrop-blur-sm transition-all duration-200 hover:border-red-400/60 hover:bg-gray-200/80 hover:shadow dark:border-gray-700/80 dark:bg-gray-900/60 dark:text-gray-300 dark:hover:border-red-500/60 dark:hover:bg-gray-800/80"
      >
        <BugAntIcon className="h-6 w-6" />
      </button>

      {/* Modal */}
      {open && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm"
          onClick={(e) => e.target === e.currentTarget && handleClose()}
        >
          <div className="w-full max-w-lg rounded-xl border border-gray-200 bg-white shadow-xl dark:border-gray-700 dark:bg-gray-900">
            {/* Header */}
            <div className="flex items-center justify-between border-b border-gray-200 px-5 py-4 dark:border-gray-700">
              <div className="flex items-center gap-2">
                <BugAntIcon className="h-5 w-5 text-red-500" />
                <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">
                  Report a faulty search
                </h2>
              </div>
              <button
                onClick={handleClose}
                disabled={status === "loading"}
                aria-label="Close"
                className="rounded-md p-1 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-800 dark:hover:text-gray-300"
              >
                <XMarkIcon className="h-5 w-5" />
              </button>
            </div>

            {status === "success" ? (
              <div className="flex flex-col items-center gap-3 px-5 py-10 text-center">
                <span className="text-3xl">✓</span>
                <p className="text-sm font-medium text-gray-700 dark:text-gray-300">
                  Report sent — thank you!
                </p>
              </div>
            ) : (
              <form onSubmit={handleSubmit} className="px-5 py-4 space-y-4">
                {/* Read-only query info */}
                <div className="space-y-2 rounded-lg border border-gray-200 bg-gray-50 p-3 text-xs dark:border-gray-700 dark:bg-gray-800/60">
                  <div>
                    <span className="font-semibold text-gray-500 dark:text-gray-400">Your query: </span>
                    <span className="text-gray-800 dark:text-gray-200">{userQuery}</span>
                  </div>
                  {scryfallQuery && (
                    <div>
                      <span className="font-semibold text-gray-500 dark:text-gray-400">Scryfall query: </span>
                      <span className="font-mono text-gray-800 dark:text-gray-200">{scryfallQuery}</span>
                    </div>
                  )}
                </div>

                {/* Description */}
                <div>
                  <label
                    htmlFor="bug-description"
                    className="mb-1.5 block text-sm font-medium text-gray-700 dark:text-gray-300"
                  >
                    Describe the issue <span className="text-red-500">*</span>
                  </label>
                  <textarea
                    id="bug-description"
                    ref={descRef}
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    required
                    rows={4}
                    placeholder="What did you search for, and what did you expect vs. what you got?"
                    className="w-full resize-none rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 placeholder-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100 dark:placeholder-gray-500 dark:focus:border-blue-400 dark:focus:ring-blue-400"
                  />
                </div>

                {/* Screenshot */}
                <div>
                  <label className="mb-1.5 block text-sm font-medium text-gray-700 dark:text-gray-300">
                    Screenshot{" "}
                    <span className="font-normal text-gray-400 dark:text-gray-500">(optional, max 2 MB)</span>
                  </label>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      className="flex items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-700 transition-colors hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700"
                    >
                      <PaperClipIcon className="h-4 w-4" />
                      {file ? "Change file" : "Attach image"}
                    </button>
                    {file && (
                      <span className="truncate text-xs text-gray-500 dark:text-gray-400 max-w-[200px]">
                        {file.name}
                      </span>
                    )}
                  </div>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={handleFileChange}
                  />
                  {fileError && (
                    <p className="mt-1 text-xs text-red-500">{fileError}</p>
                  )}
                </div>

                {/* Submit error */}
                {status === "error" && (
                  <p className="rounded-md bg-red-50 px-3 py-2 text-xs text-red-600 dark:bg-red-900/20 dark:text-red-400">
                    {errorMsg}
                  </p>
                )}

                {/* Actions */}
                <div className="flex justify-end gap-2 pt-1">
                  <button
                    type="button"
                    onClick={handleClose}
                    disabled={status === "loading"}
                    className="rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-700 transition-colors hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={status === "loading" || !description.trim()}
                    className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-blue-500 dark:hover:bg-blue-600"
                  >
                    {status === "loading" ? "Sending…" : "Send report"}
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}
    </>
  );
}
