import Foundation

// Avaliação das condições de S0.3 (T-0.8; módulo `Choreo` de architecture.md A2, aqui no Kit por ser lógica pura):
// `wait.for` agora; `expect`, `waitFor`, `assert`, `block.when`, `repeat.until` e os pontos de controle quando o
// executor chegar. Cada sondagem lê a tela uma vez (uma `ReadSession`): toda leitura passa pela lista permitida
// (S1 item 11), e o que ela recusa — inclusive uma captura para o OCR — conta como "ainda não".

/// O resultado de uma sondagem, em três valores. **FAIL-CLOSED:** `unknown` (o runner não conseguiu provar nem que
/// sim nem que não — leitura recusada, bloqueio não lido, estado desconhecido) nunca vira verdadeiro, nem negado
/// (`not unknown = unknown`); a condição só vale com `holds`.
public enum ConditionTruth: Sendable, Equatable {
    case holds
    /// Provadamente falsa (o motivo vai para a mensagem do `E_TIMEOUT`).
    case fails(String)
    /// Nada provado.
    case unknown(String)

    public var holds: Bool { self == .holds }

    public var reason: String? {
        switch self {
        case .holds: nil
        case .fails(let reason), .unknown(let reason): reason
        }
    }

    public static func not(_ truth: ConditionTruth) -> ConditionTruth {
        switch truth {
        case .holds: .fails("not: a condição negada vale")
        case .fails: .holds
        case .unknown: truth
        }
    }

    /// Um falso decide (o primeiro); senão, um desconhecido deixa desconhecido; vazio vale.
    public static func all(_ truths: [ConditionTruth]) -> ConditionTruth {
        if let failed = truths.first(where: { if case .fails = $0 { true } else { false } }) { return failed }
        return truths.first { if case .unknown = $0 { true } else { false } } ?? .holds
    }

    /// Um verdadeiro decide; senão, um desconhecido deixa desconhecido; vazio não vale.
    public static func any(_ truths: [ConditionTruth]) -> ConditionTruth {
        if truths.contains(.holds) { return .holds }
        if let unknown = truths.first(where: { if case .unknown = $0 { true } else { false } }) { return unknown }
        return truths.first ?? .fails("any sem condições")
    }
}

/// A leitura de um alvo antes da ação, para `state: changed` (só em `expect`): rótulo e valor que podem sair (no
/// SpringBoard só o `value` do modo avião; na folha `authkit`, nenhum dos dois — lá só conta deixar de resolver).
public enum ElementReading: Sendable, Equatable {
    case resolved(label: String?, value: String?)
    case unresolved
    case unknown(String)
}

/// As leituras de antes da ação de cada `element … changed` da condição, pelo caminho dele na árvore da condição
/// (índices dos filhos de `all`/`any`; `not` = 0).
public struct ConditionBaseline: Sendable, Equatable {
    public var readings: [[Int]: ElementReading]

    public init(readings: [[Int]: ElementReading] = [:]) {
        self.readings = readings
    }
}

/// De onde as condições leem: a leitura (árvore, OCR, tela, lista permitida), o `XCUIApplication.state` de um app e a
/// rede.
public struct ConditionSources: Sendable {
    public var read: ReadMethods.Context
    /// `nil` = desconhecido.
    public var appState: @Sendable (String) -> AppRunState?
    /// `nil` = desconhecido.
    public var network: @Sendable () -> NetworkState?

    public init(read: ReadMethods.Context, appState: @escaping @Sendable (String) -> AppRunState?,
                network: @escaping @Sendable () -> NetworkState?) {
        self.read = read
        self.appState = appState
        self.network = network
    }
}

