#if SPIKE
import ContrarregraKit
import CoreGraphics
import Foundation
import XCTest

/// SP-3 (T-0.18; S1 item 5, A10 PX-2/PX-3, AC-1.5, AC-1.18): toques num alvo do app enquanto ele anima, por variante,
/// com os tempos de cada toque e, se pedido, o intervalo em que o efeito aparece na árvore (`SP3Effect.swift`).
///
/// - `spike.tapProbe {}` → `{build, capabilities: {PX-2, PX-3}, variants: {a, b, c, d: {available, reason?}},
///   completionBlock}`: o que cada variante precisa e se roda agora (sondagem só de leitura; nada privado é chamado
///   sem o PX-n presente e liberado).
/// - `spike.tap {variant, base?, quiescence?, target, count?, gapMs?, restore?, pressMs?, seq?, effect?,
///   completionTimeoutMs?}` → `{taps: [...]}`: `count` toques medidos (padrão 1) e, com `restore`, depois de cada um,
///   um toque de restaurar a tela no alvo `restore` com a mesma variante (sem efeito). Cada item: `{i, role:
///   measure|restore, variant, base, seq?, point, nodeRef?, tDevStartNs, tDispatchNs, tDevEndNs, path, detail,
///   effect?}`, ou `{…, error}` — o primeiro erro para a rajada e vem no item, não como erro da chamada.
///
/// Variantes (tasks.md T-0.18):
/// - `a` público: `XCUIElement.tap()` no elemento resolvido (`base: element`, padrão) ou o caminho do `ui.tap` de hoje,
///   o `XCUICoordinate` do SpringBoard no ponto resolvido (`base: coordinate`);
/// - `b` PX-2, opções de interação: o mesmo toque público dentro de `_performWithInteractionOptions:` com
///   SkipPre|SkipPost do app do alvo (com `base: coordinate`, também do SpringBoard, dono da coordenada);
/// - `c` PX-2, troca do método de espera: o mesmo toque público com `waitForQuiescence…:isPreEvent:` trocado —
///   `quiescence: skip` (padrão) pula a espera do app do alvo (e do SpringBoard com `base: coordinate`); `observe` não
///   pula nada e só cronometra cada espera (onde e quanto o toque público espera);
/// - `d` PX-3: evento sintetizado no ponto resolvido, tocando por `pressMs` (padrão 50).
///
/// Todo toque começa como o `ui.tap` (`ActionMethods.tap`): resolve o alvo, confere que é tocável e a lista permitida
/// com a tela relida. Tempos no relógio D: `tDevStartNs` antes da resolução; `tDispatchNs` logo antes do envio (o que a
/// variante monta — elemento, coordenada, registro sintetizado — fica antes dele); `tDevEndNs` quando o envio volta
/// (em `d`, depois da conclusão do testmanagerd). As marcas `SP-3 tap … begin|end` vão ao registro do runner (e ao
/// `xcodebuild.log` da sessão) fora da janela medida, para o driver achar as linhas "Wait for … to idle" de cada toque.
enum SP3Taps {
    static let probeMethod = "spike.tapProbe"
    static let tapMethod = "spike.tap"
    static let methods = [probeMethod, tapMethod]

    /// As APIs privadas, só se presentes e liberadas (o mesmo portão do `PrivateLocker`).
    struct Tools: Sendable {
        var quiescence: PrivateQuiescence?
        var synthesizer: PrivateSynthesizer?
    }

    static func register(into router: inout RpcRouter, _ context: SpikeMethods.Context) {
        let tools = Tools(quiescence: PrivateQuiescence.make(context.capabilities),
                          synthesizer: PrivateSynthesizer.make(context.capabilities))
        router.register(probeMethod, lane: .xctest) { _ throws(RpcErrorObject) in
            MainActor.assumeIsolated { probe(context, tools) }
        }
        router.register(tapMethod, lane: .xctest, deadline: { deadlineSeconds($0) }) { call throws(RpcErrorObject) in
            let params = try SP3Params.read(call.params)
            return MainActor.assumeIsolated { taps(params, context, tools) }
        }
    }

