import Foundation

// Aparelho, apps e espera do runner (S1 itens 4, 7, 8, 9, 10 e 11; T-0.8): `device.state`, `device.home`,
// `device.press`, `device.wake`, `device.controlCenter`, `device.lock` (PX-1), `app.activate|terminate|state|openURL` e
// `wait.for` (condições de S0.3, em `Choreo/ConditionEvaluator.swift`), todos na fila do XCTest. A lógica (lista
// permitida, recusas da seção `scenes`, regras do bloqueio, geometria da Central de Controle, tempos) fica aqui,
// testável com `swift test`; o runner só implementa `DeviceController` com o `XCUIDevice`/`XCUIApplication` públicos, o
// monitor de rede (`NWPathMonitor`) e o `Locker` privado do PX-1 (só em `PrivateXCT/Lock.swift`). `app.launch` não é
// desta tarefa.

// MARK: Parâmetros

/// Botões de `device.press` (S1 item 4).
public enum DeviceButton: String, Sendable, CaseIterable { case home, volumeUp, volumeDown }

/// `device.press {button: home|volumeUp|volumeDown}`.
public struct DevicePressParams: JSONModel {
    public var button: DeviceButton

    public init(button: DeviceButton) {
        self.button = button
    }

    public static let modelName = "parâmetros de device.press"

    public static func read(_ json: JSONValue, at path: JSONPath, _ sink: IssueSink) -> DevicePressParams? {
        guard var o = ObjectReader(json, at: path, sink, allowed: ["button"]) else { return nil }
        let button = o.required("button", Read.oneOf(DeviceButton.self))
        guard o.ok, let button else { return nil }
        return DevicePressParams(button: button)
    }

    public var json: JSONValue { ["button": .string(button.rawValue)] }
}

public enum ControlCenterAction: String, Sendable, CaseIterable { case open, close }

/// `device.controlCenter {action: open|close}` — o nome do campo é o do passo `controlCenter` do Mac
/// (`mac/src/core/schema.ts`).
public struct DeviceControlCenterParams: JSONModel {
    public var action: ControlCenterAction

    public init(action: ControlCenterAction) {
        self.action = action
    }

    public static let modelName = "parâmetros de device.controlCenter"

    public static func read(_ json: JSONValue, at path: JSONPath, _ sink: IssueSink) -> DeviceControlCenterParams? {
        guard var o = ObjectReader(json, at: path, sink, allowed: ["action"]) else { return nil }
        let action = o.required("action", Read.oneOf(ControlCenterAction.self))
        guard o.ok, let action else { return nil }
        return DeviceControlCenterParams(action: action)
    }

    public var json: JSONValue { ["action": .string(action.rawValue)] }
}

/// `app.activate|terminate|state {bundleId}`.
public struct AppBundleParams: JSONModel {
    public var bundleId: String

    public init(bundleId: String) {
        self.bundleId = bundleId
    }

    public static let modelName = "parâmetros de app.*"

    public static func read(_ json: JSONValue, at path: JSONPath, _ sink: IssueSink) -> AppBundleParams? {
        guard var o = ObjectReader(json, at: path, sink, allowed: ["bundleId"]) else { return nil }
        let bundleId = o.required("bundleId", Read.nonEmpty)
        guard o.ok, let bundleId else { return nil }
        return AppBundleParams(bundleId: bundleId)
    }

    public var json: JSONValue { ["bundleId": .string(bundleId)] }
}

/// `app.openURL {url}`.
public struct AppOpenURLParams: JSONModel {
    public var url: String

    public init(url: String) {
        self.url = url
    }

    public static let modelName = "parâmetros de app.openURL"

    public static func read(_ json: JSONValue, at path: JSONPath, _ sink: IssueSink) -> AppOpenURLParams? {
        guard var o = ObjectReader(json, at: path, sink, allowed: ["url"]) else { return nil }
        let url = o.required("url", Read.nonEmpty)
        guard o.ok, let url else { return nil }
        return AppOpenURLParams(url: url)
    }

