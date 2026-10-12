import Foundation

/// Nó da árvore de acessibilidade (S0.6), em pontos. `ref` tem a forma `@e<n>` e vale até a próxima
/// mudança de tela.
public struct TreeNode: JSONModel {
    public var ref: String
    public var type: ElementType
    public var label: String?
    public var identifier: String?
    public var value: String?
    public var frame: Rect
    public var enabled: Bool
    public var selected: Bool
    public var visible: Bool
    public var depth: Int
    public var children: [TreeNode]?

    public init(
        ref: String, type: ElementType, label: String? = nil, identifier: String? = nil, value: String? = nil,
        frame: Rect, enabled: Bool = true, selected: Bool = false, visible: Bool = true, depth: Int,
        children: [TreeNode]? = nil
    ) {
        self.ref = ref
        self.type = type
        self.label = label
        self.identifier = identifier
        self.value = value
        self.frame = frame
        self.enabled = enabled
        self.selected = selected
        self.visible = visible
        self.depth = depth
        self.children = children
    }

    public static let modelName = "nó da árvore"

    static let keys: Set<JSONKey> = [
        "ref", "type", "label", "identifier", "value", "frame", "enabled", "selected", "visible", "depth", "children",
    ]

    public static func read(_ json: JSONValue, at path: JSONPath, _ sink: IssueSink) -> TreeNode? {
        guard var o = ObjectReader(json, at: path, sink, allowed: keys) else { return nil }
        let ref = o.required("ref", Read.nodeRef)
        let type = o.required("type", Read.oneOf(ElementType.self))
        let label = o.optional("label", Read.string)
        let identifier = o.optional("identifier", Read.string)
        let value = o.optional("value", Read.string)
        let frame = o.required("frame", Read.model(Rect.self))
        let enabled = o.required("enabled", Read.bool)
        let selected = o.required("selected", Read.bool)
        let visible = o.required("visible", Read.bool)
        let depth = o.required("depth", Read.nonNegativeInt)
        let children = o.optional("children", Read.array(Read.model(TreeNode.self)))
        guard o.ok, let ref, let type, let frame, let enabled, let selected, let visible, let depth else { return nil }
        return TreeNode(ref: ref, type: type, label: label, identifier: identifier, value: value, frame: frame,
                        enabled: enabled, selected: selected, visible: visible, depth: depth, children: children)
    }

    public var json: JSONValue {
        var out: JSONObject = [
            "ref": .string(ref), "type": .string(type.rawValue), "frame": frame.json, "enabled": .bool(enabled),
            "selected": .bool(selected), "visible": .bool(visible), "depth": depth.json,
        ]
        out.put("label", label?.json)
        out.put("identifier", identifier?.json)
        out.put("value", value?.json)
        out.put("children", children?.json)
        return .object(out)
    }
}