/// Avalia condições de S0.3:
/// - `element`: `exists` = resolve para ao menos um candidato; `gone` = nenhum; `hittable`, `selected`, `value` (com
///   `equals`) pedem um só candidato (vários = desconhecido); `changed` compara com a leitura de antes da ação;
/// - `text`: o OCR (por `TargetResolver`, com a captura conferida antes e depois) do app operável à frente acha / não
///   acha o texto;
/// - `appState`: `XCUIApplication.state` de `target`, de um app operável, ou o estado do processo da folha `authkit`
///   ou do SpringBoard (só o estado; nada da árvore);
/// - `locked`: `com.apple.springboard.lockstate` (não lida = desconhecido);
/// - `airplane`: o `value` do `airplane-mode-button`, só com a Central de Controle aberta (senão desconhecido);
/// - `network`: o monitor de rede;
/// - `all`/`any`/`not`: em três valores (`ConditionTruth`).
public struct ConditionEvaluator: Sendable {
    /// Sondagem a cada 100 ms ⚠️ (S0.3).
    public static let pollPeriodNs: UInt64 = 100_000_000

    public let sources: ConditionSources

    public init(_ sources: ConditionSources) {
        self.sources = sources
    }

    /// Uma sondagem: a tela lida uma vez, as árvores de cada app lidas uma vez e reaproveitadas.
    final class Poll {
        let session: ReadSession
        private(set) lazy var resolver: TargetResolver = session.resolver()

        init(_ read: ReadMethods.Context) {
            session = ReadSession(read)
        }
    }

    // MARK: Conferência estática

    /// Confere, **sem ler a tela**, o que a lista permitida nunca deixaria ler: nomes de app dos alvos (e das âncoras e
    /// alternativas, com a herança do resolvedor), os seletores na folha `authkit` e os apps de `appState`. Recusa →
    /// `E_FORBIDDEN_APP` na hora, em vez de sondar até o prazo.
    public func precheck(_ condition: Condition) throws(RpcErrorObject) {
        try Self.precheck(condition, sources.read.allowList())
    }

    static func precheck(_ condition: Condition, _ allowList: AllowList) throws(RpcErrorObject) {
        switch condition {
        case .element(let target, _, _):
            try precheck(target, inherited: nil, allowList)
        case .text(let ocr, _):
            // O app da captura é o operável que estiver à frente na hora: só os nomes explícitos se conferem aqui.
            try precheck(Target(ocr: ocr), inherited: nil, allowList, frontByDefault: true)
        case .appState(let app, _):
            _ = try allowList.scope(forTargetApp: app)
        case .locked, .airplane, .network:
            break
        case .all(let items), .any(let items):
            for item in items { try precheck(item, allowList) }
        case .not(let inner):
            try precheck(inner, allowList)
        }
    }

    /// `frontByDefault`: sem `app` (nem herdado), o alvo é do app à frente na hora (condição `text`) e não se confere
    /// aqui; senão, sem `app` é o app alvo (que tem de existir).
    static func precheck(_ target: Target, inherited: String?, _ allowList: AllowList,
                         frontByDefault: Bool = false) throws(RpcErrorObject) {
        let name = target.app ?? inherited
        var primary = target
        primary.fallback = nil
        primary.app = name
        if name != nil || !frontByDefault {
            try allowList.checkSelector(primary, app: allowList.scope(forTargetApp: name))
        }
        for anchor in [target.within, target.below, target.above, target.ocr?.within].compactMap({ $0 }) {
            try precheck(anchor, inherited: name, allowList, frontByDefault: frontByDefault)
        }
        for alternative in target.fallback ?? [] {
            try precheck(alternative, inherited: name, allowList, frontByDefault: frontByDefault)
        }
    }

    // MARK: Sondagem

    /// Uma sondagem da condição (`baseline` = as leituras de antes da ação, para `changed`).
    public func evaluate(_ condition: Condition, baseline: ConditionBaseline = ConditionBaseline()) -> ConditionTruth {
        evaluate(condition, at: [], Poll(sources.read), baseline)
    }

