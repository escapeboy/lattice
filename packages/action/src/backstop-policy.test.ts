/**
 * The backstop's rules, exhaustively, without a browser.
 *
 * Each `it` is one way a real page produces a POST that is NOT the agent's
 * doing. Every one of those that reaches a human is a false escalation, and
 * false escalations are what make a gate get switched off.
 */

import { describe, expect, it } from "vitest";
import {
  classifyGraphql,
  decide,
  endpointKey,
  TELEMETRY_HOSTS,
  type BackstopContext,
  type BackstopRequestFacts,
} from "./backstop-policy.js";

const ORIGIN = "https://shop.example.com";

const CTX: BackstopContext = {
  taskOrigin: ORIGIN,
  actedFrameId: "FRAME-A",
  backgroundEndpoints: new Set<string>(),
};

function facts(over: Partial<BackstopRequestFacts> = {}): BackstopRequestFacts {
  return {
    url: `${ORIGIN}/api/orders`,
    method: "POST",
    resourceType: "XHR",
    headers: { "content-type": "application/json" },
    frameId: "FRAME-A",
    initiatorType: "script",
    ...over,
  };
}

describe("backstop — what gets held", () => {
  it("holds a same-origin POST from the acted-on frame's script", () => {
    const d = decide(facts(), CTX);
    expect(d.hold).toBe(true);
    expect(d.why).toContain("POST");
  });

  it.each(["PUT", "PATCH", "DELETE"])("holds %s", (method) => {
    expect(decide(facts({ method }), CTX).hold).toBe(true);
  });

  it("holds a credentialed cross-origin GET", () => {
    const d = decide(
      facts({
        method: "GET",
        url: "https://other.example.net/track?u=1",
        headers: { cookie: "sid=abc" },
      }),
      CTX,
    );
    expect(d.hold).toBe(true);
  });

  it("passes a plain GET, credentialed or not, on the task origin", () => {
    expect(decide(facts({ method: "GET", headers: {} }), CTX).hold).toBe(false);
    expect(decide(facts({ method: "GET", headers: { cookie: "sid=abc" } }), CTX).hold).toBe(false);
  });

  it("passes an UNcredentialed cross-origin GET", () => {
    const d = decide(facts({ method: "GET", url: "https://cdn.example.net/x.json", headers: {} }), CTX);
    expect(d.hold).toBe(false);
  });
});

describe("backstop — what must NOT be held", () => {
  it("passes beacon and report resource types", () => {
    for (const resourceType of ["Ping", "CSPViolationReport", "Prefetch", "Preflight"]) {
      expect(decide(facts({ resourceType }), CTX).hold, resourceType).toBe(false);
    }
  });

  it("passes keepalive telemetry", () => {
    expect(decide(facts({ keepalive: true }), CTX).hold).toBe(false);
  });

  it("passes a text/plain beacon-shaped POST", () => {
    const d = decide(facts({ resourceType: "Fetch", headers: { "content-type": "text/plain;charset=UTF-8" }, keepalive: true }), CTX);
    expect(d.hold).toBe(false);
  });

  it.each([
    "https://www.google-analytics.com/g/collect",
    "https://region1.google-analytics.com/g/collect",
    "https://o123456.ingest.sentry.io/api/7/envelope/",
    "https://browser-intake-datadoghq.com/api/v2/rum",
    "https://api.segment.io/v1/t",
    "https://eu.posthog.com/e/",
    "https://in.hotjar.com/api/v2/client/sites",
  ])("passes telemetry host %s", (url) => {
    expect(decide(facts({ url }), CTX).hold, url).toBe(false);
  });

  it("does NOT treat a lookalike host as telemetry", () => {
    // Suffix matching must not be substring matching: an attacker-controlled
    // `google-analytics.com.evil.test` is not Google.
    expect(decide(facts({ url: "https://google-analytics.com.evil.test/collect" }), CTX).hold).toBe(true);
    expect(decide(facts({ url: "https://notsentry.io/api" }), CTX).hold).toBe(true);
  });

  it("passes a parser-initiated or preload request", () => {
    for (const initiatorType of ["parser", "preload", "other", "SignedExchange"]) {
      expect(decide(facts({ initiatorType }), CTX).hold, initiatorType).toBe(false);
    }
  });

  it("passes a request from a different frame than the action", () => {
    expect(decide(facts({ frameId: "FRAME-B" }), CTX).hold).toBe(false);
  });

  it("passes an endpoint that was already firing before any agent action", () => {
    // Autosave, heartbeat, session ping. If it was happening anyway, the click
    // did not cause it.
    const ctx: BackstopContext = {
      ...CTX,
      backgroundEndpoints: new Set([endpointKey("PUT", `${ORIGIN}/api/draft`)]),
    };
    expect(decide(facts({ method: "PUT", url: `${ORIGIN}/api/draft?id=9` }), ctx).hold).toBe(false);
    // …but a different endpoint on the same origin still holds.
    expect(decide(facts({ method: "PUT", url: `${ORIGIN}/api/orders` }), ctx).hold).toBe(true);
  });

  it("keys the background set on method+origin+path, ignoring the query", () => {
    expect(endpointKey("put", `${ORIGIN}/api/draft?id=1&t=2`)).toBe(`PUT ${ORIGIN}/api/draft`);
  });
});

