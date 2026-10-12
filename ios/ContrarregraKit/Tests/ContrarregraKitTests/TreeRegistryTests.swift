import Foundation
import XCTest

@testable import ContrarregraKit

/// Árvore de S0.6: refs `@e<n>`, `treeVersion`, visibilidade e o formato compacto (T-0.6). E o casamento do
/// texto do OCR (S1 item 6).
final class TreeRegistryTests: XCTestCase {
    typealias F = TreeFixtures

    func flat(_ root: TreeNode) -> [TreeNode] { IndexedTree(root).nodes }

    func testRefsArePreOrderWithDepthAndVisibility() {
        let snapshot = TreeRegistry().record(app: F.target, raw: F.reader, screen: F.screen)
        let nodes = flat(snapshot.root)
        XCTAssertEqual(nodes.count, 19)
        XCTAssertEqual(nodes.map(\.ref), (1...19).map { "@e\($0)" })
        XCTAssertEqual(nodes[5].label, "Open settings")
        XCTAssertEqual(nodes[5].depth, 3)
        XCTAssertEqual(nodes[0].depth, 0)
        XCTAssertEqual(nodes.filter { !$0.visible }.map(\.ref), ["@e14", "@e15"], "a linha 3 e o Play dela, em y ≥ 900")
        XCTAssertEqual(snapshot.version, 1)
    }

    func testSameStructureKeepsRefsAndVersionWhileFramesAndValuesChange() {
        let registry = TreeRegistry()
        let first = registry.record(app: F.target, raw: F.reader, screen: F.screen)
        var animated = F.reader
        animated.children[0].children[1].frame = Rect(x: 0, y: 80, w: 390, h: 700)
        animated.children[0].children[2].children[1].selected = true
        animated.children[0].children[0].children[0].value = "1"
        let second = registry.record(app: F.target, raw: animated, screen: F.screen)
        XCTAssertEqual(second.version, first.version)
        XCTAssertEqual(flat(second.root).map(\.ref), flat(first.root).map(\.ref))
        XCTAssertEqual(flat(second.root)[6].frame, Rect(x: 0, y: 80, w: 390, h: 700), "o frame novo vem na árvore")
    }

    func testAnotherTreeGetsNewRefsAndANewVersion() {
        let registry = TreeRegistry()
        let first = registry.record(app: F.target, raw: F.reader, screen: F.screen)
        var changed = F.reader
        changed.children[0].children[2].children.removeLast()
        let second = registry.record(app: F.target, raw: changed, screen: F.screen)
        XCTAssertEqual(second.version, first.version + 1)
        XCTAssertEqual(flat(second.root).first?.ref, "@e20", "refs nunca se repetem: um ref velho não acha outro nó")
        XCTAssertEqual(registry.version, 2)

        // Outro app: refs próprios, também únicos.
        let springboard = registry.record(app: SystemApp.springboard, raw: F.home, screen: F.screen)
        XCTAssertEqual(flat(springboard.root).first?.ref, "@e38")
        XCTAssertEqual(springboard.version, 3)
    }

    // MARK: Formato compacto (S0.6, AC-1.3)

    func testCompactLineHasRefTypeLabelAndFrameInPoints() {
        let root = TreeRegistry().record(app: F.target, raw: F.reader, screen: F.screen).root
        let lines = TreeFormat.compactLines(root, visibleOnly: true, maxDepth: nil)
        XCTAssertTrue(lines.contains("@e6 button \"Open settings\" (342,52 40x40)"), lines.joined(separator: "\n"))
        XCTAssertTrue(lines.contains("@e4 button \"Back\" (8,52 60x34) id=\"nav-back\""))
        XCTAssertTrue(lines.contains("@e17 button \"Read\" (0,795 97x49) selected"))
        XCTAssertTrue(lines.contains("@e19 button \"Plans\" (194,795 97x49) disabled"))
        XCTAssertTrue(lines.contains("@e2 window (0,0 390x844)"), "sem rótulo, sem aspas")
        XCTAssertFalse(lines.contains { $0.hasPrefix("@e14 ") || $0.hasPrefix("@e15 ") }, "só nós visíveis")

        let all = TreeFormat.compactLines(root, visibleOnly: false, maxDepth: nil)
        XCTAssertTrue(all.contains("@e15 button \"Play\" (16,910 44x44) offscreen"))
        XCTAssertEqual(TreeFormat.compactLines(root, visibleOnly: true, maxDepth: 1), ["@e1 application \"Example Target\" (0,0 390x844)",
                                                                                         "@e2 window (0,0 390x844)"])
    }

