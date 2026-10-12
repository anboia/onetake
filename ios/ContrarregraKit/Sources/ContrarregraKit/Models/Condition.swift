import Foundation

// S0.3 Condição.

public enum ElementState: String, Sendable, CaseIterable {
    case exists, gone, hittable, selected, value, changed
}

public enum TextState: String, Sendable, CaseIterable {
    case visible, gone
}

public enum AppRunState: String, Sendable, CaseIterable {
    case foreground, background, notRunning
}

public enum OnOff: String, Sendable, CaseIterable {
    case on, off
}

public enum NetworkState: String, Sendable, CaseIterable {
    case online, offline
}

/// Condição de S0.3. `state: changed` só vale em `expect`: `read` (waitFor, assert, checkpoint.until,
/// block.when, repeat.until, condição solta) o recusa no próprio `state`; `readExpect` o aceita em
/// qualquer profundidade.
public indirect enum Condition: JSONModel {
    case element(Target, state: ElementState, equals: String?)
    case text(OcrSelector, state: TextState)
    case appState(app: String, state: AppRunState)
    case locked(Bool)
    case airplane(OnOff)
    case network(NetworkState)
    case all([Condition])
    case any([Condition])
    case not(Condition)

    public static let modelName = "condição"
    public static var invalidCode: RunnerErrorCode? { .choreoInvalid }

    public static func read(_ json: JSONValue, at path: JSONPath, _ sink: IssueSink) -> Condition? {
        read(json, at: path, sink, allowChanged: false)
    }

    /// A condição de um `expect` (aceita `state: changed`).
    static func readExpect(_ json: JSONValue, _ path: JSONPath, _ sink: IssueSink) -> Condition? {
        read(json, at: path, sink, allowChanged: true)
    }

    static func read(_ json: JSONValue, at path: JSONPath, _ sink: IssueSink, allowChanged: Bool) -> Condition? {
        guard case .object(let fields) = json else {
            sink.add(path, .type, "esperava um objeto, veio \(json.typeName)")
            return nil
        }
        let nested: Reader<Condition> = { json, path, sink in read(json, at: path, sink, allowChanged: allowChanged) }
        if fields["element"] != nil {
            guard var o = ObjectReader(json, at: path, sink, allowed: ["element", "state", "equals"]) else { return nil }
            let target = o.required("element", Read.model(Target.self))
            let state = o.required("state", Read.oneOf(ElementState.self))
            let equals = o.optional("equals", Read.string)
            if !allowChanged, state == .changed {
                o.fail("state", .changedOnlyInExpect, "state: changed só vale em expect (S0.3)")
            }
            guard o.ok, let target, let state else { return nil }
            return .element(target, state: state, equals: equals)
        }
        if fields["text"] != nil {
            guard var o = ObjectReader(json, at: path, sink, allowed: ["text"]) else { return nil }
            let text: (OcrSelector, TextState)? = o.required("text") { json, path, sink in
                guard var t = ObjectReader(json, at: path, sink, allowed: ["ocr", "state"]) else { return nil }
                let ocr = t.required("ocr", Read.model(OcrSelector.self))
                let state = t.required("state", Read.oneOf(TextState.self))
                guard t.ok, let ocr, let state else { return nil }
                return (ocr, state)
            }
            guard o.ok, let text else { return nil }
            return .text(text.0, state: text.1)
        }
        if fields["appState"] != nil {
            guard var o = ObjectReader(json, at: path, sink, allowed: ["appState"]) else { return nil }
            let app: (String, AppRunState)? = o.required("appState") { json, path, sink in
                guard var a = ObjectReader(json, at: path, sink, allowed: ["app", "state"]) else { return nil }
                let name = a.required("app", Read.nonEmpty)
                let state = a.required("state", Read.oneOf(AppRunState.self))
                guard a.ok, let name, let state else { return nil }
                return (name, state)
            }
            guard o.ok, let app else { return nil }
            return .appState(app: app.0, state: app.1)
        }
        if fields["locked"] != nil {
            guard var o = ObjectReader(json, at: path, sink, allowed: ["locked"]) else { return nil }
            let locked = o.required("locked", Read.bool)
            guard o.ok, let locked else { return nil }
            return .locked(locked)
        }
        if fields["airplane"] != nil {
            guard var o = ObjectReader(json, at: path, sink, allowed: ["airplane"]) else { return nil }
            let airplane = o.required("airplane", Read.oneOf(OnOff.self))
            guard o.ok, let airplane else { return nil }
            return .airplane(airplane)
        }
        if fields["network"] != nil {
            guard var o = ObjectReader(json, at: path, sink, allowed: ["network"]) else { return nil }
            let network = o.required("network", Read.oneOf(NetworkState.self))
            guard o.ok, let network else { return nil }
            return .network(network)
        }
        if fields["all"] != nil {
            guard var o = ObjectReader(json, at: path, sink, allowed: ["all"]) else { return nil }
            let all = o.required("all", Read.array(nested))
            guard o.ok, let all else { return nil }
            return .all(all)
        }
        if fields["any"] != nil {
            guard var o = ObjectReader(json, at: path, sink, allowed: ["any"]) else { return nil }
            let any = o.required("any", Read.array(nested))
            guard o.ok, let any else { return nil }
            return .any(any)
        }
        if fields["not"] != nil {
            guard var o = ObjectReader(json, at: path, sink, allowed: ["not"]) else { return nil }
            let not = o.required("not", nested)
            guard o.ok, let not else { return nil }
            return .not(not)
        }
        sink.add(path, .conditionForm,
                 "condição sem forma de S0.3 (element, text, appState, locked, airplane, network, all, any, not)")
        return nil
    }

    public var json: JSONValue {
        switch self {
        case .element(let target, let state, let equals):
            var out: JSONObject = ["element": target.json, "state": .string(state.rawValue)]
            out.put("equals", equals?.json)
            return .object(out)
        case .text(let ocr, let state):
            return ["text": ["ocr": ocr.json, "state": .string(state.rawValue)]]
        case .appState(let app, let state):
            return ["appState": ["app": .string(app), "state": .string(state.rawValue)]]
        case .locked(let locked):
            return ["locked": .bool(locked)]
        case .airplane(let airplane):
            return ["airplane": .string(airplane.rawValue)]
        case .network(let network):
            return ["network": .string(network.rawValue)]
        case .all(let conditions):
            return ["all": conditions.json]
        case .any(let conditions):
            return ["any": conditions.json]
        case .not(let condition):
            return ["not": condition.json]
        }
    }
}