    public var json: JSONValue { ["url": .string(url)] }
}

/// `wait.for {condition, timeoutMs}` — a condição de S0.3 sem `changed` (só vale em `expect`); `timeoutMs` ≥ 0 (0 =
/// avalia uma vez, como o `assert` de S0.4).
public struct WaitForParams: JSONModel {
    public var condition: Condition
    public var timeoutMs: Int

    public init(condition: Condition, timeoutMs: Int) {
        self.condition = condition
        self.timeoutMs = timeoutMs
    }

    public static let modelName = "parâmetros de wait.for"

    public static func read(_ json: JSONValue, at path: JSONPath, _ sink: IssueSink) -> WaitForParams? {
        guard var o = ObjectReader(json, at: path, sink, allowed: ["condition", "timeoutMs"]) else { return nil }
        let condition = o.required("condition", Read.model(Condition.self))
        let timeoutMs = o.required("timeoutMs", Read.nonNegativeInt)
        guard o.ok, let condition, let timeoutMs else { return nil }
        return WaitForParams(condition: condition, timeoutMs: timeoutMs)
    }

    public var json: JSONValue { ["condition": condition.json, "timeoutMs": timeoutMs.json] }
}

// MARK: Respostas

/// `device.state` → exatamente `{locked, network, foregroundApp, language, screenPt, textSize, appearance}` (S1 item
/// 4; o `DeviceStateSchema` estrito do Mac em `mac/src/commands/device.ts`).
public struct DeviceStateResult: JSONModel {
    public var locked: Bool
    public var network: NetworkState
    public var foregroundApp: String
    public var language: String
    public var screenPt: Size
    public var textSize: String
    public var appearance: Appearance

    public init(locked: Bool, network: NetworkState, foregroundApp: String, language: String, screenPt: Size, textSize: String,
                appearance: Appearance) {
        self.locked = locked
        self.network = network
        self.foregroundApp = foregroundApp
        self.language = language
        self.screenPt = screenPt
        self.textSize = textSize
        self.appearance = appearance
    }

    public static let modelName = "resposta de device.state"

    public static func read(_ json: JSONValue, at path: JSONPath, _ sink: IssueSink) -> DeviceStateResult? {
        guard var o = ObjectReader(json, at: path, sink, allowed: ["locked", "network", "foregroundApp", "language", "screenPt",
                                                                   "textSize", "appearance"]) else { return nil }
        let locked = o.required("locked", Read.bool)
        let network = o.required("network", Read.oneOf(NetworkState.self))
        let foregroundApp = o.required("foregroundApp", Read.string)
        let language = o.required("language", Read.string)
        let screenPt = o.required("screenPt", Read.model(Size.self))
        let textSize = o.required("textSize", Read.string)
        let appearance = o.required("appearance", Read.oneOf(Appearance.self))
        guard o.ok, let locked, let network, let foregroundApp, let language, let screenPt, let textSize, let appearance else {
            return nil
        }
        return DeviceStateResult(locked: locked, network: network, foregroundApp: foregroundApp, language: language,
                                 screenPt: screenPt, textSize: textSize, appearance: appearance)
    }

    public var json: JSONValue {
        [
            "locked": .bool(locked), "network": .string(network.rawValue), "foregroundApp": .string(foregroundApp),
            "language": .string(language), "screenPt": screenPt.json, "textSize": .string(textSize),
            "appearance": .string(appearance.rawValue),
        ]
    }
}

/// Resposta das ações sem alvo (`device.home|press|wake|controlCenter|lock`, `app.activate|terminate|openURL`): os
/// tempos D e o caminho da resposta de ação de S0.5, sem `point`/`nodeRef` (não há alvo). Quando não havia nada a
/// fazer (a tela já estava como pedido), `tDispatchNs = tDevEndNs` = o instante da decisão.
public struct DeviceActionResult: JSONModel {
    public var tDevStartNs: Nanos
    public var tDispatchNs: Nanos
    public var tDevEndNs: Nanos
    public var path: ActionPath

