// Lógica do driver do SP-14 (T-0.34; S7 item 2, AC-7.1) que não depende do aparelho: as rajadas NTP na conexão
// `sync` (copiadas do `measureBursts` do SP-4, sem importar de lá), a coreografia da medição (20 min, uma rajada a cada
// 10 s, com as checagens entre rajadas) sobre um ambiente injetado (`DriftEnv`), e a análise: o ajuste completo, só-pré
// e pré+pós, o resíduo RMS e o erro de pré+pós no meio. Código de spike, descartável (architecture.md A5); testado em
// `sp14.test.ts` (`node --test spikes/sp-14/sp14.test.ts`) com dados sintéticos e um runner falso.
//
// Definições (documentadas no SP-14.md):
// - rajada = 32 trocas `clock.ping {seq}` a 10 ms pela `sync` (S7 item 2); de cada uma fica o quarto de menor atraso
//   (8 amostras), como no `fitClock` de `mac/src/clock/ntp.ts`. θ da rajada = mediana do θ dessas 8, no instante
//   mediano delas (relógio do Mac).
// - "tomada simulada" = a medição inteira: **pré** = a primeira rajada (a de logo antes do `StartRecord`), **pós** = a
//   última (a de depois da `cleanup`), **meio** = a rajada mais perto do meio do caminho entre as duas.
// - **completo** = `fitClock` (Theil-Sen) sobre todas as rajadas; **resíduo RMS** (AC-7.1) = o `residualMs` dele (RMS
//   das amostras usadas em volta da reta). Também "completo a cada 20 s" (uma rajada sim, outra não: o ritmo de S7
//   item 2 durante a tomada).
// - **só-pré** = `fitClock` só da rajada pré: com uma rajada, `b` = 0 e θ fica constante (E-7.1).
// - **pré+pós** = `fitClock` só das rajadas pré e pós (16 amostras; a inclinação só de pares entre as duas).
// - **erro no meio** = θ medido na rajada do meio − o modelo naquele instante (ms, com sinal); o critério olha |·|.
//   Também o maior |erro| do modelo em todas as rajadas da tomada e, como "verdade" alternativa, a diferença para a
//   reta completa no meio.
// - **tomadas menores** (robustez): janelas de 5 e 10 min deslizando de 1 em 1 min pela medição, cada uma com o seu
//   pré, pós e meio; registra o pior erro no meio de pré+pós e de só-pré.
// - **sono** (E-7.4): `t2RawNs − t2UptimeNs` cresce se o aparelho dormir; espalhamento > 1 ms marca a medição.

import { median } from '../../mac/src/clock/fit.ts';
import { fitClock, offsetAtNs, selectLowestDelay, type ClockFit, type Exchange } from '../../mac/src/clock/ntp.ts';
import { isContrarregraError } from '../../mac/src/core/errors.ts';
import type { ClockPingResult, HealthResult } from '../../mac/src/core/types.ts';

export type Json = Record<string, unknown>;

// ---------------------------------------------------------------------------------------------------------
// Critério e parâmetros

/** Critério da T-0.34 (= AC-7.1). */
export const CRITERIA = { residualMs: 1, midErrorMs: 2 } as const;
/** Espalhamento de `t2Raw − t2Uptime` acima disto = o aparelho dormiu durante a medição (E-7.4). */
export const SLEEP_SPREAD_MS = 1;

export interface DriftOptions {
  /** Duração da medição; rajadas em 0, `everyMs`, …, `durationMs` (121 com 20 min e 10 s). */
  durationMs: number;
  everyMs: number;
  /** Trocas por rajada e intervalo entre elas (S7 item 2: 32 a 10 ms). */
  size: number;
  intervalMs: number;
  callTimeoutMs: number;
  /** `health` na `control` a cada tantas rajadas (e no começo e no fim). */
  healthEveryBursts: number;
  /** Rajadas seguidas sem nenhuma troca boa antes de parar. */
  maxFailedBursts: number;
  /** Espera da fila do XCTest vazia no começo (nenhum comando nosso vai para ela; só confere). */
  queueWaitMs: number;
}