    /// Prazo da rajada: ⚠️ 10 s por toque (o padrão de S1 item 3) mais o prazo do efeito, vezes os toques (medidos e de
    /// restaurar), mais as pausas; no máximo 15 min. Parâmetros inválidos: o padrão (a resposta é o erro de validação).
    static func deadlineSeconds(_ params: JSONObject?) -> Double? {
        guard let parsed = try? SP3Params.read(params) else { return RpcDeadlines.defaultSeconds }
        let perTap = RpcDeadlines.defaultSeconds + Double(parsed.effect?.timeoutMs ?? 0) / 1000
            + Double(parsed.completionTimeoutMs) / 1000
        let taps = Double(parsed.count * (parsed.restore == nil ? 1 : 2))
        return min(900, taps * (perTap + Double(parsed.gapMs) / 1000) + 5)
    }

    // MARK: spike.tapProbe

    @MainActor
    static func probe(_ context: SpikeMethods.Context, _ tools: Tools) -> JSONValue {
        let capabilities = context.capabilities
        func capability(_ id: PrivateApiId) -> JSONValue {
            ["present": .bool(capabilities[id]?.present ?? false), "allowed": .bool(capabilities[id]?.allowed ?? false)]
        }
        func variant(_ id: PrivateApiId?, usable: Bool, _ reason: () -> String?) -> JSONValue {
            guard let id else { return ["available": true, "needs": "público"] }
            guard usable else {
                return ["available": false, "needs": .string(id.rawValue),
                        "reason": .string("E_CAPABILITY_MISSING: \(id.rawValue) ausente ou não liberado em CONTRARREGRA_PRIVATE")]
            }
            if let why = reason() { return ["available": false, "needs": .string(id.rawValue), "reason": .string(why)] }
            return ["available": true, "needs": .string(id.rawValue)]
        }
        var out: JSONObject = [
            "build": "Spike",
            "capabilities": ["PX-2": capability(.px2), "PX-3": capability(.px3)],
            "variants": [
                "a": variant(nil, usable: true) { nil },
                "b": variant(.px2, usable: tools.quiescence != nil) { PrivateQuiescence.interactionOptionsUnavailable() },
                "c": variant(.px2, usable: tools.quiescence != nil) { PrivateQuiescence.quiescenceSwapUnavailable() },
                "d": variant(.px3, usable: tools.synthesizer != nil) { PrivateSynthesizer.unavailableReason() },
            ],
        ]
        if tools.synthesizer != nil { out["completionBlock"] = .string(PrivateSynthesizer.completionBlockSummary) }
        return .object(out)
    }

    // MARK: spike.tap

    @MainActor
    static func taps(_ params: SP3Params, _ context: SpikeMethods.Context, _ tools: Tools) -> JSONValue {
        var items: [JSONValue] = []
        burst: for index in 0..<params.count {
            if index > 0 { pause(params.gapMs) }
            let measured = once(params, target: params.target, role: .measure, index: index, context, tools)
            items.append(measured.json)
            guard measured.ok else { break burst }
            if let restore = params.restore {
                pause(params.gapMs)
                let restored = once(params, target: restore, role: .restore, index: index, context, tools)
                items.append(restored.json)
                guard restored.ok else { break burst }
            }
        }
        return ["taps": .array(items)]
    }

    enum Role: String { case measure, restore }

    private static func pause(_ ms: Int) {
        if ms > 0 { XCUIDeviceController.pause(UInt64(ms) * 1_000_000) }
    }

