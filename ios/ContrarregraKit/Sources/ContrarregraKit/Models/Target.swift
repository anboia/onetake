import Foundation

// S0.2 Alvo (`Target`) e seletor `ocr`.

/// `XCUIElement.ElementType` com o nome do caso em Swift, **na ordem do `rawValue`**: o índice em
/// `allCases` é o `rawValue` do `XCUIElement.ElementType` (o `Driver` converte por ele). Mesma lista de
/// `ELEMENT_TYPES` no Mac.
public enum ElementType: String, Sendable, CaseIterable {
    case `any`, other, application, group, window, sheet, drawer, alert, dialog, button
    case radioButton, radioGroup, checkBox, disclosureTriangle, popUpButton, comboBox, menuButton
    case toolbarButton, popover, keyboard, key, navigationBar, tabBar, tabGroup, toolbar
    case statusBar, table, tableRow, tableColumn, outline, outlineRow, browser, collectionView
    case slider, pageIndicator, progressIndicator, activityIndicator, segmentedControl, picker
    case pickerWheel, `switch`, toggle, link, image, icon, searchField, scrollView, scrollBar
    case staticText, textField, secureTextField, datePicker, textView, menu, menuItem, menuBar
    case menuBarItem, map, webView, incrementArrow, decrementArrow, timeline, ratingIndicator
    case valueIndicator, splitGroup, splitter, relevanceIndicator, colorWell, helpTag, matte
    case dockItem, ruler, rulerMarker, grid, levelIndicator, cell, layoutArea, layoutItem
    case handle, stepper, tab, touchBar, statusItem

    /// O `rawValue` do `XCUIElement.ElementType` correspondente.
    public var xcuiRawValue: UInt { UInt(Self.allCases.firstIndex(of: self)!) }
}

/// `ocr` de um alvo (e de `{text: {ocr}}` em S0.3): texto visível achado pelo Vision.
public struct OcrSelector: JSONModel {
    public var text: String
    @Boxed public var within: Target?
    public var region: Rect?
    public var occurrence: Int?

    public init(text: String, within: Target? = nil, region: Rect? = nil, occurrence: Int? = nil) {
        self.text = text
        self.within = within
        self.region = region
        self.occurrence = occurrence
    }

    public static let modelName = "seletor ocr"
    public static var invalidCode: RunnerErrorCode? { .choreoInvalid }

    public static func read(_ json: JSONValue, at path: JSONPath, _ sink: IssueSink) -> OcrSelector? {
        guard var o = ObjectReader(json, at: path, sink, allowed: ["text", "within", "region", "occurrence"]) else {
            return nil
        }
        let text = o.required("text", Read.nonEmpty)
        let within = o.optional("within", Read.model(Target.self))
        let region = o.optional("region", Read.model(Rect.self))
        let occurrence = o.optional("occurrence", Read.nonNegativeInt)
        guard o.ok, let text else { return nil }
        return OcrSelector(text: text, within: within, region: region, occurrence: occurrence)
    }

    public var json: JSONValue {
        var out: JSONObject = ["text": .string(text)]
        out.put("within", within?.json)
        out.put("region", region?.json)
        out.put("occurrence", occurrence?.json)
        return .object(out)
    }
}

/// Alvo de S0.2: exatamente um seletor primário (`ref`, `label`, `labelPrefix`, `labelContains`,
/// `identifier`, `ocr`, `point`), ou só `type`; os demais campos são modificadores.
public struct Target: JSONModel {
    public var ref: String?
    public var app: String?
    public var label: String?
    public var labelPrefix: String?
    public var labelContains: String?
    public var identifier: String?
    public var type: ElementType?
    @Boxed public var within: Target?
    @Boxed public var below: Target?
    @Boxed public var above: Target?
    public var index: Int?
    public var ocr: OcrSelector?
    public var point: Point?
    public var offset: Offset?
    public var fallback: [Target]?

    public init(
        ref: String? = nil, app: String? = nil, label: String? = nil, labelPrefix: String? = nil,
        labelContains: String? = nil, identifier: String? = nil, type: ElementType? = nil,
        within: Target? = nil, below: Target? = nil, above: Target? = nil, index: Int? = nil,
        ocr: OcrSelector? = nil, point: Point? = nil, offset: Offset? = nil, fallback: [Target]? = nil
    ) {
        self.ref = ref
        self.app = app
        self.label = label
        self.labelPrefix = labelPrefix
        self.labelContains = labelContains
        self.identifier = identifier
        self.type = type
        self.within = within
        self.below = below
        self.above = above
        self.index = index
        self.ocr = ocr
        self.point = point
        self.offset = offset
        self.fallback = fallback
    }

