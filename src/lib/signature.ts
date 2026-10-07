// Shared per-account email signature logic.
//
// One resolution function and one sanitizer are used by every sending path
// (campaign worker, template test sends) so the signature that ends up on an
// email can never drift between code paths. Warm-up is deliberately NOT wired
// through here: it generates its own neutral internal messages and never
// attaches a business signature.
//
// No secrets pass through this module: it only ever holds signature text.

import sanitizeHtml from "sanitize-html";
import { plainTextToHtml } from "@/lib/message";

/** Hard ceiling for a stored signature. Enforced in validation, API save, and sanitizer. */
export const SIGNATURE_MAX_LENGTH = 20_000;

/**
 * Strict allowlist sanitizer for signature HTML.
 *
 * The signature is user-authored rich text, so it is sanitized at SAVE time
 * (the authoritative gate) and again whenever the app renders it in the UI.
 * Scripts, javascript: URLs, event handlers, iframes, forms and other
 * executable markup are dropped; safe formatting (p, br, strong, em, u, a,
 * img, lists, tables, …) is preserved so emails keep their formatting and
 * remote images still work.
 */
export function sanitizeSignatureHtml(input: string): string {
  return sanitizeHtml(input || "", {
    allowedTags: [
      "p",
      "br",
      "b",
      "strong",
      "i",
      "em",
      "u",
      "s",
      "h1",
      "h2",
      "h3",
      "h4",
      "h5",
      "h6",
      "ul",
      "ol",
      "li",
      "blockquote",
      "hr",
      "div",
      "span",
      "a",
      "img",
      "table",
      "thead",
      "tbody",
      "tr",
      "th",
      "td",
      "sub",
      "sup",
      "code",
      "pre",
    ],
    allowedAttributes: {
      a: ["href", "title", "target", "rel", "name"],
      img: ["src", "alt", "title", "width", "height"],
      p: ["align"],
      div: ["align"],
      h1: ["align"],
      h2: ["align"],
      h3: ["align"],
      h4: ["align"],
      h5: ["align"],
      h6: ["align"],
      td: ["align", "colspan", "rowspan"],
      th: ["align", "colspan", "rowspan"],
      table: ["align", "width"],
    },
    allowedSchemes: ["http", "https", "mailto"],
    allowedSchemesAppliedToAttributes: ["href", "src"],
    allowedSchemesByTag: { img: ["http", "https"] },
    allowProtocolRelative: false,
    disallowedTagsMode: "discard",
    allowedStyles: {
      "*": {
        "text-align": [/^left$/, /^right$/, /^center$/, /^justify$/],
        "font-weight": [/^(bold|bolder)$/, /^[4-9]00$/],
        "font-style": [/^italic$/],
        "text-decoration": [/^underline$/],
      },
    },
    transformTags: {
      a: sanitizeHtml.simpleTransform("a", { rel: "noopener noreferrer" }, true),
    },
  })
    .trim()
    .slice(0, SIGNATURE_MAX_LENGTH);
}

export interface SignatureResolutionInput {
  /** Template-level "enable signature" flag (legacy campaign/template toggle). */
  templateUseSignature: boolean;
  /** Template-level plain-text signature override. */
  templateOverride: string | null;
  /** Per-account opt-in (SMTP accounts). When false the rich signature is ignored. */
  accountSignatureEnabled: boolean;
  /** Per-account rich HTML signature (already sanitized when saved). */
  accountSignatureHtml: string | null;
  /** Legacy plain-text account override (Google/Outlook accounts). */
  accountOverride: string | null;
  /** Rich signature captured from the connected Gmail account. */
  gmailSignature: string | null;
}

/**
 * Resolve which single signature applies to an outgoing email.
 *
 * Priority (first match wins, so an email never carries more than one):
 *   1. template-level override (legacy: wins whenever the template says so)
 *   2. enabled per-account rich signature (SMTP accounts, applies automatically)
 *   3. legacy account override (Google/Outlook)
 *   4. signature captured from Gmail settings
 *
 * Existing behaviour is preserved: with no account signature enabled and no
 * template override, resolution is byte-for-byte what the worker already did
 * (template override → account override → Gmail signature, all gated by
 * `templateUseSignature`).
 */
export function resolveSignatureForSend(input: SignatureResolutionInput): string | null {
  if (input.templateUseSignature && input.templateOverride?.trim()) {
    return plainTextToHtml(input.templateOverride.trim());
  }
  if (input.accountSignatureEnabled && input.accountSignatureHtml?.trim()) {
    return input.accountSignatureHtml.trim();
  }
  if (input.templateUseSignature && input.accountOverride?.trim()) {
    return plainTextToHtml(input.accountOverride.trim());
  }
  if (input.templateUseSignature && input.gmailSignature?.trim()) {
    return input.gmailSignature.trim();
  }
  return null;
}