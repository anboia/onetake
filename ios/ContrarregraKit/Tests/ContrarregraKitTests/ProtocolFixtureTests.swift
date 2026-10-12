import CryptoKit
import Foundation
import XCTest

@testable import ContrarregraKit

/// AC-0.6 (lado Swift): as fixtures de `mac/test/fixtures/protocol/*.json`, as mesmas do `node --test`,
/// decodificam e recodificam pelos modelos do Kit; o JSON fica semanticamente igual e byte a byte igual
/// sob JCS. As inválidas são recusadas no mesmo caminho e com a mesma regra do Mac.
final class ProtocolFixtureTests: XCTestCase {
    func testEveryValidFixtureHasItsJCSAndNoJCSIsOrphan() throws {
        let jsons = try Fixtures.files(Fixtures.protocolDir, extension: "json")
        let jcss = try Fixtures.files(Fixtures.protocolDir, extension: "jcs")
        XCTAssertGreaterThanOrEqual(jsons.count, 20, "poucas fixtures em \(Fixtures.protocolDir.path)")
        XCTAssertEqual(Set(jsons.map { $0.dropLast(5) }), Set(jcss.map { $0.dropLast(4) }))
    }

    func testAC06_validFixturesRoundTripSemanticallyAndByteForByteUnderJCS() throws {
        let files = try Fixtures.files(Fixtures.protocolDir, extension: "json")
        XCTAssertFalse(files.isEmpty)
        for file in files {
            let (type, rest) = Fixtures.split(file)
            let original = try Fixtures.json(Fixtures.protocolDir.appending(path: file))
            let expected = try Fixtures.text(Fixtures.protocolDir.appending(path: String(file.dropLast(5)) + ".jcs"))
            let reencoded: JSONValue
            do {
                reencoded = try FixtureCodec.roundTrip(type: type, method: rest, original)
            } catch {
                XCTFail("\(file): esperava decodificar; veio \(error)")
                continue
            }
            XCTAssertEqual(reencoded, original, "\(file): a recodificação mudou o JSON")
            XCTAssertEqual(try JCS.canonicalize(reencoded), expected, "\(file): JCS da recodificação ≠ .jcs")
            XCTAssertEqual(try JCS.canonicalize(original), expected, "\(file): JCS do original ≠ .jcs")
            XCTAssertEqual(Array(try JCS.canonicalData(reencoded)), Array(expected.utf8), "\(file): bytes UTF-8")
            XCTAssertFalse(expected.hasSuffix("\n"), "\(file): .jcs não termina em fim de linha")
        }
    }

    func testInvalidFixturesAreRejectedAtTheExpectedPathWithTheExpectedRule() throws {
        let files = try Fixtures.files(Fixtures.invalidDir, extension: "json")
        XCTAssertFalse(files.isEmpty)
        for file in files {
            let fixture = try Fixtures.json(Fixtures.invalidDir.appending(path: file))
            let type = try XCTUnwrap(fixture["type"]?.stringValue, file)
            XCTAssertEqual(type, Fixtures.split(file).type, file)
            let method = fixture["method"]?.stringValue ?? ""
            let expectPath = try XCTUnwrap(fixture["expect"]?["path"]?.stringValue, file)
            let expectRule = try XCTUnwrap(fixture["expect"]?["rule"]?.stringValue, file)
            let value = try XCTUnwrap(fixture["value"], file)
            do {
                _ = try FixtureCodec.roundTrip(type: type, method: method, value)
                XCTFail("\(file): esperava recusa em \"\(expectPath)\" [\(expectRule)]")
            } catch let error as ValidationError {
                XCTAssertTrue(
                    error.issues.contains { $0.path == expectPath && $0.rule == expectRule },
                    "\(file): esperava erro em \"\(expectPath)\" [\(expectRule)]; veio \(error.issues)"
                )
                if let code = fixture["expect"]?["code"]?.stringValue {
                    XCTAssertEqual(error.code?.rawValue, code, file)
                    XCTAssertEqual(error.rpcError?.code, RunnerErrorCode(rawValue: code)?.code, file)
                    if !expectPath.isEmpty {
                        XCTAssertTrue(error.description.contains(expectPath), "\(file): a mensagem deve citar \(expectPath)")
                    }
                }
            }
        }
    }

