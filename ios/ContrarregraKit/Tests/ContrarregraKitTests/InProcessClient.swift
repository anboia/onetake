import Foundation
import XCTest

@testable import ContrarregraKit

/// Cliente em processo do servidor do runner: faz o papel do transporte (uma conexão WebSocket) sem
/// socket. O que o servidor envia cai numa caixa de entrada; o que o "Mac" manda entra por `post`, na fila
/// da própria conexão — como o adaptador do `NWConnection` faz no runner.
final class InProcessClient: RpcConnection, @unchecked Sendable {
    struct NoMessage: Error, CustomStringConvertible {
        let waited: TimeInterval
        var description: String { "nenhuma mensagem do servidor em \(waited) s" }
    }

    let core: RunnerServerCore
    let queue: DispatchQueue
    private let lock = NSLock()
    private var inbox: [String] = []
    private var _closed = false
    private var nextId = 0
    private let arrived = DispatchSemaphore(value: 0)

    init(_ core: RunnerServerCore, label: String = "client") {
        self.core = core
        queue = DispatchQueue(label: "test.connection.\(label)")
        core.open(self)
    }

    // MARK: RpcConnection (servidor → cliente)

    func send(_ text: String) {
        lock.withLock { inbox.append(text) }
        arrived.signal()
    }

    func close() {
        let first = lock.withLock { () -> Bool in
            defer { _closed = true }
            return !_closed
        }
        if first { core.closed(self) }
        arrived.signal()
    }

    var isClosed: Bool { lock.withLock { _closed } }

    // MARK: Cliente → servidor

    /// O cliente fecha a conexão.
    func disconnect() {
        close()
    }

    /// Manda um texto cru (na fila da conexão, como o transporte).
    func post(_ text: String, stamp: ReceiveStamp? = nil) {
        queue.async { [self] in core.receive(text, from: self, at: stamp ?? .now()) }
    }

    /// Manda um pedido e devolve o `id` usado.
    @discardableResult
    func request(_ method: String, _ params: JSONValue? = .object([:]), stamp: ReceiveStamp? = nil) -> Int {
        let id = lock.withLock { () -> Int in
            nextId += 1
            return nextId
        }
        var envelope: JSONObject = ["jsonrpc": "2.0", "id": .number(Double(id)), "method": .string(method)]
        if let params { envelope["params"] = params }
        post(try! JCS.canonicalize(.object(envelope)), stamp: stamp)
        return id
    }

    /// Próxima mensagem do servidor.
    func next(timeout: TimeInterval = 2) throws -> JSONValue {
        let limit = Date().addingTimeInterval(timeout)
        while true {
            if let text = lock.withLock({ inbox.isEmpty ? nil : inbox.removeFirst() }) {
                return try JSONParser.parse(text)
            }
            if arrived.wait(timeout: .now() + max(0, limit.timeIntervalSinceNow)) == .timedOut {
                if let text = lock.withLock({ inbox.isEmpty ? nil : inbox.removeFirst() }) {
                    return try JSONParser.parse(text)
                }
                throw NoMessage(waited: timeout)
            }
        }
    }

    /// Pedido e a resposta seguinte.
    func call(_ method: String, _ params: JSONValue? = .object([:]), timeout: TimeInterval = 2) throws -> JSONValue {
        request(method, params)
        return try next(timeout: timeout)
    }

    /// `session.hello` e a resposta.
    func hello(token: String, role: SessionRole = .control) throws -> JSONValue {
        try call("session.hello", ["token": .string(token), "role": .string(role.rawValue), "client": ["name": "test"]])
    }

    /// Nenhuma mensagem chega em `interval`.
    func assertSilent(for interval: TimeInterval, file: StaticString = #filePath, line: UInt = #line) {
        if let message = try? next(timeout: interval) {
            XCTFail("mensagem inesperada do servidor: \(message)", file: file, line: line)
        }
    }

