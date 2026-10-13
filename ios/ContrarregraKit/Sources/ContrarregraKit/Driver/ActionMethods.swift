import Foundation

// Ações do runner (S1 itens 4 e 5): `ui.tap`, `ui.doubleTap`, `ui.longPress`, `ui.drag`, `ui.scrollTo` e `ui.type`,
// na fila do XCTest, pelo caminho público. A lógica (parâmetros, lista permitida, alvos, geometria da rolagem,
// recusas de digitação, tempos) fica aqui, testável com `swift test`; o runner só implementa `Toucher` com
// `XCUICoordinate` do SpringBoard e `typeText` (módulo `Driver`). O caminho privado (PX-2, PX-3) é do SP-3, em
// `PrivateXCT`, injetado como outro `Toucher`.

// MARK: Parâmetros

/// `ui.tap {target}` e `ui.doubleTap {target}`.
public struct UiTargetParams: JSONModel {
    public var target: Target

    public init(target: Target) {
        self.target = target
    }

    public static let modelName = "parâmetros de ui.tap/ui.doubleTap"

    public static func read(_ json: JSONValue, at path: JSONPath, _ sink: IssueSink) -> UiTargetParams? {
        guard var o = ObjectReader(json, at: path, sink, allowed: ["target"]) else { return nil }
        let target = o.required("target", Read.model(Target.self))
        guard o.ok, let target else { return nil }
        return UiTargetParams(target: target)
    }

    public var json: JSONValue { ["target": target.json] }
}

/// `ui.longPress {target, durationMs}` (`durationMs` > 0, como o passo `longPress` de S0.4).
public struct UiLongPressParams: JSONModel {
    public var target: Target
    public var durationMs: Int

    public init(target: Target, durationMs: Int) {
        self.target = target
        self.durationMs = durationMs
    }

    public static let modelName = "parâmetros de ui.longPress"

    public static func read(_ json: JSONValue, at path: JSONPath, _ sink: IssueSink) -> UiLongPressParams? {
        guard var o = ObjectReader(json, at: path, sink, allowed: ["target", "durationMs"]) else { return nil }
        let target = o.required("target", Read.model(Target.self))
        let durationMs = o.required("durationMs", Read.positiveInt)
        guard o.ok, let target, let durationMs else { return nil }
        return UiLongPressParams(target: target, durationMs: durationMs)
    }

    public var json: JSONValue { ["target": target.json, "durationMs": durationMs.json] }
}

/// Como o arrasto anda: velocidade em pt/s ou duração do movimento em ms (excludentes, S0.4).
public enum DragMotion: Sendable, Equatable {
    case velocity(Double)
    case durationMs(Int)
}

/// `ui.drag {from, to, via?, pressMs, velocity|durationMs, holdMs}` (S1 item 4): `pressMs` e `holdMs` presentes;
/// exatamente um de `velocity` (pt/s, > 0) e `durationMs` (> 0). As regras e mensagens dos campos são as do passo
/// `drag` de S0.4 (`DragStepSchema` do Mac; regra `S0.4/velocity-xor-durationMs`).
public struct UiDragParams: JSONModel {
    public var from: PointOrTarget
    public var to: PointOrTarget
    public var via: [PointOrTarget]?
    public var pressMs: Int
    public var motion: DragMotion
    public var holdMs: Int

    public init(from: PointOrTarget, to: PointOrTarget, via: [PointOrTarget]? = nil, pressMs: Int, motion: DragMotion,
                holdMs: Int) {
        self.from = from
        self.to = to
        self.via = via
        self.pressMs = pressMs
        self.motion = motion
        self.holdMs = holdMs
    }

    public static let modelName = "parâmetros de ui.drag"

