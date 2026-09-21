/**
 * Action executor — dispatches trusted input events via CDP.
 * All input goes through CDP Input domain → events are isTrusted=true.
 */

import type { CDPHandle, ContextHandle } from "@lattice/engine";
import type { PerceptionEngine, InteractionGraph } from "@lattice/perception";
import { resolveTarget } from "./resolver.js";
import { pointerPointFor } from "./pointer-target.js";
import { waitNetworkIdle, waitMutationQuiescence, waitNavigationComplete } from "./settling.js";
import { ActionError } from "./types.js";
import type { ActionCommand, ActionResult, ActionTarget, WaitCondition } from "./types.js";

interface EvaluateResult<T> {
  result: { value: T };
}

interface ResolveNodeResult {
  object?: { objectId?: string };
}

interface CallFunctionOnResult {
  result?: { value?: unknown };
  exceptionDetails?: { exception?: { description?: string } };
}

export class ActionExecutor {
  constructor(
    private readonly cdp: CDPHandle,
    private readonly ctx: ContextHandle,
    private readonly perception: PerceptionEngine,
  ) {}

  async execute(command: ActionCommand): Promise<ActionResult> {
    const prevSnap = await this.perception.snapshot("L1") as InteractionGraph;

    await this.dispatch(command);

    // Engine-owned settling — no sleep() in caller
    await waitMutationQuiescence(this.cdp);

    const nextSnap = await this.perception.snapshot("L1") as InteractionGraph;
    const delta = this.perception.delta(prevSnap, nextSnap);

    let extracted: unknown;
    if (command.type === "extract") {
      extracted = await this.extractQuery(command.query);
    }

    return {
      success: true,
      delta,
      url: this.ctx.currentUrl(),
      ...(extracted !== undefined ? { extracted } : {}),
    };
  }

  private async dispatch(command: ActionCommand): Promise<void> {
    switch (command.type) {
      case "navigate": {
        await this.ctx.navigate(command.url);
        await waitNetworkIdle(this.cdp);
        return;
      }

      case "act": {
        await this.clickNode(command.target, "act");
        return;
      }

      case "fill": {
        // Focus via a verified click, then clear and type.
        await this.clickNode(command.target, "fill");
        await this.clearField();
        await this.typeText(command.value);
        return;
      }

      case "select": {
        const target = await resolveTarget(this.cdp, command.target.nodeId);
        if (target.disabled) throw new ActionError("disabled");
        // Acts on the RESOLVED node. The previous version scanned every <select>
        // on the page and set the first one carrying a matching option, so it
        // could change a control the caller never named.
        const ok = await this.callOnNode<boolean>(
          target.backendDOMNodeId,
          `function (wanted) {
            if (!(this instanceof HTMLSelectElement)) return false;
            const opt = Array.from(this.options).find((o) => o.value === wanted || o.text === wanted);
            if (!opt) return false;
            this.value = opt.value;
            this.dispatchEvent(new Event("input", { bubbles: true }));
            this.dispatchEvent(new Event("change", { bubbles: true }));
            return true;
          }`,
          [command.value],
        );
        if (ok !== true) {
          throw new ActionError(
            "element_not_found",
            "check the option value/text, and that the target is a <select>",
            `select: no option matching ${JSON.stringify(command.value)} on node ${command.target.nodeId}`,
          );
        }
        return;
      }

      case "submit": {
        await this.clickNode(command.target, "submit");
        await waitNetworkIdle(this.cdp, 5000);
        return;
      }

      case "scroll_to": {
        // Previously this read a (possibly off-screen) point and asked
        // elementFromPoint for it — which returns null outside the viewport, so
        // scroll_to silently did nothing. Scroll the node itself.
        const target = await resolveTarget(this.cdp, command.target.nodeId);
        await this.cdp
          .send("DOM.scrollIntoViewIfNeeded", { backendNodeId: target.backendDOMNodeId })
          .catch(async () => {
            await this.callOnNode(
              target.backendDOMNodeId,
              `function () { this.scrollIntoView({ behavior: "instant", block: "center" }); return true; }`,
            );
          });
        return;
      }

      case "wait_for": {
        await this.settle(command.condition);
        return;
      }

      case "extract": {
        // extraction happens after dispatch in execute()
        return;
      }

      case "set":
      case "upload":
      case "download": {
        throw new ActionError("prohibited", undefined, `${command.type} not implemented in P0`);
      }
    }
  }