    public init(tDevStartNs: Nanos, tDispatchNs: Nanos, tDevEndNs: Nanos, path: ActionPath) {
        self.tDevStartNs = tDevStartNs
        self.tDispatchNs = tDispatchNs
        self.tDevEndNs = tDevEndNs
        self.path = path
    }

    public static let modelName = "resposta de ação de aparelho/app"

    public static func read(_ json: JSONValue, at path: JSONPath, _ sink: IssueSink) -> DeviceActionResult? {
        guard var o = ObjectReader(json, at: path, sink, allowed: ["tDevStartNs", "tDispatchNs", "tDevEndNs", "path"]) else { return nil }
        let start = o.required("tDevStartNs", Read.nanos)
        let dispatch = o.required("tDispatchNs", Read.nanos)
        let end = o.required("tDevEndNs", Read.nanos)
        let actionPath = o.required("path", Read.oneOf(ActionPath.self))
        guard o.ok, let start, let dispatch, let end, let actionPath else { return nil }
        return DeviceActionResult(tDevStartNs: start, tDispatchNs: dispatch, tDevEndNs: end, path: actionPath)
    }

    public var json: JSONValue {
        ["tDevStartNs": tDevStartNs.json, "tDispatchNs": tDispatchNs.json, "tDevEndNs": tDevEndNs.json, "path": .string(path.rawValue)]
    }
}

/// `app.state` → `{state: foreground|background|notRunning}` (os estados de `{appState}` de S0.3).
public struct AppStateResult: JSONModel {
    public var state: AppRunState

    public init(state: AppRunState) {
        self.state = state
    }

    public static let modelName = "resposta de app.state"

    public static func read(_ json: JSONValue, at path: JSONPath, _ sink: IssueSink) -> AppStateResult? {
        guard var o = ObjectReader(json, at: path, sink, allowed: ["state"]) else { return nil }
        let state = o.required("state", Read.oneOf(AppRunState.self))
        guard o.ok, let state else { return nil }
        return AppStateResult(state: state)
    }

    public var json: JSONValue { ["state": .string(state.rawValue)] }
}

/// `wait.for` → `{tDevStartNs, tDevEndNs}` (D): o começo da espera e o fim da sondagem em que a condição valeu.
public struct WaitForResult: JSONModel {
    public var tDevStartNs: Nanos
    public var tDevEndNs: Nanos

    public init(tDevStartNs: Nanos, tDevEndNs: Nanos) {
        self.tDevStartNs = tDevStartNs
        self.tDevEndNs = tDevEndNs
    }

    public static let modelName = "resposta de wait.for"

    public static func read(_ json: JSONValue, at path: JSONPath, _ sink: IssueSink) -> WaitForResult? {
        guard var o = ObjectReader(json, at: path, sink, allowed: ["tDevStartNs", "tDevEndNs"]) else { return nil }
        let start = o.required("tDevStartNs", Read.nanos)
        let end = o.required("tDevEndNs", Read.nanos)
        guard o.ok, let start, let end else { return nil }
        return WaitForResult(tDevStartNs: start, tDevEndNs: end)
    }

    public var json: JSONValue { ["tDevStartNs": tDevStartNs.json, "tDevEndNs": tDevEndNs.json] }
}

extension NetworkState {
    /// `{network}` de S0.3: online quando há rota satisfeita por Wi-Fi **ou** celular (um `NWPathMonitor` por tipo de
    /// interface, o que já ignora cabo e loopback); offline quando os dois disseram que não; `nil` (desconhecido)
    /// enquanto um deles ainda não deu notícia e o outro não está satisfeito.
    public static func from(wifi: Bool?, cellular: Bool?) -> NetworkState? {
        if wifi == true || cellular == true { return .online }
        if wifi == false && cellular == false { return .offline }
        return nil
    }
}

