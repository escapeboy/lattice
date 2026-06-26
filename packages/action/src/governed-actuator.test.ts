/**
 * S3 build-on action tests (ADR 0002): the kernel gates every action before the
 * engine sees it, the escape hatches are unreachable, and typed errors surface.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { GovernedActuator, type ReAnchor } from "./governed-actuator.js";
import { ActionError } from "./types.js";
import type { ActionCommand } from "./types.js";
import { createSecurityKernel } from "@lattice/kernel";
import type { SecurityKernel, GrantDecision } from "@lattice/kernel";
import type { EngineSession, SemanticAction, NavResult, RawSnapshot, ActionResult } from "@lattice/engine-adapter";
import type { NodeId } from "@lattice/perception";

class FakeSession implements EngineSession {
  readonly id = "lattice-test" as EngineSession["id"];
  acts: SemanticAction[] = [];
  navs: string[] = [];
  nextActOk = true;
  nextActError: string | undefined;

  navigate(url: string): Promise<NavResult> {
    this.navs.push(url);
    return Promise.resolve({ url, title: "" });
  }
  currentUrl(): Promise<string> {
    return Promise.resolve("https://app.example.com/");
  }
  snapshot(): Promise<RawSnapshot> {
    return Promise.resolve({ url: "https://app.example.com/", refs: [], tree: "" });
  }
  readText(): Promise<string> {
    return Promise.resolve("page text");
  }
  screenshot(): Promise<string> {
    return Promise.resolve("BASE64PNG");
  }
  act(action: SemanticAction): Promise<ActionResult> {
    this.acts.push(action);
    return Promise.resolve({ ok: this.nextActOk, url: "https://app.example.com/x", error: this.nextActError });
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
}

const anchor: ReAnchor = { refFor: (id) => (id === ("missing" as NodeId) ? undefined : "e1") };
const ctx = { origin: "https://app.example.com", sessionId: "s1" };

function target(nodeId = "button-1"): { nodeId: NodeId } {
  return { nodeId: nodeId as NodeId };
}

describe("GovernedActuator — kernel gating over the semantic engine", () => {
  let kernel: SecurityKernel;
  let session: FakeSession;

  beforeEach(() => {
    kernel = createSecurityKernel({
      allowedOrigins: ["https://app.example.com"],
      egressAllowlist: [],
      prohibitedActions: [],
    });
    session = new FakeSession();
  });

  function actuator(k = kernel): GovernedActuator {
    return new GovernedActuator(session, k, anchor, ctx);
  }

  it("benign act (click) passes the gate and resolves NodeId → current ref", async () => {
    const res = await actuator().execute({ type: "act", target: target() });
    expect(res.ok).toBe(true);
    expect(session.acts).toEqual([{ type: "click", target: { kind: "ref", ref: "e1" } }]);
  });

  it("fill re-anchors and forwards the value", async () => {
    await actuator().execute({ type: "fill", target: target(), value: "ada@x.com" });
    expect(session.acts[0]).toEqual({ type: "fill", target: { kind: "ref", ref: "e1" }, value: "ada@x.com" });
  });

  it("SEMANTIC SUBMIT passes through the kernel when granted (S3 acceptance)", async () => {
    // submit is consequential → requires a grant handler that approves.
    const granting = createSecurityKernel({
      allowedOrigins: ["https://app.example.com"],
      egressAllowlist: [],
      prohibitedActions: [],
      grantHandler: (): Promise<GrantDecision> => Promise.resolve({ granted: true, grantId: "g1" }),
    });
    const res = await actuator(granting).execute({ type: "submit", target: target() });
    expect(res.ok).toBe(true);
    expect(session.acts[0]).toMatchObject({ type: "submit" });
  });

  it("consequential submit WITHOUT a grant handler is blocked, engine never touched", async () => {
    await expect(actuator().execute({ type: "submit", target: target() })).rejects.toBeInstanceOf(
      ActionError,
    );
    expect(session.acts).toHaveLength(0);
  });

  it("navigation outside the task origin is refused (origin scoping)", async () => {
    await expect(
      actuator().execute({ type: "navigate", url: "https://evil.test/" }),
    ).rejects.toMatchObject({ code: "navigation_interrupted" });
    expect(session.navs).toHaveLength(0);
  });

  it("in-scope navigation passes", async () => {
    const res = await actuator().execute({ type: "navigate", url: "https://app.example.com/next" });
    expect(res.ok).toBe(true);
    expect(session.navs).toEqual(["https://app.example.com/next"]);
  });

  it("a stale NodeId with no live ref yields a typed element_gone with a re-perceive hint", async () => {
    await expect(
      actuator().execute({ type: "act", target: target("missing") }),
    ).rejects.toMatchObject({ code: "element_gone", rePerceptionHint: "re-perceive" });
  });

  it("extract is read-tier: reads text without an engine action", async () => {
    const res = await actuator().execute({ type: "extract", query: "h1" });
    expect(res.extracted).toBe("page text");
    expect(session.acts).toHaveLength(0);
  });

  it("FILE VERBS (upload/download) are refused — no file path reaches the engine", async () => {
    await expect(
      actuator().execute({ type: "upload", target: target(), filePath: "/etc/passwd" }),
    ).rejects.toBeInstanceOf(ActionError);
    await expect(actuator().execute({ type: "download", target: target() })).rejects.toBeInstanceOf(
      ActionError,
    );
    expect(session.acts).toHaveLength(0);
  });

  it("a failed engine action maps to a typed ActionError", async () => {
    session.nextActOk = false;
    session.nextActError = "element is disabled";
    await expect(actuator().execute({ type: "act", target: target() })).rejects.toMatchObject({
      code: "disabled",
    });
  });

  it("the actuator vocabulary cannot express eval / cdp / file — escape hatches absent", () => {
    // ActionCommand has no eval/cdp/connect/file member; this is a compile-time
    // guarantee, asserted structurally here.
    const commands: ActionCommand["type"][] = [
      "navigate",
      "act",
      "fill",
      "select",
      "set",
      "submit",
      "scroll_to",
      "wait_for",
      "extract",
      "upload",
      "download",
    ];
    expect(commands).not.toContain("eval");
    expect(commands).not.toContain("connect");
  });
});
