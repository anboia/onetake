import ContrarregraKit
import QuartzCore
import UIKit

/// A tela do relógio de calibração (S0.10): a cada quadro (`CADisplayLink`, 60 Hz) desenha D em
/// milissegundos em dígitos grandes e no código de blocos do Kit, sobre fundo cinza médio. A geometria
/// (células de 44 pt, grade centrada, dígitos acima) vem de `CalibrationLayout`, a mesma que o Mac amostra.
final class CalibrationClockViewController: UIViewController {
    private var cellLayers: [CALayer] = []
    private let digitsLabel = UILabel()
    private var displayLink: CADisplayLink?
    private let white = UIColor(white: CalibrationPalette.white, alpha: 1).cgColor
    private let black = UIColor(white: CalibrationPalette.black, alpha: 1).cgColor

    override var prefersStatusBarHidden: Bool { true }
    override var prefersHomeIndicatorAutoHidden: Bool { true }
    override var supportedInterfaceOrientations: UIInterfaceOrientationMask { .portrait }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(white: CalibrationPalette.background, alpha: 1)
        for _ in 0..<(CalibrationGrid.rows * CalibrationGrid.columns) {
            let layer = CALayer()
            layer.actions = ["backgroundColor": NSNull(), "position": NSNull(), "bounds": NSNull()]  // sem animação implícita
            layer.backgroundColor = black
            view.layer.addSublayer(layer)
            cellLayers.append(layer)
        }
        digitsLabel.font = .monospacedDigitSystemFont(ofSize: 72, weight: .bold)
        digitsLabel.textColor = .white
        digitsLabel.textAlignment = .center
        digitsLabel.adjustsFontSizeToFitWidth = true
        digitsLabel.minimumScaleFactor = 0.25
        view.addSubview(digitsLabel)
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        let layout = CalibrationLayout(screenPt: Size(w: view.bounds.width, h: view.bounds.height))
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        for row in 0..<CalibrationGrid.rows {
            for column in 0..<CalibrationGrid.columns {
                cellLayers[row * CalibrationGrid.columns + column].frame = CGRect(layout.cellRect(row: row, column: column))
            }
        }
        CATransaction.commit()
        digitsLabel.frame = CGRect(layout.digitsRect)
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        UIApplication.shared.isIdleTimerDisabled = true
        let link = CADisplayLink(target: self, selector: #selector(tick(_:)))
        link.preferredFrameRateRange = CAFrameRateRange(minimum: 60, maximum: 60, preferred: 60)
        link.add(to: .main, forMode: .common)
        displayLink = link
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        displayLink?.invalidate()
        displayLink = nil
        UIApplication.shared.isIdleTimerDisabled = false
    }

    /// Mostra D previsto para o instante em que este quadro aparece: D agora + (`targetTimestamp` − agora,
    /// os dois na base do `CACurrentMediaTime`); o intervalo é o mesmo nos dois relógios brutos.
    @objc private func tick(_ link: CADisplayLink) {
        let ahead = max(0, link.targetTimestamp - CACurrentMediaTime())
        let rawNs = DeviceClock.rawNs() &+ UInt64(ahead * 1e9)
        let milliseconds = CalibrationCode.milliseconds(rawNs: rawNs)
        let grid = CalibrationCode.encode(milliseconds: milliseconds)
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        for (index, layer) in cellLayers.enumerated() {
            layer.backgroundColor = grid.cells[index] ? white : black
        }
        CATransaction.commit()
        digitsLabel.text = String(milliseconds)
    }
}

private extension CGRect {
    init(_ rect: ContrarregraKit.Rect) {
        self.init(x: rect.x, y: rect.y, width: rect.w, height: rect.h)
    }
}
