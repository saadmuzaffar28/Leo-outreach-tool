import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { env } from "@/lib/env";

const algorithm = "aes-256-gcm";

function deriveKey(): Buffer {
  return createHash("sha256").update(env.TOKEN_ENCRYPTION_KEY).digest();
}

/** Encrypts a string with AES-256-GCM. Output format: iv:authTag:ciphertext (hex). */
export function encrypt(plaintext: string): string {
  const iv = randomBytes(12);
  const key = deriveKey();
  const cipher = createCipheriv(algorithm, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv.toString("hex"), authTag.toString("hex"), ciphertext.toString("hex")].join(":");
}

/** Decrypts a value produced by {@link encrypt}. Throws on invalid data/tampering. */
export function decrypt(payload: string): string {
  const [ivHex, tagHex, dataHex] = payload.split(":");
  if (!ivHex || !tagHex || !dataHex) throw new Error("Malformed encrypted payload");
  const iv = Buffer.from(ivHex, "hex");
  const authTag = Buffer.from(tagHex, "hex");
  const data = Buffer.from(dataHex, "hex");
  const key = deriveKey();
  const decipher = createDecipheriv(algorithm, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}