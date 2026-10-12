import Foundation
import XCTest

@testable import ContrarregraKit

/// S0.10 e AC-0.8 (parte do Kit: codifica e desenha o código; o decodificador do Mac é da T-0.22).
final class CalibrationCodeTests: XCTestCase {
    /// iPhone 12: 390 × 844 pt, escala 3 → 1170 × 2532 px.
    let layout = CalibrationLayout(screenPt: Size(w: 390, h: 844))

    func testMillisecondsAreFloorOfRawNsOverOneMillionModulo2Pow40() {
        XCTAssertEqual(CalibrationCode.milliseconds(rawNs: 0), 0)
        XCTAssertEqual(CalibrationCode.milliseconds(rawNs: 1_999_999), 1)
        XCTAssertEqual(CalibrationCode.milliseconds(rawNs: 873_460_118_230_045), 873_460_118)
        let wrap = (UInt64(1) << 40) * 1_000_000
        XCTAssertEqual(CalibrationCode.milliseconds(rawNs: wrap + 5_000_000), 5)
        XCTAssertEqual(CalibrationCode.milliseconds(rawNs: UInt64.max), (UInt64.max / 1_000_000) % (1 << 40))
    }

    func testMostSignificantBitTopLeftRowMajorWhiteIsOneWithEvenColumnParity() throws {
        let top = CalibrationCode.encode(milliseconds: 1 << 39)
        XCTAssertTrue(top[0, 0])
        XCTAssertTrue(top[5, 0], "paridade da coluna 0")
        XCTAssertEqual(top.cells.filter { $0 }.count, 2, top.description)

        let last = CalibrationCode.encode(milliseconds: 1)
        XCTAssertTrue(last[4, 7])
        XCTAssertTrue(last[5, 7])
        XCTAssertEqual(last.cells.filter { $0 }.count, 2, last.description)

        let secondRow = CalibrationCode.encode(milliseconds: 1 << 31)  // bit 8 a partir do mais significativo
        XCTAssertTrue(secondRow[1, 0], secondRow.description)

        XCTAssertEqual(CalibrationCode.encode(milliseconds: 0).cells, [Bool](repeating: false, count: 48))

        let all = CalibrationCode.encode(milliseconds: (1 << 40) - 1)
        for column in 0..<8 {
            for row in 0..<5 { XCTAssertTrue(all[row, column]) }
            XCTAssertTrue(all[5, column], "5 uns na coluna → paridade 1")
        }
        XCTAssertEqual(try CalibrationCode.decode(all), (1 << 40) - 1)
    }

    func testLayoutHas44ptCellsCenteredWithTheDigitsAboveInsideTheScreen() {
        XCTAssertEqual(layout.gridRect, Rect(x: 19, y: 290, w: 352, h: 264))
        XCTAssertEqual(layout.cellRect(row: 0, column: 0), Rect(x: 19, y: 290, w: 44, h: 44))
        XCTAssertEqual(layout.cellRect(row: 5, column: 7), Rect(x: 327, y: 510, w: 44, h: 44))
        let digits = layout.digitsRect
        XCTAssertLessThan(digits.y + digits.h, layout.gridRect.y)
        XCTAssertGreaterThan(digits.y, 0)
        XCTAssertEqual(CalibrationPalette.byte(CalibrationPalette.background), 128)
    }

    func testAC08_aThousandRandomValuesComeBackFromAnImageRenderedAt1170x2532() throws {
        var rng = SplitMix64(seed: 0xAC08)
        for _ in 0..<1000 {
            let value = rng.next() % CalibrationCode.modulus
            let image = layout.render(CalibrationCode.encode(milliseconds: value), scale: 3)
            XCTAssertEqual(image.width, 1170)
            XCTAssertEqual(image.height, 2532)
            let sampled = layout.sample(image)
            XCTAssertEqual(try CalibrationCode.decode(sampled), value)
        }
    }

    func testAC08_parityDetectsOneFlippedBitInAnyCell() throws {
        var rng = SplitMix64(seed: 0x0B17)
        for trial in 0..<1000 {
            let value = rng.next() % CalibrationCode.modulus
            let grid = CalibrationCode.encode(milliseconds: value)
            let cell = trial < 48 ? trial : Int(rng.next() % 48)  // as 48 células uma vez, depois ao acaso
            let (row, column) = (cell / 8, cell % 8)
            var image = layout.render(grid, scale: 3)
            let rect = layout.cellRect(row: row, column: column)
            image.fill(x0: Int(rect.x * 3), y0: Int(rect.y * 3), x1: Int((rect.x + rect.w) * 3), y1: Int((rect.y + rect.h) * 3),
                       value: grid[row, column] ? 0 : 255)
            XCTAssertThrowsError(try CalibrationCode.decode(layout.sample(image))) { error in
                XCTAssertEqual(error as? CalibrationParityError, CalibrationParityError(columns: [column]))
            }
        }
    }

    func testRenderPaintsTheBackgroundGrayAndTheCellsPureBlackOrWhite() {
        let image = layout.render(CalibrationCode.encode(milliseconds: 1 << 39), scale: 3)
        XCTAssertEqual(image[0, 0], 128, "fundo cinza médio")
        XCTAssertEqual(image[19 * 3 + 66, 290 * 3 + 66], 255, "célula (0,0) branca")
        XCTAssertEqual(image[19 * 3 + 44 * 3 + 66, 290 * 3 + 66], 0, "célula (0,1) preta")
        XCTAssertEqual(image[19 * 3 - 1, 290 * 3], 128, "fora da grade")
    }

    func testDeviceClockRawIsMonotonicAndCountsAtLeastTheUptime() {
        let first = DeviceClock.rawNs()
        let uptime = DeviceClock.uptimeNs()
        let second = DeviceClock.rawNs()
        XCTAssertLessThanOrEqual(first, second)
        XCTAssertGreaterThan(first, 0)
        XCTAssertGreaterThanOrEqual(second + 1_000_000, uptime, "D conta o sono; o uptime não")
    }
}
