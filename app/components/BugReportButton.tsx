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
  const dialogRef = useRef<HTMLDialogElement>(null);

  // A native modal dialog traps focus, makes the page inert and restores focus to
  // the bug button on close(); Esc fires `cancel`, which we veto while sending.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!open || !dialog || dialog.open) return;
    dialog.showModal();
    descRef.current?.focus();
  }, [open]);

  /** Every way of closing (X, Cancel, backdrop, Esc) funnels through the dialog's `close` event. */
  const handleClose = () => {
    if (status !== "loading") dialogRef.current?.close();
  };

  const handleDialogClosed = () => {
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
      <button
        onClick={() => setOpen(true)}
        aria-label="Report a bug or faulty search"
        title="Report a bug"
        className="fixed bottom-[4.5rem] right-6 z-50 rounded-lg border border-border bg-surface-muted p-2.5 text-foreground shadow-sm backdrop-blur-sm transition-colors duration-200 hover:border-red-500/50 hover:bg-surface hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-background"
      >
        <BugAntIcon className="h-6 w-6" />
      </button>

      {open && (
        // Full-viewport dialog acting as its own backdrop, so a click on it (outside the card) closes.
        <dialog
          ref={dialogRef}
          aria-labelledby="bug-report-title"
          onCancel={(e) => status === "loading" && e.preventDefault()}
          onClose={handleDialogClosed}
          className="fixed inset-0 z-[60] m-0 hidden open:flex h-full max-h-none w-full max-w-none items-center justify-center border-0 bg-black/40 p-4 text-foreground backdrop-blur-sm backdrop:bg-transparent"
          onClick={(e) => e.target === e.currentTarget && handleClose()}
        >
          <div className="w-full max-w-lg rounded-xl border border-border bg-surface shadow-xl">
            <div className="flex items-center justify-between border-b border-border px-5 py-4">
              <div className="flex items-center gap-2">
                <BugAntIcon className="h-5 w-5 text-red-500" />
                <h2 id="bug-report-title" className="text-base font-semibold text-foreground">
                  Report a faulty search
                </h2>
              </div>
              <button
                onClick={handleClose}
                disabled={status === "loading"}
                aria-label="Close"
                className="rounded-md p-1 text-muted transition-colors hover:bg-surface-muted hover:text-foreground"
              >
                <XMarkIcon className="h-5 w-5" />
              </button>
            </div>

            {status === "success" ? (
              <div className="flex flex-col items-center gap-3 px-5 py-10 text-center">
                <span className="text-3xl">✓</span>
                <p className="text-sm font-medium text-foreground">
                  Report sent — thank you!
                </p>
              </div>
            ) : (
              <form onSubmit={handleSubmit} className="px-5 py-4 space-y-4">
                <div className="space-y-2 rounded-lg border border-border bg-surface-muted p-3 text-xs">
                  <div>
                    <span className="font-semibold text-muted">Your query: </span>
                    <span className="text-foreground">{userQuery}</span>
                  </div>
                  {scryfallQuery && (
                    <div>
                      <span className="font-semibold text-muted">Scryfall query: </span>
                      <span className="font-mono text-foreground">{scryfallQuery}</span>
                    </div>
                  )}
                </div>

                <div>
                  <label
                    htmlFor="bug-description"
                    className="mb-1.5 block text-sm font-medium text-foreground"
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
                    className="w-full resize-none rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground placeholder-muted focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
                  />
                </div>

                <div>
                  <label className="mb-1.5 block text-sm font-medium text-foreground">
                    Screenshot{" "}
                    <span className="font-normal text-muted">(optional, max 2 MB)</span>
                  </label>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      className="flex items-center gap-1.5 rounded-lg border border-border bg-surface px-3 py-1.5 text-sm text-foreground transition-colors hover:bg-surface-muted"
                    >
                      <PaperClipIcon className="h-4 w-4" />
                      {file ? "Change file" : "Attach image"}
                    </button>
                    {file && (
                      <span className="truncate text-xs text-muted max-w-[200px]">
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

                {status === "error" && (
                  <p className="rounded-md bg-red-50 px-3 py-2 text-xs text-red-600 dark:bg-red-900/20 dark:text-red-400">
                    {errorMsg}
                  </p>
                )}

                <div className="flex justify-end gap-2 pt-1">
                  <button
                    type="button"
                    onClick={handleClose}
                    disabled={status === "loading"}
                    className="rounded-lg border border-border px-4 py-2 text-sm text-foreground transition-colors hover:bg-surface-muted disabled:opacity-50"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={status === "loading" || !description.trim()}
                    className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {status === "loading" ? "Sending…" : "Send report"}
                  </button>
                </div>
              </form>
            )}
          </div>
        </dialog>
      )}
    </>
  );
}
