import Foundation

// Resolução de alvos (S0.2) sobre a árvore (S0.6) e o OCR (S1 item 6). Pura: a árvore de cada app e as linhas
// do OCR vêm de fontes injetadas — no runner, o snapshot público e o Vision; nos testes, árvores de fixture.
// A lista permitida entra pelas fontes (que só entregam o que a leitura alcança) e pelos nomes de app.

/// Árvore de um app recortada pela lista permitida: só os nós com `reachable[i]` viram candidatos ou âncoras.
public struct ScopedTree: Sendable {
    public let app: AppScope
    public let version: Int
    public let tree: IndexedTree
    /// `nil` = todos os nós.
    public let reachable: [Bool]?

    public init(app: AppScope, version: Int, tree: IndexedTree, reachable: [Bool]?) {
        self.app = app
        self.version = version
        self.tree = tree
        self.reachable = reachable
    }

    public func isReachable(_ index: Int) -> Bool { reachable?[index] ?? true }
}

/// Um candidato de um alvo: um nó da árvore, uma caixa do OCR ou um ponto da tela.
public struct Candidate: Sendable, Equatable {
    public enum Source: Sendable, Equatable {
        case node(TreeNode)
        case ocr(text: String)
        case point
    }

    public var app: AppScope
    public var source: Source
    /// Frame em pontos (um ponto tem frame de tamanho zero).
    public var frame: Rect

    public var node: TreeNode? {
        if case .node(let node) = source { return node }
        return nil
    }

    public var center: AbsolutePoint { AbsolutePoint(x: frame.midX, y: frame.midY) }

    /// Visível = frame ∩ tela com área > 0 (S0.2); um ponto é visível dentro da tela.
    public func isVisible(on screen: Size) -> Bool {
        if case .point = source { return Rect(screen: screen).contains(x: frame.x, y: frame.y) }
        return node?.visible ?? frame.isVisible(on: screen)
    }

    /// Tocável pela geometria: o centro cai na tela (um toque no centro chega ao app). Cobertura por outro
    /// elemento não se vê no snapshot público; o SP-10 compara com `isHittable`.
    public func isHittable(on screen: Size) -> Bool {
        if case .point = source { return Rect(screen: screen).contains(x: frame.x, y: frame.y) }
        return frame.area > 0 && Rect(screen: screen).contains(x: frame.midX, y: frame.midY)
    }

    /// Um candidato de `ui.find` (S1 item 4): `ref` (quando é nó), `frame`, `visible`, `hittable` e `value`
    /// quando o nó tem e pode sair (`ReadScope.exposesValue`: no SpringBoard só o do modo avião, AC-1.15; na folha
    /// `authkit`, nunca).
    public func findJSON(screen: Size) -> JSONValue {
        var out: JSONObject = ["frame": frame.json, "visible": .bool(isVisible(on: screen)),
                               "hittable": .bool(isHittable(on: screen))]
        out.put("ref", node.map { .string($0.ref) })
        if let node, ReadScope.exposesValue(node, app: app) { out.put("value", node.value.map { .string($0) }) }
        return .object(out)
    }

    /// Forma curta para a lista de `E_TARGET_AMBIGUOUS`: `{ref, frame}` (ou `{text, frame}` do OCR).
    public var briefJSON: JSONValue {
        var out: JSONObject = ["frame": frame.json]
        switch source {
        case .node(let node): out["ref"] = .string(node.ref)
        case .ocr(let text): out["text"] = .string(text)
        case .point: break
        }
        return .object(out)
    }
}

/// Um alvo resolvido: o ponto da tela onde agir (centro + `offset`) e o candidato.
public struct ResolvedTarget: Sendable, Equatable {
    public var point: AbsolutePoint
    public var candidate: Candidate
}