    private func evaluate(_ condition: Condition, at path: [Int], _ poll: Poll, _ baseline: ConditionBaseline) -> ConditionTruth {
        switch condition {
        case .element(let target, let state, let equals):
            return element(target, state, equals, at: path, poll, baseline)
        case .text(let ocr, let state):
            return text(ocr, state, poll)
        case .appState(let app, let state):
            return appState(app, state, poll)
        case .locked(let wanted):
            switch poll.session.screen.lock {
            case .unknown: return .unknown("o bloqueio não foi lido (lockstate)")
            case .locked: return wanted ? .holds : .fails("a tela está travada")
            case .unlocked: return wanted ? .fails("a tela está destravada") : .holds
            }
        case .airplane(let wanted):
            return airplane(wanted, poll)
        case .network(let wanted):
            guard let network = sources.network() else { return .unknown("a rede ainda é desconhecida") }
            return network == wanted ? .holds : .fails("a rede está \(network.rawValue)")
        case .all(let items):
            var truths: [ConditionTruth] = []
            for (index, item) in items.enumerated() {
                let truth = evaluate(item, at: path + [index], poll, baseline)
                if case .fails = truth { return truth }
                truths.append(truth)
            }
            return .all(truths)
        case .any(let items):
            var truths: [ConditionTruth] = []
            for (index, item) in items.enumerated() {
                let truth = evaluate(item, at: path + [index], poll, baseline)
                if truth.holds { return truth }
                truths.append(truth)
            }
            return .any(truths)
        case .not(let inner):
            return .not(evaluate(inner, at: path + [0], poll, baseline))
        }
    }

    // MARK: element

    /// Os candidatos de um alvo nesta sondagem. "Não achado" só é resposta (nenhum) quando nenhum passo da resolução foi
    /// ambíguo — uma âncora ambígua numa alternativa de `fallback` (ou no fallback de uma âncora) some no erro final do
    /// resolvedor, e aqui conta como "nada provado" (revisão da T-0.8, achado 3). Recusa da lista permitida, âncora
    /// ambígua e falha do XCTest também são "nada provado". Um candidato achado por uma alternativa conta como nas
    /// ações (S0.2: o fallback é tentado quando o primário não resolve).
    private func candidates(_ target: Target, _ poll: Poll) -> Result<[Candidate], RpcErrorObject> {
        let resolver = poll.resolver
        let ambiguitiesBefore = resolver.ambiguitiesSeen
        do {
            return .success(try resolver.find(target))
        } catch {
            guard error.code == RunnerErrorCode.targetNotFound.code || error.code == RunnerErrorCode.ocrNotFound.code else {
                return .failure(error)
            }
            guard resolver.ambiguitiesSeen == ambiguitiesBefore else {
                return .failure(RpcErrorObject(.targetAmbiguous, "E_TARGET_AMBIGUOUS: uma âncora ambígua em algum passo da resolução "
                                               + "(\(TargetResolver.describe(target))); não dá para concluir que o alvo não resolve"))
            }
            return .success([])
        }
    }

    private func element(_ target: Target, _ state: ElementState, _ equals: String?, at path: [Int], _ poll: Poll,
                         _ baseline: ConditionBaseline) -> ConditionTruth {
        if state == .changed { return changed(target, at: path, poll, baseline) }
        let found: [Candidate]
        switch candidates(target, poll) {
        case .failure(let error): return .unknown(error.message)
        case .success(let list): found = list
        }
        switch state {
        case .exists:
            return found.isEmpty ? .fails("o alvo não resolve") : .holds
        case .gone:
            return found.isEmpty ? .holds : .fails("o alvo ainda resolve")
        case .hittable, .selected, .value:
            guard let only = found.first else { return .fails("o alvo não resolve") }
            guard found.count == 1 else { return .unknown("\(found.count) candidatos; use index") }
            switch state {
            case .hittable:
                return only.isHittable(on: sources.read.screenSize) ? .holds : .fails("o alvo não está tocável (fora da tela)")
            case .selected:
                guard let node = only.node, Self.exposesSelected(only.app) else { return .unknown("selected não se lê deste alvo") }
                return node.selected ? .holds : .fails("o alvo não está selecionado")
            default:
                guard let equals else { return .unknown("state: value sem equals não tem valor a comparar (S0.3)") }
                guard let node = only.node, ReadScope.exposesValue(node, app: only.app) else {
                    return .unknown("o value deste alvo não se lê")
                }
                return node.value == equals ? .holds : .fails("o value do alvo é outro")
            }
        case .changed:
            return changed(target, at: path, poll, baseline)
        }
    }

