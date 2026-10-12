import Foundation

// Árvore de acessibilidade como o Kit a vê (S0.6): o `Driver` do runner converte o snapshot público do
// XCUIAutomation em `RawNode`; aqui ele ganha `ref` (`@e<n>`), `depth` e `visible`, e o `treeVersion` muda
// quando a árvore muda.

/// Um nó do snapshot, sem `ref`: o que o `XCUIElementSnapshot` dá (tipo, rótulo, identificador, valor, frame em
/// pontos, habilitado, selecionado, filhos).
public struct RawNode: Sendable, Equatable {
    public var type: ElementType
    public var label: String?
    public var identifier: String?
    public var value: String?
    public var frame: Rect
    public var enabled: Bool
    public var selected: Bool
    public var children: [RawNode]

    public init(type: ElementType, label: String? = nil, identifier: String? = nil, value: String? = nil,
                frame: Rect, enabled: Bool = true, selected: Bool = false, children: [RawNode] = []) {
        self.type = type
        self.label = label
        self.identifier = identifier
        self.value = value
        self.frame = frame
        self.enabled = enabled
        self.selected = selected
        self.children = children
    }
}

extension ElementType {
    /// O tipo do `rawValue` de um `XCUIElement.ElementType`; fora da tabela, `other`.
    public init(xcuiRawValue: UInt) {
        let all = Self.allCases
        self = xcuiRawValue < UInt(all.count) ? all[Int(xcuiRawValue)] : .other
    }
}

extension Rect {
    public var minX: Double { x }
    public var minY: Double { y }
    public var maxX: Double { x + w }
    public var maxY: Double { y + h }
    public var midX: Double { x + w / 2 }
    public var midY: Double { y + h / 2 }
    public var area: Double { w * h }

    /// A tela em pontos.
    public init(screen: Size) {
        self.init(x: 0, y: 0, w: screen.w, h: screen.h)
    }

    /// Interseção (vazia = `nil`).
    public func intersection(_ other: Rect) -> Rect? {
        let x0 = max(minX, other.minX), y0 = max(minY, other.minY)
        let x1 = min(maxX, other.maxX), y1 = min(maxY, other.maxY)
        guard x1 > x0, y1 > y0 else { return nil }
        return Rect(x: x0, y: y0, w: x1 - x0, h: y1 - y0)
    }

    /// Menor retângulo que contém os dois.
    public func union(_ other: Rect) -> Rect {
        let x0 = min(minX, other.minX), y0 = min(minY, other.minY)
        let x1 = max(maxX, other.maxX), y1 = max(maxY, other.maxY)
        return Rect(x: x0, y: y0, w: x1 - x0, h: y1 - y0)
    }

    /// O ponto está dentro (borda esquerda/superior inclusa, direita/inferior não).
    public func contains(x px: Double, y py: Double) -> Bool {
        px >= minX && px < maxX && py >= minY && py < maxY
    }

    /// Visível = frame ∩ tela com área > 0 (S0.2).
    public func isVisible(on screen: Size) -> Bool {
        intersection(Rect(screen: screen)) != nil
    }
}

/// Os refs e o `treeVersion` (S0.6). Os refs são únicos na vida do runner (`@e1`, `@e2`, …): um ref de uma
/// árvore que mudou nunca aponta para outro nó, e resolve para `E_TARGET_NOT_FOUND`. A árvore "muda" quando
/// muda a estrutura — a sequência (profundidade, tipo, identificador, rótulo) em pré-ordem —; frame, valor,
/// habilitado e selecionado mudam sem trocar os refs (animação não invalida um `@eN`).
public final class TreeRegistry: @unchecked Sendable {
    /// Uma árvore registrada.
    public struct Snapshot: Sendable {
        public let app: String
        public let version: Int
        public let root: TreeNode
    }

    private struct Key: Hashable {
        let depth: Int
        let type: ElementType
        let identifier: String?
        let label: String?
    }

    private struct Entry {
        let signature: [Key]
        let firstRef: Int
    }

    private let lock = NSLock()
    private var entries: [String: Entry] = [:]
    private var nextRef = 1
    private var _version = 0

    public init() {}

    /// O `treeVersion` corrente (o de `health`): sobe a cada árvore nova de qualquer app.
    public var version: Int { lock.withLock { _version } }

