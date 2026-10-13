import Foundation

// Métodos de leitura do runner (S1 item 4): `screen.shot`, `ui.tree`, `ui.find`, `ui.ocr`, todos na fila do
// XCTest. A lógica (lista permitida, refs, resolução, OCR) fica aqui, testável com `swift test`; o runner só
// implementa `DeviceReader` com o XCUIAutomation público e o Vision (módulos `Driver` e `OCR`).

// MARK: Parâmetros

public enum ShotFormat: String, Sendable, CaseIterable { case jpeg, png }
public enum ShotScale: String, Sendable, CaseIterable { case points, native }

/// `screen.shot {format?, scale?, quality?}` — padrão JPEG em pontos (S1 item 4), qualidade 0,8 (S8 item 3).
public struct ScreenShotParams: JSONModel {
    public static let defaultQuality = 0.8

    public var format: ShotFormat
    public var scale: ShotScale
    public var quality: Double

    public init(format: ShotFormat = .jpeg, scale: ShotScale = .points, quality: Double = ScreenShotParams.defaultQuality) {
        self.format = format
        self.scale = scale
        self.quality = quality
    }

    public static let modelName = "parâmetros de screen.shot"

    public static func read(_ json: JSONValue, at path: JSONPath, _ sink: IssueSink) -> ScreenShotParams? {
        if json.isNull { return ScreenShotParams() }
        guard var o = ObjectReader(json, at: path, sink, allowed: ["format", "scale", "quality"]) else { return nil }
        let format = o.optional("format", Read.oneOf(ShotFormat.self))
        let scale = o.optional("scale", Read.oneOf(ShotScale.self))
        let quality = o.optional("quality", Read.number(min: 0, max: 1))
        guard o.ok else { return nil }
        return ScreenShotParams(format: format ?? .jpeg, scale: scale ?? .points, quality: quality ?? defaultQuality)
    }

    public var json: JSONValue {
        ["format": .string(format.rawValue), "scale": .string(scale.rawValue), "quality": .number(quality)]
    }
}

/// `ui.tree {app?, visibleOnly?: true, maxDepth?, format?: compact|json}`; `app` padrão = o app em primeiro
/// plano; `format` padrão = `compact` (o formato para o Claude Code, S0.6).
public struct UiTreeParams: JSONModel {
    public var app: String?
    public var visibleOnly: Bool
    public var maxDepth: Int?
    public var format: TreeOutputFormat

    public init(app: String? = nil, visibleOnly: Bool = true, maxDepth: Int? = nil, format: TreeOutputFormat = .compact) {
        self.app = app
        self.visibleOnly = visibleOnly
        self.maxDepth = maxDepth
        self.format = format
    }

    public static let modelName = "parâmetros de ui.tree"

    public static func read(_ json: JSONValue, at path: JSONPath, _ sink: IssueSink) -> UiTreeParams? {
        if json.isNull { return UiTreeParams() }
        guard var o = ObjectReader(json, at: path, sink, allowed: ["app", "visibleOnly", "maxDepth", "format"]) else { return nil }
        let app = o.optional("app", Read.nonEmpty)
        let visibleOnly = o.optional("visibleOnly", Read.bool)
        let maxDepth = o.optional("maxDepth", Read.nonNegativeInt)
        let format = o.optional("format", Read.oneOf(TreeOutputFormat.self))
        guard o.ok else { return nil }
        return UiTreeParams(app: app, visibleOnly: visibleOnly ?? true, maxDepth: maxDepth, format: format ?? .compact)
    }

    public var json: JSONValue {
        var out: JSONObject = ["visibleOnly": .bool(visibleOnly), "format": .string(format.rawValue)]
        out.put("app", app?.json)
        out.put("maxDepth", maxDepth?.json)
        return .object(out)
    }
}

/// `ui.find {target}`.
public struct UiFindParams: JSONModel {
    public var target: Target

    public init(target: Target) {
        self.target = target
    }

    public static let modelName = "parâmetros de ui.find"

    public static func read(_ json: JSONValue, at path: JSONPath, _ sink: IssueSink) -> UiFindParams? {
        guard var o = ObjectReader(json, at: path, sink, allowed: ["target"]) else { return nil }
        let target = o.required("target", Read.model(Target.self))
        guard o.ok, let target else { return nil }
        return UiFindParams(target: target)
    }