// MARK: O aparelho, visto por estes métodos

/// Botões, apps e links pelo XCUIAutomation **público** (o `Driver` do runner: `XCUIDevice.shared.press`,
/// `XCUIApplication.activate/terminate/state`, `XCUIDevice.shared.system.open`). Chamado só na fila do XCTest, depois
/// de a lista permitida e as recusas da seção `scenes` conferirem; nada aqui decide se pode. Nunca chama `launch()`.
public protocol DeviceController: Sendable {
    func press(_ button: DeviceButton) throws(RpcErrorObject)
    /// `XCUIApplication.state` do app (`nil` = desconhecido).
    func appState(_ bundleId: String) -> AppRunState?
    func activate(_ bundleId: String) throws(RpcErrorObject)
    func terminate(_ bundleId: String) throws(RpcErrorObject)
    /// Abre o link com o app padrão do sistema; `url` é exatamente o texto conferido.
    func openURL(_ url: URL) throws(RpcErrorObject)
}

/// Quem trava a tela (architecture.md A2: o `Driver` expõe `Locker`). Não há API pública (S1 item 8): a única
/// implementação é a do PX-1, em `PrivateXCT/Lock.swift`, injetada só quando a sondagem o acha **e**
/// `CONTRARREGRA_PRIVATE` o libera (`RunnerCapabilities.usable`).
public protocol Locker: Sendable {
    func lock() throws(RpcErrorObject)
}

/// A Central de Controle abre por um arrasto do canto superior direito, 0,9 · 0,01 → 0,9 · 0,2 da tela (S1 item 7;
/// o SP-9 mede). O aperto curto e a velocidade padrão do XCTest são escolhas desta tarefa.
public enum ControlCenterGesture {
    public static let x = 0.9
    public static let startY = 0.01
    public static let endY = 0.2
    public static let pressSeconds = 0.05

    public static func open(screen: Size) -> DragGesture {
        DragGesture(from: AbsolutePoint(x: x * screen.w, y: startY * screen.h), to: AbsolutePoint(x: x * screen.w, y: endY * screen.h),
                    pressSeconds: pressSeconds, velocity: nil, holdSeconds: 0)
    }
}

// MARK: Métodos

public enum DeviceMethods {
    public enum Method: String, Sendable, CaseIterable {
        case state = "device.state"
        case home = "device.home"
        case press = "device.press"
        case wake = "device.wake"
        case controlCenter = "device.controlCenter"
        case lock = "device.lock"
        case appActivate = "app.activate"
        case appTerminate = "app.terminate"
        case appState = "app.state"
        case appOpenURL = "app.openURL"
        case waitFor = "wait.for"
    }

    public struct Context: Sendable {
        /// O contexto das ações (leitura e lista permitida, `Toucher` para o arrasto da Central, relógio D).
        public var action: ActionMethods.Context
        public var device: any DeviceController
        /// PX-1 presente e liberado; `nil` = `device.lock` responde `E_CAPABILITY_MISSING`.
        public var locker: (any Locker)?
        /// `{network}` lido agora (`nil` = desconhecido).
        public var network: @Sendable () -> NetworkState?
        /// A leitura da subida (S1 item 10; a de `session.hello`): tela em pontos e os valores de reserva.
        public var info: @Sendable () -> DeviceInfo
        /// Idioma, tamanho de texto e aparência lidos **agora**, a cada `device.state` (na fila do XCTest); `nil` num
        /// campo = vale o da subida.
        public var traits: @Sendable () -> LiveTraits
        /// A seção `scenes` está rodando (de `choreo.run {section: scenes}` até `take.end`; S1 item 9).
        public var inScenes: @Sendable () -> Bool
        /// Espera entre sondagens de `wait.for`, em ns (no runner, gira o run loop sem soltar a fila do XCTest).
        public var sleep: @Sendable (UInt64) -> Void

