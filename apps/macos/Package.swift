// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "Flow",
    platforms: [.macOS(.v14)],
    dependencies: [
        .package(url: "https://github.com/groue/GRDB.swift.git", from: "7.0.0"),
        // In-place auto-update (docs/ops/DEPLOYMENT.md § macOS updates). Ships
        // as an XCFramework; tools/make-app.sh embeds + signs it, since a
        // hand-rolled bundle gets none of Xcode's copy-frameworks machinery.
        .package(url: "https://github.com/sparkle-project/Sparkle", from: "2.6.0"),
        // Test-only: TestClock, so timing state machines (SyncIndicator) are
        // tested against a virtual clock instead of racing real timers on a
        // loaded CI runner.
        .package(url: "https://github.com/pointfreeco/swift-clocks", from: "1.0.0"),
    ],
    targets: [
        .executableTarget(
            name: "Flow",
            dependencies: [
                .product(name: "GRDB", package: "GRDB.swift"),
                .product(name: "Sparkle", package: "Sparkle"),
            ],
            linkerSettings: [
                // swift build autolinks the _AVKit_SwiftUI overlay but not
                // AVKit.framework itself; without this, instantiating
                // VideoPlayer aborts at runtime ("failed to demangle
                // superclass of VideoPlayerView from 'So12AVPlayerViewC'").
                .linkedFramework("AVKit"),
            ]
        ),
        .testTarget(
            name: "FlowTests",
            dependencies: [
                "Flow",
                .product(name: "Clocks", package: "swift-clocks"),
            ]
        ),
    ]
)
