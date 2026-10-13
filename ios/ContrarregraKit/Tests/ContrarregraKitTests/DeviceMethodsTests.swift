import Foundation
import XCTest

@testable import ContrarregraKit

/// Aparelho, apps e espera (S1 itens 4, 7, 8, 9, 10 e 11; T-0.8) sobre um aparelho falso: a forma estrita de
/// `device.state` (a do Mac), os botões (volume recusado na seção `scenes`), `device.wake` só com a tela travada
/// provada, a Central de Controle pelo arrasto do canto superior direito só sobre a tela de início ou um app operável,
/// `device.lock` só com PX-1 (sem ele, `E_CAPABILITY_MISSING` e nada mais), `app.*` só em apps operáveis, e
/// `app.openURL` pelos prefixos de link (da coreografia e da configuração), recusado na seção `scenes`. As medidas
/// no aparelho são dos spikes.
final class DeviceMethodsTests: XCTestCase {
    typealias F = TreeFixtures

    // MARK: Apoio

    func call(_ method: DeviceMethods.Method, _ harness: DeviceHarness) throws(RpcErrorObject) -> JSONValue {
        try call(method, [:], harness)
    }

    func call(_ method: DeviceMethods.Method, _ params: JSONValue, _ harness: DeviceHarness) throws(RpcErrorObject) -> JSONValue {
        func decode<M: JSONModel>(_ type: M.Type) throws(RpcErrorObject) -> M {
            do { return try M.decode(params) } catch { throw RpcErrorObject(.invalidParams, error.description) }
        }
        let context = harness.context
        switch method {
        case .state: return DeviceMethods.state(context).json
        case .home: return try DeviceMethods.home(context).json
        case .press: return try DeviceMethods.press(decode(DevicePressParams.self), context).json
        case .wake: return try DeviceMethods.wake(context).json
        case .controlCenter: return try DeviceMethods.controlCenter(decode(DeviceControlCenterParams.self), context).json
        case .lock: return try DeviceMethods.lock(context).json
        case .appActivate: return try DeviceMethods.activate(decode(AppBundleParams.self), context).json
        case .appTerminate: return try DeviceMethods.terminate(decode(AppBundleParams.self), context).json
        case .appState: return try DeviceMethods.appState(decode(AppBundleParams.self), context).json
        case .appOpenURL: return try DeviceMethods.openURL(decode(AppOpenURLParams.self), context).json
        case .waitFor: return try DeviceMethods.waitFor(decode(WaitForParams.self), context).json
        }
    }

    /// Uma ação de aparelho/app que deu certo: a resposta tem os tempos D em ordem e o caminho esperado.
    @discardableResult
    func ok(_ method: DeviceMethods.Method, _ harness: DeviceHarness, path: ActionPath = .public,
            file: StaticString = #filePath, line: UInt = #line) throws -> DeviceActionResult {
        try ok(method, [:], harness, path: path, file: file, line: line)
    }

    @discardableResult
    func ok(_ method: DeviceMethods.Method, _ params: JSONValue, _ harness: DeviceHarness, path: ActionPath = .public,
            file: StaticString = #filePath, line: UInt = #line) throws -> DeviceActionResult {
        do {
            let result = try DeviceActionResult.decode(call(method, params, harness))
            XCTAssertLessThanOrEqual(result.tDevStartNs, result.tDispatchNs, file: file, line: line)
            XCTAssertLessThanOrEqual(result.tDispatchNs, result.tDevEndNs, file: file, line: line)
            XCTAssertEqual(result.path, path, file: file, line: line)
            return result
        } catch let error as RpcErrorObject {
            XCTFail("\(method.rawValue) falhou: \(error.message)", file: file, line: line)
            throw error
        }
    }

    @discardableResult
    func refused(_ code: RunnerErrorCode, _ method: DeviceMethods.Method, _ harness: DeviceHarness,
                 file: StaticString = #filePath, line: UInt = #line) -> RpcErrorObject? {
        refused(code, method, [:], harness, file: file, line: line)
    }

    @discardableResult
    func refused(_ code: RunnerErrorCode, _ method: DeviceMethods.Method, _ params: JSONValue, _ harness: DeviceHarness,
                 file: StaticString = #filePath, line: UInt = #line) -> RpcErrorObject? {
        assertRunnerError(code, file: file, line: line) { () throws(RpcErrorObject) in try call(method, params, harness) }
    }

