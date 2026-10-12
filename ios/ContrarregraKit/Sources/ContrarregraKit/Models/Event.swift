import Foundation

// S0.7 Evento: uma linha de `events.ndjson` (no aparelho e no Mac) e o `params` da notificação `event`.

public enum EventKind: String, Sendable, CaseIterable {
    case takeStart = "take.start"
    case prerollMarker = "preroll.marker"
    case sceneStart = "scene.start"
    case stepStart = "step.start"
    case stepEnd = "step.end"
    case stepFail = "step.fail"
    case checkpointWait = "checkpoint.wait"
    case checkpointAlert = "checkpoint.alert"
    case checkpointResolved = "checkpoint.resolved"
    case checkpointTimeout = "checkpoint.timeout"
    case sceneHold = "scene.hold"
    case sceneEnd = "scene.end"
    case deviceState = "device.state"
    case runnerReconnect = "runner.reconnect"
    case syncBurst = "sync.burst"
    case obsState = "obs.state"
    case obsChapter = "obs.chapter"
    case intervention = "intervention"
    case takePause = "take.pause"
    case takeResume = "take.resume"
    case takeEnd = "take.end"
    case takeAbort = "take.abort"
}

/// Caminho usado por uma ação: API privada (`PrivateXCT`) ou pública.
public enum ActionPath: String, Sendable, CaseIterable { case `private`, `public` }

/// Um evento. Os campos de S0.7 (e os de `checkpoint.*`, S5) são tipados; os campos próprios de cada
/// `kind` descritos noutras seções ficam em `extra` e voltam intactos no JSON. Todo campo terminado em
/// `Ns`, em qualquer profundidade, é tempo D/M em string de inteiro de 64 bits (AC-0.4).
public struct Event: JSONModel {
    public var seq: Int
    public var kind: EventKind
    public var sceneId: String?
    public var stepId: String?
    public var action: String?
    public var target: Target?
    public var caption: String?
    public var tDevStartNs: Nanos?
    public var tDispatchNs: Nanos?
    public var tDevEndNs: Nanos?
    public var tDevUptimeNs: Nanos?
    public var tMacNs: Nanos?
    public var tPredRawS: Double?
    public var tRecS: Double?
    public var tFinalS: Double?
    /// `.null` = nenhuma mudança detectada no quadro (S7 item 4, AC-7.6).
    public var tVideoObservedS: Nullable<Double>?
    public var detectScore: Double?
    public var status: String?
    public var lateMs: Double?
    public var path: ActionPath?
    public var detail: JSONObject?
    public var overrunMs: Double?
    public var id: String?
    public var who: CheckpointWho?
    public var ask: String?
    public var timeoutMs: Int?
    public var waitedMs: Double?
    public var at: String?
    /// Campos fora dos de cima (próprios de cada `kind`).
    public var extra: JSONObject

    public init(seq: Int, kind: EventKind, extra: JSONObject = [:]) {
        self.seq = seq
        self.kind = kind
        self.extra = extra
    }

    public static let modelName = "evento"

    static let knownKeys: Set<JSONKey> = [
        "seq", "kind", "sceneId", "stepId", "action", "target", "caption", "tDevStartNs", "tDispatchNs", "tDevEndNs",
        "tDevUptimeNs", "tMacNs", "tPredRawS", "tRecS", "tFinalS", "tVideoObservedS", "detectScore", "status", "lateMs",
        "path", "detail", "overrunMs", "id", "who", "ask", "timeoutMs", "waitedMs", "at",
    ]

    static let sceneIdOrSection = Read.formatted("sceneId: id de cena (^s\\d{2}$), \"prepare\" ou \"cleanup\" (S0.7)") {
        Formats.isSceneId($0) || $0 == "prepare" || $0 == "cleanup"
    }

