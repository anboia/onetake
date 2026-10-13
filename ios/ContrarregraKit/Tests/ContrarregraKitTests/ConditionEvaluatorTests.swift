import Foundation
import XCTest

@testable import ContrarregraKit

/// Condições de S0.3 (T-0.8) sobre o aparelho falso da leitura: `element` com cada `state`, `text`, `appState`,
/// `locked`, `airplane`, `network`, a composição `all`/`any`/`not` em três valores (o que não se prova nunca vale,
/// nem negado), `changed` só em `expect` (contra a leitura de antes da ação), a conferência estática da lista
/// permitida e a sondagem a cada 100 ms até o prazo de `wait.for`. As medidas no aparelho são dos spikes.
final class ConditionEvaluatorTests: XCTestCase {
    typealias F = TreeFixtures

    // MARK: Apoio

    func condition(_ json: JSONValue, file: StaticString = #filePath, line: UInt = #line) throws -> Condition {
        do {
            return try Condition.decode(json)
        } catch {
            XCTFail("condição inválida: \(error.description)", file: file, line: line)
            throw error
        }
    }

    /// A condição de um `expect` (aceita `changed`).
    func expectCondition(_ json: JSONValue) throws -> Condition {
        let sink = IssueSink()
        let parsed = Condition.read(json, at: .root, sink, allowChanged: true)
        return try XCTUnwrap(sink.isEmpty ? parsed : nil, "\(sink.issues)")
    }

    func eval(_ json: JSONValue, _ harness: ConditionHarness, file: StaticString = #filePath, line: UInt = #line) throws -> ConditionTruth {
        harness.evaluator.evaluate(try condition(json, file: file, line: line))
    }

    func assertHolds(_ json: JSONValue, _ harness: ConditionHarness, file: StaticString = #filePath, line: UInt = #line) throws {
        let truth = try eval(json, harness, file: file, line: line)
        XCTAssertEqual(truth, .holds, "\(json)", file: file, line: line)
    }

    func assertFails(_ json: JSONValue, _ harness: ConditionHarness, file: StaticString = #filePath, line: UInt = #line) throws {
        let truth = try eval(json, harness, file: file, line: line)
        guard case .fails = truth else { return XCTFail("esperava fails, veio \(truth) para \(json)", file: file, line: line) }
    }

    func assertUnknown(_ json: JSONValue, _ harness: ConditionHarness, file: StaticString = #filePath, line: UInt = #line) throws {
        let truth = try eval(json, harness, file: file, line: line)
        guard case .unknown = truth else { return XCTFail("esperava unknown, veio \(truth) para \(json)", file: file, line: line) }
    }

    /// O app alvo com um interruptor (`value` "1"), um controle deslizante e um botão de tocar/pausar.
    static func player(toggle: String? = "Play", autoplay: String = "1") -> RawNode {
        var children: [RawNode] = [
            F.node(.switch, "Autoplay", value: autoplay, 20, 120, 350, 44),
            F.node(.slider, "Speed", value: "1.0x", 20, 180, 350, 44),
        ]
        if let toggle { children.append(F.node(.button, toggle, id: "play-toggle", 170, 400, 50, 50)) }
        return F.node(.application, "Example Target", 0, 0, 390, 844, [F.node(.window, 0, 0, 390, 844, children)])
    }

    // MARK: element

    func testElementExistsAndGoneOverTheFrontApp() throws {
        let h = ConditionHarness.exploring()
        try assertHolds(["element": ["label": "Open settings"], "state": "exists"], h)
        try assertFails(["element": ["label": "Open settings"], "state": "gone"], h)
        try assertFails(["element": ["label": "Nope"], "state": "exists"], h)
        try assertHolds(["element": ["label": "Nope"], "state": "gone"], h)
        // Vários candidatos: existe (a ambiguidade só importa para quem precisa de um elemento só).
        try assertHolds(["element": ["label": "Play"], "state": "exists"], h)
        try assertFails(["element": ["label": "Play"], "state": "gone"], h)
        // Uma alternativa de fallback que resolve conta.
        try assertHolds(["element": ["label": "Nope", "fallback": [["label": "Open settings"]]], "state": "exists"], h)
    }

