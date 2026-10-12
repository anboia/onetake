import Foundation
import XCTest

@testable import ContrarregraKit

/// `screen.shot`, `ui.tree`, `ui.find` e `ui.ocr` (S1 item 4) sobre um aparelho falso (T-0.6): lista
/// permitida aplicada antes de ler, nada capturado quando ela recusa, refs e formatos de S0.6.
final class ReadMethodsTests: XCTestCase {
    typealias F = TreeFixtures

    func call(_ method: ReadMethods.Method, _ params: JSONValue, _ harness: ReadHarness) throws(RpcErrorObject) -> JSONValue {
        let context = harness.context
        func decode<M: JSONModel>(_ type: M.Type) throws(RpcErrorObject) -> M {
            do { return try M.decode(params) } catch { throw RpcErrorObject(.invalidParams, error.description) }
        }
        switch method {
        case .screenShot: return try ReadMethods.screenShot(decode(ScreenShotParams.self), context)
        case .uiTree: return try ReadMethods.uiTree(decode(UiTreeParams.self), context)
        case .uiFind: return try ReadMethods.uiFind(decode(UiFindParams.self), context)
        case .uiOcr: return try ReadMethods.uiOcr(decode(UiOcrParams.self), context)
        }
    }

    func ok(_ method: ReadMethods.Method, _ params: JSONValue = [:], _ harness: ReadHarness,
            file: StaticString = #filePath, line: UInt = #line) throws -> JSONValue {
        do {
            return try call(method, params, harness)
        } catch {
            XCTFail("\(method.rawValue) falhou: \(error.message)", file: file, line: line)
            throw error
        }
    }

    @discardableResult
    func refused(_ code: RunnerErrorCode, _ method: ReadMethods.Method, _ params: JSONValue,
                 _ harness: ReadHarness, file: StaticString = #filePath, line: UInt = #line) -> RpcErrorObject? {
        assertRunnerError(code, file: file, line: line) { () throws(RpcErrorObject) in try call(method, params, harness) }
    }

    /// Recusado pela lista permitida (`E_FORBIDDEN_APP`).
    @discardableResult
    func refused(_ method: ReadMethods.Method, _ params: JSONValue, _ harness: ReadHarness,
                 file: StaticString = #filePath, line: UInt = #line) -> RpcErrorObject? {
        refused(.forbiddenApp, method, params, harness, file: file, line: line)
    }

    // MARK: ui.tree (S0.6, AC-1.3, AC-1.22)

    func testAC122_treeOfTheExploreAppWithoutChoreography() throws {
        let harness = ReadHarness.exploring()
        let result = try ok(.uiTree, [:], harness)
        XCTAssertEqual(result["treeVersion"], 1)
        let lines = result["nodes"]?.arrayValue?.compactMap(\.stringValue) ?? []
        XCTAssertEqual(lines.first, "@e1 application \"Example Target\" (0,0 390x844)")
        XCTAssertEqual(harness.reader.snapshots, [F.target], "app padrão = o app em primeiro plano")
        XCTAssertEqual(harness.state.treeVersion, 1, "health vê o treeVersion")
        XCTAssertEqual(harness.state.foregroundApp, F.target)
        XCTAssertEqual(harness.reader.anyCapture, 0)
    }

    func testAC13_compactLineAndFindReturnTheSameFrame() throws {
        let harness = ReadHarness.exploring()
        let lines = try ok(.uiTree, ["format": "compact"], harness)["nodes"]?.arrayValue?.compactMap(\.stringValue) ?? []
        XCTAssertTrue(lines.contains("@e6 button \"Open settings\" (342,52 40x40)"), lines.joined(separator: "\n"))
        let found = try ok(.uiFind, ["target": ["label": "Open settings"]], harness)
        XCTAssertEqual(found, ["candidates": [["ref": "@e6", "frame": ["x": 342, "y": 52, "w": 40, "h": 40],
                                              "visible": true, "hittable": true]]])
    }

    func testTreeJsonFormatReturnsTreeNodesWithChildren() throws {
        let harness = ReadHarness.exploring()
        let result = try ok(.uiTree, ["format": "json", "maxDepth": 2], harness)
        let roots = result["nodes"]?.arrayValue ?? []
        XCTAssertEqual(roots.count, 1)
        let root = try TreeNode.decode(roots[0])
        XCTAssertEqual(root.type, .application)
        XCTAssertEqual(root.children?.first?.children?.map(\.type), [.navigationBar, .scrollView, .tabBar])
        XCTAssertNil(root.children?.first?.children?.first?.children, "maxDepth 2 corta abaixo da profundidade 2")
    }