    public static let modelName = "alvo"
    public static var invalidCode: RunnerErrorCode? { .choreoInvalid }

    /// Seletores primários, na ordem de `PRIMARY_SELECTORS` do Mac.
    public static let primarySelectors = ["ref", "label", "labelPrefix", "labelContains", "identifier", "ocr", "point"]

    static let keys: Set<JSONKey> = [
        "ref", "app", "label", "labelPrefix", "labelContains", "identifier", "type", "within", "below", "above",
        "index", "ocr", "point", "offset", "fallback",
    ]

    public static func read(_ json: JSONValue, at path: JSONPath, _ sink: IssueSink) -> Target? {
        guard var o = ObjectReader(json, at: path, sink, allowed: keys) else { return nil }
        let target = Target(
            ref: o.optional("ref", Read.nonEmpty),
            app: o.optional("app", Read.nonEmpty),
            label: o.optional("label", Read.string),
            labelPrefix: o.optional("labelPrefix", Read.string),
            labelContains: o.optional("labelContains", Read.string),
            identifier: o.optional("identifier", Read.string),
            type: o.optional("type", Read.oneOf(ElementType.self)),
            within: o.optional("within", Read.model(Target.self)),
            below: o.optional("below", Read.model(Target.self)),
            above: o.optional("above", Read.model(Target.self)),
            index: o.optional("index", Read.nonNegativeInt),
            ocr: o.optional("ocr", Read.model(OcrSelector.self)),
            point: o.optional("point", Read.model(Point.self)),
            offset: o.optional("offset", Read.model(Offset.self)),
            fallback: o.optional("fallback", Read.array(Read.model(Target.self)))
        )
        let primaries = primarySelectors.filter { o.has($0) }
        if primaries.count > 1 {
            o.fail(nil, .onePrimarySelector,
                   "alvo com \(primaries.count) seletores primários (\(primaries.joined(separator: ", "))); use exatamente um (S0.2)")
        } else if primaries.isEmpty && !o.has("type") {
            o.fail(nil, .onePrimarySelector,
                   "alvo sem seletor primário (\(primarySelectors.joined(separator: ", "))) nem type (S0.2)")
        }
        return o.ok ? target : nil
    }

    public var json: JSONValue {
        var out: JSONObject = [:]
        out.put("ref", ref?.json)
        out.put("app", app?.json)
        out.put("label", label?.json)
        out.put("labelPrefix", labelPrefix?.json)
        out.put("labelContains", labelContains?.json)
        out.put("identifier", identifier?.json)
        out.put("type", type.map { .string($0.rawValue) })
        out.put("within", within?.json)
        out.put("below", below?.json)
        out.put("above", above?.json)
        out.put("index", index?.json)
        out.put("ocr", ocr?.json)
        out.put("point", point?.json)
        out.put("offset", offset?.json)
        out.put("fallback", fallback?.json)
        return .object(out)
    }
}

/// `from`/`to`/`via` de um `drag`: `Point` ou `Target`.
public enum PointOrTarget: JSONModel {
    case point(Point)
    case target(Target)

    public static let modelName = "ponto ou alvo"
    public static var invalidCode: RunnerErrorCode? { .choreoInvalid }

    /// Com alguma chave de ponto (`x`, `y`, `nx`, `ny`) e nenhuma de alvo, é `Point`; senão, `Target`. Um
    /// valor que não é objeto é erro de tipo (`type`), como no Mac.
    public static func read(_ json: JSONValue, at path: JSONPath, _ sink: IssueSink) -> PointOrTarget? {
        guard case .object(let fields) = json else {
            sink.add(path, .type, "esperava um Point ({x, y} ou {nx, ny}) ou um Target (S0.2), veio \(json.typeName)")
            return nil
        }
        let keys = Set(fields.keys)
        if !keys.isDisjoint(with: Point.keys) && keys.isDisjoint(with: Target.keys) {
            return Point.read(json, at: path, sink).map(PointOrTarget.point)
        }
        return Target.read(json, at: path, sink).map(PointOrTarget.target)
    }

    public var json: JSONValue {
        switch self {
        case .point(let point): point.json
        case .target(let target): target.json
        }
    }
}
