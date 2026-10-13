import Foundation

// Lista permitida do runner (S1 item 11, P-3, P-7): quais apps e links o runner opera, o que se lê e o que se
// age no SpringBoard, na tela travada e na folha do Sign in with Apple. Lógica pura, testada com `swift test`;
// o `Driver` do runner só informa o que está à frente (`ScreenState`) e obedece à decisão.

/// Bundle ids de sistema que a lista permitida conhece pelo nome.
public enum SystemApp {
    public static let springboard = "com.apple.springboard"
    /// Folha do Sign in with Apple (`authkit` em S0.2).
    public static let authkit = "com.apple.AuthKitUIService"
    /// `bundle.host` padrão (S0.1, ✅ Q-3).
    public static let host = "app.kifactory.contrarregra"

    /// Ajustes, Telefone, Mensagens, Mail, Wallet e as lojas (S1 item 11): no iPhone físico nunca entram na
    /// lista, nem como app alvo, nem como `app.explore`, nem em `apps.allowed` (P-3). Só o simulador os aceita
    /// (AC-3.7).
    public static let personal: [String] = [
        "com.apple.Preferences", "com.apple.mobilephone", "com.apple.MobileSMS", "com.apple.mobilemail",
        "com.apple.Passbook", "com.apple.AppStore", "com.apple.MobileStore",
    ]

    /// Esquemas de link que abrem os apps de `personal` (Ajustes, Telefone/FaceTime, Mensagens, Mail, Wallet,
    /// lojas). No iPhone físico `app.openURL` os recusa mesmo que um prefixo permitido os cubra (P-3: "recusa
    /// mesmo que a configuração peça"). Comparados em minúsculas.
    public static let personalURLSchemes: Set<String> = [
        "app-settings", "prefs", "app-prefs", "tel", "telprompt", "sms", "mailto", "message", "shoebox", "wallet",
    ]

    /// Famílias de esquema recusadas pelo começo do nome: `facetime*` (FaceTime) e `itms*` (lojas).
    public static let personalURLSchemePrefixes: [String] = ["facetime", "itms"]

    /// Hosts de links universais que abrem as lojas no lugar do navegador (e os subdomínios deles); `apple.co` é o
    /// redirecionador curto da Apple, que leva às lojas.
    public static let personalURLHosts: [String] = ["apps.apple.com", "itunes.apple.com", "apple.co"]

    /// Rótulos de botão da folha do Sign in with Apple que a leitura e o toque aceitam, comparados exatamente
    /// (lista fechada, provisória até o SP-8). Nenhum outro botão da folha é alcançado.
    public static let sheetButtonLabels: Set<String> = [
        "Continue", "Cancel", "Use Face ID", "Use Password", "Share My Email", "Hide My Email", "Not Now", "OK",
    ]

    /// Nomes que os apps de `personal` mostram sob o ícone (em inglês, o idioma do aparelho, e em pt-BR por
    /// segurança): no aparelho, uma coreografia não pode dizer que o ícone do app alvo tem um desses nomes.
    public static let personalDisplayNames: Set<String> = [
        "settings", "ajustes", "phone", "telefone", "messages", "mensagens", "mail", "wallet", "carteira", "passbook",
        "app store", "itunes store", "facetime",
    ]

    /// Normaliza um nome exibido para comparar: sem caixa, sem acentos, espaços repetidos e das pontas tirados.
    public static func normalizedDisplayName(_ name: String) -> String {
        name.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: nil)
            .split(whereSeparator: \.isWhitespace).joined(separator: " ")
    }

    public static func isPersonalScheme(_ scheme: String) -> Bool {
        let scheme = scheme.lowercased()
        return personalURLSchemes.contains(scheme) || personalURLSchemePrefixes.contains { scheme.hasPrefix($0) }
    }

    public static func isStoreHost(_ host: String) -> Bool {
        personalURLHosts.contains { host == $0 || host.hasSuffix("." + $0) }
    }
}

/// Uma camada do SpringBoard por cima da tela, reconhecida por elementos característicos visíveis do processo
/// `com.apple.springboard` (consulta pública). Os identificadores vêm da pesquisa (`research/xctest.md` F25) e
/// são provisórios até o SP-9/SP-1 os medirem no iOS 26; a prova principal é o teste de toque no centro da tela
/// (`ScreenState.foregroundHittable`), que pega também as camadas sem marcador (alternador de apps).
public enum SpringBoardLayer: String, Sendable, CaseIterable {
    case controlCenter, notificationCenter
    /// O SpringBoard não pôde ser lido: há (ou pode haver) uma camada que o runner não identifica.
    case unidentified

    /// Identificadores dos controles da Central de Controle (módulo de conectividade).
    public static let controlCenterIdentifiers: Set<String> = [
        "airplane-mode-button", "wifi-button", "bluetooth-button", "cellular-data-button", "hotspot-button",
    ]
    /// Prefixo dos identificadores de módulos da Central de Controle (`com.apple.ControlCenter.WiFi`…).
    public static let controlCenterIdentifierPrefix = "com.apple.ControlCenter."
    /// Identificadores das células de notificação (Central de Notificações e faixas; "ListCell" desde o iOS 18).
    public static let notificationIdentifiers: Set<String> = ["ListCell", "NotificationCell"]

    /// Todos os identificadores exatos que marcam uma camada (para a consulta do runner).
    public static var markerIdentifiers: Set<String> { controlCenterIdentifiers.union(notificationIdentifiers) }

    /// A camada marcada por um identificador de elemento do SpringBoard, se for um marcador.
    public static func marked(by identifier: String?) -> SpringBoardLayer? {
        guard let identifier else { return nil }
        if controlCenterIdentifiers.contains(identifier) || identifier.hasPrefix(controlCenterIdentifierPrefix) {
            return .controlCenter
        }
        if notificationIdentifiers.contains(identifier) { return .notificationCenter }
        return nil
    }
}

