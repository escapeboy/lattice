import Foundation

public enum StackState: Sendable, Equatable {
    case stopped
    case starting
    case running
    case restarting(attempt: Int)
    case failed(String)
}

public struct SupervisorConfig: Sendable {
    /// Path to the bun-compiled `lattice-backend` executable.
    public var backendBinary: URL
    /// App data dir (where traces/vault are pointed via absolute env paths). The
    /// process itself runs with cwd = the binary's directory (agent-browser
    /// resolution), not this.
    public var workingDirectory: URL
    /// Extra env injected into the backend (ports, tokens, allowlist, …).
    public var environment: [String: String]
    /// Health endpoint polled for readiness/liveness (gateway `/health`).
    public var healthURL: URL
    /// Max consecutive crash-restarts before giving up.
    public var maxRestarts: Int
    /// Backend stdout/stderr is appended here.
    public var logFile: URL?

    public init(
        backendBinary: URL,
        workingDirectory: URL,
        environment: [String: String],
        healthURL: URL,
        maxRestarts: Int = 5,
        logFile: URL? = nil
    ) {
        self.backendBinary = backendBinary
        self.workingDirectory = workingDirectory
        self.environment = environment
        self.healthURL = healthURL
        self.maxRestarts = maxRestarts
        self.logFile = logFile
    }
}

/// Owns the Lattice backend process tree: launches it on app start, restarts it
/// with backoff on crash, and tears the whole group down cleanly on quit. The
/// backend (one bun binary) internally runs the MCP gateway + control plane +
/// egress proxy and spawns agent-browser/Chrome as its own children — all in the
/// process group `ManagedProcess` owns, so teardown reaps the lot.
public final class Supervisor: @unchecked Sendable {
    private let config: SupervisorConfig
    private let queue = DispatchQueue(label: "net.lattice.supervisor")
    private var proc: ManagedProcess?
    private var stopping = false
    private var restarts = 0
    private var _state: StackState = .stopped

    /// Fired on the main queue whenever the stack state changes.
    public var onState: (@Sendable (StackState) -> Void)?

    public init(config: SupervisorConfig) {
        self.config = config
    }

    public var state: StackState { queue.sync { _state } }

    /// PID of the current backend leader process, if running (test/diagnostics).
    public var currentPID: pid_t? { queue.sync { proc?.pid } }

    public func start() {
        queue.async { [self] in
            stopping = false
            restarts = 0
            launchLocked()
        }
    }

    private func setStateLocked(_ s: StackState) {
        _state = s
        if let cb = onState {
            DispatchQueue.main.async { cb(s) }
        }
    }

    private func launchLocked() {
        guard !stopping else { return }
        setStateLocked(restarts == 0 ? .starting : .restarting(attempt: restarts))
        do {
            let p = try ManagedProcess(
                executable: config.backendBinary,
                environment: backendEnv(),
                // The bun-compiled backend resolves its EXTERNAL agent-browser
                // package relative to process.cwd(), so the cwd must be the
                // binary's own directory (where node_modules/agent-browser is
                // staged). Traces/vault use absolute env paths, so this is safe.
                currentDirectory: config.backendBinary.deletingLastPathComponent(),
                logFile: config.logFile,
                onExit: { [weak self] status in
                    self?.queue.async { self?.handleExitLocked(status) }
                })
            proc = p
            pollHealthUntilReady()
        } catch {
            setStateLocked(.failed("launch failed: \(error.localizedDescription)"))
        }
    }

    private func backendEnv() -> [String: String] {
        var env = ProcessInfo.processInfo.environment
        for (k, v) in config.environment { env[k] = v }
        return env
    }

    private func handleExitLocked(_ status: Int32) {
        proc = nil
        if stopping {
            setStateLocked(.stopped)
            return
        }
        // Unexpected exit → crash. Restart with exponential backoff up to the cap.
        if restarts >= config.maxRestarts {
            setStateLocked(.failed("backend exited (status \(status)); gave up after \(restarts) restarts"))
            return
        }
        restarts += 1
        let backoff = min(0.5 * pow(2.0, Double(restarts - 1)), 10.0)
        setStateLocked(.restarting(attempt: restarts))
        queue.asyncAfter(deadline: .now() + backoff) { [self] in
            launchLocked()
        }
    }

    private func pollHealthUntilReady() {
        let url = config.healthURL
        Task.detached { [weak self] in
            for _ in 0..<120 {
                if await Supervisor.isHealthy(url) {
                    self?.queue.async {
                        guard let self, !self.stopping, self.proc != nil else { return }
                        self.restarts = 0
                        self.setStateLocked(.running)
                    }
                    return
                }
                try? await Task.sleep(nanoseconds: 500_000_000)
            }
        }
    }

    static func isHealthy(_ url: URL) async -> Bool {
        var req = URLRequest(url: url)
        req.timeoutInterval = 2
        do {
            let (_, resp) = try await URLSession.shared.data(for: req)
            return (resp as? HTTPURLResponse)?.statusCode == 200
        } catch {
            return false
        }
    }

    /// Graceful stop: mark intentional, tear the group down (TERM then KILL
    /// backstop). Idempotent and safe to call from `applicationWillTerminate`.
    public func stop(timeout: TimeInterval = 5) {
        let p: ManagedProcess? = queue.sync {
            stopping = true
            return proc
        }
        p?.terminateGroup(timeout: timeout)
        queue.sync {
            proc = nil
            setStateLocked(.stopped)
        }
    }

    /// Block until the stack reports `.running` or the deadline passes. Test/CLI
    /// helper; the app uses `onState` instead.
    @discardableResult
    public func waitUntilRunning(timeout: TimeInterval = 30) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if case .running = state { return true }
            if case .failed = state { return false }
            usleep(100_000)
        }
        return false
    }
}
