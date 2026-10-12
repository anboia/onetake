import Foundation
import XCTest

@testable import ContrarregraKit

/// Codec JSON-RPC 2.0 (S0.5): texto ↔ mensagem, erros de leitura e a tabela de códigos.
final class RpcCodecTests: XCTestCase {
    func testDecodesTextIntoTheEnvelopeAndEncodesBackAsJCS() throws {
        let file = Fixtures.protocolDir.appending(path: "RpcRequest.session.hello.json")
        let message = try RpcCodec.decode(Fixtures.text(file))
        guard case .request(let request) = message else { return XCTFail("esperava um pedido, veio \(message)") }
        XCTAssertEqual(request.id, .int(1))
        XCTAssertEqual(request.method, "session.hello")
        let params = try SessionHelloParams.decode(.object(try XCTUnwrap(request.params)))
        XCTAssertEqual(params.role, .control)
        XCTAssertEqual(try RpcCodec.encode(message),
                       try Fixtures.text(Fixtures.protocolDir.appending(path: "RpcRequest.session.hello.jcs")))
    }

    func testClassifiesRequestNotificationSuccessAndFailureByShape() throws {
        guard case .notification(let event) = try RpcCodec.decode(#"{"jsonrpc":"2.0","method":"log","params":{"m":"x"}}"#) else {
            return XCTFail("notificação")
        }
        XCTAssertEqual(event.method, "log")
        guard case .success(let success) = try RpcCodec.decode(#"{"jsonrpc":"2.0","id":"a","result":null}"#) else {
            return XCTFail("sucesso")
        }
        XCTAssertEqual(success.id, .string("a"))
        XCTAssertEqual(success.result, .null)
        guard case .failure(let failure) = try RpcCodec.decode(#"{"jsonrpc":"2.0","id":null,"error":{"code":-32001,"message":"E_AUTH"}}"#)
        else { return XCTFail("erro") }
        XCTAssertNil(failure.id)
        XCTAssertEqual(failure.error.code, RunnerErrorCode.auth.code)
    }

    func testUnreadableTextIsParseErrorAndBadEnvelopeIsInvalidRequest() {
        XCTAssertThrowsError(try RpcCodec.decode("{not json")) { error in
            XCTAssertEqual((error as? RpcCodec.DecodeError)?.rpcError.code, -32700)
        }
        for text in [#"{"jsonrpc":"2.0"}"#, #"{"id":1,"method":"health"}"#, #"{"jsonrpc":"1.0","id":1,"method":"health"}"#,
                     #"{"jsonrpc":"2.0","id":1.5,"method":"health"}"#, #"[1]"#] {
            XCTAssertThrowsError(try RpcCodec.decode(text), text) { error in
                XCTAssertEqual((error as? RpcCodec.DecodeError)?.rpcError.code, -32600, text)
            }
        }
    }

    func testTypedBaseMethodsCheckParamsAndResults() throws {
        XCTAssertThrowsError(try RpcSchema.request(["jsonrpc": "2.0", "id": 1, "method": "health"], method: "health")) { error in
            XCTAssertTrue((error as? ValidationError)?.issues.contains { $0.path == "params" && $0.rule == "required" } ?? false)
        }
        XCTAssertThrowsError(try RpcSchema.request(["jsonrpc": "2.0", "id": 1, "method": "health", "params": ["x": 1]], method: "health"))
        XCTAssertNoThrow(try RpcSchema.request(["jsonrpc": "2.0", "id": 1, "method": "ui.tree"], method: "ui.tree"))
        let pad = String(repeating: "x", count: ClockPad.maxBytes)
        XCTAssertNoThrow(try ClockPingParams.decode(["seq": 1, "pad": .string(pad)]))
        XCTAssertThrowsError(try ClockPingParams.decode(["seq": 1, "pad": .string(pad + "é")])) { error in
            XCTAssertEqual((error as? ValidationError)?.issues.first?.rule, Rule.padMax.rawValue)
        }
        XCTAssertThrowsError(try RpcSchema.success(["jsonrpc": "2.0", "id": 1, "result": ["point": ["x": 1, "y": 2]]], method: "ui.tap"))
    }

    func testChoreographyValidationErrorBecomesEChoreoInvalidWithTheIssuesInData() throws {
        let fixture = try Fixtures.json(Fixtures.invalidDir.appending(path: "Choreography.unknown-field.json"))
        XCTAssertThrowsError(try Choreography.decode(try XCTUnwrap(fixture["value"]))) { error in
            let rpc = (error as? ValidationError)?.rpcError
            XCTAssertEqual(rpc?.code, -32040)
            XCTAssertTrue(rpc?.message.hasPrefix("E_CHOREO_INVALID") ?? false)
            let paths = rpc?.data?["errors"]?.arrayValue?.compactMap { $0["path"]?.stringValue } ?? []
            XCTAssertTrue(paths.contains("scenes[1].steps[3].tagret"), "\(paths)")
        }
    }

    func testErrorTableIsTheSameAsTheMacOne() throws {
        let source = try Fixtures.text(Fixtures.repoRoot.appending(path: "mac/src/core/errors.ts"))
        let block = try XCTUnwrap(source.range(of: "RPC_ERROR_CODES = {").map { source[$0.upperBound...] })
        let body = block[..<block.firstIndex(of: "}")!]
        var mac: [String: Int] = [:]
        for line in body.split(separator: "\n") {
            let parts = line.split(separator: ":").map { $0.trimmingCharacters(in: .whitespaces.union(.init(charactersIn: ","))) }
            if parts.count == 2, let code = Int(parts[1]) { mac[parts[0]] = code }
        }
        XCTAssertEqual(mac.count, RunnerErrorCode.allCases.count)
        for code in RunnerErrorCode.allCases {
            XCTAssertEqual(mac[code.rawValue], code.code, code.rawValue)
            XCTAssertEqual(RunnerErrorCode(code: code.code), code)
        }
    }

    func testPathFormattingMatchesTheMac() {
        XCTAssertEqual(JSONPath.root.key("scenes").index(1).key("steps").index(3).key("tagret").description, "scenes[1].steps[3].tagret")
        XCTAssertEqual(JSONPath.root.key("result").key("PX-6").description, #"result["PX-6"]"#)
        XCTAssertEqual(JSONPath.root.description, "")
    }
}
