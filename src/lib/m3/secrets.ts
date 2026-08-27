// Resolves M3 credentials from the environment.
//
// Secrets never touch the database. The stored connection carries only a
// `secretRef` naming an environment variable; this module reads it, and the
// value is held no longer than the call that needs it.
//
// The env blob carries only the credential fields - ops should not have to
// keep an `authMode` in two places - so the mode is injected from the
// connection before validation. That also means a connection switched to
// oauth_password against a basic-shaped secret fails loudly here rather than
// with a confusing 401 from the grid.

import { M3Secrets, type M3ConnectionConfig } from "./config";

export type SecretsResult =
  | { ok: true; secrets: M3Secrets }
  | { ok: false; error: string };

export function loadSecrets(config: M3ConnectionConfig): SecretsResult {
  const raw = process.env[config.secretRef];
  if (!raw) {
    return { ok: false, error: `Environment variable ${config.secretRef} is not set` };
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    return { ok: false, error: `${config.secretRef} does not contain valid JSON` };
  }
  if (typeof parsedJson !== "object" || parsedJson === null || Array.isArray(parsedJson)) {
    return { ok: false, error: `${config.secretRef} must contain a JSON object` };
  }

  const parsed = M3Secrets.safeParse({ ...parsedJson, authMode: config.authMode });
  if (!parsed.success) {
    // Report field names only. The values are the secret.
    const fields = parsed.error.issues.map((i) => i.path.join(".") || "(root)").join(", ");
    return { ok: false, error: `${config.secretRef} is missing or malformed: ${fields}` };
  }

  return { ok: true, secrets: parsed.data };
}
