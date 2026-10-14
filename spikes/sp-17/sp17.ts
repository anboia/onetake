// Driver do SP-17 (T-0.37; S4 item 4, S12 item 2): (1) puxar um `events.ndjson` do contêiner do `.xctrunner` com
// `devicectl device copy from --domain-type appDataContainer` com o runner vivo, parado e de pé de novo, conferindo
// tamanho e SHA-256 contra o que foi escrito (≤ 5 s por cópia); (2) abrir `hagah://bible/ENGNIV/PSA/1` pelo runner
// (`app.openURL` → `XCUIDevice.shared.system.open`) com o Hagah à frente, em segundo plano e encerrado, com o PID do
// Hagah antes/depois (`devicectl device info processes`) e se algo do sistema (pedido de confirmação) aparece no
// caminho. Código de spike, descartável (architecture.md A5); usa o cliente JSON-RPC de `mac/src/runner` (T-0.10).
//
// Nunca instala, constrói nem sobe/derruba o runner (`runner up --spike`/`runner down` são passos do procedimento,
// rodados à parte). Só lê e escreve o contêiner do `.xctrunner` do Contrarregra (o `--domain-identifier` é fixado em
// `lib.ts` a partir de `bundle.runnerTest`); do Hagah, só o caminho do app e os PIDs. Recusa rodar com outro driver de
// spike de pé (um spike no aparelho por vez).
//
// Uso (Node 22 ≥ 22.18, TypeScript direto; ver spikes/SP-17.md):
//   node spikes/sp-17/sp17.ts probe --label <l>
//   node spikes/sp-17/sp17.ts seed  --label <l> --source mac|runner [--sizes 65536,1048576]
//   node spikes/sp-17/sp17.ts pull  --label <l> --state live|stopped|reup [--n 5]
//   node spikes/sp-17/sp17.ts link  --label <l> [--cases front,background,cold] [--no-restore]
//   node spikes/sp-17/sp17.ts report --label <l>
// Saída bruta em spikes/sp-17/out/ (fora do git): <label>.ndjson (um evento por linha), <label>-probe.json,
// <label>-files-<momento>.json (a listagem do contêiner do runner), <label>-seed.json, <label>-pull-<estado>.json,
// <label>-link.json, <label>-summary.json (e as tabelas em Markdown na saída padrão).
// Códigos de saída: 0 ok; 1 erro; 3 OWNER_ACTION (algo que só o dono resolve); 4 outro spike usando o aparelho.

import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig, type Config } from '../../mac/src/core/config.ts';
import { isContrarregraError } from '../../mac/src/core/errors.ts';
import { parseDevicectlList, XCRUN_PATH } from '../../mac/src/device/devicectl.ts';
import { RunnerLink } from '../../mac/src/runner/link.ts';
import { RpcProtocolError } from '../../mac/src/runner/rpc.ts';
import {
  DEFAULT_SIZES,
  LINK_CASES,
  LinkStop,
  RunnerContainer,
  appFragment,
  errCode,
  linkCases,
  markdownLinks,
  markdownPulls,
  otherSpikes,
  parseAppPath,
  parseAppPids,
  parseFileList,
  parseRunnerPids,
  pullPhase,
  readFront,
  readPids,
  seedFromMac,
  seedFromRunner,
  summarizePulls,
  toPsalm23,
  type Devicectl,
  type DevicectlRun,
  type FsEnv,
  type Json,
  type LinkCase,
  type LinkEnv,
  type LinkResult,
  type PidRead,
  type PullSample,
  type RunnerState,
  type Seeded,
} from './lib.ts';

const OUT = join(dirname(fileURLToPath(import.meta.url)), 'out');
const TMP = join(OUT, 'tmp');
const RUNNER_APP_FRAGMENT = 'ContrarregraRunner-Runner.app/';

