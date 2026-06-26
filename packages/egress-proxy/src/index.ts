/**
 * @lattice/egress-proxy — the app-level egress firewall (network layer).
 *
 * The kernel's `checkEgress` is the policy; this is where it is ENFORCED on the
 * real in-browser request path. agent-browser (the internal engine) is launched
 * with `HTTP(S)_PROXY` pointing here, so EVERY outbound request the page makes —
 * fetch / XHR / img / beacon / form POST / navigation — passes through this
 * forward proxy before it leaves. A request to a destination the policy denies is
 * refused (403 / CONNECT-refused) BEFORE any bytes reach the network.
 *
 * This is fork-free: it consumes only agent-browser's exposed `--proxy` /
 * HTTP_PROXY support. agent-browser stays internal-only — the proxy sits AROUND
 * the engine, not inside it.
 *
 * SCOPE (honest): the decision key is the DESTINATION ORIGIN. Over CONNECT
 * (HTTPS) the proxy sees only `host:port`, not the page that initiated the
 * request, so this enforces a per-request DESTINATION ALLOWLIST. Content-vs-task
 * PROVENANCE (kernel A4) is not available at this layer and stays a kernel-level
 * property. Origin-level is the ceiling of the fork-free path.
 */

import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { connect as netConnect, type Socket } from "node:net";

export interface EgressDecision {
  /** The raw destination (absolute URL for HTTP, host:port for CONNECT). */
  readonly destination: string;
  /** The destination origin the decision was keyed on. */
  readonly origin: string;
  readonly allowed: boolean;
  readonly method: "http" | "connect";
}

export interface EgressProxyOptions {
  /** Allow egress to this destination origin? (checkEgress, origin-keyed.) */
  readonly allow: (origin: string) => boolean;
  /**
   * Optional host → "host:port" remap so the proxy can reach local test servers
   * by a non-localhost hostname (Chrome bypasses the proxy for localhost, but not
   * for arbitrary hostnames). PRODUCTION omits this — real DNS is used.
   */
  readonly hostMap?: Readonly<Record<string, string>>;
}

export class EgressProxy {
  private server: Server | null = null;
  /** Every decision made on the live path — for audit and the e2e assertion. */
  readonly decisions: EgressDecision[] = [];

  constructor(private readonly opts: EgressProxyOptions) {}

  async start(host = "127.0.0.1", port = 0): Promise<{ url: string; port: number }> {
    const server = createServer((req, res) => this.onRequest(req, res));
    server.on("connect", (req, socket, head) => this.onConnect(req, socket as Socket, head));
    // A proxy must not crash on a peer reset mid-transfer.
    server.on("clientError", (_e, socket) => socket.destroy());
    this.server = server;
    await new Promise<void>((resolve) => server.listen(port, host, resolve));
    const addr = server.address();
    const boundPort = typeof addr === "object" && addr ? addr.port : port;
    return { url: `http://${host}:${boundPort}`, port: boundPort };
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = null;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private resolve(hostname: string, port: number): { host: string; port: number } {
    const mapped = this.opts.hostMap?.[hostname];
    if (mapped) {
      const [h, p] = mapped.split(":");
      return { host: h ?? hostname, port: Number(p) || port };
    }
    return { host: hostname, port };
  }

  // ── plain HTTP (forward-proxy: req.url is an absolute URI) ────────────────────
  private onRequest(req: IncomingMessage, res: ServerResponse): void {
    let url: URL;
    try {
      url = new URL(req.url ?? "");
    } catch {
      res.writeHead(400).end("bad proxy request");
      return;
    }
    const origin = url.origin;
    const allowed = this.opts.allow(origin);
    this.decisions.push({ destination: req.url ?? "", origin, allowed, method: "http" });
    if (!allowed) {
      res.writeHead(403, { "Content-Type": "text/plain" }).end("egress blocked by Lattice");
      return;
    }
    const target = this.resolve(url.hostname, Number(url.port) || 80);
    const proxyReq = httpRequest(
      { host: target.host, port: target.port, method: req.method, path: url.pathname + url.search, headers: req.headers },
      (pRes) => {
        res.writeHead(pRes.statusCode ?? 502, pRes.headers);
        pRes.pipe(res);
      },
    );
    proxyReq.on("error", () => {
      if (!res.headersSent) res.writeHead(502, { "Content-Type": "text/plain" }).end("upstream error");
      else res.destroy();
    });
    req.pipe(proxyReq);
  }

  // ── HTTPS (CONNECT host:port → blind TLS tunnel) ──────────────────────────────
  private onConnect(req: IncomingMessage, clientSocket: Socket, head: Buffer): void {
    const [host, portStr] = (req.url ?? "").split(":");
    const port = Number(portStr) || 443;
    const origin = `https://${host}`;
    const allowed = this.opts.allow(origin);
    this.decisions.push({ destination: req.url ?? "", origin, allowed, method: "connect" });
    if (!allowed) {
      clientSocket.write("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
      clientSocket.end();
      return;
    }
    const target = this.resolve(host ?? "", port);
    const serverSocket = netConnect(target.port, target.host, () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      serverSocket.write(head);
      serverSocket.pipe(clientSocket);
      clientSocket.pipe(serverSocket);
    });
    serverSocket.on("error", () => clientSocket.destroy());
    clientSocket.on("error", () => serverSocket.destroy());
  }
}

/**
 * Build the `allow` decision from a destination-origin allowlist: a destination
 * is permitted iff it is the task origin or is explicitly allowlisted. This is
 * `checkEgress` minus provenance (which the proxy layer cannot see).
 */
export function originAllowlist(taskOrigins: ReadonlyArray<string>, egressAllowlist: ReadonlyArray<string>): (origin: string) => boolean {
  const allowed = new Set([...taskOrigins, ...egressAllowlist]);
  return (origin: string) => allowed.has(origin);
}
