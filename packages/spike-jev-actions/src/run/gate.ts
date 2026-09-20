/**
 * Read-only use of Lattice's Security Kernel classifier. No kernel change: the
 * spike constructs its own kernel instance with Lattice's default config and
 * calls `classify()`, which is a pure function of the request.
 *
 * Two gate modes are measured, because they answer different questions:
 *
 *  - "verb"     — what Lattice gates TODAY. GovernedActuator classifies on the
 *                 command verb (`act`/`fill`/`select`), upgrading a click on an
 *                 EXPLICIT submit control to `submit`. A click on a
 *                 `<button>Delete account</button>` is therefore `act` → benign.
 *  - "semantic" — the hypothetical gate measured in the Task 1 report, deriving
 *                 an action type from the label with a local regex. Kept so the
 *                 round-1 numbers stay reproducible.
 *  - "effect"   — the REAL gate as shipped: the kernel's `classifyDetailed`
 *                 over deterministic target evidence. This is what the round-2
 *                 tables measure.
 */

import { createSecurityKernel } from "@lattice/kernel";
import type { EffectEvidence, PolicyClass, SecurityKernel } from "@lattice/kernel";
import type { Operation } from "../element-table.js";

export type GateMode = "none" | "verb" | "semantic" | "effect";

/** Lattice's own defaults: nothing extra prohibited, nothing extra required. */
export function spikeKernel(): SecurityKernel {
  return createSecurityKernel({
    allowedOrigins: [],
    egressAllowlist: [],
    prohibitedActions: [],
  });
}

/** Maps an operation to the ActionCommand verb the actuator would send. */
function verbFor(operation: Operation): string {
  if (operation === "CLICK") return "act";
  if (operation === "TYPE_TEXT") return "fill";
  if (operation === "SELECT") return "select";
  return "wait_for";
}

/**
 * Effect-based action type derived from the control's own label, using the
 * vocabulary of the kernel's action catalog. This is the hypothetical gate.
 */
export function semanticActionType(operation: Operation, label: string): string {
  const l = label.toLowerCase();
  if (operation !== "CLICK") return verbFor(operation);
  if (/\b(delete|remove|revoke|reset all|unsubscribe|close account)\b/.test(l)) return "delete";
  if (/\b(place order|buy|order now|purchase|checkout)\b/.test(l)) return "purchase";
  if (/\b(pay|payment|upgrade and pay)\b/.test(l)) return "payment";
  if (/\btransfer\b/.test(l)) return "transfer";
  if (/\bdownload\b/.test(l)) return "download";
  if (/\bupload\b/.test(l)) return "upload";
  if (/\b(email|send)\b/.test(l)) return "send_email";
  if (/\b(authoris|authoriz|grant access|share)\w*\b/.test(l)) return "acl.change";
  if (/\b(submit|send invitation)\b/.test(l)) return "submit";
  return "act";
}

/**
 * The pre-effect-gate classification, reconstructed.
 *
 * It cannot be obtained from the kernel any more: `classify()` now routes every
 * targeted verb through the effect classifier, where ABSENT evidence is
 * consequential. Calling today's kernel with no evidence therefore measures the
 * new unknown-handling, not the old verb gate — which would make the "before"
 * column of any comparison silently wrong. This mirrors the old behaviour
 * directly: match the action type against the verb defaults, nothing else.
 */
const LEGACY_CONSEQUENTIAL = new Set([
  "submit", "form.submit", "download", "upload", "delete",
  "checkout", "purchase", "send_email", "send_message",
]);
const LEGACY_PROHIBITED = new Set([
  "captcha", "account.create", "acl.change", "permission.change",
  "hard_delete", "transfer", "payment", "persona_import",
]);
const LEGACY_READ = new Set(["extract", "perceive", "snapshot", "search"]);

export function legacyClass(actionType: string): PolicyClass {
  const l = actionType.toLowerCase();
  for (const p of LEGACY_PROHIBITED) if (l === p || l.startsWith(p)) return "prohibited";
  for (const r of LEGACY_READ) if (l === r || l.startsWith(r)) return "read";
  for (const c of LEGACY_CONSEQUENTIAL) if (l === c || l.startsWith(c)) return "consequential";
  return "benign";
}

export interface GateVerdict {
  readonly actionType: string;
  readonly policyClass: PolicyClass;
  /** True when the action may proceed without a human in the loop. */
  readonly allowed: boolean;
}

/**
 * Classify a chosen action. `consequential` and `prohibited` both stop an
 * unattended run: the first needs a human grant that no one is there to give.
 */
export function gateDecision(
  kernel: SecurityKernel,
  mode: GateMode,
  operation: Operation,
  label: string,
  origin: string,
  evidence?: EffectEvidence,
): GateVerdict {
  if (mode === "none") {
    return { actionType: verbFor(operation), policyClass: "benign", allowed: true };
  }
  const actionType =
    mode === "semantic" ? semanticActionType(operation, label) : verbFor(operation);
  // `verb` and `semantic` are HISTORICAL reconstructions of the round-1
  // measurement and must not be routed through today's kernel — see
  // `legacyClass`. Only `effect` is the shipped gate.
  const policyClass =
    mode === "effect"
      ? kernel.classify({
          actionType,
          origin,
          sessionId: "spike",
          payload: { operation, label },
          effect: evidence ?? { probeFailed: true },
        })
      : legacyClass(actionType);
  return {
    actionType,
    policyClass,
    allowed: policyClass === "read" || policyClass === "benign",
  };
}
