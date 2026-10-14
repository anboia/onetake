// Driver do SP-4 (T-0.19; S2, ADR-9, AC-2.1, AC-2.6 só a reconexão): canal usbmux → WebSocket no loopback do
// aparelho, nas duas formas de prender o listener do build `Spike` (`CONTRARREGRA_BIND=loopback` →
// `requiredInterfaceType = .loopback`; `endpoint` → `requiredLocalEndpoint 127.0.0.1:P`). Código de spike,
// descartável (architecture.md A5); usa as peças de `mac/src` (usbmux, repassador, cliente JSON-RPC, `openRunner`,
// `RunnerLink`, `severRunner`, `fitClock`) e só métodos que o runner já tem (`session.hello`, `clock.ping` com `pad`,
// `health`, `device.state`, `screen.shot`).
//
// Nunca instala, sobe nem derruba o runner (build `Spike` instalado é G5; `runner up --spike --bind <forma>` e
// `runner down` são do orquestrador): mede a sessão que estiver de pé e confere que ela é `Spike` com o bind pedido.
// O próprio runner opera o iPhone: põe o Hagah à frente (`app.activate`) e liga/desliga o modo avião pela Central de
// Controle (o interruptor `airplane-mode-button`, o único que a lista permitida libera com ela aberta). A voz do Mac
// (`say -v Luciana`) só avisa; `OWNER_ACTION {...}` na saída padrão só para o que é humano (código/Face ID, alerta ou
// notificação cobrindo a tela, o avião deixado ligado sem o runner conseguir desligar), e o driver para logo depois.
//
// Uso (Node 22 ≥ 22.18, TypeScript direto; ver spikes/SP-4.md):
//   node spikes/sp-4/sp4.ts probe   --label <l> [--bind loopback|endpoint]
//   node spikes/sp-4/sp4.ts run     --label <l> [--bind loopback|endpoint] [--phases echo64,echo64k,connect,fresh,product,
//                                   ntp,shots,concurrent,sever] [--no-airplane] [--n64 1000] [--n64k 100] [--n-connect 100]
//                                   [--n-fresh 1000] [--n-product 100] [--n-shots 100] [--bursts 12] [--burst-every-s 5]
//                                   [--sever-rounds 3] [--sever-s 30]
//   fase suplementar (só quando pedida): --phases concurrent2 [--c2-seconds 60] [--c2-n64k 100] [--c2-fresh 500]
//                                   [--transit-ms 20]
//   node spikes/sp-4/sp4.ts analyze --label <l>
//   node spikes/sp-4/sp4.ts compare --labels <l1>,<l2>
// Saída bruta: uma linha JSON por amostra em spikes/sp-4/out/<label>.ndjson (pasta ignorada pelo git); resumo em
// <label>-summary.json e a tabela em Markdown na saída padrão. Códigos de saída: 3 = esta forma é inalcançável (rodar a
// outra; o plano B só sai do `compare`); 4 = parou com `OWNER_ACTION` (algo humano; também num SIGINT/SIGTERM com o
// avião possivelmente ligado); 5 = `transportType` não é `wired`; 1 = outro erro. Rodar o `run` em segundo plano e
// pará-lo só com `kill -INT` (SIGKILL não se trata).

