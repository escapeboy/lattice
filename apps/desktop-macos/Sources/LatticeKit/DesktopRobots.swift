import Foundation

/// Desktop robots.txt navigation-gate setting (obey-robots).
///
/// When ON, the backend honors each target origin's robots.txt before
/// navigating (`LATTICE_OBEY_ROBOTS=1`) — a politeness gate borrowed from
/// Lightpanda's `--obey-robots`, routed through the same governed transport as
/// browser traffic. OFF by default (an operator-driven browser is not a crawler
/// by default). A preference (UserDefaults); the stack reads it as env at boot,
/// so applying a change restarts the backend. The app's own env wins over the
/// stored setting — same precedence as the search/approval-timeout settings.
public enum DesktopRobots {
    private static let obeyKey = "net.lattice.obeyRobots"

    public static var obey: Bool {
        get { UserDefaults.standard.bool(forKey: obeyKey) }
        set { UserDefaults.standard.set(newValue, forKey: obeyKey) }
    }

    /// Backend env for the robots gate. Empty when off (nothing to pass).
    public static func environment() -> [String: String] {
        environment(appEnv: ProcessInfo.processInfo.environment)
    }

    /// Testable core: the app-process env overrides the stored setting wholesale.
    static func environment(appEnv: [String: String]) -> [String: String] {
        if let v = appEnv["LATTICE_OBEY_ROBOTS"] { return ["LATTICE_OBEY_ROBOTS": v] }
        return obey ? ["LATTICE_OBEY_ROBOTS": "1"] : [:]
    }
}