        public init(action: ActionMethods.Context, device: any DeviceController, locker: (any Locker)?,
                    network: @escaping @Sendable () -> NetworkState?, info: @escaping @Sendable () -> DeviceInfo,
                    traits: @escaping @Sendable () -> LiveTraits = { LiveTraits() },
                    inScenes: @escaping @Sendable () -> Bool = { false },
                    sleep: @escaping @Sendable (UInt64) -> Void = { Thread.sleep(forTimeInterval: Double($0) / 1e9) }) {
            self.action = action
            self.device = device
            self.locker = locker
            self.network = network
            self.info = info
            self.traits = traits
            self.inScenes = inScenes
            self.sleep = sleep
        }

        var read: ReadMethods.Context { action.read }
        var clock: @Sendable () -> UInt64 { action.clock }

        /// As fontes das condições de S0.3.
        public var conditions: ConditionSources {
            let device = device
            return ConditionSources(read: read, appState: { device.appState($0) }, network: network)
        }
    }

    /// Registra os onze na fila do XCTest, com os prazos do roteador (`wait.for` = `timeoutMs` + 1 s; os demais
    /// ⚠️ 10 s; S1 item 3).
    public static func register(into router: inout RpcRouter, _ context: Context) {
        router.register(Method.state.rawValue, lane: .xctest) { call throws(RpcErrorObject) in
            try noParams(call)
            return state(context).json
        }
        router.register(Method.home.rawValue, lane: .xctest) { call throws(RpcErrorObject) in
            try noParams(call)
            return try home(context).json
        }
        router.register(Method.press.rawValue, lane: .xctest) { call throws(RpcErrorObject) in
            try press(call.decode(DevicePressParams.self), context).json
        }
        router.register(Method.wake.rawValue, lane: .xctest) { call throws(RpcErrorObject) in
            try noParams(call)
            return try wake(context).json
        }
        router.register(Method.controlCenter.rawValue, lane: .xctest) { call throws(RpcErrorObject) in
            try controlCenter(call.decode(DeviceControlCenterParams.self), context).json
        }
        router.register(Method.lock.rawValue, lane: .xctest) { call throws(RpcErrorObject) in
            try noParams(call)
            return try lock(context).json
        }
        router.register(Method.appActivate.rawValue, lane: .xctest) { call throws(RpcErrorObject) in
            try activate(call.decode(AppBundleParams.self), context).json
        }
        router.register(Method.appTerminate.rawValue, lane: .xctest) { call throws(RpcErrorObject) in
            try terminate(call.decode(AppBundleParams.self), context).json
        }
        router.register(Method.appState.rawValue, lane: .xctest) { call throws(RpcErrorObject) in
            try appState(call.decode(AppBundleParams.self), context).json
        }
        router.register(Method.appOpenURL.rawValue, lane: .xctest) { call throws(RpcErrorObject) in
            try openURL(call.decode(AppOpenURLParams.self), context).json
        }
        router.register(Method.waitFor.rawValue, lane: .xctest) { call throws(RpcErrorObject) in
            try waitFor(call.decode(WaitForParams.self), context).json
        }
    }

    /// Métodos sem argumentos: `params` ausente ou `{}` (como `runner.shutdown`; o Mac manda `{}`).
    static func noParams(_ call: RpcCall) throws(RpcErrorObject) {
        if call.params != nil { _ = try call.decode(EmptyParams.self) }
    }

    // MARK: device.state

