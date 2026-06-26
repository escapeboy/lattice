import Foundation

/// A child process launched as the **leader of its own process group**, so the
/// entire descendant tree (backend → agent-browser → Chrome) can be torn down as
/// one unit. This is the load-bearing piece of the "zero orphans on quit"
/// guarantee (macOS desktop plan, D2).
///
/// We use `posix_spawn` with `POSIX_SPAWN_SETPGROUP` rather than Foundation's
/// `Process`, because the group must be set *at spawn time, before exec*. A
/// parent `setpgid()` after `Process.run()` races the child's exec and fails
/// with EACCES once the child has exec'd — which `posix_spawn` always has by the
/// time it returns.
public final class ManagedProcess: @unchecked Sendable {
    public let pid: pid_t
    /// Process-group id (== pid, since this process leads its own group).
    public var pgid: pid_t { pid }

    private let onExit: (Int32) -> Void
    private var reaped = false
    private let lock = NSLock()

    /// Spawn `executable` in a fresh process group. `onExit` fires once with the
    /// wait status when the process is reaped (crash or normal exit).
    public init(
        executable: URL,
        arguments: [String] = [],
        environment: [String: String],
        currentDirectory: URL,
        logFile: URL? = nil,
        onExit: @escaping (Int32) -> Void
    ) throws {
        self.onExit = onExit

        var attr = posix_spawnattr_t(bitPattern: 0)
        posix_spawnattr_init(&attr)
        defer { posix_spawnattr_destroy(&attr) }
        // Place the child in a NEW process group whose id is the child's pid.
        posix_spawnattr_setflags(&attr, Int16(POSIX_SPAWN_SETPGROUP))
        posix_spawnattr_setpgroup(&attr, 0)

        var actions = posix_spawn_file_actions_t(bitPattern: 0)
        posix_spawn_file_actions_init(&actions)
        defer { posix_spawn_file_actions_destroy(&actions) }
        posix_spawn_file_actions_addchdir_np(&actions, currentDirectory.path)
        if let logFile {
            // Append both stdout and stderr to the log file.
            FileManager.default.createFile(atPath: logFile.path, contents: nil)
            posix_spawn_file_actions_addopen(
                &actions, 1, logFile.path, O_WRONLY | O_APPEND | O_CREAT, 0o644)
            posix_spawn_file_actions_adddup2(&actions, 1, 2)
        }

        let argv = ([executable.path] + arguments).map { strdup($0) } + [nil]
        let envp = environment.map { strdup("\($0.key)=\($0.value)") } + [nil]
        defer {
            for p in argv where p != nil { free(p) }
            for p in envp where p != nil { free(p) }
        }

        var spawnedPid: pid_t = 0
        let rc = posix_spawn(&spawnedPid, executable.path, &actions, &attr, argv, envp)
        guard rc == 0 else {
            throw NSError(
                domain: "LatticeKit.ManagedProcess", code: Int(rc),
                userInfo: [NSLocalizedDescriptionKey: "posix_spawn failed: \(String(cString: strerror(rc)))"])
        }
        self.pid = spawnedPid
        startReaper()
    }

    private func startReaper() {
        let childPid = pid
        Thread.detachNewThread { [weak self] in
            var status: Int32 = 0
            while true {
                let r = waitpid(childPid, &status, 0)
                if r == -1 && errno == EINTR { continue }
                break
            }
            guard let self else { return }
            self.lock.lock()
            self.reaped = true
            self.lock.unlock()
            self.onExit(status)
        }
    }

    /// True while the leader process is still alive.
    public var isRunning: Bool {
        kill(pid, 0) == 0
    }

    /// Signal the whole process group.
    public func signalGroup(_ sig: Int32) {
        kill(-pid, sig)
    }

    /// Graceful teardown: SIGTERM the group, wait up to `timeout` for the leader
    /// to exit, then SIGKILL the group as a backstop. Guarantees the entire tree
    /// is gone (zero orphans) regardless of the backend's own cleanup.
    public func terminateGroup(timeout: TimeInterval = 5) {
        signalGroup(SIGTERM)
        let deadline = Date().addingTimeInterval(timeout)
        while isRunning && Date() < deadline {
            usleep(50_000)
        }
        // Backstop — reaches any descendant the leader didn't reap. Harmless if
        // the group is already empty.
        signalGroup(SIGKILL)
    }
}
