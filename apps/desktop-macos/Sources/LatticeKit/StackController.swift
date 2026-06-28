import Foundation
import Combine

/// App-facing owner of the backend stack. Builds the supervisor config (ports,
/// tokens, data dir), starts/stops the supervisor, and publishes the live state
/// for the menubar UI. The generated tokens are also what the native MCP client
/// (D3) authenticates with — Swift mints them and injects them into the backend
/// env, rather than letting the backend auto-generate and only print them.
@MainActor
public final class StackController: ObservableObject {
    public static let shared = StackController(
        gatewayPort: envPort("LATTICE_DESKTOP_GATEWAY_PORT", default: 8765),
        controlPlanePort: envPort("LATTICE_DESKTOP_CP_PORT", default: 7900))

    private static func envPort(_ key: String, default def: Int) -> Int {
        if let v = ProcessInfo.processInfo.environment[key], let n = Int(v) { return n }
        return def
    }

    @Published public private(set) var state: StackState = .stopped
    /// A connected MCP client, available once the stack is `.running`.
    @Published public private(set) var client: MCPClient?
    /// Whether the first-run egress allowlist has been configured (proxy ON).
    @Published public private(set) var egressConfigured: Bool = DesktopEgress.isConfigured
    /// Consequential actions blocked awaiting the operator's approval. Drives the
    /// menubar attention indicator so a blocked agent isn't hidden in a tab.
    @Published public internal(set) var pendingApprovals: Int = 0
    /// Human handoffs the agent raised at a wall (login / 2FA / confirm) awaiting
    /// the operator. Also drives the menubar attention indicator.
    @Published public internal(set) var pendingHandoffs: Int = 0
    /// Total things needing the operator (approvals + handoffs).
    public var needsAttention: Int { pendingApprovals + pendingHandoffs }

    public let gatewayPort: Int
    public let controlPlanePort: Int
    public let host = "127.0.0.1"
    public let mcpToken = UUID().uuidString
    public let cpToken = UUID().uuidString
    /// Native handoff → notification bridge (configured at app launch).
    public let handoffNotifier = HandoffNotifier()

    private var supervisor: Supervisor?

    public init(gatewayPort: Int = 8765, controlPlanePort: Int = 7900) {
        self.gatewayPort = gatewayPort
        self.controlPlanePort = controlPlanePort
    }

    public var mcpURL: URL { URL(string: "http://\(host):\(gatewayPort)/mcp")! }
    public var healthURL: URL { URL(string: "http://\(host):\(gatewayPort)/health")! }
    public var controlPlaneURL: URL { URL(string: "http://\(host):\(controlPlanePort)")! }

    /// Build the supervisor and launch the backend. No-op if already started.
    public func startStack() {
        guard supervisor == nil else { return }
        guard let backend = BackendLocator.backendBinary() else {
            state = .failed("backend binary not found (set LATTICE_BACKEND_DIR or build the .app)")
            return
        }
        let dataDir = BackendLocator.appSupportDirectory()
        let config = SupervisorConfig(
            backendBinary: backend,
            workingDirectory: dataDir,
            environment: backendEnvironment(dataDir: dataDir),
            healthURL: healthURL,
            logFile: dataDir.appendingPathComponent("backend.log"))

        let sup = Supervisor(config: config)
        sup.onState = { [weak self] s in
            // onState already hops to the main queue; assert into the main actor.
            Task { @MainActor in self?.handleState(s) }
        }
        supervisor = sup
        sup.start()
    }

    private func handleState(_ s: StackState) {
        state = s
        if case .running = s, client == nil {
            // Connect a native MCP client for the control-plane views (D3/D4).
            let c = MCPClient(endpoint: mcpURL, token: mcpToken)
            Task { try? await c.connect() }
            client = c
            startAlertPoll()
        } else if case .running = s {
            // already connected
        } else {
            client = nil
            stopAlertPoll()
        }
    }

    // Always-on alert poll: the full control-plane model only polls while its
    // window is OPEN, so a blocked approval would sit silent in a menubar-only
    // app. This lightweight poll runs for the whole running lifetime, feeding the
    // notifier (native banner) and the menubar badge regardless of window state.
    private var alertPollTask: Task<Void, Never>?

    private func startAlertPoll() {
        guard alertPollTask == nil else { return }
        let client = ControlPlaneClient(baseURL: controlPlaneURL, token: cpToken)
        handoffNotifier.attach(client: client)
        alertPollTask = Task { [weak self] in
            while !Task.isCancelled {
                if let approvals = try? await client.approvals() {
                    self?.handoffNotifier.sync(approvals: approvals)
                    self?.pendingApprovals = approvals.count
                }
                if let handoffs = try? await client.handoffs() {
                    self?.handoffNotifier.sync(handoffs: handoffs)
                    self?.pendingHandoffs = handoffs.filter { $0.status == "pending" }.count
                }
                try? await Task.sleep(nanoseconds: 2_000_000_000)
            }
        }
    }

    private func stopAlertPoll() {
        alertPollTask?.cancel()
        alertPollTask = nil
        pendingApprovals = 0
        pendingHandoffs = 0
    }

