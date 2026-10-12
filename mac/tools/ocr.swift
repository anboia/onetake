// Ajudante de OCR do Mac (T-0.14; architecture.md A1 e A2 `media`). O Node não chama o Vision: este
// script, rodado com `xcrun swift`, lê quadros PNG e devolve as caixas de texto em JSON. Só frameworks
// da Apple (Vision, CoreText, CoreGraphics, ImageIO), sem dependência nova (P-2).
//
// Uso:
//   xcrun swift mac/tools/ocr.swift [--words] <imagem.png>...
//     stdout: {"images":[{"path","width","height","boxes":[{"text","frame":{"x","y","w","h"},"confidence"}]}]}
//     Vision `RecognizeTextRequest` no nível acurado; `frame` em pixels da imagem, origem no canto
//     superior esquerdo. Uma caixa por linha reconhecida; com `--words`, uma por palavra.
//   xcrun swift mac/tools/ocr.swift --render-text <texto> --out <imagem.png> [--font-size <px>]
//     Desenha o texto (linhas separadas por "\n") em preto sobre branco com o CoreText e grava o PNG
//     — a imagem de teste, já que o ffmpeg 8.1.1 fixado não tem `drawtext`. `--font-size` (padrão 64)
//     tem de ser finito, > 0 e ≤ 512 px; fora disso é uso errado (status 2).
//     stdout: {"path","width","height","lines":[{"text","frame":{"x","y","w","h"}}]}, com o `frame`
//     tipográfico de cada linha em pixels, origem no canto superior esquerdo.
// Saída: 0 = sucesso; 1 = falha (mensagem no stderr); 2 = uso errado.

import CoreGraphics
import CoreText
import Foundation
import ImageIO
import UniformTypeIdentifiers
import Vision

struct Frame: Encodable {
  let x: Double
  let y: Double
  let w: Double
  let h: Double

  init(_ rect: CGRect) {
    func round2(_ value: CGFloat) -> Double { (Double(value) * 100).rounded() / 100 }
    let r = rect.standardized
    x = round2(r.origin.x)
    y = round2(r.origin.y)
    w = round2(r.width)
    h = round2(r.height)
  }
}

struct Box: Encodable {
  let text: String
  let frame: Frame
  let confidence: Double
}

struct ImageResult: Encodable {
  let path: String
  let width: Int
  let height: Int
  let boxes: [Box]
}

struct OcrOutput: Encodable {
  let images: [ImageResult]
}

struct RenderedLine: Encodable {
  let text: String
  let frame: Frame
}

struct RenderOutput: Encodable {
  let path: String
  let width: Int
  let height: Int
  let lines: [RenderedLine]
}

struct ToolError: Error, CustomStringConvertible {
  let description: String
  let usage: Bool

  init(_ description: String, usage: Bool = false) {
    self.description = description
    self.usage = usage
  }
}

/// Teto do `--font-size` em px (o mesmo `MAX_FONT_SIZE` de `mac/src/media/ocr.ts`): folga para quadros
/// de 1080p/1170×2532; acima disso a tela de desenho cresce sem utilidade até esgotar a memória, e
/// `inf` faria o `Int(ceil(...))` do tamanho da tela abortar o processo.
let maxFontSize: Double = 512

let usageText = """
  uso: xcrun swift ocr.swift [--words] <imagem.png>...
       xcrun swift ocr.swift --render-text <texto> --out <imagem.png> [--font-size <px, finito, > 0 e ≤ 512>]
  """

func printJSON<T: Encodable>(_ value: T) throws {
  let encoder = JSONEncoder()
  encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
  var data = try encoder.encode(value)
  data.append(0x0A)
  FileHandle.standardOutput.write(data)
}

// MARK: OCR

func loadImage(_ path: String) throws -> CGImage {
  let url = URL(fileURLWithPath: path)
  guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
    let image = CGImageSourceCreateImageAtIndex(source, 0, nil)
  else {
    throw ToolError("imagem ilegível: \(path)")
  }
  return image
}

func recognize(_ path: String, words: Bool) async throws -> ImageResult {
  let image = try loadImage(path)
  let size = CGSize(width: image.width, height: image.height)
  var request = RecognizeTextRequest()
  request.recognitionLevel = .accurate
  let observations: [RecognizedTextObservation]
  do {
    observations = try await request.perform(on: image)
  } catch {
    throw ToolError("Vision falhou em \(path): \(error)")
  }
  var boxes: [Box] = []
  for observation in observations {
    guard let candidate = observation.topCandidates(1).first else { continue }
    let confidence = Double(candidate.confidence)
    if !words {
      let rect = observation.boundingBox.toImageCoordinates(size, origin: .upperLeft)
      boxes.append(Box(text: candidate.string, frame: Frame(rect), confidence: confidence))
      continue
    }
    let text = candidate.string
    for word in text.split(whereSeparator: { $0.isWhitespace }) {
      guard let wordBox = candidate.boundingBox(for: word.startIndex..<word.endIndex) else { continue }
      let rect = wordBox.boundingBox.toImageCoordinates(size, origin: .upperLeft)
      boxes.append(Box(text: String(word), frame: Frame(rect), confidence: confidence))
    }
  }
  return ImageResult(path: path, width: image.width, height: image.height, boxes: boxes)
}

// MARK: --render-text