    public static func read(_ json: JSONValue, at path: JSONPath, _ sink: IssueSink) -> Event? {
        guard var o = ObjectReader(json, at: path, sink, allowed: nil) else { return nil }
        let seq = o.required("seq", Read.nonNegativeInt)
        let kind = o.required("kind", Read.oneOf(EventKind.self))
        var event = Event(seq: seq ?? 0, kind: kind ?? .takeStart)
        event.sceneId = o.optional("sceneId", sceneIdOrSection)
        event.stepId = o.optional("stepId", Read.nonEmpty)
        event.action = o.optional("action", Read.nonEmpty)
        event.target = o.optional("target", Read.model(Target.self))
        event.caption = o.optional("caption", Read.string)
        event.tDevStartNs = o.optional("tDevStartNs", Read.nanos)
        event.tDispatchNs = o.optional("tDispatchNs", Read.nanos)
        event.tDevEndNs = o.optional("tDevEndNs", Read.nanos)
        event.tDevUptimeNs = o.optional("tDevUptimeNs", Read.nanos)
        event.tMacNs = o.optional("tMacNs", Read.nanos)
        event.tPredRawS = o.optional("tPredRawS", Read.seconds3)
        event.tRecS = o.optional("tRecS", Read.seconds3)
        event.tFinalS = o.optional("tFinalS", Read.seconds3)
        event.tVideoObservedS = o.optional("tVideoObservedS") { json, path, sink in
            if json.isNull { return Nullable<Double>.null }
            return Read.seconds3(json, path, sink).map { .value($0) }
        }
        event.detectScore = o.optional("detectScore", Read.anyNumber)
        event.status = o.optional("status", Read.nonEmpty)
        event.lateMs = o.optional("lateMs", Read.anyNumber)
        event.path = o.optional("path", Read.oneOf(ActionPath.self))
        event.detail = o.optional("detail", Read.jsonObject)
        event.overrunMs = o.optional("overrunMs", Read.number(min: 0))
        event.id = o.optional("id", Read.nonEmpty)
        event.who = o.optional("who", Read.oneOf(CheckpointWho.self))
        event.ask = o.optional("ask", Read.string)
        event.timeoutMs = o.optional("timeoutMs", Read.nonNegativeInt)
        event.waitedMs = o.optional("waitedMs", Read.number(min: 0))
        event.at = o.optional("at", Read.nonEmpty)
        for (key, value) in o.fields where !knownKeys.contains(key) { event.extra[key] = value }
        if !nsFieldsValid(json, path, sink) { o.fail() }
        guard o.ok, seq != nil, kind != nil else { return nil }
        return event
    }

    /// Todo campo `…Ns`, em qualquer profundidade (inclusive em `detail` e nos extras), tem de ser
    /// inteiro de 64 bits em string.
    static func nsFieldsValid(_ value: JSONValue, _ path: JSONPath, _ sink: IssueSink) -> Bool {
        switch value {
        case .array(let items):
            var ok = true
            for (position, item) in items.enumerated() where !nsFieldsValid(item, path.index(position), sink) { ok = false }
            return ok
        case .object(let fields):
            var ok = true
            for key in fields.keys.sorted() {
                let item = fields[key]!
                if key.string.hasSuffix("Ns") {
                    if case .string(let text) = item, Nanos(decimal: text) != nil {
                        // ok
                    } else {
                        sink.add(path.key(key.string), .int64String, Nanos.ruleMessage)
                        ok = false
                    }
                }
                if !nsFieldsValid(item, path.key(key.string), sink) { ok = false }
            }
            return ok
        default:
            return true
        }
    }

    public var json: JSONValue {
        var out = extra
        out["seq"] = seq.json
        out["kind"] = .string(kind.rawValue)
        out.put("sceneId", sceneId?.json)
        out.put("stepId", stepId?.json)
        out.put("action", action?.json)
        out.put("target", target?.json)
        out.put("caption", caption?.json)
        out.put("tDevStartNs", tDevStartNs?.json)
        out.put("tDispatchNs", tDispatchNs?.json)
        out.put("tDevEndNs", tDevEndNs?.json)
        out.put("tDevUptimeNs", tDevUptimeNs?.json)
        out.put("tMacNs", tMacNs?.json)
        out.put("tPredRawS", tPredRawS?.json)
        out.put("tRecS", tRecS?.json)
        out.put("tFinalS", tFinalS?.json)
        out.put("tVideoObservedS", tVideoObservedS.map {
            switch $0 {
            case .null: JSONValue.null
            case .value(let seconds): .number(seconds)
            }
        })
        out.put("detectScore", detectScore?.json)
        out.put("status", status?.json)
        out.put("lateMs", lateMs?.json)
        out.put("path", path.map { .string($0.rawValue) })
        out.put("detail", detail.map { .object($0) })
        out.put("overrunMs", overrunMs?.json)
        out.put("id", id?.json)
        out.put("who", who.map { .string($0.rawValue) })
        out.put("ask", ask?.json)
        out.put("timeoutMs", timeoutMs?.json)
        out.put("waitedMs", waitedMs?.json)
        out.put("at", at?.json)
        return .object(out)
    }
}
