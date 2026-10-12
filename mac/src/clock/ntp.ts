// Elo aparelho → Mac da sincronia (spec S7 item 2; ADR-15): rajadas de trocas de 4 carimbos estilo
// NTP (RFC 5905), o quarto de menor atraso de cada rajada e o ajuste robusto θ(t) = a + b·t
// (Theil-Sen). D = relógio do aparelho (`CLOCK_MONOTONIC_RAW`, ns); M = relógio do Mac
// (`process.hrtime.bigint()`, ns). θ = D − M, e t é o tempo M da amostra (meio de T1 e T4), então
// D = a + (1 + b)·M. Tempos em `bigint` (inteiros de 64 bits, S0.7); os ajustes trabalham em `number`
// relativo à primeira amostra para não perder precisão.

import { ContrarregraError } from '../core/errors.ts';
import { median, theilSen } from './fit.ts';

/** Uma troca: T1 Mac envia, T2 aparelho recebe, T3 aparelho responde, T4 Mac recebe. */
export interface Exchange {
  t1: bigint;
  t2: bigint;
  t3: bigint;
  t4: bigint;
}

/** Fração de cada rajada que entra no ajuste: o quarto de menor atraso (S7 item 2). */
export const KEEP_FRACTION = 1 / 4;
/** Qualidade do ajuste (S7 item 2): fora disso, aviso `E_SYNC_QUALITY`. */
export const MAX_RESIDUAL_MS = 2;
export const MAX_ABS_PPM = 150;

/** Aviso de sincronia: não derruba a tomada; vai para o relatório (S7). */
export interface SyncWarning {
  code: 'E_SYNC_QUALITY';
  message: string;
  data: Record<string, unknown>;
}

/** Amostra que entra no ajuste: tempo M do meio da troca, θ e atraso, e a rajada de origem. */
export interface ClockSample {
  burst: number;
  macNs: bigint;
  offsetNs: bigint;
  delayNs: bigint;
}

/**
 * Resultado do ajuste; `aNs`, `bPpm`, `residualMs`, `samples` e `bursts` são os campos de
 * `SyncReport.deviceToMac` (S0.9). `b` é adimensional (`bPpm` = b·10⁶).
 */
export interface ClockFit {
  aNs: bigint;
  b: number;
  bPpm: number;
  /** RMS dos resíduos das amostras usadas, em ms. */
  residualMs: number;
  /** Amostras usadas (o quarto de menor atraso de cada rajada). */
  samples: number;
  /** Rajadas com ao menos uma amostra. */
  bursts: number;
  /** `false` com uma rajada só (E-7.1): `b` fica 0 e a inclinação vem do ajuste visual. */
  slopeEstimated: boolean;
  warnings: SyncWarning[];
}

/** θ = ½[(T2−T1)+(T3−T4)], em ns (a meia unidade é truncada). */
export function exchangeOffsetNs(e: Exchange): bigint {
  return (e.t2 - e.t1 + (e.t3 - e.t4)) / 2n;
}

/** Atraso de ida e volta, descontado o tempo no aparelho: (T4−T1) − (T3−T2), em ns. */
export function exchangeDelayNs(e: Exchange): bigint {
  return e.t4 - e.t1 - (e.t3 - e.t2);
}

/** O quarto de menor atraso de uma rajada (arredondado para cima: 8 de 32). */
export function selectLowestDelay(exchanges: readonly Exchange[], burst: number): ClockSample[] {
  const samples = exchanges.map((e) => ({
    burst,
    macNs: (e.t1 + e.t4) / 2n,
    offsetNs: exchangeOffsetNs(e),
    delayNs: exchangeDelayNs(e),
  }));
  samples.sort((x, y) => (x.delayNs < y.delayNs ? -1 : x.delayNs > y.delayNs ? 1 : 0));
  return samples.slice(0, Math.ceil(samples.length * KEEP_FRACTION));
}

/**
 * Ajusta θ(t) = a + b·t sobre o quarto de menor atraso de cada rajada (Theil-Sen; pares da mesma
 * rajada não entram na inclinação). Sem nenhuma troca → `E_SYNC_QUALITY`. Resíduo > 2 ms ou
 * |b| > 150 ppm → aviso `E_SYNC_QUALITY` no resultado (não exceção).
 */
export function fitClock(bursts: readonly (readonly Exchange[])[]): ClockFit {
  const samples = bursts.flatMap((exchanges, i) => selectLowestDelay(exchanges, i));
  if (samples.length === 0) {
    throw new ContrarregraError('E_SYNC_QUALITY', 'nenhuma troca de sincronia para ajustar (S7 item 2)', { bursts: bursts.length });
  }
  const burstCount = new Set(samples.map((s) => s.burst)).size;
  const tRef = samples[0]!.macNs;
  const thetaRef = samples[0]!.offsetNs;
  const points = samples.map((s) => ({ x: Number(s.macNs - tRef), y: Number(s.offsetNs - thetaRef), group: s.burst }));

  const line = burstCount >= 2 ? theilSen(points) : null;
  const b = line ? line.slope : 0;
  const intercept = line ? line.intercept : median(points.map((p) => p.y));
  const sumSq = points.reduce((sum, p) => sum + (p.y - (intercept + b * p.x)) ** 2, 0);
  const residualMs = Math.sqrt(sumSq / points.length) / 1e6;
  const aNs = thetaRef + BigInt(Math.round(intercept - b * Number(tRef)));
  const bPpm = b * 1e6;

  const warnings: SyncWarning[] = [];
  if (residualMs > MAX_RESIDUAL_MS) {
    warnings.push({
      code: 'E_SYNC_QUALITY',
      message: `resíduo do ajuste aparelho→Mac ${residualMs.toFixed(3)} ms > ${MAX_RESIDUAL_MS} ms (S7 item 2)`,
      data: { residualMs, limitMs: MAX_RESIDUAL_MS },
    });
  }
  if (Math.abs(bPpm) > MAX_ABS_PPM) {
    warnings.push({
      code: 'E_SYNC_QUALITY',
      message: `deriva aparelho→Mac |b| = ${Math.abs(bPpm).toFixed(2)} ppm > ${MAX_ABS_PPM} ppm (S7 item 2)`,
      data: { bPpm, limitPpm: MAX_ABS_PPM },
    });
  }
  return { aNs, b, bPpm, residualMs, samples: samples.length, bursts: burstCount, slopeEstimated: line !== null, warnings };
}

/** θ(M) = a + b·M, em ns. */
export function offsetAtNs(fit: Pick<ClockFit, 'aNs' | 'b'>, macNs: bigint): bigint {
  return fit.aNs + BigInt(Math.round(fit.b * Number(macNs)));
}

/** M → D: D = M + θ(M). */
export function macToDeviceNs(fit: Pick<ClockFit, 'aNs' | 'b'>, macNs: bigint): bigint {
  return macNs + offsetAtNs(fit, macNs);
}

/** D → M: M = (D − a)/(1 + b). */
export function deviceToMacNs(fit: Pick<ClockFit, 'aNs' | 'b'>, deviceNs: bigint): bigint {
  const u = deviceNs - fit.aNs;
  return u - BigInt(Math.round((Number(u) * fit.b) / (1 + fit.b)));
}