    // MARK: device.state (S1 itens 4 e 10)

    func testDeviceStateHasExactlyTheFieldsOfTheMacSchema() throws {
        let harness = DeviceHarness.exploring()
        let state = try call(.state, harness)
        // O `DeviceStateSchema` do Mac (`mac/src/commands/device.ts`) é estrito: só estes sete campos.
        XCTAssertEqual(Set(state.objectValue?.keys.map(\.description) ?? []),
                       ["locked", "network", "foregroundApp", "language", "screenPt", "textSize", "appearance"])
        XCTAssertEqual(state["locked"], false)
        XCTAssertEqual(state["network"], "online")
        XCTAssertEqual(state["foregroundApp"], .string(F.target))
        XCTAssertEqual(state["language"], "en")
        XCTAssertEqual(state["screenPt"], ["w": 390, "h": 844])
        XCTAssertEqual(state["textSize"], "large")
        XCTAssertEqual(state["appearance"], "light")
        XCTAssertEqual(try DeviceStateResult.decode(state).json, state)
    }

    /// `locked` e `foregroundApp` como o `health` os vê (a mesma leitura atualiza o `health`): bloqueio não lido conta
    /// como travado; nada provado à frente = `""`; rede ainda desconhecida = `offline`.
    func testDeviceStateReadsLockFrontAndNetworkFailClosed() throws {
        let locked = DeviceHarness.exploring(screen: Screens.locked)
        let state = try call(.state, locked)
        XCTAssertEqual(state["locked"], true)
        XCTAssertEqual(state["foregroundApp"], .string(SystemApp.springboard))
        XCTAssertEqual(locked.action.read.state.locked, true, "o health vê a mesma leitura")

        let unknown = DeviceHarness.exploring(screen: Screens.lockUnknown())
        unknown.network.set(nil)
        let fallback = try call(.state, unknown)
        XCTAssertEqual(fallback["locked"], true)
        XCTAssertEqual(fallback["foregroundApp"], "")
        XCTAssertEqual(fallback["network"], "offline")

        let sheet = DeviceHarness.exploring(screen: Screens.proven(SystemApp.authkit))
        XCTAssertEqual(try call(.state, sheet)["foregroundApp"], .string(SystemApp.authkit))
        XCTAssertEqual(sheet.device.calls, [], "device.state não aperta nada")
        XCTAssertEqual(sheet.action.toucher.gestures, [])
    }

    func testNetworkIsOnlineWhenWiFiOrCellularIsSatisfied() {
        XCTAssertEqual(NetworkState.from(wifi: true, cellular: false), .online)
        XCTAssertEqual(NetworkState.from(wifi: false, cellular: true), .online)
        XCTAssertEqual(NetworkState.from(wifi: true, cellular: nil), .online)
        XCTAssertEqual(NetworkState.from(wifi: false, cellular: false), .offline)
        XCTAssertNil(NetworkState.from(wifi: false, cellular: nil), "um monitor ainda sem notícia: desconhecido")
        XCTAssertNil(NetworkState.from(wifi: nil, cellular: nil))
    }

    // MARK: Botões (S1 itens 4, 7 e 9)

    func testHomeAndPressHome() throws {
        let harness = DeviceHarness.exploring()
        try ok(.home, harness)
        try ok(.press, ["button": "home"], harness)
        XCTAssertEqual(harness.device.calls, [.press(.home), .press(.home)])
        // Durante a seção scenes também (só os de volume mostram o HUD).
        harness.scenes.set(true)
        try ok(.home, harness)
        try ok(.press, ["button": "home"], harness)
        XCTAssertEqual(harness.device.calls.count, 4)
    }

