import Foundation
import XCTest

@testable import ContrarregraKit

/// Resolução de alvos de S0.2 sobre árvores de fixture (T-0.6), sem tela. Refs do leitor em pré-ordem:
/// @e1 application · @e2 window · @e3 navigationBar · @e4 Back · @e5 "Psalms 23" · @e6 Open settings ·
/// @e7 scrollView · @e8 cell 1 · @e9 texto 1 · @e10 Play 1 · @e11 cell 2 · @e12 texto 2 · @e13 Play 2 ·
/// @e14 cell 3 (fora da tela) · @e15 Play 3 · @e16 tabBar · @e17 Read · @e18 Journal · @e19 Plans.
final class TargetResolverTests: XCTestCase {
    typealias F = TreeFixtures

    /// Fonte de árvore e de OCR por app; `trees` pode mudar entre operações (a tela mudando).
    final class Sources: @unchecked Sendable {
        var trees: [AppScope: RawNode]
        var text: [OcrLine]
        var regions: [Rect] = []
        let registry = TreeRegistry()
        let allowList: AllowList

        init(trees: [AppScope: RawNode] = [.app(F.target): F.reader, .springboard: F.home], text: [OcrLine] = F.readerText,
             allowList: AllowList = AllowList(isSimulator: false, explore: F.target)) {
            self.trees = trees
            self.text = text
            self.allowList = allowList
        }

        func resolver() -> TargetResolver {
            TargetResolver(
                screen: F.screen,
                appScope: { name throws(RpcErrorObject) in try self.allowList.scope(forTargetApp: name) },
                tree: { app throws(RpcErrorObject) in
                    guard let raw = self.trees[app] else { throw RpcErrorObject(.appState, "E_APP_STATE: \(app)") }
                    let snapshot = self.registry.record(app: app.bundleId, raw: raw, screen: F.screen)
                    return ScopedTree(app: app, version: snapshot.version, tree: IndexedTree(snapshot.root), reachable: nil)
                },
                text: { region throws(RpcErrorObject) in
                    self.regions.append(region)
                    return self.text
                })
        }
    }

    func target(_ json: JSONValue) throws -> Target { try Target.decode(json) }

    func resolve(_ json: JSONValue, _ sources: Sources = Sources()) throws -> ResolvedTarget {
        let target = try target(json)
        do {
            return try sources.resolver().resolve(target)
        } catch {
            XCTFail("não resolveu \(json): \(error.message)")
            throw error
        }
    }

    /// A resolução falha com o erro dado; devolve o erro.
    @discardableResult
    func resolveError(_ code: RunnerErrorCode, _ json: JSONValue, _ sources: Sources = Sources(),
                      file: StaticString = #filePath, line: UInt = #line) throws -> RpcErrorObject? {
        let target = try target(json)
        let resolver = sources.resolver()
        return assertRunnerError(code, file: file, line: line) { () throws(RpcErrorObject) in try resolver.resolve(target) }
    }

    func refs(_ json: JSONValue, _ sources: Sources = Sources()) throws -> [String] {
        try sources.resolver().find(target(json)).compactMap { $0.node?.ref }
    }

    // MARK: Seletores primários e type

    func testLabelResolvesToTheCenterOfTheNode() throws {
        let resolved = try resolve(["label": "Open settings"])
        XCTAssertEqual(resolved.point, AbsolutePoint(x: 362, y: 72))
        XCTAssertEqual(resolved.candidate.node?.ref, "@e6")
        XCTAssertEqual(resolved.candidate.frame, Rect(x: 342, y: 52, w: 40, h: 40))
    }

    func testLabelPrefixLabelContainsIdentifierAndTypeFilter() throws {
        XCTAssertEqual(try refs(["labelPrefix": "Psalms"]), ["@e3", "@e5"], "a barra (Psalms) e o título (Psalms 23)")
        XCTAssertEqual(try refs(["labelPrefix": "Psalms", "type": "staticText"]), ["@e5"])
        XCTAssertEqual(try refs(["labelContains": "shepherd"]), ["@e9"])
        XCTAssertEqual(try refs(["identifier": "nav-back"]), ["@e4"])
        XCTAssertEqual(try refs(["label": "Back", "type": "any"]), ["@e4"], "type any não filtra")
        XCTAssertThrowsError(try refs(["label": "Back", "type": "staticText"]))
    }

    func testTypeAloneSelectsWhenThereIsNoPrimary() throws {
        XCTAssertEqual(try resolve(["type": "tabBar"]).candidate.node?.ref, "@e16")
    }

    func testZeroCandidatesIsTargetNotFound() throws {
        let error = try resolveError(.targetNotFound, ["label": "Nowhere"])
        XCTAssertTrue(error?.message.contains("\"label\":\"Nowhere\"") ?? false, error?.message ?? "")
    }

