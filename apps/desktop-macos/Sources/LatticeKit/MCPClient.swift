import Foundation

public struct MCPError: Error, CustomStringConvertible {
    public let message: String
    public init(_ message: String) { self.message = message }
    public var description: String { message }
}

/// A perceive delta pushed over the SSE stream (`notifications/perceive`).
public struct PerceiveNotification: Sendable, Equatable {
    public let sessionId: String
    public let subscriptionId: String
    public let url: String
    public let added: Int
    public let removed: Int
    public let updated: Int
}

/// Result shape of `perceive_snapshot`.
public struct Snapshot: Sendable, Equatable {
    public let tier: String
    public let url: String
    public let title: String
    public let nodeCount: Int
}

/// Native client for the Lattice MCP gateway over the MCP Streamable-HTTP
/// transport (ADR 0003 D3): JSON-RPC over POST /mcp, `Authorization: Bearer`,
/// `Mcp-Session-Id` correlation, and a standalone GET /mcp SSE stream for
/// server-pushed `notifications/perceive`. The Swift app never touches the
/// engine directly — only this gateway surface (ADR 0002 internal-only).
public actor MCPClient {
    nonisolated let endpoint: URL
    nonisolated let token: String
    private let urlSession: URLSession
    private var mcpSessionId: String?
    private var nextId = 1

    public init(endpoint: URL, token: String) {
        self.endpoint = endpoint
        self.token = token
        let cfg = URLSessionConfiguration.ephemeral
        cfg.timeoutIntervalForRequest = 30
        self.urlSession = URLSession(configuration: cfg)
    }

    public var sessionId: String? { mcpSessionId }

    /// MCP handshake: `initialize` (captures Mcp-Session-Id) then the
    /// `notifications/initialized` notification.
    public func connect() async throws {
        let params: [String: Any] = [
            "protocolVersion": "2025-06-18",
            "capabilities": [:],
            "clientInfo": ["name": "lattice-macos", "version": "0.1.0"],
        ]
        _ = try await rpc("initialize", params: params, expectsResult: true)
        guard mcpSessionId != nil else { throw MCPError("no Mcp-Session-Id returned from initialize") }
        _ = try await rpc("notifications/initialized", params: nil, expectsResult: false)
    }

    /// Call an MCP tool; returns the tool's `content[0].text` payload (JSON text
    /// for Lattice tools). Throws on RPC error or `isError` tool results.
    @discardableResult
    public func callTool(_ name: String, _ arguments: [String: Any] = [:]) async throws -> String {
        guard let result = try await rpc("tools/call", params: ["name": name, "arguments": arguments], expectsResult: true) else {
            throw MCPError("tools/call \(name): empty result")
        }
        guard let content = result["content"] as? [[String: Any]],
              let text = content.first?["text"] as? String else {
            throw MCPError("tools/call \(name): missing content text")
        }
        if (result["isError"] as? Bool) == true {
            throw MCPError("tool \(name) error: \(text)")
        }
        return text
    }

    // MARK: convenience

    public func createSession(topology: String = "ephemeral") async throws -> String {
        let text = try await callTool("session_create", topology == "ephemeral" ? [:] : ["topology": topology])
        guard let obj = try jsonObject(text), let id = obj["sessionId"] as? String else {
            throw MCPError("session_create: no sessionId in \(text)")
        }
        return id
    }

    public func navigate(sessionId: String, url: String) async throws {
        let text = try await callTool("act_execute", ["sessionId": sessionId, "command": ["type": "navigate", "url": url]])
        if let obj = try jsonObject(text), (obj["success"] as? Bool) == false {
            throw MCPError("navigate failed: \(text)")
        }
    }

    public func perceiveSnapshot(sessionId: String, tier: String = "L1") async throws -> Snapshot {
        let text = try await callTool("perceive_snapshot", ["sessionId": sessionId, "tier": tier])
        guard let o = try jsonObject(text) else { throw MCPError("perceive_snapshot: bad json") }
        return Snapshot(
            tier: o["tier"] as? String ?? tier,
            url: o["url"] as? String ?? "",
            title: o["title"] as? String ?? "",
            nodeCount: o["nodeCount"] as? Int ?? 0)
    }

    @discardableResult
    public func subscribe(sessionId: String, intervalMs: Int = 1000) async throws -> String {
        let text = try await callTool("perceive_subscribe", ["sessionId": sessionId, "intervalMs": intervalMs])
        guard let o = try jsonObject(text), let id = o["subscriptionId"] as? String else {
            throw MCPError("perceive_subscribe: no subscriptionId")
        }
        return id
    }

    public func destroySession(_ sessionId: String) async throws {
        _ = try await callTool("session_destroy", ["sessionId": sessionId])
    }

    // MARK: SSE

    /// Open the standalone GET /mcp SSE stream and surface `notifications/perceive`
    /// as an async stream. Requires `connect()` first (Mcp-Session-Id).
    public func perceiveStream() -> AsyncStream<PerceiveNotification> {
        let endpoint = self.endpoint
        let token = self.token
        let sid = self.mcpSessionId
        let session = self.urlSession
        return AsyncStream { continuation in
            let task = Task {
                var req = URLRequest(url: endpoint)
                req.httpMethod = "GET"
                req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
                req.setValue("text/event-stream", forHTTPHeaderField: "Accept")
                if let sid { req.setValue(sid, forHTTPHeaderField: "Mcp-Session-Id") }
                do {
                    let (bytes, resp) = try await session.bytes(for: req)
                    guard (resp as? HTTPURLResponse)?.statusCode == 200 else { continuation.finish(); return }
                    // The gateway emits one JSON-RPC message per SSE `data:` line,
                    // so parse each data line directly rather than relying on the
                    // blank-line frame delimiter (AsyncLineSequence doesn't surface
                    // empty lines). CR (CRLF endings) is stripped defensively.
                    for try await rawLine in bytes.lines {
                        let line = rawLine.hasSuffix("\r") ? String(rawLine.dropLast()) : rawLine
                        guard line.hasPrefix("data:") else { continue }
                        let payload = line.dropFirst(5).trimmingCharacters(in: .whitespaces)
                        if payload.isEmpty { continue }
                        if let n = MCPClient.parsePerceive(payload) { continuation.yield(n) }
                    }
                } catch { /* stream ended / cancelled */ }
                continuation.finish()
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    // MARK: JSON-RPC plumbing

    private func rpc(_ method: String, params: [String: Any]?, expectsResult: Bool) async throws -> [String: Any]? {
        var req = URLRequest(url: endpoint)
        req.httpMethod = "POST"
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("application/json, text/event-stream", forHTTPHeaderField: "Accept")
        if let sid = mcpSessionId { req.setValue(sid, forHTTPHeaderField: "Mcp-Session-Id") }

        var body: [String: Any] = ["jsonrpc": "2.0", "method": method]
        if expectsResult { body["id"] = nextId; nextId += 1 }
        if let params { body["params"] = params }
        req.httpBody = try JSONSerialization.data(withJSONObject: body)

        let (data, resp) = try await urlSession.data(for: req)
        guard let http = resp as? HTTPURLResponse else { throw MCPError("no HTTP response") }
        if let sid = http.value(forHTTPHeaderField: "Mcp-Session-Id") { mcpSessionId = sid }
        guard (200..<300).contains(http.statusCode) else {
            throw MCPError("HTTP \(http.statusCode) on \(method)")
        }
        if !expectsResult { return nil }

        let json = try Self.parseRPCBody(data, contentType: http.value(forHTTPHeaderField: "Content-Type") ?? "")
        if let error = json["error"] as? [String: Any] {
            throw MCPError("rpc error: \(error["message"] as? String ?? "\(error)")")
        }
        return json["result"] as? [String: Any]
    }

    /// Parse a JSON-RPC response that may arrive as `application/json` or as an
    /// SSE frame (`text/event-stream`, JSON in `data:` lines).
    static func parseRPCBody(_ data: Data, contentType: String) throws -> [String: Any] {
        let raw: Data
        if contentType.contains("text/event-stream") {
            let text = String(decoding: data, as: UTF8.self)
            let joined = text.split(separator: "\n")
                .filter { $0.hasPrefix("data:") }
                .map { $0.dropFirst(5).trimmingCharacters(in: .whitespaces) }
                .joined()
            raw = Data(joined.utf8)
        } else {
            raw = data
        }
        guard let obj = try JSONSerialization.jsonObject(with: raw) as? [String: Any] else {
            throw MCPError("non-object JSON-RPC body")
        }
        return obj
    }

    static func parsePerceive(_ payload: String) -> PerceiveNotification? {
        guard let obj = try? JSONSerialization.jsonObject(with: Data(payload.utf8)) as? [String: Any],
              obj["method"] as? String == "notifications/perceive",
              let p = obj["params"] as? [String: Any] else { return nil }
        let delta = p["delta"] as? [String: Any]
        func count(_ key: String) -> Int {
            if let n = delta?[key] as? Int { return n }
            if let arr = delta?[key] as? [Any] { return arr.count }
            return 0
        }
        return PerceiveNotification(
            sessionId: p["sessionId"] as? String ?? "",
            subscriptionId: p["subscriptionId"] as? String ?? "",
            url: p["url"] as? String ?? "",
            added: count("added"), removed: count("removed"), updated: count("updated"))
    }

    private func jsonObject(_ text: String) throws -> [String: Any]? {
        try JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any]
    }
}
