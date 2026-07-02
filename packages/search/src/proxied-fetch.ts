/**
 * proxiedFetch — a FetchLike that routes EVERY request through the Lattice
 * egress proxy (HTTP forward-proxy semantics), the same chokepoint the
 * browser's traffic passes. This is what makes search egress GOVERNED: when
 * the firewall is active, provider requests are gated per-request by the same
 * destination allowlist — a non-allowlisted provider endpoint is refused
 * (403 / CONNECT-refused) before any bytes leave the machine, surfaced as a
 * typed SearchEgressBlockedError.
 *
 *   http://  targets → absolute-URI request to the proxy
 *   https:// targets → CONNECT tunnel, then TLS to the destination
 */

import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { connect as tlsConnect, type ConnectionOptions } from "node:tls";
import { SearchEgressBlockedError, SearchUpstreamError } from "./errors.js";
import type { FetchLike, MinimalResponse } from "./types.js";

/** The exact body the EgressProxy writes on a plain-HTTP block. */
const PROXY_BLOCK_BODY = "egress blocked by Lattice";

export interface ProxiedFetchOptions {
  /** TLS overrides for the CONNECT leg — tests only (self-signed local target). */
  readonly tls?: ConnectionOptions;
  /** Per-request budget (ms) before a hung upstream becomes a typed error. Default 20s. */
  readonly timeoutMs?: number;
}

export function proxiedFetch(proxyUrl: string, opts: ProxiedFetchOptions = {}): FetchLike {
  const proxy = new URL(proxyUrl);
  const proxyHost = proxy.hostname;
  const proxyPort = Number(proxy.port) || 80;

  const timeoutMs = opts.timeoutMs ?? 20_000;

  return async (url, init) => {
    const target = new URL(url);
    let request: Promise<MinimalResponse>;
    if (target.protocol === "http:") {
      request = httpViaProxy(proxyHost, proxyPort, target, timeoutMs, init);
    } else if (target.protocol === "https:") {
      request = httpsViaConnect(proxyHost, proxyPort, target, timeoutMs, init, opts.tls);
    } else {
      throw new SearchUpstreamError(`unsupported scheme for proxied fetch: ${target.protocol}`);
    }
    // A hung/tarpitted upstream is a TYPED failure, never an indefinite hang.
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new SearchUpstreamError(`request to ${target.origin} timed out after ${timeoutMs}ms`)), timeoutMs);
      timer.unref?.();
    });
    try {
      return await Promise.race([request, timeout]);
    } finally {
      clearTimeout(timer);
      // Don't leak an eventually-settling rejected request promise.
      request.catch(() => undefined);
    }
  };
}

function collect(res: IncomingMessage): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    res.on("data", (c: Buffer) => chunks.push(c));
    res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    res.on("error", reject);
  });
}

function toResponse(status: number, body: string): MinimalResponse {
  return { status, ok: status >= 200 && status < 300, text: () => Promise.resolve(body) };
}

function httpViaProxy(
  proxyHost: string,
  proxyPort: number,
  target: URL,
  timeoutMs: number,
  init?: { method?: string; headers?: Record<string, string> },
): Promise<MinimalResponse> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: proxyHost,
        port: proxyPort,
        method: init?.method ?? "GET",
        path: target.href, // absolute URI — forward-proxy form
        // One-shot fetches: close the socket after the response, so a proxy
        // shutdown is never held open by an idle keep-alive connection.
        headers: { host: target.host, connection: "close", ...init?.headers },
      },
      (res) => {
        collect(res).then(({ status, body }) => {
          // Distinguish the PROXY's own 403 (firewall) from an upstream 403.
          if (status === 403 && body === PROXY_BLOCK_BODY) {
            reject(new SearchEgressBlockedError(target.origin));
          } else {
            resolve(toResponse(status, body));
          }
        }, reject);
      },
    );
    req.on("error", (e) => reject(new SearchUpstreamError(`proxy request failed: ${e.message}`)));
    // Inactivity → destroy the socket so a tarpitted upstream can't hold the
    // proxy's connection open past the request budget.
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`inactivity after ${timeoutMs}ms`)));
    req.end();
  });
}

function httpsViaConnect(
  proxyHost: string,
  proxyPort: number,
  target: URL,
  timeoutMs: number,
  init?: { method?: string; headers?: Record<string, string> },
  tls?: ConnectionOptions,
): Promise<MinimalResponse> {
  const targetPort = Number(target.port) || 443;
  return new Promise((resolve, reject) => {
    const connectReq = httpRequest({
      host: proxyHost,
      port: proxyPort,
      method: "CONNECT",
      path: `${target.hostname}:${targetPort}`,
    });
    connectReq.on("connect", (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        // The proxy refused the tunnel — the destination never saw a byte.
        reject(new SearchEgressBlockedError(target.origin));
        return;
      }
      // One-shot: tear the tunnel down as soon as the exchange settles, so an
      // idle (or keep-alive-insistent) upstream can never hold the proxy open.
      const settle = <T>(fn: (v: T) => void) => (v: T) => { socket.destroy(); fn(v); };
      // Inactivity on the tunnel (tarpitted upstream) → destroy → the request
      // errors → settle path frees the proxy connection within the budget.
      socket.setTimeout(timeoutMs, () => socket.destroy(new Error(`tunnel inactivity after ${timeoutMs}ms`)));
      const req = httpsRequest(
        {
          host: target.hostname,
          port: targetPort,
          method: init?.method ?? "GET",
          path: target.pathname + target.search,
          headers: { host: target.host, connection: "close", ...init?.headers },
          // Tunnel the TLS session through the established CONNECT socket.
          createConnection: () => tlsConnect({ socket, servername: target.hostname, ...tls }),
        },
        (r) => {
          void collect(r).then(
            settle(({ status, body }) => resolve(toResponse(status, body))),
            settle(reject),
          );
        },
      );
      req.on("error", settle((e: Error) => reject(new SearchUpstreamError(`tunneled request failed: ${e.message}`))));
      req.end();
    });
    connectReq.on("error", (e) => reject(new SearchUpstreamError(`proxy CONNECT failed: ${e.message}`)));
    connectReq.setTimeout(timeoutMs, () => connectReq.destroy(new Error(`CONNECT inactivity after ${timeoutMs}ms`)));
    connectReq.end();
  });
}
