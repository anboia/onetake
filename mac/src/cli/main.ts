// CLI `contrarregra` (S8 item 1; chamada pelo shim `bin/contrarregra`). Só adapta argumentos e saída
// (architecture.md A2): a lógica está em `mac/src/commands`. Por ora só `runner build|up|down|status|
// sever` (T-0.10); os demais subcomandos de S8 entram com as tarefas deles. Ordem fixa: argumentos →
// configuração (`E_CONFIG` antes de qualquer processo filho ou conexão, AC-0.5) → comando. Todo
// subcomando aceita `--json` (o mesmo objeto que a ferramenta MCP devolve). Saída: 0 ok, 1 erro, 2 uso.

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { isContrarregraError, loadContext, type ContextOptions } from '../commands/context.ts';
import {
  RUNNER_BIND_MODES,
  RUNNER_CONFIGURATIONS,
  runnerBuild,
  runnerDown,
  runnerStatus,
  runnerSever,
  runnerUp,
  type BindMode,
  type BuildResult,
  type DownResult,
  type RunnerStatus,
  type SeverResult,
  type UpResult,
} from '../commands/runner.ts';

export const USAGE = `uso:
  contrarregra runner build [--configuration Spike] [--json]
  contrarregra runner up [--spike [--bind loopback|endpoint]] [--json]
  contrarregra runner down [--json]
  contrarregra runner status [--json]
  contrarregra runner sever --for <segundos> [--json]`;

export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

/** Só para testes: onde está a configuração e quais ferramentas usar. */
export interface CliDeps extends Omit<ContextOptions, 'onProgress'> {
  io?: CliIo;
}

class UsageError extends Error {}

const OPTIONS = {
  json: { type: 'boolean' },
  configuration: { type: 'string' },
  spike: { type: 'boolean' },
  bind: { type: 'string' },
  for: { type: 'string' },
  help: { type: 'boolean', short: 'h' },
} as const;

/** Quais opções cada subcomando aceita (além de `--json`). */
const ALLOWED: Record<string, readonly string[]> = {
  build: ['configuration'],
  up: ['spike', 'bind'],
  down: [],
  status: [],
  sever: ['for'],
};

type Values = { json?: boolean; configuration?: string; spike?: boolean; bind?: string; for?: string; help?: boolean };

interface Parsed {
  sub: string;
  values: Values;
}

function parse(argv: string[]): Parsed | 'help' {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
  const values = parsed.values as Values;
  if (values.help) return 'help';
  const [group, sub, ...rest] = parsed.positionals;
  if (group !== 'runner' || sub === undefined || !(sub in ALLOWED)) {
    throw new UsageError(group === undefined ? 'falta o subcomando' : `subcomando desconhecido: ${parsed.positionals.join(' ')}`);
  }
  if (rest.length > 0) throw new UsageError(`argumento a mais: ${rest.join(' ')}`);
  for (const key of Object.keys(values)) {
    if (key === 'json' || key === 'help') continue;
    if (!ALLOWED[sub]!.includes(key)) throw new UsageError(`--${key} não vale para runner ${sub}`);
  }
  if (values.configuration !== undefined && !(RUNNER_CONFIGURATIONS as readonly string[]).includes(values.configuration)) {
    throw new UsageError(`--configuration ${values.configuration}: use ${RUNNER_CONFIGURATIONS.join(' ou ')}`);
  }
  if (values.bind !== undefined) {
    if (!values.spike) throw new UsageError('--bind só vale com --spike');
    if (!(RUNNER_BIND_MODES as readonly string[]).includes(values.bind)) throw new UsageError(`--bind ${values.bind}: use ${RUNNER_BIND_MODES.join(' ou ')}`);
  }
  if (sub === 'sever') {
    const forS = values.for === undefined ? NaN : Number(values.for);
    if (!Number.isFinite(forS) || forS <= 0) throw new UsageError('runner sever precisa de --for <segundos> (> 0)');
  }
  return { sub, values };
}

