import ContrarregraKit
import Foundation
import ImageIO
import UIKit
import XCTest

/// Ponte entre a leitura do Kit (`DeviceReader`) e o XCUIAutomation **público** (módulo `Driver`,
/// architecture.md A2; S1 itens 4, 6 e 11): os fatos da tela (`ScreenState`), snapshot da árvore, captura crua,
/// codificação e OCR. Nenhuma decisão de lista permitida aqui — o Kit classifica a tela (FAIL-CLOSED), confere
/// antes e depois de cada captura crua e recorta o que a leitura alcança no SpringBoard e na folha `authkit`.
///
/// Chamado só na fila do XCTest (a main thread do `testServe`): cada método entra no `MainActor` com
/// `assumeIsolated`.
final class XCUIDeviceReader: DeviceReader {
    private let bridge: XCUIBridge
    /// A ordem em que se pergunta quem está à frente (`AllowList.foregroundProbeOrder`, da lista corrente).
    private let probeOrder: @Sendable () -> [String]

    init(bridge: XCUIBridge, probeOrder: @escaping @Sendable () -> [String]) {
        self.bridge = bridge
        self.probeOrder = probeOrder
    }

    func screen() -> ScreenState {
        let order = probeOrder()
        return MainActor.assumeIsolated { bridge.screen(probeOrder: order) }
    }

    func snapshot(of bundleId: String) throws(RpcErrorObject) -> RawNode {
        try MainActor.assumeIsolated { bridge.snapshot(bundleId) }.get()
    }

    func captureScreen() throws(RpcErrorObject) -> ScreenFrame {
        MainActor.assumeIsolated { ScreenFrame(bridge.captureScreen()) }
    }

    func encode(_ frame: ScreenFrame, _ request: CaptureRequest) throws(RpcErrorObject) -> CapturedImage {
        try MainActor.assumeIsolated { bridge.encode(frame, request) }.get()
    }

    func recognizeText(in frame: ScreenFrame, region: Rect) throws(RpcErrorObject) -> [OcrLine] {
        try MainActor.assumeIsolated { bridge.recognizeText(in: frame, region: region) }.get()
    }
}

/// O lado `MainActor` da ponte: guarda um `XCUIApplication` por bundle id (criado uma vez; `state` é
/// monitorado pelo XCTest) e o leitor do bloqueio.
@MainActor
final class XCUIBridge {
    private var applications: [String: XCUIApplication] = [:]
    private let lockState = LockStateReader()
    private let recognizer = VisionTextRecognizer()
    /// A tela em pontos (`device.screenPt`).
    let screenSize: Size

    init(screenSize: Size) {
        self.screenSize = screenSize
    }

    func application(_ bundleId: String) -> XCUIApplication {
        if let known = applications[bundleId] { return known }
        let app = XCUIApplication(bundleIdentifier: bundleId)
        applications[bundleId] = app
        return app
    }

    /// Os fatos da tela, só por consultas públicas; nunca chama `launch()` nem `activate()` (S0.2, P-4). Quem
    /// classifica (FAIL-CLOSED) é `AllowList.front`:
    /// - bloqueio pela `com.apple.springboard.lockstate` (não lido: nada mais se consulta);
    /// - um snapshot do SpringBoard: marcadores visíveis de camada (`SpringBoardLayer`; snapshot ilegível =
    ///   camada não identificada) e os ícones da tela de início que estão na tela;
    /// - o primeiro app da ordem em `.runningForeground` — um app fora da ordem nunca aparece;
    /// - teste de toque no centro da tela: alguma janela do app que cobre o centro é `isHittable`; se não for o
    ///   app, o mesmo no SpringBoard;
    /// - tela de início limpa: com o SpringBoard no centro e nenhuma camada, um ícone visível dela é
    ///   `isHittable` (com a Central, a Central de Notificações, o alternador ou o Spotlight por cima, não é).
    func screen(probeOrder: [String]) -> ScreenState {
        let lock = lockState.reading
        if lock == .unknown {
            return ScreenState(lock: .unknown, foregroundApp: nil, foregroundHittable: false, springBoardHittable: false,
                               homeScreenVisible: false, homeScreenHittable: false, overlays: [])
        }
        let springboard = application(SystemApp.springboard)
        let survey = surveySpringBoard(springboard)
        if lock == .locked {
            return ScreenState(lock: .locked, foregroundApp: nil, foregroundHittable: false, springBoardHittable: false,
                               homeScreenVisible: false, homeScreenHittable: false, overlays: survey.overlays)
        }
        let foreground = probeOrder.first { application($0).state == .runningForeground }
        let foregroundHittable = foreground.map { hasWindowHittableAtCenter(application($0)) } ?? false
        // O centro é de um processo só: provado no app, o SpringBoard não precisa ser testado.
        let springBoardHittable = foregroundHittable ? false : hasWindowHittableAtCenter(springboard)
        var homeScreenHittable = false
        if springBoardHittable, survey.overlays.isEmpty, let icon = survey.visibleIconIndices.first {
            let element = springboard.icons.element(boundBy: icon)
            homeScreenHittable = element.exists && element.isHittable
        }
        return ScreenState(lock: .unlocked, foregroundApp: foreground, foregroundHittable: foregroundHittable,
                           springBoardHittable: springBoardHittable, homeScreenVisible: !survey.visibleIconIndices.isEmpty,
                           homeScreenHittable: homeScreenHittable, overlays: survey.overlays)
    }

