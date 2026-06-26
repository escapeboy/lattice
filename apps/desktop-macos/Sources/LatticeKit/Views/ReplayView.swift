import SwiftUI

/// Replay browser: past session traces with their governance metrics (action
/// count, success rate, duration). The control plane exposes trace summaries +
/// PII-gated full traces; this lists the summaries.
public struct ReplayView: View {
    @ObservedObject var model: ControlPlaneModel

    public init(model: ControlPlaneModel) { self.model = model }

    public var body: some View {
        Group {
            if model.traces.isEmpty {
                ContentUnavailableMessage("No recorded sessions yet")
            } else {
                Table(model.traces) {
                    TableColumn("Session") { t in
                        Text(t.sessionId.prefix(8)).font(.system(.body, design: .monospaced))
                    }
                    TableColumn("Actions") { t in Text("\(t.totalActions)") }
                    TableColumn("Success") { t in
                        Text("\(Int((t.successRate * 100).rounded()))%")
                            .foregroundStyle(t.successRate >= 0.9 ? .green : (t.successRate >= 0.5 ? .orange : .red))
                    }
                    TableColumn("Duration") { t in Text(format(ms: t.durationMs)) }
                    TableColumn("Trace") { t in
                        Text(t.traceId.prefix(8)).font(.system(.caption, design: .monospaced))
                            .foregroundStyle(.secondary)
                    }
                }
            }
        }
        .navigationTitle("Replay")
    }

    private func format(ms: Double) -> String {
        ms < 1000 ? "\(Int(ms)) ms" : String(format: "%.1f s", ms / 1000)
    }
}