    /// Registra o snapshot de `app` e devolve a árvore com refs, profundidade e visibilidade.
    public func record(app: String, raw: RawNode, screen: Size) -> Snapshot {
        var signature: [Key] = []
        Self.collect(raw, depth: 0, into: &signature)
        let (firstRef, version) = lock.withLock { () -> (Int, Int) in
            if let entry = entries[app], entry.signature == signature {
                return (entry.firstRef, _version)
            }
            let first = nextRef
            nextRef += signature.count
            _version += 1
            entries[app] = Entry(signature: signature, firstRef: first)
            return (first, _version)
        }
        var counter = firstRef
        let root = Self.build(raw, depth: 0, screen: screen, counter: &counter)
        return Snapshot(app: app, version: version, root: root)
    }

    private static func collect(_ node: RawNode, depth: Int, into keys: inout [Key]) {
        keys.append(Key(depth: depth, type: node.type, identifier: node.identifier, label: node.label))
        for child in node.children { collect(child, depth: depth + 1, into: &keys) }
    }

    /// A árvore com refs provisórios (`@e1`…), sem registrar nada nem mexer na numeração nem no `treeVersion`: para
    /// recortar o SpringBoard e a folha antes de registrar só o que a leitura alcança.
    static func unregistered(_ raw: RawNode, screen: Size) -> TreeNode {
        var counter = 1
        return build(raw, depth: 0, screen: screen, counter: &counter)
    }

    private static func build(_ node: RawNode, depth: Int, screen: Size, counter: inout Int) -> TreeNode {
        let ref = "@e\(counter)"
        counter += 1
        let children = node.children.map { build($0, depth: depth + 1, screen: screen, counter: &counter) }
        return TreeNode(ref: ref, type: node.type, label: node.label, identifier: node.identifier, value: node.value,
                        frame: node.frame, enabled: node.enabled, selected: node.selected,
                        visible: node.frame.isVisible(on: screen), depth: depth,
                        children: children.isEmpty ? nil : children)
    }
}

/// A árvore em pré-ordem, com os descendentes de cada nó em faixa contígua, para a resolução de alvos.
public struct IndexedTree: Sendable {
    /// Nós em pré-ordem, sem `children`.
    public let nodes: [TreeNode]
    /// Os descendentes de `nodes[i]` são `nodes[(i + 1)..<subtreeEnd[i]]`.
    public let subtreeEnd: [Int]

    public init(_ root: TreeNode) {
        var nodes: [TreeNode] = []
        var ends: [Int] = []
        Self.walk(root, &nodes, &ends)
        self.nodes = nodes
        self.subtreeEnd = ends
    }

    private static func walk(_ node: TreeNode, _ nodes: inout [TreeNode], _ ends: inout [Int]) {
        let index = nodes.count
        var flat = node
        flat.children = nil
        nodes.append(flat)
        ends.append(0)
        for child in node.children ?? [] { walk(child, &nodes, &ends) }
        ends[index] = nodes.count
    }

    public func index(ofRef ref: String) -> Int? {
        nodes.firstIndex { $0.ref == ref }
    }
}

/// Formatos de `ui.tree` (S1 item 4, S0.6).
public enum TreeOutputFormat: String, Sendable, CaseIterable {
    case compact, json
}

public enum TreeFormat {
    /// `json`: a árvore com `children`, podada — `visibleOnly` tira subárvores sem nenhum nó visível (um
    /// ancestral invisível de nó visível fica, com `visible: false`); `maxDepth` corta abaixo dessa
    /// profundidade (raiz = 0).
    public static func pruned(_ node: TreeNode, visibleOnly: Bool, maxDepth: Int?) -> TreeNode? {
        var copy = node
        if let maxDepth, node.depth >= maxDepth {
            copy.children = nil
        } else {
            let kept = (node.children ?? []).compactMap { pruned($0, visibleOnly: visibleOnly, maxDepth: maxDepth) }
            copy.children = kept.isEmpty ? nil : kept
        }
        if visibleOnly && !copy.visible && copy.children == nil { return nil }
        return copy
    }

