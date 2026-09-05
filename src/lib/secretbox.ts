// Authenticated encryption for secrets held in the database.
//
// Integration credentials - an ERP service account that can write to a general
// ledger - must be enterable in the admin console, so they must be stored.
// Plaintext in a JSON column would mean any read of that row, any backup, any
// logged query discloses them.
//
// Three properties this deliberately has, beyond "it encrypts":
//
//   BOUND      Each ciphertext is bound with AAD to the integration it belongs
//              to. An attacker with database write access cannot move the M3
//              credentials into the PSA row and have them decrypt.
//   FAIL-CLOSED  A blob that is present but unreadable is reported as
//              `unreadable`, never as `absent`. Conflating the two turns
//              tampering, a wrong key or a botched rotation into a silent
//              "no credentials configured" - and, worse, lets the next save
//              overwrite secrets it could not read.
//   TAMPER-EVIDENT  GCM, so flipping bits to change a stored endpoint to one
//              the attacker controls fails the tag rather than decrypting.
//
// This is a small local wrapper, not a key-management system. It does not
// protect against a compromised application process, and it cannot prevent
// rollback (restoring an older valid blob). For a deployment that warrants
// those, envelope-encrypt with a managed KMS - AWS KMS, GCP KMS, Azure Key
// Vault or Vault Transit - and keep the master key out of the app environment.

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12; // 96 bits, the GCM standard
const TAG_BYTES = 16;
// v2 introduced AAD binding. Bumped rather than reused so a pre-AAD blob
// reports "unsupported version" - which is actionable - instead of
// "authentication failed", which looks like tampering.
const VERSION = "v2";
const PURPOSE = "amreceipts:integration-secrets";

// Bounds on what will be decoded, so a hostile row cannot make us allocate
// arbitrarily. Integration credentials are a few hundred bytes.
const MAX_CIPHERTEXT_BYTES = 64 * 1024;
const MAX_PLAINTEXT_BYTES = 64 * 1024;

const BASE64URL = /^[A-Za-z0-9_-]+$/;
// Longest envelope segment we will even attempt to decode. Checked BEFORE
// Buffer.from, so a hostile row cannot force a large allocation just to be
// rejected afterwards.
const MAX_SEGMENT_CHARS = Math.ceil((MAX_CIPHERTEXT_BYTES * 4) / 3) + 4;

/** Base64url is only canonical if re-encoding the decode reproduces it. */
function decodeCanonical(segment: string): Buffer | null {
  const buf = Buffer.from(segment, "base64url");
  return buf.toString("base64url") === segment ? buf : null;
}

export type OpenResult<T> =
  | { status: "ok"; value: T }
  /** Nothing was stored. */
  | { status: "absent" }
  /** Something IS stored and could not be read. Never treat as absent. */
  | { status: "unreadable"; reason: string };

export class SecretboxError extends Error {}

// Derived once. Reading process.env per call meant a key could change under a
// running process, making earlier ciphertext undecryptable halfway through a
// request, and it multiplied the number of key-bearing buffers in memory.
let cachedKey: Buffer | null = null;

function key(): Buffer {
  if (cachedKey) return cachedKey;

  const explicit = process.env.CONFIG_ENCRYPTION_KEY;
  if (explicit) {
    if (!/^[0-9a-fA-F]{64}$/.test(explicit)) {
      throw new SecretboxError("CONFIG_ENCRYPTION_KEY must be exactly 64 hex characters (32 bytes)");
    }
    cachedKey = Buffer.from(explicit, "hex");
    return cachedKey;
  }

  // Refused in production. The derivation below is a convenience for local and
  // test use; in production it would tie credential secrecy to the
  // session-signing secret, so rotating one silently destroys the other.
  if (process.env.NODE_ENV === "production") {
    throw new SecretboxError(
      "CONFIG_ENCRYPTION_KEY is required in production to store integration secrets",
    );
  }

  const fallback = process.env.AUTH_SECRET;
  if (!fallback) {
    throw new SecretboxError("Set CONFIG_ENCRYPTION_KEY (or AUTH_SECRET) to store integration secrets");
  }
  // HKDF with a purpose string, so this key cannot coincide with any other use
  // of AUTH_SECRET even though it is derived from it.
  cachedKey = Buffer.from(hkdfSync("sha256", Buffer.from(fallback), Buffer.alloc(0), PURPOSE, 32));
  return cachedKey;
}

