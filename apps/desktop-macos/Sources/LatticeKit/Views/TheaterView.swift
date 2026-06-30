import SwiftUI

/// Live session theater: the active sessions (polled) on the left; selecting one
/// opens a live perceive feed (SSE deltas via the MCP client) on the right.
public struct TheaterView: View {
    @ObservedObject var model: ControlPlaneModel
    let mcpClient: MCPClient?
    @State private var selected: String?

    public init(model: ControlPlaneModel, mcpClient: MCPClient?) {
        self.model = model
        self.mcpClient = mcpClient
    }

    public var body: some View {
        HSplitView {
            VStack(spacing: 0) {
                List(model.sessions, selection: $selected) { s in
                    VStack(alignment: .leading, spacing: 2) {
                        Text(s.url.isEmpty ? "about:blank" : s.url)
                            .font(.callout).lineLimit(1).truncationMode(.middle)
                        Text("\(s.actionCount) actions · \(s.sessionId.prefix(8))")
                            .font(.caption2).foregroundStyle(.secondary)
                    }.tag(s.sessionId)
                }
                .overlay { if model.sessions.isEmpty {
                    ContentUnavailableMessage("No active sessions", systemImage: "rectangle.3.group")
                } }

                // Recently-ended catch-up: an ephemeral create→act→destroy run
                // drops off the live list at teardown, so without this an operator
                // who opens Theater a beat later sees nothing. Display-only (the
                // sessions are gone — no live feed), TTL-bounded by the server.
                if !model.recentlyEnded.isEmpty {
                    Divider()
                    RecentlyEndedSection(items: model.recentlyEnded)
                }
            }
            .frame(minWidth: 220)

            if let sid = selected {
                LiveSessionView(sessionId: sid, mcpClient: mcpClient)
                    .frame(minWidth: 240)
            } else {
                ContentUnavailableMessage("Select a session to watch it live", systemImage: "cursorarrow.rays")
                    .frame(minWidth: 240)
            }
        }
        .navigationTitle("Theater")
    }
}

/// Display-only list of sessions that ended within the server's TTL — Theater
/// catch-up so a just-finished ephemeral run is still visible for a moment.
struct RecentlyEndedSection: View {
    let items: [RecentlyEndedSession]

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Recently ended")
                .font(.caption2).fontWeight(.semibold).foregroundStyle(.secondary)
                .padding(.horizontal, 8).padding(.top, 6)
            ScrollView {
                VStack(alignment: .leading, spacing: 2) {
                    ForEach(items) { s in
                        VStack(alignment: .leading, spacing: 1) {
                            Text(s.url.isEmpty ? "about:blank" : s.url)
                                .font(.caption).lineLimit(1).truncationMode(.middle)
                            Text("\(s.actionCount) actions · ended \(Self.ago(s.endedAt)) · \(s.sessionId.prefix(8))")
                                .font(.caption2).foregroundStyle(.secondary)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 8).padding(.vertical, 2)
                    }
                }
            }
            .frame(maxHeight: 120)
        }
        .opacity(0.7)
    }

    /// "12s ago" / "1m ago" from an epoch-ms timestamp.
    static func ago(_ endedAtMs: Double) -> String {
        let secs = max(0, Int(Date().timeIntervalSince1970 - endedAtMs / 1000))
        return secs < 60 ? "\(secs)s ago" : "\(secs / 60)m ago"
    }
}

/// One session's live delta feed, driven by perceive_subscribe + the SSE stream.
struct LiveSessionView: View {
    let sessionId: String
    let mcpClient: MCPClient?
    @State private var deltas: [String] = []
    @State private var streaming = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("Live perceive").font(.headline)
                Spacer()
                Circle().fill(streaming ? .green : .gray).frame(width: 8, height: 8)
                    .accessibilityLabel(streaming ? "Live" : "Not streaming")
            }
            if deltas.isEmpty {
                Text(streaming ? "Live — waiting for the next page change…" : "Reading current page…")
                    .font(.caption).foregroundStyle(.secondary)
            }
            ScrollView {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(Array(deltas.enumerated()), id: \.offset) { _, d in
                        Text(d).font(.system(.caption, design: .monospaced))
                    }
                }.frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .padding(12)
        .task(id: sessionId) { await watch() }
    }

    private func watch() async {
        guard let client = mcpClient else { return }
        deltas = []
        streaming = false
        // Show the CURRENT page state immediately — perceive_subscribe only pushes
        // deltas when the page changes, so without this the pane sits blank on a
        // static page. Taking the snapshot first also seeds the server baseline,
        // so the first streamed delta is a real incremental change, not the whole
        // page reported as "+N added".
        if let snap = try? await client.perceiveSnapshot(sessionId: sessionId) {
            let title = snap.title.isEmpty ? "" : " · \(snap.title)"
            deltas.insert("▶ \(snap.url.isEmpty ? "about:blank" : snap.url) · \(snap.nodeCount) nodes\(title)", at: 0)
        }
        do {
            _ = try await client.subscribe(sessionId: sessionId, intervalMs: 500)
            streaming = true
        } catch {
            deltas.insert("subscribe failed: \(error)", at: 0)
            return
        }
        let stream = await client.perceiveStream()
        for await n in stream where n.sessionId == sessionId {
            let line = "Δ +\(n.added) ~\(n.updated) -\(n.removed)  \(n.url)"
            deltas.insert(line, at: 0)
            if deltas.count > 100 { deltas.removeLast() }
        }
        streaming = false
    }
}