/// Um app visto pela lista permitida (o `app` de S0.2 depois de resolvido).
public enum AppScope: Sendable, Hashable, CustomStringConvertible {
    /// App operável: o app alvo, o hospedeiro (fora de tomada) ou um de `apps.allowed`.
    case app(String)
    /// SpringBoard: tela de início, Central de Controle e tela travada (`springboard`, `controlcenter`).
    case springboard
    /// Folha do Sign in with Apple (`authkit`).
    case authkit

    public var bundleId: String {
        switch self {
        case .app(let id): id
        case .springboard: SystemApp.springboard
        case .authkit: SystemApp.authkit
        }
    }

    public var description: String {
        switch self {
        case .app(let id): id
        case .springboard: "springboard"
        case .authkit: "authkit"
        }
    }
}

/// Leitura do bloqueio pela `com.apple.springboard.lockstate`.
public enum LockReading: String, Sendable {
    case unlocked, locked
    /// Não lida (falha do registro ou da leitura): conta como desconhecido — nada se lê, age ou captura.
    case unknown
}

/// O que o runner prova sobre a tela, só por APIs públicas (a classificação é de `AllowList.front`, que recusa
/// tudo o que não foi provado — FAIL-CLOSED):
/// - `lock`: `com.apple.springboard.lockstate` (travada, destravada, ou não lida);
/// - `foregroundApp`: o primeiro app de `foregroundProbeOrder` em `.runningForeground` (`nil` = nenhum conhecido);
///   um app que o runner não conhece (fora da sondagem) nunca aparece aqui;
/// - `foregroundHittable`: uma janela desse app que cobre o centro da tela é `isHittable` (o teste de toque de
///   acessibilidade no centro cai nele, e não numa camada do SpringBoard por cima);
/// - `springBoardHittable`: idem para o SpringBoard;
/// - `homeScreenVisible`: há ícones da tela de início na tela (atrás de uma camada ou não);
/// - `homeScreenHittable`: um ícone da tela de início é `isHittable` (nada por cima: tela de início limpa);
/// - `overlays`: camadas do SpringBoard com marcador visível (Central de Controle, notificações) ou não
///   identificada (SpringBoard ilegível).
public struct ScreenState: Sendable, Equatable {
    public var lock: LockReading
    public var foregroundApp: String?
    public var foregroundHittable: Bool
    public var springBoardHittable: Bool
    public var homeScreenVisible: Bool
    public var homeScreenHittable: Bool
    public var overlays: Set<SpringBoardLayer>

    public init(lock: LockReading, foregroundApp: String?, foregroundHittable: Bool, springBoardHittable: Bool,
                homeScreenVisible: Bool, homeScreenHittable: Bool, overlays: Set<SpringBoardLayer>) {
        self.lock = lock
        self.foregroundApp = foregroundApp
        self.foregroundHittable = foregroundHittable
        self.springBoardHittable = springBoardHittable
        self.homeScreenVisible = homeScreenVisible
        self.homeScreenHittable = homeScreenHittable
        self.overlays = overlays
    }

    /// Uma tela provada: `foregroundApp` à frente e atingível no centro, sem camada por cima (a tela de início
    /// limpa, quando `foregroundApp` é o SpringBoard); travada provada, quando `locked`.
    public init(foregroundApp: String, locked: Bool) {
        let lock: LockReading = locked ? .locked : .unlocked
        if AllowList.same(foregroundApp, SystemApp.springboard) {
            self.init(lock: lock, foregroundApp: nil, foregroundHittable: false, springBoardHittable: true,
                      homeScreenVisible: true, homeScreenHittable: true, overlays: [])
        } else {
            self.init(lock: lock, foregroundApp: foregroundApp, foregroundHittable: true, springBoardHittable: false,
                      homeScreenVisible: false, homeScreenHittable: false, overlays: [])
        }
    }
}

/// O que está à frente, classificado pela lista permitida (FAIL-CLOSED; ver `AllowList.front`).
public enum Front: Sendable, Equatable, CustomStringConvertible {
    /// Um app operável à frente, sem camada por cima (o único caso em que se captura a tela).
    case operable(String)
    /// Tela de início limpa: o SpringBoard tem o centro, um ícone dela é atingível e não há camada.
    case homeScreen
    /// Central de Controle aberta sobre a tela de início ou sobre um app operável.
    case controlCenter
    /// Tela travada, provada pela `lockstate`.
    case lockScreen
    /// Folha do Sign in with Apple, provada à frente com o aparelho destravado.
    case authkit
    /// Camada do SpringBoard que não libera nada: Central de Notificações ou faixa, alternador, Spotlight,
    /// alerta do SpringBoard, camada não identificada, ou qualquer camada sobre app pessoal/desconhecido.
    case layer
    /// Um app fora da lista, ou nada provado (`""`).
    case outside(String)

    /// Bundle id do que está à frente (o `foregroundApp` de `health`); `""` quando não se sabe.
    public var bundleId: String {
        switch self {
        case .operable(let id), .outside(let id): id
        case .homeScreen, .controlCenter, .lockScreen, .layer: SystemApp.springboard
        case .authkit: SystemApp.authkit
        }
    }

    public var description: String {
        switch self {
        case .operable(let id): "o app \(id)"
        case .homeScreen: "a tela de início"
        case .controlCenter: "a Central de Controle"
        case .lockScreen: "a tela travada"
        case .authkit: "a folha do Sign in with Apple (authkit)"
        case .layer: "uma camada do SpringBoard (notificações, alternador, Spotlight, alerta ou não identificada)"
        case .outside(let id): id.isEmpty ? "algo que o runner não provou (app desconhecido ou bloqueio não lido)"
            : "o app \(id), fora da lista permitida"
        }
    }
}

