import Foundation

// S0.5 Métodos de base (os demais estão em S1 e entram com as tarefas do runner): formas dos parâmetros
// e das respostas, e das ações `ui.*`.

/// Parâmetros vazios (`{}`), estritos.
public struct EmptyParams: JSONModel {
    public init() {}

    public static let modelName = "parâmetros vazios"

    public static func read(_ json: JSONValue, at path: JSONPath, _ sink: IssueSink) -> EmptyParams? {
        guard let o = ObjectReader(json, at: path, sink, allowed: []) else { return nil }
        return o.ok ? EmptyParams() : nil
    }

    public var json: JSONValue { .object([:]) }
}

public enum SessionRole: String, Sendable, CaseIterable { case control, sync }

/// `session.hello {token, role, client}`.
public struct SessionHelloParams: JSONModel {
    public var token: String
    public var role: SessionRole
    public var client: JSONValue

    public init(token: String, role: SessionRole, client: JSONValue) {
        self.token = token
        self.role = role
        self.client = client
    }

    public static let modelName = "parâmetros de session.hello"

    public static func read(_ json: JSONValue, at path: JSONPath, _ sink: IssueSink) -> SessionHelloParams? {
        guard var o = ObjectReader(json, at: path, sink, allowed: ["token", "role", "client"]) else { return nil }
        let token = o.required("token", Read.nonEmpty)
        let role = o.required("role", Read.oneOf(SessionRole.self))
        let client = o.required("client", Read.json)
        guard o.ok, let token, let role, let client else { return nil }
        return SessionHelloParams(token: token, role: role, client: client)
    }

    public var json: JSONValue { ["token": .string(token), "role": .string(role.rawValue), "client": client] }
}

/// `device` da resposta de `session.hello`.
public struct DeviceInfo: JSONModel {
    public var model: String
    public var os: String
    public var screenPt: Size
    public var scale: Double
    public var language: String
    public var textSize: String
    public var appearance: Appearance

    public init(model: String, os: String, screenPt: Size, scale: Double, language: String, textSize: String,
                appearance: Appearance) {
        self.model = model
        self.os = os
        self.screenPt = screenPt
        self.scale = scale
        self.language = language
        self.textSize = textSize
        self.appearance = appearance
    }

    public static let modelName = "aparelho"

    public static func read(_ json: JSONValue, at path: JSONPath, _ sink: IssueSink) -> DeviceInfo? {
        guard var o = ObjectReader(json, at: path, sink,
                                   allowed: ["model", "os", "screenPt", "scale", "language", "textSize", "appearance"])
        else { return nil }
        let model = o.required("model", Read.nonEmpty)
        let os = o.required("os", Read.nonEmpty)
        let screenPt = o.required("screenPt", Read.model(Size.self))
        let scale = o.required("scale", Read.number(positive: true))
        let language = o.required("language", Read.nonEmpty)
        let textSize = o.required("textSize", Read.nonEmpty)
        let appearance = o.required("appearance", Read.oneOf(Appearance.self))
        guard o.ok, let model, let os, let screenPt, let scale, let language, let textSize, let appearance else { return nil }
        return DeviceInfo(model: model, os: os, screenPt: screenPt, scale: scale, language: language, textSize: textSize,
                          appearance: appearance)
    }

    public var json: JSONValue {
        [
            "model": .string(model), "os": .string(os), "screenPt": screenPt.json, "scale": .number(scale),
            "language": .string(language), "textSize": .string(textSize), "appearance": .string(appearance.rawValue),
        ]
    }
}

/// Resposta de `session.hello`.
public struct SessionHelloResult: JSONModel {
    public var runnerVersion: String
    public var capabilities: JSONValue
    public var device: DeviceInfo
    public var nowRawNs: Nanos
    public var nowUptimeNs: Nanos

    public init(runnerVersion: String, capabilities: JSONValue, device: DeviceInfo, nowRawNs: Nanos, nowUptimeNs: Nanos) {
        self.runnerVersion = runnerVersion
        self.capabilities = capabilities
        self.device = device
        self.nowRawNs = nowRawNs
        self.nowUptimeNs = nowUptimeNs
    }

    public static let modelName = "resposta de session.hello"

