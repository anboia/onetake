import Foundation

/// A fila do XCTest (S1 item 3): serial, na main thread no runner (`DispatchQueue.main`, servida pelo run
/// loop que o `testServe` gira); nos testes, uma fila serial qualquer.
///
/// Cada comando tem prazo. O estouro responde `E_TIMEOUT` na hora, por uma fila de prazos própria — a fila
/// de controle não espera nada daqui. Um comando que estourou o prazo ainda na fila **nunca roda** (um toque
/// atrasado não acontece depois da resposta de erro); um que já estava rodando termina, e o resultado
/// atrasado é descartado. Comandos de uma conexão fechada que ainda não começaram também não rodam.
public final class XCTestLane: @unchecked Sendable {
    public typealias Outcome = Result<JSONValue, RpcErrorObject>

    private let queue: DispatchQueue
    private let timers: DispatchQueue
    private let lock = NSLock()
    private var pending = 0

    public init(queue: DispatchQueue,
                timers: DispatchQueue = DispatchQueue(label: "app.kifactory.contrarregra.runner.deadlines", qos: .userInitiated)) {
        self.queue = queue
        self.timers = timers
    }

    /// Comandos aceitos e ainda não terminados (na fila ou rodando): o `xctestQueueDepth` do `health`.
    public var depth: Int {
        lock.withLock { pending }
    }

    /// Põe `work` na fila. `reply` é chamada exatamente uma vez — com o resultado, ou com `E_TIMEOUT` se o
    /// prazo vencer antes — salvo quando o comando é descartado porque `shouldRun` ficou falso (conexão
    /// fechada) antes de começar.
    public func submit(method: String, deadlineSeconds: Double?, shouldRun: @escaping @Sendable () -> Bool,
                       work: @escaping @Sendable () -> Outcome, reply: @escaping @Sendable (Outcome) -> Void) {
        let job = Job()
        lock.withLock { pending += 1 }
        queue.async { [self] in
            defer { lock.withLock { pending -= 1 } }
            guard job.start(allowed: shouldRun()) else { return }
            let outcome = work()
            if job.finish() { reply(outcome) }
        }
        if let deadlineSeconds, deadlineSeconds.isFinite {
            let delay = max(0, deadlineSeconds)
            timers.asyncAfter(deadline: .now() + delay) {
                guard let phase = job.expire() else { return }
                reply(.failure(Self.timeoutError(method: method, seconds: delay, phase: phase)))
            }
        }
    }

    static func timeoutError(method: String, seconds: Double, phase: Job.Phase) -> RpcErrorObject {
        let deadlineMs = (seconds * 1000).rounded()
        let where_ = phase == .queued ? "ainda na fila do XCTest" : "rodando na fila do XCTest"
        return RpcErrorObject(.timeout, "E_TIMEOUT: \(method) passou do prazo de \(deadlineMs / 1000) s (\(where_))",
                              data: ["method": .string(method), "deadlineMs": .number(deadlineMs),
                                     "phase": .string(phase.rawValue)])
    }

    /// Estado de um comando: quem responde primeiro (o trabalho ou o prazo) ganha; o outro é descartado.
    final class Job: @unchecked Sendable {
        enum Phase: String { case queued, running, done }

        private let lock = NSLock()
        private var phase = Phase.queued
        private var replied = false

        /// A fila chegou nele: roda só se ninguém respondeu ainda e a conexão segue aberta.
        func start(allowed: Bool) -> Bool {
            lock.withLock {
                guard phase == .queued, !replied, allowed else {
                    phase = .done
                    return false
                }
                phase = .running
                return true
            }
        }

        /// O trabalho acabou: responde se o prazo não respondeu antes.
        func finish() -> Bool {
            lock.withLock {
                phase = .done
                guard !replied else { return false }
                replied = true
                return true
            }
        }

        /// O prazo venceu: devolve a fase em que estava se cabe a ele responder.
        func expire() -> Phase? {
            lock.withLock {
                guard !replied, phase != .done else { return nil }
                replied = true
                return phase
            }
        }
    }
}