    public static func read(_ json: JSONValue, at path: JSONPath, _ sink: IssueSink) -> UiDragParams? {
        guard var o = ObjectReader(json, at: path, sink,
                                   allowed: ["from", "to", "via", "pressMs", "velocity", "durationMs", "holdMs"]) else { return nil }
        let from = o.required("from", Read.model(PointOrTarget.self))
        let to = o.required("to", Read.model(PointOrTarget.self))
        let via = o.optional("via", Read.array(Read.model(PointOrTarget.self)))
        let pressMs = o.required("pressMs", Read.nonNegativeInt)
        let velocity = o.optional("velocity", Read.number(positive: true))
        let durationMs = o.optional("durationMs", Read.positiveInt)
        let holdMs = o.required("holdMs", Read.nonNegativeInt)
        switch (o.has("velocity"), o.has("durationMs")) {
        case (true, true):
            o.fail("durationMs", .velocityXorDuration, "drag com velocity e durationMs juntos; são excludentes (S0.4)")
        case (false, false):
            o.fail(nil, .velocityXorDuration, "ui.drag precisa de velocity (pt/s) ou de durationMs, exatamente um (S1 item 4, S0.4)")
        default:
            break
        }
        guard o.ok, let from, let to, let pressMs, let holdMs else { return nil }
        let motion: DragMotion
        if let velocity {
            motion = .velocity(velocity)
        } else if let durationMs {
            motion = .durationMs(durationMs)
        } else {
            return nil
        }
        return UiDragParams(from: from, to: to, via: via, pressMs: pressMs, motion: motion, holdMs: holdMs)
    }

    public var json: JSONValue {
        var out: JSONObject = ["from": from.json, "to": to.json, "pressMs": pressMs.json, "holdMs": holdMs.json]
        out.put("via", via?.json)
        switch motion {
        case .velocity(let velocity): out["velocity"] = .number(velocity)
        case .durationMs(let durationMs): out["durationMs"] = durationMs.json
        }
        return .object(out)
    }
}

/// `ui.scrollTo {target, within?, direction, maxSwipes}` (S0.4 `scrollTo`).
public struct UiScrollToParams: JSONModel {
    public var target: Target
    public var within: Target?
    public var direction: ScrollDirection
    public var maxSwipes: Int

    public init(target: Target, within: Target? = nil, direction: ScrollDirection, maxSwipes: Int) {
        self.target = target
        self.within = within
        self.direction = direction
        self.maxSwipes = maxSwipes
    }

    public static let modelName = "parâmetros de ui.scrollTo"

    public static func read(_ json: JSONValue, at path: JSONPath, _ sink: IssueSink) -> UiScrollToParams? {
        guard var o = ObjectReader(json, at: path, sink, allowed: ["target", "within", "direction", "maxSwipes"]) else { return nil }
        let target = o.required("target", Read.model(Target.self))
        let within = o.optional("within", Read.model(Target.self))
        let direction = o.required("direction", Read.oneOf(ScrollDirection.self))
        let maxSwipes = o.required("maxSwipes", Read.positiveInt)
        guard o.ok, let target, let direction, let maxSwipes else { return nil }
        return UiScrollToParams(target: target, within: within, direction: direction, maxSwipes: maxSwipes)
    }

    public var json: JSONValue {
        var out: JSONObject = ["target": target.json, "direction": .string(direction.rawValue), "maxSwipes": maxSwipes.json]
        out.put("within", within?.json)
        return .object(out)
    }
}

/// `ui.type {target?, text}` (o texto pode ser vazio, como no passo `type` de S0.4; E-1.5).
public struct UiTypeParams: JSONModel {
    public var target: Target?
    public var text: String

    public init(target: Target? = nil, text: String) {
        self.target = target
        self.text = text
    }

    public static let modelName = "parâmetros de ui.type"

    public static func read(_ json: JSONValue, at path: JSONPath, _ sink: IssueSink) -> UiTypeParams? {
        guard var o = ObjectReader(json, at: path, sink, allowed: ["target", "text"]) else { return nil }
        let target = o.optional("target", Read.model(Target.self))
        let text = o.required("text", Read.string)
        guard o.ok, let text else { return nil }
        return UiTypeParams(target: target, text: text)
    }

    public var json: JSONValue {
        var out: JSONObject = ["text": .string(text)]
        out.put("target", target?.json)
        return .object(out)
    }
}

// MARK: O aparelho, visto pelas ações

/// Um arrasto em pontos da tela, pronto para o `Toucher`: aperta `from` por `pressSeconds`, arrasta até `to`
/// (passando por `via`, só no caminho privado) na velocidade `velocity` e segura `holdSeconds`.
public struct DragGesture: Sendable, Equatable {
    public var from: AbsolutePoint
    public var via: [AbsolutePoint]
    public var to: AbsolutePoint
    public var pressSeconds: Double
    /// O valor de `XCUIGestureVelocity` (px/s = pt/s × escala da tela, S1 item 4); `nil` quando o caminho não tem
    /// comprimento e a velocidade não importa (o `Toucher` usa a padrão).
    public var velocity: Double?
    public var holdSeconds: Double