    public var json: JSONValue { ["target": target.json] }
}

/// `ui.ocr {region?, text?}`.
public struct UiOcrParams: JSONModel {
    public var region: Rect?
    public var text: String?

    public init(region: Rect? = nil, text: String? = nil) {
        self.region = region
        self.text = text
    }

    public static let modelName = "parâmetros de ui.ocr"

    public static func read(_ json: JSONValue, at path: JSONPath, _ sink: IssueSink) -> UiOcrParams? {
        if json.isNull { return UiOcrParams() }
        guard var o = ObjectReader(json, at: path, sink, allowed: ["region", "text"]) else { return nil }
        let region = o.optional("region", Read.model(Rect.self))
        let text = o.optional("text", Read.nonEmpty)
        guard o.ok else { return nil }
        return UiOcrParams(region: region, text: text)
    }

    public var json: JSONValue {
        var out: JSONObject = [:]
        out.put("region", region?.json)
        out.put("text", text?.json)
        return .object(out)
    }
}

// MARK: O aparelho, visto pela leitura

/// Pedido de captura de `screen.shot`.
public struct CaptureRequest: Sendable, Equatable {
    public var format: ShotFormat
    public var scale: ShotScale
    public var quality: Double

    public init(format: ShotFormat, scale: ShotScale, quality: Double) {
        self.format = format
        self.scale = scale
        self.quality = quality
    }
}

/// Imagem capturada e codificada.
public struct CapturedImage: Sendable, Equatable {
    public var data: Data
    public var widthPx: Int
    public var heightPx: Int
    /// Pixels por ponto da imagem devolvida (1 em `points`; a escala da tela em `native`).
    public var scale: Double

    public init(data: Data, widthPx: Int, heightPx: Int, scale: Double) {
        self.data = data
        self.widthPx = widthPx
        self.heightPx = heightPx
        self.scale = scale
    }
}

/// Uma captura crua da tela, ainda sem processamento: o leitor guarda nela o que tirou (no runner, o
/// `XCUIScreenshot`) e só a codifica ou passa pelo OCR depois da conferência da lista permitida. Usada só na
/// fila do XCTest.
public struct ScreenFrame: @unchecked Sendable {
    public let content: Any

    public init(_ content: Any) {
        self.content = content
    }
}

/// O que o runner lê do aparelho para os métodos de leitura (implementado pelo `Driver`/`OCR` do runner com o
/// XCUIAutomation público e o Vision). Chamado só na fila do XCTest. **Nada aqui decide a lista permitida**:
/// `screen()` só junta os fatos (`ScreenState`); `captureScreen` só é chamado depois de
/// `AllowList.checkCapture` sobre uma leitura feita logo antes; `encode` e `recognizeText` só depois da
/// conferência logo depois.
public protocol DeviceReader: Sendable {
    /// Os fatos da tela, lidos agora (bloqueio, app em `.runningForeground`, teste de toque no centro, camadas
    /// do SpringBoard).
    func screen() -> ScreenState
    /// Snapshot público do app (sem refs).
    func snapshot(of bundleId: String) throws(RpcErrorObject) -> RawNode
    /// Captura crua da tela inteira, sem codificar.
    func captureScreen() throws(RpcErrorObject) -> ScreenFrame
    /// Codifica uma captura já conferida.
    func encode(_ frame: ScreenFrame, _ request: CaptureRequest) throws(RpcErrorObject) -> CapturedImage
    /// OCR (Vision, nível acurado, caixa por palavra) de `region` (pontos da tela) numa captura já conferida; as
    /// caixas voltam em pontos da tela.
    func recognizeText(in frame: ScreenFrame, region: Rect) throws(RpcErrorObject) -> [OcrLine]
}

/// Uma operação de leitura: aplica a lista permitida, FAIL-CLOSED, e entrega árvores recortadas e OCR ao
/// `TargetResolver`. Também serve às ações (T-0.7) e às condições (T-0.8).
///
/// - Todo alvo (qualquer seletor, inclusive `point`) passa por `AllowList.checkElementRead` com o app dele.
/// - **Toda** captura relê a tela logo antes e logo depois (inclusive a 2.ª de uma operação, como a do
///   `fallback`); se a conferência de depois falha, a captura crua é descartada sem codificar nem passar pelo
///   OCR.
public final class ReadSession {
    public let context: ReadMethods.Context
    public let allowList: AllowList
    private var cached: ScreenState?

