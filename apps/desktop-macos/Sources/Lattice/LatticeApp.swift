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
    @StateObject private var stack = StackController.shared

    var body: some Scene {
        MenuBarExtra("Lattice", systemImage: stack.menubarSymbol) {
            MenuBarContent(stack: stack)
        }
        .menuBarExtraStyle(.window)

        Window("Lattice Control Plane", id: "control-plane") {
            ControlPlaneRoot(stack: stack)
        }
        .defaultSize(width: 860, height: 580)
    }
}

/// Bridges the AppKit lifecycle: start the stack once the app is up, and tear it
/// down before the process exits so nothing is orphaned. Cmd-Q / the menubar
/// Quit button go through `applicationWillTerminate`; a bare SIGTERM/SIGINT
/// (e.g. system shutdown, `kill`) does NOT, so we trap those too. `stopStack()`
/// is idempotent, so overlapping paths are safe.
final class AppDelegate: NSObject, NSApplicationDelegate {
    private var signalSources: [DispatchSourceSignal] = []

    func applicationDidFinishLaunching(_ notification: Notification) {
        installSignalTeardown(for: [SIGTERM, SIGINT])
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
