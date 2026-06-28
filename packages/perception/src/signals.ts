/**
 * Page-level perception signals (smoke gaps #3 bot-wall + #4 canvas/WebGL).
 *
 * The agent otherwise treats a trivially-small IG as a normal small page and
 * acts on a dead/blocked/canvas page. These are derived from the IG + title
 * ALONE — `eval` is firewalled on the build-on path, so we cannot count <canvas>
 * elements or read raw DOM. So the canvas case is folded into a conservative
 * "content-sparse" advisory rather than a precise canvas count: the actionable
 * outcome is the same (re-perceive at L3 / don't act blindly).
 */

// High-precision: page text that reads like an error or bot-wall. A page literally
// saying "404" / "captcha" / "access denied" is almost certainly not real content.
const ERROR_RE =
  /\b(?:404|not found|access denied|forbidden|captcha|are you (?:a )?(?:human|robot)|verify (?:you are|your)|temporarily blocked|rate.?limited|too many requests|unusual traffic|enable javascript)\b/i;

export interface PageSignals {
  /** Almost nothing addressable — possibly a bot-wall, an error, or canvas/WebGL
   *  content the accessibility tree can't represent. ADVISORY (heuristic). */
  readonly contentSparse: boolean;
  /** The title/visible text reads like an error / bot-wall. HIGH precision. */
  readonly looksLikeError: boolean;
  /** What the agent should do about it. */
  readonly hint: string;
}

/**
 * Returns a signals object ONLY when something is noteworthy (so normal pages
 * stay clean), else `undefined`.
 */
export function pageSignals(
  nodes: ReadonlyArray<{ readonly label?: string }>,
  title?: string,
): PageSignals | undefined {
  // ≤2 addressable nodes is essentially impossible for a real content page;
  // gymshark's bot-block was 2 nodes, the WebGL aquarium was 1.
  const contentSparse = nodes.length <= 2;
  const haystack = [title, ...nodes.map((n) => n.label).filter(Boolean)].join(" ");
  const looksLikeError = ERROR_RE.test(haystack);

  if (!contentSparse && !looksLikeError) return undefined;

  const hint = looksLikeError
    ? "The page text reads like an error / bot-wall (404, captcha, access-denied, 'enable JavaScript'). Don't act as if normal content loaded — consider a human handoff or a different route."
    : "Almost nothing is addressable here — the page may be a bot-wall, an error, or canvas/WebGL content the accessibility tree can't represent. Re-perceive at tier L3 (screenshot) before acting, or treat it as a dead page.";

  return { contentSparse, looksLikeError, hint };
}
