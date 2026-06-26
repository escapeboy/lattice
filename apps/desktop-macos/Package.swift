// swift-tools-version: 5.10
import PackageDescription

// Lattice macOS desktop shell (ADR 0003): fully native SwiftUI control plane +
// supervisor. NO web/webview. The backend (13 TS packages) is untouched — this
// app talks to it over the existing localhost MCP/HTTP/SSE interface and, at
// runtime, supervises it as a child process tree.
//
// Built as a SwiftPM executable (opens in Xcode, builds headlessly on CI via
// `swift build`). The `.app` bundle is assembled by Scripts/make-app.sh.
let package = Package(
    name: "Lattice",
    platforms: [.macOS(.v13)],
    targets: [
        .executableTarget(
            name: "Lattice",
            path: "Sources/Lattice"
        )
    ]
)
