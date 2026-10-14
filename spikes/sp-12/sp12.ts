// Driver do SP-12 parte 1 (T-0.30; S1 item 2, SM-5, AC-1.11, AC-2.8): o runner de pé por 4 h no cabo com comandos
// periódicos e 10 tipos de falha induzida. Código de spike, descartável (architecture.md A5). Usa o cliente de produção
// (`openRunner`, `RunnerLink`, `installSeverHandler` de `mac/src/runner`, T-0.10), o leitor do `devicectl` de
// `mac/src/device` e o repassador usbmux de `mac/src/usbmux`; a lógica fica em `lib.ts` (testada sem aparelho em
// `sp12.test.ts`).
//
// O que roda no aparelho: `health`/`clock.ping` (fila de controle) e, na fila do XCTest, só leituras do app alvo
// (`screen.shot` JPEG, `ui.find`, `ui.tree`), `app.activate|terminate` do app alvo e as falhas de `lib.ts`. Nunca liga o
// modo avião, nunca usa PX-4, nunca grava nada em disco além de `out/` (capturas ficam só em memória). Memória do runner
// pelo template "Activity Monitor" do `xctrace` (Xcode 26.6), só leitura.
//
// Uso (Node 22 ≥ 22.18, TypeScript direto; ver spikes/SP-12.md):
//   caffeinate -ims node spikes/sp-12/sp12.ts run --label <l> [--pilot] [--hours 4] [--up] [--no-f10]
//   node spikes/sp-12/sp12.ts analyze --label <l>
//   node spikes/sp-12/sp12.ts child --mode idle|bigshot      (uso interno das falhas F7/F9)
// Saída bruta: uma linha JSON por amostra em spikes/sp-12/out/<label>.ndjson (pasta ignorada pelo git); resumo em
// <label>-summary.json e a tabela em Markdown na saída padrão. Códigos de saída: 1 = erro; 5 = Acesso Pessoal ligado;
// 6 = outra sessão tomou o aparelho; 7 = `runner up` falhou; 8 = sem runner; 130 = SIGINT/SIGTERM.

import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '../../mac/src/core/config.ts';
import { readDeviceTransport, XCRUN_PATH } from '../../mac/src/device/devicectl.ts';
import { openRunner } from '../../mac/src/runner/client.ts';
import { installSeverHandler, RunnerLink, SEVER_FILE } from '../../mac/src/runner/link.ts';
import { REPO_ROOT, runnerPaths } from '../../mac/src/runner/paths.ts';
import { currentSession, processAlive } from '../../mac/src/runner/session.ts';
import { startForwarder } from '../../mac/src/usbmux/forwarder.ts';
import {
  defaultPlan,
  errCode,
  hotspotActive,
  markdown,
  parseRows,
  parseXctraceTable,
  pilotPlan,
  processMemory,
  r1,
  runEndurance,
  RUNNER_EXE,
  StopError,
  summarize,
  type EnduranceEnv,
  type Json,
  type MemSample,
  type PidSample,
  type RawStep,
  type SessionRef,
  type Spawned,
  type UpResult,
} from './lib.ts';

const SELF = fileURLToPath(import.meta.url);
const OUT = join(dirname(SELF), 'out');
const TMP = join(OUT, 'tmp');
const EXIT = { hotspot: 5, takeover: 6, 'up-failed': 7, 'no-session': 8, signal: 130 } as const;

