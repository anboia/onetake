import Foundation

// S0.4 Passos da coreografia: campos comuns + `do` + argumentos da ação no mesmo objeto.

public enum OnFail: String, Sendable, CaseIterable { case pause, abort, `continue` }
public enum SimMode: String, Sendable, CaseIterable { case run, skip, simulate }
public enum ScrollDirection: String, Sendable, CaseIterable { case down, up }
public enum HardwareButton: String, Sendable, CaseIterable { case home, volumeUp, volumeDown }
public enum OpenClose: String, Sendable, CaseIterable { case open, close }
public enum AppAction: String, Sendable, CaseIterable { case activate, terminate, launch }
public enum CheckpointWho: String, Sendable, CaseIterable { case human, runner }
public enum CheckpointTimeout: String, Sendable, CaseIterable { case pause, abort }

/// Nome de cada ação (`do`), na ordem de `STEP_ACTIONS` do Mac.
public enum StepActionName: String, Sendable, CaseIterable {
    case tap, doubleTap, longPress, drag, scrollTo, type, press, lock, wake, home
    case controlCenter, app, openURL, wait, waitFor, assert, checkpoint, block, mark, hold
}

/// `repeat: {until, max}`.
public struct StepRepeat: Sendable, Equatable {
    public var until: Condition
    public var max: Int

    public init(until: Condition, max: Int) {
        self.until = until
        self.max = max
    }
}

/// `drag`: de `from` a `to`, passando por `via`; `velocity` e `durationMs` são excludentes.
public struct DragArgs: Sendable, Equatable {
    public var from: PointOrTarget
    public var to: PointOrTarget
    public var via: [PointOrTarget]?
    public var pressMs: Int?
    public var velocity: Double?
    public var durationMs: Int?
    public var holdMs: Int?

    public init(from: PointOrTarget, to: PointOrTarget, via: [PointOrTarget]? = nil, pressMs: Int? = nil,
                velocity: Double? = nil, durationMs: Int? = nil, holdMs: Int? = nil) {
        self.from = from
        self.to = to
        self.via = via
        self.pressMs = pressMs
        self.velocity = velocity
        self.durationMs = durationMs
        self.holdMs = holdMs
    }
}

/// Ponto de controle (S5 item 1). `id` e `timeoutMs` ficam nos campos comuns do passo (obrigatórios aqui).
public struct CheckpointArgs: Sendable, Equatable {
    public var who: CheckpointWho
    public var ask: String
    public var until: Condition
    public var onTimeout: CheckpointTimeout
    public var steps: [Step]?
    public var alert: CheckpointAlert?

    public init(who: CheckpointWho, ask: String, until: Condition, onTimeout: CheckpointTimeout,
                steps: [Step]? = nil, alert: CheckpointAlert? = nil) {
        self.who = who
        self.ask = ask
        self.until = until
        self.onTimeout = onTimeout
        self.steps = steps
        self.alert = alert
    }
}

/// `alert: {sound, say}` de um ponto de controle (a forma dos valores é de S5).
public struct CheckpointAlert: Sendable, Equatable {
    public var sound: JSONValue
    public var say: JSONValue

    public init(sound: JSONValue, say: JSONValue) {
        self.sound = sound
        self.say = say
    }
}

/// A ação de um passo e seus argumentos próprios.
public enum StepAction: Sendable, Equatable {
    case tap
    case doubleTap
    case longPress(durationMs: Int)
    case drag(DragArgs)
    case scrollTo(within: Target?, direction: ScrollDirection, maxSwipes: Int)
    case type(text: String)
    case press(button: HardwareButton)
    case lock
    case wake
    case home
    case controlCenter(OpenClose)
    case app(AppAction)
    case openURL(url: String)
    case wait(ms: Int)
    case waitFor(Condition)
    case assert(Condition)
    case checkpoint(CheckpointArgs)
    case block(when: Condition?, steps: [Step])
    case mark(label: String)
    case hold