    /// Um toque: efeito armado (linha de base) → marca `begin` → janela medida → marca `end` → leituras do efeito.
    @MainActor
    private static func once(_ params: SP3Params, target: Target, role: Role, index: Int, _ context: SpikeMethods.Context,
                             _ tools: Tools) -> (json: JSONValue, ok: Bool) {
        var out: JSONObject = ["i": .number(Double(index)), "role": .string(role.rawValue),
                               "variant": .string(params.variant.rawValue)]
        if params.variant != .d { out["base"] = .string(params.base.rawValue) }
        if let seq = params.seq { out["seq"] = .number(Double(seq)) }
        if params.variant == .c { out["quiescence"] = .string(params.quiescence.rawValue) }
        let tag = "seq=\(params.seq.map(String.init) ?? "-") i=\(index) role=\(role.rawValue) variant=\(params.tag)"

        var armed: SP3ArmedEffect?
        if role == .measure, let spec = params.effect {
            switch SP3ArmedEffect.arm(spec, context) {
            case .success(let effect): armed = effect
            case .failure(let error): out["effect"] = ["error": error.json]
            }
        }

        RunnerLog.info("SP-3 tap \(tag) begin")
        switch measure(params, target: target, context, tools) {
        case .success(let measured):
            for (key, value) in measured { out[key] = value }
            let ms = durationMs(measured["tDevStartNs"], measured["tDevEndNs"])
            RunnerLog.info("SP-3 tap \(tag) end ms=\(ms.map { String(format: "%.1f", $0) } ?? "?")")
            if let armed, let dispatched = measured["tDispatchNs"]?.stringValue.flatMap(UInt64.init) {
                out["effect"] = .object(armed.poll(since: dispatched, clock: context.clock))
            }
            return (.object(out), true)
        case .failure(let error):
            RunnerLog.info("SP-3 tap \(tag) end error=\(error.code)")
            out["error"] = error.json
            return (.object(out), false)
        }
    }

    private static func durationMs(_ start: JSONValue?, _ end: JSONValue?) -> Double? {
        guard let start = start?.stringValue.flatMap(UInt64.init), let end = end?.stringValue.flatMap(UInt64.init) else { return nil }
        return Double(end &- start) / 1e6
    }

    /// A janela medida: o começo do `ui.tap` (resolver, conferir) → montar o envio da variante → enviar.
    @MainActor
    private static func measure(_ params: SP3Params, target: Target, _ context: SpikeMethods.Context,
                                _ tools: Tools) -> Result<JSONObject, RpcErrorObject> {
        do {
            let start = context.clock()
            let session = ReadSession(context.read)
            let resolver = session.resolver()
            let resolved = try session.checkForAction(resolver.resolve(target), .tap)
            let sender = try prepare(params, resolved, resolver, context, tools)
            let dispatched = context.clock()
            let detail = try sender.send()
            let end = context.clock()
            var out: JSONObject = [
                "point": resolved.point.json, "tDevStartNs": .string(String(start)), "tDispatchNs": .string(String(dispatched)),
                "tDevEndNs": .string(String(end)), "path": .string(sender.path.rawValue), "detail": .object(detail),
            ]
            if let ref = resolved.candidate.node?.ref { out["nodeRef"] = .string(ref) }
            return .success(out)
        } catch {
            return .failure(error)
        }
    }

    // MARK: Montagem do envio (antes do tDispatchNs)

