import Foundation

/// Leitores de valores escalares e coleções, com as mesmas regras dos esquemas zod do Mac
/// (`mac/src/core/schema.ts`): tipo errado → `type`; valor fora do conjunto → `value`; fora do intervalo
/// → `range`; padrão de texto → `format`.
enum Read {
    /// Maior inteiro exato no `Double` (o `z.int()` do zod só aceita inteiros seguros).
    static let maxSafeInteger: Double = 9_007_199_254_740_991

    static func string(_ json: JSONValue, _ path: JSONPath, _ sink: IssueSink) -> String? {
        guard case .string(let text) = json else {
            sink.add(path, .type, "esperava string, veio \(json.typeName)")
            return nil
        }
        return text
    }

    /// String com ao menos 1 caractere.
    static func nonEmpty(_ json: JSONValue, _ path: JSONPath, _ sink: IssueSink) -> String? {
        guard let text = string(json, path, sink) else { return nil }
        guard !text.isEmpty else {
            sink.add(path, .range, "string vazia; precisa de ao menos 1 caractere")
            return nil
        }
        return text
    }

    static func bool(_ json: JSONValue, _ path: JSONPath, _ sink: IssueSink) -> Bool? {
        guard case .bool(let flag) = json else {
            sink.add(path, .type, "esperava booleano, veio \(json.typeName)")
            return nil
        }
        return flag
    }

    /// Número com limites opcionais (`positive` = > 0).
    static func number(min: Double? = nil, max: Double? = nil, positive: Bool = false) -> Reader<Double> {
        { json, path, sink in
            guard case .number(let value) = json else {
                sink.add(path, .type, "esperava número, veio \(json.typeName)")
                return nil
            }
            if positive, !(value > 0) {
                sink.add(path, .range, "número tem de ser > 0")
                return nil
            }
            if let min, value < min {
                sink.add(path, .range, "número tem de ser ≥ \(min)")
                return nil
            }
            if let max, value > max {
                sink.add(path, .range, "número tem de ser ≤ \(max)")
                return nil
            }
            return value
        }
    }

    static let anyNumber: Reader<Double> = number()

    /// Inteiro seguro (|n| ≤ 2⁵³ − 1) com mínimo opcional. Como o `z.int()` do Mac: não inteiro → `type`;
    /// inteiro fora do intervalo seguro ou abaixo do mínimo → `range`.
    static func int(min: Int? = nil) -> Reader<Int> {
        { json, path, sink in
            guard let integer = safeInteger(json, path, sink) else { return nil }
            if let min, integer < min {
                sink.add(path, .range, "inteiro tem de ser ≥ \(min)")
                return nil
            }
            return integer
        }
    }

    /// O inteiro de `json`, ou `nil` com `type` (não é número inteiro) ou `range` (fora de ±(2⁵³ − 1)).
    static func safeInteger(_ json: JSONValue, _ path: JSONPath, _ sink: IssueSink) -> Int? {
        guard case .number(let value) = json, value.rounded(.towardZero) == value else {
            sink.add(path, .type, "esperava inteiro, veio \(json.typeName == "número" ? "número não inteiro" : json.typeName)")
            return nil
        }
        guard value.magnitude <= maxSafeInteger else {
            sink.add(path, .range, "inteiro fora do intervalo seguro (|n| ≤ 2^53 − 1)")
            return nil
        }
        return Int(value)
    }

    static let nonNegativeInt: Reader<Int> = int(min: 0)
    static let positiveInt: Reader<Int> = int(min: 1)

    static func json(_ json: JSONValue, _ path: JSONPath, _ sink: IssueSink) -> JSONValue? { json }

    /// Objeto JSON com qualquer conteúdo (`detail`, `params` de método sem esquema).
    static func jsonObject(_ json: JSONValue, _ path: JSONPath, _ sink: IssueSink) -> JSONObject? {
        guard case .object(let fields) = json else {
            sink.add(path, .type, "esperava um objeto, veio \(json.typeName)")
            return nil
        }
        return fields
    }

    /// Valor de um conjunto fechado (enum de strings).
    static func oneOf<E: RawRepresentable & CaseIterable & Sendable>(_ type: E.Type) -> Reader<E> where E.RawValue == String {
        let options = E.allCases.map { "\"\($0.rawValue)\"" }.joined(separator: ", ")
        return { json, path, sink in
            if case .string(let text) = json, let value = E(rawValue: text) { return value }
            sink.add(path, .value, "valor inválido; esperava um de: \(options)")
            return nil
        }
    }

    static func literal(_ expected: String) -> Reader<String> {
        { json, path, sink in
            guard case .string(let text) = json, text == expected else {
                sink.add(path, .value, "valor inválido; esperava \"\(expected)\"")
                return nil
            }
            return text
        }
    }

