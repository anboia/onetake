// O contexto de um comando: a configuração carregada (S0.1) antes de qualquer processo filho ou conexão
// (AC-0.5) e, só nos testes, as ferramentas trocadas por falsos. CLI e MCP montam o contexto por aqui e
// não importam nada abaixo de `commands` (architecture.md A2).

import { loadConfig, type Config, type LoadConfigOptions } from '../core/config.ts';
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
