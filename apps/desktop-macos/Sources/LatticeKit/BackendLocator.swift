import Foundation

/// Finds the embedded backend and the app's data directory.
public enum BackendLocator {
    /// Resolve the `lattice-backend` executable. Order:
    ///   1. `LATTICE_BACKEND_DIR` env (dev / tests) → `<dir>/lattice-backend`
    ///   2. the app bundle → `Contents/Resources/backend/lattice-backend`
    public static func backendBinary() -> URL? {
        if let dir = ProcessInfo.processInfo.environment["LATTICE_BACKEND_DIR"] {
            let u = URL(fileURLWithPath: dir).appendingPathComponent("lattice-backend")
            if FileManager.default.isExecutableFile(atPath: u.path) { return u }
        }
        if let res = Bundle.main.resourceURL {
            let u = res.appendingPathComponent("backend/lattice-backend")
            if FileManager.default.isExecutableFile(atPath: u.path) { return u }
        }
        return nil
    }

    /// Per-user data dir: `~/Library/Application Support/Lattice`. Created if
    /// absent. Traces, vault, and the backend log live here.
    public static func appSupportDirectory() -> URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSTemporaryDirectory())
        let dir = base.appendingPathComponent("Lattice", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }
}
