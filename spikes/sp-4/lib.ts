// Lógica do driver do SP-4 (T-0.19; S2, ADR-9, AC-2.1, AC-2.6 só a reconexão) que não depende do aparelho: as
// medidas (ecos `clock.ping` com `pad`, conexões novas, `Connect` cru, capturas, rajadas NTP de S7 item 2, capturas
// simultâneas, corte e reconexão), a coreografia da medição (o runner põe o Hagah à frente e liga/desliga o modo
// avião; o dono só no que é humano) sobre um ambiente injetado (`DriverEnv`), e o resumo: p50/p95/p99, θ, o critério da T-0.19 e a comparação entre as duas
// formas de prender o listener. Código de spike, descartável (architecture.md A5); testado em `sp4.test.ts`
// (`node --test spikes/sp-4/sp4.test.ts`) com o usbmuxd falso e um runner falso sobre `mac/test/helpers`.
//
// Definições (documentadas no SP-4.md):
// - "eco de 64 B" = `clock.ping {seq, pad}` com `pad` de 64 bytes ASCII (o runner devolve o mesmo tamanho, S0.5); "eco
//   de 64 KB" = `pad` de 65 536 bytes (o teto do `pad`). RTT = T4 − T1 no relógio do Mac (`process.hrtime.bigint()`),
//   da chamada à resposta já lida; `dly` = RTT − (T3 − T2), o tempo fora do runner.
// - "conexão nova" (`fresh`) = do começo ao fim da resposta do primeiro `clock.ping` de 64 B numa conexão `sync`
//   aberta do zero: ListDevices (a checagem de E-2.1) → repassador em 127.0.0.1 → WebSocket por um túnel usbmux novo
//   (o repassador faz outro ListDevices e o `Connect`) → `session.hello` → `clock.ping`. O fechamento fica fora (é
//   medido à parte); a leitura do estado da sessão e o `ps` do `requireLiveSession` também (custo do Mac, uma vez por
//   execução). `product` = o mesmo pelo `openRunner` de produção, inteiro (com o `ps`), para comparação.
// - percentis pelo posto mais próximo (o valor de posto ⌈p·n⌉ da lista ordenada).
// - "desvio do θ" = o resíduo RMS da reta θ(t) = a + b·t (Theil-Sen, `fitClock` de `mac/src/clock/ntp.ts`, a grandeza
//   do AC-7.1 e de S7 item 2) tirada só das rajadas sem carga e sem avião (`ground/ntp` + `sever.ntp`); com carga ou
//   com o avião, o critério é o viés contra essa reta (|mediana do resíduo do quarto de menor atraso| ≤ 1 ms).
// - "sem mudança com avião" = com o modo avião ligado, os mesmos limites absolutos passam, nenhuma chamada do canal
//   falha e nenhuma conexão cai; a diferença para o cenário sem avião é registrada, não julgada. O avião é ligado pelo
//   runner como no `auto` do SP-2 (`wait.for {airplane}` antes do toque, `wait.for {network}` depois), fora das medidas.

import { median } from '../../mac/src/clock/fit.ts';
import { fitClock, offsetAtNs, selectLowestDelay, type ClockFit, type Exchange } from '../../mac/src/clock/ntp.ts';
import { isContrarregraError } from '../../mac/src/core/errors.ts';
import type { ClockPingResult, HealthResult, SessionHelloResult } from '../../mac/src/core/types.ts';
import { readyLine, type Reach, type ReachAttempt, type UsbmuxSnapshot } from './channel.ts';

export type Json = Record<string, unknown>;

// ---------------------------------------------------------------------------------------------------------
// Critério e parâmetros

/** Critério de sucesso da T-0.19. */
export const CRITERIA = { echoP50Ms: 5, echoP95Ms: 20, freshP95Ms: 50, thetaResidualMs: 1 } as const;
/** Referência de research/transport.md (S0-RTT) para a captura: registrada, não é critério da T-0.19. */
export const SHOT_P95_REFERENCE_MS = 400;
export const PAD_SMALL = 64;
export const PAD_LARGE = 65_536;

export const PHASES = ['echo64', 'echo64k', 'connect', 'fresh', 'product', 'ntp', 'shots', 'concurrent', 'concurrent2', 'sever'] as const;
/**
 * As fases de uma execução padrão. `concurrent2` (suplementar, da revisão do SP-4) fica de fora e roda só quando pedida
 * (`--phases concurrent2`): com capturas sem parar na `control`, ecos de 64 B espaçados, ecos de 64 KB espaçados e
 * conexões novas, e quantos deles coincidiram com uma captura em trânsito.
 */
export const DEFAULT_PHASES: readonly string[] = PHASES.filter((p) => p !== 'concurrent2');
/** Os grupos da fase `concurrent2` e a linha das capturas de fundo dela. */
export const C2 = { echo64: 'echo64+shots2', echo64k: 'echo64k+shots2', fresh: 'fresh+shots2', bg: 'shots.bg2' } as const;
export type Phase = (typeof PHASES)[number];
export type Scenario = 'ground' | 'air';
/** As fases cujas falhas são do canal (as capturas podem falhar por o Hagah sair da frente, S1 item 11). */
export const CHANNEL_PHASES = ['echo64', 'echo64k', 'connect', 'fresh', 'product', 'ntp', 'echo64+shots', 'ntp+shots', C2.echo64, C2.echo64k, C2.fresh];

export interface RunOptions {
  phases: string[];
  /** Repetir as fases com o modo avião ligado (o próprio runner liga e desliga, pela Central de Controle). */
  airplane: boolean;
  n64: number;
  n64k: number;
  nConnect: number;
  nFresh: number;
  nProduct: number;
  nShots: number;
  /** Rajadas de S7 item 2: `bursts` rajadas de `burstSize` trocas a `burstIntervalMs`, uma a cada `burstEveryMs`. */
  bursts: number;
  burstEveryMs: number;
  burstSize: number;
  burstIntervalMs: number;
  /** AC-2.6 (só a reconexão): `severRounds` cortes de `severS` segundos. */
  severRounds: number;
  severS: number;
  /** Intervalo das sondagens (`health`: Hagah à frente, fila do XCTest vazia). */
  pollMs: number;
  /** Espera depois de o avião ligar (confirmado), antes de medir. */
  settleMs: number;
  /** `wait.for {airplane}` (o `value` do interruptor, com a Central aberta; S0.3): prazo de cada leitura. */
  airplaneReadMs: number;
  /** `wait.for {network}` (não lê a tela): prazo para `offline` depois de ligar e para `online` depois de desligar. */
  netOnMs: number;
  netOffMs: number;
  /** `wait.for {network: online}` no começo (linha de base). */
  startNetMs: number;
  /** Folga do prazo do Mac sobre o do runner num `wait.for` (o do runner é `timeoutMs` + 1 s). */
  waitSlackMs: number;
  /** Prazo do Mac nas outras chamadas da fila do XCTest (o runner responde `E_TIMEOUT` em 10 s). */
  xctestTimeoutMs: number;
  /** Quanto esperar o Hagah aparecer à frente depois do `app.activate`. */
  appWaitMs: number;
  /** Uma ação que estourou o prazo do runner **rodando** ainda acontece: até quanto esperar o efeito (SP-2: ~2 min). */
  lateActionMs: number;
  /** Teto da espera pela fila do XCTest vazia antes de cada fase (o SP-2 viu ~5 min). */
  drainMaxMs: number;
  callTimeoutMs: number;
  shotTimeoutMs: number;
  maxConsecutiveErrors: number;
  /** `concurrent2`: ~`c2DurationMs` de ecos de 64 B a cada `c2GapMs` (sorteado no intervalo), `c2N64k` ecos de 64 KB a cada `c2GapMs64k`, `c2NFresh` conexões novas. */
  c2DurationMs: number;
  c2GapMs: [number, number];
  c2N64k: number;
  c2GapMs64k: [number, number];
  c2NFresh: number;
  /**
   * Janela "captura em trânsito": os últimos `transitMs` antes de a resposta do `screen.shot` chegar ao Mac (os
   * ~63 KB em base64 no fio; o eco de 64 KB leva ~4 ms num sentido — a janela é folgada de propósito).
   */
  transitMs: number;
}

export const DEFAULT_OPTIONS: RunOptions = {
  phases: [...DEFAULT_PHASES],
  airplane: true,
  n64: 1000,
  n64k: 100,
  nConnect: 100,
  nFresh: 1000,
  nProduct: 100,
  nShots: 100,
  bursts: 12,
  burstEveryMs: 5_000,
  burstSize: 32,
  burstIntervalMs: 10,
  severRounds: 3,
  severS: 30,
  pollMs: 1_000,
  settleMs: 5_000,
  airplaneReadMs: 90_000,
  netOnMs: 60_000,
  netOffMs: 90_000,
  startNetMs: 10_000,
  waitSlackMs: 15_000,
  xctestTimeoutMs: 30_000,
  appWaitMs: 10_000,
  lateActionMs: 120_000,
  drainMaxMs: 360_000,
  callTimeoutMs: 2_000,
  shotTimeoutMs: 10_000,
  maxConsecutiveErrors: 20,
  c2DurationMs: 60_000,
  c2GapMs: [20, 50],
  c2N64k: 100,
  c2GapMs64k: [100, 400],
  c2NFresh: 500,
  transitMs: 20,
};

/** Uma forma inalcançável não é o plano B: ele só sai do `compare`, com as duas inalcançáveis. */
export function unreachableText(bind: string, attempts: number): string {
  return (
    `forma ${bind} inalcançável pelo usbmuxd (${attempts} Connect recusados com CONTRARREGRA_READY no registro); rodar a ` +
    'outra forma; o plano B (⏳ Q-13 num G1 imediato) só sai do `compare`, com as duas inalcançáveis'
  );
}

export const PLAN_B =
  'PARAR: o loopback do aparelho não é alcançável pelo usbmuxd (Connect recusado com o runner pronto). Plano B da ' +
  'T-0.19: levar ⏳ Q-13 ao dono num G1 imediato (emenda de P-3/P-7 e HC-4, requirements.md §5); nenhuma escuta fora ' +
  'do loopback antes desse G1.';

// ---------------------------------------------------------------------------------------------------------
// Utilidades

export function nsToMs(ns: bigint): number {
  return Math.round(Number(ns) / 1e3) / 1e3;
}

export function msToNs(ms: number): bigint {
  return BigInt(Math.round(ms * 1e6));
}

export function errCode(error: unknown): string {
  if (isContrarregraError(error)) return `${error.code}${typeof error.data?.['reason'] === 'string' ? `/${error.data['reason']}` : ''}`;
  if (error instanceof Error) return error.message.slice(0, 160);
  return String(error).slice(0, 160);
}

/** Tamanho aproximado de um `clock.ping` no fio (sem o cabeçalho WebSocket): id e seq de 4 dígitos, carimbos de 15. */
export function pingWireBytes(padBytes: number): { request: number; response: number } {
  const pad = '.'.repeat(padBytes);
  const params = padBytes > 0 ? { seq: 1000, pad } : { seq: 1000 };
  const ns = '873460118230045';
  const result = { seq: 1000, t2RawNs: ns, t3RawNs: ns, t2UptimeNs: ns, ...(padBytes > 0 ? { pad } : {}) };
  return {
    request: Buffer.byteLength(JSON.stringify({ jsonrpc: '2.0', id: 1000, method: 'clock.ping', params })),
    response: Buffer.byteLength(JSON.stringify({ jsonrpc: '2.0', id: 1000, result })),
  };
}

/** Bytes de uma imagem em base64. */
export function base64Bytes(text: string): number {
  const padding = text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0;
  return Math.floor((text.length * 3) / 4) - padding;
}

// ---------------------------------------------------------------------------------------------------------
// Estatística

export interface Stats {
  n: number;
  errors: number;
  min: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  mean: number;
}

/** Percentil pelo posto mais próximo: o valor de posto ⌈p·n/100⌉ (1 ≤ posto ≤ n) da lista já ordenada. */
export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) throw new RangeError('percentil de lista vazia');
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length)));
  return sorted[rank - 1]!;
}

const r3 = (x: number): number => Math.round(x * 1000) / 1000;

export function stats(values: readonly number[], errors = 0): Stats | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((s, v) => s + v, 0);
  return {
    n: sorted.length,
    errors,
    min: r3(sorted[0]!),
    p50: r3(percentile(sorted, 50)),
    p95: r3(percentile(sorted, 95)),
    p99: r3(percentile(sorted, 99)),
    max: r3(sorted[sorted.length - 1]!),
    mean: r3(sum / sorted.length),
  };
}