    /// AC-1.8 (parte de `device.press`): na seção `scenes`, volume → `E_FORBIDDEN_IN_TAKE` e nada é apertado.
    func testAC18_volumeButtonsAreRefusedDuringScenesOnly() throws {
        let harness = DeviceHarness.exploring()
        harness.scenes.set(true)
        for button in ["volumeUp", "volumeDown"] {
            let error = refused(.forbiddenInTake, .press, ["button": .string(button)], harness)
            XCTAssertEqual(error?.code, -32031)
        }
        XCTAssertEqual(harness.device.calls, [])
        harness.scenes.set(false)
        try ok(.press, ["button": "volumeUp"], harness)
        try ok(.press, ["button": "volumeDown"], harness)
        XCTAssertEqual(harness.device.calls, [.press(.volumeUp), .press(.volumeDown)])
    }

    // MARK: device.wake (S1 item 8)

    func testWakePressesHomeOnlyOnAProvenLockedScreen() throws {
        let locked = DeviceHarness.exploring(screen: Screens.locked)
        try ok(.wake, locked)
        XCTAssertEqual(locked.device.calls, [.press(.home)])

        // Destravada, a tela está acesa: nada a apertar (um home sairia do app).
        let unlocked = DeviceHarness.exploring()
        let result = try ok(.wake, unlocked)
        XCTAssertEqual(result.tDispatchNs, result.tDevEndNs)
        XCTAssertEqual(unlocked.device.calls, [])

        let unknown = DeviceHarness.exploring(screen: Screens.lockUnknown())
        refused(.forbiddenApp, .wake, unknown)
        XCTAssertEqual(unknown.device.calls, [])
    }

    // MARK: device.controlCenter (S1 itens 7 e 11)

    func testControlCenterOpensByTheTopRightDragOverHomeOrAnOperableAppOnly() throws {
        let expected = DragGesture(from: AbsolutePoint(x: 351, y: 8.44), to: AbsolutePoint(x: 351, y: 168.8),
                                   pressSeconds: ControlCenterGesture.pressSeconds, velocity: nil, holdSeconds: 0)
        for screen in [Screens.proven(SystemApp.springboard), Screens.proven(F.target)] {
            let harness = DeviceHarness.exploring(screen: screen)
            try ok(.controlCenter, ["action": "open"], harness)
            guard case .drag(let gesture) = harness.action.toucher.gestures.first, harness.action.toucher.gestures.count == 1 else {
                return XCTFail("esperava um arrasto, veio \(harness.action.toucher.gestures)")
            }
            XCTAssertEqual(gesture.from.x, expected.from.x, accuracy: 1e-9)
            XCTAssertEqual(gesture.from.y, expected.from.y, accuracy: 1e-9)
            XCTAssertEqual(gesture.to.x, expected.to.x, accuracy: 1e-9)
            XCTAssertEqual(gesture.to.y, expected.to.y, accuracy: 1e-9)
            XCTAssertEqual(gesture.via, [])
            XCTAssertEqual(harness.device.calls, [])
        }
        // Já aberta: nada a fazer.
        let open = DeviceHarness.exploring(screen: Screens.controlCenter(over: F.target))
        try ok(.controlCenter, ["action": "open"], open)
        XCTAssertEqual(open.action.toucher.gestures, [])

        // Tela travada (só o arrasto de destravar), folha, camadas, app fora da lista ou nada provado: recusado.
        for screen in [Screens.locked, Screens.lockUnknown(), Screens.proven(SystemApp.authkit), Screens.notificationCenter(over: F.target),
                       Screens.appSwitcher(over: F.target), Screens.proven("com.apple.MobileSMS"), Screens.unknownApp,
                       Screens.controlCenterOverUnknown] {
            let harness = DeviceHarness.exploring(screen: screen)
            refused(.forbiddenApp, .controlCenter, ["action": "open"], harness)
            XCTAssertEqual(harness.action.toucher.gestures, [], "\(screen)")
            XCTAssertEqual(harness.device.calls, [])
        }
    }