    public init(_ context: ReadMethods.Context) {
        self.context = context
        allowList = context.allowList()
    }

    /// A tela desta operação (lida na primeira vez que é preciso).
    public var screen: ScreenState {
        if let cached { return cached }
        return readScreen()
    }

    /// Lê a tela agora.
    @discardableResult
    public func readScreen() -> ScreenState {
        let screen = context.reader.screen()
        cached = screen
        context.observe(screen, front: allowList.front(screen))
        return screen
    }

    /// O app de um alvo, já conferido contra o que está à frente.
    public func appScope(_ name: String?) throws(RpcErrorObject) -> AppScope {
        let app = try allowList.scope(forTargetApp: name)
        try allowList.checkElementRead(app, screen: screen)
        return app
    }

    /// Resolvedor desta operação (árvores lidas uma vez e reaproveitadas).
    public func resolver() -> TargetResolver {
        TargetResolver(
            screen: context.screenSize,
            appScope: { name throws(RpcErrorObject) in try self.appScope(name) },
            tree: { app throws(RpcErrorObject) in try self.scopedTree(app) },
            text: { region throws(RpcErrorObject) in try self.recognizeText(in: region) },
            selectors: { [allowList] target, app throws(RpcErrorObject) in try allowList.checkSelector(target, app: app) })
    }

    /// Árvore de `app` recortada pela lista permitida (S1 item 11). No app operável, a árvore inteira (refs sobre
    /// ela). No SpringBoard e na folha, o recorte vem **antes** do registro: registra-se só a raiz e os nós
    /// alcançáveis (em ordem, sem hierarquia entre eles), então refs e `treeVersion` não dependem de nós
    /// inalcançáveis — nem a distância entre refs nem a troca de versão em `health` revelam uma notificação nova.
    public func scopedTree(_ app: AppScope) throws(RpcErrorObject) -> ScopedTree {
        try allowList.checkElementRead(app, screen: screen)
        guard case .app = app else {
            let raw = try context.reader.snapshot(of: app.bundleId)
            let full = IndexedTree(TreeRegistry.unregistered(raw, screen: context.screenSize))
            let mask = ReadScope.reachable(full, app: app, front: allowList.front(screen), iconLabel: allowList.iconLabel,
                                           screen: context.screenSize) ?? []
            let kept = full.nodes.indices.filter { mask.indices.contains($0) && mask[$0] }.map { full.nodes[$0] }
            let filtered = RawNode(type: raw.type, frame: raw.frame, children: kept.map {
                RawNode(type: $0.type, label: $0.label, identifier: $0.identifier, value: $0.value, frame: $0.frame,
                        enabled: $0.enabled, selected: $0.selected)
            })
            let snapshot = context.registry.record(app: app.bundleId, raw: filtered, screen: context.screenSize)
            context.state.treeVersion = context.registry.version
            let tree = IndexedTree(snapshot.root)
            return ScopedTree(app: app, version: snapshot.version, tree: tree,
                              reachable: tree.nodes.indices.map { $0 > 0 })
        }
        let snapshot = try record(app)
        return ScopedTree(app: app, version: snapshot.version, tree: IndexedTree(snapshot.root), reachable: nil)
    }

    /// Resolve um alvo para uma ação (T-0.7): resolve, confere que é tocável (`checkHittable`), **relê a tela logo
    /// antes de agir** e confere a ação com o ponto final (centro + `offset`) — dentro da tela, fora das faixas de
    /// gesto quando é começo de gesto e, no SpringBoard e na folha, dentro do nó permitido.
    public func resolveForAction(_ target: Target, _ action: ElementAction) throws(RpcErrorObject) -> ResolvedTarget {
        try checkForAction(resolver().resolve(target), action)
    }