export const DEFAULT_OPTIONS: DriftOptions = {
  durationMs: 20 * 60_000,
  everyMs: 10_000,
  size: 32,
  intervalMs: 10,
  callTimeoutMs: 2_000,
  healthEveryBursts: 6,
  maxFailedBursts: 3,
  queueWaitMs: 60_000,
};

/** Quantas rajadas a medição tem (a primeira em 0 e a última em `durationMs`). */
export function burstCount(o: Pick<DriftOptions, 'durationMs' | 'everyMs'>): number {
  return Math.floor(o.durationMs / o.everyMs) + 1;
}

// ---------------------------------------------------------------------------------------------------------
// Utilidades

export function msToNs(ms: number): bigint {
  return BigInt(Math.round(ms * 1e6));
}

export function errCode(error: unknown): string {
  if (isContrarregraError(error)) return `${error.code}${typeof error.data?.['reason'] === 'string' ? `/${error.data['reason']}` : ''}`;
  if (error instanceof Error) return error.message.slice(0, 160);
  return String(error).slice(0, 160);
}

const r3 = (x: number): number => Math.round(x * 1000) / 1000;
const r2 = (x: number): number => Math.round(x * 100) / 100;

/** `ifconfig` mostrando a rede do Acesso Pessoal do iPhone (o SP-2 viu que ela derruba a sessão). */
export function hotspotActive(ifconfigText: string): boolean {
  return /\binet 172\.20\.10\./.test(ifconfigText);
}

// ---------------------------------------------------------------------------------------------------------
// Medida

export interface Io {
  hr(): bigint;
  sleep(ms: number): Promise<void>;
  write(k: string, data: Json): void;
}

export interface Rpc {
  call<T = unknown>(method: string, params?: Record<string, unknown>, options?: { timeoutMs?: number }): Promise<T>;
}

/** Uma conexão aberta com o runner (o `RunnerConnection` de `mac/src/runner/client.ts` serve). */
export interface Conn extends Rpc {
  readonly isOpen: boolean;
  close(): Promise<void>;
}

/** Dorme até o instante `at` do relógio do Mac; repete se o timer acordar antes. */
export async function sleepUntil(io: Io, at: bigint): Promise<void> {
  for (;;) {
    const left = at - io.hr();
    if (left <= 0n) return;
    await io.sleep(Math.max(Number(left) / 1e6, 0.05));
  }
}

/**
 * Uma rajada de S7 item 2: `size` trocas `clock.ping {seq}` a `intervalMs`; cada troca grava T1…T4 (T1/T4 no relógio
 * do Mac, T2/T3 no `CLOCK_MONOTONIC_RAW` do aparelho) e `u2` (`t2UptimeNs`, para o sono). Nada é escrito em disco aqui.
 */
export async function measureBurst(
  rpc: Rpc,
  io: Io,
  o: { b: number; size: number; intervalMs: number; seqStart: number; timeoutMs: number },
): Promise<{ ok: number; errors: number }> {
  const burstStart = io.hr();
  let ok = 0;
  let errors = 0;
  for (let j = 0; j < o.size; j++) {
    await sleepUntil(io, burstStart + msToNs(j * o.intervalMs));
    const seq = o.seqStart + j;
    const t1 = io.hr();
    try {
      const r = await rpc.call<ClockPingResult>('clock.ping', { seq }, { timeoutMs: o.timeoutMs });
      const t4 = io.hr();
      if (r.seq !== seq) throw new Error(`seq ${String(r.seq)} ≠ ${seq}`);
      io.write('ntp', { b: o.b, j, t1: String(t1), t2: r.t2RawNs, t3: r.t3RawNs, t4: String(t4), u2: r.t2UptimeNs });
      ok++;
    } catch (error) {
      io.write('ntp', { b: o.b, j, err: errCode(error) });
      errors++;
    }
  }
  return { ok, errors };
}

/** Parada do driver: `hotspot` (Acesso Pessoal), `not-wired`, `session` (o runner caiu), `channel` (rajadas falhando). */
export class StopError extends Error {
  readonly kind: 'hotspot' | 'not-wired' | 'session' | 'channel';
  constructor(kind: StopError['kind'], message: string) {
    super(message);
    this.kind = kind;
  }
}

