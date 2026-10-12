import ContrarregraKit
import Darwin
import Foundation
import ObjectiveC

/// Sondagem das APIs privadas do XCTest (architecture.md A10, PX-1…PX-6), feita uma vez na subida do runner.
///
/// **Só lê símbolos**: procura classes (`objc_lookUpClass`), métodos nas listas de métodos das classes
/// (`class_copyMethodList`, subindo pelas superclasses — sem mandar mensagem, sem `+initialize`, sem
/// `resolveInstanceMethod:`) e métodos declarados em protocolos (`protocol_copyMethodDescriptionList`).
/// Nenhuma API privada é chamada aqui; o uso fica nos arquivos de cada capacidade deste módulo
/// (`PrivateXCT`, o único com seletores privados — P-4, P-7), e só quando `present` **e** `allowed`.
///
/// Os nomes vêm de A10 e foram conferidos por `nm` nos binários do Xcode 26.6 (17F113):
/// `XCUIAutomation`, `XCTestCore` e `XCTAutomationSupport`.
enum PrivateXCTProbe {
    /// Um símbolo procurado.
    enum Symbol: CustomStringConvertible {
        case cls(String)
        case instanceMethod(String, String)
        case classMethod(String, String)
        /// Seletor declarado por algum protocolo registrado no runtime (o proxy do testmanagerd é XPC).
        case protocolMethod(String)

        var description: String {
            switch self {
            case .cls(let name): name
            case .instanceMethod(let cls, let selector): "-[\(cls) \(selector)]"
            case .classMethod(let cls, let selector): "+[\(cls) \(selector)]"
            case .protocolMethod(let selector): "<protocolo> \(selector)"
            }
        }
    }

    /// Condição sobre símbolos.
    indirect enum Requirement {
        case symbol(Symbol)
        case all([Requirement])
        case any([Requirement])
    }

    struct Result {
        var present: Set<PrivateApiId>
        /// Símbolos não achados de cada PX-n ausente (para o registro).
        var missing: [PrivateApiId: [String]]
    }

    static func instance(_ cls: String, _ selectors: String...) -> Requirement {
        .all([.symbol(.cls(cls))] + selectors.map { .symbol(.instanceMethod(cls, $0)) })
    }

    /// A10, coluna "Símbolos".
    static let requirements: [PrivateApiId: Requirement] = [
        // Travar a tela.
        .px1: .any([
            instance("XCUIDevice", "pressLockButton"),
            .all([.symbol(.classMethod("XCDeviceEvent", "deviceEventWithPage:usage:duration:")),
                  instance("XCUIDevice", "performDeviceEvent:error:")]),
        ]),
        // Pular a espera de ociosidade.
        .px2: .any([
            instance("XCUIApplication", "_performWithInteractionOptions:block:"),
            instance("XCUIApplicationProcess", "waitForQuiescenceIncludingAnimationsIdle:isPreEvent:"),
        ]),
        // Evento sintetizado.
        .px3: .all([
            instance("XCSynthesizedEventRecord", "addPointerEventPath:"),
            .any([instance("XCSynthesizedEventRecord", "initWithName:displayID:interfaceOrientation:"),
                  instance("XCSynthesizedEventRecord", "initWithName:interfaceOrientation:")]),
            instance("XCPointerEventPath", "initForTouchAtPoint:offset:", "moveToPoint:atOffset:", "liftUpAtOffset:"),
            instance("XCUIDevice", "eventSynthesizer"),
            .any([instance("XCTRunnerDaemonSession", "synthesizeEvent:completion:"),
                  .symbol(.protocolMethod("synthesizeEvent:completion:"))]),
        ]),
        // Não parar o teste em falha.
        .px4: .any([
            instance("XCTestCase", "shouldHaltWhenReceivesControl", "setShouldHaltWhenReceivesControl:"),
            instance("XCTestCase", "shouldSetShouldHaltWhenReceivesControl", "setShouldSetShouldHaltWhenReceivesControl:"),
            instance("XCTIssue", "shouldInterruptTest"),
        ]),
        // XCTest não tocar alertas sozinho.
        .px5: instance("XCUIApplication", "doesNotHandleUIInterruptions"),
        // Captura de tela privada em JPEG.
        .px6: .all([
            .symbol(.cls("XCTImageEncoding")),
            .symbol(.protocolMethod("_XCT_requestScreenshot:withReply:")),
        ]),
    ]

    /// Roda a sondagem inteira.
    static func run() -> Result {
        let lookup = SymbolLookup()
        var present: Set<PrivateApiId> = []
        var missing: [PrivateApiId: [String]] = [:]
        for id in PrivateApiId.allCases {
            guard let requirement = requirements[id] else { continue }
            var absent: [String] = []
            if lookup.satisfies(requirement, missing: &absent) {
                present.insert(id)
            } else {
                missing[id] = absent
            }
        }
        return Result(present: present, missing: missing)
    }

    /// Leitura dos símbolos, com cache dos seletores declarados em protocolos.
    private final class SymbolLookup {
        private var protocolSelectors: Set<String>?

        func satisfies(_ requirement: Requirement, missing: inout [String]) -> Bool {
            switch requirement {
            case .symbol(let symbol):
                if exists(symbol) { return true }
                missing.append(symbol.description)
                return false
            case .all(let parts):
                var ok = true
                for part in parts where !satisfies(part, missing: &missing) { ok = false }
                return ok
            case .any(let options):
                var collected: [String] = []
                for option in options {
                    var local: [String] = []
                    if satisfies(option, missing: &local) { return true }
                    collected += local
                }
                missing += collected
                return false
            }
        }

        private func exists(_ symbol: Symbol) -> Bool {
            switch symbol {
            case .cls(let name):
                return objc_lookUpClass(name) != nil
            case .instanceMethod(let cls, let selector):
                guard let found = objc_lookUpClass(cls) else { return false }
                return Self.declares(found, NSSelectorFromString(selector))
            case .classMethod(let cls, let selector):
                guard let found = objc_lookUpClass(cls), let meta = object_getClass(found) else { return false }
                return Self.declares(meta, NSSelectorFromString(selector))
            case .protocolMethod(let selector):
                return protocolDeclared().contains(selector)
            }
        }

        /// O método está na lista de métodos da classe ou de uma superclasse (só leitura da tabela).
        private static func declares(_ start: AnyClass, _ selector: Selector) -> Bool {
            var current: AnyClass? = start
            while let cls = current {
                var count: UInt32 = 0
                if let methods = class_copyMethodList(cls, &count) {
                    defer { free(methods) }
                    for index in 0..<Int(count) where method_getName(methods[index]) == selector { return true }
                }
                current = class_getSuperclass(cls)
            }
            return false
        }

        /// Todos os seletores declarados (obrigatórios ou opcionais, de instância) pelos protocolos registrados.
        private func protocolDeclared() -> Set<String> {
            if let cached = protocolSelectors { return cached }
            var selectors: Set<String> = []
            var protocolCount: UInt32 = 0
            if let protocols = objc_copyProtocolList(&protocolCount) {
                for index in 0..<Int(protocolCount) {
                    let proto = protocols[index]
                    for required in [true, false] {
                        var methodCount: UInt32 = 0
                        guard let descriptions = protocol_copyMethodDescriptionList(proto, required, true, &methodCount) else {
                            continue
                        }
                        for item in 0..<Int(methodCount) {
                            if let name = descriptions[item].name { selectors.insert(NSStringFromSelector(name)) }
                        }
                        free(descriptions)
                    }
                }
                free(UnsafeMutableRawPointer(protocols))
            }
            protocolSelectors = selectors
            return selectors
        }
    }
}