    func testEveryProtocolTypeHasAValidAndAnInvalidFixtureAndIsKnownToTheKit() throws {
        let valid = Set(try Fixtures.files(Fixtures.protocolDir, extension: "json").map { Fixtures.split($0).type })
        let invalid = Set(try Fixtures.files(Fixtures.invalidDir, extension: "json").map { Fixtures.split($0).type })
        XCTAssertTrue(valid.isSubset(of: FixtureCodec.types), "tipos sem decodificador no Swift: \(valid.subtracting(FixtureCodec.types))")
        XCTAssertTrue(invalid.isSubset(of: FixtureCodec.types), "tipos sem decodificador no Swift: \(invalid.subtracting(FixtureCodec.types))")
        for type in FixtureCodec.types {
            XCTAssertTrue(valid.contains(type), "sem fixture válida de \(type)")
            XCTAssertTrue(invalid.contains(type), "sem fixture inválida de \(type)")
        }
    }

    func testCompiledSha256IsTheSha256OfTheJCSWithoutSha256AndCompiledAt() throws {
        let json = try Fixtures.json(Fixtures.protocolDir.appending(path: "CompiledChoreography.ac07.json"))
        let doc = try CompiledChoreography.decode(json)
        let digest = SHA256.hash(data: try JCS.canonicalData(doc.hashInput))
        let hex = digest.map { String(format: "%02x", $0) }.joined()
        XCTAssertEqual(hex, doc.compiled.sha256)
        XCTAssertTrue(hex.hasPrefix("783f4b7c"))

        var later = doc
        later.compiled.compiledAt = "2030-01-01T00:00:00Z"
        later.compiled.sha256 = String(repeating: "0", count: 64)
        XCTAssertEqual(try JCS.canonicalData(later.hashInput), try JCS.canonicalData(doc.hashInput))

        var changed = doc
        changed.choreography.scenes[0].title = "Outro título"
        XCTAssertNotEqual(try JCS.canonicalData(changed.hashInput), try JCS.canonicalData(doc.hashInput))
    }

    func testAC07_dragFixtureDecodesToTypedPointsAndTargets() throws {
        let doc = try Choreography.decode(Fixtures.json(Fixtures.protocolDir.appending(path: "Choreography.ac07.json")))
        let steps = doc.scenes[0].steps
        guard case .drag(let stage) = steps[0].action, case .drag(let screen) = steps[1].action else {
            return XCTFail("esperava dois drag")
        }
        XCTAssertEqual(stage.from, .target(Target(ref: "focusStage")))
        XCTAssertEqual(stage.to, .target(Target(ref: "focusStage", offset: Offset(dx: 0, dy: 200))))
        XCTAssertEqual(stage.velocity, 1000)
        XCTAssertNil(stage.durationMs)
        XCTAssertEqual(screen.from, .point(.normalized(nx: 0.5, ny: 0.6)))
        XCTAssertEqual(screen.to, .point(.absolute(x: 195, y: 300)))
        XCTAssertEqual(screen.durationMs, 500)
        XCTAssertEqual(doc.targets["focusStage"], Target(label: "Focus", type: .button))
    }

    func testEventKeepsFieldsOfOtherSectionsAndChecksEveryNsField() throws {
        let response = try Fixtures.json(Fixtures.protocolDir.appending(path: "RpcResponse.events.fetch.json"))
        let result = try EventsFetchResult.decode(try XCTUnwrap(response["result"]))
        let state = result.events[1]
        XCTAssertEqual(state.kind, .deviceState)
        XCTAssertEqual(state.extra["locked"], .bool(false))
        XCTAssertEqual(state.extra["network"], .string("online"))
        XCTAssertEqual(state.extra["foregroundApp"], .string("com.example.target"))
        XCTAssertEqual(state.tDevStartNs, Nanos(873_461_900_000_000))

        var nested = state.json.objectValue!
        nested["detail"] = ["burst": ["tObsNs": 12]]
        XCTAssertThrowsError(try Event.decode(.object(nested))) { error in
            let issues = (error as? ValidationError)?.issues ?? []
            XCTAssertTrue(issues.contains { $0.path == "detail.burst.tObsNs" && $0.rule == Rule.int64String.rawValue }, "\(issues)")
        }
        for bad in ["-0", "01", "9223372036854775808", "1.5", "+5", ""] {
            XCTAssertNil(Nanos(decimal: bad), bad)
        }
        XCTAssertEqual(Nanos(decimal: "-9223372036854775808")?.value, Int64.min)
        XCTAssertEqual(Nanos(decimal: "0")?.value, 0)
    }

    func testNullVideoTimeIsKeptDistinctFromAbsent() throws {
        let withNull = try Event.decode(["seq": 1, "kind": "step.end", "tVideoObservedS": nil])
        XCTAssertEqual(withNull.tVideoObservedS, .null)
        XCTAssertEqual(withNull.json["tVideoObservedS"], .null)
        let absent = try Event.decode(["seq": 1, "kind": "step.end"])
        XCTAssertNil(absent.tVideoObservedS)
        XCTAssertNil(absent.json["tVideoObservedS"])
        XCTAssertThrowsError(try Event.decode(["seq": 1, "kind": "step.end", "tRecS": 1.2345]))
    }

