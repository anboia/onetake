import Foundation

/// Identificadores estáveis das regras de validação — os mesmos de `RULES` em `mac/src/core/schema.ts`
/// (as fixtures inválidas compartilhadas citam a regra esperada).
public enum Rule: String, Sendable, CaseIterable {
    case required = "required"
    case unknownField = "unknown-field"
    case type = "type"
    case value = "value"
    case format = "format"
    case range = "range"
    case pointForm = "S0.2/point-form"
    case onePrimarySelector = "S0.2/one-primary-selector"
    case conditionForm = "S0.3/condition-form"
    case changedOnlyInExpect = "S0.3/changed-only-in-expect"
    case velocityXorDuration = "S0.4/velocity-xor-durationMs"
    case captionMax = "S0.4/caption-max-34"
    case sceneIdUnique = "S0.4/scene-id-unique"
    case refExpanded = "S0.4/ref-expanded"
    case compiledDefaults = "S0.4/compiled-defaults"
    case padMax = "S0.5/pad-max-64KB"
    case int64String = "S0.7/int64-string"
    case seconds3 = "S0.7/seconds-3-decimals"
}

/// Um problema de validação: caminho do campo (`scenes[1].steps[3].tagret`; `""` = o documento), regra e
/// mensagem — a forma `{path, rule, message}` de S3 (`choreo validate`).
public struct ValidationIssue: Sendable, Equatable, CustomStringConvertible {
    public let path: String
    public let rule: String
    public let message: String

    public init(path: String, rule: String, message: String) {
        self.path = path
        self.rule = rule
        self.message = message
    }

    public var description: String { "\(path.isEmpty ? "(raiz)" : path): \(message) [\(rule)]" }

    public var json: JSONValue { ["path": .string(path), "rule": .string(rule), "message": .string(message)] }
}

/// Falha de validação: todos os problemas achados e, quando o tipo tem um, o código de erro do protocolo
/// (ex.: `E_CHOREO_INVALID` para coreografia, alvo, ponto, condição e passo).
public struct ValidationError: Error, Sendable, CustomStringConvertible {
    public let what: String
    public let issues: [ValidationIssue]
    public let code: RunnerErrorCode?

    public var description: String {
        "falha na validação de \(what) — " + issues.map(\.description).joined(separator: "; ")
    }

    /// O erro JSON-RPC equivalente (`data.errors` com os problemas), quando há código.
    public var rpcError: RpcErrorObject? {
        guard let code else { return nil }
        return RpcErrorObject(
            code: code.code,
            message: "\(code.rawValue): \(description)",
            data: ["errors": .array(issues.map(\.json))]
        )
    }
}

/// Caminho de um campo dentro de um documento JSON.
public struct JSONPath: Sendable, Equatable, CustomStringConvertible {
    public enum Segment: Sendable, Equatable {
        case key(String)
        case index(Int)
    }

    public private(set) var segments: [Segment] = []

    public static let root = JSONPath()

    public init() {}

    public func key(_ name: String) -> JSONPath {
        var copy = self
        copy.segments.append(.key(name))
        return copy
    }

    public func index(_ position: Int) -> JSONPath {
        var copy = self
        copy.segments.append(.index(position))
        return copy
    }

    /// `scenes[1].steps[3].tagret`; chaves fora de identificador viram `["PX-1"]` (como `formatPath` do Mac).
    public var description: String {
        var out = ""
        for segment in segments {
            switch segment {
            case .index(let position):
                out += "[\(position)]"
            case .key(let name):
                if Self.isIdentifier(name) {
                    out += out.isEmpty ? name : ".\(name)"
                } else {
                    var quoted = ""
                    JCS.serialize(string: name, into: &quoted)
                    out += "[\(quoted)]"
                }
            }
        }
        return out
    }

    /// `^[A-Za-z_$][A-Za-z0-9_$]*$`
    static func isIdentifier(_ name: String) -> Bool {
        guard let first = name.unicodeScalars.first else { return false }
        func isStart(_ s: Unicode.Scalar) -> Bool {
            ("a"..."z").contains(s) || ("A"..."Z").contains(s) || s == "_" || s == "$"
        }
        return isStart(first) && name.unicodeScalars.allSatisfy { isStart($0) || ("0"..."9").contains($0) }
    }
}

