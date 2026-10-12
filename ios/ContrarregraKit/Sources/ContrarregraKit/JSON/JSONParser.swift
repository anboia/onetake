import Foundation

/// Erro de leitura de texto JSON: posição em bytes UTF-8 e motivo.
public struct JSONParseError: Error, Sendable, Equatable, CustomStringConvertible {
    public let offset: Int
    public let reason: String

    public var description: String { "JSON inválido no byte \(offset): \(reason)" }
}

/// Leitor de JSON (RFC 8259) escrito à mão, restrito ao I-JSON (RFC 7493), que é a entrada exigida pelo
/// JCS (RFC 8785): recusa chave repetida, surrogate UTF-16 isolado, número fora do `Double` e UTF-8
/// inválido. Números viram `Double` pelo `strtod` correto do Swift — o mesmo valor do `JSON.parse`.
public enum JSONParser {
    /// Profundidade máxima de listas/objetos aninhados (protege a pilha contra entrada hostil).
    public static let maxDepth = 512

    public static func parse(_ text: String) throws(JSONParseError) -> JSONValue {
        try parse(bytes: Array(text.utf8))
    }

    public static func parse(_ data: Data) throws(JSONParseError) -> JSONValue {
        try parse(bytes: [UInt8](data))
    }

    public static func parse(bytes: [UInt8]) throws(JSONParseError) -> JSONValue {
        var scanner = Scanner(bytes: bytes)
        scanner.skipWhitespace()
        let value = try scanner.readValue(depth: 0)
        scanner.skipWhitespace()
        guard scanner.atEnd else { throw scanner.error("texto depois do valor JSON") }
        return value
    }
}

private struct Scanner {
    let bytes: [UInt8]
    var index = 0

    init(bytes: [UInt8]) {
        self.bytes = bytes
    }

    var atEnd: Bool { index >= bytes.count }

    func error(_ reason: String) -> JSONParseError {
        JSONParseError(offset: index, reason: reason)
    }

    func peek() -> UInt8? { atEnd ? nil : bytes[index] }

    mutating func skipWhitespace() {
        while let byte = peek(), byte == 0x20 || byte == 0x09 || byte == 0x0A || byte == 0x0D {
            index += 1
        }
    }

    mutating func expect(_ literal: String, _ value: JSONValue) throws(JSONParseError) -> JSONValue {
        for byte in literal.utf8 {
            guard peek() == byte else { throw error("esperava \(literal)") }
            index += 1
        }
        return value
    }

    mutating func readValue(depth: Int) throws(JSONParseError) -> JSONValue {
        guard let byte = peek() else { throw error("fim inesperado do texto") }
        switch byte {
        case UInt8(ascii: "{"): return try readObject(depth: depth + 1)
        case UInt8(ascii: "["): return try readArray(depth: depth + 1)
        case UInt8(ascii: "\""): return .string(try readString())
        case UInt8(ascii: "t"): return try expect("true", .bool(true))
        case UInt8(ascii: "f"): return try expect("false", .bool(false))
        case UInt8(ascii: "n"): return try expect("null", .null)
        case UInt8(ascii: "-"), UInt8(ascii: "0")...UInt8(ascii: "9"): return .number(try readNumber())
        default: throw error("caractere inesperado")
        }
    }

    mutating func readObject(depth: Int) throws(JSONParseError) -> JSONValue {
        guard depth <= JSONParser.maxDepth else { throw error("aninhamento acima de \(JSONParser.maxDepth)") }
        index += 1  // {
        var fields: JSONObject = [:]
        skipWhitespace()
        if peek() == UInt8(ascii: "}") {
            index += 1
            return .object(fields)
        }
        while true {
            skipWhitespace()
            guard peek() == UInt8(ascii: "\"") else { throw error("esperava a chave do objeto entre aspas") }
            let keyOffset = index
            // Repetida só se idêntica unidade a unidade (RFC 8259 §8.3): "é" em NFC e em NFD são duas chaves.
            let key = JSONKey(try readString())
            guard fields[key] == nil else {
                throw JSONParseError(offset: keyOffset, reason: "chave \"\(key)\" repetida (I-JSON, RFC 7493)")
            }
            skipWhitespace()
            guard peek() == UInt8(ascii: ":") else { throw error("esperava ':'") }
            index += 1
            skipWhitespace()
            fields[key] = try readValue(depth: depth)
            skipWhitespace()
            switch peek() {
            case UInt8(ascii: ","): index += 1
            case UInt8(ascii: "}"):
                index += 1
                return .object(fields)
            default: throw error("esperava ',' ou '}'")
            }
        }
    }

    mutating func readArray(depth: Int) throws(JSONParseError) -> JSONValue {
        guard depth <= JSONParser.maxDepth else { throw error("aninhamento acima de \(JSONParser.maxDepth)") }
        index += 1  // [
        var items: [JSONValue] = []
        skipWhitespace()
        if peek() == UInt8(ascii: "]") {
            index += 1
            return .array(items)
        }
        while true {
            skipWhitespace()
            items.append(try readValue(depth: depth))
            skipWhitespace()
            switch peek() {
            case UInt8(ascii: ","): index += 1
            case UInt8(ascii: "]"):
                index += 1
                return .array(items)
            default: throw error("esperava ',' ou ']'")
            }
        }
    }

