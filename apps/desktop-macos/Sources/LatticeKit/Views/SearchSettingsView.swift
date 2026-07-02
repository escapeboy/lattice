import SwiftUI

/// Native settings for the search_query provider (Search tab).
///
/// DuckDuckGo is the zero-setup default. Brave takes a BYO API key that is
/// stored in the macOS Keychain and never displayed back; SearXNG takes a
/// remote instance URL. Applying restarts the backend stack (the env is read
/// at boot), which ends live sessions — the button says so.
public struct SearchSettingsView: View {
    @ObservedObject var stack: StackController
    @State private var provider: DesktopSearch.Provider = DesktopSearch.provider
    @State private var braveKeyInput: String = ""
    @State private var hasStoredBraveKey: Bool = DesktopSearch.hasBraveKey
    @State private var searxngUrl: String = DesktopSearch.searxngUrl
    @State private var applied = false

    public init(stack: StackController) { self.stack = stack }

    public var body: some View {
        Form {
            Section("Search provider") {
                Picker("Provider", selection: $provider) {
                    ForEach(DesktopSearch.Provider.allCases) { p in
                        Text(p.label).tag(p)
                    }
                }
                .pickerStyle(.radioGroup)
            }

            if provider == .brave {
                Section("Brave Search API key") {
                    if hasStoredBraveKey {
                        HStack {
                            Label("A key is stored in the macOS Keychain", systemImage: "key.fill")
                                .foregroundStyle(.secondary)
                            Spacer()
                            Button("Remove key", role: .destructive) {
                                DesktopSearch.removeBraveKey()
                                hasStoredBraveKey = false
                            }
                        }
                    }
                    SecureField(hasStoredBraveKey ? "Replace key (leave empty to keep)" : "Paste your Brave API key", text: $braveKeyInput)
                        .textFieldStyle(.roundedBorder)
                    Text("Stored in the macOS Keychain — never shown again, never written to disk in plaintext.")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }

            if provider == .searxng {
                Section("SearXNG instance") {
                    TextField("https://searx.example.org", text: $searxngUrl)
                        .textFieldStyle(.roundedBorder)
                        .autocorrectionDisabled()
                    if !searxngUrl.isEmpty && !DesktopSearch.isValidSearxngUrl(searxngUrl) {
                        Text("Enter a valid http(s) base URL of your self-hosted instance.")
                            .font(.caption).foregroundStyle(.orange)
                    }
                    Text("The instance runs wherever you host it — nothing is bundled with the app.")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }

            Section {
                HStack {
                    Button(applied ? "Applied — restarting stack" : "Apply & restart stack") { apply() }
                        .disabled(!canApply || applied)
                    if applied { ProgressView().controlSize(.small) }
                }
                Text("Applying restarts the Lattice engine; live sessions end. Search results are third-party content: they arrive tainted, and navigating to a result passes the normal policy gating. The provider's endpoint is an explicit egress-allowlist entry when the firewall is active.")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
        .formStyle(.grouped)
        .navigationTitle("Search")
        .onChange(of: stack.state) { s in
            if applied, case .running = s { applied = false }
        }
    }

    private var canApply: Bool {
        switch provider {
        case .ddg: return true
        case .brave: return hasStoredBraveKey || !braveKeyInput.trimmingCharacters(in: .whitespaces).isEmpty
        case .searxng: return DesktopSearch.isValidSearxngUrl(searxngUrl)
        }
    }

    private func apply() {
        applied = true
        stack.applySearchSettings(
            provider: provider,
            braveKey: braveKeyInput.isEmpty ? nil : braveKeyInput,
            searxngUrl: searxngUrl)
        braveKeyInput = ""
        hasStoredBraveKey = DesktopSearch.hasBraveKey
    }
}
