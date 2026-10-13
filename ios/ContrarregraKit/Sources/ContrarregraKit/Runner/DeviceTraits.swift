import Foundation

/// Conversões puras dos traços do aparelho para os campos de S0.5 `device` (e `device.state`, S1 item 10).
/// Quem lê os valores do UIKit é o runner; aqui só se dá nome a eles, para poder testar com `swift test`.
public enum DeviceTraits {
    /// `UIContentSizeCategory.rawValue` → nome curto (o `textSize` de S0.4/S0.5; o padrão do iOS é `large`).
    /// Valor desconhecido volta como veio.
    public static func textSize(contentSizeCategory raw: String) -> String {
        let names: [String: String] = [
            "UICTContentSizeCategoryXS": "extraSmall",
            "UICTContentSizeCategoryS": "small",
            "UICTContentSizeCategoryM": "medium",
            "UICTContentSizeCategoryL": "large",
            "UICTContentSizeCategoryXL": "extraLarge",
            "UICTContentSizeCategoryXXL": "extraExtraLarge",
            "UICTContentSizeCategoryXXXL": "extraExtraExtraLarge",
            "UICTContentSizeCategoryAccessibilityM": "accessibilityMedium",
            "UICTContentSizeCategoryAccessibilityL": "accessibilityLarge",
            "UICTContentSizeCategoryAccessibilityXL": "accessibilityExtraLarge",
            "UICTContentSizeCategoryAccessibilityXXL": "accessibilityExtraExtraLarge",
            "UICTContentSizeCategoryAccessibilityXXXL": "accessibilityExtraExtraExtraLarge",
            "_UICTContentSizeCategoryUnspecified": "unspecified",
        ]
        return names[raw] ?? raw
    }

    /// Código de idioma de `Locale.preferredLanguages.first` (`en-US` → `en`, `pt-BR` → `pt`).
    public static func languageCode(preferred identifier: String?) -> String {
        guard let identifier, !identifier.isEmpty else { return "und" }
        if let code = Locale(identifier: identifier).language.languageCode?.identifier, !code.isEmpty {
            return code
        }
        return String(identifier.prefix { $0 != "-" && $0 != "_" })
    }

    /// Idioma lido agora para `device.state` (`Locale.preferredLanguages.first`); sem leitura → `nil` (vale o da subida).
    public static func liveLanguage(preferred identifier: String?) -> String? {
        guard let identifier, !identifier.isEmpty else { return nil }
        return languageCode(preferred: identifier)
    }

    /// Tamanho de texto lido agora para `device.state` (`UIApplication.preferredContentSizeCategory`); vazio ou não
    /// especificado → `nil` (vale o da subida).
    public static func liveTextSize(contentSizeCategory raw: String) -> String? {
        let name = textSize(contentSizeCategory: raw)
        return name.isEmpty || name == "unspecified" ? nil : name
    }

    /// `XCUIDeviceAppearance` (1 = claro, 2 = escuro) → aparência; não especificada (0) ou desconhecida → `nil` (vale
    /// a da subida). Nada é inventado.
    public static func appearance(xcuiRawValue raw: Int) -> Appearance? {
        switch raw {
        case 1: .light
        case 2: .dark
        default: nil
        }
    }

    /// `26.3` + `23D127` → `26.3 (23D127)` (a forma de `toolchain.validated`, S0.1).
    public static func osDescription(version: String, build: String?) -> String {
        guard let build, !build.isEmpty else { return version }
        return "\(version) (\(build))"
    }
}

/// Idioma, tamanho de texto e aparência lidos no momento de um `device.state` (S1 item 10; revisão da T-0.8, achado 4):
/// `nil` = não se conseguiu ler agora, e vale a leitura da subida (a de `session.hello`).
public struct LiveTraits: Sendable, Equatable {
    public var language: String?
    public var textSize: String?
    public var appearance: Appearance?

    public init(language: String? = nil, textSize: String? = nil, appearance: Appearance? = nil) {
        self.language = language
        self.textSize = textSize
        self.appearance = appearance
    }
}

extension DeviceInfo {
    /// A leitura da subida com o que se leu agora por cima.
    public func updated(with live: LiveTraits) -> DeviceInfo {
        var out = self
        if let language = live.language { out.language = language }
        if let textSize = live.textSize { out.textSize = textSize }
        if let appearance = live.appearance { out.appearance = appearance }
        return out
    }
}