function now(): number {
  return Math.round((performance.timeOrigin + performance.now()) * 10) / 10;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class Recorder {
  readonly path: string;
  constructor(label: string) {
    mkdirSync(TMP, { recursive: true });
    this.path = join(OUT, `${label}.ndjson`);
    if (existsSync(this.path)) throw new Error(`${this.path} já existe: use outro --label`);
  }
  write(k: string, data: Json = {}): void {
    appendFileSync(this.path, `${JSON.stringify({ k, m: now(), ...data })}\n`);
  }
}

/** Processos filhos vivos (mortos na saída: nada fica órfão). */
const children = new Set<ChildProcess>();

function track(child: ChildProcess): ChildProcess {
  children.add(child);
  child.once('exit', () => children.delete(child));
  return child;
}

function killChildren(): void {
  for (const child of children) child.kill('SIGKILL');
}

function run(file: string, args: string[], timeoutMs: number): Promise<{ ok: boolean; code: number | null; out: string; ms: number }> {
  const t0 = performance.now();
  return new Promise((resolve) => {
    const child = track(execFile(file, args, { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, killSignal: 'SIGKILL' }, (error, stdout, stderr) => {
      const code = error === null ? 0 : typeof (error as NodeJS.ErrnoException & { code?: unknown }).code === 'number' ? ((error as unknown as { code: number }).code) : null;
      resolve({ ok: error === null, code, out: `${stdout}${stderr}`, ms: Math.round(performance.now() - t0) });
    }));
    void child;
  });
}

function readJsonFile(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  } finally {
    rmSync(path, { force: true });
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

function makeEnv(rec: Recorder): EnduranceEnv {
  const config = loadConfig();
  const paths = runnerPaths(config);
  const targetBundle = config.app.explore;
  if (targetBundle === undefined || targetBundle === '') throw new Error('sem app.explore no config.json: o SP-12 opera só o app alvo');
  const severDir = join(TMP, 'sever');
  mkdirSync(severDir, { recursive: true });
  let currentSync: RunnerLink | undefined;
  installSeverHandler(severDir, () => (currentSync === undefined ? [] : [currentSync]));

  const toRef = (): SessionRef | undefined => {
    const s = currentSession(paths);
    return s === undefined ? undefined : { sessionId: s.sessionId, xcodebuildPid: s.xcodebuildPid, xctestrun: s.xctestrun, log: s.log, startedAt: s.startedAt };
  };

  return {
    now,
    sleep,
    write: (k, d) => rec.write(k, d),
    log: (line) => console.log(`${new Date().toISOString()} ${line}`),
    targetBundle,
    targetName: /hagah/i,
    session: toRef,
    sessionAlive: (s) => processAlive(s.xcodebuildPid, s.xctestrun),
    openControl: () => openRunner(config, { role: 'control' }),
    openSync: async () => {
      const link = await RunnerLink.connect(config, {
        role: 'sync',
        onStateChange: (state, error) => rec.write('link', { state, ...(error === undefined ? {} : { err: errCode(error) }) }),
      });
      currentSync = link;
      return {
        get state() {
          return link.state;
        },
        get reconnects() {
          return link.reconnects;
        },
        call: (method, params, options) => link.call(method, params, options),
        close: async () => {
          if (currentSync === link) currentSync = undefined;
          await link.close();
        },
      };
    },
    severSync: async (forS) => {
      writeFileSync(join(severDir, SEVER_FILE), `${JSON.stringify({ forS })}\n`);
      process.kill(process.pid, 'SIGUSR1');
      await sleep(50);
    },
    hotspot: async () => {
      const r = await run('/sbin/ifconfig', [], 10_000);
      return r.ok && hotspotActive(r.out);
    },
    devicePids: async (): Promise<PidSample> => {
      const file = join(TMP, `dc-${process.pid}-${randomBytes(4).toString('hex')}.json`);
      const r = await run(XCRUN_PATH, ['devicectl', 'device', 'info', 'processes', '--device', config.device.coreDeviceId, '--json-output', file], 30_000);
      const json = readJsonFile(file) as { result?: { runningProcesses?: Json[] } } | undefined;
      const procs = json?.result?.runningProcesses;
      if (!r.ok || !Array.isArray(procs)) return { ok: false, dt: r.ms, runner: [], target: [], err: `exit ${r.code ?? '?'}` };
      const exe = (p: Json): string => String(p['executable'] ?? '');
      const base = (p: Json): string => exe(p).split('/').filter(Boolean).pop() ?? '';
      return {
        ok: true,
        dt: r.ms,
        runner: procs.filter((p) => base(p) === RUNNER_EXE).map((p) => Number(p['processIdentifier'])),
        target: procs.filter((p) => /hagah/i.test(exe(p))).map((p) => Number(p['processIdentifier'])),
      };
    },
    transport: async () => {
      const t0 = performance.now();
      const t = await readDeviceTransport({ udid: config.device.udid, coreDeviceId: config.device.coreDeviceId, outDir: TMP, timeoutMs: 20_000 });
      return { tt: t?.transportType ?? null, ts: t?.tunnelState ?? null, dt: Math.round(performance.now() - t0) };
    },
    memory: async (): Promise<MemSample> => {
      const t0 = performance.now();
      const dir = join(TMP, `am-${process.pid}-${randomBytes(4).toString('hex')}`);
      mkdirSync(dir, { recursive: true });
      const trace = join(dir, 'am.trace');
      const xml = join(dir, 'live.xml');
      try {
        const recd = await run(XCRUN_PATH, ['xctrace', 'record', '--device', config.device.udid, '--template', 'Activity Monitor', '--all-processes', '--time-limit', '3s', '--output', trace, '--no-prompt'], 90_000);
        if (!recd.ok) return { ok: false, ms: Math.round(performance.now() - t0), err: `record exit ${recd.code ?? '?'}: ${recd.out.slice(-200)}`, procs: [] };
        const exp = await run(XCRUN_PATH, ['xctrace', 'export', '--input', trace, '--xpath', '/trace-toc/run[@number="1"]/data/table[@schema="activity-monitor-process-live"]', '--output', xml], 90_000);
        if (!exp.ok || !existsSync(xml)) return { ok: false, ms: Math.round(performance.now() - t0), err: `export exit ${exp.code ?? '?'}: ${exp.out.slice(-200)}`, procs: [] };
        const procs = processMemory(parseXctraceTable(readFileSync(xml, 'utf8')));
        return { ok: procs.length > 0, ms: Math.round(performance.now() - t0), procs, ...(procs.length > 0 ? {} : { err: 'tabela vazia' }) };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    macMem: async (s) => {
      const r = await run('/bin/ps', ['-o', 'rss=', '-p', String(s.xcodebuildPid)], 5_000);
      const kb = Number(r.out.trim());
      return { xcodebuildPid: s.xcodebuildPid, xcodebuildKb: r.ok && Number.isFinite(kb) ? kb : null, driverRssMB: r1(process.memoryUsage().rss / 1e6) };
    },
    spawnClient: (mode) =>
      new Promise<Spawned>((resolve, reject) => {
        const child = track(spawn(process.execPath, [SELF, 'child', '--mode', mode], { stdio: ['ignore', 'pipe', 'pipe'] }));
        const exited = new Promise<unknown>((r) => child.once('exit', (code, signal) => r({ code, signal })));
        let buf = '';
        let err = '';
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          reject(new Error(`o filho (${mode}) não abriu a control em 20 s: ${err.slice(-200)}`));
        }, 20_000);
        child.stderr?.on('data', (d: Buffer) => (err += d.toString()));
        child.stdout?.on('data', (d: Buffer) => {
          buf += d.toString();
          if (/^(ready|sent)$/m.test(buf)) {
            clearTimeout(timer);
            resolve({ pid: child.pid ?? -1, kill: () => child.kill('SIGKILL'), exited });
          }
        });
        child.once('exit', (code) => {
          clearTimeout(timer);
          if (!/^(ready|sent)$/m.test(buf)) reject(new Error(`o filho (${mode}) saiu (${code}) antes de abrir a control: ${err.slice(-200)}`));
        });
      }),
    rawProbe: (step: RawStep) => rawProbe(config, step),
    killPid: (pid) => {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // já saiu
      }
    },
    runnerUp: async (): Promise<UpResult> => {
      const r = await run(join(REPO_ROOT, 'bin', 'contrarregra'), ['runner', 'up', '--spike'], 200_000);
      return { ok: r.ok, ms: r.ms, code: r.code, out: r.out.slice(-2000) };
    },
    readLog: (path) => {
      try {
        return readFileSync(path, 'utf8');
      } catch {
        return undefined;
      }
    },
  };
}

/**
 * Uma conexão crua (repassador usbmux + WebSocket nativo, sem o cliente de produção) para os pedidos inválidos de F4:
 * `garbage` = texto que não é JSON; `no-hello` = `health` antes do `session.hello`; `bad-token` = hello com token
 * errado. Devolve a primeira coisa que o runner fizer (resposta, fechamento ou silêncio por 3 s).
 */
async function rawProbe(config: ReturnType<typeof loadConfig>, step: RawStep): Promise<{ outcome: string; ms: number }> {
  const session = currentSession(runnerPaths(config));
  if (session === undefined) throw new Error('sem sessão');
  const fwd = await startForwarder({ socketPath: config.usbmux.socketPath, udid: config.device.udid, port: session.port });
  try {
    const ws = new WebSocket(`ws://${fwd.host}:${fwd.port}/`);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('WebSocket não abriu em 5 s')), 5_000);
      ws.addEventListener('open', () => {
        clearTimeout(timer);
        resolve();
      });
      ws.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error('WebSocket: erro ao abrir'));
      });
    });
    const t0 = performance.now();
    const outcome = new Promise<string>((resolve) => {
      const timer = setTimeout(() => resolve('silêncio 3 s'), 3_000);
      ws.addEventListener('message', (event) => {
        clearTimeout(timer);
        let text = String(event.data);
        try {
          const msg = JSON.parse(text) as { error?: { code?: number; message?: string }; result?: unknown };
          text = msg.error ? `erro ${msg.error.code} ${String(msg.error.message ?? '').slice(0, 80)}` : `result ${JSON.stringify(msg.result).slice(0, 80)}`;
        } catch {
          text = `texto ${text.slice(0, 80)}`;
        }
        resolve(text);
      });
      ws.addEventListener('close', (event) => {
        clearTimeout(timer);
        resolve(`fechou ${event.code}`);
      });
    });
    if (step === 'garbage') ws.send('{isto não é json');
    else if (step === 'no-hello') ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'health', params: {} }));
    else ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'session.hello', params: { token: 'sp12-token-errado', role: 'control', client: { name: 'sp12', pid: process.pid } } }));
    const result = await outcome;
    const ms = Math.round(performance.now() - t0);
    try {
      ws.close();
    } catch {
      // já fechado
    }
    await sleep(100);
    return { outcome: result, ms };
  } finally {
    await fwd.close();
  }
}

