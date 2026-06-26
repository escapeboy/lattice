import { describe, it, expect } from "vitest";
import { ControlPlaneServer } from "./server.js";

// Audit: the credentialed control-plane API must NOT send a wildcard CORS header
// (it would let a cross-origin page read grant-mint responses).
describe("ControlPlaneServer — no wildcard CORS on the credentialed API", () => {
  it("does not set Access-Control-Allow-Origin: *", async () => {
    const server = new ControlPlaneServer();
    const { url } = await server.start(0, "127.0.0.1");
    try {
      const r = await fetch(`${url}/policy`);
      await r.text();
      expect(r.headers.get("access-control-allow-origin")).not.toBe("*");
    } finally {
      await server.stop();
    }
  });
});