    func testTreeParamsAreValidated() {
        XCTAssertThrowsError(try UiTreeParams.decode(["format": "xml"]))
        XCTAssertThrowsError(try UiTreeParams.decode(["maxDepth": -1]))
        XCTAssertThrowsError(try UiTreeParams.decode(["extra": true]))
        XCTAssertEqual(try UiTreeParams.decode(.null), UiTreeParams())
    }

    // MARK: Lista permitida nas leituras (S1 item 11)

    func testAC117_sheetInFront_treeAndShotAreForbiddenAndNothingIsCaptured() throws {
        let harness = ReadHarness.exploring(front: SystemApp.authkit)
        refused(.uiTree, [:], harness)
        refused(.uiTree, ["app": "authkit"], harness)
        refused(.screenShot, [:], harness)
        refused(.uiOcr, [:], harness)
        refused(.uiFind, ["target": ["app": "authkit", "ocr": ["text": "Continue"]]], harness)
        XCTAssertEqual(harness.reader.anyCapture, 0, "nada é capturado com a folha à frente")
        XCTAssertFalse(harness.reader.snapshots.contains(SystemApp.authkit), "ui.tree da folha nem chega a ler a árvore")

        // Só ui.find de botões, e sem o valor (o e-mail da conta não sai do aparelho).
        let found = try ok(.uiFind, ["target": ["app": "authkit", "label": "Continue", "type": "button"]], harness)
        XCTAssertEqual(found["candidates"]?.arrayValue?.count, 1)
        let share = try ok(.uiFind, ["target": ["app": "authkit", "label": "Share My Email"]], harness)
        XCTAssertNil(share["candidates"]?.arrayValue?.first?["value"])
        // 4.ª revisão, achado 4: só rótulo exato de lista fechada; prefixo/trecho/identificador viram recusa.
        refused(.uiFind, ["target": ["app": "authkit", "label": "Someone Private"]], harness)
        for selector in [["labelContains": "@"], ["labelContains": "someone"], ["labelPrefix": "Continue as"], ["labelPrefix": "C"],
                         ["identifier": "x"], ["type": "button"], ["label": "Continue as someone@example.com"]] as [JSONObject] {
            var target = selector
            target["app"] = "authkit"
            refused(.uiFind, ["target": .object(target)], harness)
        }
        let continueButton = try ok(.uiFind, ["target": ["app": "authkit", "label": "Continue"]], harness)["candidates"]?.arrayValue ?? []
        XCTAssertEqual(continueButton.count, 1)
        XCTAssertEqual(continueButton.first?.objectValue?.keys.sorted(), ["frame", "hittable", "ref", "visible"], "nem rótulo nem valor")
    }

    func testAC117_homeScreenOrLockScreenInFront_shotAndOcrTapAreForbiddenAndNothingIsCaptured() throws {
        for harness in [ReadHarness.exploring(front: SystemApp.springboard), ReadHarness.exploring(front: F.target, locked: true)] {
            refused(.screenShot, [:], harness)
            refused(.screenShot, ["format": "png", "scale": "native"], harness)
            refused(.uiOcr, ["text": "Example"], harness)
            refused(.uiFind, ["target": ["ocr": ["text": "Example"]]], harness)
            refused(.uiFind, ["target": ["app": "springboard", "ocr": ["text": "Example"]]], harness)
            refused(.uiTree, ["app": "springboard"], harness)
            XCTAssertEqual(harness.reader.anyCapture, 0)
        }
    }

