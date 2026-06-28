import SwiftUI

/// "Needs you" surface: consequential-action grants the kernel is holding AND
/// human handoffs the agent raised at a wall (login / 2FA / confirm). Approve a
/// grant, approve/deny a handoff, or type a value (e.g. a 2FA code) for an input
/// handoff — the value flows Vault→form, never through the agent.
public struct ApprovalsView: View {
    @ObservedObject var model: ControlPlaneModel
    @State private var denyTarget: Approval?
    @State private var denyReason = ""
    @State private var busy: String?
    @State private var outcome: (text: String, ok: Bool)?
    @State private var inputValues: [String: String] = [:] // per input-handoff id

    public init(model: ControlPlaneModel) { self.model = model }

    private var pendingHandoffs: [Handoff] { model.handoffs.filter { $0.status == "pending" } }

    public var body: some View {
        Group {
            if pendingHandoffs.isEmpty && model.approvals.isEmpty {
                ContentUnavailableMessage("Nothing needs you right now", systemImage: "checkmark.shield")
            } else {
                List {
                    if !pendingHandoffs.isEmpty {
                        Section("Agent waiting for you") {
                            ForEach(pendingHandoffs) { h in handoffRow(h) }
                        }
                    }
                    if !model.approvals.isEmpty {
                        Section("Consequential actions") {
                            ForEach(model.approvals) { a in approvalRow(a) }
                        }
                    }
                }
            }
        }
        .safeAreaInset(edge: .top) {
            if let outcome {
                OutcomeLine(text: outcome.text, ok: outcome.ok)
                    .padding(.horizontal, 12).padding(.vertical, 6)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(.thinMaterial)
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
                        let reason = denyReason.isEmpty ? "denied by operator" : denyReason
                        busy = a.id; outcome = nil; denyTarget = nil
                        Task {
                            let ok = await model.deny(a, reason: reason)
                            busy = nil
                            outcome = (ok ? "Denied “\(a.summary)”." : (model.lastError ?? "Deny failed."), ok)
                        }
                    }.buttonStyle(.borderedProminent)
                }
            }
            .padding(20).frame(width: 360)
        }
    }

    // MARK: rows

    @ViewBuilder
    private func approvalRow(_ a: Approval) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(a.summary).font(.headline)
            HStack(spacing: 8) {
                Label(a.actionType, systemImage: "bolt").font(.caption)
                Label(a.origin, systemImage: "globe").font(.caption).lineLimit(1)
            }.foregroundStyle(.secondary)
            Text("session \(a.sessionId.prefix(8))").font(.caption2).foregroundStyle(.tertiary)
            HStack(spacing: 8) {
                Button("Approve") {
                    busy = a.id; outcome = nil
                    Task {
                        let ok = await model.approve(a)
                        busy = nil
                        outcome = (ok ? "Approved “\(a.summary)”." : (model.lastError ?? "Approve failed."), ok)
                    }
                }
                .buttonStyle(.borderedProminent).disabled(busy != nil)
                Button("Deny") { denyTarget = a; denyReason = "" }
                    .buttonStyle(.bordered).disabled(busy != nil)
                if busy == a.id { ProgressView().controlSize(.small) }
            }
        }
        .padding(.vertical, 4)
    }

    @ViewBuilder
    private func handoffRow(_ h: Handoff) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Label(h.reason, systemImage: h.type == "input" ? "keyboard" : "hand.raised")
                .font(.headline)
            if !h.origin.isEmpty {
                Label(h.origin, systemImage: "globe").font(.caption).foregroundStyle(.secondary).lineLimit(1)
            }
            if h.type == "input" {
                HStack(spacing: 8) {
                    SecureField(h.field ?? "value", text: Binding(
                        get: { inputValues[h.id] ?? "" },
                        set: { inputValues[h.id] = $0 }))
                        .textFieldStyle(.roundedBorder)
                    Button("Send to form") {
                        let value = inputValues[h.id] ?? ""
                        busy = h.id; outcome = nil
                        Task {
                            let ok = await model.submitHandoffInput(h, value: value)
                            busy = nil
                            inputValues[h.id] = ""
                            outcome = (ok ? "Sent to the form." : (model.lastError ?? "Send failed."), ok)
                        }
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(busy != nil || (inputValues[h.id] ?? "").isEmpty)
                    if busy == h.id { ProgressView().controlSize(.small) }
                }
                Text("The value is typed straight into the page — it never passes through the agent.")
                    .font(.caption2).foregroundStyle(.tertiary)
            } else {
                HStack(spacing: 8) {
                    Button("Approve") {
                        busy = h.id; outcome = nil
                        Task {
                            let ok = await model.resolveHandoff(h, approved: true)
                            busy = nil
                            outcome = (ok ? "Approved." : (model.lastError ?? "Failed."), ok)
                        }
                    }
                    .buttonStyle(.borderedProminent).disabled(busy != nil)
                    Button("Deny") {
                        busy = h.id; outcome = nil
                        Task {
                            let ok = await model.resolveHandoff(h, approved: false)
                            busy = nil
                            outcome = (ok ? "Denied." : (model.lastError ?? "Failed."), ok)
                        }
                    }
                    .buttonStyle(.bordered).disabled(busy != nil)
                    if busy == h.id { ProgressView().controlSize(.small) }
                }
            }
        }
        .padding(.vertical, 4)
    }
}
