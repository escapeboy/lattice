import XCTest
@testable import LatticeKit

/// The robots.txt gate is OFF by default and ships `LATTICE_OBEY_ROBOTS=1` only
/// when the Search-tab toggle is enabled. The app's own env overrides the stored
/// setting (same precedence as the search / approval-timeout settings).
final class DesktopRobotsTests: XCTestCase {
    override func tearDown() {
        UserDefaults.standard.removeObject(forKey: "net.lattice.obeyRobots")
        super.tearDown()
    }

    func testOffByDefaultShipsNoEnv() {
        XCTAssertFalse(DesktopRobots.obey)
        XCTAssertTrue(DesktopRobots.environment(appEnv: [:]).isEmpty)
    }

    func testEnabledShipsObeyEnv() {
        DesktopRobots.obey = true
        XCTAssertEqual(DesktopRobots.environment(appEnv: [:]), ["LATTICE_OBEY_ROBOTS": "1"])
    }

    func testAppEnvOverridesStoredSetting() {
        // Stored ON, but the app env forces it off → the app env wins.
        DesktopRobots.obey = true
        XCTAssertEqual(
            DesktopRobots.environment(appEnv: ["LATTICE_OBEY_ROBOTS": "0"]),
            ["LATTICE_OBEY_ROBOTS": "0"])
        // Stored OFF, app env forces on → app env wins.
        DesktopRobots.obey = false
        XCTAssertEqual(
            DesktopRobots.environment(appEnv: ["LATTICE_OBEY_ROBOTS": "1"]),
            ["LATTICE_OBEY_ROBOTS": "1"])
    }
}
