import ContrarregraKit
import Foundation

/// A tabela de métodos do runner, montada num lugar só (módulo `Server`): os de base de S0.5 (T-0.5) e as
/// superfícies dos spikes — leitura e lista permitida (T-0.6), ações (T-0.7); aparelho/apps/espera (T-0.8)
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

        let device = base.device()
        let bridge = XCUIBridge(screenSize: device.screenPt)
        let reader = XCUIDeviceReader(bridge: bridge, probeOrder: { store.current.foregroundProbeOrder })
        let read = ReadMethods.Context(reader: reader, allowList: { store.current }, screenSize: device.screenPt,
                                       registry: TreeRegistry(), state: base.state)
        ReadMethods.register(into: &router, read)

        // S1 itens 4 e 5 (T-0.7): ações pelo caminho público (XCUICoordinate do SpringBoard). O `Toucher` privado
        // (PX-3, evento sintetizado; PX-2, sem espera de ociosidade) é do SP-3, em `PrivateXCT`, e entra aqui por
        // injeção quando a sondagem o achar e `CONTRARREGRA_PRIVATE` o liberar (`base.capabilities.usable`).
        ActionMethods.register(into: &router, ActionMethods.Context(read: read, toucher: XCUICoordinateToucher(bridge: bridge),
                                                                    scale: device.scale))
    }
}