function now(): number {
  return Math.round((performance.timeOrigin + performance.now()) * 10) / 10;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class Recorder {
  readonly label: string;
  readonly path: string;
  constructor(label: string) {
    if (!/^[a-z0-9-]{1,40}$/.test(label)) throw new Error(`--label inválido: ${label} (a-z, 0-9, -)`);
    mkdirSync(OUT, { recursive: true });
    this.label = label;
    this.path = join(OUT, `${label}.ndjson`);
  }
  write(k: string, data: Json = {}): void {
    appendFileSync(this.path, `${JSON.stringify({ k, m: now(), ...data })}\n`);
  }
  file(suffix: string): string {
    return join(OUT, `${this.label}-${suffix}`);
  }
}

function args(argv: string[]): Map<string, string> {
  const map = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? '';
    if (!a.startsWith('--')) continue;
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) map.set(a.slice(2), 'true');
    else {
      map.set(a.slice(2), next);
      i++;
    }
  }
  return map;
}

function requireLabel(opts: Map<string, string>): string {
  const label = opts.get('label');
  if (label === undefined) throw new Error('falta --label');
  return label;
}

// ---------------------------------------------------------------------------------------------------------
// Aparelho

/** Um spike no aparelho por vez: recusa com outro driver `spikes/sp-N/` de pé. */
function guardDevice(rec: Recorder): void {
  const ps = execFileSync('/bin/ps', ['-axo', 'pid=,command='], { encoding: 'utf8' });
  const others = otherSpikes(ps, process.pid);
  if (others.length > 0) {
    rec.write('busy', { others });
    console.error(`outro spike está usando o aparelho:\n${others.join('\n')}`);
    process.exit(4);
  }
}

/** `xcrun devicectl … --json-output <arquivo>`; saída padrão e de erro descartadas; o JSON é apagado logo depois de lido. */
const devicectl: Devicectl = async (dcArgs: string[], timeoutMs: number): Promise<DevicectlRun> => {
  mkdirSync(TMP, { recursive: true });
  const out = join(TMP, `dc-${process.pid}-${randomBytes(4).toString('hex')}.json`);
  const t0 = performance.now();
  const status = await new Promise<string>((resolve) => {
    const child = spawn(XCRUN_PATH, ['devicectl', ...dcArgs, '--json-output', out], { stdio: 'ignore' });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve('timeout');
    }, timeoutMs);
    child.once('error', (error) => {
      clearTimeout(timer);
      resolve(`spawn: ${error.message}`);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve(code === 0 ? 'ok' : `exit ${code ?? signal}`);
    });
  });
  const dtMs = Math.round(performance.now() - t0);
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(out, 'utf8'));
  } catch {
    json = undefined;
  } finally {
    rmSync(out, { force: true });
  }
  if (status === 'ok') return { ok: true, json, dtMs };
  const error = (json as { error?: { domain?: string; code?: number; userInfo?: Record<string, { string?: string }> } } | undefined)?.error;
  const why = error?.userInfo?.['NSLocalizedDescription']?.string ?? error?.userInfo?.['NSLocalizedFailureReason']?.string ?? '';
  const detail = error === undefined ? '' : ` ${error.domain ?? ''} ${error.code ?? ''} ${why}`.slice(0, 240);
  return { ok: false, json, dtMs, err: `${status}${detail}` };
};

function fsEnv(rec: Recorder): FsEnv {
  return {
    tmpDir: () => {
      mkdirSync(TMP, { recursive: true });
      return mkdtempSync(join(TMP, 'x-'));
    },
    write: (k, data) => rec.write(k, data),
    now: () => Date.now(),
  };
}

function device(config: Config): string {
  return config.device.coreDeviceId;
}

async function appPath(config: Config, bundleId: string): Promise<{ path?: string; run: DevicectlRun }> {
  const run = await devicectl(['device', 'info', 'apps', '--device', device(config), '--bundle-id', bundleId], 20_000);
  const path = run.ok ? parseAppPath(run.json, bundleId) : undefined;
  return { ...(path === undefined ? {} : { path }), run };
}

function runnerPids(config: Config): Promise<PidRead> {
  return readPids(devicectl, device(config), RUNNER_APP_FRAGMENT, parseRunnerPids);
}