    public static func read(_ json: JSONValue, at path: JSONPath, _ sink: IssueSink) -> SessionHelloResult? {
        guard var o = ObjectReader(json, at: path, sink, allowed: ["runnerVersion", "capabilities", "device", "clock"])
        else { return nil }
        let runnerVersion = o.required("runnerVersion", Read.nonEmpty)
        let capabilities = o.required("capabilities", Read.json)
        let device = o.required("device", Read.model(DeviceInfo.self))
        let clock: (Nanos, Nanos)? = o.required("clock") { json, path, sink in
            guard var c = ObjectReader(json, at: path, sink, allowed: ["nowRawNs", "nowUptimeNs"]) else { return nil }
            let raw = c.required("nowRawNs", Read.nanos)
            let uptime = c.required("nowUptimeNs", Read.nanos)
            guard c.ok, let raw, let uptime else { return nil }
            return (raw, uptime)
        }
        guard o.ok, let runnerVersion, let capabilities, let device, let clock else { return nil }
        return SessionHelloResult(runnerVersion: runnerVersion, capabilities: capabilities, device: device,
                                  nowRawNs: clock.0, nowUptimeNs: clock.1)
    }

    public var json: JSONValue {
        [
            "runnerVersion": .string(runnerVersion), "capabilities": capabilities, "device": device.json,
            "clock": ["nowRawNs": nowRawNs.json, "nowUptimeNs": nowUptimeNs.json],
        ]
    }
}

/// Resposta de `health`.
public struct HealthResult: JSONModel {
    public var ok: Bool
    public var uptimeS: Double
    public var xctestQueueDepth: Int
    public var treeVersion: Int
    public var foregroundApp: String
    public var locked: Bool

    public init(ok: Bool, uptimeS: Double, xctestQueueDepth: Int, treeVersion: Int, foregroundApp: String, locked: Bool) {
        self.ok = ok
        self.uptimeS = uptimeS
        self.xctestQueueDepth = xctestQueueDepth
        self.treeVersion = treeVersion
        self.foregroundApp = foregroundApp
        self.locked = locked
    }

    public static let modelName = "resposta de health"

    public static func read(_ json: JSONValue, at path: JSONPath, _ sink: IssueSink) -> HealthResult? {
        guard var o = ObjectReader(json, at: path, sink,
                                   allowed: ["ok", "uptimeS", "xctestQueueDepth", "treeVersion", "foregroundApp", "locked"])
        else { return nil }
        let ok = o.required("ok", Read.bool)
        let uptimeS = o.required("uptimeS", Read.number(min: 0))
        let depth = o.required("xctestQueueDepth", Read.nonNegativeInt)
        let treeVersion = o.required("treeVersion", Read.nonNegativeInt)
        let foregroundApp = o.required("foregroundApp", Read.string)
        let locked = o.required("locked", Read.bool)
        guard o.ok, let ok, let uptimeS, let depth, let treeVersion, let foregroundApp, let locked else { return nil }
        return HealthResult(ok: ok, uptimeS: uptimeS, xctestQueueDepth: depth, treeVersion: treeVersion,
                            foregroundApp: foregroundApp, locked: locked)
    }

    public var json: JSONValue {
        [
            "ok": .bool(ok), "uptimeS": .number(uptimeS), "xctestQueueDepth": xctestQueueDepth.json,
            "treeVersion": treeVersion.json, "foregroundApp": .string(foregroundApp), "locked": .bool(locked),
        ]
    }
}

/// `pad` do `clock.ping`: até 64 KB em UTF-8 (S0.5).
enum ClockPad {
    static let maxBytes = 65_536

    static let read: Reader<String> = { json, path, sink in
        guard let text = Read.string(json, path, sink) else { return nil }
        guard text.utf8.count <= maxBytes else {
            sink.add(path, .padMax, "pad do clock.ping com mais de 64 KB (S0.5)")
            return nil
        }
        return text
    }
}

/// `clock.ping {seq, pad?}`.
public struct ClockPingParams: JSONModel {
    public var seq: Int
    public var pad: String?

    public init(seq: Int, pad: String? = nil) {
        self.seq = seq
        self.pad = pad
    }

    public static let modelName = "parâmetros de clock.ping"

    public static func read(_ json: JSONValue, at path: JSONPath, _ sink: IssueSink) -> ClockPingParams? {
        guard var o = ObjectReader(json, at: path, sink, allowed: ["seq", "pad"]) else { return nil }
        let seq = o.required("seq", Read.nonNegativeInt)
        let pad = o.optional("pad", ClockPad.read)
        guard o.ok, let seq else { return nil }
        return ClockPingParams(seq: seq, pad: pad)
    }