    func testChangedIsAcceptedOnlyInExpectAtAnyDepth() throws {
        let changed: JSONValue = ["element": ["labelPrefix": "Synced"], "state": "changed"]
        XCTAssertNoThrow(try Step.decode(["do": "tap", "target": ["label": "Go"], "expect": ["not": ["all": [changed]]]]))
        for (step, path) in [
            (["do": "assert", "condition": changed] as JSONValue, "condition.state"),
            (["do": "block", "when": changed, "steps": []], "when.state"),
            (["do": "home", "repeat": ["until": ["any": [changed]], "max": 2]], "repeat.until.any[0].state"),
            (["id": "cp", "do": "checkpoint", "who": "human", "ask": "?", "until": changed, "timeoutMs": 1, "onTimeout": "pause"],
             "until.state"),
        ] {
            XCTAssertThrowsError(try Step.decode(step)) { error in
                let issues = (error as? ValidationError)?.issues ?? []
                XCTAssertTrue(issues.contains { $0.path == path && $0.rule == Rule.changedOnlyInExpect.rawValue }, "\(path): \(issues)")
            }
        }
    }

    func testAC03_primarySelectorRuleOnLooseTargets() throws {
        for bad: JSONValue in [["label": "Focus", "point": ["x": 10, "y": 20]], ["ref": "focusStage", "identifier": "focus-stage"]] {
            XCTAssertThrowsError(try Target.decode(bad)) { error in
                let validation = error as? ValidationError
                XCTAssertEqual(validation?.code, .choreoInvalid)
                XCTAssertEqual(validation?.issues.first?.rule, Rule.onePrimarySelector.rawValue)
            }
        }
        XCTAssertEqual(try Target.decode(["label": "Focus", "type": "button"]), Target(label: "Focus", type: .button))
        XCTAssertEqual(try Target.decode(["type": "tabBar"]), Target(type: .tabBar))
    }

    func testElementTypeOrderMatchesTheXCUIElementRawValues() {
        XCTAssertEqual(ElementType.allCases.count, 83)
        XCTAssertEqual(ElementType.any.xcuiRawValue, 0)
        XCTAssertEqual(ElementType.button.xcuiRawValue, 9)
        XCTAssertEqual(ElementType.staticText.xcuiRawValue, 48)
        XCTAssertEqual(ElementType.statusItem.xcuiRawValue, 82)
    }
}

/// Achados da revisão independente da T-0.4: as regras do Swift iguais às do Mac (`mac/src/core/schema.ts`,
/// valores conferidos com o `validate` real) e nomes de campo comparados unidade a unidade.
final class MacParityTests: XCTestCase {
    func issues(_ body: () throws -> Void) -> [ValidationIssue] {
        do {
            try body()
            return []
        } catch let error as ValidationError {
            return error.issues
        } catch {
            XCTFail("esperava ValidationError, veio \(error)")
            return []
        }
    }

    func assertIssue(_ path: String, _ rule: Rule, _ body: () throws -> Void, file: StaticString = #filePath, line: UInt = #line) {
        let found = issues(body)
        XCTAssertTrue(found.contains { $0.path == path && $0.rule == rule.rawValue },
                      "esperava \(path) [\(rule.rawValue)]; veio \(found)", file: file, line: line)
    }

    /// Achado 1: `from`/`to`/`via[i]` que não é objeto sai com `type` (Mac: `keyedUnion` → `invalid_type`).
    func testPointOrTargetThatIsNotAnObjectIsATypeError() {
        let point: JSONValue = ["x": 1, "y": 2]
        for bad: JSONValue in [5, nil, "abc", [], true] {
            assertIssue("from", .type) { _ = try Step.decode(["do": "drag", "from": bad, "to": point]) }
            assertIssue("to", .type) { _ = try Step.decode(["do": "drag", "from": point, "to": bad]) }
            assertIssue("via[0]", .type) { _ = try Step.decode(["do": "drag", "from": point, "to": point, "via": [bad]]) }
            XCTAssertFalse(issues { _ = try Step.decode(["do": "drag", "from": bad, "to": point]) }
                .contains { $0.rule == Rule.pointForm.rawValue })
        }
        assertIssue("", .type) { _ = try Point.decode(5) }
        assertIssue("point", .type) { _ = try Target.decode(["point": 5]) }
    }

