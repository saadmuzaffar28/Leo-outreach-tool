import type { Prisma } from "@prisma/client";

export interface TemplateSnapshot {
  name: string;
  subject: string;
  body: string;
  useSignature: boolean;
  signatureOverride: string;
}

/** Shape of the template columns the snapshot is built from. */
export interface TemplateLike {
  name: string;
  subject: string;
  body: string;
  useSignature: boolean;
  signatureOverride: string | null;
}

export function snapshotFromTemplate(template: TemplateLike): TemplateSnapshot {
  return {
    name: template.name,
    subject: template.subject,
    body: template.body,
    useSignature: template.useSignature,
    signatureOverride: template.signatureOverride ?? "",
  };
}

function isSnapshot(value: unknown): value is TemplateSnapshot {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.name === "string" &&
    typeof v.subject === "string" &&
    typeof v.body === "string" &&
    typeof v.useSignature === "boolean" &&
    typeof v.signatureOverride === "string"
  );
}

export function parseTemplateSnapshot(
  value: Prisma.JsonValue | null | undefined,
): TemplateSnapshot | null {
  if (!isSnapshot(value)) return null;
  return value;
}

/**
 * Resolves the content a campaign sends: the immutable snapshot taken at
 * start wins; drafts without a snapshot fall back to the live template.
 */
export function campaignTemplateSource(campaign: {
  template: TemplateLike | null;
  templateSnapshot: Prisma.JsonValue | null;
}): TemplateSnapshot | null {
  const snap = parseTemplateSnapshot(campaign.templateSnapshot);
  if (snap) return snap;
  if (!campaign.template) return null;
  return snapshotFromTemplate(campaign.template);
}

export function campaignTemplateName(campaign: {
  template: { name: string } | null;
  templateSnapshot: Prisma.JsonValue | null;
}): string | null {
  const snap = parseTemplateSnapshot(campaign.templateSnapshot);
  return snap ? snap.name : campaign.template?.name ?? null;
}