    func testHittableSelectedAndValueNeedASingleElement() throws {
        let h = ConditionHarness.exploring()
        try assertUnknown(["element": ["label": "Play"], "state": "hittable"], h)  // ambíguo: nenhum elemento escolhido
        try assertHolds(["element": ["label": "Play", "index": 0], "state": "hittable"], h)
        try assertFails(["element": ["label": "Play", "index": 2], "state": "hittable"], h)  // abaixo da dobra
        try assertFails(["element": ["label": "Nope"], "state": "hittable"], h)
        try assertHolds(["element": ["label": "Read"], "state": "selected"], h)
        try assertFails(["element": ["label": "Journal"], "state": "selected"], h)

        h.read.reader.setTree(F.target, Self.player())
        try assertHolds(["element": ["label": "Autoplay"], "state": "value", "equals": "1"], h)
        try assertFails(["element": ["label": "Autoplay"], "state": "value", "equals": "0"], h)
        try assertHolds(["element": ["type": "slider"], "state": "value", "equals": "1.0x"], h)
        // `state: value` sem `equals` não tem valor a comparar: nunca vale (S0.3 "tem o value dado").
        try assertUnknown(["element": ["label": "Autoplay"], "state": "value"], h)
    }

    /// Fail-closed: uma leitura recusada pela lista permitida (o app não está à frente) não prova nem que existe nem
    /// que sumiu — e negar o desconhecido continua desconhecido.
    func testARefusedReadIsUnknownNeverGoneAndNotDoesNotFlipIt() throws {
        for screen in [Screens.proven(SystemApp.springboard), Screens.locked, Screens.lockUnknown(), Screens.controlCenter(over: F.target),
                       Screens.appSwitcher(over: F.target), Screens.unknownApp] {
            let h = ConditionHarness.exploring(screen: screen)
            try assertUnknown(["element": ["label": "Open settings"], "state": "exists"], h)
            try assertUnknown(["element": ["label": "Open settings"], "state": "gone"], h)
            try assertUnknown(["not": ["element": ["label": "Open settings"], "state": "exists"]], h)
            try assertUnknown(["not": ["element": ["label": "Nope"], "state": "gone"]], h)
        }
    }

    /// Na folha do Sign in with Apple só existência e toque saem (como em `ui.find`): `value` e `selected` nunca
    /// valem, para a condição não virar oráculo do nome ou do e-mail da conta.
    func testOnTheSheetValueAndSelectedAreNeverAnOracle() throws {
        let h = ConditionHarness.exploring(screen: Screens.proven(SystemApp.authkit))
        try assertHolds(["element": ["app": "authkit", "label": "Continue"], "state": "exists"], h)
        try assertHolds(["element": ["app": "authkit", "label": "Continue"], "state": "hittable"], h)
        try assertUnknown(["element": ["app": "authkit", "label": "Share My Email"], "state": "value", "equals": "someone@example.com"], h)
        try assertUnknown(["not": ["element": ["app": "authkit", "label": "Share My Email"], "state": "value", "equals": "x"]], h)
        try assertUnknown(["element": ["app": "authkit", "label": "Continue"], "state": "selected"], h)
        // O botão com o e-mail no rótulo não é alcançável: some (não é oráculo; a leitura nunca o vê).
        try assertFails(["element": ["app": "authkit", "label": "Continue", "index": 1], "state": "exists"], h)
    }

    // MARK: text

