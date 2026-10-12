import Foundation

/// Variáveis de ambiente do runner (S1 "API / Interface"; vêm do `.xctestrun` da sessão, S2 item 1).
///
/// Lidas aqui: `CONTRARREGRA_PORT`, `CONTRARREGRA_TOKEN`, `CONTRARREGRA_SESSION`, `CONTRARREGRA_PRIVATE` e,
/// só no build `Spike`, `CONTRARREGRA_BIND`. `CONTRARREGRA_ALLOWED` e `CONTRARREGRA_EXPLORE` são da lista
/// permitida (S1 item 11) e entram com ela.
///
/// O token nunca aparece em `description` nem em mensagem de erro (P-3, AC-2.9).
public struct RunnerEnvironment: Sendable, Equatable, CustomStringConvertible {
    /// Como o `NWListener` se prende ao loopback (SP-4): `loopback` = `requiredInterfaceType = .loopback`;
    /// `endpoint` = `requiredLocalEndpoint 127.0.0.1:<porta>`. As duas formas prendem em 127.0.0.1.
    public enum BindMode: String, Sendable, CaseIterable {
        case loopback, endpoint
    }

    public enum Failure: Error, Sendable, Equatable, CustomStringConvertible {
        case missingToken
        case badPort(String)
        case badBind(String)

        public var description: String {
            switch self {
            case .missingToken:
                "CONTRARREGRA_TOKEN ausente ou vazio: o runner não abre o servidor sem token de sessão (P-3)"
            case .badPort(let raw):
                "CONTRARREGRA_PORT inválida (\"\(raw)\"): esperava um inteiro de 1 a 65535"
            case .badBind(let raw):
                "CONTRARREGRA_BIND inválida (\"\(raw)\"): esperava loopback ou endpoint"
            }
        }
    }

    /// `runner.port` padrão (S0.1).
    public static let defaultPort: UInt16 = 8700

    public var port: UInt16
    public var token: String
    public var session: String?
    /// PX-n liberados pelo dono (`runner.privateAllowed` → `CONTRARREGRA_PRIVATE`).
    public var privateAllowed: Set<PrivateApiId>
    /// Itens de `CONTRARREGRA_PRIVATE` que não são PX-1…PX-6 (ignorados; o runner os registra).
    public var unknownPrivate: [String]
    public var bind: BindMode
    /// `CONTRARREGRA_BIND` veio, mas o build não é `Spike`: ignorada (o runner registra).
    public var bindIgnored: Bool

    public init(port: UInt16 = RunnerEnvironment.defaultPort, token: String, session: String? = nil,
                privateAllowed: Set<PrivateApiId> = [], unknownPrivate: [String] = [], bind: BindMode = .loopback,
                bindIgnored: Bool = false) {
        self.port = port
        self.token = token
        self.session = session
        self.privateAllowed = privateAllowed
        self.unknownPrivate = unknownPrivate
        self.bind = bind
        self.bindIgnored = bindIgnored
    }

    /// Lê o ambiente do processo. `allowBindOverride` = build `Spike` (só nele `CONTRARREGRA_BIND` vale).
    ///
    /// - `CONTRARREGRA_TOKEN`: obrigatório, não vazio, comparado byte a byte.
    /// - `CONTRARREGRA_PORT`: inteiro 1…65535; ausente = 8700 (S0.1).
    /// - `CONTRARREGRA_PRIVATE`: ids PX-n separados por vírgula e/ou espaço (ex.: `PX-1,PX-2,PX-3,PX-5`);
    ///   ausente ou vazio = nenhum (só caminhos públicos).
    /// - `CONTRARREGRA_BIND`: `loopback` (padrão) ou `endpoint`.
    public static func read(_ environment: [String: String], allowBindOverride: Bool) throws(Failure) -> RunnerEnvironment {
        guard let token = environment["CONTRARREGRA_TOKEN"], !token.isEmpty else { throw .missingToken }

        var port = defaultPort
        if let raw = environment["CONTRARREGRA_PORT"] {
            let digits = raw.trimmingCharacters(in: .whitespaces)
            guard !digits.isEmpty, digits.utf8.allSatisfy(Formats.isDigit), let value = Int(digits),
                  (1...65_535).contains(value)
            else { throw .badPort(raw) }
            port = UInt16(value)
        }

        let session = environment["CONTRARREGRA_SESSION"].flatMap { $0.isEmpty ? nil : $0 }

        var allowed: Set<PrivateApiId> = []
        var unknown: [String] = []
        for item in (environment["CONTRARREGRA_PRIVATE"] ?? "").split(whereSeparator: { $0 == "," || $0.isWhitespace }) {
            if let id = PrivateApiId(rawValue: String(item)) {
                allowed.insert(id)
            } else {
                unknown.append(String(item))
            }
        }

        var bind = BindMode.loopback
        var bindIgnored = false
        if let raw = environment["CONTRARREGRA_BIND"] {
            if allowBindOverride {
                guard let mode = BindMode(rawValue: raw.trimmingCharacters(in: .whitespaces)) else { throw .badBind(raw) }
                bind = mode
            } else {
                bindIgnored = true
            }
        }

        return RunnerEnvironment(port: port, token: token, session: session, privateAllowed: allowed,
                                 unknownPrivate: unknown, bind: bind, bindIgnored: bindIgnored)
    }

    /// Resumo para registro, sem o token.
    public var description: String {
        let ids = privateAllowed.map(\.rawValue).sorted().joined(separator: ",")
        return "port=\(port) bind=\(bind.rawValue) session=\(session ?? "-") private=[\(ids)] token=<\(token.utf8.count) bytes>"
    }
}
