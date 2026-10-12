import Foundation

// S0.4 Coreografia: a fonte validada e a forma compilada (com `compiled`, todo `ref` expandido e os
// padrões preenchidos). O runner a recebe já compilada (`choreo.load`) e a confere aqui.

/// Nomes e versões dos documentos (`schema` = `contrarregra.<tipo>/<n>`; architecture.md A4).
public enum SchemaId {
    public static let choreography = "contrarregra.choreography/1"
    public static let events = "contrarregra.events/1"
    public static let take = "contrarregra.take/1"
    public static let preflight = "contrarregra.preflight/1"
    public static let sync = "contrarregra.sync/1"
    public static let status = "contrarregra.status/1"
    public static let voice = "contrarregra.voice/1"
}

public enum Appearance: String, Sendable, CaseIterable { case light, dark }

public struct ChoreographyApp: Sendable, Equatable {
    public var bundleId: String
    public var iconLabel: String
    public var expectVersion: String
    public var urlPrefixes: [String]

    public init(bundleId: String, iconLabel: String, expectVersion: String, urlPrefixes: [String]) {
        self.bundleId = bundleId
        self.iconLabel = iconLabel
        self.expectVersion = expectVersion
        self.urlPrefixes = urlPrefixes
    }
}

public struct ChoreographyDevice: Sendable, Equatable {
    public var language: String
    public var screenPt: Size
    public var textSize: String
    public var appearance: Appearance

    public init(language: String, screenPt: Size, textSize: String, appearance: Appearance) {
        self.language = language
        self.screenPt = screenPt
        self.textSize = textSize
        self.appearance = appearance
    }
}

public struct GuideSettings: Sendable, Equatable {
    public var voice: String
    public var targetWpm: Int

    public init(voice: String, targetWpm: Int) {
        self.voice = voice
        self.targetWpm = targetWpm
    }
}

public struct SceneHold: Sendable, Equatable {
    public var padBeforeMs: Int?
    public var padAfterMs: Int?

    public init(padBeforeMs: Int? = nil, padAfterMs: Int? = nil) {
        self.padBeforeMs = padBeforeMs
        self.padAfterMs = padAfterMs
    }
}

public struct Scene: Sendable, Equatable {
    public var id: String
    public var title: String
    public var line: [String]?
    public var hold: SceneHold?
    public var steps: [Step]

    public init(id: String, title: String, line: [String]? = nil, hold: SceneHold? = nil, steps: [Step]) {
        self.id = id
        self.title = title
        self.line = line
        self.hold = hold
        self.steps = steps
    }

    static func read(_ json: JSONValue, _ path: JSONPath, _ sink: IssueSink) -> Scene? {
        guard var o = ObjectReader(json, at: path, sink, allowed: ["id", "title", "line", "hold", "steps"]) else {
            return nil
        }
        let id = o.required("id", Read.sceneId)
        let title = o.required("title", Read.string)
        let line = o.optional("line", Read.array(Read.string))
        let hold: SceneHold? = o.optional("hold") { json, path, sink in
            guard var h = ObjectReader(json, at: path, sink, allowed: ["padBeforeMs", "padAfterMs"]) else { return nil }
            let before = h.optional("padBeforeMs", Read.nonNegativeInt)
            let after = h.optional("padAfterMs", Read.nonNegativeInt)
            return h.ok ? SceneHold(padBeforeMs: before, padAfterMs: after) : nil
        }
        let steps = o.required("steps", Read.array(Read.model(Step.self)))
        guard o.ok, let id, let title, let steps else { return nil }
        return Scene(id: id, title: title, line: line, hold: hold, steps: steps)
    }

    var json: JSONValue {
        var out: JSONObject = ["id": .string(id), "title": .string(title), "steps": steps.json]
        out.put("line", line?.json)
        out.put("hold", hold.map { hold in
            var fields: JSONObject = [:]
            fields.put("padBeforeMs", hold.padBeforeMs?.json)
            fields.put("padAfterMs", hold.padAfterMs?.json)
            return .object(fields)
        })
        return .object(out)
    }
}

/// A coreografia fonte (S0.4), já lida do YAML pelo Mac.
public struct Choreography: JSONModel {
    public var schema: String
    public var app: ChoreographyApp
    public var device: ChoreographyDevice
    public var guide: GuideSettings?
    public var confirm: [String]?
    public var targets: [JSONKey: Target]
    public var prepare: [Step]
    public var scenes: [Scene]
    public var cleanup: [Step]