    func testTextVisibleAndGoneAndARefusedCaptureCountsAsNotYet() throws {
        let h = ConditionHarness.exploring()
        try assertHolds(["text": ["ocr": ["text": "shepherd"], "state": "visible"]], h)
        try assertFails(["text": ["ocr": ["text": "shepherd"], "state": "gone"]], h)
        try assertHolds(["text": ["ocr": ["text": "absent"], "state": "gone"]], h)
        try assertFails(["text": ["ocr": ["text": "absent"], "state": "visible"]], h)
        XCTAssertGreaterThan(h.read.reader.captures, 0)

        // SpringBoard, tela travada, folha: nada é capturado, e a condição fica "ainda não" (S1 item 11).
        for screen in [Screens.proven(SystemApp.springboard), Screens.locked, Screens.proven(SystemApp.authkit)] {
            let refused = ConditionHarness.exploring(screen: screen)
            try assertUnknown(["text": ["ocr": ["text": "shepherd"], "state": "visible"]], refused)
            try assertUnknown(["text": ["ocr": ["text": "shepherd"], "state": "gone"]], refused)
            XCTAssertEqual(refused.read.reader.captures, 0, "nada capturado com \(screen)")
            XCTAssertTrue(refused.read.reader.recognitions.isEmpty)
        }
        // A tela muda durante a captura: a imagem é descartada sem OCR, e conta como "ainda não".
        let changing = ConditionHarness.exploring()
        changing.read.reader.screenAfterCapture = Screens.proven(SystemApp.springboard)
        try assertUnknown(["text": ["ocr": ["text": "shepherd"], "state": "visible"]], changing)
        XCTAssertTrue(changing.read.reader.recognitions.isEmpty)
    }

    // MARK: appState, locked, airplane, network

    func testAppStateReadsTheProcessStateOfAllowedNamesOnly() throws {
        let h = ConditionHarness.exploring(apps: [F.notes])
        h.states.set([F.target: .foreground, F.notes: .background, SystemApp.authkit: .notRunning])
        try assertHolds(["appState": ["app": "target", "state": "foreground"]], h)
        try assertHolds(["appState": ["app": .string(F.target), "state": "foreground"]], h)
        try assertFails(["appState": ["app": "target", "state": "background"]], h)
        try assertHolds(["appState": ["app": .string(F.notes), "state": "background"]], h)
        try assertHolds(["appState": ["app": "authkit", "state": "notRunning"]], h)
        h.states.set([:])
        try assertUnknown(["appState": ["app": "target", "state": "notRunning"]], h)  // estado desconhecido
        try assertUnknown(["not": ["appState": ["app": "target", "state": "foreground"]]], h)

        // Fora da lista (ou pessoal no aparelho): recusado na conferência estática, sem ler nada.
        for app in ["com.example.other", "com.apple.Preferences", "com.apple.MobileSMS"] {
            let json: JSONValue = ["appState": ["app": .string(app), "state": "foreground"]]
            assertRunnerError(.forbiddenApp) { () throws(RpcErrorObject) in try h.evaluator.precheck(try! self.condition(json)) }
            try assertUnknown(json, h)
        }
        XCTAssertNoThrow(try ConditionHarness.exploring(apps: ["com.apple.Preferences"], isSimulator: true).evaluator
            .precheck(condition(["appState": ["app": "com.apple.Preferences", "state": "foreground"]])), "o simulador aceita quando listado (AC-3.7)")
    }

    func testLockedIsThreeValued() throws {
        let unlocked = ConditionHarness.exploring()
        try assertHolds(["locked": false], unlocked)
        try assertFails(["locked": true], unlocked)
        let locked = ConditionHarness.exploring(screen: Screens.locked)
        try assertHolds(["locked": true], locked)
        try assertFails(["locked": false], locked)
        // `lockstate` não lida: nem travada nem destravada — o arrasto de destravar nunca é liberado por engano.
        let unknown = ConditionHarness.exploring(screen: Screens.lockUnknown())
        try assertUnknown(["locked": true], unknown)
        try assertUnknown(["locked": false], unknown)
        try assertUnknown(["not": ["locked": true]], unknown)
    }

