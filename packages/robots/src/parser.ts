/**
 * A minimal, spec-shaped robots.txt parser (RFC 9309 + Google's de-facto
 * conventions). It answers one question: "may the product token <ua> fetch
 * <path>?". It is deliberately NOT a full crawler config — `Sitemap`,
 * `Crawl-delay`, and host directives are ignored; this is a NAVIGATION GATE,
 * not a scheduler.
 *
 * Matching rules (Google):
 *   - Groups are keyed by `User-agent`. A group matches our token if the token
 *     is `*` or a case-insensitive substring of our product token. The MOST
 *     SPECIFIC (longest) non-`*` matching group wins; else the `*` group; else
 *     no group ⇒ allow all.
 *   - Within the winning group, the MOST SPECIFIC rule (longest pattern by raw
 *     length) decides. On a tie, `Allow` beats `Disallow` (least restrictive).
 *   - Patterns support `*` (any sequence) and a trailing `$` (end-anchor).
 *   - An empty `Disallow:` imposes nothing; `Disallow: /` blocks everything.
 */

export type RuleType = "allow" | "disallow";

export interface Rule {
  readonly type: RuleType;
  readonly pattern: string;
  /** Precompiled matcher for `pattern` (supports `*` and trailing `$`). */
  readonly re: RegExp;
  /** Specificity for the longest-match tie-break: raw pattern length. */
  readonly length: number;
}

export interface Group {
  /** Lower-cased user-agent tokens this group applies to. */
  readonly agents: string[];
  readonly rules: Rule[];
}

export interface RobotsRules {
  readonly groups: Group[];
}

/** Turn a robots path pattern into an anchored RegExp (`*` → `.*`, trailing `$`). */
export function patternToRegExp(pattern: string): RegExp {
  const endAnchored = pattern.endsWith("$");
  const body = endAnchored ? pattern.slice(0, -1) : pattern;
  // Escape every regex metachar, THEN restore `*` as a wildcard. `$` was already
  // stripped above when it was the end-anchor; a literal `$` mid-pattern is
  // escaped and matched literally (robots has no other meta but `*` and `$`).
  const escaped = body.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\*/g, ".*");
  return new RegExp("^" + escaped + (endAnchored ? "$" : ""));
}

/** Parse robots.txt text into agent-keyed groups. Tolerant of BOM, CRLF, comments. */
export function parseRobots(text: string): RobotsRules {
  const groups: Group[] = [];
  let current: { agents: string[]; rules: Rule[] } | null = null;
  // A group is "open for more agents" until its first rule line; a `User-agent`
  // after a rule starts a NEW group (Google grouping semantics).
  let sawRuleInGroup = false;

  for (let rawLine of text.split(/\r?\n/)) {
    // Strip UTF-8 BOM on the first line and inline comments.
    rawLine = rawLine.replace(/^\uFEFF/, "");
    const hash = rawLine.indexOf("#");
    const line = (hash === -1 ? rawLine : rawLine.slice(0, hash)).trim();
    if (!line) continue;

    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const field = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();

    if (field === "user-agent") {
      if (current === null || sawRuleInGroup) {
        current = { agents: [], rules: [] };
        groups.push(current);
        sawRuleInGroup = false;
      }
      if (value) current.agents.push(value.toLowerCase());
      continue;
    }

    if (field === "allow" || field === "disallow") {
      // A rule before any User-agent line is not part of any group — ignore it.
      if (current === null) continue;
      sawRuleInGroup = true;
      // Empty `Disallow` imposes nothing; empty `Allow` is meaningless. Skip both.
      if (value === "") continue;
      current.rules.push({
        type: field,
        pattern: value,
        re: patternToRegExp(value),
        length: value.length,
      });
    }
    // Sitemap / Crawl-delay / Host and unknown fields: intentionally ignored.
  }

  return { groups };
}

/** Select the most specific group applying to `token` (lower-cased product token). */
export function selectGroup(rules: RobotsRules, token: string): Group | undefined {
  const t = token.toLowerCase();
  let best: Group | undefined;
  let bestLen = -1;
  let star: Group | undefined;
  for (const g of rules.groups) {
    for (const agent of g.agents) {
      if (agent === "*") {
        star = star ?? g;
        continue;
      }
      // Google: a group applies if its token is a substring of the product token.
      if (t.includes(agent) && agent.length > bestLen) {
        best = g;
        bestLen = agent.length;
      }
    }
  }
  return best ?? star;
}

/**
 * Is `path` (pathname + search) allowed for product token `token`?
 * No matching group, or no matching rule, ⇒ allowed (default-allow).
 */
export function isAllowed(rules: RobotsRules, token: string, path: string): boolean {
  const group = selectGroup(rules, token);
  if (!group) return true;
  let decision: RuleType | null = null;
  let bestLen = -1;
  for (const rule of group.rules) {
    if (!rule.re.test(path)) continue;
    if (rule.length > bestLen || (rule.length === bestLen && rule.type === "allow")) {
      // Longest pattern wins; on a tie, Allow is least restrictive and wins.
      decision = rule.type;
      bestLen = rule.length;
    }
  }
  return decision !== "disallow";
}
