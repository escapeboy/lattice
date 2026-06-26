import SwiftUI

/// Replay browser: past session traces with governance metrics; selecting one
/// loads its redacted event timeline ("what it saw vs what it did") from the
/// JSON trace-detail endpoint.
public struct ReplayView: View {
    @ObservedObject var model: ControlPlaneModel
    @State private var selected: TraceSummary.ID?

    public init(model: ControlPlaneModel) { self.model = model }

    public var body: some View {
        HSplitView {
            Group {
                if model.traces.isEmpty {
                    ContentUnavailableMessage("No recorded sessions yet")
                } else {
                    Table(model.traces, selection: $selected) {
                        TableColumn("Session") { t in
                            Text(t.sessionId.prefix(8)).font(.system(.body, design: .monospaced))
                        }
                        TableColumn("Actions") { t in Text("\(t.totalActions)") }
                        TableColumn("Success") { t in
                            Text("\(Int((t.successRate * 100).rounded()))%")
                                .foregroundStyle(t.successRate >= 0.9 ? .green : (t.successRate >= 0.5 ? .orange : .red))
                        }
                        TableColumn("Duration") { t in Text(format(ms: t.durationMs)) }
                    }
                }
            }
            .frame(minWidth: 320)

            if let id = selected {
                TraceTimelineView(traceId: id, model: model).frame(minWidth: 280)
            } else {
                ContentUnavailableMessage("Select a session to see its timeline").frame(minWidth: 280)
            }
        }
        .navigationTitle("Replay")
    }

    private func format(ms: Double) -> String {
        ms < 1000 ? "\(Int(ms)) ms" : String(format: "%.1f s", ms / 1000)
    }
}

/// The redacted event timeline for one trace.
struct TraceTimelineView: View {
    let traceId: String
    @ObservedObject var model: ControlPlaneModel
    @State private var rows: [TraceEventRow] = []
    @State private var loading = true

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Timeline · \(traceId.prefix(8))").font(.headline).padding(.bottom, 2)
            if loading {
                ProgressView().frame(maxWidth: .infinity)
            } else if rows.isEmpty {
                ContentUnavailableMessage("No events")
            } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: 3) {
                        ForEach(rows) { r in
                            HStack(alignment: .top, spacing: 8) {
                                Text("+\(Int(r.rel))ms").font(.caption2.monospaced()).foregroundStyle(.tertiary)
                                    .frame(width: 64, alignment: .trailing)
                                Text(r.lane).font(.caption2.weight(.semibold)).foregroundStyle(lane(r.lane))
                                    .frame(width: 56, alignment: .leading)
                                Text(r.text).font(.system(.caption, design: .monospaced))
                            }
                        }
                    }.frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
        .padding(12)
        .task(id: traceId) {
            loading = true
            rows = await model.replayEvents(traceId)
            loading = false
        }
    }

    private func lane(_ l: String) -> Color {
        switch l {
        case "perceive": return .blue
        case "act": return .purple
        case "gate": return .orange
        case "net": return .teal
        default: return .secondary
        }
    }
}
