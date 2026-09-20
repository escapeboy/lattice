/**
 * Reads the deterministic facts the effect gate classifies on.
 *
 * One `Runtime.callFunctionOn` against the resolved node — no model, no
 * network, no `eval` of page-supplied text. The function below is a constant;
 * the page never contributes a character of it.
 *
 * Everything it returns about TEXT (accessible name, dialog text, nearby text)
 * is attacker-writable, and the classifier treats it accordingly: those fields
 * can only raise a class. Everything it returns about STRUCTURE (is this in a
 * form, where does the form post) is used to resolve "unknown", which is the
 * one thing that legitimately moves a class down — from "we could not tell, so
 * assume the worst" to a class actually derived from evidence. A page lying
 * with `type="button"` on a control that submits via JS is the residual, and
 * that is what the effect backstop in `effect-backstop.ts` exists to catch.
 */

import type { CDPHandle } from "@lattice/engine";
import type { EffectEvidence } from "@lattice/kernel";

interface ResolveNodeResult {
  object?: { objectId?: string };
}

interface CallFunctionOnResult {
  result?: { value?: unknown };
  exceptionDetails?: unknown;
}

/** Cap on page text pulled into the evidence, so a huge dialog cannot bloat a grant. */
const TEXT_BUDGET = 600;

const PROBE = `function (textBudget) {
  const el = this;
  const out = {};
  const attr = (n) => { const v = el.getAttribute && el.getAttribute(n); return v == null ? undefined : String(v); };

  out.tag = (el.tagName || "").toLowerCase();
  const role = attr("role");
  if (role) out.role = role.toLowerCase();

  const name = (el.getAttribute && (el.getAttribute("aria-label") || el.getAttribute("title"))) ||
    (el.innerText || el.textContent || "");
  if (name) out.name = String(name).replace(/\\s+/g, " ").trim().slice(0, 200);

  const type = attr("type");
  if (type) out.inputType = type.toLowerCase();
  const ac = attr("autocomplete");
  if (ac) out.autocomplete = ac.toLowerCase();
  const fieldName = attr("name") || attr("id");
  if (fieldName) out.fieldName = String(fieldName).toLowerCase().slice(0, 120);

  if (el.href) out.href = String(el.href);
  else { const h = attr("href"); if (h) out.href = h; }
  if (el.hasAttribute && el.hasAttribute("download")) out.download = true;
  if (el.isContentEditable) out.contentEditable = true;

  // ── form membership. el.form is the authoritative answer for form controls
  //    and honours the form= attribute, so it beats walking ancestors.
  const form = el.form || (el.closest ? el.closest("form") : null);
  if (form) {
    const t = out.inputType;
    const isButtonish = out.tag === "button" || out.tag === "input";
    // <button> and <input> default to type=submit inside a form.
    const submits = t === "submit" || t === "image" || (isButtonish && t === undefined);
    if (submits) {
      out.submitControl = true;
      const method = (el.getAttribute && el.getAttribute("formmethod")) || form.method || "get";
      out.formMethod = String(method).toUpperCase();
      let action;
      try {
        const raw = (el.getAttribute && el.getAttribute("formaction")) || form.getAttribute("action");
        action = raw == null ? form.action : new URL(raw, document.baseURI).href;
      } catch (e) { action = undefined; }
      if (action) out.formAction = String(action);
      else out.formActionUnknown = true;
    }
  }

  // ── frame membership. A framed target is one perception cannot describe.
  try {
    const win = el.ownerDocument && el.ownerDocument.defaultView;
    if (win && win.top !== win) {
      out.inFrame = true;
      out.frameOrigin = (el.ownerDocument.location && el.ownerDocument.location.origin) || "unknown";
    }
  } catch (e) {
    // A cross-origin frame can throw on window.top access — which is itself
    // the answer: if we cannot even compare, we are not in the main frame.
    out.inFrame = true;
    out.frameOrigin = "cross-origin";
  }

  // ── dialog / confirmation context
  const dialog = el.closest ? el.closest('dialog,[role="dialog"],[role="alertdialog"],[aria-modal="true"]') : null;
  if (dialog) {
    out.inDialog = true;
    const dt = dialog.innerText || dialog.textContent || "";
    if (dt) out.dialogText = String(dt).replace(/\\s+/g, " ").trim().slice(0, textBudget);
  }

  // ── nearby text: the control's own container, not the whole page. Enough to
  //    see "you will be charged $49" next to a button; not enough for any word
  //    anywhere on the page to count as adjacent.
  const box = el.closest ? (el.closest("form,fieldset,section,article,li,td,dialog") || el.parentElement) : el.parentElement;
  if (box) {
    const nt = box.innerText || box.textContent || "";
    if (nt) out.nearbyText = String(nt).replace(/\\s+/g, " ").trim().slice(0, textBudget);
  }

  return out;
}`;

/**
 * Probe the element behind `backendNodeId`. Never throws: an unreadable target
 * resolves to `{ probeFailed: true }`, which the classifier treats as unknown —
 * and unknown is consequential, not benign.
 */
export async function probeEffect(
  cdp: CDPHandle,
  backendNodeId: number,
): Promise<EffectEvidence> {
  try {
    const resolved = await cdp.send<ResolveNodeResult>("DOM.resolveNode", { backendNodeId });
    const objectId = resolved.object?.objectId;
    if (!objectId) return { probeFailed: true };

    const out = await cdp.send<CallFunctionOnResult>("Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: PROBE,
      arguments: [{ value: TEXT_BUDGET }],
      returnByValue: true,
    });
    if (out.exceptionDetails) return { probeFailed: true };
    const value = out.result?.value as EffectEvidence | undefined;
    if (!value || typeof value !== "object") return { probeFailed: true };
    return value;
  } catch {
    return { probeFailed: true };
  }
}
