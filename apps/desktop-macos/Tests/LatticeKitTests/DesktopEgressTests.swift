import XCTest
@testable import LatticeKit

/// D6: the desktop ships the egress proxy ON via the first-run allowlist. The
/// allowlist persists and becomes LATTICE_ALLOWED_ORIGINS, which starts the
/// backend's egress proxy.
final class DesktopEgressTests: XCTestCase {
    override func tearDown() {
        UserDefaults.standard.removeObject(forKey: "net.lattice.allowedOrigins")
        UserDefaults.standard.removeObject(forKey: "net.lattice.egressConfigured")
        super.tearDown()
    }

    func testAllowlistPersistsAndBecomesProxyEnv() {
        XCTAssertFalse(DesktopEgress.isConfigured)
        XCTAssertTrue(DesktopEgress.environment().isEmpty, "no allowlist → no proxy env")

        DesktopEgress.setAllowlist(["https://example.com", "  ", "https://google.com"])
        XCTAssertTrue(DesktopEgress.isConfigured)
        XCTAssertEqual(DesktopEgress.allowlist, ["https://example.com", "https://google.com"])

        let env = DesktopEgress.environment()
        XCTAssertEqual(env["LATTICE_ALLOWED_ORIGINS"], "https://example.com,https://google.com",
                       "configured allowlist must turn the egress proxy ON")
    }
}
