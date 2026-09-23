/**
 * What a target IS at one moment, read from a full agent-browser snapshot, so a
 * human grant can be checked against the control it is about to click.
 *
 * A grant can wait minutes for a human. agent-browser resolves a ref against the
 * page as it is at dispatch, so after a re-render the same ref can name another
 * row's "Delete" (observed live: Alpha approved, Gamma deleted). Comparing the
 * guard before and after the wait turns that into a refusal.
 *
 * Borrowed from jev-ultrafast's per-element guard. Pure: no engine, no CDP.
 */

import { parseSnapshotTree } from "@lattice/perception";

export interface TargetGuard {
  readonly role: string;
  readonly name: string;
  /** Whitelisted state flags, sorted. */
  readonly state: readonly string[];
  /** Names of enclosing nodes (dialog "Confirm", form "Pay"), nearest first. */
  readonly ancestors: readonly string[];
  /** Page text between the previous ref'd node and the target, nearest 300 chars. */
  readonly before: string;
  /** Page text between the target and the next ref'd node, nearest 300 chars. */
  readonly after: string;
}

// Flags that change what a click does. Anything else agent-browser adds later
// (focus, hover) must not turn an unchanged control into a refusal.
const STATE_FLAGS: ReadonlySet<string> = new Set([
  "checked",
  "disabled",
  "expanded",
  "selected",
  "pressed",
  "required",
  "readonly",
]);

const TEXT_CHARS = 300;

export function targetGuard(tree: string, ref: string): TargetGuard | undefined {
  const lines = parseSnapshotTree(tree);
  const at = lines.findIndex((l) => l.ref === ref);
  const target = lines[at];
  if (!target) return undefined;

  const ancestors: string[] = [];
  let depth = target.depth;
  for (let i = at - 1; i >= 0 && depth > 0; i--) {
    const line = lines[i]!;
    if (line.depth < depth) {
      if (line.name.trim()) ancestors.push(line.name.trim());
      depth = line.depth;
    }
  }

  // agent-browser flattens generic <div>s, so a row's container is often not in
  // the tree at all. The text on either side of the control survives
  // flattening, and it is what tells one row's "Delete" from the next. Both
  // sides, because a row can name itself before its button or after it.
  const before: string[] = [];
  for (let i = at - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (line.ref !== undefined) break;
    if (line.name.trim()) before.unshift(line.name.trim());
  }
  const after: string[] = [];
  for (let i = at + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.ref !== undefined) break;
    if (line.name.trim()) after.push(line.name.trim());
  }

  return {
    role: target.rawRole,
    name: target.name,
    state: [...target.flags].filter((f) => STATE_FLAGS.has(f)).sort(),
    ancestors,
    before: before.join(" ").slice(-TEXT_CHARS),
    after: after.join(" ").slice(0, TEXT_CHARS),
  };
}

/** Which parts of the guard differ, for the refusal message. Empty = same target. */
export function guardDiff(a: TargetGuard, b: TargetGuard): string[] {
  const changed: string[] = [];
  if (a.role !== b.role) changed.push("role");
  if (a.name !== b.name) changed.push("name");
  if (a.state.join() !== b.state.join()) changed.push("state");
  if (a.ancestors.join("\u0000") !== b.ancestors.join("\u0000")) changed.push("ancestors");
  if (a.before !== b.before) changed.push("text before it");
  if (a.after !== b.after) changed.push("text after it");
  return changed;
}

/** Short page text for the approval panel, so the human can tell rows apart. */
export function guardContext(g: TargetGuard): string | undefined {
  // A list bullet or a separator says nothing about which row this is.
  const words = (text: string): string =>
    text
      .split(/\s+/)
      .filter((w) => /[\p{L}\p{N}]/u.test(w))
      .join(" ");
  const near = words(g.before.slice(-80)) || words(g.after.slice(0, 80));
  return near ? near : undefined;
}