    @MainActor
    private static func prepare(_ params: SP3Params, _ resolved: ResolvedTarget, _ resolver: TargetResolver,
                                _ context: SpikeMethods.Context, _ tools: Tools) throws(RpcErrorObject) -> Sender {
        let bridge = context.bridge
        var targetBundle: String?
        if case .app(let bundle) = resolved.candidate.app { targetBundle = bundle }
        let action: Sender.Action
        var described: JSONObject = [:]
        switch (params.variant, params.base) {
        case (.d, _):
            action = .none
        case (_, .element):
            let (found, query) = try queryElement(for: resolved, resolver, bridge)
            action = .element(found)
            described["query"] = .string(query)
        case (_, .coordinate):
            action = .coordinate(bridge.screenCoordinate(resolved.point))
        }
        // Os processos cuja espera conta: o do app do alvo e, com coordenada, o SpringBoard (dono do XCUICoordinate).
        var quiescent = [targetBundle].compactMap { $0 }
        if params.base == .coordinate, !quiescent.contains(SystemApp.springboard) { quiescent.append(SystemApp.springboard) }

        switch params.variant {
        case .a:
            return Sender(action: action, wrap: .none, path: .public, described: described)
        case .b:
            guard let quiescence = tools.quiescence else { throw missing(.px2, "b") }
            let apps = quiescent.map { (bundleId: $0, app: bridge.application($0)) }
            return Sender(action: action, wrap: .interaction(quiescence, apps), path: .private, described: described)
        case .c:
            guard let quiescence = tools.quiescence else { throw missing(.px2, "c") }
            let mode: PrivateQuiescence.SwapMode = params.quiescence == .observe ? .observe : .skip
            return Sender(action: action, wrap: .swap(quiescence, mode, Set(quiescent)), path: .private, described: described)
        case .d:
            guard let synthesizer = tools.synthesizer else { throw missing(.px3, "d") }
            let prepared = try synthesizer.prepareTap(at: CGPoint(x: resolved.point.x, y: resolved.point.y),
                                                      pressSeconds: Double(params.pressMs) / 1000)
            return Sender(action: action,
                          wrap: .synthesized(synthesizer, prepared, Double(params.completionTimeoutMs) / 1000, params.pressMs),
                          path: .private, described: described)
        }
    }

    private static func missing(_ id: PrivateApiId, _ variant: String) -> RpcErrorObject {
        RpcErrorObject(.capabilityMissing, "E_CAPABILITY_MISSING: a variante \(variant) precisa do \(id.rawValue) presente e "
                       + "liberado em CONTRARREGRA_PRIVATE (A10)")
    }

    /// O elemento do nó resolvido como consulta do XCUIAutomation: mesmo tipo, mesmo rótulo e identificador, na mesma
    /// ocorrência (ordem da árvore) entre os nós iguais do snapshot que resolveu o alvo.
    @MainActor
    private static func queryElement(for resolved: ResolvedTarget, _ resolver: TargetResolver,
                                _ bridge: XCUIBridge) throws(RpcErrorObject) -> (XCUIElement, String) {
        guard case .app(let bundle) = resolved.candidate.app, let node = resolved.candidate.node else {
            throw SP3Params.invalid("base element precisa de um nó de app operável (não ponto, OCR ou SpringBoard); "
                                    + "use base coordinate")
        }
        guard node.label != nil || node.identifier != nil else {
            throw SP3Params.invalid("base element precisa de um nó com rótulo ou identificador (\(node.ref) não tem)")
        }
        let tree = try resolver.scopedTree(resolved.candidate.app).tree
        let occurrence = tree.nodes.prefix { $0.ref != node.ref }
            .filter { $0.type == node.type && $0.label == node.label && $0.identifier == node.identifier }.count
        var formats: [String] = []
        var arguments: [Any] = []
        if let label = node.label {
            formats.append("label == %@")
            arguments.append(label)
        }
        if let identifier = node.identifier {
            formats.append("identifier == %@")
            arguments.append(identifier)
        }
        let predicate = NSPredicate(format: formats.joined(separator: " AND "), argumentArray: arguments)
        let type = XCUIElement.ElementType(rawValue: node.type.xcuiRawValue) ?? .any
        let element = bridge.application(bundle).descendants(matching: type).matching(predicate).element(boundBy: occurrence)
        return (element, "\(bundle) \(node.type.rawValue) [\(predicate.predicateFormat)] #\(occurrence)")
    }
}

/// O envio montado de uma variante: a ação pública (elemento ou coordenada) e o que a embrulha.
@MainActor
private struct Sender {
    enum Action {
        case none
        case element(XCUIElement)
        case coordinate(XCUICoordinate)

        @MainActor
        func tap() {
            switch self {
            case .none: break
            case .element(let element): element.tap()
            case .coordinate(let coordinate): coordinate.tap()
            }
        }
    }

