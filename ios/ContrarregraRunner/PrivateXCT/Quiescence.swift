#if SPIKE
import ContrarregraKit
import Foundation
import ObjectiveC
import XCTest

/// PX-2 (architecture.md A10; ✅ Q-5b): pular a espera de ociosidade que o XCTest faz antes e depois de cada evento
/// (S1 item 5; wda.md F17/F18). As duas formas de A10, medidas como variantes do SP-3 (T-0.18):
/// - **(b)** `-[XCUIApplication _performWithInteractionOptions:block:]` com SkipPre|SkipPostEventQuiescence (bits 0 e 1):
///   o XCTest põe as opções no processo do app, roda o bloco e as restaura (wda.md F18);
/// - **(c)** troca temporária da implementação de `-[XCUIApplicationProcess waitForQuiescenceIncludingAnimationsIdle:
///   isPreEvent:]`, o ponto único das esperas pré e pós de cada evento no Xcode 26.6 (wda.md F17), por uma que volta
///   na hora para os apps pedidos e chama a original para os demais (`skip`), ou que só cronometra a original
///   (`observe`); a original volta ao fim do bloco.
///
/// Só no build `Spike` (`#if SPIKE`): é código de medição; levar uma das formas ao caminho de produção é tarefa
/// própria, depois da decisão do SP-3. Só há instância com o PX-2 presente na sondagem **e** liberado em
/// `CONTRARREGRA_PRIVATE` (`make`, como o `PrivateLocker`); cada chamada procura o seletor de novo e confere os tipos
/// ObjC antes de chamar a implementação — sumiu ou mudou: `E_CAPABILITY_MISSING`, sem chamar nada (nunca um crash por
/// assinatura errada). A técnica de (c) é a do WebDriverAgent (wda.md F16), escrita aqui sem copiar código dele.
struct PrivateQuiescence: Sendable {
    /// O PX-2, só se presente e liberado.
    static func make(_ capabilities: RunnerCapabilities) -> PrivateQuiescence? {
        capabilities.usable.contains(.px2) ? PrivateQuiescence() : nil
    }

    private init() {}

    static let performSelector = NSSelectorFromString("_performWithInteractionOptions:block:")
    static let waitSelector = NSSelectorFromString("waitForQuiescenceIncludingAnimationsIdle:isPreEvent:")
    private static let bundleIDSelector = NSSelectorFromString("bundleID")
    /// `XCUIApplicationInteractionOptionSkipPreEventQuiescence | …SkipPostEventQuiescence` (wda.md F18).
    static let skipPreAndPost: UInt = 0b11

    // MARK: Sondagem (só leitura)

    /// `nil` se (b) pode rodar agora; senão o motivo.
    static func interactionOptionsUnavailable() -> String? {
        if case .failure(let error) = performMethod(objc_lookUpClass("XCUIApplication")) { return error.message }
        return nil
    }

    /// `nil` se (c) pode rodar agora; senão o motivo.
    static func quiescenceSwapUnavailable() -> String? {
        if case .failure(let error) = waitMethod() { return error.message }
        return nil
    }

    private static func performMethod(_ cls: AnyClass?) -> Result<Method, RpcErrorObject> {
        PrivateMethod.instance(cls, "XCUIApplication", performSelector, returns: .void, [.integer, .block], px: "PX-2")
    }

    private static func waitMethod() -> Result<Method, RpcErrorObject> {
        PrivateMethod.instance(objc_lookUpClass("XCUIApplicationProcess"), "XCUIApplicationProcess", waitSelector,
                               returns: .void, [.bool, .bool], px: "PX-2")
    }

    // MARK: (b) opções de interação

    /// O que aconteceu num bloco de (b).
    struct InteractionReport: Sendable {
        var options: UInt
        /// Os apps embrulhados, de fora para dentro.
        var apps: [String]
        /// O XCTest rodou o bloco na main thread, dentro da chamada.
        var blockRan: Bool
        /// O bloco foi chamado fora da main thread ou depois de a chamada voltar (e então não fez nada).
        var strayCalls: Int
    }

