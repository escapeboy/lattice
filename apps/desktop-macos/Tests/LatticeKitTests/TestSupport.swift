import XCTest
import Network
import Foundation
@testable import LatticeKit

/// Shared helpers for backend-integration tests (opt-in; real backend + Chrome).
enum TestSupport {
    /// Locate the staged backend dir, or skip. Gated on LATTICE_RUN_BACKEND_TESTS=1.
    static func requireBackendDir() throws -> URL {
        guard ProcessInfo.processInfo.environment["LATTICE_RUN_BACKEND_TESTS"] == "1" else {
            throw XCTSkip("set LATTICE_RUN_BACKEND_TESTS=1 to run backend integration tests")
        }
        let fm = FileManager.default
        if let d = ProcessInfo.processInfo.environment["LATTICE_BACKEND_DIR"] {
            let u = URL(fileURLWithPath: d)
            if fm.isExecutableFile(atPath: u.appendingPathComponent("lattice-backend").path) { return u }
        }
        let pkg = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let u = pkg.appendingPathComponent("build/backend")
        if fm.isExecutableFile(atPath: u.appendingPathComponent("lattice-backend").path) { return u }
        throw XCTSkip("backend not staged — run Scripts/build-backend.sh")
    }

    static let token = "test-mcp-token"

    /// Start the backend via the Supervisor on the given gateway port; returns the
    /// running supervisor once `/health` is up.
    static func startStack(backendDir: URL, gatewayPort: Int) throws -> Supervisor {
        let dataDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("lattice-mcptest-\(UUID().uuidString)", isDirectory: true)
        try? FileManager.default.createDirectory(at: dataDir, withIntermediateDirectories: true)
        let env: [String: String] = [
            "LATTICE_PORT": String(gatewayPort),
            "LATTICE_HOST": "127.0.0.1",
            "CONTROL_PLANE_PORT": String(gatewayPort + 1),
            "LATTICE_MCP_TOKEN": token,
            "LATTICE_CP_TOKEN": "test-cp-token",
            "LATTICE_TRACE_DIR": dataDir.appendingPathComponent("traces").path,
        ]
        let config = SupervisorConfig(
            backendBinary: backendDir.appendingPathComponent("lattice-backend"),
            workingDirectory: dataDir,
            environment: env,
            healthURL: URL(string: "http://127.0.0.1:\(gatewayPort)/health")!,
            maxRestarts: 2,
            logFile: dataDir.appendingPathComponent("backend.log"))
        let sup = Supervisor(config: config)
        sup.start()
        guard sup.waitUntilRunning(timeout: 60) else {
            throw XCTSkip("backend did not reach .running")
        }
        return sup
    }
}

/// Minimal HTTP server (Network framework) that serves a self-mutating page so
/// the IG changes over time → perceive deltas → SSE notifications. Used to prove
/// the Swift client receives `notifications/perceive`.
final class MutatingPageServer {
    private let listener: NWListener
    private(set) var port: UInt16 = 0
    private let html = """
    <!doctype html><body><div id=root></div><script>\
    let n=0;setInterval(()=>{const b=document.createElement('button');\
    b.textContent='btn'+(n++);document.getElementById('root').appendChild(b);},300);\
    </script></body>
    """

    init() throws {
        listener = try NWListener(using: .tcp, on: .any)
    }

    func start() throws {
        let ready = DispatchSemaphore(value: 0)
        listener.stateUpdateHandler = { [weak self] state in
            if case .ready = state { self?.port = self?.listener.port?.rawValue ?? 0; ready.signal() }
        }
        listener.newConnectionHandler = { [weak self] conn in self?.serve(conn) }
        listener.start(queue: .global())
        _ = ready.wait(timeout: .now() + 5)
    }

    func stop() { listener.cancel() }

    private func serve(_ conn: NWConnection) {
        conn.start(queue: .global())
        conn.receive(minimumIncompleteLength: 1, maximumLength: 4096) { [html] _, _, _, _ in
            let body = Data(html.utf8)
            let head = "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: \(body.count)\r\nConnection: close\r\n\r\n"
            var out = Data(head.utf8); out.append(body)
            conn.send(content: out, completion: .contentProcessed { _ in conn.cancel() })
        }
    }
}