// ---------------------------------------------------------------------------------------------------------
// Medidas (cada uma escreve uma linha por amostra em `io.write`)

export interface Io {
  hr(): bigint;
  sleep(ms: number): Promise<void>;
  write(k: string, data: Json): void;
}

export interface Rpc {
  call<T = unknown>(method: string, params?: Record<string, unknown>, options?: { timeoutMs?: number }): Promise<T>;
}

export interface OpenedConn extends Rpc {
  close(): Promise<void>;
  /** Etapas da abertura em ms (`openChannel`). */
  readonly phases?: Readonly<Record<string, number>>;
}

export interface HeldConn extends OpenedConn {
  readonly isOpen: boolean;
  readonly closed: Promise<unknown>;
}

export interface PhaseResult {
  ok: number;
  errors: number;
  aborted: boolean;
}

interface Common {
  sc: Scenario;
  ph: string;
  timeoutMs?: number;
  maxConsecutiveErrors?: number;
}

/** Dorme até o instante `at` do relógio do Mac; repete se o timer acordar antes (o relógio do laço do libuv atrasa). */
async function sleepUntil(io: Io, at: bigint): Promise<void> {
  for (;;) {
    const left = at - io.hr();
    if (left <= 0n) return;
    await io.sleep(Math.max(Number(left) / 1e6, 0.05));
  }
}

/** Espaçamento entre começos de ecos: sorteado em [mín, máx] ms (`random` ∈ [0, 1)). */
export interface Spacing {
  gapMs: [number, number];
  random?: () => number;
}

/**
 * Ecos `clock.ping {seq, pad}` pela mesma conexão; confere `seq` e o tamanho do `pad` ecoado. Em sequência (`n`), ou
 * espaçados (`spacing`: o próximo começa `gap` depois do começo do anterior) por `n` ecos ou por `durationMs`. Com
 * `stamp`, cada linha leva os instantes T1/T4 do Mac (`t1`, `t4`) para cruzar com as capturas.
 */
export async function measureEcho(
  rpc: Rpc,
  io: Io,
  o: Common & { n: number; padBytes: number; seqStart?: number; spacing?: Spacing; durationMs?: number; stamp?: boolean },
): Promise<PhaseResult> {
  const pad = o.padBytes > 0 ? 'x'.repeat(o.padBytes) : undefined;
  const timeoutMs = o.timeoutMs ?? DEFAULT_OPTIONS.callTimeoutMs;
  const max = o.maxConsecutiveErrors ?? DEFAULT_OPTIONS.maxConsecutiveErrors;
  const random = o.spacing?.random ?? Math.random;
  const start = io.hr();
  let next = start;
  let ok = 0;
  let errors = 0;
  let streak = 0;
  for (let i = 0; o.durationMs === undefined ? i < o.n : nsToMs(io.hr() - start) < o.durationMs; i++) {
    if (o.spacing !== undefined) {
      await sleepUntil(io, next);
      const [lo, hi] = o.spacing.gapMs;
      next = io.hr() + msToNs(lo + random() * (hi - lo));
    }
    const seq = (o.seqStart ?? 0) + i;
    const t1 = io.hr();
    try {
      const r = await rpc.call<ClockPingResult>('clock.ping', pad === undefined ? { seq } : { seq, pad }, { timeoutMs });
      const t4 = io.hr();
      const echoed = typeof r.pad === 'string' ? Buffer.byteLength(r.pad, 'utf8') : 0;
      if (r.seq !== seq || echoed !== o.padBytes) throw new Error(`eco errado: seq ${r.seq}/${seq}, pad ${echoed}/${o.padBytes} bytes`);
      const dev = BigInt(r.t3RawNs) - BigInt(r.t2RawNs);
      io.write('rtt', { sc: o.sc, ph: o.ph, i, rtt: nsToMs(t4 - t1), dev: nsToMs(dev), dly: nsToMs(t4 - t1 - dev), ...(o.stamp ? { t1: String(t1), t4: String(t4) } : {}) });
      ok++;
      streak = 0;
    } catch (error) {
      const t4 = io.hr();
      io.write('rtt', { sc: o.sc, ph: o.ph, i, rtt: nsToMs(t4 - t1), err: errCode(error), ...(o.stamp ? { t1: String(t1), t4: String(t4) } : {}) });
      errors++;
      if (++streak >= max) return { ok, errors, aborted: true };
    }
  }
  return { ok, errors, aborted: false };
}

/**
 * Rajadas de S7 item 2: `bursts` rajadas, uma a cada `everyMs` (do começo de uma ao da próxima), de `size` trocas
 * `clock.ping {seq}` a `intervalMs`; cada troca grava T1…T4 (T1/T4 no relógio do Mac, T2/T3 no do aparelho).
 */
export async function measureBursts(
  rpc: Rpc,
  io: Io,
  o: Common & { bursts: number; everyMs: number; size: number; intervalMs: number; round?: number; seqStart?: number },
): Promise<PhaseResult> {
  const timeoutMs = o.timeoutMs ?? DEFAULT_OPTIONS.callTimeoutMs;
  const round = o.round === undefined ? {} : { round: o.round };
  const start = io.hr();
  let seq = o.seqStart ?? 0;
  let ok = 0;
  let errors = 0;
  for (let b = 0; b < o.bursts; b++) {
    await sleepUntil(io, start + msToNs(b * o.everyMs));
    const burstStart = io.hr();
    for (let j = 0; j < o.size; j++) {
      await sleepUntil(io, burstStart + msToNs(j * o.intervalMs));
      const t1 = io.hr();
      try {
        const r = await rpc.call<ClockPingResult>('clock.ping', { seq }, { timeoutMs });
        const t4 = io.hr();
        io.write('ntp', { sc: o.sc, ph: o.ph, ...round, b, j, t1: String(t1), t2: r.t2RawNs, t3: r.t3RawNs, t4: String(t4) });
        ok++;
      } catch (error) {
        io.write('ntp', { sc: o.sc, ph: o.ph, ...round, b, j, err: errCode(error) });
        errors++;
      }
      seq++;
    }
  }
  return { ok, errors, aborted: false };
}

/** `screen.shot` (o padrão de produção: JPEG em pontos, S1 item 4): `n` vezes, ou até `stop()` (no fundo). */
export async function measureShots(
  rpc: Rpc,
  io: Io,
  o: Common & { n?: number; stop?: () => boolean; params?: Json; stamp?: boolean },
): Promise<PhaseResult> {
  const timeoutMs = o.timeoutMs ?? DEFAULT_OPTIONS.shotTimeoutMs;
  const max = o.maxConsecutiveErrors ?? DEFAULT_OPTIONS.maxConsecutiveErrors;
  const background = o.n === undefined;
  let ok = 0;
  let errors = 0;
  let streak = 0;
  for (let i = 0; background ? !(o.stop?.() ?? true) : i < (o.n ?? 0); i++) {
    const t0 = io.hr();
    try {
      const r = await rpc.call<{ image: string; format: string; widthPx: number; heightPx: number }>('screen.shot', o.params ?? {}, { timeoutMs });
      const t1 = io.hr();
      io.write('shot', {
        sc: o.sc, ph: o.ph, i, rtt: nsToMs(t1 - t0), bytes: base64Bytes(r.image), w: r.widthPx, h: r.heightPx, fmt: r.format,
        ...(o.stamp ? { ts: String(t0), te: String(t1) } : {}),
      });
      ok++;
      streak = 0;
    } catch (error) {
      io.write('shot', { sc: o.sc, ph: o.ph, i, rtt: nsToMs(io.hr() - t0), err: errCode(error) });
      errors++;
      if (++streak >= max) return { ok, errors, aborted: true };
      if (background) await io.sleep(100);
    }
  }
  return { ok, errors, aborted: false };
}

/** Quanto esperar o fechamento de cada conexão nova antes de seguir (ele termina no fundo; prazo do Mac: 1 s). */
export const CLOSE_CAP_MS = 300;

/**
 * `n` conexões novas, uma por vez: abre (`open`), um `clock.ping` com `pad` de `padBytes` e fecha. `total` = abrir +
 * o ping (o fechamento fica à parte, em `close`); as etapas da abertura vêm de `conn.phases`. O fechamento é esperado
 * até `closeCapMs` (`closeCapped` quando passou disso e terminou no fundo): se o runner não responder ao quadro de
 * fechamento, cada um levaria o prazo de 1 s do cliente e as 1.000 conexões, ~17 min de aparelho.
 */
export async function measureOpens(
  open: () => Promise<OpenedConn>,
  io: Io,
  o: Common & { n: number; padBytes: number; closeCapMs?: number; stamp?: boolean },
): Promise<PhaseResult> {
  const pad = o.padBytes > 0 ? 'x'.repeat(o.padBytes) : undefined;
  const timeoutMs = o.timeoutMs ?? DEFAULT_OPTIONS.callTimeoutMs;
  const max = o.maxConsecutiveErrors ?? DEFAULT_OPTIONS.maxConsecutiveErrors;
  const closeCapMs = o.closeCapMs ?? CLOSE_CAP_MS;
  const background: Promise<unknown>[] = [];
  const closeBounded = async (conn: OpenedConn): Promise<boolean> => {
    const closing = conn.close().catch(() => {});
    background.push(closing);
    let timer: NodeJS.Timeout | undefined;
    const capped = await Promise.race([closing.then(() => false), new Promise<boolean>((resolve) => (timer = setTimeout(() => resolve(true), closeCapMs)))]);
    clearTimeout(timer);
    return capped;
  };
  let ok = 0;
  let errors = 0;
  let streak = 0;
  try {
    for (let i = 0; i < o.n; i++) {
      const r = await openOnce(i);
      if (r) {
        ok++;
        streak = 0;
      } else {
        errors++;
        if (++streak >= max) return { ok, errors, aborted: true };
      }
    }
    return { ok, errors, aborted: false };
  } finally {
    await Promise.all(background);
  }

  async function openOnce(i: number): Promise<boolean> {
    const t0 = io.hr();
    let conn: OpenedConn | undefined;
    try {
      conn = await open();
      const t1 = io.hr();
      const r = await conn.call<ClockPingResult>('clock.ping', pad === undefined ? { seq: i } : { seq: i, pad }, { timeoutMs });
      const t2 = io.hr();
      const echoed = typeof r.pad === 'string' ? Buffer.byteLength(r.pad, 'utf8') : 0;
      if (r.seq !== i || echoed !== o.padBytes) throw new Error(`eco errado: seq ${r.seq}/${i}, pad ${echoed}/${o.padBytes} bytes`);
      const phases = conn.phases ?? {};
      const capped = await closeBounded(conn);
      conn = undefined;
      const t3 = io.hr();
      io.write('conn', {
        sc: o.sc, ph: o.ph, i, total: nsToMs(t2 - t0), open: nsToMs(t1 - t0), ping: nsToMs(t2 - t1), close: nsToMs(t3 - t2),
        ...(capped ? { closeCapped: true } : {}), ...phases, ...(o.stamp ? { t1: String(t0), t4: String(t2) } : {}),
      });
      return true;
    } catch (error) {
      if (conn !== undefined) await closeBounded(conn);
      io.write('conn', { sc: o.sc, ph: o.ph, i, total: nsToMs(io.hr() - t0), err: errCode(error) });
      return false;
    }
  }
}

/** `n` `Connect` crus do usbmuxd (sem WebSocket): `total` e as etapas que `connect()` devolve. */
export async function measureRawConnects(
  connect: () => Promise<Record<string, number>>,
  io: Io,
  o: Common & { n: number },
): Promise<PhaseResult> {
  const max = o.maxConsecutiveErrors ?? DEFAULT_OPTIONS.maxConsecutiveErrors;
  let ok = 0;
  let errors = 0;
  let streak = 0;
  for (let i = 0; i < o.n; i++) {
    const t0 = io.hr();
    try {
      const phases = await connect();
      io.write('conn', { sc: o.sc, ph: o.ph, i, total: nsToMs(io.hr() - t0), ...phases });
      ok++;
      streak = 0;
    } catch (error) {
      io.write('conn', { sc: o.sc, ph: o.ph, i, total: nsToMs(io.hr() - t0), err: errCode(error) });
      errors++;
      if (++streak >= max) return { ok, errors, aborted: true };
    }
  }
  return { ok, errors, aborted: false };
}

