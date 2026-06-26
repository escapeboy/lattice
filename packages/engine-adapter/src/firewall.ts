/**
 * Lattice-layer firewall over agent-browser primitives (ADR 0002 §3).
 *
 * agent-browser ships kernel-bypassing primitives that are safe for a human at a
 * terminal but catastrophic if reachable by an agent: arbitrary JS (`eval`), raw
 * CDP attach (`connect`, `--cdp`, `get cdp-url`), local file access
 * (`--allow-file-access`), and real-profile/credential import (`--profile`,
 * `--state`, `--session-name`, `auth`). Each one, if routed, hands the agent a
 * path around the Security Kernel — tainting, gating, egress, the constitutional
 * floor — entirely.
 *
 * This is defense-in-depth UNDER the structural guarantee: the SemanticEngine
 * surface already omits these (you cannot ask the adapter to eval). This guard
 * ensures that even an internal bug that tried to route one is refused, loudly,
 * before reaching the engine process. The negative tests assert it.
 */

export class EngineFirewallError extends Error {
  constructor(public readonly primitive: string) {
    super(
      `agent-browser primitive "${primitive}" is firewalled at the Lattice layer: ` +
        `it bypasses the Security Kernel and is not reachable by an agent (ADR 0002 §3).`,
    );
    this.name = "EngineFirewallError";
  }
}

/** Subcommands an agent-driven session may never invoke. */
export const FIREWALLED_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "eval", // arbitrary JavaScript in page context
  "connect", // attach to an arbitrary CDP endpoint → full kernel bypass
  "profiler", // DevTools profile dump (local I/O)
  "auth", // saved credential profiles (credential-bearing)
]);

/** Flags that bypass the kernel or read local plaintext state. */
export const FIREWALLED_FLAGS: ReadonlySet<string> = new Set([
  "--cdp", // raw CDP port
  "--allow-file-access", // file:// access to local files
  "--profile", // import of a real Chrome profile (persona_import vector)
  "--session-name", // legacy profile-restore key
  "--state", // load cookies+storage from a plaintext JSON file on disk
]);

/** `get <target>` is allowed except for targets that leak the CDP endpoint. */
export const FIREWALLED_GET_TARGETS: ReadonlySet<string> = new Set(["cdp-url"]);

/**
 * Throw EngineFirewallError if `subcommand`/`args` would invoke a firewalled
 * primitive. Called by the process runner on every command, so no code path —
 * intended or accidental — can route one to the engine.
 */
export function assertNotFirewalled(subcommand: string, args: readonly string[]): void {
  if (FIREWALLED_SUBCOMMANDS.has(subcommand)) throw new EngineFirewallError(subcommand);

  if (subcommand === "get" && args.length > 0) {
    const target = args[0] as string;
    if (FIREWALLED_GET_TARGETS.has(target)) throw new EngineFirewallError(`get ${target}`);
  }

  for (const a of args) {
    // Match both `--flag` and `--flag=value` forms.
    const flag = a.includes("=") ? a.slice(0, a.indexOf("=")) : a;
    if (FIREWALLED_FLAGS.has(flag)) throw new EngineFirewallError(flag);
  }
}
