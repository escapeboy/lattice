import SwiftUI

/// The popover shown from the menubar item. Reflects live stack state from the
/// supervisor (D2). Session list / theater / approvals land in D3–D4.
public struct MenuBarContent: View {
    @ObservedObject private var stack: StackController
    /// Opens the control-plane window. Injected by the AppKit status-bar
    /// controller (the popover is hosted outside the SwiftUI scene graph, so
    /// `@Environment(\.openWindow)` isn't available here).
    private let onOpenControlPlane: () -> Void

    public init(stack: StackController, onOpenControlPlane: @escaping () -> Void = {}) {
        self.stack = stack
        self.onOpenControlPlane = onOpenControlPlane
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Image(systemName: "shield.lefthalf.filled")
                Text("Lattice").font(.headline)
            }
            Text("Governance browser runtime")
                .font(.caption)
                .foregroundStyle(.secondary)

            Divider()

            HStack(spacing: 6) {
                Circle().fill(statusColor).frame(width: 8, height: 8)
                    .accessibilityHidden(true) // statusText conveys the same state
                Text(statusText).font(.caption)
            }

            if stack.firstRunNeeded {
                Label("First-run: set up the egress firewall", systemImage: "exclamationmark.triangle")
                    .font(.caption).foregroundStyle(.orange)
            }

            if stack.needsAttention > 0 {
                Button {
                    onOpenControlPlane()
                } label: {
                    Label("\(stack.needsAttention) item\(stack.needsAttention == 1 ? "" : "s") need your attention",
                          systemImage: "exclamationmark.shield.fill")
                        .font(.caption).foregroundStyle(.orange)
                }
                .buttonStyle(.plain)
            }

            Divider()

            Button(stack.firstRunNeeded ? "Set up Lattice…" : "Open Control Plane…") {
                onOpenControlPlane()
            }
            .disabled(!isRunning && !stack.firstRunNeeded)

            Button("Check for Updates…") {
                UpdaterController.shared.checkForUpdates()
            }

            Button("Quit Lattice") {
                NSApplication.shared.terminate(nil)
            }
            .keyboardShortcut("q")
        }
        .padding(12)
        .frame(width: 240)
    }

    private var isRunning: Bool {
        if case .running = stack.state { return true }
        return false
    }

    private var statusText: String {
        switch stack.state {
        case .stopped: return "Stack: stopped"
        case .starting: return "Stack: starting…"
        case .running: return "Stack: running"
        case .restarting(let n): return "Stack: restarting (attempt \(n))…"
        case .failed(let msg): return "Stack: failed — \(msg)"
        }
    }

    private var statusColor: Color {
        switch stack.state {
        case .running: return .green
        case .starting, .restarting: return .yellow
        case .failed: return .red
        case .stopped: return .gray
        }
    }
}

public extension StackController {
    /// SF Symbol for the menubar item, tinted by liveness. A pending approval
    /// raises an attention badge so a blocked agent action is visible even when
    /// the window is closed.
    var menubarSymbol: String {
        if needsAttention > 0 { return "exclamationmark.shield.fill" }
        switch state {
        case .running: return "shield.lefthalf.filled"
        case .failed: return "shield.slash"
        default: return "shield"
        }
    }
}
