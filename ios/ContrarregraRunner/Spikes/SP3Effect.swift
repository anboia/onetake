#if SPIKE
import ContrarregraKit
import Foundation
import XCTest

/// SP-3 (T-0.18): quando o efeito de um toque aparece na árvore do app — a parte "chamada → efeito na tela" que dá para
/// medir no próprio aparelho, sem vídeo. Um elemento do app alvo (ex.: o relógio do Now Playing, "0:32") é lido antes
/// do toque (linha de base, fora da janela medida) e de novo, sem pausa, depois do envio, até a condição valer ou o
/// prazo acabar. Cada leitura é uma consulta pública ao XCTest (um snapshot), então o resultado é um intervalo:
/// `tLowerNs` (começo da última leitura sem o efeito, ou o `tDispatchNs`) e `tUpperNs` (fim da primeira leitura com ele).
///
/// `effect` de `spike.tap`: `{type?, labelMatches | label | identifier, index?, attribute?: label|value,
/// until?: changed|clockJump, minJumpS?, timeoutMs?}`. `clockJump`: o relógio lido ("m:ss", "-m:ss", "h:mm:ss") se
/// afastou da linha de base mais do que o tempo que passou explica — |Δrelógio − Δt|, |Δrelógio + Δt| e |Δrelógio|
/// todos ≥ `minJumpS` − 1,5 s (relógio tocando para a frente, para trás ou parado; 1 s de resolução do rótulo).
struct SP3EffectSpec: Sendable {
    enum Attribute: String, Sendable { case label, value }
    enum Until: String, Sendable { case changed, clockJump }

    var type: ElementType = .any
    var labelMatches: String?
    var label: String?
    var identifier: String?
    var index = 0
    var attribute = Attribute.label
    var until = Until.changed
    var minJumpS = 10.0
    var timeoutMs = 3_000

    static let keys: Set<String> = ["type", "labelMatches", "label", "identifier", "index", "attribute", "until", "minJumpS",
                                    "timeoutMs"]

    static func read(_ json: JSONValue) throws(RpcErrorObject) -> SP3EffectSpec {
        guard let object = json.objectValue else { throw SP3Params.invalid("effect tem de ser objeto") }
        let fields = SP3Params.Fields(object, "effect")
        try fields.onlyKeys(keys)
        var spec = SP3EffectSpec()
        if let type = try fields.string("type") {
            guard let parsed = ElementType(rawValue: type) else { throw SP3Params.invalid("effect.type desconhecido: \(type)") }
            spec.type = parsed
        }
        spec.labelMatches = try fields.string("labelMatches")
        spec.label = try fields.string("label")
        spec.identifier = try fields.string("identifier")
        guard [spec.labelMatches, spec.label, spec.identifier].compactMap({ $0 }).count == 1 else {
            throw SP3Params.invalid("effect precisa de exatamente um de labelMatches, label, identifier")
        }
        spec.index = try fields.int("index", default: 0, 0...1_000)
        if let attribute = try fields.string("attribute") {
            guard let parsed = Attribute(rawValue: attribute) else { throw SP3Params.invalid("effect.attribute: label|value") }
            spec.attribute = parsed
        }
        if let until = try fields.string("until") {
            guard let parsed = Until(rawValue: until) else { throw SP3Params.invalid("effect.until: changed|clockJump") }
            spec.until = parsed
        }
        spec.minJumpS = try fields.number("minJumpS", default: 10, 2...3_600)
        spec.timeoutMs = try fields.int("timeoutMs", default: 3_000, 100...10_000)
        return spec
    }

    var predicate: NSPredicate {
        if let labelMatches { return NSPredicate(format: "label MATCHES %@", labelMatches) }
        if let label { return NSPredicate(format: "label == %@", label) }
        return NSPredicate(format: "identifier == %@", identifier ?? "")
    }

    var json: JSONValue {
        var out: JSONObject = ["type": .string(type.rawValue), "index": .number(Double(index)),
                               "attribute": .string(attribute.rawValue), "until": .string(until.rawValue),
                               "minJumpS": .number(minJumpS), "timeoutMs": .number(Double(timeoutMs))]
        if let labelMatches { out["labelMatches"] = .string(labelMatches) }
        if let label { out["label"] = .string(label) }
        if let identifier { out["identifier"] = .string(identifier) }
        return .object(out)
    }

    /// Segundos de um relógio "m:ss", "-m:ss" (ou com U+2212) ou "h:mm:ss" dentro do texto; `nil` sem relógio.
    static func clockSeconds(_ text: String) -> Double? {
        guard let regex = try? NSRegularExpression(pattern: "([-\u{2212}])?(\\d{1,2}):(\\d{2})(?::(\\d{2}))?"),
              let match = regex.firstMatch(in: text, range: NSRange(text.startIndex..., in: text))
        else { return nil }
        func group(_ index: Int) -> String? {
            guard let range = Range(match.range(at: index), in: text) else { return nil }
            return String(text[range])
        }
        guard let first = group(2).flatMap(Double.init), let second = group(3).flatMap(Double.init) else { return nil }
        let seconds = group(4).flatMap(Double.init).map { first * 3_600 + second * 60 + $0 } ?? first * 60 + second
        return group(1) == nil ? seconds : -seconds
    }