    func testMoreThanOneWithoutIndexIsAmbiguousWithTheListInReadingOrder() throws {
        let error = try resolveError(.targetAmbiguous, ["label": "Play"])
        let candidates = error?.data?["candidates"]?.arrayValue ?? []
        XCTAssertEqual(candidates.map { $0["ref"]?.stringValue }, ["@e10", "@e13", "@e15"])
        XCTAssertEqual(candidates.first?["frame"], Rect(x: 16, y: 100, w: 44, h: 44).json)
        XCTAssertEqual(candidates.first?.objectValue?.keys.sorted(), ["frame", "ref"], "a forma {ref, frame} da fixture do Mac")
    }

    // MARK: Modificadores

    func testIndexBreaksTiesInReadingOrderFromZero() throws {
        XCTAssertEqual(try resolve(["label": "Play", "index": 1]).candidate.node?.ref, "@e13")
        XCTAssertEqual(try resolve(["type": "button", "within": ["type": "tabBar"], "index": 2]).candidate.node?.label,
                       "Plans", "na mesma linha, esquerda→direita")
        let error = try resolveError(.targetNotFound, ["label": "Play", "index": 3])
        XCTAssertTrue(error?.message.contains("index") ?? false)
    }

    func testWithinRestrictsToDescendantsOfTheResolvedTarget() throws {
        XCTAssertEqual(try resolve(["label": "Play", "within": ["label": "Verse 2"]]).candidate.node?.ref, "@e13")
        XCTAssertEqual(try refs(["type": "button", "within": ["type": "navigationBar"]]), ["@e4", "@e6"])
        // A âncora também tem de resolver para um só.
        try resolveError(.targetAmbiguous, ["label": "Read", "within": ["label": "Play"]])
    }

    func testBelowAndAboveCompareFrameMinYWithTheAnchor() throws {
        // "The Lord is my shepherd" ocupa y 100…160: abaixo dele ficam o Play 2 (220) e o Play 3 (910).
        XCTAssertEqual(try refs(["label": "Play", "below": ["label": "The Lord is my shepherd"]]), ["@e13", "@e15"])
        XCTAssertEqual(try resolve(["label": "Play", "below": ["label": "The Lord is my shepherd"], "index": 0])
            .candidate.node?.ref, "@e13")
        // "He makes me lie down" começa em 220: acima dele só o Play 1 (o Play 2 está na mesma altura).
        XCTAssertEqual(try resolve(["label": "Play", "above": ["label": "He makes me lie down"]]).candidate.node?.ref, "@e10")
    }

    func testFallbackIsTriedInOrderWhenThePrimaryDoesNotResolve() throws {
        let missing: JSONValue = ["label": "Missing", "fallback": [["label": "Also missing"], ["identifier": "nav-back"],
                                                                  ["label": "Open settings"]]]
        XCTAssertEqual(try resolve(missing).candidate.node?.ref, "@e4")
        // Primário ambíguo também não resolve (S0.2: resolver = um único ponto).
        XCTAssertEqual(try resolve(["label": "Play", "fallback": [["label": "Open settings"]]]).candidate.node?.ref, "@e6")
        // Nada resolve: o erro do primário.
        let error = try resolveError(.targetNotFound, ["label": "Missing", "fallback": [["label": "Nope"]]])
        XCTAssertTrue(error?.message.contains("Missing") ?? false, error?.message ?? "")
        // Algum ambíguo e nenhum único: a ambiguidade (o que o autor tem de corrigir com index).
        try resolveError(.targetAmbiguous, ["label": "Nope", "fallback": [["label": "Play"]]])
    }

    func testFallbackInheritsTheAppOfThePrimary() throws {
        let resolved = try resolve(["app": "springboard", "label": "Nope",
                                    "fallback": [["label": "Example Target", "type": "icon"]]])
        XCTAssertEqual(resolved.candidate.app, .springboard)
        XCTAssertEqual(resolved.point, AbsolutePoint(x: 59, y: 118))
    }

    func testPointAbsoluteNormalizedAndOffsetFromTheCenter() throws {
        XCTAssertEqual(try resolve(["point": ["x": 24, "y": 64]]).point, AbsolutePoint(x: 24, y: 64))
        XCTAssertEqual(try resolve(["point": ["nx": 0.5, "ny": 0.5], "offset": ["dx": 0, "dy": -4.5]]).point,
                       AbsolutePoint(x: 195, y: 417.5))
        let back = try resolve(["label": "Back", "offset": ["dx": 2, "dy": -4.5]])
        XCTAssertEqual(back.point, AbsolutePoint(x: 40, y: 64.5), "centro (38, 69) + offset")
        XCTAssertNil(try resolve(["point": ["x": 24, "y": 64]]).candidate.node)
    }

