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
                Text("Deny: \(a.action ?? a.summary)").font(.headline)
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
                            outcome = (ok ? "Denied “\(a.action ?? a.summary)”." : (model.lastError ?? "Deny failed."), ok)
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
            // WHAT: human-readable action + policy badge.
            HStack(spacing: 6) {
                Text(a.action ?? a.summary).font(.headline)
                Chip(text: a.policyClass ?? "consequential", systemImage: "bolt", tint: .orange)
            }
            // WHERE + which verb: full origin (never just an icon) + action type.
            HStack(spacing: 6) {
                if !a.origin.isEmpty { Chip(text: a.origin, systemImage: "globe") }
                Chip(text: a.actionType, systemImage: "arrow.right.circle")
            }
            // WHY it needs approval.
            if let why = a.why, !why.isEmpty {
                Text(why).font(.caption).foregroundStyle(.secondary)
            }
            // Data preview — a masked field NEVER renders a raw value.
            if let fields = a.fields, !fields.isEmpty {
                let data = fields.map { "\($0.label)=\($0.masked ? "••••" : $0.value)" }.joined(separator: ", ")
                (Text("Data: ").bold() + Text(data))
                    .font(.caption).foregroundStyle(.primary)
            }
            // Agent-declared intent — UNTRUSTED. Rendered verbatim (no markdown)
            // and labelled, so page/agent text can't masquerade as UI.
            if let intent = a.intent, !intent.isEmpty {
                HStack(alignment: .top, spacing: 4) {
                    Image(systemName: "bubble.left").imageScale(.small).foregroundStyle(.tertiary)
                    (Text("agent intent (untrusted): ").italic() + Text(verbatim: intent))
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
            // Timeout fallback: when a per-policy timeout is set, show the deadline.
            if let exp = a.expiresAt {
                Label("auto-denies in \(timeLeft(exp))", systemImage: "clock")
                    .font(.caption2).foregroundStyle(.tertiary)
            }
            Text("session \(a.sessionId.prefix(8))").font(.caption2).foregroundStyle(.tertiary)
            // Explicit on-approve/deny semantics: Approve → the action dispatches;
            // Deny → it is blocked and the agent receives a typed refusal.
            HStack(spacing: 8) {
                Button("Approve → dispatch") {
                    busy = a.id; outcome = nil
                    Task {
                        let ok = await model.approve(a)
                        busy = nil
                        outcome = (ok ? "Approved “\(a.action ?? a.summary)” — dispatched." : (model.lastError ?? "Approve failed."), ok)
                    }
                }
                .buttonStyle(.borderedProminent).disabled(busy != nil)
                Button("Deny → block") { denyTarget = a; denyReason = "" }
                    .buttonStyle(.bordered).disabled(busy != nil)
                if busy == a.id { ProgressView().controlSize(.small) }
            }
        }
        .padding(.vertical, 4)
    }

    /// Time remaining until an epoch-ms deadline, for the timeout countdown.
    private func timeLeft(_ epochMs: Double) -> String {
        let secs = max(0, Int((epochMs - Date().timeIntervalSince1970 * 1000) / 1000))
        return secs >= 60 ? "\(secs / 60)m" : "\(secs)s"
    }

    @ViewBuilder
    private func handoffRow(_ h: Handoff) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Label(h.reason, systemImage: h.type == "input" ? "keyboard" : "hand.raised")
                .font(.headline)
            if !h.origin.isEmpty {
                Chip(text: h.origin, systemImage: "globe")
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