    func testControlCenterClosesOnlyWhenProvenOpen() throws {
        for screen in [Screens.controlCenter(over: F.target), Screens.controlCenterOverHome] {
            let harness = DeviceHarness.exploring(screen: screen)
            try ok(.controlCenter, ["action": "close"], harness)
            XCTAssertEqual(harness.device.calls, [.press(.home)])
            XCTAssertEqual(harness.action.toucher.gestures, [])
        }
        // Já fechada: nada a apertar (um home sairia do app).
        for screen in [Screens.proven(F.target), Screens.proven(SystemApp.springboard)] {
            let harness = DeviceHarness.exploring(screen: screen)
            try ok(.controlCenter, ["action": "close"], harness)
            XCTAssertEqual(harness.device.calls, [])
        }
        for screen in [Screens.locked, Screens.facts(lock: .locked, overlays: [.controlCenter]), Screens.lockUnknown(),
                       Screens.proven(SystemApp.authkit), Screens.controlCenterOverUnknown] {
            let harness = DeviceHarness.exploring(screen: screen)
            refused(.forbiddenApp, .controlCenter, ["action": "close"], harness)
            XCTAssertEqual(harness.device.calls, [], "\(screen)")
        }
    }

    // MARK: device.lock (S1 item 8, PX-1)

    /// AC-1.10 / AC-1.16: sem PX-1 presente e liberado, `E_CAPABILITY_MISSING` e nada mais acontece (nem a tela é
    /// lida).
    func testAC110_lockWithoutPX1IsCapabilityMissingAndNothingElseHappens() {
        let harness = DeviceHarness.exploring()
        let error = refused(.capabilityMissing, .lock, harness)
        XCTAssertEqual(error?.code, -32030)
        XCTAssertEqual(harness.action.read.reader.screenReads, 0)
        XCTAssertEqual(harness.device.calls, [])
        XCTAssertEqual(harness.action.toucher.gestures, [])
    }

    func testLockWithPX1PressesOnlyOnAProvenUnlockedScreen() throws {
        let harness = DeviceHarness.exploring(locker: FakeLocker())
        try ok(.lock, harness, path: .private)
        XCTAssertEqual(harness.locker?.count, 1)

        // Já travada: apertar de novo acenderia a tela; nada a fazer.
        let locked = DeviceHarness.exploring(screen: Screens.locked, locker: FakeLocker())
        try ok(.lock, locked, path: .private)
        XCTAssertEqual(locked.locker?.count, 0)

        let unknown = DeviceHarness.exploring(screen: Screens.lockUnknown(), locker: FakeLocker())
        refused(.forbiddenApp, .lock, unknown)
        XCTAssertEqual(unknown.locker?.count, 0)
    }

    // MARK: app.* (S1 itens 4 e 11)

    /// AC-1.17 (parte de `app.activate`) e AC-1.24: só apps operáveis; Ajustes e os demais pessoais nunca no aparelho.
    func testAC117_appControlOnlyOnOperableApps() throws {
        let harness = DeviceHarness.exploring(apps: [F.notes])
        try ok(.appActivate, ["bundleId": .string(F.target)], harness)
        try ok(.appActivate, ["bundleId": .string(F.notes)], harness)
        try ok(.appActivate, ["bundleId": .string(SystemApp.host)], harness)  // o hospedeiro, fora de tomada
        try ok(.appTerminate, ["bundleId": .string(F.target)], harness)
        XCTAssertEqual(harness.device.calls, [.activate(F.target), .activate(F.notes), .activate(SystemApp.host), .terminate(F.target)])

        for bundleId in ["com.apple.Preferences", "com.apple.mobilephone", "com.apple.springboard", "com.apple.AuthKitUIService",
                         "com.example.other"] {
            for method in [DeviceMethods.Method.appActivate, .appTerminate, .appState] {
                refused(.forbiddenApp, method, ["bundleId": .string(bundleId)], harness)
            }
        }
        XCTAssertEqual(harness.device.calls.count, 4, "nada mais foi operado")

        // Durante a tomada o hospedeiro sai da lista (S1 item 11).
        harness.action.read.store.current.inTake = true
        refused(.forbiddenApp, .appActivate, ["bundleId": .string(SystemApp.host)], harness)
        XCTAssertEqual(harness.device.calls.count, 4)
    }

    func testAppStateMapsTheProcessStateAndUnknownIsAnAppStateError() throws {
        let harness = DeviceHarness.exploring()
        harness.device.states.set([F.target: .background])
        XCTAssertEqual(try call(.appState, ["bundleId": .string(F.target)], harness), ["state": "background"])
        harness.device.states.set([F.target: .notRunning])
        XCTAssertEqual(try call(.appState, ["bundleId": .string(F.target)], harness), ["state": "notRunning"])
        harness.device.states.set([:])
        refused(.appState, .appState, ["bundleId": .string(F.target)], harness)
    }

