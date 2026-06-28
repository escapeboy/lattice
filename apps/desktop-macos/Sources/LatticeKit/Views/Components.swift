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

/// A compact pill for a single piece of metadata — an origin, an action type, a
/// status. Replaces the scattered `Label(...).font(.caption)` one-offs so gov
/// metadata reads as discrete tappable-looking tokens with a consistent shape,
/// tint, and combined VoiceOver label.
struct Chip: View {
    let text: String
    var systemImage: String? = nil
    var tint: Color = .secondary

    var body: some View {
        HStack(spacing: 3) {
            if let systemImage {
                Image(systemName: systemImage).imageScale(.small)
            }
            Text(text).lineLimit(1)
        }
        .font(.caption2)
        .padding(.horizontal, 7)
        .padding(.vertical, 2)
        .foregroundStyle(tint)
        .background(tint.opacity(0.12), in: Capsule())
        .overlay(Capsule().strokeBorder(tint.opacity(0.22), lineWidth: 0.5))
        .accessibilityElement(children: .combine)
    }
}

/// Wrapping row of chips — flows left-to-right and wraps to the next line when
/// the width runs out (e.g. a persona with several origins). Uses the macOS 13
/// `Layout` protocol; no fixed column count.
struct ChipFlow<Data: RandomAccessCollection, Content: View>: View where Data.Element: Hashable {
    let items: Data
    var spacing: CGFloat = 4
    @ViewBuilder let chip: (Data.Element) -> Content

    var body: some View {
        FlowLayout(spacing: spacing) {
            ForEach(Array(items), id: \.self) { chip($0) }
        }
    }
}

/// Minimal flow layout: place subviews along the row, wrap when the next one
/// would overflow the proposed width. Greedy single-pass — enough for chips.
struct FlowLayout: Layout {
    var spacing: CGFloat = 4

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout Void) -> CGSize {
        let maxWidth = proposal.width ?? .infinity
        var x: CGFloat = 0, y: CGFloat = 0, rowHeight: CGFloat = 0
        for sub in subviews {
            let s = sub.sizeThatFits(.unspecified)
            if x > 0, x + s.width > maxWidth {
                x = 0; y += rowHeight + spacing; rowHeight = 0
            }
            x += s.width + spacing
            rowHeight = max(rowHeight, s.height)
        }
        return CGSize(width: maxWidth == .infinity ? x : maxWidth, height: y + rowHeight)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout Void) {
        var x = bounds.minX, y = bounds.minY, rowHeight: CGFloat = 0
        for sub in subviews {
            let s = sub.sizeThatFits(.unspecified)
            if x > bounds.minX, x + s.width > bounds.maxX {
                x = bounds.minX; y += rowHeight + spacing; rowHeight = 0
            }
            sub.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(s))
            x += s.width + spacing
            rowHeight = max(rowHeight, s.height)
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