    func testCompactLineEscapesTextAndPrintsFractionalPoints() {
        let node = TreeNode(ref: "@e7", type: .staticText, label: "Say \"hi\"\nnow", value: "50%",
                            frame: Rect(x: 52.5, y: 10.333, w: 40, h: 0.5), depth: 1)
        XCTAssertEqual(TreeFormat.compactLine(node), "@e7 staticText \"Say \\\"hi\\\"\\nnow\" (52.5,10.33 40x0.5) value=\"50%\"")
    }

    func testJsonFormatPrunesInvisibleSubtreesAndDepth() throws {
        let root = TreeRegistry().record(app: F.target, raw: F.reader, screen: F.screen).root
        let visible = try XCTUnwrap(TreeFormat.pruned(root, visibleOnly: true, maxDepth: nil))
        XCTAssertFalse(flat(visible).contains { $0.ref == "@e14" || $0.ref == "@e15" })
        XCTAssertEqual(flat(visible).count, 17)
        let shallow = try XCTUnwrap(TreeFormat.pruned(root, visibleOnly: false, maxDepth: 1))
        XCTAssertEqual(flat(shallow).map(\.ref), ["@e1", "@e2"])
        // Volta como TreeNode válido de S0.6.
        XCTAssertEqual(try TreeNode.decode(visible.json), visible)
    }

    // MARK: OCR

    func testOcrMatchingIgnoresCaseAccentsAndEdgePunctuationAndNeedsWholeWords() {
        XCTAssertEqual(OcrMatcher.normalize("shepherd;"), "shepherd")
        XCTAssertEqual(OcrMatcher.normalize("Café"), "cafe")
        XCTAssertEqual(OcrMatcher.normalize("—"), "")
        let found = OcrMatcher.matches("Shepherd", in: F.readerText)
        XCTAssertEqual(found.map(\.text), ["shepherd;", "Shepherd"], "ordem de leitura")
        XCTAssertTrue(OcrMatcher.matches("shep", in: F.readerText).isEmpty, "palavra inteira")
        XCTAssertTrue(OcrMatcher.matches("my shepherd", in: F.readerText).count == 1)
        XCTAssertTrue(OcrMatcher.matches("shepherd current", in: F.readerText).isEmpty, "não atravessa linhas")
    }

    func testOcrPhraseIsTheUnionOfItsWordsWithTheLowestConfidence() {
        let lines = [OcrLine(words: [F.word("Hold", 10, 50, 40, confidence: 0.9), F.word("—", 54, 50, 10),
                                     F.word("still", 68, 50, 30, confidence: 0.7)])]
        let match = OcrMatcher.matches("hold still", in: lines)
        XCTAssertEqual(match.count, 1, "a palavra só de pontuação é pulada")
        XCTAssertEqual(match.first?.frame, Rect(x: 10, y: 50, w: 88, h: 20))
        XCTAssertEqual(match.first?.text, "Hold still", "as palavras casadas, como o OCR as leu")
        XCTAssertEqual(match.first?.confidence, 0.7)
    }

    func testOcrRegionKeepsWordsWhoseCenterIsInside() {
        let region = Rect(x: 0, y: 290, w: 390, h: 200)
        XCTAssertEqual(OcrMatcher.words(in: F.readerText, region: region).map(\.text), ["CURRENT", "DAY", "Shepherd"])
        XCTAssertEqual(OcrMatcher.matches("shepherd", in: F.readerText, region: region).map(\.text), ["Shepherd"])
    }

    func testOcrBoxJsonRoundsFrameAndConfidence() {
        let word = OcrWord(text: "Psalms", frame: Rect(x: 10.12345, y: 20.6789, w: 30.004, h: 12), confidence: 0.50000002)
        XCTAssertEqual(word.json, ["text": "Psalms", "frame": ["x": 10.12, "y": 20.68, "w": 30, "h": 12], "confidence": 0.5])
    }
}