    /// O relógio saltou (ver o comentário do tipo).
    func isClockJump(baseline: String, value: String, elapsedS: Double) -> Bool {
        guard let base = Self.clockSeconds(baseline), let now = Self.clockSeconds(value) else { return false }
        let delta = now - base
        let threshold = minJumpS - 1.5
        return abs(delta - elapsedS) >= threshold && abs(delta + elapsedS) >= threshold && abs(delta) >= threshold
    }
}

/// Um efeito armado: elemento achado e linha de base lida, antes do `tDevStartNs`.
@MainActor
struct SP3ArmedEffect {
    let spec: SP3EffectSpec
    let element: XCUIElement
    let bundleId: String
    let baseline: String
    let baselineNs: UInt64

    /// Acha o elemento no app alvo (conferido pela lista permitida, como qualquer leitura) e lê a linha de base.
    static func arm(_ spec: SP3EffectSpec, _ context: SpikeMethods.Context) -> Result<SP3ArmedEffect, RpcErrorObject> {
        do {
            let scope = try ReadSession(context.read).appScope(nil)
            guard case .app(let bundleId) = scope else {
                return .failure(RpcErrorObject(.forbiddenApp, "E_FORBIDDEN_APP: o efeito só se lê no app alvo"))
            }
            let type = XCUIElement.ElementType(rawValue: spec.type.xcuiRawValue) ?? .any
            let element = context.bridge.application(bundleId).descendants(matching: type).matching(spec.predicate)
                .element(boundBy: spec.index)
            guard element.exists else {
                return .failure(RpcErrorObject(.targetNotFound, "E_TARGET_NOT_FOUND: elemento do efeito não achado "
                                               + "(\(spec.type.rawValue) \(spec.predicate.predicateFormat) #\(spec.index))"))
            }
            let baseline = read(element, spec.attribute)
            let armed = SP3ArmedEffect(spec: spec, element: element, bundleId: bundleId, baseline: baseline,
                                       baselineNs: context.clock())
            if spec.until == .clockJump, SP3EffectSpec.clockSeconds(baseline) == nil {
                return .failure(RpcErrorObject(.targetNotFound, "E_TARGET_NOT_FOUND: o elemento do efeito não tem relógio "
                                               + "(lido: \(baseline))"))
            }
            return .success(armed)
        } catch {
            return .failure(error)
        }
    }

    static func read(_ element: XCUIElement, _ attribute: SP3EffectSpec.Attribute) -> String {
        switch attribute {
        case .label: element.label
        case .value: XCUIBridge.text(element.value) ?? ""
        }
    }

    func satisfied(_ value: String, atNs: UInt64) -> Bool {
        switch spec.until {
        case .changed: value != baseline
        case .clockJump: spec.isClockJump(baseline: baseline, value: value, elapsedS: Double(atNs &- baselineNs) / 1e9)
        }
    }

    /// Lê sem pausa até a condição valer ou `timeoutMs` passar, a partir de agora; `since` é o limite de baixo inicial
    /// (o `tDispatchNs` do toque). Guarda só as mudanças de valor (até 20).
    func poll(since: UInt64, clock: () -> UInt64) -> JSONObject {
        let started = clock()
        let deadline = started &+ UInt64(spec.timeoutMs) * 1_000_000
        var lower = since
        var polls = 0
        var last = baseline
        var changes: [JSONValue] = []
        var out: JSONObject = ["baseline": .string(baseline), "tBaselineNs": .string(String(baselineNs)),
                               "tPollStartNs": .string(String(started)), "spec": spec.json]
        while true {
            let readStart = clock()
            let value = Self.read(element, spec.attribute)
            let readEnd = clock()
            polls += 1
            if value != last, changes.count < 20 {
                changes.append(["tNs": .string(String(readEnd)), "value": .string(value)])
            }
            last = value
            if satisfied(value, atNs: readEnd) {
                out["satisfied"] = true
                out["value"] = .string(value)
                out["tLowerNs"] = .string(String(lower))
                out["tUpperNs"] = .string(String(readEnd))
                break
            }
            lower = readStart
            if readEnd >= deadline {
                out["satisfied"] = false
                out["value"] = .string(value)
                out["tLastReadNs"] = .string(String(readEnd))
                break
            }
        }
        out["polls"] = .number(Double(polls))
        out["changes"] = .array(changes)
        return out
    }
}
#endif
