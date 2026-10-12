import Foundation

/// Valor que não é I-JSON (RFC 8785 §3.2.2.2): número não finito.
public struct JCSError: Error, Sendable, Equatable, CustomStringConvertible {
    public let reason: String

    public var description: String { "JCS: \(reason)" }
}

/// JCS — JSON Canonicalization Scheme (RFC 8785), espelho de `mac/src/core/jcs.ts`. Usado na comparação
/// byte a byte das fixtures com o Mac (AC-0.6) e no `compiled.sha256` da coreografia (S0.4).
///
/// Regras: sem espaços; chaves ordenadas pelas unidades de código UTF-16; strings como no
/// `JSON.stringify` do ECMAScript (escapa só `"`, `\` e os controles < U+0020, com `\b \t \n \f \r`
/// curtos e o resto como `\u00xx` minúsculo); números pelo `Number.prototype.toString` do ECMAScript,
/// com -0 → `0`; NaN e ±Infinity não são JSON. Uma `String` do Swift nunca tem surrogate isolado (o
/// leitor de JSON já os recusa), então toda string é I-JSON.
public enum JCS {
    /// Texto canônico de um valor JSON.
    public static func canonicalize(_ value: JSONValue) throws(JCSError) -> String {
        var out = ""
        try write(value, into: &out)
        return out
    }

    /// Bytes UTF-8 do texto canônico (a entrada do SHA-256 de S0.4).
    public static func canonicalData(_ value: JSONValue) throws(JCSError) -> Data {
        Data(try canonicalize(value).utf8)
    }

    private static func write(_ value: JSONValue, into out: inout String) throws(JCSError) {
        switch value {
        case .null: out += "null"
        case .bool(let flag): out += flag ? "true" : "false"
        case .number(let number): out += try serialize(number: number)
        case .string(let text): serialize(string: text, into: &out)
        case .array(let items):
            out += "["
            for (position, item) in items.enumerated() {
                if position > 0 { out += "," }
                try write(item, into: &out)
            }
            out += "]"
        case .object(let fields):
            out += "{"
            for (position, key) in fields.keys.sorted().enumerated() {  // por unidades UTF-16
                if position > 0 { out += "," }
                serialize(string: key.string, into: &out)
                out += ":"
                try write(fields[key]!, into: &out)
            }
            out += "}"
        }
    }

    /// String como o `JSON.stringify` do ECMAScript (QuoteJSONString).
    public static func serialize(string text: String, into out: inout String) {
        out += "\""
        for scalar in text.unicodeScalars {
            switch scalar.value {
            case 0x22: out += "\\\""
            case 0x5C: out += "\\\\"
            case 0x08: out += "\\b"
            case 0x09: out += "\\t"
            case 0x0A: out += "\\n"
            case 0x0C: out += "\\f"
            case 0x0D: out += "\\r"
            case 0x00..<0x20:
                let hex = String(scalar.value, radix: 16)
                out += "\\u" + String(repeating: "0", count: 4 - hex.count) + hex
            default: out.unicodeScalars.append(scalar)
            }
        }
        out += "\""
    }

    /// Número pelo algoritmo `Number::toString` do ECMAScript (o que a RFC 8785 §3.2.2.3 adota).
    ///
    /// Os dígitos vêm da descrição do `Double` do Swift, que já é a mais curta que volta ao mesmo valor
    /// e, entre as mais curtas, a mais próxima (as mesmas exigências do ECMAScript); daqui só se reescreve
    /// a forma (posição do ponto, zeros e expoente).
    public static func serialize(number value: Double) throws(JCSError) -> String {
        guard value.isFinite else { throw JCSError(reason: "número não finito (\(value)) não é JSON") }
        if value == 0 { return "0" }  // inclui -0
        let (digits, n) = shortestDigits(of: value.magnitude)
        let k = digits.count
        var out = value < 0 ? "-" : ""
        if k <= n && n <= 21 {
            out += String(digits) + String(repeating: "0", count: n - k)
        } else if 0 < n && n <= 21 {
            out += String(digits[0..<n]) + "." + String(digits[n...])
        } else if -6 < n && n <= 0 {
            out += "0." + String(repeating: "0", count: -n) + String(digits)
        } else {
            let exponent = n - 1
            out += String(digits[0])
            if k > 1 { out += "." + String(digits[1...]) }
            out += exponent >= 0 ? "e+\(exponent)" : "e-\(-exponent)"
        }
        return out
    }

    /// Dígitos decimais `d₁…dₖ` (sem zeros nas pontas) e `n` tais que o valor é `0.d₁…dₖ × 10ⁿ`.
    private static func shortestDigits(of magnitude: Double) -> (digits: [Character], n: Int) {
        let text = magnitude.description  // ex.: "5e-324", "0.001", "9007199254740992.0", "1.7976931348623157e+308"
        let parts = text.split(separator: "e", maxSplits: 1)
        let mantissa = parts[0]
        let exponent = parts.count > 1 ? Int(parts[1])! : 0
        let pieces = mantissa.split(separator: ".", maxSplits: 1, omittingEmptySubsequences: false)
        let integerPart = Array(pieces[0])
        let fractionPart = pieces.count > 1 ? Array(pieces[1]) : []
        var digits = integerPart + fractionPart
        var n = integerPart.count + exponent
        while digits.first == "0" {
            digits.removeFirst()
            n -= 1
        }
        while digits.last == "0" { digits.removeLast() }
        return (digits, n)
    }
}