func renderText(_ text: String, to path: String, fontSize: CGFloat) throws -> RenderOutput {
  let font = CTFontCreateUIFontForLanguage(.system, fontSize, nil)
    ?? CTFontCreateWithName("Helvetica" as CFString, fontSize, nil)
  let attributes: [NSAttributedString.Key: Any] = [
    NSAttributedString.Key(kCTFontAttributeName as String): font,
    NSAttributedString.Key(kCTForegroundColorAttributeName as String): CGColor(gray: 0, alpha: 1),
  ]
  let texts = text.components(separatedBy: "\n")
  let lines = texts.map { CTLineCreateWithAttributedString(NSAttributedString(string: $0, attributes: attributes)) }

  let ascent = CTFontGetAscent(font)
  let descent = CTFontGetDescent(font)
  let lineHeight = ceil(ascent + descent)
  let lineStep = ceil(lineHeight * 1.6)  // folga entre linhas para o Vision não juntá-las
  let margin = ceil(fontSize)
  let widths = lines.map { CGFloat(CTLineGetTypographicBounds($0, nil, nil, nil)) }
  let width = Int(ceil((widths.max() ?? 0) + 2 * margin))
  let height = Int(ceil(2 * margin + CGFloat(lines.count - 1) * lineStep + lineHeight))

  guard let space = CGColorSpace(name: CGColorSpace.sRGB),
    let context = CGContext(
      data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0, space: space,
      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
  else {
    throw ToolError("não consegui criar o contexto de desenho \(width)x\(height)")
  }
  context.setFillColor(CGColor(gray: 1, alpha: 1))
  context.fill(CGRect(x: 0, y: 0, width: width, height: height))

  var rendered: [RenderedLine] = []
  for (index, line) in lines.enumerated() {
    let top = margin + CGFloat(index) * lineStep  // origem no canto superior esquerdo
    context.textPosition = CGPoint(x: margin, y: CGFloat(height) - top - ascent)  // linha de base, origem embaixo
    CTLineDraw(line, context)
    rendered.append(RenderedLine(text: texts[index], frame: Frame(CGRect(x: margin, y: top, width: widths[index], height: lineHeight))))
  }

  guard let image = context.makeImage() else { throw ToolError("não consegui gerar a imagem") }
  let url = URL(fileURLWithPath: path)
  guard let destination = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil) else {
    throw ToolError("não consegui criar o PNG em \(path)")
  }
  CGImageDestinationAddImage(destination, image, nil)
  guard CGImageDestinationFinalize(destination) else { throw ToolError("não consegui gravar o PNG em \(path)") }
  return RenderOutput(path: path, width: width, height: height, lines: rendered)
}

// MARK: argumentos

/// Caminho absoluto sem resolver links (`/private/var/…` continua igual), para o JSON devolver o
/// mesmo caminho que recebeu.
func absolute(_ path: String) -> String {
  path.hasPrefix("/") ? path : URL(fileURLWithPath: path).path
}

func run(_ arguments: [String]) async throws {
  var words = false
  var renderTextValue: String?
  var out: String?
  var fontSize: CGFloat = 64
  var paths: [String] = []
  var index = 0
  func value(after flag: String) throws -> String {
    index += 1
    guard index < arguments.count else { throw ToolError("\(flag) pede um valor", usage: true) }
    return arguments[index]
  }
  while index < arguments.count {
    let argument = arguments[index]
    switch argument {
    case "--words": words = true
    case "--render-text": renderTextValue = try value(after: argument)
    case "--out": out = try value(after: argument)
    case "--font-size":
      let raw = try value(after: argument)
      guard let size = Double(raw), size.isFinite, size > 0, size <= maxFontSize else {
        throw ToolError("--font-size inválido: \(raw) (finito, > 0 e ≤ \(Int(maxFontSize)) px)", usage: true)
      }
      fontSize = CGFloat(size)
    case "--":
      paths.append(contentsOf: arguments[(index + 1)...])
      index = arguments.count
      continue
    default:
      if argument.hasPrefix("--") { throw ToolError("opção desconhecida: \(argument)", usage: true) }
      paths.append(argument)
    }
    index += 1
  }

  if let text = renderTextValue {
    guard let out, paths.isEmpty, !words else {
      throw ToolError("--render-text pede --out e não aceita imagens nem --words", usage: true)
    }
    guard !text.isEmpty else { throw ToolError("--render-text pede um texto não vazio", usage: true) }
    try printJSON(try renderText(text, to: absolute(out), fontSize: fontSize))
    return
  }
  guard out == nil else { throw ToolError("--out só vale com --render-text", usage: true) }
  guard !paths.isEmpty else { throw ToolError("nenhuma imagem", usage: true) }
  var images: [ImageResult] = []
  for path in paths {
    images.append(try await recognize(absolute(path), words: words))
  }
  try printJSON(OcrOutput(images: images))
}

do {
  try await run(Array(CommandLine.arguments.dropFirst()))
} catch let error as ToolError {
  FileHandle.standardError.write(Data("ocr.swift: \(error.description)\n".utf8))
  if error.usage {
    FileHandle.standardError.write(Data("\(usageText)\n".utf8))
    exit(2)
  }
  exit(1)
} catch {
  FileHandle.standardError.write(Data("ocr.swift: \(error)\n".utf8))
  exit(1)
}