    /// `compact`: uma linha por nó (S0.6), em pré-ordem — `@e12 button "Open settings" (342,52 40x40)` —,
    /// seguida, só quando há, de `id="…"`, `value="…"` e dos estados fora do padrão (`disabled`, `selected`;
    /// `offscreen` quando `visibleOnly = false` lista um nó invisível).
    public static func compactLines(_ root: TreeNode, visibleOnly: Bool, maxDepth: Int?) -> [String] {
        var lines: [String] = []
        func walk(_ node: TreeNode) {
            if let maxDepth, node.depth > maxDepth { return }
            if node.visible || !visibleOnly { lines.append(compactLine(node)) }
            for child in node.children ?? [] { walk(child) }
        }
        walk(root)
        return lines
    }

    public static func compactLine(_ node: TreeNode) -> String {
        var line = "\(node.ref) \(node.type.rawValue)"
        if let label = node.label { line += " " + quoted(label) }
        let f = node.frame
        line += " (\(number(f.x)),\(number(f.y)) \(number(f.w))x\(number(f.h)))"
        if let identifier = node.identifier { line += " id=" + quoted(identifier) }
        if let value = node.value { line += " value=" + quoted(value) }
        if !node.enabled { line += " disabled" }
        if node.selected { line += " selected" }
        if !node.visible { line += " offscreen" }
        return line
    }

    /// Inteiro sem casas; senão até 2 casas, sem zeros à direita.
    static func number(_ value: Double) -> String {
        let rounded = (value * 100).rounded() / 100
        if rounded == rounded.rounded(), abs(rounded) < 1e15 { return String(Int(rounded)) }
        var text = String(format: "%.2f", rounded)
        while text.hasSuffix("0") { text.removeLast() }
        return text
    }

    static func quoted(_ text: String) -> String {
        var out = ""
        JCS.serialize(string: text, into: &out)
        return out
    }
}

/// O que uma leitura alcança fora dos apps operáveis (S1 item 11, P-3), conforme o que está à frente (`Front`):
/// - **tela de início limpa**: os ícones da página onde está o ícone do app alvo (`app.iconLabel`; PF-12);
///   nunca widgets, busca ou outros controles;
/// - **Central de Controle** (sobre a tela de início ou um app operável): só os controles com identificador da
///   Central (`SpringBoardLayer.controlCenterIdentifiers` ou o prefixo `com.apple.ControlCenter.`), visíveis;
///   nunca ícones nem widgets por trás;
/// - **tela travada** (provada): só os controles de mídia, por LISTA POSITIVA — nós `button`/`slider` visíveis
///   com um rótulo de mídia reconhecido (`isMediaControlLabel`, em inglês: o aparelho grava em inglês), que não
///   são marcador de camada nem estão dentro de uma notificação, **e só em grupo**: irmãos sob o mesmo pai (que
///   não é a raiz nem uma janela) com ≥ 2 rótulos de mídia distintos (o controle de posição conta). Um "Pause"
///   solitário (Live Activity), notificação de qualquer id e widget ficam inalcançáveis;
/// - **folha do Sign in with Apple**: só botões com rótulo de `SystemApp.sheetButtonLabels` (exato); nada de
///   texto (nome e e-mail da conta Apple);
/// - qualquer outra coisa à frente: nada. Nunca a árvore inteira do SpringBoard.
///
/// Provisório até os spikes medirem a árvore real: a lista de identificadores da Central (SP-9; só o módulo de
/// conectividade, que basta para o modo avião), os rótulos e o critério de grupo da mídia na tela travada (SP-7) e
/// a lista de botões da folha (SP-8).
///
/// No SpringBoard e na folha, `ReadSession` registra só a árvore já recortada: refs e `treeVersion` não dependem
/// de nós inalcançáveis.
public enum ReadScope {
    /// Identificador do interruptor do modo avião na Central de Controle (S1 item 7).
    public static let airplaneModeIdentifier = "airplane-mode-button"
    /// Tipos de controle da tela travada (mídia).
    public static let lockScreenTypes: Set<ElementType> = [.button, .slider]

    /// Rótulos exatos (sem caixa, espaços normalizados) dos controles de mídia da tela travada.
    public static let mediaControlLabels: Set<String> = [
        "play", "pause", "previous track", "next track", "rewind", "fast forward", "track position", "airplay",
    ]
    /// Famílias "<começo> <n> seconds" (podcasts e audiolivros: "Skip Back 15 Seconds").
    public static let mediaControlSecondsPrefixes = ["skip back", "skip forward", "rewind", "fast forward"]

