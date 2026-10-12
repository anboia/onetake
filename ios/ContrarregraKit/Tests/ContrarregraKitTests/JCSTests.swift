import CryptoKit
import Foundation
import XCTest

@testable import ContrarregraKit

/// JCS (RFC 8785) e o leitor de I-JSON: os mesmos vetores que o Mac usa (`mac/test/fixtures/protocol/jcs/`).
final class JCSTests: XCTestCase {
    func testNumbersFollowTheIEEE754VectorsOfRFC8785AppendixB() throws {
        let vectors = try XCTUnwrap(Fixtures.json(Fixtures.jcsDir.appending(path: "numbers.json")).arrayValue)
        XCTAssertGreaterThanOrEqual(vectors.count, 25)
        for vector in vectors {
            let bits = try XCTUnwrap(vector["bits"]?.stringValue)
            let pattern = try XCTUnwrap(UInt64(bits.dropFirst(2), radix: 16), bits)
            let value = Double(bitPattern: pattern)
            if vector["error"] == .bool(true) {
                XCTAssertThrowsError(try JCS.serialize(number: value), bits)
                XCTAssertThrowsError(try JCS.canonicalize(.number(value)), bits)
            } else {
                XCTAssertEqual(try JCS.serialize(number: value), vector["expected"]?.stringValue, bits)
            }
        }
    }

    func testRFC8785ExamplesFromInputTextToCanonicalText() throws {
        let inputs = try Fixtures.files(Fixtures.jcsDir, extension: "json").filter { $0 != "numbers.json" }
        XCTAssertGreaterThanOrEqual(inputs.count, 2)
        for file in inputs {
            let expected = try Fixtures.text(Fixtures.jcsDir.appending(path: String(file.dropLast(5)) + ".jcs"))
            XCTAssertEqual(try JCS.canonicalize(Fixtures.json(Fixtures.jcsDir.appending(path: file))), expected, file)
        }
    }

    func testKeyOrderByUTF16NegativeZeroNestingAndControlCharacters() throws {
        let value: JSONValue = ["b": [1, ["d": true, "c": nil]], "a": "x", "": .number(-0.0)]
        XCTAssertEqual(try JCS.canonicalize(value), #"{"":0,"a":"x","b":[1,{"c":null,"d":true}]}"#)
        XCTAssertEqual(try JCS.canonicalize([]), "[]")
        XCTAssertEqual(try JCS.canonicalize([:]), "{}")
        XCTAssertEqual(try JCS.canonicalize(" \u{7}"), #"" \u0007""#)
        XCTAssertEqual(try JCS.canonicalize("\u{8}\t\n\u{c}\r\u{1f}\u{7f}\u{2028}"), #""\b\t\n\f\r\u001f"# + "\u{7f}\u{2028}\"")
        // U+1F600 vem antes de U+FB33 em UTF-16 (0xD83D < 0xFB33) — o contrário da ordem por code point.
        XCTAssertEqual(try JCS.canonicalize(["\u{FB33}": 2, "\u{1F600}": 1]), "{\"\u{1F600}\":1,\"\u{FB33}\":2}")
        XCTAssertThrowsError(try JCS.canonicalize(.number(.nan)))
        XCTAssertThrowsError(try JCS.canonicalize(.number(-.infinity)))
    }

    func testSha256OfTheCanonicalBytesMatchesTheMacExample() throws {
        let value: JSONValue = ["é": 1, "a": [0.5, "ü"]]
        XCTAssertEqual(try JCS.canonicalize(value), #"{"a":[0.5,"ü"],"é":1}"#)
        let expected = SHA256.hash(data: Data(#"{"a":[0.5,"ü"],"é":1}"#.utf8))
        XCTAssertEqual(SHA256.hash(data: try JCS.canonicalData(value)), expected)
    }

    func testNumberTextRoundTripsToTheSameDoubleForRandomBitPatterns() throws {
        var rng = SplitMix64(seed: 0x5EED_0006)
        var checked = 0
        while checked < 20_000 {
            let value = Double(bitPattern: rng.next())
            guard value.isFinite else { continue }
            let text = try JCS.serialize(number: value)
            XCTAssertEqual(Double(text), value == 0 ? 0 : value, text)
            XCTAssertFalse(text.contains("e") && !text.contains("e+") && !text.contains("e-"), text)
            checked += 1
        }
        for (value, text) in [(1.0, "1"), (100.0, "100"), (0.1, "0.1"), (1e21, "1e+21"), (1e-7, "1e-7"), (123e-20, "1.23e-18"),
                              (-1.5, "-1.5"), (31.391, "31.391"), (5730.0, "5730")] {
            XCTAssertEqual(try JCS.serialize(number: value), text)
        }
    }

    func testParserAcceptsJSONAndRejectsWhatIsNotIJSON() throws {
        XCTAssertEqual(try JSONParser.parse(#" {"a": [1, -2.5e3, true, false, null, "é😀\/"]} "#),
                       ["a": [1, -2500, true, false, nil, "é😀/"]])
        let rejected = [
            #"{"a": 1, "a": 2}"#,  // chave repetida
            #""\ud800""#,  // surrogate isolado
            #""\udc00x""#,
            "1e400",  // fora do Double
            "[1] x",  // texto depois do valor
            "\"a\u{1}\"",  // controle sem escape
            "01",  // zero à esquerda
            "[1,]",
            "{\"a\" 1}",
            "nul",
            "",
            String(repeating: "[", count: JSONParser.maxDepth + 1) + String(repeating: "]", count: JSONParser.maxDepth + 1),
        ]
        for text in rejected {
            XCTAssertThrowsError(try JSONParser.parse(text), text)
        }
        XCTAssertThrowsError(try JSONParser.parse(Data([0x22, 0xC3, 0x28, 0x22])), "UTF-8 inválido")
        XCTAssertNoThrow(try JSONParser.parse(String(repeating: "[", count: JSONParser.maxDepth) + String(repeating: "]", count: JSONParser.maxDepth)))
    }
}

/// Gerador pseudoaleatório com semente (testes reproduzíveis).
struct SplitMix64: RandomNumberGenerator {
    private var state: UInt64

    init(seed: UInt64) {
        state = seed
    }

    mutating func next() -> UInt64 {
        state &+= 0x9E37_79B9_7F4A_7C15
        var z = state
        z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
        z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
        return z ^ (z >> 31)
    }
}
