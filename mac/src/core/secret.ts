// Segredos (spec S8 item 8, E-8.2; constituição P-3; deploy.md D0.2, D2). O único lugar que chama
// `/usr/bin/security` (architecture.md A2): lê um item do Chaveiro do macOS (serviço `contrarregra`,
// conta = o **nome** do segredo) em memória, na hora do uso, e o devolve num `Secret`, que se imprime
// como `[redacted]` em `String`, JSON, `util.inspect`, `console.*` e mensagens de erro. O nome vai no
// argv; o valor só chega pela saída padrão do `security` e nunca vai para argv, log, erro ou arquivo.
// Item ausente → `E_SECRET_MISSING` com o comando que o próprio dono roda (D0.2); a ferramenta nunca
// pede a senha.

import { execFile } from 'node:child_process';
import { inspect } from 'node:util';

import { ContrarregraError } from './errors.ts';

export const SECURITY_PATH = '/usr/bin/security';
/** Serviço dos itens da ferramenta no Chaveiro (D2). */
export const KEYCHAIN_SERVICE = 'contrarregra';
/** Prazo da leitura (S8 item 8). */
export const SECRET_TIMEOUT_MS = 5_000;
export const REDACTED = '[redacted]';
/** Saída do `security` quando o item não existe (errSecItemNotFound; E-8.2). */
export const SECURITY_ITEM_NOT_FOUND = 44;

/** Rótulos do D0.2 por nome; os demais itens são criados sem rótulo. */
const LABELS: Readonly<Record<string, string>> = { OBS_WEBSOCKET_PASSWORD: 'Contrarregra OBS WebSocket' };
const SECRET_NAME = /^[A-Z][A-Z0-9_]*$/;
const SERVICE_NAME = /^[a-z0-9][a-z0-9._-]*$/;

/** Valor secreto em memória. Só `reveal()` o devolve; qualquer outra forma de imprimir dá `[redacted]`. */
export class Secret {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  /** O valor em claro, para quem vai usá-lo na hora (ex.: o hash da autenticação do OBS). */
  reveal(): string {
    return this.#value;
  }

  toString(): string {
    return REDACTED;
  }

  toJSON(): string {
    return REDACTED;
  }

  [Symbol.toPrimitive](): string {
    return REDACTED;
  }

  [inspect.custom](): string {
    return REDACTED;
  }
}

/** Resultado de uma chamada ao `security`; `exitCode` é `null` quando o processo não saiu sozinho. */
export interface SecurityResult {
  exitCode: number | null;
  stdout: string;
  timedOut: boolean;
}

/** Executor do `security` (injetável nos testes, que nunca leem o Chaveiro real). */
export type SecurityRunner = (file: string, args: readonly string[], options: { timeoutMs: number }) => Promise<SecurityResult>;

export interface ReadSecretOptions {
  run?: SecurityRunner;
  /** Padrão: `contrarregra` (D2). */
  service?: string;
  /** Padrão: 5 s (S8 item 8). */
  timeoutMs?: number;
}

/** O comando do D0.2 que o dono roda para criar o item (o `-w` no fim pede a senha sem ela ir ao histórico). */
export function addSecretCommand(name: string, service: string = KEYCHAIN_SERVICE): string {
  const label = LABELS[name];
  return `security add-generic-password -s ${service} -a ${name}${label === undefined ? '' : ` -l '${label}'`} -U -w`;
}

const runSecurity: SecurityRunner = (file, args, { timeoutMs }) =>
  new Promise((resolve) => {
    execFile(file, args, { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      if (error === null) {
        resolve({ exitCode: 0, stdout, timedOut: false });
        return;
      }
      // Sem `cause` nem `stdout` no erro: a saída pode conter o segredo.
      const exitCode = typeof error.code === 'number' ? error.code : null;
      resolve({ exitCode, stdout: '', timedOut: error.killed === true && exitCode === null });
    });
  });

/**
 * Lê o item `name` do Chaveiro com `security find-generic-password -s <serviço> -a <name> -w`. Erros
 * (`E_SECRET_MISSING`, ou `E_CONFIG` para nome inválido) nunca levam a saída do `security`.
 */
export async function readSecret(name: string, options: ReadSecretOptions = {}): Promise<Secret> {
  const service = options.service ?? KEYCHAIN_SERVICE;
  if (!SECRET_NAME.test(name)) {
    throw new ContrarregraError('E_CONFIG', `nome de segredo inválido ${JSON.stringify(name)}: use MAIÚSCULAS, dígitos e _`, { name });
  }
  if (!SERVICE_NAME.test(service)) {
    throw new ContrarregraError('E_CONFIG', `serviço do Chaveiro inválido ${JSON.stringify(service)}`, { service });
  }
  const timeoutMs = options.timeoutMs ?? SECRET_TIMEOUT_MS;
  const command = addSecretCommand(name, service);
  const run = options.run ?? runSecurity;
  const result = await run(SECURITY_PATH, ['find-generic-password', '-s', service, '-a', name, '-w'], { timeoutMs });

  const missing = (reason: string, why: string): ContrarregraError =>
    new ContrarregraError(
      'E_SECRET_MISSING',
      `${why}. Crie ou atualize o item você mesmo no Terminal (o comando pede a senha sem ela ir ao histórico): ${command}`,
      { name, service, reason, command },
    );

  if (result.timedOut) throw missing('timeout', `o Chaveiro não respondeu em ${timeoutMs} ms ao ler ${name} (serviço ${service})`);
  if (result.exitCode === SECURITY_ITEM_NOT_FOUND) throw missing('not-found', `o item ${name} não está no Chaveiro (serviço ${service})`);
  if (result.exitCode !== 0) {
    throw missing('security-failed', `o \`security\` saiu com ${result.exitCode ?? 'sinal'} ao ler ${name} (serviço ${service})`);
  }
  const value = result.stdout.endsWith('\n') ? result.stdout.slice(0, -1) : result.stdout;
  if (value === '') throw missing('empty', `o item ${name} do Chaveiro (serviço ${service}) está vazio`);
  return new Secret(value);
}
