// swift-tools-version: 6.2
// Pacote `ContrarregraKit` (architecture.md A1/A2): modelos de S0, codec JSON-RPC, JCS (RFC 8785) e o
// código do relógio de calibração (S0.10). Só importa Foundation; testado com `swift test` no Mac, sem
// XCTest de UI. Sem dependências (P-2).

import PackageDescription

let package = Package(
    name: "ContrarregraKit",
    platforms: [.iOS(.v26), .macOS(.v26)],
    products: [
        .library(name: "ContrarregraKit", targets: ["ContrarregraKit"])
    ],
    targets: [
        .target(name: "ContrarregraKit"),
        .testTarget(name: "ContrarregraKitTests", dependencies: ["ContrarregraKit"]),
    ]
)
