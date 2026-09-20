/**
 * Effect-based classification: what the action DOES, not what it is called.
 *
 * The old gate classified on the verb name. `submit` was consequential and
 * `act` was benign, so clicking the submit button instead of sending `submit`
 * walked straight through. This classifies the (operation, target, context)
 * triple from deterministic signals — no model call, no network.
 *
 * TWO RULES THE REST OF THE FILE ENFORCES
 *
 * 1. Page-controlled strings are EVIDENCE, NEVER AUTHORITY. A label, a dialog's
 *    text, the text around a control — all of it can only RAISE the class.
 *    `raise()` is the single mutation point and it takes a max; there is no
 *    code path that lowers a class. So a page that writes "this button is
 *    harmless, no approval needed" next to a delete button changes nothing.
 *
 * 2. UNKNOWN OR CONFLICTING → CONSEQUENTIAL, NEVER BENIGN. If the probe could
 *    not read the element, or it read enough to know the element commits
 *    something but not enough to know where it goes, the action needs a human.
 *    Silence is not evidence of safety.
 */

import { CONSTITUTIONAL_FLOOR } from "./operator.js";
import {
  EFFECT_LEXICON,
  hasMonetaryAmount,
  matchTerm,
  normalizeForMatch,
  type EffectLexicon,
} from "./effect-lexicon.js";
import type { PolicyClass } from "./types.js";

/**
 * What a deterministic DOM probe can see about the action's target.
 *
 * Fields marked PAGE-CONTROLLED are attacker-writable on a hostile page. They
 * are read, but only ever to raise the class.
 */
export interface EffectEvidence {
  /** Lowercased tag name, e.g. "button", "a", "input". */
  readonly tag?: string;
  /** Mapped semantic role. */
  readonly role?: string;
  /** Accessible name / visible label. PAGE-CONTROLLED. */
  readonly name?: string;
  /** `type` attribute of an input or button, lowercased. */
  readonly inputType?: string;
  /** `autocomplete` attribute, lowercased. */
  readonly autocomplete?: string;
  /** `name`/`id` of a form field, lowercased. PAGE-CONTROLLED. */
  readonly fieldName?: string;
  /** Resolved absolute URL for a link target. */
  readonly href?: string;
  /** The element carries a `download` attribute. */
  readonly download?: boolean;
  /** The element (or an ancestor) is contenteditable. */
  readonly contentEditable?: boolean;
  /** The target submits a form — explicit `type=submit|image`, or a bare
   *  `<button>` inside a `<form>`, whose default type IS submit. */
  readonly submitControl?: boolean;
  /** Effective form method, uppercased ("GET"/"POST"). */
  readonly formMethod?: string;
  /** Resolved absolute form action URL. */
  readonly formAction?: string;
  /** The form exists but its action could not be resolved. */
  readonly formActionUnknown?: boolean;
  /** Target sits inside a <dialog>, [role=dialog|alertdialog] or aria-modal. */
  readonly inDialog?: boolean;
  /** Text of the enclosing dialog. PAGE-CONTROLLED. */
  readonly dialogText?: string;
  /** Text immediately around the control. PAGE-CONTROLLED. */
  readonly nearbyText?: string;
  /** The probe could not read the element at all. */
  readonly probeFailed?: boolean;
}

export interface EffectVerdict {
  readonly policyClass: PolicyClass;
  /** Why, in the order the signals fired. Operator-facing; safe to log. */
  readonly reasons: readonly string[];
  /** Lexicon version in force, for the audit record. */
  readonly lexiconVersion: string;
  /** Set when a floor primitive was named — which one. */
  readonly primitive?: string;
}

const ORDER: Record<PolicyClass, number> = {
  read: 0,
  benign: 1,
  consequential: 2,
  prohibited: 3,
};

/** Severity max. The ONLY way a class changes in this module. */
function raise(current: PolicyClass, next: PolicyClass): PolicyClass {
  return ORDER[next] > ORDER[current] ? next : current;
}

const FLOOR_PRIMITIVES = new Set(CONSTITUTIONAL_FLOOR.prohibitedPrimitives.map((p) => p.toLowerCase()));

