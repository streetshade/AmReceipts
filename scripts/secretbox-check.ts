// Adversarial checks for src/lib/secretbox.ts.
//
//   npm run check:secretbox
//
// A round-trip test proves only that a thing decrypts what it encrypted. These
// are the cases that decide whether the envelope is actually load-bearing:
// moving a ciphertext to another record, a changed key, a flipped bit, and -
// most importantly - that a blob which is PRESENT but unreadable never looks
// like one that is absent.

// Next's types declare NODE_ENV readonly; this script deliberately varies it
// to exercise the production guard, so it is written through a widened view.
const env = process.env as Record<string, string | undefined>;
env.NODE_ENV = "test";
env.CONFIG_ENCRYPTION_KEY = "11".repeat(32);

import { seal, open, resetKeyCacheForTests, SecretboxError } from "../src/lib/secretbox";

let failures = 0;
function check(name: string, passed: boolean, detail = "") {
  console.log(`${passed ? "  ok  " : "  FAIL"} ${name}${detail && !passed ? ` — ${detail}` : ""}`);
  if (!passed) failures++;
}

const creds = { clientSecret: "super-secret-cs", saak: "the-saak", sask: "the-sask" };
const sealed = seal(creds, "m3_ion");

// --- basics ---------------------------------------------------------------
const opened = open<typeof creds>(sealed, "m3_ion");
check("round-trips under the right context", opened.status === "ok" && opened.value.saak === "the-saak");
check("ciphertext contains no plaintext", !sealed.includes("super-secret-cs") && !sealed.includes("the-saak"));
check("two seals of the same value differ (fresh IV)", seal(creds, "m3_ion") !== seal(creds, "m3_ion"));

// --- absent vs unreadable, the distinction the callers depend on ----------
check("null is absent", open(null, "m3_ion").status === "absent");
check("empty string is absent", open("", "m3_ion").status === "absent");
check("garbage is unreadable, NOT absent", open("not-an-envelope", "m3_ion").status === "unreadable");

// --- transplantation ------------------------------------------------------
const moved = open(sealed, "psa_web");
check("a blob bound to m3_ion will not open as psa_web", moved.status === "unreadable",
  `got ${moved.status}`);

// --- tampering ------------------------------------------------------------
const parts = sealed.split(".");
const flipped = [parts[0], parts[1], parts[2], parts[3].slice(0, -4) + "AAAA"].join(".");
check("flipped ciphertext fails the tag", open(flipped, "m3_ion").status === "unreadable");
const badTag = [parts[0], parts[1], "A".repeat(parts[2].length), parts[3]].join(".");
check("forged tag is rejected", open(badTag, "m3_ion").status === "unreadable");

// --- malformed encodings --------------------------------------------------
check("unknown version is rejected", open("v9." + parts.slice(1).join("."), "m3_ion").status === "unreadable");
check("too few segments rejected", open("v1.aa.bb", "m3_ion").status === "unreadable");
check("non-base64url rejected", open(`v1.${parts[1]}.${parts[2]}.!!!!`, "m3_ion").status === "unreadable");
check("short iv rejected", open(`v1.AAAA.${parts[2]}.${parts[3]}`, "m3_ion").status === "unreadable");

// --- canonicality and size ------------------------------------------------
// Buffer.from is lenient: an extra padding-ish character can decode to the
// same bytes. Only a canonical encoding is accepted.
check("non-canonical base64url rejected", open(`v1.${parts[1]}A.${parts[2]}.${parts[3]}`, "m3_ion").status === "unreadable");
check("oversized envelope rejected before decoding",
  open(`v2.${parts[1]}.${parts[2]}.${"A".repeat(200000)}`, "m3_ion").status === "unreadable");
// A pre-AAD blob should say so, rather than looking like tampering.
const legacy = open("v1.aaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbbbbbbbb.cccc", "m3_ion");
check("legacy v1 reports unsupported version",
  legacy.status === "unreadable" && legacy.reason.includes("version"), legacy.status === "unreadable" ? legacy.reason : "");

// --- wrong key ------------------------------------------------------------
env.CONFIG_ENCRYPTION_KEY = "22".repeat(32);
resetKeyCacheForTests();
check("a different key cannot read it", open(sealed, "m3_ion").status === "unreadable");
env.CONFIG_ENCRYPTION_KEY = "11".repeat(32);
resetKeyCacheForTests();
check("restoring the key restores access", open(sealed, "m3_ion").status === "ok");

// --- key hygiene ----------------------------------------------------------
env.CONFIG_ENCRYPTION_KEY = "not-hex";
resetKeyCacheForTests();
let threw = false;
try { seal({ a: 1 }, "m3_ion"); } catch (e) { threw = e instanceof SecretboxError; }
check("a malformed key is refused loudly", threw);

env.CONFIG_ENCRYPTION_KEY = "";
env.NODE_ENV = "production";
resetKeyCacheForTests();
threw = false;
try { seal({ a: 1 }, "m3_ion"); } catch (e) { threw = e instanceof SecretboxError; }
check("production refuses to derive a key from AUTH_SECRET", threw);
env.NODE_ENV = "test";
resetKeyCacheForTests();

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
