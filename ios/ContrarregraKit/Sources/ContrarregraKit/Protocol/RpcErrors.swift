import Foundation

/// Erros da aplicação no JSON-RPC do runner (S0.5, faixa -32000…-32099). Mesma tabela de
/// `RPC_ERROR_CODES` em `mac/src/core/errors.ts`.
public enum RunnerErrorCode: String, Sendable, CaseIterable {
    case auth = "E_AUTH"
    case busy = "E_BUSY"
    case forbiddenApp = "E_FORBIDDEN_APP"
    case targetNotFound = "E_TARGET_NOT_FOUND"
    case targetAmbiguous = "E_TARGET_AMBIGUOUS"
    case targetNotHittable = "E_TARGET_NOT_HITTABLE"
    case ocrNotFound = "E_OCR_NOT_FOUND"
    case timeout = "E_TIMEOUT"
    case secureField = "E_SECURE_FIELD"
    case noFocus = "E_NO_FOCUS"
    case capabilityMissing = "E_CAPABILITY_MISSING"
    case forbiddenInTake = "E_FORBIDDEN_IN_TAKE"
    case choreoInvalid = "E_CHOREO_INVALID"
    case choreoState = "E_CHOREO_STATE"
    case appState = "E_APP_STATE"
    case xctest = "E_XCTEST"

    public var code: Int {
        switch self {
        case .auth: -32001
        case .busy: -32002
        case .forbiddenApp: -32003
        case .targetNotFound: -32010
        case .targetAmbiguous: -32011
        case .targetNotHittable: -32012
        case .ocrNotFound: -32013
        case .timeout: -32020
        case .secureField: -32021
        case .noFocus: -32022
        case .capabilityMissing: -32030
        case .forbiddenInTake: -32031
        case .choreoInvalid: -32040
        case .choreoState: -32041
        case .appState: -32050
        case .xctest: -32060
        }
    }

    public init?(code: Int) {
        guard let match = Self.allCases.first(where: { $0.code == code }) else { return nil }
        self = match
    }
}

/// Códigos de erro do próprio JSON-RPC 2.0.
public enum JSONRPCErrorCode: Int, Sendable, CaseIterable {
    case parseError = -32700
    case invalidRequest = -32600
    case methodNotFound = -32601
    case invalidParams = -32602
    case internalError = -32603
}

extension RpcErrorObject {
    /// Todo código aceito: o do JSON-RPC 2.0 e os da tabela de S0.5.
    public static let knownCodes: Set<Int> = Set(JSONRPCErrorCode.allCases.map(\.rawValue))
        .union(RunnerErrorCode.allCases.map(\.code))

    public init(_ code: RunnerErrorCode, _ message: String, data: JSONValue? = nil) {
        self.init(code: code.code, message: message, data: data)
    }

    public init(_ code: JSONRPCErrorCode, _ message: String, data: JSONValue? = nil) {
        self.init(code: code.rawValue, message: message, data: data)
    }
}
