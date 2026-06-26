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
            if policy == nil { policy = try await client.policy() }
            connected = true
            lastError = nil
        } catch {
            connected = false
            lastError = "\(error)"
        }
    }

    public func reloadPolicy() async {
        do { policy = try await client.policy() } catch { lastError = "\(error)" }
    }

    public func savePolicy(_ p: Policy) async {
        do {
            try await client.savePolicy(p)
            policy = p
            lastError = nil
        } catch { lastError = "save failed: \(error)" }
    }

    public func approve(_ approval: Approval) async {
        do { try await client.approve(approval.id); await refresh() }
        catch { lastError = "approve failed: \(error)" }
    }

    public func deny(_ approval: Approval, reason: String) async {
        do { try await client.deny(approval.id, reason: reason); await refresh() }
        catch { lastError = "deny failed: \(error)" }
    }
}
