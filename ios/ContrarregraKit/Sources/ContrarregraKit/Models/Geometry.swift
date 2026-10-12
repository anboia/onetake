import Foundation

// Escalares e geometria de S0 (spec.md S0.2, S0.6, S0.7).

/// Tempo D ou M em nanossegundos (S0.7): inteiro de 64 bits, escrito como string decimal no JSON.
public struct Nanos: Sendable, Hashable, Comparable, JSONRepresentable, CustomStringConvertible {
    public var value: Int64

    public init(_ value: Int64) {
        self.value = value
    }

    /// Lê `^-?(0|[1-9][0-9]*)$` dentro de 64 bits (e não `-0`); `nil` fora disso.
    public init?(decimal text: String) {
        let bytes = Array(text.utf8)
        let digits = bytes.first == UInt8(ascii: "-") ? bytes.dropFirst() : bytes[...]
        guard let first = digits.first, digits.allSatisfy(Formats.isDigit) else { return nil }
        guard first != UInt8(ascii: "0") || digits.count == 1 else { return nil }
        guard text != "-0", let value = Int64(text) else { return nil }
        self.value = value
    }

    static let ruleMessage = "tempo D/M tem de ser inteiro de 64 bits em string decimal (S0.7)"

    public var json: JSONValue { .string(String(value)) }
    public var description: String { String(value) }

    public static func < (lhs: Nanos, rhs: Nanos) -> Bool { lhs.value < rhs.value }
}

/// Valor que pode ser `null` explícito no JSON (diferente de ausente).
public enum Nullable<Wrapped: Sendable & Equatable>: Sendable, Equatable {
    case null
    case value(Wrapped)
}

/// Guarda um valor opcional do próprio tipo (alvo dentro de alvo) fora da estrutura, mantendo semântica
/// de valor.
@propertyWrapper
public struct Boxed<Value: Sendable & Equatable>: Sendable, Equatable {
    private var storage: [Value]

    public init(wrappedValue: Value?) {
        storage = wrappedValue.map { [$0] } ?? []
    }

    public var wrappedValue: Value? {
        get { storage.first }
        set { storage = newValue.map { [$0] } ?? [] }
    }
}

/// Retângulo em pontos (o `frame` de S0.6).
public struct Rect: JSONModel {
    public var x: Double
    public var y: Double
    public var w: Double
    public var h: Double

    public init(x: Double, y: Double, w: Double, h: Double) {
        self.x = x
        self.y = y
        self.w = w
        self.h = h
    }

    public static let modelName = "retângulo"

    public static func read(_ json: JSONValue, at path: JSONPath, _ sink: IssueSink) -> Rect? {
        guard var o = ObjectReader(json, at: path, sink, allowed: ["x", "y", "w", "h"]) else { return nil }
        let x = o.required("x", Read.anyNumber)
        let y = o.required("y", Read.anyNumber)
        let w = o.required("w", Read.number(min: 0))
        let h = o.required("h", Read.number(min: 0))
        guard o.ok, let x, let y, let w, let h else { return nil }
        return Rect(x: x, y: y, w: w, h: h)
    }

    public var json: JSONValue { ["x": .number(x), "y": .number(y), "w": .number(w), "h": .number(h)] }
}

/// Tamanho em pontos (`screenPt`), com lados > 0.
public struct Size: JSONModel {
    public var w: Double
    public var h: Double

    public init(w: Double, h: Double) {
        self.w = w
        self.h = h
    }

    public static let modelName = "tamanho"

    public static func read(_ json: JSONValue, at path: JSONPath, _ sink: IssueSink) -> Size? {
        guard var o = ObjectReader(json, at: path, sink, allowed: ["w", "h"]) else { return nil }
        let w = o.required("w", Read.number(positive: true))
        let h = o.required("h", Read.number(positive: true))
        guard o.ok, let w, let h else { return nil }
        return Size(w: w, h: h)
    }