    // MARK: app.openURL (S1 itens 4, 9 e 11)

    /// Os prefixos de link: os da coreografia carregada (`app.urlPrefixes`) e os da configuração
    /// (`urls.allowedPrefixes`), casados por componentes normalizados; no aparelho, os links pessoais nunca.
    func testOpenURLFollowsTheLinkPrefixesOfTheChoreographyAndTheConfig() throws {
        let harness = DeviceHarness.exploring(urlPrefixes: ["https://example.com/docs"])
        try ok(.appOpenURL, ["url": "https://example.com/docs/intro"], harness)
        refused(.forbiddenApp, .appOpenURL, ["url": "example://chapter/23"], harness)  // sem coreografia, só a configuração

        harness.action.read.store.current = try harness.action.read.store.current
            .loading(AllowList.ChoreographyApp(bundleId: F.target, iconLabel: "Example Target", urlPrefixes: ["example://"]))
        try ok(.appOpenURL, ["url": "example://chapter/23"], harness)
        try ok(.appOpenURL, ["url": "https://example.com/docs"], harness)
        for url in ["tel:123", "TEL:123", "sms:123", "https://apps.apple.com/app/id1", "https://example.com/docs2",
                    "https://example.com/docs/../admin", "https://user@example.com/docs/x", "other://x", "example:/x y",
                    "app-settings:", "mailto:someone@example.com"] {
            refused(.forbiddenApp, .appOpenURL, ["url": .string(url)], harness)
        }
        XCTAssertEqual(harness.device.calls, [.open("https://example.com/docs/intro"), .open("example://chapter/23"),
                                              .open("https://example.com/docs")])

        // A coreografia sai: os prefixos dela também.
        harness.action.read.store.current = harness.action.read.store.current.unloaded()
        refused(.forbiddenApp, .appOpenURL, ["url": "example://chapter/23"], harness)
    }

    /// AC-1.8 (parte de `app.openURL`): na seção `scenes`, `E_FORBIDDEN_IN_TAKE` mesmo para um link permitido; na
    /// limpeza (fora de `scenes`), executa. AC-1.17: `tel:` com a coreografia carregada é `E_FORBIDDEN_APP`.
    func testAC18_openURLIsRefusedDuringScenesAndRunsInCleanup() throws {
        let harness = DeviceHarness.exploring()
        harness.action.read.store.current = try harness.action.read.store.current
            .loading(AllowList.ChoreographyApp(bundleId: F.target, iconLabel: "Example Target", urlPrefixes: ["example://"]))
        harness.scenes.set(true)
        let error = refused(.forbiddenInTake, .appOpenURL, ["url": "example://chapter/23"], harness)
        XCTAssertEqual(error?.code, -32031)
        XCTAssertEqual(harness.device.calls, [])
        harness.scenes.set(false)
        try ok(.appOpenURL, ["url": "example://chapter/23"], harness)
        refused(.forbiddenApp, .appOpenURL, ["url": "tel:123"], harness)
        XCTAssertEqual(harness.device.calls, [.open("example://chapter/23")])
    }

    /// O link aberto é exatamente o texto conferido (nada de normalização entre a conferência e a abertura).
    func testOpenURLOpensExactlyTheValidatedText() throws {
        let harness = DeviceHarness.exploring(urlPrefixes: ["example://"])
        for url in ["example://chapter/23?verse=1#v1", "example://chapter/%E2%9C%93"] {
            try ok(.appOpenURL, ["url": .string(url)], harness)
        }
        XCTAssertEqual(harness.device.calls, [.open("example://chapter/23?verse=1#v1"), .open("example://chapter/%E2%9C%93")])
        refused(.forbiddenApp, .appOpenURL, ["url": "example://chapter/✓"], harness)  // caractere inválido: não se analisa
    }

    // MARK: Revisão da T-0.8, achado 1: app.* e links releem a tela logo antes

