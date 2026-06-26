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

    public let gatewayPort: Int
    public let controlPlanePort: Int
    public let host = "127.0.0.1"
    public let mcpToken = UUID().uuidString
    public let cpToken = UUID().uuidString

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
            Task { @MainActor in self?.state = s }
        }
        supervisor = sup
        sup.start()
    }

    /// Tear the stack down cleanly (zero orphans). Safe to call on app quit.
    public func stopStack() {
        supervisor?.stop()
        supervisor = nil
    }

    private func backendEnvironment(dataDir: URL) -> [String: String] {
        var env: [String: String] = [
            "LATTICE_PORT": String(gatewayPort),
            "LATTICE_HOST": host,
            "CONTROL_PLANE_PORT": String(controlPlanePort),
            "LATTICE_MCP_TOKEN": mcpToken,
            "LATTICE_CP_TOKEN": cpToken,
            "LATTICE_TRACE_DIR": dataDir.appendingPathComponent("traces").path,
            // Vault persistence requires a 64-hex LATTICE_VAULT_KEY, which lives
            // in the macOS Keychain — wired in D5. Until then the vault is
            // ephemeral (no LATTICE_VAULT_PATH), so the stack boots clean.
        ]
        // Desktop egress posture (D6) is layered in later; D2 just boots the stack.
        env.merge(DesktopEgress.environment()) { _, new in new }
        return env
    }
}

/// Desktop egress configuration hook. Fleshed out in D6 (proxy ON by default +
/// first-run allowlist). D2 ships it as a no-op so the wiring exists.
public enum DesktopEgress {
    public static func environment() -> [String: String] { [:] }
}