    /// As conferências de `resolveForAction` sobre um alvo já resolvido (por um resolvedor reaproveitado).
    public func checkForAction(_ resolved: ResolvedTarget, _ action: ElementAction) throws(RpcErrorObject) -> ResolvedTarget {
        try Self.checkHittable(resolved, display: context.screenSize)
        try allowList.checkAction(action, resolved: resolved, display: context.screenSize, screen: readScreen())
        return resolved
    }

    /// Um alvo que resolveu para um elemento (ou ponto) fora da tela — o centro do frame fora dela, ou frame sem
    /// área — é `E_TARGET_NOT_HITTABLE` (S0.5: "existe, mas fora da tela ou coberto"). Um `offset` que leve o toque de
    /// um elemento na tela para fora dela continua `E_FORBIDDEN_APP` (`AllowList.checkActionPoint`).
    public static func checkHittable(_ resolved: ResolvedTarget, display: Size) throws(RpcErrorObject) {
        guard resolved.candidate.isHittable(on: display) else {
            let frame = resolved.candidate.frame
            throw RpcErrorObject(.targetNotHittable,
                                 "E_TARGET_NOT_HITTABLE: o alvo resolveu, mas está fora da tela (frame \(TreeFormat.number(frame.x)),"
                                 + "\(TreeFormat.number(frame.y)) \(TreeFormat.number(frame.w))x\(TreeFormat.number(frame.h)))")
        }
    }

    /// Snapshot registrado (refs e `treeVersion`) de um app operável: para `ui.tree` (já conferido) e
    /// `scopedTree`.
    func record(_ app: AppScope) throws(RpcErrorObject) -> TreeRegistry.Snapshot {
        let raw = try context.reader.snapshot(of: app.bundleId)
        let snapshot = context.registry.record(app: app.bundleId, raw: raw, screen: context.screenSize)
        context.state.treeVersion = context.registry.version
        return snapshot
    }

    /// Captura conferida (`screen.shot`), codificada só depois da conferência.
    public func capture(_ request: CaptureRequest) throws(RpcErrorObject) -> CapturedImage {
        let frame = try guardedCapture()
        return try context.reader.encode(frame, request)
    }

    /// OCR de uma região numa captura conferida (seletor `ocr`, `ui.ocr`, condição `text`).
    public func recognizeText(in region: Rect) throws(RpcErrorObject) -> [OcrLine] {
        let frame = try guardedCapture()
        return try context.reader.recognizeText(in: frame, region: region)
    }

    /// Lista permitida logo antes e logo depois da captura crua; o que está à frente tem de ser o mesmo app
    /// operável nas duas leituras. Falhou depois: a captura é descartada aqui, sem processamento.
    private func guardedCapture() throws(RpcErrorObject) -> ScreenFrame {
        let before = readScreen()
        try allowList.checkCapture(before)
        let frame = try context.reader.captureScreen()
        let after = readScreen()
        let (frontBefore, frontAfter) = (allowList.front(before), allowList.front(after))
        do {
            try allowList.checkCapture(after)
        } catch {
            throw AllowList.forbidden("a tela mudou durante a captura (\(frontAfter) à frente); a imagem foi descartada sem processar (S1 item 11)")
        }
        guard frontBefore == frontAfter else {
            throw AllowList.forbidden("a tela mudou durante a captura (\(frontBefore) → \(frontAfter)); a imagem foi descartada sem processar")
        }
        return frame
    }
}

// MARK: Métodos

public enum ReadMethods {
    public enum Method: String, Sendable, CaseIterable {
        case screenShot = "screen.shot"
        case uiTree = "ui.tree"
        case uiFind = "ui.find"
        case uiOcr = "ui.ocr"
    }

    public struct Context: Sendable {
        public var reader: any DeviceReader
        /// A lista permitida corrente (muda com `choreo.load` e com a tomada).
        public var allowList: @Sendable () -> AllowList
        /// A tela em pontos (`device.screenPt`).
        public var screenSize: Size
        public var registry: TreeRegistry
        /// Onde `health` lê `treeVersion`, `foregroundApp` e `locked`.
        public var state: RunnerState

        public init(reader: any DeviceReader, allowList: @escaping @Sendable () -> AllowList, screenSize: Size,
                    registry: TreeRegistry, state: RunnerState) {
            self.reader = reader
            self.allowList = allowList
            self.screenSize = screenSize
            self.registry = registry
            self.state = state
        }