    public init(from: AbsolutePoint, via: [AbsolutePoint] = [], to: AbsolutePoint, pressSeconds: Double, velocity: Double?,
                holdSeconds: Double) {
        self.from = from
        self.via = via
        self.to = to
        self.pressSeconds = pressSeconds
        self.velocity = velocity
        self.holdSeconds = holdSeconds
    }

    /// Distância em pontos.
    public static func distance(_ a: AbsolutePoint, _ b: AbsolutePoint) -> Double {
        ((b.x - a.x) * (b.x - a.x) + (b.y - a.y) * (b.y - a.y)).squareRoot()
    }

    /// Comprimento do caminho `from` → `via`… → `to`, em pontos.
    public static func length(_ path: [AbsolutePoint]) -> Double {
        zip(path, path.dropFirst()).reduce(0) { $0 + distance($1.0, $1.1) }
    }

    /// `XCUIGestureVelocity` de um arrasto pelo caminho dado: a velocidade pedida (pt/s), ou o comprimento sobre a
    /// duração (`durationMs` é a do movimento); vezes a escala da tela (px por ponto).
    public static func gestureVelocity(_ motion: DragMotion, path: [AbsolutePoint], scale: Double) -> Double? {
        switch motion {
        case .velocity(let ptPerSecond):
            return ptPerSecond * scale
        case .durationMs(let ms):
            let length = length(path)
            guard length > 0 else { return nil }
            return length / (Double(ms) / 1000) * scale
        }
    }
}

/// Quem toca (architecture.md A2: o `Driver` expõe `Toucher`; o privado de `PrivateXCT` entra por injeção quando a
/// sondagem confirma PX-3 e `CONTRARREGRA_PRIVATE` o libera). Chamado só na fila do XCTest, **depois** de a lista
/// permitida e as recusas conferirem o gesto; nada aqui decide se pode.
public protocol Toucher: Sendable {
    /// `public` (XCUICoordinate) ou `private` (evento sintetizado, PX-3).
    var path: ActionPath { get }
    /// Arrasta passando por pontos intermediários (`via`): só o caminho privado (PX-3).
    var supportsVia: Bool { get }
    func tap(_ point: AbsolutePoint) throws(RpcErrorObject)
    func doubleTap(_ point: AbsolutePoint) throws(RpcErrorObject)
    func longPress(_ point: AbsolutePoint, seconds: Double) throws(RpcErrorObject)
    func drag(_ gesture: DragGesture) throws(RpcErrorObject)
    /// Digita no campo com o foco do teclado do app `bundleId` (já conferido).
    func typeText(_ text: String, app bundleId: String) throws(RpcErrorObject)
}

// MARK: Rolagem (S0.4 `scrollTo`)

public enum ScrollGeometry {
    /// Tipos do ancestral rolável (S0.4).
    public static let scrollableTypes: Set<ElementType> = [.scrollView, .table, .collectionView]
    /// Cada passe: aperta 50 ms, a ⚠️ 600 pt/s, sem segurar no fim (S0.4).
    public static let pressMs = 50
    public static let velocityPtPerSecond = 600.0
    /// O passe vai de 70 % a 30 % da altura do contêiner (`down`), ou o inverso (`up`).
    public static let startFraction = 0.7
    public static let endFraction = 0.3

    /// O ancestral rolável mais próximo do nó `ref` na árvore.
    public static func scrollContainer(ofRef ref: String, in tree: IndexedTree) -> TreeNode? {
        guard let index = tree.index(ofRef: ref) else { return nil }
        let parents = ReadScope.parents(tree)
        var current = parents[index]
        while current >= 0 {
            if scrollableTypes.contains(tree.nodes[current].type) { return tree.nodes[current] }
            current = parents[current]
        }
        return nil
    }

