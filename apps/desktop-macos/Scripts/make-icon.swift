// Generates AppIcon.icns for Lattice from the SF Symbol `lock.shield.fill`
// (the app's menubar identity) on a dark gradient squircle. No external assets.
//
//   swift Scripts/make-icon.swift            # → Signing/AppIcon.icns
import AppKit

let outDir = CommandLine.arguments.count > 1 ? CommandLine.arguments[1]
    : FileManager.default.currentDirectoryPath + "/Signing"
let iconset = NSTemporaryDirectory() + "AppIcon.iconset"
try? FileManager.default.removeItem(atPath: iconset)
try! FileManager.default.createDirectory(atPath: iconset, withIntermediateDirectories: true)

func tintedSymbol(_ name: String, point: CGFloat) -> NSImage {
    let cfg = NSImage.SymbolConfiguration(pointSize: point, weight: .semibold)
    let base = NSImage(systemSymbolName: name, accessibilityDescription: nil)!
        .withSymbolConfiguration(cfg)!
    let out = NSImage(size: base.size)
    out.lockFocus()
    base.draw(at: .zero, from: .zero, operation: .sourceOver, fraction: 1)
    NSColor.white.set()
    NSRect(origin: .zero, size: base.size).fill(using: .sourceAtop)
    out.unlockFocus()
    return out
}

func render(_ px: Int) -> Data {
    let n = CGFloat(px)
    let img = NSImage(size: NSSize(width: n, height: n))
    img.lockFocus()
    // squircle-ish rounded rect with a subtle inset (macOS icons aren't full-bleed)
    let inset = n * 0.10
    let rect = NSRect(x: inset, y: inset, width: n - inset * 2, height: n - inset * 2)
    let path = NSBezierPath(roundedRect: rect, xRadius: (n - inset * 2) * 0.225, yRadius: (n - inset * 2) * 0.225)
    let grad = NSGradient(colors: [
        NSColor(calibratedRed: 0.27, green: 0.30, blue: 0.42, alpha: 1),   // #454C6B-ish top
        NSColor(calibratedRed: 0.11, green: 0.12, blue: 0.19, alpha: 1),   // #1C1F30-ish bottom
    ])!
    grad.draw(in: path, angle: -90)
    // glyph centered
    let glyph = tintedSymbol("lock.shield.fill", point: n * 0.52)
    let gs = glyph.size
    let scale = min(rect.width * 0.62 / gs.width, rect.height * 0.62 / gs.height)
    let gw = gs.width * scale, gh = gs.height * scale
    glyph.draw(in: NSRect(x: rect.midX - gw / 2, y: rect.midY - gh / 2, width: gw, height: gh),
               from: .zero, operation: .sourceOver, fraction: 0.96)
    img.unlockFocus()
    let tiff = img.tiffRepresentation!
    return NSBitmapImageRep(data: tiff)!.representation(using: .png, properties: [:])!
}

let sizes: [(Int, String)] = [
    (16, "icon_16x16"), (32, "icon_16x16@2x"), (32, "icon_32x32"), (64, "icon_32x32@2x"),
    (128, "icon_128x128"), (256, "icon_128x128@2x"), (256, "icon_256x256"), (512, "icon_256x256@2x"),
    (512, "icon_512x512"), (1024, "icon_512x512@2x"),
]
for (px, name) in sizes {
    try! render(px).write(to: URL(fileURLWithPath: "\(iconset)/\(name).png"))
}

let icns = outDir + "/AppIcon.icns"
let p = Process()
p.executableURL = URL(fileURLWithPath: "/usr/bin/iconutil")
p.arguments = ["-c", "icns", iconset, "-o", icns]
try! p.run(); p.waitUntilExit()
print(p.terminationStatus == 0 ? "wrote \(icns)" : "iconutil failed")