    public init(
        schema: String = SchemaId.choreography, app: ChoreographyApp, device: ChoreographyDevice,
        guide: GuideSettings? = nil, confirm: [String]? = nil, targets: [JSONKey: Target] = [:],
        prepare: [Step] = [], scenes: [Scene], cleanup: [Step] = []
    ) {
        self.schema = schema
        self.app = app
        self.device = device
        self.guide = guide
        self.confirm = confirm
        self.targets = targets
        self.prepare = prepare
        self.scenes = scenes
        self.cleanup = cleanup
    }

    public static let modelName = "coreografia"
    public static var invalidCode: RunnerErrorCode? { .choreoInvalid }

    static let keys: Set<JSONKey> = ["schema", "app", "device", "guide", "confirm", "targets", "prepare", "scenes", "cleanup"]

    public static func read(_ json: JSONValue, at path: JSONPath, _ sink: IssueSink) -> Choreography? {
        guard var o = ObjectReader(json, at: path, sink, allowed: keys) else { return nil }
        return readFields(&o)
    }

    /// Lê os campos comuns à fonte e à forma compilada.
    static func readFields(_ o: inout ObjectReader) -> Choreography? {
        let schema = o.required("schema", Read.literal(SchemaId.choreography))
        let app: ChoreographyApp? = o.required("app") { json, path, sink in
            guard var a = ObjectReader(json, at: path, sink, allowed: ["bundleId", "iconLabel", "expectVersion", "urlPrefixes"])
            else { return nil }
            let bundleId = a.required("bundleId", Read.nonEmpty)
            let iconLabel = a.required("iconLabel", Read.string)
            let expectVersion = a.required("expectVersion", Read.string)
            let urlPrefixes = a.required("urlPrefixes", Read.array(Read.nonEmpty))
            guard a.ok, let bundleId, let iconLabel, let expectVersion, let urlPrefixes else { return nil }
            return ChoreographyApp(bundleId: bundleId, iconLabel: iconLabel, expectVersion: expectVersion, urlPrefixes: urlPrefixes)
        }
        let device: ChoreographyDevice? = o.required("device") { json, path, sink in
            guard var d = ObjectReader(json, at: path, sink, allowed: ["language", "screenPt", "textSize", "appearance"])
            else { return nil }
            let language = d.required("language", Read.nonEmpty)
            let screenPt = d.required("screenPt", Read.model(Size.self))
            let textSize = d.required("textSize", Read.nonEmpty)
            let appearance = d.required("appearance", Read.oneOf(Appearance.self))
            guard d.ok, let language, let screenPt, let textSize, let appearance else { return nil }
            return ChoreographyDevice(language: language, screenPt: screenPt, textSize: textSize, appearance: appearance)
        }
        let guide: GuideSettings? = o.optional("guide") { json, path, sink in
            guard var g = ObjectReader(json, at: path, sink, allowed: ["voice", "targetWpm"]) else { return nil }
            let voice = g.required("voice", Read.nonEmpty)
            let targetWpm = g.required("targetWpm", Read.positiveInt)
            guard g.ok, let voice, let targetWpm else { return nil }
            return GuideSettings(voice: voice, targetWpm: targetWpm)
        }
        let confirm = o.optional("confirm", Read.array(Read.string))
        let targets = o.required("targets", Read.record(Read.model(Target.self)))
        let steps: Reader<[Step]> = Read.array(Read.model(Step.self))
        let prepare = o.required("prepare", steps)
        let scenes = o.required("scenes", Read.array(Scene.read))
        let cleanup = o.required("cleanup", steps)

        // S0.4: ids de cena únicos.
        if case .array(let rawScenes)? = o.value("scenes") {
            var seen: [String: Int] = [:]
            for (position, raw) in rawScenes.enumerated() {
                guard case .string(let id)? = raw["id"] else { continue }
                if let first = seen[id] {
                    o.sink.add(o.path.key("scenes").index(position).key("id"), .sceneIdUnique,
                               "id de cena \"\(id)\" repetido (já em scenes[\(first)]) (S0.4)")
                    o.fail()
                } else {
                    seen[id] = position
                }
            }
        }

        guard o.ok, let schema, let app, let device, let targets, let prepare, let scenes, let cleanup else { return nil }
        return Choreography(schema: schema, app: app, device: device, guide: guide, confirm: confirm, targets: targets,
                            prepare: prepare, scenes: scenes, cleanup: cleanup)
    }

    var fields: JSONObject {
        var out: JSONObject = [
            "schema": .string(schema),
            "app": [
                "bundleId": .string(app.bundleId), "iconLabel": .string(app.iconLabel),
                "expectVersion": .string(app.expectVersion), "urlPrefixes": app.urlPrefixes.json,
            ],
            "device": [
                "language": .string(device.language), "screenPt": device.screenPt.json,
                "textSize": .string(device.textSize), "appearance": .string(device.appearance.rawValue),
            ],
            "targets": targets.json,
            "prepare": prepare.json,
            "scenes": .array(scenes.map(\.json)),
            "cleanup": cleanup.json,
        ]
        out.put("guide", guide.map { ["voice": .string($0.voice), "targetWpm": $0.targetWpm.json] })
        out.put("confirm", confirm?.json)
        return out
    }