    public var name: StepActionName {
        switch self {
        case .tap: .tap
        case .doubleTap: .doubleTap
        case .longPress: .longPress
        case .drag: .drag
        case .scrollTo: .scrollTo
        case .type: .type
        case .press: .press
        case .lock: .lock
        case .wake: .wake
        case .home: .home
        case .controlCenter: .controlCenter
        case .app: .app
        case .openURL: .openURL
        case .wait: .wait
        case .waitFor: .waitFor
        case .assert: .assert
        case .checkpoint: .checkpoint
        case .block: .block
        case .mark: .mark
        case .hold: .hold
        }
    }

    /// Passos aninhados (`block` e `checkpoint`).
    public var nestedSteps: [Step]? {
        switch self {
        case .block(_, let steps): steps
        case .checkpoint(let args): args.steps
        default: nil
        }
    }
}

/// Um passo de S0.4.
public struct Step: JSONModel {
    public var id: String?
    public var target: Target?
    public var cue: Int?
    public var afterMs: Int?
    public var timeoutMs: Int?
    public var expect: Condition?
    public var expectTimeoutMs: Int?
    public var `repeat`: StepRepeat?
    public var onFail: OnFail?
    public var optional: Bool?
    public var caption: String?
    public var visual: Bool?
    public var sim: SimMode?
    public var action: StepAction

    public init(
        _ action: StepAction, id: String? = nil, target: Target? = nil, cue: Int? = nil, afterMs: Int? = nil,
        timeoutMs: Int? = nil, expect: Condition? = nil, expectTimeoutMs: Int? = nil, repeat: StepRepeat? = nil,
        onFail: OnFail? = nil, optional: Bool? = nil, caption: String? = nil, visual: Bool? = nil, sim: SimMode? = nil
    ) {
        self.action = action
        self.id = id
        self.target = target
        self.cue = cue
        self.afterMs = afterMs
        self.timeoutMs = timeoutMs
        self.expect = expect
        self.expectTimeoutMs = expectTimeoutMs
        self.repeat = `repeat`
        self.onFail = onFail
        self.optional = optional
        self.caption = caption
        self.visual = visual
        self.sim = sim
    }

    public static let modelName = "passo"
    public static var invalidCode: RunnerErrorCode? { .choreoInvalid }

    /// Limite da legenda (S0.4), em code points (o `Array.from(s).length` do Mac).
    public static let captionMax = 34

    static let commonKeys: Set<JSONKey> = [
        "id", "target", "cue", "afterMs", "timeoutMs", "expect", "expectTimeoutMs", "repeat", "onFail", "optional",
        "caption", "visual", "sim",
    ]

    static let actionKeys: [StepActionName: Set<JSONKey>] = [
        .longPress: ["durationMs"],
        .drag: ["from", "to", "via", "pressMs", "velocity", "durationMs", "holdMs"],
        .scrollTo: ["within", "direction", "maxSwipes"],
        .type: ["text"],
        .press: ["button"],
        .controlCenter: ["action"],
        .app: ["action"],
        .openURL: ["url"],
        .wait: ["ms"],
        .waitFor: ["condition"],
        .assert: ["condition"],
        .checkpoint: ["who", "ask", "until", "onTimeout", "steps", "alert"],
        .block: ["when", "steps"],
        .mark: ["label"],
    ]

    static let readCaption: Reader<String> = { json, path, sink in
        guard let text = Read.string(json, path, sink) else { return nil }
        guard text.unicodeScalars.count <= captionMax else {
            sink.add(path, .captionMax, "caption com mais de \(captionMax) caracteres (S0.4)")
            return nil
        }
        return text
    }

