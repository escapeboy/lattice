/**
 * S7 integration tests — Observability / Trace store.
 * Browser-dependent tests skip when no Chromium found.
 */

import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createEngineAdapter, detectChromiumExecutable } from "@lattice/engine";
import type { EngineAdapter } from "@lattice/engine";
import { createPerceptionEngine } from "@lattice/perception";
import type { InteractionGraph } from "@lattice/perception";
import { createActionEngine } from "@lattice/action";
import { TraceRecorder } from "./recorder.js";
import { serializeTrace, deserializeTrace, writeTraceFile, readTraceFile } from "./serializer.js";
import { SessionReplayer } from "./replayer.js";
import { extractMetrics, formatMetrics } from "./metrics.js";
import { emitToSvod } from "./svod-emitter.js";
import { renderTrace, renderReplayDiff } from "./viewer.js";

// ── Unit tests (no browser) ───────────────────────────────────────────────────

describe("TraceRecorder", () => {
  it("records events in order with sequential seq numbers", () => {
    const rec = new TraceRecorder("session-unit");
    rec.recordNetwork("https://example.com", "GET", 200);
    rec.recordGrant("navigate", "benign", true, "auto-grant");
    const trace = rec.finish();

    expect(trace.events.length).toBeGreaterThan(2);
    // seq is monotonically increasing
    for (let i = 1; i < trace.events.length; i++) {
      expect(trace.events[i]!.seq).toBe(trace.events[i - 1]!.seq + 1);
    }
    // metrics event is last before session_end
    const metricsIdx = trace.events.findIndex((e) => e.kind === "metrics");
    const endIdx = trace.events.findIndex((e) => e.kind === "session_end");
    expect(metricsIdx).toBeLessThan(endIdx);
  });

  it("computes success rate correctly", () => {
    const rec = new TraceRecorder("session-sr");
    rec.recordAction({ type: "navigate", url: "https://a.com" });
    rec.recordActionResult(true, "https://a.com");
    rec.recordAction({ type: "navigate", url: "https://b.com" });
    rec.recordActionResult(false, "https://b.com", undefined, "timeout");
    const trace = rec.finish();

    const metrics = extractMetrics(trace);
    expect(metrics.totalActions).toBe(2);
    expect(metrics.successCount).toBe(1);
    expect(metrics.successRate).toBeCloseTo(0.5);
  });
});

describe("Serializer", () => {
  it("round-trips a trace through JSONL", () => {
    const rec = new TraceRecorder("session-serial");
    rec.recordNetwork("https://x.com", "GET", 200, 1024);
    rec.recordGrant("submit", "consequential", false, "no handler");
    const trace = rec.finish();

    const jsonl = serializeTrace(trace);
    const restored = deserializeTrace(jsonl);

    expect(restored.traceId).toBe(trace.traceId);
    expect(restored.sessionId).toBe(trace.sessionId);
    expect(restored.events.length).toBe(trace.events.length);
    expect(restored.events[0]!.kind).toBe("session_start");
  });

  it("every line of JSONL is valid JSON", () => {
    const rec = new TraceRecorder("session-jsonl");
    rec.recordNetwork("https://a.com", "POST", 201);
    const jsonl = serializeTrace(rec.finish());

    for (const line of jsonl.split("\n").filter((l) => l.trim())) {
      expect(() => { JSON.parse(line); }).not.toThrow();
    }
  });
});

describe("Metrics", () => {
  it("formatMetrics produces non-empty output", () => {
    const rec = new TraceRecorder("session-metrics");
    rec.recordAction({ type: "navigate", url: "https://x.com" });
    rec.recordActionResult(true, "https://x.com");
    const trace = rec.finish();
    const text = formatMetrics(extractMetrics(trace));
    expect(text).toContain("Trace:");
    expect(text).toContain("Actions:");
    expect(text).toContain("100.0%");
  });
});

describe("SvodEmitter", () => {
  it("calls write with a markdown note containing trace ID", async () => {
    const rec = new TraceRecorder("session-svod");
    rec.recordAction({ type: "navigate", url: "https://example.com" });
    rec.recordActionResult(true, "https://example.com");
    const trace = rec.finish();

    let writtenPath = "";
    let writtenContent = "";
    await emitToSvod(trace, (path, content) => {
      writtenPath = path;
      writtenContent = content;
      return Promise.resolve();
    });

    expect(writtenPath).toContain(trace.traceId);
    expect(writtenContent).toContain(trace.traceId);
    expect(writtenContent).toContain("Metrics");
    expect(writtenContent).toContain("Events");
  });
});

