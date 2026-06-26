import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, request, type Server } from "node:http";
import { EgressProxy, originAllowlist, EgressPolicy } from "./index.js";

/** A trivial upstream that echoes a marker, so we can see a request got through. */
function startTarget(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer((_req, res) => res.writeHead(200).end("UPSTREAM-OK"));
    server.listen(0, "127.0.0.1", () => resolve({ server, port: (server.address() as { port: number }).port }));
  });
}

/** Send a forward-proxy GET (absolute-URI) through the proxy; resolve {status, body}. */
function proxyGet(proxyPort: number, absoluteUrl: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(absoluteUrl);
    const req = request({ host: "127.0.0.1", port: proxyPort, method: "GET", path: absoluteUrl, headers: { Host: u.host } }, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

/** Send a CONNECT through the proxy; resolve the status line (e.g. 200 / 403). */
function proxyConnect(proxyPort: number, hostPort: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: proxyPort, method: "CONNECT", path: hostPort });
    req.on("connect", (res, socket) => {
      socket.destroy();
      resolve(res.statusCode ?? 0);
    });
    // A refused CONNECT comes back as a normal response, not a 'connect' event.
    req.on("response", (res) => {
      res.destroy();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end();
  });
}

describe("EgressProxy — per-request destination allowlist", () => {
  let target: { server: Server; port: number };
  let proxy: EgressProxy;
  let proxyPort: number;

  beforeAll(async () => {
    target = await startTarget();
    proxy = new EgressProxy({
      // http:// and https:// are distinct origins; allow both for the test host.
      allow: originAllowlist(["http://allowed.test", "https://allowed.test"], []),
      hostMap: {
        "allowed.test": `127.0.0.1:${target.port}`,
        "blocked.test": `127.0.0.1:${target.port}`, // reachable, but policy denies
      },
    });
    proxyPort = (await proxy.start()).port;
  });

  afterAll(async () => {
    await proxy.stop();
    await new Promise<void>((r) => target.server.close(() => r()));
  });

  it("forwards an allowed HTTP destination to the upstream (200)", async () => {
    const r = await proxyGet(proxyPort, "http://allowed.test/x");
    expect(r.status).toBe(200);
    expect(r.body).toBe("UPSTREAM-OK");
  });

  it("blocks a denied HTTP destination with 403 — the upstream is never reached", async () => {
    const r = await proxyGet(proxyPort, "http://blocked.test/steal?d=secret");
    expect(r.status).toBe(403);
    expect(r.body).not.toContain("UPSTREAM-OK");
  });

  it("CONNECT to an allowed host is established (200)", async () => {
    expect(await proxyConnect(proxyPort, `allowed.test:${target.port}`)).toBe(200);
  });

  it("CONNECT to a denied host is refused (403)", async () => {
    expect(await proxyConnect(proxyPort, "blocked.test:443")).toBe(403);
  });

  it("records every decision on the live path (audit)", () => {
    const blocked = proxy.decisions.filter((d) => !d.allowed).map((d) => d.origin);
    expect(blocked).toContain("http://blocked.test");
    expect(blocked).toContain("https://blocked.test");
  });
});

describe("originAllowlist", () => {
  it("permits task origins + allowlist, denies everything else", () => {
    const allow = originAllowlist(["https://app.example.com"], ["https://api.partner.com"]);
    expect(allow("https://app.example.com")).toBe(true);
    expect(allow("https://api.partner.com")).toBe(true);
    expect(allow("https://attacker.example")).toBe(false);
  });
});

describe("EgressPolicy — ask-to-allow (learn) mode", () => {
  it("default-deny holds: an unknown origin is blocked and recorded pending", () => {
    let t = 1000;
    const p = new EgressPolicy(["https://allowed.com"], true, () => t++);
    expect(p.decide("https://allowed.com")).toBe(true);
    // unknown → blocked (nothing leaks), but surfaced for the operator
    expect(p.decide("https://new.com")).toBe(false);
    const pend = p.pendingList();
    expect(pend.map((x) => x.origin)).toEqual(["https://new.com"]);
    expect(pend[0]!.attempts).toBe(1);
    // a retry bumps attempts but never auto-allows
    expect(p.decide("https://new.com")).toBe(false);
    expect(p.pendingList()[0]!.attempts).toBe(2);
  });

  it("operator allow lets it through from the next attempt and clears pending", () => {
    const p = new EgressPolicy([], true);
    expect(p.decide("https://x.com")).toBe(false);
    p.allow("https://x.com");
    expect(p.decide("https://x.com")).toBe(true);
    expect(p.pendingList()).toEqual([]);
    expect(p.allowList()).toContain("https://x.com");
  });

  it("operator deny keeps it blocked and stops re-prompting", () => {
    const p = new EgressPolicy([], true);
    expect(p.decide("https://bad.com")).toBe(false);
    p.deny("https://bad.com");
    expect(p.decide("https://bad.com")).toBe(false);
    expect(p.pendingList()).toEqual([]); // no longer prompts
  });

  it("strict mode (learn=false) blocks unknowns WITHOUT prompting", () => {
    const p = new EgressPolicy(["https://ok.com"], false);
    expect(p.decide("https://ok.com")).toBe(true);
    expect(p.decide("https://unknown.com")).toBe(false);
    expect(p.pendingList()).toEqual([]);
  });

  it("decide is usable as the EgressProxy allow function (never silently allows)", () => {
    const p = new EgressPolicy([], true);
    const allow: (o: string) => boolean = p.decide;
    expect(allow("https://anything.com")).toBe(false);
  });
});
