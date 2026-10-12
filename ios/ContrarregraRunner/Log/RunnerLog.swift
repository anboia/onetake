import Foundation
import os

/// Registro do runner (módulo `Log`, architecture.md A2).
///
/// Cada linha vai ao `os_log` (subsistema `app.kifactory.contrarregra.runner`) e à saída padrão como
/// `CONTRARREGRA <NÍVEL> <mensagem>` — que o `xcodebuild` da sessão grava no registro em arquivo (S2 item 1).
/// Avisos e erros também viram a notificação `log {level, msg}` para o controlador, quando há um (S1
/// "API / Interface").
///
/// Nunca recebe o token da sessão nem outro segredo (P-3, AC-2.9): quem chama passa só resumos
/// (`RunnerEnvironment.description` omite o token).
enum RunnerLog {
    enum Level: String, Sendable {
        case info, warn, error
    }

    typealias Forwarder = @Sendable (Level, String) -> Void

    private static let logger = Logger(subsystem: "app.kifactory.contrarregra.runner", category: "runner")
    private static let forwarding = ForwarderBox()

    /// Liga (ou desliga, com `nil`) o envio de avisos e erros ao controlador.
    static func forward(to forwarder: Forwarder?) {
        forwarding.set(forwarder)
    }

    static func info(_ message: String) { write(.info, message) }
    static func warn(_ message: String) { write(.warn, message) }
    static func error(_ message: String) { write(.error, message) }

    static func write(_ level: Level, _ message: String) {
        switch level {
        case .info: logger.info("\(message, privacy: .public)")
        case .warn: logger.warning("\(message, privacy: .public)")
        case .error: logger.error("\(message, privacy: .public)")
        }
        let line = "CONTRARREGRA \(level.rawValue.uppercased()) \(message)\n"
        FileHandle.standardOutput.write(Data(line.utf8))
        if level != .info { forwarding.get()?(level, message) }
    }

    private final class ForwarderBox: @unchecked Sendable {
        private let lock = NSLock()
        private var forwarder: Forwarder?

        func set(_ value: Forwarder?) { lock.withLock { forwarder = value } }
        func get() -> Forwarder? { lock.withLock { forwarder } }
    }
}