/** Roda `fg` com `bg` no fundo (até `fg` terminar); devolve o resultado de `fg`. */
export async function withBackground<T>(bg: (stop: () => boolean) => Promise<unknown>, fg: () => Promise<T>): Promise<T> {
  let stopped = false;
  const running = bg(() => stopped);
  try {
    return await fg();
  } finally {
    stopped = true;
    await running;
  }
}

// ---------------------------------------------------------------------------------------------------------
// O dono e as paradas

/**
 * Pedido ao dono — só para o que é de fato humano: código ou Face ID, alerta do sistema ou notificação cobrindo a
 * tela, o Acesso Pessoal ligado, o modo avião deixado ligado sem o runner conseguir desligá-lo. O driver imprime e
 * para (`StopError`, código de saída 4).
 */
export type Owner = (step: string, text: string) => void;

/** Parada do driver: `owner` = pediu algo humano (`OWNER_ACTION`); `transport` = o túnel não está no cabo. */
export class StopError extends Error {
  override readonly name = 'StopError';
  readonly kind: 'owner' | 'transport';
  readonly step: string;

  constructor(kind: 'owner' | 'transport', step: string, message: string) {
    super(message);
    this.kind = kind;
    this.step = step;
  }
}

/** O modo avião como o driver sabe; só `off` é certeza de desligado. */
export type AirState = 'off' | 'on' | 'maybe-on';

/** A voz só avisa; `unlock`, `screen`, `hotspot` e `ownerAirOff` são os pedidos ao dono. */
export const TEXT = {
  start: (bind: string): string => `SP-4 começando, forma ${bind}. O runner opera o iPhone sozinho.`,
  airOn: 'SP-4: o runner vai ligar o modo avião.',
  airOff: 'SP-4: o runner vai desligar o modo avião.',
  end: 'SP-4 terminado.',
  unlock: 'SP-4 parado: o iPhone está travado. Destrave com o código ou o Face ID e deixe a tela acesa; depois o orquestrador roda de novo.',
  screen: (why: string): string =>
    `SP-4 parado: algo cobre a tela do iPhone e o runner não consegue pôr o Hagah na frente (${why}). Feche o alerta, a ` +
    'notificação ou o app que estiver na frente; depois o orquestrador roda de novo.',
  hotspot: 'SP-4 parado antes de mexer no modo avião: o Mac está na rede do Acesso Pessoal do iPhone (172.20.10.x). Desligue o Acesso Pessoal; depois o orquestrador roda de novo.',
  ownerAirOff: 'SP-4 parado com o modo avião possivelmente ligado, e o runner não conseguiu desligá-lo. Desligue o modo avião pela Central de Controle.',
  notWired: (tt: string): string =>
    `transportType = ${tt}, não wired: o modo avião com o runner vivo só roda no cabo (regras comuns dos spikes). O SP-2 viu ` +
    'que religar o cabo volta para wired em ≤ 2 s; depois, rodar de novo.',
};

/** O interruptor do modo avião (S1 item 7): com a Central de Controle aberta, a lista permitida só libera ele. */
export const AIRPLANE_TARGET = { app: 'springboard', identifier: 'airplane-mode-button' } as const;

/** A saída do `ifconfig` mostra o Mac na rede do Acesso Pessoal do iPhone (172.20.10.0/28). */
export function hotspotActive(ifconfigText: string): boolean {
  return /\binet 172\.20\.10\./.test(ifconfigText);
}

/** O que fazer num SIGINT/SIGTERM: com o avião possivelmente ligado, pedir ao dono e sair com 4; senão, 130. */
export function signalExit(air: AirState): { code: number; owner?: { step: string; text: string } } {
  return air === 'off' ? { code: 130 } : { code: 4, owner: { step: 'air-off', text: TEXT.ownerAirOff } };
}

// ---------------------------------------------------------------------------------------------------------
// Coreografia da medição

export interface LinkLike extends Rpc {
  readonly state: string;
  readonly reconnects: number;
  close(): Promise<void>;
}

export interface Transport {
  transportType: string | null;
  tunnelState: string | null;
}

/** O que o driver usa do mundo; `sp4.ts` liga ao aparelho, os testes ao runner falso. */
export interface DriverEnv extends Io {
  flush(): void;
  log(line: string): void;
  /** Aviso pela voz do Mac (nunca pedido). */
  say(text: string, meta?: Json): void;
  /** Pedido ao dono (`OWNER_ACTION`); o driver para logo depois. */
  owner: Owner;
  /** Cada mudança do estado do avião (o tratador de SIGINT/SIGTERM do `sp4.ts` precisa dele). */
  setAir?: (air: AirState) => void;
  /** O Mac está na rede do Acesso Pessoal do iPhone (`ifconfig`). */
  hotspot?: () => Promise<boolean>;
  /** O bundle id do Hagah (`app.explore`). */
  app: string;
  bind: string;
  openControl(): Promise<HeldConn>;
  openSync(): Promise<HeldConn>;
  /** Conexão `sync` nova pelo `openChannel` (com as etapas). */
  openFresh(): Promise<OpenedConn>;
  /** Conexão `sync` nova pelo `openRunner` de produção. */
  openProduct?: () => Promise<OpenedConn>;
  rawConnect(): Promise<Record<string, number>>;
  transport?: () => Promise<Transport | undefined>;
  sessionAlive?: () => boolean;
  openLink(role: 'control' | 'sync', onState: (state: string, error?: Error) => void): Promise<LinkLike>;
  /** `runner sever --for <s>` fora de tomada: corta as linhas deste processo; devolve quantas. */
  sever(forS: number): number;
}

/** Uma conexão segurada durante a medição; conta quedas (fechou sem o driver pedir). */
class Held {
  readonly role: string;
  scenario: Scenario = 'ground';
  phase = '-';
  drops = 0;
  #open: () => Promise<HeldConn>;
  #env: DriverEnv;
  #conn: HeldConn | undefined;

  constructor(role: string, open: () => Promise<HeldConn>, env: DriverEnv) {
    this.role = role;
    this.#open = open;
    this.#env = env;
  }

