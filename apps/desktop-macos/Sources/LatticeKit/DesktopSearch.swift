import Foundation

/// Desktop search-provider settings (search_query backend selection).
///
/// The provider kind and the SearXNG instance URL are preferences
/// (UserDefaults); the Brave API key is a SECRET and lives in the macOS
/// Keychain (never UserDefaults, never rendered back into the UI). The stack
/// reads these as env at boot (`LATTICE_SEARCH_PROVIDER` / `LATTICE_BRAVE_KEY`
/// / `LATTICE_SEARXNG_URL`), so applying a change restarts the backend.
///
/// Env set on the app's own process wins over the stored settings — same
/// precedence as LATTICE_APPROVAL_TIMEOUT_MS in StackController.
public enum DesktopSearch {
    public enum Provider: String, CaseIterable, Identifiable {
        case ddg
        case brave
        case searxng
        public var id: String { rawValue }
        public var label: String {
            switch self {
            case .ddg: return "DuckDuckGo (default — no key)"
            case .brave: return "Brave (your API key)"
            case .searxng: return "SearXNG (self-hosted URL)"
            }
        }
    }

    private static let providerKey = "net.lattice.searchProvider"
    private static let searxngUrlKey = "net.lattice.searxngUrl"
    /// Keychain account for the Brave Search API key (service net.lattice.desktop).
    static let braveKeyAccount = "brave-search-key"

    public static var provider: Provider {
        get {
            guard let raw = UserDefaults.standard.string(forKey: providerKey),
                  let p = Provider(rawValue: raw) else { return .ddg }
            return p
        }
        set { UserDefaults.standard.set(newValue.rawValue, forKey: providerKey) }
    }

    public static var searxngUrl: String {
        get { UserDefaults.standard.string(forKey: searxngUrlKey) ?? "" }
        set { UserDefaults.standard.set(newValue.trimmingCharacters(in: .whitespaces), forKey: searxngUrlKey) }
    }

    /// Whether a Brave key is stored. The value itself is never read back into
    /// the UI — only replaced or removed.
    public static var hasBraveKey: Bool { KeychainStore.read(braveKeyAccount) != nil }

    @discardableResult
    public static func setBraveKey(_ key: String) -> Bool {
        let trimmed = key.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty else { return false }
        return KeychainStore.write(braveKeyAccount, trimmed)
    }

    public static func removeBraveKey() {
        KeychainStore.delete(braveKeyAccount)
    }

    /// True when `url` is a usable SearXNG base URL (http/https with a host).
    public static func isValidSearxngUrl(_ url: String) -> Bool {
        guard let u = URL(string: url.trimmingCharacters(in: .whitespaces)),
              let scheme = u.scheme?.lowercased(),
              scheme == "http" || scheme == "https",
              let host = u.host, !host.isEmpty else { return false }
        return true
    }

    /// Backend env for the selected provider. Only what the selection needs is
    /// passed (the Brave key never rides the env of a non-Brave run).
    public static func environment() -> [String: String] {
        environment(
            appEnv: ProcessInfo.processInfo.environment,
            braveKey: KeychainStore.read(braveKeyAccount))
    }

    /// Testable core: pure function of the stored settings + injected secrets.
    static func environment(appEnv: [String: String], braveKey: String?) -> [String: String] {
        var env: [String: String] = [:]
        // App-process env overrides the stored settings wholesale.
        if appEnv["LATTICE_SEARCH_PROVIDER"] != nil || appEnv["LATTICE_BRAVE_KEY"] != nil || appEnv["LATTICE_SEARXNG_URL"] != nil {
            for k in ["LATTICE_SEARCH_PROVIDER", "LATTICE_BRAVE_KEY", "LATTICE_SEARXNG_URL"] {
                if let v = appEnv[k] { env[k] = v }
            }
            return env
        }
        let p = provider
        env["LATTICE_SEARCH_PROVIDER"] = p.rawValue
        switch p {
        case .ddg:
            break
        case .brave:
            if let key = braveKey { env["LATTICE_BRAVE_KEY"] = key }
        case .searxng:
            if isValidSearxngUrl(searxngUrl) { env["LATTICE_SEARXNG_URL"] = searxngUrl }
        }
        return env
    }
}