    func testSpringBoardReadsNeverReturnTheWholeTree() throws {
        let harness = ReadHarness.exploring(front: SystemApp.springboard)
        harness.store.current = try harness.store.current.loading(.init(bundleId: F.target, iconLabel: "Example Target"))
        let icon = try ok(.uiFind, ["target": ["app": "springboard", "label": "Example Target", "type": "icon"]], harness)
        XCTAssertEqual(icon["candidates"]?.arrayValue?.first?["frame"], Rect(x: 27, y: 80, w: 64, h: 76).json)
        refused(.targetNotFound, .uiFind, ["target": ["app": "springboard", "label": "Notes", "type": "icon"]], harness)
        refused(.targetNotFound, .uiFind, ["target": ["app": "springboard", "label": "Dentist 3 PM"]], harness)
        // Âncora fora do alcance também não serve (não dá para sondar o que está escondido).
        refused(.targetNotFound, .uiFind, ["target": ["app": "springboard", "type": "icon", "within": ["label": "Calendar"]]], harness)
        let all = try ok(.uiFind, ["target": ["app": "springboard", "type": "any"]], harness)
        XCTAssertEqual(all["candidates"]?.arrayValue?.count, 4, "os 4 ícones da página do app alvo, nada mais")
    }

    func testAC115_airplaneSwitchIsFoundWithItsValueWhenTheControlCenterIsOpen() throws {
        // A Central sobre a tela de início e sobre o app alvo: só os controles dela (revisões 2 e 5).
        for screen in [Screens.controlCenterOverHome, Screens.controlCenter(over: F.target)] {
            let harness = ReadHarness.exploring(screen: screen)
            harness.store.current = try harness.store.current.loading(.init(bundleId: F.target, iconLabel: "Example Target"))
            harness.reader.setTree(SystemApp.springboard, F.controlCenter)
            let found = try ok(.uiFind, ["target": ["app": "springboard", "identifier": "airplane-mode-button"]], harness)
            let candidate = found["candidates"]?.arrayValue?.first
            XCTAssertEqual(candidate?["value"], "0")
            XCTAssertEqual(candidate?["hittable"], true)
            refused(.targetNotFound, .uiFind, ["target": ["app": "controlcenter", "labelPrefix": "Now Playing"]], harness)
            refused(.targetNotFound, .uiFind, ["target": ["app": "springboard", "label": "Call Alex Doe"]], harness)
            refused(.targetNotFound, .uiFind, ["target": ["app": "springboard", "label": "Example Target", "type": "icon"]], harness)
            XCTAssertEqual(harness.reader.captures, 0)
        }
    }

    /// Revisão 2: com qualquer camada por cima, os ícones da tela de início não se leem.
    func testHomeScreenIconsAreUnreachableUnderAnyLayer() throws {
        for screen in [Screens.notificationCenter(over: F.target), Screens.appSwitcher(over: F.target), Screens.springBoardLayerOverHome,
                       Screens.banner(over: F.target), Screens.controlCenterOverUnknown, Screens.unidentified(over: F.target)] {
            let harness = ReadHarness.exploring(screen: screen)
            harness.store.current = try harness.store.current.loading(.init(bundleId: F.target, iconLabel: "Example Target"))
            refused(.uiFind, ["target": ["app": "springboard", "label": "Example Target", "type": "icon"]], harness)
            XCTAssertFalse(harness.reader.snapshots.contains(SystemApp.springboard), "\(screen)")
        }
    }

    func testAC121_lockScreenMediaControlsAreFoundButNotTheNotification() throws {
        let harness = ReadHarness.exploring(front: SystemApp.springboard, locked: true)
        harness.reader.setTree(SystemApp.springboard, F.lockScreen)
        XCTAssertEqual(try ok(.uiFind, ["target": ["app": "springboard", "label": "Pause"]], harness)["candidates"]?.arrayValue?.count, 1)
        refused(.targetNotFound, .uiFind, ["target": ["app": "springboard", "type": "cell"]], harness)
        refused(.targetNotFound, .uiFind, ["target": ["app": "springboard", "label": "Psalm 23"]], harness)
        // Revisão 4: nada de notificação, nem botão dentro dela (o código do SMS).
        refused(.targetNotFound, .uiFind, ["target": ["app": "springboard", "label": "Copy Code"]], harness)
        refused(.targetNotFound, .uiFind, ["target": ["app": "springboard", "labelContains": "New message"]], harness)
        XCTAssertEqual(try ok(.uiFind, ["target": ["app": "springboard", "type": "button"]], harness)["candidates"]?.arrayValue?.count, 3)
        XCTAssertEqual(harness.reader.anyCapture, 0)
    }