    /// Abrir/terminar app e abrir link são ações (S1 item 11): releem a tela logo antes e, com a tela travada, o
    /// bloqueio não lido, uma camada do SpringBoard (inclusive a Central de Controle), a folha `authkit` ou algo fora da
    /// lista à frente, `E_FORBIDDEN_APP` sem agir — o bloqueio não lido é "nada se lê, age ou captura".
    func testReview1_appActionsAndLinksRereadTheScreenAndRefuseWhenLockedUnknownOrUnderALayer() throws {
        let refusedScreens = [
            Screens.locked, Screens.lockUnknown(), Screens.facts(lock: .locked, overlays: [.controlCenter]),
            Screens.notificationCenter(over: F.target), Screens.banner(over: F.target), Screens.appSwitcher(over: F.target),
            Screens.unidentified(over: F.target), Screens.springBoardLayerOverHome, Screens.controlCenter(over: F.target),
            Screens.controlCenterOverHome, Screens.proven(SystemApp.authkit), Screens.proven("com.apple.MobileSMS"),
            Screens.unknownApp, Screens.notReachable(F.target),
        ]
        for screen in refusedScreens {
            let harness = DeviceHarness.exploring(screen: screen, urlPrefixes: ["example://"])
            refused(.forbiddenApp, .appActivate, ["bundleId": .string(F.target)], harness)
            refused(.forbiddenApp, .appTerminate, ["bundleId": .string(F.target)], harness)
            refused(.forbiddenApp, .appOpenURL, ["url": "example://chapter/23"], harness)
            XCTAssertEqual(harness.device.calls, [], "nada operado com \(screen)")
            XCTAssertEqual(harness.action.read.reader.screenReads, 3, "uma releitura por comando com \(screen)")
        }
        // Permitido: um app operável provado à frente (o alvo, o hospedeiro fora de tomada) ou a tela de início limpa.
        for screen in [Screens.proven(F.target), Screens.proven(SystemApp.host), Screens.proven(SystemApp.springboard)] {
            let harness = DeviceHarness.exploring(screen: screen, urlPrefixes: ["example://"])
            try ok(.appActivate, ["bundleId": .string(F.target)], harness)
            try ok(.appTerminate, ["bundleId": .string(F.target)], harness)
            try ok(.appOpenURL, ["url": "example://chapter/23"], harness)
            XCTAssertEqual(harness.device.calls, [.activate(F.target), .terminate(F.target), .open("example://chapter/23")])
        }
        // A releitura é a última conferência: a tela trava entre a montagem do comando e o envio → nada operado.
        let late = DeviceHarness.exploring(urlPrefixes: ["example://"])
        late.action.read.reader.queue(Screens.locked)
        refused(.forbiddenApp, .appOpenURL, ["url": "example://chapter/23"], late)
        XCTAssertEqual(late.device.calls, [])
        // As recusas estáticas e a da seção scenes vêm antes, sem ler a tela.
        let early = DeviceHarness.exploring(urlPrefixes: ["example://"])
        refused(.forbiddenApp, .appActivate, ["bundleId": "com.apple.Preferences"], early)
        refused(.forbiddenApp, .appOpenURL, ["url": "tel:123"], early)
        early.scenes.set(true)
        refused(.forbiddenInTake, .appOpenURL, ["url": "example://chapter/23"], early)
        XCTAssertEqual(early.action.read.reader.screenReads, 0)
        XCTAssertEqual(early.device.calls, [])
    }

    // MARK: Revisão da T-0.8, achado 4: idioma, texto e aparência lidos a cada device.state

    func testReview4_deviceStateReadsLanguageTextSizeAndAppearanceAtEachCall() throws {
        let harness = DeviceHarness.exploring()
        harness.traits.set(LiveTraits(language: "pt", textSize: "extraLarge", appearance: .dark))
        let changed = try call(.state, harness)
        XCTAssertEqual(changed["language"], "pt")
        XCTAssertEqual(changed["textSize"], "extraLarge")
        XCTAssertEqual(changed["appearance"], "dark")
        XCTAssertEqual(changed["screenPt"], ["w": 390, "h": 844], "a tela é a da subida")
        // O que não se leu agora (nil) fica com a leitura da subida (a de session.hello).
        harness.traits.set(LiveTraits(language: nil, textSize: "small", appearance: nil))
        let partial = try call(.state, harness)
        XCTAssertEqual(partial["language"], "en")
        XCTAssertEqual(partial["textSize"], "small")
        XCTAssertEqual(partial["appearance"], "light")
        XCTAssertEqual(harness.traitReads.get(), 2, "uma leitura por device.state")
    }

