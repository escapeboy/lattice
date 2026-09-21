import Foundation
import Darwin

/// The ports the stack will actually use, decided before launch.
public struct PortPlan: Sendable, Equatable {
    public var gatewayPort: Int
    public var controlPlanePort: Int
    /// What the planner had to do (a reaped orphan, a fallback port), for the UI.
    public var notes: [String]
}

public enum PortPlanError: Error, Equatable, CustomStringConvertible {
    /// Another Lattice (a second app instance, or a standalone `serve`) holds it.
    case latticeRunning(port: Int, holder: String)
    case leftoverWouldNotStop(port: Int, pid: pid_t)
    case noFreePort(preferred: Int, span: Int)

    public var description: String {
        switch self {
        case let .latticeRunning(port, holder):
            return "port \(port) is used by another Lattice (\(holder)) — quit it, then restart Lattice"
        case let .leftoverWouldNotStop(port, pid):
            return "a leftover Lattice backend (PID \(pid)) on port \(port) did not stop"
        case let .noFreePort(preferred, span):
            return "ports \(preferred)–\(preferred + span) are all in use"
        }
    }
}

/// Picks the gateway and control-plane ports before launch.
///
/// - Free preferred port: use it.
/// - Held by a leftover backend of a Lattice app (its app is gone, so launchd
///   adopted it): stop that process group and take the port back.
/// - Held by a running Lattice: fail. Falling back would leave MCP clients
///   configured for the preferred port talking to the other stack.
/// - Held by anything else: use the next free port within `fallbackSpan`.
///   The real port is published in `endpoint.json` for clients that read it.
public enum PortPlanner {
    public static let fallbackSpan = 10

    public static func plan(host: String, gateway: Int, controlPlane: Int) throws -> PortPlan {
        var notes: [String] = []
        let gw = try resolve(host: host, preferred: gateway, isGateway: true, avoid: [], notes: &notes)
        let cp = try resolve(host: host, preferred: controlPlane, isGateway: false, avoid: [gw], notes: &notes)
        return PortPlan(gatewayPort: gw, controlPlanePort: cp, notes: notes)
    }

    enum Holder: Equatable {
        case leftoverBackend(pid_t)
        case lattice(String)
        case other(String)
    }

    private static func resolve(
        host: String, preferred: Int, isGateway: Bool, avoid: Set<Int>, notes: inout [String]
    ) throws -> Int {
        if !avoid.contains(preferred), !PortProbe.isListening(host: host, port: preferred) {
            return preferred
        }
        switch classify(host: host, port: preferred, isGateway: isGateway) {
        case .leftoverBackend(let pid):
            guard reap(pid: pid, host: host, port: preferred) else {
                throw PortPlanError.leftoverWouldNotStop(port: preferred, pid: pid)
            }
            notes.append("stopped a leftover Lattice backend (PID \(pid)) that held port \(preferred)")
            return preferred
        case .lattice(let holder):
            throw PortPlanError.latticeRunning(port: preferred, holder: holder)
        case .other(let holder):
            for p in (preferred + 1)...(preferred + fallbackSpan)
            where !avoid.contains(p) && !PortProbe.isListening(host: host, port: p) {
                notes.append("port \(preferred) is used by \(holder); using \(p)")
                return p
            }
            throw PortPlanError.noFreePort(preferred: preferred, span: fallbackSpan)
        }
    }

    static func classify(host: String, port: Int, isGateway: Bool) -> Holder {
        guard let (pid, name) = PortProbe.listener(port: port) else {
            return .other("an unknown process")
        }
        let who = "\(name) (PID \(pid))"
        if let path = PortProbe.executablePath(pid),
           path.hasSuffix("/lattice-backend"), path.contains(".app/Contents/Resources/backend/") {
            // Our supervisor spawns the backend as its child. Parent 1 = the app
            // that owned it is gone; anything else = a Lattice app is running.
            let parent = PortProbe.parentPID(pid)
            if parent == 1 { return .leftoverBackend(pid) }
            return .lattice(parent.map { "Lattice app, PID \($0)" } ?? who)
        }
        if isGateway, PortProbe.isLatticeGateway(host: host, port: port) {
            return .lattice(who)
        }
        return .other(who)
    }

    /// TERM the backend's process group (it leads its own, with agent-browser
    /// and Chrome under it), then KILL if the port is still held.
    static func reap(pid: pid_t, host: String, port: Int) -> Bool {
        let group = getpgid(pid)
        let target: pid_t = (group > 1 && group != getpgrp()) ? -group : pid
        kill(target, SIGTERM)
        if PortProbe.waitUntilFree(host: host, port: port, timeout: 5) { return true }
        kill(target, SIGKILL)
        return PortProbe.waitUntilFree(host: host, port: port, timeout: 2)
    }
}

extension PortProbe {
    /// PID and command name of the process listening on the port, via lsof.
    static func listener(port: Int) -> (pid_t, String)? {
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/usr/sbin/lsof")
        task.arguments = ["-nP", "-iTCP:\(port)", "-sTCP:LISTEN", "-Fpc"]
        let out = Pipe()
        task.standardOutput = out
        task.standardError = FileHandle.nullDevice
        do { try task.run() } catch { return nil }
        let data = out.fileHandleForReading.readDataToEndOfFile()
        task.waitUntilExit()
        var pid: pid_t?
        var name: String?
        for line in String(decoding: data, as: UTF8.self).split(separator: "\n") {
            if line.hasPrefix("p"), pid == nil { pid = pid_t(line.dropFirst()) }
            if line.hasPrefix("c"), name == nil { name = String(line.dropFirst()) }
        }
        guard let pid else { return nil }
        return (pid, name ?? "process")
    }

    static func executablePath(_ pid: pid_t) -> String? {
        var buf = [CChar](repeating: 0, count: 4096)
        let n = proc_pidpath(pid, &buf, UInt32(buf.count))
        return n > 0 ? String(cString: buf) : nil
    }

    static func parentPID(_ pid: pid_t) -> pid_t? {
        var info = kinfo_proc()
        var size = MemoryLayout<kinfo_proc>.stride
        var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, pid]
        guard sysctl(&mib, 4, &info, &size, nil, 0) == 0, size > 0 else { return nil }
        return info.kp_eproc.e_ppid
    }

    /// True when GET /health on the port answers as a Lattice gateway.
    static func isLatticeGateway(host: String, port: Int) -> Bool {
        guard let url = URL(string: "http://\(host):\(port)/health") else { return false }
        var req = URLRequest(url: url)
        req.timeoutInterval = 1.5
        let done = DispatchSemaphore(value: 0)
        let found = LockedFlag()
        URLSession.shared.dataTask(with: req) { data, _, _ in
            if let data, let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               obj["server"] as? String == "lattice-gateway" {
                found.set()
            }
            done.signal()
        }.resume()
        _ = done.wait(timeout: .now() + 2)
        return found.value
    }

    static func waitUntilFree(host: String, port: Int, timeout: TimeInterval) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        repeat {
            if !isListening(host: host, port: port) { return true }
            usleep(100_000)
        } while Date() < deadline
        return false
    }
}

private final class LockedFlag: @unchecked Sendable {
    private let lock = NSLock()
    private var flag = false
    var value: Bool { lock.lock(); defer { lock.unlock() }; return flag }
    func set() { lock.lock(); flag = true; lock.unlock() }
}
