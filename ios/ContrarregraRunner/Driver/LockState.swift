import ContrarregraKit
import Foundation
import notify

/// Bloqueio da tela pela notificação `com.apple.springboard.lockstate` (S1 item 8; libnotify pública, nome da
/// notificação não documentado — o mesmo que o WebDriverAgent lê): estado ≠ 0 = travada.
///
/// Sem conseguir ler, devolve `.unknown`: a lista permitida trata como desconhecido e não lê, não age e não
/// captura nada (FAIL-CLOSED; as regras da tela travada só valem com o bloqueio provado).
final class LockStateReader {
    static let notificationName = "com.apple.springboard.lockstate"

    private let token: Int32
    private let registered: Bool

    init() {
        var token: Int32 = 0
        registered = notify_register_check(Self.notificationName, &token) == UInt32(NOTIFY_STATUS_OK)
        self.token = token
        if !registered {
            RunnerLog.warn("não consegui registrar \(Self.notificationName): bloqueio desconhecido, nada se lê nem captura")
        }
    }

    deinit {
        if registered { notify_cancel(token) }
    }

    var reading: LockReading {
        guard registered else { return .unknown }
        var state: UInt64 = 0
        guard notify_get_state(token, &state) == UInt32(NOTIFY_STATUS_OK) else { return .unknown }
        return state != 0 ? .locked : .unlocked
    }
}
