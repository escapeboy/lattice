/** Fixture builders shared by the spike's unit tests. */

import type { IGNode, InteractionGraph, NodeId, NodeRole } from "@lattice/perception";
import type { Viewport } from "./element-table.js";

export const VIEWPORT: Viewport = { width: 1280, height: 800, scrollX: 0, scrollY: 0, scrollHeight: 2400 };

export interface NodeSpec {
  role: NodeRole;
  label: string;
  value?: string;
  placeholder?: string;
  href?: string;
  hidden?: boolean;
  disabled?: boolean;
  /** Document-space y. Defaults to a position inside the viewport. */
  y?: number;
}

export function igFixture(
  specs: readonly NodeSpec[],
  opts: { url?: string; title?: string } = {},
): InteractionGraph {
  const nodes = new Map<NodeId, IGNode>();
  const nodeOrder: NodeId[] = [];
  specs.forEach((spec, i) => {
    const id = `n${i + 1}` as NodeId;
    const node: IGNode = {
      id,
      role: spec.role,
      label: spec.label,
      state: { disabled: spec.disabled ?? false, hidden: spec.hidden ?? false },
      ...(spec.value !== undefined ? { value: spec.value } : {}),
      ...(spec.placeholder !== undefined ? { placeholder: spec.placeholder } : {}),
      ...(spec.href !== undefined ? { href: spec.href } : {}),
      relations: [],
      geometry: { x: 20, y: spec.y ?? 40 + i * 50, width: 200, height: 32, inViewport: (spec.y ?? 40 + i * 50) < 720 },
    };
    nodes.set(id, node);
    nodeOrder.push(id);
  });
  return {
    tier: "L1",
    url: opts.url ?? "https://fixture.localhost/settings",
    title: opts.title ?? "Account settings",
    nodes,
    nodeOrder,
    serializedSize: 0,
  };
}
