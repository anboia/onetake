import Foundation
import XCTest

@testable import ContrarregraKit

/// Lista permitida de S1 item 11 e P-3 (T-0.6): quem o runner opera, ações × leituras, SpringBoard, tela
/// travada e folha `authkit`. As ACs do aparelho (AC-1.15, AC-1.17, AC-1.21…AC-1.24) medem-se nos spikes;
/// aqui se prova a regra.
final class AllowListTests: XCTestCase {
    typealias F = TreeFixtures
    let token = "tok-3f9a1c7e5b2d4086a1e9c3b5d7f0a2c4"

    let device = AllowList(isSimulator: false, explore: F.target, apps: [F.notes])

    func screen(_ app: String, locked: Bool = false) -> ScreenState { ScreenState(foregroundApp: app, locked: locked) }

    func forbidden(_ body: () throws(RpcErrorObject) -> Void, file: StaticString = #filePath, line: UInt = #line) {
        assertRunnerError(.forbiddenApp, file: file, line: line, body)
    }

    func node(_ type: ElementType, _ label: String? = nil, id: String? = nil, frame: Rect = Rect(x: 0, y: 0, w: 10, h: 10)) -> TreeNode {
        TreeNode(ref: "@e1", type: type, label: label, identifier: id, frame: frame, depth: 1)
    }

    // MARK: Montagem

    func testEnvironmentSplitsBundleIdsFromLinkPrefixes() throws {
        let env = try RunnerEnvironment.read([
            "CONTRARREGRA_TOKEN": token,
            "CONTRARREGRA_ALLOWED": "com.example.notes, example://  https://example.com/docs/,com.example.maps",
            "CONTRARREGRA_EXPLORE": " com.example.target ",
        ], allowBindOverride: false)
        let list = AllowList(environment: env, isSimulator: false)
        XCTAssertEqual(list.explore, F.target)
        XCTAssertEqual(list.targetApp, F.target)
        XCTAssertEqual(list.apps, ["com.example.notes", "com.example.maps"])
        XCTAssertEqual(list.urlPrefixes, ["example://", "https://example.com/docs/"])
        XCTAssertTrue(list.refused.isEmpty)
    }

    func testPersonalAppsNeverEnterTheListOnThePhysicalPhone() {
        let list = AllowList(isSimulator: false, explore: "com.apple.Preferences",
                             apps: ["com.apple.MobileSMS", "COM.APPLE.MOBILEMAIL", F.notes, "com.apple.springboard", SystemApp.authkit],
                             urlPrefixes: ["tel:", "example://", "itms-apps://"])
        XCTAssertNil(list.explore, "app.explore = Ajustes é recusado (AC-1.24)")
        XCTAssertNil(list.targetApp)
        XCTAssertEqual(list.apps, [F.notes])
        XCTAssertEqual(list.urlPrefixes, ["example://"])
        XCTAssertEqual(Set(list.refused.map(\.item)), ["com.apple.Preferences", "com.apple.MobileSMS", "COM.APPLE.MOBILEMAIL",
                                                        "com.apple.springboard", SystemApp.authkit, "tel:", "itms-apps://"])
        for app in SystemApp.personal { XCTAssertFalse(list.isOperable(app), app) }
    }

    func testTheSimulatorAcceptsPersonalAppsButNotSystemSheets() {
        let list = AllowList(isSimulator: true, explore: "com.apple.Preferences", apps: ["com.apple.MobileSMS", "com.apple.springboard"],
                             urlPrefixes: ["tel:"])
        XCTAssertEqual(list.explore, "com.apple.Preferences", "AC-3.7: só o simulador aceita")
        XCTAssertEqual(list.apps, ["com.apple.MobileSMS"])
        XCTAssertEqual(list.urlPrefixes, ["tel:"])
        XCTAssertTrue(list.isOperable("com.apple.Preferences"))
    }

    func testLoadedChoreographyBecomesTheTargetAndAPersonalTargetIsForbiddenOnThePhone() throws {
        let loaded = try device.loading(.init(bundleId: "com.example.reader", iconLabel: "Example Reader", urlPrefixes: ["reader://"]))
        XCTAssertEqual(loaded.targetApp, "com.example.reader")
        XCTAssertEqual(loaded.iconLabel, "Example Reader")
        XCTAssertFalse(loaded.isOperable(F.target), "app.explore só vale sem coreografia")
        XCTAssertEqual(loaded.unloaded().targetApp, F.target)

        // AC-1.24: coreografia com app.bundleId = Ajustes.
        forbidden { () throws(RpcErrorObject) in _ = try device.loading(.init(bundleId: "com.apple.Preferences")) }
        let simulator = AllowList(isSimulator: true)
        XCTAssertEqual(try simulator.loading(.init(bundleId: "com.apple.Preferences")).targetApp, "com.apple.Preferences")
    }

    func testHostIsOperableOnlyOutsideATake() {
        var list = device
        XCTAssertTrue(list.isOperable(SystemApp.host))
        list.inTake = true
        XCTAssertFalse(list.isOperable(SystemApp.host))
        XCTAssertFalse(list.isOperable("app.kifactory.contrarregra.runner.xctrunner"), "o runner nunca é operado")
    }

    // MARK: Nomes de app de S0.2

    func testTargetAppNames() throws {
        XCTAssertEqual(try device.scope(forTargetApp: nil), .app(F.target))
        XCTAssertEqual(try device.scope(forTargetApp: "target"), .app(F.target))
        XCTAssertEqual(try device.scope(forTargetApp: "springboard"), .springboard)
        XCTAssertEqual(try device.scope(forTargetApp: "controlcenter"), .springboard)
        XCTAssertEqual(try device.scope(forTargetApp: "com.apple.springboard"), .springboard)
        XCTAssertEqual(try device.scope(forTargetApp: "authkit"), .authkit)
        XCTAssertEqual(try device.scope(forTargetApp: F.notes), .app(F.notes))
        forbidden { () throws(RpcErrorObject) in _ = try device.scope(forTargetApp: "com.apple.Preferences") }
        forbidden { () throws(RpcErrorObject) in _ = try device.scope(forTargetApp: "com.example.unknown") }
        forbidden { () throws(RpcErrorObject) in _ = try AllowList(isSimulator: false).scope(forTargetApp: nil) }
    }

    func testFrontClassification() {
        XCTAssertEqual(device.front(screen(F.target)), .operable(F.target))
        XCTAssertEqual(device.front(screen(SystemApp.springboard)), .homeScreen)
        XCTAssertEqual(device.front(screen(F.target, locked: true)), .lockScreen, "travada vence o app")
        XCTAssertEqual(device.front(screen(SystemApp.authkit)), .authkit)
        XCTAssertEqual(device.front(screen("com.apple.Preferences")), .outside("com.apple.Preferences"))
        XCTAssertEqual(device.front(screen("")), .outside(""))
    }

