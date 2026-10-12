import ContrarregraKit
import Foundation

/// A tabela de métodos do runner, montada num lugar só (módulo `Server`): os de base de S0.5 (T-0.5) e as
/// superfícies dos spikes — leitura e lista permitida (T-0.6); as ações (T-0.7) e aparelho/apps/espera (T-0.8)
/// entram aqui também.
enum RunnerMethods {
    /// O build do runner roda no simulador (só nele os apps pessoais entram na lista permitida; AC-3.7).
    static let isSimulator: Bool = {
        #if targetEnvironment(simulator)
        true
        #else
        false
        #endif
    }()

    /// Registra todos os métodos. Chamado pelo `testServe` com o runner ainda à frente, na main thread.
    @MainActor
    static func register(into router: inout RpcRouter, _ base: BaseMethods.Context, environment: RunnerEnvironment) {
        BaseMethods.register(into: &router, base)

        // S1 item 11: a lista permitida vem da sessão (CONTRARREGRA_EXPLORE, CONTRARREGRA_ALLOWED); o que a
        // configuração pediu e o runner recusa (Ajustes, Telefone, Mensagens, Mail, Wallet, lojas no aparelho
        // físico; SpringBoard e authkit como "app permitido") fica registrado e fora.
        let allowList = AllowList(environment: environment, isSimulator: isSimulator)
        for refusal in allowList.refused {
            RunnerLog.warn("lista permitida: \(refusal)")
        }
        RunnerLog.info("lista permitida: alvo=\(allowList.targetApp ?? "-") apps=[\(allowList.apps.joined(separator: ","))] "
                       + "links=[\(allowList.urlPrefixes.joined(separator: ","))] simulador=\(isSimulator)")
        let store = AllowListStore(allowList)

        let screenSize = base.device().screenPt
        let reader = XCUIDeviceReader(bridge: XCUIBridge(screenSize: screenSize),
                                      probeOrder: { store.current.foregroundProbeOrder })
        ReadMethods.register(into: &router, ReadMethods.Context(reader: reader, allowList: { store.current },
                                                                screenSize: screenSize, registry: TreeRegistry(),
                                                                state: base.state))
    }
}
