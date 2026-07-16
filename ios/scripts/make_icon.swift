// Generates the 1024×1024 app icon (brand: green circle-mark "H" on the
// design system's green #0f8a63). Run on macOS:
//   swift ios/scripts/make_icon.swift ios/HealMeDaily/Assets.xcassets/AppIcon.appiconset/AppIcon.png
import Foundation
import CoreGraphics
import CoreText
import ImageIO
import UniformTypeIdentifiers

let size = 1024
guard CommandLine.arguments.count > 1 else {
    fatalError("usage: swift make_icon.swift <output.png>")
}
let outputURL = URL(fileURLWithPath: CommandLine.arguments[1])

let colorSpace = CGColorSpace(name: CGColorSpace.sRGB)!
let context = CGContext(
    data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: 0,
    // noneSkipLast: App Store marketing icons must have NO alpha channel
    // (App Store Connect rejects alpha PNGs with ITMS-90717).
    space: colorSpace, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue
)!

// Background: brand green (#0f8a63) with a subtle radial lift.
context.setFillColor(CGColor(red: 0x0F / 255.0, green: 0x8A / 255.0, blue: 0x63 / 255.0, alpha: 1))
context.fill(CGRect(x: 0, y: 0, width: size, height: size))
let gradient = CGGradient(
    colorsSpace: colorSpace,
    colors: [
        CGColor(red: 1, green: 1, blue: 1, alpha: 0.10),
        CGColor(red: 1, green: 1, blue: 1, alpha: 0.0),
    ] as CFArray,
    locations: [0, 1]
)!
context.drawRadialGradient(
    gradient,
    startCenter: CGPoint(x: 512, y: 700), startRadius: 0,
    endCenter: CGPoint(x: 512, y: 512), endRadius: 760,
    options: []
)

// White "H" centered — same mark as the in-app BrandMark.
let font = CTFontCreateWithName("HelveticaNeue-Bold" as CFString, 560, nil)
let attributes: [NSAttributedString.Key: Any] = [
    NSAttributedString.Key(kCTFontAttributeName as String): font,
    NSAttributedString.Key(kCTForegroundColorAttributeName as String): CGColor(red: 1, green: 1, blue: 1, alpha: 1),
]
let line = CTLineCreateWithAttributedString(NSAttributedString(string: "H", attributes: attributes))
let bounds = CTLineGetBoundsWithOptions(line, .useGlyphPathBounds)
context.textPosition = CGPoint(
    x: (CGFloat(size) - bounds.width) / 2 - bounds.minX,
    y: (CGFloat(size) - bounds.height) / 2 - bounds.minY
)
CTLineDraw(line, context)

let image = context.makeImage()!
let destination = CGImageDestinationCreateWithURL(outputURL as CFURL, UTType.png.identifier as CFString, 1, nil)!
CGImageDestinationAddImage(destination, image, nil)
CGImageDestinationFinalize(destination)
print("wrote \(outputURL.path)")
