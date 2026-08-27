// Client for m3api-rest on an on-prem M3 grid.
//
// Ported from an existing internal PHP client, which reads and writes a live
// grid. Its hard-won operational behaviour is preserved deliberately, and the
// non-obvious parts are commented where they are easy to "clean up" into bugs.
//
// The substantive departure is write safety. That client's only mutating call
// (PPS001MI/ConfirmLine) SETS a delivery date, so repeating it is harmless. A
// GL voucher post APPENDS, so this client never retries a write, and reports
// `ambiguous` whenever it cannot prove what happened.

import { createHash } from "node:crypto";
import { httpRequest } from "./http";
import { loadSecrets } from "./secrets";
import type { M3ConnectionConfig } from "./config";

export type MIRecord = Record<string, string>;

export type MIFailureReason =
  | "invalid_request"
  | "auth"
  | "not_delivered"
  | "unknown_delivery"
  | "rejected"
  | "http_error";

export type MIResult =
  | {
      ok: true;
      records: MIRecord[];
      // True when exactly maxrecs came back. The grid caps each call and gives
      // no offset to page past it, so a full page means "there may be more",
      // never "this is all of it". Callers that close out or reconcile against
      // a complete set MUST stop when this is set.
      truncated: boolean;
    }
  | {
      ok: false;
      message: string;
      status: number;
      /**
       * Why it failed, as a closed set rather than a message to be sniffed.
       * The posting worker maps this onto queue outcomes, and a total mapping
       * is the difference between a safe classification and a guess.
       *
       *   invalid_request  - never left this process
       *   auth             - no token, so nothing was dispatched
       *   not_delivered    - PROVABLY never reached M3 (no TLS connection)
       *   unknown_delivery - reached M3, outcome unknown
       *   rejected         - M3 explicitly refused it
       *   http_error       - HTTP or protocol failure at the gateway
       */
      reason: MIFailureReason;
      // The write may or may not have been applied - we do not know. Never
      // retry it. Reconcile by querying M3 for the posting's external
      // reference, and escalate to manual review if that is inconclusive.
      // Always false for reads, which are safe to repeat regardless.
      ambiguous: boolean;
    };

export type MetadataResult =
  | { ok: true; data: unknown }
  | { ok: false; message: string; status: number };

// Raw HTTP outcome before MI-shaped interpretation.
type RawResult =
  | { ok: true; status: number; body: string }
  | { ok: false; message: string; status: number; ambiguous: boolean; reason: MIFailureReason };

interface CachedToken {
  accessToken: string;
  expiresAt: number; // epoch ms
}

// Token cache is per-process and in-memory. The PHP client cached to disk
// because PHP starts a fresh process per request; a Node server does not, so
// keeping bearer tokens off the filesystem entirely is both simpler and safer.
// Multi-worker deployments hold one token per worker, which the STS allows.
const tokenCache = new Map<string, CachedToken>();
// In-flight fetches, so N concurrent callers cause one token request rather
// than a thundering herd against the STS. The reference client had no such
// guard; a batch of parallel postings would have stampeded it.
const inFlight = new Map<string, Promise<string | null>>();
// Monotonic per-key counter. A token is only installed if no fetch STARTED
// later has already finished - comparing expiry instead would let a slow older
// request win purely by being granted a longer lifetime.
const tokenGeneration = new Map<string, number>();
// Highest generation that actually succeeded and installed a token.
const completedGeneration = new Map<string, number>();

// Refresh this far before expiry so a token cannot die mid-request.
const EXPIRY_MARGIN_MS = 60_000;
// Writes demand a much wider margin. A write that meets a 401 is unretryable
// and lands in manual reconciliation, so it is worth spending a spare token
// refresh to make that essentially impossible.
const WRITE_EXPIRY_MARGIN_MS = 5 * 60_000;

/** Strict RFC3986: encodeURIComponent leaves !'()* unescaped, rawurlencode does not. */
function encodeComponent(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
  );
}

function encodeQuery(params: Record<string, string>): string {
  return Object.entries(params)
    .map(([k, v]) => `${encodeComponent(k)}=${encodeComponent(v)}`)
    .join("&");
}

