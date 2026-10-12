// O contexto de um comando: a configuração carregada (S0.1) antes de qualquer processo filho ou conexão
// (AC-0.5) e, só nos testes, as ferramentas trocadas por falsos. CLI e MCP montam o contexto por aqui e
// não importam nada abaixo de `commands` (architecture.md A2).

import { z } from 'zod';

import { loadConfig, type Config, type LoadConfigOptions } from '../core/config.ts';
import { isContrarregraError } from '../core/errors.ts';
import { parseOrThrow } from '../core/schema.ts';
import { RpcProtocolError } from '../runner/rpc.ts';
import type { RunnerTools } from '../runner/xcodebuild.ts';

export { ContrarregraError, isContrarregraError } from '../core/errors.ts';
export type { LoadConfigOptions } from '../core/config.ts';

export interface CommandContext {
  config: Config;
  /** Caminhos das ferramentas (`xcodebuild`, `xcodegen`, `caffeinate`, `xcrun`); padrão: os do sistema. */
  tools?: Partial<RunnerTools>;
  /** Linhas de andamento para o dono. */
  onProgress?: (line: string) => void;
}

export interface ContextOptions {
  config?: LoadConfigOptions;
  tools?: Partial<RunnerTools>;
  onProgress?: (line: string) => void;
}

/** Carrega a configuração (`E_CONFIG` sai daqui, antes de qualquer efeito). */
export function loadContext(options: ContextOptions = {}): CommandContext {
  const context: CommandContext = { config: loadConfig(options.config) };
  if (options.tools !== undefined) context.tools = options.tools;
  if (options.onProgress !== undefined) context.onProgress = options.onProgress;
  return context;
}

/** O erro como CLI (`--json`) e MCP o devolvem: código de S0.5 (ou `null` fora da tabela), mensagem e `data`. */
export interface ErrorObject {
  code: string | null;
  message: string;
  data: Record<string, unknown>;
}

/** `{error: {code, message, data}}`. O `data` é o do erro (nunca leva segredo: ninguém põe o token nele). */
export function errorObject(error: unknown): { error: ErrorObject } {
  if (isContrarregraError(error)) return { error: { code: error.code, message: error.message, data: { ...(error.data ?? {}) } } };
  if (error instanceof RpcProtocolError) {
    return { error: { code: null, message: error.message, data: { method: error.method, jsonRpcCode: error.code } } };
  }
  return { error: { code: null, message: error instanceof Error ? error.message : String(error), data: {} } };
}

/**
 * Argumentos de um comando conferidos contra a forma dele (campo desconhecido, tipo, regra do seletor
 * primário de S0.2): fora dela → `E_CHOREO_INVALID` com `data.errors` (`{path, rule, message}`), antes de
 * qualquer efeito. CLI e MCP passam por aqui, e o erro sai como `{error: {code, message, data}}`.
 */
export function parseArgs<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  return parseOrThrow(schema, value, 'E_CHOREO_INVALID', `argumentos de ${what}`);
}

/** Comando sem argumentos (`doctor`, `device_status`, `screenshot`): qualquer campo é desconhecido. */
export const NoArgsSchema = z.strictObject({});