  async get(): Promise<HeldConn> {
    if (this.#conn !== undefined && this.#conn.isOpen) return this.#conn;
    const conn = await this.#open();
    this.#conn = conn;
    void conn.closed.then(() => {
      if (this.#conn !== conn) return;
      this.drops++;
      this.#env.write('drop', { role: this.role, sc: this.scenario, ph: this.phase });
    });
    return conn;
  }

  async close(): Promise<void> {
    const conn = this.#conn;
    this.#conn = undefined;
    await conn?.close();
  }
}

/** O resultado de uma ação da fila do XCTest que pode estourar o prazo do runner (S1 item 3, `XCTestLane`). */
export type Lenient = 'ok' | 'ran-late' | 'not-run';

/**
 * A medição inteira de uma forma de prender o listener (a sessão de pé). O runner faz tudo no iPhone: põe o Hagah à
 * frente (`app.activate`) e liga/desliga o modo avião como o `auto` do SP-2 (10/10): fila do XCTest vazia → Central
 * aberta → `wait.for {airplane: <antigo>}` → `ui.tap` no interruptor → Central fechada → `wait.for {network}`. Toda
 * ação da fila que estoura o prazo do runner é lida pelo `data.phase` do `E_TIMEOUT`: `running` = vai acontecer (o
 * driver espera o efeito, nunca toca de novo às cegas); `queued` = não acontece (tenta de novo). Tudo da fila fica
 * entre as fases, nunca dentro de uma medida, e cada fase só começa com a fila vazia. Para (`StopError`) com
 * `OWNER_ACTION` só no que é humano; parando com o avião possivelmente ligado, o runner esvazia a fila, lê o
 * interruptor e só toca se ele ainda estiver ligado; se não conseguir, `OWNER_ACTION air-off` e `StopError`.
 */
export async function runSpike(env: DriverEnv, opts: RunOptions): Promise<void> {
  const control = new Held('control', () => env.openControl(), env);
  const sync = new Held('sync', () => env.openSync(), env);
  const phases = opts.phases.filter((p) => p !== 'sever');
  const needsApp = phases.includes('shots') || phases.includes('concurrent') || phases.includes('concurrent2');
  let seq = 0;
  let air: AirState = 'off';
  const setAir = (next: AirState): void => {
    if (next === air) return;
    air = next;
    env.setAir?.(next);
  };
  const common = { timeoutMs: opts.callTimeoutMs, maxConsecutiveErrors: opts.maxConsecutiveErrors };
  const bursts = { bursts: opts.bursts, everyMs: opts.burstEveryMs, size: opts.burstSize, intervalMs: opts.burstIntervalMs };

  const healthNow = async (): Promise<HealthResult> => (await control.get()).call<HealthResult>('health', {}, { timeoutMs: 3_000 });

  /** Uma chamada da fila do XCTest pela `control`, registrada (`xop`, com o instante para conferir que ficou fora das fases). */
  const xcall = async <T>(op: string, method: string, params: Json, timeoutMs = opts.xctestTimeoutMs): Promise<T> => {
    const t0 = env.hr();
    try {
      const r = await (await control.get()).call<T>(method, params, { timeoutMs });
      env.write('xop', { op, method, t: String(t0), ms: nsToMs(env.hr() - t0) });
      return r;
    } catch (error) {
      const phase = isContrarregraError(error) ? error.data?.['phase'] : undefined;
      env.write('xop', { op, method, t: String(t0), ms: nsToMs(env.hr() - t0), err: errCode(error), ...(phase === undefined ? {} : { lanePhase: phase }) });
      throw error;
    }
  };

  /** `E_TIMEOUT` do runner com o comando ainda na fila: não rodou e nunca vai rodar. */
  const queued = (error: unknown): boolean => isContrarregraError(error, 'E_TIMEOUT') && error.data?.['phase'] === 'queued';

  /** Ação da fila que pode estourar os 10 s do runner: na fila → tenta de novo; rodando → vai acontecer (não repete). */
  const lenient = async (op: string, method: string, params: Json, tries = 3): Promise<Lenient> => {
    for (let i = 0; i < tries; i++) {
      try {
        await xcall(op, method, params);
        return 'ok';
      } catch (error) {
        if (!isContrarregraError(error, 'E_TIMEOUT')) throw error;
        if (!queued(error)) return 'ran-late';
      }
    }
    return 'not-run';
  };

  /**
   * O interruptor pelo `wait.for {airplane}` (prazo do runner = `timeoutMs` + 1 s, não os 10 s de um `ui.find`: com a
   * Central aberta, cada leitura do SpringBoard chegou a 20–35 s no SP-2). `yes` = vale; `no` = a última sondagem viu
   * o contrário; `unknown` = não se leu.
   */
  const airplaneIs = async (state: 'on' | 'off'): Promise<'yes' | 'no' | 'unknown'> => {
    for (let i = 0; i < 3; i++) {
      try {
        await xcall(`wait-airplane-${state}`, 'wait.for', { condition: { airplane: state }, timeoutMs: opts.airplaneReadMs }, opts.airplaneReadMs + opts.waitSlackMs);
        return 'yes';
      } catch (error) {
        if (!isContrarregraError(error, 'E_TIMEOUT')) throw error;
        if (/o modo avião está (on|off)/.test(error.message)) return 'no';
        if (!queued(error)) return 'unknown';
      }
    }
    return 'unknown';
  };

  /** A rede pelo `wait.for {network}` (não lê a tela). */
  const netCheck = async (expect: 'online' | 'offline', timeoutMs: number, when: string): Promise<boolean> => {
    for (let i = 0; i < 4; i++) {
      try {
        await xcall(`wait-${expect}`, 'wait.for', { condition: { network: expect }, timeoutMs }, timeoutMs + opts.waitSlackMs);
        env.write('net', { when, want: expect, ok: true, tries: i + 1 });
        return true;
      } catch (error) {
        if (!queued(error)) {
          env.write('net', { when, want: expect, ok: false, tries: i + 1, err: errCode(error) });
          return false;
        }
      }
    }
    env.write('net', { when, want: expect, ok: false, tries: 4, err: 'na fila' });
    return false;
  };

  const health = async (when: string): Promise<void> => {
    try {
      const h = await healthNow();
      env.write('health', { when, uptimeS: h.uptimeS, fg: h.foregroundApp, locked: h.locked, queue: h.xctestQueueDepth });
    } catch (error) {
      env.write('health', { when, err: errCode(error) });
    }
    if (env.sessionAlive !== undefined) env.write('xcb', { when, alive: env.sessionAlive() });
  };

  const transport = async (when: string): Promise<Transport | undefined> => {
    if (env.transport === undefined) return undefined;
    const t = await env.transport();
    env.write('transport', { when, tt: t?.transportType ?? null, ts: t?.tunnelState ?? null });
    return t;
  };

  /** Fail-closed: `devicectl` sem resposta conta como fora do cabo. */
  const requireWired = async (when: string): Promise<void> => {
    if (env.transport === undefined) return;
    const t = await transport(when);
    if (t?.transportType !== 'wired') throw new StopError('transport', 'wired', TEXT.notWired(t?.transportType ?? 'desconhecido (devicectl sem resposta)'));
  };

  const stopOwner = (step: string, text: string): never => {
    env.owner(step, text);
    throw new StopError('owner', step, text);
  };

  /** Espera a fila do XCTest esvaziar (pelo `health`, que não entra nela): antes de cada fase e de cada troca do avião. */
  const drain = async (sc: string, ph: string): Promise<void> => {
    const t0 = env.hr();
    let polls = 0;
    for (;;) {
      const h = await healthNow();
      if (h.xctestQueueDepth === 0) {
        if (polls > 0) env.write('drain', { sc, ph, polls, ms: nsToMs(env.hr() - t0) });
        return;
      }
      polls++;
      if (nsToMs(env.hr() - t0) > opts.drainMaxMs) {
        throw new Error(`a fila do XCTest não esvaziou em ${Math.round(opts.drainMaxMs / 1000)} s (profundidade ${h.xctestQueueDepth})`);
      }
      await env.sleep(opts.pollMs);
    }
  };

  /** O Hagah à frente pelo próprio runner (`app.activate`); tela travada ou algo que o runner não tira → o dono. */
  const ensureApp = async (sc: Scenario): Promise<void> => {
    const t0 = env.hr();
    let activations = 0;
    let closedCc = false;
    for (;;) {
      const h = await healthNow();
      if (h.locked) stopOwner('unlock', TEXT.unlock);
      if (h.foregroundApp === env.app) {
        env.write('app', { sc, ok: true, activations, ms: nsToMs(env.hr() - t0) });
        return;
      }
      if (activations >= 2) stopOwner('screen', TEXT.screen(`à frente: ${h.foregroundApp === '' ? 'desconhecido' : h.foregroundApp}`));
      activations++;
      let outcome: Lenient;
      try {
        outcome = await lenient('activate', 'app.activate', { bundleId: env.app });
      } catch (error) {
        if (!isContrarregraError(error, 'E_FORBIDDEN_APP')) throw error;
        if (closedCc) stopOwner('screen', TEXT.screen(errCode(error)));
        // A Central de Controle aberta (sobra de uma execução interrompida) é a única camada que o runner fecha.
        closedCc = true;
        await lenient('cc-close', 'device.controlCenter', { action: 'close' }).catch(() => undefined);
        continue;
      }
      if (outcome === 'not-run') continue;
      const deadline = env.hr() + msToNs(outcome === 'ran-late' ? Math.max(opts.appWaitMs, opts.lateActionMs) : opts.appWaitMs);
      while (env.hr() < deadline) {
        const x = await healthNow();
        if (x.locked || x.foregroundApp === env.app) break;
        await env.sleep(Math.min(opts.pollMs, 500));
      }
    }
  };

  /**
   * Uma troca do interruptor, como o `auto` do SP-2: fila vazia (um `screen.shot` atrasado da fase `concurrent`
   * também a ocupa) → Central aberta → `wait.for {airplane: <antigo>}` → `ui.tap` (só se ainda no antigo) → Central
   * fechada → `wait.for {network}`. Devolve se a rede confirmou; erro se a Central não abriu, o interruptor ficou
   * ilegível ou o toque não rodou.
   */
  const toggleAirplane = async (want: boolean): Promise<boolean> => {
    await drain('-', 'toggle');
    const t0 = env.hr();
    const oldState = want ? 'off' : 'on';
    const wantState = want ? 'on' : 'off';
    const row: Json = { want };
    try {
      if ((await lenient('cc-open', 'device.controlCenter', { action: 'open' })) === 'not-run') throw new Error('a Central de Controle não abriu');
      let read = await airplaneIs(oldState);
      if (read === 'unknown') read = await airplaneIs(oldState);
      const before = read === 'yes' ? oldState : read === 'no' ? wantState : null;
      row['before'] = before;
      if (before === null) throw new Error(`o interruptor do modo avião ficou ilegível antes de ${want ? 'ligar' : 'desligar'}`);
      if (before === 'on' && air === 'off') setAir('on');
      let tap: Lenient | 'already' = 'already';
      if (before !== wantState) {
        if (want) setAir('maybe-on');
        try {
          tap = await lenient('tap', 'ui.tap', { target: AIRPLANE_TARGET });
        } catch (error) {
          // A Central fechou sozinha entre a leitura e o toque (visto no SP-2): reabre e toca uma vez.
          if (!isContrarregraError(error, 'E_TARGET_NOT_FOUND')) throw error;
          env.write('cc-closed', { want });
          if ((await lenient('cc-open', 'device.controlCenter', { action: 'open' })) === 'not-run') throw new Error('a Central de Controle não reabriu');
          tap = await lenient('tap', 'ui.tap', { target: AIRPLANE_TARGET });
        }
      }
      row['tap'] = tap;
      row['close'] = await lenient('cc-close', 'device.controlCenter', { action: 'close' });
      if (tap === 'not-run') throw new Error('o toque no interruptor do modo avião não rodou (ficou na fila)');
      const net = await netCheck(want ? 'offline' : 'online', want ? opts.netOnMs : opts.netOffMs, want ? 'air-on' : 'air-off');
      row['net'] = net;
      if (net) setAir(want ? 'on' : 'off');
      row['ok'] = net;
      return net;
    } catch (error) {
      row['ok'] = false;
      row['err'] = errCode(error);
      await lenient('cc-close', 'device.controlCenter', { action: 'close' }).catch(() => undefined);
      throw error;
    } finally {
      env.write('toggle', { ...row, ms: nsToMs(env.hr() - t0) });
    }
  };

  /**
   * Desligado pelo `value` do interruptor (basta para saber o estado; a rede não precisa confirmar): fila vazia →
   * Central → `wait.for {airplane: off}`; se a leitura disser ligado, um toque e outra leitura; nunca toca sem ler.
   * `true` = desligado de certeza.
   */
  const ensureOffByValue = async (why: string): Promise<boolean> => {
    const row: Json = { why };
    try {
      try {
        await drain('-', 'recover');
      } catch (error) {
        row['drainErr'] = errCode(error);
      }
      if ((await lenient('cc-open', 'device.controlCenter', { action: 'open' })) === 'not-run') throw new Error('a Central de Controle não abriu');
      let read = await airplaneIs('off');
      if (read === 'unknown') read = await airplaneIs('off');
      row['before'] = read;
      if (read === 'no') {
        row['tap'] = await lenient('tap', 'ui.tap', { target: AIRPLANE_TARGET });
        read = await airplaneIs('off');
        if (read === 'unknown') read = await airplaneIs('off');
        row['after'] = read;
      }
      await lenient('cc-close', 'device.controlCenter', { action: 'close' }).catch(() => undefined);
      if (read === 'yes') setAir('off');
      row['ok'] = read === 'yes';
    } catch (error) {
      row['ok'] = false;
      row['err'] = errCode(error);
      await lenient('cc-close', 'device.controlCenter', { action: 'close' }).catch(() => undefined);
    }
    env.write('recover', row);
    return row['ok'] === true;
  };

  const airplaneOff = async (): Promise<void> => {
    env.say(TEXT.airOff, { step: 'air-off' });
    let ok = await toggleAirplane(false);
    if (!ok) ok = await ensureOffByValue('a rede não voltou depois de desligar');
    env.write('air', { state: 'off', ok });
    if (!ok) throw new Error('o modo avião não se confirmou desligado');
    await transport('after-air');
    await health('after-air');
  };

  const airplaneOn = async (): Promise<boolean> => {
    await requireWired('before-air');
    env.say(TEXT.airOn, { step: 'air-on' });
    const offline = await toggleAirplane(true);
    env.write('air', { state: 'on', ok: offline });
    if (!offline) {
      env.write('skip', { sc: 'air', ph: '*', why: 'o interruptor foi tocado, mas a rede não ficou offline' });
      await airplaneOff();
      return false;
    }
    await env.sleep(opts.settleMs);
    await transport('air');
    await health('air');
    return true;
  };

  const runPhase = async (sc: Scenario, ph: string): Promise<void> => {
    control.phase = ph;
    sync.phase = ph;
    if (ph === 'shots' || ph === 'concurrent' || ph === 'concurrent2') {
      await drain(sc, ph);
      await ensureApp(sc);
    }
    await drain(sc, ph);
    const t0 = env.hr();
    env.write('phase', { sc, ph, at: 'begin', t: String(t0) });
    let r: PhaseResult | undefined;
    let skip: string | undefined;
    switch (ph) {
      case 'echo64':
      case 'echo64k': {
        const padBytes = ph === 'echo64' ? PAD_SMALL : PAD_LARGE;
        const n = ph === 'echo64' ? opts.n64 : opts.n64k;
        env.write('wire', { sc, ph, padBytes, ...pingWireBytes(padBytes) });
        r = await measureEcho(await sync.get(), env, { ...common, sc, ph, n, padBytes, seqStart: seq });
        seq += n;
        break;
      }
      case 'connect':
        r = await measureRawConnects(() => env.rawConnect(), env, { ...common, sc, ph, n: opts.nConnect });
        break;
      case 'fresh':
        r = await measureOpens(() => env.openFresh(), env, { ...common, sc, ph, n: opts.nFresh, padBytes: PAD_SMALL });
        break;
      case 'product':
        if (env.openProduct === undefined) skip = 'sem openRunner neste ambiente';
        else r = await measureOpens(env.openProduct, env, { ...common, sc, ph, n: opts.nProduct, padBytes: PAD_SMALL });
        break;
      case 'ntp':
        r = await measureBursts(await sync.get(), env, { ...common, sc, ph, ...bursts, seqStart: seq });
        seq += opts.bursts * opts.burstSize;
        break;
      case 'shots':
        r = await measureShots(await control.get(), env, { ...common, timeoutMs: opts.shotTimeoutMs, sc, ph, n: opts.nShots });
        break;
      case 'concurrent': {
        const ctl = await control.get();
        const syn = await sync.get();
        let shots: PhaseResult = { ok: 0, errors: 0, aborted: false };
        r = await withBackground(
          async (stop) => {
            shots = await measureShots(ctl, env, { ...common, timeoutMs: opts.shotTimeoutMs, sc, ph: 'shots.bg', stop });
          },
          async () => {
            const a = await measureEcho(syn, env, { ...common, sc, ph: 'echo64+shots', n: opts.n64, padBytes: PAD_SMALL, seqStart: seq });
            seq += opts.n64;
            const b = await measureBursts(syn, env, { ...common, sc, ph: 'ntp+shots', ...bursts, seqStart: seq });
            seq += opts.bursts * opts.burstSize;
            return { ok: a.ok + b.ok, errors: a.errors + b.errors, aborted: a.aborted || b.aborted };
          },
        );
        env.write('bg', { sc, ph: 'shots.bg', ...shots });
        break;
      }
      case 'concurrent2': {
        // Revisão do SP-4: na `concurrent`, os 1.000 ecos couberam na 1ª captura (antes de a resposta entrar no fio).
        // Aqui as capturas rodam sem parar na `control` enquanto a `sync` faz ecos ESPAÇADOS (64 B por ~60 s, 64 KB) e
        // conexões novas; cada amostra leva os instantes para contar quantas cruzaram uma captura em trânsito.
        const ctl = await control.get();
        const syn = await sync.get();
        let shots: PhaseResult = { ok: 0, errors: 0, aborted: false };
        r = await withBackground(
          async (stop) => {
            shots = await measureShots(ctl, env, { ...common, timeoutMs: opts.shotTimeoutMs, sc, ph: C2.bg, stop, stamp: true });
          },
          async () => {
            const a = await measureEcho(syn, env, { ...common, sc, ph: C2.echo64, n: 0, padBytes: PAD_SMALL, seqStart: seq, spacing: { gapMs: opts.c2GapMs }, durationMs: opts.c2DurationMs, stamp: true });
            seq += a.ok + a.errors;
            const b = await measureEcho(syn, env, { ...common, sc, ph: C2.echo64k, n: opts.c2N64k, padBytes: PAD_LARGE, seqStart: seq, spacing: { gapMs: opts.c2GapMs64k }, stamp: true });
            seq += opts.c2N64k;
            const c = await measureOpens(() => env.openFresh(), env, { ...common, sc, ph: C2.fresh, n: opts.c2NFresh, padBytes: PAD_SMALL, stamp: true });
            return { ok: a.ok + b.ok + c.ok, errors: a.errors + b.errors + c.errors, aborted: a.aborted || b.aborted || c.aborted };
          },
        );
        env.write('bg', { sc, ph: C2.bg, ...shots });
        break;
      }
      default:
        throw new Error(`fase desconhecida: ${ph} (${PHASES.join(', ')})`);
    }
    if (skip !== undefined) env.write('skip', { sc, ph, why: skip });
    env.write('phase', { sc, ph, at: 'end', t: String(env.hr()), ms: nsToMs(env.hr() - t0), ...(r ?? {}) });
    env.flush();
    env.log(`${sc}/${ph}: ${r === undefined ? `pulada (${skip ?? '?'})` : `${r.ok} ok, ${r.errors} erros${r.aborted ? ', parou' : ''}`}`);
  };

  const severPhase = async (): Promise<void> => {
    const sc: Scenario = 'ground';
    const ph = 'sever';
    const t0 = env.hr();
    env.write('phase', { sc, ph, at: 'begin' });
    const ups: Record<'control' | 'sync', bigint[]> = { control: [], sync: [] };
    const onState = (role: 'control' | 'sync') => (state: string, error?: Error): void => {
      const at = env.hr();
      env.write('state', { role, state, at: String(at), ...(error === undefined ? {} : { err: errCode(error) }) });
      if (state === 'up') ups[role].push(at);
    };
    const ctl = await env.openLink('control', onState('control'));
    const syn = await env.openLink('sync', onState('sync'));
    const ntp = { ...common, sc, ph: 'sever.ntp', bursts: 2, everyMs: 1_000, size: opts.burstSize, intervalMs: opts.burstIntervalMs };
    let okRounds = 0;
    try {
      await measureBursts(syn, env, { ...ntp, round: 0 });
      for (let round = 1; round <= opts.severRounds; round++) {
        const before = { control: ctl.reconnects, sync: syn.reconnects };
        const tSever = env.hr();
        const links = env.sever(opts.severS);
        const failFast: Record<string, { ms: number; code: string }> = {};
        for (const [role, link, method] of [['control', ctl, 'health'], ['sync', syn, 'clock.ping']] as const) {
          const t = env.hr();
          try {
            await link.call(method, method === 'health' ? {} : { seq: 0 }, { timeoutMs: 1_000 });
            failFast[role] = { ms: nsToMs(env.hr() - t), code: 'respondeu' };
          } catch (error) {
            failFast[role] = { ms: nsToMs(env.hr() - t), code: errCode(error) };
          }
        }
        const windowEnd = tSever + msToNs(opts.severS * 1000);
        const deadline = windowEnd + msToNs(10_000);
        const back = (): boolean => ctl.reconnects > before.control && syn.reconnects > before.sync && ctl.state === 'up' && syn.state === 'up';
        while (!back() && env.hr() < deadline) await env.sleep(20);
        const upAfter = (role: 'control' | 'sync', link: LinkLike, was: number): number | null => {
          const at = ups[role].at(-1);
          return link.reconnects > was && at !== undefined ? nsToMs(at - windowEnd) : null;
        };
        const upAfterWindowMs = { control: upAfter('control', ctl, before.control), sync: upAfter('sync', syn, before.sync) };
        let healthOk = false;
        try {
          await ctl.call('health', {}, { timeoutMs: 3_000 });
          healthOk = true;
        } catch {
          // registrado em `healthOk`
        }
        await measureBursts(syn, env, { ...ntp, round });
        const ok =
          links >= 2 &&
          upAfterWindowMs.control !== null &&
          upAfterWindowMs.sync !== null &&
          healthOk &&
          (failFast['control']?.code.startsWith('E_RUNNER_DOWN') ?? false) &&
          (failFast['sync']?.code.startsWith('E_RUNNER_DOWN') ?? false);
        if (ok) okRounds++;
        env.write('sever', { round, forS: opts.severS, links, failFast, upAfterWindowMs, healthOk, ok });
        env.log(`ground/sever ${round}/${opts.severRounds}: ${ok ? 'reconectou' : 'FALHOU'} (control +${upAfterWindowMs.control ?? '—'} ms, sync +${upAfterWindowMs.sync ?? '—'} ms depois da janela)`);
      }
    } finally {
      await ctl.close();
      await syn.close();
    }
    env.write('phase', { sc, ph, at: 'end', ms: nsToMs(env.hr() - t0), ok: okRounds, errors: opts.severRounds - okRounds, aborted: false });
    env.flush();
  };

  env.write('run', { bind: env.bind, app: env.app, opts });
  try {
    // Antes de qualquer coisa que mexa no avião: com o Acesso Pessoal ligado, sair do avião derruba a sessão (SP-2).
    if (env.hotspot !== undefined && (await env.hotspot())) stopOwner('hotspot', TEXT.hotspot);
    await control.get();
    await sync.get();
    await health('start');
    if (opts.airplane && phases.length > 0) await requireWired('start');
    else await transport('start');
    env.say(TEXT.start(env.bind), { step: 'intro' });
    // Linha de base: a rede uma vez; um avião deixado ligado por uma execução interrompida, o runner desliga.
    await drain('-', 'start');
    if (!(await netCheck('online', opts.startNetMs, 'start'))) {
      setAir('maybe-on');
      if (!(await ensureOffByValue('sem rede no começo'))) throw new Error('sem rede no começo e o modo avião não se confirmou desligado');
    }
    if (needsApp) {
      await drain('-', 'app');
      await ensureApp('ground');
    }
    const scenarios: Scenario[] = opts.airplane && phases.length > 0 ? ['ground', 'air'] : ['ground'];
    for (const sc of scenarios) {
      control.scenario = sc;
      sync.scenario = sc;
      if (sc === 'air' && !(await airplaneOn())) continue;
      for (const ph of phases) await runPhase(sc, ph);
      if (sc === 'air') await airplaneOff();
      control.scenario = 'ground';
      sync.scenario = 'ground';
    }
    if (opts.phases.includes('sever')) {
      await control.close();
      await sync.close();
      await severPhase();
    }
    await health('end');
    env.write('end', { drops: { control: control.drops, sync: sync.drops } });
    env.say(TEXT.end, { step: 'end' });
  } catch (error) {
    // Parou com o avião possivelmente ligado: o runner esvazia a fila, lê o interruptor e só toca se ainda ligado; se
    // não conseguir (caiu, tela travada), o dono — e a parada vira `StopError('owner', 'air-off')` (saída 4).
    const airAtStop = air;
    let recovered: boolean | null = null;
    if (air !== 'off') recovered = await ensureOffByValue(`parada: ${errCode(error)}`);
    env.write('abort', { err: errCode(error), air: airAtStop, recovered });
    if (recovered === false) {
      env.owner('air-off', TEXT.ownerAirOff);
      throw new StopError('owner', 'air-off', TEXT.ownerAirOff);
    }
    throw error;
  } finally {
    await control.close().catch(() => {});
    await sync.close().catch(() => {});
    env.flush();
  }
}

// ---------------------------------------------------------------------------------------------------------
// Sessão e alcance

/** Problema com a sessão de pé para o SP-4, ou `null`. O driver nunca sobe nem derruba o runner (G5 do orquestrador). */
export function sessionProblem(
  s: { sessionId: string; configuration: string; spike: boolean; bind?: string } | undefined,
  alive: boolean,
  wantBind: string | undefined,
): string | null {
  if (s === undefined) return 'nenhuma sessão do runner: o orquestrador sobe `bin/contrarregra runner up --spike --bind <loopback|endpoint>`';
  if (!alive) return `o xcodebuild da sessão ${s.sessionId} saiu: o orquestrador sobe o runner de novo`;
  if (s.configuration !== 'Spike' || !s.spike) {
    return `a sessão de pé é do build ${s.configuration}${s.spike ? '' : ' sem --spike'}: o SP-4 precisa de \`runner up --spike --bind <forma>\` (CONTRARREGRA_BIND só vale no Spike)`;
  }
  const bind = s.bind ?? 'loopback';
  if (wantBind !== undefined && bind !== wantBind) {
    return `a sessão de pé usa bind=${bind}, não ${wantBind}: o orquestrador faz \`runner down\` e \`runner up --spike --bind ${wantBind}\``;
  }
  return null;
}

export interface ProbeDeps {
  session: { sessionId: string; configuration: string; spike: boolean; bind?: string; port: number; log: string } | undefined;
  alive: boolean;
  wantBind: string | undefined;
  readLog(path: string): string;
  snapshot(): Promise<UsbmuxSnapshot>;
  reach(ready: boolean): Promise<{ verdict: Reach; attempts: ReachAttempt[] }>;
  hello(): Promise<SessionHelloResult>;
}

export interface ProbeResult {
  ok: boolean;
  verdict: Reach | 'session';
  message: string;
}

/**
 * A sonda do começo de cada execução (T-0.11, T-0.19): sessão `Spike` com o bind pedido; `CONTRARREGRA_READY` no
 * registro; `ListDevices` inteiro com o `SerialNumber` cru; `Connect` cru até o loopback; `session.hello`. Escreve a
 * linha `probe`. `unreachable` → a mensagem do plano B (o driver para).
 */
export async function probeSpike(io: Io, d: ProbeDeps): Promise<ProbeResult> {
  const problem = sessionProblem(d.session, d.alive, d.wantBind);
  if (problem !== null || d.session === undefined) {
    io.write('probe', { verdict: 'session', problem });
    return { ok: false, verdict: 'session', message: problem ?? 'sem sessão' };
  }
  const s = d.session;
  const bind = s.bind ?? 'loopback';
  let ready: { port: number; bind: string } | undefined;
  try {
    ready = readyLine(d.readLog(s.log));
  } catch {
    ready = undefined;
  }
  let usbmux: UsbmuxSnapshot;
  try {
    usbmux = await d.snapshot();
  } catch (error) {
    usbmux = { entries: [], usb: null, error: errCode(error) };
  }
  const readyMatches = ready === undefined ? null : ready.port === s.port && ready.bind === bind;
  if (ready !== undefined && readyMatches === false) {
    // O registro é de outro runner (outra porta ou outra forma): uma recusa aqui não diria nada sobre o loopback.
    const message =
      `o registro do xcodebuild diz CONTRARREGRA_READY port=${ready.port} bind=${ready.bind}, mas a sessão é port=${s.port} ` +
      `bind=${bind}: a sessão de pé não é a deste registro; o orquestrador confere o runner up`;
    io.write('probe', { verdict: 'session', problem: message, bind, configuration: s.configuration, sessionId: s.sessionId, port: s.port, ready, readyMatches, usbmux });
    return { ok: false, verdict: 'session', message };
  }
  const reach = usbmux.usb === null ? { verdict: 'no-usb' as const, attempts: [] } : await d.reach(ready !== undefined);
  let hello: Json = {};
  if (reach.verdict === 'reachable') {
    try {
      const h = await d.hello();
      hello = { runnerVersion: h.runnerVersion, device: h.device, capabilities: h.capabilities };
    } catch (error) {
      hello = { err: errCode(error) };
    }
  }
  io.write('probe', {
    verdict: reach.verdict,
    bind,
    configuration: s.configuration,
    sessionId: s.sessionId,
    port: s.port,
    ready: ready ?? null,
    readyMatches,
    usbmux,
    attempts: reach.attempts,
    hello,
  });
  const connectMs = reach.attempts.find((a) => a.ok)?.ms;
  const messages: Record<Reach, string> = {
    reachable:
      hello['err'] === undefined
        ? `loopback alcançável com bind=${bind} (Connect cru ${connectMs ?? '?'} ms); SerialNumber cru ${usbmux.usb?.serialRaw ?? '?'}`
        : `o Connect passa, mas o session.hello falhou (${String(hello['err'])})`,
    unreachable: unreachableText(bind, reach.attempts.length),
    'not-ready': 'o Connect é recusado e o registro do xcodebuild ainda não tem CONTRARREGRA_READY: o runner não terminou de subir',
    'no-usb': `o usbmuxd não dá a entrada USB do iPhone (${usbmux.error ?? 'E_NO_USB'}): ligue o cabo`,
  };
  return { ok: reach.verdict === 'reachable' && hello['err'] === undefined, verdict: reach.verdict, message: messages[reach.verdict] };
}

// ---------------------------------------------------------------------------------------------------------
// Resumo

export interface NtpSummary {
  sc: string;
  ph: string;
  bursts: number;
  exchanges: number;
  errors: number;
  samples: number;
  /** "Desvio do θ" (critério ≤ 1 ms): RMS dos resíduos do ajuste nas amostras usadas. */
  residualMs: number;
  bPpm: number;
  slopeEstimated: boolean;
  /** RMS do θ de cada rajada (mediana do quarto de menor atraso) em volta do ajuste. */
  burstRmsMs: number;
  delayP50Ms: number;
  delayMinMs: number;
  /** θ(t) = a + b·t: `a` é θ em M = 0 (extrapolado; serve para refazer o ajuste, não para comparar). */
  aNs: string;
  /** θ no meio das amostras usadas (M mediano): o deslocamento aparelho − Mac medido, em ns. */
  thetaMidNs: string;
}

function medianBig(values: bigint[]): bigint {
  const s = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const mid = s.length >> 1;
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2n;
}

/** As trocas de um conjunto de linhas `ntp`, agrupadas por rajada (`sc|ph|round:b`), e quantas falharam. */
function burstsOf(rows: Json[]): { bursts: Exchange[][]; errors: number } {
  const groups = new Map<string, Exchange[]>();
  let errors = 0;
  for (const row of rows) {
    if (row['err'] !== undefined) {
      errors++;
      continue;
    }
    const key = `${String(row['sc'])}|${String(row['ph'])}|${String(row['round'] ?? 0)}:${String(row['b'])}`;
    const list = groups.get(key) ?? [];
    list.push({ t1: BigInt(String(row['t1'])), t2: BigInt(String(row['t2'])), t3: BigInt(String(row['t3'])), t4: BigInt(String(row['t4'])) });
    groups.set(key, list);
  }
  return { bursts: [...groups.values()], errors };
}

/** As rajadas da reta de referência: sem carga e sem avião (`ground/ntp` e `sever.ntp`, antes e depois das outras). */
export function isReferenceNtp(row: Json): boolean {
  return row['k'] === 'ntp' && ((row['sc'] === 'ground' && row['ph'] === 'ntp') || row['ph'] === 'sever.ntp');
}

/** A reta θ(t) de referência, ou `null` sem trocas. */
export function referenceFit(rows: Json[]): ClockFit | null {
  const { bursts } = burstsOf(rows.filter(isReferenceNtp));
  return bursts.some((b) => b.length > 0) ? fitClock(bursts) : null;
}

export interface BiasSummary {
  sc: string;
  ph: string;
  bursts: number;
  samples: number;
  /** Mediana do resíduo (θ − reta de referência) do quarto de menor atraso de cada rajada, em ms (critério |·| ≤ 1). */
  biasMs: number;
  /** O maior |mediana por rajada| — mostra se o viés vem de uma rajada só. */
  maxBurstAbsMs: number;
}

/**
 * Viés de um grupo (`ntp+shots`, `air/ntp`, `air/ntp+shots`) contra a reta de referência: o resíduo por fase (a reta
 * do próprio grupo) não enxerga um deslocamento constante — um atraso assimétrico com carga ou com o avião.
 */
export function analyzeBias(fit: Pick<ClockFit, 'aNs' | 'b'>, sc: string, ph: string, rows: Json[]): BiasSummary | null {
  const { bursts } = burstsOf(rows);
  const residuals: number[] = [];
  const perBurst: number[] = [];
  bursts.forEach((ex, i) => {
    const kept = selectLowestDelay(ex, i).map((k) => Number(k.offsetNs - offsetAtNs(fit, k.macNs)) / 1e6);
    if (kept.length === 0) return;
    residuals.push(...kept);
    perBurst.push(Math.abs(median(kept)));
  });
  if (residuals.length === 0) return null;
  return { sc, ph, bursts: perBurst.length, samples: residuals.length, biasMs: r3(median(residuals)), maxBurstAbsMs: r3(Math.max(...perBurst)) };
}

/** O ajuste θ(t) de um grupo de linhas `ntp` (rajadas por `round:b`); `null` sem nenhuma troca. */
export function analyzeNtp(sc: string, ph: string, rows: Json[]): NtpSummary | null {
  const { bursts, errors } = burstsOf(rows);
  const exchanges = bursts.reduce((n, b) => n + b.length, 0);
  if (exchanges === 0) return null;
  const fit = fitClock(bursts);
  const keptAt: bigint[] = [];
  const burstResiduals = bursts.map((ex, i) => {
    const kept = selectLowestDelay(ex, i);
    keptAt.push(...kept.map((s) => s.macNs));
    const theta = medianBig(kept.map((s) => s.offsetNs));
    const at = medianBig(kept.map((s) => s.macNs));
    return Number(theta - offsetAtNs(fit, at)) / 1e6;
  });
  const delays = bursts.flat().map((e) => Number(e.t4 - e.t1 - (e.t3 - e.t2)) / 1e6);
  return {
    sc,
    ph,
    bursts: bursts.length,
    exchanges,
    errors,
    samples: fit.samples,
    residualMs: r3(fit.residualMs),
    bPpm: r3(fit.bPpm),
    slopeEstimated: fit.slopeEstimated,
    burstRmsMs: r3(Math.sqrt(burstResiduals.reduce((s, x) => s + x * x, 0) / burstResiduals.length)),
    delayP50Ms: r3(median(delays)),
    delayMinMs: r3(Math.min(...delays)),
    aNs: String(fit.aNs),
    thetaMidNs: String(offsetAtNs(fit, medianBig(keptAt))),
  };
}

/**
 * Para cada amostra (intervalo [t1, t4] no relógio do Mac), se ela cruzou a janela de trânsito [te − transitMs, te] de
 * alguma captura (o fim do `screen.shot`, quando a resposta de ~63 KB passa pelo fio).
 */
export function transitOverlaps(samples: readonly { t1: bigint; t4: bigint }[], shotEnds: readonly bigint[], transitMs: number): boolean[] {
  const w = msToNs(transitMs);
  const ends = [...shotEnds].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return samples.map(({ t1, t4 }) => {
    // a primeira captura que termina depois do começo da amostra
    let lo = 0;
    let hi = ends.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (ends[mid]! < t1) lo = mid + 1;
      else hi = mid;
    }
    for (let i = lo; i < ends.length && ends[i]! - w <= t4; i++) if (ends[i]! >= t1) return true;
    return false;
  });
}

export interface C2Group {
  ph: string;
  stats: Stats | null;
  errors: number;
  /** Amostras que cruzaram uma captura em trânsito. */
  overlaps: number;
  overlapStats: Stats | null;
}

export interface C2Summary {
  sc: string;
  transitMs: number;
  bg: { ok: number; errors: number; aborted: boolean } | null;
  /** As capturas de fundo de fato rodaram (linha `bg` sem parar e com alguma). */
  bgValid: boolean;
  echo64: C2Group;
  echo64k: C2Group;
  fresh: C2Group;
}

function c2Group(rows: Json[], sc: string, ph: string, value: 'rtt' | 'total', shotEnds: bigint[], transitMs: number): C2Group {
  const all = rows.filter((r) => r['sc'] === sc && r['ph'] === ph && (r['k'] === 'rtt' || r['k'] === 'conn'));
  const good = all.filter((r) => r['err'] === undefined && typeof r[value] === 'number' && typeof r['t1'] === 'string' && typeof r['t4'] === 'string');
  const flags = transitOverlaps(good.map((r) => ({ t1: BigInt(r['t1'] as string), t4: BigInt(r['t4'] as string) })), shotEnds, transitMs);
  const hit = good.filter((_, i) => flags[i]);
  return {
    ph,
    stats: stats(good.map((r) => r[value] as number), all.length - good.length),
    errors: all.length - good.length,
    overlaps: hit.length,
    overlapStats: stats(hit.map((r) => r[value] as number)),
  };
}

/** A fase suplementar `concurrent2` de um cenário, ou `null` se ela não rodou nele. */
export function analyzeC2(rows: Json[], sc: string, transitMs: number): C2Summary | null {
  if (!rows.some((r) => r['sc'] === sc && (r['ph'] === C2.echo64 || r['ph'] === C2.bg))) return null;
  const bgRow = rows.find((r) => r['k'] === 'bg' && r['sc'] === sc && r['ph'] === C2.bg);
  const bg = bgRow === undefined ? null : { ok: Number(bgRow['ok'] ?? 0), errors: Number(bgRow['errors'] ?? 0), aborted: bgRow['aborted'] === true };
  const shotEnds = rows
    .filter((r) => r['k'] === 'shot' && r['sc'] === sc && r['ph'] === C2.bg && r['err'] === undefined && typeof r['te'] === 'string')
    .map((r) => BigInt(r['te'] as string));
  return {
    sc,
    transitMs,
    bg,
    bgValid: bg !== null && !bg.aborted && bg.ok > 0,
    echo64: c2Group(rows, sc, C2.echo64, 'rtt', shotEnds, transitMs),
    echo64k: c2Group(rows, sc, C2.echo64k, 'rtt', shotEnds, transitMs),
    fresh: c2Group(rows, sc, C2.fresh, 'total', shotEnds, transitMs),
  };
}

export interface RowStats {
  sc: string;
  ph: string;
  kind: 'rtt' | 'conn' | 'shot';
  stats: Stats | null;
  errors: number;
  /** Medianas de outras grandezas (etapas da abertura, `dly`, bytes…). */
  extra: Record<string, number>;
}

export interface Check {
  id: string;
  what: string;
  value: number | string | null;
  limit: string;
  ok: boolean | null;
  /** Entra no "sucesso" da T-0.19. */
  required: boolean;
}

export interface Summary {
  label: string;
  bind: string | null;
  configuration: string | null;
  sessionId: string | null;
  serialRaw: string | null;
  reach: string | null;
  rows: RowStats[];
  ntp: NtpSummary[];
  /** A reta de referência (sem carga, sem avião) e o viés de cada outro grupo contra ela. */
  thetaRef: { residualMs: number; bPpm: number; bursts: number; samples: number } | null;
  bias: BiasSummary[];
  sever: { rounds: number; ok: number; upAfterWindowMs: Stats | null; failFastMs: Stats | null; theta: NtpSummary | null } | null;
  air: { tried: boolean; on: boolean; off: boolean; drops: number; skipped: string[] };
  drops: number;
  checks: Check[];
  /** Critério da T-0.19 inteiro. */
  success: boolean;
  /** AC-2.1 (1.000 ecos de 64 B pela `sync`, sem avião). */
  ac21: boolean | null;
  /** AC-2.6, só a reconexão. */
  ac26: boolean | null;
  /** A fase suplementar `concurrent2` (quando rodou) e o veredito dela (as verificações `*.c2.*` sem as de leitura literal). */
  c2: C2Summary[];
  c2ok: boolean | null;
}

const SUB_KEYS: Record<RowStats['kind'], string[]> = {
  rtt: ['dly', 'dev'],
  conn: ['open', 'ping', 'close', 'list', 'fwd', 'ws', 'hello', 'connect'],
  shot: ['bytes'],
};

function rowStats(kind: RowStats['kind'], sc: string, ph: string, rows: Json[]): RowStats {
  const value = kind === 'conn' ? 'total' : 'rtt';
  const good = rows.filter((r) => r['err'] === undefined && typeof r[value] === 'number');
  const errors = rows.length - good.length;
  const extra: Record<string, number> = {};
  for (const key of SUB_KEYS[kind]) {
    const values = good.map((r) => r[key]).filter((v): v is number => typeof v === 'number');
    if (values.length > 0) extra[key] = r3(median(values));
  }
  const capped = good.filter((r) => r['closeCapped'] === true).length;
  if (capped > 0) extra['closeCapped'] = capped;
  return { sc, ph, kind, stats: stats(good.map((r) => r[value] as number), errors), errors, extra };
}

const PHASE_ORDER = ['echo64', 'echo64k', 'connect', 'fresh', 'product', 'ntp', 'shots', 'echo64+shots', 'ntp+shots', 'shots.bg', C2.echo64, C2.echo64k, C2.fresh, C2.bg];

function byPhase(a: { sc: string; ph: string }, b: { sc: string; ph: string }): number {
  if (a.sc !== b.sc) return a.sc === 'ground' ? -1 : 1;
  return PHASE_ORDER.indexOf(a.ph) - PHASE_ORDER.indexOf(b.ph);
}

/** Resumo de uma execução a partir das linhas do `.ndjson`. */
export function summarize(label: string, rows: Json[]): Summary {
  const first = (k: string): Json | undefined => rows.find((r) => r['k'] === k);
  const probe = first('probe');
  const run = first('run');
  const groups = new Map<string, { kind: RowStats['kind']; sc: string; ph: string; rows: Json[] }>();
  const ntpRows = new Map<string, { sc: string; ph: string; rows: Json[] }>();
  for (const row of rows) {
    const k = row['k'];
    const sc = String(row['sc'] ?? '');
    const ph = String(row['ph'] ?? '');
    if (k === 'rtt' || k === 'conn' || k === 'shot') {
      const key = `${k}|${sc}|${ph}`;
      const g = groups.get(key) ?? { kind: k, sc, ph, rows: [] };
      g.rows.push(row);
      groups.set(key, g);
    } else if (k === 'ntp') {
      const key = `${sc}|${ph}`;
      const g = ntpRows.get(key) ?? { sc, ph, rows: [] };
      g.rows.push(row);
      ntpRows.set(key, g);
    }
  }
  const rowSummaries = [...groups.values()].map((g) => rowStats(g.kind, g.sc, g.ph, g.rows)).sort(byPhase);
  const ntp = [...ntpRows.values()]
    .filter((g) => g.ph !== 'sever.ntp')
    .map((g) => analyzeNtp(g.sc, g.ph, g.rows))
    .filter((x): x is NtpSummary => x !== null)
    .sort(byPhase);

  const severRows = rows.filter((r) => r['k'] === 'sever');
  const severNtp = ntpRows.get('ground|sever.ntp');
  const sever =
    severRows.length === 0
      ? null
      : {
          rounds: severRows.length,
          ok: severRows.filter((r) => r['ok'] === true).length,
          upAfterWindowMs: stats(
            severRows.flatMap((r) => Object.values((r['upAfterWindowMs'] ?? {}) as Record<string, number | null>)).filter((v): v is number => typeof v === 'number'),
          ),
          failFastMs: stats(severRows.flatMap((r) => Object.values((r['failFast'] ?? {}) as Record<string, { ms: number }>).map((f) => f.ms))),
          theta: severNtp === undefined ? null : analyzeNtp('ground', 'sever.ntp', severNtp.rows),
        };

  const airRows = rows.filter((r) => r['k'] === 'air');
  const drops = rows.filter((r) => r['k'] === 'drop');
  const air = {
    tried: airRows.length > 0 || rows.some((r) => r['k'] === 'skip' && r['sc'] === 'air'),
    on: airRows.some((r) => r['state'] === 'on' && r['ok'] === true),
    off: airRows.some((r) => r['state'] === 'off' && r['ok'] === true),
    drops: drops.filter((r) => r['sc'] === 'air').length,
    skipped: rows.filter((r) => r['k'] === 'skip' && r['sc'] === 'air').map((r) => `${String(r['ph'])}: ${String(r['why'])}`),
  };

  const fit = referenceFit(rows);
  const thetaRef = fit === null ? null : { residualMs: r3(fit.residualMs), bPpm: r3(fit.bPpm), bursts: fit.bursts, samples: fit.samples };
  const bias = fit === null
    ? []
    : [...ntpRows.values()]
        .filter((g) => g.ph !== 'sever.ntp' && !(g.sc === 'ground' && g.ph === 'ntp'))
        .map((g) => analyzeBias(fit, g.sc, g.ph, g.rows))
        .filter((x): x is BiasSummary => x !== null)
        .sort(byPhase);
  /** As medidas `*+shots` só valem com as capturas de fundo de fato rodando (linha `bg` sem parar e com alguma). */
  const bgValid = (sc: string): boolean =>
    rows.some((r) => r['k'] === 'bg' && r['sc'] === sc && r['ph'] === 'shots.bg' && r['aborted'] === false && typeof r['ok'] === 'number' && r['ok'] > 0);

  const healthRows = rows.filter((r) => r['k'] === 'health' && typeof r['uptimeS'] === 'number');
  const uptimes = healthRows.map((r) => r['uptimeS'] as number);

  const find = (sc: string, ph: string): RowStats | undefined => rowSummaries.find((r) => r.sc === sc && r.ph === ph);
  const findBias = (sc: string, ph: string): BiasSummary | undefined => bias.find((r) => r.sc === sc && r.ph === ph);
  const checks: Check[] = [];
  const le = (id: string, what: string, value: number | null | undefined, limit: number, required: boolean): void => {
    const v = value ?? null;
    checks.push({ id, what, value: v, limit: `≤ ${limit}`, ok: v === null ? null : v <= limit, required });
  };
  const absLe = (id: string, what: string, value: number | null | undefined, limit: number, required: boolean): void => {
    const v = value ?? null;
    checks.push({ id, what, value: v, limit: `|·| ≤ ${limit}`, ok: v === null ? null : Math.abs(v) <= limit, required });
  };

  const reach = typeof probe?.['verdict'] === 'string' ? (probe['verdict'] as string) : null;
  checks.push({ id: 'reach', what: 'loopback alcançável pelo usbmuxd', value: reach, limit: 'reachable', ok: reach === null ? null : reach === 'reachable', required: true });
  le('ref.ntp.residual', 'desvio do θ: resíduo RMS da reta de referência (ground/ntp + sever.ntp, sem carga e sem avião) (ms)', thetaRef?.residualMs, CRITERIA.thetaResidualMs, true);
  const scenarios = ['ground', ...(air.tried ? ['air'] : [])];
  for (const sc of scenarios) {
    const echo = find(sc, 'echo64');
    le(`${sc}.echo64.p50`, 'eco 64 B, conexão sync persistente: p50 (ms)', echo?.stats?.p50, CRITERIA.echoP50Ms, true);
    le(`${sc}.echo64.p95`, 'eco 64 B, conexão sync persistente: p95 (ms)', echo?.stats?.p95, CRITERIA.echoP95Ms, true);
    const fresh = find(sc, 'fresh');
    le(`${sc}.fresh.p95`, 'conexão nova + hello + eco 64 B: p95 (ms)', fresh?.stats?.p95, CRITERIA.freshP95Ms, true);
    if (sc === 'air') absLe('air.ntp.bias', 'viés do θ com o avião contra a reta de referência: mediana (ms)', findBias('air', 'ntp')?.biasMs, CRITERIA.thetaResidualMs, true);
    const withShots = bgValid(sc);
    const conc = withShots ? find(sc, 'echo64+shots') : undefined;
    le(`${sc}.echo64+shots.p50`, 'eco 64 B com capturas na control: p50 (ms; só com as capturas de fundo rodando)', conc?.stats?.p50, CRITERIA.echoP50Ms, true);
    le(`${sc}.echo64+shots.p95`, 'eco 64 B com capturas na control: p95 (ms; só com as capturas de fundo rodando)', conc?.stats?.p95, CRITERIA.echoP95Ms, true);
    absLe(`${sc}.ntp+shots.bias`, 'viés do θ com capturas na control contra a reta de referência: mediana (ms; só com as capturas de fundo rodando)', withShots ? findBias(sc, 'ntp+shots')?.biasMs : null, CRITERIA.thetaResidualMs, true);
    const channelErrors =
      rowSummaries.filter((r) => r.sc === sc && CHANNEL_PHASES.includes(r.ph)).reduce((n, r) => n + r.errors, 0) +
      ntp.filter((r) => r.sc === sc && CHANNEL_PHASES.includes(r.ph)).reduce((n, r) => n + r.errors, 0);
    const measured = rowSummaries.some((r) => r.sc === sc) || ntp.some((r) => r.sc === sc);
    checks.push({ id: `${sc}.errors`, what: 'chamadas do canal que falharam', value: measured ? channelErrors : null, limit: '= 0', ok: measured ? channelErrors === 0 : null, required: true });
    const shots = find(sc, 'shots');
    le(`${sc}.shots.p95`, `captura com o Hagah à frente: p95 (ms; referência de research/transport.md, não critério)`, shots?.stats?.p95, SHOT_P95_REFERENCE_MS, false);
  }
  if (air.tried) {
    checks.push({ id: 'air.on', what: 'modo avião ligado pelo runner e confirmado (wait.for {network: offline})', value: air.on ? 'sim' : 'não', limit: 'sim', ok: air.on, required: true });
    checks.push({ id: 'air.drops', what: 'conexões que caíram com o avião ligado', value: air.drops, limit: '= 0', ok: air.drops === 0, required: true });
  } else {
    checks.push({ id: 'air.on', what: 'modo avião (não rodou)', value: null, limit: 'sim', ok: null, required: true });
  }
  if (uptimes.length >= 2) {
    const same = uptimes.every((u, i) => i === 0 || u >= uptimes[i - 1]!);
    checks.push({ id: 'runner.same', what: 'runner não foi religado (uptimeS só cresce)', value: same ? 'sim' : 'não', limit: 'sim', ok: same, required: false });
  }
  if (sever !== null) {
    checks.push({ id: 'sever.rounds', what: 'AC-2.6 (reconexão): rodadas em que control e sync voltaram', value: `${sever.ok}/${sever.rounds}`, limit: 'todas', ok: sever.ok === sever.rounds, required: false });
    le('sever.theta', 'θ contínuo através dos cortes: resíduo RMS (ms)', sever.theta?.residualMs, CRITERIA.thetaResidualMs, false);
  }

  const transitMs = Number(((run?.['opts'] ?? {}) as Json)['transitMs'] ?? DEFAULT_OPTIONS.transitMs);
  const c2 = ['ground', 'air'].map((sc) => analyzeC2(rows, sc, transitMs)).filter((x): x is C2Summary => x !== null);
  const c2Verdict: Check[] = [];
  for (const g of c2) {
    const v = (x: number | undefined): number | null => (g.bgValid ? (x ?? null) : null);
    const push = (c: Check, verdict: boolean): void => {
      checks.push(c);
      if (verdict) c2Verdict.push(c);
    };
    push({ id: `${g.sc}.c2.bg`, what: 'concurrent2: capturas de fundo rodando o tempo todo (bg sem parar, ok > 0)', value: g.bg === null ? null : `${g.bg.ok} ok, ${g.bg.errors} erros${g.bg.aborted ? ', parou' : ''}`, limit: 'sem parar, ok > 0', ok: g.bgValid, required: false }, true);
    const p50 = v(g.echo64.stats?.p50);
    const p95 = v(g.echo64.stats?.p95);
    push({ id: `${g.sc}.c2.echo64.p50`, what: 'concurrent2: eco 64 B espaçado com capturas: p50 (ms)', value: p50, limit: `≤ ${CRITERIA.echoP50Ms}`, ok: p50 === null ? null : p50 <= CRITERIA.echoP50Ms, required: false }, true);
    push({ id: `${g.sc}.c2.echo64.p95`, what: 'concurrent2: eco 64 B espaçado com capturas: p95 (ms)', value: p95, limit: `≤ ${CRITERIA.echoP95Ms}`, ok: p95 === null ? null : p95 <= CRITERIA.echoP95Ms, required: false }, true);
    const hits = g.bgValid ? g.echo64.overlaps : null;
    push({ id: `${g.sc}.c2.echo64.overlaps`, what: `concurrent2: ecos de 64 B que cruzaram uma captura em trânsito (últimos ${g.transitMs} ms)`, value: hits, limit: '≥ 1', ok: hits === null ? null : hits >= 1, required: false }, true);
    const fp95 = v(g.fresh.stats?.p95);
    push({ id: `${g.sc}.c2.fresh.p95`, what: 'concurrent2: conexão nova com capturas: p95 (ms)', value: fp95, limit: `≤ ${CRITERIA.freshP95Ms}`, ok: fp95 === null ? null : fp95 <= CRITERIA.freshP95Ms, required: false }, true);
    const errs = g.echo64.errors + g.echo64k.errors + g.fresh.errors;
    push({ id: `${g.sc}.c2.errors`, what: 'concurrent2: chamadas do canal que falharam', value: errs, limit: '= 0', ok: errs === 0, required: false }, true);
    // Leitura literal da T-0.19 / research S0-RTT ("persistent echo p50 ≤ 5, p95 ≤ 20" valendo também para 64 KB): só registro, questão para o G1.
    const k50 = v(g.echo64k.stats?.p50);
    const k95 = v(g.echo64k.stats?.p95);
    push({ id: `${g.sc}.c2.echo64k.p50`, what: 'concurrent2: eco 64 KB com capturas: p50 (ms; leitura literal, não entra no veredito — G1)', value: k50, limit: `≤ ${CRITERIA.echoP50Ms}`, ok: k50 === null ? null : k50 <= CRITERIA.echoP50Ms, required: false }, false);
    push({ id: `${g.sc}.c2.echo64k.p95`, what: 'concurrent2: eco 64 KB com capturas: p95 (ms; leitura literal, não entra no veredito — G1)', value: k95, limit: `≤ ${CRITERIA.echoP95Ms}`, ok: k95 === null ? null : k95 <= CRITERIA.echoP95Ms, required: false }, false);
  }
  const c2ok = c2.length === 0 ? null : c2Verdict.every((c) => c.ok === true);

  const required = checks.filter((c) => c.required);
  const success = required.every((c) => c.ok === true);
  const g50 = checks.find((c) => c.id === 'ground.echo64.p50');
  const g95 = checks.find((c) => c.id === 'ground.echo64.p95');
  const gEcho = find('ground', 'echo64');
  const ac21 = g50?.ok === null || g95?.ok === null ? null : g50?.ok === true && g95?.ok === true && gEcho?.errors === 0;
  const ac26 = sever === null ? null : sever.ok === sever.rounds;
  const usb = (probe?.['usbmux'] as { usb?: { serialRaw?: string } | null } | undefined)?.usb;
  return {
    label,
    bind: typeof run?.['bind'] === 'string' ? (run['bind'] as string) : typeof probe?.['bind'] === 'string' ? (probe['bind'] as string) : null,
    configuration: typeof probe?.['configuration'] === 'string' ? (probe['configuration'] as string) : null,
    sessionId: typeof probe?.['sessionId'] === 'string' ? (probe['sessionId'] as string) : null,
    serialRaw: usb?.serialRaw ?? null,
    reach,
    rows: rowSummaries,
    ntp,
    thetaRef,
    bias,
    sever,
    air,
    drops: drops.length,
    checks,
    success,
    ac21,
    ac26,
    c2,
    c2ok,
  };
}

const fmt = (v: number | undefined | null): string => (v === undefined || v === null ? '—' : v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2));

