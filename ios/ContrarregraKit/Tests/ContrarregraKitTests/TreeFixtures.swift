import Foundation
import XCTest

@testable import ContrarregraKit

/// Árvores de fixture para a resolução de alvos e a lista permitida (T-0.6), no formato que o `Driver` do
/// runner tira do snapshot público. O app alvo é fictício (`com.example.target`; AC-3.7: nada do app real no
/// código).
enum TreeFixtures {
    static let target = "com.example.target"
    static let notes = "com.example.notes"
    static let screen = Size(w: 390, h: 844)

    static func node(_ type: ElementType, _ label: String, id: String? = nil, value: String? = nil,
                     _ x: Double, _ y: Double, _ w: Double, _ h: Double, enabled: Bool = true, selected: Bool = false,
                     _ children: [RawNode] = []) -> RawNode {
        RawNode(type: type, label: label, identifier: id, value: value, frame: Rect(x: x, y: y, w: w, h: h),
                enabled: enabled, selected: selected, children: children)
    }

    /// Nó sem rótulo.
    static func node(_ type: ElementType, id: String? = nil, value: String? = nil,
                     _ x: Double, _ y: Double, _ w: Double, _ h: Double, enabled: Bool = true, selected: Bool = false,
                     _ children: [RawNode] = []) -> RawNode {
        RawNode(type: type, label: nil, identifier: id, value: value, frame: Rect(x: x, y: y, w: w, h: h),
                enabled: enabled, selected: selected, children: children)
    }

    /// O leitor do app alvo: barra de navegação, uma lista com três linhas (a terceira fora da tela) e a barra
    /// de abas.
    static let reader: RawNode = node(.application, "Example Target", 0, 0, 390, 844, [
        node(.window, 0, 0, 390, 844, [
            node(.navigationBar, "Psalms", 0, 47, 390, 44, [
                node(.button, "Back", id: "nav-back", 8, 52, 60, 34),
                node(.staticText, "Psalms 23", 150, 58, 90, 22),
                node(.button, "Open settings", 342, 52, 40, 40),
            ]),
            node(.scrollView, id: "verses", 0, 91, 390, 700, [
                node(.cell, "Verse 1", 0, 91, 390, 120, [
                    node(.staticText, "The Lord is my shepherd", 70, 100, 300, 60),
                    node(.button, "Play", 16, 100, 44, 44),
                ]),
                node(.cell, "Verse 2", 0, 211, 390, 120, [
                    node(.staticText, "He makes me lie down", 70, 220, 300, 60),
                    node(.button, "Play", 16, 220, 44, 44),
                ]),
                node(.cell, "Verse 3", 0, 900, 390, 120, [
                    node(.button, "Play", 16, 910, 44, 44),
                ]),
            ]),
            node(.tabBar, 0, 791, 390, 53, [
                node(.button, "Read", 0, 795, 97, 49, selected: true),
                node(.button, "Journal", 97, 795, 97, 49),
                node(.button, "Plans", 194, 795, 97, 49, enabled: false),
            ]),
        ]),
    ])

    /// A tela de início: a página 0 visível com o ícone do app alvo, um ícone pessoal (Settings), um widget com
    /// texto, a busca; a página 1 fora da tela; a doca.
    static let home: RawNode = node(.application, "SpringBoard", 0, 0, 390, 844, [
        node(.other, id: "home-screen", 0, 0, 390, 844, [
            node(.icon, "Example Target", 27, 80, 64, 76),
            node(.icon, "Photos", 117, 80, 64, 76),
            node(.icon, "Settings", 207, 80, 64, 76),
            node(.other, "Calendar", 27, 200, 334, 160, [node(.staticText, "Dentist 3 PM", 40, 220, 200, 20)]),
            node(.icon, "Notes", 417, 80, 64, 76),
            node(.button, "Search", 150, 700, 90, 30),
        ]),
        node(.other, id: "dock", 0, 744, 390, 100, [node(.icon, "Phone", 27, 760, 64, 64)]),
    ])