    /// Janelas olhadas por app no teste do centro (as primeiras, na ordem do XCTest).
    static let maxWindowsProbed = 12

    /// Alguma janela do app que cobre o centro da tela é `isHittable` (o XCTest faz o teste de toque de
    /// acessibilidade no ponto de toque dela, o centro, e só diz que sim se o elemento atingido é ela ou um
    /// descendente).
    private func hasWindowHittableAtCenter(_ app: XCUIApplication) -> Bool {
        let center = CGPoint(x: screenSize.w / 2, y: screenSize.h / 2)
        for window in app.windows.allElementsBoundByIndex.prefix(Self.maxWindowsProbed) {
            guard window.exists, window.frame.contains(center) else { continue }
            if window.isHittable { return true }
        }
        return false
    }

    /// O que um snapshot do SpringBoard mostra: camadas com marcador visível e a posição (na ordem da consulta
    /// `icons`, pré-ordem) dos ícones da tela de início que estão na tela.
    private struct SpringBoardSurvey {
        var overlays: Set<SpringBoardLayer> = []
        var visibleIconIndices: [Int] = []
    }

    private func surveySpringBoard(_ springboard: XCUIApplication) -> SpringBoardSurvey {
        guard let snapshot = try? springboard.snapshot() else {
            return SpringBoardSurvey(overlays: [.unidentified])
        }
        let screen = CGRect(x: 0, y: 0, width: screenSize.w, height: screenSize.h)
        var survey = SpringBoardSurvey()
        var iconIndex = 0
        func visible(_ frame: CGRect) -> Bool {
            let shown = frame.intersection(screen)
            return !shown.isNull && !shown.isEmpty
        }
        func walk(_ node: any XCUIElementSnapshot) {
            if let layer = SpringBoardLayer.marked(by: node.identifier), visible(node.frame) {
                survey.overlays.insert(layer)
            }
            if node.elementType == .icon {
                if visible(node.frame) { survey.visibleIconIndices.append(iconIndex) }
                iconIndex += 1
            }
            for child in node.children { walk(child) }
        }
        walk(snapshot)
        return survey
    }

    // MARK: Árvore

    /// Snapshot público (`XCUIElement.snapshot()`), convertido para o Kit. App parado → `E_APP_STATE`; falha
    /// do XCTest → `E_XCTEST` (o teste não para: `record(_:)` só registra).
    func snapshot(_ bundleId: String) -> Result<RawNode, RpcErrorObject> {
        let app = application(bundleId)
        switch app.state {
        case .notRunning, .unknown:
            return .failure(RpcErrorObject(.appState, "E_APP_STATE: \(bundleId) não está rodando"))
        default:
            break
        }
        do {
            return .success(Self.raw(try app.snapshot()))
        } catch {
            return .failure(RpcErrorObject(.xctest, "E_XCTEST: snapshot de \(bundleId) falhou: \(error.localizedDescription)"))
        }
    }