    /// `selected` sai do app operável e do SpringBoard; nunca da folha `authkit` (lá só existência e toque, como em
    /// `ui.find`).
    static func exposesSelected(_ app: AppScope) -> Bool {
        if case .authkit = app { return false }
        return true
    }

    /// O que se compara em `changed`: rótulo e valor que podem sair (nada na folha `authkit`).
    private func reading(_ target: Target, _ poll: Poll) -> ElementReading {
        switch candidates(target, poll) {
        case .failure(let error):
            return .unknown(error.message)
        case .success(let found):
            guard let only = found.first else { return .unresolved }
            guard found.count == 1 else { return .unknown("\(found.count) candidatos; use index") }
            guard let node = only.node else { return .resolved(label: nil, value: nil) }
            if case .authkit = only.app { return .resolved(label: nil, value: nil) }
            return .resolved(label: node.label, value: ReadScope.exposesValue(node, app: only.app) ? node.value : nil)
        }
    }

    /// `changed` (S0.3, só em `expect`): vale quando o alvo, que resolvia antes da ação, deixou de resolver ou tem
    /// rótulo/valor diferente do lido antes. Sem leitura de antes (ou com o alvo ausente antes), nunca vale.
    private func changed(_ target: Target, at path: [Int], _ poll: Poll, _ baseline: ConditionBaseline) -> ConditionTruth {
        guard let before = baseline.readings[path] else { return .unknown("changed sem a leitura de antes da ação (só vale em expect)") }
        guard case .resolved(let label, let value) = before else { return .unknown("changed: o alvo não resolvia antes da ação") }
        switch reading(target, poll) {
        case .unresolved:
            return .holds
        case .unknown(let reason):
            return .unknown(reason)
        case .resolved(let nowLabel, let nowValue):
            return nowLabel != label || nowValue != value ? .holds : .fails("rótulo e valor iguais aos de antes da ação")
        }
    }

    /// As leituras de antes da ação para cada `element … changed` (lidas numa sondagem só).
    public func baseline(_ condition: Condition) -> ConditionBaseline {
        let poll = Poll(sources.read)
        var out = ConditionBaseline()
        collect(condition, at: [], poll, &out)
        return out
    }

    private func collect(_ condition: Condition, at path: [Int], _ poll: Poll, _ out: inout ConditionBaseline) {
        switch condition {
        case .element(let target, .changed, _):
            out.readings[path] = reading(target, poll)
        case .all(let items), .any(let items):
            for (index, item) in items.enumerated() { collect(item, at: path + [index], poll, &out) }
        case .not(let inner):
            collect(inner, at: path + [0], poll, &out)
        default:
            break
        }
    }

    // MARK: text, appState, airplane

    /// `text` (S0.3): o OCR da captura do app operável **provado à frente** — o app alvo, o hospedeiro fora de tomada ou
    /// um de `apps.allowed` (S1 item 11; revisão da T-0.8, achado 2) —, com as releituras e recusas da captura de sempre
    /// (`ReadSession`). Qualquer outra coisa à frente: nada é capturado, e conta como "ainda não".
    private func text(_ ocr: OcrSelector, _ state: TextState, _ poll: Poll) -> ConditionTruth {
        let front = poll.session.allowList.front(poll.session.screen)
        guard case .operable(let app) = front else {
            return .unknown("captura recusada com \(front) à frente; nada foi capturado (S1 item 11)")
        }
        switch candidates(Target(app: app, ocr: ocr), poll) {
        case .failure(let error):
            return .unknown(error.message)
        case .success(let found):
            switch state {
            case .visible: return found.isEmpty ? .fails("o texto não está na tela") : .holds
            case .gone: return found.isEmpty ? .holds : .fails("o texto ainda está na tela")
            }
        }
    }