    /// Roda `body` dentro de `_performWithInteractionOptions:SkipPre|SkipPost block:` de cada app de `apps` (aninhados,
    /// o primeiro por fora). `body` só roda na main thread e só durante a chamada; se o XCTest não o rodar,
    /// `E_XCTEST` (o toque não aconteceu).
    @MainActor
    func perform(skippingQuiescenceOf apps: [(bundleId: String, app: XCUIApplication)],
                 _ body: @escaping @MainActor () -> Void) throws(RpcErrorObject) -> InteractionReport {
        guard let first = apps.first else {
            throw RpcErrorObject(.invalidParams, "PX-2 (b): nenhum app para embrulhar")
        }
        let method = try Self.performMethod(object_getClass(first.app)).get()
        typealias Perform = @convention(c) (AnyObject, Selector, UInt, @convention(block) () -> Void) -> Void
        let perform = unsafeBitCast(method_getImplementation(method), to: Perform.self)
        let selector = Self.performSelector
        let options = Self.skipPreAndPost
        let run = BlockRun()

        var block: @convention(block) () -> Void = {
            guard Thread.isMainThread, !run.expired else {
                run.stray()
                return
            }
            run.ran = true
            MainActor.assumeIsolated { body() }
        }
        for (_, app) in apps.reversed() {
            let inner = block
            block = {
                guard Thread.isMainThread, !run.expired else {
                    run.stray()
                    return
                }
                MainActor.assumeIsolated { perform(app, selector, options, inner) }
            }
        }
        block()
        run.expired = true
        guard run.ran else {
            throw RpcErrorObject(.xctest, "E_XCTEST: o XCTest não rodou o bloco de _performWithInteractionOptions:block: "
                                 + "(PX-2); nada foi tocado",
                                 data: ["strayCalls": .number(Double(run.strays))])
        }
        return InteractionReport(options: options, apps: apps.map(\.bundleId), blockRan: true, strayCalls: run.strays)
    }

    // MARK: (c) troca do método de espera

    enum SwapMode: String, Sendable {
        /// Volta na hora para os apps pedidos (e para processo sem bundle id legível); os demais esperam como sempre.
        case skip
        /// Não pula nada: chama a original para todos e cronometra (onde e quanto o XCTest espera).
        case observe
    }

    /// O que passou pela troca durante um bloco de (c).
    struct SwapReport: Sendable {
        var mode: SwapMode
        var skippedPre = 0
        var skippedPost = 0
        var waitedPre = 0
        var waitedPost = 0
        /// Tempo dentro da original (só das esperas que não foram puladas), em ns.
        var waitedPreNs: UInt64 = 0
        var waitedPostNs: UInt64 = 0
        /// Chamadas de processo sem bundle id legível.
        var unknownBundle = 0
        /// Bundle ids vistos, na ordem da primeira chamada.
        var bundles: [String] = []
    }

    /// Roda `body` com `waitForQuiescenceIncludingAnimationsIdle:isPreEvent:` trocado e restaura a original no fim.
    /// O bloco da troca fica vivo depois (não se chama `imp_removeBlock`: uma chamada em voo noutra thread ainda o
    /// usaria); são poucos bytes por toque, só no build `Spike`.
    @MainActor
    func withQuiescenceSwapped(_ mode: SwapMode, skipping bundleIds: Set<String>,
                               _ body: @MainActor () -> Void) throws(RpcErrorObject) -> SwapReport {
        let method = try Self.waitMethod().get()
        typealias Wait = @convention(c) (AnyObject, Selector, Bool, Bool) -> Void
        let original = method_getImplementation(method)
        let callOriginal = unsafeBitCast(original, to: Wait.self)
        let selector = Self.waitSelector
        let tally = SwapTally(mode)

        let replacement: @convention(block) (AnyObject, Bool, Bool) -> Void = { process, includingAnimations, isPreEvent in
            let bundle = Self.bundleID(of: process)
            let skip = mode == .skip && (bundle.map { bundleIds.contains($0) } ?? true)
            tally.saw(bundle)
            if skip {
                tally.skipped(isPreEvent)
                return
            }
            let started = DeviceClock.rawNs()
            callOriginal(process, selector, includingAnimations, isPreEvent)
            tally.waited(isPreEvent, DeviceClock.rawNs() &- started)
        }
        let previous = method_setImplementation(method, imp_implementationWithBlock(unsafeBitCast(replacement, to: AnyObject.self)))
        defer { method_setImplementation(method, previous) }
        body()
        return tally.report
    }

    /// `-[XCUIApplicationProcess bundleID]`, conferido antes de chamar; `nil` se não existir ou não for texto.
    private static func bundleID(of process: AnyObject) -> String? {
        guard case .success(let method) = PrivateMethod.instance(object_getClass(process), "XCUIApplicationProcess",
                                                                 bundleIDSelector, returns: .object, [], px: "PX-2")
        else { return nil }
        typealias Getter = @convention(c) (AnyObject, Selector) -> Unmanaged<AnyObject>?
        let getter = unsafeBitCast(method_getImplementation(method), to: Getter.self)
        return getter(process, bundleIDSelector)?.takeUnretainedValue() as? String
    }
}

/// Estado de um bloco entregue ao XCTest em (b): só a main thread mexe (o resto só conta chamadas perdidas).
private final class BlockRun: @unchecked Sendable {
    private let lock = NSLock()
    var ran = false
    var expired = false
    private var strayCount = 0

    func stray() { lock.withLock { strayCount += 1 } }
    var strays: Int { lock.withLock { strayCount } }
}

/// Contagem da troca de (c); a original pode, em tese, ser chamada fora da main thread.
private final class SwapTally: @unchecked Sendable {
    private let lock = NSLock()
    private var current: PrivateQuiescence.SwapReport