    /// Revisões 1 e 2: o app `.runningForeground` não basta; só o que o runner prova conta (FAIL-CLOSED). Tela de
    /// início limpa ≠ camadas do SpringBoard; só a Central de Controle sobre a tela de início ou um app operável
    /// tem regra própria; o resto não libera nada.
    func testFrontIsFailClosedOverSpringBoardLayersAndUnknownApps() {
        XCTAssertEqual(device.front(Screens.controlCenter(over: F.target)), .controlCenter, "Central sobre o app alvo")
        XCTAssertEqual(device.front(Screens.controlCenterOverHome), .controlCenter, "Central sobre a tela de início")
        XCTAssertEqual(device.front(Screens.controlCenter(over: "com.apple.MobileSMS")), .layer, "Central sobre app pessoal")
        XCTAssertEqual(device.front(Screens.controlCenter(over: SystemApp.authkit)), .layer, "Central sobre a folha")
        XCTAssertEqual(device.front(Screens.controlCenterOverUnknown), .layer, "Central sobre app desconhecido")
        XCTAssertEqual(device.front(Screens.notificationCenter(over: F.target)), .layer, "Central de Notificações")
        XCTAssertEqual(device.front(Screens.appSwitcher(over: F.target)), .layer, "alternador de apps")
        XCTAssertEqual(device.front(Screens.springBoardLayerOverHome), .layer, "alternador/Spotlight/alerta sobre a tela de início")
        XCTAssertEqual(device.front(Screens.banner(over: F.target)), .layer, "notificação em faixa por cima")
        XCTAssertEqual(device.front(Screens.unidentified(over: F.target)), .layer, "SpringBoard ilegível: camada não identificada")
        XCTAssertEqual(device.front(Screens.unknownApp), .outside(""), "app fora da sondagem: desconhecido, não SpringBoard")
        XCTAssertEqual(device.front(Screens.notReachable(F.target)), .outside(F.target), "rodando sem o centro: não provado")
        XCTAssertEqual(device.front(Screens.locked), .lockScreen)
        XCTAssertEqual(device.front(Screens.facts(lock: .locked, overlays: [.controlCenter])), .layer, "Central sobre a tela travada")
        XCTAssertEqual(device.front(Screens.facts(lock: .locked, overlays: [.notificationCenter])), .lockScreen,
                       "notificações fazem parte da tela travada (e ficam fora da leitura)")
        XCTAssertEqual(device.front(Screens.lockUnknown()), .outside(""), "revisão 3: bloqueio não lido = desconhecido")
        let contradictory = Screens.facts(app: F.target, appHit: true, springBoardHit: true)
        XCTAssertEqual(device.front(contradictory), .outside(F.target), "centro do app e do SpringBoard ao mesmo tempo: não provado")
        XCTAssertEqual(device.front(Screens.facts(springBoardHit: true, homeVisible: true, homeHit: true)), .homeScreen)
        XCTAssertEqual(Front.lockScreen.bundleId, SystemApp.springboard)
        XCTAssertEqual(Front.layer.bundleId, SystemApp.springboard)
        XCTAssertEqual(Front.controlCenter.bundleId, SystemApp.springboard)
        XCTAssertEqual(Front.outside("").bundleId, "")
    }

    /// Revisão 1 (reprodução): uma camada a mais nunca aumenta a permissão.
    func testAnExtraLayerNeverWidensWhatIsAllowed() throws {
        let loaded = try device.loading(.init(bundleId: F.target, iconLabel: "Example Target"))
        let messages = screen("com.apple.MobileSMS")
        let screens = [messages, Screens.banner(over: "com.apple.MobileSMS"), Screens.controlCenter(over: "com.apple.MobileSMS"),
                       Screens.appSwitcher(over: "com.apple.MobileSMS"), Screens.notificationCenter(over: "com.apple.MobileSMS")]
        for front in screens {
            forbidden { () throws(RpcErrorObject) in
                try loaded.checkElementActionAtCenter(.tap, app: .springboard, node: node(.icon, "Example Target"), screen: front)
            }
            forbidden { () throws(RpcErrorObject) in
                try loaded.checkElementActionAtCenter(.tap, app: .springboard, node: node(.switch, "Airplane Mode", id: "airplane-mode-button"),
                                              screen: front)
            }
            forbidden { () throws(RpcErrorObject) in try loaded.checkElementRead(.springboard, screen: front) }
            forbidden { () throws(RpcErrorObject) in try loaded.checkCapture(front) }
        }
    }

    func testSpringBoardMarkersNameTheLayers() {
        XCTAssertEqual(SpringBoardLayer.marked(by: "airplane-mode-button"), .controlCenter)
        XCTAssertEqual(SpringBoardLayer.marked(by: "wifi-button"), .controlCenter)
        XCTAssertEqual(SpringBoardLayer.marked(by: "com.apple.ControlCenter.Bluetooth"), .controlCenter)
        XCTAssertEqual(SpringBoardLayer.marked(by: "ListCell"), .notificationCenter)
        XCTAssertNil(SpringBoardLayer.marked(by: "nav-back"))
        XCTAssertNil(SpringBoardLayer.marked(by: nil))
    }

    func testForegroundProbeAsksTheSheetFirstAndNamesPersonalAppsOnlyOnThePhone() {
        let order = device.foregroundProbeOrder
        XCTAssertEqual(order.first, SystemApp.authkit)
        XCTAssertTrue(order.contains("com.apple.Preferences"))
        XCTAssertEqual(Array(order.suffix(3)), [F.target, F.notes, SystemApp.host])
        XCTAssertFalse(AllowList(isSimulator: true, explore: F.target).foregroundProbeOrder.contains("com.apple.Preferences"))
    }

    // MARK: Leituras

    func testCaptureOnlyWithAnOperableAppInFront() throws {
        XCTAssertNoThrow(try device.checkCapture(screen(F.target)))
        XCTAssertNoThrow(try device.checkCapture(screen(F.notes)))
        XCTAssertNoThrow(try device.checkCapture(screen(SystemApp.host)))
        var inTake = device
        inTake.inTake = true
        forbidden { () throws(RpcErrorObject) in try inTake.checkCapture(screen(SystemApp.host)) }
        forbidden { () throws(RpcErrorObject) in try device.checkCapture(screen(SystemApp.springboard)) }
        forbidden { () throws(RpcErrorObject) in try device.checkCapture(screen(F.target, locked: true)) }
        forbidden { () throws(RpcErrorObject) in try device.checkCapture(screen(SystemApp.authkit)) }
        forbidden { () throws(RpcErrorObject) in try device.checkCapture(screen("com.apple.MobileSMS")) }
        for layered in [Screens.controlCenter(over: F.target), Screens.notificationCenter(over: F.target),
                        Screens.appSwitcher(over: F.target), Screens.banner(over: F.target), Screens.unknownApp,
                        Screens.notReachable(F.target), Screens.lockUnknown(), Screens.unidentified(over: F.target),
                        Screens.controlCenterOverHome, Screens.springBoardLayerOverHome] {
            forbidden { () throws(RpcErrorObject) in try device.checkCapture(layered) }
        }
    }

    func testTreeNeverOfSpringBoardOrTheSheetAndOnlyWithAnOperableAppInFront() throws {
        XCTAssertEqual(try device.treeScope(nil, screen: screen(F.target)), .app(F.target))
        XCTAssertEqual(try device.treeScope(F.notes, screen: screen(F.notes)), .app(F.notes))
        forbidden { () throws(RpcErrorObject) in _ = try device.treeScope(F.notes, screen: screen(F.target)) }
        forbidden { () throws(RpcErrorObject) in _ = try device.treeScope(nil, screen: Screens.controlCenter(over: F.target)) }
        forbidden { () throws(RpcErrorObject) in _ = try device.treeScope("target", screen: Screens.unknownApp) }
        forbidden { () throws(RpcErrorObject) in _ = try device.treeScope("springboard", screen: screen(F.target)) }
        forbidden { () throws(RpcErrorObject) in _ = try device.treeScope(nil, screen: screen(SystemApp.springboard)) }
        forbidden { () throws(RpcErrorObject) in _ = try device.treeScope(nil, screen: screen(SystemApp.authkit)) }
        forbidden { () throws(RpcErrorObject) in _ = try device.treeScope("target", screen: screen(SystemApp.authkit)) }
        forbidden { () throws(RpcErrorObject) in _ = try device.treeScope("target", screen: screen(F.target, locked: true)) }
    }