    /// A Central de Controle aberta por cima da tela de início (com um widget de contato atrás, visível na árvore).
    static let controlCenter: RawNode = node(.application, "SpringBoard", 0, 0, 390, 844, [
        node(.other, id: "home-screen", 0, 0, 390, 844, [
            node(.icon, "Example Target", 27, 80, 64, 76),
            node(.button, "Call Alex Doe", 27, 600, 160, 60),
            node(.switch, "Focus", 200, 600, 160, 60),
        ]),
        node(.other, id: "control-center", 0, 0, 390, 844, [
            node(.switch, "Airplane Mode", id: "airplane-mode-button", value: "0", 30, 90, 60, 60),
            node(.button, "Wi-Fi", id: "wifi-button", value: "Home Network", 100, 90, 60, 60),
            node(.staticText, "Now Playing: Psalm 23", 200, 90, 160, 40),
        ]),
    ])

    /// A tela travada: hora, notificações (uma com botão de copiar código, outra que é um botão), os controles de
    /// mídia e o título.
    static let lockScreen: RawNode = node(.application, "SpringBoard", 0, 0, 390, 844, [
        node(.staticText, "9:41", 120, 90, 150, 80),
        node(.cell, "Messages, 123456 is your code", id: "ListCell", 20, 220, 350, 70, [
            node(.button, "Copy Code", 280, 240, 80, 30),
        ]),
        node(.button, "Mail, New message", id: "NotificationCell", 20, 300, 350, 70),
        // Botões que a lista negativa deixava passar: notificação com id desconhecido, widget, Live Activity.
        node(.button, "Maria: 482913 is your code", id: "NotificationListCell", 20, 580, 350, 60),
        node(.button, "Calendar, Dentist with Dr. Silva 3 PM", 20, 650, 350, 60),
        node(.button, "Delivery, arriving in 5 min", id: "LiveActivity", 20, 720, 350, 60),
        // Live Activity pessoal com um "Pause" solitário: rótulo de mídia, mas fora de um grupo de Now Playing.
        node(.other, id: "workout-activity", 20, 780, 350, 60, [
            node(.staticText, "Workout 25:13", 30, 790, 200, 20),
            node(.button, "Pause", 320, 790, 40, 40),
        ]),
        node(.other, id: "now-playing", 20, 400, 350, 160, [
            node(.staticText, "Psalm 23", 40, 410, 200, 20),
            node(.slider, "Track position", value: "35%", 40, 440, 310, 20),
            node(.button, "Previous track", 80, 480, 44, 44),
            node(.button, "Pause", 173, 480, 44, 44),
            node(.button, "Next track", 266, 480, 44, 44),
        ]),
    ])

    /// A folha do Sign in with Apple: título, nome e e-mail da conta (nunca saem do aparelho) e os botões.
    static let authSheet: RawNode = node(.application, "AuthKitUIService", 0, 0, 390, 844, [
        node(.staticText, "Sign in with Apple", 20, 420, 350, 30),
        node(.staticText, "Someone Private", 20, 470, 350, 20),
        node(.button, "Share My Email", value: "someone@example.com", 20, 520, 350, 44),
        node(.button, "Continue as someone@example.com", 20, 640, 350, 44),
        node(.button, "Continue", 20, 700, 350, 50),
        node(.button, "Continue with Password", 20, 760, 350, 40),
    ])

    /// Linhas do OCR do leitor, em pontos: "shepherd" em duas colunas, uma frase em duas linhas.
    static let readerText: [OcrLine] = [
        OcrLine(words: [word("The", 70, 100, 30), word("Lord", 104, 100, 40), word("is", 148, 100, 14),
                        word("my", 166, 100, 24), word("shepherd;", 194, 100, 80)]),
        OcrLine(words: [word("CURRENT", 70, 300, 80), word("DAY", 154, 300, 40)]),
        OcrLine(words: [word("Shepherd", 220, 400, 80, confidence: 0.6)]),
    ]

    static func word(_ text: String, _ x: Double, _ y: Double, _ w: Double, confidence: Double = 0.9) -> OcrWord {
        OcrWord(text: text, frame: Rect(x: x, y: y, w: w, h: 20), confidence: confidence)
    }
}

/// Telas como o runner as prova (`ScreenState`), inclusive camadas do SpringBoard por cima de um app.
enum Screens {
    /// `app` à frente e atingível no centro (a tela de início limpa, quando `app` é o SpringBoard).
    static func proven(_ app: String, locked: Bool = false) -> ScreenState { ScreenState(foregroundApp: app, locked: locked) }