    mutating func readDigits() -> Int {
        let start = index
        while let byte = peek(), byte >= UInt8(ascii: "0"), byte <= UInt8(ascii: "9") { index += 1 }
        return index - start
    }

    mutating func readNumber() throws(JSONParseError) -> Double {
        let start = index
        if peek() == UInt8(ascii: "-") { index += 1 }
        if peek() == UInt8(ascii: "0") {
            index += 1
        } else {
            guard readDigits() > 0 else { throw error("número sem dígitos") }
        }
        if peek() == UInt8(ascii: ".") {
            index += 1
            guard readDigits() > 0 else { throw error("número sem dígitos depois do ponto") }
        }
        if peek() == UInt8(ascii: "e") || peek() == UInt8(ascii: "E") {
            index += 1
            if peek() == UInt8(ascii: "+") || peek() == UInt8(ascii: "-") { index += 1 }
            guard readDigits() > 0 else { throw error("expoente sem dígitos") }
        }
        let text = String(decoding: bytes[start..<index], as: UTF8.self)
        guard let value = Double(text), value.isFinite else {
            throw JSONParseError(offset: start, reason: "número \(text) fora do intervalo do Double (I-JSON)")
        }
        return value
    }

    mutating func readHex4() throws(JSONParseError) -> UInt32 {
        var value: UInt32 = 0
        for _ in 0..<4 {
            guard let byte = peek() else { throw error("escape \\u incompleto") }
            let digit: UInt32
            switch byte {
            case UInt8(ascii: "0")...UInt8(ascii: "9"): digit = UInt32(byte - UInt8(ascii: "0"))
            case UInt8(ascii: "a")...UInt8(ascii: "f"): digit = UInt32(byte - UInt8(ascii: "a") + 10)
            case UInt8(ascii: "A")...UInt8(ascii: "F"): digit = UInt32(byte - UInt8(ascii: "A") + 10)
            default: throw error("dígito hexadecimal inválido no escape \\u")
            }
            value = value << 4 | digit
            index += 1
        }
        return value
    }

    func appendUTF8(_ scalar: Unicode.Scalar, to buffer: inout [UInt8]) {
        UTF8.encode(scalar) { buffer.append($0) }
    }

    mutating func readString() throws(JSONParseError) -> String {
        let start = index
        index += 1  // "
        var buffer: [UInt8] = []
        while true {
            guard let byte = peek() else { throw JSONParseError(offset: start, reason: "string sem aspas de fechamento") }
            switch byte {
            case UInt8(ascii: "\""):
                index += 1
                guard let text = String(validating: buffer, as: UTF8.self) else {
                    throw JSONParseError(offset: start, reason: "string com UTF-8 inválido")
                }
                return text
            case UInt8(ascii: "\\"):
                index += 1
                guard let escape = peek() else { throw error("escape incompleto") }
                index += 1
                switch escape {
                case UInt8(ascii: "\""): buffer.append(0x22)
                case UInt8(ascii: "\\"): buffer.append(0x5C)
                case UInt8(ascii: "/"): buffer.append(0x2F)
                case UInt8(ascii: "b"): buffer.append(0x08)
                case UInt8(ascii: "f"): buffer.append(0x0C)
                case UInt8(ascii: "n"): buffer.append(0x0A)
                case UInt8(ascii: "r"): buffer.append(0x0D)
                case UInt8(ascii: "t"): buffer.append(0x09)
                case UInt8(ascii: "u"):
                    let unit = try readHex4()
                    let scalarValue: UInt32
                    if (0xD800...0xDBFF).contains(unit) {
                        guard peek() == UInt8(ascii: "\\"), index + 1 < bytes.count, bytes[index + 1] == UInt8(ascii: "u") else {
                            throw error("surrogate UTF-16 isolado não é I-JSON (RFC 8785 §3.2.2.2)")
                        }
                        index += 2
                        let low = try readHex4()
                        guard (0xDC00...0xDFFF).contains(low) else {
                            throw error("surrogate UTF-16 isolado não é I-JSON (RFC 8785 §3.2.2.2)")
                        }
                        scalarValue = 0x10000 + ((unit - 0xD800) << 10) + (low - 0xDC00)
                    } else if (0xDC00...0xDFFF).contains(unit) {
                        throw error("surrogate UTF-16 isolado não é I-JSON (RFC 8785 §3.2.2.2)")
                    } else {
                        scalarValue = unit
                    }
                    guard let scalar = Unicode.Scalar(scalarValue) else { throw error("escape \\u inválido") }
                    appendUTF8(scalar, to: &buffer)
                default: throw error("escape desconhecido")
                }
            case 0x00..<0x20:
                throw error("caractere de controle sem escape dentro de string")
            default:
                buffer.append(byte)
                index += 1
            }
        }
    }
}