    func testAC124_treeWithSettingsInFrontAndExploreSettingsIsForbiddenOnThePhoneOnly() throws {
        let phone = AllowList(isSimulator: false, explore: "com.apple.Preferences")
        forbidden { () throws(RpcErrorObject) in _ = try phone.treeScope(nil, screen: screen("com.apple.Preferences")) }
        forbidden { () throws(RpcErrorObject) in _ = try phone.treeScope("target", screen: screen("com.apple.Preferences")) }
        let simulator = AllowList(isSimulator: true, explore: "com.apple.Preferences")
        XCTAssertEqual(try simulator.treeScope(nil, screen: screen("com.apple.Preferences")), .app("com.apple.Preferences"))
    }

    /// Lê-se um app só quando ele é o que está à frente (provado); o SpringBoard só na tela de início limpa, na
    /// Central de Controle (sobre a tela de início ou um app operável) e na tela travada provada; a folha só com
    /// ela à frente e destravado; camadas e bloqueio não lido: nada.
    func testElementReadsOnlyOfWhatIsProvenInFront() throws {
        XCTAssertNoThrow(try device.checkElementRead(.app(F.target), screen: screen(F.target)))
        for front in [screen(F.notes), screen(SystemApp.authkit), screen(SystemApp.springboard), Screens.unknownApp,
                      Screens.controlCenter(over: F.target), Screens.notReachable(F.target), Screens.locked,
                      screen("com.apple.Preferences"), Screens.banner(over: F.target), Screens.lockUnknown()] {
            forbidden { () throws(RpcErrorObject) in try device.checkElementRead(.app(F.target), screen: front) }
        }
        for front in [screen(SystemApp.springboard), Screens.locked, Screens.controlCenter(over: F.target),
                      Screens.controlCenterOverHome] {
            XCTAssertNoThrow(try device.checkElementRead(.springboard, screen: front), "\(front)")
        }
        for front in [screen(F.target), Screens.unknownApp, screen(SystemApp.authkit), screen("com.example.other"),
                      Screens.notificationCenter(over: F.target), Screens.appSwitcher(over: F.target), Screens.springBoardLayerOverHome,
                      Screens.banner(over: F.target), Screens.lockUnknown(over: SystemApp.springboard), Screens.lockUnknown(),
                      Screens.controlCenterOverUnknown, Screens.unidentified(over: F.target)] {
            forbidden { () throws(RpcErrorObject) in try device.checkElementRead(.springboard, screen: front) }
        }
        XCTAssertNoThrow(try device.checkElementRead(.authkit, screen: screen(SystemApp.authkit)))
        for front in [Screens.locked, screen(SystemApp.springboard), screen("com.apple.Preferences"), screen(F.target),
                      Screens.unknownApp, Screens.notReachable(SystemApp.authkit), Screens.lockUnknown(over: SystemApp.authkit),
                      Screens.banner(over: SystemApp.authkit)] {
            forbidden { () throws(RpcErrorObject) in try device.checkElementRead(.authkit, screen: front) }
        }
    }

    // MARK: O que a leitura alcança no SpringBoard e na folha

    func reachable(_ raw: RawNode, _ app: AppScope, front: Front = .homeScreen, iconLabel: String? = "Example Target") -> [String] {
        let tree = IndexedTree(TreeRegistry().record(app: app.bundleId, raw: raw, screen: F.screen).root)
        guard let mask = ReadScope.reachable(tree, app: app, front: front, iconLabel: iconLabel, screen: F.screen) else {
            return tree.nodes.map { $0.label ?? $0.identifier ?? $0.type.rawValue }
        }
        return tree.nodes.indices.filter { mask[$0] }.map { tree.nodes[$0].label ?? tree.nodes[$0].identifier ?? "?" }
    }

    func testHomeScreenReadsReachOnlyTheIconsOfTheTargetIconPage() {
        XCTAssertEqual(reachable(F.home, .springboard), ["Example Target", "Photos", "Settings", "Phone"],
                       "sem a página 1 (Notes), o widget, o texto dele e a busca")
        XCTAssertEqual(reachable(F.home, .springboard, iconLabel: nil), [], "sem app.iconLabel (sem coreografia), nenhum ícone")
    }

    /// Revisões 2 e 5: com a Central aberta só os controles dela; nunca ícones nem widgets atrás.
    func testAC115_controlCenterReadsReachOnlyItsControls() {
        XCTAssertEqual(reachable(F.controlCenter, .springboard, front: .controlCenter), ["Airplane Mode", "Wi-Fi"],
                       "sem o ícone do app alvo atrás, o widget, o controle Focus e o texto do Now Playing")
        XCTAssertEqual(reachable(F.home, .springboard, front: .controlCenter), [], "nenhum ícone com a Central aberta")
        XCTAssertFalse(reachable(F.home, .springboard).contains("Search"), "botão da tela de início não é da Central")
    }

    /// Revisão 4: na tela travada, só os controles de mídia; nunca notificação (nem botão dentro dela).
    func testAC121_lockScreenReadsReachOnlyTheMediaControls() {
        XCTAssertEqual(reachable(F.lockScreen, .springboard, front: .lockScreen),
                       ["Track position", "Previous track", "Pause", "Next track"],
                       "nada de notificação (nem o botão Copy Code dentro dela), hora ou título")
    }

    func testLayersAndUnknownReachNothingOnSpringBoard() {
        for front in [Front.layer, .outside(""), .operable(F.target), .authkit] {
            XCTAssertEqual(reachable(F.controlCenter, .springboard, front: front), [], "\(front)")
            XCTAssertEqual(reachable(F.home, .springboard, front: front), [], "\(front)")
            XCTAssertEqual(reachable(F.lockScreen, .springboard, front: front), [], "\(front)")
        }
    }

    func testSheetReadsReachOnlyButtons() {
        XCTAssertEqual(reachable(F.authSheet, .authkit, front: .authkit), ["Share My Email", "Continue"])
        XCTAssertNil(ReadScope.reachable(IndexedTree(TreeRegistry().record(app: F.target, raw: F.reader, screen: F.screen).root),
                                         app: .app(F.target), front: .operable(F.target), iconLabel: nil, screen: F.screen),
                     "app operável: tudo")
    }

    // MARK: Ações

