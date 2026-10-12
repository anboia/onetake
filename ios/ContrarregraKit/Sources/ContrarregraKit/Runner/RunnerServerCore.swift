import Foundation

/// Uma conexão vista pelo servidor: WebSocket no runner; cliente em processo nos testes.
public protocol RpcConnection: AnyObject, Sendable {
    /// Envia uma mensagem de texto. Pode ser chamada de qualquer thread; as mensagens saem na ordem das
    /// chamadas.
    func send(_ text: String)
    /// Fecha a conexão depois das mensagens já enviadas.
    func close()
}

/// O núcleo do servidor de comandos do runner (S0.5, S1 itens 2–3, S2 item 3), sem transporte:
///
/// - **Autenticação.** A primeira mensagem tem de ser `session.hello` com o token da sessão. Qualquer outra
///   coisa antes dela, `session.hello` inválido ou token errado → `E_AUTH` e a conexão é fechada (AC-1.2).
/// - **Um controlador.** Só uma conexão `control` por vez; uma segunda recebe `E_BUSY` e é fechada (AC-2.5).
///   A vaga se libera quando a conexão fecha. Conexões `sync` não ocupam a vaga e só levam `clock.ping`.
/// - **Duas filas.** A rota diz a fila: controle (na fila da conexão, fora da main thread) ou XCTest
///   (`XCTestLane`, com prazo).
public final class RunnerServerCore: @unchecked Sendable {
    public typealias Log = @Sendable (_ level: String, _ message: String) -> Void

    private enum Phase {
        case awaitingHello
        case active(SessionRole)
    }

    private struct Entry {
        let connection: any RpcConnection
        let serial: UInt64
        var phase: Phase
    }

    private let tokenBytes: [UInt8]
    private let router: RpcRouter
    private let lane: XCTestLane
    private let hello: @Sendable () -> SessionHelloResult
    private let log: Log

    private let lock = NSLock()
    private var entries: [ObjectIdentifier: Entry] = [:]
    private var controller: ObjectIdentifier?
    private var nextSerial: UInt64 = 0
    private var stopped = false

    /// - Parameters:
    ///   - token: o `CONTRARREGRA_TOKEN` da sessão.
    ///   - hello: monta a resposta de `session.hello` (versão, capacidades, aparelho, relógio).
    public init(token: String, router: RpcRouter, lane: XCTestLane, hello: @escaping @Sendable () -> SessionHelloResult,
                log: @escaping Log = { _, _ in }) {
        precondition(!token.isEmpty, "token de sessão vazio")
        tokenBytes = Array(token.utf8)
        self.router = router
        self.lane = lane
        self.hello = hello
        self.log = log
    }

    // MARK: Conexões

    /// Uma conexão nova (ainda sem `session.hello`).
    public func open(_ connection: any RpcConnection) {
        let accepted: Bool = lock.withLock {
            guard !stopped else { return false }
            nextSerial += 1
            entries[ObjectIdentifier(connection)] = Entry(connection: connection, serial: nextSerial, phase: .awaitingHello)
            return true
        }
        if !accepted { connection.close() }
    }

    /// A conexão fechou (pelo cliente, pelo transporte ou por nós): libera a vaga de controlador.
    public func closed(_ connection: any RpcConnection) {
        let id = ObjectIdentifier(connection)
        let wasController: Bool = lock.withLock {
            entries[id] = nil
            guard controller == id else { return false }
            controller = nil
            return true
        }
        if wasController { log("info", "controlador desconectado; vaga de control livre") }
    }

    /// Há um controlador conectado.
    public var hasController: Bool {
        lock.withLock { controller != nil }
    }

    /// Conexões abertas (com ou sem `session.hello`).
    public var connectionCount: Int {
        lock.withLock { entries.count }
    }

