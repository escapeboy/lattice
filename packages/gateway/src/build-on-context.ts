/**
 * BuildOnContext (ADR 0002, S6 serve flip): a ContextHandle shim so a build-on
 * GatewaySession satisfies the shape server.ts consumes, WITHOUT exposing a CDP
 * handle.
 *
 * The only CDP use in server.ts is the capability_check WebMCP probe
 * (Runtime.evaluate). Build-on cannot eval (firewalled), so `cdp().send` rejects
 * and the probe degrades to "no WebMCP" → semantic fallback, which is the
 * correct behaviour (architecture §5), not a regression. currentUrl is cached
 * synchronously (the ContextHandle contract is sync); screenshot delegates to
 * the engine's own artifact.
 */

import { randomUUID } from "node:crypto";
import type { BrowserContextId, CDPHandle, ContextHandle, NavigationResult } from "@lattice/engine";
import type { EngineSession } from "@lattice/engine-adapter";

/** A CDP handle that refuses every call — build-on has no raw-CDP surface. */
const FIREWALLED_CDP: CDPHandle = {
  send: () =>
    Promise.reject(new Error("raw CDP is firewalled on the build-on engine (ADR 0002 §3)")),
  on: () => () => undefined,
};

export class BuildOnContext implements ContextHandle {
  readonly id: BrowserContextId;
  private cachedUrl = "";

  constructor(private readonly engine: EngineSession) {
    this.id = randomUUID() as unknown as BrowserContextId;
  }

  async navigate(url: string): Promise<NavigationResult> {
    const res = await this.engine.navigate(url);
    this.cachedUrl = res.url;
    return { url: res.url, statusCode: null };
  }

  /** Sync per the ContextHandle contract — returns the last known url. */
  currentUrl(): string {
    return this.cachedUrl;
  }

  /** Keep the cached url in sync after a perceive/act reports the landed url. */
  setUrl(url: string): void {
    if (url) this.cachedUrl = url;
  }

  cdp(): CDPHandle {
    return FIREWALLED_CDP;
  }

  screenshot(): Promise<string> {
    return this.engine.screenshot();
  }

  async close(): Promise<void> {
    await this.engine.close();
  }
}