    func testAC117_springBoardActionsOnlyOnTheTargetIconAndTheAirplaneSwitch() throws {
        let loaded = try device.loading(.init(bundleId: F.target, iconLabel: "Example Target"))
        let home = screen(SystemApp.springboard)
        let icon = node(.icon, "Example Target")
        let airplane = node(.switch, "Airplane Mode", id: "airplane-mode-button")
        // Tela de início limpa: só o ícone do app alvo, com o rótulo exato.
        XCTAssertNoThrow(try loaded.checkElementActionAtCenter(.tap, app: .springboard, node: icon, screen: home))
        for other in [node(.icon, "Settings"), node(.icon, "example target"), node(.icon, "Example Target "), airplane,
                      node(.button, "Wi-Fi", id: "wifi-button")] {
            forbidden { () throws(RpcErrorObject) in try loaded.checkElementActionAtCenter(.tap, app: .springboard, node: other, screen: home) }
        }
        // Central de Controle (sobre a tela de início ou o app alvo): só o modo avião; o toque no ícone cairia na Central.
        for center in [Screens.controlCenterOverHome, Screens.controlCenter(over: F.target)] {
            XCTAssertNoThrow(try loaded.checkElementActionAtCenter(.tap, app: .springboard, node: airplane, screen: center))
            for other in [icon, node(.button, "Wi-Fi", id: "wifi-button")] {
                forbidden { () throws(RpcErrorObject) in try loaded.checkElementActionAtCenter(.tap, app: .springboard, node: other, screen: center) }
            }
        }
        // Camadas, desconhecido, app à frente, bloqueio não lido: nada.
        for front in [Screens.unknownApp, screen(F.target), Screens.appSwitcher(over: F.target), Screens.springBoardLayerOverHome,
                      Screens.notificationCenter(over: F.target), Screens.banner(over: F.target), Screens.controlCenterOverUnknown,
                      Screens.lockUnknown(over: SystemApp.springboard)] {
            forbidden { () throws(RpcErrorObject) in try loaded.checkElementActionAtCenter(.tap, app: .springboard, node: icon, screen: front) }
            forbidden { () throws(RpcErrorObject) in try loaded.checkElementActionAtCenter(.tap, app: .springboard, node: airplane, screen: front) }
        }
        forbidden { () throws(RpcErrorObject) in
            try loaded.checkElementActionAtCenter(.longPress, app: .springboard, node: icon, screen: home)
        }
        forbidden { () throws(RpcErrorObject) in
            try loaded.checkElementActionAtCenter(.tap, app: .springboard, node: nil, screen: home)
        }
        // Na tela travada, nenhum toque em elemento (nem nos controles de mídia).
        forbidden { () throws(RpcErrorObject) in
            try loaded.checkElementActionAtCenter(.tap, app: .springboard, node: node(.button, "Pause"), screen: Screens.locked)
        }
        // Sem coreografia não há app.iconLabel: nenhum ícone é tocável.
        forbidden { () throws(RpcErrorObject) in
            try device.checkElementActionAtCenter(.tap, app: .springboard, node: icon, screen: home)
        }
    }

    /// 3.ª revisão, achado 2: no SpringBoard e na folha, o ponto final da ação (centro + `offset`) tem de cair dentro
    /// do frame do nó permitido; no app operável, não (o app inteiro é permitido).
    func testFinalPointMustStayInsideThePermittedNodeOnSpringBoardAndTheSheet() throws {
        let loaded = try device.loading(.init(bundleId: F.target, iconLabel: "Example Target"))
        let icon = node(.icon, "Example Target", frame: Rect(x: 27, y: 80, w: 64, h: 76))
        let home = screen(SystemApp.springboard)
        XCTAssertNoThrow(try loaded.checkElementActionOn(.tap, app: .springboard, node: icon, point: AbsolutePoint(x: 59, y: 118), screen: home))
        XCTAssertNoThrow(try loaded.checkElementActionOn(.tap, app: .springboard, node: icon, point: AbsolutePoint(x: 30, y: 150), screen: home))
        for outside in [AbsolutePoint(x: 239, y: 118), AbsolutePoint(x: 91, y: 118), AbsolutePoint(x: 59, y: 156), AbsolutePoint(x: 26.9, y: 80)] {
            forbidden { () throws(RpcErrorObject) in
                try loaded.checkElementActionOn(.tap, app: .springboard, node: icon, point: outside, screen: home)
            }
        }
        forbidden { () throws(RpcErrorObject) in try loaded.checkElementActionOn(.tap, app: .springboard, node: icon, point: nil, screen: home) }

        let airplane = node(.switch, "Airplane Mode", id: "airplane-mode-button", frame: Rect(x: 30, y: 90, w: 60, h: 60))
        let center = Screens.controlCenter(over: F.target)
        XCTAssertNoThrow(try loaded.checkElementActionOn(.tap, app: .springboard, node: airplane, point: AbsolutePoint(x: 60, y: 120), screen: center))
        forbidden { () throws(RpcErrorObject) in
            try loaded.checkElementActionOn(.tap, app: .springboard, node: airplane, point: AbsolutePoint(x: 130, y: 120), screen: center)
        }

        let button = node(.button, "Continue", frame: Rect(x: 20, y: 700, w: 350, h: 50))
        let sheet = screen(SystemApp.authkit)
        XCTAssertNoThrow(try loaded.checkElementActionOn(.tap, app: .authkit, node: button, point: AbsolutePoint(x: 195, y: 725), screen: sheet))
        forbidden { () throws(RpcErrorObject) in
            try loaded.checkElementActionOn(.tap, app: .authkit, node: button, point: AbsolutePoint(x: 195, y: 680), screen: sheet)
        }

        // No app operável o deslocamento é livre (o app está à frente, provado).
        XCTAssertNoThrow(try loaded.checkElementActionOn(.tap, app: .app(F.target), node: node(.button, "Play"),
                                                       point: AbsolutePoint(x: 300, y: 600), screen: screen(F.target)))
    }

    /// 3.ª revisão, achado 1: rótulos de mídia reconhecidos (inglês, sem caixa); o resto não.
    func testMediaControlLabelsArePositivelyRecognized() {
        for label in ["Play", "pause", "Previous Track", "Next track", "Rewind", "Fast Forward", "Skip Back 15 Seconds",
                      "skip forward 30 seconds", "Rewind 15 seconds", "Fast Forward 30 Seconds", "Track position", "AirPlay"] {
            XCTAssertTrue(ReadScope.isMediaControlLabel(label), label)
        }
        for label in ["Maria: 482913 is your code", "Calendar, Dentist with Dr. Silva 3 PM", "Play 482913", "Skip Back",
                      "Skip Back x seconds", "Pause, Messages", "", "Flashlight", "Camera"] {
            XCTAssertFalse(ReadScope.isMediaControlLabel(label), label)
        }
        XCTAssertFalse(ReadScope.isMediaControlLabel(nil))
    }

    /// Revisão 7: no aparelho, `iconLabel` com o nome de um app pessoal é recusado; o toque exige o rótulo exato.
    func testIconLabelOfAPersonalAppIsRefusedOnThePhone() throws {
        for label in ["Messages", " messages ", "MESSAGES", "Mensagens", "Settings", "Ajustes", "Phone", "Telefone", "Mail",
                      "Wallet", "Carteira", "App Store", "App  Store", "iTunes Store", "FaceTime", "Facetime", "Passbook"] {
            forbidden { () throws(RpcErrorObject) in
                _ = try device.loading(.init(bundleId: "com.example.reader", iconLabel: label))
            }
            XCTAssertNoThrow(try AllowList(isSimulator: true).loading(.init(bundleId: "com.example.reader", iconLabel: label)),
                             "\(label) no simulador")
        }
        XCTAssertEqual(try device.loading(.init(bundleId: "com.example.reader", iconLabel: "Example Reader")).iconLabel, "Example Reader")
    }

    func testSheetActionsOnlyTapButtonsAndTypingThereIsASecureFieldRefusal() throws {
        let sheet = screen(SystemApp.authkit)
        XCTAssertNoThrow(try device.checkElementActionAtCenter(.tap, app: .authkit, node: node(.button, "Continue"), screen: sheet))
        // Achado 3: o AuthKitUIService vivo não basta; a folha tem de ser o que está à frente, destravado.
        for front in [Screens.locked, screen("com.apple.Preferences"), screen(SystemApp.springboard), screen(F.target),
                      Screens.unknownApp] {
            forbidden { () throws(RpcErrorObject) in
                try device.checkElementActionAtCenter(.tap, app: .authkit, node: node(.button, "Continue"), screen: front)
            }
        }
        forbidden { () throws(RpcErrorObject) in
            try device.checkElementActionAtCenter(.tap, app: .authkit, node: node(.staticText, "Someone"), screen: sheet)
        }
        forbidden { () throws(RpcErrorObject) in
            try device.checkElementActionAtCenter(.drag, app: .authkit, node: node(.button, "Continue"), screen: sheet)
        }
        assertRunnerError(.secureField) { () throws(RpcErrorObject) in
            try device.checkElementActionAtCenter(.type, app: .authkit, node: node(.secureTextField), screen: sheet)
        }
        assertRunnerError(.secureField) { () throws(RpcErrorObject) in
            try device.checkElementActionAtCenter(.type, app: .app(F.target), node: node(.textField), screen: screen(SystemApp.springboard))
        }
    }

