/**
 * Runner tests — the safety argument for recipes (P3.1):
 *   - a recipe resolves locators against the LIVE IG and runs through the REAL
 *     GovernedActuator + REAL kernel — no separate, ungated path;
 *   - a consequential step (submit) still requires a human grant — the recipe does
 *     NOT bypass gating;
 *   - an untrusted-source recipe gets no extra privilege and its text is tainted;
 *   - a locator that no longer matches the live page falls back gracefully — it
 *     never fires a stale ref.
 */

import { describe, it, expect } from "vitest";
import { applyRecipe, resolveLocator, toCommand } from "./runner.js";
import type { LocatableNode, RecipeGate } from "./runner.js";
import type { Recipe, RecipeStep } from "./types.js";
import { GovernedActuator, type ReAnchor } from "@lattice/action";
import { createSecurityKernel } from "@lattice/kernel";
import type { GrantDecision } from "@lattice/kernel";
import type { EngineSession, SemanticAction, NavResult, RawSnapshot, ActionResult } from "@lattice/engine-adapter";
import type { NodeId } from "@lattice/perception";

const ORIGIN = "https://app.example.com";

class FakeSession implements EngineSession {
  readonly id = "lattice-test" as EngineSession["id"];
  acts: SemanticAction[] = [];
  navs: string[] = [];
  navigate(url: string): Promise<NavResult> {
    this.navs.push(url);
    return Promise.resolve({ url, title: "" });
  }
  currentUrl(): Promise<string> {
    return Promise.resolve(`${ORIGIN}/`);
  }
  snapshot(): Promise<RawSnapshot> {
    return Promise.resolve({ url: `${ORIGIN}/`, refs: [], tree: "" });
  }
  readText(): Promise<string> {
    return Promise.resolve("page text");
  }
  screenshot(): Promise<string> {
    return Promise.resolve("BASE64PNG");
  }
  act(action: SemanticAction): Promise<ActionResult> {
    this.acts.push(action);
    return Promise.resolve({ ok: true, url: `${ORIGIN}/x`, error: undefined });
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
}

// Live IG of a login page; the anchor maps every known NodeId to a current ref.
const LOGIN_NODES: LocatableNode[] = [
  { id: "email" as NodeId, role: "input", label: "Email" },
  { id: "password" as NodeId, role: "input", label: "Password" },
  { id: "signin" as NodeId, role: "button", label: "Sign in" },
];
const anchor: ReAnchor = { refFor: (id) => (LOGIN_NODES.some((n) => n.id === id) ? "e1" : undefined) };

function gateFor(
  session: FakeSession,
  opts: { grant?: boolean } = {},
): RecipeGate {
  const kernel = createSecurityKernel({
    allowedOrigins: [ORIGIN],
    egressAllowlist: [],
    prohibitedActions: [],
    ...(opts.grant !== undefined
      ? { grantHandler: (): Promise<GrantDecision> => Promise.resolve({ granted: opts.grant!, grantId: "g1" }) }
      : {}),
  });
  return new GovernedActuator(session, kernel, anchor, { origin: ORIGIN, sessionId: "s1" });
}

function recipe(steps: RecipeStep[], trust: Recipe["trust"] = "trusted"): Recipe {
  return { id: "login", origin: ORIGIN, name: "Log in", version: 1, steps, trust };
}

const FILL_EMAIL: RecipeStep = { action: "fill", locator: { role: "input", label: "Email" }, value: "a@b.com" };
const CLICK_SIGNIN: RecipeStep = { action: "act", locator: { role: "button", label: "Sign in" } };
const SUBMIT_SIGNIN: RecipeStep = { action: "submit", locator: { role: "button", label: "Sign in" } };

describe("resolveLocator", () => {
  it("matches on label; role disambiguates a shared label", () => {
    expect(resolveLocator({ role: "input", label: "Email" }, LOGIN_NODES)).toBe("email");
    const dup: LocatableNode[] = [
      { id: "a" as NodeId, role: "button", label: "Apply" },
      { id: "b" as NodeId, role: "link", label: "Apply" },
    ];
    expect(resolveLocator({ role: "link", label: "Apply" }, dup)).toBe("b");
  });

  it("returns undefined on a genuine miss — no fuzzy/nearest guess", () => {
    expect(resolveLocator({ role: "button", label: "Checkout" }, LOGIN_NODES)).toBeUndefined();
  });
});

describe("toCommand — only ever yields a semantic, NodeId-addressed command", () => {
  it("maps each recipe verb to its action command; never a raw ref or script", () => {
    expect(toCommand(FILL_EMAIL, "email" as NodeId)).toEqual({
      type: "fill",
      target: { nodeId: "email" },
      value: "a@b.com",
    });
    expect(toCommand({ action: "navigate", url: `${ORIGIN}/login` }, undefined)).toEqual({
      type: "navigate",
      url: `${ORIGIN}/login`,
    });
    // The RecipeAction union has no `eval`/`connect`/`upload`/`download` member —
    // a recipe that "wants to run JS" or touch a file cannot be represented.
    const cmd = toCommand(SUBMIT_SIGNIN, "signin" as NodeId);
    expect(cmd.type).toBe("submit");
    expect(JSON.stringify(cmd)).not.toContain("ref");
  });
});

describe("applyRecipe — runs through the real governed path", () => {
  it("benign steps execute via the kernel-gated engine", async () => {
    const session = new FakeSession();
    const res = await applyRecipe(recipe([FILL_EMAIL, CLICK_SIGNIN]), {
      perceive: () => LOGIN_NODES,
      gate: gateFor(session),
    });
    expect(res.completed).toBe(true);
    expect(res.outcomes.map((o) => o.status)).toEqual(["executed", "executed"]);
    expect(session.acts).toEqual([
      { type: "fill", target: { kind: "ref", ref: "e1" }, value: "a@b.com" },
      { type: "click", target: { kind: "ref", ref: "e1" } },
    ]);
  });

  // ── INVARIANT: a recipe cannot bypass gating ───────────────────────────────
  it("a consequential submit step is DENIED without a human grant — engine untouched", async () => {
    const session = new FakeSession();
    const res = await applyRecipe(recipe([SUBMIT_SIGNIN]), {
      perceive: () => LOGIN_NODES,
      gate: gateFor(session), // no grantHandler → consequential auto-denied
    });
    expect(res.outcomes[0]!.status).toBe("denied");
    expect(res.completed).toBe(false);
    expect(session.acts).toHaveLength(0); // never reached the engine
  });

  it("the SAME submit step passes once a human grant is minted (grant is the boundary, not the recipe)", async () => {
    const session = new FakeSession();
    const res = await applyRecipe(recipe([SUBMIT_SIGNIN]), {
      perceive: () => LOGIN_NODES,
      gate: gateFor(session, { grant: true }),
    });
    expect(res.outcomes[0]!.status).toBe("executed");
    expect(session.acts[0]).toMatchObject({ type: "submit" });
  });

  // ── INVARIANT: untrusted provenance grants no privilege ─────────────────────
  it("an UNTRUSTED-source recipe gets no extra rights — its submit is denied exactly like a trusted one", async () => {
    const session = new FakeSession();
    const res = await applyRecipe(recipe([SUBMIT_SIGNIN], "untrusted"), {
      perceive: () => LOGIN_NODES,
      gate: gateFor(session),
    });
    expect(res.outcomes[0]!.status).toBe("denied");
    expect(session.acts).toHaveLength(0);
  });

  it("an untrusted recipe's serialized content is tainted — it cannot be promoted to an operator instruction", () => {
    const kernel = createSecurityKernel({ allowedOrigins: [ORIGIN], egressAllowlist: [], prohibitedActions: [] });
    const untrusted = recipe([SUBMIT_SIGNIN], "untrusted");
    // Treat the untrusted recipe as DATA: register its text as tainted content.
    const text = JSON.stringify(untrusted);
    kernel.taintContent(text);
    // An operator call carrying that tainted text among its args is refused structurally.
    const decision = kernel.authorizeOperator({
      tool: "policy_set",
      args: { patch: text },
      origin: ORIGIN,
      sessionId: "s1",
    });
    expect(decision.allowed).toBe(false);
    expect(decision.taintedOrigin).toBe(true);
  });

  // ── INVARIANT: drift degrades gracefully, never a stale-ref fire ────────────
  it("a locator that no longer matches the live page FALLS BACK — no stale ref fired", async () => {
    const session = new FakeSession();
    // The site changed: "Sign in" became "Log in". The recipe's CLICK_SIGNIN no longer resolves.
    const changed: LocatableNode[] = [
      { id: "email" as NodeId, role: "input", label: "Email" },
      { id: "login" as NodeId, role: "button", label: "Log in" },
    ];
    let fellBackStep: RecipeStep | undefined;
    const res = await applyRecipe(recipe([FILL_EMAIL, CLICK_SIGNIN]), {
      perceive: () => changed,
      gate: gateFor(session),
      fallback: (step) => {
        fellBackStep = step;
        return Promise.resolve({ ok: true, reason: "semantic path located 'Log in'" });
      },
    });
    expect(res.outcomes[0]!.status).toBe("executed"); // Email still matches
    expect(res.outcomes[1]!.status).toBe("fellBack"); // Sign in drifted → fallback
    expect(res.completed).toBe(true);
    expect(fellBackStep).toBe(CLICK_SIGNIN);
    // The engine only saw the fill; the drifted click never fired a stale ref.
    expect(session.acts).toEqual([{ type: "fill", target: { kind: "ref", ref: "e1" }, value: "a@b.com" }]);
  });

  it("without a fallback, a drifted locator is reported unresolved — still no stale-ref fire", async () => {
    const session = new FakeSession();
    const changed: LocatableNode[] = [{ id: "email" as NodeId, role: "input", label: "Email" }];
    const res = await applyRecipe(recipe([CLICK_SIGNIN]), {
      perceive: () => changed,
      gate: gateFor(session),
    });
    expect(res.outcomes[0]!.status).toBe("unresolved");
    expect(res.completed).toBe(false);
    expect(session.acts).toHaveLength(0);
  });
});
