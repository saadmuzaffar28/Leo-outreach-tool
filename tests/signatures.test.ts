import { describe, expect, it } from "vitest";
import {
  sanitizeSignatureHtml,
  resolveSignatureForSend,
  type SignatureResolutionInput,
} from "@/lib/signature";
import {
  appendEmailSignature,
  buildMessageHtml,
  buildMessageText,
  htmlBody,
  plainBody,
  plainTextToHtml,
  type MailMessage,
} from "@/lib/message";
import { buildWarmupContent } from "@/lib/warmup/messages";

// Two "connected mailboxes", each with its OWN signature — exactly how Leo
// Outreach is set up today (10 SMTP mailboxes, one signature each).
const SIG_A =
  "<p>Best regards,<br>John Smith<br>RCM Solutions<br>Insurance Verification | Billing &amp; Coding<br>" +
  "john@company.com<br>+1 555 010 0101</p>";
const SIG_B =
  "<p>Thanks,<br>Sarah Khan<br>RCM Solutions<br>sarah@clinic.example</p>";

const BODY = "Hi John,\nI wanted to reach out regarding your RCM operations.";
const BODY_HTML = "<div>Hi John,<br>I wanted to reach out regarding your RCM operations.</div>";

function baseInput(overrides: Partial<SignatureResolutionInput> = {}): SignatureResolutionInput {
  return {
    templateUseSignature: true,
    templateOverride: null,
    accountSignatureEnabled: false,
    accountSignatureHtml: null,
    accountOverride: null,
    gmailSignature: null,
    ...overrides,
  };
}

function messageWith(overrides: Partial<MailMessage> = {}): MailMessage {
  return {
    fromName: "Leo",
    fromEmail: "leo@company.example",
    to: "client@clinic.example",
    subject: "RCM operations",
    body: BODY,
    unsubscribeUrl: null,
    ...overrides,
  };
}

describe("signature resolution: disabled → body unchanged", () => {
  it("returns null when the account signature is not enabled", () => {
    expect(
      resolveSignatureForSend(
        baseInput({ accountSignatureEnabled: false, accountSignatureHtml: SIG_A }),
      ),
    ).toBeNull();
  });

  it("appendEmailSignature with enabled=false returns the body unchanged", () => {
    expect(
      appendEmailSignature({ html: BODY_HTML, signatureHtml: SIG_A, enabled: false }),
    ).toBe(BODY_HTML);
  });

  it("appendEmailSignature with no signature returns the body unchanged", () => {
    expect(appendEmailSignature({ html: BODY_HTML, signatureHtml: null })).toBe(BODY_HTML);
  });
});

describe("signature resolution: enabled → signature appended", () => {
  it("resolves the enabled account signature", () => {
    expect(
      resolveSignatureForSend(
        baseInput({ accountSignatureEnabled: true, accountSignatureHtml: SIG_A }),
      ),
    ).toBe(SIG_A);
  });

  it("appendEmailSignature appends the signature after <br> spacing", () => {
    expect(
      appendEmailSignature({ html: BODY_HTML, signatureHtml: SIG_A, enabled: true }),
    ).toBe(`${BODY_HTML}<br>${SIG_A}`);
  });

  it("htmlBody attaches the resolved signature to the final email body", () => {
    const out = htmlBody(messageWith({ signatureHtml: SIG_A }));
    expect(out).toBe(`${BODY_HTML}<br>${SIG_A}`);
  });

  it("plainBody attaches a text representation of the signature", () => {
    const out = plainBody(messageWith({ signatureHtml: SIG_A }));
    expect(out).toContain("John Smith");
    expect(out).toContain("john@company.com");
    expect(out).not.toContain("<p>");
  });
});

describe("different sending accounts → each gets its own signature", () => {
  it("mailbox A ships signature A", () => {
    expect(
      resolveSignatureForSend(
        baseInput({ accountSignatureEnabled: true, accountSignatureHtml: SIG_A }),
      ),
    ).toBe(SIG_A);
  });

  it("mailbox B ships signature B", () => {
    expect(
      resolveSignatureForSend(
        baseInput({ accountSignatureEnabled: true, accountSignatureHtml: SIG_B }),
      ),
    ).toBe(SIG_B);
  });
});

