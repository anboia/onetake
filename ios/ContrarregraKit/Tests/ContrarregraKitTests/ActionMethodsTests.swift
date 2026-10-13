import Foundation
import XCTest

@testable import ContrarregraKit

/// Ações `ui.*` (S1 itens 4 e 5; T-0.7) sobre um aparelho falso: recusas de `ui.type` (campo seguro, texto com cara
/// de credencial, tela de autenticação do sistema; AC-1.7, AC-1.19, E-1.5), validação de `ui.drag` (S0.4: velocity
/// XOR durationMs; `via` só com PX-3), lista permitida antes de qualquer toque, geometria da rolagem e os tempos de
/// S0.5. As medidas no aparelho são dos spikes.
final class ActionMethodsTests: XCTestCase {
    typealias F = TreeFixtures

    // MARK: Apoio

    func call(_ method: ActionMethods.Method, _ params: JSONValue, _ harness: ActionHarness) throws(RpcErrorObject) -> UiActionResult {
        let context = harness.context
        func decode<M: JSONModel>(_ type: M.Type) throws(RpcErrorObject) -> M {
            do { return try M.decode(params) } catch { throw RpcErrorObject(.invalidParams, error.description) }
        }
        switch method {
        case .tap: return try ActionMethods.tap(decode(UiTargetParams.self), context)
        case .doubleTap: return try ActionMethods.doubleTap(decode(UiTargetParams.self), context)
        case .longPress: return try ActionMethods.longPress(decode(UiLongPressParams.self), context)
        case .drag: return try ActionMethods.drag(decode(UiDragParams.self), context)
        case .scrollTo: return try ActionMethods.scrollTo(decode(UiScrollToParams.self), context)
        case .type: return try ActionMethods.type(decode(UiTypeParams.self), context)
        }
    }

    func ok(_ method: ActionMethods.Method, _ params: JSONValue, _ harness: ActionHarness,
            file: StaticString = #filePath, line: UInt = #line) throws -> UiActionResult {
        do {
            let result = try call(method, params, harness)
            // A resposta tem a forma estrita de S0.5 (a mesma do `UiActionResultSchema` do Mac).
            XCTAssertEqual(try UiActionResult.decode(result.json), result, file: file, line: line)
            XCTAssertLessThanOrEqual(result.tDevStartNs, result.tDispatchNs, file: file, line: line)
            XCTAssertLessThanOrEqual(result.tDispatchNs, result.tDevEndNs, file: file, line: line)
            XCTAssertEqual(result.path, .public, "caminho público (PX-2/PX-3 ficam para o SP-3)", file: file, line: line)
            return result
        } catch {
            XCTFail("\(method.rawValue) falhou: \(error.message)", file: file, line: line)
            throw error
        }
    }

    @discardableResult
    func refused(_ code: RunnerErrorCode, _ method: ActionMethods.Method, _ params: JSONValue, _ harness: ActionHarness,
                 file: StaticString = #filePath, line: UInt = #line) -> RpcErrorObject? {
        assertRunnerError(code, file: file, line: line) { () throws(RpcErrorObject) in try call(method, params, harness) }
    }

    /// Um formulário do app alvo: título (campo de texto), texto (área de texto), opcionalmente um campo seguro e o
    /// teclado.
    static func form(focused: ElementType? = nil, secure: Bool = false, keyboard: Bool = false) -> RawNode {
        var fields: [RawNode] = [
            RawNode(type: .textField, label: "Title", frame: Rect(x: 20, y: 120, w: 350, h: 44), focused: focused == .textField),
            RawNode(type: .textView, label: "Entry", frame: Rect(x: 20, y: 180, w: 350, h: 200), focused: focused == .textView),
            F.node(.button, "Save", 300, 400, 70, 44),
        ]
        if secure {
            fields.append(RawNode(type: .secureTextField, label: "Passcode", value: "••••", frame: Rect(x: 20, y: 460, w: 350, h: 44),
                                  focused: focused == .secureTextField))
        }
        if keyboard { fields.append(F.node(.keyboard, 0, 544, 390, 300)) }
        return F.node(.application, "Example Target", 0, 0, 390, 844, [F.node(.window, 0, 0, 390, 844, fields)])
    }

    // MARK: ui.type — recusas (AC-1.7, AC-1.19, E-1.5, P-3)

    func testAC17_secureFieldInFocusIsRefusedAndNoKeyIsSent() {
        let harness = ActionHarness.exploring(tree: Self.form(focused: .secureTextField, secure: true, keyboard: true))
        let error = refused(.secureField, .type, ["text": "hello"], harness)
        XCTAssertEqual(error?.code, -32021)
        XCTAssertEqual(harness.toucher.gestures, [], "nenhuma tecla, nenhum toque")
    }

    func testAC17_secureTargetIsRefusedBeforeAnyTouch() {
        let harness = ActionHarness.exploring(tree: Self.form(secure: true))
        refused(.secureField, .type, ["target": ["label": "Passcode"], "text": "1234"], harness)
        refused(.secureField, .type, ["target": ["type": "secureTextField"], "text": "1234"], harness)
        XCTAssertEqual(harness.toucher.gestures, [], "o campo seguro não chega nem a receber o toque de foco")
    }

