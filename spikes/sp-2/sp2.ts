// Driver do SP-2 (T-0.17; HC-4, S2, ADR-10): o túnel CoreDevice (`wired` × `localNetwork`) e a sessão do XCTest
// do runner × modo avião. Código de spike, descartável (architecture.md A5); usa o cliente JSON-RPC de
// `mac/src/runner` (T-0.10) e o leitor do `devicectl` de `mac/src/device`.
//
// Nunca toca no modo avião nem em Ajustes: quem liga e desliga é o dono, à mão, guiado pela voz do Mac
// (`say -v Luciana`); o driver só anuncia, registra o instante de cada anúncio e mede.
//
// Uso (Node 22 ≥ 22.18, TypeScript direto; ver spikes/SP-2.md):
//   node spikes/sp-2/sp2.ts transport --label <l> --seconds <n> [--wake] [--procedure] [--lead <s>]
//   node spikes/sp-2/sp2.ts airplane  --label <l> --rounds <n> [--on 60] [--off 60] [--lead 20] [--tail 60]
//                                     [--pre <s>] [--warn <s>] [--hz 10] [--intro <texto>]
//                                     [--state-every <s>] [--state-timeout <s>]
//   node spikes/sp-2/sp2.ts auto      --label <l> --rounds 10 [--on 60] [--off 60] [--pre 60] [--tail 60] [--hz 10]
//                                     (o runner alterna o avião pela Central de Controle)
//   node spikes/sp-2/sp2.ts analyze   --label <l>
//   node spikes/sp-2/sp2.ts announce  --label <l> --step <passo> --text <texto>   (anúncio avulso, registrado)
// `airplane --rounds 0 --pre <s>` é a observação sem anúncios (estabilidade). Saída bruta: uma linha JSON por
// amostra em spikes/sp-2/out/<label>.ndjson (pasta ignorada pelo git); resumo em <label>-summary.json.

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig, type Config } from '../../mac/src/core/config.ts';
import { isContrarregraError } from '../../mac/src/core/errors.ts';
import type { HealthResult } from '../../mac/src/core/types.ts';
import { parseDevicectlList, XCRUN_PATH } from '../../mac/src/device/devicectl.ts';
import { RunnerLink } from '../../mac/src/runner/link.ts';
import { runnerPaths } from '../../mac/src/runner/paths.ts';
import { currentSession, sessionAlive, type SessionState } from '../../mac/src/runner/session.ts';
import { findUsbDevice } from '../../mac/src/usbmux/client.ts';

const OUT = join(dirname(fileURLToPath(import.meta.url)), 'out');
const TMP = join(OUT, 'tmp');
const VOICE = 'Luciana';
/** O executável do runner no aparelho (o XCTRunner renomeado pelo Xcode). */
const RUNNER_EXE = 'ContrarregraRunner-Runner';
/** O que procurar no registro do `xcodebuild` da sessão (o runner repassa a saída dele por lá). */
const LOG_PATTERNS = [
  'IDE disconnection',
  'Exiting due to',
  'Lost connection',
  'lost connection',
  'Test runner exited',
  'Early unexpected exit',
  'interrupted',
  'TEST EXECUTE FAILED',
  'Testing failed',
  'crash',
];

type Json = Record<string, unknown>;

