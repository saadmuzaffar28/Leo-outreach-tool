// Builds RFC-2822 messages and encodes them for the Gmail API. No secrets here.

export interface MailMessage {
  fromName: string;
  fromEmail: string;
  to: string;
  subject: string;
  body: string;
  unsubscribeUrl: string | null;
  signatureHtml?: string | null;
}

/** RFC 2047-encode non-ASCII header values (subject, display name). */
export function encodeHeaderValue(value: string): string {
  if (/[^\x00-\x7F]/.test(value)) {
    return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
  }
  return value;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function decodeEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'");
}

/** Crude HTML → plain text so plain-text clients still see the signature. */
export function stripHtmlToText(html: string): string {
  let s = html.replace(/<style[\s\S]*?<\/style>/gi, " ");
  s = s.replace(/<script[\s\S]*?<\/script>/gi, " ");
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<\/p>/gi, "\n\n");
  s = s.replace(/<\/div>/gi, "\n");
  s = s.replace(/<\/tr>/gi, "\n");
  s = s.replace(/<[^>]+>/g, "");
  s = decodeEntities(s);
  return s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function plainBody(message: MailMessage): string {
  const text = message.body.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const sig =
    message.signatureHtml && message.signatureHtml.trim() !== ""
      ? stripHtmlToText(message.signatureHtml)
      : "";
  return sig ? `${text}\n\n${sig}` : text;
}

function htmlBody(message: MailMessage): string {
  const escaped = escapeHtml(message.body.replace(/\r\n/g, "\n").replace(/\r/g, "\n")).replace(
    /\n/g,
    "<br>",
  );
  const sig = message.signatureHtml ?? "";
  return `<div>${escaped}</div>${sig ? `<br>${sig}` : ""}`;
}

/** Exported for Graph (Microsoft Outlook) sends. */
export { plainBody, htmlBody };

/** Converts a plain-text signature (from a template) into safe HTML. */
export function plainTextToHtml(value: string): string {
  return escapeHtml(value.replace(/\r\n/g, "\n").replace(/\r/g, "\n")).replace(/\n/g, "<br>");
}

/** Plain-text body (with stripped signature) used by buildMessageText. */
export function buildMessageText(msg: MailMessage): string {
  const headers: string[] = [];
  if (msg.fromName) {
    headers.push(`From: ${encodeHeaderValue(msg.fromName)} <${msg.fromEmail}>`);
  } else {
    headers.push(`From: ${msg.fromEmail}`);
  }
  headers.push(`To: <${msg.to}>`);
  headers.push(`Subject: ${encodeHeaderValue(msg.subject)}`);
  headers.push(`MIME-Version: 1.0`);
  headers.push(`Content-Type: text/plain; charset=UTF-8`);
  headers.push(`Content-Transfer-Encoding: 8bit`);
  if (msg.unsubscribeUrl) {
    headers.push(`List-Unsubscribe: <${msg.unsubscribeUrl}>`);
    headers.push(`List-Unsubscribe-Post: List-Unsubscribe=One-Click`);
  }
  headers.push("", plainBody(msg));
  return headers.join("\r\n");
}

/** Multipart/alternative message (text + HTML) — used when a signature exists. */
export function buildMessageHtml(msg: MailMessage): string {
  const boundary = `_sb_${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
  const headers: string[] = [];
  if (msg.fromName) {
    headers.push(`From: ${encodeHeaderValue(msg.fromName)} <${msg.fromEmail}>`);
  } else {
    headers.push(`From: ${msg.fromEmail}`);
  }
  headers.push(`To: <${msg.to}>`);
  headers.push(`Subject: ${encodeHeaderValue(msg.subject)}`);
  headers.push(`MIME-Version: 1.0`);
  headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
  if (msg.unsubscribeUrl) {
    headers.push(`List-Unsubscribe: <${msg.unsubscribeUrl}>`);
    headers.push(`List-Unsubscribe-Post: List-Unsubscribe=One-Click`);
  }
  headers.push("");
  headers.push(`--${boundary}`);
  headers.push(`Content-Type: text/plain; charset=UTF-8`);
  headers.push(`Content-Transfer-Encoding: 8bit`);
  headers.push("");
  headers.push(plainBody(msg));
  headers.push(`--${boundary}`);
  headers.push(`Content-Type: text/html; charset=UTF-8`);
  headers.push(`Content-Transfer-Encoding: 8bit`);
  headers.push("");
  headers.push(htmlBody(msg));
  headers.push(`--${boundary}--`);
  return headers.join("\r\n");
}

/** base64url (websafe, no padding) as required by the Gmail API. */
export function toBase64Url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

export function buildRawMessage(msg: MailMessage): string {
  const withSignature = msg.signatureHtml && msg.signatureHtml.trim() !== "";
  return toBase64Url(withSignature ? buildMessageHtml(msg) : buildMessageText(msg));
}