    /// Revisão da T-0.7, achado 2: o campo seguro vence a resolução — abaixo da dobra (seria E_TARGET_NOT_HITTABLE),
    /// repetido (seria E_TARGET_AMBIGUOUS) ou pedido pelo seletor — sempre E_SECURE_FIELD, sem tocar nada.
    func testASecureFieldIsRefusedBeforeResolutionEvenOffscreenOrAmbiguous() {
        func login(_ secure: [RawNode]) -> RawNode {
            F.node(.application, "Example Target", 0, 0, 390, 844, [F.node(.window, 0, 0, 390, 844, [
                RawNode(type: .textField, label: "Title", frame: Rect(x: 20, y: 120, w: 350, h: 44)),
            ] + secure)])
        }
        let belowTheFold = ActionHarness.exploring(tree: login([
            RawNode(type: .secureTextField, label: "Password", frame: Rect(x: 20, y: 900, w: 350, h: 44)),
        ]))
        refused(.secureField, .type, ["target": ["label": "Password"], "text": "hunter2"], belowTheFold)
        refused(.secureField, .type, ["target": ["type": "secureTextField"], "text": "hunter2"], belowTheFold)
        refused(.secureField, .type, ["target": ["label": "Title"], "text": "notes"], belowTheFold)
        XCTAssertEqual(belowTheFold.toucher.gestures, [])

        let twice = ActionHarness.exploring(tree: login([
            RawNode(type: .secureTextField, label: "Password", frame: Rect(x: 20, y: 300, w: 350, h: 44)),
            RawNode(type: .secureTextField, label: "Password", frame: Rect(x: 20, y: 360, w: 350, h: 44)),
        ]))
        refused(.secureField, .type, ["target": ["label": "Password"], "text": "hunter2"], twice)
        refused(.secureField, .type, ["target": ["type": "secureTextField", "index": 1], "text": "hunter2"], twice)
        XCTAssertEqual(twice.toucher.gestures, [])

        // O seletor pede um campo seguro (o alvo ou uma alternativa de fallback): recusado sem ler a árvore.
        let plain = ActionHarness.exploring(tree: login([]))
        refused(.secureField, .type, ["target": ["type": "secureTextField"], "text": "x"], plain)
        refused(.secureField, .type, ["target": ["label": "Nope", "fallback": [["type": "secureTextField"]]], "text": "x"], plain)
        XCTAssertTrue(plain.read.reader.snapshots.isEmpty)
        XCTAssertEqual(plain.toucher.gestures, [])
    }

    func testE15_emptyTextIsRefusedTooWithoutSendingAKey() {
        let harness = ActionHarness.exploring(tree: Self.form(focused: .secureTextField, secure: true, keyboard: true))
        refused(.secureField, .type, ["text": ""], harness)
        refused(.secureField, .type, ["target": ["label": "Passcode"], "text": ""], harness)
        XCTAssertEqual(harness.toucher.gestures, [])
    }

    /// Fail-closed: o `hasFocus` público não prova onde está o foco do teclado; com um campo seguro na árvore, nada
    /// se digita, nem num campo comum que diz ter o foco.
    func testAnySecureFieldInTheFrontAppRefusesTyping() {
        let harness = ActionHarness.exploring(tree: Self.form(focused: .textField, secure: true, keyboard: true))
        refused(.secureField, .type, ["text": "My notes"], harness)
        refused(.secureField, .type, ["target": ["label": "Title"], "text": "My notes"], harness)
        XCTAssertEqual(harness.toucher.gestures, [])
    }

    func testAC119_emailLikeTextIsRefusedInAPlainFieldBeforeReadingTheScreen() {
        let harness = ActionHarness.exploring(tree: Self.form(focused: .textField, keyboard: true))
        for text in ["someone@icloud.com", "Apple ID: Someone.Else+tag@icloud.com please", "SOMEONE@ICLOUD.COM"] {
            let error = refused(.secureField, .type, ["text": .string(text)], harness)
            XCTAssertFalse(error?.message.contains("icloud") ?? true, "a mensagem nunca repete o texto")
            XCTAssertFalse(error?.message.lowercased().contains("someone") ?? true)
        }
        XCTAssertEqual(harness.toucher.gestures, [])
        XCTAssertEqual(harness.read.reader.screenReads, 0, "o texto é recusado antes de ler a tela")
        XCTAssertTrue(harness.read.reader.snapshots.isEmpty)
    }

    func testCredentialLikeTextIsAnEmailAnywhereEvenWithLookalikesOrInvisibleCharacters() {
        for text in ["someone@icloud.com", "write to someone@example.org now", "a@b.co", "someone＠icloud．com",
                     "some\u{200B}one@icloud.com", "someone@\u{200B}icloud.com", "someone\u{FE6B}icloud.com",
                     "user.name+tag@sub.example.co.uk"] {
            XCTAssertTrue(TypeGuard.looksLikeCredential(text), text)
        }
        for text in ["", "Psalm 23", "Meet @ 5 pm", "@handle", "user@localhost", "price: 5.00", "The Lord is my shepherd"] {
            XCTAssertFalse(TypeGuard.looksLikeCredential(text), text)
        }
    }

    func assertSecureText(_ text: String, file: StaticString = #filePath, line: UInt = #line) {
        do {
            try TypeGuard.checkText(text)
            XCTFail("aceitou \(text.debugDescription)", file: file, line: line)
        } catch {
            XCTAssertEqual(error.code, RunnerErrorCode.secureField.code, "\(text.debugDescription): \(error.message)", file: file, line: line)
        }
    }

    /// Revisão da T-0.7, achado 1: tecla de controle no meio do texto não pode quebrar a regex e deixar o campo com o
    /// e-mail (o XCTest digita "someone", aperta Return, digita "@icloud.com"). A regex roda sobre o texto cru, sem os
    /// controles e com cada controle trocado por espaço; os controles que editam o campo são recusados sempre.
    func testControlCharactersInsideAnEmailOrAppleIdCannotSlipPastTheCredentialCheck() {
        let controls = ["\n", "\t", "\r", "\u{8}", "\u{7f}"]
        for credential in ["someone@icloud.com", "appleid.user@me.com"] {
            let scalars = Array(credential)
            for control in controls {
                for cut in [1, scalars.firstIndex(of: "@")!, scalars.firstIndex(of: "@")! + 1, scalars.lastIndex(of: ".")!,
                            scalars.count - 1] {
                    let text = String(scalars[..<cut]) + control + String(scalars[cut...])
                    assertSecureText(text)
                    XCTAssertTrue(TypeGuard.looksLikeCredential(text), "o e-mail aparece sem os controles: \(text.debugDescription)")
                }
                let mixed = "some" + control + "one" + control + "@" + control + "icloud" + control + "." + control + "com"
                assertSecureText(mixed)
            }
        }
        let harness = ActionHarness.exploring(tree: Self.form(focused: .textField, keyboard: true))
        for text in ["someone\n@icloud.com", "someone\t@icloud.com", "someone@\nicloud.com", "someone\r@icloud.com",
                     "someone@icloud\u{8}.com", "x\u{8}\u{8}someone@icloud.com"] {
            refused(.secureField, .type, ["text": .string(text)], harness)
        }
        XCTAssertEqual(harness.toucher.gestures, [], "nenhuma tecla")
        XCTAssertEqual(harness.read.reader.screenReads, 0, "recusado antes de ler a tela")
    }