    /// Um passe no contêiner `frame` (já recortado pela tela): no centro horizontal, `dx = 0`.
    public static func swipe(in frame: Rect, direction: ScrollDirection, scale: Double) -> DragGesture {
        let x = frame.midX
        let low = AbsolutePoint(x: x, y: frame.minY + startFraction * frame.h)
        let high = AbsolutePoint(x: x, y: frame.minY + endFraction * frame.h)
        let (from, to) = direction == .down ? (low, high) : (high, low)
        return DragGesture(from: from, to: to, pressSeconds: Double(pressMs) / 1000,
                           velocity: velocityPtPerSecond * scale, holdSeconds: 0)
    }

    /// O alvo ficou tocável: tocável pela geometria e com o ponto do toque dentro da parte visível do contêiner (fora
    /// dela, está coberto pela barra de navegação, de abas ou pela borda da lista).
    public static func isTappable(_ resolved: ResolvedTarget, viewport: Rect, display: Size) -> Bool {
        resolved.candidate.isHittable(on: display) && viewport.contains(x: resolved.point.x, y: resolved.point.y)
            && Rect(screen: display).contains(x: resolved.point.x, y: resolved.point.y)
    }
}

// MARK: Métodos

public enum ActionMethods {
    public enum Method: String, Sendable, CaseIterable {
        case tap = "ui.tap"
        case doubleTap = "ui.doubleTap"
        case longPress = "ui.longPress"
        case drag = "ui.drag"
        case scrollTo = "ui.scrollTo"
        case type = "ui.type"
    }

    public struct Context: Sendable {
        /// O mesmo contexto dos métodos de leitura (leitor, lista permitida, tela, refs, estado de `health`).
        public var read: ReadMethods.Context
        public var toucher: any Toucher
        /// Px por ponto da tela (`device.scale`): pt/s × escala = `XCUIGestureVelocity` (S1 item 4).
        public var scale: Double
        /// O relógio D em ns (S0.5: `tDevStartNs`, `tDispatchNs`, `tDevEndNs`).
        public var clock: @Sendable () -> UInt64

        public init(read: ReadMethods.Context, toucher: any Toucher, scale: Double,
                    clock: @escaping @Sendable () -> UInt64 = { DeviceClock.rawNs() }) {
            self.read = read
            self.toucher = toucher
            self.scale = scale
            self.clock = clock
        }
    }

    /// Registra as seis na fila do XCTest, com o prazo padrão do roteador (⚠️ 10 s; S1 item 3).
    public static func register(into router: inout RpcRouter, _ context: Context) {
        router.register(Method.tap.rawValue, lane: .xctest) { call throws(RpcErrorObject) in
            try tap(call.decode(UiTargetParams.self), context).json
        }
        router.register(Method.doubleTap.rawValue, lane: .xctest) { call throws(RpcErrorObject) in
            try doubleTap(call.decode(UiTargetParams.self), context).json
        }
        router.register(Method.longPress.rawValue, lane: .xctest) { call throws(RpcErrorObject) in
            try longPress(call.decode(UiLongPressParams.self), context).json
        }
        router.register(Method.drag.rawValue, lane: .xctest) { call throws(RpcErrorObject) in
            try drag(call.decode(UiDragParams.self), context).json
        }
        router.register(Method.scrollTo.rawValue, lane: .xctest) { call throws(RpcErrorObject) in
            try scrollTo(call.decode(UiScrollToParams.self), context).json
        }
        router.register(Method.type.rawValue, lane: .xctest) { call throws(RpcErrorObject) in
            try type(call.decode(UiTypeParams.self), context).json
        }
    }

    // MARK: Toques

    /// `ui.tap` → S0.5: resolve, confere (tocável, lista permitida com a tela relida) e toca no ponto resolvido.
    public static func tap(_ params: UiTargetParams, _ context: Context) throws(RpcErrorObject) -> UiActionResult {
        let start = context.clock()
        let resolved = try ReadSession(context.read).resolveForAction(params.target, .tap)
        return try dispatch(context, start: start, point: resolved.point, nodeRef: resolved.candidate.node?.ref) { () throws(RpcErrorObject) in
            try context.toucher.tap(resolved.point)
        }
    }