/// Coletor de problemas durante uma validação (um por caminho e regra).
public final class IssueSink {
    public private(set) var issues: [ValidationIssue] = []
    private var seen: Set<String> = []

    public init() {}

    public var isEmpty: Bool { issues.isEmpty }

    public func add(_ path: JSONPath, _ rule: Rule, _ message: String) {
        add(path, rule: rule.rawValue, message)
    }

    public func add(_ path: JSONPath, rule: String, _ message: String) {
        let formatted = path.description
        guard seen.insert("\(formatted)\u{0}\(rule)").inserted else { return }
        issues.append(ValidationIssue(path: formatted, rule: rule, message: message))
    }
}

/// Um tipo de S0 que se lê de um valor JSON com validação (caminho e regra em cada problema) e se escreve
/// de volta como JSON.
public protocol JSONModel: Sendable, Equatable, JSONRepresentable {
    /// Lê `json` (em `path`); devolve `nil` e registra os problemas em `sink` se não for válido.
    static func read(_ json: JSONValue, at path: JSONPath, _ sink: IssueSink) -> Self?

    /// Nome do tipo nas mensagens de erro.
    static var modelName: String { get }

    /// Código de erro do protocolo para quando a validação falha (`nil` = sem código próprio).
    static var invalidCode: RunnerErrorCode? { get }
}

extension JSONModel {
    public static var invalidCode: RunnerErrorCode? { nil }

    /// Valida e devolve o valor, ou lança `ValidationError` com todos os problemas.
    public static func decode(_ json: JSONValue) throws(ValidationError) -> Self {
        let sink = IssueSink()
        if let value = read(json, at: .root, sink), sink.isEmpty { return value }
        throw ValidationError(what: modelName, issues: sink.issues, code: invalidCode)
    }

    /// Lê texto JSON e valida.
    public static func decode(text: String) throws -> Self {
        try decode(JSONParser.parse(text))
    }
}

typealias Reader<T> = @Sendable (JSONValue, JSONPath, IssueSink) -> T?

/// Leitura de um objeto JSON campo a campo: acusa campos fora da lista (`unknown-field`), ausentes
/// (`required`) e inválidos, e segue lendo os demais para juntar todos os problemas.
struct ObjectReader {
    let fields: JSONObject
    let path: JSONPath
    let sink: IssueSink
    private(set) var ok = true

    /// `allowed == nil` = objeto aberto (aceita campos extras). Devolve `nil` se `json` não é objeto. Os
    /// nomes se comparam unidade a unidade (`JSONKey`).
    init?(_ json: JSONValue, at path: JSONPath, _ sink: IssueSink, allowed: Set<JSONKey>?) {
        guard case .object(let fields) = json else {
            sink.add(path, .type, "esperava um objeto, veio \(json.typeName)")
            return nil
        }
        self.fields = fields
        self.path = path
        self.sink = sink
        if let allowed {
            for key in fields.keys.sorted() where !allowed.contains(key) {
                sink.add(path.key(key.string), .unknownField, "campo desconhecido \"\(key)\" (fora de S0)")
                ok = false
            }
        }
    }

    func has(_ key: String) -> Bool { fields[JSONKey(key)] != nil }

    func value(_ key: String) -> JSONValue? { fields[JSONKey(key)] }

    mutating func fail() { ok = false }

    mutating func fail(_ key: String?, _ rule: Rule, _ message: String) {
        sink.add(key.map { path.key($0) } ?? path, rule, message)
        ok = false
    }

    mutating func required<T>(_ key: String, _ read: Reader<T>) -> T? {
        guard let value = value(key) else {
            fail(key, .required, "campo obrigatório ausente")
            return nil
        }
        guard let result = read(value, path.key(key), sink) else {
            ok = false
            return nil
        }
        return result
    }

    mutating func optional<T>(_ key: String, _ read: Reader<T>) -> T? {
        guard let value = value(key) else { return nil }
        guard let result = read(value, path.key(key), sink) else {
            ok = false
            return nil
        }
        return result
    }
}