/// Faixas de gesto do sistema, em pontos a partir das bordas da tela: um arrasto que começa na faixa de cima
/// (barra de estado) puxa a Central de Notificações ou a de Controle; um que começa na de baixo (indicador de
/// início) vai para a tela de início ou troca de app. Provisórias até o SP-9/SP-10 medirem.
public struct GestureBands: Sendable, Equatable {
    public var top: Double
    public var bottom: Double

    public init(top: Double, bottom: Double) {
        self.top = top
        self.bottom = bottom
    }

    /// Telas com entalhe ou Ilha Dinâmica (altura ≥ 812 pt, como o iPhone 12 com 390×844): barra de estado de
    /// 47 pt e indicador de início de 34 pt. Telas com botão de início: 20 pt em cima e 20 pt embaixo (de onde se
    /// puxa a Central de Controle).
    public static func forScreen(_ screen: Size) -> GestureBands {
        screen.h >= 812 ? GestureBands(top: 47, bottom: 34) : GestureBands(top: 20, bottom: 20)
    }
}

/// Ações sobre um elemento resolvido (S1 item 4); cada uma passa pela lista permitida antes de tocar a tela.
public enum ElementAction: String, Sendable, CaseIterable {
    case tap, doubleTap, longPress, drag, scrollTo, type

    /// Ações cujo começo é um gesto que o sistema pode tomar para si nas bordas (arrasto, rolagem, toque longo).
    /// Toque e toque duplo na barra de estado ficam liberados: não abrem camada (o app pode rolar para o topo).
    public var startsGesture: Bool { self == .drag || self == .scrollTo || self == .longPress }
}

/// A lista permitida de S1 item 11, montada do ambiente da sessão (`CONTRARREGRA_EXPLORE`,
/// `CONTRARREGRA_ALLOWED`) e, quando houver, da coreografia carregada.
public struct AllowList: Sendable, Equatable {
    /// O `app` da coreografia carregada (S0.4): bundle id, rótulo do ícone e prefixos de link.
    public struct ChoreographyApp: Sendable, Equatable {
        public var bundleId: String
        public var iconLabel: String?
        public var urlPrefixes: [String]

        public init(bundleId: String, iconLabel: String? = nil, urlPrefixes: [String] = []) {
            self.bundleId = bundleId
            self.iconLabel = iconLabel
            self.urlPrefixes = urlPrefixes
        }
    }

    /// Um item da configuração recusado na montagem (para o registro do runner).
    public struct Refusal: Sendable, Equatable, CustomStringConvertible {
        public var item: String
        public var reason: String

        public var description: String { "\(item): \(reason)" }
    }

    /// Simulador: só nele os apps de `SystemApp.personal` são aceitos (AC-3.7).
    public var isSimulator: Bool
    public var hostBundleId: String
    /// `app.explore` (sem coreografia carregada, é o app alvo).
    public private(set) var explore: String?
    /// `apps.allowed`.
    public private(set) var apps: [String]
    /// `urls.allowedPrefixes`.
    public private(set) var urlPrefixes: [String]
    /// A coreografia carregada (`choreo.load`), se houver.
    public private(set) var choreography: ChoreographyApp?
    /// Há tomada em curso: o hospedeiro sai da lista (S1 item 11).
    public var inTake: Bool
    /// Itens da configuração que ficaram de fora, com o motivo.
    public private(set) var refused: [Refusal]

    /// Monta a lista; itens proibidos ficam fora e vão para `refused` (o runner os registra e segue servindo).
    public init(isSimulator: Bool, hostBundleId: String = SystemApp.host, explore: String? = nil, apps: [String] = [],
                urlPrefixes: [String] = [], inTake: Bool = false) {
        self.isSimulator = isSimulator
        self.hostBundleId = hostBundleId
        self.inTake = inTake
        self.choreography = nil
        self.explore = nil
        self.apps = []
        self.urlPrefixes = []
        self.refused = []
        if let explore, !explore.isEmpty {
            if let reason = refusalReason(app: explore) {
                refused.append(Refusal(item: explore, reason: "app.explore recusado: \(reason)"))
            } else {
                self.explore = explore
            }
        }
        for app in apps where !app.isEmpty {
            if let reason = refusalReason(app: app) {
                refused.append(Refusal(item: app, reason: "apps.allowed recusado: \(reason)"))
            } else if !self.apps.contains(where: { Self.same($0, app) }) {
                self.apps.append(app)
            }
        }
        for prefix in urlPrefixes where !prefix.isEmpty {
            if let reason = refusalReason(url: prefix) {
                refused.append(Refusal(item: prefix, reason: "urls.allowedPrefixes recusado: \(reason)"))
            } else if !self.urlPrefixes.contains(prefix) {
                self.urlPrefixes.append(prefix)
            }
        }
    }

    /// Do ambiente da sessão: `CONTRARREGRA_EXPLORE` e `CONTRARREGRA_ALLOWED` (bundle ids e prefixos de link
    /// juntos; um item com `:` é prefixo de link, os demais são bundle ids).
    public init(environment: RunnerEnvironment, isSimulator: Bool, hostBundleId: String = SystemApp.host) {
        let links = environment.allowed.filter { $0.contains(":") }
        let bundles = environment.allowed.filter { !$0.contains(":") }
        self.init(isSimulator: isSimulator, hostBundleId: hostBundleId, explore: environment.explore, apps: bundles,
                  urlPrefixes: links)
    }

    // MARK: Quem está na lista

