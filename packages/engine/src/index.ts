/**
 * @lattice/engine — CDP adapter layer (S0 scaffold; implementation in S1)
 */

export type BrowserContextId = string & { readonly __brand: "BrowserContextId" };
export type TargetId = string & { readonly __brand: "TargetId" };

export interface EngineConfig {
  headless: boolean;
  executablePath?: string;
}

export interface BrowserContext {
  readonly id: BrowserContextId;
  close(): Promise<void>;
}

export interface EngineAdapter {
  launch(config: EngineConfig): Promise<void>;
  createContext(): Promise<BrowserContext>;
  shutdown(): Promise<void>;
}

export function createEngineAdapter(): EngineAdapter {
  throw new Error("Not implemented — see S1");
}
