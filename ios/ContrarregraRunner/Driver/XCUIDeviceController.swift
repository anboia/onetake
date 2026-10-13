import ContrarregraKit
import Foundation
import UIKit
import XCTest

/// Botões, apps e links pelo XCUIAutomation **público** (módulo `Driver`, architecture.md A2; S1 itens 4, 7 e 8):
/// `XCUIDevice.shared.press`, `XCUIApplication.activate/terminate/state` e `XCUIDevice.shared.system.open`. Nunca chama
/// `launch()` (P-4). Nada aqui decide se pode: `DeviceMethods` (Kit) já conferiu a lista permitida, a seção `scenes`
/// e o bloqueio. Chamado só na fila do XCTest (a main thread do `testServe`).
final class XCUIDeviceController: DeviceController {
    private let bridge: XCUIBridge

    init(bridge: XCUIBridge) {
        self.bridge = bridge
    }

    func press(_ button: DeviceButton) throws(RpcErrorObject) {
        try MainActor.assumeIsolated { bridge.press(button) }.get()
    }

    func appState(_ bundleId: String) -> AppRunState? {
        MainActor.assumeIsolated { bridge.appState(bundleId) }
    }

    func activate(_ bundleId: String) throws(RpcErrorObject) {
        try MainActor.assumeIsolated { bridge.activate(bundleId) }.get()
    }

    func terminate(_ bundleId: String) throws(RpcErrorObject) {
        try MainActor.assumeIsolated { bridge.terminate(bundleId) }.get()
    }

    func openURL(_ url: URL) throws(RpcErrorObject) {
        MainActor.assumeIsolated { XCUIDevice.shared.system.open(url) }
    }

    /// Idioma, tamanho de texto e aparência lidos **agora**, a cada `device.state` (S1 item 10; revisão da T-0.8,
    /// achado 4), só por API pública, na fila do XCTest (main thread):
    /// - idioma: `Locale.preferredLanguages.first` (as preferências do aparelho);
    /// - tamanho de texto: `UIApplication.shared.preferredContentSizeCategory` do processo do runner (a preferência do
    ///   usuário; o UIKit a atualiza quando ela muda);
    /// - aparência: `XCUIDevice.shared.appearance` (o estilo do aparelho visto pelo XCUIAutomation, não o da cena do
    ///   runner, que o sistema pode alternar em segundo plano para tirar instantâneos).
    /// O que não se lê (aparência não especificada, categoria não especificada, sem idioma) fica `nil`: vale a leitura da
    /// subida, e o registro diz qual. O spike confere no aparelho que os três mudam sem `runner up`.
    func liveTraits() -> LiveTraits {
        MainActor.assumeIsolated {
            let live = LiveTraits(
                language: DeviceTraits.liveLanguage(preferred: Locale.preferredLanguages.first),
                textSize: DeviceTraits.liveTextSize(contentSizeCategory: UIApplication.shared.preferredContentSizeCategory.rawValue),
                appearance: DeviceTraits.appearance(xcuiRawValue: XCUIDevice.shared.appearance.rawValue))
            let stale = [live.language == nil ? "language" : nil, live.textSize == nil ? "textSize" : nil,
                         live.appearance == nil ? "appearance" : nil].compactMap { $0 }
            if !stale.isEmpty {
                RunnerLog.warn("device.state: \(stale.joined(separator: ", ")) sem leitura agora; vale a leitura da subida")
            }
            return live
        }
    }

    /// A espera entre sondagens de `wait.for`, na fila do XCTest: gira o run loop da main thread (as fontes dele, como
    /// as do próprio XCTest, seguem sendo servidas) sem soltar a fila — os blocos da fila principal não rodam aninhados,
    /// então nenhum outro comando do XCTest entra no meio da espera.
    static func pause(_ ns: UInt64) {
        let until = Date(timeIntervalSinceNow: Double(ns) / 1e9)
        while Date() < until {
            if !RunLoop.current.run(mode: .default, before: until) {
                Thread.sleep(forTimeInterval: max(0, min(0.01, until.timeIntervalSinceNow)))
            }
        }
    }
}

extension XCUIBridge {
    /// `home` sempre; volume só no aparelho (o simulador não tem os botões: `E_CAPABILITY_MISSING`).
    func press(_ button: DeviceButton) -> Result<Void, RpcErrorObject> {
        switch button {
        case .home:
            XCUIDevice.shared.press(.home)
        case .volumeUp, .volumeDown:
            #if targetEnvironment(simulator)
            return .failure(RpcErrorObject(.capabilityMissing, "E_CAPABILITY_MISSING: o simulador não tem botões de volume"))
            #else
            XCUIDevice.shared.press(button == .volumeUp ? .volumeUp : .volumeDown)
            #endif
        }
        return .success(())
    }

    /// `XCUIApplication.state` nos estados de S0.3; `unknown` → `nil`.
    func appState(_ bundleId: String) -> AppRunState? {
        switch application(bundleId).state {
        case .runningForeground: .foreground
        case .runningBackground, .runningBackgroundSuspended: .background
        case .notRunning: .notRunning
        case .unknown: nil
        @unknown default: nil
        }
    }

    /// `activate()` (sem `launch()`): se o app não fica em primeiro plano (não instalado, não responde), `E_APP_STATE`
    /// — a falha do XCTest já foi só registrada (`record(_:)`).
    func activate(_ bundleId: String) -> Result<Void, RpcErrorObject> {
        let app = application(bundleId)
        app.activate()
        guard app.state == .runningForeground else {
            return .failure(RpcErrorObject(.appState, "E_APP_STATE: \(bundleId) não ficou em primeiro plano (não instalado ou não responde)"))
        }
        return .success(())
    }

    func terminate(_ bundleId: String) -> Result<Void, RpcErrorObject> {
        let app = application(bundleId)
        app.terminate()
        guard app.state == .notRunning else {
            return .failure(RpcErrorObject(.appState, "E_APP_STATE: \(bundleId) não terminou"))
        }
        return .success(())
    }
}
