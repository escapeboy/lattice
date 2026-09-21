/**
 * Effect evidence over the NARROW build-on engine seam.
 *
 * The seam exposes exactly one DOM read: `getAttr(ref, name)` — one attribute
 * of one element, no eval, no ancestors. So this path cannot see what the CDP
 * probe sees: whether the control sits inside a `<form>`, where that form
 * posts, whether a dialog encloses it. It reads what it can and says so.
 *
 * The consequence is deliberate and it costs approval prompts. A `<button>`
 * with no `type` attribute defaults to `type=submit` INSIDE a form and does
 * nothing OUTSIDE one — and this seam cannot tell the two apart. Under "unknown
 * → consequential", it is consequential. The previous code made the opposite
 * choice and documented it as a residual: "a bare `<button>` whose DEFAULT type
 * is submit is NOT caught". That residual is a gate bypass, so it is closed
 * here and the cost is measured rather than hidden behind a flag.
 *
 * The accessibility ROLE is what keeps that cost bounded. It is computed by the
 * browser from the element itself, not written by the page as free text: an
 * `<input type=submit>` surfaces as `button`, a text field as `textbox`. So a
 * node perceived as an input or a link cannot be a submit control, and only
 * `button` (or a node with no role at all) stays ambiguous.
 */

import type { EffectEvidence } from "@lattice/kernel";
import type { EngineSession } from "@lattice/engine-adapter";

/** The perceived node behind a NodeId, as much of it as the caller has. */
export interface PerceivedNode {
  readonly role?: string;
  readonly label?: string;
  readonly href?: string;
}

const ATTRS = ["type", "href", "download", "autocomplete", "contenteditable", "name", "id"] as const;

/** Roles that can activate a form submission. Everything else cannot. */
const AMBIGUOUS_ROLES: ReadonlySet<string> = new Set(["button", "menuitem"]);

export async function collectEngineEvidence(
  engine: EngineSession,
  ref: string | undefined,
  node: PerceivedNode | undefined,
): Promise<EffectEvidence> {
  const canRead = ref !== undefined && engine.getAttr !== undefined;
  const liveRef = ref ?? "";
  if (!canRead && !node) {
    // Nothing is known about the target at all. That is the unknown case, and
    // the classifier answers it with `consequential`.
    return { probeFailed: true };
  }

  const values = new Map<string, string | undefined>();
  if (canRead) {
    await Promise.all(
      ATTRS.map(async (a) => {
        values.set(a, await engine.getAttr!(liveRef, a).catch(() => undefined));
      }),
    );
  }

  const type = values.get("type")?.toLowerCase();
  const href = values.get("href") ?? node?.href;
  const role = node?.role;
  const fieldName = (values.get("name") ?? values.get("id"))?.toLowerCase();
  const autocomplete = values.get("autocomplete")?.toLowerCase();
  const contentEditable = values.get("contenteditable");

  // An explicit submit control is certain; a bare button MIGHT be one inside a
  // form and this seam cannot rule it out. Either way the seam cannot read the
  // form's action, and the classifier escalates a commit whose destination is
  // unreadable.
  const submits =
    type === "submit" || type === "image" || (href === undefined && couldSubmit(role, type));

  return {
    ...(role !== undefined ? { role } : {}),
    ...(node?.label !== undefined ? { name: node.label } : {}),
    ...(href !== undefined ? { href } : {}),
    ...(type !== undefined ? { inputType: type } : {}),
    ...(autocomplete !== undefined ? { autocomplete } : {}),
    ...(fieldName !== undefined ? { fieldName } : {}),
    ...(values.get("download") !== undefined ? { download: true } : {}),
    ...(contentEditable !== undefined && contentEditable !== "false"
      ? { contentEditable: true }
      : {}),
    ...(submits ? { submitControl: true, formActionUnknown: true } : {}),
  };
}

/**
 * True when nothing known about the node rules out a form submission.
 *
 * An explicit `type` other than submit/image is the page's own claim and could
 * be a lie — a `type="button"` that calls `form.submit()` in JS still posts.
 * The claim is accepted here because it resolves an UNKNOWN rather than
 * lowering a class derived from evidence, and the residual (a page lying about
 * its own control) is what the effect backstop catches by watching the request
 * the click actually produces.
 */
function couldSubmit(role: string | undefined, type: string | undefined): boolean {
  if (type !== undefined) return false;
  if (role === undefined) return true;
  return AMBIGUOUS_ROLES.has(role);
}
