/**
 * One-shot cleanup of legacy `*.md.md` trace files.
 *
 * An earlier traceWriter appended `.md` unconditionally, so a Svod path that
 * already ended in `.md` produced a double extension (`foo.md` → `foo.md.md`).
 * The writer is fixed (it only appends when the extension is missing), but trace
 * dirs on existing installs still hold the doubled files. This renames them back
 * on boot — idempotent, cheap (the trace dir is flat: the writer flattens path
 * separators to `_`), and self-healing so no operator step is needed.
 */

import { readdir, rename, stat } from "node:fs/promises";
import { join } from "node:path";

/** Rename every `*.md.md` in `dir` to `*.md`. Returns how many were migrated. */
export async function migrateLegacyTraces(dir: string): Promise<number> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return 0; // trace dir not created yet — nothing to migrate
  }

  let migrated = 0;
  for (const name of entries) {
    if (!name.endsWith(".md.md")) continue;
    const from = join(dir, name);
    const to = join(dir, name.slice(0, -3)); // drop the trailing ".md"
    // Don't clobber a correctly-named file that already exists.
    if (await exists(to)) continue;
    try {
      await rename(from, to);
      migrated++;
    } catch {
      // Skip a file we can't move (permission, races) — best-effort cleanup.
    }
  }
  return migrated;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