    /// O app alvo: o da coreografia carregada ou, sem ela, `app.explore`.
    public var targetApp: String? { choreography?.bundleId ?? explore }

    /// O ícone do app alvo no SpringBoard (`app.iconLabel` da coreografia; sem coreografia, não há).
    public var iconLabel: String? { choreography?.iconLabel }

    /// Ajustes, Telefone, Mensagens, Mail, Wallet e lojas no aparelho físico.
    public func isPersonal(_ bundleId: String) -> Bool {
        !isSimulator && SystemApp.personal.contains { Self.same($0, bundleId) }
    }

    /// O runner opera este app: o app alvo, o hospedeiro (fora de tomada) ou um de `apps.allowed`.
    public func isOperable(_ bundleId: String) -> Bool {
        guard !bundleId.isEmpty, !isPersonal(bundleId), !Self.isSystemSheet(bundleId) else { return false }
        if let target = targetApp, Self.same(target, bundleId) { return true }
        if !inTake, Self.same(hostBundleId, bundleId) { return true }
        return apps.contains { Self.same($0, bundleId) }
    }

    /// Ordem em que o runner pergunta `XCUIApplication.state == .runningForeground` para achar o app à frente:
    /// a folha `authkit` antes de tudo (ela fica por cima do app que a abriu), os apps pessoais (para dizer
    /// qual deles está à frente), o app alvo, `apps.allowed` e o hospedeiro. Nenhum à frente = SpringBoard.
    public var foregroundProbeOrder: [String] {
        var order = [SystemApp.authkit]
        if !isSimulator { order += SystemApp.personal }
        if let target = targetApp { order.append(target) }
        order += apps
        order.append(hostBundleId)
        var seen: Set<String> = []
        return order.filter { seen.insert($0.lowercased()).inserted }
    }

    /// Classifica a tela, FAIL-CLOSED — o que não se prova é desconhecido e nada se libera:
    /// 1. bloqueio não lido → desconhecido; travada → tela travada (com a Central por cima → camada);
    /// 2. marcador de notificação (Central de Notificações, faixa) ou camada não identificada → camada;
    /// 3. Central de Controle → `.controlCenter` só sobre um app operável (o `.runningForeground`) ou sobre a tela
    ///    de início (ícones dela na tela, nenhum app conhecido à frente); sobre o resto → camada;
    /// 4. app `.runningForeground` com o centro (e o SpringBoard sem ele) → a folha, o app operável, ou fora;
    /// 5. SpringBoard com o centro: tela de início limpa só se um ícone dela é atingível; senão (alternador,
    ///    Spotlight, alerta) → camada;
    /// 6. o resto → desconhecido.
    public func front(_ screen: ScreenState) -> Front {
        switch screen.lock {
        case .unknown: return .outside("")
        case .locked: return screen.overlays.contains(.controlCenter) || screen.overlays.contains(.unidentified) ? .layer : .lockScreen
        case .unlocked: break
        }
        if screen.overlays.contains(.notificationCenter) || screen.overlays.contains(.unidentified) { return .layer }
        let app = screen.foregroundApp
        if screen.overlays.contains(.controlCenter) {
            if let app { return isOperable(app) ? .controlCenter : .layer }
            return screen.homeScreenVisible ? .controlCenter : .layer
        }
        if let app, screen.foregroundHittable, !screen.springBoardHittable {
            if Self.same(app, SystemApp.springboard) { return .layer }
            if Self.same(app, SystemApp.authkit) { return .authkit }
            return isOperable(app) ? .operable(app) : .outside(app)
        }
        if screen.springBoardHittable, !screen.foregroundHittable {
            return screen.homeScreenHittable ? .homeScreen : .layer
        }
        return .outside(app ?? "")
    }

    /// O app `id` é o que está à frente (provado).
    func isFront(_ id: String, _ front: Front) -> Bool {
        if case .operable(let fronted) = front { return Self.same(fronted, id) }
        return false
    }

    // MARK: Nomes de app (S0.2 `Target.app`)

    /// `app` de um alvo: `target` (padrão), `springboard`, `controlcenter` (= SpringBoard), `authkit`, ou um
    /// bundle id operável. Fora disso, `E_FORBIDDEN_APP`.
    public func scope(forTargetApp name: String?) throws(RpcErrorObject) -> AppScope {
        switch name {
        case nil, "target":
            guard let target = targetApp else {
                throw Self.forbidden("nenhum app alvo: sem coreografia carregada e sem app.explore na sessão (S1 item 11)")
            }
            return .app(target)
        case "springboard", "controlcenter":
            return .springboard
        case "authkit":
            return .authkit
        case let id?:
            if Self.same(id, SystemApp.springboard) { return .springboard }
            if Self.same(id, SystemApp.authkit) { return .authkit }
            if isPersonal(id) {
                throw Self.forbidden("\(id) nunca é operado no iPhone físico (Ajustes, Telefone, Mensagens, Mail, Wallet e lojas; P-3)")
            }
            guard isOperable(id) else {
                throw Self.forbidden("\(id) fora da lista permitida (app alvo, hospedeiro fora de tomada, apps.allowed)")
            }
            return .app(id)
        }
    }

    // MARK: Leituras

    /// Captura da tela (`screen.shot`, `ui.ocr`, seletor `ocr`, condição `text`): só com um app operável à
    /// frente; com o SpringBoard (tela de início, Central de Controle, tela travada) ou a folha `authkit` à
    /// frente, `E_FORBIDDEN_APP` e nada é capturado.
    public func checkCapture(_ screen: ScreenState) throws(RpcErrorObject) {
        guard case .operable = front(screen) else {
            throw Self.forbidden("captura recusada com \(front(screen)) à frente; nada foi capturado (S1 item 11)")
        }
    }