    func testAppActionsNeedAnOperableAppInFront() throws {
        XCTAssertNoThrow(try device.checkElementActionAtCenter(.tap, app: .app(F.target), node: node(.button, "Play"), screen: screen(F.target)))
        XCTAssertNoThrow(try device.checkElementActionAtCenter(.type, app: .app(F.target), node: node(.textField), screen: screen(F.target)))
        for front in [screen(SystemApp.springboard), screen(F.target, locked: true), screen(SystemApp.authkit),
                      screen("com.apple.Preferences"), screen(F.notes), Screens.unknownApp, Screens.notReachable(F.target),
                      Screens.controlCenter(over: F.target), Screens.appSwitcher(over: F.target)] {
            forbidden { () throws(RpcErrorObject) in
                try device.checkElementActionAtCenter(.tap, app: .app(F.target), node: node(.button, "Play"), screen: front)
            }
        }
    }

    func testAC123_unlockDragOnlyAfterUnlockInsideARunnerCheckpoint() throws {
        forbidden { () throws(RpcErrorObject) in
            try device.checkUnlockDrag(screen: screen(SystemApp.springboard, locked: true), inRunnerCheckpoint: true)
        }
        forbidden { () throws(RpcErrorObject) in
            try device.checkUnlockDrag(screen: Screens.lockUnknown(over: SystemApp.springboard), inRunnerCheckpoint: true)
        }
        XCTAssertNoThrow(try device.checkUnlockDrag(screen: screen(SystemApp.springboard), inRunnerCheckpoint: true))
        forbidden { () throws(RpcErrorObject) in
            try device.checkUnlockDrag(screen: screen(SystemApp.springboard), inRunnerCheckpoint: false)
        }
        XCTAssertNoThrow(try device.checkUnlockDrag(screen: screen(SystemApp.springboard), inRunnerCheckpoint: false, spike: true))
        forbidden { () throws(RpcErrorObject) in
            try device.checkUnlockDrag(screen: screen(SystemApp.springboard, locked: true), inRunnerCheckpoint: false, spike: true)
        }
    }

    func testAC117_appControlAndLinks() throws {
        forbidden { () throws(RpcErrorObject) in try device.checkAppControl("com.apple.Preferences") }
        forbidden { () throws(RpcErrorObject) in try device.checkAppControl("com.apple.springboard") }
        forbidden { () throws(RpcErrorObject) in try device.checkAppControl("com.example.unknown") }
        XCTAssertNoThrow(try device.checkAppControl(F.target))
        XCTAssertNoThrow(try device.checkAppControl(F.notes))

        let loaded = try AllowList(isSimulator: false, explore: F.target, urlPrefixes: ["https://example.com"])
            .loading(.init(bundleId: F.target, urlPrefixes: ["example://", "tel:"]))
        XCTAssertNoThrow(try loaded.checkOpenURL("example://chapter/23"))
        XCTAssertNoThrow(try loaded.checkOpenURL("https://example.com/"))
        forbidden { () throws(RpcErrorObject) in try loaded.checkOpenURL("tel:123") }
        forbidden { () throws(RpcErrorObject) in try loaded.checkOpenURL("TEL:123") }
        forbidden { () throws(RpcErrorObject) in try loaded.checkOpenURL("https://apps.apple.com/app/id1") }
        forbidden { () throws(RpcErrorObject) in try loaded.checkOpenURL("other://x") }
        XCTAssertNoThrow(try AllowList(isSimulator: true, urlPrefixes: ["tel:"]).checkOpenURL("tel:123"), "simulador")
    }

    // MARK: Links (achado 4): decididos pelo URL analisado, não pelo texto

    func testPersonalSchemesAreRefusedOnThePhoneEvenWhenAPrefixAsks() throws {
        let cases = ["app-settings:", "APP-SETTINGS:root", "prefs:root=General", "App-prefs:root=WIFI", "tel:123", "TEL:123",
                     "telprompt:123", "sms:123", "facetime:someone", "facetime-audio:someone", "facetime-prompt:x",
                     "mailto:a@example.com", "message://x", "shoebox://", "wallet://", "itms://x", "itmss://x",
                     "itms-apps://x", "itms-appss://x", "itms-services://x"]
        for url in cases {
            let scheme = String(url.prefix { $0 != ":" }) + ":"
            let asking = AllowList(isSimulator: false, urlPrefixes: [scheme, url])
            XCTAssertTrue(asking.urlPrefixes.isEmpty, "\(url): o prefixo pessoal fica fora da lista")
            forbidden { () throws(RpcErrorObject) in try asking.checkOpenURL(url) }
            let loaded = try AllowList(isSimulator: false, explore: F.target).loading(.init(bundleId: F.target, urlPrefixes: [scheme]))
            forbidden { () throws(RpcErrorObject) in try loaded.checkOpenURL(url) }
            XCTAssertNoThrow(try AllowList(isSimulator: true, urlPrefixes: [scheme]).checkOpenURL(url), "\(url) no simulador")
        }
    }

    func testStoreHostsUserinfoAndTrailingDotsCannotSlipThroughAPrefix() {
        let list = AllowList(isSimulator: false, urlPrefixes: ["https://", "https://example.com"])
        XCTAssertEqual(list.urlPrefixes, ["https://example.com"], "achado 2 da 4.ª revisão: \"https://\" sem host não é permissão")
        for url in ["https://x@apps.apple.com/app/id1", "https://example.com@itunes.apple.com/app/id1",
                    "https://apps.apple.com./app/id1", "https://APPS.Apple.COM/app/id1", "https://geo.itunes.apple.com/x",
                    "https://apps.apple.com.:443/app/id1", "https://user:pw@example.com/"] {
            forbidden { () throws(RpcErrorObject) in try list.checkOpenURL(url) }
        }
        // A regra da loja vem antes do casamento de prefixo (e não depende dele).
        for url in ["https://apps.apple.com./app/id1", "https://geo.itunes.apple.com/x"] {
            let error = assertRunnerError(.forbiddenApp) { () throws(RpcErrorObject) in try list.checkOpenURL(url) }
            XCTAssertTrue(error?.message.contains("loja") ?? false, error?.message ?? "")
        }
        XCTAssertNoThrow(try list.checkOpenURL("https://example.com/page"))
        // Userinfo é recusado também no simulador (só serve para enganar o casamento do prefixo).
        forbidden { () throws(RpcErrorObject) in
            try AllowList(isSimulator: true, urlPrefixes: ["https://example.com"]).checkOpenURL("https://example.com@evil.example/")
        }
        // Prefixo com userinfo, consulta ou fragmento, ou que não se analisa, nem entra.
        let odd = AllowList(isSimulator: false, urlPrefixes: ["https://me@example.com/", "https://example.com/?a=1",
                                                              "https://example.com/#x", "exa mple://", "//example.com/"])
        XCTAssertTrue(odd.urlPrefixes.isEmpty, odd.urlPrefixes.joined(separator: " "))
        XCTAssertEqual(odd.refused.count, 5)
    }

