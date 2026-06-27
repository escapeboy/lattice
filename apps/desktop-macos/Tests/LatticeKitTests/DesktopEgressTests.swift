import XCTest
@testable import LatticeKit

/// Egress is DISABLED on desktop: the app proxy gates HTTP only and breaks HTTPS
/// navigation (ERR_EMPTY_RESPONSE), so `environment()` ships NO proxy env even
/// when an allowlist is stored. The allowlist store persists for the future
/// HTTPS-gating work but is intentionally not wired to the running stack.
final class DesktopEgressTests: XCTestCase {
    override func tearDown() {
        UserDefaults.standard.removeObject(forKey: "net.lattice.allowedOrigins")
        UserDefaults.standard.removeObject(forKey: "net.lattice.egressConfigured")
        super.tearDown()
    }

    func testEgressDisabledOnDesktopEvenWithAllowlist() {
        XCTAssertTrue(DesktopEgress.environment().isEmpty, "no allowlist → no proxy env")

        // The store still persists (dormant — kept for future HTTPS gating)…
        DesktopEgress.setAllowlist(["https://example.com", "  ", "https://google.com"])
        XCTAssertTrue(DesktopEgress.isConfigured)
        XCTAssertEqual(DesktopEgress.allowlist, ["https://example.com", "https://google.com"])

        // …but it is NOT wired: environment() stays empty so the browser can load
        // HTTPS. A non-empty env here would re-introduce the ERR_EMPTY_RESPONSE
        // brick. Pin it.
        XCTAssertTrue(DesktopEgress.environment().isEmpty,
                      "egress disabled on desktop — allowlist must NOT turn the proxy on")
    }
}