    /// 3.ª revisão, achado 1: lista positiva na tela travada — notificação de id desconhecido, widget e Live
    /// Activity como `button` não são alcançados, nem letra a letra; nenhum `value` do SpringBoard sai, salvo o do
    /// modo avião.
    func testLockScreenReachesOnlyRecognizedMediaControlsAndNoValues() throws {
        let harness = ReadHarness.exploring(screen: Screens.locked)
        harness.reader.setTree(SystemApp.springboard, F.lockScreen)
        let buttons = try ok(.uiFind, ["target": ["app": "springboard", "type": "button"]], harness)["candidates"]?.arrayValue ?? []
        XCTAssertEqual(buttons.count, 3, "Previous track, Pause, Next track")
        let pauses = try ok(.uiFind, ["target": ["app": "springboard", "label": "Pause"]], harness)["candidates"]?.arrayValue ?? []
        XCTAssertEqual(pauses.count, 1, "4.ª revisão, achado 3: o Pause solitário da Live Activity fica de fora")
        for probe in ["Maria", "482913", "4829", "Dentist", "Delivery", "Copy", "New message"] {
            refused(.targetNotFound, .uiFind, ["target": ["app": "springboard", "type": "button", "labelContains": .string(probe)]], harness)
            refused(.targetNotFound, .uiFind, ["target": ["app": "springboard", "labelPrefix": .string(probe)]], harness)
        }
        let slider = try ok(.uiFind, ["target": ["app": "springboard", "type": "slider"]], harness)["candidates"]?.arrayValue?.first
        XCTAssertNotNil(slider)
        XCTAssertNil(slider?["value"], "valor do SpringBoard fora do modo avião não sai")

        let center = ReadHarness.exploring(screen: Screens.controlCenterOverHome)
        center.reader.setTree(SystemApp.springboard, F.controlCenter)
        let wifi = try ok(.uiFind, ["target": ["app": "springboard", "identifier": "wifi-button"]], center)["candidates"]?.arrayValue?.first
        XCTAssertNotNil(wifi)
        XCTAssertNil(wifi?["value"], "o SSID da rede não sai")
    }

    /// 3.ª revisão, achado 3: refs e `treeVersion` do SpringBoard só dependem do que a leitura alcança.
    func testSpringBoardRefsAndTreeVersionIgnoreUnreachableNodes() throws {
        func pauseRef(_ tree: RawNode, _ harness: ReadHarness) throws -> JSONValue? {
            harness.reader.setTree(SystemApp.springboard, tree)
            return try ok(.uiFind, ["target": ["app": "springboard", "label": "Pause"]], harness)["candidates"]?.arrayValue?.first?["ref"]
        }
        var moreNotifications = F.lockScreen
        moreNotifications.children.insert(contentsOf: (0..<5).map { F.node(.cell, "Messages, \($0)", id: "ListCell", 20, 100, 350, 40) }, at: 1)

        let harness = ReadHarness.exploring(screen: Screens.locked)
        let first = try pauseRef(F.lockScreen, harness)
        let version = harness.state.treeVersion
        let second = try pauseRef(moreNotifications, harness)
        XCTAssertEqual(first, second, "notificações novas não trocam o ref")
        XCTAssertEqual(harness.state.treeVersion, version, "nem o treeVersion de health")

        // A numeração também não depende de quantos nós escondidos havia antes.
        let other = ReadHarness.exploring(screen: Screens.locked)
        XCTAssertEqual(try pauseRef(moreNotifications, other), first)

        // O que a leitura alcança mudou (Pause → Play): aí sim, refs e versão novos.
        var playing = F.lockScreen
        playing.children[playing.children.count - 1].children[3].label = "Play"
        harness.reader.setTree(SystemApp.springboard, playing)
        _ = try ok(.uiFind, ["target": ["app": "springboard", "label": "Play"]], harness)
        XCTAssertEqual(harness.state.treeVersion, version + 1)
    }