    /// `device.state` (S1 itens 4 e 10): bloqueio e app à frente pela mesma leitura (e classificação) do `health`, que
    /// ela atualiza — bloqueio não lido conta como travado, nada provado à frente é `""`; rede do monitor (ainda
    /// desconhecida = `offline`); idioma, tamanho de texto e aparência lidos agora (`traits`; o que não se leu fica com a
    /// leitura da subida); a tela em pontos é a da subida.
    public static func state(_ context: Context) -> DeviceStateResult {
        let session = ReadSession(context.read)
        let screen = session.readScreen()
        let info = context.info().updated(with: context.traits())
        return DeviceStateResult(locked: screen.lock != .unlocked, network: context.network() ?? .offline,
                                 foregroundApp: session.allowList.front(screen).bundleId, language: info.language,
                                 screenPt: info.screenPt, textSize: info.textSize, appearance: info.appearance)
    }

    // MARK: Botões

    /// `device.home` = `device.press {button: home}` (S1 item 7: sem desligar a ociosidade do SpringBoard).
    public static func home(_ context: Context) throws(RpcErrorObject) -> DeviceActionResult {
        try press(DevicePressParams(button: .home), context)
    }

    /// `device.press {button}`: na seção `scenes`, os de volume são `E_FORBIDDEN_IN_TAKE` (mostram o HUD; os dois
    /// juntos encerram a automação; S1 item 9, P-4) e nada é apertado.
    public static func press(_ params: DevicePressParams, _ context: Context) throws(RpcErrorObject) -> DeviceActionResult {
        let start = context.clock()
        if params.button != .home, context.inScenes() {
            throw RpcErrorObject(.forbiddenInTake, "E_FORBIDDEN_IN_TAKE: device.press \(params.button.rawValue) durante a seção scenes "
                                 + "(o HUD de volume apareceria no vídeo; S1 item 9, P-4); nada foi apertado")
        }
        return try dispatch(context, start: start) { () throws(RpcErrorObject) in try context.device.press(params.button) }
    }

    /// `device.wake` (S1 item 8): com a tela travada **provada**, um `press(.home)` acende a tela travada sem
    /// destravar (ninguém olhando; o SP-7 confirma). Destravada, a tela está acesa e nada é apertado (um home sairia do
    /// app). Bloqueio não lido: `E_FORBIDDEN_APP`, nada apertado.
    public static func wake(_ context: Context) throws(RpcErrorObject) -> DeviceActionResult {
        let start = context.clock()
        switch ReadSession(context.read).readScreen().lock {
        case .locked:
            return try dispatch(context, start: start) { () throws(RpcErrorObject) in try context.device.press(.home) }
        case .unlocked:
            return unchanged(context, start: start)
        case .unknown:
            throw AllowList.forbidden("device.wake recusado: o bloqueio não foi lido (lockstate); nada foi apertado (S1 item 8)")
        }
    }

    // MARK: Central de Controle

    /// `device.controlCenter {action}` (S1 itens 7 e 11). Abrir: só sobre a tela de início limpa ou um app operável à
    /// frente, pelo arrasto do canto superior direito (`ControlCenterGesture`; o começo fica de propósito na faixa de
    /// gesto do sistema); já aberta, nada a fazer. Fechar: só com ela provadamente aberta, por `press(.home)` (o SP-9
    /// confere que volta ao que estava por baixo); já fechada, nada a fazer. Tela travada (lá só o arrasto de
    /// destravar), folha `authkit`, camadas e o que não se provou: `E_FORBIDDEN_APP`, nada feito.
    public static func controlCenter(_ params: DeviceControlCenterParams, _ context: Context) throws(RpcErrorObject) -> DeviceActionResult {
        let start = context.clock()
        let session = ReadSession(context.read)
        let front = session.allowList.front(session.readScreen())
        switch (params.action, front) {
        case (.open, .controlCenter), (.close, .homeScreen), (.close, .operable):
            return unchanged(context, start: start, path: params.action == .open ? context.action.toucher.path : .public)
        case (.open, .homeScreen), (.open, .operable):
            let gesture = ControlCenterGesture.open(screen: context.read.screenSize)
            return try dispatch(context, start: start, path: context.action.toucher.path) { () throws(RpcErrorObject) in
                try context.action.toucher.drag(gesture)
            }
        case (.close, .controlCenter):
            return try dispatch(context, start: start) { () throws(RpcErrorObject) in try context.device.press(.home) }
        default:
            throw AllowList.forbidden("device.controlCenter \(params.action.rawValue) recusado com \(front) à frente; a Central de "
                                      + "Controle só se abre sobre a tela de início ou um app operável (S1 itens 7 e 11)")
        }
    }

