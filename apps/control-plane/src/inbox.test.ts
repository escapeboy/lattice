/**
 * ApprovalInbox — enriched approval payloads, approve/deny semantics, and the
 * operator-timeout fallback (paused + audited).
 */

import { describe, it, expect, vi } from "vitest";
import { ApprovalInbox } from "./inbox.js";
import type { ActionDetail, CapabilityRequest } from "@lattice/kernel";

function req(detail?: ActionDetail, payload: unknown = { type: "submit" }): CapabilityRequest {
  return {
    actionType: "submit",
    origin: "https://app.example.com",
    sessionId: "s1",
    payload,
    ...(detail ? { detail } : {}),
  };
}

describe("ApprovalInbox — enriched requests", () => {
  it("maps ActionDetail (+ intent) into the pending request with a why line", async () => {
    const inbox = new ApprovalInbox();
    void inbox.grantHandler(
      req({
        action: "Submit form (2 fields)",
        targetLabel: "Log in",
        intent: "log in",
        fields: [
          { label: "Email", value: "ada@x.com", masked: false },
          { label: "Password", value: "••••", masked: true },
        ],
      }),
    );
    const p = inbox.pendingList()[0]!;
    expect(p.action).toBe("Submit form (2 fields)");
    expect(p.targetLabel).toBe("Log in");
    expect(p.intent).toBe("log in");
    expect(p.why).toBe("consequential — matches requireGrant rule 'submit'");
    expect(p.fields).toEqual([
      { label: "Email", value: "ada@x.com", masked: false },
      { label: "Password", value: "••••", masked: true },
    ]);
    await inbox.approve(p.id);
  });

  it("falls back to the command payload's intent when detail carries none", () => {
    const inbox = new ApprovalInbox();
    void inbox.grantHandler(req(undefined, { type: "submit", intent: "from payload" }));
    expect(inbox.pendingList()[0]!.intent).toBe("from payload");
  });

  it("APPROVE resolves granted (dispatch); DENY resolves a typed refusal (block)", async () => {
    const inbox = new ApprovalInbox();
    const g1 = inbox.grantHandler(req());
    await inbox.approve(inbox.pendingList()[0]!.id);
    await expect(g1).resolves.toMatchObject({ granted: true });

    const g2 = inbox.grantHandler(req());
    await inbox.deny(inbox.pendingList()[0]!.id, "nope");
    await expect(g2).resolves.toEqual({ granted: false, reason: "nope" });
    expect(inbox.pendingList()).toHaveLength(0);
  });
});

describe("ApprovalInbox — operator-timeout fallback", () => {
  it("auto-denies an unanswered request and notifies on change", async () => {
    vi.useFakeTimers();
    try {
      const inbox = new ApprovalInbox({ timeoutMs: 1000 });
      const changeSizes: number[] = [];
      inbox.onChange(() => changeSizes.push(inbox.pendingList().length));

      const g = inbox.grantHandler(req());
      expect(inbox.pendingList()).toHaveLength(1);
      expect(inbox.pendingList()[0]!.expiresAt).toBeGreaterThan(0);

      await vi.advanceTimersByTimeAsync(1000);
      await expect(g).resolves.toEqual({ granted: false, reason: "operator_timeout" });
      expect(inbox.pendingList()).toHaveLength(0);
      expect(changeSizes.at(-1)).toBe(0);
      expect(inbox.decisionHistory().at(-1)).toMatchObject({ outcome: "denied", reason: "operator_timeout" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("no timeout configured → the request holds indefinitely", () => {
    const inbox = new ApprovalInbox();
    void inbox.grantHandler(req());
    expect(inbox.pendingList()[0]!.expiresAt).toBeUndefined();
  });
});
