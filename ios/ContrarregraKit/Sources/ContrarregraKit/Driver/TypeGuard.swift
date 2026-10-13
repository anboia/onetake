import Foundation

// Recusas de `ui.type` (S1 item 4, E-1.5, P-3, P-7): o runner nunca digita Apple ID, senha, código do aparelho ou
// qualquer credencial. Lógica pura, testada com `swift test`; o `Driver` do runner só informa a árvore do app à
// frente e digita depois que tudo aqui passou. A tela de autenticação do sistema (folha `authkit`, SpringBoard
// com o teclado do código) é `AllowList.checkTypingFront`.
//
// Nenhuma mensagem de erro daqui repete o texto pedido (ele pode ser a credencial).

public enum TypeGuard {
    /// Tipos de elemento que recebem texto do teclado: o "campo com foco" de `E_NO_FOCUS`.
    public static let textEntryTypes: Set<ElementType> = [.textField, .searchField, .textView]

    /// Texto com cara de e-mail/Apple ID, em qualquer lugar do texto. Larga de propósito (FAIL-CLOSED): qualquer
    /// coisa sem espaço e sem `@`, um `@`, e um domínio com ao menos um ponto.
    static let emailPattern = #"[^\s@]+@[^\s@]+\.[^\s@]+"#

    /// Caracteres de controle e separadores de linha/parágrafo (o que o XCTest manda como tecla, não como letra).
    static let controlPattern = #"[\p{Cc}\p{Zl}\p{Zp}]"#

    /// Controle que edita o campo ou mexe nele além de quebrar linha e tabular: C0 (U+0000–U+001F) menos `\t` e `\n`
    /// — `\r`, backspace `\u{8}`, escape… —, DEL (U+007F) e C1 (U+0080–U+009F). Num `ui.type` é sempre recusado:
    /// apagaria, trocaria ou montaria no campo um texto que a conferência de credencial não viu.
    public static func isEditingControl(_ scalar: Unicode.Scalar) -> Bool {
        switch scalar.value {
        case 0x09, 0x0A: false
        case 0x00...0x1F, 0x7F...0x9F: true
        default: false
        }
    }

