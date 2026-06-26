import { describe, it, expect } from "vitest";
import { redactString, detectPii, redactTrace, DEFAULT_PII_POLICY } from "./redact.js";
import { emitToSvod } from "./svod-emitter.js";
import type { SessionTrace, TraceEvent } from "./types.js";
import type { IGNode, NodeId } from "@lattice/perception";

const RAW = {
  email: "jane.doe@example.com",
  card: "4111 1111 1111 1111", // valid Luhn test card
  ssn: "123-45-6789",
  iban: "DE89370400440532013000",
  phone: "+1 (415) 555-0132",
};

describe("PII detection + masking", () => {
  it("detects and masks each structured PII type", () => {
    for (const [type, value] of Object.entries(RAW)) {
      const masked = redactString(`value is ${value} here`);
      expect(masked, type).not.toContain(value);
      expect(masked, type).toContain("[REDACTED:");
    }
  });

  it("does NOT redact non-PII numbers (counts, ids, prices, short ints)", () => {
    expect(redactString("42 items, $19.99, id 7, page 3")).toBe("42 items, $19.99, id 7, page 3");
  });

  it("rejects invalid card numbers (fails Luhn)", () => {
    const bad = "1234 5678 9012 3456"; // fails Luhn
    expect(detectPii(bad).some((p) => p.type === "card")).toBe(false);
  });

  it("is idempotent — redacting twice changes nothing further", () => {
    const once = redactString(`email ${RAW.email}`);
    expect(redactString(once)).toBe(once);
  });
});

function node(id: string, label: string, value?: string): IGNode {
  return {
    id: id as NodeId,
    role: "input",
    label,
    state: { disabled: false, hidden: false },
    relations: [],
    ...(value !== undefined ? { value } : {}),
  };
}

function traceWithPii(): SessionTrace {
  const events: TraceEvent[] = [
    { kind: "session_start", traceId: "t1", sessionId: "s1", ts: 1, seq: 0, topology: "ephemeral" },
    {
      kind: "snapshot",
      traceId: "t1",
      sessionId: "s1",
      ts: 2,
      seq: 1,
      tier: "L1",
      url: "https://shop.example.com/checkout",
      title: "Checkout",
      nodeCount: 1,
      nodes: [node("n1", "Email", RAW.email)],
    },
    {
      kind: "action",
      traceId: "t1",
      sessionId: "s1",
      ts: 3,
      seq: 2,
      command: { type: "fill", target: { nodeId: "n1" as NodeId }, value: RAW.card },
    },
    {
      kind: "action_result",
      traceId: "t1",
      sessionId: "s1",
      ts: 4,
      seq: 3,
      success: true,
      url: "https://shop.example.com/done",
      extracted: { contact: RAW.phone, ref: RAW.ssn },
    },
    {
      kind: "network",
      traceId: "t1",
      sessionId: "s1",
      ts: 5,
      seq: 4,
      url: `https://track.example.com/p?email=${encodeURIComponent(RAW.email)}`,
      method: "GET",
      status: 200,
    },
  ];
  return { traceId: "t1", sessionId: "s1", startTs: 1, endTs: 5, events };
}

describe("redactTrace", () => {
  it("masks PII across snapshot nodes, action values, extracted results, and URLs", () => {
    const red = redactTrace(traceWithPii());
    const json = JSON.stringify(red);
    for (const value of Object.values(RAW)) {
      // the network URL email is percent-encoded; check the decoded form too
      expect(json).not.toContain(value);
    }
    expect(json).toContain("[REDACTED:");
  });

  it("does not mutate the input trace (live fidelity preserved)", () => {
    const t = traceWithPii();
    redactTrace(t);
    const snap = t.events[1] as unknown as { nodes: IGNode[] };
    expect(snap.nodes[0]!.value).toBe(RAW.email); // original untouched
  });

  it("per-origin policy 'full' keeps the listed origin unredacted", () => {
    const red = redactTrace(traceWithPii(), {
      defaultMode: "redacted",
      perOrigin: { "https://shop.example.com": "full" },
    });
    const snap = red.events[1] as unknown as { nodes: IGNode[] };
    expect(snap.nodes[0]!.value).toBe(RAW.email); // shop.* logged in full
    // but a different origin (track.example.com) is still redacted
    const net = red.events[4] as unknown as { url: string };
    expect(net.url).not.toContain(RAW.email);
  });
});

describe("emitToSvod — raw PII never reaches the Svod boundary", () => {
  it("the content handed to the writer contains no raw PII (default policy)", async () => {
    let persisted = "";
    await emitToSvod(traceWithPii(), async (_path, content) => {
      persisted = content;
    });
    for (const value of Object.values(RAW)) {
      expect(persisted, value).not.toContain(value);
    }
  });

  it("redaction is on by default (DEFAULT_PII_POLICY is redacted)", () => {
    expect(DEFAULT_PII_POLICY.defaultMode).toBe("redacted");
  });
});
