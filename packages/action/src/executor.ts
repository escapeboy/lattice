/**
 * Action executor — dispatches trusted input events via CDP.
 * All input goes through CDP Input domain → events are isTrusted=true.
 */

import type { CDPHandle, ContextHandle } from "@lattice/engine";
import type { PerceptionEngine, InteractionGraph } from "@lattice/perception";
import { resolveTarget } from "./resolver.js";
import { waitNetworkIdle, waitMutationQuiescence, waitNavigationComplete } from "./settling.js";
import { ActionError } from "./types.js";
import type { ActionCommand, ActionResult, WaitCondition } from "./types.js";

interface EvaluateResult<T> {
  result: { value: T };
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
        const target = await resolveTarget(this.cdp, command.target.nodeId);
        if (target.disabled) {
          throw new ActionError("disabled", `re-perceive to confirm state`, `Node ${command.target.nodeId} is disabled`);
        }
        await this.click(target.x, target.y);
        return;
      }

      case "fill": {
        const target = await resolveTarget(this.cdp, command.target.nodeId);
        if (target.disabled) throw new ActionError("disabled");
        // Focus via click, then clear and type
        await this.click(target.x, target.y);
        await this.clearField();
        await this.typeText(command.value);
        return;
      }

      case "select": {
        const target = await resolveTarget(this.cdp, command.target.nodeId);
        if (target.disabled) throw new ActionError("disabled");
        // Use Runtime.evaluate to set value + dispatch change event (isTrusted not required for select)
        const backendId = target.backendDOMNodeId;
        const result = await this.cdp.send<EvaluateResult<boolean>>("Runtime.evaluate", {
          expression: `
            (function() {
              const el = document.querySelector('[id]');
              // Resolve by backendDOMNodeId via __latticeResolve helper
              const inputs = Array.from(document.querySelectorAll('select'));
              for (const s of inputs) {
                const opt = Array.from(s.options).find(o => o.value === ${JSON.stringify(command.value)} || o.text === ${JSON.stringify(command.value)});
                if (opt) { s.value = opt.value; s.dispatchEvent(new Event('change', { bubbles: true })); return true; }
              }
              return false;
            })()
          `,
          returnByValue: true,
        }).catch(() => ({ result: { value: false } }));
        void backendId;
        if (!result.result.value) {
          throw new ActionError("element_not_found", "check option value/text");
        }
        return;
      }

      case "submit": {
        const target = await resolveTarget(this.cdp, command.target.nodeId);
        if (target.disabled) throw new ActionError("disabled");
        await this.click(target.x, target.y);
        await waitNetworkIdle(this.cdp, 5000);
        return;
      }

      case "scroll_to": {
        const target = await resolveTarget(this.cdp, command.target.nodeId);
        await this.cdp.send("Runtime.evaluate", {
          expression: `document.elementFromPoint(${target.x}, ${target.y})?.scrollIntoView({behavior:'instant',block:'center'})`,
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

  private async click(x: number, y: number): Promise<void> {
    // CDP Input.dispatchMouseEvent produces isTrusted=true events
    await this.cdp.send("Input.dispatchMouseEvent", {
      type: "mousePressed", x, y, button: "left", clickCount: 1,
    });
    await this.cdp.send("Input.dispatchMouseEvent", {
      type: "mouseReleased", x, y, button: "left", clickCount: 1,
    });
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
      expression: `
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
          // Default: evaluate as JS expression
          return eval(q);
        })()
      `,
      returnByValue: true,
    });
    return result.result.value;
  }
}
