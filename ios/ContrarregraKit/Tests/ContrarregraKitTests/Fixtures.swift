import Foundation
import XCTest

@testable import ContrarregraKit

// Fixtures compartilhadas com o Mac (T-0.3, `mac/test/fixtures/protocol/`), lidas daqui pelo caminho do
// repositório (sem copiar para o pacote). Convenção (a mesma de `mac/test/schema.test.ts`):
//   <Tipo>.<caso>.json      válida; decodifica → recodifica (AC-0.6)
//   <Tipo>.<caso>.jcs       bytes UTF-8 esperados do JCS da anterior (sem fim de linha)
//     · para RpcRequest/RpcResponse/RpcNotification o <caso> é o nome do método (ex.: session.hello)
//   invalid/<Tipo>.<caso>.json   {type, method?, expect: {path, rule, code?}, value}
//   jcs/numbers.json        vetores do Apêndice B da RFC 8785 (bits IEEE 754 → texto)
//   jcs/<caso>.json + .jcs  exemplos da RFC 8785 (texto JSON de entrada → JCS)

enum Fixtures {
    /// Raiz do repositório: `ios/ContrarregraKit/Tests/ContrarregraKitTests/<arquivo>` sobe 5 níveis.
    static let repoRoot: URL = {
        var url = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 { url.deleteLastPathComponent() }
        return url
    }()

    static let protocolDir = repoRoot.appending(path: "mac/test/fixtures/protocol")
    static let invalidDir = protocolDir.appending(path: "invalid")
    static let jcsDir = protocolDir.appending(path: "jcs")

    static func files(_ dir: URL, extension ext: String) throws -> [String] {
        try FileManager.default.contentsOfDirectory(atPath: dir.path)
            .filter { $0.hasSuffix(".\(ext)") }
            .sorted()
    }

    static func text(_ url: URL) throws -> String {
        try String(contentsOf: url, encoding: .utf8)
    }

    static func json(_ url: URL) throws -> JSONValue {
        try JSONParser.parse(Data(contentsOf: url))
    }

    /// `<Tipo>.<caso>.json` → tipo e caso (o caso pode ter pontos: é o método nas mensagens RPC).
    static func split(_ file: String) -> (type: String, rest: String) {
        let base = String(file.dropLast(".json".count))
        guard let dot = base.firstIndex(of: ".") else { return (base, "") }
        return (String(base[..<dot]), String(base[base.index(after: dot)...]))
    }
}

struct UnknownFixtureType: Error, CustomStringConvertible {
    let type: String
    var description: String { "fixture de tipo desconhecido no Swift: \(type)" }
}

/// Decodifica uma fixture no modelo tipado do Kit e a reescreve como JSON a partir dele.
enum FixtureCodec {
    static let types: Set<String> = [
        "Point", "Target", "Condition", "Step", "Choreography", "CompiledChoreography", "TreeNode", "Event",
        "RpcRequest", "RpcResponse", "RpcNotification", "RpcError",
    ]

    static func roundTrip(type: String, method: String, _ json: JSONValue) throws -> JSONValue {
        switch type {
        case "Point": return try Point.decode(json).json
        case "Target": return try Target.decode(json).json
        case "Condition": return try Condition.decode(json).json
        case "Step": return try Step.decode(json).json
        case "Choreography": return try Choreography.decode(json).json
        case "CompiledChoreography": return try CompiledChoreography.decode(json).json
        case "TreeNode": return try TreeNode.decode(json).json
        case "Event": return try Event.decode(json).json
        case "RpcRequest": return RpcMessage.request(try RpcSchema.request(json, method: method)).json
        case "RpcResponse": return RpcMessage.success(try RpcSchema.success(json, method: method)).json
        case "RpcNotification": return RpcMessage.notification(try RpcSchema.notification(json, method: method)).json
        case "RpcError": return try RpcFailure.decode(json).json
        default: throw UnknownFixtureType(type: type)
        }
    }
}