/** Relógio de parede em ms, contínuo dentro do processo (timeOrigin + performance.now()). */
function now(): number {
  return Math.round((performance.timeOrigin + performance.now()) * 10) / 10;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errCode(error: unknown): string {
  if (isContrarregraError(error)) return `${error.code}${typeof error.data?.['reason'] === 'string' ? `/${error.data['reason']}` : ''}`;
  if (error instanceof Error) return error.message.slice(0, 160);
  return String(error).slice(0, 160);
}

// ---------------------------------------------------------------------------------------------------------
// Registro

class Recorder {
  readonly path: string;
  constructor(label: string, fresh: boolean) {
    mkdirSync(TMP, { recursive: true });
    this.path = join(OUT, `${label}.ndjson`);
    if (fresh && existsSync(this.path)) throw new Error(`${this.path} já existe: use outro --label`);
  }
  write(k: string, data: Json = {}): void {
    appendFileSync(this.path, `${JSON.stringify({ k, m: now(), ...data })}\n`);
  }
}

function say(rec: Recorder, text: string, meta: Json): void {
  rec.write('say', { ...meta, text });
  const child = spawn('/usr/bin/say', ['-v', VOICE, text], { stdio: 'ignore' });
  child.once('error', (error) => rec.write('say-error', { err: errCode(error) }));
}

// ---------------------------------------------------------------------------------------------------------
// devicectl (JSON só em arquivo; saída padrão e de erro descartadas)

interface DevicectlRun {
  ok: boolean;
  json: unknown;
  dtMs: number;
  err?: string;
}

async function devicectl(args: string[], timeoutMs: number): Promise<DevicectlRun> {
  const out = join(TMP, `dc-${process.pid}-${randomBytes(4).toString('hex')}.json`);
  const t0 = performance.now();
  const status = await new Promise<string>((resolve) => {
    const child = spawn(XCRUN_PATH, ['devicectl', ...args, '--json-output', out], { stdio: 'ignore' });
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
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(out, 'utf8'));
  } catch {
    json = undefined;
  } finally {
    rmSync(out, { force: true });
  }
  const dtMs = Math.round(performance.now() - t0);
  if (status === 'ok') return { ok: true, json, dtMs };
  const error = (json as { error?: { domain?: string; code?: number; userInfo?: { NSLocalizedDescription?: { string?: string } } } } | undefined)?.error;
  const detail = error === undefined ? '' : ` ${error.domain ?? ''} ${error.code ?? ''} ${error.userInfo?.NSLocalizedDescription?.string ?? ''}`.slice(0, 200);
  return { ok: false, json, dtMs, err: `${status}${detail}` };
}

/** `connectionProperties` do aparelho configurado (para registrar a leitura crua, AC-2.4 parcial). */
function connectionProperties(json: unknown, config: Config): Json | undefined {
  const devices = ((json as Json | undefined)?.['result'] as Json | undefined)?.['devices'];
  if (!Array.isArray(devices)) return undefined;
  const udid = config.device.udid.replace(/-/g, '').toUpperCase();
  for (const device of devices as Json[]) {
    const hw = device['hardwareProperties'] as Json | undefined;
    const id = typeof hw?.['udid'] === 'string' ? (hw['udid'] as string).replace(/-/g, '').toUpperCase() : '';
    if (id === udid || device['identifier'] === config.device.coreDeviceId) {
      const cp = { ...(device['connectionProperties'] as Json) };
      delete cp['potentialHostnames'];
      return cp;
    }
  }
  return undefined;
}

let savedLocalNetwork = false;

async function sampleTransport(rec: Recorder, config: Config, label: string): Promise<void> {
  const run = await devicectl(['list', 'devices'], 10_000);
  const transport = run.ok ? parseDevicectlList(run.json, config.device) : undefined;
  let usb = false;
  let usbErr: string | undefined;
  try {
    await findUsbDevice({ socketPath: config.usbmux.socketPath, udid: config.device.udid, timeoutMs: 1_000 });
    usb = true;
  } catch (error) {
    usbErr = errCode(error);
  }
  rec.write('tr', {
    tt: transport?.transportType ?? null,
    ts: transport?.tunnelState ?? null,
    listed: transport !== undefined,
    usb,
    ...(usbErr === undefined ? {} : { usbErr }),
    dt: run.dtMs,
    ...(run.ok ? {} : { err: run.err }),
  });
  if (!savedLocalNetwork && transport?.transportType === 'localNetwork' && transport.tunnelState === 'connected') {
    savedLocalNetwork = true;
    const cp = connectionProperties(run.json, config);
    writeFileSync(join(OUT, `${label}-devicectl-localNetwork.json`), `${JSON.stringify({ at: new Date().toISOString(), connectionProperties: cp }, null, 2)}\n`);
  }
}

async function samplePids(rec: Recorder, config: Config, why: string): Promise<void> {
  const run = await devicectl(['device', 'info', 'processes', '--device', config.device.coreDeviceId], 8_000);
  if (!run.ok) {
    rec.write('pid', { why, ok: false, dt: run.dtMs, err: run.err });
    return;
  }
  const procs = (((run.json as Json)['result'] as Json | undefined)?.['runningProcesses'] ?? []) as Json[];
  const mine = procs
    .filter((p) => String(p['executable']).includes('Contrarregra'))
    .map((p) => ({ exe: String(p['executable']).split('/').filter(Boolean).pop() ?? '', pid: p['processIdentifier'] }));
  const runner = mine.filter((p) => p.exe === RUNNER_EXE).map((p) => p.pid);
  rec.write('pid', { why, ok: true, dt: run.dtMs, runner, mine });
}

// ---------------------------------------------------------------------------------------------------------
// Laços

class Loops {
  #timers: NodeJS.Timeout[] = [];
  #stopped = false;
  get stopped(): boolean {
    return this.#stopped;
  }
  /** Repete `fn` a cada `ms` (do começo de uma ao começo da próxima), sem sobrepor. */
  every(ms: number, fn: () => Promise<void> | void): void {
    const tick = async (): Promise<void> => {
      if (this.#stopped) return;
      const t0 = performance.now();
      try {
        await fn();
      } catch {
        // cada amostra registra o próprio erro
      }
      if (this.#stopped) return;
      this.#timers.push(setTimeout(() => void tick(), Math.max(0, ms - (performance.now() - t0))));
    };
    void tick();
  }
  at(epochMs: number, fn: () => void): void {
    this.#timers.push(setTimeout(() => !this.#stopped && fn(), Math.max(0, epochMs - Date.now())));
  }
  stop(): void {
    this.#stopped = true;
    for (const timer of this.#timers) clearTimeout(timer);
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

function num(opts: Map<string, string>, key: string, fallback: number): number {
  const v = opts.get(key);
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`--${key} inválido: ${v}`);
  return n;
}

function waitForStop(loops: Loops, untilEpochMs: number): Promise<string> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve('done'), Math.max(0, untilEpochMs - Date.now()));
    const onSignal = (signal: string): void => {
      clearTimeout(timer);
      resolve(signal);
    };
    process.once('SIGINT', () => onSignal('SIGINT'));
    process.once('SIGTERM', () => onSignal('SIGTERM'));
    void loops;
  });
}

// transport: só o túnel (1 Hz), com `--wake` pedindo o túnel (processes a cada 2 s) e `--procedure` anunciando o
// procedimento de forçar o cabo (Wi-Fi do iPhone desligado em Ajustes por 10 s e religado).
async function cmdTransport(opts: Map<string, string>): Promise<void> {
  const label = opts.get('label') ?? 'transport';
  const seconds = num(opts, 'seconds', 120);
  const config = loadConfig();
  const rec = new Recorder(label, true);
  const loops = new Loops();
  const start = Date.now();
  rec.write('start', { mode: 'transport', seconds, wake: opts.has('wake'), procedure: opts.has('procedure') });
  loops.every(1_000, () => sampleTransport(rec, config, label));
  if (opts.has('wake')) loops.every(2_000, () => samplePids(rec, config, 'wake'));
  if (opts.has('procedure')) {
    const lead = num(opts, 'lead', 15) * 1000;
    say(rec, `Procedimento do cabo. Em ${Math.round(lead / 1000)} segundos, desligue o Wi-Fi do iPhone em Ajustes.`, { step: 'intro' });
    loops.at(start + lead, () => say(rec, 'Desligue o Wi-Fi do iPhone agora.', { step: 'wifi-off' }));
    loops.at(start + lead + 10_000, () => say(rec, 'Ligue o Wi-Fi do iPhone de novo agora.', { step: 'wifi-on' }));
  }
  const why = await waitForStop(loops, start + seconds * 1000);
  loops.stop();
  rec.write('end', { why });
  console.log(JSON.stringify(analyze(label), null, 2));
}

// airplane: runner de pé; health a <hz> Hz, device.state a 1 Hz, túnel a 1 Hz, PIDs a cada 10 s e em cada
// anúncio, vida do xcodebuild a 1 Hz. `--pre` = observação sem anúncios antes das rodadas.
async function cmdAirplane(opts: Map<string, string>): Promise<void> {
  const label = opts.get('label') ?? 'airplane';
  const rounds = num(opts, 'rounds', 10);
  const onS = num(opts, 'on', 60);
  const offS = num(opts, 'off', 60);
  const leadS = num(opts, 'lead', 20);
  const tailS = num(opts, 'tail', 60);
  const preS = num(opts, 'pre', 0);
  const warnS = num(opts, 'warn', 0);
  const hz = num(opts, 'hz', 10);
  const config = loadConfig();
  const paths = runnerPaths(config);
  const session: SessionState | undefined = currentSession(paths);
  if (session === undefined || !sessionAlive(session)) throw new Error('o runner não está de pé: rode bin/contrarregra runner up');
  const rec = new Recorder(label, true);
  const loops = new Loops();

  const link = await RunnerLink.connect(config, {
    role: 'control',
    onStateChange: (state, error) => rec.write('link', { state, ...(error === undefined ? {} : { err: errCode(error) }) }),
  });
  const start = Date.now();
  rec.write('start', {
    mode: 'airplane',
    rounds,
    onS,
    offS,
    leadS,
    tailS,
    preS,
    hz,
    sessionId: session.sessionId,
    xcodebuildPid: session.xcodebuildPid,
    sessionStartedAt: session.startedAt,
    log: session.log,
  });

  // health a <hz> Hz pela linha (que reconecta sozinha como em S2 item 6).
  let seq = 0;
  let outstanding = 0;
  let downTicks = 0;
  let lastFg: string | undefined;
  let lastLocked: boolean | undefined;
  const healthTimer = setInterval(() => {
    const i = seq++;
    if (link.state !== 'up') {
      downTicks++;
      return;
    }
    if (outstanding >= 30) return;
    outstanding++;
    const s = now();
    link.call<HealthResult>('health', {}, { timeoutMs: 1_000 }).then(
      (r) => {
        const extra: Json = {};
        if (r.foregroundApp !== lastFg) extra['fg'] = lastFg = r.foregroundApp;
        if (r.locked !== lastLocked) extra['lk'] = lastLocked = r.locked;
        rec.write('h', { i, s, r: now(), up: r.uptimeS, ...extra });
      },
      (error: unknown) => rec.write('h', { i, s, f: now(), err: errCode(error) }),
    ).finally(() => {
      outstanding--;
    });
  }, 1000 / hz);

  // device.state a cada <state-every> s: `network` (online/offline) confirma quando o avião ligou de fato. Vai pela
  // fila do XCTest (consultas ao SpringBoard, ~1–2 s cada com a Central de Controle aberta): espaçado e com prazo
  // longo para não empilhar chamadas no runner.
  const stateEveryMs = num(opts, 'state-every', 1) * 1000;
  const stateTimeoutMs = num(opts, 'state-timeout', 3) * 1000;
  loops.every(stateEveryMs, async () => {
    if (link.state !== 'up') return;
    const s = now();
    try {
      const st = await link.call<Json>('device.state', {}, { timeoutMs: stateTimeoutMs });
      rec.write('st', { s, r: now(), net: st['network'] ?? null, lk: st['locked'] ?? null, fg: st['foregroundApp'] ?? null });
    } catch (error) {
      rec.write('st', { s, f: now(), err: errCode(error) });
    }
  });
  loops.every(1_000, () => sampleTransport(rec, config, label));
  loops.every(10_000, () => samplePids(rec, config, 'periodic'));
  let lastAlive: boolean | undefined;
  loops.every(1_000, () => {
    const alive = sessionAlive(session);
    if (alive !== lastAlive) rec.write('xcb', { alive, pid: session.xcodebuildPid });
    lastAlive = alive;
  });

  // Anúncios.
  const t0 = start + preS * 1000;
  if (rounds > 0) {
    if (warnS > 0 && preS > warnS) {
      loops.at(t0 - warnS * 1000, () =>
        say(
          rec,
          `Atenção: o teste do modo avião começa em ${warnS < 120 ? `${Math.round(warnS + leadS)} segundos` : `${Math.round(warnS / 60)} minutos`}. Fique com o iPhone na mão.`,
          { step: 'warn' },
        ),
      );
    }
    const intro =
      opts.get('intro') ??
      `Teste do modo avião. ${rounds} ${rounds === 1 ? 'rodada' : 'rodadas'}: um minuto ligado, um minuto desligado. Começa em ${leadS} segundos.`;
    loops.at(t0, () => say(rec, intro, { step: 'intro' }));
    for (let r = 1; r <= rounds; r++) {
      const onAt = t0 + leadS * 1000 + (r - 1) * (onS + offS) * 1000;
      const offAt = onAt + onS * 1000;
      loops.at(onAt - 3_000, () => void samplePids(rec, config, `before-on-${r}`));
      loops.at(onAt, () => say(rec, `Rodada ${r} de ${rounds}. Ligue o modo avião agora.`, { step: 'on', round: r }));
      loops.at(offAt - 3_000, () => void samplePids(rec, config, `before-off-${r}`));
      loops.at(offAt, () => say(rec, `Rodada ${r} de ${rounds}. Desligue o modo avião agora.`, { step: 'off', round: r }));
    }
  }
  const endAt = rounds > 0 ? t0 + leadS * 1000 + rounds * (onS + offS) * 1000 + tailS * 1000 : t0;
  if (rounds > 0) {
    // Depois da última rodada: o dono solta o iPhone; a observação segue sozinha até o fim (`--tail`).
    const lastOffAt = t0 + leadS * 1000 + rounds * (onS + offS) * 1000 - offS * 1000;
    if (tailS > 60) {
      loops.at(lastOffAt + 20_000, () =>
        say(rec, 'Fim das rodadas. Deixe o modo avião desligado. Pode soltar o iPhone; ele fica sozinho no cabo até o fim.', { step: 'done' }),
      );
    }
    loops.at(endAt - Math.min(tailS, 15) * 1000, () => say(rec, 'Fim do teste do modo avião.', { step: 'end' }));
  }

  const why = await waitForStop(loops, endAt);
  loops.stop();
  clearInterval(healthTimer);
  await samplePids(rec, config, 'final');
  rec.write('end', { why, downTicks, reconnects: link.reconnects, xcodebuildAlive: sessionAlive(session) });
  await link.close();
  console.log(JSON.stringify(analyze(label), null, 2));
}

// auto: o PRÓPRIO runner liga e desliga o modo avião pela Central de Controle (device.controlCenter open → wait.for
// {airplane: <antigo>} → ui.tap no interruptor `airplane-mode-button` → wait.for {airplane: <novo>} → device.controlCenter
// close), <on> s ligado / <off> s desligado × <rounds>; depois de cada troca, wait.for {network: offline|online} (não lê
// a tela). O dono não age; a voz só avisa. Medidas como em `airplane`: health a <hz> Hz com `xctestQueueDepth`, PIDs a
// cada 10 s, vida do xcodebuild e túnel a 1 Hz. Tudo da fila do XCTest em série, nunca duas chamadas ao mesmo tempo.
// Se a sessão cair: com o avião possivelmente ligado, anuncia e sai com código 3 (o dono desliga o avião); senão, 4.
const AIRPLANE_TARGET = { app: 'springboard', identifier: 'airplane-mode-button' };

async function cmdAuto(opts: Map<string, string>): Promise<number> {
  const label = opts.get('label') ?? 'auto';
  const rounds = num(opts, 'rounds', 10);
  const onS = num(opts, 'on', 60);
  const offS = num(opts, 'off', 60);
  const preS = num(opts, 'pre', 60);
  const tailS = num(opts, 'tail', 60);
  const hz = num(opts, 'hz', 10);
  const config = loadConfig();
  const session: SessionState | undefined = currentSession(runnerPaths(config));
  if (session === undefined || !sessionAlive(session)) throw new Error('o runner não está de pé: rode bin/contrarregra runner up --spike');
  const rec = new Recorder(label, true);
  const loops = new Loops();
  let linkDownSince: number | undefined;
  const link = await RunnerLink.connect(config, {
    role: 'control',
    onStateChange: (state, error) => {
      linkDownSince = state === 'up' ? undefined : (linkDownSince ?? Date.now());
      rec.write('link', { state, ...(error === undefined ? {} : { err: errCode(error) }) });
    },
  });
  const start = Date.now();
  rec.write('start', {
    mode: 'auto', rounds, onS, offS, preS, tailS, hz,
    sessionId: session.sessionId, configuration: session.configuration, xcodebuildPid: session.xcodebuildPid,
    sessionStartedAt: session.startedAt, log: session.log,
  });

  // health a <hz> Hz, com a profundidade da fila do XCTest.
  let seq = 0;
  let outstanding = 0;
  let downTicks = 0;
  let lastFg: string | undefined;
  let lastLocked: boolean | undefined;
  const healthTimer = setInterval(() => {
    const i = seq++;
    if (link.state !== 'up') {
      downTicks++;
      return;
    }
    if (outstanding >= 30) return;
    outstanding++;
    const s = now();
    link.call<HealthResult>('health', {}, { timeoutMs: 1_000 }).then(
      (r) => {
        const extra: Json = {};
        if (r.foregroundApp !== lastFg) extra['fg'] = lastFg = r.foregroundApp;
        if (r.locked !== lastLocked) extra['lk'] = lastLocked = r.locked;
        rec.write('h', { i, s, r: now(), up: r.uptimeS, q: r.xctestQueueDepth, ...extra });
      },
      (error: unknown) => rec.write('h', { i, s, f: now(), err: errCode(error) }),
    ).finally(() => {
      outstanding--;
    });
  }, 1000 / hz);
  loops.every(1_000, () => sampleTransport(rec, config, label));
  loops.every(10_000, () => samplePids(rec, config, 'periodic'));

  // Vigia da sessão: xcodebuild morto ou conexão caída há mais de 10 s = runner caído.
  let airplane = 'unknown' as '0' | '1' | 'maybe-on' | 'unknown';
  let dead = undefined as string | undefined;
  let lastAlive: boolean | undefined;
  loops.every(1_000, () => {
    const alive = sessionAlive(session);
    if (alive !== lastAlive) rec.write('xcb', { alive, pid: session.xcodebuildPid });
    lastAlive = alive;
    if (dead === undefined && !alive) dead = 'xcodebuild-exited';
    if (dead === undefined && linkDownSince !== undefined && Date.now() - linkDownSince > 10_000) dead = 'link-down-10s';
  });

  const meta = (round: number, phase: string): Json => ({ round, phase });
  async function xop<T>(op: string, method: string, params: Json, m: Json, timeoutMs = 30_000): Promise<T> {
    const s = now();
    try {
      const result = await link.call<T>(method, params, { timeoutMs });
      rec.write('xop', { ...m, op, s, r: now() });
      return result;
    } catch (error) {
      const data = isContrarregraError(error) ? error.data : undefined;
      const msg = error instanceof Error ? error.message.slice(0, 220) : String(error);
      rec.write('xop', { ...m, op, s, f: now(), err: errCode(error), msg, ...(data?.['phase'] === undefined ? {} : { lanePhase: data['phase'] }) });
      throw error;
    }
  }
  /**
   * O interruptor lido por `wait.for {airplane}` (S0.3): o prazo do runner é `timeoutMs` + 1 s, e não os 10 s de
   * `ui.find` — com a Central aberta e o avião mudando, cada leitura do SpringBoard passa de 10 s (a leitura da tela
   * percorre as janelas uma a uma, ~0,7 s por consulta). 'yes' = vale; 'no' = a última sondagem viu o contrário;
   * 'unknown' = não se leu.
   */
  async function airplaneIs(m: Json, state: 'on' | 'off', timeoutMs: number): Promise<'yes' | 'no' | 'unknown'> {
    for (let i = 0; i < 3; i++) {
      try {
        await xop(`wait-airplane-${state}`, 'wait.for', { condition: { airplane: state }, timeoutMs }, m, timeoutMs + 15_000);
        return 'yes';
      } catch (error) {
        if (!isContrarregraError(error, 'E_TIMEOUT')) throw error;
        if (/o modo avião está (on|off)/.test(error.message)) return 'no';
        if (error.data?.['phase'] !== 'queued') return 'unknown';
      }
    }
    return 'unknown';
  }
  /** Uma chamada da fila do XCTest que pode estourar os 10 s do runner: na fila (não rodou) tenta de novo; rodando, valeu. */
  async function lenient(op: string, method: string, params: Json, m: Json, tries = 2): Promise<'ok' | 'ran-late' | 'not-run'> {
    for (let i = 0; i < tries; i++) {
      try {
        await xop(op, method, params, m);
        return 'ok';
      } catch (error) {
        if (!isContrarregraError(error, 'E_TIMEOUT')) throw error;
        if (error.data?.['phase'] !== 'queued') return 'ran-late';
      }
    }
    return 'not-run';
  }
  /**
   * Uma troca do interruptor: abre a Central; lê o interruptor (`wait.for {airplane: <antigo>}` — é a confirmação
   * pelo `value` da troca ANTERIOR, lida com o estado já parado); espera até `notBefore`; anuncia e toca; fecha a
   * Central; e confirma a troca pela rede (`wait.for {network}`, que não lê a tela). O `value` desta troca é lido na
   * abertura seguinte (ou na conferência final). Com a Central aberta, cada leitura do SpringBoard chegou a levar
   * 20–35 s (a leitura da tela percorre as janelas uma a uma), e `ui.tap`/`device.controlCenter` estouram os 10 s do
   * runner rodando (= a ação acontece, só a resposta se perde); por isso a duração de cada fase conta da confirmação
   * pela rede da troca anterior (≥ <on|off> s garantidos) e não do instante da resposta do toque.
   */
  async function toggle(round: number, want: '0' | '1', notBefore: number, phaseName?: string): Promise<{ seqStart: number; tapS: number; tapR: number; netAt: number }> {
    const phase = phaseName ?? (want === '1' ? 'on' : 'off');
    const oldState = want === '1' ? 'off' : 'on';
    const old = want === '1' ? '0' : '1';
    const m = meta(round, phase);
    const seqStart = now();
    if ((await lenient('open', 'device.controlCenter', { action: 'open' }, m, 3)) === 'not-run') throw new Error('a Central de Controle não abriu');
    let read = await airplaneIs(m, oldState, 90_000);
    if (read === 'unknown') read = await airplaneIs(m, oldState, 90_000);
    const before = read === 'yes' ? old : read === 'no' ? want : null;
    if (before === want) {
      airplane = want;
      rec.write('toggle', { ...m, before, ok: true, already: true, tapS: now(), tapR: now(), netAt: now() });
      await lenient('close', 'device.controlCenter', { action: 'close' }, m, 3);
      return { seqStart, tapS: now(), tapR: now(), netAt: now() };
    }
    if (before === null) {
      rec.write('toggle', { ...m, before, ok: false, why: 'interruptor ilegível antes do toque' });
      await lenient('close', 'device.controlCenter', { action: 'close' }, m, 3);
      throw new Error(`interruptor do modo avião ilegível antes de ${phase}`);
    }
    await until(notBefore);
    if (round > 0) say(rec, `SP-2: o runner vai ${want === '1' ? 'ligar' : 'desligar'} o modo avião, rodada ${round}.`, { step: phase, round });
    if (want === '1') airplane = 'maybe-on';
    let tapS = now();
    let tapOutcome: 'ok' | 'ran-late' | 'not-run';
    try {
      tapOutcome = await lenient('tap', 'ui.tap', { target: AIRPLANE_TARGET }, m, 3);
    } catch (error) {
      // A Central fechou sozinha durante a espera até `notBefore` (visto na rodada 6 da série auto5): reabre e toca.
      if (!isContrarregraError(error, 'E_TARGET_NOT_FOUND')) throw error;
      rec.write('cc-closed', { ...m });
      if ((await lenient('open', 'device.controlCenter', { action: 'open' }, m, 3)) === 'not-run') throw new Error('a Central de Controle não reabriu');
      tapS = now();
      tapOutcome = await lenient('tap', 'ui.tap', { target: AIRPLANE_TARGET }, m, 3);
    }
    const tapR = now();
    const closeOutcome = await lenient('close', 'device.controlCenter', { action: 'close' }, m, 3);
    const expect = want === '1' ? 'offline' : 'online';
    const netAt = tapOutcome === 'not-run' ? undefined : await netCheck(round, phase, expect, tapS, want === '1' ? 60_000 : 90_000);
    airplane = netAt !== undefined ? want : want === '1' ? 'maybe-on' : 'unknown';
    rec.write('toggle', { ...m, before, ok: netAt !== undefined, tapS, tapR, netAt: netAt ?? null, tapOutcome, closeOutcome });
    if (netAt === undefined) throw new Error(`a troca para ${want === '1' ? 'ligado' : 'desligado'} não se confirmou pela rede (toque: ${tapOutcome})`);
    return { seqStart, tapS, tapR, netAt };
  }
  /** Conferência final do `value` (a da última troca). */
  async function finalCheck(): Promise<void> {
    const m = meta(0, 'final');
    await lenient('open', 'device.controlCenter', { action: 'open' }, m);
    let read = await airplaneIs(m, 'off', 60_000);
    if (read === 'unknown') read = await airplaneIs(m, 'off', 60_000);
    rec.write('final', { ...m, value: read === 'yes' ? '0' : read === 'no' ? '1' : null });
    await lenient('close', 'device.controlCenter', { action: 'close' }, m);
  }
  /** A rede pelo `wait.for {network}` (não lê a tela): o instante em que ela ficou como se espera (ou `undefined`). */
  async function netCheck(round: number, phase: string, expect: 'online' | 'offline', tapS: number, timeoutMs: number): Promise<number | undefined> {
    const m = meta(round, phase);
    for (let i = 0; i < 4; i++) {
      const s = now();
      try {
        await xop(`wait-${expect}`, 'wait.for', { condition: { network: expect }, timeoutMs }, m, timeoutMs + 15_000);
        const at = now();
        rec.write('net', { ...m, s, r: at, net: expect, afterTapS: r1((at - tapS) / 1000) });
        return at;
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        const queued = isContrarregraError(error, 'E_TIMEOUT') && error.data?.['phase'] === 'queued';
        rec.write('net', { ...m, s, f: now(), net: queued ? 'queued' : `not-${expect}`, err: errCode(error), msg: msg.slice(0, 200) });
        if (!queued) return undefined;
      }
    }
    return undefined;
  }
  const check = (): void => {
    if (dead !== undefined) throw new Error(`runner caído: ${dead}`);
    if (stopped !== undefined) throw new Error(`parado: ${stopped}`);
  };
  let stopped = undefined as string | undefined;
  process.once('SIGINT', () => (stopped = 'SIGINT'));
  process.once('SIGTERM', () => (stopped = 'SIGTERM'));
  async function until(epochMs: number): Promise<void> {
    while (Date.now() < epochMs) {
      check();
      await sleep(Math.min(250, epochMs - Date.now()));
    }
    check();
  }

  let code = 0;
  let why = 'done';
  try {
    say(rec, `SP-2: teste do modo avião pelo runner. ${rounds} rodadas. Não precisa fazer nada.`, { step: 'intro' });
    const health0 = await link.call<HealthResult>('health', {}, { timeoutMs: 5_000 });
    if (health0.locked) throw new Error('o iPhone está travado: a Central de Controle só se abre destravado');
    // Ponto de partida conhecido: avião desligado (se uma série anterior parou com ele ligado, o runner o desliga).
    const base = await toggle(0, '0', 0, 'normalize');
    let notBefore = Math.max(start + preS * 1000, base.netAt + offS * 1000);
    for (let r = 1; r <= rounds; r++) {
      const on = await toggle(r, '1', notBefore);
      const off = await toggle(r, '0', on.netAt + onS * 1000);
      notBefore = off.netAt + offS * 1000;
    }
    await finalCheck();
    await until(Date.now() + tailS * 1000);
    say(rec, 'SP-2: fim do teste do modo avião pelo runner.', { step: 'end' });
  } catch (error) {
    why = errCode(error);
    rec.write('abort', { why, airplane, dead: dead ?? null });
    if (dead !== undefined && airplane !== '0') {
      say(rec, 'SP-2: o runner caiu com o modo avião ligado. Por favor, desligue o modo avião pela Central de Controle.', { step: 'owner-airplane-off' });
      code = 3;
    } else if (dead !== undefined) {
      say(rec, 'SP-2: o runner caiu. O modo avião está desligado.', { step: 'dead' });
      code = 4;
    } else if (airplane !== '0') {
      say(rec, 'SP-2: teste interrompido; o modo avião pode estar ligado.', { step: 'abort' });
      code = 5;
    } else {
      code = stopped !== undefined ? 6 : 5;
    }
    await sleep(6_000);
  }
  loops.stop();
  clearInterval(healthTimer);
  await samplePids(rec, config, 'final');
  rec.write('end', { why, code, airplane, downTicks, reconnects: link.reconnects, xcodebuildAlive: sessionAlive(session) });
  await link.close();
  console.log(JSON.stringify(analyze(label), null, 2));
  return code;
}


// ---------------------------------------------------------------------------------------------------------
// Análise

interface Row extends Json {
  k: string;
  m: number;
}

function readRows(label: string): Row[] {
  const text = readFileSync(join(OUT, `${label}.ndjson`), 'utf8');
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Row);
}

