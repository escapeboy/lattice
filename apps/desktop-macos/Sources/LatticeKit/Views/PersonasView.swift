import SwiftUI

/// Personas & Vault manager. Persona state persists per-session (topology=
/// persistent + personaId); the vault holds per-origin credentials. The vault
/// moves to the macOS Keychain in D5 — this panel surfaces the model and the
/// status until the management actions land.
public struct PersonasView: View {
    public init() {}

    public var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Personas").font(.headline)
            Text("Sessions created with topology = persistent and a personaId resume that persona's cookies/storage across runs. Persona creation flows from the session theater.")
                .font(.callout).foregroundStyle(.secondary)

            Divider()

            Text("Vault").font(.headline)
            HStack(spacing: 8) {
                Image(systemName: "key.horizontal")
                Text("Credentials are mediated by the vault and never pass through the model or agent.")
                    .font(.callout).foregroundStyle(.secondary)
            }
            Label("macOS Keychain backing — landing in D5", systemImage: "lock.shield")
                .font(.caption).foregroundStyle(.tertiary)

            Spacer()
        }
        .padding(16)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .navigationTitle("Personas & Vault")
    }
}
