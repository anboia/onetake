import ContrarregraKit
import XCTest

/// O runner (S1 itens 1–2): um bundle de UI test com um único método de teste, `testServe`, que vira o
/// servidor de comandos e nunca retorna.
///
/// Nesta etapa (T-0.4) o bundle só existe para o build: assinatura no time fixo, bundle id
/// `app.kifactory.contrarregra.runner` (instalado como `….runner.xctrunner`) e um único `.xctestrun`.
/// O ciclo de vida — `press(.home)`, só então o servidor (S2) e o run loop até `runner.shutdown` — entra
/// na T-0.5.
final class RunnerTests: XCTestCase {
    @MainActor
    func testServe() throws {
        continueAfterFailure = true
        throw XCTSkip("o servidor do runner entra na T-0.5 (S1 item 2); protocolo \(jsonRpcVersion)")
    }
}
