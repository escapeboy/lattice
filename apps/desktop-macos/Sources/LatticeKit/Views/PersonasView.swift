import SwiftUI

/// Personas & Vault manager. Reads the operator surfaces: personas (id + cookie
/// origins + live sessions) and vault entries (id / origin / label — never any
/// credential value). The vault key is held in the macOS Keychain (D5).
public struct PersonasView: View {
    @ObservedObject var model: ControlPlaneModel

    @State private var importPersonaId = ""
    @State private var importProfile = "Default"
    @State private var importOrigins = ""
    @State private var importing = false
    @State private var importResult: String?

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

                section("Import browser session", systemImage: "square.and.arrow.down") {
                    Text("Bring your logged-in cookies from Chrome into a persona — the agent then browses as you. Cookies are read & decrypted locally (the Keychain may prompt); raw values never reach the model or agent.")
                        .font(.caption).foregroundStyle(.secondary)
                    TextField("Persona name (e.g. me)", text: $importPersonaId).textFieldStyle(.roundedBorder)
                    TextField("Chrome profile (e.g. Default)", text: $importProfile).textFieldStyle(.roundedBorder)
                    TextField("Origins, comma-separated (e.g. https://github.com)", text: $importOrigins).textFieldStyle(.roundedBorder)
                    HStack(spacing: 8) {
                        Button {
                            let origins = importOrigins
                                .split(separator: ",")
                                .map { $0.trimmingCharacters(in: .whitespaces) }
                                .filter { !$0.isEmpty }
                            guard !importPersonaId.isEmpty, !origins.isEmpty else {
                                importResult = "Enter a persona name and at least one origin."
                                return
                            }
                            importing = true; importResult = nil
                            Task {
                                let n = await model.importPersona(
                                    personaId: importPersonaId,
                                    profile: importProfile.isEmpty ? "Default" : importProfile,
                                    origins: origins)
                                importing = false
                                importResult = n.map { "Imported \($0) cookie(s) into “\(importPersonaId)”." }
                                    ?? (model.lastError ?? "Import failed.")
                            }
                        } label: { Label("Import from Chrome", systemImage: "square.and.arrow.down") }
                        .disabled(importing || importPersonaId.isEmpty || importOrigins.isEmpty)
                        if importing { ProgressView().controlSize(.small) }
                    }
                    if let importResult { Text(importResult).font(.caption).foregroundStyle(.secondary) }
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
