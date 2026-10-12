// Latência de captura e tempo de cada evento no vídeo (spec S7 itens 4–6; ADR-15; SM-2).
// P = `tPredRawS` = `tDispatchNs` levado a M (θ) e a R (T0), sem latência; V = quadro observado em R
// (`tVideoObservedS` + `trim.startR`). Ajuste V = α + (1+β)·P sobre os passos `visual: true`
// detectados (mínimos quadrados); `tRecS` = α + (1+β)·P; `tFinalS` = `tRecS` − `trim.startR`. Erro
// (SM-2) deixando um de fora: |Vᵢ − V̂₋ᵢ|, com V̂₋ᵢ do ajuste sem o passo i; meta mediana ≤ 50 ms e
// máximo ≤ 100 ms, com ≥ 10 detectados.

import type { Event } from '../core/types.ts';
import { leastSquares, median } from '../clock/fit.ts';
import { deviceToMacNs, type ClockFit, type SyncWarning } from '../clock/ntp.ts';
import { macToRecordingS, type RecordingMap } from './marks.ts';

/** Meta de SM-2 (S7 item 6). */
export const SM2_MEDIAN_MS = 50;
export const SM2_MAX_MS = 100;
/** Abaixo disso, α vem de `sync.captureLatencyMs` (S7 item 6). */
export const MIN_FIT_EVENTS = 2;
/** Abaixo disso, o erro não é avaliado (`error: null`, `ok: false`; S7 item 6). */
export const MIN_EVAL_EVENTS = 10;

/** Passo visual: P em R (s) e V observado em R (s), ou `null` sem mudança detectada (AC-7.6). */
export interface VisualPoint {
  pS: number;
  vS: number | null;
}

export interface LatencyLine {
  alphaS: number;
  beta: number;
}

/** Os campos de `SyncReport.error` (S0.9). */
export interface LooError {
  method: 'leave-one-out';
  medianMs: number;
  maxMs: number;
  rawMedianMs: number;
  rawMaxMs: number;
}

export interface LatencyFit extends LatencyLine {
  /**
   * De onde vêm α e β: `'calibrated'` e `'none'` são os valores de `captureLatency.method` de S7 item
   * 6; `'fit'` = ajuste visual com ≥ 2 detectados (S7 não nomeia este valor no `sync.json`).
   */
  basis: 'fit' | 'calibrated' | 'none';
  /** Passos detectados usados no ajuste (0 quando α não vem do ajuste). */
  eventsUsed: number;
  error: LooError | null;
  ok: boolean;
  warnings: SyncWarning[];
}

export interface LatencyOptions {
  /** `sync.captureLatencyMs` da config (S0.1): α quando há < 2 detectados, e a base do erro bruto. */
  captureLatencyMs?: number;
}

type Detected = { pS: number; vS: number };

/** V = α + (1+β)·P por mínimos quadrados. */
export function fitLatencyLine(points: readonly Detected[]): LatencyLine {
  const line = leastSquares(points.map((p) => ({ x: p.pS, y: p.vS })));
  return { alphaS: line.intercept, beta: line.slope - 1 };
}

function predict(line: LatencyLine, pS: number): number {
  return line.alphaS + (1 + line.beta) * pS;
}

/** |Vᵢ − V̂₋ᵢ| em ms, para cada passo, com o ajuste feito sem ele. */
export function leaveOneOutErrorsMs(points: readonly Detected[]): number[] {
  return points.map((p, i) => {
    const others = points.filter((_, j) => j !== i);
    return Math.abs(p.vS - predict(fitLatencyLine(others), p.pS)) * 1000;
  });
}

/**
 * Ajuste da latência de captura e erro de SM-2 (S7 itens 4 e 6). Passos com `vS: null` ficam fora.
 * < 2 detectados: α = `captureLatencyMs`, β = 0 (`calibrated`); sem ela, α = 0 (`none`), `ok: false`
 * e aviso `E_SYNC_QUALITY`. < 10 detectados: `error: null`, `ok: false`. O erro bruto usa só θ, T0 e
 * `captureLatencyMs` (0 se vazio), para expor viés.
 */
export function fitCaptureLatency(points: readonly VisualPoint[], options: LatencyOptions = {}): LatencyFit {
  const detected = points.filter((p): p is Detected => p.vS !== null);
  const warnings: SyncWarning[] = [];
  if (detected.length < MIN_FIT_EVENTS) {
    if (options.captureLatencyMs !== undefined) {
      return { basis: 'calibrated', alphaS: options.captureLatencyMs / 1000, beta: 0, eventsUsed: 0, error: null, ok: false, warnings };
    }
    warnings.push({
      code: 'E_SYNC_QUALITY',
      message: `${detected.length} passo(s) visual(is) detectado(s) e sync.captureLatencyMs vazio: α = 0, sem latência de captura (S7 item 6)`,
      data: { detected: detected.length },
    });
    return { basis: 'none', alphaS: 0, beta: 0, eventsUsed: 0, error: null, ok: false, warnings };
  }
  const line = fitLatencyLine(detected);
  if (detected.length < MIN_EVAL_EVENTS) {
    return { basis: 'fit', ...line, eventsUsed: detected.length, error: null, ok: false, warnings };
  }
  const loo = leaveOneOutErrorsMs(detected);
  const rawLatencyS = (options.captureLatencyMs ?? 0) / 1000;
  const raw = detected.map((p) => Math.abs(p.vS - (p.pS + rawLatencyS)) * 1000);
  const error: LooError = {
    method: 'leave-one-out',
    medianMs: median(loo),
    maxMs: Math.max(...loo),
    rawMedianMs: median(raw),
    rawMaxMs: Math.max(...raw),
  };
  const ok = error.medianMs <= SM2_MEDIAN_MS && error.maxMs <= SM2_MAX_MS;
  return { basis: 'fit', ...line, eventsUsed: detected.length, error, ok, warnings };
}

/** P = D levado a M (θ) e a R (T0), sem latência (S7 item 4). */
export function predictRawS(deviceNs: bigint, clock: Pick<ClockFit, 'aNs' | 'b'>, recording: RecordingMap): number {
  return macToRecordingS(recording, deviceToMacNs(clock, deviceNs));
}

export interface EventTimesContext {
  clock: Pick<ClockFit, 'aNs' | 'b'>;
  recording: RecordingMap;
  latency: LatencyLine;
  /** `trim.startR` (s): F = R − trim.startR. */
  trimStartR: number;
}

export interface EventTimes {
  tPredRawS: number;
  tRecS: number;
  tFinalS: number;
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * Tempos do evento no vídeo (S7 item 5), com 3 casas (S0.7). Eventos do runner: `tDispatchNs`, ou
 * `tDevStartNs` quando não há (`scene.*`, `checkpoint.*`), com o ajuste (α, β). Eventos do Mac:
 * `tMacNs` → R só por T0, sem latência. Sem nenhum desses tempos → `null`.
 */
export function eventTimes(event: Event, ctx: EventTimesContext): EventTimes | null {
  const device = event.tDispatchNs ?? event.tDevStartNs;
  if (typeof device === 'string') {
    const pS = predictRawS(BigInt(device), ctx.clock, ctx.recording);
    const recS = predict(ctx.latency, pS);
    return { tPredRawS: round3(pS), tRecS: round3(recS), tFinalS: round3(recS - ctx.trimStartR) };
  }
  if (typeof event.tMacNs === 'string') {
    const rS = macToRecordingS(ctx.recording, BigInt(event.tMacNs));
    return { tPredRawS: round3(rS), tRecS: round3(rS), tFinalS: round3(rS - ctx.trimStartR) };
  }
  return null;
}