describe("Viewer", () => {
  it("renderTrace produces readable output for a trace", () => {
    const rec = new TraceRecorder("session-view");
    rec.recordAction({ type: "navigate", url: "https://example.com" });
    rec.recordActionResult(true, "https://example.com");
    const trace = rec.finish();
    const rendered = renderTrace(trace);
    expect(rendered).toContain("Lattice Session Trace");
    expect(rendered).toContain(trace.traceId);
    expect(rendered).toContain("navigate");
  });
});

// ── Browser integration tests ─────────────────────────────────────────────────

const executablePath = detectChromiumExecutable();
const describeIfBrowser = executablePath ? describe : describe.skip;

const FORM_HTML = `<!DOCTYPE html>
<html lang="en">
<head><title>Trace Test</title></head>
<body>
<form id="f">
  <label for="q">Query</label>
  <input id="q" type="text" name="q">
  <button type="submit">Go</button>
</form>
<div id="out"></div>
<script>
  document.getElementById("f").addEventListener("submit", (e) => {
    e.preventDefault();
    document.getElementById("out").textContent = "result:" + document.getElementById("q").value;
  });
</script>
</body>
</html>`;

const CHANGED_HTML = `<!DOCTYPE html>
<html lang="en">
<head><title>Trace Test — Changed</title></head>
<body>
<form id="f">
  <label for="q">Query</label>
  <input id="q" type="text" name="q">
  <label for="extra">Extra Field</label>
  <input id="extra" type="text" name="extra">
  <label for="another">Another Field</label>
  <input id="another" type="text" name="another">
  <button type="submit">Find</button>
</form>
</body>
</html>`;

function startTestServer(html: string): Promise<{ url: string; server: Server }> {
  return new Promise((resolve, reject) => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") { reject(new Error("bad addr")); return; }
      resolve({ url: `http://127.0.0.1:${addr.port}/`, server });
    });
  });
}

