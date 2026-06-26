import SwiftUI

/// Approval inbox: pending consequential grants the kernel is holding. Approve
/// resolves the grant; deny rejects it with a reason. This is the human-in-the-
/// loop gate for consequential actions.
public struct ApprovalsView: View {
    @ObservedObject var model: ControlPlaneModel
    @State private var denyTarget: Approval?
    @State private var denyReason = ""

    public init(model: ControlPlaneModel) { self.model = model }

    public var body: some View {
        Group {
            if model.approvals.isEmpty {
                ContentUnavailableMessage("No pending approvals")
            } else {
                List(model.approvals) { a in
                    VStack(alignment: .leading, spacing: 6) {
                        Text(a.summary).font(.headline)
                        HStack(spacing: 8) {
                            Label(a.actionType, systemImage: "bolt").font(.caption)
                            Label(a.origin, systemImage: "globe").font(.caption).lineLimit(1)
                        }.foregroundStyle(.secondary)
                        Text("session \(a.sessionId.prefix(8))").font(.caption2).foregroundStyle(.tertiary)
                        HStack {
                            Button("Approve") { Task { await model.approve(a) } }
                                .buttonStyle(.borderedProminent)
                            Button("Deny") { denyTarget = a; denyReason = "" }
                                .buttonStyle(.bordered)
                        }
                    }
                    .padding(.vertical, 4)
                }
            }
        }
        .navigationTitle("Approvals")
        .sheet(item: $denyTarget) { a in
            VStack(alignment: .leading, spacing: 12) {
                Text("Deny: \(a.summary)").font(.headline)
                TextField("Reason", text: $denyReason)
                    .textFieldStyle(.roundedBorder)
                HStack {
                    Spacer()
                    Button("Cancel") { denyTarget = nil }
                    Button("Deny") {
                        Task { await model.deny(a, reason: denyReason.isEmpty ? "denied by operator" : denyReason) }
                        denyTarget = nil
                    }.buttonStyle(.borderedProminent)
                }
            }
            .padding(20).frame(width: 360)
        }
    }
}
