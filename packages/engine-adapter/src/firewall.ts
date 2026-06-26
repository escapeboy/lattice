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
 * URL schemes that read local files or escape the page sandbox. Blocking
 * `--allow-file-access` is NOT enough: a top-level `open file:///etc/passwd`
 * needs no flag, and the page text is then readable via `read`/snapshot. These
 * schemes are refused on ANY argument, regardless of subcommand or task policy
 * (constitutional floor — local file read is never an agent primitive).
 */
export const FORBIDDEN_URL_SCHEMES: ReadonlySet<string> = new Set([
  "file",
  "javascript",
  "blob",
  "filesystem",
  "view-source",
  "chrome",
  "chrome-extension",
]);

/**
 * Return the forbidden scheme of `raw`, or null if its scheme is not forbidden.
 *
 * Critically, this canonicalizes the SAME way the WHATWG URL parser (Chromium /
 * agent-browser) does BEFORE reading the scheme: it removes every ASCII tab
 * (0x09), LF (0x0A) and CR (0x0D) anywhere in the string, then strips leading C0
 * controls + space (code point <= 0x20). Without this, an obfuscated scheme such
 * as a tab inside "file" or a leading NUL slips past a naive prefix check while
 * the engine still resolves it to "file:". (Confirmed against the WHATWG parser.)
 * Implemented with char codes so no control characters appear in this source.
 */
export function forbiddenUrlScheme(raw: string): string | null {
  let s = "";
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    if (c !== 0x09 && c !== 0x0a && c !== 0x0d) s += raw[i];
  }
  let start = 0;
  while (start < s.length && s.charCodeAt(start) <= 0x20) start++;
  const colon = s.indexOf(":", start);
  if (colon < 0) return null;
  const scheme = s.slice(start, colon).toLowerCase();
  return FORBIDDEN_URL_SCHEMES.has(scheme) ? scheme : null;
}

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
    // A local-file / sandbox-escaping URL on any positional arg (e.g. the URL
    // passed to `open`/`read`) — the actual file-read primitive, flagless. The
    // scheme is canonicalized to defeat tab/newline/control-char obfuscation.
    const scheme = forbiddenUrlScheme(a);
    if (scheme) throw new EngineFirewallError(`${scheme}: url`);
  }
}