async function listContainer(container: RunnerContainer, rec: Recorder, moment: string): Promise<{ path: string; size: number | null; dir: boolean }[]> {
  const run = await container.list();
  const files = run.ok ? parseFileList(run.json) : [];
  rec.write('files', { moment, ok: run.ok, dt: run.dtMs, n: files.length, ...(run.err === undefined ? {} : { err: run.err }) });
  // só o contêiner do runner: a listagem crua vai inteira para out/ (forma do JSON ainda não conhecida)
  writeFileSync(rec.file(`files-${moment}.json`), `${JSON.stringify({ at: new Date().toISOString(), container: container.id, ok: run.ok, dtMs: run.dtMs, err: run.err, files, raw: run.json }, null, 2)}\n`);
  return files;
}

interface Session {
  link: RunnerLink;
  configuration: string;
  hello: unknown;
}

async function connect(config: Config, rec: Recorder): Promise<Session> {
  const link = await RunnerLink.connect(config, {
    role: 'control',
    onStateChange: (state, error) => rec.write('link', { state, ...(error === undefined ? {} : { err: errCode(error) }) }),
  });
  const connection = link.connection;
  if (connection === undefined) throw new Error('a linha com o runner caiu logo depois de abrir');
  return { link, configuration: connection.session.configuration, hello: connection.hello };
}

/** O runner responde? (`session.hello` pela linha de controle) — sem lançar. */
async function runnerAnswers(config: Config, rec: Recorder): Promise<{ up: boolean; configuration?: string; err?: string }> {
  try {
    const session = await connect(config, rec);
    await session.link.close();
    return { up: true, configuration: session.configuration };
  } catch (error) {
    return { up: false, err: errCode(error) };
  }
}

// ---------------------------------------------------------------------------------------------------------
// Comandos

