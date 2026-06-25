/**
 * @lattice/demo — S9 demo agent + mobile responsive sanity check.
 */

export { runResponsiveCheck } from "./sanity-check.js";
export type { ResponsiveCheckResult } from "./sanity-check.js";
export { applyProfile, MOBILE_PROFILE, DESKTOP_PROFILE } from "./profiles.js";
export { RESPONSIVE_NAV_HTML } from "./fixture.js";
export type { BreakpointReport, DeviceProfile, ViewportFinding } from "./types.js";