/// Resolve alvos de S0.2 numa operação (um comando): cada app é lido uma vez e reaproveitado pelas âncoras
/// (`within`, `below`, `above`) e pelas alternativas (`fallback`).
///
/// Regras (S0.2):
/// - exatamente um seletor primário (`ref`, `label`, `labelPrefix`, `labelContains`, `identifier`, `ocr`,
///   `point`), ou só `type`; `type` filtra (`any` = todos);
/// - `within` restringe aos descendentes do alvo dado (alvo sem nó: aos candidatos com o centro dentro do frame
///   dele); `below`/`above`: só candidatos com `frame.minY` abaixo (≥ `maxY`) / acima (< `minY`) do alvo dado;
/// - `index` desempata pela ordem de leitura (topo→base, esquerda→direita), a partir de 0;
/// - `fallback`: alternativas tentadas em ordem quando o seletor primário não resolve; herdam o `app`;
/// - zero candidatos → `E_TARGET_NOT_FOUND` (`E_OCR_NOT_FOUND` no `ocr`); mais de um sem `index` →
///   `E_TARGET_AMBIGUOUS` com a lista. Erros que não são "não resolveu" (lista permitida, XCTest) param na hora.
public final class TargetResolver {
    public typealias TreeSource = (AppScope) throws(RpcErrorObject) -> ScopedTree
    public typealias TextSource = (Rect) throws(RpcErrorObject) -> [OcrLine]
    public typealias AppNamer = (String?) throws(RpcErrorObject) -> AppScope
    public typealias SelectorCheck = (Target, AppScope) throws(RpcErrorObject) -> Void

    private let screen: Size
    private let appScope: AppNamer
    private let treeSource: TreeSource
    private let textSource: TextSource
    private let selectorCheck: SelectorCheck
    private var trees: [AppScope: ScopedTree] = [:]

    /// Ambiguidades (`E_TARGET_AMBIGUOUS` de uma âncora, em qualquer profundidade) vistas por este resolvedor, inclusive
    /// as que um "não achado" de outra alternativa mascarou no erro final. As ações não mudam; as condições de S0.3 usam
    /// isto para nunca concluir "não resolve" de uma resolução incerta (revisão da T-0.8, achado 3).
    public private(set) var ambiguitiesSeen = 0

    /// - Parameter selectors: confere o seletor de cada alternativa e âncora com o app dela (a lista permitida
    ///   recusa, por exemplo, `labelContains` na folha `authkit`).
    public init(screen: Size, appScope: @escaping AppNamer, tree: @escaping TreeSource, text: @escaping TextSource,
                selectors: @escaping SelectorCheck = { _, _ in }) {
        self.screen = screen
        self.appScope = appScope
        self.treeSource = tree
        self.textSource = text
        self.selectorCheck = selectors
    }

    /// Os candidatos que a resolução vê (`ui.find`): o único da primeira alternativa que resolve; se nenhuma
    /// resolve e alguma tem vários, a lista da primeira dessas (o toque daria `E_TARGET_AMBIGUOUS`); se
    /// nenhuma tem candidato, o erro da primeira alternativa.
    public func find(_ target: Target) throws(RpcErrorObject) -> [Candidate] {
        try evaluate(target, inheritedApp: nil).candidates
    }

    /// Um único ponto (e o nó, quando veio da árvore).
    public func resolve(_ target: Target) throws(RpcErrorObject) -> ResolvedTarget {
        let (candidates, chosen) = try evaluate(target, inheritedApp: nil)
        guard candidates.count == 1, let only = candidates.first else {
            throw Self.ambiguous(candidates, chosen)
        }
        return Self.resolution(only, offset: chosen.offset)
    }

    /// A árvore recortada de um app, lida uma vez por operação.
    public func scopedTree(_ app: AppScope) throws(RpcErrorObject) -> ScopedTree {
        if let cached = trees[app] { return cached }
        let tree = try treeSource(app)
        trees[app] = tree
        return tree
    }

    // MARK: Alternativas