    /// Espera o servidor fechar a conexão.
    func waitClosed(timeout: TimeInterval = 2) -> Bool {
        let limit = Date().addingTimeInterval(timeout)
        while Date() < limit {
            if isClosed { return true }
            Thread.sleep(forTimeInterval: 0.005)
        }
        return isClosed
    }
}

/// Atalhos de leitura das respostas JSON-RPC nos testes.
extension JSONValue {
    var rpcErrorCode: Int? { self["error"]?["code"]?.numberValue.map { Int($0) } }
    var rpcResult: JSONValue? { self["result"] }
    var rpcIdNumber: Int? { self["id"]?.numberValue.map { Int($0) } }
}

/// Um servidor do runner montado como no `testServe`, com a fila do XCTest numa fila serial de teste.
struct RunnerHarness {
    static let token = "tok-3f9a1c7e5b2d4086a1e9c3b5d7f0a2c4"
    static let device = DeviceInfo(model: "iPhone13,2", os: "26.3 (23D127)", screenPt: Size(w: 390, h: 844), scale: 3,
                                   language: "en", textSize: "large", appearance: .light)

    let core: RunnerServerCore
    let lane: XCTestLane
    let laneQueue: DispatchQueue
    let state: RunnerState
    let capabilities: RunnerCapabilities
    let shutdowns: Counter
    /// A tabela de rotas montada (para conferir a fila de cada método de base).
    let router: RpcRouter

    /// Contador seguro entre threads.
    final class Counter: @unchecked Sendable {
        private let lock = NSLock()
        private var count = 0
        func increment() { lock.withLock { count += 1 } }
        var value: Int { lock.withLock { count } }
    }

    init(present: Set<PrivateApiId> = [.px1, .px2, .px3, .px4, .px5], allowed: Set<PrivateApiId> = [],
         state: RunnerState = RunnerState(), extraRoutes: (inout RpcRouter) -> Void = { _ in }) {
        let laneQueue = DispatchQueue(label: "test.xctest-lane")
        let lane = XCTestLane(queue: laneQueue)
        let capabilities = RunnerCapabilities(present: present, allowed: allowed)
        let shutdowns = Counter()
        var router = RpcRouter()
        let coreBox = CoreBox()
        let context = BaseMethods.Context(
            runnerVersion: "0.0.0", capabilities: capabilities, device: { RunnerHarness.device }, state: state, lane: lane,
            shutdown: {
                shutdowns.increment()
                coreBox.core?.stop()
            })
        BaseMethods.register(into: &router, context)
        extraRoutes(&router)
        let core = RunnerServerCore(token: Self.token, router: router, lane: lane, hello: { BaseMethods.helloResult(context) })
        coreBox.core = core
        self.core = core
        self.lane = lane
        self.laneQueue = laneQueue
        self.state = state
        self.capabilities = capabilities
        self.router = router
        self.shutdowns = shutdowns
    }

    final class CoreBox: @unchecked Sendable {
        var core: RunnerServerCore?
    }

    func client(_ label: String = "client") -> InProcessClient {
        InProcessClient(core, label: label)
    }

    /// Um cliente já com `session.hello` aceito.
    func connected(_ role: SessionRole = .control, label: String = "client") throws -> InProcessClient {
        let client = client(label)
        let reply = try client.hello(token: Self.token, role: role)
        XCTAssertNotNil(reply.rpcResult, "session.hello recusado: \(reply)")
        return client
    }
}

/// Portão que um tratador de teste espera (simula um comando lento do XCTest).
final class Gate: @unchecked Sendable {
    private let entered = DispatchSemaphore(value: 0)
    private let released = DispatchSemaphore(value: 0)

    func pass(timeout: TimeInterval = 5) {
        entered.signal()
        _ = released.wait(timeout: .now() + timeout)
    }

    func waitEntered(timeout: TimeInterval = 2) -> Bool {
        entered.wait(timeout: .now() + timeout) == .success
    }

    func release() {
        released.signal()
    }
}