    /// 3.ª revisão, achado 2: a resolução para ação confere o ponto final (centro + offset) contra o nó permitido.
    func testResolveForActionChecksTheFinalPoint() throws {
        let home = ReadHarness.exploring(front: SystemApp.springboard)
        home.store.current = try home.store.current.loading(.init(bundleId: F.target, iconLabel: "Example Target"))
        let icon: JSONValue = ["app": "springboard", "label": "Example Target", "type": "icon"]
        func target(_ json: JSONValue) throws -> Target { try Target.decode(json) }
        func resolve(_ json: JSONValue, _ harness: ReadHarness) throws -> Result<ResolvedTarget, RpcErrorObject> {
            let parsed = try target(json)
            let session = harness.session()
            do { return .success(try session.resolveForAction(parsed, .tap)) } catch { return .failure(error) }
        }
        var withOffset = icon.objectValue!
        withOffset["offset"] = ["dx": 180, "dy": 0]
        XCTAssertEqual(try resolve(.object(withOffset), home).failureCode, RunnerErrorCode.forbiddenApp.code, "o toque cairia em Ajustes")
        withOffset["offset"] = ["dx": 10, "dy": 0]
        XCTAssertEqual(try resolve(.object(withOffset), home).successPoint, AbsolutePoint(x: 69, y: 118))
        XCTAssertEqual(try resolve(["app": "springboard", "label": "Settings", "type": "icon"], home).failureCode,
                       RunnerErrorCode.forbiddenApp.code, "AC-1.17")
        XCTAssertEqual(try resolve(["app": "springboard", "point": ["x": 59, "y": 118]], home).failureCode,
                       RunnerErrorCode.forbiddenApp.code, "ponto solto no SpringBoard")

        let center = ReadHarness.exploring(screen: Screens.controlCenter(over: F.target))
        center.reader.setTree(SystemApp.springboard, F.controlCenter)
        XCTAssertEqual(try resolve(["app": "springboard", "identifier": "airplane-mode-button", "offset": ["dx": 70, "dy": 0]], center)
            .failureCode, RunnerErrorCode.forbiddenApp.code, "o toque cairia no Wi-Fi")
        XCTAssertEqual(try resolve(["app": "springboard", "identifier": "airplane-mode-button"], center).successPoint,
                       AbsolutePoint(x: 60, y: 120))

        // A tela é relida logo antes da conferência da ação.
        let app = ReadHarness.exploring()
        app.reader.queue(Screens.proven(F.target), Screens.controlCenter(over: F.target))
        XCTAssertEqual(try resolve(["label": "Back"], app).failureCode, RunnerErrorCode.forbiddenApp.code)
        XCTAssertEqual(try resolve(["label": "Back", "offset": ["dx": 300, "dy": 0]], ReadHarness.exploring()).successPoint,
                       AbsolutePoint(x: 338, y: 69), "no app operável o offset é livre (dentro da tela)")
        XCTAssertEqual(try resolve(["label": "Back", "offset": ["dx": 400, "dy": 0]], ReadHarness.exploring()).failureCode,
                       RunnerErrorCode.forbiddenApp.code, "4.ª revisão, achado 1: fora da tela")
        let edge = ReadHarness.exploring()
        let topEdge = try Target.decode(["point": ["x": 20, "y": 1]])
        XCTAssertNoThrow(try edge.session().resolveForAction(topEdge, .tap))
        XCTAssertThrowsError(try edge.session().resolveForAction(topEdge, .drag), "arrastar da barra de estado abriria a Central de Notificações")
    }

    /// Revisão 3: bloqueio não lido (ou em transição) = desconhecido; nada se lê, nem os controles de mídia.
    func testUnreadLockStateRefusesEveryRead() throws {
        for screen in [Screens.lockUnknown(), Screens.lockUnknown(over: SystemApp.springboard)] {
            let harness = ReadHarness.exploring(screen: screen)
            harness.reader.setTree(SystemApp.springboard, F.lockScreen)
            refused(.uiFind, ["target": ["app": "springboard", "label": "Pause"]], harness)
            refused(.uiFind, ["target": ["app": "springboard", "type": "button"]], harness)
            refused(.uiFind, ["target": ["label": "Back"]], harness)
            refused(.uiTree, [:], harness)
            refused(.screenShot, [:], harness)
            XCTAssertTrue(harness.reader.snapshots.isEmpty)
            XCTAssertEqual(harness.reader.captures, 0)
            XCTAssertEqual(harness.state.locked, true, "health trata como travada")
        }
    }