    enum Wrap {
        case none
        case interaction(PrivateQuiescence, [(bundleId: String, app: XCUIApplication)])
        case swap(PrivateQuiescence, PrivateQuiescence.SwapMode, Set<String>)
        case synthesized(PrivateSynthesizer, PrivateSynthesizer.PreparedTap, Double, Int)
    }

    let action: Action
    let wrap: Wrap
    let path: ActionPath
    let described: JSONObject

    /// Envia; devolve o `detail` da variante.
    func send() throws(RpcErrorObject) -> JSONObject {
        var detail = described
        switch wrap {
        case .none:
            action.tap()
        case .interaction(let quiescence, let apps):
            let action = action  // o bloco leva só a ação, não o `Sender`
            let report = try quiescence.perform(skippingQuiescenceOf: apps) { action.tap() }
            detail["options"] = .number(Double(report.options))
            detail["apps"] = .array(report.apps.map { .string($0) })
            detail["strayCalls"] = .number(Double(report.strayCalls))
        case .swap(let quiescence, let mode, let bundles):
            let report = try quiescence.withQuiescenceSwapped(mode, skipping: bundles) { action.tap() }
            detail["mode"] = .string(report.mode.rawValue)
            detail["skipping"] = .array(bundles.sorted().map { .string($0) })
            detail["skippedPre"] = .number(Double(report.skippedPre))
            detail["skippedPost"] = .number(Double(report.skippedPost))
            detail["waitedPre"] = .number(Double(report.waitedPre))
            detail["waitedPost"] = .number(Double(report.waitedPost))
            detail["waitedPreMs"] = .number(Double(report.waitedPreNs) / 1e6)
            detail["waitedPostMs"] = .number(Double(report.waitedPostNs) / 1e6)
            detail["unknownBundle"] = .number(Double(report.unknownBundle))
            detail["bundles"] = .array(report.bundles.map { .string($0) })
        case .synthesized(let synthesizer, let prepared, let timeout, let pressMs):
            let timing = try synthesizer.submit(prepared, timeoutSeconds: timeout)
            detail["pressMs"] = .number(Double(pressMs))
            detail["recordInit"] = .string(timing.recordInit)
            detail["synthesizer"] = .string(prepared.synthesizerClass)
            detail["completionBlock"] = .string(timing.completionBlock)
            detail["tSubmittedNs"] = .string(String(timing.submittedNs))
            detail["tReturnedNs"] = .string(String(timing.returnedNs))
            detail["tCompletedNs"] = .string(String(timing.completedNs))
            detail["completionOnMain"] = .bool(timing.completionOnMain)
        }
        return detail
    }
}

// MARK: Parâmetros

/// Parâmetros de `spike.tap`, lidos à mão (o leitor de modelos do Kit é interno); campo desconhecido é erro.
struct SP3Params: Sendable {
    enum Variant: String, Sendable { case a, b, c, d }
    enum Base: String, Sendable { case element, coordinate }
    enum Quiescence: String, Sendable { case skip, observe }

    var variant: Variant
    var base: Base
    var quiescence: Quiescence
    var target: Target
    var restore: Target?
    var count: Int
    var gapMs: Int
    var pressMs: Int
    var seq: Int?
    var effect: SP3EffectSpec?
    var completionTimeoutMs: Int

    /// `a/element`, `c/coordinate/observe`…, para o registro.
    var tag: String {
        var parts = [variant.rawValue]
        if variant != .d { parts.append(base.rawValue) }
        if variant == .c { parts.append(quiescence.rawValue) }
        return parts.joined(separator: "/")
    }

    static let keys: Set<String> = ["variant", "base", "quiescence", "target", "restore", "count", "gapMs", "pressMs", "seq",
                                    "effect", "completionTimeoutMs"]