    /// `ui.tree`: só do app operável que está à frente (provado); nunca do SpringBoard nem da folha `authkit`,
    /// nunca com a tela travada, nunca de um app em segundo plano.
    public func checkTree(_ app: AppScope, screen: ScreenState) throws(RpcErrorObject) {
        guard case .app(let id) = app, isOperable(id) else {
            throw Self.forbidden("ui.tree de \(app) recusado: a árvore só sai de app operável, nunca do SpringBoard nem da folha authkit (S1 item 11)")
        }
        guard isFront(id, front(screen)) else {
            throw Self.forbidden("ui.tree de \(id) recusado com \(front(screen)) à frente (S1 item 11)")
        }
    }

    /// `ui.tree {app?}`: o app pedido, ou o app em primeiro plano quando não vem.
    public func treeScope(_ name: String?, screen: ScreenState) throws(RpcErrorObject) -> AppScope {
        let scope: AppScope
        if let name {
            scope = try self.scope(forTargetApp: name)
        } else {
            guard case .operable(let id) = front(screen) else {
                throw Self.forbidden("ui.tree recusado com \(front(screen)) à frente (S1 item 11)")
            }
            scope = .app(id)
        }
        try checkTree(scope, screen: screen)
        return scope
    }

    /// Leitura de elementos (`ui.find`, condições, qualquer seletor — inclusive `point`), FAIL-CLOSED:
    /// - app operável: só quando é ele o que está à frente (provado), nunca em segundo plano;
    /// - SpringBoard: só com ele à frente (tela de início, Central de Controle, tela travada);
    /// - folha `authkit`: só com ela à frente e o aparelho destravado.
    /// No SpringBoard e na `authkit` a leitura ainda é recortada por `ReadScope`.
    public func checkElementRead(_ app: AppScope, screen: ScreenState) throws(RpcErrorObject) {
        let front = front(screen)
        switch app {
        case .app(let id):
            guard isOperable(id) else { throw Self.forbidden("\(id) fora da lista permitida") }
            guard isFront(id, front) else {
                throw Self.forbidden("leitura de \(id) recusada com \(front) à frente; só se lê o app que está à frente (S1 item 11)")
            }
        case .springboard:
            switch front {
            case .homeScreen, .controlCenter, .lockScreen: break
            default: throw Self.forbidden("leitura do SpringBoard recusada com \(front) à frente (S1 item 11)")
            }
        case .authkit:
            guard case .authkit = front else {
                throw Self.forbidden("leitura da folha authkit recusada com \(front) à frente; só com a folha à frente e destravado (S1 item 11)")
            }
        }
    }

    // MARK: Ações

    /// Ação sobre um alvo resolvido, com o ponto final onde o toque vai cair (centro + `offset`). É assim que a
    /// T-0.7 chama: `checkAction(.tap, resolved: try session.resolve…, screen: session.readScreen())` — ou, mais
    /// simples, `ReadSession.resolveForAction`, que resolve, relê a tela e confere.
    public func checkAction(_ action: ElementAction, resolved: ResolvedTarget, display: Size, screen: ScreenState) throws(RpcErrorObject) {
        try checkElementAction(action, app: resolved.candidate.app, node: resolved.candidate.node, point: resolved.point,
                               display: display, screen: screen)
    }

    /// Ação sobre um elemento resolvido (`node` = o nó da árvore, quando o alvo veio dela; `point` = onde o toque
    /// cai, centro + `offset`):
    /// - app operável: só quando é ele o que está à frente (provado); `type` com a folha, o SpringBoard ou uma
    ///   camada à frente é `E_SECURE_FIELD` (`checkTypingFront`; as demais recusas de `ui.type` estão em `TypeGuard`); o
    ///   deslocamento é livre (o app inteiro é permitido);
    /// - SpringBoard: só tocar o ícone do app alvo (rótulo exato) na tela de início limpa e o interruptor do modo
    ///   avião com a Central de Controle aberta; na tela travada, nada (o arrasto de destravar é `checkUnlockDrag`);
    /// - folha `authkit`: só `tap` em botão, com a folha à frente;
    /// - no SpringBoard e na folha, `point` tem de cair dentro do frame do nó permitido (um `offset` que leve o
    ///   toque para fora — o ícone vizinho, outro controle da Central — é `E_FORBIDDEN_APP`);
    /// - em todo lugar (menos `type`, que não tem ponto): `point` dentro da tela (`display`, em pontos), um nó sem
    ///   frame não é alvo, e o começo de arrasto, rolagem e toque longo fica fora das faixas de gesto do sistema
    ///   (`GestureBands`; `checkActionPoint`, que a T-0.7 usa também para `to` e o caminho do arrasto).
    ///
    /// `gestureStart` (padrão: `action.startsGesture`) diz se `point` é o começo do gesto; `false` confere um ponto
    /// do meio ou do fim (`to` e `via` de `ui.drag`, o fim de cada passe de `ui.scrollTo`) sem as faixas de gesto.
    public func checkElementAction(_ action: ElementAction, app: AppScope, node: TreeNode?, point: AbsolutePoint?,
                                   display: Size, screen: ScreenState, gestureStart: Bool? = nil) throws(RpcErrorObject) {
        let front = front(screen)
        if action == .type {
            _ = try checkTypingFront(screen)
        } else {
            guard let point else { throw Self.forbidden("ação sem ponto na tela") }
            if let node, !(node.frame.area > 0) {
                throw Self.forbidden("\(node.ref) não tem frame na tela; não é alvo de ação")
            }
            try Self.checkActionPoint(point, gestureStart: gestureStart ?? action.startsGesture, display: display)
        }
        switch app {
        case .app(let id):
            guard isOperable(id) else { throw Self.forbidden("\(id) fora da lista permitida") }
            guard isFront(id, front) else {
                throw Self.forbidden("ui.\(action.rawValue) em \(id) recusado com \(front) à frente (S1 item 11)")
            }
        case .springboard:
            if case .lockScreen = front {
                throw Self.forbidden("na tela travada só o arrasto de destravar, dentro de ponto de controle, depois de {locked: false} (S1 item 11)")
            }
            guard action == .tap, let node, isSpringBoardActionable(node, front: front) else {
                throw Self.forbidden("no SpringBoard só se toca o ícone do app alvo (app.iconLabel) na tela de início limpa e o "
                                     + "interruptor do modo avião com a Central de Controle aberta; à frente: \(front) (S1 item 11)")
            }
            try Self.checkInside(point, node)
        case .authkit:
            guard case .authkit = front else {
                throw Self.forbidden("ação na folha authkit recusada com \(front) à frente; só com a folha à frente e destravado (S1 item 11)")
            }
            guard action == .tap, let node, node.type == .button else {
                throw Self.forbidden("na folha do Sign in with Apple só se tocam botões (S1 item 11)")
            }
            try Self.checkInside(point, node)
        }
    }