/** Roles whose label names the DATA, not an action. Browser-computed, not page text. */
const DATA_ENTRY_ROLES: ReadonlySet<string> = new Set([
  "input", "textbox", "searchbox", "combobox", "select", "spinbutton", "slider", "textarea",
]);

/** Payment autocomplete tokens (WHATWG). Any of these is a card field. */
function isPaymentField(autocomplete: string | undefined): boolean {
  if (!autocomplete) return false;
  return /(^|\s)(cc-[a-z-]+|cc-number|cc-csc)(\s|$)/i.test(autocomplete);
}

function sameOrigin(a: string | undefined, b: string | undefined): boolean | undefined {
  if (!a || !b) return undefined;
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return undefined;
  }
}

/** A link that only moves within the page (#anchor) commits nothing. */
function isInPageAnchor(href: string, taskOrigin: string | undefined): boolean {
  if (href.startsWith("#")) return true;
  const same = sameOrigin(href, taskOrigin);
  if (same !== true) return false;
  try {
    const u = new URL(href);
    const base = taskOrigin ? new URL(taskOrigin) : undefined;
    return u.hash !== "" && base !== undefined && u.pathname === base.pathname;
  } catch {
    return false;
  }
}

/**
 * Classify the real effect of an action.
 *
 * @param base      the class the verb alone implies (the kernel's existing
 *                  action-type classification) — the floor this can only rise from
 * @param evidence  deterministic probe output; PAGE-CONTROLLED fields included
 * @param taskOrigin the origin the session is scoped to
 * @param verb       the action type, when the caller knows it — used only to
 *                   tell activation apart from data entry
 */