    func testAC124_settingsInFrontWithExploreSettings() throws {
        let phone = ReadHarness(reader: FakeReader(front: "com.apple.Preferences", trees: ["com.apple.Preferences": F.reader]),
                                allowList: AllowList(isSimulator: false, explore: "com.apple.Preferences"))
        refused(.uiTree, [:], phone)
        refused(.uiTree, ["app": "target"], phone)
        refused(.uiFind, ["target": ["label": "Back"]], phone)
        refused(.screenShot, [:], phone)
        XCTAssertTrue(phone.reader.snapshots.isEmpty, "nada é operado")
        XCTAssertEqual(phone.reader.anyCapture, 0)

        let simulator = ReadHarness(reader: FakeReader(front: "com.apple.Preferences", trees: ["com.apple.Preferences": F.reader]),
                                    allowList: AllowList(isSimulator: true, explore: "com.apple.Preferences"))
        XCTAssertNotNil(try ok(.uiTree, [:], simulator)["nodes"])
    }

    func testAnyReadWithAnAppOutsideTheListInFrontIsForbidden() throws {
        let harness = ReadHarness.exploring(front: "com.example.other")
        for method in ReadMethods.Method.allCases {
            let params: JSONValue = method == .uiFind ? ["target": ["label": "Back"]] : [:]
            refused(method, params, harness)
        }
        XCTAssertEqual(harness.reader.anyCapture, 0)
        XCTAssertTrue(harness.reader.snapshots.isEmpty)
    }

    /// Achado 6: se a tela muda durante a captura, a imagem é descartada sem codificar e sem OCR.
    func testScreenChangingDuringTheCaptureDiscardsTheRawFrameUnprocessed() throws {
        let harness = ReadHarness.exploring()
        harness.reader.screenAfterCapture = Screens.proven(SystemApp.springboard)
        let error = refused(.screenShot, [:], harness)
        XCTAssertTrue(error?.message.contains("descartada") ?? false, error?.message ?? "")
        XCTAssertEqual(harness.state.foregroundApp, SystemApp.springboard)
        XCTAssertEqual(harness.reader.captures, 1)
        XCTAssertEqual(harness.reader.encodes, 0, "nada de recodificar a imagem descartada")

        // Inclusive quando muda para outro app operável (Notes): o que estava à frente antes e depois tem de ser o mesmo.
        for after in [Screens.locked, Screens.controlCenter(over: F.target), Screens.unknownApp, Screens.proven(F.notes)] {
            for (method, params) in [(ReadMethods.Method.uiFind, ["target": ["ocr": ["text": "shepherd", "occurrence": 0]]] as JSONValue),
                                     (.uiOcr, ["text": "shepherd"])] {
                let ocr = ReadHarness.exploring(apps: [F.notes])
                ocr.reader.screenAfterCapture = after
                refused(method, params, ocr)
                XCTAssertEqual(ocr.reader.captures, 1)
                XCTAssertEqual(ocr.reader.recognitions.count, 0, "o OCR nunca roda numa captura descartada")
            }
        }
    }

    /// Achado 6: o estado é relido logo antes de capturar (aqui o dono trava a tela depois da leitura da âncora).
    func testStateIsReadAgainRightBeforeCapturing() throws {
        let harness = ReadHarness.exploring()
        harness.reader.queue(Screens.proven(F.target), Screens.locked)
        refused(.uiFind, ["target": ["ocr": ["text": "shepherd"], "within": ["label": "Verse 1"]]], harness)
        XCTAssertEqual(harness.reader.snapshots, [F.target], "a âncora foi lida com o app à frente")
        XCTAssertEqual(harness.reader.captures, 0, "travou antes da captura: nada capturado")

        // Revisão 6: cada captura de uma operação relê logo antes (a 2.ª do fallback viu a tela travar).
        let fallback = ReadHarness.exploring()
        fallback.reader.queue(Screens.proven(F.target), Screens.proven(F.target), Screens.proven(F.target), Screens.locked)
        refused(.uiFind, ["target": ["ocr": ["text": "still waters"], "fallback": [["ocr": ["text": "shepherd", "occurrence": 0]]]]],
                fallback)
        XCTAssertEqual(fallback.reader.captures, 1, "a 2.ª captura não aconteceu")
        XCTAssertEqual(fallback.reader.recognitions.count, 1)

        let shot = ReadHarness.exploring()
        _ = try ok(.screenShot, [:], shot)
        XCTAssertEqual(shot.reader.screenReads, 2, "uma leitura logo antes e uma logo depois da captura")
        XCTAssertEqual(shot.reader.captures, 1)
        XCTAssertEqual(shot.reader.encodes, 1)
    }

