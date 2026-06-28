/**
 * Canonical action-type catalog — the known action types the kernel classifies,
 * with human labels + their default category. Source of truth for the operator
 * Policy UI so the operator picks from a list instead of guessing strings.
 *
 * The enforced sets (prohibited floor, consequential defaults) are read from the
 * real kernel constants, so they never drift from what is actually gated. The
 * low-level command list and the labels are presentation-only.
 */

import { CONSTITUTIONAL_FLOOR } from "./operator.js";
import { CONSEQUENTIAL_DEFAULTS } from "./kernel.js";

export type ActionCategory = "prohibited" | "consequential" | "command";

export interface ActionCatalogEntry {
  /** The action-type string the kernel matches (by prefix). */
  value: string;
  /** Human description for the picker. */
  label: string;
  /** Default classification this type carries. */
  category: ActionCategory;
}

/** Low-level semantic commands the agent emits (`act_execute`). Rarely gated,
 *  but valid policy targets. No runtime union exists for these, so list them. */
const COMMAND_TYPES = ["navigate", "fill", "select", "scroll_to", "wait_for", "extract"];

const LABELS: Record<string, string> = {
  submit: "submit a form",
  "form.submit": "form submission",
  checkout: "start checkout",
  purchase: "buy / place an order",
  payment: "pay / enter card details",
  transfer: "move money or assets",
  delete: "delete content",
  hard_delete: "permanently delete",
  download: "download a file",
  upload: "upload a file",
  send_email: "send an email",
  send_message: "send a message / DM",
  "account.create": "create an account",
  "acl.change": "change sharing / access control",
  "permission.change": "change permissions",
  captcha: "solve a CAPTCHA",
  persona_import: "import a browser profile",
  navigate: "open a URL",
  fill: "type into a field",
  select: "choose an option",
  scroll_to: "scroll to an element",
  wait_for: "wait for a condition",
  extract: "read data from the page",
};

/** The full catalog, de-duplicated, in (prohibited → consequential → command) order. */
export function actionCatalog(): ActionCatalogEntry[] {
  const seen = new Set<string>();
  const out: ActionCatalogEntry[] = [];
  const add = (value: string, category: ActionCategory): void => {
    if (seen.has(value)) return;
    seen.add(value);
    out.push({ value, label: LABELS[value] ?? value, category });
  };
  for (const v of CONSTITUTIONAL_FLOOR.prohibitedPrimitives) add(v, "prohibited");
  for (const v of CONSEQUENTIAL_DEFAULTS) add(v, "consequential");
  for (const v of COMMAND_TYPES) add(v, "command");
  return out;
}
