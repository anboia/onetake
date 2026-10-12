import ContrarregraKit
import Darwin
import UIKit
import XCTest

/// O runner (S1 itens 1–3): um bundle de UI test com um único método de teste, `testServe`, que vira o
/// servidor de comandos e só termina com `runner.shutdown` (ou se o servidor não puder escutar).
///
/// Ordem da subida (S1 item 2): lê o ambiente da sessão (`CONTRARREGRA_*`, S1 "API / Interface") → sonda as
/// APIs privadas só lendo símbolos (`PrivateXCT`, A10) → `press(.home)` para sair da frente → **só então** abre
/// o servidor WebSocket no loopback (S2) → gira o run loop principal, que serve a fila do XCTest.
///
/// Falhas do XCTest não derrubam o teste enquanto ele serve: `continueAfterFailure = true` e `record(_:)` só
/// registra. Durante a tomada nada aqui chama `launch()`, ativa o hospedeiro ou a si mesmo (P-4, S1 item 9).
final class RunnerTests: XCTestCase {
    /// Ligado enquanto o servidor está aberto: aí toda falha do XCTest só é registrada.
    private static let serving = Flag()

    override func record(_ issue: XCTIssue) {
        if Self.serving.isOn {
            RunnerLog.warn("falha do XCTest registrada e ignorada: \(issue.compactDescription)")
        } else {
            super.record(issue)
        }
    }

    @MainActor
    func testServe() throws {
        continueAfterFailure = true

        let environment: RunnerEnvironment
        do {
            environment = try RunnerEnvironment.read(ProcessInfo.processInfo.environment, allowBindOverride: Self.isSpikeBuild)
        } catch {
            RunnerLog.error("CONTRARREGRA_FATAL \(error.description)")
            throw error
        }
        RunnerLog.info("subindo runner \(Self.runnerVersion) (build \(Self.buildName)): \(environment)")
        if environment.bindIgnored {
            RunnerLog.warn("CONTRARREGRA_BIND ignorada: só vale no build Spike; escutando pela interface de loopback")
        }
        if !environment.unknownPrivate.isEmpty {
            RunnerLog.warn("CONTRARREGRA_PRIVATE com itens desconhecidos, ignorados: \(environment.unknownPrivate.joined(separator: ","))")
        }

        // A10: sondagem só de leitura; `allowed` vem de `runner.privateAllowed` → CONTRARREGRA_PRIVATE.
        let probe = PrivateXCTProbe.run()
        let capabilities = RunnerCapabilities(present: probe.present, allowed: environment.privateAllowed)
        for id in PrivateApiId.allCases {
            guard let capability = capabilities[id] else { continue }
            let missing = probe.missing[id].map { "; faltam \($0.joined(separator: ", "))" } ?? ""
            RunnerLog.info("\(id.rawValue): present=\(capability.present) allowed=\(capability.allowed)\(missing)")
        }

        // Lido com o runner ainda à frente (a cena dele está conectada com certeza).
        let device = RunnerDevice.snapshot()
        RunnerLog.info("aparelho: \(device.model) iOS \(device.os) \(Int(device.screenPt.w))x\(Int(device.screenPt.h))pt @\(device.scale)x "
                       + "\(device.language) \(device.textSize) \(device.appearance.rawValue)")

        // S1 item 2: sair da frente e só então abrir o servidor.
        XCUIDevice.shared.press(.home)

        let loop = MainLoop()
        let lane = XCTestLane(queue: .main)  // fila do XCTest = main thread, servida pelo `loop`
        let context = BaseMethods.Context(
            runnerVersion: Self.runnerVersion, capabilities: capabilities, device: { device }, state: RunnerState(),
            lane: lane,
            shutdown: {
                RunnerLog.info("runner.shutdown pedido pelo controlador")
                loop.stop()
            })
        var router = RpcRouter()
        BaseMethods.register(into: &router, context)
        let core = RunnerServerCore(token: environment.token, router: router, lane: lane,
                                    hello: { BaseMethods.helloResult(context) },
                                    log: { level, message in RunnerLog.write(RunnerLog.Level(rawValue: level) ?? .info, message) })
        RunnerLog.forward { level, message in
            core.notifyController(RpcNotification(method: "log", params: ["level": .string(level.rawValue), "msg": .string(message)]))
        }
        let server = try WebSocketServer(port: environment.port, bind: environment.bind, core: core) { reason in
            loop.stop(failure: reason)
        }

        Self.serving.set(true)
        server.start()
        loop.run()
        server.stop()
        RunnerLog.forward(to: nil)
        Self.serving.set(false)

        if let failure = loop.failure {
            RunnerLog.error("CONTRARREGRA_FATAL \(failure)")
            XCTFail("o servidor do runner parou: \(failure)")
        }
        RunnerLog.info("runner encerrado")
    }