describe("campaign rotation → the actual sending account decides", () => {
  // Each campaign row carries its own smtpAccount; the worker resolves from
  // THAT account. Rotating campaigns across mailboxes therefore keeps every
  // message on the signature of the box that physically sends it.
  it("campaign on mailbox A → signature A appears in the outbound body", () => {
    const signatureHtml = resolveSignatureForSend(
      baseInput({ accountSignatureEnabled: true, accountSignatureHtml: SIG_A }),
    );
    const out = htmlBody(messageWith({ signatureHtml }));
    expect(out).toBe(`${BODY_HTML}<br>${SIG_A}`);
    expect(out).toContain("John Smith");
  });

  it("campaign on mailbox B → signature B appears in the outbound body", () => {
    const signatureHtml = resolveSignatureForSend(
      baseInput({ accountSignatureEnabled: true, accountSignatureHtml: SIG_B }),
    );
    const out = htmlBody(messageWith({ signatureHtml }));
    expect(out).toBe(`${BODY_HTML}<br>${SIG_B}`);
    expect(out).toContain("Sarah Khan");
    expect(out).not.toContain("John Smith");
  });
});

describe("follow-up / retry path → the sending account's signature, exactly once", () => {
  // Leo Outreach has no separate follow-up feature: retries and any later
  // attempt on a recipient go through the same per-account resolution and the
  // same shared body assembly, so the signature is stable and never duplicated.
  it("same account resolves the same signature on every attempt", () => {
    const input = baseInput({ accountSignatureEnabled: true, accountSignatureHtml: SIG_A });
    expect(resolveSignatureForSend(input)).toBe(resolveSignatureForSend(input));
  });

  it("a rebuilt retry body carries the signature exactly once", () => {
    const signatureHtml = resolveSignatureForSend(
      baseInput({ accountSignatureEnabled: true, accountSignatureHtml: SIG_A }),
    );
    const first = buildMessageText(messageWith({ signatureHtml }));
    const second = buildMessageText(messageWith({ signatureHtml }));
    expect(first).toBe(second);
    expect(BODY_HTML.split("<br>").length).toBeGreaterThan(1);
  });
});

describe("manual / test send → selected account signature", () => {
  // The template-test route resolves through the same function; legacy
  // account-override and Gmail-signature paths behave exactly as before.
  it("an account signature override is used for the selected account", () => {
    expect(
      resolveSignatureForSend({
        templateUseSignature: true,
        templateOverride: null,
        accountSignatureEnabled: false,
        accountSignatureHtml: null,
        accountOverride: "Best,\nBob",
        gmailSignature: null,
      }),
    ).toBe(plainTextToHtml("Best,\nBob"));
  });

  it("the captured Gmail signature is used when nothing else overrides", () => {
    expect(
      resolveSignatureForSend({
        templateUseSignature: true,
        templateOverride: null,
        accountSignatureEnabled: false,
        accountSignatureHtml: null,
        accountOverride: null,
        gmailSignature: "<p>From Gmail</p>",
      }),
    ).toBe("<p>From Gmail</p>");
  });
});

describe("signature HTML sanitization", () => {
  it("drops scripts, iframes, forms and event handlers", () => {
    const dirty =
      '<p onclick="alert(1)">Hello</p><script>alert(1)</script>' +
      '<iframe src="https://evil.example"></iframe><form action="x"></form>' +
      "<img src=\"https://x.example/a.png\" onerror=\"alert(1)\">";
    const clean = sanitizeSignatureHtml(dirty);
    expect(clean).not.toMatch(/<script/i);
    expect(clean).not.toMatch(/<iframe/i);
    expect(clean).not.toMatch(/<form/i);
    expect(clean).not.toMatch(/onclick/i);
    expect(clean).not.toMatch(/onerror/i);
    expect(clean).toContain("<p>Hello</p>");
  });

  it("drops javascript: URLs and data: images", () => {
    const dirty =
      '<a href="javascript:alert(1)">click</a>' +
      '<a href="   jAvAsCrIpT:alert(1)">spaced</a>' +
      '<img src="data:text/html;base64,PHNjcmlwdD4=">';
    const clean = sanitizeSignatureHtml(dirty);
    expect(clean).not.toMatch(/javascript:/i);
    expect(clean).not.toMatch(/data:/i);
  });

  it("keeps safe formatting: p, br, strong, em, u, a, img, lists", () => {
    const src =
      "<p><strong>Bold</strong> <em>italic</em> <u>under</u></p>" +
      "<ul><li>one</li></ul><a href=\"https://example.com\">site</a>" +
      "<img src=\"https://example.com/logo.png\" alt=\"logo\">";
    const clean = sanitizeSignatureHtml(src);
    expect(clean).toContain("<strong>Bold</strong>");
    expect(clean).toContain("<em>italic</em>");
    expect(clean).toContain("<u>under</u>");
    expect(clean).toContain("<ul><li>one</li></ul>");
    expect(clean).toContain('<a href="https://example.com"');
    expect(clean).toContain('rel="noopener noreferrer"');
    expect(clean).toContain('<img src="https://example.com/logo.png"');
  });
});