function human(sub: string, result: unknown): string {
  switch (sub) {
    case 'build': {
      const r = result as BuildResult;
      return `runner build: ${r.configuration} pronto em ${(r.durationMs / 1000).toFixed(1)} s — ${r.xctestrun}\nregistro: ${r.log}`;
    }
    case 'up': {
      const r = result as UpResult;
      return `runner up: sessão ${r.sessionId} (${r.configuration}) de pé em ${(r.readyMs / 1000).toFixed(1)} s — xcodebuild ${r.pid}, runner ${r.runnerVersion}\nregistro: ${r.log}`;
    }
    case 'down': {
      const r = result as DownResult;
      const stopped = r.stopped.map((s) => `${s.sessionId} (${s.how})`).join(', ') || 'nenhuma sessão de pé';
      return `runner down: ${stopped}; ${r.deleted.length} arquivo(s) de sessão apagado(s)`;
    }
    case 'status': {
      const r = result as RunnerStatus;
      const lines = [
        `state: ${r.state}`,
        `pid: ${r.pid ?? '-'}`,
        `sessionId: ${r.sessionId ?? '-'}`,
        `transport: usb ${r.transport.usb ? 'sim' : 'não'}, wired ${r.transport.wired === null ? '?' : r.transport.wired ? 'sim' : 'não'}, tunnelState ${r.transport.tunnelState ?? '?'}`,
        `rttMs: ${r.rttMs === null ? '-' : `p50 ${r.rttMs.p50}, p95 ${r.rttMs.p95}`}`,
        `uptimeS: ${r.uptimeS ?? '-'}`,
      ];
      if (r.controlHeldBy !== undefined) lines.push(`controlHeldBy: ${r.controlHeldBy}`);
      return lines.join('\n');
    }
    default: {
      const r = result as SeverResult;
      return r.owner === 'supervisor'
        ? `runner sever: pedido de corte por ${r.forS} s enviado ao supervisor ${r.pid} (tomada ${r.takeId})`
        : `runner sever: fora de tomada; ${r.links ?? 0} conexão(ões) deste processo cortada(s) por ${r.forS} s`;
    }
  }
}

/** Roda a CLI com `argv` (sem `node` e o script) e devolve o código de saída. */
export async function main(argv: string[], deps: CliDeps = {}): Promise<number> {
  const io: CliIo = deps.io ?? { stdout: (text) => process.stdout.write(text), stderr: (text) => process.stderr.write(text) };
  let parsed: Parsed | 'help';
  try {
    parsed = parse(argv);
  } catch (error) {
    io.stderr(`contrarregra: ${(error as Error).message}\n${USAGE}\n`);
    return 2;
  }
  if (parsed === 'help') {
    io.stdout(`${USAGE}\n`);
    return 0;
  }
  const { sub, values } = parsed;
  const json = values.json === true;
  try {
    const ctx = loadContext({ ...deps, onProgress: (line) => io.stderr(`${line}\n`) });
    let result: unknown;
    switch (sub) {
      case 'build':
        result = await runnerBuild(ctx, values.configuration === undefined ? {} : { configuration: values.configuration });
        break;
      case 'up':
        result = await runnerUp(ctx, { spike: values.spike === true, ...(values.bind === undefined ? {} : { bind: values.bind as BindMode }) });
        break;
      case 'down':
        result = await runnerDown(ctx);
        break;
      case 'status':
        result = await runnerStatus(ctx);
        break;
      default:
        result = runnerSever(ctx, { forS: Number(values.for) });
    }
    io.stdout(json ? `${JSON.stringify(result)}\n` : `${human(sub, result)}\n`);
    return 0;
  } catch (error) {
    if (isContrarregraError(error)) {
      const hint = error.data?.['hint'];
      io.stderr(`contrarregra: ${error.code}: ${error.message}\n${typeof hint === 'string' ? `dica: ${hint}\n` : ''}`);
      if (json) io.stdout(`${JSON.stringify({ error: { code: error.code, message: error.message, data: error.data ?? {} } })}\n`);
      return 1;
    }
    io.stderr(`contrarregra: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    return 1;
  }
}

function invokedDirectly(): boolean {
  const script = process.argv[1];
  if (script === undefined) return false;
  try {
    return realpathSync(script) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  process.exitCode = await main(process.argv.slice(2));
}