        /// `health` passa a ver o que está à frente como a lista permitida o classifica (`""` = desconhecido).
        func observe(_ screen: ScreenState, front: Front) {
            state.foregroundApp = front.bundleId
            state.locked = screen.lock != .unlocked  // não lido conta como travado
        }
    }

    /// Registra os quatro na fila do XCTest, com os prazos do roteador (`screen.shot` 3 s, `ui.tree` 5 s, os
    /// demais 10 s; S1 item 3).
    public static func register(into router: inout RpcRouter, _ context: Context) {
        router.register(Method.screenShot.rawValue, lane: .xctest) { call throws(RpcErrorObject) in
            try screenShot(call.decode(ScreenShotParams.self), context)
        }
        router.register(Method.uiTree.rawValue, lane: .xctest) { call throws(RpcErrorObject) in
            try uiTree(call.decode(UiTreeParams.self), context)
        }
        router.register(Method.uiFind.rawValue, lane: .xctest) { call throws(RpcErrorObject) in
            try uiFind(call.decode(UiFindParams.self), context)
        }
        router.register(Method.uiOcr.rawValue, lane: .xctest) { call throws(RpcErrorObject) in
            try uiOcr(call.decode(UiOcrParams.self), context)
        }
    }

    /// `screen.shot` → `{image, format, widthPx, heightPx, scale}` (`image` em base64).
    public static func screenShot(_ params: ScreenShotParams, _ context: Context) throws(RpcErrorObject) -> JSONValue {
        let session = ReadSession(context)
        let image = try session.capture(CaptureRequest(format: params.format, scale: params.scale, quality: params.quality))
        return ["image": .string(image.data.base64EncodedString()), "format": .string(params.format.rawValue),
                "widthPx": .number(Double(image.widthPx)), "heightPx": .number(Double(image.heightPx)),
                "scale": .number(image.scale)]
    }

    /// `ui.tree` → `{treeVersion, nodes}`: em `compact`, `nodes` é a lista de linhas (S0.6); em `json`, a lista
    /// de raízes `TreeNode` com `children`.
    public static func uiTree(_ params: UiTreeParams, _ context: Context) throws(RpcErrorObject) -> JSONValue {
        let session = ReadSession(context)
        let app = try session.allowList.treeScope(params.app, screen: session.screen)
        let snapshot = try session.record(app)
        let nodes: JSONValue
        switch params.format {
        case .compact:
            nodes = .array(TreeFormat.compactLines(snapshot.root, visibleOnly: params.visibleOnly, maxDepth: params.maxDepth)
                .map { .string($0) })
        case .json:
            let root = TreeFormat.pruned(snapshot.root, visibleOnly: params.visibleOnly, maxDepth: params.maxDepth)
            nodes = .array(root.map { [$0.json] } ?? [])
        }
        return ["treeVersion": .number(Double(snapshot.version)), "nodes": nodes]
    }

    /// `ui.find` → `{candidates: [{ref?, frame, visible, hittable, value?}]}` — o que a resolução vê (S0.2).
    public static func uiFind(_ params: UiFindParams, _ context: Context) throws(RpcErrorObject) -> JSONValue {
        let session = ReadSession(context)
        let candidates = try session.resolver().find(params.target)
        return ["candidates": .array(candidates.map { $0.findJSON(screen: context.screenSize) })]
    }

    /// `ui.ocr` → `{boxes: [{text, frame, confidence}]}` em pontos: sem `text`, uma caixa por palavra; com
    /// `text`, uma por ocorrência (S1 itens 4 e 6).
    public static func uiOcr(_ params: UiOcrParams, _ context: Context) throws(RpcErrorObject) -> JSONValue {
        let session = ReadSession(context)
        var region = Rect(screen: context.screenSize)
        if let limit = params.region {
            guard let clipped = region.intersection(limit) else {
                try session.allowList.checkCapture(session.screen)  // a regra vale mesmo sem nada a capturar
                return ["boxes": []]
            }
            region = clipped
        }
        let lines = try session.recognizeText(in: region)
        let boxes = params.text.map { OcrMatcher.matches($0, in: lines, region: region) }
            ?? OcrMatcher.words(in: lines, region: region)
        return ["boxes": .array(boxes.map(\.json))]
    }
}
