import Foundation

/// Estado do runner lido pela fila de controle (`health`) sem tocar o XCTest. Quem observa o aparelho
/// (árvore, app em primeiro plano, bloqueio; S1 itens 4, 8 e 9) escreve aqui.
public final class RunnerState: @unchecked Sendable {
    private let lock = NSLock()
    private let startRawNs: UInt64
    private var _treeVersion = 0
    private var _foregroundApp = ""
    private var _locked = false

    public init(startRawNs: UInt64 = DeviceClock.rawNs()) {
        self.startRawNs = startRawNs
    }

    /// Segundos desde a subida, em D, com 3 casas.
    public func uptimeSeconds(nowRawNs: UInt64 = DeviceClock.rawNs()) -> Double {
        let elapsed = nowRawNs >= startRawNs ? nowRawNs - startRawNs : 0
        return (Double(elapsed) / 1_000_000).rounded() / 1000
    }

    public var treeVersion: Int {
        get { lock.withLock { _treeVersion } }
        set { lock.withLock { _treeVersion = newValue } }
    }

    /// Bundle id do app em primeiro plano; `""` = ainda não observado.
    public var foregroundApp: String {
        get { lock.withLock { _foregroundApp } }
        set { lock.withLock { _foregroundApp = newValue } }
    }

    public var locked: Bool {
        get { lock.withLock { _locked } }
        set { lock.withLock { _locked = newValue } }
    }
}

extension RunnerCapabilities {
    /// O mapa de `runner.capabilities`: `present` = a sondagem achou os símbolos (A10); `allowed` = o dono
    /// liberou em `runner.privateAllowed` (`CONTRARREGRA_PRIVATE`). Usar exige os dois (`usable`).
    public init(present: Set<PrivateApiId>, allowed: Set<PrivateApiId>) {
        self.init(Dictionary(uniqueKeysWithValues: PrivateApiId.allCases.map { id in
            (id, Capability(present: present.contains(id), allowed: allowed.contains(id)))
        }))
    }

    /// PX-n presentes **e** liberados; os demais respondem `E_CAPABILITY_MISSING` (S1, A10).
    public var usable: Set<PrivateApiId> {
        Set(capabilities.compactMap { id, capability in capability.present && capability.allowed ? id : nil })
    }
}

/// Os métodos de base do runner (S0.5): `health`, `clock.ping`, `runner.capabilities` e `runner.shutdown`,
/// todos na fila de controle; `session.hello` é do próprio `RunnerServerCore`, que usa `helloResult`.
public enum BaseMethods {
    public struct Context: Sendable {
        public var runnerVersion: String
        public var capabilities: RunnerCapabilities
        /// O aparelho visto pelo runner (S0.5 `device`), lido sem bloquear a fila de controle.
        public var device: @Sendable () -> DeviceInfo
        public var state: RunnerState
        public var lane: XCTestLane
        /// Pedido de desligar (depois da resposta de `runner.shutdown`).
        public var shutdown: @Sendable () -> Void

        public init(runnerVersion: String, capabilities: RunnerCapabilities, device: @escaping @Sendable () -> DeviceInfo,
                    state: RunnerState, lane: XCTestLane, shutdown: @escaping @Sendable () -> Void) {
            self.runnerVersion = runnerVersion
            self.capabilities = capabilities
            self.device = device
            self.state = state
            self.lane = lane
            self.shutdown = shutdown
        }
    }

    /// Resposta de `session.hello`.
    public static func helloResult(_ context: Context) -> SessionHelloResult {
        SessionHelloResult(runnerVersion: context.runnerVersion, capabilities: context.capabilities.json,
                           device: context.device(), nowRawNs: Nanos(clamping: DeviceClock.rawNs()),
                           nowUptimeNs: Nanos(clamping: DeviceClock.uptimeNs()))
    }

    /// `pad` do `clock.ping` ecoado só no tamanho (S0.5): o mesmo número de bytes UTF-8, em pontos.
    public static func echoPad(_ pad: String?) -> String? {
        pad.map { String(repeating: ".", count: $0.utf8.count) }
    }

    public static func register(into router: inout RpcRouter, _ context: Context) {
        router.register(RpcBaseMethod.health.rawValue, lane: .control) { call throws(RpcErrorObject) in
            _ = try call.decode(EmptyParams.self)
            let state = context.state
            return HealthResult(ok: true, uptimeS: state.uptimeSeconds(), xctestQueueDepth: context.lane.depth,
                                treeVersion: state.treeVersion, foregroundApp: state.foregroundApp,
                                locked: state.locked).json
        }

        // Na conexão `sync` também (S2 item 3), fora da main thread; t2 = chegada da mensagem, t3 = logo antes
        // de montar a resposta.
        router.register(RpcBaseMethod.clockPing.rawValue, lane: .control, roles: [.control, .sync]) { call throws(RpcErrorObject) in
            let params = try call.decode(ClockPingParams.self)
            let pad = echoPad(params.pad)
            let t3 = DeviceClock.rawNs()
            return ClockPingResult(seq: params.seq, t2RawNs: Nanos(clamping: call.received.rawNs), t3RawNs: Nanos(clamping: t3),
                                   t2UptimeNs: Nanos(clamping: call.received.uptimeNs), pad: pad).json
        }

        // Lê o resultado da sondagem feita na subida (nada de símbolo privado aqui).
        router.register(RpcBaseMethod.runnerCapabilities.rawValue, lane: .control) { call throws(RpcErrorObject) in
            _ = try call.decode(EmptyParams.self)
            return context.capabilities.json
        }

        // Não é método de base de S0.5: como no esquema do Mac (`rpcRequestSchemaFor`), `params` é opcional;
        // se vier, tem de ser `{}`.
        router.register("runner.shutdown", lane: .control, afterReply: context.shutdown) { call throws(RpcErrorObject) in
            if call.params != nil { _ = try call.decode(EmptyParams.self) }
            return .object([:])
        }
    }
}

extension Nanos {
    /// Um instante de `DeviceClock` (UInt64) em ns; satura em `Int64.max`.
    public init(clamping value: UInt64) {
        self.init(Int64(clamping: value))
    }
}
