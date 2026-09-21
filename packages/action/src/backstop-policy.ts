/**
 * The backstop's decision, as a pure function.
 *
 * Kept away from CDP on purpose: these rules decide whether a real request is
 * held from a user, and they need to be testable exhaustively without a
 * browser. `effect-backstop.ts` supplies the facts; this decides.
 *
 * The question is never "is this request interesting" but "did the action we
 * just auto-granted as harmless actually commit something". Everything below is
 * an attempt to answer that without holding traffic the page was going to send
 * anyway.
 */

/**
 * Third-party measurement hosts, as DATA so the list can be reviewed and
 * diffed. Bump the version on every change; a verdict records which list judged
 * it.
 *
 * This list is the price of leaving the backstop on. Measured over ten live
 * flows, EVERY false escalation came from this infrastructure — consent
 * platforms posting their own usage statistics, ad exchanges syncing IDs, RUM
 * agents shipping timings. None of it commits anything a user would want to
 * approve, and all of it fires on exactly the clicks an agent makes.
 *
 * It is a curated list and it will need maintenance; that is why it is data
 * with a version, and why `category` is recorded — a reviewer can judge a whole
 * category at once rather than 60 hostnames one by one.
 *
 * Matching is by hostname SUFFIX on a dotted boundary, never substring:
 * `google-analytics.com.evil.test` is not Google.
 */
export const TELEMETRY_HOSTS_VERSION = "2026-09-21.1";

export type TelemetryCategory = "analytics" | "consent" | "adtech" | "rum" | "support";

export interface TelemetryHost {
  readonly host: string;
  readonly category: TelemetryCategory;
  /** Present when only a path prefix on that host is measurement. */
  readonly path?: string;
}

export const TELEMETRY_HOST_ENTRIES: readonly TelemetryHost[] = [
  // ── product analytics ───────────────────────────────────────────────────
  { host: "google-analytics.com", category: "analytics" },
  { host: "analytics.google.com", category: "analytics" },
  { host: "googletagmanager.com", category: "analytics" },
  { host: "segment.io", category: "analytics" },
  { host: "segment.com", category: "analytics" },
  { host: "amplitude.com", category: "analytics" },
  { host: "mixpanel.com", category: "analytics" },
  { host: "hotjar.com", category: "analytics" },
  { host: "hotjar.io", category: "analytics" },
  { host: "fullstory.com", category: "analytics" },
  { host: "logrocket.io", category: "analytics" },
  { host: "clarity.ms", category: "analytics" },
  { host: "plausible.io", category: "analytics" },
  { host: "matomo.cloud", category: "analytics" },
  { host: "posthog.com", category: "analytics" },
  { host: "scorecardresearch.com", category: "analytics" },
  { host: "quantserve.com", category: "analytics" },
  { host: "cloudflareinsights.com", category: "analytics" },
  { host: "gemius.pl", category: "analytics" },
  { host: "hit.gemius.pl", category: "analytics" },

  // ── consent / CMP. Measured: the single largest false-escalation source.
  //    A consent platform POSTs its own usage statistics on every interaction
  //    with the page, including the click that dismisses its dialog.
  { host: "termly.io", category: "consent" },
  { host: "fundingchoicesmessages.google.com", category: "consent" },
  { host: "cookiebot.com", category: "consent" },
  { host: "cookielaw.org", category: "consent" },
  { host: "onetrust.com", category: "consent" },
  { host: "usercentrics.eu", category: "consent" },
  { host: "consensu.org", category: "consent" },
  { host: "privacy-mgmt.com", category: "consent" },
  { host: "sp-prod.net", category: "consent" },
  { host: "didomi.io", category: "consent" },
  { host: "iubenda.com", category: "consent" },
  { host: "quantcast.mgr.consensu.org", category: "consent" },

  // ── ad exchanges and identity sync ──────────────────────────────────────
  { host: "doubleclick.net", category: "adtech" },
  { host: "crwdcntrl.net", category: "adtech" },
  { host: "adsrvr.org", category: "adtech" },
  { host: "adnxs.com", category: "adtech" },
  { host: "casalemedia.com", category: "adtech" },
  { host: "rubiconproject.com", category: "adtech" },
  { host: "pubmatic.com", category: "adtech" },
  { host: "openx.net", category: "adtech" },
  { host: "criteo.com", category: "adtech" },
  { host: "criteo.net", category: "adtech" },
  { host: "taboola.com", category: "adtech" },
  { host: "outbrain.com", category: "adtech" },
  { host: "bat.bing.com", category: "adtech" },
  { host: "connect.facebook.net", category: "adtech" },
  { host: "facebook.com", category: "adtech", path: "/tr" },
  { host: "smartadserver.com", category: "adtech" },
  { host: "360yield.com", category: "adtech" },
  { host: "adform.net", category: "adtech" },

  // ── error reporting and real-user monitoring ────────────────────────────
  { host: "sentry.io", category: "rum" },
  { host: "ingest.sentry.io", category: "rum" },
  { host: "sentry-cdn.com", category: "rum" },
  { host: "bugsnag.com", category: "rum" },
  { host: "datadoghq.com", category: "rum" },
  { host: "browser-intake-datadoghq.com", category: "rum" },
  { host: "newrelic.com", category: "rum" },
  { host: "nr-data.net", category: "rum" },
  { host: "browser.events.data.microsoft.com", category: "rum" },
  { host: "dynatrace.com", category: "rum" },

  // ── embedded support widgets: they post transcripts and presence, not
  //    application state, and they fire on any click.
  { host: "intercom.io", category: "support" },
  { host: "intercomcdn.com", category: "support" },
  { host: "zendesk.com", category: "support" },
  { host: "zdassets.com", category: "support" },
  { host: "crisp.chat", category: "support" },
];

