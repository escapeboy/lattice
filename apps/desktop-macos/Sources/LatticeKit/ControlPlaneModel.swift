import Foundation
import Combine

/// Observable state for the native control-plane views (D4). Polls the
/// control-plane API for sessions/approvals/policy/traces and exposes the
/// approve/deny/save-policy actions. Live perceive deltas (theater) come from
/// the MCP client's SSE stream, handled in the theater view.
@MainActor
public final class ControlPlaneModel: ObservableObject {
    @Published public private(set) var sessions: [SessionView] = []
    @Published public private(set) var approvals: [Approval] = []
    @Published public private(set) var traces: [TraceSummary] = []
    @Published public private(set) var personas: [Persona] = []
    @Published public private(set) var vault: [VaultEntry] = []
    @Published public private(set) var chromeProfiles: [ChromeProfile] = []
    @Published public private(set) var providers: [ProviderInfo] = []
    @Published public private(set) var actionCatalog: [ActionCatalogEntry] = []
    @Published public private(set) var handoffs: [Handoff] = []
    @Published public var policy: Policy?
    @Published public private(set) var lastError: String?
    @Published public private(set) var connected = false

    private let client: ControlPlaneClient
    private let notifier: HandoffNotifier?
    private var pollTask: Task<Void, Never>?

    public init(client: ControlPlaneClient, notifier: HandoffNotifier? = nil) {
        self.client = client
        self.notifier = notifier
        notifier?.attach(client: client)
    }

    /// Trace event timeline (native replay detail).
    public func replayEvents(_ traceId: String) async -> [TraceEventRow] {
        (try? await client.replayEvents(traceId)) ?? []
    }

    public func start() {
        guard pollTask == nil else { return }
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                await self?.refresh()
                try? await Task.sleep(nanoseconds: 2_000_000_000)
            }
        }
    }

    public func stop() {
        pollTask?.cancel()
        pollTask = nil
    }

    public func refresh() async {
        do {
            async let s = client.sessions()
            async let a = client.approvals()
            async let t = client.traces()
            async let p = client.personas()
            async let v = client.vault()
            async let h = client.handoffs()
            sessions = try await s
            approvals = try await a
            traces = try await t.sorted { $0.recordedAt > $1.recordedAt }
            personas = try await p
            vault = try await v
            handoffs = try await h
            notifier?.sync(handoffs: handoffs)
            notifier?.sync(approvals: approvals)
            StackController.shared.pendingApprovals = approvals.count
            if policy == nil { policy = try await client.policy() }
            connected = true
            lastError = nil
        } catch {
            connected = false
            lastError = "\(error)"
        }
    }

    /// Resolve an approval handoff (login/2FA/confirm wall) in-app: claim for
    /// this device, then approve/deny. Returns true on success.
    @discardableResult
    public func resolveHandoff(_ handoff: Handoff, approved: Bool) async -> Bool {
        let device = notifier?.deviceId ?? "macos-desktop"
        do {
            guard try await client.claimHandoff(handoff.id, deviceId: device) else {
                lastError = "handoff already claimed elsewhere"; return false
            }
            let ok = try await client.resolveHandoff(handoff.id, deviceId: device, approved: approved)
            await refresh(); lastError = ok ? nil : "handoff resolve rejected"; return ok
        } catch { lastError = "handoff failed: \(error)"; return false }
    }

    /// Fulfil an input handoff (e.g. a 2FA code) in-app. The value flows
    /// Vault→form on the backend — it never passes through the model/agent.
    @discardableResult
    public func submitHandoffInput(_ handoff: Handoff, value: String) async -> Bool {
        let device = notifier?.deviceId ?? "macos-desktop"
        do {
            guard try await client.claimHandoff(handoff.id, deviceId: device) else {
                lastError = "handoff already claimed elsewhere"; return false
            }
            let ok = try await client.submitHandoffInput(handoff.id, deviceId: device, value: value)
            await refresh(); lastError = ok ? nil : "input rejected (expired or claim lost)"; return ok
        } catch { lastError = "input failed: \(error)"; return false }
    }

    public func reloadPolicy() async {
        do { policy = try await client.policy() } catch { lastError = "\(error)" }
    }

    @discardableResult
    public func savePolicy(_ p: Policy) async -> Bool {
        do {
            try await client.savePolicy(p)
            policy = p
            lastError = nil
            return true
        } catch { lastError = "save failed: \(error)"; return false }
    }

    @discardableResult
    public func approve(_ approval: Approval) async -> Bool {
        do { try await client.approve(approval.id); await refresh(); lastError = nil; return true }
        catch { lastError = "approve failed: \(error)"; return false }
    }

    @discardableResult
    public func deny(_ approval: Approval, reason: String) async -> Bool {
        do { try await client.deny(approval.id, reason: reason); await refresh(); lastError = nil; return true }
        catch { lastError = "deny failed: \(error)"; return false }
    }

    /// Import the operator's logged-in browser session into a persona (human-
    /// initiated). Returns the number of cookies imported, or nil on failure.
    @discardableResult
    /// Returns the imported count plus an optional honest note (e.g. the engine
    /// won't restore the session). `nil` on failure.
    public func importPersona(personaId: String, profile: String, origins: [String]) async -> (imported: Int, note: String?)? {
        do {
            let r = try await client.importPersona(personaId: personaId, profile: profile, origins: origins)
            await refresh()
            lastError = nil
            return r
        } catch { lastError = "import failed: \(error)"; return nil }
    }

    /// Load the Chrome profiles available for import (best-effort; empty on failure).
    public func loadChromeProfiles() async {
        chromeProfiles = (try? await client.chromeProfiles()) ?? []
    }

    /// The agent system prompt (for the "Copy agent prompt" button); nil on failure.
    public func agentPrompt() async -> String? {
        let t = try? await client.agentPrompt()
        return (t?.isEmpty == false) ? t : nil
    }

    /// Load the known action-type catalog for the Policy picker (best-effort).
    public func loadActionCatalog() async {
        if let c = try? await client.actionCatalog(), !c.isEmpty { actionCatalog = c }
    }

    /// Load credential-provider availability + connection status (best-effort).
    public func loadProviders() async {
        providers = (try? await client.providers()) ?? []
    }

    /// Connect a credential provider. Returns logins exposed (-1 if not
    /// enumerable), or nil on failure.
    @discardableResult
    public func connectProvider(id: String, scope: String?, session: String?) async -> Int? {
        do {
            let n = try await client.connectProvider(id: id, scope: scope, session: session)
            await loadProviders()
            lastError = nil
            return n
        } catch { lastError = "\(error)"; return nil }
    }

    public func disconnectProvider(id: String) async {
        do {
            try await client.disconnectProvider(id: id)
            await loadProviders()
            lastError = nil
        } catch { lastError = "\(error)" }
    }

    /// Store a credential in the local encrypted vault. Returns true on success.
    public func storeVaultCredential(label: String, origin: String, username: String, password: String) async -> Bool {
        do {
            try await client.storeVaultCredential(label: label, origin: origin, username: username, password: password)
            await refresh()
            lastError = nil
            return true
        } catch { lastError = "\(error)"; return false }
    }
}