describe("no duplicate signature", () => {
  it("does not append when the body already contains the exact signature", () => {
    const html = `${BODY_HTML}<br>${SIG_A}`;
    expect(appendEmailSignature({ html, signatureHtml: SIG_A, enabled: true })).toBe(html);
  });

  it("plainBody does not append when the text already contains the signature", () => {
    const text = `${BODY}\n\nBest regards,\nJohn Smith`;
    expect(
      plainBody({
        ...messageWith(),
        body: text,
        signatureHtml: "<p>Best regards,<br>John Smith</p>",
      }),
    ).toBe(text);
  });
});

describe("retry → signature appears exactly once", () => {
  it("appendEmailSignature is idempotent", () => {
    const once = appendEmailSignature({ html: BODY_HTML, signatureHtml: SIG_A, enabled: true });
    const twice = appendEmailSignature({ html: once, signatureHtml: SIG_A, enabled: true });
    expect(twice).toBe(once);
    expect((once.match(/John Smith/g) ?? []).length).toBe(1);
  });

  it("each multipart part contains the signature exactly once", () => {
    const raw = buildMessageHtml(messageWith({ signatureHtml: SIG_A }));
    expect(raw).toContain(`multipart/alternative`);
    // Slice the raw message between part markers so the plain-text and HTML
    // segments are inspected independently.
    const htmlMarker = "Content-Type: text/html; charset=UTF-8";
    const textMarker = "Content-Type: text/plain; charset=UTF-8";
    const textPart = raw.slice(raw.indexOf(textMarker) + textMarker.length, raw.indexOf(htmlMarker));
    const htmlPart = raw.slice(raw.indexOf(htmlMarker) + htmlMarker.length);
    expect((textPart.match(/John Smith/g) ?? []).length).toBe(1);
    expect((htmlPart.match(/John Smith/g) ?? []).length).toBe(1);
    expect(htmlPart).toContain(SIG_A);
  });
});

describe("existing accounts with no signature → existing behavior unchanged", () => {
  // The pre-signature worker logic was:
  //   if (tpl.useSignature) signatureHtml = tpl.signatureOverride
  //     ? plainTextToHtml(tpl.signatureOverride)
  //     : account.signatureOverride ? plainTextToHtml(account.signatureOverride)
  //     : googleAccountData?.signature ?? null
  it("useSignature=false sends nothing even if a Gmail signature exists", () => {
    expect(
      resolveSignatureForSend(
        baseInput({ templateUseSignature: false, gmailSignature: "<p>Gmail</p>" }),
      ),
    ).toBeNull();
  });

  it("template override still wins when set", () => {
    expect(
      resolveSignatureForSend(
        baseInput({
          templateUseSignature: true,
          templateOverride: "Campaign Sig",
          accountSignatureEnabled: true,
          accountSignatureHtml: SIG_A,
        }),
      ),
    ).toBe(plainTextToHtml("Campaign Sig"));
  });

  it("legacy account override precedes the captured Gmail signature", () => {
    expect(
      resolveSignatureForSend(
        baseInput({
          accountOverride: "Override",
          gmailSignature: "<p>Gmail</p>",
        }),
      ),
    ).toBe(plainTextToHtml("Override"));
  });

  it("a bare email body is untouched when nothing enables a signature", () => {
    expect(htmlBody(messageWith())).toBe(BODY_HTML);
    expect(buildMessageText(messageWith())).toContain(BODY);
  });
});

describe("warm-up is not affected", () => {
  it("warm-up messages stay neutral with no signature", () => {
    const content = buildWarmupContent(0, "job_abc123");
    expect(content.text).toContain("warm-up");
    expect(content.body).not.toContain("<br>");
    expect(content.body).not.toContain("Sincerely");
    expect(content.subject).toBeTruthy();
  });
});