describe("backstop — GraphQL", () => {
  const gql = (body: unknown): BackstopRequestFacts =>
    facts({ url: `${ORIGIN}/graphql`, postData: typeof body === "string" ? body : JSON.stringify(body) });

  it("passes a query operation", () => {
    expect(decide(gql({ query: "query Cart { cart { id } }" }), CTX).hold).toBe(false);
    expect(decide(gql({ query: "{ cart { id } }" }), CTX).hold).toBe(false);
    expect(decide(gql({ query: "  \n# comment\n query { me { id } }" }), CTX).hold).toBe(false);
  });

  it("holds a mutation", () => {
    expect(decide(gql({ query: "mutation PlaceOrder { placeOrder { id } }" }), CTX).hold).toBe(true);
    expect(decide(gql({ query: "\n\n  mutation { deleteAll }" }), CTX).hold).toBe(true);
  });

  it("holds a mutation hidden behind leading fragments", () => {
    const body = { query: "fragment F on Cart { id }\nmutation M { checkout { ...F } }" };
    expect(decide(gql(body), CTX).hold).toBe(true);
  });

  it("holds a batch where ANY member mutates", () => {
    const batch = [{ query: "query A { a }" }, { query: "mutation B { b }" }];
    expect(decide(gql(batch), CTX).hold).toBe(true);
  });

  it("passes a batch where every member is a query", () => {
    expect(decide(gql([{ query: "query A { a }" }, { query: "{ b }" }]), CTX).hold).toBe(false);
  });

  it("holds a persisted query — the hash hides the effect", () => {
    const body = { extensions: { persistedQuery: { version: 1, sha256Hash: "abc123" } }, variables: {} };
    expect(decide(gql(body), CTX)).toMatchObject({ hold: true });
    expect(decide(gql(body), CTX).why).toContain("persisted");
  });

  it("holds an unparseable body", () => {
    expect(decide(gql("not json at all"), CTX).hold).toBe(true);
    expect(decide(facts({ url: `${ORIGIN}/graphql` }), CTX).hold).toBe(true); // no body
    expect(decide(gql({ query: 42 }), CTX).hold).toBe(true);
  });

  it("treats a subscription as a mutation — it opens a stream, not a read", () => {
    expect(decide(gql({ query: "subscription S { orderUpdates { id } }" }), CTX).hold).toBe(true);
  });

  it("only applies the GraphQL rule to GraphQL-shaped URLs", () => {
    expect(classifyGraphql(`${ORIGIN}/api/orders`, '{"query":"query X { y }"}')).toBe("not-graphql");
    expect(classifyGraphql(`${ORIGIN}/gql`, '{"query":"query X { y }"}')).toBe("query");
    expect(classifyGraphql(`${ORIGIN}/api/graph`, '{"query":"mutation X { y }"}')).toBe("mutation");
  });

  it("a GraphQL query still passes even though the method is POST", () => {
    // This is the whole point: every GraphQL request is a POST, so the method
    // cannot decide and the body must.
    const d = decide(gql({ query: "query { me { id } }" }), CTX);
    expect(d.hold).toBe(false);
    expect(d.why).toContain("query");
  });
});

describe("backstop — the host list is data", () => {
  it("is versioned and non-empty", () => {
    expect(TELEMETRY_HOSTS.length).toBeGreaterThan(10);
  });

  it("contains no bare public suffix that would blanket-allow a registrar", () => {
    for (const h of TELEMETRY_HOSTS) {
      expect(h.split("/")[0]!.split(".").length, h).toBeGreaterThanOrEqual(2);
    }
  });

  it("can be overridden per session", () => {
    const ctx: BackstopContext = { ...CTX, telemetryHosts: ["metrics.internal"] };
    expect(decide(facts({ url: "https://metrics.internal/ingest" }), ctx).hold).toBe(false);
    expect(decide(facts({ url: "https://www.google-analytics.com/collect" }), ctx).hold).toBe(true);
  });
});

describe("backstop — unparseable input is never a pass", () => {
  it("holds a request whose URL cannot be parsed", () => {
    expect(decide(facts({ url: "http://[bad" }), CTX).hold).toBe(true);
  });
});