    public var json: JSONValue {
        var out: JSONObject = ["seq": seq.json]
        out.put("pad", pad?.json)
        return .object(out)
    }
}

/// Resposta de `clock.ping`: `t2` na chegada e `t3` na saída, em D; `pad` ecoado só no tamanho.
public struct ClockPingResult: JSONModel {
    public var seq: Int
    public var t2RawNs: Nanos
    public var t3RawNs: Nanos
    public var t2UptimeNs: Nanos
    public var pad: String?

    public init(seq: Int, t2RawNs: Nanos, t3RawNs: Nanos, t2UptimeNs: Nanos, pad: String? = nil) {
        self.seq = seq
        self.t2RawNs = t2RawNs
        self.t3RawNs = t3RawNs
        self.t2UptimeNs = t2UptimeNs
        self.pad = pad
    }

    public static let modelName = "resposta de clock.ping"

    public static func read(_ json: JSONValue, at path: JSONPath, _ sink: IssueSink) -> ClockPingResult? {
        guard var o = ObjectReader(json, at: path, sink, allowed: ["seq", "t2RawNs", "t3RawNs", "t2UptimeNs", "pad"]) else {
            return nil
        }
        let seq = o.required("seq", Read.nonNegativeInt)
        let t2 = o.required("t2RawNs", Read.nanos)
        let t3 = o.required("t3RawNs", Read.nanos)
        let t2Uptime = o.required("t2UptimeNs", Read.nanos)
        let pad = o.optional("pad", ClockPad.read)
        guard o.ok, let seq, let t2, let t3, let t2Uptime else { return nil }
        return ClockPingResult(seq: seq, t2RawNs: t2, t3RawNs: t3, t2UptimeNs: t2Uptime, pad: pad)
    }

    public var json: JSONValue {
        var out: JSONObject = [
            "seq": seq.json, "t2RawNs": t2RawNs.json, "t3RawNs": t3RawNs.json, "t2UptimeNs": t2UptimeNs.json,
        ]
        out.put("pad", pad?.json)
        return .object(out)
    }
}

/// `events.fetch {takeId, sinceSeq}`.
public struct EventsFetchParams: JSONModel {
    public var takeId: String
    public var sinceSeq: Int

    public init(takeId: String, sinceSeq: Int) {
        self.takeId = takeId
        self.sinceSeq = sinceSeq
    }

    public static let modelName = "parâmetros de events.fetch"

    public static func read(_ json: JSONValue, at path: JSONPath, _ sink: IssueSink) -> EventsFetchParams? {
        guard var o = ObjectReader(json, at: path, sink, allowed: ["takeId", "sinceSeq"]) else { return nil }
        let takeId = o.required("takeId", Read.takeId)
        let sinceSeq = o.required("sinceSeq", Read.nonNegativeInt)
        guard o.ok, let takeId, let sinceSeq else { return nil }
        return EventsFetchParams(takeId: takeId, sinceSeq: sinceSeq)
    }

    public var json: JSONValue { ["takeId": .string(takeId), "sinceSeq": sinceSeq.json] }
}

/// Resposta de `events.fetch`.
public struct EventsFetchResult: JSONModel {
    public var events: [Event]
    public var lastSeq: Int

    public init(events: [Event], lastSeq: Int) {
        self.events = events
        self.lastSeq = lastSeq
    }

    public static let modelName = "resposta de events.fetch"

    public static func read(_ json: JSONValue, at path: JSONPath, _ sink: IssueSink) -> EventsFetchResult? {
        guard var o = ObjectReader(json, at: path, sink, allowed: ["events", "lastSeq"]) else { return nil }
        let events = o.required("events", Read.array(Read.model(Event.self)))
        let lastSeq = o.required("lastSeq", Read.nonNegativeInt)
        guard o.ok, let events, let lastSeq else { return nil }
        return EventsFetchResult(events: events, lastSeq: lastSeq)
    }

    public var json: JSONValue { ["events": events.json, "lastSeq": lastSeq.json] }
}

/// Ids das APIs privadas (A10).
public enum PrivateApiId: String, Sendable, CaseIterable {
    case px1 = "PX-1", px2 = "PX-2", px3 = "PX-3", px4 = "PX-4", px5 = "PX-5", px6 = "PX-6"
}

