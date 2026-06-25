/**
 * Engine-owned settling — waits for the page to stabilize after an action.
 * No sleep() in the agent. The engine polls CDP events directly.
 */

import type { CDPHandle } from "@lattice/engine";

interface NetworkEvent {
  requestId: string;
}

export async function waitNetworkIdle(
  cdp: CDPHandle,
  timeoutMs = 5000,
  idleThresholdMs = 500,
): Promise<void> {
  await cdp.send("Network.enable", {});

  return new Promise((resolve, reject) => {
    const pending = new Set<string>();
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const deadline = setTimeout(() => {
      cleanup();
      resolve(); // treat timeout as "idle enough"
    }, timeoutMs);

    function resetIdle() {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        cleanup();
        resolve();
      }, idleThresholdMs);
    }

    function cleanup() {
      clearTimeout(deadline);
      clearTimeout(idleTimer);
      offRequest();
      offFinished();
      offFailed();
    }

    const offRequest = cdp.on("Network.requestWillBeSent", (data) => {
      const ev = data as NetworkEvent;
      pending.add(ev.requestId);
      clearTimeout(idleTimer);
    });

    const offFinished = cdp.on("Network.loadingFinished", (data) => {
      const ev = data as NetworkEvent;
      pending.delete(ev.requestId);
      if (pending.size === 0) resetIdle();
    });

    const offFailed = cdp.on("Network.loadingFailed", (data) => {
      const ev = data as NetworkEvent;
      pending.delete(ev.requestId);
      if (pending.size === 0) resetIdle();
    });

    // If already idle, start the idle timer immediately
    resetIdle();

    void reject; // suppress unused warning — reject path is via timeout only
  });
}

export async function waitMutationQuiescence(
  cdp: CDPHandle,
  timeoutMs = 3000,
  quietMs = 200,
): Promise<void> {
  // Use DOM.setChildNodes events as a proxy for mutation activity.
  // A more precise version would use a MutationObserver injected via Runtime.evaluate.
  await cdp.send("Runtime.evaluate", {
    expression: `
      window.__latticeQuiescence = new Promise((resolve) => {
        let t;
        const obs = new MutationObserver(() => {
          clearTimeout(t);
          t = setTimeout(() => { obs.disconnect(); resolve(); }, ${quietMs});
        });
        obs.observe(document.body || document.documentElement, {
          subtree: true, childList: true, attributes: true, characterData: true
        });
        // Resolve immediately if no mutations within quiet period
        t = setTimeout(() => { obs.disconnect(); resolve(); }, ${quietMs});
      });
    `,
    awaitPromise: false,
  });

  await cdp.send<{ result: { value: boolean } }>("Runtime.evaluate", {
    expression: "window.__latticeQuiescence",
    awaitPromise: true,
    timeout: timeoutMs,
  }).catch(() => { /* treat timeout as quiescent */ });
}

export async function waitNavigationComplete(
  cdp: CDPHandle,
  timeoutMs = 10000,
): Promise<void> {
  return new Promise((resolve) => {
    const deadline = setTimeout(() => {
      off();
      resolve();
    }, timeoutMs);

    const off = cdp.on("Page.loadEventFired", () => {
      clearTimeout(deadline);
      off();
      resolve();
    });
  });
}
