/**
 * Device profiles + CDP emulation application.
 */

import type { CDPHandle } from "@lattice/engine";
import type { DeviceProfile } from "./types.js";

/** Pixel 8 class handset — the S9 target (390×844, DPR3, touch, mobile UA). */
export const MOBILE_PROFILE: DeviceProfile = {
  label: "mobile-390",
  width: 390,
  height: 844,
  deviceScaleFactor: 3,
  mobile: true,
  userAgent:
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36",
  maxTouchPoints: 5,
};

/** Desktop baseline for breakpoint contrast. */
export const DESKTOP_PROFILE: DeviceProfile = {
  label: "desktop-1280",
  width: 1280,
  height: 800,
  deviceScaleFactor: 1,
  mobile: false,
  userAgent:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  maxTouchPoints: 0,
};

/**
 * Apply a device profile to a page's CDP session via the Emulation domain.
 * Caller must (re)navigate afterwards so media queries re-evaluate cleanly.
 */
export async function applyProfile(cdp: CDPHandle, profile: DeviceProfile): Promise<void> {
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: profile.width,
    height: profile.height,
    deviceScaleFactor: profile.deviceScaleFactor,
    mobile: profile.mobile,
    screenWidth: profile.width,
    screenHeight: profile.height,
  });
  await cdp.send("Emulation.setUserAgentOverride", {
    userAgent: profile.userAgent,
    userAgentMetadata: {
      mobile: profile.mobile,
      platform: profile.mobile ? "Android" : "macOS",
      platformVersion: profile.mobile ? "14" : "10.15.7",
      architecture: profile.mobile ? "" : "x86",
      model: profile.mobile ? "Pixel 8" : "",
    },
  });
  await cdp.send("Emulation.setTouchEmulationEnabled", {
    enabled: profile.mobile,
    // CDP requires maxTouchPoints in [1,16]; only meaningful when enabled.
    ...(profile.mobile ? { maxTouchPoints: profile.maxTouchPoints } : {}),
  });
}
