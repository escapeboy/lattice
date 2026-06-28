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
 *   LATTICE_PII_FULL_ORIGINS  origins to log in full (default: all redacted)
 */

import { mkdir, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { createEngineAdapter, detectChromiumExecutable } from "@lattice/engine";
import { AgentBrowserEngine } from "@lattice/engine-adapter";
import { SecurityKernelImpl } from "@lattice/kernel";
import { NtfyTransport, Vault } from "@lattice/gateway";
import { EgressProxy, EgressPolicy, originAllowlist } from "@lattice/egress-proxy";
import { createLatticeCore, resolveEngineKind } from "./index.js";

function list(env: string | undefined): string[] {
  return (env ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

async function main(): Promise<void> {
  const gwPort = Number(process.env["LATTICE_PORT"] ?? "8765");
  const gwHost = process.env["LATTICE_HOST"] ?? "0.0.0.0";
  const cpPort = Number(process.env["CONTROL_PLANE_PORT"] ?? "7900");

  // Engine selection (ADR 0002): the DEFAULT is the build-on stack (agent-browser
  // behind the governed session), where eval/raw-CDP/file are structurally absent.
  // The raw CDP stack is opt-in ONLY via LATTICE_ENGINE=cdp — it lacks the
  // build-on firewall (a raw cdp() handle exists) and is for local dev/debug, not
  // production. Any value other than "cdp" selects build-on.
  const engineKind = resolveEngineKind(process.env["LATTICE_ENGINE"]);
  if (engineKind === "cdp") {
    console.error(
      "WARNING: LATTICE_ENGINE=cdp selects the legacy raw-CDP stack, which lacks the " +
        "build-on firewall. Do NOT use it for production / untrusted pages.",
    );
  }

  // Egress firewall (app-level): when an allowlist is configured, every browser
  // request is routed through the Lattice egress proxy and gated per-request.
  // An empty allowlist keeps the dev-unrestricted default (no proxy) — matching
  // the kernel's empty-allowlist=unrestricted convention. Origin-level (the proxy
  // sees the destination, not the initiating page); provenance stays kernel-level.
  const allowedOrigins = list(process.env["LATTICE_ALLOWED_ORIGINS"]);
  const egressAllow = list(process.env["LATTICE_EGRESS_ALLOWLIST"]);
  // Ask-to-allow (learn) mode: the proxy is ON even with no allowlist, and an
  // unknown origin is BLOCKED but surfaced as pending for the operator to
  // allow/deny (still default-deny — nothing leaks until a human says yes).
  const egressLearn = process.env["LATTICE_EGRESS_LEARN"] === "1";
  let egressProxy: EgressProxy | undefined;
  let egressPolicy: EgressPolicy | undefined;
  let proxyUrl: string | undefined;
  if (egressLearn) {
    egressPolicy = new EgressPolicy([...allowedOrigins, ...egressAllow], true);
    egressProxy = new EgressProxy({ allow: egressPolicy.decide });
    proxyUrl = (await egressProxy.start()).url;
    console.error(`Egress firewall active (ask-to-allow) — new origins are blocked and surfaced for approval. Proxy: ${proxyUrl}`);
  } else if (allowedOrigins.length > 0 || egressAllow.length > 0) {
    egressProxy = new EgressProxy({ allow: originAllowlist(allowedOrigins, egressAllow) });
    proxyUrl = (await egressProxy.start()).url;
    console.error(`Egress firewall active — browser traffic gated through ${proxyUrl} (origin allowlist).`);
  }

  let cdpEngine: ReturnType<typeof createEngineAdapter> | undefined;
  let buildOnEngine: AgentBrowserEngine | undefined;
  if (engineKind === "agent-browser") {
    buildOnEngine = new AgentBrowserEngine();
    await buildOnEngine.launch({
      headed: process.env["LATTICE_HEADED"] === "1",
      ...(process.env["LATTICE_DEVICE"] ? { device: process.env["LATTICE_DEVICE"] } : {}),
      ...(proxyUrl ? { proxyUrl } : {}),
    });
  } else {
    const executablePath = detectChromiumExecutable();
    if (!executablePath) {
      console.error("No Chromium found. Set CHROME_EXECUTABLE or install Chrome (or LATTICE_ENGINE=agent-browser).");
      process.exitCode = 1;
      return;
    }
    cdpEngine = createEngineAdapter();
    await cdpEngine.launch({ headless: true, executablePath });
  }

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
    const safe = path.replace(/[/\\]/g, "_");
    const abs = join(traceDir, safe.endsWith(".md") ? safe : `${safe}.md`);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content, "utf8");
  };

  // Secure by default (A2/A5): the /mcp endpoint and the control-plane API are
  // ALWAYS token-gated. If a token env is unset we generate an ephemeral one and
  // print it — access is never open, but startup is not blocked. Real deployments
  // set LATTICE_MCP_TOKEN / LATTICE_CP_TOKEN.
  const cpToken = process.env["LATTICE_CP_TOKEN"] ?? randomUUID();
  if (!process.env["LATTICE_CP_TOKEN"]) console.error(`LATTICE_CP_TOKEN unset — generated for this run: ${cpToken}`);
  const mcpToken = process.env["LATTICE_MCP_TOKEN"] ?? randomUUID();
  if (!process.env["LATTICE_MCP_TOKEN"]) console.error(`LATTICE_MCP_TOKEN unset — generated for this run: ${mcpToken}`);
  // PII redaction policy (P1.1): traces are redacted before Svod by default.
  // LATTICE_PII_FULL_ORIGINS lists origins to log in full (trusted internal).
  const piiFullOrigins = list(process.env["LATTICE_PII_FULL_ORIGINS"]);
  const piiPolicy =
    piiFullOrigins.length > 0
      ? { defaultMode: "redacted" as const, perOrigin: Object.fromEntries(piiFullOrigins.map((o) => [o, "full" as const])) }
      : undefined;

  const { gateway, control } = createLatticeCore({
    engineKind,
    ...(cdpEngine ? { engine: cdpEngine } : {}),
    ...(buildOnEngine ? { buildOnEngine } : {}),
    kernel,
    vault: new Vault(vaultKey, vaultPath),
    traceWriter,
    ...(piiPolicy ? { piiPolicy } : {}),
    ...(ntfyBase ? { handoffTransport: new NtfyTransport(ntfyBase) } : {}),
    ...(handoffKey ? { handoffSigningKey: handoffKey } : {}),
    ...(egressPolicy ? { egressPolicy } : {}),
    controlPlaneToken: cpToken,
    mcpToken,
    // Persist the redacted Replay archive next to the trace notes so the Replay
    // tab survives an app restart (full traces stay in-memory only).
    replayArchivePath: join(traceDir, "replay-archive.json"),
  });

  // Hard-reap any agent-browser daemon we spawned. The daemon `setsid`-detaches
  // into its own session, so it survives the backend's process group AND the
  // desktop app's quit (whose AppKit termination callbacks are unreliable for a
  // MenuBarExtra app). We match by the binary path under our own working dir
  // (cwd = the backend dir, where node_modules/agent-browser is staged), so only
  // this stack's engine is killed — never another install.
  const engineFragment = join(process.cwd(), "node_modules", "agent-browser");
  const reapEngineDaemons = (): void => {
    try {
      const out = spawnSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" }).stdout ?? "";
      for (const line of out.split("\n")) {
        const m = line.trim().match(/^(\d+)\s+(.*)$/);
        if (m && m[1] && m[2]?.includes(engineFragment) && Number(m[1]) !== process.pid) {
          try { process.kill(Number(m[1]), "SIGKILL"); } catch { /* already gone */ }
        }
      }
    } catch { /* ps unavailable — best effort */ }
  };

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    void (async () => {
      await gateway.stop().catch(() => undefined);
      await control.stop().catch(() => undefined);
      await cdpEngine?.shutdown().catch(() => undefined);
      await buildOnEngine?.shutdown().catch(() => undefined);
      await egressProxy?.stop().catch(() => undefined);
      reapEngineDaemons(); // backstop: kill any daemon the graceful close missed
      process.exit(0);
    })();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  // Parent-death watchdog: the desktop app passes its own PID as LATTICE_PARENT_PID
  // and we poll it with `kill(pid, 0)`. When the app dies — even via SIGKILL at the
  // macOS force-quit deadline, whose AppKit callbacks never run — the probe throws
  // ESRCH and we shut down, reaping the detached engine daemon. We watch the PID
  // (not `process.ppid`) because the bun single-binary re-execs, so our ppid is
  // unreliable. Unset for `docker compose`/CLI runs → no watchdog.
  const parentPid = Number(process.env["LATTICE_PARENT_PID"] ?? 0);
  if (Number.isInteger(parentPid) && parentPid > 1) {
    const watchdog = setInterval(() => {
      try {
        process.kill(parentPid, 0); // probe only — throws if the app is gone
      } catch {
        clearInterval(watchdog);
        shutdown();
      }
    }, 1000);
    watchdog.unref();
  }

  const { url: mcpUrl } = await gateway.startHttp(gwPort, gwHost);
  const { url: cpUrl } = await control.start(cpPort, "127.0.0.1");
  console.error(`Lattice serve — MCP gateway: ${mcpUrl}`);
  console.error(`Lattice serve — control plane: ${cpUrl}`);
}

main().catch((e: unknown) => {
  console.error(e);
  process.exitCode = 1;
});