    static func raw(_ snapshot: any XCUIElementSnapshot) -> RawNode {
        RawNode(type: ElementType(xcuiRawValue: snapshot.elementType.rawValue),
                label: nonEmpty(snapshot.label), identifier: nonEmpty(snapshot.identifier), value: text(snapshot.value),
                frame: rect(snapshot.frame), enabled: snapshot.isEnabled, selected: snapshot.isSelected,
                children: snapshot.children.map(raw))
    }

    static func nonEmpty(_ text: String) -> String? { text.isEmpty ? nil : text }

    /// `value` do snapshot (`Any?`): texto, número (interruptor = "0"/"1") ou a descrição.
    static func text(_ value: Any?) -> String? {
        switch value {
        case nil: return nil
        case let string as String: return string.isEmpty ? nil : string
        case let number as NSNumber: return number.stringValue
        case let other?: return String(describing: other)
        }
    }

    /// Frame em pontos; um frame não finito (elemento sem posição) vira vazio na origem.
    static func rect(_ frame: CGRect) -> Rect {
        let r = frame.standardized
        guard r.origin.x.isFinite, r.origin.y.isFinite, r.width.isFinite, r.height.isFinite else {
            return Rect(x: 0, y: 0, w: 0, h: 0)
        }
        return Rect(x: Double(r.origin.x), y: Double(r.origin.y), w: Double(r.width), h: Double(r.height))
    }

    // MARK: Captura

    /// `XCUIScreen.main.screenshot()` (público; a tela inteira), cru — nada se processa antes de a lista
    /// permitida conferir a tela depois da captura.
    func captureScreen() -> XCUIScreenshot {
        XCUIScreen.main.screenshot()
    }

    /// Recodifica uma captura conferida: em `points`, redesenhada no tamanho da tela em pontos (390×844 no
    /// iPhone 12); em `native`, nos pixels da captura.
    func encode(_ frame: ScreenFrame, _ request: CaptureRequest) -> Result<CapturedImage, RpcErrorObject> {
        guard let shot = frame.content as? XCUIScreenshot, let image = Self.cgImage(shot) else {
            return .failure(RpcErrorObject(.xctest, "E_XCTEST: a captura da tela veio sem imagem"))
        }
        let pxPerPoint = Double(image.width) / screenSize.w
        switch request.scale {
        case .native:
            let data = request.format == .png
                ? shot.pngRepresentation
                : UIImage(cgImage: image).jpegData(compressionQuality: request.quality)
            guard let data else { return .failure(RpcErrorObject(.xctest, "E_XCTEST: não consegui codificar a captura")) }
            return .success(CapturedImage(data: data, widthPx: image.width, heightPx: image.height, scale: pxPerPoint))
        case .points:
            let size = CGSize(width: screenSize.w, height: screenSize.h)
            let format = UIGraphicsImageRendererFormat()
            format.scale = 1
            format.opaque = true
            let renderer = UIGraphicsImageRenderer(size: size, format: format)
            let source = UIImage(cgImage: image)
            let draw: (UIGraphicsImageRendererContext) -> Void = { _ in
                source.draw(in: CGRect(origin: .zero, size: size))
            }
            let data = request.format == .png
                ? renderer.pngData(actions: draw)
                : renderer.jpegData(withCompressionQuality: request.quality, actions: draw)
            return .success(CapturedImage(data: data, widthPx: Int(size.width.rounded()), heightPx: Int(size.height.rounded()),
                                          scale: 1))
        }
    }

    /// OCR da região (pontos da tela) numa captura conferida.
    func recognizeText(in frame: ScreenFrame, region: Rect) -> Result<[OcrLine], RpcErrorObject> {
        guard let shot = frame.content as? XCUIScreenshot, let image = Self.cgImage(shot) else {
            return .failure(RpcErrorObject(.xctest, "E_XCTEST: a captura da tela veio sem imagem"))
        }
        do {
            return .success(try recognizer.recognize(image, region: region, pxPerPoint: Double(image.width) / screenSize.w))
        } catch {
            return .failure(RpcErrorObject(.xctest, "E_XCTEST: OCR falhou: \(error)"))
        }
    }

    static func cgImage(_ shot: XCUIScreenshot) -> CGImage? {
        if let image = shot.image.cgImage { return image }
        guard let source = CGImageSourceCreateWithData(shot.pngRepresentation as CFData, nil) else { return nil }
        return CGImageSourceCreateImageAtIndex(source, 0, nil)
    }
}
