import XCTest
@testable import LatticeKit

/// D5 operator surfaces + handoff claim-once, against the real backend.
/// Opt-in via LATTICE_RUN_BACKEND_TESTS=1.
final class ControlPlaneD5Tests: XCTestCase {
    private func port() -> Int { 24_000 + Int.random(in: 0..<2000) }
    private func cp(_ p: Int) -> ControlPlaneClient {
        ControlPlaneClient(baseURL: URL(string: "http://127.0.0.1:\(p + 1)")!, token: "test-cp-token")
    }
    private func mcpClient(_ p: Int) -> MCPClient {
        MCPClient(endpoint: URL(string: "http://127.0.0.1:\(p)/mcp")!, token: TestSupport.token)
    }

    func testVaultAndPersonaSurfaces() async throws {
        let dir = try TestSupport.requireBackendDir()
        let p = port()
        let sup = try TestSupport.startStack(backendDir: dir, gatewayPort: p)
        defer { sup.stop() }
        let mcp = mcpClient(p); try await mcp.connect()
        let control = cp(p)

        // A persistent session with a personaId registers a persona (read surface).
        _ = try await mcp.callTool("session_create", ["topology": "persistent", "personaId": "ada"])
        var personaFound = false
        for _ in 0..<20 {
            if try await control.personas().contains(where: { $0.personaId == "ada" }) { personaFound = true; break }
            try await Task.sleep(nanoseconds: 200_000_000)
        }
        XCTAssertTrue(personaFound, "persona not surfaced")

        // The vault list is reachable with the token and empty by default (storing
        // a credential requires a human grant — the agent surface alone can't).
        // VaultEntry has no credential fields by construction, so values can't leak.
        _ = try await control.vault()

        // Token-gated: a wrong token is rejected.
        let bad = ControlPlaneClient(baseURL: URL(string: "http://127.0.0.1:\(p + 1)")!, token: "wrong-token")
        do {
            _ = try await bad.vault()
            XCTFail("vault list should be token-gated")
        } catch let e as MCPError {
            XCTAssertTrue(e.message.contains("401"), "expected 401, got \(e.message)")
        }
    }

    func testReplayEventsTimeline() async throws {
        let dir = try TestSupport.requireBackendDir()
        let p = port()
        let sup = try TestSupport.startStack(backendDir: dir, gatewayPort: p)
        defer { sup.stop() }
        let mcp = mcpClient(p); try await mcp.connect()
        let control = cp(p)

        let sessionId = try await mcp.createSession()
        try await mcp.navigate(sessionId: sessionId, url: "https://example.com")
        try await mcp.destroySession(sessionId) // → trace recorded

        var rows: [TraceEventRow] = []
        for _ in 0..<20 {
            let ids = try await control.replayList()
            if let traceId = ids.first {
                rows = try await control.replayEvents(traceId)
                if !rows.isEmpty { break }
            }
            try await Task.sleep(nanoseconds: 300_000_000)
        }
        XCTAssertFalse(rows.isEmpty, "no redacted timeline rows returned")
        XCTAssertTrue(rows.contains { $0.lane == "act" || $0.lane == "perceive" || $0.lane == "meta" })
    }

    func testHandoffClaimOnce() async throws {
        let dir = try TestSupport.requireBackendDir()
        let p = port()
        let sup = try TestSupport.startStack(backendDir: dir, gatewayPort: p)
        defer { sup.stop() }
        let mcp = mcpClient(p); try await mcp.connect()
        let control = cp(p)

        let sessionId = try await mcp.createSession()
        _ = try await mcp.callTool("session_handoff", [
            "sessionId": sessionId, "type": "approval", "reason": "confirm login",
        ])

        var handoffId: String?
        for _ in 0..<20 {
            if let h = try await control.handoffs().first { handoffId = h.id; break }
            try await Task.sleep(nanoseconds: 300_000_000)
        }
        guard let id = handoffId else { return XCTFail("handoff not surfaced") }

        // First device wins the claim; a second device loses it (claim-once).
        let first = try await control.claimHandoff(id, deviceId: "device-A")
        XCTAssertTrue(first, "first claim should win")
        let second = try await control.claimHandoff(id, deviceId: "device-B")
        XCTAssertFalse(second, "second claim must lose (claim-once)")

        _ = try await control.resolveHandoff(id, deviceId: "device-A", approved: true)
    }
}