    /// Achado 4: inteiro fora do intervalo seguro sai com `range` (Mac: `z.int()` → `too_big`/`too_small`);
    /// não inteiro continua `type`.
    func testUnsafeIntegersAreARangeErrorAndFractionsATypeError() {
        for n: Double in [9_007_199_254_740_992, 1e21, 1e300, -9_007_199_254_740_992] {
            let value = JSONValue.number(n)
            assertIssue("seq", .range) { _ = try Event.decode(["seq": value, "kind": "step.end"]) }
            assertIssue("ms", .range) { _ = try Step.decode(["do": "wait", "ms": value]) }
            assertIssue("index", .range) { _ = try Target.decode(["label": "a", "index": value]) }
            assertIssue("durationMs", .range) { _ = try Step.decode(["do": "longPress", "target": ["label": "a"], "durationMs": value]) }
            assertIssue("params.sinceSeq", .range) {
                _ = try RpcSchema.request(["jsonrpc": "2.0", "id": 1, "method": "events.fetch",
                                           "params": ["takeId": "20261016-143000-x", "sinceSeq": value]], method: "events.fetch")
            }
            assertIssue("id", .range) {
                _ = try RpcSchema.request(["jsonrpc": "2.0", "id": value, "method": "health", "params": [:]], method: "health")
            }
            assertIssue("error.code", .range) { _ = try RpcFailure.decode(["jsonrpc": "2.0", "id": 1, "error": ["code": value, "message": "x"]]) }
        }
        let largest = JSONValue.number(9_007_199_254_740_991)
        XCTAssertNoThrow(try Event.decode(["seq": largest, "kind": "step.end"]))
        XCTAssertNoThrow(try RpcSchema.request(["jsonrpc": "2.0", "id": largest, "method": "health", "params": [:]], method: "health"))
        assertIssue("seq", .type) { _ = try Event.decode(["seq": 1.5, "kind": "step.end"]) }
        assertIssue("id", .type) { _ = try RpcSchema.request(["jsonrpc": "2.0", "id": 1.5, "method": "health", "params": [:]], method: "health") }
    }

    /// Achado 2: "é" em NFC e em NFD são chaves diferentes (RFC 8259 §8.3; o `JSON.parse` do Mac mantém as
    /// duas). O JCS as ordena por UTF-16, como o Mac: bytes `7b2265cc81223a322c22c3a9223a317d`.
    func testCanonicallyEquivalentKeysStayDistinctAndSortByUTF16() throws {
        let nfc = "\u{E9}", nfd = "e\u{301}"
        let value = try JSONParser.parse("{\"\(nfc)\":1,\"\(nfd)\":2}")
        let fields = try XCTUnwrap(value.objectValue)
        XCTAssertEqual(fields.count, 2)
        XCTAssertEqual(fields[JSONKey(nfc)], 1)
        XCTAssertEqual(fields[JSONKey(nfd)], 2)
        let canonical = try JCS.canonicalize(value)
        XCTAssertEqual(Array(canonical.utf8).map { String(format: "%02x", $0) }.joined(), "7b2265cc81223a322c22c3a9223a317d")
        XCTAssertEqual(canonical.unicodeScalars.map(\.value), "{\"\(nfd)\":2,\"\(nfc)\":1}".unicodeScalars.map(\.value))

        XCTAssertThrowsError(try JSONParser.parse(#"{"a":1,"a":2}"#))
        XCTAssertThrowsError(try JSONParser.parse("{\"\(nfd)\":1,\"\(nfd)\":2}"))

        // Igualdade semântica unidade a unidade (como o `deepStrictEqual` do Mac), em chaves e em strings.
        XCTAssertNotEqual(JSONValue.object([JSONKey(nfc): 1]), .object([JSONKey(nfd): 1]))
        XCTAssertNotEqual(JSONValue.string(nfc), .string(nfd))
        XCTAssertEqual(JSONValue.string(nfc), .string("\u{E9}"))

        // Campo extra de evento e alvo do catálogo com as duas formas: preservados, nada fundido.
        let event = try Event.decode(["seq": 1, "kind": "obs.state", JSONKey(nfc): 1, JSONKey(nfd): 2])
        XCTAssertEqual(event.extra.count, 2)
        XCTAssertEqual(try JCS.canonicalize(event.json), #"{"e\#u{301}":2,"kind":"obs.state","seq":1,"\#u{E9}":1}"#)

        // U+212A (KELVIN SIGN) é canonicamente igual a "K" para o `String` do Swift, mas é outra chave no JSON.
        XCTAssertEqual("\u{212A}", "K")
        XCTAssertNotEqual(JSONKey("\u{212A}"), JSONKey("K"))
        XCTAssertFalse(Set<JSONKey>(["K"]).contains(JSONKey("\u{212A}")))
        assertIssue(#"["\#u{212A}"]"#, .unknownField) { _ = try Point.decode(["x": 1, "y": 2, JSONKey("\u{212A}"): 3]) }
    }
}