    /// Fecha todas as conexões e recusa as próximas (`runner.shutdown`).
    public func stop() {
        let all: [any RpcConnection] = lock.withLock {
            stopped = true
            controller = nil
            let list = entries.values.map(\.connection)
            entries.removeAll()
            return list
        }
        for connection in all { connection.close() }
    }

    /// Envia uma notificação (`event`, `log`) ao controlador, se houver. Devolve se enviou.
    @discardableResult
    public func notifyController(_ notification: RpcNotification) -> Bool {
        let target: (any RpcConnection)? = lock.withLock { controller.flatMap { entries[$0]?.connection } }
        guard let target else { return false }
        guard let text = encode(.notification(notification)) else { return false }
        target.send(text)
        return true
    }

    // MARK: Mensagens

    /// Uma mensagem de texto chegou em `connection` no instante `stamp`. Chamada na fila da conexão, uma
    /// mensagem por vez.
    public func receive(_ text: String, from connection: any RpcConnection, at stamp: ReceiveStamp) {
        let id = ObjectIdentifier(connection)
        guard let entry = lock.withLock({ entries[id] }) else { return }
        let authenticated: Bool
        if case .active = entry.phase { authenticated = true } else { authenticated = false }

        let message: RpcMessage
        do {
            message = try RpcCodec.decode(text)
        } catch {
            // -32700 (não é JSON) ou -32600 (envelope inválido), com `id: null`.
            send(.failure(RpcFailure(id: nil, error: error.rpcError)), to: connection)
            if !authenticated { reject(connection) }
            return
        }

        switch message {
        case .request(let request):
            switch entry.phase {
            case .awaitingHello:
                handshake(request, on: connection, entry: entry)
            case .active(let role):
                dispatch(request, role: role, on: connection, entry: entry, stamp: stamp)
            }
        case .notification, .success, .failure:
            // O Mac não manda notificações nem respostas ao runner; antes do hello, é conexão sem autenticação.
            if !authenticated {
                fail(nil, .auth, "E_AUTH: a primeira mensagem tem de ser o pedido session.hello", on: connection)
                reject(connection)
            }
        }
    }

    // MARK: session.hello

    private func handshake(_ request: RpcRequest, on connection: any RpcConnection, entry: Entry) {
        guard request.method == RpcBaseMethod.sessionHello.rawValue else {
            fail(request.id, .auth, "E_AUTH: conexão sem session.hello; \(request.method) recusado", on: connection)
            return reject(connection)
        }
        let params: SessionHelloParams
        do {
            params = try SessionHelloParams.decode(request.params.map { .object($0) } ?? .null)
        } catch {
            fail(request.id, .auth, "E_AUTH: session.hello inválido", on: connection,
                 data: ["errors": .array(error.issues.map(\.json))])
            return reject(connection)
        }
        guard tokenMatches(params.token) else {
            log("warn", "session.hello com token errado (\(params.role.rawValue)); conexão fechada")
            fail(request.id, .auth, "E_AUTH: token de sessão errado", on: connection)
            return reject(connection)
        }

        let id = ObjectIdentifier(connection)
        enum Admission { case ok, busy, gone }
        let admission: Admission = lock.withLock {
            guard var current = entries[id], current.serial == entry.serial else { return .gone }
            if params.role == .control {
                if let holder = controller, holder != id { return .busy }
                controller = id
            }
            current.phase = .active(params.role)
            entries[id] = current
            return .ok
        }
        switch admission {
        case .gone:
            return
        case .busy:
            log("info", "segundo control recusado com E_BUSY")
            fail(request.id, .busy, "E_BUSY: já há um controlador conectado (um control por vez)", on: connection)
            return reject(connection)
        case .ok:
            log("info", "session.hello ok (\(params.role.rawValue))")
            send(.success(RpcSuccess(id: request.id, result: hello().json)), to: connection)
        }
    }

