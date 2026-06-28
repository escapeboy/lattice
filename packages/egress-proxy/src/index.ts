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
 *
 * `allowSubdomains` (opt-in, smoke gap #5): also permit a destination whose host
 * is a SUBDOMAIN of an allowed host on the same scheme — e.g. allowing
 * `https://vuejs.org` then also permits `https://automation.vuejs.org`. This is
 * the common "same-site asset/subdomain" case that pure origin-exact match
 * blocks. It is SAFE: it never crosses to a different registrable domain
 * (allowing `vuejs.org` never permits `evil.com`), and only broadens DOWNWARD to
 * subdomains of an explicitly-allowed host — not its parent or siblings.
 */
export function originAllowlist(
  taskOrigins: ReadonlyArray<string>,
  egressAllowlist: ReadonlyArray<string>,
  opts: { allowSubdomains?: boolean } = {},
): (origin: string) => boolean {
  const allowed = new Set([...taskOrigins, ...egressAllowlist]);
  if (!opts.allowSubdomains) return (origin: string) => allowed.has(origin);

  const hosts = [...allowed].map(parseOrigin).filter((p): p is { scheme: string; host: string } => p !== null);
  return (origin: string) => {
    if (allowed.has(origin)) return true;
    const d = parseOrigin(origin);
    if (!d) return false;
    return hosts.some((a) => a.scheme === d.scheme && (d.host === a.host || d.host.endsWith(`.${a.host}`)));
  };
}

function parseOrigin(o: string): { scheme: string; host: string } | null {
  try {
    const u = new URL(o);
    return { scheme: u.protocol, host: u.hostname };
  } catch {
    return null;
  }
}

export interface PendingEgress {
  readonly origin: string;
  readonly firstSeen: number;
  readonly attempts: number;
}

/**
 * Stateful egress decision for "ask-to-allow" (learn) mode.
 *
 * Default-deny is PRESERVED: an unknown origin is BLOCKED (nothing leaves the
 * machine) and recorded as `pending` for the operator to decide. The operator's
 * choice mutates the live policy — `allow` lets it through from the next attempt
 * on, `deny` keeps it blocked without re-prompting. This never silently allows:
 * it turns a hard block into a block-and-ask, so the proxy's default-deny
 * egress boundary stays intact — the agent simply can't reach a new origin
 * until a human says yes. (This boundary is HTTP-only: the proxy never sees
 * HTTPS sub-resource egress — see SECURITY.md §4c.)
 */
export class EgressPolicy {
  private readonly allowed: Set<string>;
  private readonly denied = new Set<string>();
  private readonly pending = new Map<string, { firstSeen: number; attempts: number }>();

  constructor(
    seedAllow: Iterable<string> = [],
    private readonly learn = true,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.allowed = new Set(seedAllow);
  }

  /** Use as the EgressProxy `allow` function. Records unknown origins as pending. */
  readonly decide = (origin: string): boolean => {
    if (this.allowed.has(origin)) return true;
    if (this.denied.has(origin)) return false;
    if (this.learn && !this.pending.has(origin)) {
      this.pending.set(origin, { firstSeen: this.now(), attempts: 0 });
    }
    if (this.learn) {
      const p = this.pending.get(origin)!;
      this.pending.set(origin, { firstSeen: p.firstSeen, attempts: p.attempts + 1 });
    }
    return false; // unknown → blocked until the operator allows it
  };

  /** Operator: permit this origin from now on (clears pending/denied). */
  allow(origin: string): void {
    this.allowed.add(origin);
    this.pending.delete(origin);
    this.denied.delete(origin);
  }

  /** Operator: keep this origin blocked and stop prompting for it. */
  deny(origin: string): void {
    this.denied.add(origin);
    this.pending.delete(origin);
  }

  pendingList(): PendingEgress[] {
    return [...this.pending].map(([origin, v]) => ({ origin, firstSeen: v.firstSeen, attempts: v.attempts }));
  }

  allowList(): string[] {
    return [...this.allowed];
  }

  get learnMode(): boolean {
    return this.learn;
  }
}