    /// `ui.doubleTap`.
    public static func doubleTap(_ params: UiTargetParams, _ context: Context) throws(RpcErrorObject) -> UiActionResult {
        let start = context.clock()
        let resolved = try ReadSession(context.read).resolveForAction(params.target, .doubleTap)
        return try dispatch(context, start: start, point: resolved.point, nodeRef: resolved.candidate.node?.ref) { () throws(RpcErrorObject) in
            try context.toucher.doubleTap(resolved.point)
        }
    }

    /// `ui.longPress {target, durationMs}`: começo de gesto, fora das faixas do sistema.
    public static func longPress(_ params: UiLongPressParams, _ context: Context) throws(RpcErrorObject) -> UiActionResult {
        let start = context.clock()
        let resolved = try ReadSession(context.read).resolveForAction(params.target, .longPress)
        return try dispatch(context, start: start, point: resolved.point, nodeRef: resolved.candidate.node?.ref) { () throws(RpcErrorObject) in
            try context.toucher.longPress(resolved.point, seconds: Double(params.durationMs) / 1000)
        }
    }

    /// `ui.drag`: `via` só com um `Toucher` que o aceite (PX-3), senão `E_CAPABILITY_MISSING` antes de ler a tela;
    /// `from` é o começo do gesto (fora das faixas do sistema), cada ponto de `via` e `to` só dentro da tela; todos no
    /// app operável à frente. A resposta leva o ponto e o nó de `from`.
    public static func drag(_ params: UiDragParams, _ context: Context) throws(RpcErrorObject) -> UiActionResult {
        let start = context.clock()
        if let via = params.via, !via.isEmpty, !context.toucher.supportsVia {
            throw RpcErrorObject(.capabilityMissing,
                                 "E_CAPABILITY_MISSING: ui.drag com via precisa do evento sintetizado (PX-3, presente e liberado); "
                                 + "o caminho público só arrasta em linha reta (S1 item 4, A10)")
        }
        let session = ReadSession(context.read)
        let resolver = session.resolver()
        let from = try resolver.resolve(target(params.from))
        let via = try (params.via ?? []).map { (point) throws(RpcErrorObject) in try resolver.resolve(target(point)) }
        let to = try resolver.resolve(target(params.to))
        let display = context.read.screenSize
        for point in via + [to] { try ReadSession.checkHittable(point, display: display) }
        _ = try session.checkForAction(from, .drag)  // tocável, relê a tela, começo do gesto
        for point in via + [to] {
            try session.allowList.checkActionPath(.drag, resolved: point, display: display, screen: session.screen)
        }
        let path = [from.point] + via.map(\.point) + [to.point]
        let gesture = DragGesture(from: from.point, via: via.map(\.point), to: to.point, pressSeconds: Double(params.pressMs) / 1000,
                                  velocity: DragGesture.gestureVelocity(params.motion, path: path, scale: context.scale),
                                  holdSeconds: Double(params.holdMs) / 1000)
        return try dispatch(context, start: start, point: from.point, nodeRef: from.candidate.node?.ref) { () throws(RpcErrorObject) in
            try context.toucher.drag(gesture)
        }
    }

    /// `from`/`to` de um arrasto como alvo: um `Point` vira `{point}` (do app alvo, S0.2).
    static func target(_ value: PointOrTarget) -> Target {
        switch value {
        case .point(let point): Target(point: point)
        case .target(let target): target
        }
    }

    // MARK: Rolagem