    /// Desktop egress is OFF by default, so first-run never blocks startup. The
    /// app-level proxy gates HTTP only and BREAKS HTTPS navigation: Chromium
    /// routes HTTPS through the proxy, which can't tunnel the CONNECT, so every
    /// navigation fails with net::ERR_EMPTY_RESPONSE. Forcing the egress setup
    /// therefore shipped a browser that can't load HTTPS. Re-enable the guided
    /// first-run when app-level HTTPS gating lands (plans/https-egress-roadmap).
    public var firstRunNeeded: Bool { false }

    /// Persist an allowlist (kept for the future HTTPS-gating work) and restart.
    /// NOTE: `environment()` does not wire this to the running stack today —
    /// egress is disabled on desktop until HTTPS gating exists. Dormant.
    public func applyAllowlist(_ origins: [String]) {
        DesktopEgress.setAllowlist(origins)
        egressConfigured = true
        if supervisor != nil { stopStack() }
        startStack()
    }

    /// Tear the stack down cleanly (zero orphans). Safe to call on app quit.
    public func stopStack() {
        supervisor?.stop()
        supervisor = nil
        client = nil
    }

    private func backendEnvironment(dataDir: URL) -> [String: String] {
        var env: [String: String] = [
            "LATTICE_PORT": String(gatewayPort),
            "LATTICE_HOST": host,
            "CONTROL_PLANE_PORT": String(controlPlanePort),
            "LATTICE_MCP_TOKEN": mcpToken,
            "LATTICE_CP_TOKEN": cpToken,
            "LATTICE_TRACE_DIR": dataDir.appendingPathComponent("traces").path,
            // Parent-death watchdog: the backend polls this PID and reaps its
            // detached agent-browser daemon when the app dies (the app's own quit
            // teardown is unreliable for a MenuBarExtra/LSUIElement app).
            "LATTICE_PARENT_PID": String(ProcessInfo.processInfo.processIdentifier),
        ]
        // Vault → Keychain (D5): the 64-hex encryption key lives in the macOS
        // Keychain; the vault file is encrypted with it and persists across runs.
        // If the Keychain is unavailable, fall back to an ephemeral vault (no
        // LATTICE_VAULT_PATH) so the stack still boots.
        let vaultPath = dataDir.appendingPathComponent("vault.json")
        // If the key can't be read non-interactively (fresh install, or the
        // ad-hoc signature changed so the item's ACL no longer matches), we mint
        // a new key — which makes any existing vault.json undecryptable. Drop the
        // stale file so the backend boots a fresh vault instead of failing.
        let hadKey = KeychainStore.read("vault-key") != nil
        if let vaultKey = KeychainStore.getOrCreateHexKey("vault-key") {
            if !hadKey { try? FileManager.default.removeItem(at: vaultPath) }
            env["LATTICE_VAULT_KEY"] = vaultKey
            env["LATTICE_VAULT_PATH"] = vaultPath.path
        }
        // Desktop egress (D6): currently a no-op — `environment()` returns empty
        // because the app proxy breaks HTTPS (see DesktopEgress). Merged anyway so
        // re-enabling later (post HTTPS-gating) is a one-line change there.
        env.merge(DesktopEgress.environment()) { _, new in new }
        return env
    }
}

/// Desktop egress posture (ADR 0003 D6) — DISABLED by default.
///
/// The original design shipped the egress proxy ON via a guided first-run
/// allowlist. But the app-level proxy gates HTTP only and breaks HTTPS
/// navigation entirely: Chromium routes HTTPS through the proxy, the proxy
/// cannot tunnel the CONNECT, and every navigation fails with
/// net::ERR_EMPTY_RESPONSE — i.e. ON-by-default made the browser unusable.
/// Until app-level HTTPS gating exists (plans/https-egress-roadmap), egress is
/// OFF on desktop: `environment()` ships no proxy and first-run does not force
/// setup. The allowlist store below is retained, dormant, for that future work.
/// HTTPS exfil compensating control today = network/infra layer (squid/pf).
public enum DesktopEgress {
    private static let originsKey = "net.lattice.allowedOrigins"
    private static let configuredKey = "net.lattice.egressConfigured"

    public static var isConfigured: Bool { UserDefaults.standard.bool(forKey: configuredKey) }

    public static var allowlist: [String] {
        UserDefaults.standard.stringArray(forKey: originsKey) ?? []
    }

    public static func setAllowlist(_ origins: [String]) {
        let cleaned = origins
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
        UserDefaults.standard.set(cleaned, forKey: originsKey)
        UserDefaults.standard.set(true, forKey: configuredKey)
    }

    /// Env for the backend. Egress is DISABLED on desktop: the proxy gates HTTP
    /// only and breaks HTTPS navigation (ERR_EMPTY_RESPONSE), so we ship NO proxy
    /// env — otherwise the browser can't load any HTTPS page. The allowlist store
    /// stays for future HTTPS-gating work but is intentionally not wired here.
    public static func environment() -> [String: String] { [:] }
}
