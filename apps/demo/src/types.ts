/**
 * S9 demo types — device profile and responsive breakpoint report.
 */

import type { NodeGeometry } from "@lattice/perception";

export interface DeviceProfile {
  readonly label: string;
  readonly width: number;
  readonly height: number;
  readonly deviceScaleFactor: number;
  readonly mobile: boolean;
  readonly userAgent: string;
  readonly maxTouchPoints: number;
}

/** What perception found at a single viewport. */
export interface ViewportFinding {
  readonly profile: string;
  readonly viewport: { readonly width: number; readonly height: number; readonly dpr: number };
  /** Count of inline navigation links present in the L1 Interaction Graph. */
  readonly navLinkCount: number;
  /** A hamburger/menu toggle button is present in the accessibility tree. */
  readonly hamburgerPresent: boolean;
  /** Geometry of the hamburger toggle — fetched at L3 only when one is present. */
  readonly hamburgerGeometry?: NodeGeometry;
  /** Hamburger is rendered with non-zero size inside the viewport. */
  readonly hamburgerVisible: boolean;
  /** Inline links gone AND a visible toggle present → collapsed menu. */
  readonly collapsed: boolean;
}

export interface BreakpointReport {
  readonly url: string;
  readonly query: string;
  readonly mobile: ViewportFinding;
  readonly desktop: ViewportFinding;
  /** True iff collapsed on mobile but not on desktop — a genuine breakpoint. */
  readonly navCollapsesAt390: boolean;
  readonly answer: string;
}
