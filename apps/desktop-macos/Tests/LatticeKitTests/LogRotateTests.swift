import XCTest
@testable import LatticeKit

/// `backend.log` is append-only, so StackController rolls it to `.1` once it
/// crosses the size cap, keeping exactly one backup. Below the cap it's a no-op.
final class LogRotateTests: XCTestCase {
    private var dir: URL!

    override func setUpWithError() throws {
        dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("lattice-logrotate-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    }
    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: dir)
    }

    func testNoOpBelowCap() throws {
        let log = dir.appendingPathComponent("backend.log")
        try Data("small".utf8).write(to: log)
        StackController.rotateLogIfNeeded(log)
        XCTAssertTrue(FileManager.default.fileExists(atPath: log.path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: log.appendingPathExtension("1").path))
    }

    func testRollsWhenOverCap() throws {
        let log = dir.appendingPathComponent("backend.log")
        let big = Data(count: Int(StackController.logRotateCapBytes) + 1)
        try big.write(to: log)
        StackController.rotateLogIfNeeded(log)
        XCTAssertFalse(FileManager.default.fileExists(atPath: log.path), "original rolled away")
        XCTAssertTrue(FileManager.default.fileExists(atPath: log.appendingPathExtension("1").path), "backup created")
    }

    func testKeepsSingleBackup() throws {
        let log = dir.appendingPathComponent("backend.log")
        let backup = log.appendingPathExtension("1")
        try Data("old-backup".utf8).write(to: backup)
        try Data(count: Int(StackController.logRotateCapBytes) + 1).write(to: log)
        StackController.rotateLogIfNeeded(log)
        // Prior backup replaced by the rolled log; still exactly one backup.
        XCTAssertTrue(FileManager.default.fileExists(atPath: backup.path))
        let size = try FileManager.default.attributesOfItem(atPath: backup.path)[.size] as? UInt64 ?? 0
        XCTAssertGreaterThan(size, StackController.logRotateCapBytes)
    }
}
