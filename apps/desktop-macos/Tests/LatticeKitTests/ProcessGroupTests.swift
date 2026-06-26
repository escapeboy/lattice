import XCTest
import Darwin
@testable import LatticeKit

/// Proves the zero-orphan teardown mechanism (D2 acceptance): killing the
/// process GROUP reaps descendants the leader spawned, not just the leader.
/// No backend needed — uses a synthetic sh → sleep tree.
final class ProcessGroupTests: XCTestCase {
    func testTerminateGroupReapsDescendants() throws {
        let tmp = FileManager.default.temporaryDirectory
        let pidFile = tmp.appendingPathComponent("lattice-pgtest-\(UUID().uuidString).pid")
        let exited = expectation(description: "leader exited")

        // Leader (sh) backgrounds a long-lived grandchild and records its pid.
        let script = "sleep 600 & echo $! > '\(pidFile.path)'; wait"
        let proc = try ManagedProcess(
            executable: URL(fileURLWithPath: "/bin/sh"),
            arguments: ["-c", script],
            environment: ProcessInfo.processInfo.environment,
            currentDirectory: tmp,
            onExit: { _ in exited.fulfill() })

        var grandchild: pid_t = 0
        for _ in 0..<100 {
            if let s = try? String(contentsOf: pidFile, encoding: .utf8),
               let p = pid_t(s.trimmingCharacters(in: .whitespacesAndNewlines)) {
                grandchild = p
                break
            }
            usleep(50_000)
        }
        XCTAssertGreaterThan(grandchild, 0, "grandchild pid was not captured")
        XCTAssertEqual(kill(grandchild, 0), 0, "grandchild should be alive before teardown")

        proc.terminateGroup(timeout: 3)
        wait(for: [exited], timeout: 5)

        // The grandchild MUST be gone — if only the leader were signalled it would
        // survive as an orphan. Allow a moment for SIGKILL + reaping by launchd.
        var orphaned = true
        for _ in 0..<60 {
            if kill(grandchild, 0) != 0 && errno == ESRCH {
                orphaned = false
                break
            }
            usleep(50_000)
        }
        XCTAssertFalse(orphaned, "grandchild was orphaned after group teardown")

        try? FileManager.default.removeItem(at: pidFile)
    }
}
