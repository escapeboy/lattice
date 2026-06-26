/**
 * AgentBrowserProcess — the ONLY module that talks to the agent-browser binary.
 *
 * Internal-only boundary (ADR 0002 §1): agent-browser is spawned as a child
 * process keyed by a private, randomly-generated session name. No TCP port is
 * exposed (we never run `stream`/`dashboard`/`--cdp`), so there is no socket an
 * agent could reach. The agent's only door is the Lattice MCP gateway, which
 * calls the adapter, which calls this runner — never the binary directly.
 *
 * Every command passes through the firewall (firewall.ts) before exec.
 */

import { spawn } from "node:child_process";
import { chmodSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { assertNotFirewalled } from "./firewall.js";
import type { AbEnvelope, AbRunner } from "./types.js";

function platformBinaryName(): string {
  const key = `${process.platform}-${process.arch}`;
  const map: Record<string, string> = {
    "darwin-arm64": "agent-browser-darwin-arm64",
    "darwin-x64": "agent-browser-darwin-x64",
    "linux-x64": "agent-browser-linux-x64",
    "linux-arm64": "agent-browser-linux-arm64",
    "win32-x64": "agent-browser-win32-x64.exe",
  };
  const name = map[key];
  if (!name) {
    throw new Error(
      `No pinned agent-browser binary for platform ${key}. ` +
        `Supported: ${Object.keys(map).join(", ")}.`,
    );
  }
  return name;
}

/** Resolve the pinned agent-browser native binary and ensure it is executable. */
export function resolveAgentBrowserBinary(): string {
  const require = createRequire(import.meta.url);
  const pkgJson = require.resolve("agent-browser/package.json");
  const bin = join(dirname(pkgJson), "bin", platformBinaryName());
  if (!existsSync(bin)) {
    throw new Error(`agent-browser binary missing at ${bin}; reinstall the pinned dependency.`);
  }
  // pnpm does not run the package's postinstall chmod, so the vendored binaries
  // can land without the exec bit. Set it ourselves (idempotent).
  try {
    chmodSync(bin, 0o755);
  } catch {
    /* already executable, or a read-only store that was set up correctly */
  }
  return bin;
}

export interface ProcessOptions {
  /** Base global flags applied to every command (e.g. ["--headed"]). */
  baseFlags?: readonly string[];
  /** Per-command timeout in ms. */
  timeoutMs?: number;
  /** Override the binary path (tests). */
  binaryPath?: string;
  /** Route the browser's egress through this forward proxy (Lattice egress firewall). */
  proxyUrl?: string;
}

const DEFAULT_TIMEOUT_MS = 30_000;

export class AgentBrowserProcess implements AbRunner {
  private readonly binary: string;
  private readonly baseFlags: readonly string[];
  private readonly timeoutMs: number;
  private readonly proxyUrl: string | undefined;

  constructor(opts: ProcessOptions = {}) {
    this.binary = opts.binaryPath ?? resolveAgentBrowserBinary();
    this.baseFlags = opts.baseFlags ?? [];
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.proxyUrl = opts.proxyUrl;
  }

  async run(session: string, subcommand: string, args: readonly string[] = []): Promise<AbEnvelope> {
    assertNotFirewalled(subcommand, args);
    // Global flags first (--session/--headed), then subcommand + its args, then --json.
    const argv = ["--session", session, ...this.baseFlags, subcommand, ...args, "--json"];
    const stdout = await this.exec(argv);
    return parseEnvelope(stdout);
  }

  private exec(argv: readonly string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.binary, argv as string[], {
        stdio: ["ignore", "pipe", "pipe"],
        // Egress firewall: route the browser's traffic through the Lattice proxy.
        // NO_PROXY for loopback keeps the agent-browser daemon's own control IPC
        // (and any localhost target) off the proxy; real egress still goes through.
        ...(this.proxyUrl
          ? { env: { ...process.env, HTTP_PROXY: this.proxyUrl, HTTPS_PROXY: this.proxyUrl, NO_PROXY: "127.0.0.1,localhost" } }
          : {}),
      });
      let out = "";
      let err = "";
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`agent-browser timed out after ${this.timeoutMs}ms: ${argv.join(" ")}`));
      }, this.timeoutMs);

      child.stdout.on("data", (d: Buffer) => (out += d.toString()));
      child.stderr.on("data", (d: Buffer) => (err += d.toString()));
      child.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        // agent-browser returns a JSON envelope on stdout even for command-level
        // failures (success:false); a nonzero exit with no parseable stdout is a
        // real process error.
        if (out.trim().length === 0 && code !== 0) {
          reject(new Error(`agent-browser exited ${code}: ${err.trim() || "(no output)"}`));
          return;
        }
        resolve(out);
      });
    });
  }
}

/** Parse the last JSON object on stdout into an envelope. */
export function parseEnvelope(stdout: string): AbEnvelope {
  const line = stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("{"))
    .pop();
  if (!line) {
    throw new Error(`agent-browser produced no JSON envelope; got: ${stdout.slice(0, 200)}`);
  }
  const parsed = JSON.parse(line) as Partial<AbEnvelope>;
  return {
    success: parsed.success === true,
    data: (parsed.data as Record<string, unknown> | null) ?? null,
    error: (parsed.error as string | null) ?? null,
  };
}
