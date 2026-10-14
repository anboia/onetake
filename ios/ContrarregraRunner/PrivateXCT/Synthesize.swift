#if SPIKE
import ContrarregraKit
import CoreGraphics
import Darwin
import Foundation
import ObjectiveC
import XCTest

/// PX-3 (architecture.md A10; ✅ Q-5c): toque por evento sintetizado num único registro — um `XCSynthesizedEventRecord`
/// com um `XCPointerEventPath` (toca no ponto, solta depois de `pressSeconds`), entregue ao testmanagerd por
/// `-[XCUIDevice eventSynthesizer]` `synthesizeEvent:completion:`, caminho que não passa pela espera de ociosidade do
/// XCTest (wda.md F20; S1 item 5, caminho principal). Variante (d) do SP-3 (T-0.18).
///
/// Só no build `Spike` (`#if SPIKE`); levar ao `Toucher` de produção é tarefa própria, depois da decisão do SP-3. Só há
/// instância com o PX-3 presente na sondagem **e** liberado em `CONTRARREGRA_PRIVATE` (`make`). A cada toque, cada
/// seletor é procurado de novo e os tipos ObjC são conferidos antes de chamar (A10: cabeçalhos mudaram no Xcode 26,
/// WDA #1202); a assinatura do bloco de conclusão, `void (^)(BOOL, NSError *)` como o WebDriverAgent usa, é conferida
/// na assinatura estendida dos protocolos que declaram `synthesizeEvent:completion:` quando o runtime a dá — diferente:
/// `E_CAPABILITY_MISSING`, nada é chamado. Nenhum trecho do WebDriverAgent copiado (só os seletores de A10).
struct PrivateSynthesizer: Sendable {
    /// O PX-3, só se presente e liberado.
    static func make(_ capabilities: RunnerCapabilities) -> PrivateSynthesizer? {
        capabilities.usable.contains(.px3) ? PrivateSynthesizer() : nil
    }

    private init() {}

    private static let alloc = NSSelectorFromString("alloc")
    private static let recordInitWithDisplay = NSSelectorFromString("initWithName:displayID:interfaceOrientation:")
    private static let recordInit = NSSelectorFromString("initWithName:interfaceOrientation:")
    private static let addPointerEventPath = NSSelectorFromString("addPointerEventPath:")
    private static let pathInit = NSSelectorFromString("initForTouchAtPoint:offset:")
    private static let liftUp = NSSelectorFromString("liftUpAtOffset:")
    private static let eventSynthesizer = NSSelectorFromString("eventSynthesizer")
    private static let synthesize = NSSelectorFromString("synthesizeEvent:completion:")
    /// `UIInterfaceOrientationPortrait`: o iPhone grava em retrato (S1 item 5 não gira a tela).
    private static let portrait = 1
    /// Nome do registro (aparece nos registros do XCTest).
    private static let recordName = "Contrarregra SP-3 tap"

    /// Tempos e procedência de um toque sintetizado (relógio D, `DeviceClock.rawNs`).
    struct Timing: Sendable {
        /// Qual `init` do registro existia (`initWithName:displayID:interfaceOrientation:` é o preferido, como no WDA).
        var recordInit: String
        /// Logo antes de `synthesizeEvent:completion:`.
        var submittedNs: UInt64
        /// A chamada voltou (o envio é assíncrono).
        var returnedNs: UInt64
        /// O bloco de conclusão rodou (o testmanagerd terminou de injetar o gesto).
        var completedNs: UInt64
        var completionOnMain: Bool
        var completionBlock: String
    }

    // MARK: Sondagem (só leitura; não chama nada privado)

    /// `nil` se (d) pode rodar agora; senão o motivo. O dono de `synthesizeEvent:completion:` só se confere de verdade
    /// no toque (é o objeto que `eventSynthesizer` devolve); aqui, a classe do aparelho (`XCTRunnerDaemonSession`).
    static func unavailableReason() -> String? {
        let recordClass: AnyClass? = objc_lookUpClass("XCSynthesizedEventRecord")
        let pathClass: AnyClass? = objc_lookUpClass("XCPointerEventPath")
        let checks: [Result<Method, RpcErrorObject>] = [
            recordInitMethod(recordClass).map(\.method),
            PrivateMethod.instance(recordClass, "XCSynthesizedEventRecord", addPointerEventPath, returns: .void, [.object], px: "PX-3"),
            PrivateMethod.instance(pathClass, "XCPointerEventPath", pathInit, returns: .object, [.cgPoint, .double], px: "PX-3"),
            PrivateMethod.instance(pathClass, "XCPointerEventPath", liftUp, returns: .void, [.double], px: "PX-3"),
            PrivateMethod.instance(objc_lookUpClass("XCUIDevice"), "XCUIDevice", eventSynthesizer, returns: .object, [], px: "PX-3"),
        ]
        for case .failure(let error) in checks { return error.message }
        if let session = objc_lookUpClass("XCTRunnerDaemonSession"),
           case .failure(let error) = PrivateMethod.instance(session, "XCTRunnerDaemonSession", synthesize, returns: .object,
                                                             [.object, .block], px: "PX-3") {
            return error.message
        }
        if case .refused(let why) = blockVerdict { return why }
        return nil
    }

