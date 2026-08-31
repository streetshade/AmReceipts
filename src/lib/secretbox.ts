// Authenticated encryption for secrets held in the database.
//
// Integration credentials - an ERP service account that can write to a general
// ledger - have to be enterable in the admin console, which means they have to
// be stored. Storing them in plaintext in a JSON column would mean any read of
// that row, any backup, any log of a query, discloses them.
//
// GCM rather than CBC so the ciphertext is tamper-evident: an attacker who can
// write to the database cannot flip bits to change the decrypted endpoint to
// one they control without the tag failing.

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12; // 96 bits, the GCM standard
const TAG_BYTES = 16;
const VERSION = "v1";

/**
 * The 32-byte key.
 *
 * A dedicated CONFIG_ENCRYPTION_KEY is preferred. Failing that we derive one
 * from AUTH_SECRET via HKDF, which keeps a single-secret deployment working -
 * at the cost of tying the two together: rotating AUTH_SECRET then makes every
 * stored integration secret undecryptable, and they must be re-entered. That
 * trade is stated here rather than discovered during an incident.
 */
function key(): Buffer {
  const explicit = process.env.CONFIG_ENCRYPTION_KEY;
  if (explicit) {
    const buf = Buffer.from(explicit, "hex");
    if (buf.length !== 32) {
      throw new Error("CONFIG_ENCRYPTION_KEY must be 32 bytes of hex (64 characters)");
    }
    return buf;
  }

  const fallback = process.env.AUTH_SECRET;
  if (!fallback) {
    throw new Error("Set CONFIG_ENCRYPTION_KEY (or AUTH_SECRET) to store integration secrets");
  }
  // Domain-separated so this key can never coincide with the session-signing
  // use of the same secret.
  return Buffer.from(hkdfSync("sha256", Buffer.from(fallback), Buffer.alloc(0), "amreceipts:integration-secrets", 32));
}

/** Encrypt a JSON-serialisable value. Returns "v1.<iv>.<tag>.<ciphertext>". */
export function seal(value: unknown): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key(), iv);
  const plaintext = Buffer.from(JSON.stringify(value), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString("base64url"), tag.toString("base64url"), ciphertext.toString("base64url")].join(".");
}

/** Decrypt a sealed value, or null if it is absent, malformed or tampered with. */
export function open<T = unknown>(sealed: string | null | undefined): T | null {
  if (!sealed) return null;
  const parts = sealed.split(".");
  if (parts.length !== 4 || parts[0] !== VERSION) return null;

  try {
    const iv = Buffer.from(parts[1], "base64url");
    const tag = Buffer.from(parts[2], "base64url");
    const ciphertext = Buffer.from(parts[3], "base64url");
    if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) return null;

    const decipher = createDecipheriv(ALGORITHM, key(), iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return JSON.parse(plaintext.toString("utf8")) as T;
  } catch {
    // A failed tag check is indistinguishable from a wrong key here, and that
    // is deliberate: neither should tell a caller which it was.
    return null;
  }
}

/** Constant-time comparison, for anywhere a stored secret is checked. */
export function secretEquals(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}
