import SwiftUI

/// The popover shown from the menubar item. Reflects live stack state from the
/// supervisor (D2). Session list / theater / approvals land in D3–D4.
public struct MenuBarContent: View {
    @ObservedObject private var stack: StackController

    public init(stack: StackController) {
        self.stack = stack
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
                Text(statusText).font(.caption)
            }

            Divider()

            Button("Quit Lattice") {
                NSApplication.shared.terminate(nil)
            }
            .keyboardShortcut("q")
        }
        .padding(12)
        .frame(width: 240)
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
    /// SF Symbol for the menubar item, tinted by liveness.
    var menubarSymbol: String {
        switch state {
        case .running: return "shield.lefthalf.filled"
        case .failed: return "shield.slash"
        default: return "shield"
        }
    }
}
