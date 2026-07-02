import XCTest
@testable import LatticeKit

/// Search-provider settings → backend env. The provider kind / SearXNG URL are
/// UserDefaults; the Brave key is Keychain-backed and injected here so the
/// tests never touch the real login keychain.
final class DesktopSearchTests: XCTestCase {
    override func tearDown() {
        UserDefaults.standard.removeObject(forKey: "net.lattice.searchProvider")
        UserDefaults.standard.removeObject(forKey: "net.lattice.searxngUrl")
        super.tearDown()
    }

    func testDefaultIsDuckDuckGoWithNoSecrets() {
        let env = DesktopSearch.environment(appEnv: [:], braveKey: nil)
        XCTAssertEqual(env["LATTICE_SEARCH_PROVIDER"], "ddg")
        XCTAssertNil(env["LATTICE_BRAVE_KEY"])
        XCTAssertNil(env["LATTICE_SEARXNG_URL"])
    }

    func testBraveSelectionPassesTheKeyOnlyForBrave() {
        DesktopSearch.provider = .brave
        let env = DesktopSearch.environment(appEnv: [:], braveKey: "mock-key")
        XCTAssertEqual(env["LATTICE_SEARCH_PROVIDER"], "brave")
        XCTAssertEqual(env["LATTICE_BRAVE_KEY"], "mock-key")

        // Switching back to ddg: the key must NOT ride the env anymore.
        DesktopSearch.provider = .ddg
        let ddgEnv = DesktopSearch.environment(appEnv: [:], braveKey: "mock-key")
        XCTAssertNil(ddgEnv["LATTICE_BRAVE_KEY"],
                     "the Brave key must not leak into a non-Brave run's env")
    }

    func testSearxngSelectionPassesValidatedUrl() {
        DesktopSearch.provider = .searxng
        DesktopSearch.searxngUrl = "https://searx.internal.example:8443/base"
        let env = DesktopSearch.environment(appEnv: [:], braveKey: nil)
        XCTAssertEqual(env["LATTICE_SEARCH_PROVIDER"], "searxng")
        XCTAssertEqual(env["LATTICE_SEARXNG_URL"], "https://searx.internal.example:8443/base")

        // An invalid URL is not forwarded (the backend would boot search-disabled
        // with a typed config error either way; don't ship garbage).
        DesktopSearch.searxngUrl = "not a url"
        XCTAssertNil(DesktopSearch.environment(appEnv: [:], braveKey: nil)["LATTICE_SEARXNG_URL"])
    }

    func testUrlValidation() {
        XCTAssertTrue(DesktopSearch.isValidSearxngUrl("https://searx.example.org"))
        XCTAssertTrue(DesktopSearch.isValidSearxngUrl("http://10.0.0.5:8080"))
        XCTAssertFalse(DesktopSearch.isValidSearxngUrl(""))
        XCTAssertFalse(DesktopSearch.isValidSearxngUrl("searx.example.org"))
        XCTAssertFalse(DesktopSearch.isValidSearxngUrl("ftp://searx.example.org"))
    }

    func testAppProcessEnvOverridesStoredSettings() {
        DesktopSearch.provider = .brave
        let env = DesktopSearch.environment(
            appEnv: ["LATTICE_SEARCH_PROVIDER": "searxng", "LATTICE_SEARXNG_URL": "https://override.example"],
            braveKey: "stored-key")
        XCTAssertEqual(env["LATTICE_SEARCH_PROVIDER"], "searxng")
        XCTAssertEqual(env["LATTICE_SEARXNG_URL"], "https://override.example")
        XCTAssertNil(env["LATTICE_BRAVE_KEY"], "override mode forwards ONLY the app env values")
    }
}