    public var json: JSONValue { ["w": .number(w), "h": .number(h)] }
}

/// Deslocamento em pontos aplicado ao ponto de um alvo.
public struct Offset: JSONModel {
    public var dx: Double
    public var dy: Double

    public init(dx: Double, dy: Double) {
        self.dx = dx
        self.dy = dy
    }

    public static let modelName = "deslocamento"
    public static var invalidCode: RunnerErrorCode? { .choreoInvalid }

    public static func read(_ json: JSONValue, at path: JSONPath, _ sink: IssueSink) -> Offset? {
        guard var o = ObjectReader(json, at: path, sink, allowed: ["dx", "dy"]) else { return nil }
        let dx = o.required("dx", Read.anyNumber)
        let dy = o.required("dy", Read.anyNumber)
        guard o.ok, let dx, let dy else { return nil }
        return Offset(dx: dx, dy: dy)
    }

    public var json: JSONValue { ["dx": .number(dx), "dy": .number(dy)] }
}

/// Ponto absoluto `{x, y}` em pontos da tela (resposta das ações `ui.*`, S0.5).
public struct AbsolutePoint: JSONModel {
    public var x: Double
    public var y: Double

    public init(x: Double, y: Double) {
        self.x = x
        self.y = y
    }

    public static let modelName = "ponto"

    public static func read(_ json: JSONValue, at path: JSONPath, _ sink: IssueSink) -> AbsolutePoint? {
        guard var o = ObjectReader(json, at: path, sink, allowed: ["x", "y"]) else { return nil }
        let x = o.required("x", Read.anyNumber)
        let y = o.required("y", Read.anyNumber)
        guard o.ok, let x, let y else { return nil }
        return AbsolutePoint(x: x, y: y)
    }

    public var json: JSONValue { ["x": .number(x), "y": .number(y)] }
}

/// Ponto de S0.2: `{x, y}` em pontos da tela ou `{nx, ny}` normalizado (0–1).
public enum Point: JSONModel {
    case absolute(x: Double, y: Double)
    case normalized(nx: Double, ny: Double)

    public static let modelName = "ponto"
    public static var invalidCode: RunnerErrorCode? { .choreoInvalid }

    static let keys: Set<JSONKey> = ["x", "y", "nx", "ny"]

    /// A forma é escolhida pelas chaves presentes, para o erro sair do ramo certo com o caminho exato.
    public static func read(_ json: JSONValue, at path: JSONPath, _ sink: IssueSink) -> Point? {
        guard case .object(let fields) = json else {
            sink.add(path, .type, "esperava um objeto, veio \(json.typeName)")
            return nil
        }
        let absolute = fields["x"] != nil || fields["y"] != nil
        let normalized = fields["nx"] != nil || fields["ny"] != nil
        if absolute && normalized {
            sink.add(path, .pointForm, "ponto mistura {x, y} e {nx, ny}; use uma forma só (S0.2)")
            return nil
        }
        if normalized {
            guard var o = ObjectReader(json, at: path, sink, allowed: ["nx", "ny"]) else { return nil }
            let nx = o.required("nx", Read.number(min: 0, max: 1))
            let ny = o.required("ny", Read.number(min: 0, max: 1))
            guard o.ok, let nx, let ny else { return nil }
            return .normalized(nx: nx, ny: ny)
        }
        if absolute {
            return AbsolutePoint.read(json, at: path, sink).map { .absolute(x: $0.x, y: $0.y) }
        }
        sink.add(path, .pointForm, "ponto precisa de {x, y} em pontos ou {nx, ny} normalizado 0–1 (S0.2)")
        return nil
    }

    public var json: JSONValue {
        switch self {
        case .absolute(let x, let y): ["x": .number(x), "y": .number(y)]
        case .normalized(let nx, let ny): ["nx": .number(nx), "ny": .number(ny)]
        }
    }
}
