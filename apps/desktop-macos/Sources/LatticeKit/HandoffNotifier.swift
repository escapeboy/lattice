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
    private static let approveAction = "APPROVE"
    private static let denyAction = "DENY"

    private let deviceId: String
    private var client: ControlPlaneClient?
    private var seen = Set<String>()
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
        let category = UNNotificationCategory(
            identifier: Self.categoryId, actions: [approve, deny], intentIdentifiers: [], options: [])
        center.setNotificationCategories([category])
        center.delegate = self
        center.requestAuthorization(options: [.alert, .sound]) { _, _ in }
    }

    public func attach(client: ControlPlaneClient) { self.client = client }

    /// Post notifications for any approval handoffs not seen yet. Called by the
    /// control-plane model when it polls `/handoffs`.
    public func sync(handoffs: [Handoff]) {
        let live = Set(handoffs.map(\.id))
        seen.formIntersection(live) // forget resolved handoffs so re-raises notify again
        for h in handoffs where h.type == "approval" && h.status == "pending" && !seen.contains(h.id) {
            seen.insert(h.id)
            post(h)
        }
    }

    private func post(_ h: Handoff) {
        let content = UNMutableNotificationContent()
        content.title = "Lattice — approval needed"
        content.body = "\(h.reason)\n\(h.origin)"
        content.categoryIdentifier = Self.categoryId
        content.userInfo = ["handoffId": h.id]
        content.sound = .default
        let req = UNNotificationRequest(identifier: "handoff-\(h.id)", content: content, trigger: nil)
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
        let id = response.notification.request.content.userInfo["handoffId"] as? String
        let approved: Bool?
        switch response.actionIdentifier {
        case Self.approveAction: approved = true
        case Self.denyAction: approved = false
        default: approved = nil // tapped the body — no decision
        }
        if let id, let approved, let client {
            let device = deviceId
            Task {
                // First-claim-wins: only resolve if THIS device wins the claim.
                if (try? await client.claimHandoff(id, deviceId: device)) == true {
                    _ = try? await client.resolveHandoff(id, deviceId: device, approved: approved)
                }
            }
        }
        completionHandler()
    }
}