    /// `ui.scrollTo` (S0.4): enquanto o alvo não está tocável, passes no contêiner — `within` ou, sem ele, o
    /// ancestral rolável mais próximo do alvo na árvore (sem ancestral: `E_TARGET_NOT_FOUND`) —, até `maxSwipes`.
    /// Esgotado: `E_TARGET_NOT_HITTABLE` se o alvo resolve, `E_TARGET_NOT_FOUND` se não. Cada passe relê a tela e
    /// confere o começo (faixas de gesto) e o fim (dentro da tela) no app operável à frente. A resposta leva o
    /// ponto e o nó do alvo; `tDispatchNs` é o envio do primeiro passe (sem passe, o instante da decisão).
    public static func scrollTo(_ params: UiScrollToParams, _ context: Context) throws(RpcErrorObject) -> UiActionResult {
        let start = context.clock()
        let display = context.read.screenSize
        var firstDispatch: UInt64?
        var swipes = 0
        var lastViewport: Viewport?
        while true {
            let session = ReadSession(context.read)
            let resolver = session.resolver()
            let found = try resolveIfPresent(params.target, resolver)
            let viewport = try viewport(params, found: found, resolver: resolver, display: display, last: lastViewport)
            lastViewport = viewport
            if let found, let visible = viewport?.visible, ScrollGeometry.isTappable(found, viewport: visible, display: display) {
                try session.allowList.checkActionPath(.scrollTo, resolved: found, display: display, screen: session.readScreen())
                let end = context.clock()
                return result(context, start: start, dispatch: firstDispatch ?? end, end: end, point: found.point,
                              nodeRef: found.candidate.node?.ref)
            }
            guard swipes < params.maxSwipes else {
                if found != nil {
                    throw RpcErrorObject(.targetNotHittable, "E_TARGET_NOT_HITTABLE: o alvo resolve, mas não ficou tocável em "
                                         + "\(params.maxSwipes) passe(s) de rolagem (\(TargetResolver.describe(params.target)))")
                }
                throw RpcErrorObject(.targetNotFound, "E_TARGET_NOT_FOUND: o alvo não apareceu em \(params.maxSwipes) passe(s) de "
                                     + "rolagem (\(TargetResolver.describe(params.target)))")
            }
            guard let viewport else {
                throw RpcErrorObject(.targetNotFound, "E_TARGET_NOT_FOUND: sem within e sem ancestral rolável (scrollView, table, "
                                     + "collectionView) do alvo na árvore (\(TargetResolver.describe(params.target)); S0.4)")
            }
            guard let visible = viewport.visible else {
                throw RpcErrorObject(.targetNotHittable, "E_TARGET_NOT_HITTABLE: o contêiner rolável está fora da tela")
            }
            let swipe = ScrollGeometry.swipe(in: visible, direction: params.direction, scale: context.scale)
            let screen = session.readScreen()
            try session.allowList.checkElementAction(.scrollTo, app: viewport.app, node: viewport.node, point: swipe.from,
                                                     display: display, screen: screen)
            try session.allowList.checkElementAction(.scrollTo, app: viewport.app, node: viewport.node, point: swipe.to,
                                                     display: display, screen: screen, gestureStart: false)
            let dispatched = context.clock()
            if firstDispatch == nil { firstDispatch = dispatched }
            try context.toucher.drag(swipe)
            swipes += 1
        }
    }

    /// O contêiner da rolagem: app, nó (quando veio da árvore) e a parte dele na tela (`nil` = fora dela).
    struct Viewport {
        var app: AppScope
        var node: TreeNode?
        var visible: Rect?
    }

    /// O alvo, ou `nil` se ainda não resolve (não achado: segue rolando); ambíguo e recusas param na hora.
    static func resolveIfPresent(_ target: Target, _ resolver: TargetResolver) throws(RpcErrorObject) -> ResolvedTarget? {
        do {
            return try resolver.resolve(target)
        } catch {
            if error.code == RunnerErrorCode.targetNotFound.code || error.code == RunnerErrorCode.ocrNotFound.code { return nil }
            throw error
        }
    }

    static func viewport(_ params: UiScrollToParams, found: ResolvedTarget?, resolver: TargetResolver, display: Size,
                         last: Viewport?) throws(RpcErrorObject) -> Viewport? {
        let screen = Rect(screen: display)
        if let within = params.within {
            let container = try resolver.resolve(within)
            return Viewport(app: container.candidate.app, node: container.candidate.node,
                            visible: container.candidate.frame.intersection(screen))
        }
        if let found, let node = found.candidate.node,
           let container = ScrollGeometry.scrollContainer(ofRef: node.ref, in: try resolver.scopedTree(found.candidate.app).tree) {
            return Viewport(app: found.candidate.app, node: container, visible: container.frame.intersection(screen))
        }
        return last
    }

    // MARK: Digitação

