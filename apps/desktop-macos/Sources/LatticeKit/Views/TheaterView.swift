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
            List(model.sessions, selection: $selected) { s in
                VStack(alignment: .leading, spacing: 2) {
                    Text(s.url.isEmpty ? "about:blank" : s.url)
                        .font(.callout).lineLimit(1).truncationMode(.middle)
                    Text("\(s.actionCount) actions · \(s.sessionId.prefix(8))")
                        .font(.caption2).foregroundStyle(.secondary)
                }.tag(s.sessionId)
            }
            .frame(minWidth: 220)
            .overlay { if model.sessions.isEmpty { ContentUnavailableMessage("No active sessions") } }

            if let sid = selected {
                LiveSessionView(sessionId: sid, mcpClient: mcpClient)
                    .frame(minWidth: 240)
            } else {
                ContentUnavailableMessage("Select a session to watch it live")
                    .frame(minWidth: 240)
            }
        }
        .navigationTitle("Theater")
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
            }
            if deltas.isEmpty {
                Text(streaming ? "Subscribed — waiting for page changes…" : "Connecting…")
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
        do {
            _ = try await client.subscribe(sessionId: sessionId, intervalMs: 1000)
            streaming = true
        } catch {
            deltas = ["subscribe failed: \(error)"]
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

struct ContentUnavailableMessage: View {
    let text: String
    init(_ text: String) { self.text = text }
    var body: some View {
        Text(text)
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
