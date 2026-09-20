/**
 * TAINT RULE — enforced here, tested in taint.test.ts.
 *
 * Page-derived strings may appear ONLY inside a Jev request's `state`. A
 * question's `instructions` and `criteria` (keys AND values) are assembled from
 * static templates, the operator-supplied goal, element indices, and the closed
 * role vocabulary.
 *
 * Why it matters: `state` is data the model weighs, but `instructions` and
 * `criteria` define what the question MEANS. A page that can write into the
 * rubric can redefine the decision itself, not merely argue for an option. An
 * element's visible label is page-derived, so labels live in the `state`
 * element table and criteria carry the bare index plus its role.
 */

import type { InteractionGraph, NodeRole } from "@lattice/perception";

/** Closed role vocabulary — a classification produced by perception, not page text. */
const ROLE_VOCABULARY: ReadonlySet<string> = new Set<NodeRole>([
  "button",
  "link",
  "input",
  "select",
  "textarea",
  "checkbox",
  "radio",
  "combobox",
  "heading",
  "landmark",
  "list",
  "listitem",
  "dialog",
  "alert",
  "tab",
  "tabpanel",
  "menu",
  "menuitem",
  "image",
  "table",
  "row",
  "cell",
  "article",
  "code",
  "text",
  "iframe",
  "generic",
]);

/**
 * Page strings shorter than this are not searched for. A 2-character label
 * ("OK") collides with ordinary template text too often to be a usable signal,
 * and the structural check below already constrains what criteria may contain.
 */
const MIN_TAINT_LENGTH = 3;

export class TaintViolation extends Error {
  constructor(
    readonly pageString: string,
    readonly path: string,
  ) {
    super(
      `Taint violation: page-derived string ${JSON.stringify(pageString)} reached ${path}. ` +
        `Page text belongs in state, never in instructions or criteria.`,
    );
    this.name = "TaintViolation";
  }
}

/** Every string that originated in the page, from an L1/L2 Interaction Graph. */
export function collectPageStrings(ig: InteractionGraph): Set<string> {
  const out = new Set<string>();
  const add = (s: string | undefined): void => {
    if (typeof s !== "string") return;
    const t = s.trim();
    // A label that happens to BE a role name ("button") is not evidence of a
    // leak — the role vocabulary is ours, and criteria legitimately contain it.
    if (t.length < MIN_TAINT_LENGTH) return;
    if (ROLE_VOCABULARY.has(t.toLowerCase())) return;
    out.add(t);
  };
  add(ig.url);
  add(ig.title);
  for (const node of ig.nodes.values()) {
    add(node.label);
    add(node.value);
    add(node.placeholder);
    add(node.href);
    add(node.axName);
  }
  return out;
}

/** Walk a value, yielding every string leaf AND every object key, with a path. */
function* strings(value: unknown, path: string): Generator<[string, string]> {
  if (typeof value === "string") {
    yield [value, path];
    return;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) yield* strings(value[i], `${path}[${i}]`);
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      yield [k, `${path}.<key ${JSON.stringify(k)}>`];
      yield* strings(v, `${path}.${k}`);
    }
  }
}

/**
 * Throw if any page-derived string reached the question surface.
 *
 * `allowedFreeText` is the operator-supplied goal. It is trusted input (it comes
 * from the caller, not the page) and may legitimately contain words that also
 * appear on the page, so substrings of it are exempt.
 */
export function assertUntainted(
  questions: unknown,
  pageStrings: ReadonlySet<string>,
  allowedFreeText: readonly string[] = [],
  staticTemplates: ReadonlySet<string> = new Set(),
): void {
  const exempt = allowedFreeText.map((t) => t.toLowerCase());
  for (const [leaf, path] of strings(questions, "questions")) {
    // A leaf that is EXACTLY one of our compile-time template constants cannot
    // have come from the page: the constant existed before any page was seen.
    // Exact equality only — a page can at most match a string we already had,
    // never smuggle one in. This is what stops a page whose link is labelled
    // "target" from tripping the scan on our own fixed rule text.
    if (staticTemplates.has(leaf)) continue;
    const haystack = leaf.toLowerCase();
    for (const page of pageStrings) {
      const needle = page.toLowerCase();
      if (!haystack.includes(needle)) continue;
      // The goal may quote page words; that string did not come from the page.
      if (exempt.some((t) => t.includes(needle))) continue;
      throw new TaintViolation(page, path);
    }
  }
}

/**
 * Structural companion to the blacklist scan: a target head's criteria may only
 * ever be `index -> role` plus "other". This holds even for a page string the
 * scan cannot see (too short, or absent from the IG we happened to capture).
 */
export function assertTargetCriteriaShape(criteria: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(criteria)) {
    if (key !== "other" && !/^[1-9][0-9]*$/.test(key)) {
      throw new TaintViolation(key, "criteria.<key> must be an element index or \"other\"");
    }
    if (typeof value !== "string") {
      throw new TaintViolation(String(value), `criteria.${key} must be a string`);
    }
    if (key === "other") continue;
    if (!ROLE_VOCABULARY.has(value)) {
      throw new TaintViolation(value, `criteria.${key} must be a bare role, got ${JSON.stringify(value)}`);
    }
  }
}
