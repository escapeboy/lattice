import SwiftUI

/// Personas & Vault manager. Reads the operator surfaces: personas (id + cookie
/// origins + live sessions) and vault entries (id / origin / label — never any
/// credential value). The vault key is held in the macOS Keychain (D5).
public struct PersonasView: View {
    @ObservedObject var model: ControlPlaneModel

    public init(model: ControlPlaneModel) { self.model = model }

    public var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                section("Personas", systemImage: "person.crop.circle") {
                    if model.personas.isEmpty {
                        Text("No personas yet. Persistent sessions with a personaId create them.")
                            .font(.callout).foregroundStyle(.secondary)
                    } else {
                        ForEach(model.personas) { p in
                            VStack(alignment: .leading, spacing: 2) {
                                Text(p.personaId).font(.callout.weight(.medium))
                                Text("\(p.sessions) live · origins: \(p.origins.isEmpty ? "—" : p.origins.joined(separator: ", "))")
                                    .font(.caption).foregroundStyle(.secondary)
                            }
                        }
                    }
                }

                Divider()

                section("Vault", systemImage: "key.horizontal") {
                    Label("Credentials are encrypted with a key held in the macOS Keychain; values never pass through the model or agent.", systemImage: "lock.shield")
                        .font(.caption).foregroundStyle(.secondary)
                    if model.vault.isEmpty {
                        Text("No stored credentials.").font(.callout).foregroundStyle(.secondary)
                    } else {
                        ForEach(model.vault) { v in
                            HStack(spacing: 8) {
                                Image(systemName: "key.fill").foregroundStyle(.tertiary)
                                VStack(alignment: .leading, spacing: 1) {
                                    Text(v.label).font(.callout)
                                    Text(v.origin).font(.caption).foregroundStyle(.secondary)
                                }
                                Spacer()
                                Text(v.id.prefix(8)).font(.caption2.monospaced()).foregroundStyle(.tertiary)
                            }
                        }
                    }
                }
            }
            .padding(16)
        }
        .navigationTitle("Personas & Vault")
    }

    @ViewBuilder
    private func section<Content: View>(_ title: String, systemImage: String, @ViewBuilder _ content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(title, systemImage: systemImage).font(.headline)
            content()
        }
    }
}