async function cmdProbe(opts: Map<string, string>): Promise<void> {
  const rec = new Recorder(requireLabel(opts));
  guardDevice(rec);
  const config = loadConfig();
  const container = new RunnerContainer(devicectl, device(config), config.bundle.runnerTest);
  const list = await devicectl(['list', 'devices'], 15_000);
  const transport = list.ok ? parseDevicectlList(list.json, config.device) : undefined;
  const runnerApp = await appPath(config, container.id);
  const hagah = config.app.explore === undefined ? undefined : await appPath(config, config.app.explore);
  const pids = await runnerPids(config);
  const answers = await runnerAnswers(config, rec);
  let logWrite = 'não testado (runner parado)';
  if (answers.up) {
    try {
      const session = await connect(config, rec);
      try {
        // `bytes: 0` é recusado pelo método (mínimo 1024): distingue "não existe" de "existe" sem escrever nada
        await session.link.call('spike.logWrite', { dir: 'sp17-probe', bytes: 0 }, { timeoutMs: 10_000 });
        logWrite = 'respondeu a bytes 0 (inesperado)';
      } catch (error) {
        logWrite = error instanceof RpcProtocolError && error.code === -32601 ? `ausente (${errCode(error)})` : `presente (${errCode(error)})`;
      } finally {
        await session.link.close();
      }
    } catch (error) {
      logWrite = `sem conexão (${errCode(error)})`;
    }
  }
  const files = await listContainer(container, rec, 'probe');
  const result = {
    at: new Date().toISOString(),
    transport: transport ?? null,
    container: container.id,
    runnerAppInstalled: runnerApp.path !== undefined,
    runnerAppErr: runnerApp.run.err,
    hagahApp: hagah?.path === undefined ? null : appFragment(hagah.path),
    runnerPids: pids,
    runner: answers,
    spikeLogWrite: logWrite,
    containerFiles: files.length,
  };
  rec.write('probe', result);
  writeFileSync(rec.file('probe.json'), `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
}

function readSeed(rec: Recorder): Seeded[] {
  const path = rec.file('seed.json');
  if (!existsSync(path)) throw new Error(`${path} não existe: rode seed primeiro`);
  return (JSON.parse(readFileSync(path, 'utf8')) as { seeded: Seeded[] }).seeded;
}

async function cmdSeed(opts: Map<string, string>): Promise<void> {
  const rec = new Recorder(requireLabel(opts));
  guardDevice(rec);
  const source = opts.get('source');
  if (source !== 'mac' && source !== 'runner') throw new Error('--source mac|runner');
  const sizes = (opts.get('sizes')?.split(',').map(Number) ?? [...DEFAULT_SIZES]);
  if (sizes.some((n) => !Number.isInteger(n) || n < 1024)) throw new Error(`--sizes inválido: ${opts.get('sizes')}`);
  const config = loadConfig();
  const env = fsEnv(rec);
  let seeded: Seeded[];
  if (source === 'mac') {
    const container = new RunnerContainer(devicectl, device(config), config.bundle.runnerTest);
    seeded = await seedFromMac(container, env, rec.label, sizes);
  } else {
    const session = await connect(config, rec);
    try {
      if (session.configuration !== 'Spike') throw new Error(`o runner de pé é o build ${session.configuration}, não o Spike`);
      seeded = await seedFromRunner(session.link, env, rec.label, sizes);
    } finally {
      await session.link.close();
    }
  }
  writeFileSync(rec.file('seed.json'), `${JSON.stringify({ at: new Date().toISOString(), source, seeded }, null, 2)}\n`);
  console.log(JSON.stringify(seeded, null, 2));
}

async function cmdPull(opts: Map<string, string>): Promise<void> {
  const rec = new Recorder(requireLabel(opts));
  guardDevice(rec);
  const state = opts.get('state') as RunnerState | undefined;
  if (state !== 'live' && state !== 'stopped' && state !== 'reup') throw new Error('--state live|stopped|reup');
  const n = Number(opts.get('n') ?? '5');
  if (!Number.isInteger(n) || n < 1 || n > 20) throw new Error('--n entre 1 e 20');
  const config = loadConfig();
  const seeded = readSeed(rec);
  const container = new RunnerContainer(devicectl, device(config), config.bundle.runnerTest);
  // o estado do runner é conferido, não suposto: processo do `.xctrunner` e `session.hello`
  const pids = await runnerPids(config);
  const answers = await runnerAnswers(config, rec);
  const want = state === 'stopped' ? { up: false, running: false } : { up: true, running: true };
  const running = pids.ok ? pids.pids.length > 0 : null;
  const stateOk = answers.up === want.up && (running === null || running === want.running);
  rec.write('state', { state, pids, answers, stateOk });
  if (!stateOk && opts.get('force-state') !== 'true') {
    throw new Error(`o runner não está "${state}": responde=${answers.up} processo=${JSON.stringify(pids.pids)} (${answers.err ?? ''}); `
      + `use runner up --spike / runner down antes (ou --force-state para registrar assim mesmo)`);
  }
  const samples = await pullPhase(container, fsEnv(rec), seeded, state, n);
  const files = await listContainer(container, rec, `pull-${state}`);
  const summary = summarizePulls(samples);
  writeFileSync(rec.file(`pull-${state}.json`), `${JSON.stringify({ at: new Date().toISOString(), state, runnerPids: pids, runner: answers, stateOk, containerFiles: files.length, summary, samples }, null, 2)}\n`);
  console.log(markdownPulls(summary));
}

function linkEnv(config: Config, session: Session, rec: Recorder, hagahPath: string): LinkEnv {
  const fragment = appFragment(hagahPath);
  return {
    rpc: session.link,
    bundleId: config.app.explore as string,
    hagahPids: () => readPids(devicectl, device(config), fragment, (json) => parseAppPids(json, hagahPath)),
    write: (k, data) => rec.write(k, data),
    now: () => Date.now(),
    sleep,
  };
}

async function cmdLink(opts: Map<string, string>): Promise<void> {
  const rec = new Recorder(requireLabel(opts));
  guardDevice(rec);
  const config = loadConfig();
  const bundleId = config.app.explore;
  if (bundleId === undefined) throw new Error('app.explore não configurado: o SP-17 abre o link no app de app.explore (o Hagah)');
  if (!config.urls.allowedPrefixes.some((p) => 'hagah://bible/ENGNIV/PSA/1'.startsWith(p))) {
    throw new Error('urls.allowedPrefixes não libera hagah://: o runner recusaria o link');
  }
  const kinds = (opts.get('cases')?.split(',') ?? [...LINK_CASES]) as LinkCase[];
  if (kinds.some((k) => !LINK_CASES.includes(k))) throw new Error(`--cases: ${LINK_CASES.join(',')}`);
  const hagah = await appPath(config, bundleId);
  if (hagah.path === undefined) throw new Error(`não achei o ${bundleId} no aparelho (${hagah.run.err ?? 'sem app'})`);
  const session = await connect(config, rec);
  const env = linkEnv(config, session, rec, hagah.path);
  let results: LinkResult[] = [];
  let stop: LinkStop | undefined;
  let restored: string | undefined;
  try {
    ({ results, stop } = await linkCases(env, kinds));
    if (stop !== undefined) {
      // uma camada do SpringBoard (possível pedido) ficou: o runner não toca nela; só tenta a tela de início uma vez
      const front = await readFront(env).catch((error: unknown) => ({ kind: `erro: ${errCode(error)}` }));
      rec.write('stop', { step: stop.step, msg: stop.message, front: front.kind });
      if (front.kind === 'layer') {
        try {
          await session.link.call('device.home', {}, { timeoutMs: 15_000 });
          const after = await readFront(env);
          rec.write('stop-home', { front: after.kind });
        } catch (error) {
          rec.write('stop-home', { err: errCode(error) });
        }
      }
    } else if (opts.get('no-restore') !== 'true') {
      try {
        await toPsalm23(env);
        restored = 'Salmo 23 à frente';
      } catch (error) {
        restored = `não: ${errCode(error)}`;
      }
      rec.write('restore', { restored });
    }
  } finally {
    await session.link.close();
  }
  writeFileSync(rec.file('link.json'), `${JSON.stringify({ at: new Date().toISOString(), configuration: session.configuration, results, stop: stop === undefined ? null : { step: stop.step, msg: stop.message }, restored: restored ?? null }, null, 2)}\n`);
  console.log(markdownLinks(results));
  if (stop !== undefined) {
    console.log(`OWNER_ACTION ${JSON.stringify({ step: stop.step, message: stop.message })}`);
    process.exit(3);
  }
}

function cmdReport(opts: Map<string, string>): void {
  const rec = new Recorder(requireLabel(opts));
  const pulls: PullSample[] = [];
  const states: Json[] = [];
  for (const state of ['live', 'stopped', 'reup'] as const) {
    const path = rec.file(`pull-${state}.json`);
    if (!existsSync(path)) continue;
    const data = JSON.parse(readFileSync(path, 'utf8')) as { samples: PullSample[]; runnerPids: unknown; runner: unknown; stateOk: boolean };
    pulls.push(...data.samples);
    states.push({ state, runnerPids: data.runnerPids, runner: data.runner, stateOk: data.stateOk });
  }
  const linkPath = rec.file('link.json');
  const link = existsSync(linkPath) ? (JSON.parse(readFileSync(linkPath, 'utf8')) as { results: LinkResult[] }) : undefined;
  const summary = summarizePulls(pulls);
  writeFileSync(rec.file('summary.json'), `${JSON.stringify({ at: new Date().toISOString(), states, pulls: summary, link: link?.results ?? null }, null, 2)}\n`);
  console.log(markdownPulls(summary));
  if (link !== undefined) console.log(`\n${markdownLinks(link.results)}`);
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const opts = args(rest);
  switch (command) {
    case 'probe': return cmdProbe(opts);
    case 'seed': return cmdSeed(opts);
    case 'pull': return cmdPull(opts);
    case 'link': return cmdLink(opts);
    case 'report': return cmdReport(opts);
    default:
      console.error('uso: sp17.ts probe|seed|pull|link|report --label <l> … (ver o cabeçalho)');
      process.exit(1);
  }
}

main().catch((error: unknown) => {
  console.error(isContrarregraError(error) ? `${error.code}: ${error.message}` : error instanceof Error ? error.message : String(error));
  process.exit(1);
});