async function cmdRun(opts: Map<string, string>): Promise<void> {
  const label = opts.get('label') ?? `run-${Date.now()}`;
  const plan = opts.has('pilot') ? pilotPlan() : defaultPlan(Number(opts.get('hours') ?? 4));
  if (opts.has('no-f10')) plan.f10 = false;
  const rec = new Recorder(label);
  const env = makeEnv(rec);
  const onSignal = (signal: string): void => {
    rec.write('end', { why: 'signal', signal });
    killChildren();
    process.exit(EXIT.signal);
  };
  process.once('SIGINT', () => onSignal('SIGINT'));
  process.once('SIGTERM', () => onSignal('SIGTERM'));
  rec.write('env', { node: process.version, pid: process.pid, label, plan: plan.name, up: opts.has('up') });
  env.log(`sp12: ${plan.name}, ${Math.round(plan.durationMs / 60_000)} min, F10 ${plan.f10 ? 'sim' : 'não'}; registro ${rec.path}`);
  try {
    const r = await runEndurance(env, plan, { up: opts.has('up') });
    env.log(`sp12: fim (${r.why}); ${r.ticks} ticks, ${r.failures} falhas, ${r.restarts} religamentos espontâneos`);
    if (r.stop !== undefined) process.exitCode = EXIT[r.stop];
  } catch (error) {
    rec.write('end', { why: 'error', err: errCode(error), kind: error instanceof StopError ? error.kind : null });
    env.log(`sp12: parado — ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = error instanceof StopError ? EXIT[error.kind] : 1;
  } finally {
    killChildren();
  }
  try {
    analyze(label);
  } catch (error) {
    console.error(`sp12: análise — ${errCode(error)}`);
  }
}

function analyze(label: string): void {
  const rows = parseRows(readFileSync(join(OUT, `${label}.ndjson`), 'utf8'));
  const summary = summarize(label, rows);
  writeFileSync(join(OUT, `${label}-summary.json`), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(markdown(summary));
}

/** Filho das falhas F7/F9: abre a `control` e espera o SIGKILL do pai (sozinho, sai em 2 min). */
async function cmdChild(opts: Map<string, string>): Promise<void> {
  const mode = opts.get('mode') === 'bigshot' ? 'bigshot' : 'idle';
  const c = await openRunner(loadConfig(), { role: 'control' });
  if (mode === 'bigshot') {
    void c.call('screen.shot', { format: 'png', scale: 'native' }, { timeoutMs: 30_000 }).catch(() => undefined);
    await sleep(50);
    process.stdout.write('sent\n');
  } else {
    process.stdout.write('ready\n');
  }
  await sleep(120_000);
  await c.close();
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
    case 'child':
      await cmdChild(opts);
      break;
    default:
      console.error('uso: sp12.ts run --label <l> [--pilot] [--hours 4] [--up] [--no-f10] | analyze --label <l>');
      process.exitCode = 2;
  }
}

main().then(
  () => process.exit(process.exitCode ?? 0),
  (error: unknown) => {
    console.error(`sp12: ${errCode(error)}`);
    killChildren();
    process.exit(1);
  },
);
