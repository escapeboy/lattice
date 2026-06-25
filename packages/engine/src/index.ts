/**
 * @lattice/engine — CDP adapter layer.
 *
 * Public API: types + factory functions.
 * Implementation: PlaywrightEngineAdapter (wraps playwright-core).
 */

export type {
  BrowserContextId,
  CDPHandle,
  ContextHandle,
  EngineAdapter,
  EngineConfig,
  NavigationResult,
  TargetId,
} from "./types.js";

export { PlaywrightEngineAdapter } from "./adapter.js";
export { detectChromiumExecutable } from "./executable.js";

import { PlaywrightEngineAdapter } from "./adapter.js";
import type { EngineAdapter } from "./types.js";

export function createEngineAdapter(): EngineAdapter {
  return new PlaywrightEngineAdapter();
}
