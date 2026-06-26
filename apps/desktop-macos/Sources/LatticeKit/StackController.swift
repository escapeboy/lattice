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
        } else if case .running = s {
            // already connected
        } else {
            client = nil
        }
    }

    /// True until the operator completes the guided first-run egress allowlist.
    public var firstRunNeeded: Bool { !egressConfigured }

    /// Persist the first-run allowlist and restart the stack so the egress proxy
    /// comes up ON with it (the sole egress layer on desktop — D6).
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
        ]
        // Vault → Keychain (D5): the 64-hex encryption key lives in the macOS
        // Keychain; the vault file is encrypted with it and persists across runs.
        // If the Keychain is unavailable, fall back to an ephemeral vault (no
        // LATTICE_VAULT_PATH) so the stack still boots.
        if let vaultKey = KeychainStore.getOrCreateHexKey("vault-key") {
            env["LATTICE_VAULT_KEY"] = vaultKey
            env["LATTICE_VAULT_PATH"] = dataDir.appendingPathComponent("vault.json").path
        }
        // Desktop egress posture (D6) is layered in later; D2 just boots the stack.
        env.merge(DesktopEgress.environment()) { _, new in new }
        return env
    }
}

/// Desktop egress posture (ADR 0003 D6): the egress proxy is ON by default,
/// configured through a guided first-run allowlist. On desktop there is no infra
/// layer behind the proxy, so it is the SOLE egress defense — which is why the
/// secure config is made the default via setup UX (closing the server's 18/20
/// zero-config hole to 20/20) rather than left to an env var.
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

    /// Env for the backend: when an allowlist is set, ship it so the egress proxy
    /// starts ON (origin-gated). Empty before first-run.
    public static func environment() -> [String: String] {
        let origins = allowlist
        return origins.isEmpty ? [:] : ["LATTICE_ALLOWED_ORIGINS": origins.joined(separator: ",")]
    }
}