    /// O que se sabe da assinatura do bloco de conclusão (para o `spike.tapProbe` e para cada toque).
    enum BlockCheck: Sendable {
        case verified(String)
        case unverified(String)
        case refused(String)

        var summary: String {
            switch self {
            case .verified(let text): "conferido: \(text)"
            case .unverified(let text): "não conferido: \(text)"
            case .refused(let text): "recusado: \(text)"
            }
        }
    }

    /// Lê a assinatura estendida de `synthesizeEvent:completion:` nos protocolos registrados que o declaram
    /// (`_protocol_getMethodTypeEncoding` do runtime ObjC, por `dlsym`; só leitura). Aceita o bloco `v@?B@"NSError"`
    /// (ou com `c` no lugar de `B`, ou o erro sem classe); sem como ler, segue "não conferido" (risco registrado em A10).
    static func completionBlockCheck() -> BlockCheck {
        guard let symbol = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "_protocol_getMethodTypeEncoding") else {
            return .unverified("o runtime não exporta _protocol_getMethodTypeEncoding")
        }
        typealias Encoding = @convention(c) (Protocol, Selector, Bool, Bool) -> UnsafePointer<CChar>?
        let encoding = unsafeBitCast(symbol, to: Encoding.self)
        var found: [String] = []
        var count: UInt32 = 0
        if let protocols = objc_copyProtocolList(&count) {
            for index in 0..<Int(count) {
                let proto = protocols[index]
                for required in [true, false] where protocol_getMethodDescription(proto, synthesize, required, true).name != nil {
                    if let text = encoding(proto, synthesize, required, true) {
                        found.append("\(NSStringFromProtocol(proto)): \(String(cString: text))")
                    }
                }
            }
            free(UnsafeMutableRawPointer(protocols))
        }
        guard !found.isEmpty else { return .unverified("nenhum protocolo registrado declara synthesizeEvent:completion:") }
        let accepted = ["@?<v@?B@\"NSError\">", "@?<v@?c@\"NSError\">", "@?<v@?B@>", "@?<v@?c@>"]
        let text = found.joined(separator: " | ")
        if found.contains(where: { line in accepted.contains { line.contains($0) } }) { return .verified(text) }
        return .refused("E_CAPABILITY_MISSING: o bloco de synthesizeEvent:completion: não é void (^)(BOOL, NSError *): "
                        + "\(text) (PX-3, A10)")
    }

    // MARK: Toque

    /// Veredito da assinatura do bloco, lido uma vez por processo (percorre todos os protocolos registrados).
    private static let blockVerdict = completionBlockCheck()

    /// O veredito em texto (as assinaturas achadas), para o `spike.tapProbe`.
    static var completionBlockSummary: String { blockVerdict.summary }

    /// Um toque montado e ainda não enviado: tudo o que custa (objetos, procura e conferência dos seletores) fica
    /// antes do `tDispatchNs`; `submit` só faz o envio e espera a conclusão.
    struct PreparedTap {
        /// `synthesizeEvent:completion:` devolve `id` (`@32@0:8@16@?24` em `XCTRunnerDaemonSession`, conferido com
        /// `otool -ov` no XCUIAutomation do Xcode 26.6); o retorno é ignorado: declarado `Void`, o Swift não faz
        /// retain/release dele (no arm64 o valor só fica em x0, sem dono — o método segue a convenção +0).
        typealias Submit = @convention(c) (AnyObject, Selector, AnyObject, @convention(block) (Bool, NSError?) -> Void) -> Void

        fileprivate let record: AnyObject
        fileprivate let synthesizer: AnyObject
        fileprivate let submit: Submit
        let recordInit: String
        let synthesizerClass: String
        let completionBlock: String
    }

    /// Monta o registro com um caminho (toca em `point`, pontos da tela em retrato, no instante 0 e solta em
    /// `pressSeconds`) e acha quem o entrega (`-[XCUIDevice eventSynthesizer]`; no aparelho, a sessão com o
    /// testmanagerd). Nada é enviado aqui.
    @MainActor
    func prepareTap(at point: CGPoint, pressSeconds: Double) throws(RpcErrorObject) -> PreparedTap {
        if case .refused(let why) = Self.blockVerdict {
            throw RpcErrorObject(.capabilityMissing, why)
        }
        let (record, recordInitName) = try Self.makeRecord()
        let path = try Self.makeTouchPath(at: point)
        let lift = try PrivateMethod.instance(object_getClass(path), "XCPointerEventPath", Self.liftUp, returns: .void, [.double],
                                              px: "PX-3").get()
        typealias Lift = @convention(c) (AnyObject, Selector, Double) -> Void
        unsafeBitCast(method_getImplementation(lift), to: Lift.self)(path, Self.liftUp, max(0, pressSeconds))
        let add = try PrivateMethod.instance(object_getClass(record), "XCSynthesizedEventRecord", Self.addPointerEventPath,
                                             returns: .void, [.object], px: "PX-3").get()
        typealias Add = @convention(c) (AnyObject, Selector, AnyObject) -> Void
        unsafeBitCast(method_getImplementation(add), to: Add.self)(record, Self.addPointerEventPath, path)

        let device: XCUIDevice = .shared
        let getter = try PrivateMethod.instance(object_getClass(device), "XCUIDevice", Self.eventSynthesizer, returns: .object, [],
                                                px: "PX-3").get()
        typealias Getter = @convention(c) (AnyObject, Selector) -> Unmanaged<AnyObject>?
        guard let synthesizer = unsafeBitCast(method_getImplementation(getter), to: Getter.self)(device, Self.eventSynthesizer)?
            .takeUnretainedValue()
        else {
            throw RpcErrorObject(.xctest, "E_XCTEST: -[XCUIDevice eventSynthesizer] devolveu nil (PX-3); nada foi tocado")
        }
        let synthesizerClass: AnyClass? = object_getClass(synthesizer)
        let className = synthesizerClass.map { String(cString: class_getName($0)) } ?? "?"
        let submit = try PrivateMethod.instance(synthesizerClass, className, Self.synthesize, returns: .object, [.object, .block],
                                                px: "PX-3").get()
        return PreparedTap(record: record, synthesizer: synthesizer,
                           submit: unsafeBitCast(method_getImplementation(submit), to: PreparedTap.Submit.self),
                           recordInit: recordInitName, synthesizerClass: className, completionBlock: Self.blockVerdict.summary)
    }

    /// Envia o toque montado e espera o bloco de conclusão girando o run loop da main thread (a resposta do
    /// testmanagerd chega por XPC) por até `timeoutSeconds`. Sem conclusão no prazo, ou conclusão com erro: `E_XCTEST`
    /// com os tempos em `data`.
    @MainActor
    func submit(_ prepared: PreparedTap, timeoutSeconds: Double) throws(RpcErrorObject) -> Timing {
        let completion = Completion()
        let block: @convention(block) (Bool, NSError?) -> Void = { ok, error in
            completion.finish(ok, error, onMain: Thread.isMainThread)
        }
        let submitted = DeviceClock.rawNs()
        prepared.submit(prepared.synthesizer, Self.synthesize, prepared.record, block)
        let returned = DeviceClock.rawNs()
        let deadline = returned &+ UInt64(max(0.1, timeoutSeconds) * 1_000_000_000)
        while completion.state == nil, DeviceClock.rawNs() < deadline {
            if !RunLoop.current.run(mode: .default, before: Date(timeIntervalSinceNow: 0.001)) { usleep(200) }
        }
        let times: JSONObject = ["submittedNs": .string(String(submitted)), "returnedNs": .string(String(returned)),
                                 "synthesizer": .string(prepared.synthesizerClass), "recordInit": .string(prepared.recordInit)]
        guard let done = completion.state else {
            throw RpcErrorObject(.xctest, "E_XCTEST: synthesizeEvent:completion: sem conclusão em \(timeoutSeconds) s (PX-3)",
                                 data: .object(times))
        }
        guard done.ok, done.error == nil else {
            var data = times
            data["completedNs"] = .string(String(done.atNs))
            if let error = done.error {
                data["error"] = ["domain": .string(error.domain), "code": .number(Double(error.code)),
                                 "description": .string(error.localizedDescription)]
            }
            throw RpcErrorObject(.xctest, "E_XCTEST: o testmanagerd recusou o evento sintetizado (PX-3): "
                                 + (done.error?.localizedDescription ?? "result = NO"), data: .object(data))
        }
        return Timing(recordInit: prepared.recordInit, submittedNs: submitted, returnedNs: returned, completedNs: done.atNs,
                      completionOnMain: done.onMain, completionBlock: prepared.completionBlock)
    }

    // MARK: Objetos privados

    private enum RecordInit {
        case withDisplay(Method)
        case plain(Method)

        var method: Method {
            switch self {
            case .withDisplay(let method), .plain(let method): method
            }
        }
    }

    private static func recordInitMethod(_ cls: AnyClass?) -> Result<RecordInit, RpcErrorObject> {
        if case .success(let method) = PrivateMethod.instance(cls, "XCSynthesizedEventRecord", recordInitWithDisplay,
                                                              returns: .object, [.object, .integer, .integer], px: "PX-3") {
            return .success(.withDisplay(method))
        }
        return PrivateMethod.instance(cls, "XCSynthesizedEventRecord", recordInit, returns: .object, [.object, .integer],
                                      px: "PX-3").map { .plain($0) }
    }

    /// `[[XCSynthesizedEventRecord alloc] initWithName:… (displayID: 0) interfaceOrientation: retrato]`.
    private static func makeRecord() throws(RpcErrorObject) -> (AnyObject, String) {
        let cls: AnyClass? = objc_lookUpClass("XCSynthesizedEventRecord")
        let initializer = try recordInitMethod(cls).get()
        let raw = try allocate(cls, "XCSynthesizedEventRecord")
        let name = recordName as NSString
        let made: UnsafeMutableRawPointer?
        let used: String
        switch initializer {
        case .withDisplay(let method):
            typealias Init = @convention(c) (UnsafeMutableRawPointer, Selector, AnyObject, Int, Int) -> UnsafeMutableRawPointer?
            made = unsafeBitCast(method_getImplementation(method), to: Init.self)(raw, recordInitWithDisplay, name, 0, portrait)
            used = "initWithName:displayID:interfaceOrientation:"
        case .plain(let method):
            typealias Init = @convention(c) (UnsafeMutableRawPointer, Selector, AnyObject, Int) -> UnsafeMutableRawPointer?
            made = unsafeBitCast(method_getImplementation(method), to: Init.self)(raw, recordInit, name, portrait)
            used = "initWithName:interfaceOrientation:"
        }
        guard let made else {
            throw RpcErrorObject(.xctest, "E_XCTEST: XCSynthesizedEventRecord \(used) devolveu nil (PX-3)")
        }
        return (Unmanaged<AnyObject>.fromOpaque(made).takeRetainedValue(), used)
    }

    /// `[[XCPointerEventPath alloc] initForTouchAtPoint:point offset:0]`.
    private static func makeTouchPath(at point: CGPoint) throws(RpcErrorObject) -> AnyObject {
        let cls: AnyClass? = objc_lookUpClass("XCPointerEventPath")
        let method = try PrivateMethod.instance(cls, "XCPointerEventPath", pathInit, returns: .object, [.cgPoint, .double],
                                                px: "PX-3").get()
        let raw = try allocate(cls, "XCPointerEventPath")
        typealias Init = @convention(c) (UnsafeMutableRawPointer, Selector, CGPoint, Double) -> UnsafeMutableRawPointer?
        guard let made = unsafeBitCast(method_getImplementation(method), to: Init.self)(raw, pathInit, point, 0) else {
            throw RpcErrorObject(.xctest, "E_XCTEST: XCPointerEventPath initForTouchAtPoint:offset: devolveu nil (PX-3)")
        }
        return Unmanaged<AnyObject>.fromOpaque(made).takeRetainedValue()
    }

    /// `+alloc` (objeto +1, ainda sem `init`; o `init` o consome e devolve +1).
    private static func allocate(_ cls: AnyClass?, _ name: String) throws(RpcErrorObject) -> UnsafeMutableRawPointer {
        let method = try PrivateMethod.classMethod(cls, name, alloc, returns: .object, [], px: "PX-3").get()
        typealias Alloc = @convention(c) (AnyClass, Selector) -> UnsafeMutableRawPointer?
        guard let cls, let raw = unsafeBitCast(method_getImplementation(method), to: Alloc.self)(cls, alloc) else {
            throw RpcErrorObject(.xctest, "E_XCTEST: +[\(name) alloc] devolveu nil (PX-3)")
        }
        return raw
    }
}

/// A conclusão de `synthesizeEvent:completion:`, que pode chegar em qualquer thread.
private final class Completion: @unchecked Sendable {
    struct State {
        var ok: Bool
        var error: NSError?
        var atNs: UInt64
        var onMain: Bool
    }

    private let lock = NSLock()
    private var value: State?

    func finish(_ ok: Bool, _ error: NSError?, onMain: Bool) {
        let at = DeviceClock.rawNs()
        lock.withLock {
            if value == nil { value = State(ok: ok, error: error, atNs: at, onMain: onMain) }
        }
    }

    var state: State? { lock.withLock { value } }
}
#endif