    func testControlCharactersThatEditTheFieldAreAlwaysRefusedButNewlineAndTabArePlainText() throws {
        for text in ["abc\u{8}", "\u{7f}", "\r", "Line\r\nnext", "x\u{1b}", "\u{0}", "a\u{85}b", "a\u{9f}", "\u{1f}"] {
            assertSecureText(text)
        }
        for text in ["Line 1\nLine 2", "a\tb", "Psalm 23\n", ""] {
            XCTAssertNoThrow(try TypeGuard.checkText(text), text.debugDescription)
        }
        XCTAssertFalse(TypeGuard.isEditingControl("\n"))
        XCTAssertFalse(TypeGuard.isEditingControl("\t"))
        XCTAssertTrue(TypeGuard.isEditingControl("\r"))
        XCTAssertTrue(TypeGuard.isEditingControl("\u{8}"))
        XCTAssertTrue(TypeGuard.isEditingControl("\u{7f}"))
        XCTAssertTrue(TypeGuard.isEditingControl("\u{80}"))
        XCTAssertFalse(TypeGuard.isEditingControl("\u{a0}"))
        let harness = ActionHarness.exploring(tree: Self.form(focused: .textView, keyboard: true))
        _ = try ok(.type, ["text": "Line 1\nLine 2\tend"], harness)
        XCTAssertEqual(harness.toucher.gestures, [.type("Line 1\nLine 2\tend", app: F.target)])
    }

    func testSystemAuthenticationScreensInFrontAreSecureFieldAndNothingIsRead() {
        let screens = [Screens.proven(SystemApp.authkit), Screens.proven(SystemApp.springboard), Screens.locked,
                       Screens.controlCenter(over: F.target), Screens.controlCenterOverHome, Screens.banner(over: F.target),
                       Screens.appSwitcher(over: F.target), Screens.unidentified(over: F.target)]
        for screen in screens {
            let harness = ActionHarness.exploring(screen: screen, tree: Self.form(focused: .textField, keyboard: true))
            refused(.secureField, .type, ["text": "hello"], harness)
            refused(.secureField, .type, ["target": ["app": "authkit", "label": "Continue"], "text": "hello"], harness)
            refused(.secureField, .type, ["target": ["label": "Title"], "text": "hello"], harness)
            XCTAssertEqual(harness.toucher.gestures, [], "\(screen)")
            XCTAssertTrue(harness.read.reader.snapshots.isEmpty, "nenhuma árvore lida com \(screen) à frente")
        }
    }

    func testTypingWithAnAppOutsideTheListInFrontIsForbidden() {
        for screen in [Screens.proven("com.apple.Preferences"), Screens.unknownApp, Screens.notReachable(F.target),
                       Screens.lockUnknown()] {
            let harness = ActionHarness.exploring(screen: screen, tree: Self.form(focused: .textField, keyboard: true))
            refused(.forbiddenApp, .type, ["text": "hello"], harness)
            XCTAssertEqual(harness.toucher.gestures, [])
        }
    }

    func testTypingWithoutAFocusedFieldIsNoFocus() {
        let harness = ActionHarness.exploring(tree: Self.form())
        refused(.noFocus, .type, ["text": "hello"], harness)
        // Teclado na tela sem campo com `hasFocus`: sem target não se sabe onde o texto cai.
        harness.read.reader.setTree(F.target, Self.form(keyboard: true))
        refused(.noFocus, .type, ["text": "hello"], harness)
        XCTAssertEqual(harness.toucher.gestures, [])
    }

    // MARK: ui.type — digitação

    func testTypingIntoTheFocusedFieldSendsTheTextOnceAndReportsTheFieldCenter() throws {
        let harness = ActionHarness.exploring(tree: Self.form(focused: .textView, keyboard: true))
        let result = try ok(.type, ["text": "The Lord is my shepherd"], harness)
        XCTAssertEqual(harness.toucher.gestures, [.type("The Lord is my shepherd", app: F.target)])
        XCTAssertEqual(result.point, AbsolutePoint(x: 195, y: 280))
        XCTAssertNil(result.nodeRef)
    }

    func testTypingIntoATargetTapsItToFocusThenSendsTheText() throws {
        let harness = ActionHarness.exploring(tree: Self.form())
        harness.toucher.onTap = { _ in harness.read.reader.setTree(F.target, Self.form(focused: .textField, keyboard: true)) }
        let result = try ok(.type, ["target": ["label": "Title"], "text": "Morning"], harness)
        XCTAssertEqual(harness.toucher.gestures, [.tap(AbsolutePoint(x: 195, y: 142)), .type("Morning", app: F.target)])
        XCTAssertEqual(result.point, AbsolutePoint(x: 195, y: 142))
        XCTAssertNotNil(result.nodeRef)
        // Só o teclado (o `hasFocus` pode não dizer nada no iPhone): basta, com o toque no alvo.
        let keyboardOnly = ActionHarness.exploring(tree: Self.form())
        keyboardOnly.toucher.onTap = { _ in keyboardOnly.read.reader.setTree(F.target, Self.form(keyboard: true)) }
        _ = try ok(.type, ["target": ["label": "Entry"], "text": "x"], keyboardOnly)
        XCTAssertEqual(keyboardOnly.toucher.gestures.last, .type("x", app: F.target))
    }

