// swift-tools-version: 5.10
import PackageDescription

// Lattice macOS desktop shell (ADR 0003): fully native SwiftUI control plane +
// supervisor. NO web/webview. The backend (13 TS packages) is untouched — this
// app talks to it over the existing localhost MCP/HTTP/SSE interface and, at
// runtime, supervises it as a child process tree.
//
// Split into a testable `LatticeKit` library (supervisor, MCP client, view
// models, views) and a thin `Lattice` executable (just the @main App + scene).
let package = Package(
    name: "Lattice",
    platforms: [.macOS(.v13)],
    targets: [
        .target(
            name: "LatticeKit",
            path: "Sources/LatticeKit"
        ),
        .executableTarget(
            name: "Lattice",
            dependencies: ["LatticeKit"],
            path: "Sources/Lattice"
        ),
        .testTarget(
            name: "LatticeKitTests",
            dependencies: ["LatticeKit"],
            path: "Tests/LatticeKitTests"
        ),
    ]
)