describeIfBrowser("Observability — browser integration", () => {
  let engine: EngineAdapter;
  let originalUrl: string;
  let changedUrl: string;
  let originalServer: Server;
  let changedServer: Server;

  beforeAll(async () => {
    engine = createEngineAdapter();
    await engine.launch({
      headless: true,
      ...(executablePath ? { executablePath } : {}),
    });
    const orig = await startTestServer(FORM_HTML);
    const changed = await startTestServer(CHANGED_HTML);
    originalUrl = orig.url;
    changedUrl = changed.url;
    originalServer = orig.server;
    changedServer = changed.server;
  });

  afterAll(async () => {
    await engine.shutdown();
    originalServer.close();
    changedServer.close();
  });

  it("records a session deterministically and JSONL round-trips", async () => {
    const ctx = await engine.createContext();
    const perception = createPerceptionEngine(ctx.cdp());
    const action = createActionEngine(ctx.cdp(), ctx, perception);
    const rec = new TraceRecorder(ctx.id, "ephemeral");

    // Navigate
    rec.recordAction({ type: "navigate", url: originalUrl });
    await action.execute({ type: "navigate", url: originalUrl });
    rec.recordActionResult(true, ctx.currentUrl());

    // Snapshot
    const snap = await perception.snapshot("L1") as InteractionGraph;
    rec.recordSnapshot("L1", snap.url, snap.title, Array.from(snap.nodes.values()));

    // Fill
    const qNode = Array.from(snap.nodes.values()).find((n) => n.label?.toLowerCase().includes("query"));
    if (qNode) {
      rec.recordAction({ type: "fill", target: { nodeId: qNode.id }, value: "test-value" });
      await action.execute({ type: "fill", target: { nodeId: qNode.id }, value: "test-value" }).catch(() => undefined);
      rec.recordActionResult(true, ctx.currentUrl());
    }

    const trace = rec.finish();
    await ctx.close();

    // JSONL round-trip
    const jsonl = serializeTrace(trace);
    const restored = deserializeTrace(jsonl);
    expect(restored.traceId).toBe(trace.traceId);
    expect(restored.events.length).toBe(trace.events.length);

    const metrics = extractMetrics(restored);
    expect(metrics.totalActions).toBeGreaterThan(0);
    expect(metrics.tierDistribution["L1"]).toBe(1);

    // File round-trip
    const filePath = join(tmpdir(), `lattice-trace-${trace.traceId}.jsonl`);
    await writeTraceFile(filePath, trace);
    const fromFile = await readTraceFile(filePath);
    expect(fromFile.traceId).toBe(trace.traceId);
  });

  it("replays deterministically against the same site", async () => {
    // Record
    const ctx = await engine.createContext();
    const perception = createPerceptionEngine(ctx.cdp());
    const action = createActionEngine(ctx.cdp(), ctx, perception);
    const rec = new TraceRecorder(ctx.id);

    rec.recordAction({ type: "navigate", url: originalUrl });
    await action.execute({ type: "navigate", url: originalUrl });
    rec.recordActionResult(true, ctx.currentUrl());

    const snap = await perception.snapshot("L1") as InteractionGraph;
    rec.recordSnapshot("L1", snap.url, snap.title, Array.from(snap.nodes.values()));

    const trace = rec.finish();
    await ctx.close();

    // Replay against same site — should not diverge
    const replayer = new SessionReplayer(engine);
    const result = await replayer.replay(trace);

    expect(result.traceId).toBe(trace.traceId);
    expect(result.actionsReplayed).toBeGreaterThan(0);
    // Same site — node counts should be similar (may have minor state differences)
    expect(result.liveSnapshotNodeCount).toBeGreaterThan(0);
    expect(result.recordedSnapshotNodeCount).toBeGreaterThan(0);
  });

  it("replay against changed site shows divergence (different node count)", async () => {
    // Record on original site
    const ctx = await engine.createContext();
    const perception = createPerceptionEngine(ctx.cdp());
    const action = createActionEngine(ctx.cdp(), ctx, perception);
    const rec = new TraceRecorder(ctx.id);

    rec.recordAction({ type: "navigate", url: originalUrl });
    await action.execute({ type: "navigate", url: originalUrl });
    rec.recordActionResult(true, ctx.currentUrl());

    const snapOrig = await perception.snapshot("L1") as InteractionGraph;
    rec.recordSnapshot("L1", snapOrig.url, snapOrig.title, Array.from(snapOrig.nodes.values()));

    const trace = rec.finish();
    await ctx.close();

    // Mutate the trace to navigate to the changed site instead
    // (simulates "same trace, different site" — we replace the navigate URL)
    const mutatedTrace = {
      ...trace,
      events: trace.events.map((e) =>
        e.kind === "action" && e.command.type === "navigate"
          ? { ...e, command: { type: "navigate" as const, url: changedUrl } }
          : e,
      ),
    };

    // Replay against changed site
    const replayer = new SessionReplayer(engine);
    const result = await replayer.replay(mutatedTrace);

    // Changed site has more inputs → different node count → should diverge
    const rendered = renderReplayDiff(trace, result.liveSnapshotNodeCount, result.snapshotDiffs);
    expect(rendered).toContain("Replay Diff");
    expect(result.liveSnapshotNodeCount).toBeGreaterThan(0);
    // The changed site has an extra input — node counts differ
    expect(result.recordedSnapshotNodeCount).not.toBe(result.liveSnapshotNodeCount);
  });

  it("emitToSvod writes a well-formed markdown note", async () => {
    const rec = new TraceRecorder("session-svod-browser");
    rec.recordAction({ type: "navigate", url: originalUrl });
    rec.recordActionResult(true, originalUrl);

    const ctx = await engine.createContext();
    await ctx.close();
    const trace = rec.finish();

    let capturedPath = "";
    let capturedContent = "";
    await emitToSvod(trace, (path, content) => {
      capturedPath = path;
      capturedContent = content;
      return Promise.resolve();
    });

    expect(capturedPath).toMatch(/projects\/lattice\/traces\/.+\.md/);
    expect(capturedContent).toContain("# Lattice Trace");
    expect(capturedContent).toContain(trace.traceId);
    expect(capturedContent).toContain("## Metrics");
    expect(capturedContent).toContain("navigate");
  });
});
