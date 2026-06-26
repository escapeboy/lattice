import Foundation

// MARK: Models (control-plane JSON shapes)

public struct SessionView: Codable, Sendable, Identifiable {
    public let sessionId: String
    public let url: String
    public let actionCount: Int
    public var id: String { sessionId }
}

public struct Approval: Codable, Sendable, Identifiable {
    public let id: String
    public let sessionId: String
    public let origin: String
    public let actionType: String
    public let summary: String
}

public struct Policy: Codable, Sendable, Equatable {
    public var allowedOrigins: [String]
    public var egressAllowlist: [String]
    public var prohibitedActions: [String]
    public var requireGrant: [String]

    public init(allowedOrigins: [String] = [], egressAllowlist: [String] = [],
                prohibitedActions: [String] = [], requireGrant: [String] = []) {
        self.allowedOrigins = allowedOrigins
        self.egressAllowlist = egressAllowlist
        self.prohibitedActions = prohibitedActions
        self.requireGrant = requireGrant
    }
}

public struct TraceSummary: Codable, Sendable, Identifiable {
    public let traceId: String
    public let sessionId: String
    public let durationMs: Double
    public let totalActions: Int
    public let successRate: Double
    public let recordedAt: Double
    public var id: String { traceId }
}

/// Native client for the control-plane HTTP API (ADR 0003 D4). Mutating routes
/// and the PII `/replay` reads carry the control-plane bearer token; plain GETs
/// are open (matching the server's auth model).
public struct ControlPlaneClient: Sendable {
    let baseURL: URL
    let token: String
    private let session: URLSession

    public init(baseURL: URL, token: String) {
        self.baseURL = baseURL
        self.token = token
        let cfg = URLSessionConfiguration.ephemeral
        cfg.timeoutIntervalForRequest = 15
        self.session = URLSession(configuration: cfg)
    }

    public func sessions() async throws -> [SessionView] {
        try await get("/sessions", "sessions")
    }
    public func approvals() async throws -> [Approval] {
        try await get("/approvals", "approvals")
    }
    public func traces() async throws -> [TraceSummary] {
        try await get("/traces", "traces")
    }
    public func policy() async throws -> Policy {
        let (data, _) = try await send("GET", "/policy", body: nil)
        return try JSONDecoder().decode(Policy.self, from: data)
    }
    public func savePolicy(_ p: Policy) async throws {
        let body = try JSONEncoder().encode(p)
        _ = try await send("PUT", "/policy", body: body)
    }
    public func approve(_ id: String) async throws {
        _ = try await send("POST", "/approvals/\(id)/approve", body: Data("{}".utf8))
    }
    public func deny(_ id: String, reason: String) async throws {
        let body = try JSONSerialization.data(withJSONObject: ["reason": reason])
        _ = try await send("POST", "/approvals/\(id)/deny", body: body)
    }
    /// Replay trace ids (PII read — token required).
    public func replayList() async throws -> [String] {
        try await get("/replay", "traces")
    }

    // MARK: plumbing

    private func get<T: Decodable>(_ path: String, _ key: String) async throws -> [T] {
        let (data, _) = try await send("GET", path, body: nil)
        let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        guard let arr = obj?[key] else { return [] }
        let sub = try JSONSerialization.data(withJSONObject: arr)
        return try JSONDecoder().decode([T].self, from: sub)
    }

    private func send(_ method: String, _ path: String, body: Data?) async throws -> (Data, HTTPURLResponse) {
        var req = URLRequest(url: baseURL.appendingPathComponent(path))
        req.httpMethod = method
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        if body != nil { req.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        req.httpBody = body
        let (data, resp) = try await session.data(for: req)
        guard let http = resp as? HTTPURLResponse else { throw MCPError("no HTTP response") }
        guard (200..<300).contains(http.statusCode) else {
            throw MCPError("control-plane \(method) \(path) → HTTP \(http.statusCode)")
        }
        return (data, http)
    }
}