    /// O que muda com o toque de foco (um alerta com senha, a folha do Sign in with Apple, o teclado que não veio) é
    /// conferido de novo antes de qualquer tecla.
    func testTheFocusTapIsFollowedByAFreshCheckBeforeAnyKey() {
        let alert = ActionHarness.exploring(tree: Self.form())
        alert.toucher.onTap = { _ in alert.read.reader.setTree(F.target, Self.form(focused: .secureTextField, secure: true, keyboard: true)) }
        refused(.secureField, .type, ["target": ["label": "Title"], "text": "hello"], alert)
        XCTAssertEqual(alert.toucher.gestures, [.tap(AbsolutePoint(x: 195, y: 142))], "o toque, nenhuma tecla")

        let sheet = ActionHarness.exploring(tree: Self.form())
        sheet.toucher.onTap = { _ in sheet.read.reader.screenState = Screens.proven(SystemApp.authkit) }
        refused(.secureField, .type, ["target": ["label": "Title"], "text": "hello"], sheet)
        XCTAssertEqual(sheet.toucher.gestures.count, 1)

        let other = ActionHarness.exploring(tree: Self.form(), apps: [F.notes])
        other.toucher.onTap = { _ in other.read.reader.screenState = Screens.proven(F.notes) }
        refused(.forbiddenApp, .type, ["target": ["label": "Title"], "text": "hello"], other)
        XCTAssertEqual(other.toucher.gestures.count, 1)

        let unfocused = ActionHarness.exploring(tree: Self.form())
        refused(.noFocus, .type, ["target": ["label": "Title"], "text": "hello"], unfocused)
        XCTAssertEqual(unfocused.toucher.gestures.count, 1)
    }

    func testTypeParams() throws {
        XCTAssertEqual(try UiTypeParams.decode(["text": ""]), UiTypeParams(text: ""))
        XCTAssertThrowsError(try UiTypeParams.decode([:]))
        XCTAssertThrowsError(try UiTypeParams.decode(["text": 1]))
        XCTAssertThrowsError(try UiTypeParams.decode(["text": "a", "secure": false]))
    }

    // MARK: ui.drag — validação (S0.4, S1 item 4)

    func dragIssues(_ params: JSONValue) -> [ValidationIssue] {
        do {
            _ = try UiDragParams.decode(params)
            return []
        } catch {
            return error.issues
        }
    }

    func testDragVelocityAndDurationAreExclusiveAndOneIsRequired() throws {
        let base: JSONObject = ["from": ["nx": 0.5, "ny": 0.6], "to": ["x": 195, "y": 300], "pressMs": 60, "holdMs": 0]
        var both = base
        both["velocity"] = 350
        both["durationMs"] = 500
        XCTAssertEqual(dragIssues(.object(both)),
                       [ValidationIssue(path: "durationMs", rule: "S0.4/velocity-xor-durationMs",
                                        message: "drag com velocity e durationMs juntos; são excludentes (S0.4)")])
        XCTAssertEqual(dragIssues(.object(base)).map(\.rule), ["S0.4/velocity-xor-durationMs"])
        XCTAssertEqual(dragIssues(.object(base)).map(\.path), [""])

        var velocity = base
        velocity["velocity"] = 350
        XCTAssertEqual(try UiDragParams.decode(.object(velocity)).motion, .velocity(350))
        var duration = base
        duration["durationMs"] = 500
        let decoded = try UiDragParams.decode(.object(duration))
        XCTAssertEqual(decoded.motion, .durationMs(500))
        XCTAssertEqual(decoded.from, .point(.normalized(nx: 0.5, ny: 0.6)))
        XCTAssertEqual(decoded.to, .point(.absolute(x: 195, y: 300)))
        XCTAssertEqual(try UiDragParams.decode(decoded.json), decoded, "volta igual pelo JSON")
    }

    func testDragFieldRulesMatchTheDragStep() {
        let ok: JSONObject = ["from": ["label": "Verse 1"], "to": ["label": "Verse 1", "offset": ["dx": 0, "dy": 200]],
                              "velocity": 1000, "pressMs": 0, "holdMs": 0]
        XCTAssertEqual(dragIssues(.object(ok)), [], "a forma do AC-0.7 com alvos")
        func with(_ key: String, _ value: JSONValue?) -> JSONValue {
            var copy = ok
            copy[JSONKey(key)] = value
            return .object(copy)
        }
        XCTAssertEqual(dragIssues(with("pressMs", nil)).map(\.rule), ["required"])
        XCTAssertEqual(dragIssues(with("holdMs", nil)).map(\.rule), ["required"])
        XCTAssertEqual(dragIssues(with("from", nil)).map(\.rule), ["required"])
        XCTAssertEqual(dragIssues(with("velocity", 0)).map(\.rule), ["range"], "velocity > 0")
        XCTAssertEqual(dragIssues(with("pressMs", -1)).map(\.rule), ["range"])
        XCTAssertEqual(dragIssues(with("holdMs", 1.5)).map(\.rule), ["type"])
        XCTAssertEqual(dragIssues(with("extra", true)).map(\.rule), ["unknown-field"])
        XCTAssertEqual(dragIssues(with("to", ["x": 1, "nx": 0.5])).map(\.rule), ["S0.2/point-form"])
        XCTAssertEqual(dragIssues(with("via", [["x": 1, "y": 2], ["label": "Play"]])), [])
        var duration = ok
        duration["velocity"] = nil
        duration["durationMs"] = 0
        XCTAssertEqual(dragIssues(.object(duration)).map(\.rule), ["range"], "durationMs > 0")
    }

    func testDragViaNeedsThePrivatePathAndOtherwiseIsCapabilityMissingBeforeReadingAnything() {
        let harness = ActionHarness.exploring()
        let params: JSONValue = ["from": ["x": 100, "y": 300], "to": ["x": 100, "y": 600], "via": [["x": 200, "y": 450]],
                                 "pressMs": 50, "velocity": 600, "holdMs": 0]
        let error = refused(.capabilityMissing, .drag, params, harness)
        XCTAssertEqual(error?.code, -32030)
        XCTAssertEqual(harness.toucher.gestures, [])
        XCTAssertEqual(harness.read.reader.screenReads, 0)
    }

    func testDragVelocityIsConvertedToXCUIGestureVelocityByTheScreenScale() {
        let a = AbsolutePoint(x: 100, y: 500), b = AbsolutePoint(x: 100, y: 400)
        XCTAssertEqual(DragGesture.gestureVelocity(.velocity(350), path: [a, b], scale: 3), 1050)
        XCTAssertEqual(DragGesture.gestureVelocity(.durationMs(500), path: [a, b], scale: 3), 600, "100 pt em 0,5 s = 200 pt/s")
        XCTAssertEqual(DragGesture.gestureVelocity(.durationMs(500), path: [a, AbsolutePoint(x: 160, y: 580)], scale: 2), 400)
        XCTAssertEqual(DragGesture.gestureVelocity(.durationMs(1000), path: [a, b, a], scale: 3), 600, "via conta no comprimento")
        XCTAssertNil(DragGesture.gestureVelocity(.durationMs(500), path: [a, a], scale: 3), "sem distância, a velocidade não importa")
    }

