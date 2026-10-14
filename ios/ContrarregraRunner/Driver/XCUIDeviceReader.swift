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
    /// - tela de início limpa: com o SpringBoard no centro e nenhuma camada, o ícone inteiro na tela mais acima e
    ///   mais à esquerda (frame do snapshot; só ícones de app, sem widgets), achado na consulta `springboard.icons`
    ///   pelo identificador com o frame conferido (`HomeScreenProbe`; no máximo 5 buscas), é `isHittable` (com a
    ///   Central, a Central de Notificações, o alternador ou o Spotlight por cima, não é; sem correspondência única,
    ///   não provado = camada).
    func screen(probeOrder: [String]) -> ScreenState {
        let started = DispatchTime.now().uptimeNanoseconds
        let lock = lockState.reading
        if lock == .unknown {
            return ScreenState(lock: .unknown, foregroundApp: nil, foregroundHittable: false, springBoardHittable: false,
                               homeScreenVisible: false, homeScreenHittable: false, overlays: [])
        }
        let springboard = application(SystemApp.springboard)
        let survey = surveySpringBoard(springboard)
        if lock == .locked {
            let state = ScreenState(lock: .locked, foregroundApp: nil, foregroundHittable: false, springBoardHittable: false,
                                    homeScreenVisible: false, homeScreenHittable: false, overlays: survey.overlays)
            logScreen(state, survey: survey, probe: nil, startedNs: started)
            return state
        }
        let foreground = probeOrder.first { application($0).state == .runningForeground }
        let foregroundHittable = foreground.map { hasWindowHittableAtCenter(application($0)) } ?? false
        // O centro é de um processo só: provado no app, o SpringBoard não precisa ser testado.
        let springBoardHittable = foregroundHittable ? false : hasWindowHittableAtCenter(springboard)
        var homeScreenHittable = false
        var probe: HomeProbeReading?
        if springBoardHittable, survey.overlays.isEmpty {
            let reading = probeHomeScreen(springboard, icons: survey.icons)
            homeScreenHittable = reading.hittable
            probe = reading
        }
        let state = ScreenState(lock: .unlocked, foregroundApp: foreground, foregroundHittable: foregroundHittable,
                                springBoardHittable: springBoardHittable, homeScreenVisible: !survey.icons.isEmpty,
                                homeScreenHittable: homeScreenHittable, overlays: survey.overlays)
        logScreen(state, survey: survey, probe: probe, startedNs: started)
        return state
    }

    /// O ícone de app que prova a tela de início limpa, achado na consulta só por geometria (`HomeScreenProbe`): o
    /// predicado `frame == …` ou a posição em largura, com o frame conferido; sem isso, `hittable = false` (não provado
    /// → camada).
    private struct HomeProbeReading {
        var outcome: HomeScreenProbe.Outcome
        /// Quantos elementos `frame == …` achou (`nil` = não chegou a consultar).
        var frameCount: Int?
        var queryFrame: Rect?
        var hittable = false
        /// Buscas feitas na consulta nesta leitura (teto: `HomeScreenProbe.maxQueryLookups`).
        var lookups = 0
    }

    /// A consulta de um frame (só geometria na descrição que o XCTest registra).
    private static func frameQuery(_ query: XCUIElementQuery, _ frame: Rect) -> XCUIElementQuery {
        query.matching(NSPredicate(format: "frame == %@", NSValue(cgRect: CGRect(x: frame.x, y: frame.y, width: frame.w, height: frame.h))))
    }

    private func probeHomeScreen(_ springboard: XCUIApplication, icons: [HomeScreenProbe.Icon]) -> HomeProbeReading {
        // Falhas do XCTest aqui dentro saem do registro só como um código genérico (`SensitiveQueryScope`).
        SensitiveQueryScope.run {
            let all = springboard.icons
            var byFrame: XCUIElementQuery?
            var frameCount: Int?
            var queryFrame: Rect?
            var lookups = 0
            let outcome = HomeScreenProbe.probe(icons, screen: screenSize, countWithFrame: { frame in
                let query = Self.frameQuery(all, frame)
                byFrame = query
                let count = query.count
                lookups += 1
                frameCount = count
                return count
            }, frameOfFrameMatch: {
                guard let query = byFrame else { return nil }
                let frame = Self.rect(query.element(boundBy: 0).frame)
                lookups += 1
                queryFrame = frame
                return frame
            }, frameAtBreadthIndex: { index in
                let frame = Self.rect(all.element(boundBy: index).frame)
                lookups += 1
                queryFrame = frame
                return frame
            })
            guard case .resolved(let icon, let via) = outcome else {
                return HomeProbeReading(outcome: outcome, frameCount: frameCount, queryFrame: queryFrame, lookups: lookups)
            }
            let element = via == .framePredicate ? Self.frameQuery(all, icon.frame).element(boundBy: 0)
                : all.element(boundBy: icon.breadthIndex)
            let hittable = element.isHittable
            lookups += 1
            return HomeProbeReading(outcome: outcome, frameCount: frameCount, queryFrame: queryFrame, hittable: hittable,
                                    lookups: lookups)
        }
    }

    // MARK: Diagnóstico da leitura da tela (T-0.11)

    /// Liga a linha `diagnóstico SpringBoard: …` a cada leitura da tela (e a de cada marcador de camada visto). Para
    /// ligar: `true` aqui e `runner build` (a linha só tem booleanos, contagens, índices, tipos, frames e tempos — nunca
    /// rótulo, valor nem identificador de ícone; custa < 0,5 ms por leitura). Desligada depois da T-0.11.
    static let screenDiagnostics = false

    private static func describe(_ r: Rect) -> String {
        "(\(Int(r.x)),\(Int(r.y)) \(Int(r.w))x\(Int(r.h)))"
    }

    private func logScreen(_ state: ScreenState, survey: SpringBoardSurvey, probe: HomeProbeReading?, startedNs: UInt64) {
        guard Self.screenDiagnostics else { return }
        let readMs = Double(DispatchTime.now().uptimeNanoseconds - startedNs) / 1_000_000
        let first = survey.icons.prefix(3).map { "#\($0.index) \($0.type.rawValue) \(Self.describe($0.frame))" }
        var line = "diagnóstico SpringBoard: estado lock=\(state.lock) appÀFrente=\(state.foregroundApp != nil) "
            + "appTocável=\(state.foregroundHittable) springboardTocável=\(state.springBoardHittable) "
            + "inícioVisível=\(state.homeScreenVisible) inícioTocável=\(state.homeScreenHittable) "
            + "camadas=[\(state.overlays.map(\.rawValue).sorted().joined(separator: ","))] "
            + "ícones=\(survey.icons.count) primeiros=[\(first.joined(separator: "; "))]"
        if let probe {
            switch probe.outcome {
            case .resolved(let icon, let via):
                line += " sondado=#\(icon.index)/largura#\(icon.breadthIndex) \(Self.describe(icon.frame)) via=\(via.rawValue) "
                    + "frameConsulta=\(probe.queryFrame.map(Self.describe) ?? "-") isHittable=\(probe.hittable)"
            case .notProven(let why):
                line += " sondado=não-provado(\(why.rawValue)) frameConsulta=\(probe.queryFrame.map(Self.describe) ?? "-")"
            }
            line += " consultaPorFrame=\(probe.frameCount.map(String.init) ?? "-") buscas=\(probe.lookups)"
        } else {
            line += " sondado=-"
        }
        // a leitura da tela (sem esta linha) e o custo de montar a linha
        let formattedMs = Double(DispatchTime.now().uptimeNanoseconds - startedNs) / 1_000_000 - readMs
        line += String(format: " leituraMs=%.0f linhaMs=%.2f", readMs, formattedMs)
        RunnerLog.info(line)
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

    /// O que um snapshot do SpringBoard mostra: camadas com marcador visível e os ícones da tela de início que estão
    /// na tela (posição entre os ícones na pré-ordem e em largura, tipo e frame; `HomeScreenProbe`) — nada de
    /// identificador, rótulo ou valor de ícone.
    private struct SpringBoardSurvey {
        var overlays: Set<SpringBoardLayer> = []
        var icons: [HomeScreenProbe.Icon] = []
    }

    private func surveySpringBoard(_ springboard: XCUIApplication) -> SpringBoardSurvey {
        guard let snapshot = try? springboard.snapshot() else {
            // Diagnóstico da T-0.11: só o fato de a leitura ter falhado, nada do SpringBoard.
            if Self.screenDiagnostics { RunnerLog.info("diagnóstico SpringBoard: snapshot falhou → camada unidentified") }
            return SpringBoardSurvey(overlays: [.unidentified])
        }
        let screen = CGRect(x: 0, y: 0, width: screenSize.w, height: screenSize.h)
        var survey = SpringBoardSurvey()
        var iconIndex = 0
        func visible(_ frame: CGRect) -> Bool {
            let shown = frame.intersection(screen)
            return !shown.isNull && !shown.isEmpty
        }
        var visibleNodes: [(node: ObjectIdentifier, icon: HomeScreenProbe.Icon)] = []
        func walk(_ node: any XCUIElementSnapshot) {
            if let layer = SpringBoardLayer.marked(by: node.identifier), visible(node.frame) {
                survey.overlays.insert(layer)
                // Diagnóstico da T-0.11: SÓ o identificador do marcador, o tipo e o frame — nunca rótulo nem valor
                // (nada do conteúdo de notificações ou widgets).
                if Self.screenDiagnostics {
                    RunnerLog.info("diagnóstico SpringBoard: marcador id=\(node.identifier) "
                                   + "tipo=\(ElementType(xcuiRawValue: node.elementType.rawValue).rawValue) "
                                   + "frame=\(Self.describe(Self.rect(node.frame))) camada=\(layer.rawValue)")
                }
            }
            if node.elementType == .icon {
                if visible(node.frame) {
                    let icon = HomeScreenProbe.Icon(index: iconIndex, breadthIndex: -1, type: .icon, frame: Self.rect(node.frame))
                    visibleNodes.append((ObjectIdentifier(node as AnyObject), icon))
                }
                iconIndex += 1
            }
            for child in node.children { walk(child) }
        }
        walk(snapshot)
        // A posição de cada ícone em largura (a ordem que a consulta `descendants(matching: .icon)` pode seguir).
        var breadth: [ObjectIdentifier: Int] = [:]
        var queue: [any XCUIElementSnapshot] = [snapshot]
        var head = 0
        var breadthIndex = 0
        while head < queue.count {
            let node = queue[head]
            head += 1
            if node.elementType == .icon {
                breadth[ObjectIdentifier(node as AnyObject)] = breadthIndex
                breadthIndex += 1
            }
            queue.append(contentsOf: node.children)
        }
        survey.icons = visibleNodes.map { entry in
            var icon = entry.icon
            icon.breadthIndex = breadth[entry.node] ?? -1
            return icon
        }
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
                focused: snapshot.hasFocus, children: snapshot.children.map(raw))
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

/// Enquanto a sondagem da tela de início consulta o SpringBoard, uma falha do XCTest sai do registro do runner (e do
/// controlador) só como um código genérico — nunca com a descrição da consulta (S1 item 11, P-3; T-0.11).
enum SensitiveQueryScope {
    private static let lock = NSLock()
    nonisolated(unsafe) private static var depth = 0

    static var isActive: Bool { lock.withLock { depth > 0 } }

    static func run<T>(_ body: () -> T) -> T {
        lock.withLock { depth += 1 }
        defer { lock.withLock { depth -= 1 } }
        return body()
    }
}