public struct Capability: Sendable, Equatable {
    public var present: Bool
    public var allowed: Bool

    public init(present: Bool, allowed: Bool) {
        self.present = present
        self.allowed = allowed
    }
}

/// Resposta de `runner.capabilities`: os seis PX-n, todos presentes no objeto.
public struct RunnerCapabilities: JSONModel {
    public var capabilities: [PrivateApiId: Capability]

    public init(_ capabilities: [PrivateApiId: Capability]) {
        self.capabilities = capabilities
    }

    public subscript(id: PrivateApiId) -> Capability? { capabilities[id] }

    public static let modelName = "resposta de runner.capabilities"

    public static func read(_ json: JSONValue, at path: JSONPath, _ sink: IssueSink) -> RunnerCapabilities? {
        guard var o = ObjectReader(json, at: path, sink, allowed: Set(PrivateApiId.allCases.map { JSONKey($0.rawValue) })) else {
            return nil
        }
        var out: [PrivateApiId: Capability] = [:]
        for id in PrivateApiId.allCases {
            let capability: Capability? = o.required(id.rawValue) { json, path, sink in
                guard var c = ObjectReader(json, at: path, sink, allowed: ["present", "allowed"]) else { return nil }
                let present = c.required("present", Read.bool)
                let allowed = c.required("allowed", Read.bool)
                guard c.ok, let present, let allowed else { return nil }
                return Capability(present: present, allowed: allowed)
            }
            out[id] = capability
        }
        return o.ok ? RunnerCapabilities(out) : nil
    }

    public var json: JSONValue {
        .object(Dictionary(uniqueKeysWithValues: capabilities.map { id, capability in
            (JSONKey(id.rawValue), ["present": .bool(capability.present), "allowed": .bool(capability.allowed)] as JSONValue)
        }))
    }
}

/// Resposta das ações `ui.*` (S0.5).
public struct UiActionResult: JSONModel {
    public var point: AbsolutePoint
    public var nodeRef: String?
    public var tDevStartNs: Nanos
    public var tDispatchNs: Nanos
    public var tDevEndNs: Nanos
    public var path: ActionPath

    public init(point: AbsolutePoint, nodeRef: String? = nil, tDevStartNs: Nanos, tDispatchNs: Nanos, tDevEndNs: Nanos,
                path: ActionPath) {
        self.point = point
        self.nodeRef = nodeRef
        self.tDevStartNs = tDevStartNs
        self.tDispatchNs = tDispatchNs
        self.tDevEndNs = tDevEndNs
        self.path = path
    }

    public static let modelName = "resposta de ação ui.*"

    public static func read(_ json: JSONValue, at path: JSONPath, _ sink: IssueSink) -> UiActionResult? {
        guard var o = ObjectReader(json, at: path, sink,
                                   allowed: ["point", "nodeRef", "tDevStartNs", "tDispatchNs", "tDevEndNs", "path"])
        else { return nil }
        let point = o.required("point", Read.model(AbsolutePoint.self))
        let nodeRef = o.optional("nodeRef", Read.nodeRef)
        let start = o.required("tDevStartNs", Read.nanos)
        let dispatch = o.required("tDispatchNs", Read.nanos)
        let end = o.required("tDevEndNs", Read.nanos)
        let actionPath = o.required("path", Read.oneOf(ActionPath.self))
        guard o.ok, let point, let start, let dispatch, let end, let actionPath else { return nil }
        return UiActionResult(point: point, nodeRef: nodeRef, tDevStartNs: start, tDispatchNs: dispatch, tDevEndNs: end,
                              path: actionPath)
    }

    public var json: JSONValue {
        var out: JSONObject = [
            "point": point.json, "tDevStartNs": tDevStartNs.json, "tDispatchNs": tDispatchNs.json,
            "tDevEndNs": tDevEndNs.json, "path": .string(path.rawValue),
        ]
        out.put("nodeRef", nodeRef?.json)
        return .object(out)
    }
}

/// Os métodos de base de S0.5 e o esquema dos seus parâmetros e respostas.
public enum RpcBaseMethod: String, Sendable, CaseIterable {
    case sessionHello = "session.hello"
    case health = "health"
    case clockPing = "clock.ping"
    case eventsFetch = "events.fetch"
    case runnerCapabilities = "runner.capabilities"