    func testAirplaneIsReadOnlyWithTheControlCenterOpen() throws {
        let open = ConditionHarness.exploring(screen: Screens.controlCenter(over: F.target))
        open.read.reader.setTree(SystemApp.springboard, F.controlCenter)
        try assertHolds(["airplane": "off"], open)
        try assertFails(["airplane": "on"], open)
        let switchedOn = F.controlCenter.replacingValue(ofIdentifier: "airplane-mode-button", with: "1")
        open.read.reader.setTree(SystemApp.springboard, switchedOn)
        try assertHolds(["airplane": "on"], open)

        for screen in [Screens.proven(F.target), Screens.proven(SystemApp.springboard), Screens.locked] {
            let closed = ConditionHarness.exploring(screen: screen)
            closed.read.reader.setTree(SystemApp.springboard, F.controlCenter)
            try assertUnknown(["airplane": "off"], closed)
            try assertUnknown(["not": ["airplane": "on"]], closed)
        }
    }

    func testNetworkComesFromTheMonitorAndUnknownNeverHolds() throws {
        let h = ConditionHarness.exploring()
        h.network.set(.online)
        try assertHolds(["network": "online"], h)
        try assertFails(["network": "offline"], h)
        h.network.set(.offline)
        try assertHolds(["network": "offline"], h)
        h.network.set(nil)
        try assertUnknown(["network": "online"], h)
        try assertUnknown(["network": "offline"], h)
    }

    // MARK: all, any, not

    func testCompositionIsThreeValued() throws {
        let yes = ConditionTruth.holds, no = ConditionTruth.fails("f"), unknown = ConditionTruth.unknown("u")
        XCTAssertEqual(ConditionTruth.all([]), .holds)
        XCTAssertEqual(ConditionTruth.all([yes, yes]), .holds)
        XCTAssertEqual(ConditionTruth.all([yes, unknown]), unknown)
        XCTAssertEqual(ConditionTruth.all([unknown, no]), no, "um falso decide o all")
        XCTAssertEqual(ConditionTruth.any([]), .fails("any sem condições"))
        XCTAssertEqual(ConditionTruth.any([no, yes]), .holds)
        XCTAssertEqual(ConditionTruth.any([no, unknown]), unknown)
        XCTAssertEqual(ConditionTruth.any([unknown, yes]), .holds, "um verdadeiro decide o any")
        XCTAssertEqual(ConditionTruth.not(yes).holds, false)
        XCTAssertEqual(ConditionTruth.not(no), .holds)
        XCTAssertEqual(ConditionTruth.not(unknown), unknown)

        let h = ConditionHarness.exploring()
        h.network.set(.online)
        try assertHolds(["all": [["locked": false], ["element": ["label": "Open settings"], "state": "exists"], ["network": "online"]]], h)
        try assertFails(["all": [["locked": false], ["element": ["label": "Nope"], "state": "exists"]]], h)
        try assertHolds(["any": [["locked": true], ["element": ["label": "Read"], "state": "selected"]]], h)
        try assertHolds(["not": ["any": [["locked": true], ["network": "offline"]]]], h)
        h.network.set(nil)
        try assertUnknown(["all": [["locked": false], ["network": "online"]]], h)
        try assertHolds(["any": [["network": "online"], ["locked": false]]], h)
        try assertUnknown(["not": ["any": [["network": "online"], ["locked": true]]]], h)
    }

    // MARK: changed (só em expect)

    func testChangedIsRefusedOutsideExpect() {
        let json: JSONValue = ["element": ["label": "Play"], "state": "changed"]
        XCTAssertThrowsError(try Condition.decode(json))
        XCTAssertThrowsError(try Condition.decode(["all": [["not": json]]]), "em qualquer profundidade")
        XCTAssertNoThrow(try expectCondition(["all": [["not": json]]]))
        XCTAssertThrowsError(try WaitForParams.decode(["condition": json, "timeoutMs": 1000])) { error in
            XCTAssertEqual((error as? ValidationError)?.issues.first?.rule, Rule.changedOnlyInExpect.rawValue)
        }
    }