    func testReview4_liveTraitMappingsNeverInventAValue() {
        XCTAssertEqual(DeviceTraits.appearance(xcuiRawValue: 1), .light)
        XCTAssertEqual(DeviceTraits.appearance(xcuiRawValue: 2), .dark)
        XCTAssertNil(DeviceTraits.appearance(xcuiRawValue: 0), "não especificada: vale a da subida")
        XCTAssertNil(DeviceTraits.appearance(xcuiRawValue: 7))
        XCTAssertEqual(DeviceTraits.liveTextSize(contentSizeCategory: "UICTContentSizeCategoryXL"), "extraLarge")
        XCTAssertNil(DeviceTraits.liveTextSize(contentSizeCategory: "_UICTContentSizeCategoryUnspecified"))
        XCTAssertNil(DeviceTraits.liveTextSize(contentSizeCategory: ""))
        XCTAssertEqual(DeviceTraits.liveLanguage(preferred: "pt-BR"), "pt")
        XCTAssertNil(DeviceTraits.liveLanguage(preferred: nil))
        XCTAssertNil(DeviceTraits.liveLanguage(preferred: ""))
    }

    // MARK: wait.for

    func testWaitForAnswersTheTimesOfTheWaitAndTimesOutWithETimeout() throws {
        let harness = DeviceHarness.exploring()
        var sleeps = 0
        harness.time.onSleep = {
            sleeps += 1
            if sleeps == 3 { harness.action.read.reader.screenState = Screens.locked }
        }
        let result = try call(.waitFor, ["condition": ["locked": true], "timeoutMs": 2000], harness)
        XCTAssertEqual(Set(result.objectValue?.keys.map(\.description) ?? []), ["tDevStartNs", "tDevEndNs"])
        let decoded = try WaitForResult.decode(result)
        XCTAssertEqual(Double(decoded.tDevEndNs.value - decoded.tDevStartNs.value), 300_000_000, accuracy: 100_000)

        let never = DeviceHarness.exploring()
        let error = refused(.timeout, .waitFor, ["condition": ["locked": true], "timeoutMs": 500], never)
        XCTAssertEqual(never.time.sleeps.count, 5)
        XCTAssertTrue(error?.message.contains("destravada") ?? false, error?.message ?? "")
    }

    // MARK: Pelo roteador

    func testMethodsAreRegisteredOnTheXCTestLaneWithStrictParams() throws {
        let harness = DeviceHarness.exploring()
        let runner = RunnerHarness(state: harness.action.read.state, extraRoutes: { router in
            DeviceMethods.register(into: &router, harness.context)
        })
        for method in DeviceMethods.Method.allCases {
            let route = try XCTUnwrap(runner.router.route(method.rawValue), method.rawValue)
            XCTAssertEqual(route.lane, .xctest, method.rawValue)
            XCTAssertEqual(route.roles, [.control], method.rawValue)
        }
        XCTAssertEqual(runner.router.route("wait.for")?.deadline(["timeoutMs": 2500, "condition": ["locked": true]]), 3.5)
        XCTAssertEqual(runner.router.route("device.lock")?.deadline(nil), 10)
        XCTAssertNil(runner.router.route("app.launch"), "app.launch não é desta tarefa")

        let client = try runner.connected()
        let state = try client.call("device.state", [:])
        XCTAssertEqual(state.rpcResult?["foregroundApp"], .string(F.target))
        XCTAssertNotNil(try client.call("device.state", nil).rpcResult, "params ausente também vale (como no runner.shutdown)")
        XCTAssertEqual(try client.call("device.home", [:]).rpcResult?["path"], "public")

        let invalid: [(String, JSONValue)] = [
            ("device.press", ["button": "power"]),
            ("device.press", [:]),
            ("device.controlCenter", ["open": true]),
            ("device.controlCenter", ["action": "toggle"]),
            ("device.state", ["verbose": true]),
            ("app.activate", ["bundleId": ""]),
            ("app.openURL", ["url": "example://x", "extra": 1]),
            ("wait.for", ["condition": ["locked": true]]),
            ("wait.for", ["condition": ["element": ["label": "Play"], "state": "changed"], "timeoutMs": 100]),
            ("wait.for", ["condition": ["locked": "yes"], "timeoutMs": 100]),
        ]
        for (method, params) in invalid {
            XCTAssertEqual(try client.call(method, params).rpcErrorCode, JSONRPCErrorCode.invalidParams.rawValue, "\(method) \(params)")
        }
        XCTAssertEqual(try client.call("device.lock", [:]).rpcErrorCode, RunnerErrorCode.capabilityMissing.code)
        XCTAssertEqual(try client.call("app.activate", ["bundleId": "com.apple.Preferences"]).rpcErrorCode,
                       RunnerErrorCode.forbiddenApp.code)
        XCTAssertEqual(harness.device.calls, [.press(.home)])
    }
}

