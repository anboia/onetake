// Driver do SP-14 (T-0.34; S7 item 2, AC-7.1): deriva do relógio aparelho → Mac. Rajadas de 32 trocas `clock.ping` a
// 10 ms pela conexão `sync`, uma a cada 10 s por 20 min; ajuste θ(t) = a + b·t (`fitClock`, Theil-Sen) completo, só-pré
// e pré+pós; resíduo RMS e erro de pré+pós no meio. Código de spike, descartável (architecture.md A5); usa o cliente de
// produção (`openRunner` de `mac/src/runner/client.ts`, T-0.10) e o núcleo de relógio da T-0.22 (`mac/src/clock`).
//
// Nunca instala, sobe nem derruba o runner (`runner up --spike` e `runner down` são do orquestrador) e nunca põe nada na
// fila do XCTest: só `session.hello`, `clock.ping` (na `sync`) e `health` (na `control`, fila de controle). Para se o
// Mac entrar na rede do Acesso Pessoal (`inet 172.20.10.*`), se o túnel não for `wired`, se o runner cair ou se 3
// rajadas seguidas falharem.
//
// Uso (Node 22 ≥ 22.18, TypeScript direto; ver spikes/SP-14.md):
//   caffeinate -i node spikes/sp-14/sp14.ts run --label <l> [--minutes 20] [--every-s 10]
//   node spikes/sp-14/sp14.ts analyze --label <l>
// Saída bruta: uma linha JSON por amostra em spikes/sp-14/out/<label>.ndjson (pasta ignorada pelo git); resumo em
// <label>-summary.json e a tabela em Markdown na saída padrão. Códigos de saída: 1 = erro; 5 = não está no cabo;
// 6 = Acesso Pessoal ligado; 7 = o runner caiu ou o canal falhou; 130 = SIGINT/SIGTERM.

import { execFile } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '../../mac/src/core/config.ts';
import { readDeviceTransport } from '../../mac/src/device/devicectl.ts';
import { openRunner } from '../../mac/src/runner/client.ts';
import { runnerPaths } from '../../mac/src/runner/paths.ts';
import { currentSession, sessionAlive } from '../../mac/src/runner/session.ts';
import { DEFAULT_OPTIONS, errCode, hotspotActive, markdownTable, runDrift, StopError, summarize, type DriftEnv, type Json } from './lib.ts';

const OUT = join(dirname(fileURLToPath(import.meta.url)), 'out');
const TMP = join(OUT, 'tmp');
const EXIT = { 'not-wired': 5, hotspot: 6, session: 7, channel: 7 } as const;

function now(): number {
  return Math.round((performance.timeOrigin + performance.now()) * 10) / 10;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Registro em memória, gravado entre rajadas (`flush`): nada de escrita em disco no meio de uma rajada. */
class Recorder {
  readonly path: string;
  #buffer: string[] = [];

  constructor(label: string) {
    mkdirSync(TMP, { recursive: true });
    this.path = join(OUT, `${label}.ndjson`);
    if (existsSync(this.path)) throw new Error(`${this.path} já existe: use outro --label`);
  }

  write(k: string, data: Json = {}): void {
    this.#buffer.push(JSON.stringify({ k, m: now(), ...data }));
  }

  flush(): void {
    if (this.#buffer.length === 0) return;
    appendFileSync(this.path, `${this.#buffer.join('\n')}\n`);
    this.#buffer = [];
  }
}

function macOnHotspot(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('/sbin/ifconfig', [], { timeout: 5_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => resolve(error === null && hotspotActive(stdout)));
  });
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

function num(opts: Map<string, string>, key: string, fallback: number): number {
  const v = opts.get(key);
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`--${key} inválido: ${v}`);
  return n;
}

async function cmdRun(opts: Map<string, string>): Promise<void> {
  const label = opts.get('label') ?? `run-${Date.now()}`;
  const options = {
    ...DEFAULT_OPTIONS,
    durationMs: num(opts, 'minutes', DEFAULT_OPTIONS.durationMs / 60_000) * 60_000,
    everyMs: num(opts, 'every-s', DEFAULT_OPTIONS.everyMs / 1000) * 1000,
  };
  const config = loadConfig();
  const session = currentSession(runnerPaths(config));
  if (session === undefined || !sessionAlive(session)) {
    console.error('sp14: o runner não está de pé: o orquestrador sobe `bin/contrarregra runner up --spike`');
    process.exitCode = 1;
    return;
  }
  const rec = new Recorder(label);
  rec.write('session', { sessionId: session.sessionId, configuration: session.configuration, spike: session.spike, bind: session.bind ?? 'loopback', port: session.port, node: process.version });
  const onSignal = (signal: string): void => {
    rec.write('end', { why: 'signal', signal });
    rec.flush();
    process.exit(130);
  };
  process.once('SIGINT', () => onSignal('SIGINT'));
  process.once('SIGTERM', () => onSignal('SIGTERM'));

  const env: DriftEnv = {
    hr: () => process.hrtime.bigint(),
    sleep,
    write: (k, d) => rec.write(k, d),
    flush: () => rec.flush(),
    log: (line) => console.log(`${new Date().toISOString()} ${line}`),
    openSync: () => openRunner(config, { role: 'sync', session }),
    openControl: () => openRunner(config, { role: 'control', session }),
    hotspot: macOnHotspot,
    sessionAlive: () => sessionAlive(session),
    transport: () => readDeviceTransport({ udid: config.device.udid, coreDeviceId: config.device.coreDeviceId, outDir: TMP }),
  };
  try {
    const r = await runDrift(env, options);
    console.log(`sp14: ${r.bursts} rajadas, ${r.ok} trocas boas, ${r.errors} erros, ${r.reopens} reaberturas`);
  } catch (error) {
    rec.write('end', { why: 'error', err: errCode(error), kind: error instanceof StopError ? error.kind : null });
    rec.flush();
    if (!(error instanceof StopError)) throw error;
    console.error(`sp14: parado — ${error.message}`);
    process.exitCode = EXIT[error.kind];
  }
  try {
    analyze(label);
  } catch (error) {
    console.error(`sp14: análise — ${errCode(error)}`);
  }
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

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const opts = args(rest);
  switch (command) {
    case 'run':
      await cmdRun(opts);
      break;
    case 'analyze':
      analyze(opts.get('label') ?? '');
      break;
    default:
      console.error('uso: sp14.ts run|analyze --label <l> [--minutes 20] [--every-s 10]');
      process.exitCode = 2;
  }
}

main().then(
  () => process.exit(process.exitCode ?? 0),
  (error: unknown) => {
    console.error(`sp14: ${errCode(error)}`);
    process.exit(1);
  },
);
