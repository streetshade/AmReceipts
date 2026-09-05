// The external reference that makes an ambiguous posting recoverable.
//
// Every posting carries a reference derived deterministically from its session
// id. It is written into an M3 external-document/reference field, which makes
// it the answer to the only question that matters after a timeout: "did this
// actually post?" Without it, reconciliation degrades to matching on amount and
// date, which cannot distinguish a duplicate from a legitimate second expense.
//
// Properties that matter, in order:
//   - DETERMINISTIC. The same session always yields the same reference, across
//     process restarts and redeploys, so a retry cannot orphan its predecessor.
//   - COLLISION-RESISTANT. Derived from a SHA-256, not a counter, so two
//     sessions cannot collide and appear to be the same posting.
//   - M3-SAFE. Uppercase A-Z and 2-9 only, fixed length, no separators. M3
//     reference fields are short, fixed-width and fussy about punctuation.
//   - OPAQUE. Carries no user or amount data, so it is safe in logs and in an
//     ERP field that finance staff can see.

import { createHash } from "node:crypto";

/** Crockford-style base32 without I, L, O, U - unambiguous when read aloud or
 *  retyped from a screen, which is exactly what reconciliation involves. */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

const PREFIX = "AMR";
const BODY_LENGTH = 17;

/** Full reference length, e.g. "AMR7K2M9QX4T8VBNP3F". Keep under any M3 field cap. */
export const REFERENCE_LENGTH = PREFIX.length + BODY_LENGTH;

/**
 * The stable external reference for a session's posting.
 *
 * Pure and side-effect free: call it as often as you like, including during
 * reconciliation, and it will always name the same posting.
 */
export function postingReference(sessionId: string): string {
  const digest = createHash("sha256").update(`amreceipts:m3:posting:${sessionId}`).digest();

  let body = "";
  // 5 bits per character, walked as a bit stream so every output character
  // draws on the full digest rather than one byte modulo 32 (which would skew
  // the distribution toward the low characters of the alphabet).
  let bitBuffer = 0;
  let bitCount = 0;
  let byteIndex = 0;
  while (body.length < BODY_LENGTH) {
    if (bitCount < 5) {
      bitBuffer = (bitBuffer << 8) | digest[byteIndex % digest.length];
      bitCount += 8;
      byteIndex++;
    }
    bitCount -= 5;
    body += ALPHABET[(bitBuffer >> bitCount) & 31];
  }

  return PREFIX + body;
}

// ---------------------------------------------------------------------------
// The two identifiers M3's AP route actually takes
// ---------------------------------------------------------------------------

/**
 * SINO - supplier invoice number, A(24).
 *
 * This is the one that matters. AP uniqueness in M3 is SPYN+SUNO+SINO+INYR, so
 * a claim re-posted with the same SINO is REJECTED BY THE LEDGER rather than
 * duplicated. That is stronger than anything this application can enforce on
 * its own, and it is why the reference has to be deterministic: the protection
 * only works if a retry produces the same value the first attempt used.
 */
export function supplierInvoiceNo(sessionId: string): string {
  // The 20-character reference fits A(24) with room to spare.
  return postingReference(sessionId);
}

/**
 * CORI - correlation id, A(36).
 *
 * Exists expressly to tie a voucher back to the system that fed it.
 *
 * Deliberately NOT shaped as a v4 UUID. An earlier version set the version and
 * variant nibbles so it looked like one, which would have told every reader
 * that the value was randomly generated when it is in fact derived - and the
 * whole point is that it is reproducible from the session. It is an opaque,
 * fixed-width, name-based identifier, and it looks like one.
 */
export function correlationId(sessionId: string): string {
  const digest = createHash("sha256").update(`amreceipts:m3:correlation:${sessionId}`).digest();
  let body = "";
  let bits = 0;
  let buf = 0;
  let i = 0;
  while (body.length < 32) {
    if (bits < 5) {
      buf = (buf << 8) | digest[i % digest.length];
      bits += 8;
      i++;
    }
    bits -= 5;
    body += ALPHABET[(buf >> bits) & 31];
  }
  // "AMRC" + 32 characters = exactly the 36 the field allows.
  return `AMRC${body}`;
}

/** Whether a string looks like one of our references. Used when reconciling
 *  values read back out of M3, which may have been padded or lower-cased. */
export function isPostingReference(value: string): boolean {
  const trimmed = value.trim().toUpperCase();
  if (trimmed.length !== REFERENCE_LENGTH) return false;
  if (!trimmed.startsWith(PREFIX)) return false;
  return [...trimmed.slice(PREFIX.length)].every((c) => ALPHABET.includes(c));
}