    static func facts(lock: LockReading = .unlocked, app: String? = nil, appHit: Bool = false, springBoardHit: Bool = false,
                      homeVisible: Bool = false, homeHit: Bool = false, overlays: Set<SpringBoardLayer> = []) -> ScreenState {
        ScreenState(lock: lock, foregroundApp: app, foregroundHittable: appHit, springBoardHittable: springBoardHit,
                    homeScreenVisible: homeVisible, homeScreenHittable: homeHit, overlays: overlays)
    }

    /// Tela travada, provada pela `lockstate`.
    static let locked = facts(lock: .locked)
    /// A `lockstate` não foi lida (ou está em transição): nada provado.
    static func lockUnknown(over app: String = TreeFixtures.target) -> ScreenState { facts(lock: .unknown, app: app, appHit: true) }
    /// Central de Controle por cima do app: o app continua `.runningForeground`, o centro é do SpringBoard.
    static func controlCenter(over app: String) -> ScreenState {
        facts(app: app, springBoardHit: true, overlays: [.controlCenter])
    }
    /// Central de Controle por cima da tela de início (ícones dela atrás, na tela).
    static let controlCenterOverHome = facts(springBoardHit: true, homeVisible: true, overlays: [.controlCenter])
    /// Central de Controle por cima de um app que o runner não conhece (sem ícones da tela de início atrás).
    static let controlCenterOverUnknown = facts(springBoardHit: true, overlays: [.controlCenter])
    /// Central de Notificações puxada com o aparelho destravado.
    static func notificationCenter(over app: String) -> ScreenState {
        facts(app: app, springBoardHit: true, overlays: [.notificationCenter])
    }
    /// Alternador de apps: nenhum marcador conhecido, só o teste de toque no centro cai no SpringBoard.
    static func appSwitcher(over app: String) -> ScreenState { facts(app: app, springBoardHit: true) }
    /// Alternador, Spotlight ou alerta do SpringBoard sobre a tela de início: ícones na tela, nenhum atingível.
    static let springBoardLayerOverHome = facts(springBoardHit: true, homeVisible: true)
    /// Uma notificação em faixa por cima do app (o centro ainda é do app).
    static func banner(over app: String) -> ScreenState {
        facts(app: app, appHit: true, overlays: [.notificationCenter])
    }
    /// O SpringBoard não pôde ser lido: camada não identificada.
    static func unidentified(over app: String) -> ScreenState { facts(app: app, appHit: true, overlays: [.unidentified]) }
    /// Um app que o runner não conhece à frente (fora da ordem de sondagem): nada provado.
    static let unknownApp = facts()
    /// O app alvo reportado `.runningForeground`, mas sem o centro.
    static func notReachable(_ app: String) -> ScreenState { facts(app: app) }
}

/// Um aparelho falso para os métodos de leitura: o que está à frente (inclusive uma fila de estados para a tela
/// mudar entre leituras), as árvores por app, o texto do OCR, e a contagem do que foi lido e processado — para
/// provar que nada é capturado, codificado ou passado pelo OCR quando a lista permitida recusa.
final class FakeReader: DeviceReader, @unchecked Sendable {
    private let lock = NSLock()
    private var _screen: ScreenState
    private var _queued: [ScreenState] = []
    private var _trees: [String: RawNode]
    private var _text: [OcrLine]
    private var _captures = 0
    private var _encodes = 0
    private var _recognitions: [Rect] = []
    private var _snapshots: [String] = []
    private var _screenReads = 0
    /// O que fica à frente logo depois de uma captura (a tela mudando no meio dela).
    var screenAfterCapture: ScreenState?

    init(front: String = TreeFixtures.target, locked: Bool = false, trees: [String: RawNode] = [:],
         text: [OcrLine] = TreeFixtures.readerText) {
        _screen = Screens.proven(front, locked: locked)
        _trees = trees
        _text = text
    }

    convenience init(screen: ScreenState, trees: [String: RawNode]) {
        self.init(trees: trees)
        screenState = screen
    }

    var screenState: ScreenState {
        get { lock.withLock { _screen } }
        set { lock.withLock { _screen = newValue } }
    }