    public static func read(_ json: JSONValue, at path: JSONPath, _ sink: IssueSink) -> Step? {
        guard case .object(let fields) = json else {
            sink.add(path, .type, "esperava um objeto, veio \(json.typeName)")
            return nil
        }
        guard let doValue = fields["do"] else {
            sink.add(path.key("do"), .required, "campo obrigatório ausente")
            return nil
        }
        guard case .string(let doName) = doValue, let name = StepActionName(rawValue: doName) else {
            let options = StepActionName.allCases.map { "\"\($0.rawValue)\"" }.joined(separator: ", ")
            sink.add(path.key("do"), .value, "ação desconhecida; esperava um de: \(options)")
            return nil
        }
        let allowed = commonKeys.union(["do"]).union(actionKeys[name] ?? [])
        guard var o = ObjectReader(json, at: path, sink, allowed: allowed) else { return nil }

        let needsTarget: Set<StepActionName> = [.tap, .doubleTap, .longPress, .scrollTo]
        let target = needsTarget.contains(name)
            ? o.required("target", Read.model(Target.self)) : o.optional("target", Read.model(Target.self))
        let id = name == .checkpoint ? o.required("id", Read.nonEmpty) : o.optional("id", Read.nonEmpty)
        let timeoutMs = name == .checkpoint
            ? o.required("timeoutMs", Read.nonNegativeInt) : o.optional("timeoutMs", Read.nonNegativeInt)
        let cue = o.optional("cue", Read.nonNegativeInt)
        let afterMs = o.optional("afterMs", Read.nonNegativeInt)
        let expect = o.optional("expect", Condition.readExpect)
        let expectTimeoutMs = o.optional("expectTimeoutMs", Read.nonNegativeInt)
        let repeatValue: StepRepeat? = o.optional("repeat") { json, path, sink in
            guard var r = ObjectReader(json, at: path, sink, allowed: ["until", "max"]) else { return nil }
            let until = r.required("until", Read.model(Condition.self))
            let max = r.required("max", Read.positiveInt)
            guard r.ok, let until, let max else { return nil }
            return StepRepeat(until: until, max: max)
        }
        let onFail = o.optional("onFail", Read.oneOf(OnFail.self))
        let optional = o.optional("optional", Read.bool)
        let caption = o.optional("caption", Step.readCaption)
        let visual = o.optional("visual", Read.bool)
        let sim = o.optional("sim", Read.oneOf(SimMode.self))

        let action = readAction(name, &o)
        guard o.ok, let action else { return nil }
        return Step(
            action, id: id, target: target, cue: cue, afterMs: afterMs, timeoutMs: timeoutMs, expect: expect,
            expectTimeoutMs: expectTimeoutMs, repeat: repeatValue, onFail: onFail, optional: optional,
            caption: caption, visual: visual, sim: sim
        )
    }

    private static func readAction(_ name: StepActionName, _ o: inout ObjectReader) -> StepAction? {
        let steps: Reader<[Step]> = Read.array(Read.model(Step.self))
        switch name {
        case .tap: return .tap
        case .doubleTap: return .doubleTap
        case .longPress: return o.required("durationMs", Read.positiveInt).map { .longPress(durationMs: $0) }
        case .drag:
            let from = o.required("from", Read.model(PointOrTarget.self))
            let to = o.required("to", Read.model(PointOrTarget.self))
            let via = o.optional("via", Read.array(Read.model(PointOrTarget.self)))
            let pressMs = o.optional("pressMs", Read.nonNegativeInt)
            let velocity = o.optional("velocity", Read.number(positive: true))
            let durationMs = o.optional("durationMs", Read.positiveInt)
            let holdMs = o.optional("holdMs", Read.nonNegativeInt)
            if o.has("velocity") && o.has("durationMs") {
                o.fail("durationMs", .velocityXorDuration, "drag com velocity e durationMs juntos; são excludentes (S0.4)")
            }
            guard let from, let to else { return nil }
            return .drag(DragArgs(from: from, to: to, via: via, pressMs: pressMs, velocity: velocity,
                                  durationMs: durationMs, holdMs: holdMs))
        case .scrollTo:
            let within = o.optional("within", Read.model(Target.self))
            let direction = o.required("direction", Read.oneOf(ScrollDirection.self))
            let maxSwipes = o.required("maxSwipes", Read.positiveInt)
            guard let direction, let maxSwipes else { return nil }
            return .scrollTo(within: within, direction: direction, maxSwipes: maxSwipes)
        case .type: return o.required("text", Read.string).map { .type(text: $0) }
        case .press: return o.required("button", Read.oneOf(HardwareButton.self)).map { .press(button: $0) }
        case .lock: return .lock
        case .wake: return .wake
        case .home: return .home
        case .controlCenter: return o.required("action", Read.oneOf(OpenClose.self)).map { .controlCenter($0) }
        case .app: return o.required("action", Read.oneOf(AppAction.self)).map { .app($0) }
        case .openURL: return o.required("url", Read.nonEmpty).map { .openURL(url: $0) }
        case .wait: return o.required("ms", Read.nonNegativeInt).map { .wait(ms: $0) }
        case .waitFor: return o.required("condition", Read.model(Condition.self)).map { .waitFor($0) }
        case .assert: return o.required("condition", Read.model(Condition.self)).map { .assert($0) }
        case .checkpoint:
            let who = o.required("who", Read.oneOf(CheckpointWho.self))
            let ask = o.required("ask", Read.string)
            let until = o.required("until", Read.model(Condition.self))
            let onTimeout = o.required("onTimeout", Read.oneOf(CheckpointTimeout.self))
            let nested = o.optional("steps", steps)
            let alert: CheckpointAlert? = o.optional("alert") { json, path, sink in
                guard var a = ObjectReader(json, at: path, sink, allowed: ["sound", "say"]) else { return nil }
                let sound = a.required("sound", Read.json)
                let say = a.required("say", Read.json)
                guard a.ok, let sound, let say else { return nil }
                return CheckpointAlert(sound: sound, say: say)
            }
            guard let who, let ask, let until, let onTimeout else { return nil }
            return .checkpoint(CheckpointArgs(who: who, ask: ask, until: until, onTimeout: onTimeout,
                                              steps: nested, alert: alert))
        case .block:
            let when = o.optional("when", Read.model(Condition.self))
            return o.required("steps", steps).map { .block(when: when, steps: $0) }
        case .mark: return o.required("label", Read.string).map { .mark(label: $0) }
        case .hold: return .hold
        }
    }