    /// Rótulo de controle de mídia reconhecido (lista positiva).
    public static func isMediaControlLabel(_ label: String?) -> Bool {
        guard let label else { return false }
        let words = label.lowercased().split(whereSeparator: \.isWhitespace).map(String.init)
        let normalized = words.joined(separator: " ")
        if mediaControlLabels.contains(normalized) { return true }
        guard words.count >= 3, words.last == "seconds", words[words.count - 2].allSatisfy(\.isNumber) else { return false }
        return mediaControlSecondsPrefixes.contains(words.dropLast(2).joined(separator: " "))
    }

    static func normalizedLabel(_ label: String?) -> String {
        (label ?? "").lowercased().split(whereSeparator: \.isWhitespace).joined(separator: " ")
    }

    /// O pai de cada nó (−1 na raiz), pela faixa de descendentes.
    static func parents(_ tree: IndexedTree) -> [Int] {
        var parent = Array(repeating: -1, count: tree.nodes.count)
        for i in tree.nodes.indices {
            var child = i + 1
            while child < tree.subtreeEnd[i] {
                parent[child] = i
                child = tree.subtreeEnd[child]
            }
        }
        return parent
    }

    /// O `value` de um nó que pode sair numa leitura: tudo no app operável; no SpringBoard, só o do interruptor do
    /// modo avião (AC-1.15); na folha, nunca.
    public static func exposesValue(_ node: TreeNode, app: AppScope) -> Bool {
        switch app {
        case .app: true
        case .springboard: node.identifier == airplaneModeIdentifier
        case .authkit: false
        }
    }

    /// `true` em cada nó que a leitura alcança; `nil` = a árvore toda (app operável).
    public static func reachable(_ tree: IndexedTree, app: AppScope, front: Front, iconLabel: String?,
                                 screen: Size) -> [Bool]? {
        let none = Array(repeating: false, count: tree.nodes.count)
        switch app {
        case .app:
            return nil
        case .authkit:
            guard case .authkit = front else { return none }
            return tree.nodes.map { $0.type == .button && SystemApp.sheetButtonLabels.contains($0.label ?? "") }
        case .springboard:
            switch front {
            case .homeScreen:
                var mask = none
                if let iconLabel,
                   let icon = tree.nodes.first(where: { $0.type == .icon && $0.label == iconLabel }) {
                    let page = pageIndex(icon.frame, screen: screen)
                    for (i, node) in tree.nodes.enumerated() where node.type == .icon && pageIndex(node.frame, screen: screen) == page {
                        mask[i] = true
                    }
                }
                return mask
            case .controlCenter:
                return tree.nodes.map { $0.visible && SpringBoardLayer.marked(by: $0.identifier) == .controlCenter }
            case .lockScreen:
                var insideNotification = none
                for (i, node) in tree.nodes.enumerated() where SpringBoardLayer.marked(by: node.identifier) == .notificationCenter {
                    for k in i..<tree.subtreeEnd[i] { insideNotification[k] = true }
                }
                let media = tree.nodes.indices.map { i in
                    let node = tree.nodes[i]
                    return lockScreenTypes.contains(node.type) && node.visible && isMediaControlLabel(node.label)
                        && !insideNotification[i] && SpringBoardLayer.marked(by: node.identifier) == nil
                }
                // Grupo de Now Playing: irmãos (mesmo pai, que não é a raiz nem uma janela) com ≥ 2 rótulos distintos.
                let parent = parents(tree)
                var labelsByParent: [Int: Set<String>] = [:]
                for i in tree.nodes.indices where media[i] && parent[i] > 0 && tree.nodes[parent[i]].type != .window {
                    labelsByParent[parent[i], default: []].insert(normalizedLabel(tree.nodes[i].label))
                }
                return tree.nodes.indices.map { i in
                    media[i] && parent[i] > 0 && (labelsByParent[parent[i]]?.count ?? 0) >= 2
                }
            default:
                return none
            }
        }
    }

    /// Página da tela de início pela posição horizontal (as páginas ficam lado a lado, uma largura de tela cada).
    static func pageIndex(_ frame: Rect, screen: Size) -> Int {
        Int((frame.midX / screen.w).rounded(.down))
    }
}