    /// As próximas leituras de `screen()` devolvem estes estados, em ordem (depois, o último fica).
    func queue(_ screens: ScreenState...) { lock.withLock { _queued += screens } }

    func setTree(_ app: String, _ tree: RawNode) { lock.withLock { _trees[app] = tree } }

    var captures: Int { lock.withLock { _captures } }
    var encodes: Int { lock.withLock { _encodes } }
    var recognitions: [Rect] { lock.withLock { _recognitions } }
    var snapshots: [String] { lock.withLock { _snapshots } }
    var screenReads: Int { lock.withLock { _screenReads } }
    /// Capturas cruas de qualquer tipo (imagem ou OCR).
    var anyCapture: Int { captures }

    func screen() -> ScreenState {
        lock.withLock {
            _screenReads += 1
            if !_queued.isEmpty { _screen = _queued.removeFirst() }
            return _screen
        }
    }

    func snapshot(of bundleId: String) throws(RpcErrorObject) -> RawNode {
        let tree = lock.withLock { () -> RawNode? in
            _snapshots.append(bundleId)
            return _trees[bundleId]
        }
        guard let tree else { throw RpcErrorObject(.appState, "E_APP_STATE: \(bundleId) não está rodando") }
        return tree
    }

    func captureScreen() throws(RpcErrorObject) -> ScreenFrame {
        lock.withLock {
            _captures += 1
            if let next = screenAfterCapture { _screen = next }
            return ScreenFrame("frame-\(_captures)")
        }
    }

    func encode(_ frame: ScreenFrame, _ request: CaptureRequest) throws(RpcErrorObject) -> CapturedImage {
        lock.withLock { _encodes += 1 }
        let points = request.scale == .points
        return CapturedImage(data: Data("fake-\(request.format.rawValue)".utf8), widthPx: points ? 390 : 1170,
                             heightPx: points ? 844 : 2532, scale: points ? 1 : 3)
    }

    func recognizeText(in frame: ScreenFrame, region: Rect) throws(RpcErrorObject) -> [OcrLine] {
        lock.withLock {
            _recognitions.append(region)
            return _text
        }
    }
}

/// Monta o contexto dos métodos de leitura sobre um `FakeReader`.
struct ReadHarness {
    let reader: FakeReader
    let store: AllowListStore
    let registry = TreeRegistry()
    let state = RunnerState()

    init(reader: FakeReader, allowList: AllowList) {
        self.reader = reader
        store = AllowListStore(allowList)
    }

    var context: ReadMethods.Context {
        let store = store
        return ReadMethods.Context(reader: reader, allowList: { store.current }, screenSize: TreeFixtures.screen,
                                   registry: registry, state: state)
    }

    /// Exploração no aparelho físico com `app.explore = com.example.target`.
    static func exploring(front: String = TreeFixtures.target, locked: Bool = false, apps: [String] = [],
                          isSimulator: Bool = false) -> ReadHarness {
        exploring(screen: locked ? Screens.locked : Screens.proven(front), apps: apps, isSimulator: isSimulator)
    }

    /// Exploração com a tela dada (camadas do SpringBoard, app desconhecido…).
    static func exploring(screen: ScreenState, apps: [String] = [], isSimulator: Bool = false) -> ReadHarness {
        let reader = FakeReader(screen: screen, trees: [
            TreeFixtures.target: TreeFixtures.reader,
            SystemApp.springboard: TreeFixtures.home,
            SystemApp.authkit: TreeFixtures.authSheet,
        ])
        return ReadHarness(reader: reader, allowList: AllowList(isSimulator: isSimulator, explore: TreeFixtures.target, apps: apps))
    }

    func session() -> ReadSession { ReadSession(context) }
}

/// Afirma que a chamada lança o erro do runner dado e devolve a mensagem.
@discardableResult
func assertRunnerError<T>(_ code: RunnerErrorCode, file: StaticString = #filePath, line: UInt = #line,
                          _ body: () throws(RpcErrorObject) -> T) -> RpcErrorObject? {
    do {
        let value = try body()
        XCTFail("esperava \(code.rawValue), veio \(value)", file: file, line: line)
        return nil
    } catch {
        XCTAssertEqual(error.code, code.code, "esperava \(code.rawValue), veio \(error.message)", file: file, line: line)
        return error
    }
}
