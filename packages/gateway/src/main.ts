/**
 * Self-hosted Lattice Agent Gateway — Docker/CLI entrypoint.
 *
 * Launches a headless Chromium engine, builds the security kernel from
 * environment policy, and serves the MCP gateway over Streamable HTTP.
 *
 * Env:
 *   LATTICE_PORT            listen port (default 8765)
 *   LATTICE_HOST            bind host (default 0.0.0.0)
 *   CHROME_EXECUTABLE       Chromium executable (else auto-detected)
 *   LATTICE_ALLOWED_ORIGINS comma-separated task-origin allowlist
 *   LATTICE_EGRESS_ALLOWLIST comma-separated egress origin allowlist
 *   LATTICE_PROHIBITED      comma-separated always-prohibited action types
 *   LATTICE_TRANSPORT       "http" (default) or "stdio"
 *   LATTICE_NTFY_BASE       ntfy server base URL for handoff push (optional)
 *   LATTICE_HANDOFF_KEY     HMAC key for signing input handoffs (optional)
 */

import { createEngineAdapter, detectChromiumExecutable } from "@lattice/engine";
import { SecurityKernelImpl } from "@lattice/kernel";
import { createAgentGateway, NtfyTransport } from "./index.js";

function list(env: string | undefined): string[] {
  return (env ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

async function main(): Promise<void> {
  // Legacy CDP-only entrypoint. The production default is apps/serve (build-on,
  // firewalled). This stack lacks the build-on firewall — dev/debug only.
  console.error(
    "WARNING: packages/gateway/main.js is the legacy raw-CDP entrypoint (no build-on " +
      "firewall). For production use apps/serve/main.js (build-on default).",
  );
  const transportKind = process.env["LATTICE_TRANSPORT"] ?? "http";
  const port = Number(process.env["LATTICE_PORT"] ?? "8765");
  const host = process.env["LATTICE_HOST"] ?? "0.0.0.0";

  const executablePath = detectChromiumExecutable();
  if (!executablePath) {
    console.error("No Chromium found. Set CHROME_EXECUTABLE or install Chrome.");
    process.exitCode = 1;
    return;
  }

  const engine = createEngineAdapter();
  await engine.launch({ headless: true, executablePath });

  const kernel = new SecurityKernelImpl({
    allowedOrigins: list(process.env["LATTICE_ALLOWED_ORIGINS"]),
    egressAllowlist: list(process.env["LATTICE_EGRESS_ALLOWLIST"]),
    prohibitedActions: list(process.env["LATTICE_PROHIBITED"]),
  });

  const ntfyBase = process.env["LATTICE_NTFY_BASE"];
  const handoffKey = process.env["LATTICE_HANDOFF_KEY"];
  const gateway = createAgentGateway({
    engine,
    kernel,
    ...(ntfyBase ? { handoffTransport: new NtfyTransport(ntfyBase) } : {}),
    ...(handoffKey ? { handoffSigningKey: handoffKey } : {}),
  });

  const shutdown = () => {
    void (async () => {
      await gateway.stop();
      await engine.shutdown();
      process.exit(0);
    })();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  if (transportKind === "stdio") {
    await gateway.startStdio();
    console.error("Lattice gateway listening on stdio");
    return;
  }

  const { url } = await gateway.startHttp(port, host);
  console.error(`Lattice gateway listening on ${url}`);
}

main().catch((e: unknown) => {
  console.error(e);
  process.exitCode = 1;
});
