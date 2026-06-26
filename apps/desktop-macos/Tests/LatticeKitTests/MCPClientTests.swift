import XCTest
@testable import LatticeKit

/// D3 acceptance: the native client drives session_create → navigate → perceive
/// end-to-end, receives SSE deltas, and the /mcp endpoint is token-gated.
/// Opt-in (real backend + Chrome) via LATTICE_RUN_BACKEND_TESTS=1.
final class MCPClientTests: XCTestCase {
    private func gatewayURL(_ port: Int) -> URL { URL(string: "http://127.0.0.1:\(port)/mcp")! }
    private func port() -> Int { 20_000 + Int.random(in: 0..<2000) }

    func testTokenGatingRejectsBadToken() async throws {
        let dir = try TestSupport.requireBackendDir()
        let p = port()
        let sup = try TestSupport.startStack(backendDir: dir, gatewayPort: p)
        defer { sup.stop() }

        let bad = MCPClient(endpoint: gatewayURL(p), token: "wrong-token")
        do {
            try await bad.connect()
            XCTFail("connect should have failed with a bad token")
        } catch let e as MCPError {
            XCTAssertTrue(e.message.contains("401"), "expected 401, got: \(e.message)")
        }
    }

    func testRoundTripAndSSEDeltas() async throws {
        let dir = try TestSupport.requireBackendDir()
        let p = port()
        let sup = try TestSupport.startStack(backendDir: dir, gatewayPort: p)
        defer { sup.stop() }

        let page = try MutatingPageServer()
        try page.start()
        defer { page.stop() }
        XCTAssertGreaterThan(page.port, 0, "test page server did not bind a port")
        let pageURL = "http://localhost:\(page.port)/"

        let client = MCPClient(endpoint: gatewayURL(p), token: TestSupport.token)
        try await client.connect()
        let mcpSession = await client.sessionId
        XCTAssertNotNil(mcpSession, "no MCP session id after connect")

        // session_create → navigate → perceive
        let sessionId = try await client.createSession()
        XCTAssertFalse(sessionId.isEmpty)
        try await client.navigate(sessionId: sessionId, url: pageURL)
        let snap = try await client.perceiveSnapshot(sessionId: sessionId)
        XCTAssertTrue(snap.url.contains("\(page.port)"), "snapshot url \(snap.url) is not the page")

        // Subscribe + open the SSE stream; the self-mutating page must yield ≥1
        // perceive delta within the timeout.
        let stream = await client.perceiveStream()
        _ = try await client.subscribe(sessionId: sessionId, intervalMs: 300)

        let received = try await withThrowingTaskGroup(of: PerceiveNotification?.self) { group -> PerceiveNotification? in
            group.addTask {
                for await n in stream { return n }
                return nil
            }
            group.addTask {
                try await Task.sleep(nanoseconds: 8_000_000_000)
                return nil
            }
            let first = try await group.next() ?? nil
            group.cancelAll()
            return first
        }

        XCTAssertNotNil(received, "no SSE perceive notification arrived")
        if let n = received {
            XCTAssertEqual(n.sessionId, sessionId)
            XCTAssertGreaterThan(n.added + n.updated, 0, "delta had no node changes")
        }

        try await client.destroySession(sessionId)
    }
}