const SAFE_NAME = /^[A-Za-z0-9_]+$/;

export class M3Client {
  constructor(private readonly config: M3ConnectionConfig) {}

  private cacheKey(): string {
    const parts =
      this.config.authMode === "oauth_password"
        ? [this.config.tokenUrl, this.config.clientId, this.config.secretRef]
        : [this.config.baseUrl, this.config.secretRef];
    // Ties the cached token to this grid+client so test and prod never share one.
    return createHash("sha256").update(parts.join("|")).digest("hex");
  }

  /** A cached token with at least `marginMs` of life left, else null. */
  private fromCache(key: string, marginMs: number): string | null {
    const cached = tokenCache.get(key);
    return cached && cached.expiresAt > Date.now() + marginMs ? cached.accessToken : null;
  }

  /**
   * Bearer token, from cache when fresh enough, else from the STS.
   *
   * The cache is the single source of truth. A fetch's own return value is
   * never handed back directly: if a concurrent refresh superseded it, that
   * value is already stale, and returning it would undo the very race the
   * generation counter exists to settle.
   */
  private async getToken(marginMs: number, forceFresh: boolean): Promise<string | null> {
    if (this.config.authMode !== "oauth_password") return null;
    const key = this.cacheKey();

    if (forceFresh) {
      // The caller has evidence this token is bad, so neither the cache nor an
      // older in-flight fetch can satisfy it. Raising the completed floor to
      // the highest generation started so far bars every fetch already in
      // flight from installing - each of them began before we learned the
      // token was bad, so their results are suspect too.
      tokenCache.delete(key);
      completedGeneration.set(key, tokenGeneration.get(key) ?? 0);
      await this.startTokenFetch(key, false);

      const refreshed = this.fromCache(key, 0);
      if (refreshed !== null) return refreshed;

      // Our install can be barred by a forced refresh that started after ours.
      // Wait for whichever fetch superseded us rather than reporting an auth
      // failure we have no evidence for.
      const superseding = inFlight.get(key);
      if (superseding) {
        await superseding;
        return this.fromCache(key, 0);
      }
      return null;
    }

    // Bounded: at most two joins before insisting on our own fetch, so a flight
    // that keeps returning tokens too stale for us cannot loop forever.
    for (let round = 0; round < 2; round++) {
      const fresh = this.fromCache(key, marginMs);
      if (fresh !== null) return fresh;

      // Join an existing fetch rather than starting a second one. The joined
      // flight may have been started by a read, whose freshness bar is much
      // lower, so the CACHE is re-checked against our own margin at the top of
      // the next round - otherwise a write could inherit a nearly-expired token
      // and land in the unretryable 401 case this margin exists to prevent.
      const pending = inFlight.get(key);
      if (!pending) break;
      await pending;
    }

    await this.startTokenFetch(key, true);
    // Accept whatever is now cached and still valid. A token shorter-lived than
    // our preferred margin still beats failing the call outright, and we have
    // already spent a fresh fetch trying to do better.
    return this.fromCache(key, 0);
  }