export interface Transport {
  transportType: string | null;
  tunnelState: string | null;
}

/** O que o driver usa do mundo; `sp14.ts` liga ao aparelho, os testes ao runner falso. */
export interface DriftEnv extends Io {
  flush(): void;
  log(line: string): void;
  openSync(): Promise<Conn>;
  openControl(): Promise<Conn>;
  /** O Mac está na rede do Acesso Pessoal do iPhone (`ifconfig`). */
  hotspot(): Promise<boolean>;
  /** O `xcodebuild` da sessão está vivo. */
  sessionAlive(): boolean;
  /** `devicectl list devices` (no começo e no fim; nunca entre rajadas próximas). */
  transport?(): Promise<Transport | undefined>;
}

export interface DriftRun {
  bursts: number;
  ok: number;
  errors: number;
  reopens: number;
}

async function health(env: DriftEnv, control: Conn, b: number | null, timeoutMs: number): Promise<HealthResult | null> {
  const t0 = env.hr();
  try {
    const h = await control.call<HealthResult>('health', {}, { timeoutMs });
    env.write('health', { b, rtt: Number(env.hr() - t0) / 1e6, depth: h.xctestQueueDepth, locked: h.locked, fg: h.foregroundApp, uptimeS: h.uptimeS });
    return h;
  } catch (error) {
    env.write('health', { b, err: errCode(error) });
    return null;
  }
}

async function checkTransport(env: DriftEnv, when: string): Promise<void> {
  if (env.transport === undefined) return;
  const t = await env.transport();
  env.write('transport', { when, transportType: t?.transportType ?? null, tunnelState: t?.tunnelState ?? null });
  if (t?.transportType !== 'wired') {
    throw new StopError('not-wired', `transportType = ${t?.transportType ?? 'desconhecido'} (${when}): o SP-14 só mede no cabo (wired)`);
  }
}

/**
 * A medição do SP-14: confere o cabo, o Acesso Pessoal e a fila do XCTest; abre `control` (só `health`) e `sync`; uma
 * rajada a cada `everyMs` por `durationMs` (agendadas a partir do começo, sem acumular atraso); entre rajadas, grava em
 * disco, confere o Acesso Pessoal e a sessão e reabre a `sync` se ela caiu. Nunca toca na fila do XCTest.
 */
