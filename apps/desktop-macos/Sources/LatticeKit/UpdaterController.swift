import Foundation
import Sparkle

/// Thin wrapper over Sparkle's standard updater. Auto-checks on the schedule
/// configured in Info.plist (`SUFeedURL`, `SUPublicEDKey`, `SUScheduledCheckInterval`)
/// and exposes a manual "Check for Updates…" action for the menubar.
///
/// Updates are EdDSA-signed: the public key lives in Info.plist; each release's
/// `.dmg` is signed with the private key and the signature is published in the
/// appcast, so a tampered update is rejected.
@MainActor
public final class UpdaterController: ObservableObject {
    public static let shared = UpdaterController()

    private let controller: SPUStandardUpdaterController

    private init() {
        // startingUpdater: true → begins the scheduled background check immediately.
        controller = SPUStandardUpdaterController(
            startingUpdater: true, updaterDelegate: nil, userDriverDelegate: nil)
    }

    /// User-initiated check (menubar). Shows Sparkle's standard UI.
    public func checkForUpdates() {
        controller.checkForUpdates(nil)
    }
}