    // MARK: Travar (PX-1)

    /// `device.lock` (S1 item 8): sem PX-1 presente e liberado, `E_CAPABILITY_MISSING` e nada mais acontece — nem a
    /// tela é lida (AC-1.10, AC-1.16); a coreografia usa um ponto de controle (o dono aperta o botão lateral). Com ele:
    /// só com a tela provadamente destravada (já travada, apertar de novo acenderia a tela: nada a fazer); bloqueio
    /// não lido, `E_FORBIDDEN_APP`.
    public static func lock(_ context: Context) throws(RpcErrorObject) -> DeviceActionResult {
        let start = context.clock()
        guard let locker = context.locker else {
            throw RpcErrorObject(.capabilityMissing, "E_CAPABILITY_MISSING: device.lock precisa do PX-1 presente e liberado "
                                 + "(runner.privateAllowed); sem ele, um ponto de controle: o dono aperta o botão lateral (S1 item 8, A10)")
        }
        switch ReadSession(context.read).readScreen().lock {
        case .unlocked:
            return try dispatch(context, start: start, path: .private) { () throws(RpcErrorObject) in try locker.lock() }
        case .locked:
            return unchanged(context, start: start, path: .private)
        case .unknown:
            throw AllowList.forbidden("device.lock recusado: o bloqueio não foi lido (lockstate); nada foi apertado (S1 item 8)")
        }
    }

    // MARK: Apps

    /// Abrir/terminar app e abrir link são ações (S1 item 11): **logo antes de agir**, relê a tela e só segue com um
    /// app operável provado à frente ou a tela de início limpa. Tela travada (lá só o arrasto de destravar), bloqueio
    /// não lido ("nada se lê, age ou captura"), qualquer camada do SpringBoard (inclusive a Central de Controle), a
    /// folha `authkit` e o que está fora da lista ou não se provou: `E_FORBIDDEN_APP`, nada feito.
    static func checkFrontForAppAction(_ what: String, _ session: ReadSession) throws(RpcErrorObject) {
        let front = session.allowList.front(session.readScreen())
        switch front {
        case .operable, .homeScreen:
            return
        default:
            throw AllowList.forbidden("\(what) recusado com \(front) à frente; abrir ou terminar app e abrir link só com um app "
                                      + "operável à frente ou a tela de início limpa, destravada (S1 item 11); nada foi feito")
        }
    }

    /// `app.activate {bundleId}`: só apps operáveis (o app alvo, o hospedeiro fora de tomada, `apps.allowed`; S1 item 11),
    /// e só com a tela relida logo antes (`checkFrontForAppAction`).
    public static func activate(_ params: AppBundleParams, _ context: Context) throws(RpcErrorObject) -> DeviceActionResult {
        let start = context.clock()
        let session = ReadSession(context.read)
        try session.allowList.checkAppControl(params.bundleId)
        try checkFrontForAppAction("app.activate", session)
        return try dispatch(context, start: start) { () throws(RpcErrorObject) in try context.device.activate(params.bundleId) }
    }

    /// `app.terminate {bundleId}`: só apps operáveis, com a tela relida logo antes.
    public static func terminate(_ params: AppBundleParams, _ context: Context) throws(RpcErrorObject) -> DeviceActionResult {
        let start = context.clock()
        let session = ReadSession(context.read)
        try session.allowList.checkAppControl(params.bundleId)
        try checkFrontForAppAction("app.terminate", session)
        return try dispatch(context, start: start) { () throws(RpcErrorObject) in try context.device.terminate(params.bundleId) }
    }

