import ContrarregraKit
import Foundation
import Network

/// Servidor de comandos do runner (módulo `Server`, architecture.md A2): adaptador fino do `NWListener`
/// WebSocket sobre o `RunnerServerCore` do Kit, que faz autenticação, controlador único e as duas filas.
///
/// Segurança (P-3, P-7, S1 item 9, ADR-9):
/// - escuta **só no loopback**, em IPv4 127.0.0.1 — `requiredInterfaceType = .loopback` (padrão) ou, no build
///   `Spike` com `CONTRARREGRA_BIND=endpoint`, `requiredLocalEndpoint 127.0.0.1:<porta>` (as duas formas do
///   SP-4); toda conexão que chegue de endereço fora do loopback é cancelada antes de ler qualquer byte;
/// - sem Bonjour (`service = nil`) e sem peer-to-peer;
/// - só mensagens de texto (uma mensagem = um objeto JSON-RPC, S0.5); binário fecha com 1003.
final class WebSocketServer: @unchecked Sendable {
    /// Teto de uma mensagem: cabe o `pad` de 64 KB do `clock.ping` e uma coreografia compilada.
    static let maximumMessageSize = 4 * 1024 * 1024

    private let core: RunnerServerCore
    private let port: UInt16
    private let bind: RunnerEnvironment.BindMode
    private let listener: NWListener
    private let queue = DispatchQueue(label: "app.kifactory.contrarregra.runner.listener")
    private let onFailure: @Sendable (String) -> Void
    private let lock = NSLock()
    private var connections: [ObjectIdentifier: WebSocketConnection] = [:]

    /// - Parameter onFailure: o listener falhou (porta ocupada, rede): o runner deve parar.
    init(port: UInt16, bind: RunnerEnvironment.BindMode, core: RunnerServerCore,
         onFailure: @escaping @Sendable (String) -> Void) throws {
        self.core = core
        self.port = port
        self.bind = bind
        self.onFailure = onFailure

        let tcp = NWProtocolTCP.Options()
        tcp.noDelay = true  // clock.ping: sem Nagle
        let parameters = NWParameters(tls: nil, tcp: tcp)
        let websocket = NWProtocolWebSocket.Options()
        websocket.autoReplyPing = true
        websocket.maximumMessageSize = Self.maximumMessageSize
        parameters.defaultProtocolStack.applicationProtocols.insert(websocket, at: 0)
        if let ip = parameters.defaultProtocolStack.internetProtocol as? NWProtocolIP.Options {
            ip.version = .v4  // 127.0.0.1 nas duas formas
        }
        parameters.includePeerToPeer = false
        parameters.allowLocalEndpointReuse = true  // religar o runner logo depois de cair

        guard let nwPort = NWEndpoint.Port(rawValue: port) else { throw ServerError.badPort(port) }
        switch bind {
        case .loopback:
            parameters.requiredInterfaceType = .loopback
            listener = try NWListener(using: parameters, on: nwPort)
        case .endpoint:
            parameters.requiredLocalEndpoint = .hostPort(host: .ipv4(.loopback), port: nwPort)
            listener = try NWListener(using: parameters)
        }
        listener.service = nil  // nunca anuncia Bonjour
    }

    enum ServerError: Error, CustomStringConvertible {
        case badPort(UInt16)

        var description: String {
            switch self {
            case .badPort(let port): "porta inválida para o NWListener: \(port)"
            }
        }
    }

    func start() {
        listener.stateUpdateHandler = { [weak self] state in
            guard let self else { return }
            switch state {
            case .ready:
                let actual = listener.port?.rawValue ?? port
                RunnerLog.info("CONTRARREGRA_READY port=\(actual) bind=\(bind.rawValue)")
            case .failed(let error):
                RunnerLog.error("o servidor não pôde escutar em 127.0.0.1:\(port) (\(bind.rawValue)): \(error)")
                onFailure("listener: \(error)")
            case .waiting(let error):
                RunnerLog.warn("listener esperando (\(error)); 127.0.0.1:\(port) indisponível")
            default:
                break
            }
        }
        listener.newConnectionHandler = { [weak self] connection in
            self?.accept(connection)
        }
        listener.start(queue: queue)
    }

    /// Para de escutar e fecha as conexões abertas.
    func stop() {
        listener.cancel()
        core.stop()
        let open = lock.withLock { Array(connections.values) }
        for connection in open { connection.close() }
    }

