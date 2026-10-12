import Foundation

// S0.5 Protocolo Mac ↔ runner: JSON-RPC 2.0 em mensagens de texto WebSocket (uma mensagem = um objeto).
// Pedidos com `id`; notificações do runner sem `id` (`event`, `log`).

public let jsonRpcVersion = "2.0"

/// `id` de um pedido: string ou inteiro.
public enum RpcId: Sendable, Hashable, JSONRepresentable {
    case string(String)
    case int(Int)

    /// String, ou inteiro seguro (fora de ±(2⁵³ − 1) → `range`, como no Mac); o resto → `type`.
    static func read(_ json: JSONValue, _ path: JSONPath, _ sink: IssueSink) -> RpcId? {
        switch json {
        case .string(let text): return .string(text)
        case .number(let number) where number.rounded(.towardZero) == number:
            return Read.safeInteger(json, path, sink).map(RpcId.int)
        default:
            sink.add(path, .type, "id do JSON-RPC tem de ser string ou inteiro")
            return nil
        }
    }

    public var json: JSONValue {
        switch self {
        case .string(let text): .string(text)
        case .int(let number): .number(Double(number))
        }
    }
}

/// O objeto `error` de uma resposta de erro.
public struct RpcErrorObject: Sendable, Equatable, JSONRepresentable {
    public var code: Int
    public var message: String
    public var data: JSONValue?

    public init(code: Int, message: String, data: JSONValue? = nil) {
        self.code = code
        self.message = message
        self.data = data
    }

    static func read(_ json: JSONValue, _ path: JSONPath, _ sink: IssueSink) -> RpcErrorObject? {
        guard var o = ObjectReader(json, at: path, sink, allowed: ["code", "message", "data"]) else { return nil }
        let code = o.required("code", Read.int())
        if let code, !knownCodes.contains(code) {
            o.fail("code", .value, "código de erro fora da tabela de S0.5 e do JSON-RPC 2.0")
        }
        let message = o.required("message", Read.string)
        let data = o.optional("data", Read.json)
        guard o.ok, let code, let message else { return nil }
        return RpcErrorObject(code: code, message: message, data: data)
    }

    public var json: JSONValue {
        var out: JSONObject = ["code": code.json, "message": .string(message)]
        out.put("data", data)
        return .object(out)
    }
}

public struct RpcRequest: Sendable, Equatable {
    public var id: RpcId
    public var method: String
    public var params: JSONObject?

    public init(id: RpcId, method: String, params: JSONObject? = nil) {
        self.id = id
        self.method = method
        self.params = params
    }
}

public struct RpcNotification: Sendable, Equatable {
    public var method: String
    public var params: JSONObject?

    public init(method: String, params: JSONObject? = nil) {
        self.method = method
        self.params = params
    }
}

public struct RpcSuccess: Sendable, Equatable {
    public var id: RpcId
    public var result: JSONValue

    public init(id: RpcId, result: JSONValue) {
        self.id = id
        self.result = result
    }
}

public struct RpcFailure: JSONModel {
    /// `nil` = `id: null` (o pedido não pôde ser lido).
    public var id: RpcId?
    public var error: RpcErrorObject

    public init(id: RpcId?, error: RpcErrorObject) {
        self.id = id
        self.error = error
    }

    public static let modelName = "erro JSON-RPC"

    public static func read(_ json: JSONValue, at path: JSONPath, _ sink: IssueSink) -> RpcFailure? {
        guard var o = ObjectReader(json, at: path, sink, allowed: ["jsonrpc", "id", "error"]) else { return nil }
        _ = o.required("jsonrpc", Read.literal(jsonRpcVersion))
        let id: Nullable<RpcId>? = o.required("id") { json, path, sink in
            json.isNull ? .null : RpcId.read(json, path, sink).map { .value($0) }
        }
        let error = o.required("error", RpcErrorObject.read)
        guard o.ok, let id, let error else { return nil }
        if case .value(let value) = id { return RpcFailure(id: value, error: error) }
        return RpcFailure(id: nil, error: error)
    }

    public var json: JSONValue {
        ["jsonrpc": .string(jsonRpcVersion), "id": id?.json ?? .null, "error": error.json]
    }
}