function quantile(values: number[], q: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? null;
}

const r1 = (x: number | null | undefined): number | null => (x === null || x === undefined ? null : Math.round(x * 10) / 10);

/**
 * Maior intervalo sem resposta ao `health` dentro de [from, to], por duas definições (as bordas da janela contam):
 * - `maxGapMs` (chegada → chegada): entre respostas boas consecutivas, pelo instante de chegada; `E_TIMEOUT` conta
 *   como sem resposta;
 * - `strictMaxGapMs` (envio → chegada): do envio do último batimento respondido até a chegada da resposta seguinte
 *   (ordem de envio) — inclui o período do batimento e o RTT.
 */
interface Gap {
  maxGapMs: number | null;
  at: number | null;
  strictMaxGapMs: number | null;
  strictAt: number | null;
  ok: number;
  failed: number;
}

function maxGap(rows: Row[], from: number, to: number): Gap {
  const good = rows.filter((r) => r.k === 'h' && typeof r['r'] === 'number' && (r['r'] as number) >= from && (r['r'] as number) <= to);
  const failed = rows.filter((r) => r.k === 'h' && typeof r['f'] === 'number' && (r['f'] as number) >= from && (r['f'] as number) <= to).length;
  if (good.length === 0) return { maxGapMs: r1(to - from), at: from, strictMaxGapMs: r1(to - from), strictAt: from, ok: 0, failed };
  const arrivals = good.map((r) => r['r'] as number).sort((a, b) => a - b);
  const points = [from, ...arrivals, to];
  let best = 0;
  let at = from;
  for (let i = 1; i < points.length; i++) {
    const gap = (points[i] as number) - (points[i - 1] as number);
    if (gap > best) {
      best = gap;
      at = points[i - 1] as number;
    }
  }
  const bySend = [...good].sort((a, b) => (a['s'] as number) - (b['s'] as number));
  let strict = (bySend[0]?.['r'] as number) - from;
  let strictAt = from;
  for (let i = 1; i < bySend.length; i++) {
    const gap = (bySend[i]?.['r'] as number) - (bySend[i - 1]?.['s'] as number);
    if (gap > strict) {
      strict = gap;
      strictAt = bySend[i - 1]?.['s'] as number;
    }
  }
  const tail = to - (bySend[bySend.length - 1]?.['s'] as number);
  if (tail > strict) {
    strict = tail;
    strictAt = bySend[bySend.length - 1]?.['s'] as number;
  }
  return { maxGapMs: r1(best), at, strictMaxGapMs: r1(strict), strictAt, ok: good.length, failed };
}