import { execFile, spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '../../mac/src/core/config.ts';
import { readDeviceTransport } from '../../mac/src/device/devicectl.ts';
import { openRunner } from '../../mac/src/runner/client.ts';
import { severRunner } from '../../mac/src/runner/lifecycle.ts';
import { RunnerLink } from '../../mac/src/runner/link.ts';
import { runnerPaths } from '../../mac/src/runner/paths.ts';
import { currentSession, readSessionToken, sessionAlive } from '../../mac/src/runner/session.ts';
import { openChannel, probeReach, rawConnect, usbmuxSnapshot } from './channel.ts';
import {
  compare,
  DEFAULT_OPTIONS,
  errCode,
  markdownTable,
  PHASES,
  probeSpike,
  runSpike,
  summarize,
  hotspotActive,
  signalExit,
  StopError,
  type AirState,
  type DriverEnv,
  type Json,
  type RunOptions,
} from './lib.ts';

const OUT = join(dirname(fileURLToPath(import.meta.url)), 'out');
const TMP = join(OUT, 'tmp');
const VOICE = 'Luciana';
/** Esta forma é inalcançável (o plano B só sai do `compare`, com as duas inalcançáveis). */
const EXIT_PLAN_B = 3;
/** Parou pedindo algo humano (`OWNER_ACTION`). */
const EXIT_OWNER = 4;
/** O túnel não está no cabo (`transportType` ≠ `wired`). */
const EXIT_NOT_WIRED = 5;

function now(): number {
  return Math.round((performance.timeOrigin + performance.now()) * 10) / 10;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------------------------------------
// Registro (em memória, gravado no fim de cada fase: nada de escrita em disco no meio de uma medida), voz e dono

class Recorder {
  readonly label: string;
  readonly path: string;
  #buffer: string[] = [];

  constructor(label: string, fresh: boolean) {
    mkdirSync(TMP, { recursive: true });
    this.label = label;
    this.path = join(OUT, `${label}.ndjson`);
    if (fresh && existsSync(this.path)) throw new Error(`${this.path} já existe: use outro --label`);
  }

  write(k: string, data: Json = {}): void {
    this.#buffer.push(JSON.stringify({ k, m: now(), ...data }));
    if (this.#buffer.length >= 5_000) this.flush();
  }

  flush(): void {
    if (this.#buffer.length === 0) return;
    appendFileSync(this.path, `${this.#buffer.join('\n')}\n`);
    this.#buffer = [];
  }
}

/** As vozes em andamento: o driver espera elas acabarem antes de sair (nenhum `say` órfão). */
const voices = new Set<Promise<void>>();

function say(rec: Recorder, text: string, meta: Json = {}): void {
  rec.write('say', { ...meta, text });
  const child = spawn('/usr/bin/say', ['-v', VOICE, text], { stdio: 'ignore' });
  const done = new Promise<void>((resolve) => {
    child.once('exit', () => resolve());
    child.once('error', (error) => {
      rec.write('say-error', { err: errCode(error) });
      resolve();
    });
  });
  voices.add(done);
  void done.then(() => voices.delete(done));
}

/** Espera as vozes (até `maxMs`). */
async function voicesDone(maxMs = 20_000): Promise<void> {
  await Promise.race([Promise.all([...voices]), sleep(maxMs)]);
}

/** Pedido ao dono (só o que é humano): `OWNER_ACTION {...}` na saída padrão (o orquestrador repassa) + a voz do Mac. */
function ownerAction(rec: Recorder, step: string, text: string): void {
  console.log(`OWNER_ACTION ${JSON.stringify({ step, text })}`);
  say(rec, text, { step, owner: true });
  rec.flush();
}

/** `ifconfig` (todas as interfaces): o Mac na rede do Acesso Pessoal do iPhone? */
function macOnHotspot(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('/sbin/ifconfig', [], { timeout: 5_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => resolve(error === null && hotspotActive(stdout)));
  });
}

// ---------------------------------------------------------------------------------------------------------
// Opções

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

function num(opts: Map<string, string>, key: string, fallback: number): number {
  const v = opts.get(key);
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new Error(`--${key} inválido: ${v}`);
  return n;
}

function bindOption(opts: Map<string, string>): string | undefined {
  const bind = opts.get('bind');
  if (bind !== undefined && bind !== 'loopback' && bind !== 'endpoint') throw new Error(`--bind inválido: ${bind} (loopback ou endpoint)`);
  return bind;
}

function runOptions(opts: Map<string, string>): RunOptions {
  const phases = opts.get('phases')?.split(',').map((p) => p.trim()).filter((p) => p !== '') ?? [...DEFAULT_OPTIONS.phases];
  for (const p of phases) if (!(PHASES as readonly string[]).includes(p)) throw new Error(`fase desconhecida: ${p} (${PHASES.join(', ')})`);
  return {
    ...DEFAULT_OPTIONS,
    phases,
    airplane: !opts.has('no-airplane'),
    n64: num(opts, 'n64', DEFAULT_OPTIONS.n64),
    n64k: num(opts, 'n64k', DEFAULT_OPTIONS.n64k),
    nConnect: num(opts, 'n-connect', DEFAULT_OPTIONS.nConnect),
    nFresh: num(opts, 'n-fresh', DEFAULT_OPTIONS.nFresh),
    nProduct: num(opts, 'n-product', DEFAULT_OPTIONS.nProduct),
    nShots: num(opts, 'n-shots', DEFAULT_OPTIONS.nShots),
    bursts: num(opts, 'bursts', DEFAULT_OPTIONS.bursts),
    burstEveryMs: num(opts, 'burst-every-s', DEFAULT_OPTIONS.burstEveryMs / 1000) * 1000,
    severRounds: num(opts, 'sever-rounds', DEFAULT_OPTIONS.severRounds),
    severS: num(opts, 'sever-s', DEFAULT_OPTIONS.severS),
    c2DurationMs: num(opts, 'c2-seconds', DEFAULT_OPTIONS.c2DurationMs / 1000) * 1000,
    c2N64k: num(opts, 'c2-n64k', DEFAULT_OPTIONS.c2N64k),
    c2NFresh: num(opts, 'c2-fresh', DEFAULT_OPTIONS.c2NFresh),
    transitMs: num(opts, 'transit-ms', DEFAULT_OPTIONS.transitMs),
  };
}

// ---------------------------------------------------------------------------------------------------------
// Sessão e sonda

function context(wantBind: string | undefined) {
  const config = loadConfig();
  const paths = runnerPaths(config);
  const session = currentSession(paths);
  const alive = session !== undefined && sessionAlive(session);
  return { config, session, alive, wantBind };
}

async function probe(rec: Recorder, ctx: ReturnType<typeof context>): Promise<{ ok: boolean; verdict: string; message: string }> {
  const { config, session } = ctx;
  const target = { socketPath: config.usbmux.socketPath, udid: config.device.udid, port: session?.port ?? config.runner.port };
  const result = await probeSpike(
    { hr: () => process.hrtime.bigint(), sleep, write: (k, d) => rec.write(k, d) },
    {
      session,
      alive: ctx.alive,
      wantBind: ctx.wantBind,
      readLog: (path) => readFileSync(path, 'utf8'),
      snapshot: () => usbmuxSnapshot(target),
      reach: (ready) => probeReach({ ...target, attempts: 5, retryMs: 1_000, ready, sleep }),
      hello: async () => {
        if (session === undefined) throw new Error('sem sessão');
        const channel = await openChannel({ ...target, role: 'sync', token: readSessionToken(session), session });
        await channel.close();
        return channel.hello;
      },
    },
  );
  rec.flush();
  console.log(`sonda: ${result.message}`);
  return result;
}

// ---------------------------------------------------------------------------------------------------------
// Comandos

async function cmdProbe(opts: Map<string, string>): Promise<void> {
  const rec = new Recorder(opts.get('label') ?? 'probe', false);
  const result = await probe(rec, context(bindOption(opts)));
  if (result.verdict === 'unreachable') process.exitCode = EXIT_PLAN_B;
  else if (!result.ok) process.exitCode = 1;
}

async function cmdRun(opts: Map<string, string>): Promise<void> {
  const label = opts.get('label') ?? `run-${Date.now()}`;
  const options = runOptions(opts);
  const ctx = context(bindOption(opts));
  const rec = new Recorder(label, true);
  // SIGINT/SIGTERM (SIGKILL não se trata: rodar em segundo plano e parar com `kill -INT`): com o avião possivelmente
  // ligado, `OWNER_ACTION air-off` e saída 4; senão, 130.
  let air: AirState = 'off';
  const onSignal = (signal: string): void => {
    const exit = signalExit(air);
    rec.write('end', { why: 'signal', signal, air });
    if (exit.owner !== undefined) ownerAction(rec, exit.owner.step, exit.owner.text);
    rec.flush();
    // Sai na hora (esperar a voz deixaria a medição seguir, e até tocar no avião); o `say` termina sozinho em segundos.
    process.exit(exit.code);
  };
  process.once('SIGINT', () => onSignal('SIGINT'));
  process.once('SIGTERM', () => onSignal('SIGTERM'));

  const probed = await probe(rec, ctx);
  if (!probed.ok) {
    if (probed.verdict === 'unreachable') {
      const bind = ctx.session?.bind ?? 'loopback';
      say(rec, `SP-4: a forma ${bind} é inalcançável. Rodar a outra; o plano B só sai da comparação.`, { step: 'unreachable' });
      process.exitCode = EXIT_PLAN_B;
    } else process.exitCode = 1;
    rec.flush();
    await voicesDone();
    return;
  }
  const { config, session } = ctx;
  if (session === undefined) throw new Error('sem sessão');
  const app = config.app.explore;
  if (app === undefined && (options.phases.includes('shots') || options.phases.includes('concurrent'))) {
    throw new Error('app.explore não configurado: as capturas do SP-4 são com o Hagah (app.explore) à frente');
  }
  const token = readSessionToken(session);
  const target = { socketPath: config.usbmux.socketPath, udid: config.device.udid, port: session.port };
  const open = (role: 'control' | 'sync') => openChannel({ ...target, role, token, session });
  const env: DriverEnv = {
    hr: () => process.hrtime.bigint(),
    sleep,
    write: (k, d) => rec.write(k, d),
    flush: () => rec.flush(),
    log: (line) => console.log(line),
    say: (text, meta) => say(rec, text, meta),
    owner: (step, text) => ownerAction(rec, step, text),
    setAir: (next) => {
      air = next;
    },
    hotspot: macOnHotspot,
    app: app ?? '',
    bind: session.bind ?? 'loopback',
    openControl: () => open('control'),
    openSync: () => open('sync'),
    openFresh: () => open('sync'),
    openProduct: () => openRunner(config, { role: 'sync', session }),
    rawConnect: () => rawConnect(target),
    transport: () => readDeviceTransport({ udid: config.device.udid, coreDeviceId: config.device.coreDeviceId, outDir: TMP }),
    sessionAlive: () => sessionAlive(session),
    openLink: (role, onState) => RunnerLink.connect(config, { role, onStateChange: onState }),
    sever: (forS) => {
      const result = severRunner(config, { forS });
      if (result.owner !== 'self') throw new Error(`há uma tomada (${result.takeId ?? '?'}) segurando o aparelho: o SP-4 não corta a linha de outro processo`);
      return result.links ?? 0;
    },
  };
  try {
    await runSpike(env, options);
  } catch (error) {
    if (!(error instanceof StopError)) throw error;
    console.error(`sp4: parado — ${error.message}`);
    process.exitCode = error.kind === 'owner' ? EXIT_OWNER : EXIT_NOT_WIRED;
  } finally {
    rec.flush();
  }
  analyze(label);
  await voicesDone();
}

function readRows(label: string): Json[] {
  const text = readFileSync(join(OUT, `${label}.ndjson`), 'utf8');
  return text.split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l) as Json);
}

function analyze(label: string): void {
  const summary = summarize(label, readRows(label));
  writeFileSync(join(OUT, `${label}-summary.json`), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(markdownTable(summary));
}

function cmdCompare(opts: Map<string, string>): void {
  const labels = (opts.get('labels') ?? '').split(',').map((l) => l.trim()).filter((l) => l !== '');
  if (labels.length === 0) throw new Error('--labels <l1>,<l2>');
  const summaries = labels.map((label) => summarize(label, readRows(label)));
  const result = compare(summaries);
  writeFileSync(join(OUT, `compare-${labels.join('+')}.json`), `${JSON.stringify({ labels, ...result }, null, 2)}\n`);
  console.log(result.markdown);
  console.log(`\n${result.decision}`);
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const opts = args(rest);
  switch (command) {
    case 'probe':
      await cmdProbe(opts);
      break;
    case 'run':
      await cmdRun(opts);
      break;
    case 'analyze':
      analyze(opts.get('label') ?? '');
      break;
    case 'compare':
      cmdCompare(opts);
      break;
    default:
      console.error('uso: sp4.ts probe|run|analyze|compare --label <l> …');
      process.exitCode = 2;
  }
}

main().then(
  () => process.exit(process.exitCode ?? 0),
  (error: unknown) => {
    console.error(`sp4: ${errCode(error)}`);
    process.exit(1);
  },
);
