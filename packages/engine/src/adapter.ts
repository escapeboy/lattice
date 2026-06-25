import {
  chromium,
  type Browser,
  type BrowserContext as PwContext,
  type CDPSession,
  type Page,
} from "playwright-core";
import { randomUUID } from "node:crypto";
import type {
  BrowserContextId,
  CDPHandle,
  ContextHandle,
  EngineAdapter,
  EngineConfig,
  NavigationResult,
} from "./types.js";

class CDPHandleImpl implements CDPHandle {
  constructor(private readonly session: CDPSession) {}

  send<Result = unknown>(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<Result> {
    // Cast through unknown: we expose a generic string-typed API over the
    // strongly-typed playwright Protocol — acceptable at this boundary.
    return (this.session as unknown as { send: (m: string, p?: unknown) => Promise<Result> }).send(
      method,
      params,
    );
  }

  on(event: string, listener: (data: unknown) => void): () => void {
    const typedSession = this.session as unknown as {
      on: (e: string, l: (d: unknown) => void) => void;
      off: (e: string, l: (d: unknown) => void) => void;
    };
    typedSession.on(event, listener);
    return () => typedSession.off(event, listener);
  }
}

class ContextHandleImpl implements ContextHandle {
  readonly id: BrowserContextId;
  private _cdp: CDPHandleImpl;

  constructor(
    private readonly page: Page,
    private readonly pwContext: PwContext,
    cdpSession: CDPSession,
  ) {
    this.id = randomUUID() as unknown as BrowserContextId;
    this._cdp = new CDPHandleImpl(cdpSession);
  }

  async navigate(url: string): Promise<NavigationResult> {
    const response = await this.page.goto(url, { waitUntil: "domcontentloaded" });
    return {
      url: this.page.url(),
      statusCode: response?.status() ?? null,
    };
  }

  currentUrl(): string {
    return this.page.url();
  }

  cdp(): CDPHandle {
    return this._cdp;
  }

  async screenshot(): Promise<string> {
    const { data } = await this._cdp.send<{ data: string }>("Page.captureScreenshot", {
      format: "png",
    });
    return data;
  }

  async close(): Promise<void> {
    await this.pwContext.close();
  }
}

export class PlaywrightEngineAdapter implements EngineAdapter {
  private browser: Browser | undefined;

  async launch(config: EngineConfig): Promise<void> {
    this.browser = await chromium.launch({
      headless: config.headless,
      ...(config.executablePath !== undefined ? { executablePath: config.executablePath } : {}),
    });
  }

  async createContext(): Promise<ContextHandle> {
    if (!this.browser) throw new Error("Engine not launched; call launch() first");
    const pwContext = await this.browser.newContext();
    const page = await pwContext.newPage();
    const cdpSession = await pwContext.newCDPSession(page);
    return new ContextHandleImpl(page, pwContext, cdpSession);
  }

  async shutdown(): Promise<void> {
    await this.browser?.close();
    this.browser = undefined;
  }
}
