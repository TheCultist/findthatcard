import { NextRequest, NextResponse } from "next/server";
import { Resend } from "resend";

const resend = new Resend(process.env.RESEND_API_KEY);

const RECIPIENT = "findthatcard@thecultist.it";
const SENDER = "FindThatCard Bug Reports <findthatcard@thecultist.it>";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { description, userQuery, scryfallQuery, screenshot } = body as {
      description: string;
      userQuery: string;
      scryfallQuery: string;
      screenshot?: string; // base64 data URI
    };

    if (!description?.trim()) {
      return NextResponse.json({ error: "Description is required." }, { status: 400 });
    }

    const attachments: { filename: string; content: string }[] = [];
    if (screenshot) {
      // strip "data:image/...;base64," prefix
      const match = screenshot.match(/^data:(image\/\w+);base64,(.+)$/);
      if (match) {
        const ext = match[1].split("/")[1];
        attachments.push({ filename: `screenshot.${ext}`, content: match[2] });
      }
    }

    const html = `
      <h2>FindThatCard — Bug Report</h2>
      <table cellpadding="6" cellspacing="0" style="border-collapse:collapse;font-family:monospace;font-size:14px;">
        <tr>
          <td style="font-weight:bold;vertical-align:top;padding-right:16px;white-space:nowrap;">User query</td>
          <td style="border:1px solid #ccc;padding:8px;background:#f9f9f9;">${escHtml(userQuery || "(none)")}</td>
        </tr>
        <tr>
          <td style="font-weight:bold;vertical-align:top;padding-right:16px;white-space:nowrap;">Scryfall query</td>
          <td style="border:1px solid #ccc;padding:8px;background:#f9f9f9;">${escHtml(scryfallQuery || "(none)")}</td>
        </tr>
        <tr>
          <td style="font-weight:bold;vertical-align:top;padding-right:16px;white-space:nowrap;">Description</td>
          <td style="border:1px solid #ccc;padding:8px;white-space:pre-wrap;">${escHtml(description)}</td>
        </tr>
      </table>
      ${attachments.length > 0 ? "<p><em>Screenshot attached.</em></p>" : ""}
    `;

    const text = [
      "=== FindThatCard Bug Report ===",
      "",
      `User query:     ${userQuery || "(none)"}`,
      `Scryfall query: ${scryfallQuery || "(none)"}`,
      "",
      "Description:",
      description,
      attachments.length > 0 ? "\n[Screenshot attached]" : "",
    ].join("\n");

    const { error } = await resend.emails.send({
      from: SENDER,
      to: RECIPIENT,
      subject: `[Bug Report] ${(userQuery || "unknown query").slice(0, 60)}`,
      html,
      text,
      attachments,
    });

    if (error) {
      console.error("Resend error:", error);
      return NextResponse.json({ error: "Failed to send report." }, { status: 500 });
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("report-bug route error:", err);
    return NextResponse.json({ error: "Internal server error." }, { status: 500 });
  }
}

function escHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
