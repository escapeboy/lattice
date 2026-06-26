import SwiftUI

/// Policy editor: view and edit the kernel's policy (allowed origins, egress
/// allowlist, prohibited actions, actions that require a grant). Save PUTs the
/// updated policy to the control plane, which keeps the live kernel in sync.
public struct PolicyView: View {
    @ObservedObject var model: ControlPlaneModel
    @State private var draft = Policy()
    @State private var loaded = false

    public init(model: ControlPlaneModel) { self.model = model }

    public var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                listEditor("Allowed origins", \.allowedOrigins,
                           hint: "Empty = unrestricted (dev). Set to scope navigation.")
                listEditor("Egress allowlist", \.egressAllowlist,
                           hint: "Destinations the browser may reach (egress firewall).")
                listEditor("Prohibited actions", \.prohibitedActions,
                           hint: "Always blocked, regardless of grant.")
                listEditor("Require grant", \.requireGrant,
                           hint: "Consequential actions that need human approval.")
            }
            .padding(16)
        }
        .navigationTitle("Policy")
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button("Save") { Task { await model.savePolicy(draft) } }
                    .disabled(model.policy == draft)
            }
            ToolbarItem(placement: .cancellationAction) {
                Button("Revert") { if let p = model.policy { draft = p } }
                    .disabled(model.policy == draft)
            }
        }
        .onChange(of: model.policy) { p in if let p, !loaded { draft = p; loaded = true } }
        .onAppear { if let p = model.policy { draft = p; loaded = true } }
    }

    private func listEditor(_ title: String, _ keyPath: WritableKeyPath<Policy, [String]>, hint: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title).font(.headline)
            Text(hint).font(.caption).foregroundStyle(.secondary)
            ForEach(draft[keyPath: keyPath].indices, id: \.self) { i in
                HStack {
                    TextField("", text: Binding(
                        get: { draft[keyPath: keyPath][i] },
                        set: { draft[keyPath: keyPath][i] = $0 }))
                        .textFieldStyle(.roundedBorder)
                    Button(role: .destructive) {
                        draft[keyPath: keyPath].remove(at: i)
                    } label: { Image(systemName: "minus.circle") }
                        .buttonStyle(.borderless)
                }
            }
            Button {
                draft[keyPath: keyPath].append("")
            } label: { Label("Add", systemImage: "plus") }
                .buttonStyle(.borderless).font(.caption)
        }
    }
}