    /// Um ponto do meio ou do fim de um gesto sobre um alvo resolvido (`to` e `via` de `ui.drag`): as regras de
    /// `checkAction`, sem as faixas de gesto do começo.
    public func checkActionPath(_ action: ElementAction, resolved: ResolvedTarget, display: Size,
                                screen: ScreenState) throws(RpcErrorObject) {
        try checkElementAction(action, app: resolved.candidate.app, node: resolved.candidate.node, point: resolved.point,
                               display: display, screen: screen, gestureStart: false)
    }

    /// Digitar (`ui.type`; S1 item 4, P-3): só com um app operável à frente, e devolve o bundle id dele. Com a
    /// folha `authkit`, o SpringBoard (tela de início, Central de Controle, tela travada com o teclado do código) ou
    /// uma camada à frente é tela de autenticação do sistema: `E_SECURE_FIELD`, sempre. Com algo fora da lista ou
    /// não provado à frente, `E_FORBIDDEN_APP`.
    public func checkTypingFront(_ screen: ScreenState) throws(RpcErrorObject) -> String {
        let front = front(screen)
        switch front {
        case .authkit, .homeScreen, .controlCenter, .lockScreen, .layer:
            throw RpcErrorObject(.secureField,
                                 "E_SECURE_FIELD: digitar com \(front) à frente é sempre recusado (tela de autenticação do sistema; P-3)")
        case .outside:
            throw Self.forbidden("ui.type recusado com \(front) à frente")
        case .operable(let id):
            return id
        }
    }

    /// O nó do SpringBoard em que se pode agir com `front` à frente: o ícone do app alvo (rótulo exato) só na
    /// tela de início limpa; o interruptor do modo avião só com a Central de Controle aberta. Nada mais.
    public func isSpringBoardActionable(_ node: TreeNode, front: Front) -> Bool {
        switch front {
        case .homeScreen:
            guard node.type == .icon, let iconLabel else { return false }
            return node.label == iconLabel
        case .controlCenter:
            return node.identifier == ReadScope.airplaneModeIdentifier
        default:
            return false
        }
    }

    /// O arrasto de destravar na tela travada: só depois de `{locked: false}` (Face ID feito) e dentro de um
    /// ponto de controle `who: runner` — ou, no build `Spike`, o `spike.unlockDrag` do SP-7 (AC-1.23).
    public func checkUnlockDrag(screen: ScreenState, inRunnerCheckpoint: Bool, spike: Bool = false) throws(RpcErrorObject) {
        guard screen.lock == .unlocked else {
            throw Self.forbidden("arrasto de destravar recusado: a tela não está provadamente destravada (lockstate \(screen.lock.rawValue); S1 item 11)")
        }
        guard inRunnerCheckpoint || spike else {
            throw Self.forbidden("arrasto de destravar só dentro de um ponto de controle who: runner (S1 item 11)")
        }
    }

    /// `app.activate|launch|terminate|state {bundleId}`: só apps operáveis.
    public func checkAppControl(_ bundleId: String) throws(RpcErrorObject) {
        if Self.same(bundleId, SystemApp.springboard) || Self.same(bundleId, SystemApp.authkit) {
            throw Self.forbidden("\(bundleId) não é operado como app (S1 item 11)")
        }
        if isPersonal(bundleId) {
            throw Self.forbidden("\(bundleId) nunca é operado no iPhone físico (P-3)")
        }
        guard isOperable(bundleId) else { throw Self.forbidden("\(bundleId) fora da lista permitida") }
    }

    /// `app.openURL {url}`: decidido pelo URL analisado (`LinkRule`), não pelo texto. Só `app.urlPrefixes` da
    /// coreografia carregada e `urls.allowedPrefixes`, casados por componentes normalizados; nunca URL com
    /// userinfo; no iPhone físico, nunca um link que abra Ajustes, Telefone/FaceTime, Mensagens, Mail, Wallet ou
    /// as lojas, mesmo que um prefixo permita.
    public func checkOpenURL(_ url: String) throws(RpcErrorObject) {
        guard let link = LinkRule(url, isPrefix: false) else {
            throw Self.forbidden("link recusado: não se analisa como URL com esquema, ou tem userinfo")
        }
        if let reason = personalReason(link, opening: true) { throw Self.forbidden("link recusado: \(reason)") }
        let prefixes = ((choreography?.urlPrefixes ?? []) + urlPrefixes).compactMap { LinkRule($0, isPrefix: true) }
        guard prefixes.contains(where: { $0.covers(link) }) else {
            throw Self.forbidden("link fora dos prefixos permitidos (app.urlPrefixes, urls.allowedPrefixes): \(url)")
        }
    }