    func testVisibleIsFrameIntersectingTheScreenAndHittableIsTheCenterOnScreen() throws {
        let candidates = try Sources().resolver().find(target(["label": "Play"]))
        XCTAssertEqual(candidates.map { $0.isVisible(on: F.screen) }, [true, true, false], "o Play 3 está em y 910")
        XCTAssertEqual(candidates.map { $0.isHittable(on: F.screen) }, [true, true, false])
        let json = candidates[2].findJSON(screen: F.screen)
        XCTAssertEqual(json["visible"], false)
        XCTAssertEqual(json["ref"], "@e15")
    }

    // MARK: ref (S0.6)

    func testRefResolvesInTheCurrentTreeAndAStaleRefIsNotFound() throws {
        let sources = Sources()
        XCTAssertEqual(try resolve(["ref": "@e6"], sources).candidate.node?.label, "Open settings")

        // Mesmo esqueleto, frame diferente (animação): o ref continua valendo.
        var moved = F.reader
        moved.children[0].children[0].children[2].frame = Rect(x: 340, y: 50, w: 40, h: 40)
        sources.trees[.app(F.target)] = moved
        XCTAssertEqual(try resolve(["ref": "@e6"], sources).point, AbsolutePoint(x: 360, y: 70))

        // Outra árvore (o rótulo mudou): refs novos, e o antigo não acha nada.
        var changed = F.reader
        changed.children[0].children[0].children[2].label = "Close settings"
        sources.trees[.app(F.target)] = changed
        let error = try resolveError(.targetNotFound, ["ref": "@e6"], sources)
        XCTAssertTrue(error?.message.contains("árvore atual") ?? false)
        XCTAssertEqual(try resolve(["label": "Close settings"], sources).candidate.node?.ref, "@e25", "19 refs da 1.ª árvore + 6")
    }

    func testCatalogRefOutsideAChoreographyIsNotFound() throws {
        let error = try resolveError(.targetNotFound, ["ref": "playButton"])
        XCTAssertTrue(error?.message.contains("catálogo") ?? false)
    }

    // MARK: Seletor ocr (S1 item 6)

    func testOcrFindsTheWordInsideWithinAndTapsTheCenterOfItsBox() throws {
        let sources = Sources()
        // Duas ocorrências na tela ("shepherd;" no verso 1 e "Shepherd" mais abaixo): ambíguo sem limitar.
        try resolveError(.targetAmbiguous, ["ocr": ["text": "shepherd"]], sources)
        let resolved = try resolve(["ocr": ["text": "shepherd", "within": ["label": "Verse 1"]]], sources)
        XCTAssertEqual(resolved.point, AbsolutePoint(x: 234, y: 110))
        XCTAssertNil(resolved.candidate.node)
        XCTAssertEqual(sources.regions.last, Rect(x: 0, y: 91, w: 390, h: 120), "o OCR roda só na região do within")
    }

    func testOcrOccurrenceRegionAndPhrases() throws {
        XCTAssertEqual(try resolve(["ocr": ["text": "shepherd", "occurrence": 1]]).point, AbsolutePoint(x: 260, y: 410))
        XCTAssertEqual(try resolve(["ocr": ["text": "shepherd", "region": ["x": 0, "y": 380, "w": 390, "h": 100]]]).point,
                       AbsolutePoint(x: 260, y: 410))
        let phrase = try resolve(["ocr": ["text": "current day"]])
        XCTAssertEqual(phrase.candidate.frame, Rect(x: 70, y: 300, w: 124, h: 20))
    }

    func testOcrTextNotFoundIsOcrNotFound() throws {
        try resolveError(.ocrNotFound, ["ocr": ["text": "still waters"]])
        try resolveError(.ocrNotFound, ["ocr": ["text": "shepherd", "occurrence": 2]])
    }

    func testFallbackFromOcrToTheTree() throws {
        XCTAssertEqual(try resolve(["ocr": ["text": "still waters"], "fallback": [["label": "Verse 2"]]]).candidate.node?.ref,
                       "@e11")
    }

    // MARK: Lista permitida dentro da resolução

    func testAppNamesGoThroughTheAllowList() throws {
        try resolveError(.forbiddenApp, ["app": "com.apple.Preferences", "label": "General"])
        try resolveError(.forbiddenApp, ["app": "com.example.unknown", "label": "General"])
        // Erro de lista permitida não cai para o fallback.
        try resolveError(.forbiddenApp, ["app": "com.apple.MobileSMS", "label": "x", "fallback": [["label": "Back"]]])
    }
}
