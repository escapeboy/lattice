/**
 * Phase 2B capture — real Interaction Graph snapshots from public, logged-out
 * pages across many origins.
 *
 * Politeness: robots.txt is honoured per origin using @lattice/robots (the
 * repo's own parser, read-only), and requests to one origin are spaced out.
 * Everything runs in a throwaway context; no credentials, no profile.
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { parseRobots, isAllowed, type RobotsRules } from "@lattice/robots";
import { startHarness } from "../run/harness.js";
import type { InteractionGraph } from "@lattice/perception";

const USER_AGENT = "Lattice";
const PER_ORIGIN_DELAY_MS = 900;
const NAV_TIMEOUT_MS = 25_000;

/** Public documentation / project sites: stable, logged-out, control-rich. */
export const SEED_PAGES: readonly string[] = [
  "https://en.wikipedia.org/wiki/Main_Page",
  "https://en.wikipedia.org/wiki/Interaction_design",
  "https://en.wikipedia.org/wiki/Accessibility",
  "https://en.wikipedia.org/wiki/Web_browser",
  "https://en.wikipedia.org/wiki/Special:Search",
  "https://en.wikipedia.org/wiki/Prompt_engineering",
  "https://en.wikipedia.org/wiki/Computer_security",
  "https://en.wikipedia.org/wiki/Hypertext_Transfer_Protocol",
  "https://en.wikipedia.org/wiki/Usability",

  "https://www.mediawiki.org/wiki/MediaWiki",
  "https://www.mediawiki.org/wiki/API:Main_page",
  "https://www.mediawiki.org/wiki/Manual:Contents",
  "https://www.mediawiki.org/wiki/Special:Search",
  "https://www.mediawiki.org/wiki/Download",
  "https://www.mediawiki.org/wiki/Developers",
  "https://www.mediawiki.org/wiki/Extension:Examples",
  "https://www.mediawiki.org/wiki/Help:Contents",
  "https://www.mediawiki.org/wiki/Project:Support_desk",

  "https://developer.mozilla.org/en-US/",
  "https://developer.mozilla.org/en-US/docs/Web/HTML",
  "https://developer.mozilla.org/en-US/docs/Web/CSS",
  "https://developer.mozilla.org/en-US/docs/Web/API",
  "https://developer.mozilla.org/en-US/docs/Web/Accessibility",
  "https://developer.mozilla.org/en-US/docs/Web/JavaScript",
  "https://developer.mozilla.org/en-US/docs/Web/HTTP",
  "https://developer.mozilla.org/en-US/about",
  "https://developer.mozilla.org/en-US/docs/Web/HTML/Element/button",

  "https://www.python.org/",
  "https://www.python.org/downloads/",
  "https://www.python.org/about/",
  "https://www.python.org/community/",
  "https://www.python.org/doc/",
  "https://www.python.org/psf/",
  "https://www.python.org/events/",
  "https://www.python.org/blogs/",
  "https://www.python.org/success-stories/",

  "https://nodejs.org/en",
  "https://nodejs.org/en/download",
  "https://nodejs.org/en/about",
  "https://nodejs.org/en/learn",
  "https://nodejs.org/en/blog",
  "https://nodejs.org/en/about/governance",
  "https://nodejs.org/en/about/previous-releases",
  "https://nodejs.org/en/download/package-manager",

  "https://www.rust-lang.org/",
  "https://www.rust-lang.org/learn",
  "https://www.rust-lang.org/tools/install",
  "https://www.rust-lang.org/governance",
  "https://www.rust-lang.org/community",
  "https://www.rust-lang.org/policies",
  "https://www.rust-lang.org/what/cli",
  "https://www.rust-lang.org/learn/get-started",

  "https://go.dev/",
  "https://go.dev/doc/",
  "https://go.dev/dl/",
  "https://go.dev/learn/",
  "https://go.dev/solutions/",
  "https://go.dev/blog/",
  "https://go.dev/help/",
  "https://go.dev/doc/tutorial/getting-started",

  "https://www.gnu.org/",
  "https://www.gnu.org/software/software.html",
  "https://www.gnu.org/licenses/licenses.html",
  "https://www.gnu.org/help/help.html",
  "https://www.gnu.org/philosophy/philosophy.html",
  "https://www.gnu.org/distros/free-distros.html",
  "https://www.gnu.org/gnu/gnu.html",
  "https://www.gnu.org/doc/doc.html",

  "https://www.kernel.org/",
  "https://www.kernel.org/category/releases.html",
  "https://www.kernel.org/category/signatures.html",
  "https://www.kernel.org/doc/html/latest/",
  "https://www.kernel.org/category/about.html",
  "https://www.kernel.org/category/faq.html",

  "https://httpd.apache.org/",
  "https://httpd.apache.org/download.cgi",
  "https://httpd.apache.org/docs/",
  "https://httpd.apache.org/security_report.html",
  "https://httpd.apache.org/support.html",
  "https://httpd.apache.org/contribute/",

  "https://www.debian.org/",
  "https://www.debian.org/distrib/",
  "https://www.debian.org/intro/about",
  "https://www.debian.org/support",
  "https://www.debian.org/doc/",
  "https://www.debian.org/donations",
  "https://www.debian.org/CD/",

  "https://www.openstreetmap.org/about",
  "https://www.openstreetmap.org/help",
  "https://www.openstreetmap.org/copyright",
  "https://www.openstreetmap.org/fixthemap",

  "https://www.w3.org/",
  "https://www.w3.org/standards/",
  "https://www.w3.org/WAI/",
  "https://www.w3.org/WAI/standards-guidelines/wcag/",
  "https://www.w3.org/participate/",
  "https://www.w3.org/about/",

  "https://news.ycombinator.com/news",
  "https://news.ycombinator.com/newest",
  "https://news.ycombinator.com/ask",
  "https://news.ycombinator.com/show",
  "https://news.ycombinator.com/jobs",

  "https://curl.se/",
  "https://curl.se/download.html",
  "https://curl.se/docs/",
  "https://curl.se/docs/security.html",
  "https://curl.se/support.html",
  "https://curl.se/donation.html",

  "https://www.postgresql.org/",
  "https://www.postgresql.org/download/",
  "https://www.postgresql.org/docs/",
  "https://www.postgresql.org/support/",
  "https://www.postgresql.org/community/",
  "https://www.postgresql.org/about/donate/",
  "https://www.postgresql.org/about/",

  "https://git-scm.com/",
  "https://git-scm.com/downloads",
  "https://git-scm.com/doc",
  "https://git-scm.com/book/en/v2",
  "https://git-scm.com/community",
  "https://git-scm.com/about",

  "https://www.sqlite.org/index.html",
  "https://www.sqlite.org/download.html",
  "https://www.sqlite.org/docs.html",
  "https://www.sqlite.org/support.html",
  "https://www.sqlite.org/copyright.html",

  "https://www.openssl.org/",
  "https://www.openssl.org/source/",
  "https://www.openssl.org/docs/",
  "https://www.openssl.org/community/",
  "https://www.openssl.org/policies/",

  "https://www.iana.org/",
  "https://www.iana.org/domains",
  "https://www.iana.org/numbers",
  "https://www.iana.org/protocols",
  "https://www.iana.org/about",

  // Second pass — more pages on origins that responded reliably, plus three
  // further origins, to reach the 150-snapshot target.
  "https://en.wikipedia.org/wiki/Semantic_Web",
  "https://en.wikipedia.org/wiki/Open_source",
  "https://en.wikipedia.org/wiki/Cryptography",
  "https://en.wikipedia.org/wiki/Database",
  "https://en.wikipedia.org/wiki/Operating_system",
  "https://www.mediawiki.org/wiki/Manual:Configuration_settings",
  "https://www.mediawiki.org/wiki/Special:MyLanguage/Help:Links",
  "https://www.mediawiki.org/wiki/Gerrit",
  "https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API",
  "https://developer.mozilla.org/en-US/docs/Web/CSS/flex",
  "https://developer.mozilla.org/en-US/docs/Web/HTML/Element/form",
  "https://developer.mozilla.org/en-US/docs/Learn_web_development",
  "https://www.python.org/dev/peps/",
  "https://www.python.org/downloads/source/",
  "https://www.python.org/about/apps/",
  "https://www.python.org/community/forums/",
  "https://nodejs.org/en/download/current",
  "https://nodejs.org/en/about/releases",
  "https://nodejs.org/en/learn/getting-started/introduction-to-nodejs",
  "https://www.rust-lang.org/tools",
  "https://www.rust-lang.org/learn/challenges",
  "https://www.rust-lang.org/production",
  "https://go.dev/doc/effective_go",
  "https://go.dev/doc/install",
  "https://go.dev/ref/spec",
  "https://www.debian.org/releases/",
  "https://www.debian.org/security/",
  "https://www.debian.org/social_contract",
  "https://www.postgresql.org/docs/current/",
  "https://www.postgresql.org/list/",
  "https://www.postgresql.org/developer/",
  "https://git-scm.com/docs",
  "https://git-scm.com/book/en/v2/Getting-Started-About-Version-Control",
  "https://git-scm.com/downloads/mac",
  "https://curl.se/libcurl/",
  "https://curl.se/dev/",
  "https://www.sqlite.org/whentouse.html",
  "https://www.sqlite.org/lang.html",
  "https://www.iana.org/time-zones",
  "https://www.iana.org/help/example-domains",
  "https://www.w3.org/TR/",
  "https://www.w3.org/community/",
  "https://httpd.apache.org/docs/2.4/",
  "https://httpd.apache.org/info/",
  "https://www.kernel.org/doc/",
  "https://news.ycombinator.com/best",
  "https://news.ycombinator.com/front",
  "https://www.openstreetmap.org/traces",
  "https://www.openstreetmap.org/user/new",
];

