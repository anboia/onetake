import ContrarregraKit
import CoreGraphics
import Foundation
import Vision

/// OCR do runner (módulo `OCR`, architecture.md A2; S1 item 6): roda o Vision só na região pedida da captura,
/// nível acurado, e devolve uma caixa por palavra em pontos da tela. Quem acha o texto pedido entre as palavras
/// é o `OcrMatcher` do Kit; quem decide se pode capturar é a lista permitida (`ReadSession`), antes desta
/// chamada.
///
/// `VNRecognizeTextRequest` síncrono (a fila do XCTest é serial e já espera o resultado); `boundingBox(for:)`
/// no nível acurado dá a caixa da palavra inteira.
struct VisionTextRecognizer {
    struct Failure: Error, CustomStringConvertible {
        let description: String
    }

    /// - Parameters:
    ///   - image: a captura da tela inteira, em pixels;
    ///   - region: a região em pontos da tela;
    ///   - pxPerPoint: pixels por ponto da captura (3 no iPhone 12).
    func recognize(_ image: CGImage, region: Rect, pxPerPoint: Double) throws -> [OcrLine] {
        let bounds = CGRect(x: 0, y: 0, width: image.width, height: image.height)
        let crop = CGRect(x: region.x * pxPerPoint, y: region.y * pxPerPoint,
                          width: region.w * pxPerPoint, height: region.h * pxPerPoint).integral.intersection(bounds)
        guard !crop.isNull, !crop.isEmpty, let cropped = image.cropping(to: crop) else { return [] }

        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        let handler = VNImageRequestHandler(cgImage: cropped, options: [:])
        do {
            try handler.perform([request])
        } catch {
            throw Failure(description: "Vision falhou: \(error.localizedDescription)")
        }

        // Caixas do Vision: normalizadas no recorte, origem embaixo à esquerda → pontos da tela, origem em cima.
        let width = Double(cropped.width)
        let height = Double(cropped.height)
        let originX = Double(crop.minX) / pxPerPoint
        let originY = Double(crop.minY) / pxPerPoint
        var lines: [OcrLine] = []
        for observation in request.results ?? [] {
            guard let candidate = observation.topCandidates(1).first else { continue }
            let text = candidate.string
            let confidence = Double(candidate.confidence)
            var words: [OcrWord] = []
            for word in text.split(whereSeparator: \.isWhitespace) {
                guard let box = try? candidate.boundingBox(for: word.startIndex..<word.endIndex) else { continue }
                let normalized = box.boundingBox
                let frame = Rect(x: originX + Double(normalized.minX) * width / pxPerPoint,
                                 y: originY + (1 - Double(normalized.maxY)) * height / pxPerPoint,
                                 w: Double(normalized.width) * width / pxPerPoint,
                                 h: Double(normalized.height) * height / pxPerPoint)
                words.append(OcrWord(text: String(word), frame: frame, confidence: confidence))
            }
            if !words.isEmpty { lines.append(OcrLine(words: words)) }
        }
        return lines
    }
}
