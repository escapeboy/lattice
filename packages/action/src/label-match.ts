/**
 * Tolerant semantic-label matching for locators (recipe + recovery rung 2).
 *
 * Strict `node.label === locator.label` fails on real-world controls whose
 * accessible name carries decorative trailing glyphs ("Get Started →"), different
 * case ("LOG IN"), or extra trailing words ("Reject all and subscribe" vs the
 * human "Reject all"). Perception SEES the control; the agent just can't address
 * it by the name a human/agent would use. These helpers normalise both sides and
 * tolerate a trailing-content difference, while callers keep the match ROLE-SCOPED
 * so a loose label can't collide across control types.
 */

// Decorative leading/trailing runs: whitespace, the arrows block (U+2190–21FF),
// chevrons/guillemets, bullets, ellipsis (and its NFKC "..." expansion), dashes,
// and common separators. Anchored to the edges, so internal punctuation is kept.
const DECORATIVE_EDGE =
  /^[\s←-⇿•·…–—<>«»‹›|:+.\-–—]+|[\s←-⇿•·…–—<>«»‹›|:+.\-–—]+$/gu;

/** Case-fold, NFKC-normalise, collapse whitespace, strip decorative edges. */
export function normalizeLabel(s: string): string {
  return s
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim()
    .replace(DECORATIVE_EDGE, "")
    .trim()
    .toLowerCase();
}

/**
 * Does `candidate` (a node's label) match `target` (a locator's label)?
 * Exact after normalisation, OR the candidate carries the target plus extra
 * trailing content (glyph/word) — e.g. node "Reject all and subscribe" matches
 * locator "Reject all". The reverse (target longer than the node) is NOT matched,
 * to avoid "Log" capturing "Log in". Empty target never matches.
 */
export function labelMatches(candidate: string, target: string): boolean {
  const c = normalizeLabel(candidate);
  const t = normalizeLabel(target);
  if (t === "") return false;
  if (c === t) return true;
  return c.startsWith(t);
}