    /// `ui.type {target?, text}` — só texto não secreto (S1 item 4, E-1.5, P-3). Na ordem, sem enviar tecla antes de
    /// tudo passar:
    /// 1. texto com cara de credencial → `E_SECURE_FIELD` (nada se lê);
    /// 2. tela de autenticação do sistema à frente (folha `authkit`, SpringBoard) → `E_SECURE_FIELD`;
    /// 3. com `target`, antes de resolver: o seletor pede um campo seguro, ou há algum campo seguro na árvore do app à
    ///    frente → `E_SECURE_FIELD`; depois o alvo resolvido é campo seguro → `E_SECURE_FIELD`; senão um toque no
    ///    alvo (com as regras de `ui.tap`) põe o foco;
    /// 4. logo antes das teclas, relê a árvore e por último a tela: nenhum campo seguro, o mesmo app operável à
    ///    frente, e foco num campo de texto (sem `target`: o campo com `hasFocus`; com `target`: ele ou o teclado na
    ///    tela; senão `E_NO_FOCUS`).
    /// A resposta leva o ponto do alvo (ou o centro do campo com foco) e `tDispatchNs` no envio das teclas.
    public static func type(_ params: UiTypeParams, _ context: Context) throws(RpcErrorObject) -> UiActionResult {
        let start = context.clock()
        try TypeGuard.checkText(params.text)
        let session = ReadSession(context.read)
        let allowList = session.allowList
        let app = try allowList.checkTypingFront(session.readScreen())
        var focusTap: ResolvedTarget?
        if let target = params.target {
            // O campo seguro vence a resolução: pedido pelo seletor, ou em qualquer lugar da árvore do app à frente
            // (abaixo da dobra, repetido) → E_SECURE_FIELD antes de "não achado", "fora da tela" ou "ambíguo".
            try TypeGuard.checkTargetSelector(target)
            try TypeGuard.checkNoSecureField(TypeGuard.scan(context.read.reader.snapshot(of: app)))
            let resolved = try session.resolveForAction(target, .type)
            try TypeGuard.checkTargetNode(resolved.candidate.node)
            _ = try session.checkForAction(resolved, .tap)  // o toque de foco é um toque
            try context.toucher.tap(resolved.point)
            focusTap = resolved
        }
        // As últimas conferências, logo antes das teclas: a árvore (campos seguros) e, por último no aparelho, a tela
        // (o mesmo app operável à frente; nada de tela de autenticação do sistema); o foco sai da mesma árvore.
        let scan = TypeGuard.scan(try context.read.reader.snapshot(of: app))
        try TypeGuard.checkNoSecureField(scan)
        let front = try allowList.checkTypingFront(session.readScreen())
        guard AllowList.same(front, app) else {
            throw AllowList.forbidden("a tela mudou antes de digitar (\(app) → \(front)); nada foi digitado")
        }
        let point: AbsolutePoint
        if let focusTap {
            try TypeGuard.checkFocus(scan)
            point = focusTap.point
        } else {
            let field = try TypeGuard.focusedField(scan)
            point = AbsolutePoint(x: field.frame.midX, y: field.frame.midY)
        }
        return try dispatch(context, start: start, point: point, nodeRef: focusTap?.candidate.node?.ref) { () throws(RpcErrorObject) in
            try context.toucher.typeText(params.text, app: app)
        }
    }

    // MARK: Tempos (S1 item 5)

    /// Marca `tDispatchNs` logo antes do envio e `tDevEndNs` logo depois; `tDevStartNs` é o começo da resolução.
    static func dispatch(_ context: Context, start: UInt64, point: AbsolutePoint, nodeRef: String?,
                         _ send: () throws(RpcErrorObject) -> Void) throws(RpcErrorObject) -> UiActionResult {
        // S1 item 5 / AC-1.18 querem a espera de ociosidade em `tDispatchNs − tDevStartNs`; no caminho público ela
        // acontece dentro da chamada do XCTest (`tap()`…), depois deste carimbo, e não se mede por fora. Quem decide
        // como medir (PX-2/PX-3, evento sintetizado) é o SP-3; levado ao dono.
        let dispatched = context.clock()
        try send()
        let end = context.clock()
        return result(context, start: start, dispatch: dispatched, end: end, point: point, nodeRef: nodeRef)
    }

    static func result(_ context: Context, start: UInt64, dispatch: UInt64, end: UInt64, point: AbsolutePoint,
                       nodeRef: String?) -> UiActionResult {
        UiActionResult(point: point, nodeRef: nodeRef, tDevStartNs: Nanos(clamping: start), tDispatchNs: Nanos(clamping: dispatch),
                       tDevEndNs: Nanos(clamping: end), path: context.toucher.path)
    }
}
