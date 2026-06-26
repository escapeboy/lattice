import SwiftUI

/// The popover shown from the menubar item. D0: static placeholder. The live
/// stack status (D2), session list (D3/D4) and quit-tears-down-the-stack wiring
/// land in later steps.
struct MenuBarContent: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Image(systemName: "shield.lefthalf.filled")
                Text("Lattice").font(.headline)
            }
            Text("Governance browser runtime")
                .font(.caption)
                .foregroundStyle(.secondary)

            Divider()

            Text("Stack: not started")
                .font(.caption)
                .foregroundStyle(.secondary)

            Divider()

            Button("Quit Lattice") {
                NSApplication.shared.terminate(nil)
            }
            .keyboardShortcut("q")
        }
        .padding(12)
        .frame(width: 240)
    }
}
