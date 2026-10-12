import Foundation

// Casamento do texto do OCR (S1 item 6, seletor `ocr` de S0.2, `ui.ocr`): o módulo `OCR` do runner roda o
// Vision (nível acurado, caixa por palavra) e devolve as linhas com as palavras em pontos da tela; aqui se
// acha o texto pedido entre elas.

/// Uma palavra (ou um trecho casado) do OCR, com o frame em pontos da tela.
public struct OcrWord: Sendable, Equatable {
    public var text: String
    public var frame: Rect
    public var confidence: Double

    public init(text: String, frame: Rect, confidence: Double) {
        self.text = text
        self.frame = frame
        self.confidence = confidence
    }

    /// `{text, frame, confidence}` (S1 item 4, `ui.ocr`), com frame em centésimos de ponto e confiança em
    /// milésimos.
    public var json: JSONValue {
        func round(_ value: Double, _ per: Double) -> Double { (value * per).rounded() / per }
        let f = frame
        return ["text": .string(text),
                "frame": Rect(x: round(f.x, 100), y: round(f.y, 100), w: round(f.w, 100), h: round(f.h, 100)).json,
                "confidence": .number(round(confidence, 1000))]
    }
}

/// Uma linha reconhecida pelo Vision, com as palavras na ordem do texto.
public struct OcrLine: Sendable, Equatable {
    public var words: [OcrWord]

    public init(words: [OcrWord]) {
        self.words = words
    }
}

public enum OcrMatcher {
    /// Normaliza uma palavra para comparar: sem diferença de maiúsculas e acentos, sem pontuação nas pontas
    /// (`"shepherd;"` = `"Shepherd"`). Palavra só de pontuação vira `""` e é pulada.
    public static func normalize<S: StringProtocol>(_ word: S) -> String {
        let folded = String(word).folding(options: [.caseInsensitive, .diacriticInsensitive], locale: nil)
        return folded.trimmingCharacters(in: CharacterSet.punctuationCharacters.union(.symbols).union(.whitespaces))
    }

    /// As palavras de um texto, normalizadas, sem as vazias.
    public static func tokens(_ text: String) -> [String] {
        text.split(whereSeparator: \.isWhitespace).map(normalize).filter { !$0.isEmpty }
    }

    /// Todas as palavras com o centro dentro de `region` (todas, sem região), em ordem de leitura.
    public static func words(in lines: [OcrLine], region: Rect? = nil) -> [OcrWord] {
        readingOrder(lines.flatMap(\.words).filter { inside($0.frame, region) })
    }

    /// As ocorrências de `query` (uma palavra ou várias seguidas, na mesma linha), em ordem de leitura
    /// (topo→base, esquerda→direita). Cada ocorrência vira uma caixa: a união das palavras casadas, o texto
    /// delas como o OCR leu e a menor confiança. Só contam palavras com o centro dentro de `region`.
    public static func matches(_ query: String, in lines: [OcrLine], region: Rect? = nil) -> [OcrWord] {
        let wanted = tokens(query)
        guard !wanted.isEmpty else { return [] }
        var found: [OcrWord] = []
        for line in lines {
            let words = line.words.filter { inside($0.frame, region) }
            let normalized = words.map { normalize($0.text) }
            let kept = normalized.indices.filter { !normalized[$0].isEmpty }
            guard kept.count >= wanted.count else { continue }
            for start in 0...(kept.count - wanted.count) {
                let span = kept[start..<(start + wanted.count)]
                guard zip(span, wanted).allSatisfy({ normalized[$0] == $1 }) else { continue }
                let matched = span.map { words[$0] }
                let frame = matched.dropFirst().reduce(matched[0].frame) { $0.union($1.frame) }
                found.append(OcrWord(text: matched.map(\.text).joined(separator: " "), frame: frame,
                                     confidence: matched.map(\.confidence).min() ?? 0))
            }
        }
        return readingOrder(found)
    }

    static func inside(_ frame: Rect, _ region: Rect?) -> Bool {
        guard let region else { return true }
        return region.contains(x: frame.midX, y: frame.midY)
    }

    /// Ordem de leitura de S0.2 (`index`): topo→base, depois esquerda→direita.
    static func readingOrder(_ words: [OcrWord]) -> [OcrWord] {
        words.enumerated().sorted { a, b in
            if a.element.frame.minY != b.element.frame.minY { return a.element.frame.minY < b.element.frame.minY }
            if a.element.frame.minX != b.element.frame.minX { return a.element.frame.minX < b.element.frame.minX }
            return a.offset < b.offset
        }.map(\.element)
    }
}
