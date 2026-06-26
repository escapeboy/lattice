/**
 * Compact IG projection — the agent-facing wire shape.
 *
 * The full `IGNode` carries everything the runtime and the trace store need
 * (always-present `state`, `relations`, geometry, `axName` for debugging). The
 * agent does not need most of it: it acts on a stable `NodeId` and decides from
 * `role` + `label` plus the handful of fields that actually change what it would
 * do (current value, whether a control is checked/disabled, a link target).
 *
 * Compaction drops the structural bulk — empty relation arrays, the
 * always-false default state flags, geometry at L1, and the `axName` that just
 * duplicates the label — so the perception cost is the labels, not the scaffold.
 * It is a pure projection: the `id` is preserved, so the action path (NodeId →
 * ref) and tainting are unaffected. Full nodes are still recorded in the trace.
 */

import type { IGNode, NodeRole } from "./types.js";
import type { IGDelta } from "./types.js";

export interface CompactNode {
  readonly id: string;
  readonly role: NodeRole;
  readonly label: string;
  readonly value?: string;
  readonly placeholder?: string;
  readonly href?: string;
  readonly level?: number;
  /** Boolean-meaning control state — present only when it applies to the role. */
  readonly checked?: boolean;
  readonly expanded?: boolean;
  readonly selected?: boolean;
  /** Set-only flags — present only when true (absence means false). */
  readonly disabled?: true;
  readonly hidden?: true;
  readonly required?: true;
  readonly readonly?: true;
}

export interface CompactDelta {
  readonly added: ReadonlyArray<CompactNode>;
  readonly removed: ReadonlyArray<string>;
  readonly updated: ReadonlyArray<CompactNode>;
}

export function compactNode(n: IGNode): CompactNode {
  const out: {
    -readonly [K in keyof CompactNode]: CompactNode[K];
  } = { id: n.id, role: n.role, label: n.label };

  if (n.value !== undefined) out.value = n.value;
  if (n.placeholder !== undefined) out.placeholder = n.placeholder;
  if (n.href !== undefined) out.href = n.href;
  if (n.level !== undefined) out.level = n.level;

  const s = n.state;
  if (s.checked !== undefined) out.checked = s.checked;
  if (s.expanded !== undefined) out.expanded = s.expanded;
  if (s.selected !== undefined) out.selected = s.selected;
  if (s.disabled) out.disabled = true;
  if (s.hidden) out.hidden = true;
  if (s.required) out.required = true;
  if (s.readonly) out.readonly = true;

  return out;
}

export function compactNodes(nodes: Iterable<IGNode>): CompactNode[] {
  const out: CompactNode[] = [];
  for (const n of nodes) out.push(compactNode(n));
  return out;
}

export function compactDelta(d: IGDelta): CompactDelta {
  return {
    added: d.added.map(compactNode),
    removed: d.removed.map((id) => id as string),
    updated: d.updated.map(compactNode),
  };
}