    private func appState(_ name: String, _ wanted: AppRunState, _ poll: Poll) -> ConditionTruth {
        let bundleId: String
        do {
            bundleId = try poll.session.allowList.scope(forTargetApp: name).bundleId
        } catch {
            return .unknown(error.message)
        }
        guard let state = sources.appState(bundleId) else { return .unknown("o estado de \(bundleId) é desconhecido") }
        return state == wanted ? .holds : .fails("\(bundleId) está \(state.rawValue)")
    }

    /// O interruptor do modo avião só se lê com a Central de Controle aberta (S0.3); "1"/"0" = ligado/desligado.
    private func airplane(_ wanted: OnOff, _ poll: Poll) -> ConditionTruth {
        let front = poll.session.allowList.front(poll.session.screen)
        guard case .controlCenter = front else {
            return .unknown("airplane só se avalia com a Central de Controle aberta; à frente: \(front)")
        }
        let target = Target(app: "springboard", identifier: ReadScope.airplaneModeIdentifier)
        switch candidates(target, poll) {
        case .failure(let error):
            return .unknown(error.message)
        case .success(let found):
            guard found.count == 1, let node = found.first?.node else { return .unknown("o interruptor do modo avião não foi achado") }
            let state: OnOff
            switch node.value {
            case "1": state = .on
            case "0": state = .off
            default: return .unknown("value do interruptor do modo avião não reconhecido")
            }
            return state == wanted ? .holds : .fails("o modo avião está \(state.rawValue)")
        }
    }

    // MARK: Espera até o prazo

    /// Sonda a cada `pollPeriodNs` até a condição valer ou o prazo (`timeoutMs`, a partir do começo) passar; um prazo
    /// que não cai num múltiplo do período ganha uma última sondagem no próprio prazo; `timeoutMs = 0` avalia uma vez.
    /// Antes de tudo, a conferência estática (`E_FORBIDDEN_APP` sem ler a tela). Devolve o começo e o fim da sondagem
    /// que valeu (D); no prazo, `E_TIMEOUT` com o motivo da última sondagem.
    public func wait(for condition: Condition, timeoutMs: Int, baseline: ConditionBaseline = ConditionBaseline(),
                     clock: () -> UInt64, sleep: (UInt64) -> Void) throws(RpcErrorObject) -> (start: UInt64, end: UInt64) {
        let start = clock()
        try precheck(condition)
        let span = UInt64(max(0, timeoutMs)).multipliedReportingOverflow(by: 1_000_000)
        let sum = start.addingReportingOverflow(span.partialValue)
        let deadline = span.overflow || sum.overflow ? UInt64.max : sum.partialValue
        var pollAt = start
        var polls = 0
        while true {
            let truth = evaluate(condition, baseline: baseline)
            polls += 1
            let now = clock()
            if truth.holds { return (start, now) }
            if pollAt >= deadline || now >= deadline {
                throw RpcErrorObject(.timeout, "E_TIMEOUT: a condição não ficou verdadeira em \(timeoutMs) ms (\(polls) "
                                     + "\(polls == 1 ? "sondagem" : "sondagens"); a última: \(truth.reason ?? "-"))")
            }
            let next = pollAt.addingReportingOverflow(Self.pollPeriodNs)
            pollAt = next.overflow ? deadline : min(next.partialValue, deadline)
            if pollAt > now { sleep(pollAt - now) }
        }
    }
}