    #if SPIKE
    /// Build da configuração `Spike`: só nele `CONTRARREGRA_BIND` vale e existem os métodos `spike.*`.
    static let isSpikeBuild = true
    static let buildName = "Spike"
    #else
    static let isSpikeBuild = false
    static let buildName = "Debug/Release"
    #endif

    static var runnerVersion: String {
        Bundle(for: RunnerTests.self).object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0.0.0"
    }
}

/// O run loop principal girando até `stop` (o padrão do WebDriverAgent): a main thread fica livre para a fila
/// do XCTest (`DispatchQueue.main`), que o run loop serve entre uma volta e outra.
private final class MainLoop: @unchecked Sendable {
    private let lock = NSLock()
    private var stopped = false
    private var reason: String?

    func stop(failure: String? = nil) {
        lock.withLock {
            stopped = true
            if reason == nil { reason = failure }
        }
        DispatchQueue.main.async {}  // acorda o run loop
    }

    var isStopped: Bool { lock.withLock { stopped } }
    var failure: String? { lock.withLock { reason } }

    @MainActor
    func run() {
        while !isStopped {
            if !RunLoop.main.run(mode: .default, before: Date(timeIntervalSinceNow: 0.25)) {
                Thread.sleep(forTimeInterval: 0.05)  // sem fontes no modo: não girar em vazio
            }
        }
    }
}

private final class Flag: @unchecked Sendable {
    private let lock = NSLock()
    private var value = false

    func set(_ newValue: Bool) { lock.withLock { value = newValue } }
    var isOn: Bool { lock.withLock { value } }
}

/// O aparelho visto pelo processo do runner (S0.5 `device`; S1 item 10): modelo, iOS, tela em pontos,
/// escala, idioma, tamanho de texto e aparência. Lido na subida, na main thread.
private enum RunnerDevice {
    @MainActor
    static func snapshot() -> DeviceInfo {
        let scene = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
            ?? UIApplication.shared.openSessions.compactMap { $0.scene as? UIWindowScene }.first
        let screen = scene?.screen ?? fallbackScreen()
        let traits = scene?.traitCollection ?? screen.traitCollection
        let size = screen.bounds.size
        return DeviceInfo(
            model: machine() ?? UIDevice.current.model,
            os: DeviceTraits.osDescription(version: UIDevice.current.systemVersion, build: sysctlString("kern.osversion")),
            screenPt: Size(w: Double(min(size.width, size.height)), h: Double(max(size.width, size.height))),
            scale: Double(screen.scale),
            language: DeviceTraits.languageCode(preferred: Locale.preferredLanguages.first),
            textSize: DeviceTraits.textSize(contentSizeCategory: UIApplication.shared.preferredContentSizeCategory.rawValue),
            appearance: traits.userInterfaceStyle == .dark ? .dark : .light)
    }

    /// Só se o processo do runner não tiver cena (o XCTRunner declara uma; não deve acontecer): a tela principal,
    /// API marcada como obsoleta no iOS 26 e ainda funcional — o único aviso de compilação do alvo.
    @MainActor
    private static func fallbackScreen() -> UIScreen {
        UIScreen.main
    }

    /// `iPhone13,2` (o identificador do modelo).
    private static func machine() -> String? {
        var info = utsname()
        guard uname(&info) == 0 else { return nil }
        let text = withUnsafeBytes(of: &info.machine) { raw in
            String(decoding: raw.prefix { $0 != 0 }, as: UTF8.self)
        }
        return text.isEmpty ? nil : text
    }

    private static func sysctlString(_ name: String) -> String? {
        var size = 0
        guard sysctlbyname(name, nil, &size, nil, 0) == 0, size > 1 else { return nil }
        var buffer = [UInt8](repeating: 0, count: size)
        guard sysctlbyname(name, &buffer, &size, nil, 0) == 0 else { return nil }
        return String(decoding: buffer.prefix { $0 != 0 }, as: UTF8.self)
    }
}