    private func accept(_ connection: NWConnection) {
        guard Self.isLoopback(connection.endpoint) else {
            RunnerLog.warn("conexão de fora do loopback recusada (\(connection.endpoint))")
            connection.cancel()
            return
        }
        let adapter = WebSocketConnection(connection, core: core) { [weak self] closed in
            guard let self else { return }
            _ = lock.withLock { connections.removeValue(forKey: ObjectIdentifier(closed)) }
        }
        lock.withLock { connections[ObjectIdentifier(adapter)] = adapter }
        adapter.start()
    }

    static func isLoopback(_ endpoint: NWEndpoint) -> Bool {
        guard case .hostPort(let host, _) = endpoint else { return false }
        switch host {
        case .ipv4(let address): return address.isLoopback
        case .ipv6(let address): return address.isLoopback
        case .name: return false  // conexão aceita sempre tem endereço; nome não é prova de loopback
        @unknown default: return false
        }
    }
}

/// Uma conexão WebSocket vista pelo `RunnerServerCore` (`RpcConnection`). Cada conexão tem a própria fila:
/// a fila de controle de S1 item 3 roda nela, fora da main thread.
final class WebSocketConnection: RpcConnection, @unchecked Sendable {
    private let connection: NWConnection
    private let core: RunnerServerCore
    private let queue: DispatchQueue
    private let onClosed: @Sendable (WebSocketConnection) -> Void
    private let lock = NSLock()
    private var finished = false
    private var closing = false

    init(_ connection: NWConnection, core: RunnerServerCore, onClosed: @escaping @Sendable (WebSocketConnection) -> Void) {
        self.connection = connection
        self.core = core
        self.onClosed = onClosed
        queue = DispatchQueue(label: "app.kifactory.contrarregra.runner.connection", qos: .userInitiated)
    }

    func start() {
        connection.stateUpdateHandler = { [weak self] state in
            guard let self else { return }
            switch state {
            case .ready:
                core.open(self)
                receiveNext()
            case .failed, .cancelled:
                finish()
            default:
                break
            }
        }
        connection.start(queue: queue)
    }

    // MARK: RpcConnection

    func send(_ text: String) {
        let metadata = NWProtocolWebSocket.Metadata(opcode: .text)
        let context = NWConnection.ContentContext(identifier: "text", metadata: [metadata])
        connection.send(content: Data(text.utf8), contentContext: context, isComplete: true,
                        completion: .contentProcessed { _ in })
    }

    func close() {
        close(code: .protocolCode(.normalClosure))
    }

    private func close(code: NWProtocolWebSocket.CloseCode) {
        let first = lock.withLock { () -> Bool in
            defer { closing = true }
            return !closing
        }
        guard first else { return }
        // Envia o quadro de fechamento depois das mensagens já postas e só então cancela.
        let metadata = NWProtocolWebSocket.Metadata(opcode: .close)
        metadata.closeCode = code
        let context = NWConnection.ContentContext(identifier: "close", metadata: [metadata])
        connection.send(content: nil, contentContext: context, isComplete: true,
                        completion: .contentProcessed { [connection] _ in connection.cancel() })
    }

    // MARK: Recepção

    private func receiveNext() {
        connection.receiveMessage { [weak self] content, context, _, error in
            let stamp = ReceiveStamp.now()  // t2 do clock.ping: a mensagem acabou de ficar inteira
            guard let self else { return }
            if error != nil {
                connection.cancel()
                return
            }
            let metadata = context?.protocolMetadata(definition: NWProtocolWebSocket.definition) as? NWProtocolWebSocket.Metadata
            switch metadata?.opcode {
            case .text?:
                // Texto vazio chega com `content == nil` e é UTF-8 válido (RFC 6455 §8.1): vai ao núcleo como "",
                // que responde -32700 e só fecha conexão sem session.hello. 1007 só para UTF-8 inválido.
                guard let text = String(data: content ?? Data(), encoding: .utf8) else {
                    return close(code: .protocolCode(.invalidFramePayloadData))
                }
                core.receive(text, from: self, at: stamp)
            case .binary?:
                return close(code: .protocolCode(.unsupportedData))
            case .close?:
                connection.cancel()
                return
            default:
                break  // ping/pong (respondidos sozinhos) e mensagens sem metadado
            }
            if !lock.withLock({ closing || finished }) { receiveNext() }
        }
    }

    private func finish() {
        let first = lock.withLock { () -> Bool in
            defer { finished = true }
            return !finished
        }
        guard first else { return }
        core.closed(self)
        onClosed(self)
    }
}
