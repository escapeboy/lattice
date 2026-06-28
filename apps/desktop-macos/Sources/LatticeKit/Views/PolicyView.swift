import SwiftUI

/// Policy editor: view and edit the kernel's policy (allowed origins, egress
/// allowlist, prohibited actions, actions that require a grant). Save PUTs the
/// updated policy to the control plane, which keeps the live kernel in sync.
public struct PolicyView: View {
    @ObservedObject var model: ControlPlaneModel
    @State private var draft = Policy()
    @State private var loaded = false
    // Which action list (by title) is currently showing the "Custom…" field, and its text.
    @State private var customTarget: String?
    @State private var customText = ""
    @State private var saving = false
    @State private var saveResult: (text: String, ok: Bool)?

    public init(model: ControlPlaneModel) { self.model = model }

    public var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                Text("Rules the governance kernel enforces on every agent action. Edit, then Save to push them live.")
                    .font(.callout).foregroundStyle(.secondary)
                if let saveResult { OutcomeLine(text: saveResult.text, ok: saveResult.ok) }
                listEditor("Allowed origins", \.allowedOrigins,
                           hint: "Sites the agent may OPEN (navigate to). Empty = any site (dev). e.g. https://github.com")
                listEditor("Egress allowlist", \.egressAllowlist,
                           hint: "Network destinations any loaded page may CONTACT — the egress firewall around sub-requests (APIs, trackers, CDNs). Empty = unrestricted.")
                actionListEditor("Prohibited actions", \.prohibitedActions,
                           hint: "Action types that are ALWAYS blocked — no human grant can override (e.g. payment, account.create).")
                actionListEditor("Require grant", \.requireGrant,
                           hint: "Action types allowed only after you approve them in the moment (e.g. submit, checkout, delete).")
            }
            .padding(16)
        }
        .navigationTitle("Policy")
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                HStack(spacing: 6) {
                    if saving { ProgressView().controlSize(.small) }
                    Button("Save") {
                        saving = true; saveResult = nil
                        Task {
                            let ok = await model.savePolicy(draft)
                            saving = false
                            saveResult = (ok ? "Policy saved — pushed live to the kernel." : (model.lastError ?? "Save failed."), ok)
                        }
                    }
                    .disabled(model.policy == draft || saving)
                }
            }
            ToolbarItem(placement: .cancellationAction) {
                Button("Revert") { if let p = model.policy { draft = p }; saveResult = nil }
                    .disabled(model.policy == draft)
            }
        }
        .onChange(of: model.policy) { p in if let p, !loaded { draft = p; loaded = true } }
        .onChange(of: draft) { _ in saveResult = nil } // stale "saved" once edits resume
        .onAppear { if let p = model.policy { draft = p; loaded = true } }
        .task { await model.loadActionCatalog() }
    }

    private func listEditor(_ title: String, _ keyPath: WritableKeyPath<Policy, [String]>, hint: String) -> some View {
        LabeledSection(title: title, hint: hint) {
            ForEach(draft[keyPath: keyPath].indices, id: \.self) { i in
                RemovableRow(removeLabel: "Remove \(title) entry",
                             onRemove: { draft[keyPath: keyPath].remove(at: i) }) {
                    TextField("", text: Binding(
                        get: { draft[keyPath: keyPath][i] },
                        set: { draft[keyPath: keyPath][i] = $0 }))
                        .textFieldStyle(.roundedBorder)
                }
            }
            Button {
                draft[keyPath: keyPath].append("")
            } label: { Label("Add", systemImage: "plus") }
                .buttonStyle(.borderless).font(.caption)
        }
    }

    /// Like `listEditor`, but entries are PICKED from the known-action catalog
    /// instead of typed. Existing entries show as read-only chips; "Add" is a menu
    /// of catalog types not yet present, plus a "Custom…" escape for bespoke types.
    private func actionListEditor(_ title: String, _ keyPath: WritableKeyPath<Policy, [String]>, hint: String) -> some View {
        LabeledSection(title: title, hint: hint) {
            ForEach(draft[keyPath: keyPath].indices, id: \.self) { i in
                RemovableRow(removeLabel: "Remove \(draft[keyPath: keyPath][i])",
                             onRemove: { draft[keyPath: keyPath].remove(at: i) }) {
                    Text(draft[keyPath: keyPath][i]).font(.callout.monospaced())
                    Spacer()
                }
            }
            let present = Set(draft[keyPath: keyPath])
            Menu {
                ForEach(model.actionCatalog.filter { !present.contains($0.value) }) { item in
                    Button("\(item.value) — \(item.label)") { draft[keyPath: keyPath].append(item.value) }
                }
                Divider()
                Button("Custom…") { customText = ""; customTarget = title }
            } label: {
                Label("Add", systemImage: "plus")
            }
            .menuStyle(.borderlessButton).fixedSize().font(.caption)

            if customTarget == title {
                HStack(spacing: 6) {
                    TextField("custom action type", text: $customText)
                        .textFieldStyle(.roundedBorder)
                    Button("Add") {
                        let v = customText.trimmingCharacters(in: .whitespaces)
                        if !v.isEmpty, !present.contains(v) { draft[keyPath: keyPath].append(v) }
                        customText = ""; customTarget = nil
                    }.disabled(customText.trimmingCharacters(in: .whitespaces).isEmpty)
                    Button("Cancel") { customText = ""; customTarget = nil }
                }
            }
        }
    }
}