/// Qualquer mensagem do envelope, classificada pela forma: pedido, notificação, sucesso ou erro.
public enum RpcMessage: JSONModel {
    case request(RpcRequest)
    case notification(RpcNotification)
    case success(RpcSuccess)
    case failure(RpcFailure)

    public static let modelName = "mensagem JSON-RPC"

    public static func read(_ json: JSONValue, at path: JSONPath, _ sink: IssueSink) -> RpcMessage? {
        guard case .object(let fields) = json else {
            sink.add(path, .type, "esperava um objeto, veio \(json.typeName)")
            return nil
        }
        if fields["method"] != nil {
            let isRequest = fields["id"] != nil
            let allowed: Set<JSONKey> = isRequest ? ["jsonrpc", "id", "method", "params"] : ["jsonrpc", "method", "params"]
            guard var o = ObjectReader(json, at: path, sink, allowed: allowed) else { return nil }
            _ = o.required("jsonrpc", Read.literal(jsonRpcVersion))
            let id = isRequest ? o.required("id", RpcId.read) : nil
            let method = o.required("method", Read.nonEmpty)
            let params = o.optional("params", Read.jsonObject)
            guard o.ok, let method else { return nil }
            if isRequest {
                guard let id else { return nil }
                return .request(RpcRequest(id: id, method: method, params: params))
            }
            return .notification(RpcNotification(method: method, params: params))
        }
        if fields["error"] != nil {
            return RpcFailure.read(json, at: path, sink).map(RpcMessage.failure)
        }
        if fields["result"] != nil {
            guard var o = ObjectReader(json, at: path, sink, allowed: ["jsonrpc", "id", "result"]) else { return nil }
            _ = o.required("jsonrpc", Read.literal(jsonRpcVersion))
            let id = o.required("id", RpcId.read)
            let result = o.required("result", Read.json)
            guard o.ok, let id, let result else { return nil }
            return .success(RpcSuccess(id: id, result: result))
        }
        sink.add(path, .type, "mensagem JSON-RPC 2.0 sem method, result nem error")
        return nil
    }

    public var json: JSONValue {
        switch self {
        case .request(let request):
            var out: JSONObject = [
                "jsonrpc": .string(jsonRpcVersion), "id": request.id.json, "method": .string(request.method),
            ]
            out.put("params", request.params.map { .object($0) })
            return .object(out)
        case .notification(let notification):
            var out: JSONObject = ["jsonrpc": .string(jsonRpcVersion), "method": .string(notification.method)]
            out.put("params", notification.params.map { .object($0) })
            return .object(out)
        case .success(let success):
            return ["jsonrpc": .string(jsonRpcVersion), "id": success.id.json, "result": success.result]
        case .failure(let failure):
            return failure.json
        }
    }
}

/// Codec de texto: uma mensagem WebSocket ↔ um `RpcMessage`. A saída é o JCS da mensagem (sem espaços,
/// chaves ordenadas): determinística e legível pelo `JSON.parse` do Mac.
public enum RpcCodec {
    /// Erro ao ler uma mensagem: texto que não é JSON (`-32700`) ou envelope inválido (`-32600`).
    public enum DecodeError: Error, Sendable, CustomStringConvertible {
        case parse(JSONParseError)
        case invalid(ValidationError)

        public var rpcError: RpcErrorObject {
            switch self {
            case .parse(let error): RpcErrorObject(.parseError, "Parse error: \(error.reason)")
            case .invalid(let error):
                RpcErrorObject(.invalidRequest, "Invalid Request: \(error.description)",
                               data: ["errors": .array(error.issues.map(\.json))])
            }
        }

        public var description: String {
            switch self {
            case .parse(let error): error.description
            case .invalid(let error): error.description
            }
        }
    }

    public static func decode(_ text: String) throws(DecodeError) -> RpcMessage {
        let json: JSONValue
        do {
            json = try JSONParser.parse(text)
        } catch {
            throw .parse(error)
        }
        do {
            return try RpcMessage.decode(json)
        } catch {
            throw .invalid(error)
        }
    }

    public static func encode(_ message: RpcMessage) throws(JCSError) -> String {
        try JCS.canonicalize(message.json)
    }
}
