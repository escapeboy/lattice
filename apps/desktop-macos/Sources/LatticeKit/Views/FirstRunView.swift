import SwiftUI

/// Guided first-run egress allowlist (ADR 0003 D6). The desktop egress proxy is
/// ON by default and is the only egress defense, so the operator scopes the
/// origins the browser may reach before the stack runs unrestricted. This turns
/// the secure configuration into the default through setup UX.
public struct FirstRunView: View {
    @ObservedObject var stack: StackController
    @State private var text = "https://example.com\nhttps://www.google.com"

    public init(stack: StackController) { self.stack = stack }

    public var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(spacing: 8) {
                Image(systemName: "lock.shield").font(.title2)
                Text("Set up the egress firewall").font(.title2.weight(.semibold))
            }
            Text("Lattice routes all browser traffic through an egress firewall that is ON by default. List the origins the agent is allowed to reach — one per line. You can change these any time under Policy.")
                .foregroundStyle(.secondary)

            TextEditor(text: $text)
                .font(.system(.body, design: .monospaced))
                .frame(minHeight: 140)
                .overlay(RoundedRectangle(cornerRadius: 6).stroke(.quaternary))

            HStack {
                Text("\(origins.count) origin\(origins.count == 1 ? "" : "s")")
                    .font(.caption).foregroundStyle(.secondary)
                Spacer()
                Button("Enable firewall & continue") {
                    stack.applyAllowlist(origins)
                }
                .keyboardShortcut(.defaultAction)
                .disabled(origins.isEmpty)
            }
        }
        .padding(24)
        .frame(maxWidth: 520)
    }

    private var origins: [String] {
        text.split(separator: "\n")
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
    }
}