/** As tabelas de uma execução, em Markdown, para o SP-4.md. */
export function markdownTable(s: Summary): string {
  const lines: string[] = [];
  lines.push(`### ${s.label} — bind \`${s.bind ?? '?'}\` (${s.configuration ?? '?'}), SerialNumber cru \`${s.serialRaw ?? '?'}\``);
  lines.push('');
  lines.push('| cenário | fase | n | erros | p50 | p95 | p99 | máx | medianas das partes |');
  lines.push('|---|---|---|---|---|---|---|---|---|');
  for (const r of s.rows) {
    const parts = Object.entries(r.extra).map(([k, v]) => `${k} ${fmt(v)}`).join(', ');
    lines.push(`| ${r.sc} | ${r.ph} | ${r.stats?.n ?? 0} | ${r.errors} | ${fmt(r.stats?.p50)} | ${fmt(r.stats?.p95)} | ${fmt(r.stats?.p99)} | ${fmt(r.stats?.max)} | ${parts} |`);
  }
  lines.push('');
  lines.push('Tempos em ms. `shots.bg` = capturas no fundo, na `control`, durante `echo64+shots` e `ntp+shots`.');
  lines.push('');
  lines.push('| cenário | rajadas | trocas | erros | resíduo θ (ms) | b (ppm) | RMS das rajadas (ms) | atraso p50 / mín (ms) |');
  lines.push('|---|---|---|---|---|---|---|---|');
  const ntpAll = [...s.ntp, ...(s.sever?.theta ? [s.sever.theta] : [])];
  for (const n of ntpAll) {
    lines.push(`| ${n.sc}/${n.ph} | ${n.bursts} | ${n.exchanges} | ${n.errors} | ${fmt(n.residualMs)} | ${fmt(n.bPpm)} | ${fmt(n.burstRmsMs)} | ${fmt(n.delayP50Ms)} / ${fmt(n.delayMinMs)} |`);
  }
  lines.push('');
  lines.push(
    s.thetaRef === null
      ? 'Reta de referência do θ: — (sem rajadas sem carga e sem avião).'
      : `Reta de referência do θ (ground/ntp + sever.ntp, sem carga e sem avião): ${s.thetaRef.bursts} rajadas, ${s.thetaRef.samples} amostras, ` +
          `resíduo RMS ${fmt(s.thetaRef.residualMs)} ms, b ${fmt(s.thetaRef.bPpm)} ppm.`,
  );
  if (s.bias.length > 0) {
    lines.push('');
    lines.push('| grupo | rajadas | amostras | viés contra a referência: mediana (ms) | maior |mediana| de uma rajada (ms) |');
    lines.push('|---|---|---|---|---|');
    for (const b of s.bias) lines.push(`| ${b.sc}/${b.ph} | ${b.bursts} | ${b.samples} | ${fmt(b.biasMs)} | ${fmt(b.maxBurstAbsMs)} |`);
  }
  if (s.sever !== null) {
    lines.push('');
    lines.push(
      `Reconexão (AC-2.6, só a reconexão): ${s.sever.ok}/${s.sever.rounds} rodadas; volta depois da janela p50 ${fmt(s.sever.upAfterWindowMs?.p50)} ms, ` +
        `máx ${fmt(s.sever.upAfterWindowMs?.max)} ms; chamada durante o corte falha em p50 ${fmt(s.sever.failFastMs?.p50)} ms.`,
    );
  }
  for (const g of s.c2) {
    lines.push('');
    lines.push(
      `Fase suplementar \`concurrent2\` (${g.sc}): capturas de fundo ${g.bg === null ? '—' : `${g.bg.ok} ok, ${g.bg.errors} erros${g.bg.aborted ? ', PAROU' : ''}`}; ` +
        `"em trânsito" = últimos ${g.transitMs} ms de cada captura.`,
    );
    lines.push('');
    lines.push('| grupo | n | erros | p50 | p95 | p99 | máx | cruzaram captura em trânsito | p50 / p95 / máx dos que cruzaram |');
    lines.push('|---|---|---|---|---|---|---|---|---|');
    for (const x of [g.echo64, g.echo64k, g.fresh]) {
      const o = x.overlapStats;
      lines.push(
        `| ${x.ph} | ${x.stats?.n ?? 0} | ${x.errors} | ${fmt(x.stats?.p50)} | ${fmt(x.stats?.p95)} | ${fmt(x.stats?.p99)} | ${fmt(x.stats?.max)} | ${x.overlaps} | ` +
          `${o === null ? '—' : `${fmt(o.p50)} / ${fmt(o.p95)} / ${fmt(o.max)}`} |`,
      );
    }
  }
  lines.push('');
  lines.push('| verificação | valor | limite | ok | entra no sucesso |');
  lines.push('|---|---|---|---|---|');
  for (const c of s.checks) {
    const value = typeof c.value === 'number' ? fmt(c.value) : (c.value ?? '—');
    lines.push(`| ${c.what} (\`${c.id}\`) | ${value} | ${c.limit} | ${c.ok === null ? '—' : c.ok ? 'sim' : 'NÃO'} | ${c.required ? 'sim' : 'não'} |`);
  }
  lines.push('');
  lines.push(`Sucesso (T-0.19): ${s.success ? 'sim' : 'não'} · AC-2.1: ${s.ac21 === null ? '—' : s.ac21 ? 'passa' : 'falha'} · AC-2.6 (reconexão): ${s.ac26 === null ? '—' : s.ac26 ? 'passa' : 'falha'}`);
  if (s.c2ok !== null) lines.push(`concurrent2 (fase suplementar; numa execução só com ela, o "Sucesso" acima não se aplica): ${s.c2ok ? 'passa' : 'NÃO passa'}`);
  if (s.air.skipped.length > 0) lines.push(`Avião pulado: ${s.air.skipped.join('; ')}`);
  return lines.join('\n');
}

