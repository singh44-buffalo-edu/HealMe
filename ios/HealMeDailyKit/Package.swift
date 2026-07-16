// swift-tools-version:5.9
// HealMeDailyKit — the iOS app's data core, kept UI-free on purpose:
// FHIR models, the Medplum client, the dose/adherence engine, check-in
// cadence logic, quick-log FHIRObservation builders and the ai-service client.
// macOS is in the platform list solely so `swift test` runs natively on the
// dev machine (no simulator runtime required); the app target only ever
// builds it for iOS.
import PackageDescription

let package = Package(
    name: "HealMeDailyKit",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [
        .library(name: "HealMeDailyKit", targets: ["HealMeDailyKit"])
    ],
    targets: [
        .target(name: "HealMeDailyKit", path: "Sources/HealMeDailyKit"),
        .testTarget(
            name: "HealMeDailyKitTests",
            dependencies: ["HealMeDailyKit"],
            path: "Tests/HealMeDailyKitTests"
        ),
    ]
)
