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

    /// `26.3` + `23D127` → `26.3 (23D127)` (a forma de `toolchain.validated`, S0.1).
    public static func osDescription(version: String, build: String?) -> String {
        guard let build, !build.isEmpty else { return version }
        return "\(version) (\(build))"
    }
}
