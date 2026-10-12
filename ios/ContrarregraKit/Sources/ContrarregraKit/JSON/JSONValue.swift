import Foundation

/// Nome de campo de um objeto JSON, comparado unidade a unidade (RFC 8259 §8.3; é o que o `JSON.parse` do
/// Mac faz) — e não pela equivalência canônica do `String` do Swift, que fundiria "é" em NFC e em NFD (ou
/// U+212A e "K"). Ordem (`<`) = unidades de código UTF-16, a do JCS (RFC 8785 §3.2.3).
public struct JSONKey: Sendable, Hashable, Comparable, ExpressibleByStringLiteral, CustomStringConvertible {
    public let string: String

    public init(_ string: String) {
        self.string = string
    }

    public init(stringLiteral value: String) {
        string = value
    }

    public static func == (lhs: JSONKey, rhs: JSONKey) -> Bool {
        lhs.string.unicodeScalars.elementsEqual(rhs.string.unicodeScalars)
    }

    public func hash(into hasher: inout Hasher) {
        for scalar in string.unicodeScalars { hasher.combine(scalar.value) }
    }

    public static func < (lhs: JSONKey, rhs: JSONKey) -> Bool {
        lhs.string.utf16.lexicographicallyPrecedes(rhs.string.utf16)
    }

    public var description: String { string }
}

/// Objeto JSON: campos pelo nome exato.
public typealias JSONObject = [JSONKey: JSONValue]

/// Valor JSON (RFC 8259) no modelo I-JSON (RFC 7493): números em `Double`, como o `JSON.parse` do lado do
/// Mac. A igualdade é semântica (objetos sem ordem de chaves; números pelo valor) e compara nomes e strings
/// unidade a unidade, como o `assert.deepStrictEqual` dos testes TypeScript (AC-0.6).
public enum JSONValue: Sendable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object(JSONObject)
}

extension JSONValue: Equatable {
    public static func == (lhs: JSONValue, rhs: JSONValue) -> Bool {
        switch (lhs, rhs) {
        case (.null, .null): true
        case (.bool(let a), .bool(let b)): a == b
        case (.number(let a), .number(let b)): a == b
        case (.string(let a), .string(let b)): a.unicodeScalars.elementsEqual(b.unicodeScalars)
        case (.array(let a), .array(let b)): a == b
        case (.object(let a), .object(let b)): a == b
        default: false
        }
    }
}

extension JSONValue {
    public var objectValue: JSONObject? {
        if case .object(let fields) = self { return fields }
        return nil
    }

    public var arrayValue: [JSONValue]? {
        if case .array(let items) = self { return items }
        return nil
    }

    public var stringValue: String? {
        if case .string(let text) = self { return text }
        return nil
    }

    public var numberValue: Double? {
        if case .number(let number) = self { return number }
        return nil
    }

    public var boolValue: Bool? {
        if case .bool(let flag) = self { return flag }
        return nil
    }

    public var isNull: Bool { self == .null }

    /// Campo de um objeto (`nil` se não é objeto ou não tem a chave exata).
    public subscript(key: String) -> JSONValue? { objectValue?[JSONKey(key)] }

    /// Nome do tipo JSON, para mensagens de erro.
    public var typeName: String {
        switch self {
        case .null: "null"
        case .bool: "booleano"
        case .number: "número"
        case .string: "string"
        case .array: "lista"
        case .object: "objeto"
        }
    }
}

extension JSONValue: ExpressibleByNilLiteral, ExpressibleByBooleanLiteral, ExpressibleByIntegerLiteral,
    ExpressibleByFloatLiteral, ExpressibleByStringLiteral, ExpressibleByArrayLiteral,
    ExpressibleByDictionaryLiteral
{
    public init(nilLiteral: ()) { self = .null }
    public init(booleanLiteral value: Bool) { self = .bool(value) }
    public init(integerLiteral value: Int) { self = .number(Double(value)) }
    public init(floatLiteral value: Double) { self = .number(value) }
    public init(stringLiteral value: String) { self = .string(value) }
    public init(arrayLiteral elements: JSONValue...) { self = .array(elements) }
    public init(dictionaryLiteral elements: (JSONKey, JSONValue)...) {
        var fields: JSONObject = [:]
        for (key, value) in elements { fields[key] = value }
        self = .object(fields)
    }
}

/// Montagem de objetos JSON omitindo campos ausentes (como o `JSON.stringify` omite `undefined`).
extension Dictionary where Key == JSONKey, Value == JSONValue {
    mutating func put(_ key: JSONKey, _ value: JSONValue?) {
        if let value { self[key] = value }
    }
}

/// Tipos que se escrevem como um valor JSON.
public protocol JSONRepresentable {
    var json: JSONValue { get }
}

extension String: JSONRepresentable {
    public var json: JSONValue { .string(self) }
}

extension Bool: JSONRepresentable {
    public var json: JSONValue { .bool(self) }
}

extension Double: JSONRepresentable {
    public var json: JSONValue { .number(self) }
}

extension Int: JSONRepresentable {
    public var json: JSONValue { .number(Double(self)) }
}

extension JSONValue: JSONRepresentable {
    public var json: JSONValue { self }
}

extension Array: JSONRepresentable where Element: JSONRepresentable {
    public var json: JSONValue { .array(map(\.json)) }
}

extension Dictionary: JSONRepresentable where Key == JSONKey, Value: JSONRepresentable {
    public var json: JSONValue { .object(mapValues(\.json)) }
}

extension Optional where Wrapped: JSONRepresentable {
    var json: JSONValue? { map(\.json) }
}
