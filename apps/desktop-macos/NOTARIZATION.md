# Notarizing Lattice.app (operator steps)

The build pipeline produces a **dev-signed** (ad-hoc) `.app` and `.dmg`. Ad-hoc
binaries run on the build machine but are **not notarizable** and will be blocked
by Gatekeeper on other Macs. To ship, re-sign with your **Developer ID** and
notarize. The agent does **not** handle signing certificates or notarization
credentials — these steps are yours.

## What you supply
- A **Developer ID Application** certificate in your login keychain
  (`security find-identity -v -p codesigning` lists it).
- Your **Team ID** (10 chars, e.g. `AB12CD34EF`).
- An App Store Connect credential for `notarytool` — either an **API key**
  (`.p8` + Key ID + Issuer ID) or an **app-specific password** for your Apple ID.

## 1. Build + sign with your identity
```bash
pnpm -w build                                   # backend source (repo root)
cd apps/desktop-macos
./Scripts/make-app.sh release                   # build/Lattice.app (+ embedded backend)
IDENTITY="Developer ID Application: YOUR NAME (TEAMID)" ./Scripts/sign-app.sh
./Scripts/make-dmg.sh                            # build/Lattice.dmg
```
`sign-app.sh` signs inside-out (the embedded `lattice-backend` and the
`agent-browser-darwin-*` engine binaries, then the app) with the hardened runtime
and the JIT entitlements in `Signing/Lattice.entitlements` (bun + Chromium need
JIT). Verify locally:
```bash
codesign --verify --deep --strict --verbose=2 build/Lattice.app
```

## 2. Store the notarization credential once (recommended)
```bash
# API key:
xcrun notarytool store-credentials lattice-notary \
  --key /path/AuthKey_XXXXXX.p8 --key-id <KEY_ID> --issuer <ISSUER_ID>
# …or app-specific password:
xcrun notarytool store-credentials lattice-notary \
  --apple-id you@example.com --team-id TEAMID --password <app-specific-password>
```

## 3. Submit + wait
```bash
xcrun notarytool submit build/Lattice.dmg --keychain-profile lattice-notary --wait
```
On `status: Accepted`, continue. On `Invalid`, pull the log:
```bash
xcrun notarytool log <submission-id> --keychain-profile lattice-notary
```

## 4. Staple + verify
```bash
xcrun stapler staple build/Lattice.dmg
spctl -a -t open --context context:primary-signature build/Lattice.dmg   # → accepted
```
Ship the stapled `build/Lattice.dmg`.

## Chrome / Chromium
Chromium is **not** bundled or signed by us. Playwright (inside the agent-browser
engine) downloads it to `~/Library/Caches/ms-playwright/` on first browser use, so
it lives outside the `.app` and isn't part of this signature. **First run needs
network** for that one-time fetch. (If you prefer a fully offline `.app`, bundle a
Chromium build under `Contents/Resources` and add it to `sign-app.sh` — it then
needs the same hardened-runtime + JIT entitlements.)

## Notes
- The embedded `lattice-backend` is a `bun --compile` binary; the hardened runtime
  requires `com.apple.security.cs.allow-jit` +
  `com.apple.security.cs.allow-unsigned-executable-memory` (already in the
  entitlements). A dev-signed build was verified to boot under hardened runtime.
- `disable-library-validation` is set so the app can spawn the separately-signed
  backend binary.
