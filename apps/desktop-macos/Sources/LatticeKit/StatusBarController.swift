import AppKit
import SwiftUI
import Combine

/// AppKit-managed menubar item. LEFT-click opens the control-plane window;
/// RIGHT-click (or Control-click) shows the dropdown popover. SwiftUI's
/// `MenuBarExtra` can't tell the two clicks apart, so we drive an `NSStatusItem`
/// directly and host the existing SwiftUI views (MenuBarContent / ControlPlaneRoot)
/// via `NSHostingController`.
@MainActor
public final class StatusBarController {
    private let stack: StackController
    private let statusItem: NSStatusItem
    private let popover = NSPopover()
    private var window: NSWindow?
    private var cancellable: AnyCancellable?

    public init(stack: StackController) {
        self.stack = stack
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)

        popover.behavior = .transient
        popover.contentViewController = NSHostingController(
            rootView: MenuBarContent(stack: stack, onOpenControlPlane: { [weak self] in
                self?.popover.performClose(nil)
                self?.openControlPlane()
            }))

        if let button = statusItem.button {
            button.action = #selector(handleClick)
            button.target = self
            button.sendAction(on: [.leftMouseUp, .rightMouseUp])
        }
        updateIcon()

        // Keep the icon in sync with stack state + pending approvals (the badge).
        cancellable = stack.objectWillChange.sink { [weak self] in
            DispatchQueue.main.async { self?.updateIcon() }
        }
    }

    private func updateIcon() {
        guard let button = statusItem.button else { return }
        let img = NSImage(systemSymbolName: stack.menubarSymbol, accessibilityDescription: "Lattice")
        img?.isTemplate = true
        button.image = img
    }

    @objc private func handleClick() {
        let event = NSApp.currentEvent
        let isRight = event?.type == .rightMouseUp
            || (event?.modifierFlags.contains(.control) ?? false)
        if isRight { togglePopover() } else { openControlPlane() }
    }

    private func togglePopover() {
        guard let button = statusItem.button else { return }
        if popover.isShown {
            popover.performClose(nil)
        } else {
            NSApp.activate(ignoringOtherApps: true)
            popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
            popover.contentViewController?.view.window?.makeKey()
        }
    }

    private func openControlPlane() {
        if let w = window {
            w.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            return
        }
        let host = NSHostingController(rootView: ControlPlaneRoot(stack: stack))
        let w = NSWindow(contentViewController: host)
        w.title = "Lattice Control Plane"
        w.setContentSize(NSSize(width: 860, height: 580))
        w.styleMask = [.titled, .closable, .miniaturizable, .resizable]
        w.isReleasedWhenClosed = false
        w.center()
        window = w
        w.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }
}
