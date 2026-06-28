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

    // Per-provider connect inputs (keyed by provider id).
    @State private var providerScope: [String: String] = [:]
    @State private var providerSession: [String: String] = [:]
    @State private var providerBusy: String?
    @State private var providerResult: [String: String] = [:]

    // Local "Add login" form.
    @State private var addOrigin = ""
    @State private var addUsername = ""
    @State private var addPassword = ""
    @State private var addBusy = false
    @State private var addResult: String?

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
                    if model.chromeProfiles.isEmpty {
                        // No profiles detected (Chrome not installed, or probe not
                        // yet loaded) — keep a manual field so import still works.
                        TextField("Chrome profile (e.g. Default)", text: $importProfile).textFieldStyle(.roundedBorder)
                    } else {
                        Picker("Chrome profile", selection: $importProfile) {
                            ForEach(model.chromeProfiles) { p in
                                Text(p.name == p.dir ? p.dir : "\(p.name) (\(p.dir))").tag(p.dir)
                            }
                        }
                        .pickerStyle(.menu)
                    }
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

                section("Password managers", systemImage: "lock.rectangle.on.rectangle") {
                    Text("Connect a manager once — its logins become available to the agent, matched automatically by website. When a password is needed, Lattice reads it on demand (your manager unlocks it) and types it straight into the page; the value never reaches the model or agent.")
                        .font(.caption).foregroundStyle(.secondary)
                    ForEach(model.providers) { p in providerRow(p) }
                }

                Divider()

                section("Add login", systemImage: "key.horizontal") {
                    Text("No password manager? Store a login directly. It’s encrypted with a key held in the macOS Keychain; the value never passes through the model or agent. The agent autofills it only on its own site.")
                        .font(.caption).foregroundStyle(.secondary)
                    TextField("Origin (e.g. https://github.com)", text: $addOrigin).textFieldStyle(.roundedBorder)
                    TextField("Username", text: $addUsername).textFieldStyle(.roundedBorder)
                    SecureField("Password", text: $addPassword).textFieldStyle(.roundedBorder)
                    HStack(spacing: 8) {
                        Button {
                            let origin = addOrigin.trimmingCharacters(in: .whitespaces)
                            guard !origin.isEmpty, !addPassword.isEmpty else {
                                addResult = "Enter an origin and a password."; return
                            }
                            addBusy = true; addResult = nil
                            Task {
                                let ok = await model.storeVaultCredential(
                                    label: addUsername.isEmpty ? origin : addUsername,
                                    origin: origin, username: addUsername, password: addPassword)
                                addBusy = false
                                addResult = ok ? "Saved login for \(origin)." : (model.lastError ?? "Save failed.")
                                if ok { addOrigin = ""; addUsername = ""; addPassword = "" }
                            }
                        } label: { Label("Save login", systemImage: "plus") }
                        .disabled(addBusy || addOrigin.isEmpty || addPassword.isEmpty)
                        if addBusy { ProgressView().controlSize(.small) }
                    }
                    if let addResult { Text(addResult).font(.caption).foregroundStyle(.secondary) }
                }

                Divider()

                section("Stored credentials", systemImage: "key.fill") {
                    if model.vault.isEmpty {
                        Text("No stored credentials. Connected managers' logins are resolved per-site and aren't listed here.")
                            .font(.callout).foregroundStyle(.secondary)
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
        .task {
            await model.loadChromeProfiles()
            await model.loadProviders()
            // Make sure the picker starts on a real profile dir.
            if !model.chromeProfiles.contains(where: { $0.dir == importProfile }),
               let first = model.chromeProfiles.first {
                importProfile = first.dir
            }
        }
    }

    @ViewBuilder
    private func providerRow(_ p: ProviderInfo) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Image(systemName: p.connected ? "checkmark.seal.fill" : "circle")
                    .foregroundStyle(p.connected ? .green : .secondary)
                    .accessibilityLabel(p.connected ? "Connected" : "Not connected")
                Text(p.label).font(.callout.weight(.medium))
                Spacer()
                if p.connected {
                    Text(p.logins >= 0 ? "\(p.logins) login\(p.logins == 1 ? "" : "s")" : "on-demand")
                        .font(.caption2).foregroundStyle(.tertiary)
                }
            }
            if let detail = p.detail, !p.connected {
                Text(detail).font(.caption2)
                    .foregroundStyle(p.available ? Color.secondary : Color.orange)
            }
            if p.connected {
                HStack {
                    if let scope = p.scope { Text("scope: \(scope)").font(.caption2).foregroundStyle(.tertiary) }
                    Spacer()
                    Button(role: .destructive) {
                        providerBusy = p.id
                        Task { await model.disconnectProvider(id: p.id); providerBusy = nil }
                    } label: { Text("Disconnect").font(.caption) }
                    .buttonStyle(.borderless).disabled(providerBusy != nil)
                }
            } else {
                TextField(p.id == "bitwarden" ? "Folder id (optional)" : "Vault/scope (optional)",
                          text: scopeBinding(p.id)).textFieldStyle(.roundedBorder).font(.caption)
                if p.needsSession {
                    HStack(spacing: 6) {
                        Text("1. In Terminal:").font(.caption2).foregroundStyle(.tertiary)
                        Text("bw unlock --raw").font(.caption2.monospaced())
                        Button {
                            NSPasteboard.general.clearContents()
                            NSPasteboard.general.setString("bw unlock --raw", forType: .string)
                        } label: { Image(systemName: "doc.on.doc") }
                            .buttonStyle(.borderless).controlSize(.small)
                            .accessibilityLabel("Copy command")
                    }
                    SecureField("2. Paste the session token here", text: sessionBinding(p.id))
                        .textFieldStyle(.roundedBorder).font(.caption)
                }
                HStack(spacing: 8) {
                    Button {
                        providerBusy = p.id; providerResult[p.id] = nil
                        let scope = providerScope[p.id]?.trimmingCharacters(in: .whitespaces)
                        let session = providerSession[p.id]?.trimmingCharacters(in: .whitespaces)
                        Task {
                            let n = await model.connectProvider(
                                id: p.id, scope: (scope?.isEmpty ?? true) ? nil : scope,
                                session: (session?.isEmpty ?? true) ? nil : session)
                            providerBusy = nil
                            providerResult[p.id] = n.map { $0 >= 0 ? "Connected — \($0) login(s)." : "Connected (on-demand)." }
                                ?? (model.lastError ?? "Connect failed.")
                        }
                    } label: { Label("Connect", systemImage: "link").font(.caption) }
                    .buttonStyle(.borderless)
                    .disabled(providerBusy != nil || !p.available)
                    if providerBusy == p.id { ProgressView().controlSize(.small) }
                }
            }
            if let r = providerResult[p.id], !r.isEmpty {
                Text(r).font(.caption2).foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 4)
    }

    private func scopeBinding(_ id: String) -> Binding<String> {
        Binding(get: { providerScope[id] ?? "" }, set: { providerScope[id] = $0 })
    }
    private func sessionBinding(_ id: String) -> Binding<String> {
        Binding(get: { providerSession[id] ?? "" }, set: { providerSession[id] = $0 })
    }

    @ViewBuilder
    private func section<Content: View>(_ title: String, systemImage: String, @ViewBuilder _ content: @escaping () -> Content) -> some View {
        LabeledSection(title: title, systemImage: systemImage, content: content)
    }
}