    var params: any JSONModel.Type {
        switch self {
        case .sessionHello: SessionHelloParams.self
        case .health, .runnerCapabilities: EmptyParams.self
        case .clockPing: ClockPingParams.self
        case .eventsFetch: EventsFetchParams.self
        }
    }

    var result: any JSONModel.Type {
        switch self {
        case .sessionHello: SessionHelloResult.self
        case .health: HealthResult.self
        case .clockPing: ClockPingResult.self
        case .eventsFetch: EventsFetchResult.self
        case .runnerCapabilities: RunnerCapabilities.self
        }
    }
}

/// Ações `ui.*` (S1 item 4): a resposta é `UiActionResult`.
public let uiActionMethods: Set<String> = ["ui.tap", "ui.doubleTap", "ui.longPress", "ui.drag", "ui.scrollTo", "ui.type"]

/// Leitura das mensagens com o esquema do método: nos métodos de base os `params`/`result` passam pelo
/// modelo tipado (e voltam reescritos por ele); nos demais, o envelope e um objeto JSON qualquer.
public enum RpcSchema {
    private static func normalized(_ type: any JSONModel.Type, _ json: JSONValue, _ path: JSONPath,
                                   _ sink: IssueSink) -> JSONValue? {
        type.read(json, at: path, sink)?.json
    }

    /// Pedido do `method` dado.
    public static func request(_ json: JSONValue, method: String) throws(ValidationError) -> RpcRequest {
        let sink = IssueSink()
        let known = RpcBaseMethod(rawValue: method)
        var request: RpcRequest?
        if var o = ObjectReader(json, at: .root, sink, allowed: ["jsonrpc", "id", "method", "params"]) {
            _ = o.required("jsonrpc", Read.literal(jsonRpcVersion))
            let id = o.required("id", RpcId.read)
            _ = o.required("method", Read.literal(method))
            let params: JSONObject?
            if let known {
                params = o.required("params") { json, path, sink in normalized(known.params, json, path, sink)?.objectValue }
            } else {
                params = o.optional("params", Read.jsonObject)
            }
            if o.ok, let id { request = RpcRequest(id: id, method: method, params: params) }
        }
        guard let request, sink.isEmpty else { throw ValidationError(what: "pedido \(method)", issues: sink.issues, code: nil) }
        return request
    }

    /// Resposta de sucesso ao `method` dado (o JSON-RPC não repete o método: quem chamou sabe qual foi).
    public static func success(_ json: JSONValue, method: String) throws(ValidationError) -> RpcSuccess {
        let sink = IssueSink()
        var success: RpcSuccess?
        if var o = ObjectReader(json, at: .root, sink, allowed: ["jsonrpc", "id", "result"]) {
            _ = o.required("jsonrpc", Read.literal(jsonRpcVersion))
            let id = o.required("id", RpcId.read)
            let type: (any JSONModel.Type)? =
                RpcBaseMethod(rawValue: method)?.result ?? (uiActionMethods.contains(method) ? UiActionResult.self : nil)
            let result: JSONValue? = o.required("result") { json, path, sink in
                guard let type else { return json }
                return normalized(type, json, path, sink)
            }
            if o.ok, let id, let result { success = RpcSuccess(id: id, result: result) }
        }
        guard let success, sink.isEmpty else { throw ValidationError(what: "resposta de \(method)", issues: sink.issues, code: nil) }
        return success
    }

    /// Notificação do runner: `event` leva um `Event` em `params`; `log`, um objeto JSON.
    public static func notification(_ json: JSONValue, method: String) throws(ValidationError) -> RpcNotification {
        let sink = IssueSink()
        var notification: RpcNotification?
        if var o = ObjectReader(json, at: .root, sink, allowed: ["jsonrpc", "method", "params"]) {
            _ = o.required("jsonrpc", Read.literal(jsonRpcVersion))
            _ = o.required("method", Read.literal(method))
            let params: JSONObject?
            switch method {
            case "event":
                params = o.required("params") { json, path, sink in Event.read(json, at: path, sink)?.json.objectValue }
            case "log":
                params = o.required("params", Read.jsonObject)
            default:
                params = o.optional("params", Read.jsonObject)
            }
            if o.ok { notification = RpcNotification(method: method, params: params) }
        }
        guard let notification, sink.isEmpty else {
            throw ValidationError(what: "notificação \(method)", issues: sink.issues, code: nil)
        }
        return notification
    }
}
