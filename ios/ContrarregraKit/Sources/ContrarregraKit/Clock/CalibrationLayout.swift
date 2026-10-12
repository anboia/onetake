import Foundation

// Onde e como o código de S0.10 é desenhado. É a geometria que o hospedeiro usa na tela e que o
// decodificador do Mac (T-0.22) amostra: células de 44 × 44 pt, a grade de 8 × 6 células centrada na
// tela, os dígitos grandes logo acima dela, fundo cinza médio.

/// Tons do relógio de calibração (0 = preto, 1 = branco).
public enum CalibrationPalette {
    public static let white = 1.0
    public static let black = 0.0
    /// Fundo cinza médio.
    public static let background = 0.5

    /// O tom em 8 bits (`round(tom × 255)`).
    public static func byte(_ level: Double) -> UInt8 { UInt8((level * 255).rounded()) }
}

/// Geometria do relógio de calibração numa tela de `screenPt` pontos.
public struct CalibrationLayout: Sendable, Equatable {
    /// Lado de cada célula, em pontos (S0.10).
    public static let cellPt = 44.0
    /// Altura da faixa dos dígitos grandes, em pontos, e a folga entre ela e a grade.
    public static let digitsHeightPt = 88.0
    public static let digitsGapPt = 22.0

    public let screenPt: Size

    public init(screenPt: Size) {
        self.screenPt = screenPt
    }

    /// A grade inteira (8 × 6 células), centrada na tela.
    public var gridRect: Rect {
        let width = Double(CalibrationGrid.columns) * Self.cellPt
        let height = Double(CalibrationGrid.rows) * Self.cellPt
        return Rect(x: (screenPt.w - width) / 2, y: (screenPt.h - height) / 2, w: width, h: height)
    }

    /// A célula da linha `row` (0 = em cima; 5 = paridade) e coluna `column` (0 = à esquerda), em pontos.
    public func cellRect(row: Int, column: Int) -> Rect {
        let grid = gridRect
        return Rect(x: grid.x + Double(column) * Self.cellPt, y: grid.y + Double(row) * Self.cellPt,
                    w: Self.cellPt, h: Self.cellPt)
    }

    /// Faixa dos dígitos de D em milissegundos, acima da grade e da mesma largura.
    public var digitsRect: Rect {
        let grid = gridRect
        return Rect(x: grid.x, y: grid.y - Self.digitsGapPt - Self.digitsHeightPt, w: grid.w, h: Self.digitsHeightPt)
    }

    /// Desenha o fundo e o código numa imagem em tons de cinza com `scale` pixels por ponto (os dígitos
    /// ficam por conta do hospedeiro, que tem as fontes). Cada célula cobre os pixels de
    /// `round(início × scale)` a `round(fim × scale)`.
    public func render(_ grid: CalibrationGrid, scale: Double) -> GrayImage {
        var image = GrayImage(width: Int((screenPt.w * scale).rounded()), height: Int((screenPt.h * scale).rounded()),
                              fill: CalibrationPalette.byte(CalibrationPalette.background))
        let white = CalibrationPalette.byte(CalibrationPalette.white)
        let black = CalibrationPalette.byte(CalibrationPalette.black)
        for row in 0..<CalibrationGrid.rows {
            for column in 0..<CalibrationGrid.columns {
                let cell = cellRect(row: row, column: column)
                image.fill(
                    x0: Int((cell.x * scale).rounded()), y0: Int((cell.y * scale).rounded()),
                    x1: Int(((cell.x + cell.w) * scale).rounded()), y1: Int(((cell.y + cell.h) * scale).rounded()),
                    value: grid[row, column] ? white : black
                )
            }
        }
        return image
    }

    /// Lê o código de uma imagem da tela inteira amostrando o centro de cada célula (como o Mac decodifica,
    /// S0.10); a escala sai da largura da imagem. Claro (> meio-tom entre preto e branco) = 1.
    public func sample(_ image: GrayImage) -> CalibrationGrid {
        let scale = Double(image.width) / screenPt.w
        let threshold = (Int(CalibrationPalette.byte(CalibrationPalette.white)) + Int(CalibrationPalette.byte(CalibrationPalette.black))) / 2
        var cells: [Bool] = []
        cells.reserveCapacity(CalibrationGrid.rows * CalibrationGrid.columns)
        for row in 0..<CalibrationGrid.rows {
            for column in 0..<CalibrationGrid.columns {
                let cell = cellRect(row: row, column: column)
                let x = Int(((cell.x + cell.w / 2) * scale).rounded(.down))
                let y = Int(((cell.y + cell.h / 2) * scale).rounded(.down))
                cells.append(Int(image[x, y]) > threshold)
            }
        }
        return CalibrationGrid(cells: cells)
    }
}

/// Imagem em tons de cinza de 8 bits, por linhas (0 = preto, 255 = branco).
public struct GrayImage: Sendable, Equatable {
    public let width: Int
    public let height: Int
    public private(set) var pixels: [UInt8]

    public init(width: Int, height: Int, fill: UInt8) {
        self.width = width
        self.height = height
        // `memset` direto: o laço genérico do `Array(repeating:)` fica lento sem otimização (testes em debug).
        pixels = [UInt8](unsafeUninitializedCapacity: width * height) { buffer, count in
            if let base = buffer.baseAddress { memset(base, Int32(fill), width * height) }
            count = width * height
        }
    }

    public subscript(x: Int, y: Int) -> UInt8 {
        get { pixels[y * width + x] }
        set { pixels[y * width + x] = newValue }
    }

    /// Pinta o retângulo `[x0, x1) × [y0, y1)`, cortado nas bordas da imagem.
    public mutating func fill(x0: Int, y0: Int, x1: Int, y1: Int, value: UInt8) {
        let left = max(0, x0), right = min(width, x1), top = max(0, y0), bottom = min(height, y1)
        guard left < right, top < bottom else { return }
        let width = self.width
        pixels.withUnsafeMutableBufferPointer { buffer in
            guard let start = buffer.baseAddress else { return }
            for y in top..<bottom { memset(start + y * width + left, Int32(value), right - left) }
        }
    }
}