// MARK: Aparelho falso dos métodos de aparelho e apps

/// Um `DeviceController` que só registra o que receberia; o estado dos apps é trocado pelo teste.
final class FakeDevice: DeviceController, @unchecked Sendable {
    enum Call: Equatable {
        case press(DeviceButton)
        case activate(String)
        case terminate(String)
        case open(String)
    }

    private let lock = NSLock()
    private var _calls: [Call] = []
    let states = Box<[String: AppRunState]>([:])

    var calls: [Call] { lock.withLock { _calls } }

    private func record(_ call: Call) { lock.withLock { _calls.append(call) } }

    func press(_ button: DeviceButton) throws(RpcErrorObject) { record(.press(button)) }
    func appState(_ bundleId: String) -> AppRunState? { states.get()[bundleId] }
    func activate(_ bundleId: String) throws(RpcErrorObject) { record(.activate(bundleId)) }
    func terminate(_ bundleId: String) throws(RpcErrorObject) { record(.terminate(bundleId)) }
    func openURL(_ url: URL) throws(RpcErrorObject) { record(.open(url.absoluteString)) }
}

/// O `Locker` privado (PX-1) que o runner injeta quando a sondagem o acha e `CONTRARREGRA_PRIVATE` o libera.
final class FakeLocker: Locker, @unchecked Sendable {
    private let mutex = NSLock()
    private var _count = 0

    var count: Int { mutex.withLock { _count } }

    func lock() throws(RpcErrorObject) { mutex.withLock { _count += 1 } }
}

/// O contexto dos métodos de aparelho sobre o aparelho falso da leitura e das ações, com relógio e espera falsos.
struct DeviceHarness {
    let action: ActionHarness
    let device = FakeDevice()
    let locker: FakeLocker?
    let network = Box<NetworkState?>(.online)
    let scenes = Box<Bool>(false)
    let time = FakeTime()
    /// Idioma, texto e aparência lidos agora (vazio = nada lido: valem os da subida).
    let traits = Box<LiveTraits>(LiveTraits())
    let traitReads = Box<Int>(0)

    var context: DeviceMethods.Context {
        let (time, network, scenes, traits, traitReads) = (time, network, scenes, traits, traitReads)
        let actions = ActionMethods.Context(read: action.read.context, toucher: action.toucher, scale: 3, clock: { time.clock() })
        return DeviceMethods.Context(action: actions, device: device, locker: locker, network: { network.get() },
                                     info: { RunnerHarness.device },
                                     traits: {
                                         traitReads.set(traitReads.get() + 1)
                                         return traits.get()
                                     },
                                     inScenes: { scenes.get() }, sleep: { time.sleep($0) })
    }

    static func exploring(screen: ScreenState = Screens.proven(TreeFixtures.target), apps: [String] = [], urlPrefixes: [String] = [],
                          locker: FakeLocker? = nil) -> DeviceHarness {
        let reader = FakeReader(screen: screen, trees: [
            TreeFixtures.target: TreeFixtures.reader,
            SystemApp.springboard: TreeFixtures.home,
            SystemApp.authkit: TreeFixtures.authSheet,
        ])
        let read = ReadHarness(reader: reader, allowList: AllowList(isSimulator: false, explore: TreeFixtures.target, apps: apps,
                                                                    urlPrefixes: urlPrefixes))
        return DeviceHarness(action: ActionHarness(read: read), locker: locker)
    }
}
