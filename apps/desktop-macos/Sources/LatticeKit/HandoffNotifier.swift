import Foundation
import UserNotifications

/// Bridges S8.5 human-handoff approvals to native macOS notifications with
/// Approve / Deny actions (ADR 0003 D5). When the agent raises an approval
/// handoff, the operator gets a notification anywhere; tapping Approve/Deny
/// claims the handoff for this device (first-claim-wins) and resolves it.
///
/// The value path for *input* handoffs (2FA/passwords) is NOT handled here — it
/// flows Vault→form via the mediated channel, never through a notification.
public final class HandoffNotifier: NSObject, UNUserNotificationCenterDelegate {
    public static let categoryId = "net.lattice.handoff.approval"
    public static let inputCategoryId = "net.lattice.handoff.input"
    private static let approveAction = "APPROVE"
    private static let denyAction = "DENY"
    private static let provideAction = "PROVIDE"

    /// Stable per-install device id (claim-once accounting). Public so the
    /// in-app handoff UI uses the SAME identity to claim + resolve/submit.
    public let deviceId: String
    private var client: ControlPlaneClient?
    private var seen = Set<String>()
    private var seenApprovals = Set<String>()
    private let center = UNUserNotificationCenter.current()

    public override init() {
        // Stable per-install device id for claim-once accounting.
        let key = "net.lattice.deviceId"
        if let existing = UserDefaults.standard.string(forKey: key) {
            deviceId = existing
        } else {
            let id = "macos-desktop-" + UUID().uuidString.prefix(8)
            UserDefaults.standard.set(String(id), forKey: key)
            deviceId = String(id)
        }
        super.init()
    }

    /// Register the category + delegate and request authorization. Safe to call
    /// once at launch; silently degrades if notifications aren't permitted.
    public func configure() {
        let approve = UNNotificationAction(identifier: Self.approveAction, title: "Approve", options: [.authenticationRequired])
        let deny = UNNotificationAction(identifier: Self.denyAction, title: "Deny", options: [.destructive])
        let approvalCategory = UNNotificationCategory(
            identifier: Self.categoryId, actions: [approve, deny], intentIdentifiers: [], options: [])
        // Input handoffs: a text-input action lets the operator type the value
        // (e.g. a 2FA code) straight in the notification. It goes to the backend
        // and is filled Vault→form — never through the agent/model.
        let provide = UNTextInputNotificationAction(
            identifier: Self.provideAction, title: "Provide", options: [.authenticationRequired],
            textInputButtonTitle: "Send", textInputPlaceholder: "value")
        let inputCategory = UNNotificationCategory(
            identifier: Self.inputCategoryId, actions: [provide], intentIdentifiers: [], options: [])
        center.setNotificationCategories([approvalCategory, inputCategory])
        center.delegate = self
        center.requestAuthorization(options: [.alert, .sound]) { _, _ in }
    }

    public func attach(client: ControlPlaneClient) { self.client = client }

    /// Post notifications for any approval handoffs not seen yet. Called by the
    /// control-plane model when it polls `/handoffs`.
    public func sync(handoffs: [Handoff]) {
        let live = Set(handoffs.map(\.id))
        seen.formIntersection(live) // forget resolved handoffs so re-raises notify again
        for h in handoffs where h.status == "pending" && !seen.contains(h.id) {
            seen.insert(h.id)
            post(h)
        }
    }

    private func post(_ h: Handoff) {
        let content = UNMutableNotificationContent()
        let isInput = h.type == "input"
        content.title = isInput ? "Lattice — input needed" : "Lattice — approval needed"
        let field = h.field.map { " (\($0))" } ?? ""
        content.body = isInput ? "\(h.reason)\(field)\n\(h.origin)" : "\(h.reason)\n\(h.origin)"
        content.categoryIdentifier = isInput ? Self.inputCategoryId : Self.categoryId
        content.userInfo = isInput ? ["inputHandoffId": h.id] : ["handoffId": h.id]
        content.sound = .default
        let req = UNNotificationRequest(identifier: "handoff-\(h.id)", content: content, trigger: nil)
        center.add(req)
    }

    /// Post notifications for any consequential-action grants the agent is BLOCKED
    /// on (the `/approvals` inbox). Without this the agent sits blocked and the
    /// operator gets no signal unless they happen to be on the Approvals tab.
    /// Called by the control-plane model on every refresh.
    public func sync(approvals: [Approval]) {
        let live = Set(approvals.map(\.id))
        seenApprovals.formIntersection(live) // forget resolved → a re-raise notifies again
        for a in approvals where !seenApprovals.contains(a.id) {
            seenApprovals.insert(a.id)
            postApproval(a)
        }
    }

    private func postApproval(_ a: Approval) {
        let content = UNMutableNotificationContent()
        content.title = "Lattice — action needs approval"
        let where_ = a.origin.isEmpty ? "" : "\n\(a.origin)"
        content.body = "\(a.actionType) · \(a.summary)\(where_)"
        content.categoryIdentifier = Self.categoryId
        content.userInfo = ["approvalId": a.id]
        content.sound = .default
        let req = UNNotificationRequest(identifier: "approval-\(a.id)", content: content, trigger: nil)
        center.add(req)
    }

    // MARK: UNUserNotificationCenterDelegate

    /// Show the banner even when the app is frontmost.
    public func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .sound])
    }

    public func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let info = response.notification.request.content.userInfo

        // Input handoff: the operator typed the value in the notification reply.
        // Claim then submit — the value goes Vault→form, never through the agent.
        if response.actionIdentifier == Self.provideAction,
           let inputId = info["inputHandoffId"] as? String,
           let textResponse = response as? UNTextInputNotificationResponse,
           let client {
            let device = deviceId
            let value = textResponse.userText
            Task {
                if (try? await client.claimHandoff(inputId, deviceId: device)) == true {
                    _ = try? await client.submitHandoffInput(inputId, deviceId: device, value: value)
                }
            }
            completionHandler()
            return
        }

        let approved: Bool?
        switch response.actionIdentifier {
        case Self.approveAction: approved = true
        case Self.denyAction: approved = false
        default: approved = nil // tapped the body — no decision
        }
        if let approved, let client {
            if let handoffId = info["handoffId"] as? String {
                let device = deviceId
                Task {
                    // First-claim-wins: only resolve if THIS device wins the claim.
                    if (try? await client.claimHandoff(handoffId, deviceId: device)) == true {
                        _ = try? await client.resolveHandoff(handoffId, deviceId: device, approved: approved)
                    }
                }
            } else if let approvalId = info["approvalId"] as? String {
                // Consequential-action grant inbox: resolve directly.
                Task {
                    if approved { try? await client.approve(approvalId) }
                    else { try? await client.deny(approvalId, reason: "denied by operator") }
                }
            }
        }
        completionHandler()
    }
}
