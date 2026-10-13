import ContrarregraKit
import CoreGraphics
import Foundation
import XCTest

/// O caminho **público** de toque (S1 item 5, plano B; architecture.md A2 `Driver`): toda ação vai a uma coordenada
/// absoluta da tela, por um `XCUICoordinate` do SpringBoard (`press(forDuration:thenDragTo:withVelocity:
/// thenHoldForDuration:)` e companhia), e a digitação por `typeText` do app à frente. Sem símbolo privado: sem PX-3
/// não há `via` (`supportsVia = false` → `E_CAPABILITY_MISSING` no Kit) e o XCTest espera a ociosidade do app como
/// sempre (essa espera cai entre `tDevStartNs` e `tDispatchNs`, ou dentro do envio).
///
/// Nada aqui decide se pode: `ActionMethods` (Kit) já conferiu a lista permitida, as faixas de gesto e as recusas
/// de digitação, com a tela relida logo antes. Chamado só na fila do XCTest (a main thread do `testServe`).
final class XCUICoordinateToucher: Toucher {
    private let bridge: XCUIBridge

    init(bridge: XCUIBridge) {
        self.bridge = bridge
    }

    var path: ActionPath { .public }
    var supportsVia: Bool { false }

    func tap(_ point: AbsolutePoint) throws(RpcErrorObject) {
        MainActor.assumeIsolated { bridge.screenCoordinate(point).tap() }
    }

    func doubleTap(_ point: AbsolutePoint) throws(RpcErrorObject) {
        MainActor.assumeIsolated { bridge.screenCoordinate(point).doubleTap() }
    }

    func longPress(_ point: AbsolutePoint, seconds: Double) throws(RpcErrorObject) {
        MainActor.assumeIsolated { bridge.screenCoordinate(point).press(forDuration: seconds) }
    }

    /// Velocidade já em px/s (pt/s × escala, conferida no Kit); `nil` (arrasto sem distância) = a padrão do XCTest.
    /// Só linha reta: um `via` aqui nunca é descartado em silêncio.
    func drag(_ gesture: DragGesture) throws(RpcErrorObject) {
        guard gesture.via.isEmpty else {
            throw RpcErrorObject(.capabilityMissing, "E_CAPABILITY_MISSING: o caminho público não arrasta por via (PX-3)")
        }
        MainActor.assumeIsolated {
            let velocity = gesture.velocity.map { XCUIGestureVelocity(rawValue: CGFloat($0)) } ?? .default
            bridge.screenCoordinate(gesture.from).press(forDuration: gesture.pressSeconds,
                                                        thenDragTo: bridge.screenCoordinate(gesture.to),
                                                        withVelocity: velocity,
                                                        thenHoldForDuration: gesture.holdSeconds)
        }
    }

    /// Digita no foco do teclado do app à frente (público: `XCUIElement.typeText` no próprio app; o XCTest manda as
    /// teclas ao elemento com o foco). Nunca registra o texto.
    func typeText(_ text: String, app bundleId: String) throws(RpcErrorObject) {
        MainActor.assumeIsolated { bridge.application(bundleId).typeText(text) }
    }
}

extension XCUIBridge {
    /// O ponto absoluto da tela (em pontos) como `XCUICoordinate` do SpringBoard, cujo frame é a tela inteira:
    /// deslocamento normalizado (0, 0) a partir da origem, mais o ponto.
    func screenCoordinate(_ point: AbsolutePoint) -> XCUICoordinate {
        application(SystemApp.springboard)
            .coordinate(withNormalizedOffset: CGVector(dx: 0, dy: 0))
            .withOffset(CGVector(dx: point.x, dy: point.y))
    }
}
