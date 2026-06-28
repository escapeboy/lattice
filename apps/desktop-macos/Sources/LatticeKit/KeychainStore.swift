import Foundation
import Security

/// Stores Lattice secrets in the macOS Keychain (Security framework) rather than
/// a plaintext file (ADR 0003 D5). The vault's encryption key lives here; the
/// encrypted vault file is useless without it.
///
/// Uses the **login (file) keychain**, NOT the data-protection keychain. WHY the
/// switch (D9): the data-protection keychain scopes items by `keychain-access-group`,
/// which on a non-App-Store build needs a provisioning profile we don't ship — so
/// on the signed Developer-ID app every read returned `errSecItemNotFound` and the
/// vault fell back to EPHEMERAL (credentials lost on every restart). The login
/// keychain needs no entitlement/profile and persists across runs.
///
/// The file keychain binds an item's ACL to the creating binary's code signature
/// and pops a blocking SecurityAgent prompt when a *differently*-signed binary
/// reads it. That is fine now because the shipped app — and the recommended local
/// build — are signed with a STABLE Developer ID identity (see sign-app.sh), so the
/// ACL matches across rebuilds and never prompts. Only a pure ad-hoc (`IDENTITY=-`)
/// dev build can trigger a one-time "Always Allow" prompt after a re-sign; that is a
/// dev-only edge, not a shipped-app concern.
public enum KeychainStore {
    public static let service = "net.lattice.desktop"

    public static func read(_ account: String) -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data,
              let value = String(data: data, encoding: .utf8) else { return nil }
        return value
    }

    @discardableResult
    public static func write(_ account: String, _ value: String) -> Bool {
        let base: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(base as CFDictionary)
        var add = base
        add[kSecValueData as String] = Data(value.utf8)
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        return SecItemAdd(add as CFDictionary, nil) == errSecSuccess
    }

    public static func delete(_ account: String) {
        SecItemDelete([
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ] as CFDictionary)
    }

    /// Return the existing 64-hex key for `account`, or mint + store a fresh one.
    /// Returns nil only if the Keychain is unavailable (e.g. locked, no entitlement).
    public static func getOrCreateHexKey(_ account: String, bytes: Int = 32) -> String? {
        if let existing = read(account), existing.count == bytes * 2 { return existing }
        var raw = [UInt8](repeating: 0, count: bytes)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes, &raw) == errSecSuccess else { return nil }
        let hex = raw.map { String(format: "%02x", $0) }.joined()
        return write(account, hex) ? hex : nil
    }
}