export async function runDrift(env: DriftEnv, opts: DriftOptions): Promise<DriftRun> {
  const n = burstCount(opts);
  env.write('start', { opts: { ...opts }, bursts: n });
  if (await env.hotspot()) throw new StopError('hotspot', 'o Mac está na rede do Acesso Pessoal do iPhone (inet 172.20.10.*): parar');
  await checkTransport(env, 'start');
  const control = await env.openControl();
  let sync: Conn | null = null;
  let reopens = 0;
  let ok = 0;
  let errors = 0;
  let failedStreak = 0;
  try {
    const waitUntil = env.hr() + msToNs(opts.queueWaitMs);
    for (;;) {
      const h = await health(env, control, null, opts.callTimeoutMs);
      if (h !== null && h.xctestQueueDepth === 0) break;
      if (env.hr() > waitUntil) throw new StopError('session', `a fila do XCTest não esvaziou em ${opts.queueWaitMs} ms (health: ${h === null ? 'erro' : h.xctestQueueDepth})`);
      await env.sleep(1_000);
    }
    sync = await env.openSync();
    env.flush();
    const start = env.hr();
    env.write('t0', { hr: String(start) });
    for (let b = 0; b < n; b++) {
      await sleepUntil(env, start + msToNs(b * opts.everyMs));
      if (sync === null || !sync.isOpen) {
        try {
          sync = await env.openSync();
          reopens++;
          env.write('reopen', { b });
        } catch (error) {
          env.write('reopen', { b, err: errCode(error) });
          sync = null;
        }
      }
      const r = sync === null ? { ok: 0, errors: opts.size } : await measureBurst(sync, env, { b, size: opts.size, intervalMs: opts.intervalMs, seqStart: b * opts.size, timeoutMs: opts.callTimeoutMs });
      if (sync === null) env.write('ntp', { b, j: -1, err: 'no-sync' });
      ok += r.ok;
      errors += r.errors;
      env.write('burst', { b, ok: r.ok, errors: r.errors });
      // Entre rajadas (fora da medida): disco, checagens.
      env.flush();
      failedStreak = r.ok === 0 ? failedStreak + 1 : 0;
      if (b % 6 === 0 || b === n - 1) env.log(`rajada ${b + 1}/${n}: ${r.ok}/${opts.size} trocas boas`);
      if (failedStreak >= opts.maxFailedBursts) throw new StopError('channel', `${failedStreak} rajadas seguidas sem nenhuma troca boa`);
      if (!env.sessionAlive()) throw new StopError('session', 'o xcodebuild da sessão saiu: o runner caiu');
      if (await env.hotspot()) throw new StopError('hotspot', 'o Mac entrou na rede do Acesso Pessoal do iPhone (inet 172.20.10.*): parar');
      if (b % opts.healthEveryBursts === 0 || b === n - 1) await health(env, control, b, opts.callTimeoutMs);
    }
    await checkTransport(env, 'end');
    env.write('end', { why: 'done', bursts: n, ok, errors, reopens });
    return { bursts: n, ok, errors, reopens };
  } finally {
    env.flush();
    await sync?.close().catch(() => {});
    await control.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------------------------------------
// Análise

/** Uma rajada já lida: as trocas boas e o índice dela na medição. */
export interface Burst {
  b: number;
  exchanges: Exchange[];
  /** `t2RawNs − t2UptimeNs` de cada troca (ns), quando veio. */
  rawMinusUptime: bigint[];
  errors: number;
}

/** As rajadas das linhas `ntp` (ordenadas por `b`; rajadas sem troca boa ficam com `exchanges` vazio). */
export function burstsFromRows(rows: readonly Json[]): Burst[] {
  const map = new Map<number, Burst>();
  for (const row of rows) {
    if (row['k'] !== 'ntp') continue;
    const b = Number(row['b']);
    const burst = map.get(b) ?? { b, exchanges: [], rawMinusUptime: [], errors: 0 };
    map.set(b, burst);
    if (row['err'] !== undefined) {
      burst.errors++;
      continue;
    }
    const t2 = BigInt(String(row['t2']));
    burst.exchanges.push({ t1: BigInt(String(row['t1'])), t2, t3: BigInt(String(row['t3'])), t4: BigInt(String(row['t4'])) });
    if (row['u2'] !== undefined) burst.rawMinusUptime.push(t2 - BigInt(String(row['u2'])));
  }
  return [...map.values()].sort((x, y) => x.b - y.b);
}

function medianBig(values: readonly bigint[]): bigint {
  const s = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const mid = s.length >> 1;
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2n;
}

/** θ de uma rajada: mediana do θ do quarto de menor atraso, no instante mediano dele (relógio do Mac). */
export interface BurstTheta {
  b: number;
  macNs: bigint;
  thetaNs: bigint;
}

export function burstTheta(burst: Burst): BurstTheta | null {
  if (burst.exchanges.length === 0) return null;
  const kept = selectLowestDelay(burst.exchanges, burst.b);
  return { b: burst.b, macNs: medianBig(kept.map((s) => s.macNs)), thetaNs: medianBig(kept.map((s) => s.offsetNs)) };
}

/** Erro do modelo numa rajada: θ medido − θ do modelo no mesmo instante, em ms. */
export function errorAtMs(fit: Pick<ClockFit, 'aNs' | 'b'>, p: BurstTheta): number {
  return Number(p.thetaNs - offsetAtNs(fit, p.macNs)) / 1e6;
}

export interface ModelSummary {
  model: string;
  bursts: number;
  samples: number;
  bPpm: number;
  slopeEstimated: boolean;
  /** RMS das amostras usadas em volta da reta (o `residualMs` do `fitClock`; para o completo, o do AC-7.1). */
  fitResidualMs: number;
  /** Erro no meio (θ medido na rajada do meio − modelo), com sinal. */
  midErrorMs: number;
  /** O modelo no meio − a reta completa no meio (a "verdade" pela reta de todas as rajadas). */
  midVsFullMs: number;
  /** Erro na rajada pós (θ medido − modelo). */
  postErrorMs: number;
  /** O maior |erro| do modelo entre todas as rajadas da tomada. */
  maxAbsErrorMs: number;
  /** RMS do erro do modelo sobre o θ de todas as rajadas da tomada. */
  rmsErrorMs: number;
}

function summarizeModel(model: string, fit: ClockFit, full: ClockFit, take: readonly BurstTheta[], mid: BurstTheta, post: BurstTheta): ModelSummary {
  const errs = take.map((p) => errorAtMs(fit, p));
  return {
    model,
    bursts: fit.bursts,
    samples: fit.samples,
    bPpm: r3(fit.bPpm),
    slopeEstimated: fit.slopeEstimated,
    fitResidualMs: r3(fit.residualMs),
    midErrorMs: r3(errorAtMs(fit, mid)),
    midVsFullMs: r3(Number(offsetAtNs(fit, mid.macNs) - offsetAtNs(full, mid.macNs)) / 1e6),
    postErrorMs: r3(errorAtMs(fit, post)),
    maxAbsErrorMs: r3(Math.max(...errs.map(Math.abs))),
    rmsErrorMs: r3(Math.sqrt(errs.reduce((s, e) => s + e * e, 0) / errs.length)),
  };
}

/** A rajada (com θ) mais perto do meio do caminho entre `pre` e `post`. */
function middleOf(take: readonly BurstTheta[], pre: BurstTheta, post: BurstTheta): BurstTheta {
  const target = (pre.macNs + post.macNs) / 2n;
  let best = take[0]!;
  for (const p of take) {
    const d = p.macNs > target ? p.macNs - target : target - p.macNs;
    const dBest = best.macNs > target ? best.macNs - target : target - best.macNs;
    if (d < dBest) best = p;
  }
  return best;
}

export interface WindowSummary {
  minutes: number;
  windows: number;
  /** Pior |erro no meio| de pré+pós entre as janelas, e onde (minuto do começo). */
  prePostWorstMidMs: number;
  prePostWorstAtMin: number;
  /** Pior |erro no meio| de só-pré. */
  preOnlyWorstMidMs: number;
}

export interface DriftSummary {
  label: string;
  bursts: { planned: number | null; withData: number; exchanges: number; errors: number; samples: number };
  durationMin: number;
  delayP50Ms: number;
  delayMinMs: number;
  /** Espalhamento de `t2Raw − t2Uptime` (ms) e se passou do limite de sono. */
  sleep: { spreadMs: number | null; slept: boolean };
  /** θ total que a deriva da reta completa acumula na medição (ms). */
  driftOverRunMs: number;
  full: ModelSummary;
  full20s: ModelSummary;
  prePost: ModelSummary;
  preOnly: ModelSummary;
  windows: WindowSummary[];
  /** Erros do completo por rajada (minuto, ms), para o gráfico/registro. */
  residuals: { min: number; ms: number }[];
  health: { checks: number; errors: number; maxDepth: number | null; lockedSeen: boolean };
  transport: Json[];
  reopens: number;
  criteria: { residualMs: number; midErrorMs: number; residualOk: boolean; midOk: boolean; met: boolean };
}

/** Janelas de `minutes` deslizando de `stepBursts` em `stepBursts` rajadas, com pré, pós e meio próprios. */
export function slidingWindows(points: readonly BurstTheta[], byB: Map<number, Burst>, minutes: number, everyMs: number, stepBursts: number): WindowSummary | null {
  const span = Math.round((minutes * 60_000) / everyMs);
  let windows = 0;
  let worst = 0;
  let worstAt = 0;
  let worstPre = 0;
  const bIndex = new Map(points.map((p) => [p.b, p]));
  const first = points[0]?.b ?? 0;
  const last = points[points.length - 1]?.b ?? 0;
  for (let s = first; s + span <= last; s += stepBursts) {
    const pre = bIndex.get(s);
    const post = bIndex.get(s + span);
    if (pre === undefined || post === undefined) continue;
    const take = points.filter((p) => p.b >= s && p.b <= s + span);
    const mid = middleOf(take, pre, post);
    const prePost = fitClock([byB.get(pre.b)!.exchanges, byB.get(post.b)!.exchanges]);
    const preOnly = fitClock([byB.get(pre.b)!.exchanges]);
    const e = Math.abs(errorAtMs(prePost, mid));
    const ep = Math.abs(errorAtMs(preOnly, mid));
    windows++;
    if (e > worst) {
      worst = e;
      worstAt = ((s - first) * everyMs) / 60_000;
    }
    worstPre = Math.max(worstPre, ep);
  }
  if (windows === 0) return null;
  return { minutes, windows, prePostWorstMidMs: r3(worst), prePostWorstAtMin: r2(worstAt), preOnlyWorstMidMs: r3(worstPre) };
}

/** O resumo do SP-14 a partir das linhas gravadas pelo `runDrift`. */
export function summarize(label: string, rows: readonly Json[], o: { everyMs?: number; windowMinutes?: number[]; windowStepBursts?: number } = {}): DriftSummary {
  const startRow = rows.find((r) => r['k'] === 'start');
  const everyMs = o.everyMs ?? Number((startRow?.['opts'] as Json | undefined)?.['everyMs'] ?? DEFAULT_OPTIONS.everyMs);
  const planned = startRow === undefined ? null : Number(startRow['bursts']);
  const bursts = burstsFromRows(rows);
  const withData = bursts.filter((b) => b.exchanges.length > 0);
  if (withData.length < 3) throw new Error(`só ${withData.length} rajada(s) com dados: são precisas ≥ 3 (pré, meio, pós)`);
  const byB = new Map(withData.map((b) => [b.b, b]));
  const points = withData.map(burstTheta).filter((p): p is BurstTheta => p !== null);
  const pre = points[0]!;
  const post = points[points.length - 1]!;
  const mid = middleOf(points, pre, post);

  const full = fitClock(withData.map((b) => b.exchanges));
  const full20 = fitClock(withData.filter((b) => b.b % 2 === pre.b % 2 || b.b === post.b).map((b) => b.exchanges));
  const prePost = fitClock([byB.get(pre.b)!.exchanges, byB.get(post.b)!.exchanges]);
  const preOnly = fitClock([byB.get(pre.b)!.exchanges]);

  const delays = withData.flatMap((b) => b.exchanges.map((e) => Number(e.t4 - e.t1 - (e.t3 - e.t2)) / 1e6));
  const rmu = withData.flatMap((b) => b.rawMinusUptime);
  const spreadMs = rmu.length === 0 ? null : Number(rmu.reduce((m, x) => (x > m ? x : m)) - rmu.reduce((m, x) => (x < m ? x : m))) / 1e6;
  const t0 = pre.macNs;
  const durationMin = Number(post.macNs - pre.macNs) / 6e10;

  const healthRows = rows.filter((r) => r['k'] === 'health');
  const depths = healthRows.map((r) => r['depth']).filter((d): d is number => typeof d === 'number');
  const fullSummary = summarizeModel('completo (10 s)', full, full, points, mid, post);
  const windows = (o.windowMinutes ?? [5, 10])
    .map((m) => slidingWindows(points, byB, m, everyMs, o.windowStepBursts ?? Math.max(1, Math.round(60_000 / everyMs))))
    .filter((w): w is WindowSummary => w !== null);
  const prePostSummary = summarizeModel('pré+pós', prePost, full, points, mid, post);
  const residualOk = full.residualMs <= CRITERIA.residualMs;
  const midOk = Math.abs(prePostSummary.midErrorMs) <= CRITERIA.midErrorMs;
  return {
    label,
    bursts: { planned, withData: withData.length, exchanges: delays.length, errors: bursts.reduce((s, b) => s + b.errors, 0), samples: full.samples },
    durationMin: r2(durationMin),
    delayP50Ms: r3(median(delays)),
    delayMinMs: r3(Math.min(...delays)),
    sleep: { spreadMs: spreadMs === null ? null : r3(spreadMs), slept: spreadMs !== null && spreadMs > SLEEP_SPREAD_MS },
    driftOverRunMs: r3((full.b * Number(post.macNs - pre.macNs)) / 1e6),
    full: fullSummary,
    full20s: summarizeModel('completo (20 s)', full20, full, points, mid, post),
    prePost: prePostSummary,
    preOnly: summarizeModel('só-pré', preOnly, full, points, mid, post),
    windows,
    residuals: points.map((p) => ({ min: r2(Number(p.macNs - t0) / 6e10), ms: r3(errorAtMs(full, p)) })),
    health: {
      checks: healthRows.length,
      errors: healthRows.filter((r) => r['err'] !== undefined).length,
      maxDepth: depths.length === 0 ? null : Math.max(...depths),
      lockedSeen: healthRows.some((r) => r['locked'] === true),
    },
    transport: rows.filter((r) => r['k'] === 'transport').map((r) => ({ when: r['when'], transportType: r['transportType'], tunnelState: r['tunnelState'] })),
    reopens: rows.filter((r) => r['k'] === 'reopen' && r['err'] === undefined).length,
    criteria: { residualMs: CRITERIA.residualMs, midErrorMs: CRITERIA.midErrorMs, residualOk, midOk, met: residualOk && midOk },
  };
}

const f = (x: number): string => x.toFixed(3);

/** A tabela do resumo em Markdown (vai para a saída padrão e para o SP-14.md). */
export function markdownTable(s: DriftSummary): string {
  const lines: string[] = [];
  lines.push(`**${s.label}**: ${s.bursts.withData}${s.bursts.planned === null ? '' : `/${s.bursts.planned}`} rajadas com dados, ${s.bursts.exchanges} trocas boas, ${s.bursts.errors} erros, ${s.durationMin} min; atraso p50/mín ${f(s.delayP50Ms)}/${f(s.delayMinMs)} ms; deriva acumulada na medição ${f(s.driftOverRunMs)} ms; sono: ${s.sleep.slept ? 'SIM' : 'não'} (espalhamento ${s.sleep.spreadMs === null ? '—' : f(s.sleep.spreadMs)} ms); reaberturas da sync ${s.reopens}.`);
  lines.push('');
  lines.push('| modelo | rajadas | amostras | b (ppm) | resíduo RMS do ajuste (ms) | erro no meio (ms) | modelo − completo no meio (ms) | erro no pós (ms) | maior \\|erro\\| (ms) | RMS do erro nas rajadas (ms) |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|');
  for (const m of [s.preOnly, s.prePost, s.full20s, s.full]) {
    lines.push(`| ${m.model} | ${m.bursts} | ${m.samples} | ${m.slopeEstimated ? f(m.bPpm) : '0 (não estimado)'} | ${f(m.fitResidualMs)} | ${f(m.midErrorMs)} | ${f(m.midVsFullMs)} | ${f(m.postErrorMs)} | ${f(m.maxAbsErrorMs)} | ${f(m.rmsErrorMs)} |`);
  }
  if (s.windows.length > 0) {
    lines.push('');
    lines.push('| tomada menor | janelas | pré+pós: pior \\|erro no meio\\| (ms) | começo da pior (min) | só-pré: pior \\|erro no meio\\| (ms) |');
    lines.push('|---|---|---|---|---|');
    for (const w of s.windows) lines.push(`| ${w.minutes} min | ${w.windows} | ${f(w.prePostWorstMidMs)} | ${w.prePostWorstAtMin} | ${f(w.preOnlyWorstMidMs)} |`);
  }
  lines.push('');
  lines.push(
    `Critério (AC-7.1): resíduo RMS do completo ${f(s.full.fitResidualMs)} ms (≤ ${s.criteria.residualMs}: ${s.criteria.residualOk ? 'ok' : 'FALHA'}); ` +
      `|erro de pré+pós no meio| ${f(Math.abs(s.prePost.midErrorMs))} ms (≤ ${s.criteria.midErrorMs}: ${s.criteria.midOk ? 'ok' : 'FALHA'}) → ${s.criteria.met ? 'ATINGIDO' : 'NÃO atingido'}.`,
  );
  return lines.join('\n');
}
