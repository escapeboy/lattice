import XCTest
import Darwin
@testable import LatticeKit

/// Port planning before launch: fall back past foreign listeners, take the port
/// back from a leftover backend, refuse to shadow a running Lattice.
final class PortPlannerTests: XCTestCase {
    private let host = "127.0.0.1"

    /// A free loopback port with the next `span` ports free as well.
    private func freeBlock(span: Int = PortPlanner.fallbackSpan + 2) -> Int {
        for _ in 0..<50 {
            let base = 20_000 + Int.random(in: 0..<20_000)
            if (base...(base + span)).allSatisfy({ !PortProbe.isListening(host: host, port: $0) }) {
                return base
            }
        }
        return 39_000
    }

    private func listen(on port: Int) throws -> Int32 {
        let fd = socket(AF_INET, SOCK_STREAM, 0)
        var yes: Int32 = 1
        setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &yes, socklen_t(MemoryLayout<Int32>.size))
        var addr = sockaddr_in()
        addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = in_port_t(UInt16(port).bigEndian)
        addr.sin_addr.s_addr = inet_addr(host)
        let ok = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) == 0 && Darwin.listen(fd, 4) == 0
            }
        }
        guard ok else { close(fd); throw XCTSkip("could not listen on \(port)") }
        return fd
    }

    /// Compile a tiny listener named `lattice-backend` inside a fake .app
    /// bundle — what a leftover backend looks like to the planner.
    private func fakeBackend() throws -> URL {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("planner-\(UUID().uuidString)/Fake.app/Contents/Resources/backend")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let src = dir.appendingPathComponent("listen.c")
        try """
        #include <arpa/inet.h>
        #include <stdlib.h>
        #include <sys/socket.h>
        #include <unistd.h>
        int main(int c, char **v) {
          int fd = socket(AF_INET, SOCK_STREAM, 0), one = 1;
          setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &one, sizeof one);
          struct sockaddr_in a = {0};
          a.sin_len = sizeof a; a.sin_family = AF_INET;
          a.sin_port = htons(atoi(v[1])); a.sin_addr.s_addr = inet_addr("127.0.0.1");
          if (bind(fd, (struct sockaddr *)&a, sizeof a) || listen(fd, 4)) return 1;
          for (;;) pause();
        }
        """.write(to: src, atomically: true, encoding: .utf8)
        let bin = dir.appendingPathComponent("lattice-backend")
        let cc = Process()
        cc.executableURL = URL(fileURLWithPath: "/usr/bin/clang")
        cc.arguments = ["-o", bin.path, src.path]
        cc.standardError = FileHandle.nullDevice
        do { try cc.run() } catch { throw XCTSkip("clang unavailable") }
        cc.waitUntilExit()
        guard cc.terminationStatus == 0 else { throw XCTSkip("clang failed") }
        return bin
    }

    private func waitListening(_ port: Int) -> Bool {
        for _ in 0..<50 {
            if PortProbe.isListening(host: host, port: port) { return true }
            usleep(100_000)
        }
        return false
    }

    func testFreePortsAreUsedAsIs() throws {
        let gw = freeBlock()
        let cp = freeBlock()
        let plan = try PortPlanner.plan(host: host, gateway: gw, controlPlane: cp)
        XCTAssertEqual(plan, PortPlan(gatewayPort: gw, controlPlanePort: cp, notes: []))
    }

    func testForeignListenerFallsBackToNextFreePort() throws {
        let gw = freeBlock()
        let cp = freeBlock()
        let fd = try listen(on: gw)
        defer { close(fd) }
        let plan = try PortPlanner.plan(host: host, gateway: gw, controlPlane: cp)
        XCTAssertEqual(plan.gatewayPort, gw + 1)
        XCTAssertEqual(plan.controlPlanePort, cp)
        XCTAssertEqual(plan.notes.count, 1)
        XCTAssertTrue(plan.notes[0].contains("using \(gw + 1)"), plan.notes[0])
    }

    func testFallbackSkipsPortsTakenInTheRange() throws {
        let gw = freeBlock()
        let fds = try [gw, gw + 1, gw + 2].map { try listen(on: $0) }
        defer { fds.forEach { close($0) } }
        let plan = try PortPlanner.plan(host: host, gateway: gw, controlPlane: freeBlock())
        XCTAssertEqual(plan.gatewayPort, gw + 3)
    }

    func testLeftoverBackendIsStoppedAndItsPortReused() throws {
        let bin = try fakeBackend()
        let gw = freeBlock()
        // Detach via a shell that exits at once, so launchd adopts the listener
        // (parent PID 1) — the state an orphaned backend is in.
        let sh = Process()
        sh.executableURL = URL(fileURLWithPath: "/bin/sh")
        sh.arguments = ["-c", "\"\(bin.path)\" \(gw) >/dev/null 2>&1 &"]
        try sh.run()
        sh.waitUntilExit()
        XCTAssertTrue(waitListening(gw), "fake backend did not start")
        let pid = try XCTUnwrap(PortProbe.listener(port: gw)?.0)
        XCTAssertEqual(PortProbe.parentPID(pid), 1)

        let plan = try PortPlanner.plan(host: host, gateway: gw, controlPlane: freeBlock())
        XCTAssertEqual(plan.gatewayPort, gw)
        XCTAssertTrue(plan.notes.contains { $0.contains("leftover Lattice backend (PID \(pid))") }, "\(plan.notes)")
        XCTAssertNotEqual(kill(pid, 0), 0, "leftover backend still alive")
    }

    /// A standalone `serve` (e.g. a launchd job) answers /health as a Lattice
    /// gateway: falling back would leave clients on the preferred port talking
    /// to it, so planning must stop with an error instead.
    func testStandaloneLatticeGatewayIsReportedNotShadowed() throws {
        let gw = freeBlock()
        let server = Process()
        server.executableURL = URL(fileURLWithPath: "/usr/bin/python3")
        server.arguments = ["-c", """
            import http.server, sys
            class H(http.server.BaseHTTPRequestHandler):
                def do_GET(self):
                    body = b'{"status":"ok","server":"lattice-gateway"}'
                    self.send_response(200); self.send_header("Content-Length", str(len(body)))
                    self.end_headers(); self.wfile.write(body)
                def log_message(self, *a): pass
            http.server.HTTPServer(("127.0.0.1", int(sys.argv[1])), H).serve_forever()
            """, String(gw)]
        do { try server.run() } catch { throw XCTSkip("python3 unavailable") }
        defer { server.terminate(); server.waitUntilExit() }
        guard waitListening(gw) else { throw XCTSkip("python3 server did not start") }

        XCTAssertThrowsError(try PortPlanner.plan(host: host, gateway: gw, controlPlane: freeBlock())) { error in
            guard case PortPlanError.latticeRunning(let port, _) = error else {
                return XCTFail("expected latticeRunning, got \(error)")
            }
            XCTAssertEqual(port, gw)
            XCTAssertTrue(String(describing: error).contains("used by another Lattice"), "\(error)")
        }
    }

    func testBackendOfARunningLatticeIsNotTouched() throws {
        let bin = try fakeBackend()
        let gw = freeBlock()
        // Our own child: a live parent, as when another Lattice app runs it.
        let child = Process()
        child.executableURL = bin
        child.arguments = [String(gw)]
        try child.run()
        defer { child.terminate(); child.waitUntilExit() }
        XCTAssertTrue(waitListening(gw), "fake backend did not start")

        XCTAssertThrowsError(try PortPlanner.plan(host: host, gateway: gw, controlPlane: freeBlock())) { error in
            guard case PortPlanError.latticeRunning(let port, _) = error else {
                return XCTFail("expected latticeRunning, got \(error)")
            }
            XCTAssertEqual(port, gw)
        }
        XCTAssertTrue(child.isRunning, "a running Lattice's backend must not be killed")
    }
}