    func testChangedComparesWithTheReadingBeforeTheAction() throws {
        let changed = try expectCondition(["element": ["identifier": "play-toggle"], "state": "changed"])
        let h = ConditionHarness.exploring()
        h.read.reader.setTree(F.target, Self.player(toggle: "Play"))
        let before = h.evaluator.baseline(changed)
        XCTAssertEqual(before.readings[[]], .resolved(label: "Play", value: nil))

        guard case .fails = h.evaluator.evaluate(changed, baseline: before) else { return XCTFail("nada mudou ainda") }
        h.read.reader.setTree(F.target, Self.player(toggle: "Pause"))
        XCTAssertEqual(h.evaluator.evaluate(changed, baseline: before), .holds, "rótulo diferente do lido antes")
        h.read.reader.setTree(F.target, Self.player(toggle: nil))
        XCTAssertEqual(h.evaluator.evaluate(changed, baseline: before), .holds, "deixou de resolver")

        // Valor diferente também conta.
        let autoplay = try expectCondition(["any": [["locked": true], ["element": ["label": "Autoplay"], "state": "changed"]]])
        h.read.reader.setTree(F.target, Self.player(autoplay: "1"))
        let baseline = h.evaluator.baseline(autoplay)
        XCTAssertEqual(baseline.readings[[1]], .resolved(label: "Autoplay", value: "1"))
        guard case .fails = h.evaluator.evaluate(autoplay, baseline: baseline) else { return XCTFail("nada mudou ainda") }
        h.read.reader.setTree(F.target, Self.player(autoplay: "0"))
        XCTAssertEqual(h.evaluator.evaluate(autoplay, baseline: baseline), .holds)

        // Sem leitura de antes (ou com o alvo ausente antes), `changed` nunca vale.
        guard case .unknown = h.evaluator.evaluate(changed) else { return XCTFail("sem baseline") }
        h.read.reader.setTree(F.target, Self.player(toggle: nil))
        let absent = h.evaluator.baseline(changed)
        XCTAssertEqual(absent.readings[[]], .unresolved)
        h.read.reader.setTree(F.target, Self.player(toggle: "Pause"))
        guard case .unknown = h.evaluator.evaluate(changed, baseline: absent) else { return XCTFail("não resolvia antes") }

        // A leitura de depois recusada (o app saiu da frente): ainda não.
        h.read.reader.setTree(F.target, Self.player(toggle: "Play"))
        let resolved = h.evaluator.baseline(changed)
        h.read.reader.screenState = Screens.proven(SystemApp.springboard)
        guard case .unknown = h.evaluator.evaluate(changed, baseline: resolved) else { return XCTFail("leitura recusada") }
    }

    // MARK: Revisão da T-0.8, achado 2: text sobre o app operável à frente