    /// String que satisfaz `matches` (senão `format`, com `message`).
    static func formatted(_ message: String, _ matches: @escaping @Sendable (String) -> Bool) -> Reader<String> {
        { json, path, sink in
            guard let text = string(json, path, sink) else { return nil }
            guard matches(text) else {
                sink.add(path, .format, message)
                return nil
            }
            return text
        }
    }

    static func array<T>(_ element: @escaping Reader<T>) -> Reader<[T]> {
        { json, path, sink in
            guard case .array(let items) = json else {
                sink.add(path, .type, "esperava lista, veio \(json.typeName)")
                return nil
            }
            var out: [T] = []
            var ok = true
            for (position, item) in items.enumerated() {
                if let value = element(item, path.index(position), sink) {
                    out.append(value)
                } else {
                    ok = false
                }
            }
            return ok ? out : nil
        }
    }

    /// Objeto usado como mapa (`targets`), com os nomes exatos.
    static func record<T>(_ element: @escaping Reader<T>) -> Reader<[JSONKey: T]> {
        { json, path, sink in
            guard case .object(let fields) = json else {
                sink.add(path, .type, "esperava um objeto, veio \(json.typeName)")
                return nil
            }
            var out: [JSONKey: T] = [:]
            var ok = true
            for key in fields.keys.sorted() {
                if let value = element(fields[key]!, path.key(key.string), sink) {
                    out[key] = value
                } else {
                    ok = false
                }
            }
            return ok ? out : nil
        }
    }

    static func model<M: JSONModel>(_ type: M.Type) -> Reader<M> {
        { json, path, sink in M.read(json, at: path, sink) }
    }

    // ── Formatos de S0 ────────────────────────────────────────────────────────────────────────────

    /// Tempo D ou M em ns: inteiro de 64 bits em string decimal (S0.7).
    static func nanos(_ json: JSONValue, _ path: JSONPath, _ sink: IssueSink) -> Nanos? {
        if case .string(let text) = json, let value = Nanos(decimal: text) { return value }
        sink.add(path, .int64String, Nanos.ruleMessage)
        return nil
    }

    /// Tempo R ou F em segundos, com até 3 casas (S0.7).
    static func seconds3(_ json: JSONValue, _ path: JSONPath, _ sink: IssueSink) -> Double? {
        guard let value = anyNumber(json, path, sink) else { return nil }
        guard (value * 1000 - (value * 1000).rounded()).magnitude < 1e-6 else {
            sink.add(path, .seconds3, "tempo R/F em segundos com no máximo 3 casas decimais (S0.7)")
            return nil
        }
        return value
    }

    static let sceneId = formatted("id de cena no formato ^s\\d{2}$ (S0.4)", Formats.isSceneId)

    static let sha256Hex = formatted("SHA-256 em hex minúsculo (64 dígitos)") { text in
        text.utf8.count == 64 && text.utf8.allSatisfy { Formats.isDigit($0) || ($0 >= UInt8(ascii: "a") && $0 <= UInt8(ascii: "f")) }
    }

    static let nodeRef = formatted("ref de nó no formato @e<n> (S0.6)") { text in
        let bytes = Array(text.utf8)
        return bytes.count > 2 && bytes[0] == UInt8(ascii: "@") && bytes[1] == UInt8(ascii: "e")
            && bytes[2...].allSatisfy(Formats.isDigit)
    }

    static let takeId = formatted("takeId no formato YYYYMMDD-HHMMSS-<coreografia> (S0.8)", Formats.isTakeId)
}

/// Padrões de texto de S0 (equivalentes às expressões regulares do Mac).
enum Formats {
    static func isDigit(_ byte: UInt8) -> Bool { byte >= UInt8(ascii: "0") && byte <= UInt8(ascii: "9") }

    /// `^s[0-9]{2}$`
    static func isSceneId(_ text: String) -> Bool {
        let bytes = Array(text.utf8)
        return bytes.count == 3 && bytes[0] == UInt8(ascii: "s") && isDigit(bytes[1]) && isDigit(bytes[2])
    }

    /// `^[0-9]{8}-[0-9]{6}-.+$` (o `.` do JavaScript não casa fim de linha).
    static func isTakeId(_ text: String) -> Bool {
        let scalars = Array(text.unicodeScalars)
        guard scalars.count > 16, scalars[8] == "-", scalars[15] == "-" else { return false }
        let digits = scalars[0..<8] + scalars[9..<15]
        guard digits.allSatisfy({ ("0"..."9").contains($0) }) else { return false }
        let lineTerminators: Set<Unicode.Scalar> = ["\n", "\r", "\u{2028}", "\u{2029}"]
        return scalars[16...].allSatisfy { !lineTerminators.contains($0) }
    }
}