export interface CapturedNode {
  readonly id: string;
  readonly role: string;
  readonly label: string;
  readonly value?: string;
  readonly placeholder?: string;
  readonly href?: string;
  readonly relations: ReadonlyArray<{ type: string; targetId: string }>;
  /** Position in nodeOrder — used to build document-adjacency edges. */
  readonly ordinal: number;
}

export interface CapturedSnapshot {
  readonly url: string;
  readonly origin: string;
  readonly title: string;
  readonly capturedAt: string;
  readonly nodes: readonly CapturedNode[];
}

function toCaptured(ig: InteractionGraph, url: string): CapturedSnapshot {
  const nodes: CapturedNode[] = [];
  ig.nodeOrder.forEach((id, ordinal) => {
    const n = ig.nodes.get(id);
    if (!n) return;
    nodes.push({
      id: String(n.id),
      role: n.role,
      label: n.label,
      ...(n.value !== undefined ? { value: n.value } : {}),
      ...(n.placeholder !== undefined ? { placeholder: n.placeholder } : {}),
      ...(n.href !== undefined ? { href: n.href } : {}),
      relations: n.relations.map((r) => ({ type: r.type, targetId: String(r.targetId) })),
      ordinal,
    });
  });
  return {
    url,
    origin: new URL(url).origin,
    title: ig.title,
    capturedAt: new Date().toISOString(),
    nodes,
  };
}