    init(_ mode: PrivateQuiescence.SwapMode) {
        current = PrivateQuiescence.SwapReport(mode: mode)
    }

    func saw(_ bundle: String?) {
        lock.withLock {
            if let bundle {
                if !current.bundles.contains(bundle) { current.bundles.append(bundle) }
            } else {
                current.unknownBundle += 1
            }
        }
    }

    func skipped(_ isPreEvent: Bool) {
        lock.withLock {
            if isPreEvent { current.skippedPre += 1 } else { current.skippedPost += 1 }
        }
    }

    func waited(_ isPreEvent: Bool, _ ns: UInt64) {
        lock.withLock {
            if isPreEvent {
                current.waitedPre += 1
                current.waitedPreNs &+= ns
            } else {
                current.waitedPost += 1
                current.waitedPostNs &+= ns
            }
        }
    }

    var report: PrivateQuiescence.SwapReport { lock.withLock { current } }
}

// MARK: Métodos privados conferidos (usado também por Synthesize.swift)

/// Tipos ObjC de um método, para conferir antes de chamar a implementação por um tipo C (A10: um seletor que mudou de
/// assinatura é recusado, nunca chamado).
struct ObjCSignature: CustomStringConvertible {
    enum Kind {
        case void, object, block, integer, bool, double, cgPoint

        func matches(_ type: String) -> Bool {
            switch self {
            case .void: type == "v"
            case .object: type.hasPrefix("@") && !type.hasPrefix("@?")
            case .block: type.hasPrefix("@?")
            case .integer: type.count == 1 && "cCsSiIlLqQB".contains(type)
            case .bool: type == "B" || type == "c"
            case .double: type == "d"
            case .cgPoint: type.hasPrefix("{CGPoint=dd}")
            }
        }
    }

    /// Tipo de retorno e dos argumentos depois de `self` e `_cmd`, sem qualificadores (`r n N o O R V`).
    let returnType: String
    let arguments: [String]

    init(_ method: Method) {
        returnType = Self.take(method_copyReturnType(method))
        let count = Int(method_getNumberOfArguments(method))
        arguments = count > 2 ? (2..<count).map { Self.take(method_copyArgumentType(method, UInt32($0))) } : []
    }

    func matches(returns: Kind, _ expected: [Kind]) -> Bool {
        returns.matches(returnType) && arguments.count == expected.count
            && zip(expected, arguments).allSatisfy { $0.matches($1) }
    }

    var description: String { "\(returnType)(\(arguments.joined(separator: ",")))" }

    private static func take(_ pointer: UnsafeMutablePointer<CChar>?) -> String {
        guard let pointer else { return "?" }
        defer { free(pointer) }
        return String(String(cString: pointer).drop { "rnNoORV".contains($0) })
    }
}

enum PrivateMethod {
    /// O método de instância `selector` de `cls` (ou superclasse), se existir com os tipos esperados; senão
    /// `E_CAPABILITY_MISSING` com o motivo. Procurado na hora do uso, como em `Lock.swift`.
    static func instance(_ cls: AnyClass?, _ className: String, _ selector: Selector, returns: ObjCSignature.Kind,
                         _ arguments: [ObjCSignature.Kind], px: String) -> Result<Method, RpcErrorObject> {
        let name = "-[\(className) \(NSStringFromSelector(selector))]"
        guard let cls else { return .failure(missing("a classe \(className) não existe neste XCTest", px)) }
        guard let method = class_getInstanceMethod(cls, selector) else {
            return .failure(missing("\(name) não existe neste XCTest", px))
        }
        return check(method, name, returns: returns, arguments, px: px)
    }

    /// O método de classe `selector` de `cls`, conferido como em `instance`.
    static func classMethod(_ cls: AnyClass?, _ className: String, _ selector: Selector, returns: ObjCSignature.Kind,
                            _ arguments: [ObjCSignature.Kind], px: String) -> Result<Method, RpcErrorObject> {
        let name = "+[\(className) \(NSStringFromSelector(selector))]"
        guard let cls else { return .failure(missing("a classe \(className) não existe neste XCTest", px)) }
        guard let method = class_getClassMethod(cls, selector) else {
            return .failure(missing("\(name) não existe neste XCTest", px))
        }
        return check(method, name, returns: returns, arguments, px: px)
    }

    private static func check(_ method: Method, _ name: String, returns: ObjCSignature.Kind, _ arguments: [ObjCSignature.Kind],
                              px: String) -> Result<Method, RpcErrorObject> {
        let signature = ObjCSignature(method)
        guard signature.matches(returns: returns, arguments) else {
            return .failure(missing("\(name) mudou de assinatura (tipos ObjC \(signature)); não é chamado", px))
        }
        return .success(method)
    }

    static func missing(_ why: String, _ px: String) -> RpcErrorObject {
        RpcErrorObject(.capabilityMissing, "E_CAPABILITY_MISSING: \(why) (\(px), A10)")
    }
}
#endif