  /**
   * The only place a pointer event is dispatched. Resolves identity, then asks
   * `pointerPointFor` for a point that has just been proven to hit this node —
   * it scrolls, re-reads geometry and hit-tests. If it cannot prove the hit it
   * throws, so no click is ever sent "somewhere".
   */
  private async clickNode(target: ActionTarget, what: string): Promise<void> {
    const resolved = await resolveTarget(this.cdp, target.nodeId);
    if (resolved.disabled) {
      throw new ActionError(
        "disabled",
        "re-perceive to confirm state",
        `${what}: node ${target.nodeId} is disabled`,
      );
    }
    const point = await pointerPointFor(this.cdp, resolved.backendDOMNodeId, String(target.nodeId));
    await this.click(point.x, point.y);
  }

  private async click(x: number, y: number): Promise<void> {
    // CDP Input.dispatchMouseEvent produces isTrusted=true events
    await this.cdp.send("Input.dispatchMouseEvent", {
      type: "mouseMoved", x, y, button: "none", clickCount: 0,
    });
    await this.cdp.send("Input.dispatchMouseEvent", {
      type: "mousePressed", x, y, button: "left", clickCount: 1,
    });
    await this.cdp.send("Input.dispatchMouseEvent", {
      type: "mouseReleased", x, y, button: "left", clickCount: 1,
    });
  }

  /** Runs `fn` with `this` bound to the resolved DOM node. */
  private async callOnNode<T>(
    backendNodeId: number,
    fn: string,
    args: readonly unknown[] = [],
  ): Promise<T | undefined> {
    const resolved = await this.cdp.send<ResolveNodeResult>("DOM.resolveNode", { backendNodeId });
    const objectId = resolved.object?.objectId;
    if (!objectId) return undefined;
    const out = await this.cdp.send<CallFunctionOnResult>("Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: fn,
      arguments: args.map((value) => ({ value })),
      returnByValue: true,
    });
    if (out.exceptionDetails) return undefined;
    return out.result?.value as T;
  }

  private async clearField(): Promise<void> {
    await this.cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "a", modifiers: 2 }); // Ctrl+A
    await this.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "a", modifiers: 2 });
    await this.cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Delete" });
    await this.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Delete" });
  }

  private async typeText(text: string): Promise<void> {
    // Input.insertText is the most reliable for arbitrary text
    await this.cdp.send("Input.insertText", { text });
  }

  private async settle(condition: WaitCondition): Promise<void> {
    switch (condition.kind) {
      case "network_idle":
        await waitNetworkIdle(this.cdp, condition.timeoutMs);
        break;
      case "mutation_quiescence":
        await waitMutationQuiescence(this.cdp, condition.timeoutMs);
        break;
      case "navigation_complete":
        await waitNavigationComplete(this.cdp, condition.timeoutMs);
        break;
    }
  }

  private async extractQuery(query: string): Promise<unknown> {
    const result = await this.cdp.send<EvaluateResult<unknown>>("Runtime.evaluate", {
      expression: buildExtractExpression(query),
      returnByValue: true,
    });
    return result.result.value;
  }
}

/**
 * Build the in-page expression for an `extract` query. Supports declarative
 * selectors ONLY — `text:`/`attr:`/`value:`. A non-selector query returns null;
 * it is NOT evaluated as JavaScript.
 *
 * SECURITY (audit, escape-hatch): the previous default branch ran `eval(q)`
 * in-page, which gave the agent arbitrary JS = a full kernel bypass (egress,
 * token theft) on the CDP path. The build-on path already makes `extract`
 * read-only; this aligns the CDP path with it. The expression is pure and
 * exported so a test can assert it never contains `eval`.
 */
export function buildExtractExpression(query: string): string {
  return `
        (function() {
          const q = ${JSON.stringify(query)};
          if (q.startsWith('text:')) {
            const sel = q.slice(5).trim();
            return document.querySelector(sel)?.textContent?.trim() ?? null;
          }
          if (q.startsWith('attr:')) {
            const [sel, attr] = q.slice(5).split('@');
            return document.querySelector(sel?.trim() ?? '')?.getAttribute(attr?.trim() ?? '') ?? null;
          }
          if (q.startsWith('value:')) {
            const sel = q.slice(6).trim();
            const el = document.querySelector(sel);
            return el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement
              ? el.value : null;
          }
          // No arbitrary-JS fallback: an unrecognized query yields null.
          return null;
        })()
      `;
}
