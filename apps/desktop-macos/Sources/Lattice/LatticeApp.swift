import SwiftUI

/// Entry point for the Lattice macOS control plane.
///
/// D0 scaffold: a menubar-only (LSUIElement) SwiftUI app with no functionality
/// beyond presence. Later steps hang the supervisor (D2), MCP client (D3) and
/// control-plane views (D4) off this scene.
@main
struct LatticeApp: App {
    var body: some Scene {
        MenuBarExtra("Lattice", systemImage: "shield.lefthalf.filled") {
            MenuBarContent()
        }
        .menuBarExtraStyle(.window)
    }
}