    /// Com um `Toucher` que aceite `via` (o privado do SP-3), cada ponto de `via` passa pelas mesmas regras de `to`.
    func testDragViaPointsAreCheckedLikeTheEndWhenATouchCanTakeThem() throws {
        let harness = ActionHarness(read: ReadHarness.exploring(), toucher: FakeToucher(supportsVia: true))
        func drag(_ via: JSONValue) throws(RpcErrorObject) -> UiActionResult {
            try call(.drag, ["from": ["x": 100, "y": 300], "to": ["x": 100, "y": 600], "via": via, "pressMs": 50,
                             "durationMs": 1000, "holdMs": 0], harness)
        }
        let result = try drag([["x": 200, "y": 10], ["label": "Open settings"]])
        XCTAssertEqual(result.path, .private)
        let path = [AbsolutePoint(x: 100, y: 300), AbsolutePoint(x: 200, y: 10), AbsolutePoint(x: 362, y: 72), AbsolutePoint(x: 100, y: 600)]
        XCTAssertEqual(harness.toucher.gestures, [.drag(DragGesture(from: path[0], via: [path[1], path[2]], to: path[3], pressSeconds: 0.05,
                                                                    velocity: DragGesture.length(path) * 3, holdSeconds: 0))],
                       "via no meio da faixa do sistema pode (não é começo de gesto); o comprimento conta via")
        assertRunnerError(.targetNotHittable) { () throws(RpcErrorObject) in try drag([["x": 500, "y": 400]]) }
        assertRunnerError(.forbiddenApp) { () throws(RpcErrorObject) in
            try drag([["label": "Open settings", "offset": ["dx": 100, "dy": 0]]])
        }
        assertRunnerError(.forbiddenApp) { () throws(RpcErrorObject) in
            try drag([["app": "springboard", "label": "Example Target", "type": "icon"]])
        }
        XCTAssertEqual(harness.toucher.gestures.count, 1)
    }

    // MARK: ui.drag — execução

    func testDragSendsOneStraightGestureBetweenTheResolvedPoints() throws {
        let harness = ActionHarness.exploring()
        let result = try ok(.drag, ["from": ["nx": 0.5, "ny": 0.62], "to": ["nx": 0.5, "ny": 0.5], "pressMs": 40, "durationMs": 500,
                                    "holdMs": 400], harness)
        let from = AbsolutePoint(x: 195, y: 0.62 * 844), to = AbsolutePoint(x: 195, y: 422)
        let velocity = DragGesture.distance(from, to) / 0.5 * 3
        XCTAssertEqual(velocity, 607.68, accuracy: 1e-9, "101,28 pt em 0,5 s, vezes a escala 3")
        XCTAssertEqual(harness.toucher.gestures, [.drag(DragGesture(from: from, to: to, pressSeconds: 0.04, velocity: velocity,
                                                                    holdSeconds: 0.4))])
        XCTAssertEqual(result.point, from, "a resposta leva o ponto de from")
        XCTAssertNil(result.nodeRef)
        let fromNode = try ok(.drag, ["from": ["label": "Verse 1"], "to": ["label": "Verse 2"], "pressMs": 60, "velocity": 350,
                                      "holdMs": 0], harness)
        XCTAssertNotNil(fromNode.nodeRef)
        XCTAssertEqual(fromNode.point, AbsolutePoint(x: 195, y: 151))
    }

    func testDragStartInASystemBandIsForbiddenButTheEndMayBeThere() throws {
        let harness = ActionHarness.exploring()
        refused(.forbiddenApp, .drag, ["from": ["x": 195, "y": 10], "to": ["x": 195, "y": 400], "pressMs": 0, "velocity": 600,
                                       "holdMs": 0], harness)
        refused(.forbiddenApp, .drag, ["from": ["x": 195, "y": 820], "to": ["x": 195, "y": 400], "pressMs": 0, "velocity": 600,
                                       "holdMs": 0], harness)
        XCTAssertEqual(harness.toucher.gestures, [])
        _ = try ok(.drag, ["from": ["x": 195, "y": 400], "to": ["x": 195, "y": 10], "pressMs": 0, "velocity": 600, "holdMs": 0], harness)
        XCTAssertEqual(harness.toucher.gestures.count, 1)
    }

    func testDragOffTheScreenIsNotHittableAndOnSpringBoardIsForbidden() throws {
        let harness = ActionHarness.exploring()
        refused(.targetNotHittable, .drag, ["from": ["x": 195, "y": 400], "to": ["x": 195, "y": 900], "pressMs": 0,
                                            "velocity": 600, "holdMs": 0], harness)
        refused(.targetNotHittable, .drag, ["from": ["label": "Play", "index": 2], "to": ["x": 195, "y": 400], "pressMs": 0,
                                            "velocity": 600, "holdMs": 0], harness)
        let home = ActionHarness.exploring(front: SystemApp.springboard)
        home.read.store.current = try home.read.store.current.loading(.init(bundleId: F.target, iconLabel: "Example Target"))
        refused(.forbiddenApp, .drag, ["from": ["app": "springboard", "label": "Example Target", "type": "icon"],
                                       "to": ["app": "springboard", "label": "Photos", "type": "icon"], "pressMs": 0,
                                       "velocity": 600, "holdMs": 0], home)
        refused(.forbiddenApp, .drag, ["from": ["x": 195, "y": 400], "to": ["x": 195, "y": 600], "pressMs": 0, "velocity": 600,
                                       "holdMs": 0], home)
        XCTAssertEqual(harness.toucher.gestures + home.toucher.gestures, [])
    }

    // MARK: ui.tap, ui.doubleTap, ui.longPress

