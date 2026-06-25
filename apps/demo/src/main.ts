/**
 * CLI: launch a real browser, serve the responsive fixture, run the mobile
 * sanity check, print the report, and write the trace to disk as JSONL.
 *
 * Usage: node dist/main.js [url] [--out <trace.jsonl>]
 * With no url, the bundled fixture is served on an ephemeral local port.
 */

import { createServer, type Server } from "node:http";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createEngineAdapter, detectChromiumExecutable } from "@lattice/engine";
import { writeTraceFile, extractMetrics, formatMetrics } from "@lattice/observability";
import { runResponsiveCheck } from "./sanity-check.js";
import { RESPONSIVE_NAV_HTML } from "./fixture.js";

function serveFixture(): Promise<{ url: string; server: Server }> {
  return new Promise((resolveP, reject) => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(RESPONSIVE_NAV_HTML);
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") { reject(new Error("bad address")); return; }
      resolveP({ url: `http://127.0.0.1:${addr.port}/`, server });
    });
    server.on("error", reject);
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const outIdx = args.indexOf("--out");
  const outPath = outIdx >= 0 ? args[outIdx + 1] : undefined;
  const urlArg = args.find((a) => a.startsWith("http"));

  const executablePath = detectChromiumExecutable();
  if (!executablePath) {
    console.error("No Chromium-compatible browser found. Set CHROME_PATH or install Chrome.");
    process.exitCode = 1;
    return;
  }

  let fixtureServer: Server | undefined;
  let targetUrl = urlArg;
  if (!targetUrl) {
    const served = await serveFixture();
    targetUrl = served.url;
    fixtureServer = served.server;
  }

  const adapter = createEngineAdapter();
  await adapter.launch({ headless: true, executablePath });

  try {
    const { report, trace } = await runResponsiveCheck(adapter, targetUrl);

    console.log("\n── Mobile responsive sanity check ──────────────────────────");
    console.log(`Query:  ${report.query}`);
    console.log(`URL:    ${report.url}`);
    console.log(
      `Mobile (${report.mobile.viewport.width}×${report.mobile.viewport.height} @${report.mobile.viewport.dpr}x): ` +
        `${report.mobile.navLinkCount} inline links, toggle ${report.mobile.hamburgerPresent ? "present" : "absent"}` +
        `${report.mobile.hamburgerGeometry ? ` @ ${Math.round(report.mobile.hamburgerGeometry.x)},${Math.round(report.mobile.hamburgerGeometry.y)} ${Math.round(report.mobile.hamburgerGeometry.width)}×${Math.round(report.mobile.hamburgerGeometry.height)}` : ""}` +
        ` → ${report.mobile.collapsed ? "COLLAPSED" : "expanded"}`,
    );
    console.log(
      `Desktop (${report.desktop.viewport.width}×${report.desktop.viewport.height}): ` +
        `${report.desktop.navLinkCount} inline links, toggle ${report.desktop.hamburgerPresent ? "present" : "absent"}` +
        ` → ${report.desktop.collapsed ? "COLLAPSED" : "expanded"}`,
    );
    console.log(`\nAnswer: ${report.answer}\n`);
    console.log(formatMetrics(extractMetrics(trace)));

    if (outPath) {
      const abs = resolve(outPath);
      await mkdir(dirname(abs), { recursive: true });
      await writeTraceFile(abs, trace);
      console.log(`\nTrace written: ${abs}`);
    }
  } finally {
    await adapter.shutdown();
    fixtureServer?.close();
  }
}

main().catch((e: unknown) => {
  console.error(e);
  process.exitCode = 1;
});
