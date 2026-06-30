import XCTest
@testable import LatticeKit

/// D4 data-layer acceptance: the control-plane client (which the native views
/// render) drives sessions / policy round-trip / traces against the real
/// backend. UI pixels are a human review; this proves the wiring functions.
/// Opt-in via LATTICE_RUN_BACKEND_TESTS=1.
final class ControlPlaneClientTests: XCTestCase {
    private func port() -> Int { 22_000 + Int.random(in: 0..<2000) }

    func testSessionsPolicyAndTraces() async throws {
        let dir = try TestSupport.requireBackendDir()
        let p = port()
        let sup = try TestSupport.startStack(backendDir: dir, gatewayPort: p)
        defer { sup.stop() }

        let cp = ControlPlaneClient(baseURL: URL(string: "http://127.0.0.1:\(p + 1)")!, token: "test-cp-token")
        let mcp = MCPClient(endpoint: URL(string: "http://127.0.0.1:\(p)/mcp")!, token: TestSupport.token)
        try await mcp.connect()

        // Policy round-trips through the control plane (PUT then GET).
        var policy = try await cp.policy()
        XCTAssertFalse(policy.requireGrant.isEmpty, "expected default requireGrant entries")
        let marker = "https://lattice-test.example"
        policy.allowedOrigins.append(marker)
        try await cp.savePolicy(policy)
        let reloaded = try await cp.policy()
        XCTAssertTrue(reloaded.allowedOrigins.contains(marker), "policy did not persist")

        // A created session shows up in the control-plane session list.
        let sessionId = try await mcp.createSession()
        var found = false
        for _ in 0..<20 {
            if try await cp.sessions().contains(where: { $0.sessionId == sessionId }) { found = true; break }
            try await Task.sleep(nanoseconds: 300_000_000)
        }
        XCTAssertTrue(found, "created session did not appear in control-plane /sessions")

        // Traces endpoint is reachable and well-formed (may be empty).
        _ = try await cp.traces()

        try await mcp.destroySession(sessionId)
    }

    /// Theater visibility: a create→destroy run (a) raises the "N live" badge
    /// count while alive — independent of any open window, since this is exactly
    /// what StackController's always-on poll reads — and (b) is retained in the
    /// recently-ended catch-up after teardown so it isn't invisible.
    func testLiveCountAndRecentlyEndedCatchUp() async throws {
        let dir = try TestSupport.requireBackendDir()
        let p = port()
        let sup = try TestSupport.startStack(backendDir: dir, gatewayPort: p)
        defer { sup.stop() }

        let cp = ControlPlaneClient(baseURL: URL(string: "http://127.0.0.1:\(p + 1)")!, token: "test-cp-token")
        let mcp = MCPClient(endpoint: URL(string: "http://127.0.0.1:\(p)/mcp")!, token: TestSupport.token)
        try await mcp.connect()

        let sessionId = try await mcp.createSession()

        // (a) Live count > 0 — the badge source the always-on poll reads.
        var liveSeen = false
        for _ in 0..<20 {
            if try await cp.sessions().contains(where: { $0.sessionId == sessionId }) { liveSeen = true; break }
            try await Task.sleep(nanoseconds: 300_000_000)
        }
        XCTAssertTrue(liveSeen, "live session not counted for the N-live badge")

        // (b) After destroy: gone from live, present in recently-ended (catch-up).
        try await mcp.destroySession(sessionId)
        var endedSeen = false
        for _ in 0..<20 {
            let snap = try await cp.sessionsSnapshot()
            let live = snap.live.contains { $0.sessionId == sessionId }
            let ended = snap.recentlyEnded.contains { $0.sessionId == sessionId }
            if !live && ended { endedSeen = true; break }
            try await Task.sleep(nanoseconds: 300_000_000)
        }
        XCTAssertTrue(endedSeen, "destroyed session did not appear in recently-ended catch-up")
    }
}
