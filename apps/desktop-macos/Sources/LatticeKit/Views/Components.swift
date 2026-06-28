import SwiftUI

/// Shared empty / placeholder state. Centred, secondary, with an optional SF
/// Symbol — richer than a bare line of text and consistent across every pane.
/// (Deployment target is macOS 13, which predates the native `ContentUnavailableView`.)
struct ContentUnavailableMessage: View {
    let text: String
    let systemImage: String?

    init(_ text: String, systemImage: String? = nil) {
        self.text = text
        self.systemImage = systemImage
    }

    var body: some View {
        VStack(spacing: 8) {
            if let systemImage {
                Image(systemName: systemImage)
                    .font(.system(size: 26))
                    .foregroundStyle(.tertiary)
            }
            Text(text)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityElement(children: .combine)
    }
}

/// Inline outcome line (success or error) for an async action — green check on
/// success, orange triangle on failure. Used to give every consequential button
/// visible feedback instead of silently succeeding/failing.
struct OutcomeLine: View {
    let text: String
    let ok: Bool

    var body: some View {
        Label(text, systemImage: ok ? "checkmark.circle" : "exclamationmark.triangle")
            .font(.caption)
            .foregroundStyle(ok ? Color.green : Color.orange)
            .accessibilityLabel("\(ok ? "Success" : "Error"): \(text)")
    }
}

/// A titled section: bold header (optionally with an SF Symbol), an optional
/// secondary hint, then content. The one grouping primitive every operator pane
/// uses, so headers/spacing stay identical across Policy, Personas & Vault, etc.
struct LabeledSection<Content: View>: View {
    let title: String
    var systemImage: String? = nil
    var hint: String? = nil
    @ViewBuilder let content: () -> Content

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let systemImage {
                Label(title, systemImage: systemImage).font(.headline)
            } else {
                Text(title).font(.headline)
            }
            if let hint { Text(hint).font(.caption).foregroundStyle(.secondary) }
            content()
        }
    }
}

/// A list row with a trailing destructive remove button that carries a proper
/// VoiceOver label. Centralises the "minus.circle + accessibilityLabel" pattern.
struct RemovableRow<Content: View>: View {
    let removeLabel: String
    let onRemove: () -> Void
    @ViewBuilder let content: () -> Content

    var body: some View {
        HStack {
            content()
            Button(role: .destructive, action: onRemove) {
                Image(systemName: "minus.circle")
            }
            .buttonStyle(.borderless)
            .accessibilityLabel(removeLabel)
        }
    }
}