  /**
   * Start (or join) a token fetch for `key`.
   *
   * The in-flight entry is registered synchronously with no await in between,
   * so concurrent callers arriving in the same tick coalesce onto one request
   * instead of stampeding the STS. Callers read the result from the cache.
   */
  private async startTokenFetch(key: string, join: boolean): Promise<void> {
    if (join) {
      const existing = inFlight.get(key);
      if (existing) {
        await existing;
        return;
      }
    }

    const promise = this.fetchToken(key).catch((e: unknown) => {
      // An unexpected throw must not escape as a rejected promise to every
      // joined caller.
      console.error(`M3Client: token fetch threw: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    });

    inFlight.set(key, promise);
    try {
      await promise;
    } finally {
      // Only clear the entry if it is still ours. A concurrent forced refresh
      // may have replaced it, and deleting that one would let a third caller
      // start yet another fetch.
      if (inFlight.get(key) === promise) inFlight.delete(key);
    }
  }

  private async fetchToken(key: string): Promise<string | null> {
    if (this.config.authMode !== "oauth_password") return null;

    const secrets = loadSecrets(this.config);
    if (!secrets.ok || secrets.secrets.authMode !== "oauth_password") {
      console.error(`M3Client: ${secrets.ok ? "unexpected secret shape" : secrets.error}`);
      return null;
    }

    // Password grant against Infor STS. Credentials go in the form-encoded
    // POST body, never in the URL, so they cannot reach an access log.
    const body = encodeQuery({
      grant_type: "password",
      client_id: this.config.clientId,
      client_secret: secrets.secrets.cs,
      username: secrets.secrets.saak,
      password: secrets.secrets.sask,
    });

    const requestedAt = Date.now();
    const generation = (tokenGeneration.get(key) ?? 0) + 1;
    tokenGeneration.set(key, generation);
    const outcome = await httpRequest({
      url: this.config.tokenUrl,
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": String(Buffer.byteLength(body)),
        Accept: "application/json",
      },
      body,
      verifyTls: this.config.verifyTls,
      connectTimeoutMs: this.config.connectTimeoutMs,
      requestTimeoutMs: this.config.requestTimeoutMs,
    });

    if (outcome.kind !== "response" || outcome.status !== 200) {
      const detail = outcome.kind === "response" ? `HTTP ${outcome.status}` : outcome.error;
      // Never log the body: a failed token response can echo credentials.
      console.error(`M3Client: token request failed (${detail})`);
      return null;
    }

    let json: unknown;
    try {
      json = JSON.parse(outcome.body);
    } catch {
      console.error("M3Client: token response was not JSON");
      return null;
    }
    const token = (json as { access_token?: unknown }).access_token;
    if (typeof token !== "string" || token === "") {
      console.error("M3Client: token response had no access_token");
      return null;
    }
    const expiresInRaw = Number((json as { expires_in?: unknown }).expires_in ?? 300);
    const expiresIn = Number.isFinite(expiresInRaw) && expiresInRaw > 0 ? expiresInRaw : 300;

    // Expiry counts from when the request went out, not from when the reply
    // was parsed, so a slow STS cannot make the token look fresher than it is.
    // Install unless a fetch that STARTED LATER has already succeeded. Keying
    // off "started" alone would let a later fetch that failed veto a perfectly
    // good older token; keying off expiry would let a slow older request win
    // purely by being granted a longer lifetime.
    if (generation > (completedGeneration.get(key) ?? 0)) {
      completedGeneration.set(key, generation);
      tokenCache.set(key, { accessToken: token, expiresAt: requestedAt + expiresIn * 1000 });
    }
    return token;
  }

  /**
   * Execute an MI transaction.
   *
   * @param write Mutating call. Disables every retry, widens the token
   *              freshness margin, and makes any indeterminate outcome
   *              `ambiguous` rather than a plain failure.
   */
  async execute(
    program: string,
    transaction: string,
    params: Record<string, string | number | null | undefined> = {},
    { write = false }: { write?: boolean } = {},
  ): Promise<MIResult> {
    if (!SAFE_NAME.test(program) || !SAFE_NAME.test(transaction)) {
      // Never dispatched, so unambiguous even for a write.
      return {
        ok: false,
        message: "Invalid program or transaction name.",
        status: 0,
        ambiguous: false,
        reason: "invalid_request",
      };
    }

    // Whitespace-only is treated as blank. The reference client compared
    // against "" exactly; a value of "   " is a mistake either way, and letting
    // it through would send garbage to M3 or silently drop the company.
    const isBlank = (v: string | number | null | undefined) =>
      v === null || v === undefined || String(v).trim() === "";

    const query: Record<string, string> = { maxrecs: String(this.config.maxrecs) };
    const callerCono = params.CONO;
    // The configured company is the fallback; only a NON-BLANK caller value
    // displaces it. Passing CONO: "" must not silently drop the company - that
    // would post against the service account's default instead.
    if (this.config.defaultCono && isBlank(callerCono)) {
      query.CONO = this.config.defaultCono;
    }
    for (const [name, value] of Object.entries(params)) {
      // Blanks are skipped so optional fields fall back to M3's own defaults -
      // sending an empty string is NOT the same as omitting the field.
      if (isBlank(value)) continue;
      query[name] = String(value);
    }

    // maxrecs rides twice on purpose. The matrix parameter after the
    // transaction segment is the form m3api-rest documents, and the grid this
    // was proven against IGNORES the query-string spelling - falling back to a
    // silent default cap of 100. The query-string copy is there for grids that
    // read it instead. Each side ignores the spelling it does not know.
    // Removing either one reintroduces silent truncation.
    const url =
      `${this.config.baseUrl}/execute/${encodeComponent(program)}/` +
      `${encodeComponent(transaction)};maxrecs=${this.config.maxrecs}?${encodeQuery(query)}`;

    const raw = await this.request(url, write);
    if (!raw.ok) return raw;
    return this.parseBody(raw.status, raw.body, write);
  }

  /**
   * REST metadata for a program, returned raw.
   *
   * Not MI-shaped: running it through the MIRecord parser would discard the
   * payload and report a cheerful empty success. Not routed on every grid -
   * listTransactions is the more reliable route.
   */
  async metadata(program: string): Promise<MetadataResult> {
    if (!SAFE_NAME.test(program)) {
      return { ok: false, message: "Invalid program name.", status: 0 };
    }
    const raw = await this.request(`${this.config.baseUrl}/metadata/${encodeComponent(program)}`, false);
    if (!raw.ok) return { ok: false, message: raw.message, status: raw.status };

    try {
      return { ok: true, data: JSON.parse(raw.body) };
    } catch {
      return { ok: false, message: "Metadata response was not JSON.", status: raw.status };
    }
  }

  /**
   * The transactions a program actually exposes on THIS grid.
   *
   * Custom list APIs are defined per environment, so configured transaction
   * names must be checked against the grid rather than assumed. This is how
   * routing rules get validated against real master data instead of a guess.
   */
  async listTransactions(program: string): Promise<MIResult> {
    return this.execute("MRS001MI", "LstTransactions", { MINM: program });
  }

  /** Field names for one transaction. TRTP selects input ("I") or output ("O"). */
  async listFields(program: string, transaction: string, side: "I" | "O" = "O"): Promise<MIResult> {
    return this.execute("MRS001MI", "LstFields", { MINM: program, TRNM: transaction, TRTP: side });
  }

  /** One GET, with auth and - for reads only - refresh and transport retries. */
  private async request(url: string, write: boolean): Promise<RawResult> {
    if (write) {
      // Writes get exactly one attempt. No transport retry, no 401 retry: an
      // HTTP status is not proof that no mutation occurred, so anything other
      // than a clean answer has to be reconciled rather than repeated.
      return this.requestOnce(url, write, false);
    }

    const attempts = this.config.readMaxRetries + 1;
    let last: RawResult = {
      ok: false, message: "No attempt made.", status: 0, ambiguous: false, reason: "invalid_request",
    };

    for (let attempt = 0; attempt < attempts; attempt++) {
      last = await this.requestOnce(url, write, false);

      // A 401/403 on a READ is safe to repeat with a fresh token, exactly as
      // the reference client does: one forced refresh, one retry.
      if (!last.ok && (last.status === 401 || last.status === 403)) {
        last = await this.requestOnce(url, write, true);
      }
      if (last.ok) return last;

      // Retry transport failures and 5xx; a 4xx will not fix itself.
      const retryable = last.status === 0 || last.status >= 500;
      if (!retryable || attempt === attempts - 1) return last;

      await new Promise((r) => setTimeout(r, 250 * 2 ** attempt));
    }
    return last;
  }

  private async requestOnce(url: string, write: boolean, forceFreshToken: boolean): Promise<RawResult> {
    const headers: Record<string, string> = { Accept: "application/json;charset=utf-8" };

    if (this.config.authMode === "oauth_password") {
      const margin = write ? WRITE_EXPIRY_MARGIN_MS : EXPIRY_MARGIN_MS;
      const token = await this.getToken(margin, forceFreshToken);
      if (token === null) {
        // Nothing was dispatched, so this is a definite failure even for a write.
        return { ok: false, message: "Could not authenticate to M3.", status: 0, ambiguous: false, reason: "auth" };
      }
      headers.Authorization = `Bearer ${token}`;
    } else {
      const secrets = loadSecrets(this.config);
      if (!secrets.ok || secrets.secrets.authMode !== "basic") {
        return { ok: false, message: "Could not load M3 basic credentials.", status: 0, ambiguous: false, reason: "auth" };
      }
      const pair = `${secrets.secrets.username}:${secrets.secrets.password}`;
      headers.Authorization = `Basic ${Buffer.from(pair).toString("base64")}`;
    }

    const outcome = await httpRequest({
      url,
      method: "GET",
      headers,
      verifyTls: this.config.verifyTls,
      connectTimeoutMs: this.config.connectTimeoutMs,
      requestTimeoutMs: this.config.requestTimeoutMs,
    });

    if (outcome.kind === "transport") {
      // The URL carries MI parameters, which are business data - log the
      // failure without it.
      console.error(`M3Client: transport error: ${outcome.error}`);
      return {
        ok: false,
        message: "Could not reach M3. Please try again shortly.",
        status: 0,
        // If we never completed the TLS handshake, the grid cannot have acted.
        // Once connected we make no claim: unknown, not failed.
        ambiguous: write && outcome.connected,
        reason: outcome.connected ? "unknown_delivery" : "not_delivered",
      };
    }

    return { ok: true, status: outcome.status, body: outcome.body };
  }

  private parseBody(status: number, body: string, write: boolean): MIResult {
    let json: unknown;
    try {
      json = JSON.parse(body);
    } catch {
      console.error(`M3Client: non-JSON response (HTTP ${status})`);
      // We cannot tell what the grid did from a body we cannot read.
      return { ok: false, message: "Unexpected response from M3.", status, ambiguous: write, reason: "http_error" };
    }
    if (typeof json !== "object" || json === null) {
      return { ok: false, message: "Unexpected response from M3.", status, ambiguous: write, reason: "http_error" };
    }

    const obj = json as Record<string, unknown>;
    // Error shapes seen from m3api-rest:
    //   { "@type": "NOK", "Message": "..." }
    //   { "ErrorMessage": "...", ... }
    // plus anything HTTP >= 400 regardless of body.
    const type = String(obj["@type"] ?? "");
    const errMsg = String(obj.Message ?? obj.ErrorMessage ?? "").trim();
    const miRecords = Array.isArray(obj.MIRecord) ? (obj.MIRecord as unknown[]) : [];
    const isNok = type.toUpperCase() === "NOK";
    const isApplicationError = isNok || (errMsg !== "" && miRecords.length === 0);

    // Success requires a 2xx. A 3xx carrying JSON is not a result: we never
    // follow redirects, so the body is whatever sat at the old location, and
    // treating it as an empty-record success would report a write as done.
    const isSuccessStatus = status >= 200 && status < 300;

    if (!isSuccessStatus || isApplicationError) {
      // Only an explicit "@type": "NOK" is M3 stating it rejected the call -
      // the one failure we can take at face value for a write. A bare Message
      // field can come from a proxy or gateway, a 5xx or 401/403 is the
      // infrastructure talking, and none of those says whether MI ran.
      const definitiveRejection = isNok && isSuccessStatus;
      return {
        ok: false,
        message: errMsg !== "" ? errMsg : `M3 returned HTTP ${status}.`,
        status,
        ambiguous: write && !definitiveRejection,
        reason: definitiveRejection ? "rejected" : "http_error",
      };
    }

    // Flatten MIRecord[].NameValue[] Name/Value pairs into plain objects.
    const records: MIRecord[] = [];
    for (const entry of miRecords) {
      if (typeof entry !== "object" || entry === null) continue;
      const pairs = (entry as Record<string, unknown>).NameValue;
      if (!Array.isArray(pairs)) continue;
      const row: MIRecord = {};
      for (const pair of pairs) {
        if (typeof pair !== "object" || pair === null) continue;
        const p = pair as Record<string, unknown>;
        if (typeof p.Name !== "string") continue;
        row[p.Name] = String(p.Value ?? "").trim();
      }
      if (Object.keys(row).length > 0) records.push(row);
    }

    return { ok: true, records, truncated: records.length >= this.config.maxrecs };
  }
}