/** Additional authenticated data: version, purpose and the owning record. */
function aad(context: string): Buffer {
  return Buffer.from(`${VERSION}|${PURPOSE}|${context}`, "utf8");
}

/**
 * Encrypt a JSON-serialisable value, bound to `context`.
 *
 * `context` must identify the record this belongs to - the integration key -
 * so the result cannot be transplanted onto a different row.
 */
export function seal(value: unknown, context: string): string {
  if (!context) throw new SecretboxError("seal requires a context to bind to");

  const json = JSON.stringify(value);
  if (json === undefined) throw new SecretboxError("seal cannot serialise this value");
  const plaintext = Buffer.from(json, "utf8");
  if (plaintext.length > MAX_PLAINTEXT_BYTES) throw new SecretboxError("Value is too large to seal");

  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key(), iv);
  cipher.setAAD(aad(context));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [VERSION, iv.toString("base64url"), tag.toString("base64url"), ciphertext.toString("base64url")].join(".");
}

/**
 * Decrypt a sealed value bound to `context`.
 *
 * Distinguishes absent from unreadable on purpose: the caller must be able to
 * refuse to proceed when credentials exist but cannot be read, rather than
 * quietly behaving as though none were configured.
 */
export function open<T = unknown>(sealed: string | null | undefined, context: string): OpenResult<T> {
  if (sealed === null || sealed === undefined || sealed === "") return { status: "absent" };

  const parts = sealed.split(".");
  if (parts.length !== 4) return { status: "unreadable", reason: "malformed envelope" };
  if (parts[0] !== VERSION) return { status: "unreadable", reason: `unsupported version ${parts[0]}` };
  if (!parts.slice(1).every((p) => BASE64URL.test(p))) {
    return { status: "unreadable", reason: "invalid encoding" };
  }
  // Size is checked on the ENCODED text, before decoding allocates anything.
  if (parts.some((p) => p.length > MAX_SEGMENT_CHARS)) {
    return { status: "unreadable", reason: "envelope too large" };
  }

  // Canonical, not merely well-charactered: Buffer.from is lenient about
  // padding and trailing bits, so two different strings can decode to the same
  // bytes. Insisting on a round-trip removes that ambiguity.
  const iv = decodeCanonical(parts[1]);
  const tag = decodeCanonical(parts[2]);
  const ciphertext = decodeCanonical(parts[3]);
  if (!iv || !tag || !ciphertext) return { status: "unreadable", reason: "non-canonical encoding" };
  if (iv.length !== IV_BYTES) return { status: "unreadable", reason: "bad iv length" };
  if (tag.length !== TAG_BYTES) return { status: "unreadable", reason: "bad tag length" };
  if (ciphertext.length > MAX_CIPHERTEXT_BYTES) return { status: "unreadable", reason: "ciphertext too large" };

  let k: Buffer;
  try {
    k = key();
  } catch (e) {
    // A missing or malformed key must not take down a page that merely renders
    // "is this configured". seal() still throws, so writes stay loud.
    return { status: "unreadable", reason: e instanceof Error ? e.message : "key unavailable" };
  }

  try {
    const decipher = createDecipheriv(ALGORITHM, k, iv);
    decipher.setAAD(aad(context));
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    // The generic is only a TypeScript assertion; callers validate the shape.
    return { status: "ok", value: JSON.parse(plaintext.toString("utf8")) as T };
  } catch {
    // A failed tag, a wrong key, and a blob bound to another record are all
    // reported identically - none should tell a caller which it was.
    return { status: "unreadable", reason: "authentication failed" };
  }
}

/** Test seam: forget the derived key so a changed env var takes effect. */
export function resetKeyCacheForTests(): void {
  cachedKey = null;
}