    /// A captura interna da condição `text` vale com o app alvo, o hospedeiro fora de tomada ou um app de
    /// `apps.allowed` à frente (S1 item 11) — não só com o app alvo.
    func testReview2_textReadsTheOperableAppInFrontIncludingAllowedAppsAndTheHostOutsideATake() throws {
        let visible: JSONValue = ["text": ["ocr": ["text": "shepherd"], "state": "visible"]]
        let notes = ConditionHarness.exploring(screen: Screens.proven(F.notes), apps: [F.notes])
        try assertHolds(visible, notes)
        try assertHolds(["text": ["ocr": ["text": "absent"], "state": "gone"]], notes)
        XCTAssertGreaterThan(notes.read.reader.captures, 0)

        let host = ConditionHarness.exploring(screen: Screens.proven(SystemApp.host))
        try assertHolds(visible, host)

        // Sem app alvo nenhum (sem coreografia e sem app.explore), o hospedeiro à frente basta.
        let bare = ConditionHarness(read: ReadHarness(reader: FakeReader(screen: Screens.proven(SystemApp.host), trees: [:]),
                                                      allowList: AllowList(isSimulator: false)))
        XCTAssertNoThrow(try bare.evaluator.precheck(condition(visible)))
        try assertHolds(visible, bare)

        // Em tomada o hospedeiro sai da lista; um app fora da lista à frente: nada é capturado.
        let inTake = ConditionHarness.exploring(screen: Screens.proven(SystemApp.host))
        inTake.read.store.current.inTake = true
        try assertUnknown(visible, inTake)
        let outside = ConditionHarness.exploring(screen: Screens.proven(F.notes))  // notes fora de apps.allowed
        try assertUnknown(visible, outside)
        try assertUnknown(["text": ["ocr": ["text": "absent"], "state": "gone"]], outside)
        XCTAssertEqual(inTake.read.reader.captures + outside.read.reader.captures, 0)

        // Um `within` com app explícito fora da lista continua recusado na conferência estática.
        assertRunnerError(.forbiddenApp) { () throws(RpcErrorObject) in
            try notes.evaluator.precheck(try! self.condition(["text": ["ocr": ["text": "x", "within": ["app": "com.apple.Passbook", "label": "y"]],
                                                                       "state": "visible"]]))
        }
    }

    // MARK: Revisão da T-0.8, achado 3: ambiguidade em qualquer passo da resolução

    /// Uma âncora ambígua em qualquer passo (inclusive numa alternativa de `fallback`, ou no fallback de uma âncora) não
    /// deixa concluir "não resolve": `gone`, `not exists` e `hittable` ficam desconhecidos.
    func testReview3_anAmbiguousAnchorAnywhereInTheResolutionIsUnknownNeverGone() throws {
        let h = ConditionHarness.exploring()
        let masked: JSONValue = ["label": "Nope", "fallback": [["label": "Psalms 23", "below": ["label": "Play"]]]]
        let nested: JSONValue = ["label": "Nope", "fallback": [["label": "Psalms 23", "below": ["label": "Nope2", "fallback": [["label": "Play"]]]]]]
        let withinAmbiguous: JSONValue = ["label": "Nope", "fallback": [["label": "Play", "within": ["type": "cell"]]]]
        for target in [masked, nested, withinAmbiguous] {
            try assertUnknown(["element": target, "state": "gone"], h)
            try assertUnknown(["not": ["element": target, "state": "exists"]], h)
            try assertUnknown(["element": target, "state": "exists"], h)
            try assertUnknown(["element": target, "state": "hittable"], h)
            let changed = try expectCondition(["element": target, "state": "changed"])
            guard case .unknown = h.evaluator.baseline(changed).readings[[]] else { return XCTFail("leitura de antes incerta: \(target)") }
        }
        // Sem ambiguidade: a âncora que não existe deixa o alvo provadamente ausente.
        let absent: JSONValue = ["label": "Nope", "fallback": [["label": "Psalms 23", "below": ["label": "Nope2"]]]]
        try assertHolds(["element": absent, "state": "gone"], h)
        // Uma alternativa seguinte que resolve conta, como nas ações (S0.2: o fallback é tentado quando o primário não resolve).
        let resolves: JSONValue = ["label": "Psalms 23", "below": ["label": "Play"], "fallback": [["label": "Open settings"]]]
        try assertHolds(["element": resolves, "state": "exists"], h)
        try assertFails(["element": resolves, "state": "gone"], h)
    }

    // MARK: Conferência estática