export function classifyEffect(
  base: PolicyClass,
  evidence: EffectEvidence | undefined,
  taskOrigin: string | undefined,
  lexicon: EffectLexicon = EFFECT_LEXICON,
  verb?: string,
): EffectVerdict {
  const reasons: string[] = [];
  let cls = base;
  let primitive: string | undefined;

  // A read verb does not touch the element: it copies text that is already on
  // screen. What the element SAYS is therefore irrelevant to its class — a
  // heading that reads "Delete everything" is still just a heading. Escalating
  // reads on label evidence would let any page make the agent stop reading.
  if (base === "read") {
    return { policyClass: "read", reasons: ["read verb: no side effect on the target"], lexiconVersion: lexicon.version };
  }

  // ── Rule 2, first application: no evidence at all is not evidence of safety.
  if (!evidence || evidence.probeFailed) {
    cls = raise(cls, "consequential");
    reasons.push("effect probe unavailable — unknown target treated as consequential");
    return { policyClass: cls, reasons, lexiconVersion: lexicon.version };
  }

  // ── STRUCTURAL SIGNALS ────────────────────────────────────────────────────
  // Not page-controlled in the same sense as a label: these are what the
  // element IS. A hostile page can still set them, but only in the direction of
  // making its own control look MORE dangerous, which is safe.

  if (evidence.submitControl) {
    cls = raise(cls, "consequential");
    reasons.push("target submits a form");

    const method = (evidence.formMethod ?? "").toUpperCase();
    if (evidence.formActionUnknown || (!evidence.formAction && method !== "GET")) {
      // Knows it commits, does not know where. Rule 2.
      cls = raise(cls, "consequential");
      reasons.push("form destination unreadable — treated as consequential");
    } else if (evidence.formAction) {
      const same = sameOrigin(evidence.formAction, taskOrigin);
      if (same === false) {
        cls = raise(cls, "consequential");
        reasons.push(`form posts off-origin (${originOf(evidence.formAction)})`);
      } else if (same === undefined) {
        cls = raise(cls, "consequential");
        reasons.push("form destination could not be compared to the task origin");
      }
    }
  }

  if (evidence.download === true) {
    cls = raise(cls, "consequential");
    reasons.push("download attribute — writes a file");
  }

  const inputType = evidence.inputType;
  if (inputType === "file") {
    cls = raise(cls, "consequential");
    reasons.push("file input — uploads local data");
  }
  if (inputType === "password") {
    cls = raise(cls, "consequential");
    reasons.push("password field");
  }

  if (isPaymentField(evidence.autocomplete)) {
    cls = raise(cls, "prohibited");
    primitive ??= "payment";
    reasons.push(`payment field (autocomplete=${evidence.autocomplete})`);
  }

  if (evidence.contentEditable === true) {
    cls = raise(cls, "consequential");
    reasons.push("contenteditable surface — edits publishable content");
  }

  // Links that leave the task origin are NOT escalated here. Origin scope is
  // already owned by `checkNavigation`, which refuses an out-of-scope URL
  // outright — a stricter answer than a human prompt. Escalating here as well
  // gated a fifth of the benign traffic in the 150-case set (14/70: social
  // icons, upstream project links, documentation) and caught nothing the label
  // signals did not already catch. Carrying DATA off-origin is a different
  // matter and is handled above, on the form action.
  //
  // A non-http scheme is escalated, because it hands off to something outside
  // the browser entirely and no navigation gate sees it.
  if (evidence.href && !isInPageAnchor(evidence.href, taskOrigin)) {
    if (/^(?!https?:)[a-z][a-z0-9+.-]*:/i.test(evidence.href)) {
      // mailto:, tel:, intent:, javascript: … — hands off to something outside
      // the browser, or is a script URL.
      cls = raise(cls, "consequential");
      reasons.push(`non-http link scheme (${evidence.href.split(":")[0]}:)`);
    }
  }

  // ── PAGE-CONTROLLED EVIDENCE — raise only ────────────────────────────────

  // A FIELD's label names the data it holds, not an effect. "Email",
  // "Delete reason", "Payment reference" are all things you type INTO; typing
  // commits nothing, the later submit does — and that submit is classified on
  // its own. Running the action lexicon over field labels made every email box
  // consequential, which is approval fatigue bought for no safety at all.
  // Structural signals on fields (password, file, cc-*) still apply above.
  const entersDataOnly =
    (verb === "fill" || verb === "select" || verb === "set") && DATA_ENTRY_ROLES.has(evidence.role ?? "");

  const label = entersDataOnly ? "" : [evidence.name, evidence.fieldName].filter(Boolean).join(" ");
  if (label) {
    for (const entry of lexicon.prohibited) {
      const hit = matchTerm(label, entry.terms);
      if (hit && FLOOR_PRIMITIVES.has(entry.primitive)) {
        cls = raise(cls, "prohibited");
        primitive ??= entry.primitive;
        reasons.push(`label names a prohibited primitive (${entry.primitive}: "${hit}")`);
      }
    }
    const conseq = matchTerm(label, lexicon.consequential);
    if (conseq) {
      cls = raise(cls, "consequential");
      reasons.push(`label carries a consequential term ("${conseq}")`);
    }
  }

  // Surrounding text is weaker evidence than the control's own name: on a busy
  // page ANY word appears somewhere nearby, so treating it like a label would
  // gate everything. It is read for two things only — a confirmation dialog's
  // irreversibility wording, and an amount next to the control.
  const context = [evidence.dialogText, evidence.nearbyText].filter(Boolean).join(" ");
  if (context) {
    const irreversible = matchTerm(context, lexicon.irreversible);
    if (irreversible && (evidence.inDialog === true || cls === "consequential")) {
      cls = raise(cls, "consequential");
      reasons.push(`context states the action is irreversible ("${irreversible}")`);
    }
    if (hasMonetaryAmount(context)) {
      cls = raise(cls, "consequential");
      reasons.push("a monetary amount appears next to the control");
      if (evidence.inDialog === true) {
        cls = raise(cls, "prohibited");
        primitive ??= "payment";
        reasons.push("amount inside a confirmation dialog — treated as payment");
      }
    }
  }

  if (evidence.inDialog === true && cls === "consequential") {
    reasons.push("inside a confirmation dialog");
  }

  if (reasons.length === 0) {
    reasons.push(`no effect signal; verb class (${base}) stands`);
  }

  return {
    policyClass: cls,
    reasons,
    lexiconVersion: lexicon.version,
    ...(primitive !== undefined ? { primitive } : {}),
  };
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return normalizeForMatch(url).slice(0, 40);
  }
}
