import { describe, it, expect } from "vitest";
import { compactNode, compactNodes, compactDelta } from "./compact.js";
import type { IGNode, NodeId } from "./types.js";

function node(over: Partial<IGNode> = {}): IGNode {
  return {
    id: "n1" as NodeId,
    role: "button",
    label: "Save",
    state: { disabled: false, hidden: false },
    relations: [],
    ...over,
  };
}

describe("compact IG projection", () => {
  it("keeps id, role, label and drops the always-false scaffold", () => {
    const c = compactNode(node({ axName: "Save button" }));
    expect(c).toEqual({ id: "n1", role: "button", label: "Save" });
    // No state object, no relations, no axName, no geometry.
    expect(Object.keys(c).sort()).toEqual(["id", "label", "role"]);
  });

  it("preserves actionable fields the agent needs to decide", () => {
    const c = compactNode(
      node({
        role: "input",
        label: "Email",
        value: "a@b.com",
        placeholder: "you@example.com",
        state: { disabled: false, hidden: false, required: true },
      }),
    );
    expect(c.value).toBe("a@b.com");
    expect(c.placeholder).toBe("you@example.com");
    expect(c.required).toBe(true);
  });

  it("emits set-only flags only when true, boolean-meaning flags when defined", () => {
    const checked = compactNode(node({ role: "checkbox", state: { disabled: false, hidden: false, checked: false } }));
    expect(checked.checked).toBe(false); // present even when false — it is meaningful
    expect("disabled" in checked).toBe(false); // false → absent
    const disabled = compactNode(node({ state: { disabled: true, hidden: false } }));
    expect(disabled.disabled).toBe(true);
  });

  it("the projection is strictly smaller than the full node JSON", () => {
    const n = node({ axName: "Save button", value: "x", relations: [{ type: "labelled-by", targetId: "n2" as NodeId }] });
    const full = JSON.stringify([n]);
    const compact = JSON.stringify(compactNodes([n]));
    expect(compact.length).toBeLessThan(full.length);
  });

  it("compactDelta projects added/updated and passes removed ids through", () => {
    const d = compactDelta({
      added: [node({ id: "a" as NodeId })],
      removed: ["r" as NodeId],
      updated: [node({ id: "u" as NodeId })],
    });
    expect(d.added[0]!.id).toBe("a");
    expect(d.updated[0]!.id).toBe("u");
    expect(d.removed).toEqual(["r"]);
  });

  it("the id survives compaction so the action path (NodeId→ref) is unaffected", () => {
    const c = compactNode(node({ id: "stable-xyz" as NodeId }));
    expect(c.id).toBe("stable-xyz");
  });
});