    func testPrecheckRefusesWhatCouldNeverBeReadWithoutReadingTheScreen() throws {
        let h = ConditionHarness.exploring()
        let refused: [JSONValue] = [
            ["element": ["app": "com.apple.Preferences", "label": "General"], "state": "exists"],
            ["element": ["app": "com.example.other", "label": "x"], "state": "gone"],
            ["element": ["label": "x", "fallback": [["app": "com.apple.MobileSMS", "label": "y"]]], "state": "exists"],
            ["element": ["label": "x", "within": ["app": "com.apple.mobilemail", "label": "y"]], "state": "exists"],
            ["element": ["app": "authkit", "labelContains": "@"], "state": "exists"],
            ["text": ["ocr": ["text": "x", "within": ["app": "com.apple.Passbook", "label": "y"]], "state": "visible"]],
            ["any": [["locked": true], ["not": ["appState": ["app": "com.apple.mobilephone", "state": "foreground"]]]]],
        ]
        for json in refused {
            assertRunnerError(.forbiddenApp) { () throws(RpcErrorObject) in try h.evaluator.precheck(try! self.condition(json)) }
        }
        XCTAssertEqual(h.read.reader.screenReads, 0, "a conferência estática não lê a tela")

        // Sem coreografia e sem app.explore não há app alvo.
        let none = ConditionHarness(read: ReadHarness(reader: FakeReader(), allowList: AllowList(isSimulator: false)))
        assertRunnerError(.forbiddenApp) { () throws(RpcErrorObject) in
            try none.evaluator.precheck(try! self.condition(["element": ["label": "x"], "state": "exists"]))
        }
        XCTAssertNoThrow(try none.evaluator.precheck(condition(["all": [["locked": false], ["network": "online"], ["airplane": "on"]]])))
        XCTAssertNoThrow(try h.evaluator.precheck(condition(["element": ["app": "springboard", "label": "Example Target"], "state": "exists"])))
    }

    // MARK: Sondagem até o prazo (wait.for)

    func testWaitPollsEvery100MsUntilTheDeadlineThenTimesOut() throws {
        let h = ConditionHarness.exploring()
        let time = FakeTime()
        let error = assertRunnerError(.timeout) { () throws(RpcErrorObject) in
            try h.evaluator.wait(for: try! self.condition(["element": ["label": "Nope"], "state": "exists"]), timeoutMs: 300,
                                 clock: time.clock, sleep: time.sleep)
        }
        XCTAssertEqual(error?.code, -32020)
        XCTAssertTrue(error?.message.contains("300 ms") ?? false, error?.message ?? "")
        XCTAssertTrue(error?.message.contains("4 sondagens") ?? false, "sondagens em 0, 100, 200 e 300 ms: \(error?.message ?? "")")
        XCTAssertEqual(time.sleeps.count, 3)
        for sleep in time.sleeps { XCTAssertEqual(Double(sleep), 100_000_000, accuracy: 10_000) }

        // Um prazo que não cai num múltiplo de 100 ms ganha uma última sondagem no próprio prazo.
        let odd = FakeTime()
        assertRunnerError(.timeout) { () throws(RpcErrorObject) in
            try h.evaluator.wait(for: try! self.condition(["locked": true]), timeoutMs: 250, clock: odd.clock, sleep: odd.sleep)
        }
        XCTAssertEqual(odd.sleeps.count, 3)
        XCTAssertEqual(Double(odd.sleeps[2]), 50_000_000, accuracy: 10_000)
    }

    func testWaitReturnsOnThePollThatHolds() throws {
        let h = ConditionHarness.exploring()
        let time = FakeTime()
        var sleeps = 0
        time.onSleep = {
            sleeps += 1
            if sleeps == 2 { h.read.reader.screenState = Screens.locked }
        }
        let (start, end) = try h.evaluator.wait(for: condition(["locked": true]), timeoutMs: 3000, clock: time.clock, sleep: time.sleep)
        XCTAssertEqual(time.sleeps.count, 2, "valeu na 3.ª sondagem")
        XCTAssertEqual(Double(end - start), 200_000_000, accuracy: 100_000)

        let first = FakeTime()
        let (s0, e0) = try h.evaluator.wait(for: condition(["locked": true]), timeoutMs: 3000, clock: first.clock, sleep: first.sleep)
        XCTAssertTrue(first.sleeps.isEmpty)
        XCTAssertLessThanOrEqual(s0, e0)
    }

