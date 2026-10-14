#if SPIKE
import ContrarregraKit
import Foundation

/// Os métodos `spike.*` (architecture.md A2, módulo `Spikes`; tasks.md "Regras comuns" dos spikes). Só existem no build
/// `Spike`: a pasta `Spikes/` fica fora do Debug e do Release (`EXCLUDED_SOURCE_FILE_NAMES` em `ios/project.yml`) e
/// tudo aqui está atrás de `#if SPIKE`. Registrados pelo `RunnerMethods` depois dos de produção, com o mesmo contexto;
/// API privada só pelo módulo `PrivateXCT`, com o PX-n presente e liberado (`RunnerCapabilities.usable`).
enum SpikeMethods {
    struct Context: Sendable {
        /// O contexto dos métodos de leitura (leitor, lista permitida, tela, refs, estado de `health`).
        var read: ReadMethods.Context
        /// A ponte com o XCUIAutomation público (`Driver`).
        var bridge: XCUIBridge
        /// O mapa da sondagem × `CONTRARREGRA_PRIVATE` da subida.
        var capabilities: RunnerCapabilities
        /// O relógio D em ns (S0.5).
        var clock: @Sendable () -> UInt64 = { DeviceClock.rawNs() }
    }

    @MainActor
    static func register(into router: inout RpcRouter, _ context: Context) {
        SP3Taps.register(into: &router, context)
        RunnerLog.info("build Spike: métodos \(SP3Taps.methods.joined(separator: ", ")) registrados")
    }
}
#endif