    public var json: JSONValue {
        var out: JSONObject = ["do": .string(action.name.rawValue)]
        out.put("id", id?.json)
        out.put("target", target?.json)
        out.put("cue", cue?.json)
        out.put("afterMs", afterMs?.json)
        out.put("timeoutMs", timeoutMs?.json)
        out.put("expect", expect?.json)
        out.put("expectTimeoutMs", expectTimeoutMs?.json)
        out.put("repeat", self.repeat.map { ["until": $0.until.json, "max": $0.max.json] })
        out.put("onFail", onFail.map { .string($0.rawValue) })
        out.put("optional", optional?.json)
        out.put("caption", caption?.json)
        out.put("visual", visual?.json)
        out.put("sim", sim.map { .string($0.rawValue) })
        switch action {
        case .tap, .doubleTap, .lock, .wake, .home, .hold:
            break
        case .longPress(let durationMs):
            out["durationMs"] = durationMs.json
        case .drag(let args):
            out["from"] = args.from.json
            out["to"] = args.to.json
            out.put("via", args.via?.json)
            out.put("pressMs", args.pressMs?.json)
            out.put("velocity", args.velocity?.json)
            out.put("durationMs", args.durationMs?.json)
            out.put("holdMs", args.holdMs?.json)
        case .scrollTo(let within, let direction, let maxSwipes):
            out.put("within", within?.json)
            out["direction"] = .string(direction.rawValue)
            out["maxSwipes"] = maxSwipes.json
        case .type(let text):
            out["text"] = .string(text)
        case .press(let button):
            out["button"] = .string(button.rawValue)
        case .controlCenter(let action):
            out["action"] = .string(action.rawValue)
        case .app(let action):
            out["action"] = .string(action.rawValue)
        case .openURL(let url):
            out["url"] = .string(url)
        case .wait(let ms):
            out["ms"] = ms.json
        case .waitFor(let condition), .assert(let condition):
            out["condition"] = condition.json
        case .checkpoint(let args):
            out["who"] = .string(args.who.rawValue)
            out["ask"] = .string(args.ask)
            out["until"] = args.until.json
            out["onTimeout"] = .string(args.onTimeout.rawValue)
            out.put("steps", args.steps?.json)
            out.put("alert", args.alert.map { ["sound": $0.sound, "say": $0.say] })
        case .block(let when, let steps):
            out.put("when", when?.json)
            out["steps"] = steps.json
        case .mark(let label):
            out["label"] = .string(label)
        }
        return .object(out)
    }
}
