/**
 * Engine process reaping (supervisor layer — NOT an agent-browser patch).
 *
 * agent-browser starts a per-session DAEMON that `setsid`-detaches into its own
 * session (so its ppid becomes 1) and owns a Chrome the daemon RESURRECTS if you
 * kill the browser alone. Chrome runs from the system Chrome install
 * (`/Applications/Google Chrome.app/...`) with `--user-data-dir=<tmp>/agent-browser-chrome-<uuid>`,
 * NOT under our node_modules — so the old reap (which matched `<cwd>/node_modules/agent-browser`)
 * missed it, and on a pnpm layout the daemon path is `.pnpm/agent-browser@x/node_modules/agent-browser/bin/...`
 * so the old fragment missed the DAEMON too.
 *
 * The reap therefore:
 *   1. finds OUR daemons — command under our cwd AND the layout-robust marker
 *      `node_modules/agent-browser/bin/agent-browser-` (matches both pnpm and the
 *      desktop's staged backend) — and kills them FIRST so Chrome can't respawn;
 *   2. kills the Chrome those daemons own (ppid ∈ our daemons) plus any ALREADY
 *      orphaned agent-browser Chrome (ppid 1 = its daemon is already gone).
 *
 * Scoping: a live OTHER instance's Chrome (ppid = its own live daemon, neither 1
 * nor one of ours) is spared — including the desktop app's engine when a dev
 * `serve` reaps, since its daemon lives under `/Applications/...`, not our cwd.
 */

export interface PsRow {
  readonly pid: number;
  readonly ppid: number;
  readonly command: string;
}

/** Parse `ps -axo pid=,ppid=,command=` output. */
export function parsePs(output: string): PsRow[] {
  const rows: PsRow[] = [];
  for (const line of output.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), command: m[3] ?? "" });
  }
  return rows;
}

/** Layout-robust daemon marker (pnpm `.pnpm/.../` AND desktop staged both match). */
const DAEMON_MARKER = /node_modules\/agent-browser\/bin\/agent-browser-/;
/** Every Chrome agent-browser launches carries this in `--user-data-dir`. */
const CHROME_MARKER = "agent-browser-chrome-";

/**
 * Compute the PIDs to SIGKILL for a reap from `ownCwd`. Returns daemons and
 * chrome separately so the caller kills daemons FIRST (the resurrector) then the
 * browser. `selfPid` is never returned.
 */
export function reapTargets(
  rows: readonly PsRow[],
  ownCwd: string,
  selfPid: number,
): { daemons: number[]; chrome: number[] } {
  const daemons = rows.filter(
    (r) => r.pid !== selfPid && r.command.includes(ownCwd) && DAEMON_MARKER.test(r.command),
  );
  const daemonPids = new Set(daemons.map((r) => r.pid));
  const chrome = rows.filter(
    (r) =>
      r.pid !== selfPid &&
      r.command.includes(CHROME_MARKER) &&
      (r.ppid === 1 || daemonPids.has(r.ppid)),
  );
  return { daemons: daemons.map((r) => r.pid), chrome: chrome.map((r) => r.pid) };
}

/** Injectable process surface (real impl = node's `child_process` + `process`). */
export interface ReapHost {
  ps(): string;
  kill(pid: number): void;
  readonly cwd: string;
  readonly selfPid: number;
}

/**
 * Run one reap pass: kill our daemons, then the Chrome they own / orphaned Chrome.
 * Returns the pids killed (for logging/tests). Best-effort — never throws.
 */
export function reapEngineProcesses(host: ReapHost): { daemons: number[]; chrome: number[] } {
  try {
    const { daemons, chrome } = reapTargets(parsePs(host.ps()), host.cwd, host.selfPid);
    // Daemon FIRST — a dead daemon cannot resurrect the browser we kill next.
    for (const pid of daemons) safeKill(host, pid);
    for (const pid of chrome) safeKill(host, pid);
    return { daemons, chrome };
  } catch {
    return { daemons: [], chrome: [] };
  }
}

function safeKill(host: ReapHost, pid: number): void {
  try {
    host.kill(pid);
  } catch {
    /* already gone */
  }
}
