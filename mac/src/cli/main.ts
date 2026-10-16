// CLI `contrarregra` (S8 item 1; chamada pelo shim `bin/contrarregra`). Só adapta argumentos e saída
// (architecture.md A2): a lógica está em `mac/src/commands`. Por ora `runner build|up|down|status|sever`
// (T-0.10), `obs setup` (T-0.13) e `take validate|run|control` (trilha do demo, M3); os demais
// subcomandos de S8 entram com as tarefas deles. Ordem fixa:
// argumentos → configuração (`E_CONFIG` antes de qualquer processo filho ou conexão, AC-0.5) → comando.
// Todo subcomando aceita `--json` (o mesmo objeto que a ferramenta MCP devolve). Saída: 0 ok, 1 erro, 2
// uso.

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { isContrarregraError, loadContext, type ContextOptions } from '../commands/context.ts';
import { obsLaunchCommand, obsSetup, restartHint, type ObsCommandDeps, type ObsSetupChange, type ObsSetupResult } from '../commands/obs.ts';
import {
  CONTROL_OPS,
  takeControl,
  takeRun,
  takeValidate,
  type TakeControlResult,
  type TakeRunDeps,
  type TakeRunOptions,
  type TakeSummary,
  type TakeValidation,
} from '../commands/take.ts';
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
  contrarregra runner sever --for <segundos> [--json]
  contrarregra obs setup [--json]
  contrarregra take validate <choreo.yaml> [--json]
  contrarregra take run <choreo.yaml> [--dry] [--scenes s02,s05] [--from <stepId|sceneId>] [--until <stepId>]
                        [--voice <voice.json>] [--no-prepare] [--no-cleanup] [--json]
  contrarregra take control <takeDir> resume|retry|skip|abort [--json]`;

export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

/** Só para testes: onde está a configuração e quais ferramentas usar. */
export interface CliDeps extends Omit<ContextOptions, 'onProgress'> {
  io?: CliIo;
  /** OBS falso: sem processo real, sem Chaveiro real. */
  obs?: ObsCommandDeps;
  /** Tomada com runner, OBS, relógio e aviso falados falsos. */
  take?: TakeRunDeps;
}

class UsageError extends Error {}

const OPTIONS = {
  json: { type: 'boolean' },
  configuration: { type: 'string' },
  spike: { type: 'boolean' },
  bind: { type: 'string' },
  for: { type: 'string' },
  dry: { type: 'boolean' },
  scenes: { type: 'string' },
  from: { type: 'string' },
  until: { type: 'string' },
  voice: { type: 'string' },
  'no-prepare': { type: 'boolean' },
  'no-cleanup': { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
} as const;

/** Quais opções cada subcomando de cada grupo aceita (além de `--json`). */
const ALLOWED: Record<string, Record<string, readonly string[]>> = {
  runner: {
    build: ['configuration'],
    up: ['spike', 'bind'],
    down: [],
    status: [],
    sever: ['for'],
  },
  obs: {
    setup: [],
  },
  take: {
    validate: [],
    run: ['dry', 'scenes', 'from', 'until', 'voice', 'no-prepare', 'no-cleanup'],
    control: [],
  },
};

/** Argumentos posicionais de cada subcomando (os demais não têm nenhum). */
const POSITIONALS: Record<string, Record<string, readonly string[]>> = {
  take: {
    validate: ['<choreo.yaml>'],
    run: ['<choreo.yaml>'],
    control: ['<takeDir>', CONTROL_OPS.join('|')],
  },
};

type Values = {
  json?: boolean;
  configuration?: string;
  spike?: boolean;
  bind?: string;
  for?: string;
  dry?: boolean;
  scenes?: string;
  from?: string;
  until?: string;
  voice?: string;
  'no-prepare'?: boolean;
  'no-cleanup'?: boolean;
  help?: boolean;
};

interface Parsed {
  group: string;
  sub: string;
  values: Values;
  args: string[];
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
  // Só chaves próprias: `constructor`, `toString`, `__proto__`… vêm de Object.prototype e não são comandos.
  const subs = group !== undefined && Object.hasOwn(ALLOWED, group) ? ALLOWED[group] : undefined;
  if (group === undefined || subs === undefined || sub === undefined || !Object.hasOwn(subs, sub)) {
    throw new UsageError(group === undefined ? 'falta o subcomando' : `subcomando desconhecido: ${parsed.positionals.join(' ')}`);
  }
  const expected = POSITIONALS[group]?.[sub] ?? [];
  if (rest.length > expected.length) throw new UsageError(`argumento a mais: ${rest.slice(expected.length).join(' ')}`);
  if (rest.length < expected.length) throw new UsageError(`${group} ${sub} precisa de ${expected.join(' ')}`);
  for (const key of Object.keys(values)) {
    if (key === 'json' || key === 'help') continue;
    if (!subs[sub]!.includes(key)) throw new UsageError(`--${key} não vale para ${group} ${sub}`);
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
  if (group === 'take' && sub === 'control' && !(CONTROL_OPS as readonly string[]).includes(rest[1]!)) {
    throw new UsageError(`take control: comando "${rest[1]}" desconhecido; use ${CONTROL_OPS.join(', ')}`);
  }
  if (values.scenes !== undefined && sceneList(values.scenes).length === 0) throw new UsageError('--scenes precisa de ids de cena (ex.: --scenes s02,s05)');
  for (const key of ['from', 'until', 'voice'] as const) {
    if (values[key] !== undefined && values[key].trim() === '') throw new UsageError(`--${key} vazio`);
  }
  return { group, sub, values, args: rest };
}

function sceneList(text: string): string[] {
  return text
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id !== '');
}

function takeRunOptions(file: string, values: Values): TakeRunOptions {
  const options: TakeRunOptions = { file, dry: values.dry === true, prepare: values['no-prepare'] !== true, cleanup: values['no-cleanup'] !== true };
  if (values.scenes !== undefined) options.scenes = sceneList(values.scenes);
  if (values.from !== undefined) options.from = values.from;
  if (values.until !== undefined) options.until = values.until;
  if (values.voice !== undefined) options.voice = values.voice;
  return options;
}

function takeValidateText(r: TakeValidation): string {
  const lines: string[] = [];
  if (r.ok) lines.push(`take validate: ok — ${r.file}: ${r.scenes} cena(s), ${r.steps} passo(s)`);
  else {
    lines.push(`take validate: ${r.errors.length} erro(s) em ${r.file}:`);
    for (const e of r.errors) lines.push(`  ${e.path === '' ? '(raiz)' : e.path}: ${e.message} [${e.rule}]`);
  }
  for (const w of r.warnings) lines.push(`  aviso: ${w}`);
  return lines.join('\n');
}

function takeRunText(r: TakeSummary): string {
  const lines = [
    `take run: ${r.status}${r.cause === undefined ? '' : ` (${r.cause})`} — ${r.takeId} (${r.mode})`,
    `  cenas: ${r.scenes.started}/${r.scenes.planned}; passos: ${r.steps.ok} ok, ${r.steps.skipped} pulado(s), ${r.steps.failed} com falha`,
  ];
  if (r.recording !== null) {
    const size = r.recording.sizeBytes === null ? '' : ` (${(r.recording.sizeBytes / 1024 ** 2).toFixed(1)} MB)`;
    lines.push(`  gravação: ${r.recording.file ?? '(sem arquivo)'}${size}; pasta de gravação do OBS ${r.recording.directoryRestored === false ? 'NÃO devolvida' : 'devolvida'}`);
  }
  if (r.error !== undefined) lines.push(`  erro: ${r.error.code ?? 'erro'}: ${r.error.message}`);
  if (r.cleanupPending) lines.push('  cleanup: pendente (não rodou)');
  if (r.airplaneMaybeOn) lines.push('  ATENÇÃO: o modo avião pode ter ficado ligado — desligue-o no iPhone');
  if (r.takeJson !== null) lines.push(`  take.json: ${r.takeJson}`);
  return lines.join('\n');
}

function takeControlText(r: TakeControlResult): string {
  return `take control: ${r.op} enviado à tomada ${r.takeId}${r.pausedAt === null ? '' : ` (pausada em ${r.pausedAt})`} — ${r.file}`;
}

function changeLine(c: ObsSetupChange): string {
  return `  ${c.item}: ${c.from === null ? '(não existia)' : JSON.stringify(c.from)} → ${JSON.stringify(c.to)}`;
}

function obsSetupText(r: ObsSetupResult): string {
  const lines: string[] = [];
  if (r.launched) lines.push(`OBS aberto pela ferramenta: ${obsLaunchCommand(r.profile, r.collection)}`);
  lines.push(
    r.changes.length === 0
      ? `obs setup: perfil "${r.profile}" e coleção "${r.collection}" conferidos; nada a corrigir (nenhuma escrita)`
      : `obs setup: perfil "${r.profile}" e coleção "${r.collection}"; ${r.changes.length} diferença(s) corrigida(s):`,
  );
  for (const c of r.changes) lines.push(changeLine(c));
  lines.push(`iPhone: "${r.device.name}" → device ${r.device.value}`);
  const encoder = { ok: 'conferido', written: 'corrigido antes de abrir o OBS', pending: 'pendente: só é escrito com o OBS fechado' }[r.recordEncoder.status];
  lines.push(`recordEncoder.json: ${encoder} — ${r.recordEncoder.path}`);
  if (r.restartRequired) lines.push(`reinício: ${restartHint(r.profile, r.collection)}`);
  return lines.join('\n');
}

/** Em texto, um erro do `obs setup` depois de escrever mostra o que já foi feito e o reinício pendente. */
function errorProgressText(data: Readonly<Record<string, unknown>>): string {
  const lines: string[] = [];
  const changes = data['changes'];
  if (Array.isArray(changes) && changes.length > 0) {
    lines.push(`mudanças feitas antes do erro (${changes.length}):`);
    for (const c of changes as ObsSetupChange[]) lines.push(changeLine(c));
  }
  const profile = data['profile'];
  const collection = data['collection'];
  if (data['restartRequired'] === true && typeof profile === 'string' && typeof collection === 'string') {
    lines.push(`reinício: ${restartHint(profile, collection)}`);
  }
  return lines.map((line) => `${line}\n`).join('');
}

function human(group: string, sub: string, result: unknown): string {
  if (group === 'obs') return obsSetupText(result as ObsSetupResult);
  if (group === 'take') {
    if (sub === 'validate') return takeValidateText(result as TakeValidation);
    if (sub === 'run') return takeRunText(result as TakeSummary);
    return takeControlText(result as TakeControlResult);
  }
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
  const { group, sub, values, args } = parsed;
  const json = values.json === true;
  try {
    const ctx = loadContext({ ...deps, onProgress: (line) => io.stderr(`${line}\n`) });
    let result: unknown;
    let failed = false;
    switch (group === 'runner' ? sub : `${group} ${sub}`) {
      case 'obs setup':
        result = await obsSetup(ctx, deps.obs);
        break;
      case 'take validate': {
        const validation = takeValidate(args[0]!);
        failed = !validation.ok;
        result = validation;
        break;
      }
      case 'take run': {
        const summary = await takeRun(ctx, takeRunOptions(args[0]!, values), deps.take);
        failed = summary.status !== 'finished';
        result = summary;
        break;
      }
      case 'take control':
        result = takeControl(ctx, args[0]!, args[1]!);
        break;
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
    io.stdout(json ? `${JSON.stringify(result)}\n` : `${human(group, sub, result)}\n`);
    return failed ? 1 : 0;
  } catch (error) {
    if (isContrarregraError(error)) {
      const hint = error.data?.['hint'];
      const progress = json ? '' : errorProgressText(error.data ?? {});
      io.stderr(`contrarregra: ${error.code}: ${error.message}\n${progress}${typeof hint === 'string' ? `dica: ${hint}\n` : ''}`);
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
