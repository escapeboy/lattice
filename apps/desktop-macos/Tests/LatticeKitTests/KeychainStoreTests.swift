import XCTest
@testable import LatticeKit

/// Vault → Keychain (D5): the encryption key is stored in and read from the
/// macOS Keychain, not a file. Skipped when the Keychain is unavailable
/// (locked / headless CI without a login keychain).
final class KeychainStoreTests: XCTestCase {
    private let account = "lattice-test-\(UUID().uuidString.prefix(8))"

    override func tearDown() {
        KeychainStore.delete(account)
        super.tearDown()
    }

    func testRoundTrip() throws {
        guard KeychainStore.write(account, "secret-value") else {
            throw XCTSkip("Keychain unavailable in this environment")
        }
        XCTAssertEqual(KeychainStore.read(account), "secret-value")
        KeychainStore.delete(account)
        XCTAssertNil(KeychainStore.read(account))
    }

    func testGetOrCreateHexKeyIsStableAnd64Hex() throws {
        guard let key = KeychainStore.getOrCreateHexKey(account) else {
            throw XCTSkip("Keychain unavailable in this environment")
        }
        XCTAssertEqual(key.count, 64)
        XCTAssertTrue(key.allSatisfy { $0.isHexDigit })
        // Stable: a second call returns the same stored key.
        XCTAssertEqual(KeychainStore.getOrCreateHexKey(account), key)
    }
}