    func testTapTouchesTheResolvedPointWithOrderedTimes() throws {
        let harness = ActionHarness.exploring()
        let result = try ok(.tap, ["target": ["label": "Open settings"]], harness)
        XCTAssertEqual(harness.toucher.gestures, [.tap(AbsolutePoint(x: 362, y: 72))])
        XCTAssertEqual(result.nodeRef, "@e6")
        XCTAssertLessThan(result.tDevStartNs, result.tDispatchNs)
        XCTAssertLessThan(result.tDispatchNs, result.tDevEndNs)
        let offset = try ok(.tap, ["target": ["label": "Open settings", "offset": ["dx": -10, "dy": 5]]], harness)
        XCTAssertEqual(offset.point, AbsolutePoint(x: 352, y: 77))
        _ = try ok(.doubleTap, ["target": ["point": ["x": 195, "y": 2]]], harness)
        XCTAssertEqual(harness.toucher.gestures.last, .doubleTap(AbsolutePoint(x: 195, y: 2)), "toque na barra de estado não abre camada")
    }

    func testAC117_tapOnSpringBoardOnlyOnTheTargetIconAndNothingElseIsTouched() throws {
        let harness = ActionHarness.exploring(front: SystemApp.springboard)
        harness.read.store.current = try harness.read.store.current.loading(.init(bundleId: F.target, iconLabel: "Example Target"))
        refused(.forbiddenApp, .tap, ["target": ["app": "springboard", "label": "Settings", "type": "icon"]], harness)
        refused(.forbiddenApp, .tap, ["target": ["app": "springboard", "label": "Example Target", "type": "icon",
                                                 "offset": ["dx": 90, "dy": 0]]], harness)
        refused(.forbiddenApp, .doubleTap, ["target": ["app": "springboard", "label": "Example Target", "type": "icon"]], harness)
        refused(.forbiddenApp, .longPress, ["target": ["app": "springboard", "label": "Example Target", "type": "icon"],
                                            "durationMs": 800], harness)
        refused(.forbiddenApp, .tap, ["target": ["point": ["x": 100, "y": 100]]], harness)
        XCTAssertEqual(harness.toucher.gestures, [])
        _ = try ok(.tap, ["target": ["app": "springboard", "label": "Example Target", "type": "icon"]], harness)
        XCTAssertEqual(harness.toucher.gestures, [.tap(AbsolutePoint(x: 59, y: 118))])
    }

    func testAnOffscreenTargetIsNotHittable() {
        let harness = ActionHarness.exploring()
        refused(.targetNotHittable, .tap, ["target": ["label": "Play", "index": 2]], harness)
        refused(.targetNotHittable, .tap, ["target": ["point": ["x": 500, "y": 100]]], harness)
        refused(.targetNotFound, .tap, ["target": ["label": "Nowhere"]], harness)
        // O elemento está na tela; o offset é que leva o toque para fora dela: recusa da lista permitida (T-0.6).
        refused(.forbiddenApp, .tap, ["target": ["label": "Open settings", "offset": ["dx": 100, "dy": 0]]], harness)
        XCTAssertEqual(harness.toucher.gestures, [])
    }

    func testLongPressPassesTheDurationAndNeverStartsInASystemBand() throws {
        let harness = ActionHarness.exploring()
        _ = try ok(.longPress, ["target": ["label": "Play", "index": 0], "durationMs": 800], harness)
        XCTAssertEqual(harness.toucher.gestures, [.longPress(AbsolutePoint(x: 38, y: 122), seconds: 0.8)])
        refused(.forbiddenApp, .longPress, ["target": ["point": ["x": 20, "y": 10]], "durationMs": 800], harness)
        refused(.forbiddenApp, .longPress, ["target": ["label": "Read"], "durationMs": 800], harness)  // aba na faixa de baixo
        XCTAssertThrowsError(try UiLongPressParams.decode(["target": ["label": "Play"], "durationMs": 0]))
        XCTAssertThrowsError(try UiLongPressParams.decode(["target": ["label": "Play"]]))
        XCTAssertEqual(harness.toucher.gestures.count, 1)
    }

    // MARK: ui.scrollTo (S0.4)

    /// O leitor com a linha "Verse 3" em `y`.
    static func reader(verse3At y: Double) -> RawNode {
        F.node(.application, "Example Target", 0, 0, 390, 844, [
            F.node(.window, 0, 0, 390, 844, [
                F.node(.scrollView, id: "verses", 0, 91, 390, 700, [
                    F.node(.cell, "Verse 1", 0, 91, 390, 120),
                    F.node(.cell, "Verse 3", 0, y, 390, 120, [F.node(.button, "Play", 16, y + 10, 44, 44)]),
                ]),
                F.node(.tabBar, 0, 791, 390, 53, [F.node(.button, "Read", 0, 795, 97, 49)]),
            ]),
        ])
    }

    func testScrollToDoesNotSwipeWhenTheTargetIsAlreadyTappable() throws {
        let harness = ActionHarness.exploring()
        let result = try ok(.scrollTo, ["target": ["label": "Verse 2"], "direction": "down", "maxSwipes": 3], harness)
        XCTAssertEqual(harness.toucher.gestures, [])
        XCTAssertEqual(result.point, AbsolutePoint(x: 195, y: 271))
        XCTAssertNotNil(result.nodeRef)
        XCTAssertEqual(result.tDispatchNs, result.tDevEndNs, "sem passe, tDispatchNs é o instante da decisão")
    }

    func testScrollToSwipesInTheNearestScrollableAncestorUntilTheTargetIsTappable() throws {
        let harness = ActionHarness.exploring(tree: Self.reader(verse3At: 900))
        harness.toucher.onDrag = { _ in harness.read.reader.setTree(F.target, Self.reader(verse3At: 400)) }
        let result = try ok(.scrollTo, ["target": ["label": "Verse 3"], "direction": "down", "maxSwipes": 3], harness)
        // Centro horizontal do frame da lista (0,91 390x700), de 70 % a 30 % da altura, 50 ms, 600 pt/s × 3, sem segurar.
        let pass = ScrollGeometry.swipe(in: Rect(x: 0, y: 91, w: 390, h: 700), direction: .down, scale: 3)
        XCTAssertEqual(harness.toucher.gestures, [.drag(pass)])
        XCTAssertEqual(pass.from.x, 195)
        XCTAssertEqual(pass.to.x, 195, "dx = 0")
        XCTAssertEqual(pass.from.y, 581, accuracy: 1e-9)
        XCTAssertEqual(pass.to.y, 301, accuracy: 1e-9)
        XCTAssertEqual(pass.pressSeconds, 0.05)
        XCTAssertEqual(pass.velocity, 1800)
        XCTAssertEqual(pass.holdSeconds, 0)
        XCTAssertEqual(result.point, AbsolutePoint(x: 195, y: 460))
        XCTAssertLessThan(result.tDispatchNs, result.tDevEndNs)
    }

