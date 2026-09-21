import XCTest
import Darwin
@testable import LatticeKit

/// A port already taken by another process must stop the stack with a clear
/// error instead of a crash → restart loop. No real backend needed.
final class PortConflictTests: XCTestCase {
    /// Listen on 127.0.0.1 with a kernel-chosen port; returns (fd, port).
    private func listenOnLoopback() throws -> (Int32, Int) {
        let fd = socket(AF_INET, SOCK_STREAM, 0)
        guard fd >= 0 else { throw XCTSkip("socket() failed") }
        var addr = sockaddr_in()
        addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = 0
        addr.sin_addr.s_addr = inet_addr("127.0.0.1")
        var len = socklen_t(MemoryLayout<sockaddr_in>.size)
        let bound = withUnsafeMutablePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { p -> Bool in
                Darwin.bind(fd, p, len) == 0 && Darwin.listen(fd, 4) == 0 && getsockname(fd, p, &len) == 0
            }
        }
        guard bound else { close(fd); throw XCTSkip("could not listen on loopback") }
        return (fd, Int(UInt16(bigEndian: addr.sin_port)))
    }

    func testProbeSeesListenerAndFreePort() throws {
        let (fd, port) = try listenOnLoopback()
        XCTAssertTrue(PortProbe.isListening(host: "127.0.0.1", port: port))
        close(fd)
        XCTAssertFalse(PortProbe.isListening(host: "127.0.0.1", port: port))
    }

    func testListenerDescriptionNamesTheOwningPID() throws {
        let (fd, port) = try listenOnLoopback()
        defer { close(fd) }
        let desc = try XCTUnwrap(PortProbe.listenerDescription(port: port))
        XCTAssertTrue(desc.contains("PID \(getpid())"), desc)
    }

    func testBusyPortFailsWithoutLaunching() throws {
        let (fd, port) = try listenOnLoopback()
        defer { close(fd) }
        let config = SupervisorConfig(
            // Never executed: the port check runs before the spawn.
            backendBinary: URL(fileURLWithPath: "/usr/bin/false"),
            workingDirectory: FileManager.default.temporaryDirectory,
            environment: [:],
            healthURL: URL(string: "http://127.0.0.1:\(port)/health")!,
            logFile: nil,
            requiredPorts: [port])
        let sup = Supervisor(config: config)
        sup.start()
        XCTAssertFalse(sup.waitUntilRunning(timeout: 5))
        guard case .failed(let msg) = sup.state else {
            return XCTFail("expected .failed, got \(sup.state)")
        }
        XCTAssertTrue(msg.contains("port \(port) is already in use"), msg)
        XCTAssertTrue(msg.contains("PID \(getpid())"), msg)
        XCTAssertNil(sup.currentPID, "backend must not be launched on a busy port")
    }
}