/** Flat host list, kept for callers that only need the strings. */
export const TELEMETRY_HOSTS: readonly string[] = TELEMETRY_HOST_ENTRIES.map((e) =>
  e.path ? `${e.host}${e.path}` : e.host,
);

/** Resource types the browser itself labels as fire-and-forget measurement. */
export const NON_COMMITTING_RESOURCE_TYPES: ReadonlySet<string> = new Set([
  "Ping",
  "CSPViolationReport",
  "Prefetch",
  "Preflight",
]);

const STATE_CHANGING_METHODS: ReadonlySet<string> = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export interface BackstopRequestFacts {
  readonly url: string;
  readonly method: string;
  readonly resourceType: string;
  readonly headers: Readonly<Record<string, string>>;
  /** Request body, when the browser gave us one. */
  readonly postData?: string;
  /** Frame the request belongs to. */
  readonly frameId?: string;
  /** `Network.Initiator.type` — "script", "parser", "preload", "SignedExchange", "other". */
  readonly initiatorType?: string;
  /** True when the request carries `keepalive` (sendBeacon and fetch keepalive). */
  readonly keepalive?: boolean;
}

export interface BackstopContext {
  /** Origin the session is scoped to. */
  readonly taskOrigin: string | undefined;
  /** Frame the agent acted in. A request from another frame is not ours. */
  readonly actedFrameId: string | undefined;
  /**
   * Endpoint keys seen BEFORE the agent's first action this session. Autosave,
   * heartbeats and session pings all announce themselves this way.
   */
  readonly backgroundEndpoints: ReadonlySet<string>;
  /** Overridable for tests. */
  readonly telemetryHosts?: readonly string[];
}

export type BackstopDecision =
  | { readonly hold: false; readonly why: string }
  | { readonly hold: true; readonly why: string };

const PASS = (why: string): BackstopDecision => ({ hold: false, why });
const HOLD = (why: string): BackstopDecision => ({ hold: true, why });

/** method + origin + pathname. Query strings vary per row; the endpoint does not. */
export function endpointKey(method: string, url: string): string {
  try {
    const u = new URL(url);
    return `${method.toUpperCase()} ${u.origin}${u.pathname}`;
  } catch {
    return `${method.toUpperCase()} ${url}`;
  }
}

function hostMatches(hostname: string, url: string, suffixes: readonly string[]): boolean {
  const h = hostname.toLowerCase();
  for (const s of suffixes) {
    if (s.includes("/")) {
      // A host+path entry (e.g. "facebook.com/tr") — match both parts.
      const [host, ...rest] = s.split("/");
      if (host && (h === host || h.endsWith(`.${host}`)) && url.includes(`/${rest.join("/")}`)) return true;
      continue;
    }
    if (h === s || h.endsWith(`.${s}`)) return true;
  }
  return false;
}

/**
 * GraphQL verdict. One endpoint carries both reads and writes, so the method
 * says nothing — the body does.
 */
export type GraphqlVerdict = "query" | "mutation" | "unparseable" | "persisted" | "not-graphql";

export function classifyGraphql(url: string, postData: string | undefined): GraphqlVerdict {
  const looksGraphql = /\/graphql\b|\/gql\b|\/api\/graph\b/i.test(url);
  if (!looksGraphql) return "not-graphql";
  if (postData === undefined || postData.trim() === "") return "unparseable";

  let body: unknown;
  try {
    body = JSON.parse(postData);
  } catch {
    return "unparseable";
  }
  // Batched GraphQL sends an array; a batch is a mutation if ANY member is.
  const entries = Array.isArray(body) ? body : [body];
  let sawQuery = false;
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) return "unparseable";
    const rec = entry as Record<string, unknown>;
    const text = typeof rec["query"] === "string" ? rec["query"] : undefined;
    if (text === undefined) {
      // No document. A persisted query ships only a hash, so we cannot see what
      // it does — and what we cannot see, we do not wave through.
      const ext = rec["extensions"];
      if (ext && typeof ext === "object" && "persistedQuery" in ext) return "persisted";
      return "unparseable";
    }
    const op = firstOperationKeyword(text);
    if (op === "mutation" || op === "subscription") return "mutation";
    if (op === "unknown") return "unparseable";
    sawQuery = true;
  }
  return sawQuery ? "query" : "unparseable";
}