    /// Revisão 5: http(s) sem host (o Safari normaliza `https:apps.apple.com` e abre a loja) e host de loja no
    /// caminho quando o host não existe.
    func testHostlessWebLinksAndStoreHostsInThePathAreRefusedOnThePhone() {
        let list = AllowList(isSimulator: false, urlPrefixes: ["https://example.com", "http://example.com", "example:"])
        for url in ["https:apps.apple.com/app/id1", "HTTPS:itunes.apple.com/app/id1", "https:///apps.apple.com/app/id1",
                    "http:example.com/x", "https:/example.com/x", "example:apps.apple.com/app/id1", "example:///itunes.apple.com./x"] {
            forbidden { () throws(RpcErrorObject) in try list.checkOpenURL(url) }
        }
        XCTAssertNoThrow(try list.checkOpenURL("https://example.com/x"))
        XCTAssertNoThrow(try list.checkOpenURL("example:chapter/23"))
        XCTAssertNoThrow(try AllowList(isSimulator: true, urlPrefixes: ["https://"]).checkOpenURL("https:apps.apple.com/app/id1"),
                         "o simulador aceita (AC-3.7)")
    }

    /// 4.ª revisão, achado 2: host fora do ASCII imprimível (o WebKit aplica UTS-46: `。`, `．`, `｡`, letras de
    /// largura total, hífen suave), o redirecionador `apple.co`, e prefixo http(s) sem host no aparelho.
    func testNonAsciiHostsAppleCoAndHostlessWebPrefixesOnThePhone() {
        let list = AllowList(isSimulator: false, urlPrefixes: ["https://example.com"])
        // A regra que recusa vem antes do casamento de prefixo: a mensagem diz qual foi.
        for (urls, rule) in [(["https://apps%E3%80%82apple.com/app/id1", "https://apps%EF%BC%8Eapple.com/app/id1",
                               "https://apps%EF%BD%A1apple.com/app/id1", "https://%EF%BD%81pps.apple.com/app/id1",
                               "https://apps.ap%C2%ADple.com/app/id1", "https://itunes%E3%80%82apple.com/x",
                               "https://apps.apple.com%E3%80%82/x", "https://example.com%E3%80%82/x"], "ASCII"),
                             (["https://apple.co/abc", "https://APPLE.CO./abc", "https://x.apple.co/abc"], "loja")] {
            for url in urls {
                let error = assertRunnerError(.forbiddenApp) { () throws(RpcErrorObject) in try list.checkOpenURL(url) }
                XCTAssertTrue(error?.message.contains(rule) ?? false, "\(url): \(error?.message ?? "")")
            }
        }
        XCTAssertNoThrow(try list.checkOpenURL("https://example.com/ok"))
        // Nem um prefixo que os nomeie entra (senão o casamento os liberaria).
        let naming = AllowList(isSimulator: false, urlPrefixes: ["https://apps%E3%80%82apple.com", "https://%EF%BD%81pps.apple.com",
                                                                 "https://apple.co"])
        XCTAssertTrue(naming.urlPrefixes.isEmpty, naming.urlPrefixes.joined(separator: " "))
        forbidden { () throws(RpcErrorObject) in try naming.checkOpenURL("https://apps%E3%80%82apple.com/app/id1") }
        forbidden { () throws(RpcErrorObject) in try naming.checkOpenURL("https://apple.co/abc") }

        let hostless = AllowList(isSimulator: false, urlPrefixes: ["https://", "HTTP://", "https:///", "https:", "example://"])
        XCTAssertEqual(hostless.urlPrefixes, ["example://"])
        XCTAssertEqual(Set(hostless.refused.map(\.item)), ["https://", "HTTP://", "https:///", "https:"])
        forbidden { () throws(RpcErrorObject) in try hostless.checkOpenURL("https://example.com/") }

        let simulator = AllowList(isSimulator: true, urlPrefixes: ["https://"])
        XCTAssertEqual(simulator.urlPrefixes, ["https://"], "o simulador aceita (AC-3.7)")
        XCTAssertNoThrow(try simulator.checkOpenURL("https://apple.co/abc"))
    }

    /// 4.ª revisão, achado 1: todo ponto de ação dentro da tela; nó sem frame não é alvo; o começo de arrasto,
    /// rolagem e toque longo fora das faixas de gesto do sistema (barra de estado, indicador de início).
    func testActionPointsStayOnScreenAndGestureStartsAvoidSystemBands() throws {
        let display = F.screen
        XCTAssertEqual(GestureBands.forScreen(display), GestureBands(top: 47, bottom: 34))
        XCTAssertEqual(GestureBands.forScreen(Size(w: 375, h: 667)), GestureBands(top: 20, bottom: 20))
        let front = screen(F.target)
        let play = node(.button, "Play", frame: Rect(x: 16, y: 100, w: 44, h: 44))
        func act(_ action: ElementAction, _ x: Double, _ y: Double, node: TreeNode? = nil) throws(RpcErrorObject) {
            try device.checkElementAction(action, app: .app(F.target), node: node, point: AbsolutePoint(x: x, y: y),
                                          display: display, screen: front)
        }
        XCTAssertNoThrow(try act(.tap, 20, 1), "toque simples na barra de estado não abre camada")
        XCTAssertNoThrow(try act(.tap, 38, 122, node: play))
        XCTAssertNoThrow(try act(.drag, 20, 47))
        XCTAssertNoThrow(try act(.drag, 20, 809.9))
        for (action, x, y) in [(ElementAction.drag, 20.0, 1.0), (.drag, 20, 46.9), (.scrollTo, 195, 10), (.longPress, 195, 820),
                               (.drag, 195, 810), (.tap, -500, 5000), (.tap, 390, 100), (.tap, 100, 844), (.doubleTap, -1, 400)] {
            forbidden { () throws(RpcErrorObject) in try act(action, x, y) }
        }
        let empty = node(.button, "Ghost", frame: Rect(x: 0, y: 0, w: 0, h: 0))
        forbidden { () throws(RpcErrorObject) in try act(.tap, 0, 0, node: empty) }
        forbidden { () throws(RpcErrorObject) in
            try device.checkElementAction(.tap, app: .app(F.target), node: play, point: nil, display: display, screen: front)
        }
        XCTAssertNoThrow(try device.checkElementAction(.type, app: .app(F.target), node: nil, point: nil, display: display, screen: front),
                         "digitar no campo com foco não tem ponto")
        // Para a T-0.7: `to` e o caminho do arrasto — só dentro da tela; o começo, também fora das faixas.
        XCTAssertNoThrow(try AllowList.checkActionPoint(AbsolutePoint(x: 20, y: 600), gestureStart: false, display: display))
        XCTAssertNoThrow(try AllowList.checkActionPoint(AbsolutePoint(x: 20, y: 2), gestureStart: false, display: display))
        forbidden { () throws(RpcErrorObject) in try AllowList.checkActionPoint(AbsolutePoint(x: 20, y: 2), gestureStart: true, display: display) }
        forbidden { () throws(RpcErrorObject) in try AllowList.checkActionPoint(AbsolutePoint(x: 20, y: 900), gestureStart: false, display: display) }
    }

    /// 4.ª revisão, achado 3: controles de mídia só em grupo (≥ 2 rótulos de mídia distintos sob o mesmo pai).
    func testLockScreenMediaControlsCountOnlyAsAGroup() {
        let lonely = F.node(.application, "SpringBoard", 0, 0, 390, 844, [
            F.node(.other, id: "live-activity", 20, 600, 350, 80, [F.node(.staticText, "Workout", 30, 610, 200, 20),
                                                                   F.node(.button, "Pause", 300, 620, 44, 44)]),
            F.node(.other, 20, 700, 350, 80, [F.node(.button, "Pause", 40, 710, 44, 44), F.node(.button, "Pause", 100, 710, 44, 44)]),
        ])
        XCTAssertEqual(reachable(lonely, .springboard, front: .lockScreen), [], "Pause sozinho, ou dois Pause, não é Now Playing")
        XCTAssertEqual(reachable(F.lockScreen, .springboard, front: .lockScreen),
                       ["Track position", "Previous track", "Pause", "Next track"])
    }

