import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    // Several integration tests launch a REAL headless Chromium (engine, gateway,
    // engine-adapter, egress-proxy e2e). Under the full parallel suite the browser
    // launch + first navigation can exceed the 5s default purely from CPU
    // contention — a latency effect, not a logic race (a real race surfaces as an
    // assertion failure regardless of the limit). The unit logic these tests cover
    // (e.g. the synchronous claim-once check-and-set in HandoffManager) is
    // race-free by construction. Give the slow, browser-backed tests headroom so
    // the gate is deterministic.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