function iso(m: number | null): string | null {
  return m === null ? null : new Date(m).toISOString();
}

function grepLog(path: string | undefined): Record<string, number> | null {
  if (path === undefined || !existsSync(path)) return null;
  const text = readFileSync(path, 'utf8');
  const counts: Record<string, number> = {};
  for (const pattern of LOG_PATTERNS) counts[pattern] = text.split(pattern).length - 1;
  return counts;
}

function transitions(rows: Row[]): Array<{ at: string | null; tt: unknown; ts: unknown; usb: unknown }> {
  const out: Array<{ at: string | null; tt: unknown; ts: unknown; usb: unknown }> = [];
  let last = '';
  for (const r of rows.filter((x) => x.k === 'tr')) {
    const key = `${String(r['tt'])}|${String(r['ts'])}|${String(r['usb'])}`;
    if (key !== last) out.push({ at: iso(r.m), tt: r['tt'], ts: r['ts'], usb: r['usb'] });
    last = key;
  }
  return out;
}

function analyze(label: string): Json {
  const rows = readRows(label);
  const start = rows.find((r) => r.k === 'start');
  const end = rows.find((r) => r.k === 'end');
  const lastM = rows[rows.length - 1]?.m ?? 0;
  const summary: Json = { label, start: iso(start?.m ?? null), end: iso(end?.m ?? lastM), durationS: r1(((end?.m ?? lastM) - (start?.m ?? 0)) / 1000) };
  const tr = rows.filter((r) => r.k === 'tr');
  const trans = transitions(rows);
  summary['transport'] = {
    samples: tr.length,
    wiredConnected: tr.filter((r) => r['tt'] === 'wired' && r['ts'] === 'connected').length,
    localNetwork: tr.filter((r) => r['tt'] === 'localNetwork').length,
    devicectlP95Ms: quantile(tr.map((r) => Number(r['dt'])), 0.95),
    transitions: trans,
  };
  const says = rows.filter((r) => r.k === 'say');
  summary['announcements'] = says.map((r) => ({ at: iso(r.m), step: r['step'], round: r['round'] ?? null }));

  if (start?.['mode'] === 'transport') {
    const wifiOff = says.find((r) => r['step'] === 'wifi-off');
    const from = wifiOff?.m ?? start.m;
    const firstWired = tr.find((r) => r.m >= from && r['tt'] === 'wired' && r['ts'] === 'connected');
    const afterWired = firstWired === undefined ? [] : tr.filter((r) => r.m > firstWired.m);
    summary['procedure'] = {
      from: iso(from),
      fromWhat: wifiOff === undefined ? 'start' : 'announcement wifi-off',
      firstWiredConnected: iso(firstWired?.m ?? null),
      secondsToWired: firstWired === undefined ? null : r1((firstWired.m - from) / 1000),
      samplesAfterWired: afterWired.length,
      notWiredAfterWired: afterWired.filter((r) => r['tt'] !== 'wired').length,
    };
    writeFileSync(join(OUT, `${label}-summary.json`), `${JSON.stringify(summary, null, 2)}\n`);
    return summary;
  }

  const h = rows.filter((r) => r.k === 'h');
  const okH = h.filter((r) => typeof r['r'] === 'number');
  const rtts = okH.map((r) => (r['r'] as number) - (r['s'] as number));
  const ups = okH.map((r) => Number(r['up']));
  let uptimeResets = 0;
  for (let i = 1; i < okH.length; i++) {
    if (Number(okH[i]?.['up']) + 1 < Number(okH[i - 1]?.['up'])) uptimeResets++;
  }
  const pids = rows.filter((r) => r.k === 'pid');
  const runnerPidSet = new Set<string>();
  for (const p of pids) if (p['ok'] === true) runnerPidSet.add(JSON.stringify(p['runner']));
  const xcb = rows.filter((r) => r.k === 'xcb');
  const st = rows.filter((r) => r.k === 'st');
  const links = rows.filter((r) => r.k === 'link');
  const endM = end?.m ?? lastM;
  const preS = Number(start?.['preS'] ?? 0);
  const t0 = (start?.m ?? 0) + preS * 1000;
  summary['health'] = {
    sent: h.length,
    ok: okH.length,
    failed: h.length - okH.length,
    rttMs: { p50: r1(quantile(rtts, 0.5)), p95: r1(quantile(rtts, 0.95)), max: r1(rtts.length ? Math.max(...rtts) : null) },
    uptimeS: { first: ups[0] ?? null, last: ups[ups.length - 1] ?? null, resets: uptimeResets },
    whole: maxGap(rows, start?.m ?? 0, endM),
  };
  summary['runnerPids'] = [...runnerPidSet];
  summary['pidSamples'] = { ok: pids.filter((p) => p['ok'] === true).length, failed: pids.filter((p) => p['ok'] !== true).length };
  summary['xcodebuild'] = xcb.map((r) => ({ at: iso(r.m), alive: r['alive'], pid: r['pid'] }));
  summary['link'] = links.map((r) => ({ at: iso(r.m), state: r['state'], err: r['err'] ?? null }));
  summary['endInfo'] = end === undefined ? null : { downTicks: end['downTicks'], reconnects: end['reconnects'], xcodebuildAlive: end['xcodebuildAlive'] };
  summary['xcodebuildLog'] = grepLog(typeof start?.['log'] === 'string' ? (start['log'] as string) : undefined);
  if (preS > 0) {
    const preTr = tr.filter((r) => r.m <= t0);
    summary['pre'] = {
      seconds: preS,
      transportSamples: preTr.length,
      notWiredConnected: preTr.filter((r) => !(r['tt'] === 'wired' && r['ts'] === 'connected')).length,
      health: maxGap(rows, start?.m ?? 0, Math.min(t0, endM)),
      locked: st.filter((r) => r.m <= t0 && r['lk'] === true).length,
    };
  }
  if (start?.['mode'] === 'auto') {
    // Rodadas pelo runner: os toques e as leituras do interruptor (`toggle`), a rede uma vez por fase (`net`), as
    // chamadas da fila do XCTest (`xop`) e a fila vista pelo health (`q`).
    const toggles = rows.filter((r) => r.k === 'toggle');
    const nets = rows.filter((r) => r.k === 'net');
    const xops = rows.filter((r) => r.k === 'xop');
    const qs = okH.map((r) => Number(r['q'] ?? 0));
    summary['xctestQueue'] = { max: qs.length ? Math.max(...qs) : null, nonZero: qs.filter((q) => q > 0).length };
    summary['xops'] = {
      count: xops.length,
      failed: xops.filter((r) => typeof r['f'] === 'number').map((r) => ({ at: iso(r.m), op: r['op'], round: r['round'], err: r['err'] })),
      msByOp: Object.fromEntries(
        ['open', 'find', 'tap', 'close', 'state', 'wait-airplane-on', 'wait-airplane-off', 'wait-offline', 'wait-online'].map((op) => {
          const d = xops.filter((r) => r['op'] === op && typeof r['r'] === 'number').map((r) => (r['r'] as number) - (r['s'] as number));
          return [op, { n: d.length, p50: r1(quantile(d, 0.5)), max: r1(d.length ? Math.max(...d) : null) }];
        }),
      ),
    };
    const autoRounds: Json[] = [];
    const maxRound = Math.max(0, ...toggles.map((r) => Number(r['round'])));
    const firstXop = (round: number, phase: string): number | undefined => xops.find((r) => Number(r['round']) === round && r['phase'] === phase)?.['s'] as number | undefined;
    for (let round = 1; round <= maxRound; round++) {
      const on = toggles.find((r) => Number(r['round']) === round && r['phase'] === 'on');
      const off = toggles.find((r) => Number(r['round']) === round && r['phase'] === 'off');
      const from = firstXop(round, 'on') ?? on?.m ?? endM;
      const to = Math.min(firstXop(round + 1, 'on') ?? endM, endM);
      // A última leitura da fase (as anteriores podem ter estourado o prazo ainda na fila e sido repetidas).
      const netOn = nets.filter((r) => Number(r['round']) === round && r['phase'] === 'on').pop();
      const netOff = nets.filter((r) => Number(r['round']) === round && r['phase'] === 'off').pop();
      const pidsIn = new Set<string>();
      for (const p of pids) if (p.m >= from && p.m <= to && p['ok'] === true) pidsIn.add(JSON.stringify(p['runner']));
      const trIn = tr.filter((r) => r.m >= from && r.m <= to);
      const qIn = okH.filter((r) => (r['r'] as number) >= from && (r['r'] as number) <= to).map((r) => Number(r['q'] ?? 0));
      autoRounds.push({
        round,
        onTap: iso((on?.['tapR'] as number | undefined) ?? null),
        // O `value` depois de cada toque é lido na abertura seguinte (o `before` da troca seguinte, ou a final).
        onValue: on === undefined ? null : `${String(on['before'])}→${String(off?.['before'] ?? null)}`,
        offTap: iso((off?.['tapR'] as number | undefined) ?? null),
        offValue:
          off === undefined
            ? null
            : `${String(off['before'])}→${String(
                toggles.find((r) => Number(r['round']) === round + 1 && r['phase'] === 'on')?.['before'] ??
                  rows.find((r) => r.k === 'final')?.['value'] ??
                  null,
              )}`,
        // Avião ligado: da confirmação pela rede do "ligar" à do "desligar"; e da confirmação do "ligar" ao começo do
        // toque de "desligar" (o mínimo garantido).
        airplaneOnS: on !== undefined && off !== undefined && typeof on['netAt'] === 'number' && typeof off['netAt'] === 'number'
          ? r1(((off['netAt'] as number) - (on['netAt'] as number)) / 1000) : null,
        onConfirmedToOffTapS: on !== undefined && off !== undefined && typeof on['netAt'] === 'number'
          ? r1(((off['tapS'] as number) - (on['netAt'] as number)) / 1000) : null,
        netOn: netOn === undefined ? null : `${String(netOn['net'])}${netOn['afterTapS'] === undefined ? '' : ` +${String(netOn['afterTapS'])} s`}`,
        netOff: netOff === undefined ? null : `${String(netOff['net'])}${netOff['afterTapS'] === undefined ? '' : ` +${String(netOff['afterTapS'])} s`}`,
        onTapOutcome: on?.['tapOutcome'] ?? null,
        offTapOutcome: off?.['tapOutcome'] ?? null,
        runnerPids: [...pidsIn],
        health: maxGap(rows, from, to),
        queueMax: qIn.length ? Math.max(...qIn) : null,
        transportNotWired: trIn.filter((r) => r['tt'] !== 'wired').length,
        tunnelNotConnected: trIn.filter((r) => r['ts'] !== 'connected').length,
      });
    }
    summary['rounds'] = autoRounds;
    const firstOn = firstXop(1, 'on');
    if (firstOn !== undefined) summary['roundsWindow'] = { from: iso(firstOn), to: iso(endM), health: maxGap(rows, firstOn, endM) };
    summary['normalize'] = toggles.filter((r) => r['phase'] === 'normalize').map((r) => ({ at: iso(r.m), before: r['before'], already: r['already'] ?? false, ok: r['ok'] }));
    summary['final'] = rows.filter((r) => r.k === 'final').map((r) => ({ at: iso(r.m), value: r['value'] }));
    summary['abort'] = rows.filter((r) => r.k === 'abort').map((r) => ({ at: iso(r.m), why: r['why'], airplane: r['airplane'], dead: r['dead'] }));
    writeFileSync(join(OUT, `${label}-summary.json`), `${JSON.stringify(summary, null, 2)}\n`);
    return summary;
  }
  const rounds: Json[] = [];
  const ons = says.filter((r) => r['step'] === 'on');
  for (const on of ons) {
    const round = Number(on['round']);
    const off = says.find((r) => r['step'] === 'off' && Number(r['round']) === round);
    const nextOn = ons.find((r) => Number(r['round']) === round + 1);
    const to = Math.min(nextOn?.m ?? (off === undefined ? endM : off.m + Number(start?.['offS'] ?? 60) * 1000), endM);
    const offline = st.find((r) => r.m >= on.m && r['net'] === 'offline');
    const online = off === undefined ? undefined : st.find((r) => r.m >= off.m && r['net'] === 'online');
    const pidsIn = new Set<string>();
    for (const p of pids) if (p.m >= on.m - 5_000 && p.m <= to && p['ok'] === true) pidsIn.add(JSON.stringify(p['runner']));
    const trIn = tr.filter((r) => r.m >= on.m && r.m <= to);
    // device.state por fase (pela hora do envio): rede vista e a maior demora perto dos anúncios (a Central de
    // Controle aberta deixa as consultas ao SpringBoard lentas: é o rastro de que o dono mexeu ali).
    const offAt = off?.m ?? to;
    const netCount = (from: number, until: number): Json => {
      const counts: Record<string, number> = {};
      for (const r of st) {
        const s = Number(r['s']);
        if (s < from || s >= until) continue;
        const key = typeof r['net'] === 'string' ? (r['net'] as string) : `err:${String(r['err'])}`;
        counts[key] = (counts[key] ?? 0) + 1;
      }
      return counts;
    };
    const slowest = (at: number): number | null => {
      const near = st.filter((r) => Number(r['s']) >= at - 2_000 && Number(r['s']) <= at + 20_000);
      const lat = near.map((r) => (typeof r['r'] === 'number' ? (r['r'] as number) - Number(r['s']) : Number(r['f']) - Number(r['s'])));
      return lat.length === 0 ? null : r1(Math.max(...lat));
    };
    const hIn = h.filter((r) => typeof r['r'] === 'number' && (r['r'] as number) >= on.m && (r['r'] as number) <= to).map((r) => (r['r'] as number) - (r['s'] as number));
    rounds.push({
      round,
      on: iso(on.m),
      off: iso(off?.m ?? null),
      netOfflineAfterS: offline === undefined ? null : r1((offline.m - on.m) / 1000),
      netOnlineAfterS: online === undefined || off === undefined ? null : r1((online.m - off.m) / 1000),
      offlineSamples: st.filter((r) => r.m >= on.m && r.m <= (off?.m ?? to) && r['net'] === 'offline').length,
      runnerPids: [...pidsIn],
      health: maxGap(rows, on.m, to),
      transportNotWired: trIn.filter((r) => r['tt'] !== 'wired').length,
      tunnelNotConnected: trIn.filter((r) => r['ts'] !== 'connected').length,
      netDuringOn: netCount(on.m, offAt),
      netDuringOff: netCount(offAt, to),
      stateSlowestNearOnMs: slowest(on.m),
      stateSlowestNearOffMs: off === undefined ? null : slowest(off.m),
      healthRttP95Ms: r1(quantile(hIn, 0.95)),
      healthRttMaxMs: r1(hIn.length ? Math.max(...hIn) : null),
    });
  }
  summary['rounds'] = rounds;
  if (ons.length > 0) {
    const first = ons[0] as Row;
    const lastOff = says.filter((r) => r['step'] === 'off').pop();
    const to = Math.min((lastOff?.m ?? endM) + Number(start?.['offS'] ?? 60) * 1000, endM);
    summary['roundsWindow'] = { from: iso(first.m), to: iso(to), health: maxGap(rows, first.m, to) };
  }
  writeFileSync(join(OUT, `${label}-summary.json`), `${JSON.stringify(summary, null, 2)}\n`);
  return summary;
}

// ---------------------------------------------------------------------------------------------------------

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const opts = args(rest);
  switch (command) {
    case 'transport':
      await cmdTransport(opts);
      break;
    case 'airplane':
      await cmdAirplane(opts);
      break;
    case 'auto':
      process.exitCode = await cmdAuto(opts);
      break;
    case 'analyze':
      console.log(JSON.stringify(analyze(opts.get('label') ?? ''), null, 2));
      break;
    case 'announce': {
      // Um anúncio avulso, registrado no arquivo de um rótulo já existente (ex.: os passos do cabo).
      const rec = new Recorder(opts.get('label') ?? 'announce', false);
      say(rec, opts.get('text') ?? '', { step: opts.get('step') ?? 'announce' });
      await sleep(4_000);
      break;
    }
    default:
      console.error('uso: sp2.ts transport|airplane|analyze --label <l> …');
      process.exitCode = 2;
  }
}

main().then(
  () => process.exit(process.exitCode ?? 0),
  (error: unknown) => {
    console.error(`sp2: ${errCode(error)}`);
    process.exit(1);
  },
);
