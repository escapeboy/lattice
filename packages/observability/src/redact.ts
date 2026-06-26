/**
 * PII redaction — applied at the Svod persistence boundary (P1.1).
 *
 * Traces fly to Svod IMMUTABLY and carry page content (node values, the text an
 * agent typed, extracted results, URLs). For an EU deployment that means logging
 * PII forever, versioned — a right-to-erasure problem against an immutable log.
 * Retroactive redaction of an immutable store is painful, so we redact BEFORE
 * persistence, by default.
 *
 * Scope: high-confidence STRUCTURED PII (email, payment card [Luhn-checked],
 * IBAN, US SSN, phone numbers). Names/addresses are intentionally out of scope —
 * detecting them reliably is lossy and would gut the trace's debugging value;
 * the policy lets a trusted internal origin opt into full logging instead.
 *
 * This does NOT bypass or weaken tainting. Redaction reads trace-payload strings
 * and replaces matched spans with a mask; it never promotes page content into an
 * instruction channel and never clears a taint mark. It is a payload transform
 * orthogonal to the kernel's quarantine guarantee.
 */

import type { SessionTrace, TraceEvent } from "./types.js";
import type { IGNode } from "@lattice/perception";
import type { ActionCommand } from "@lattice/action";

export type PiiMode = "full" | "redacted";

export interface PiiPolicy {
  /** Mode for origins not listed in `perOrigin`. Defaults to "redacted". */
  readonly defaultMode: PiiMode;
  /** Per-origin overrides (exact origin string, e.g. "https://app.example.com"). */
  readonly perOrigin?: Readonly<Record<string, PiiMode>>;
}

export const DEFAULT_PII_POLICY: PiiPolicy = { defaultMode: "redacted" };

export type PiiType = "email" | "card" | "iban" | "ssn" | "phone";

interface Detector {
  readonly type: PiiType;
  readonly re: RegExp;
  /** Optional extra validation (e.g. Luhn) to suppress false positives. */
  readonly valid?: (match: string) => boolean;
}

function luhnValid(raw: string): boolean {
  const digits = raw.replace(/\D/g, "");
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

// Order matters: longer / more-specific structures first so a card isn't first
// eaten by the phone detector.
const DETECTORS: ReadonlyArray<Detector> = [
  { type: "email", re: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g },
  { type: "card", re: /\b(?:\d[ -]?){13,19}\b/g, valid: luhnValid },
  { type: "iban", re: /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g },
  { type: "ssn", re: /\b\d{3}-\d{2}-\d{4}\b/g },
  // Phone: require a leading + or grouping/separators so bare short integers
  // (counts, ids, prices) are not redacted. 10–15 significant digits.
  { type: "phone", re: /\+?\d[\d\s().-]{8,16}\d/g },
];

/** Detect structured PII spans in a string (for tests / policy reporting). */
export function detectPii(s: string): ReadonlyArray<{ type: PiiType; value: string }> {
  const found: { type: PiiType; value: string }[] = [];
  for (const d of DETECTORS) {
    for (const m of s.matchAll(d.re)) {
      const value = m[0];
      if (d.valid && !d.valid(value)) continue;
      if (d.type === "phone" && (value.replace(/\D/g, "").length < 10)) continue;
      found.push({ type: d.type, value });
    }
  }
  return found;
}

/** Replace every detected PII span with `[REDACTED:type]`. Idempotent. */
export function redactString(s: string): string {
  let out = s;
  for (const d of DETECTORS) {
    out = out.replace(d.re, (match) => {
      if (d.valid && !d.valid(match)) return match;
      if (d.type === "phone" && match.replace(/\D/g, "").length < 10) return match;
      return `[REDACTED:${d.type}]`;
    });
  }
  return out;
}

function redactUnknown(value: unknown): unknown {
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map(redactUnknown);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactUnknown(v);
    return out;
  }
  return value;
}

function originOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function modeFor(policy: PiiPolicy, url: string | undefined): PiiMode {
  const origin = originOf(url);
  if (origin && policy.perOrigin && origin in policy.perOrigin) return policy.perOrigin[origin]!;
  return policy.defaultMode;
}

function redactNode(n: IGNode): IGNode {
  return {
    ...n,
    label: redactString(n.label),
    ...(n.value !== undefined ? { value: redactString(n.value) } : {}),
    ...(n.placeholder !== undefined ? { placeholder: redactString(n.placeholder) } : {}),
    ...(n.axName !== undefined ? { axName: redactString(n.axName) } : {}),
    ...(n.href !== undefined ? { href: redactString(n.href) } : {}),
  };
}

function redactCommand(c: ActionCommand): ActionCommand {
  // Only string-bearing fields carry PII (typed text, a navigate URL, a query).
  return redactUnknown(c) as ActionCommand;
}

function redactEvent(e: TraceEvent, policy: PiiPolicy): TraceEvent {
  switch (e.kind) {
    case "snapshot": {
      if (modeFor(policy, e.url) === "full") return e;
      return { ...e, url: redactString(e.url), title: redactString(e.title), nodes: e.nodes.map(redactNode) };
    }
    case "action": {
      const url = e.command.type === "navigate" ? e.command.url : undefined;
      if (modeFor(policy, url) === "full") return e;
      return { ...e, command: redactCommand(e.command) };
    }
    case "action_result": {
      if (modeFor(policy, e.url) === "full") return e;
      return {
        ...e,
        url: redactString(e.url),
        ...(e.extracted !== undefined ? { extracted: redactUnknown(e.extracted) } : {}),
        ...(e.error !== undefined ? { error: redactString(e.error) } : {}),
      };
    }
    case "network": {
      if (modeFor(policy, e.url) === "full") return e;
      return { ...e, url: redactString(e.url) };
    }
    default:
      return e;
  }
}

/**
 * Return a redacted copy of the trace. Pure — does not mutate the input, so the
 * live in-memory trace (used by replay/control-plane behind the human boundary)
 * keeps full fidelity; only what crosses the Svod boundary is masked.
 */
export function redactTrace(trace: SessionTrace, policy: PiiPolicy = DEFAULT_PII_POLICY): SessionTrace {
  return { ...trace, events: trace.events.map((e) => redactEvent(e, policy)) };
}
