import SwiftUI

public enum ControlPlaneSection: String, CaseIterable, Identifiable {
    case theater = "Theater"
    case approvals = "Approvals"
    case policy = "Policy"
    case replay = "Replay"
    case personas = "Personas & Vault"
    public var id: String { rawValue }
    var systemImage: String {
        switch self {
        case .theater: return "rectangle.3.group"
        case .approvals: return "checkmark.shield"
        case .policy: return "doc.text"
        case .replay: return "clock.arrow.circlepath"
        case .personas: return "person.crop.circle"
        }
    }
}

/// Root of the native control plane. Builds the model + clients once the stack
/// is running; shows a waiting state otherwise.
public struct ControlPlaneRoot: View {
    @ObservedObject var stack: StackController
    @StateObject private var holder = ModelHolder()

    public init(stack: StackController) { self.stack = stack }

    public var body: some View {
        Group {
            if let model = holder.model {
                ControlPlaneView(model: model, mcpClient: stack.client)
            } else {
                VStack(spacing: 10) {
                    ProgressView()
                    Text(waitingText).foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .onChange(of: stack.state) { _ in holder.sync(stack: stack) }
        .onAppear { holder.sync(stack: stack) }
    }

    private var waitingText: String {
        switch stack.state {
        case .failed(let m): return "Stack failed: \(m)"
        default: return "Starting the Lattice stack…"
        }
    }

    @MainActor final class ModelHolder: ObservableObject {
        @Published var model: ControlPlaneModel?
        func sync(stack: StackController) {
            if case .running = stack.state {
                if model == nil {
                    let client = ControlPlaneClient(baseURL: stack.controlPlaneURL, token: stack.cpToken)
                    let m = ControlPlaneModel(client: client, notifier: stack.handoffNotifier)
                    m.start()
                    model = m
                }
            } else {
                model?.stop()
                model = nil
            }
        }
    }
}

public struct ControlPlaneView: View {
    @ObservedObject var model: ControlPlaneModel
    let mcpClient: MCPClient?
    @State private var section: ControlPlaneSection = .theater

    public init(model: ControlPlaneModel, mcpClient: MCPClient?) {
        self.model = model
        self.mcpClient = mcpClient
    }

    public var body: some View {
        NavigationSplitView {
            List(ControlPlaneSection.allCases, selection: $section) { s in
                Label(s.rawValue, systemImage: s.systemImage).tag(s)
            }
            .navigationSplitViewColumnWidth(min: 180, ideal: 200)
            .safeAreaInset(edge: .bottom) { statusBar }
        } detail: {
            detail.frame(minWidth: 460, minHeight: 360)
        }
    }

    @ViewBuilder private var detail: some View {
        switch section {
        case .theater: TheaterView(model: model, mcpClient: mcpClient)
        case .approvals: ApprovalsView(model: model)
        case .policy: PolicyView(model: model)
        case .replay: ReplayView(model: model)
        case .personas: PersonasView(model: model)
        }
    }

    private var statusBar: some View {
        HStack(spacing: 6) {
            Circle().fill(model.connected ? .green : .orange).frame(width: 7, height: 7)
            Text(model.connected ? "Connected" : "Reconnecting…")
                .font(.caption2).foregroundStyle(.secondary)
            Spacer()
            if !model.approvals.isEmpty {
                Text("\(model.approvals.count) pending")
                    .font(.caption2).foregroundStyle(.orange)
            }
        }
        .padding(.horizontal, 10).padding(.vertical, 6)
    }
}
