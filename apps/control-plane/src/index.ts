/**
 * @lattice/control-plane — Human supervision UI (S8).
 *
 * HTTP + SSE server: intent input, live session theater, approval inbox,
 * policy editor, replay browser. Tauri shell wraps this for desktop (P3).
 */

export { ControlPlaneServer } from "./server.js";
export { ApprovalInbox } from "./inbox.js";
export { PolicyEditor } from "./policy.js";
export { buildUI } from "./ui.js";
export type {
  ApprovalDecision,
  ApprovalOutcome,
  ApprovalRequest,
  PolicyConfig,
  SessionView,
} from "./types.js";
