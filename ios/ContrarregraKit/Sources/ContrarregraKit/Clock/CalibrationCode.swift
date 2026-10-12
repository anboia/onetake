import Foundation

// S0.10 Código do relógio de calibração: o valor de D em milissegundos (`floor(rawNs / 1e6) mod 2^40`)
// num código de blocos de 5 linhas × 8 colunas (bit mais significativo em cima à esquerda, ordem por
// linhas, branco = 1, preto = 0) e uma 6.ª linha com a paridade par de cada coluna.

/// As 6 × 8 células do código (5 linhas de dados + 1 de paridade), por linhas.
public struct CalibrationGrid: Sendable, Equatable, CustomStringConvertible {
    public static let columns = 8
    public static let dataRows = 5
    public static let rows = dataRows + 1

    /// `true` = branco (1), `false` = preto (0); índice `row * columns + column`.
    public var cells: [Bool]

    public init(cells: [Bool]) {
        precondition(cells.count == Self.rows * Self.columns, "o código tem \(Self.rows * Self.columns) células")
        self.cells = cells
    }

    public subscript(row: Int, column: Int) -> Bool {
        get { cells[row * Self.columns + column] }
        set { cells[row * Self.columns + column] = newValue }
    }

    /// Uma linha por fila, `#` = branco, `.` = preto (para mensagens de teste).
    public var description: String {
        (0..<Self.rows).map { row in
            String((0..<Self.columns).map { self[row, $0] ? "#" : "." })
        }.joined(separator: "\n")
    }
}

/// Falha de paridade: as colunas cuja soma (5 bits + paridade) não é par.
public struct CalibrationParityError: Error, Sendable, Equatable {
    public let columns: [Int]
}

public enum CalibrationCode {
    /// Bits de dados (5 × 8).
    public static let bitCount = CalibrationGrid.dataRows * CalibrationGrid.columns
    /// O valor é tomado módulo 2^40 ms (≈ 34,8 anos de D).
    public static let modulus: UInt64 = 1 << 40

    /// `floor(rawNs / 1e6) mod 2^40`.
    public static func milliseconds(rawNs: UInt64) -> UInt64 {
        (rawNs / 1_000_000) % modulus
    }

    /// Código de `milliseconds` (que tem de ser < 2^40).
    public static func encode(milliseconds value: UInt64) -> CalibrationGrid {
        precondition(value < modulus, "o valor do código é módulo 2^40")
        var cells = [Bool](repeating: false, count: CalibrationGrid.rows * CalibrationGrid.columns)
        for bit in 0..<bitCount {
            // célula 0 (em cima à esquerda) = bit mais significativo
            cells[bit] = (value >> UInt64(bitCount - 1 - bit)) & 1 == 1
        }
        for column in 0..<CalibrationGrid.columns {
            var parity = false
            for row in 0..<CalibrationGrid.dataRows where cells[row * CalibrationGrid.columns + column] {
                parity.toggle()
            }
            cells[CalibrationGrid.dataRows * CalibrationGrid.columns + column] = parity
        }
        return CalibrationGrid(cells: cells)
    }

    /// Valor do código; lança `CalibrationParityError` se alguma coluna falhar na paridade par.
    public static func decode(_ grid: CalibrationGrid) throws(CalibrationParityError) -> UInt64 {
        var failing: [Int] = []
        for column in 0..<CalibrationGrid.columns {
            var ones = 0
            for row in 0..<CalibrationGrid.rows where grid[row, column] { ones += 1 }
            if ones % 2 != 0 { failing.append(column) }
        }
        guard failing.isEmpty else { throw CalibrationParityError(columns: failing) }
        var value: UInt64 = 0
        for bit in 0..<bitCount {
            value = value << 1 | (grid.cells[bit] ? 1 : 0)
        }
        return value
    }
}
