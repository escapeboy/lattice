import XCTest
import Darwin
@testable import LatticeKit

/// Integration tests against the REAL bun-compiled backend (which launches
/// agent-browser/Chrome). Skipped when the backend isn't staged. Locate it via
/// `LATTICE_BACKEND_DIR` or the package's `build/backend` (produced by
/// Scripts/build-backend.sh). These exercise: cold start → healthy, clean
/// teardown (zero orphans), and crash → restart.
final class SupervisorTests: XCTestCase {
    private func backendDir() throws -> URL {
        // These launch the real backend + agent-browser + Chrome. Off by default
        // (deterministic CI without browser provisioning); opt in for local runs.
        guard ProcessInfo.processInfo.environment["LATTICE_RUN_BACKEND_TESTS"] == "1" else {
            throw XCTSkip("set LATTICE_RUN_BACKEND_TESTS=1 to run backend integration tests")
        }
        let fm = FileManager.default
        if let d = ProcessInfo.processInfo.environment["LATTICE_BACKEND_DIR"] {
            let u = URL(fileURLWithPath: d)
            if fm.isExecutableFile(atPath: u.appendingPathComponent("lattice-backend").path) { return u }
        }
        // <pkg>/Tests/LatticeKitTests/SupervisorTests.swift → <pkg>
        let pkg = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let u = pkg.appendingPathComponent("build/backend")
        if fm.isExecutableFile(atPath: u.appendingPathComponent("lattice-backend").path) { return u }
        throw XCTSkip("backend not staged — run Scripts/build-backend.sh or set LATTICE_BACKEND_DIR")
    }

    /// A high, per-run port to avoid clashing with a dev backend on 8765.
    private func freePort() -> Int { 19_000 + Int.random(in: 0..<2000) }

    private func makeSupervisor(dir: URL, port: Int) -> Supervisor {
        let base = ProcessInfo.processInfo.environment["LATTICE_TEST_DIR"]
            .map { URL(fileURLWithPath: $0) } ?? FileManager.default.temporaryDirectory
        let dataDir = base
            .appendingPathComponent("lattice-suptest-\(UUID().uuidString)", isDirectory: true)
        try? FileManager.default.createDirectory(at: dataDir, withIntermediateDirectories: true)
        let env: [String: String] = [
            "LATTICE_PORT": String(port),
            "LATTICE_HOST": "127.0.0.1",
            "CONTROL_PLANE_PORT": String(port + 1),
            "LATTICE_MCP_TOKEN": "test-mcp-token",
            "LATTICE_CP_TOKEN": "test-cp-token",
            "LATTICE_TRACE_DIR": dataDir.appendingPathComponent("traces").path,
            // Ephemeral vault (no LATTICE_VAULT_PATH) — persistence is D5.
        ]
        let config = SupervisorConfig(
            backendBinary: dir.appendingPathComponent("lattice-backend"),
            workingDirectory: dataDir,
            environment: env,
            healthURL: URL(string: "http://127.0.0.1:\(port)/health")!,
            maxRestarts: 3,
            logFile: dataDir.appendingPathComponent("backend.log"))
        return Supervisor(config: config)
    }

    func testColdStartBecomesHealthyThenStopsClean() throws {
        let dir = try backendDir()
        let port = freePort()
        let sup = makeSupervisor(dir: dir, port: port)

        sup.start()
        XCTAssertTrue(sup.waitUntilRunning(timeout: 60), "stack did not reach .running")

        guard let pid = sup.currentPID else { return XCTFail("no backend pid while running") }
        XCTAssertEqual(kill(pid, 0), 0, "backend should be alive")

        sup.stop(timeout: 8)
        // Leader must be gone after a clean stop.
        var alive = true
        for _ in 0..<80 { if kill(pid, 0) != 0 { alive = false; break }; usleep(50_000) }
        XCTAssertFalse(alive, "backend leader orphaned after stop()")
        XCTAssertEqual(sup.state, .stopped)
    }

    func testCrashTriggersRestart() throws {
        let dir = try backendDir()
        let port = freePort()
        let sup = makeSupervisor(dir: dir, port: port)

        sup.start()
        XCTAssertTrue(sup.waitUntilRunning(timeout: 60), "stack did not reach .running (initial)")
        guard let firstPID = sup.currentPID else {
            return XCTFail("no backend pid after reaching .running")
        }

        // Simulate a crash: hard-kill the leader's group out from under the supervisor.
        kill(-firstPID, SIGKILL)

        // Supervisor should observe the exit and relaunch (backoff) → running again
        // with a NEW pid.
        var restarted = false
        for _ in 0..<120 {
            if case .running = sup.state, let p = sup.currentPID, p != firstPID {
                restarted = true
                break
            }
            usleep(100_000)
        }
        XCTAssertTrue(restarted, "supervisor did not restart the backend after a crash")

        sup.stop(timeout: 8)
    }
}
