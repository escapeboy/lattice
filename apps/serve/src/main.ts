/**
 * `lattice serve` — boot the unified process: MCP gateway + control-plane UI on
 * one shared kernel.
 *
 * Env:
 *   LATTICE_PORT            gateway MCP port (default 8765)
 *   LATTICE_HOST            bind host (default 0.0.0.0)
 *   CONTROL_PLANE_PORT      control-plane UI port (default 7900)
 *   CHROME_EXECUTABLE       Chromium (else auto-detected)
 *   LATTICE_ALLOWED_ORIGINS / LATTICE_EGRESS_ALLOWLIST / LATTICE_PROHIBITED
 *   LATTICE_NTFY_BASE / LATTICE_HANDOFF_KEY   handoff push + signing
 *   LATTICE_VAULT_KEY / LATTICE_VAULT_PATH    vault encryption + persistence
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createEngineAdapter, detectChromiumExecutable } from "@lattice/engine";
import { SecurityKernelImpl } from "@lattice/kernel";
import { NtfyTransport, Vault } from "@lattice/gateway";
import { createLatticeCore } from "./index.js";

function list(env: string | undefined): string[] {
  return (env ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

async function main(): Promise<void> {
  const gwPort = Number(process.env["LATTICE_PORT"] ?? "8765");
  const gwHost = process.env["LATTICE_HOST"] ?? "0.0.0.0";
  const cpPort = Number(process.env["CONTROL_PLANE_PORT"] ?? "7900");

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
  const vaultKey = process.env["LATTICE_VAULT_KEY"];
  const vaultPath = process.env["LATTICE_VAULT_PATH"];

  // Default trace sink: write each Svod note under LATTICE_TRACE_DIR.
  const traceDir = process.env["LATTICE_TRACE_DIR"] ?? "./traces";
  const traceWriter = async (path: string, content: string): Promise<void> => {
    const abs = join(traceDir, `${path.replace(/[/\\]/g, "_")}.md`);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content, "utf8");
  };

  const cpToken = process.env["LATTICE_CP_TOKEN"];
  const { gateway, control } = createLatticeCore({
    engine,
    kernel,
    vault: new Vault(vaultKey, vaultPath),
    traceWriter,
    ...(ntfyBase ? { handoffTransport: new NtfyTransport(ntfyBase) } : {}),
    ...(handoffKey ? { handoffSigningKey: handoffKey } : {}),
    ...(cpToken ? { controlPlaneToken: cpToken } : {}),
  });

  const shutdown = () => {
    void (async () => {
      await gateway.stop();
      await control.stop();
      await engine.shutdown();
      process.exit(0);
    })();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  const { url: mcpUrl } = await gateway.startHttp(gwPort, gwHost);
  const { url: cpUrl } = await control.start(cpPort, "127.0.0.1");
  console.error(`Lattice serve — MCP gateway: ${mcpUrl}`);
  console.error(`Lattice serve — control plane: ${cpUrl}`);
}

main().catch((e: unknown) => {
  console.error(e);
  process.exitCode = 1;
});