    private func alternatives(_ target: Target, app: String?) -> [Target] {
        var primary = target
        primary.fallback = nil
        if primary.app == nil { primary.app = app }
        let inherited = primary.app
        return [primary] + (target.fallback ?? []).flatMap { alternatives($0, app: inherited) }
    }

    private func evaluate(_ target: Target, inheritedApp: String?) throws(RpcErrorObject) -> (candidates: [Candidate], alternative: Target) {
        var firstError: RpcErrorObject?
        var ambiguous: ([Candidate], Target)?
        for alternative in alternatives(target, app: inheritedApp) {
            do {
                let found = try candidates(alternative)
                if found.count == 1 { return (found, alternative) }
                if found.count > 1 {
                    if ambiguous == nil { ambiguous = (found, alternative) }
                } else if firstError == nil {
                    firstError = notFound(alternative)
                }
            } catch {
                guard Self.isUnresolved(error) else { throw error }
                if error.code == RunnerErrorCode.targetAmbiguous.code { ambiguitiesSeen += 1 }
                if firstError == nil { firstError = error }
            }
        }
        if let ambiguous { return ambiguous }
        throw firstError ?? notFound(target)
    }

    static func isUnresolved(_ error: RpcErrorObject) -> Bool {
        [RunnerErrorCode.targetNotFound, .targetAmbiguous, .ocrNotFound].map(\.code).contains(error.code)
    }

    // MARK: Candidatos de uma alternativa (sem `fallback`)

    private func candidates(_ target: Target) throws(RpcErrorObject) -> [Candidate] {
        let app = try appScope(target.app)
        try selectorCheck(target, app)
        var list: [Candidate]
        if let point = target.point {
            list = [pointCandidate(point, app: app)]
            if let within = target.within {
                let anchor = try self.anchor(within, app: target.app)
                list = list.filter { anchor.frame.contains(x: $0.frame.x, y: $0.frame.y) }
            }
        } else if let ocr = target.ocr {
            list = try ocrCandidates(ocr, target: target, app: app)
        } else {
            list = try nodeCandidates(target, app: app)
        }
        if let below = target.below {
            let anchor = try self.anchor(below, app: target.app)
            list = list.filter { $0.frame.minY >= anchor.frame.maxY }
        }
        if let above = target.above {
            let anchor = try self.anchor(above, app: target.app)
            list = list.filter { $0.frame.minY < anchor.frame.minY }
        }
        list = Self.readingOrder(list)
        if let index = target.index {
            list = index < list.count ? [list[index]] : []
        }
        return list
    }

    /// Uma âncora (`within`, `below`, `above`, `ocr.within`) tem de resolver para um único candidato.
    private func anchor(_ target: Target, app: String?) throws(RpcErrorObject) -> Candidate {
        let (found, chosen) = try evaluate(target, inheritedApp: app)
        guard found.count == 1, let only = found.first else { throw Self.ambiguous(found, chosen) }
        return only
    }

    private func nodeCandidates(_ target: Target, app: AppScope) throws(RpcErrorObject) -> [Candidate] {
        let scoped = try scopedTree(app)
        let nodes = scoped.tree.nodes
        var range = 0..<nodes.count
        var containment: Rect?
        if let within = target.within {
            let anchor = try self.anchor(within, app: target.app)
            if let node = anchor.node, anchor.app == app, let index = scoped.tree.index(ofRef: node.ref) {
                range = (index + 1)..<scoped.tree.subtreeEnd[index]
            } else {
                containment = anchor.frame
            }
        }
        var out: [Candidate] = []
        for index in range where scoped.isReachable(index) && Self.matches(nodes[index], target) {
            let node = nodes[index]
            if let containment, !containment.contains(x: node.frame.midX, y: node.frame.midY) { continue }
            out.append(Candidate(app: app, source: .node(node), frame: node.frame))
        }
        return out
    }