    // MARK: Camadas do SpringBoard por cima de um app e app desconhecido (achados 1 e 2)

    func testSpringBoardLayersOverAnOperableAppBlockEveryCapture() throws {
        for layered in [Screens.controlCenter(over: F.target), Screens.notificationCenter(over: F.target),
                        Screens.appSwitcher(over: F.target), Screens.banner(over: F.target)] {
            let harness = ReadHarness.exploring(screen: layered)
            refused(.screenShot, [:], harness)
            refused(.uiOcr, [:], harness)
            refused(.uiFind, ["target": ["ocr": ["text": "shepherd", "occurrence": 0]]], harness)
            refused(.uiTree, [:], harness)
            refused(.uiFind, ["target": ["label": "Back"]], harness)
            XCTAssertEqual(harness.reader.captures, 0, "\(layered)")
            XCTAssertEqual(harness.state.foregroundApp, SystemApp.springboard, "health diz que o SpringBoard está à frente")
        }
    }

    func testAnUnknownOrUnreachableAppInFrontRefusesReadsOfTheBackgroundTargetAndOfSpringBoard() throws {
        for screen in [Screens.unknownApp, Screens.notReachable(F.target)] {
            let harness = ReadHarness.exploring(screen: screen)
            refused(.uiFind, ["target": ["label": "Back"]], harness)
            refused(.uiFind, ["target": ["app": "springboard", "type": "icon"]], harness)
            refused(.uiTree, [:], harness)
            refused(.uiTree, ["app": "target"], harness)
            refused(.screenShot, [:], harness)
            XCTAssertTrue(harness.reader.snapshots.isEmpty, "nenhuma árvore lida")
            XCTAssertEqual(harness.reader.captures, 0)
        }
        let other = ReadHarness.exploring(front: F.notes, apps: [F.notes])
        refused(.uiFind, ["target": ["label": "Back"]], other)  // o app alvo está em segundo plano
        XCTAssertTrue(other.reader.snapshots.isEmpty)
    }

    /// Achado 3: a folha só com ela à frente e destravado.
    func testSheetReadsOnlyWithTheSheetInFront() throws {
        for screen in [Screens.locked, Screens.proven(SystemApp.springboard), Screens.proven("com.apple.Preferences"),
                       Screens.proven(F.target), Screens.unknownApp] {
            let harness = ReadHarness.exploring(screen: screen)
            refused(.uiFind, ["target": ["app": "authkit", "label": "Continue", "type": "button"]], harness)
            XCTAssertFalse(harness.reader.snapshots.contains(SystemApp.authkit))
        }
    }

    /// Achado 7: alvo `point` também passa pela lista permitida.
    func testPointTargetsAreRefusedWhenTheFrontIsNotInTheList() throws {
        for screen in [Screens.unknownApp, Screens.proven("com.apple.Preferences"), Screens.notReachable(F.target)] {
            let harness = ReadHarness.exploring(screen: screen)
            refused(.uiFind, ["target": ["point": ["x": 100, "y": 200]]], harness)
            refused(.uiFind, ["target": ["app": "authkit", "point": ["x": 100, "y": 200]]], harness)
            refused(.uiFind, ["target": ["app": "springboard", "point": ["nx": 0.5, "ny": 0.5]]], harness)
        }
        let harness = ReadHarness.exploring()
        let found = try ok(.uiFind, ["target": ["point": ["x": 100, "y": 200]]], harness)
        XCTAssertEqual(found["candidates"]?.arrayValue?.count, 1)
    }

    // MARK: screen.shot e ui.ocr