    /// A lista com uma coreografia carregada (`choreo.load`): o app dela vira o app alvo. No iPhone físico, um
    /// app pessoal como app alvo é `E_FORBIDDEN_APP` (AC-1.24).
    public func loading(_ app: ChoreographyApp) throws(RpcErrorObject) -> AllowList {
        if let reason = refusalReason(app: app.bundleId) {
            throw Self.forbidden("coreografia recusada: app.bundleId \(reason)")
        }
        if !isSimulator, let label = app.iconLabel,
           SystemApp.personalDisplayNames.contains(SystemApp.normalizedDisplayName(label)) {
            throw Self.forbidden("coreografia recusada: app.iconLabel \"\(label)\" é o nome de Ajustes, Telefone, Mensagens, Mail, Wallet, loja ou FaceTime (P-3)")
        }
        var copy = self
        copy.choreography = ChoreographyApp(bundleId: app.bundleId, iconLabel: app.iconLabel,
                                            urlPrefixes: app.urlPrefixes.filter { refusalReason(url: $0) == nil })
        return copy
    }

    /// A lista sem coreografia (volta a `app.explore`).
    public func unloaded() -> AllowList {
        var copy = self
        copy.choreography = nil
        return copy
    }

    // MARK: Apoio

    /// Um ponto de ação: dentro da tela; se é o começo de um gesto (arrasto, rolagem, toque longo), também fora das
    /// faixas de gesto do sistema. A T-0.7 confere com isto cada ponto de `ui.drag`/`ui.scrollTo`: o começo com
    /// `gestureStart: true`; `to` e o caminho com `false`.
    public static func checkActionPoint(_ point: AbsolutePoint, gestureStart: Bool, display: Size) throws(RpcErrorObject) {
        guard Rect(screen: display).contains(x: point.x, y: point.y) else {
            throw forbidden("ponto (\(point.x), \(point.y)) fora da tela")
        }
        guard gestureStart else { return }
        let bands = GestureBands.forScreen(display)
        guard point.y >= bands.top, point.y < display.h - bands.bottom else {
            throw forbidden("gesto começando na faixa do sistema (y \(point.y); faixas: \(bands.top) pt em cima, \(bands.bottom) pt embaixo) "
                            + "abriria uma camada do SpringBoard ou trocaria de app")
        }
    }

    /// O seletor de um alvo, conforme o app. Na folha do Sign in with Apple, só `label` exato de
    /// `SystemApp.sheetButtonLabels` (com `type` ausente ou `button`, e `index`/`offset` se quiser);
    /// `labelPrefix`, `labelContains`, `identifier`, `ocr`, `point`, `ref` e âncoras são recusados — nada que sirva
    /// de oráculo de texto para o nome ou o e-mail da conta Apple.
    public func checkSelector(_ target: Target, app: AppScope) throws(RpcErrorObject) {
        guard case .authkit = app else { return }
        guard let label = target.label, SystemApp.sheetButtonLabels.contains(label),
              target.labelPrefix == nil, target.labelContains == nil, target.identifier == nil, target.ocr == nil,
              target.point == nil, target.ref == nil, target.within == nil, target.below == nil, target.above == nil,
              target.type == nil || target.type == .button
        else {
            throw Self.forbidden("na folha do Sign in with Apple só se acha botão por label exato de uma lista fechada "
                                 + "(\(SystemApp.sheetButtonLabels.sorted().joined(separator: ", "))); S1 item 11")
        }
    }

    /// O toque cai dentro do frame do nó permitido.
    static func checkInside(_ point: AbsolutePoint?, _ node: TreeNode) throws(RpcErrorObject) {
        guard let point, node.frame.contains(x: point.x, y: point.y) else {
            throw forbidden("o ponto do toque sai do elemento permitido (offset para fora de \(node.ref)); no SpringBoard e na folha só dentro dele (S1 item 11)")
        }
    }

    public static func forbidden(_ message: String) -> RpcErrorObject {
        RpcErrorObject(.forbiddenApp, "E_FORBIDDEN_APP: \(message)")
    }

    /// Bundle ids se comparam sem diferenciar maiúsculas (como o iOS faz).
    static func same(_ a: String, _ b: String) -> Bool {
        a.compare(b, options: .caseInsensitive) == .orderedSame
    }

    static func isSystemSheet(_ bundleId: String) -> Bool {
        same(bundleId, SystemApp.springboard) || same(bundleId, SystemApp.authkit)
    }

    private func refusalReason(app: String) -> String? {
        if isPersonal(app) { return "\(app) é Ajustes, Telefone, Mensagens, Mail, Wallet ou loja (nunca no iPhone físico; P-3)" }
        if Self.isSystemSheet(app) { return "\(app) só é alcançado pelas regras do SpringBoard e da folha authkit" }
        return nil
    }

    /// Motivo de recusa de um prefixo de link da configuração ou da coreografia. No aparelho, um prefixo http(s)
    /// sem host (`https://`) não é permissão: abriria qualquer site, inclusive os que levam às lojas.
    private func refusalReason(url prefix: String) -> String? {
        guard let link = LinkRule(prefix, isPrefix: true) else {
            return "prefixo de link inválido (precisa de esquema; sem userinfo, consulta ou fragmento)"
        }
        if !isSimulator, link.host == nil, link.scheme == "http" || link.scheme == "https" {
            return "prefixo \(link.scheme) sem host não vale no iPhone físico (nomeie o site)"
        }
        return personalReason(link)
    }

