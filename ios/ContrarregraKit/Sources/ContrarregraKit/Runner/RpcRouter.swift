import Foundation

// Roteador do runner (S1 item 3, S2 item 3): cada método tem uma fila, os papéis de conexão que o aceitam,
// um prazo e um tratador. O servidor (`RunnerServerCore`) faz a autenticação e despacha pelo roteador; o
// transporte (WebSocket no runner, cliente em processo nos testes) fica fora daqui.

extension RpcErrorObject: Error {}

/// As duas filas de S1 item 3.
public enum RpcLane: String, Sendable {
    /// Fora da main thread; nunca espera o XCTest (`session.hello`, `health`, `clock.ping`, `choreo.status`,
    /// `choreo.abort`, `events.fetch`). O tratador roda na fila da própria conexão e não pode bloquear.
    case control
    /// Main thread, serial: tudo que toca a UI. Com prazo; o estouro responde `E_TIMEOUT`.
    case xctest
}

/// Instante de chegada de uma mensagem, tomado pelo transporte assim que ela fica inteira (o `t2` do
/// `clock.ping`).
public struct ReceiveStamp: Sendable, Equatable {
    public var rawNs: UInt64
    public var uptimeNs: UInt64

    public init(rawNs: UInt64, uptimeNs: UInt64) {
        self.rawNs = rawNs
        self.uptimeNs = uptimeNs
    }

    public static func now() -> ReceiveStamp {
        ReceiveStamp(rawNs: DeviceClock.rawNs(), uptimeNs: DeviceClock.uptimeNs())
    }
}

/// Um pedido autenticado, entregue ao tratador.
public struct RpcCall: Sendable {
    public var id: RpcId
    public var method: String
    public var params: JSONObject?
    public var role: SessionRole
    public var received: ReceiveStamp

    public init(id: RpcId, method: String, params: JSONObject?, role: SessionRole, received: ReceiveStamp) {
        self.id = id
        self.method = method
        self.params = params
        self.role = role
        self.received = received
    }

    /// `params` lidos pelo modelo do método; inválidos (ou ausentes) → `-32602` com os problemas em
    /// `data.errors`.
    public func decode<Params: JSONModel>(_ type: Params.Type) throws(RpcErrorObject) -> Params {
        do {
            return try Params.decode(params.map { .object($0) } ?? .null)
        } catch {
            throw RpcErrorObject(.invalidParams, "Invalid params: \(error.description)",
                                 data: ["errors": .array(error.issues.map(\.json))])
        }
    }
}

/// O tratador de um método: devolve o `result` ou lança o erro JSON-RPC.
public typealias RpcHandler = @Sendable (RpcCall) throws(RpcErrorObject) -> JSONValue

/// Uma rota do roteador.
public struct RpcRoute: Sendable {
    public var lane: RpcLane
    /// Papéis de conexão que podem chamar o método (S2 item 3: a `sync` só leva `clock.ping`).
    public var roles: Set<SessionRole>
    /// Prazo em segundos, a partir dos `params` (`nil` = sem prazo; só a fila de controle não tem).
    public var deadline: @Sendable (JSONObject?) -> Double?
    public var handler: RpcHandler
    /// Executado depois que a resposta de sucesso foi enviada (ex.: `runner.shutdown`).
    public var afterReply: (@Sendable () -> Void)?

    public init(lane: RpcLane, roles: Set<SessionRole>, deadline: @escaping @Sendable (JSONObject?) -> Double?,
                handler: @escaping RpcHandler, afterReply: (@Sendable () -> Void)? = nil) {
        self.lane = lane
        self.roles = roles
        self.deadline = deadline
        self.handler = handler
        self.afterReply = afterReply
    }
}

/// Prazos por comando (S1 item 3): padrão ⚠️ 10 s; `ui.tree` 5 s; `screen.shot` 3 s; `wait.for` =
/// `timeoutMs` + 1 s.
public enum RpcDeadlines {
    public static let defaultSeconds = 10.0

    public static func xctestSeconds(method: String, params: JSONObject?) -> Double {
        switch method {
        case "ui.tree": return 5
        case "screen.shot": return 3
        case "wait.for":
            if let timeoutMs = params?["timeoutMs"]?.numberValue, timeoutMs.isFinite, timeoutMs >= 0 {
                return timeoutMs / 1000 + 1
            }
            return defaultSeconds
        default: return defaultSeconds
        }
    }
}

/// Tabela método → rota. Montada antes de o servidor abrir; depois é só leitura.
public struct RpcRouter: Sendable {
    public private(set) var routes: [String: RpcRoute] = [:]

    public init() {}

    public func route(_ method: String) -> RpcRoute? { routes[method] }

    public var methods: [String] { routes.keys.sorted() }

    /// Registra um método. Na fila do XCTest, sem `deadline` explícito, vale `RpcDeadlines.xctestSeconds`;
    /// na de controle, sem prazo. `session.hello` é do próprio servidor e não se registra.
    public mutating func register(_ method: String, lane: RpcLane, roles: Set<SessionRole> = [.control],
                                  deadline: (@Sendable (JSONObject?) -> Double?)? = nil,
                                  afterReply: (@Sendable () -> Void)? = nil, handler: @escaping RpcHandler) {
        precondition(method != RpcBaseMethod.sessionHello.rawValue, "session.hello é tratado pelo servidor")
        precondition(routes[method] == nil, "método registrado duas vezes: \(method)")
        let resolved: @Sendable (JSONObject?) -> Double? = deadline ?? { params in
            lane == .xctest ? RpcDeadlines.xctestSeconds(method: method, params: params) : nil
        }
        routes[method] = RpcRoute(lane: lane, roles: roles, deadline: resolved, handler: handler, afterReply: afterReply)
    }
}
