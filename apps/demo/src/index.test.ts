/**
 * S9 — demo agent + mobile responsive sanity check.
 * Browser integration tests skip automatically when no Chromium is found.
 */

import { createServer, type Server } from "node:http";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createEngineAdapter, detectChromiumExecutable } from "@lattice/engine";
import type { EngineAdapter } from "@lattice/engine";
import { runResponsiveCheck } from "./sanity-check.js";
import { RESPONSIVE_NAV_HTML } from "./fixture.js";
import { MOBILE_PROFILE, DESKTOP_PROFILE } from "./profiles.js";

const executablePath = detectChromiumExecutable();
const describeIfBrowser = executablePath ? describe : describe.skip;

function startTestServer(html: string): Promise<{ url: string; server: Server }> {
  return new Promise((resolve, reject) => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") { reject(new Error("bad address")); return; }
      resolve({ url: `http://127.0.0.1:${addr.port}/`, server });
    });
    server.on("error", reject);
  });
}

describe("S9 device profiles", () => {
  it("mobile profile is the 390×844 DPR3 target", () => {
    expect(MOBILE_PROFILE.width).toBe(390);
    expect(MOBILE_PROFILE.height).toBe(844);
    expect(MOBILE_PROFILE.deviceScaleFactor).toBe(3);
    expect(MOBILE_PROFILE.mobile).toBe(true);
    expect(MOBILE_PROFILE.maxTouchPoints).toBeGreaterThan(0);
    expect(MOBILE_PROFILE.userAgent).toMatch(/Mobile/);
  });

  it("desktop baseline is wider than the 768px breakpoint", () => {
    expect(DESKTOP_PROFILE.width).toBeGreaterThan(768);
    expect(DESKTOP_PROFILE.mobile).toBe(false);
  });
});

describeIfBrowser("S9 mobile responsive sanity check — integration", () => {
  let testUrl: string;
  let httpServer: Server;
  let adapter: EngineAdapter;

  beforeAll(async () => {
    const { url, server } = await startTestServer(RESPONSIVE_NAV_HTML);
    testUrl = url;
    httpServer = server;
    adapter = createEngineAdapter();
    await adapter.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  });

  afterAll(async () => {
    await adapter?.shutdown();
    httpServer?.close();
  });

  it("answers 'does nav collapse at 390px' as a perception query", async () => {
    const { report } = await runResponsiveCheck(adapter, testUrl);

    expect(report.navCollapsesAt390).toBe(true);
    expect(report.answer).toMatch(/^Yes\./);

    // Mobile: links gone, visible toggle.
    expect(report.mobile.navLinkCount).toBe(0);
    expect(report.mobile.hamburgerPresent).toBe(true);
    expect(report.mobile.hamburgerVisible).toBe(true);
    expect(report.mobile.collapsed).toBe(true);

    // Desktop: 4 inline links, no toggle in the accessibility tree.
    expect(report.desktop.navLinkCount).toBe(4);
    expect(report.desktop.hamburgerPresent).toBe(false);
    expect(report.desktop.collapsed).toBe(false);
  });

  it("L3 geometry confirms the toggle renders inside the 390px viewport", async () => {
    const { report } = await runResponsiveCheck(adapter, testUrl);
    const geo = report.mobile.hamburgerGeometry;
    expect(geo).toBeDefined();
    expect(geo!.width).toBeGreaterThan(0);
    expect(geo!.height).toBeGreaterThan(0);
    expect(geo!.x).toBeGreaterThanOrEqual(0);
    expect(geo!.x).toBeLessThan(MOBILE_PROFILE.width);
  });

  it("emits a deterministic trace carrying the breakpoint report", async () => {
    const { trace, report } = await runResponsiveCheck(adapter, testUrl);

    const action = trace.events.find((e) => e.kind === "action");
    expect(action).toBeDefined();

    const result = trace.events.find((e) => e.kind === "action_result");
    expect(result).toBeDefined();
    // The verdict rides in the action_result's extracted payload → lands in Svod trace.
    expect((result as { extracted: unknown }).extracted).toMatchObject({
      navCollapsesAt390: report.navCollapsesAt390,
      query: report.query,
    });

    // Both fidelity tiers were exercised: L1 for presence, L3 for geometry.
    const tiers = trace.events.filter((e) => e.kind === "snapshot").map((e) => (e as { tier: string }).tier);
    expect(tiers).toContain("L1");
    expect(tiers).toContain("L3");
  });
});