    /// 4.ª revisão, achado 4: na folha, só `label` exato de uma lista fechada (e `type: button`); o resto recusado.
    func testSheetSelectorsAreOnlyExactKnownLabels() throws {
        for json in [["app": "authkit", "label": "Continue"], ["app": "authkit", "label": "Continue", "type": "button"],
                     ["app": "authkit", "label": "Share My Email", "index": 0]] as [JSONValue] {
            XCTAssertNoThrow(try device.checkSelector(Target.decode(json), app: .authkit), "\(json)")
        }
        for json in [["app": "authkit", "labelPrefix": "Continue"], ["app": "authkit", "labelContains": "@"],
                     ["app": "authkit", "identifier": "x"], ["app": "authkit", "type": "button"],
                     ["app": "authkit", "label": "Continue as someone@example.com"], ["app": "authkit", "label": "continue"],
                     ["app": "authkit", "label": "Continue", "type": "staticText"], ["app": "authkit", "ocr": ["text": "Continue"]],
                     ["app": "authkit", "point": ["x": 10, "y": 10]], ["app": "authkit", "ref": "@e3"],
                     ["app": "authkit", "label": "Continue", "within": ["app": "authkit", "label": "OK"]],
                     ["app": "authkit", "label": "Continue", "below": ["app": "authkit", "label": "OK"]]] as [JSONValue] {
            let target = try Target.decode(json)
            forbidden { () throws(RpcErrorObject) in try device.checkSelector(target, app: .authkit) }
        }
        XCTAssertNoThrow(try device.checkSelector(Target.decode(["labelContains": "Psalm"]), app: .app(F.target)), "fora da folha, livre")
        XCTAssertEqual(reachable(F.authSheet, .authkit, front: .authkit), ["Share My Email", "Continue"],
                       "só botões com rótulo conhecido (sem o do e-mail nem o Continue with Password)")
    }

    /// 3.ª revisão, achado 4: o caminho é normalizado (`.`/`..`, inclusive percent-codificados) antes de casar.
    func testPathTraversalCannotLeaveAPrefix() {
        let list = AllowList(isSimulator: false, urlPrefixes: ["https://docs.example.com/guide/", "https://files.example.com/docs"])
        for url in ["https://docs.example.com/guide/../account/delete", "https://docs.example.com/guide/%2e%2e/account",
                    "https://docs.example.com/guide/%2E%2e/account", "https://docs.example.com/guide/%2E%2e/", "https://docs.example.com/guide/.%2e/account",
                    "https://docs.example.com/guide/a/../../account", "https://docs.example.com/guide/..%2faccount",
                    "https://docs.example.com/guide/x%2F..%2F..%2Faccount", "https://docs.example.com/guide/x%5c..%5caccount",
                    "https://docs.example.com/guide/..", "https://files.example.com/docs/../x", "https://files.example.com/docs/%2e%2e"] {
            forbidden { () throws(RpcErrorObject) in try list.checkOpenURL(url) }
        }
        for url in ["https://docs.example.com/guide/./intro", "https://docs.example.com/guide/a/../intro",
                    "https://docs.example.com/guide/%2e/intro", "https://files.example.com/docs/a/..", "https://files.example.com/docs/./a"] {
            XCTAssertNoThrow(try list.checkOpenURL(url), url)
        }
        XCTAssertEqual(LinkRule.normalizedPath("/guide/a/../%2E/b/%2e%2E/c"), "/guide/c")
        XCTAssertEqual(LinkRule.normalizedPath("/../../x"), "/x")
        XCTAssertEqual(LinkRule.normalizedPath("/guide/a/.."), "/guide/")
    }

    func testPrefixesMatchByNormalizedComponents() throws {
        let list = AllowList(isSimulator: false, urlPrefixes: ["https://example.com", "https://docs.example.com/guide/", "example://",
                                                               "https://files.example.com/docs"])
        for url in ["https://example.com", "https://example.com/", "https://EXAMPLE.com./x", "HTTPS://example.com/a?b=1#c",
                    "https://docs.example.com/guide/", "https://docs.example.com/guide/intro", "example://chapter/23",
                    "EXAMPLE://chapter", "https://files.example.com/docs", "https://files.example.com/docs/a"] {
            XCTAssertNoThrow(try list.checkOpenURL(url), url)
        }
        for url in ["https://example.com.evil.net/", "https://evil.net/https://example.com", "https://example.com:8443/",
                    "http://example.com/", "https://docs.example.com/guidebook", "https://docs.example.com/", "examplex://chapter",
                    "https://files.example.com/docs2", "https://exa mple.com/", "//example.com/", "example", ""] {
            forbidden { () throws(RpcErrorObject) in try list.checkOpenURL(url) }
        }
    }
}

extension AllowList {
    /// A checagem de ação com o ponto final no centro do nó (sem `offset`), para os testes de regra.
    func checkElementActionAtCenter(_ action: ElementAction, app: AppScope, node: TreeNode?, screen: ScreenState) throws(RpcErrorObject) {
        try checkElementAction(action, app: app, node: node,
                               point: node.map { AbsolutePoint(x: $0.frame.midX, y: $0.frame.midY) },
                               display: TreeFixtures.screen, screen: screen)
    }

    /// A checagem de ação com o ponto dado, na tela de 390×844.
    func checkElementActionOn(_ action: ElementAction, app: AppScope, node: TreeNode?, point: AbsolutePoint?,
                              screen: ScreenState) throws(RpcErrorObject) {
        try checkElementAction(action, app: app, node: node, point: point, display: TreeFixtures.screen, screen: screen)
    }
}

/// Prova da "tela de início limpa" (S1 item 11; T-0.11): o ícone sondado é o **ícone de app** (≤ 100×120 pt) visível
/// inteiro na tela mais acima e mais à esquerda pelo frame do snapshot; na consulta `springboard.icons`, só geometria e
/// tipo: primeiro `matching(frame == <frame>)` (exatamente um elemento, no frame), depois o elemento na posição do
/// ícone em largura (a ordem da consulta), com o frame conferido. Nunca identificador, rótulo ou valor (a descrição da
/// consulta vai para o registro do XCTest). Sem isso → não provado (o runner trata como camada: FAIL-CLOSED).
final class HomeScreenProbeTests: XCTestCase {
    typealias Icon = HomeScreenProbe.Icon
    let screen = Size(w: 390, h: 844)

    func icon(_ index: Int, _ x: Double, _ y: Double, _ w: Double = 68, _ h: Double = 90, breadth: Int? = nil) -> Icon {
        Icon(index: index, breadthIndex: breadth ?? index, type: .icon, frame: Rect(x: x, y: y, w: w, h: h))
    }

    /// As duas páginas vistas no aparelho: (1) widgets de Clima e Calendário no topo, apps a partir de y = 261;
    /// (2) uma fileira de apps no topo. As duas com o Dock (ícones sem nome, 68×68) e um ícone da página seguinte
    /// entrando pela direita.
    var widgetsOnTop: [Icon] {
        [
            icon(0, 25, 750, 68, 68), icon(1, 22, 65, 166, 188), icon(2, 202, 65, 166, 188),  // Dock, widgets
            icon(3, 26, 261), icon(4, 116, 261), icon(5, 206, 261), icon(6, 297, 261),       // apps
            icon(7, 417, 261),                                                                // página seguinte
        ]
    }
    var appsOnTop: [Icon] {
        [
            icon(0, 25, 750, 68, 68), icon(1, 116, 750, 68, 68),                              // Dock
            icon(28, 25, 65, breadth: 21), icon(29, 116, 65), icon(38, 206, 65), icon(39, 297, 65),
            icon(40, 20, 470, 170, 170),                                                      // widget embaixo
            icon(41, 380, 175),                                                               // página seguinte
        ]
    }
    let appOnWidgetPage = Rect(x: 26, y: 261, w: 68, h: 90)
    let appOnAppsPage = Rect(x: 25, y: 65, w: 68, h: 90)

