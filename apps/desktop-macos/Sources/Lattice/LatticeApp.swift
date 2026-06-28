import SwiftUI
import LatticeKit

/// Entry point for the Lattice macOS control plane.
///
/// Menubar-only (LSUIElement). On launch the supervisor (D2) brings the whole
/// backend stack up; on quit it tears the process group down cleanly (zero
/// orphans). Control-plane views (D3/D4) hang off this scene.
@main
struct LatticeApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    var body: some Scene {
        // The menubar item and the control-plane window are managed in AppKit
        // (StatusBarController) so we can distinguish LEFT-click (open window)
        // from RIGHT-click (popover) — SwiftUI's MenuBarExtra can't. This no-op
        // scene just satisfies the `App` requirement; it never shows (LSUIElement).
        Settings { EmptyView() }
    }
}

/// Bridges the AppKit lifecycle: start the stack once the app is up, and tear it
/// down before the process exits so nothing is orphaned. Cmd-Q / the menubar
/// Quit button go through `applicationWillTerminate`; a bare SIGTERM/SIGINT
/// (e.g. system shutdown, `kill`) does NOT, so we trap those too. `stopStack()`
/// is idempotent, so overlapping paths are safe.
final class AppDelegate: NSObject, NSApplicationDelegate {
    private var signalSources: [DispatchSourceSignal] = []
    private var statusBar: StatusBarController?

    func applicationDidFinishLaunching(_ notification: Notification) {
        installSignalTeardown(for: [SIGTERM, SIGINT])
        StackController.shared.handoffNotifier.configure()
        // AppKit menubar item: left-click opens the window, right-click the menu.
        statusBar = StatusBarController(stack: .shared)
        StackController.shared.startStack()
    }

    func applicationWillTerminate(_ notification: Notification) {
        StackController.shared.stopStack()
    }

    private func installSignalTeardown(for signals: [Int32]) {
        for sig in signals {
            signal(sig, SIG_IGN) // disable default handler; observe via dispatch
            let src = DispatchSource.makeSignalSource(signal: sig, queue: .main)
            src.setEventHandler {
                // The source fires on the main queue, so we are on the main actor.
                MainActor.assumeIsolated {
                    StackController.shared.stopStack()
                    NSApp.terminate(nil)
                }
            }
            src.resume()
            signalSources.append(src)
        }
    }
}