    public var json: JSONValue { .object(fields) }
}

/// Fala da guia sintetizada numa cena compilada (tempos a partir do início da cena).
public struct CompiledSentence: Sendable, Equatable {
    public var text: String
    public var startMs: Int
    public var durMs: Int

    public init(text: String, startMs: Int, durMs: Int) {
        self.text = text
        self.startMs = startMs
        self.durMs = durMs
    }
}

public struct CompiledScene: Sendable, Equatable {
    public var id: String
    public var sentences: [CompiledSentence]
    public var holdMs: Int

    public init(id: String, sentences: [CompiledSentence], holdMs: Int) {
        self.id = id
        self.sentences = sentences
        self.holdMs = holdMs
    }
}

/// Guia usada na compilação: voz, ritmo medido e fator de ajuste.
public struct CompiledGuide: Sendable, Equatable {
    public var voice: String
    public var wpm: Double
    public var factor: Double

    public init(voice: String, wpm: Double, factor: Double) {
        self.voice = voice
        self.wpm = wpm
        self.factor = factor
    }
}

/// `compiled` (S0.4).
public struct CompiledInfo: Sendable, Equatable {
    /// SHA-256 (hex minúsculo) do JCS do documento compilado sem `compiled.sha256` e `compiled.compiledAt`.
    public var sha256: String
    public var compiledAt: String
    public var guide: CompiledGuide
    public var scenes: [CompiledScene]

    public init(sha256: String, compiledAt: String, guide: CompiledGuide, scenes: [CompiledScene]) {
        self.sha256 = sha256
        self.compiledAt = compiledAt
        self.guide = guide
        self.scenes = scenes
    }

    static func read(_ json: JSONValue, _ path: JSONPath, _ sink: IssueSink) -> CompiledInfo? {
        guard var o = ObjectReader(json, at: path, sink, allowed: ["sha256", "compiledAt", "guide", "scenes"]) else {
            return nil
        }
        let sha256 = o.required("sha256", Read.sha256Hex)
        let compiledAt = o.required("compiledAt", Read.nonEmpty)
        let guide: CompiledGuide? = o.required("guide") { json, path, sink in
            guard var g = ObjectReader(json, at: path, sink, allowed: ["voice", "wpm", "factor"]) else { return nil }
            let voice = g.required("voice", Read.nonEmpty)
            let wpm = g.required("wpm", Read.number(positive: true))
            let factor = g.required("factor", Read.number(positive: true))
            guard g.ok, let voice, let wpm, let factor else { return nil }
            return CompiledGuide(voice: voice, wpm: wpm, factor: factor)
        }
        let sentence: Reader<CompiledSentence> = { json, path, sink in
            guard var s = ObjectReader(json, at: path, sink, allowed: ["text", "startMs", "durMs"]) else { return nil }
            let text = s.required("text", Read.string)
            let startMs = s.required("startMs", Read.nonNegativeInt)
            let durMs = s.required("durMs", Read.nonNegativeInt)
            guard s.ok, let text, let startMs, let durMs else { return nil }
            return CompiledSentence(text: text, startMs: startMs, durMs: durMs)
        }
        let scene: Reader<CompiledScene> = { json, path, sink in
            guard var c = ObjectReader(json, at: path, sink, allowed: ["id", "sentences", "holdMs"]) else { return nil }
            let id = c.required("id", Read.sceneId)
            let sentences = c.required("sentences", Read.array(sentence))
            let holdMs = c.required("holdMs", Read.nonNegativeInt)
            guard c.ok, let id, let sentences, let holdMs else { return nil }
            return CompiledScene(id: id, sentences: sentences, holdMs: holdMs)
        }
        let scenes = o.required("scenes", Read.array(scene))
        guard o.ok, let sha256, let compiledAt, let guide, let scenes else { return nil }
        return CompiledInfo(sha256: sha256, compiledAt: compiledAt, guide: guide, scenes: scenes)
    }

    /// `compiled` sem `sha256` e `compiledAt` (a parte que entra no hash).
    var hashedJSON: JSONObject {
        [
            "guide": ["voice": .string(guide.voice), "wpm": .number(guide.wpm), "factor": .number(guide.factor)],
            "scenes": .array(scenes.map { scene in
                [
                    "id": .string(scene.id),
                    "sentences": .array(scene.sentences.map {
                        ["text": .string($0.text), "startMs": $0.startMs.json, "durMs": $0.durMs.json]
                    }),
                    "holdMs": scene.holdMs.json,
                ]
            }),
        ]
    }