    static func matches(_ node: TreeNode, _ target: Target) -> Bool {
        if let type = target.type, type != .any, node.type != type { return false }
        if let ref = target.ref, node.ref != ref { return false }
        if let label = target.label, node.label != label { return false }
        if let prefix = target.labelPrefix, !(node.label?.hasPrefix(prefix) ?? false) { return false }
        if let part = target.labelContains, !(node.label?.contains(part) ?? false) { return false }
        if let identifier = target.identifier, node.identifier != identifier { return false }
        return true
    }

    private func ocrCandidates(_ ocr: OcrSelector, target: Target, app: AppScope) throws(RpcErrorObject) -> [Candidate] {
        var region: Rect? = Rect(screen: screen)
        if let limit = ocr.region { region = region?.intersection(limit) }
        if let within = ocr.within {
            let anchor = try self.anchor(within, app: target.app)
            region = region?.intersection(anchor.frame)
        }
        if let within = target.within {
            let anchor = try self.anchor(within, app: target.app)
            region = region?.intersection(anchor.frame)
        }
        guard let region else { return [] }
        let lines = try textSource(region)
        var found = OcrMatcher.matches(ocr.text, in: lines, region: region)
        if let occurrence = ocr.occurrence {
            found = occurrence < found.count ? [found[occurrence]] : []
        }
        return found.map { Candidate(app: app, source: .ocr(text: $0.text), frame: $0.frame) }
    }

    private func pointCandidate(_ point: Point, app: AppScope) -> Candidate {
        let (x, y): (Double, Double)
        switch point {
        case .absolute(let px, let py): (x, y) = (px, py)
        case .normalized(let nx, let ny): (x, y) = (nx * screen.w, ny * screen.h)
        }
        return Candidate(app: app, source: .point, frame: Rect(x: x, y: y, w: 0, h: 0))
    }

    // MARK: Apoio

    static func resolution(_ candidate: Candidate, offset: Offset?) -> ResolvedTarget {
        let center = candidate.center
        let point = AbsolutePoint(x: center.x + (offset?.dx ?? 0), y: center.y + (offset?.dy ?? 0))
        return ResolvedTarget(point: point, candidate: candidate)
    }

    /// Ordem de leitura de S0.2: topo→base, depois esquerda→direita (empate: ordem da árvore).
    static func readingOrder(_ list: [Candidate]) -> [Candidate] {
        list.enumerated().sorted { a, b in
            if a.element.frame.minY != b.element.frame.minY { return a.element.frame.minY < b.element.frame.minY }
            if a.element.frame.minX != b.element.frame.minX { return a.element.frame.minX < b.element.frame.minX }
            return a.offset < b.offset
        }.map(\.element)
    }

    static func describe(_ target: Target) -> String {
        (try? JCS.canonicalize(target.json)) ?? "alvo"
    }

    func notFound(_ target: Target) -> RpcErrorObject {
        if let ocr = target.ocr {
            return RpcErrorObject(.ocrNotFound, "E_OCR_NOT_FOUND: texto \(TreeFormat.quoted(ocr.text)) não achado na região "
                                  + "(\(Self.describe(target)))")
        }
        var detail = ""
        if let ref = target.ref {
            detail = ref.hasPrefix("@e")
                ? " (\(ref) não está na árvore atual; refs valem até a árvore mudar, S0.6)"
                : " (ref de catálogo só existe dentro de coreografia compilada)"
        } else if target.index != nil {
            detail = " (index fora da lista de candidatos)"
        }
        return RpcErrorObject(.targetNotFound, "E_TARGET_NOT_FOUND: nenhum candidato para \(Self.describe(target))\(detail)")
    }

    static func ambiguous(_ candidates: [Candidate], _ target: Target) -> RpcErrorObject {
        RpcErrorObject(.targetAmbiguous,
                       "E_TARGET_AMBIGUOUS: \(candidates.count) candidatos para \(describe(target)); use index",
                       data: ["candidates": .array(candidates.map(\.briefJSON))])
    }
}