/**
 * The first operation keyword in a GraphQL document, ignoring comments and
 * leading whitespace. An anonymous `{ … }` document is a query by the spec.
 */
function firstOperationKeyword(text: string): "query" | "mutation" | "subscription" | "unknown" {
  const stripped = text.replace(/#[^\n]*/g, "").trimStart();
  if (stripped.startsWith("{")) return "query";
  const m = /^(query|mutation|subscription)\b/i.exec(stripped);
  if (m) return m[1]!.toLowerCase() as "query" | "mutation" | "subscription";
  // `fragment F on T { … } mutation M { … }` — find the first operation past
  // any leading fragment definitions.
  const op = /\b(query|mutation|subscription)\s|\bfragment\b/i.exec(stripped);
  if (op && /^fragment$/i.test(op[0].trim())) {
    const after = stripped.slice(op.index + op[0].length);
    return firstOperationKeyword(after);
  }
  if (op) return op[1]!.toLowerCase() as "query" | "mutation" | "subscription";
  return "unknown";
}

function isCrossOrigin(url: string, taskOrigin: string | undefined): boolean {
  if (!taskOrigin) return false;
  try {
    return new URL(url).origin !== new URL(taskOrigin).origin;
  } catch {
    return false;
  }
}

function hasCredentials(headers: Readonly<Record<string, string>>): boolean {
  for (const k of Object.keys(headers)) {
    const lower = k.toLowerCase();
    if (lower === "cookie" || lower === "authorization") return true;
  }
  return false;
}

/**
 * Should this request be held and escalated?
 *
 * Called only while the backstop is armed — i.e. inside the window after an
 * action the gate auto-granted as read or benign. A consequential action
 * already carries its human grant and is not second-guessed here.
 */
export function decide(facts: BackstopRequestFacts, ctx: BackstopContext): BackstopDecision {
  const method = facts.method.toUpperCase();

  // ── Things that are not the agent's doing ────────────────────────────────

  if (NON_COMMITTING_RESOURCE_TYPES.has(facts.resourceType)) {
    return PASS(`resource type ${facts.resourceType} commits nothing`);
  }
  if (facts.keepalive === true) {
    // sendBeacon and `fetch(..., {keepalive:true})`: the shape of telemetry
    // that must survive page unload. Applications do not commit orders this way.
    return PASS("keepalive/beacon telemetry");
  }

  let hostname = "";
  try {
    hostname = new URL(facts.url).hostname;
  } catch {
    return HOLD("unparseable request URL");
  }
  if (hostMatches(hostname, facts.url, ctx.telemetryHosts ?? TELEMETRY_HOSTS)) {
    return PASS(`telemetry host (${hostname}, list ${TELEMETRY_HOSTS_VERSION})`);
  }

  // Only a script can be the consequence of a click. A parser-initiated
  // request is the page loading itself; a preload is the browser guessing.
  if (facts.initiatorType !== undefined && facts.initiatorType !== "script") {
    return PASS(`initiator is ${facts.initiatorType}, not the acted-on script`);
  }
  if (
    ctx.actedFrameId !== undefined &&
    facts.frameId !== undefined &&
    facts.frameId !== ctx.actedFrameId
  ) {
    return PASS("request belongs to a different frame than the action");
  }

  // Autosave, heartbeats, session pings: if this endpoint was already firing
  // before the agent did anything, it is the page's own background traffic and
  // the agent's click did not cause it.
  const key = endpointKey(method, facts.url);
  if (ctx.backgroundEndpoints.has(key)) {
    return PASS(`endpoint was already active before any agent action (${key})`);
  }

  // ── GraphQL: the method is uninformative, the body is not ────────────────

  const gql = classifyGraphql(facts.url, facts.postData);
  if (gql === "query") return PASS("GraphQL query operation");
  if (gql === "mutation") return HOLD("GraphQL mutation");
  if (gql === "persisted") return HOLD("GraphQL persisted query — hash only, effect not visible");
  if (gql === "unparseable") return HOLD("GraphQL request body could not be parsed");

  // ── Ordinary state change ────────────────────────────────────────────────

  if (STATE_CHANGING_METHODS.has(method)) {
    return HOLD(`${method} issued by an action auto-granted as benign`);
  }

  if (method === "GET" && isCrossOrigin(facts.url, ctx.taskOrigin) && hasCredentials(facts.headers)) {
    // A read for the site, an authenticated action for the agent: it carries
    // the session outward.
    return HOLD("credentialed cross-origin GET issued by an auto-granted action");
  }

  return PASS(`${method} with no state-changing effect`);
}