async function robotsFor(origin: string): Promise<RobotsRules | null> {
  try {
    const res = await fetch(`${origin}/robots.txt`, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    return parseRobots(await res.text());
  } catch {
    return null;
  }
}

export async function capture(outPath: string): Promise<CapturedSnapshot[]> {
  const harness = await startHarness(true);
  const snapshots: CapturedSnapshot[] = [];
  const robotsCache = new Map<string, RobotsRules | null>();
  const lastHit = new Map<string, number>();

  try {
    for (const url of SEED_PAGES) {
      const origin = new URL(url).origin;

      if (!robotsCache.has(origin)) robotsCache.set(origin, await robotsFor(origin));
      const rules = robotsCache.get(origin) ?? null;
      if (rules && !isAllowed(rules, USER_AGENT, new URL(url).pathname)) {
        process.stderr.write(`robots-disallow ${url}\n`);
        continue;
      }

      const since = Date.now() - (lastHit.get(origin) ?? 0);
      if (since < PER_ORIGIN_DELAY_MS) {
        await new Promise((r) => setTimeout(r, PER_ORIGIN_DELAY_MS - since));
      }
      lastHit.set(origin, Date.now());

      try {
        const opened = await Promise.race([
          harness.open(url),
          new Promise<never>((_, rej) => setTimeout(() => rej(new Error("nav timeout")), NAV_TIMEOUT_MS)),
        ]);
        const { run } = opened;
        try {
          const ig = (await run.perception.snapshot("L2")) as InteractionGraph;
          const snap = toCaptured(ig, run.ctx.currentUrl() || url);
          snapshots.push(snap);
          process.stderr.write(`ok ${snap.origin} ${snap.nodes.length} nodes ${url}\n`);
        } finally {
          await run.close().catch(() => undefined);
        }
      } catch (err) {
        process.stderr.write(`skip ${url}: ${(err as Error).message}\n`);
      }
      writeJson(outPath, snapshots);
    }
  } finally {
    await harness.shutdown();
  }
  writeJson(outPath, snapshots);
  return snapshots;
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}