    func testScrollToUpReversesThePassAndAWithinContainerIsUsedAsIs() throws {
        let harness = ActionHarness.exploring(tree: Self.reader(verse3At: 900))
        refused(.targetNotHittable, .scrollTo, ["target": ["label": "Verse 3"], "within": ["identifier": "verses"],
                                                "direction": "up", "maxSwipes": 1], harness)
        let down = ScrollGeometry.swipe(in: Rect(x: 0, y: 91, w: 390, h: 700), direction: .down, scale: 3)
        let up = ScrollGeometry.swipe(in: Rect(x: 0, y: 91, w: 390, h: 700), direction: .up, scale: 3)
        XCTAssertEqual(up.from, down.to)
        XCTAssertEqual(up.to, down.from)
        XCTAssertEqual(harness.toucher.gestures, [.drag(up)])
    }

    /// Centro na tela, mas debaixo da barra de abas (fora da parte visível da lista): ainda não está tocável.
    func testScrollToKeepsGoingWhileTheTargetIsUnderTheTabBar() throws {
        let harness = ActionHarness.exploring(tree: Self.reader(verse3At: 760))
        harness.toucher.onDrag = { _ in harness.read.reader.setTree(F.target, Self.reader(verse3At: 500)) }
        _ = try ok(.scrollTo, ["target": ["label": "Verse 3"], "direction": "down", "maxSwipes": 2], harness)
        XCTAssertEqual(harness.toucher.gestures.count, 1)
    }

    func testScrollToExhaustedIsNotHittableWhenTheTargetResolvesAndNotFoundOtherwise() {
        let stuck = ActionHarness.exploring(tree: Self.reader(verse3At: 900))
        refused(.targetNotHittable, .scrollTo, ["target": ["label": "Verse 3"], "direction": "down", "maxSwipes": 2], stuck)
        XCTAssertEqual(stuck.toucher.gestures.count, 2)

        let missing = ActionHarness.exploring(tree: Self.reader(verse3At: 900))
        refused(.targetNotFound, .scrollTo, ["target": ["label": "Verse 40"], "within": ["identifier": "verses"],
                                             "direction": "down", "maxSwipes": 2], missing)
        XCTAssertEqual(missing.toucher.gestures.count, 2)

        let noAncestor = ActionHarness.exploring(tree: Self.reader(verse3At: 900))
        refused(.targetNotFound, .scrollTo, ["target": ["label": "Verse 40"], "direction": "down", "maxSwipes": 2], noAncestor)
        refused(.targetNotFound, .scrollTo, ["target": ["point": ["x": 195, "y": 900]], "direction": "down", "maxSwipes": 2],
                noAncestor)
        XCTAssertEqual(noAncestor.toucher.gestures, [], "sem within e sem ancestral rolável não há onde rolar")
    }

    /// Revisão da T-0.7, achado 3: a leitura permite; só a conferência do passe recusa. Lista de chips no topo da
    /// tela (0,0 390x60): o ponto de 70 % fica em y = 42, dentro da faixa da barra de estado (47 pt) — um arrasto
    /// dali puxaria a Central de Notificações.
    func testAPassStartingInTheStatusBarBandIsRefusedEvenThoughTheReadIsAllowed() throws {
        let chips = F.node(.application, "Example Target", 0, 0, 390, 844, [F.node(.window, 0, 0, 390, 844, [
            F.node(.scrollView, id: "chips", 0, 0, 390, 60, [
                F.node(.button, "Chip 1", 0, 10, 100, 40),
                F.node(.button, "Chip 9", 0, 200, 100, 40),
            ]),
        ])])
        let harness = ActionHarness.exploring(tree: chips)
        XCTAssertNoThrow(try ReadMethods.uiFind(UiFindParams(target: Target(label: "Chip 9")), harness.read.context),
                         "a leitura do alvo é permitida")
        for direction in ["down", "up"] {
            let error = refused(.forbiddenApp, .scrollTo, ["target": ["label": "Chip 9"], "direction": .string(direction), "maxSwipes": 3],
                                harness)
            XCTAssertTrue(error?.message.contains("faixa do sistema") ?? false, error?.message ?? "")
        }
        XCTAssertEqual(harness.toucher.gestures, [], "nenhum passe enviado")
    }

    /// Revisão da T-0.7, achado 3: a tela é relida logo antes de cada passe — a leitura do alvo viu o app, o passe vê
    /// a Central de Controle por cima e não arrasta.
    func testThePassRereadsTheScreenRightBeforeSwiping() throws {
        let harness = ActionHarness.exploring(tree: Self.reader(verse3At: 900))
        harness.read.reader.queue(Screens.proven(F.target), Screens.controlCenter(over: F.target))
        refused(.forbiddenApp, .scrollTo, ["target": ["label": "Verse 3"], "direction": "down", "maxSwipes": 3], harness)
        XCTAssertEqual(harness.toucher.gestures, [])
        XCTAssertEqual(harness.read.reader.screenReads, 2, "uma leitura para resolver, outra logo antes do passe")
        // Do segundo passe em diante também: a tela muda depois do primeiro.
        let later = ActionHarness.exploring(tree: Self.reader(verse3At: 900))
        later.read.reader.queue(Screens.proven(F.target), Screens.proven(F.target), Screens.proven(F.target),
                                Screens.appSwitcher(over: F.target))
        refused(.forbiddenApp, .scrollTo, ["target": ["label": "Verse 3"], "direction": "down", "maxSwipes": 3], later)
        XCTAssertEqual(later.toucher.gestures.count, 1)
    }

