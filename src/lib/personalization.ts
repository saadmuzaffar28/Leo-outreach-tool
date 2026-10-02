export interface TemplateVariables {
  first_name: string;
  last_name: string;
  email: string;
  practice_name: string;
}

export interface TemplateVariableDef {
  key: keyof TemplateVariables;
  label: string;
  description: string;
}

export const TEMPLATE_VARIABLES: TemplateVariableDef[] = [
  { key: "first_name", label: "{{first_name}}", description: "Lead's first name" },
  { key: "last_name", label: "{{last_name}}", description: "Lead's last name" },
  { key: "email", label: "{{email}}", description: "Lead's email address" },
  { key: "practice_name", label: "{{practice_name}}", description: "Practice / company name" },
];

const variableRegex = (key: string) => new RegExp(`\\{\\{\\s*${key}\\s*\\}\\}`, "gi");

/**
 * Replaces {{variable}} placeholders with per-lead values.
 * Unknown or empty values become a blank token (safe fallback string can be passed).
 */
export function personalize(template: string, values: Partial<TemplateVariables>, fallback = ""): string {
  let out = template;
  for (const def of TEMPLATE_VARIABLES) {
    const raw = values[def.key];
    const value = raw !== undefined && raw !== null && raw.trim() !== "" ? raw : fallback;
    out = out.replace(variableRegex(def.key), value);
  }
  return out;
}

/** Throws when a template references a variable outside the supported set. */
export function assertOnlySupportedVariables(template: string): void {
  const matches = template.match(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g) ?? [];
  const supported = new Set(TEMPLATE_VARIABLES.map((v) => `{{${v.key}}}`));
  for (const match of matches) {
    const key = match.toLowerCase();
    if (!supported.has(key)) {
      throw new Error(
        `Unsupported template variable: ${match}. Supported: ${Array.from(supported).join(", ")}`,
      );
    }
  }
}

export const SAMPLE_LEAD: TemplateVariables = {
  first_name: "Alex",
  last_name: "Rivera",
  email: "alex@example.com",
  practice_name: "Green Valley Family Practice",
};

/** Sample lead used for template previews and test emails. */
export const PREVIEW_LEAD: TemplateVariables = {
  first_name: "John",
  last_name: "Smith",
  email: "john@example.com",
  practice_name: "ABC Medical Group",
};

/**
 * After substituting supported variables, any remaining {{...}} tokens are
 * typos, unsupported variables, or malformed braces. Returns their raw form
 * so the caller can surface them to the user.
 */
export function findUnresolvedVariables(template: string): string[] {
  return Array.from(new Set(template.match(/\{\{\s*[\w]+\s*\}\}/g) ?? [])).sort();
}

/**
 * Validates template content the way the editor and campaign launch do.
 * Pure and unit-testable; returns a list of human-readable problems.
 */
export function validateTemplateContent(
  subject: string,
  body: string,
): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!subject.trim()) errors.push("Subject is required");
  if (!body.trim()) errors.push("Body is required");

  const combined = subject + "\n" + body;
  const opens = (combined.match(/\{\{\s*/g) ?? []).length;
  const closes = (combined.match(/\s*\}\}/g) ?? []).length;
  if (opens !== closes) errors.push("Template variables have unbalanced braces");

  try {
    assertOnlySupportedVariables(combined);
  } catch (err) {
    errors.push((err as Error).message);
  }

  const unresolved = findUnresolvedVariables(personalize(combined, PREVIEW_LEAD));
  if (unresolved.length > 0) {
    errors.push(`Unresolved variables: ${unresolved.join(", ")}`);
  }

  return { ok: errors.length === 0, errors };
}