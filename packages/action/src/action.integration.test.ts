/**
 * S3 integration tests — requires a Chromium-compatible browser.
 */

import { createServer, type Server } from "node:http";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createEngineAdapter, detectChromiumExecutable } from "@lattice/engine";
import type { ContextHandle, EngineAdapter } from "@lattice/engine";
import { createPerceptionEngine } from "@lattice/perception";
import type { InteractionGraph } from "@lattice/perception";
import { createActionEngine, ActionError } from "./index.js";
import type { ActionEngine } from "./types.js";

const executablePath = detectChromiumExecutable();
const describeIfBrowser = executablePath ? describe : describe.skip;

const TEST_FORM_HTML = `<!DOCTYPE html>
<html lang="en">
<head><title>Action Test</title></head>
<body>
<main>
  <form id="test-form">
    <label for="name">Name</label>
    <input id="name" type="text" name="name">

    <label for="email">Email</label>
    <input id="email" type="email" name="email">

    <label for="role">Role</label>
    <select id="role" name="role">
      <option value="">-- pick --</option>
      <option value="dev">Developer</option>
      <option value="pm">PM</option>
    </select>

    <label><input id="agree" type="checkbox" name="agree"> Agree</label>

    <button type="submit" id="submit-btn">Submit</button>
    <button type="button" id="disabled-btn" disabled>Disabled</button>
  </form>
  <div id="result" style="display:none"></div>
</main>
<script>
  document.getElementById('test-form').addEventListener('submit', function(e) {
    e.preventDefault();
    const data = new FormData(this);
    document.getElementById('result').style.display = 'block';
    document.getElementById('result').textContent = JSON.stringify(Object.fromEntries(data));
  });
</script>
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
      if (!addr || typeof addr === "string") return reject(new Error("Bad address"));
      resolve({ url: `http://127.0.0.1:${addr.port}/`, server });
    });
    server.on("error", reject);
  });
}

describeIfBrowser("@lattice/action — integration (S3)", () => {
  let testUrl: string;
  let httpServer: Server;
  let adapter: EngineAdapter;
  let ctx: ContextHandle;
  let actionEngine: ActionEngine;

  beforeAll(async () => {
    const { url, server } = await startTestServer(TEST_FORM_HTML);
    testUrl = url;
    httpServer = server;

    adapter = createEngineAdapter();
    await adapter.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
    ctx = await adapter.createContext();
    await ctx.navigate(testUrl);

    const perception = createPerceptionEngine(ctx.cdp());
    actionEngine = createActionEngine(ctx.cdp(), ctx, perception);
  });

  afterAll(async () => {
    await ctx?.close();
    await adapter?.shutdown();
    httpServer?.close();
  });

  it("fill text input by nodeId returns delta with no sleep()", async () => {
    // Re-perceive to get fresh nodeIds
    const snap = await createPerceptionEngine(ctx.cdp()).snapshot("L1") as InteractionGraph;
    const nameNode = Array.from(snap.nodes.values()).find(
      (n) => n.role === "input" && (n.label === "Name" || n.axName === "Name"),
    );
    expect(nameNode, "name input not found in IG").toBeDefined();

    const result = await actionEngine.execute({
      type: "fill",
      target: { nodeId: nameNode!.id },
      value: "Alice",
    });

    expect(result.success).toBe(true);
    expect(result.delta).toBeDefined();

    // Verify the value was set
    const valueResult = await ctx.cdp().send<{ result: { value: string } }>("Runtime.evaluate", {
      expression: "document.getElementById('name').value",
      returnByValue: true,
    });
    expect(valueResult.result.value).toBe("Alice");
  });

  it("fill email input", async () => {
    const snap = await createPerceptionEngine(ctx.cdp()).snapshot("L1") as InteractionGraph;
    const emailNode = Array.from(snap.nodes.values()).find(
      (n) => n.role === "input" && (n.label === "Email" || n.axName === "Email"),
    );
    expect(emailNode).toBeDefined();

    await actionEngine.execute({
      type: "fill",
      target: { nodeId: emailNode!.id },
      value: "alice@example.com",
    });

    const val = await ctx.cdp().send<{ result: { value: string } }>("Runtime.evaluate", {
      expression: "document.getElementById('email').value",
      returnByValue: true,
    });
    expect(val.result.value).toBe("alice@example.com");
  });

  it("disabled button throws ActionError with code=disabled", async () => {
    const snap = await createPerceptionEngine(ctx.cdp()).snapshot("L1") as InteractionGraph;
    const disabledNode = Array.from(snap.nodes.values()).find(
      (n) => n.role === "button" && n.state.disabled,
    );
    expect(disabledNode, "disabled button not found").toBeDefined();

    await expect(
      actionEngine.execute({ type: "act", target: { nodeId: disabledNode!.id } }),
    ).rejects.toThrow(ActionError);

    try {
      await actionEngine.execute({ type: "act", target: { nodeId: disabledNode!.id } });
    } catch (e) {
      expect(e instanceof ActionError).toBe(true);
      expect((e as ActionError).code).toBe("disabled");
    }
  });

  it("wait_for network_idle completes without sleep()", async () => {
    const start = Date.now();
    const result = await actionEngine.execute({
      type: "wait_for",
      condition: { kind: "network_idle", timeoutMs: 2000 },
    });
    const elapsed = Date.now() - start;
    expect(result.success).toBe(true);
    // Should settle well under 2s on a quiet page
    expect(elapsed).toBeLessThan(2100);
  });

  it("submit form and delta shows result div appearing", async () => {
    // Fill name if not already set
    const snap = await createPerceptionEngine(ctx.cdp()).snapshot("L1") as InteractionGraph;
    const submitNode = Array.from(snap.nodes.values()).find(
      (n) => n.role === "button" && !n.state.disabled && (n.label === "Submit" || n.axName === "Submit"),
    );
    expect(submitNode, "submit button not found").toBeDefined();

    const result = await actionEngine.execute({
      type: "submit",
      target: { nodeId: submitNode!.id },
    });

    expect(result.success).toBe(true);
    // After submit, the #result div should be visible
    const visible = await ctx.cdp().send<{ result: { value: boolean } }>("Runtime.evaluate", {
      expression: "document.getElementById('result').style.display !== 'none'",
      returnByValue: true,
    });
    expect(visible.result.value).toBe(true);
  });

  it("extract text content via query", async () => {
    const result = await actionEngine.execute({
      type: "extract",
      query: "text:#result",
    });
    expect(result.success).toBe(true);
    expect(typeof result.extracted).toBe("string");
  });
});