    /// As formas do texto que a conferência de credencial olha, todas depois do NFKC (o `＠` de largura total e o
    /// `﹫` pequeno viram `@`) e sem os caracteres de formatação invisíveis (`\p{Cf}`: espaço de largura zero, marcas
    /// de direção): o texto assim, sem os controles, e com cada controle trocado por espaço. Uma tecla de controle no
    /// meio (`someone\n@icloud.com`: digita "someone", Return, "@icloud.com") não esconde o e-mail.
    static func credentialVariants(_ text: String) -> [String] {
        let base = text.precomposedStringWithCompatibilityMapping
            .replacingOccurrences(of: #"\p{Cf}"#, with: "", options: .regularExpression)
        return [
            base,
            base.replacingOccurrences(of: controlPattern, with: "", options: .regularExpression),
            base.replacingOccurrences(of: controlPattern, with: " ", options: .regularExpression),
        ]
    }

    /// O texto parece credencial (S1 item 4: "contém e-mail/Apple ID, regex de e-mail") em alguma das formas de
    /// `credentialVariants`.
    public static func looksLikeCredential(_ text: String) -> Bool {
        credentialVariants(text).contains { $0.range(of: emailPattern, options: .regularExpression) != nil }
    }

    /// Conferido antes de qualquer leitura da tela, sempre `E_SECURE_FIELD` (S0.5: pedido de digitar credencial,
    /// sempre recusado):
    /// - controle que edita o campo (`isEditingControl`, no texto cru ou em NFKC) — o código de S0.5 mais próximo:
    ///   com ele, o pedido montaria no campo um texto que nenhuma conferência viu;
    /// - texto com cara de credencial (`looksLikeCredential`; AC-1.19).
    public static func checkText(_ text: String) throws(RpcErrorObject) {
        let scalars = text.unicodeScalars + text.precomposedStringWithCompatibilityMapping.unicodeScalars
        if scalars.contains(where: isEditingControl) {
            throw secureField("o texto tem caractere de controle que edita o campo (\\r, backspace, DEL, escape, C0/C1 menos "
                              + "\\n e \\t); o runner nunca o digita")
        }
        guard !looksLikeCredential(text) else {
            throw secureField("o texto parece credencial (contém um e-mail/Apple ID); o runner nunca o digita, é ponto de controle humano")
        }
    }

    /// `E_SECURE_FIELD` se o próprio alvo pede um campo seguro (`type: secureTextField` no alvo ou numa alternativa de
    /// `fallback`), antes de ler a árvore.
    public static func checkTargetSelector(_ target: Target) throws(RpcErrorObject) {
        if target.type == .secureTextField {
            throw secureField("o alvo pede um campo seguro (type: secureTextField); o runner nunca digita nele")
        }
        for alternative in target.fallback ?? [] { try checkTargetSelector(alternative) }
    }

    /// O que a árvore do app à frente diz sobre a digitação.
    public struct InputScan: Sendable, Equatable {
        /// Campos seguros (`secureTextField`) em qualquer lugar da árvore, visíveis ou não.
        public var secureFields: Int
        /// O campo de texto com foco (`hasFocus`; o mais fundo, em pré-ordem), se houver.
        public var focusedField: RawNode?
        /// Há teclado (`keyboard`) na árvore do app.
        public var keyboardShown: Bool

        public init(secureFields: Int, focusedField: RawNode?, keyboardShown: Bool) {
            self.secureFields = secureFields
            self.focusedField = focusedField
            self.keyboardShown = keyboardShown
        }
    }

    public static func scan(_ root: RawNode) -> InputScan {
        var scan = InputScan(secureFields: 0, focusedField: nil, keyboardShown: false)
        func walk(_ node: RawNode) {
            if node.type == .secureTextField { scan.secureFields += 1 }
            if node.type == .keyboard { scan.keyboardShown = true }
            if node.focused, textEntryTypes.contains(node.type) {
                var field = node
                field.children = []
                scan.focusedField = field
            }
            for child in node.children { walk(child) }
        }
        walk(root)
        return scan
    }

    /// `E_SECURE_FIELD` se o app à frente tem algum campo seguro (AC-1.7, E-1.5). FAIL-CLOSED: a consulta pública
    /// de foco (`hasFocus`) não prova onde está o foco do teclado, então não se digita nada enquanto houver um campo
    /// seguro na árvore — nem se o texto vier vazio.
    public static func checkNoSecureField(_ scan: InputScan) throws(RpcErrorObject) {
        guard scan.secureFields == 0 else {
            throw secureField("o app à frente tem \(scan.secureFields) campo(s) seguro(s) (secureTextField); o runner não digita "
                              + "enquanto houver um, porque o foco do teclado pode estar nele")
        }
    }

    /// O campo com foco, para digitar sem `target` (E_NO_FOCUS se nenhum campo de texto tem foco).
    public static func focusedField(_ scan: InputScan) throws(RpcErrorObject) -> RawNode {
        guard let field = scan.focusedField else {
            throw RpcErrorObject(.noFocus, "E_NO_FOCUS: nenhum campo de texto com foco no app à frente; use target")
        }
        return field
    }

    /// Depois do toque de foco num `target`: o foco do teclado está no app (um campo de texto com foco ou o
    /// teclado na tela), senão `E_NO_FOCUS`.
    public static func checkFocus(_ scan: InputScan) throws(RpcErrorObject) {
        guard scan.focusedField != nil || scan.keyboardShown else {
            throw RpcErrorObject(.noFocus, "E_NO_FOCUS: o toque no target não pôs foco num campo de texto (sem teclado na tela)")
        }
    }

    /// `E_SECURE_FIELD` se o alvo de `ui.type` é um campo seguro (antes de qualquer toque).
    public static func checkTargetNode(_ node: TreeNode?) throws(RpcErrorObject) {
        if let node, node.type == .secureTextField {
            throw secureField("\(node.ref) é um campo seguro (secureTextField); o runner nunca digita nele")
        }
    }

    static func secureField(_ message: String) -> RpcErrorObject {
        RpcErrorObject(.secureField, "E_SECURE_FIELD: \(message) (S1 item 4, P-3)")
    }
}
