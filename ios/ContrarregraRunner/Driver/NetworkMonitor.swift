import ContrarregraKit
import Foundation
import Network

/// `{network}` de S0.3 e o `network` de `device.state` (S1 item 4): há rota satisfeita por Wi-Fi ou celular — um
/// `NWPathMonitor` por tipo de interface exigido, o que já ignora cabo e loopback. A combinação é
/// `NetworkState.from(wifi:cellular:)` (Kit). Começa na subida do runner; até cada monitor dar a primeira notícia,
/// desconhecido. API pública, sem permissão nem rede própria.
final class NetworkMonitor: @unchecked Sendable {
    private let queue = DispatchQueue(label: "app.kifactory.contrarregra.runner.network", qos: .utility)
    private let wifi = NWPathMonitor(requiredInterfaceType: .wifi)
    private let cellular = NWPathMonitor(requiredInterfaceType: .cellular)
    private let lock = NSLock()
    private var wifiSatisfied: Bool?
    private var cellularSatisfied: Bool?

    init() {
        wifi.pathUpdateHandler = { [weak self] path in self?.update(wifi: path.status == .satisfied) }
        cellular.pathUpdateHandler = { [weak self] path in self?.update(cellular: path.status == .satisfied) }
        wifi.start(queue: queue)
        cellular.start(queue: queue)
    }

    deinit {
        wifi.cancel()
        cellular.cancel()
    }

    private func update(wifi satisfied: Bool) {
        lock.withLock { wifiSatisfied = satisfied }
    }

    private func update(cellular satisfied: Bool) {
        lock.withLock { cellularSatisfied = satisfied }
    }

    /// `nil` = ainda desconhecido.
    var state: NetworkState? {
        lock.withLock { NetworkState.from(wifi: wifiSatisfied, cellular: cellularSatisfied) }
    }
}
