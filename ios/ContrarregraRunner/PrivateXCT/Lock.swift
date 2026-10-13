import ContrarregraKit
import Foundation
import ObjectiveC
import XCTest

/// PX-1 (architecture.md A10; ✅ Q-5a): travar a tela. Não há API pública (`XCUIDevice.Button` só tem home, volume,
/// action e camera; S1 item 8). **Único** arquivo com os seletores privados de travar (P-4, P-7).
///
/// Só entra no runner como o `Locker` de `DeviceMethods` quando a sondagem de subida achou o PX-1 (`present`) **e**
/// `CONTRARREGRA_PRIVATE` o libera (`allowed`) — `PrivateLocker.make`. Fora disso `device.lock` responde
/// `E_CAPABILITY_MISSING` no Kit, sem chegar aqui (AC-1.10, AC-1.16).
///
/// Os dois caminhos de A10, na ordem: `-[XCUIDevice pressLockButton]`; reserva, o evento HID do botão lateral
/// (`+[XCDeviceEvent deviceEventWithPage:0x0C usage:0x30 duration:0.5]` + `-[XCUIDevice performDeviceEvent:error:]`).
/// Os métodos são procurados de novo a cada chamada (só leitura da tabela de métodos) e chamados pela implementação
/// achada; se nenhum existir mais, `E_CAPABILITY_MISSING`. O SP-7 (T-0.25) mede os dois. Nenhum trecho do
/// WebDriverAgent foi copiado: os seletores são os de A10, conferidos por `nm` no Xcode 26.6.
final class PrivateLocker: Locker {
    /// O `Locker` do PX-1, só se presente e liberado.
    static func make(_ capabilities: RunnerCapabilities) -> PrivateLocker? {
        capabilities.usable.contains(.px1) ? PrivateLocker() : nil
    }

    private init() {}

    func lock() throws(RpcErrorObject) {
        try MainActor.assumeIsolated { Self.pressLock() }.get()
    }

    private static let pressLockButton = NSSelectorFromString("pressLockButton")
    private static let deviceEventWithPage = NSSelectorFromString("deviceEventWithPage:usage:duration:")
    private static let performDeviceEvent = NSSelectorFromString("performDeviceEvent:error:")

    /// Página HID de consumo (0x0C), uso "Power" (0x30), 0,5 s (A10).
    private static let hidPage: UInt32 = 0x0C
    private static let hidUsage: UInt32 = 0x30
    private static let pressSeconds = 0.5

    @MainActor
    private static func pressLock() -> Result<Void, RpcErrorObject> {
        let device: XCUIDevice = .shared
        let deviceClass: AnyClass? = object_getClass(device)

        if let method = class_getInstanceMethod(deviceClass, pressLockButton) {
            typealias Press = @convention(c) (AnyObject, Selector) -> Void
            let press = unsafeBitCast(method_getImplementation(method), to: Press.self)
            press(device, pressLockButton)
            return .success(())
        }

        guard let eventClass = objc_lookUpClass("XCDeviceEvent"),
              let make = class_getClassMethod(eventClass, deviceEventWithPage),
              let perform = class_getInstanceMethod(deviceClass, performDeviceEvent)
        else {
            return .failure(RpcErrorObject(.capabilityMissing, "E_CAPABILITY_MISSING: os símbolos do PX-1 sumiram depois da sondagem (A10)"))
        }
        typealias MakeEvent = @convention(c) (AnyClass, Selector, UInt32, UInt32, Double) -> Unmanaged<AnyObject>?
        typealias PerformEvent = @convention(c) (AnyObject, Selector, AnyObject, OpaquePointer?) -> ObjCBool
        let makeEvent = unsafeBitCast(method_getImplementation(make), to: MakeEvent.self)
        guard let event = makeEvent(eventClass, deviceEventWithPage, hidPage, hidUsage, pressSeconds)?.takeUnretainedValue() else {
            return .failure(RpcErrorObject(.xctest, "E_XCTEST: o evento do botão lateral (PX-1) não foi criado"))
        }
        let performEvent = unsafeBitCast(method_getImplementation(perform), to: PerformEvent.self)
        guard performEvent(device, performDeviceEvent, event, nil).boolValue else {
            return .failure(RpcErrorObject(.xctest, "E_XCTEST: o evento do botão lateral (PX-1) foi recusado pelo XCTest"))
        }
        return .success(())
    }
}