    func testWaitWithZeroTimeoutEvaluatesOnce() throws {
        let h = ConditionHarness.exploring()
        let time = FakeTime()
        assertRunnerError(.timeout) { () throws(RpcErrorObject) in
            try h.evaluator.wait(for: try! self.condition(["locked": true]), timeoutMs: 0, clock: time.clock, sleep: time.sleep)
        }
        XCTAssertTrue(time.sleeps.isEmpty)
        XCTAssertEqual(h.read.reader.screenReads, 1)
        XCTAssertNoThrow(try h.evaluator.wait(for: condition(["locked": false]), timeoutMs: 0, clock: time.clock, sleep: time.sleep))
    }

    func testWaitRefusesForbiddenNamesBeforeAnyPoll() throws {
        let h = ConditionHarness.exploring()
        let time = FakeTime()
        assertRunnerError(.forbiddenApp) { () throws(RpcErrorObject) in
            try h.evaluator.wait(for: try! self.condition(["element": ["app": "com.apple.Preferences", "label": "x"], "state": "gone"]),
                                 timeoutMs: 5000, clock: time.clock, sleep: time.sleep)
        }
        XCTAssertTrue(time.sleeps.isEmpty)
        XCTAssertEqual(h.read.reader.screenReads, 0)
    }
}

// MARK: Apoio das condições

/// Um valor trocado pelo teste e lido pelos fechos `@Sendable` das fontes.
final class Box<Value: Sendable>: @unchecked Sendable {
    private let lock = NSLock()
    private var value: Value

    init(_ value: Value) { self.value = value }

    func set(_ newValue: Value) { lock.withLock { value = newValue } }
    func get() -> Value { lock.withLock { value } }
}

/// As fontes das condições sobre o aparelho falso da leitura: estados de app e rede trocados pelo teste.
struct ConditionHarness {
    let read: ReadHarness
    let states = Box<[String: AppRunState]>([:])
    let network = Box<NetworkState?>(.online)

    var sources: ConditionSources {
        let (states, network) = (states, network)
        return ConditionSources(read: read.context, appState: { states.get()[$0] }, network: { network.get() })
    }

    var evaluator: ConditionEvaluator { ConditionEvaluator(sources) }

    static func exploring(screen: ScreenState = Screens.proven(TreeFixtures.target), apps: [String] = [],
                          isSimulator: Bool = false) -> ConditionHarness {
        ConditionHarness(read: ReadHarness.exploring(screen: screen, apps: apps, isSimulator: isSimulator))
    }
}

/// Relógio D e espera falsos: cada leitura do relógio avança 1 µs; `sleep` avança o tempo pedido e o registra.
final class FakeTime: @unchecked Sendable {
    private let lock = NSLock()
    private var now: UInt64 = 1_000_000_000
    private var _sleeps: [UInt64] = []
    /// Chamado depois de cada espera (a tela muda entre sondagens).
    var onSleep: (() -> Void)?

    func clock() -> UInt64 {
        lock.withLock {
            now += 1_000
            return now
        }
    }

    func sleep(_ ns: UInt64) {
        lock.withLock {
            now += ns
            _sleeps.append(ns)
        }
        onSleep?()
    }

    var sleeps: [UInt64] { lock.withLock { _sleeps } }
}

extension RawNode {
    /// A mesma árvore com o `value` do nó de identificador `identifier` trocado.
    func replacingValue(ofIdentifier identifier: String, with value: String) -> RawNode {
        RawNode(type: type, label: label, identifier: self.identifier, value: self.identifier == identifier ? value : self.value,
                frame: frame, enabled: enabled, selected: selected, focused: focused,
                children: children.map { $0.replacingValue(ofIdentifier: identifier, with: value) })
    }
}