    var json: JSONValue {
        var out = hashedJSON
        out["sha256"] = .string(sha256)
        out["compiledAt"] = .string(compiledAt)
        return .object(out)
    }
}

/// A coreografia compilada (S0.4): a fonte validada + `compiled`, com todos os `ref` expandidos e os
/// padrões preenchidos (`guide`, `hold` de cada cena e, em todo passo, `afterMs`, `timeoutMs`, `onFail`,
/// `sim` e, com `expect`, `expectTimeoutMs`).
public struct CompiledChoreography: JSONModel {
    public var choreography: Choreography
    public var compiled: CompiledInfo

    public init(choreography: Choreography, compiled: CompiledInfo) {
        self.choreography = choreography
        self.compiled = compiled
    }

    public static let modelName = "coreografia compilada"
    public static var invalidCode: RunnerErrorCode? { .choreoInvalid }

    static let stepDefaults = ["afterMs", "timeoutMs", "onFail", "sim"]

    public static func read(_ json: JSONValue, at path: JSONPath, _ sink: IssueSink) -> CompiledChoreography? {
        guard var o = ObjectReader(json, at: path, sink, allowed: Choreography.keys.union(["compiled"])) else { return nil }
        let choreography = Choreography.readFields(&o)
        let compiled = o.required("compiled", CompiledInfo.read)

        // Todo `ref` expandido: nenhum objeto de targets/prepare/scenes/cleanup pode ter a chave `ref`.
        for section in ["targets", "prepare", "scenes", "cleanup"] {
            if let value = o.value(section), !refsExpanded(value, path.key(section), sink) { o.fail() }
        }
        if let choreography, !defaultsFilled(choreography, path, sink) { o.fail() }

        guard o.ok, let choreography, let compiled else { return nil }
        return CompiledChoreography(choreography: choreography, compiled: compiled)
    }

    private static func refsExpanded(_ value: JSONValue, _ path: JSONPath, _ sink: IssueSink) -> Bool {
        switch value {
        case .array(let items):
            var ok = true
            for (position, item) in items.enumerated() where !refsExpanded(item, path.index(position), sink) { ok = false }
            return ok
        case .object(let fields):
            var ok = true
            if fields["ref"] != nil {
                sink.add(path.key("ref"), .refExpanded, "ref não expandido na coreografia compilada (S0.4)")
                ok = false
            }
            for key in fields.keys.sorted() where !refsExpanded(fields[key]!, path.key(key.string), sink) { ok = false }
            return ok
        default:
            return true
        }
    }

    private static func defaultsFilled(_ doc: Choreography, _ path: JSONPath, _ sink: IssueSink) -> Bool {
        var ok = true
        func missing(_ what: String, _ at: JSONPath) {
            sink.add(at, .compiledDefaults, "padrão não preenchido na forma compilada: \(what) (S0.4)")
            ok = false
        }
        func check(_ steps: [Step], _ at: JSONPath) {
            for (position, step) in steps.enumerated() {
                let stepPath = at.index(position)
                if step.afterMs == nil { missing("afterMs", stepPath.key("afterMs")) }
                if step.timeoutMs == nil { missing("timeoutMs", stepPath.key("timeoutMs")) }
                if step.onFail == nil { missing("onFail", stepPath.key("onFail")) }
                if step.sim == nil { missing("sim", stepPath.key("sim")) }
                if step.expect != nil && step.expectTimeoutMs == nil {
                    missing("expectTimeoutMs", stepPath.key("expectTimeoutMs"))
                }
                if let nested = step.action.nestedSteps { check(nested, stepPath.key("steps")) }
            }
        }
        if doc.guide == nil { missing("guide", path.key("guide")) }
        for (position, scene) in doc.scenes.enumerated() {
            let scenePath = path.key("scenes").index(position)
            if let hold = scene.hold {
                if hold.padBeforeMs == nil { missing("hold.padBeforeMs", scenePath.key("hold").key("padBeforeMs")) }
                if hold.padAfterMs == nil { missing("hold.padAfterMs", scenePath.key("hold").key("padAfterMs")) }
            } else {
                missing("hold", scenePath.key("hold"))
            }
            check(scene.steps, scenePath.key("steps"))
        }
        check(doc.prepare, path.key("prepare"))
        check(doc.cleanup, path.key("cleanup"))
        return ok
    }

    /// O documento que entra no `compiled.sha256`: tudo, menos `compiled.sha256` e `compiled.compiledAt`.
    public var hashInput: JSONValue {
        var out = choreography.fields
        out["compiled"] = .object(compiled.hashedJSON)
        return .object(out)
    }

    public var json: JSONValue {
        var out = choreography.fields
        out["compiled"] = compiled.json
        return .object(out)
    }
}
