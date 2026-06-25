/**
 * Engine layer public types — consumed by perception, action, runtime, kernel.
 */

export type BrowserContextId = string & { readonly __brand: "BrowserContextId" };
export type TargetId = string & { readonly __brand: "TargetId" };

export interface EngineConfig {
  headless: boolean;
  executablePath?: string;
}

export interface NavigationResult {
  url: string;
  /** HTTP status code, or null when no response (e.g. about:blank, data:). */
  statusCode: number | null;
}

/**
 * Thin wrapper over a CDP session for the given page.
 * Typed loosely so perception/action can send any CDP command
 * without importing playwright-core's Protocol types directly.
 */
export interface CDPHandle {
  send<Result = unknown>(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<Result>;
  on(event: string, listener: (data: unknown) => void): () => void;
}

/**
 * An isolated browsing context: own cookies, storage, cache.
 * One page per context for the P0 prototype.
 */
export interface ContextHandle {
  readonly id: BrowserContextId;
  navigate(url: string): Promise<NavigationResult>;
  currentUrl(): string;
  /** CDP session for the context's active page (ready after createContext resolves). */
  cdp(): CDPHandle;
  /** Capture a viewport screenshot of the active page as base64-encoded PNG. */
  screenshot(): Promise<string>;
  close(): Promise<void>;
}

export interface EngineAdapter {
  launch(config: EngineConfig): Promise<void>;
  createContext(): Promise<ContextHandle>;
  shutdown(): Promise<void>;
}