    /// Comparação em tempo constante no conteúdo (o tamanho, só, pode vazar).
    private func tokenMatches(_ candidate: String) -> Bool {
        let bytes = Array(candidate.utf8)
        guard bytes.count == tokenBytes.count else { return false }
        var diff: UInt8 = 0
        for index in bytes.indices { diff |= bytes[index] ^ tokenBytes[index] }
        return diff == 0
    }

    // MARK: Despacho

    private func dispatch(_ request: RpcRequest, role: SessionRole, on connection: any RpcConnection, entry: Entry,
                          stamp: ReceiveStamp) {
        if request.method == RpcBaseMethod.sessionHello.rawValue {
            return fail(request.id, .invalidRequest, "Invalid Request: session.hello já feito nesta conexão", on: connection)
        }
        guard let route = router.route(request.method) else {
            return fail(request.id, .methodNotFound, "Method not found: \(request.method)", on: connection)
        }
        guard route.roles.contains(role) else {
            return fail(request.id, .auth,
                        "E_AUTH: \(request.method) não é aceito numa conexão \(role.rawValue) (S2 item 3: a sync só leva clock.ping)",
                        on: connection)
        }
        let call = RpcCall(id: request.id, method: request.method, params: request.params, role: role, received: stamp)

        switch route.lane {
        case .control:
            let outcome = Result { () throws(RpcErrorObject) -> JSONValue in try route.handler(call) }
            reply(request.id, outcome, route: route, on: connection)
        case .xctest:
            let id = ObjectIdentifier(connection)
            let serial = entry.serial
            lane.submit(
                method: request.method,
                deadlineSeconds: route.deadline(request.params),
                shouldRun: { [weak self] in self?.isOpen(id, serial: serial) ?? false },
                work: { Result { () throws(RpcErrorObject) -> JSONValue in try route.handler(call) } },
                reply: { [weak self] outcome in
                    guard let self, self.isOpen(id, serial: serial) else { return }
                    self.reply(request.id, outcome, route: route, on: connection)
                })
        }
    }

    private func isOpen(_ id: ObjectIdentifier, serial: UInt64) -> Bool {
        lock.withLock { entries[id]?.serial == serial }
    }

    private func reply(_ id: RpcId, _ outcome: Result<JSONValue, RpcErrorObject>, route: RpcRoute,
                       on connection: any RpcConnection) {
        switch outcome {
        case .success(let result):
            send(.success(RpcSuccess(id: id, result: result)), to: connection)
            route.afterReply?()
        case .failure(let error):
            send(.failure(RpcFailure(id: id, error: error)), to: connection)
        }
    }

    // MARK: Envio

    private func fail(_ id: RpcId?, _ code: RunnerErrorCode, _ message: String, on connection: any RpcConnection,
                      data: JSONValue? = nil) {
        send(.failure(RpcFailure(id: id, error: RpcErrorObject(code, message, data: data))), to: connection)
    }

    private func fail(_ id: RpcId?, _ code: JSONRPCErrorCode, _ message: String, on connection: any RpcConnection) {
        send(.failure(RpcFailure(id: id, error: RpcErrorObject(code, message))), to: connection)
    }

    private func send(_ message: RpcMessage, to connection: any RpcConnection) {
        if let text = encode(message) {
            connection.send(text)
        } else if case .success(let success) = message {
            // Resultado que não vira JSON canônico (número não finito): erro interno no lugar.
            send(.failure(RpcFailure(id: success.id, error: RpcErrorObject(.internalError, "Internal error: resultado sem JSON canônico"))),
                 to: connection)
        }
    }

    private func encode(_ message: RpcMessage) -> String? {
        do {
            return try RpcCodec.encode(message)
        } catch {
            log("error", "falha ao codificar resposta: \(error.description)")
            return nil
        }
    }

    /// Fecha uma conexão sem autenticação (depois da resposta de erro já enviada).
    private func reject(_ connection: any RpcConnection) {
        let id = ObjectIdentifier(connection)
        lock.withLock {
            entries[id] = nil
            if controller == id { controller = nil }
        }
        connection.close()
    }
}