    func testScreenShotDefaultsToJpegInPointsAndReturnsBase64AndSize() throws {
        let harness = ReadHarness.exploring()
        let shot = try ok(.screenShot, [:], harness)
        XCTAssertEqual(shot["format"], "jpeg")
        XCTAssertEqual(shot["widthPx"], 390)
        XCTAssertEqual(shot["heightPx"], 844)
        XCTAssertEqual(shot["scale"], 1)
        let data = Data(base64Encoded: shot["image"]?.stringValue ?? "")
        XCTAssertEqual(data.map { String(decoding: $0, as: UTF8.self) }, "fake-jpeg")
        let native = try ok(.screenShot, ["format": "png", "scale": "native"], harness)
        XCTAssertEqual(native["widthPx"], 1170)
        XCTAssertEqual(native["scale"], 3)
        XCTAssertEqual(harness.reader.captures, 2)
        XCTAssertEqual(harness.reader.encodes, 2)
        XCTAssertThrowsError(try ScreenShotParams.decode(["quality": 1.5]))
        XCTAssertEqual(try ScreenShotParams.decode(.null), ScreenShotParams(format: .jpeg, scale: .points, quality: 0.8))
    }

    func testOcrReturnsWordBoxesInPointsOrTheOccurrencesOfTheText() throws {
        let harness = ReadHarness.exploring()
        let all = try ok(.uiOcr, [:], harness)["boxes"]?.arrayValue ?? []
        XCTAssertEqual(all.compactMap { $0["text"]?.stringValue },
                       ["The", "Lord", "is", "my", "shepherd;", "CURRENT", "DAY", "Shepherd"])
        XCTAssertEqual(all.first, ["text": "The", "frame": ["x": 70, "y": 100, "w": 30, "h": 20], "confidence": 0.9])
        let shepherd = try ok(.uiOcr, ["text": "shepherd"], harness)["boxes"]?.arrayValue ?? []
        XCTAssertEqual(shepherd.count, 2)
        let region = try ok(.uiOcr, ["region": ["x": 0, "y": 380, "w": 390, "h": 100]], harness)["boxes"]?.arrayValue ?? []
        XCTAssertEqual(region.compactMap { $0["text"]?.stringValue }, ["Shepherd"])
        XCTAssertEqual(harness.reader.recognitions.last, Rect(x: 0, y: 380, w: 390, h: 100))
        let outside = try ok(.uiOcr, ["region": ["x": 400, "y": 0, "w": 10, "h": 10]], harness)
        XCTAssertEqual(outside, ["boxes": []], "região fora da tela")
    }

    // MARK: Pelo roteador (fila do XCTest, prazos, erros JSON-RPC)

    func testReadMethodsAreRegisteredOnTheXCTestLaneWithTheirDeadlines() throws {
        let read = ReadHarness.exploring()
        let runner = RunnerHarness(state: read.state, extraRoutes: { router in ReadMethods.register(into: &router, read.context) })
        for method in ReadMethods.Method.allCases {
            XCTAssertEqual(runner.router.route(method.rawValue)?.lane, .xctest, method.rawValue)
        }
        XCTAssertEqual(runner.router.route("screen.shot")?.deadline(nil), 3)
        XCTAssertEqual(runner.router.route("ui.tree")?.deadline(nil), 5)
        XCTAssertEqual(runner.router.route("ui.find")?.deadline(nil), 10)

        let client = try runner.connected()
        let found = try client.call("ui.find", ["target": ["label": "Play", "index": 1]])
        XCTAssertEqual(found.rpcResult?["candidates"]?.arrayValue?.first?["ref"], "@e13")
        let ambiguousFind = try client.call("ui.find", ["target": ["label": "Play"]])
        XCTAssertEqual(ambiguousFind.rpcResult?["candidates"]?.arrayValue?.count, 3, "ui.find mostra os candidatos")
        XCTAssertEqual(try client.call("ui.find", [:]).rpcErrorCode, JSONRPCErrorCode.invalidParams.rawValue)
        XCTAssertEqual(try client.call("ui.find", ["target": ["label": "x", "identifier": "y"]]).rpcErrorCode,
                       JSONRPCErrorCode.invalidParams.rawValue, "dois seletores primários")
        XCTAssertEqual(try client.call("ui.tree", ["app": "springboard"]).rpcErrorCode, RunnerErrorCode.forbiddenApp.code)
        let health = try client.call("health")
        XCTAssertEqual(health.rpcResult?["foregroundApp"], .string(F.target))
        XCTAssertEqual(health.rpcResult?["treeVersion"], 1)
    }
}

extension Result where Success == ResolvedTarget, Failure == RpcErrorObject {
    var failureCode: Int? { if case .failure(let error) = self { return error.code }; return nil }
    var successPoint: AbsolutePoint? { if case .success(let resolved) = self { return resolved.point }; return nil }
}
