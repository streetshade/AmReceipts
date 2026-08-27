// Minimal HTTPS transport for the M3 grid.
//
// Deliberately built on node:https rather than fetch/undici: we need exact
// control over things the global fetch cannot express without pulling in a
// dispatcher dependency.
//
//   1. TLS verification toggling  - test grids run on self-signed certificates.
//   2. Separate connect vs overall deadline - an unreachable grid should fail
//      fast, while a legitimately slow MI transaction gets its full budget.
//   3. Never following redirects - a redirect would leak the bearer token to
//      whatever host the Location header names.
//   4. A response size cap, so a runaway result cannot exhaust memory.
//
// Contract: this function ALWAYS resolves an HttpOutcome and never rejects.
// The caller's write-safety logic depends on seeing every failure as data.

import https from "node:https";

export type HttpOutcome =
  | { kind: "response"; status: number; body: string }
  | {
      kind: "transport";
      error: string;
      // Whether the TLS connection was established before the failure.
      //
      // Deliberately NOT "the request was delivered". It is only ever used in
      // the safe direction: if we never connected, the server cannot have
      // acted, so a write is provably un-applied. Once connected we make no
      // claim at all. An earlier version keyed off the request "finish" event,
      // which is wrong in both directions - bytes can reach the server before
      // it fires, and it firing only means Node flushed to the socket.
      //
      // Where readiness cannot be established (socket reuse, a synchronous
      // throw), this is reported as true: over-reporting ambiguity costs a
      // reconciliation, under-reporting it can duplicate a voucher.
      connected: boolean;
    };

export interface HttpRequestOptions {
  url: string;
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: string;
  verifyTls: boolean;
  connectTimeoutMs: number;
  /** Overall deadline for the whole exchange, like cURL's CURLOPT_TIMEOUT. */
  requestTimeoutMs: number;
}

// Generous next to a maxrecs-capped MI response, small enough to bound memory.
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

export function httpRequest(opts: HttpRequestOptions): Promise<HttpOutcome> {
  return new Promise((resolve) => {
    let connected = false;
    let settled = false;
    let connectTimer: NodeJS.Timeout | undefined;
    let deadlineTimer: NodeJS.Timeout | undefined;

    // Declared before the try so the catch below can still settle the promise.
    const finish = (outcome: HttpOutcome) => {
      if (settled) return;
      settled = true;
      if (connectTimer) clearTimeout(connectTimer);
      if (deadlineTimer) clearTimeout(deadlineTimer);
      resolve(outcome);
    };

    let url: URL;
    try {
      url = new URL(opts.url);
    } catch {
      return finish({ kind: "transport", error: "Invalid URL", connected: false });
    }
    if (url.protocol !== "https:") {
      return finish({ kind: "transport", error: "Only https is supported", connected: false });
    }

    try {
      const req = https.request(
        {
          protocol: url.protocol,
          hostname: url.hostname,
          port: url.port || 443,
          path: url.pathname + url.search,
          method: opts.method,
          headers: opts.headers,
          rejectUnauthorized: opts.verifyTls,
          setHost: true,
        },
        (res) => {
          const chunks: Buffer[] = [];
          let total = 0;
          res.on("data", (c: Buffer) => {
            total += c.length;
            if (total > MAX_RESPONSE_BYTES) {
              req.destroy(new Error(`Response exceeded ${MAX_RESPONSE_BYTES} bytes`));
              return;
            }
            chunks.push(c);
          });
          res.on("end", () => {
            // A body cut short emits 'aborted'/'error' instead, so reaching
            // 'end' means the response is complete.
            finish({
              kind: "response",
              status: res.statusCode ?? 0,
              body: Buffer.concat(chunks).toString("utf8"),
            });
          });
          res.on("aborted", () => {
            finish({ kind: "transport", error: "Response aborted by peer", connected });
          });
          res.on("error", (e: Error) => {
            finish({ kind: "transport", error: e.message, connected });
          });
        },
      );

      // Fail fast when the grid is unreachable. Cleared on secureConnect rather
      // than the TCP connect: a stalled TLS handshake is exactly what this
      // budget exists to catch, and clearing on 'connect' would hand it the
      // much longer request deadline instead.
      connectTimer = setTimeout(() => {
        req.destroy(new Error(`Connect timeout after ${opts.connectTimeoutMs}ms`));
      }, opts.connectTimeoutMs);

      req.on("socket", (socket) => {
        const onReady = () => {
          connected = true;
          if (connectTimer) clearTimeout(connectTimer);
        };
        // A pooled socket is already established and will emit nothing further.
        // `encrypted` only tells us it is a TLSSocket, so this errs toward
        // "connected" - the conservative direction for write safety.
        const tlsSocket = socket as typeof socket & { encrypted?: boolean };
        if (tlsSocket.encrypted && !socket.connecting) {
          onReady();
        } else {
          socket.once("secureConnect", onReady);
        }
      });

      // Overall deadline. req.setTimeout() is an INACTIVITY timeout, so a
      // response trickling one byte at a time could run forever under it.
      deadlineTimer = setTimeout(() => {
        req.destroy(new Error(`Request exceeded ${opts.requestTimeoutMs}ms`));
      }, opts.requestTimeoutMs);

      req.on("error", (e: Error) => {
        finish({ kind: "transport", error: e.message, connected });
      });

      if (opts.body !== undefined) req.write(opts.body);
      req.end();
    } catch (e: unknown) {
      // https.request, header validation, write and end can all throw
      // synchronously. Whether anything reached the grid is unknowable here,
      // so assume it did.
      finish({
        kind: "transport",
        error: e instanceof Error ? e.message : String(e),
        connected: true,
      });
    }
  });
}
