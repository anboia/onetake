// Erros da ferramenta (spec S0.5). `core` não importa nenhum outro módulo (architecture.md A2).

/** Erros do lado do Mac: não vêm do runner. */
export const MAC_ERROR_CODES = [
  'E_CONFIG',
  'E_CHOREO_INVALID',
  'E_NO_USB',
  'E_NOT_WIRED',
  'E_RUNNER_DOWN',
  'E_TOOLCHAIN_MISMATCH',
  'E_OBS_UNREACHABLE',
  'E_OBS_AUTH',
  'E_OBS_CONFIG',
  'E_OBS_SOURCE',
  'E_DISK_LOW',
  'E_SECRET_MISSING',
  'E_SYNC_QUALITY',
  'E_PREFLIGHT',
] as const;

/** Erros da aplicação no JSON-RPC do runner (faixa -32000…-32099): nome → código. */
export const RPC_ERROR_CODES = {
  E_AUTH: -32001,
  E_BUSY: -32002,
  E_FORBIDDEN_APP: -32003,
  E_TARGET_NOT_FOUND: -32010,
  E_TARGET_AMBIGUOUS: -32011,
  E_TARGET_NOT_HITTABLE: -32012,
  E_OCR_NOT_FOUND: -32013,
  E_TIMEOUT: -32020,
  E_SECURE_FIELD: -32021,
  E_NO_FOCUS: -32022,
  E_CAPABILITY_MISSING: -32030,
  E_FORBIDDEN_IN_TAKE: -32031,
  E_CHOREO_INVALID: -32040,
  E_CHOREO_STATE: -32041,
  E_APP_STATE: -32050,
  E_XCTEST: -32060,
} as const;

export type MacErrorCode = (typeof MAC_ERROR_CODES)[number];
export type RpcErrorCode = keyof typeof RPC_ERROR_CODES;
export type ErrorCode = MacErrorCode | RpcErrorCode;

/** Erro com código da spec; `data` leva detalhes estruturados (nunca segredos). */
export class ContrarregraError extends Error {
  override readonly name = 'ContrarregraError';
  readonly code: ErrorCode;
  readonly data: Readonly<Record<string, unknown>> | undefined;

  constructor(code: ErrorCode, message: string, data?: Record<string, unknown>, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
    this.data = data;
  }
}

export function isContrarregraError(error: unknown, code?: ErrorCode): error is ContrarregraError {
  return error instanceof ContrarregraError && (code === undefined || error.code === code);
}
