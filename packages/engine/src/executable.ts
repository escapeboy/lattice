import { accessSync } from "node:fs";

const CANDIDATES = [
  process.env["CHROME_EXECUTABLE"],
  // macOS
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  // Linux
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium-browser",
  "/usr/bin/chromium",
  // Docker / CI
  "/usr/bin/google-chrome-unstable",
];

export function detectChromiumExecutable(): string | undefined {
  for (const path of CANDIDATES) {
    if (!path) continue;
    try {
      accessSync(path);
      return path;
    } catch {
      // not accessible
    }
  }
  return undefined;
}