/** Comparação das execuções (uma por forma de prender o listener) e a decisão principal × plano B. */
export function compare(summaries: Summary[]): { markdown: string; decision: string } {
  const metric = (s: Summary, id: string): string => {
    const c = s.checks.find((x) => x.id === id);
    if (c === undefined || c.value === null) return '—';
    return `${typeof c.value === 'number' ? fmt(c.value) : c.value}${c.ok === false ? ' ✗' : ''}`;
  };
  const rows: [string, (s: Summary) => string][] = [
    ['bind', (s) => s.bind ?? '?'],
    ['SerialNumber cru', (s) => (s.serialRaw === null ? '—' : `\`${s.serialRaw}\``)],
    ['alcance', (s) => s.reach ?? '—'],
    ['eco 64 B p50 / p95 (sem avião)', (s) => `${metric(s, 'ground.echo64.p50')} / ${metric(s, 'ground.echo64.p95')}`],
    ['eco 64 B p50 / p95 (avião)', (s) => `${metric(s, 'air.echo64.p50')} / ${metric(s, 'air.echo64.p95')}`],
    ['eco 64 B com capturas p95 (sem avião / avião)', (s) => `${metric(s, 'ground.echo64+shots.p95')} / ${metric(s, 'air.echo64+shots.p95')}`],
    ['conexão nova p95 (sem avião / avião)', (s) => `${metric(s, 'ground.fresh.p95')} / ${metric(s, 'air.fresh.p95')}`],
    ['desvio do θ da referência', (s) => metric(s, 'ref.ntp.residual')],
    ['viés do θ: capturas / avião / avião + capturas', (s) => `${metric(s, 'ground.ntp+shots.bias')} / ${metric(s, 'air.ntp.bias')} / ${metric(s, 'air.ntp+shots.bias')}`],
    ['captura p95 (sem avião / avião)', (s) => `${metric(s, 'ground.shots.p95')} / ${metric(s, 'air.shots.p95')}`],
    ['quedas com avião', (s) => metric(s, 'air.drops')],
    ['reconexão (AC-2.6)', (s) => metric(s, 'sever.rounds')],
    ['sucesso T-0.19', (s) => (s.success ? 'sim' : 'não')],
  ];
  const lines = [`| | ${summaries.map((s) => s.label).join(' | ')} |`, `|---|${summaries.map(() => '---').join('|')}|`];
  for (const [name, get] of rows) lines.push(`| ${name} | ${summaries.map(get).join(' | ')} |`);

  let decision: string;
  const reached = summaries.filter((s) => s.reach === 'reachable');
  const passed = summaries.filter((s) => s.success);
  if (summaries.length > 0 && reached.length === 0 && summaries.every((s) => s.reach === 'unreachable')) {
    decision = `PLANO B — ${PLAN_B}`;
  } else if (passed.length > 0) {
    const pick = passed.find((s) => s.bind === 'loopback') ?? passed[0]!;
    decision =
      `PRINCIPAL — ADR-9 confirmado: o loopback é alcançável e o critério da T-0.19 passa com bind=${passed.map((s) => s.bind).join(', ')}. ` +
      (pick.bind === 'loopback'
        ? 'Fica o padrão de produção (`requiredInterfaceType = .loopback`).'
        : 'Só a forma endpoint passou: trocar o padrão do runner é mudança de código com tarefa própria (fora do SP).');
  } else if (reached.length > 0) {
    const failed = reached.flatMap((s) => s.checks.filter((c) => c.required && c.ok !== true).map((c) => `${s.bind}:${c.id}`));
    decision =
      'INDECISO — o loopback é alcançável, mas o critério da T-0.19 não passou inteiro: ' +
      `${failed.join(', ')}. O plano B da tarefa cobre só o loopback inalcançável; levar os números ao dono.`;
  } else {
    decision = 'SEM DADOS — nenhuma execução com a sonda de alcance.';
  }
  return { markdown: lines.join('\n'), decision };
}
