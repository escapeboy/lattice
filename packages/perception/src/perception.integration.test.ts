/**
 * S2 integration tests — requires a Chromium-compatible browser.
 */

import { createServer, type Server } from "node:http";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createEngineAdapter, detectChromiumExecutable } from "@lattice/engine";
import type { ContextHandle, EngineAdapter } from "@lattice/engine";
import { createPerceptionEngine } from "./index.js";
import type { InteractionGraph } from "./index.js";

const executablePath = detectChromiumExecutable();
const describeIfBrowser = executablePath ? describe : describe.skip;

const TEST_FORM_HTML = `<!DOCTYPE html>
<html lang="en">
<head><title>Lattice Perception Test</title></head>
<body>
  <main>
    <nav aria-label="Main navigation">
      <a href="/home">Home</a>
      <a href="/about">About</a>
    </nav>
    <h1>Registration Form</h1>
    <form id="reg-form">
      <label for="name">Full Name</label>
      <input id="name" type="text" placeholder="Your name" required>

      <label for="email">Email</label>
      <input id="email" type="email" placeholder="you@example.com">

      <label for="role">Role</label>
      <select id="role">
        <option value="dev">Developer</option>
        <option value="pm">Product Manager</option>
      </select>

      <label>
        <input type="checkbox" id="agree"> I agree to terms
      </label>

      <button type="submit" id="submit-btn">Register</button>
      <button type="button" id="cancel-btn" disabled>Cancel</button>
    </form>
  </main>
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

describeIfBrowser("@lattice/perception — integration (S2)", () => {
  let testUrl: string;
  let httpServer: Server;
  let adapter: EngineAdapter;
  let ctx: ContextHandle;

  beforeAll(async () => {
    const { url, server } = await startTestServer(TEST_FORM_HTML);
    testUrl = url;
    httpServer = server;

    adapter = createEngineAdapter();
    await adapter.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
    ctx = await adapter.createContext();
    await ctx.navigate(testUrl);
  });

  afterAll(async () => {
    await ctx?.close();
    await adapter?.shutdown();
    httpServer?.close();
  });

  it("L1 snapshot contains all interactive elements with stable IDs", async () => {
    const engine = createPerceptionEngine(ctx.cdp());
    const snap = await engine.snapshot("L1") as InteractionGraph;

    expect(snap.tier).toBe("L1");
    const nodes = Array.from(snap.nodes.values());

    // Must find: 2 links, text input, email input, select, checkbox, 2 buttons, heading
    const byRole = (role: string) => nodes.filter((n) => n.role === role);

    expect(byRole("link").length).toBeGreaterThanOrEqual(2);
    expect(byRole("input").length).toBeGreaterThanOrEqual(2);
    // Chrome AX tree reports <select> as "combobox"
    expect(byRole("combobox").length + byRole("select").length).toBeGreaterThanOrEqual(1);
    expect(byRole("checkbox").length).toBeGreaterThanOrEqual(1);
    expect(byRole("button").length).toBeGreaterThanOrEqual(2);
    expect(byRole("heading").length).toBeGreaterThanOrEqual(1);
  });

  it("L1 serialized size < 5KB for the test form", async () => {
    const engine = createPerceptionEngine(ctx.cdp());
    const snap = await engine.snapshot("L1") as InteractionGraph;
    expect(snap.serializedSize).toBeLessThan(5 * 1024);
  });

  it("node IDs are stable across re-snapshots (no DOM mutations)", async () => {
    const engine = createPerceptionEngine(ctx.cdp());
    const snap1 = await engine.snapshot("L1") as InteractionGraph;
    const snap2 = await engine.snapshot("L1") as InteractionGraph;

    const ids1 = new Set(snap1.nodeOrder);
    const ids2 = new Set(snap2.nodeOrder);

    // Every ID in snap1 should appear in snap2
    for (const id of ids1) {
      expect(ids2.has(id)).toBe(true);
    }
  });

  it("disabled button is reflected in state", async () => {
    const engine = createPerceptionEngine(ctx.cdp());
    const snap = await engine.snapshot("L1") as InteractionGraph;
    const buttons = Array.from(snap.nodes.values()).filter((n) => n.role === "button");
    const disabledBtn = buttons.find((b) => b.state.disabled);
    expect(disabledBtn).toBeDefined();
    expect(disabledBtn?.label).toContain("Cancel");
  });

  it("populates href on links and level on headings (regression)", async () => {
    const engine = createPerceptionEngine(ctx.cdp());
    const snap = await engine.snapshot("L1") as InteractionGraph;
    const nodes = Array.from(snap.nodes.values());

    // href: pushNodesByBackendIdsToFrontend returns `nodeIds` (plural) — a prior
    // bug destructured `nodeId` and left every link's href undefined.
    const links = nodes.filter((n) => n.role === "link");
    expect(links.length).toBeGreaterThanOrEqual(2);
    const hrefs = links.map((l) => l.href);
    expect(hrefs).toContain("/home");
    expect(hrefs).toContain("/about");

    // heading level: the AX "level" property is an integer, not a string.
    const h1 = nodes.find((n) => n.role === "heading" && n.label.includes("Registration"));
    expect(h1).toBeDefined();
    expect(h1!.level).toBe(1);
  });

  it("delta shows only changed nodes after label update via JS", async () => {
    const engine = createPerceptionEngine(ctx.cdp());
    const snap1 = await engine.snapshot("L1") as InteractionGraph;

    // Mutate the DOM: change the submit button label
    await ctx.cdp().send("Runtime.evaluate", {
      expression: `document.getElementById('submit-btn').textContent = 'Submitting…'`,
    });

    const snap2 = await engine.snapshot("L1") as InteractionGraph;
    const delta = engine.delta(snap1, snap2);

    // Only the changed button should be in updated (nothing added or removed)
    expect(delta.added.length + delta.removed.length).toBe(0);
    const changedLabels = delta.updated.map((n) => n.label);
    expect(changedLabels.some((l) => l.includes("Submitting"))).toBe(true);
  });

  // NOTE: navigates away from the form fixture — keep this test last in the block.
  it("recovers clickable div-soup elements with inferred roles (no a11y)", async () => {
    const page =
      `<!DOCTYPE html><html><head><title>noa11y</title></head><body>` +
      `<div onclick="a()" style="cursor:pointer">Home</div>` +
      `<div onclick="b()" style="cursor:pointer">Sign In</div>` +
      `<div onclick="c()" style="cursor:pointer">Buy Now</div>` +
      `<div class="copy">just text, not clickable</div></body></html>`;
    await ctx.navigate("data:text/html," + encodeURIComponent(page));

    const engine = createPerceptionEngine(ctx.cdp());
    const snap = (await engine.snapshot("L1")) as InteractionGraph;
    const nodes = Array.from(snap.nodes.values());

    // Role-less <div onclick> buttons are recovered with an inferred "button" role
    // (Chrome's read_page only labels these "generic").
    const buttonLabels = nodes.filter((n) => n.role === "button").map((n) => n.label);
    expect(buttonLabels).toContain("Home");
    expect(buttonLabels).toContain("Sign In");
    expect(buttonLabels).toContain("Buy Now");

    // A non-interactive text div must NOT be promoted to a node (stays lean).
    expect(nodes.some((n) => n.label.includes("just text"))).toBe(false);
  });

  it("does not duplicate a clickable wrapper around a real control", async () => {
    // Outer div is clickable (onclick) but wraps a real <button>. The button is
    // captured with its proper role; the wrapper must be dropped, not emitted as
    // a second inferred "button" with the same aggregated label.
    const page =
      `<!DOCTYPE html><html><head><title>wrap</title></head><body>` +
      `<div onclick="x()" style="cursor:pointer"><button onclick="y()">Real</button></div>` +
      `</body></html>`;
    await ctx.navigate("data:text/html," + encodeURIComponent(page));

    const engine = createPerceptionEngine(ctx.cdp());
    const snap = (await engine.snapshot("L1")) as InteractionGraph;
    const realButtons = Array.from(snap.nodes.values()).filter(
      (n) => n.role === "button" && n.label === "Real",
    );
    expect(realButtons).toHaveLength(1);
  });
});