    /// `app.state {bundleId}` → `{state}`: só apps operáveis; estado desconhecido → `E_APP_STATE`.
    public static func appState(_ params: AppBundleParams, _ context: Context) throws(RpcErrorObject) -> AppStateResult {
        try context.read.allowList().checkAppControl(params.bundleId)
        guard let state = context.device.appState(params.bundleId) else {
            throw RpcErrorObject(.appState, "E_APP_STATE: o estado de \(params.bundleId) é desconhecido (não instalado ou não responde)")
        }
        return AppStateResult(state: state)
    }

    /// `app.openURL {url}`: na seção `scenes`, `E_FORBIDDEN_IN_TAKE` (S1 item 9, P-4); fora dela, só os prefixos
    /// permitidos (`app.urlPrefixes` da coreografia carregada e `urls.allowedPrefixes`; `AllowList.checkOpenURL`, com
    /// as recusas do aparelho) e só com a tela relida logo antes (`checkFrontForAppAction`). O link aberto é exatamente
    /// o texto conferido.
    public static func openURL(_ params: AppOpenURLParams, _ context: Context) throws(RpcErrorObject) -> DeviceActionResult {
        let start = context.clock()
        if context.inScenes() {
            throw RpcErrorObject(.forbiddenInTake, "E_FORBIDDEN_IN_TAKE: app.openURL durante a seção scenes (S1 item 9, P-4); nada foi aberto")
        }
        let session = ReadSession(context.read)
        try session.allowList.checkOpenURL(params.url)
        guard let url = URL(string: params.url, encodingInvalidCharacters: false), url.absoluteString == params.url else {
            throw AllowList.forbidden("link recusado: não vira URL sem mudar o texto conferido")
        }
        try checkFrontForAppAction("app.openURL", session)
        return try dispatch(context, start: start) { () throws(RpcErrorObject) in try context.device.openURL(url) }
    }

    // MARK: wait.for

    /// `wait.for {condition, timeoutMs}` (S0.3): confere a condição contra a lista permitida sem ler a tela
    /// (`E_FORBIDDEN_APP` na hora), depois sonda a cada 100 ms ⚠️ até valer — ou `E_TIMEOUT` no prazo.
    public static func waitFor(_ params: WaitForParams, _ context: Context) throws(RpcErrorObject) -> WaitForResult {
        let evaluator = ConditionEvaluator(context.conditions)
        let (start, end) = try evaluator.wait(for: params.condition, timeoutMs: params.timeoutMs, clock: context.clock,
                                              sleep: context.sleep)
        return WaitForResult(tDevStartNs: Nanos(clamping: start), tDevEndNs: Nanos(clamping: end))
    }

    // MARK: Tempos

    /// Marca `tDispatchNs` logo antes do envio e `tDevEndNs` logo depois.
    static func dispatch(_ context: Context, start: UInt64, path: ActionPath = .public,
                         _ send: () throws(RpcErrorObject) -> Void) throws(RpcErrorObject) -> DeviceActionResult {
        let dispatched = context.clock()
        try send()
        let end = context.clock()
        return DeviceActionResult(tDevStartNs: Nanos(clamping: start), tDispatchNs: Nanos(clamping: dispatched),
                                  tDevEndNs: Nanos(clamping: end), path: path)
    }

    /// Nada a enviar (a tela já estava como pedido): `tDispatchNs = tDevEndNs` = o instante da decisão.
    static func unchanged(_ context: Context, start: UInt64, path: ActionPath = .public) -> DeviceActionResult {
        let now = Nanos(clamping: context.clock())
        return DeviceActionResult(tDevStartNs: Nanos(clamping: start), tDispatchNs: now, tDevEndNs: now, path: path)
    }
}
