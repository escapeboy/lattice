import Foundation

// MARK: Models (control-plane JSON shapes)

public struct SessionView: Codable, Sendable, Identifiable {
    public let sessionId: String
    public let url: String
    public let actionCount: Int
    public var id: String { sessionId }
}

/// A session that ended recently — the Theater's short-lived catch-up so an
/// ephemeral create→act→destroy run isn't invisible to an operator who opens
/// the window a moment after teardown. TTL-pruned on the server; no PII.
public struct RecentlyEndedSession: Codable, Sendable, Identifiable {
    public let sessionId: String
    public let url: String
    public let actionCount: Int
    public let endedAt: Double
    public var id: String { sessionId }
}

/// One read of /sessions: the live sessions plus the recently-ended catch-up.
public struct SessionsSnapshot: Sendable {
    public let live: [SessionView]
    public let recentlyEnded: [RecentlyEndedSession]
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

public struct Persona: Codable, Sendable, Identifiable {
    public let personaId: String
    public let origins: [String]
    public let sessions: Int
    public var id: String { personaId }
}

/// A known action type the kernel classifies (for the Policy picker).
public struct ActionCatalogEntry: Codable, Sendable, Identifiable {
    public let value: String
    public let label: String
    public let category: String
    public var id: String { value }
}

public struct ChromeProfile: Codable, Sendable, Identifiable {
    public let dir: String
    public let name: String
    public var id: String { dir }
}

public struct VaultEntry: Codable, Sendable, Identifiable {
    public let id: String
    public let origin: String
    public let label: String
    public let source: String?
}

/// A credential provider (1Password / Bitwarden / Apple Keychain) and its state.
public struct ProviderInfo: Codable, Sendable, Identifiable {
    public let id: String
    public let label: String
    public let needsSession: Bool
    public let available: Bool
    public let ready: Bool
    public let detail: String?
    public let connected: Bool
    public let scope: String?
    public let logins: Int
}

public struct Handoff: Codable, Sendable, Identifiable {
    public let id: String
    public let type: String
    public let origin: String
    public let reason: String
    public let field: String?
    public let status: String
    public let createdAt: Double
}

public struct TraceEventRow: Codable, Sendable, Identifiable {
    public let lane: String
    public let cls: String
    public let text: String
    public let rel: Double
    public var id: String { "\(rel)-\(text)" }
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
    /// Live sessions + the recently-ended catch-up, from ONE /sessions read.
    public func sessionsSnapshot() async throws -> SessionsSnapshot {
        let (data, _) = try await send("GET", "/sessions", body: nil)
        let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        func decode<T: Decodable>(_ key: String) throws -> [T] {
            guard let arr = obj?[key] else { return [] }
            let sub = try JSONSerialization.data(withJSONObject: arr)
            return try JSONDecoder().decode([T].self, from: sub)
        }
        return SessionsSnapshot(live: try decode("sessions"), recentlyEnded: try decode("recentlyEnded"))
    }
    public func approvals() async throws -> [Approval] {
        try await get("/approvals", "approvals")
    }
    public func traces() async throws -> [TraceSummary] {
        try await get("/traces", "traces")
    }
    /// Known action types (value + label + category) for the Policy editor picker.
    public func actionCatalog() async throws -> [ActionCatalogEntry] {
        let (data, _) = try await send("GET", "/action-catalog", body: nil)
        let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        guard let arr = obj?["catalog"] else { return [] }
        let sub = try JSONSerialization.data(withJSONObject: arr)
        return try JSONDecoder().decode([ActionCatalogEntry].self, from: sub)
    }
    /// The agent system prompt (plain text) for the "Copy agent prompt" button.
    public func agentPrompt() async throws -> String {
        let (data, _) = try await send("GET", "/agent-prompt", body: nil)
        return String(data: data, encoding: .utf8) ?? ""
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
    /// Redacted event timeline for one trace (native replay detail).
    public func replayEvents(_ traceId: String) async throws -> [TraceEventRow] {
        let (data, _) = try await send("GET", "/replay/\(traceId)/events", body: nil)
        let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        guard let arr = obj?["events"] else { return [] }
        let sub = try JSONSerialization.data(withJSONObject: arr)
        return try JSONDecoder().decode([TraceEventRow].self, from: sub)
    }
    public func personas() async throws -> [Persona] {
        try await get("/personas", "personas")
    }
    public func vault() async throws -> [VaultEntry] {
        try await get("/vault", "vault")
    }
    public func handoffs() async throws -> [Handoff] {
        try await get("/handoffs", "handoffs")
    }
    /// Claim a handoff for this device (first claim wins).
    public func claimHandoff(_ id: String, deviceId: String) async throws -> Bool {
        let body = try JSONSerialization.data(withJSONObject: ["deviceId": deviceId])
        let (data, _) = try await send("POST", "/handoff/\(id)/claim", body: body)
        return ((try? JSONSerialization.jsonObject(with: data)) as? [String: Any])?["claimed"] as? Bool ?? false
    }
    /// Resolve an approval handoff (approve/deny) for a claimed device.
    public func resolveHandoff(_ id: String, deviceId: String, approved: Bool) async throws -> Bool {
        let body = try JSONSerialization.data(withJSONObject: ["deviceId": deviceId, "approved": approved])
        let (data, _) = try await send("POST", "/handoff/\(id)/approve", body: body)
        return ((try? JSONSerialization.jsonObject(with: data)) as? [String: Any])?["resolved"] as? Bool ?? false
    }

    /// Fulfil an input handoff (e.g. a 2FA code). The value flows Vault→form on
    /// the backend; session + field are resolved from the stored handoff.
    public func submitHandoffInput(_ id: String, deviceId: String, value: String) async throws -> Bool {
        let body = try JSONSerialization.data(withJSONObject: ["deviceId": deviceId, "value": value])
        let (data, _) = try await send("POST", "/handoff/\(id)/input", body: body)
        return ((try? JSONSerialization.jsonObject(with: data)) as? [String: Any])?["filled"] as? Bool ?? false
    }

    /// Per-provider availability + connection status (1Password / Bitwarden / Keychain).
    public func providers() async throws -> [ProviderInfo] {
        let (data, _) = try await send("GET", "/providers", body: nil)
        let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        guard let arr = obj?["providers"] else { return [] }
        let sub = try JSONSerialization.data(withJSONObject: arr)
        return try JSONDecoder().decode([ProviderInfo].self, from: sub)
    }

    /// Connect a provider as a credential source. `scope` narrows it (1Password
    /// vault / Bitwarden folder); `session` is a token for providers that need
    /// one (Bitwarden). Returns the number of logins exposed (-1 if not enumerable).
    @discardableResult
    public func connectProvider(id: String, scope: String?, session: String?) async throws -> Int {
        var payload: [String: Any] = ["id": id]
        if let scope, !scope.isEmpty { payload["scope"] = scope }
        if let session, !session.isEmpty { payload["session"] = session }
        let body = try JSONSerialization.data(withJSONObject: payload)
        let (data, _) = try await send("POST", "/providers/connect", body: body)
        let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        return (obj?["logins"] as? Int) ?? 0
    }

    public func disconnectProvider(id: String) async throws {
        let body = try JSONSerialization.data(withJSONObject: ["id": id])
        _ = try await send("POST", "/providers/disconnect", body: body)
    }

    /// Store a credential directly in the local encrypted vault (operator-entered).
    /// The value is sealed with the Keychain-held key and never reaches the model.
    public func storeVaultCredential(label: String, origin: String, username: String, password: String) async throws {
        let body = try JSONSerialization.data(withJSONObject: [
            "label": label, "origin": origin, "username": username, "password": password,
        ])
        _ = try await send("POST", "/vault/store", body: body)
    }

    /// On-disk Chrome profiles available to import from (dir name + display name).
    public func chromeProfiles() async throws -> [ChromeProfile] {
        let (data, _) = try await send("GET", "/chrome-profiles", body: nil)
        let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        guard let arr = obj?["profiles"] else { return [] }
        let sub = try JSONSerialization.data(withJSONObject: arr)
        return try JSONDecoder().decode([ChromeProfile].self, from: sub)
    }

    /// Returns the imported cookie count plus an optional note — e.g. the honest
    /// warning that the default (agent-browser) engine does NOT restore the
    /// session, so the persona won't be auto-logged-in.
    public func importPersona(personaId: String, profile: String, origins: [String]) async throws -> (imported: Int, note: String?) {
        let body = try JSONSerialization.data(withJSONObject: [
            "personaId": personaId, "profile": profile, "origins": origins,
        ])
        let (data, _) = try await send("POST", "/persona-import", body: body)
        let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        let restored = (obj?["restored"] as? Bool) ?? true
        let note = restored ? nil : (obj?["note"] as? String)
        return ((obj?["imported"] as? Int) ?? 0, note)
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
            // Surface the server's own error text (JSON `{error}` or a plain body)
            // instead of a bare status code — the cause is almost always there.
            let detail = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["error"] as? String
                ?? String(data: data, encoding: .utf8).flatMap { $0.isEmpty ? nil : $0 }
            throw MCPError(detail ?? "control-plane \(method) \(path) → HTTP \(http.statusCode)")
        }
        return (data, http)
    }
}