    /// As buscas que o runner faria na consulta, contadas. `byFrame` = quantos elementos `frame == f` acha (nil =
    /// predicado não aceito); `matchFrame` = o frame do elemento achado; `byBreadth` = frames por posição na consulta.
    final class FakeQuery {
        var byFrame: [(Rect, Int)]?
        var matchFrame: Rect?
        var byBreadth: [Int: Rect]
        var calls: [String] = []
        init(byFrame: [(Rect, Int)]? = [], matchFrame: Rect? = nil, byBreadth: [Int: Rect] = [:]) {
            self.byFrame = byFrame
            self.matchFrame = matchFrame
            self.byBreadth = byBreadth
        }
        func count(_ frame: Rect) -> Int? {
            calls.append("count")
            guard let byFrame else { return nil }
            return byFrame.first { $0.0 == frame }?.1 ?? 0
        }
        func frameOfMatch() -> Rect? {
            calls.append("matchFrame")
            return matchFrame
        }
        func frameAt(_ index: Int) -> Rect? {
            calls.append("breadth \(index)")
            return byBreadth[index]
        }
    }

    func probe(_ icons: [Icon], _ query: FakeQuery) -> HomeScreenProbe.Outcome {
        HomeScreenProbe.probe(icons, screen: screen, countWithFrame: query.count, frameOfFrameMatch: query.frameOfMatch,
                              frameAtBreadthIndex: query.frameAt)
    }

    func testTheIconCarriesOnlyGeometryAndType() {
        let labels = Mirror(reflecting: icon(0, 25, 65)).children.compactMap(\.label)
        XCTAssertEqual(Set(labels), ["index", "breadthIndex", "type", "frame"], "nada de identificador, rótulo ou valor")
    }

    func testOnlyAppSizedIconsCountAndTheTopLeftWins() {
        XCTAssertEqual(HomeScreenProbe.choose(widgetsOnTop, screen: screen)?.index, 3, "widgets no topo ficam de fora")
        XCTAssertEqual(HomeScreenProbe.choose(appsOnTop, screen: screen)?.index, 28)
        XCTAssertEqual(HomeScreenProbe.choose(appsOnTop.reversed(), screen: screen)?.index, 28)
        XCTAssertEqual(HomeScreenProbe.choose([icon(0, 25, 750, 68, 68), icon(1, 22, 65, 166, 188)], screen: screen)?.index, 0)
        XCTAssertNil(HomeScreenProbe.choose([icon(1, 22, 65, 166, 188), icon(2, 202, 65, 166, 188)], screen: screen))
    }

    func testAppIconSizeLimitIsAConstant() {
        XCTAssertEqual(HomeScreenProbe.maxAppIconSize, Size(w: 100, h: 120))
        XCTAssertEqual(HomeScreenProbe.choose([icon(0, 25, 65, 100, 120)], screen: screen)?.index, 0)
        XCTAssertNil(HomeScreenProbe.choose([icon(0, 25, 65, 101, 120)], screen: screen))
        XCTAssertNil(HomeScreenProbe.choose([icon(0, 25, 65, 100, 121)], screen: screen))
    }

    func testIconsPartlyOffScreenNeverCount() {
        XCTAssertNil(HomeScreenProbe.choose([icon(0, 380, 175), icon(1, 417, 65), icon(2, 25, -40)], screen: screen))
        XCTAssertNil(HomeScreenProbe.choose([], screen: screen))
    }

    func testResolvesByTheFramePredicateFirst() {
        let query = FakeQuery(byFrame: [(appOnAppsPage, 1)], matchFrame: appOnAppsPage)
        XCTAssertEqual(probe(appsOnTop, query), .resolved(icon: icon(28, 25, 65, breadth: 21), via: .framePredicate))
        XCTAssertEqual(query.calls, ["count", "matchFrame"])
    }

    func testFallsBackToTheBreadthIndexWhenTheFramePredicateDoesNotFindExactlyOne() {
        for byFrame in [nil, [], [(appOnAppsPage, 2)]] as [[(Rect, Int)]?] {
            let query = FakeQuery(byFrame: byFrame, byBreadth: [21: appOnAppsPage, 28: Rect(x: 116, y: 175, w: 68, h: 90)])
            XCTAssertEqual(probe(appsOnTop, query), .resolved(icon: icon(28, 25, 65, breadth: 21), via: .breadthIndex))
            XCTAssertEqual(query.calls.last, "breadth 21", "a posição em largura, não a da pré-ordem")
        }
        // o predicado acha um, mas noutro lugar: também cai para a posição em largura
        let elsewhere = FakeQuery(byFrame: [(appOnWidgetPage, 1)], matchFrame: Rect(x: 0, y: 0, w: 0, h: 0), byBreadth: [3: appOnWidgetPage])
        XCTAssertEqual(probe(widgetsOnTop, elsewhere), .resolved(icon: icon(3, 26, 261), via: .breadthIndex))
    }

    func testWithoutEitherPathItIsNotProvenAndNoSnapshotDoubtIsQueried() {
        XCTAssertEqual(probe(widgetsOnTop, FakeQuery(byBreadth: [3: Rect(x: 116, y: 261, w: 68, h: 90)])), .notProven(.notFound))
        XCTAssertEqual(probe(widgetsOnTop, FakeQuery(byFrame: nil)), .notProven(.notFound))
        let doubled = FakeQuery(byFrame: [(appOnAppsPage, 1)], matchFrame: appOnAppsPage)
        XCTAssertEqual(probe([icon(0, 25, 65), icon(1, 25.4, 65.3)], doubled), .notProven(.ambiguousInSnapshot))
        XCTAssertEqual(doubled.calls, [])
        let none = FakeQuery()
        XCTAssertEqual(probe([icon(1, 22, 65, 166, 188)], none), .notProven(.noIcon))
        XCTAssertEqual(none.calls, [])
    }

    func testAtMostThreeLookupsBeforeTheHittableCheck() {
        XCTAssertEqual(HomeScreenProbe.maxQueryLookups, 4, "count + frame + posição em largura + o isHittable final")
        for query in [FakeQuery(), FakeQuery(byFrame: nil), FakeQuery(byFrame: [(appOnWidgetPage, 1)], matchFrame: appOnWidgetPage),
                      FakeQuery(byFrame: [(appOnWidgetPage, 1)], matchFrame: appOnAppsPage, byBreadth: [3: appOnWidgetPage])] {
            _ = probe(widgetsOnTop, query)
            XCTAssertLessThanOrEqual(query.calls.count, HomeScreenProbe.maxQueryLookups - 1)
        }
    }

    func testFrameToleranceIsSmall() {
        XCTAssertEqual(HomeScreenProbe.frameTolerance, 1)
        XCTAssertTrue(HomeScreenProbe.sameFrame(appOnAppsPage, Rect(x: 25.9, y: 64.2, w: 68.5, h: 89.1)))
        XCTAssertFalse(HomeScreenProbe.sameFrame(appOnAppsPage, Rect(x: 27, y: 65, w: 68, h: 90)))
        XCTAssertFalse(HomeScreenProbe.sameFrame(appOnAppsPage, Rect(x: 25, y: 65, w: 70, h: 90)))
    }
}