    func testScrollToIsRefusedOutsideAnOperableAppInFront() throws {
        for screen in [Screens.proven(SystemApp.springboard), Screens.controlCenter(over: F.target), Screens.locked] {
            let harness = ActionHarness.exploring(screen: screen, tree: Self.reader(verse3At: 900))
            refused(.forbiddenApp, .scrollTo, ["target": ["label": "Verse 3"], "direction": "down", "maxSwipes": 2], harness)
            XCTAssertEqual(harness.toucher.gestures, [])
        }
        // A tela muda para a tela de início entre um passe e outro: o passe seguinte é recusado.
        let harness = ActionHarness.exploring(tree: Self.reader(verse3At: 900))
        harness.toucher.onDrag = { _ in harness.read.reader.screenState = Screens.proven(SystemApp.springboard) }
        refused(.forbiddenApp, .scrollTo, ["target": ["label": "Verse 3"], "direction": "down", "maxSwipes": 3], harness)
        XCTAssertEqual(harness.toucher.gestures.count, 1)
    }

    // MARK: Pelo roteador

    func testActionMethodsAreRegisteredOnTheXCTestLaneAndAnswerTheS05Shape() throws {
        let action = ActionHarness.exploring()
        let runner = RunnerHarness(state: action.read.state, extraRoutes: { router in ActionMethods.register(into: &router, action.context) })
        XCTAssertEqual(Set(ActionMethods.Method.allCases.map(\.rawValue)), uiActionMethods)
        for method in ActionMethods.Method.allCases {
            XCTAssertEqual(runner.router.route(method.rawValue)?.lane, .xctest, method.rawValue)
            XCTAssertEqual(runner.router.route(method.rawValue)?.deadline(nil), 10, method.rawValue)
        }
        let client = try runner.connected()
        let tap = try client.call("ui.tap", ["target": ["label": "Open settings"]])
        let success = try RpcSchema.success(tap, method: "ui.tap")
        XCTAssertEqual(success.result["nodeRef"], "@e6")
        XCTAssertEqual(success.result["path"], "public")
        XCTAssertNotNil(success.result["tDispatchNs"]?.stringValue, "tempos D como string de inteiro (S0.7)")

        let both = try client.call("ui.drag", ["from": ["x": 1, "y": 100], "to": ["x": 1, "y": 200], "pressMs": 0, "velocity": 1,
                                               "durationMs": 1, "holdMs": 0])
        XCTAssertEqual(both.rpcErrorCode, JSONRPCErrorCode.invalidParams.rawValue)
        XCTAssertEqual(both["error"]?["data"]?["errors"]?.arrayValue?.first?["rule"], "S0.4/velocity-xor-durationMs")
        XCTAssertEqual(try client.call("ui.type", ["text": "someone@icloud.com"]).rpcErrorCode, RunnerErrorCode.secureField.code)
        XCTAssertEqual(try client.call("ui.drag", ["from": ["x": 1, "y": 100], "to": ["x": 1, "y": 200], "via": [["x": 1, "y": 150]],
                                                   "pressMs": 0, "velocity": 1, "holdMs": 0]).rpcErrorCode,
                       RunnerErrorCode.capabilityMissing.code)
        XCTAssertEqual(action.toucher.gestures, [.tap(AbsolutePoint(x: 362, y: 72))])
    }
}

// MARK: Aparelho falso das ações

/// Um `Toucher` que só registra o que receberia, com ganchos para a tela mudar depois de um toque ou arrasto.
final class FakeToucher: Toucher, @unchecked Sendable {
    enum Gesture: Equatable {
        case tap(AbsolutePoint)
        case doubleTap(AbsolutePoint)
        case longPress(AbsolutePoint, seconds: Double)
        case drag(DragGesture)
        case type(String, app: String)
    }

    private let lock = NSLock()
    private var _gestures: [Gesture] = []
    var onTap: ((AbsolutePoint) -> Void)?
    var onDrag: ((DragGesture) -> Void)?

    let path: ActionPath
    let supportsVia: Bool

    /// `supportsVia: true` faz o papel do `Toucher` privado (PX-3) que o SP-3 injeta.
    init(supportsVia: Bool = false) {
        self.supportsVia = supportsVia
        path = supportsVia ? .private : .public
    }

    var gestures: [Gesture] { lock.withLock { _gestures } }

    private func record(_ gesture: Gesture) { lock.withLock { _gestures.append(gesture) } }

    func tap(_ point: AbsolutePoint) throws(RpcErrorObject) {
        record(.tap(point))
        onTap?(point)
    }

    func doubleTap(_ point: AbsolutePoint) throws(RpcErrorObject) { record(.doubleTap(point)) }

    func longPress(_ point: AbsolutePoint, seconds: Double) throws(RpcErrorObject) { record(.longPress(point, seconds: seconds)) }

    func drag(_ gesture: DragGesture) throws(RpcErrorObject) {
        record(.drag(gesture))
        onDrag?(gesture)
    }

    func typeText(_ text: String, app bundleId: String) throws(RpcErrorObject) { record(.type(text, app: bundleId)) }
}

/// Relógio D falso: cada leitura avança 10 ns.
final class Ticks: @unchecked Sendable {
    private let lock = NSLock()
    private var now: UInt64 = 1_000

    func next() -> UInt64 {
        lock.withLock {
            now += 10
            return now
        }
    }
}

/// O contexto das ações sobre o aparelho falso da leitura (`ReadHarness`), com escala 3 (iPhone 12).
struct ActionHarness {
    let read: ReadHarness
    let toucher: FakeToucher
    let ticks = Ticks()

    init(read: ReadHarness, toucher: FakeToucher = FakeToucher()) {
        self.read = read
        self.toucher = toucher
    }

    var context: ActionMethods.Context {
        let ticks = ticks
        return ActionMethods.Context(read: read.context, toucher: toucher, scale: 3, clock: { ticks.next() })
    }

    static func exploring(front: String = TreeFixtures.target, tree: RawNode? = nil, apps: [String] = []) -> ActionHarness {
        exploring(screen: Screens.proven(front), tree: tree, apps: apps)
    }

    static func exploring(screen: ScreenState, tree: RawNode? = nil, apps: [String] = []) -> ActionHarness {
        let read = ReadHarness.exploring(screen: screen, apps: apps)
        if let tree { read.reader.setTree(TreeFixtures.target, tree) }
        return ActionHarness(read: read)
    }
}