    static func read(_ params: JSONObject?) throws(RpcErrorObject) -> SP3Params {
        let fields = Fields(params ?? [:], "params")
        try fields.onlyKeys(keys)
        guard let variantText = try fields.string("variant"), let variant = Variant(rawValue: variantText) else {
            throw invalid("variant obrigatório: a | b | c | d")
        }
        var base = Base.element
        if let text = try fields.string("base") {
            guard let parsed = Base(rawValue: text) else { throw invalid("base: element | coordinate") }
            base = parsed
        }
        if variant == .d, fields.has("base") { throw invalid("base não vale para d (o evento sintetizado vai ao ponto)") }
        var quiescence = Quiescence.skip
        if let text = try fields.string("quiescence") {
            guard variant == .c else { throw invalid("quiescence só vale para a variante c") }
            guard let parsed = Quiescence(rawValue: text) else { throw invalid("quiescence: skip | observe") }
            quiescence = parsed
        }
        let target = try fields.target("target")
        var restore: Target?
        if fields.has("restore") { restore = try fields.target("restore") }
        let count = try fields.int("count", default: 1, 1...100)
        let gapMs = try fields.int("gapMs", default: 0, 0...10_000)
        let pressMs = try fields.int("pressMs", default: 50, 0...2_000)
        if variant != .d, fields.has("pressMs") { throw invalid("pressMs só vale para a variante d") }
        var seq: Int?
        if fields.has("seq") { seq = try fields.int("seq", default: 0, 0...Int(Int32.max)) }
        var effect: SP3EffectSpec?
        if let json = fields.value("effect") { effect = try SP3EffectSpec.read(json) }
        let completionTimeoutMs = try fields.int("completionTimeoutMs", default: 5_000, 100...10_000)
        return SP3Params(variant: variant, base: base, quiescence: quiescence, target: target, restore: restore, count: count,
                         gapMs: gapMs, pressMs: pressMs, seq: seq, effect: effect, completionTimeoutMs: completionTimeoutMs)
    }

    static func invalid(_ message: String) -> RpcErrorObject {
        RpcErrorObject(.invalidParams, "Invalid params: \(message)")
    }

    /// Leitura tipada dos campos de um objeto JSON, com o caminho nas mensagens.
    struct Fields {
        let object: JSONObject
        let path: String

        init(_ object: JSONObject, _ path: String) {
            self.object = object
            self.path = path
        }

        func has(_ key: String) -> Bool { object[JSONKey(key)] != nil }

        func value(_ key: String) -> JSONValue? { object[JSONKey(key)] }

        func onlyKeys(_ keys: Set<String>) throws(RpcErrorObject) {
            let unknown = object.keys.map(\.string).filter { !keys.contains($0) }.sorted()
            guard unknown.isEmpty else {
                throw SP3Params.invalid("\(path): campo(s) desconhecido(s) \(unknown.joined(separator: ", "))")
            }
        }

        func string(_ key: String) throws(RpcErrorObject) -> String? {
            guard let json = value(key) else { return nil }
            guard let text = json.stringValue else { throw SP3Params.invalid("\(path).\(key) tem de ser string") }
            return text
        }

        func number(_ key: String, default fallback: Double, _ range: ClosedRange<Double>) throws(RpcErrorObject) -> Double {
            guard let json = value(key) else { return fallback }
            guard let number = json.numberValue, number.isFinite, range.contains(number) else {
                throw SP3Params.invalid("\(path).\(key) tem de ser número em \(range.lowerBound)…\(range.upperBound)")
            }
            return number
        }

        func int(_ key: String, default fallback: Int, _ range: ClosedRange<Int>) throws(RpcErrorObject) -> Int {
            guard let json = value(key) else { return fallback }
            guard let number = json.numberValue, number.isFinite, number == number.rounded(),
                  number >= Double(range.lowerBound), number <= Double(range.upperBound)
            else {
                throw SP3Params.invalid("\(path).\(key) tem de ser inteiro em \(range.lowerBound)…\(range.upperBound)")
            }
            return Int(number)
        }

        func target(_ key: String) throws(RpcErrorObject) -> Target {
            guard let json = value(key) else { throw SP3Params.invalid("\(path).\(key) obrigatório") }
            do {
                return try Target.decode(json)
            } catch {
                throw SP3Params.invalid("\(path).\(key): \(error.description)")
            }
        }
    }
}
#endif