    /// No iPhone físico: esquema pessoal ou host de loja (P-3) — também no caminho quando o link não tem host
    /// (`https:apps.apple.com/…`, que o Safari normaliza); e um link http(s) a abrir sem host é recusado.
    private func personalReason(_ link: LinkRule, opening: Bool = false) -> String? {
        guard !isSimulator else { return nil }
        if let host = link.host, !host.unicodeScalars.allSatisfy({ (0x21...0x7E).contains($0.value) }) {
            return "host com caractere fora do ASCII imprimível (o navegador o converteria; P-3)"
        }
        if SystemApp.isPersonalScheme(link.scheme) {
            return "o esquema \(link.scheme): abre Ajustes, Telefone/FaceTime, Mensagens, Mail, Wallet ou loja (P-3)"
        }
        if let host = link.host ?? link.hostInPath, SystemApp.isStoreHost(host) { return "\(host) abre uma loja (P-3)" }
        if opening, link.host == nil, link.scheme == "http" || link.scheme == "https" {
            return "link \(link.scheme) sem host (o navegador o completaria)"
        }
        return nil
    }
}

/// Um link (ou prefixo de link) analisado e normalizado: esquema e host em minúsculas, host sem ponto final,
/// porta explícita, caminho. Recusa texto com espaço ou caractere de controle, sem esquema, ou com userinfo; um
/// prefixo também não pode ter consulta nem fragmento.
struct LinkRule: Equatable {
    let scheme: String
    let host: String?
    let port: Int?
    let path: String
    /// O caminho resolvido (`normalizedPath`), contra o qual o prefixo casa.
    let normalizedPath: String
    /// Barra ou contrabarra codificada (`%2f`, `%5c`) ou contrabarra crua no caminho: nunca casa com prefixo que
    /// limita o caminho (o servidor ou o navegador poderiam lê-la como separador).
    let hasEncodedSeparator: Bool

    init?(_ text: String, isPrefix: Bool) {
        guard !text.isEmpty,
              !text.unicodeScalars.contains(where: { CharacterSet.whitespacesAndNewlines.contains($0) || CharacterSet.controlCharacters.contains($0) }),
              let components = URLComponents(string: text, encodingInvalidCharacters: false),
              let scheme = components.scheme?.lowercased(), !scheme.isEmpty,
              components.user == nil, components.password == nil
        else { return nil }
        if isPrefix && (components.query != nil || components.fragment != nil) { return nil }
        // Host codificado que não se decodifica: inválido.
        if let raw = components.percentEncodedHost, !raw.isEmpty, components.host == nil { return nil }
        var host = components.host?.lowercased()
        while let current = host, current.hasSuffix(".") { host = String(current.dropLast()) }
        self.scheme = scheme
        self.host = (host?.isEmpty ?? true) ? nil : host
        self.port = components.port
        self.path = components.path
        let raw = components.percentEncodedPath
        self.hasEncodedSeparator = raw.contains("\\") || raw.range(of: "%2f", options: .caseInsensitive) != nil
            || raw.range(of: "%5c", options: .caseInsensitive) != nil
        self.normalizedPath = Self.normalizedPath(raw)
    }

    /// O caminho como o navegador o resolve: segmentos `.` e `..` (também `%2e`, `%2E`, `.%2e`…) resolvidos; `..`
    /// acima da raiz fica na raiz; termina em `/` quando o último segmento era um diretório (`.`/`..`).
    static func normalizedPath(_ path: String) -> String {
        let absolute = path.hasPrefix("/")
        var segments = path.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
        if absolute { segments.removeFirst() }
        var out: [String] = []
        var endsAsDirectory = false
        for (index, segment) in segments.enumerated() {
            let decoded = segment.replacingOccurrences(of: "%2e", with: ".", options: .caseInsensitive)
            let last = index == segments.count - 1
            switch decoded {
            case ".":
                endsAsDirectory = last
            case "..":
                if !out.isEmpty { out.removeLast() }
                endsAsDirectory = last
            default:
                out.append(segment)
                endsAsDirectory = false
            }
        }
        var joined = out.joined(separator: "/")
        if endsAsDirectory, !joined.isEmpty { joined += "/" }
        return absolute ? "/" + joined : joined
    }

    /// Sem host: o primeiro segmento do caminho, normalizado como host (`https:apps.apple.com/app` →
    /// `apps.apple.com`).
    var hostInPath: String? {
        guard host == nil else { return nil }
        var first = path.drop { $0 == "/" }.prefix { $0 != "/" }.lowercased()
        while first.hasSuffix(".") { first.removeLast() }
        return first.isEmpty ? nil : first
    }

    /// Este prefixo cobre `link`: mesmo esquema; se o prefixo tem host, mesmo host e mesma porta; e o caminho do
    /// link, já resolvido (`normalizedPath`), começa pelo do prefixo em fronteira de segmento (`/docs` cobre
    /// `/docs` e `/docs/a`, não `/docs2` nem `/docs/../x`).
    func covers(_ link: LinkRule) -> Bool {
        guard scheme == link.scheme else { return false }
        if let host {
            guard link.host == host, link.port == port else { return false }
        }
        if path.isEmpty { return true }
        guard !link.hasEncodedSeparator else { return false }
        let target = link.normalizedPath
        if path == "/" { return target.isEmpty || target.hasPrefix("/") }
        if path.hasSuffix("/") { return target.hasPrefix(path) }
        return target == path || target.hasPrefix(path + "/")
    }
}

/// A lista permitida corrente, trocada por `choreo.load` e pelo começo/fim da tomada (tarefas seguintes); lida
/// pelos tratadores a cada comando.
public final class AllowListStore: @unchecked Sendable {
    private let lock = NSLock()
    private var value: AllowList

    public init(_ initial: AllowList) {
        value = initial
    }

    public var current: AllowList {
        get { lock.withLock { value } }
        set { lock.withLock { value = newValue } }
    }
}
