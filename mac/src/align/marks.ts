// Elo Mac → gravação da sincronia (spec S7 item 3; ADR-15): as 8 marcas "Sync Flash" (fonte de cor
// branca de tela inteira, 2 quadros, intervalos de 400–900 ms) achadas pela luminância média
// (`signalstats` YAVG); T0ᵢ = T1ᵢ − kᵢ·Δ + Δ/2, com kᵢ·Δ = `pts_time` do primeiro quadro da marca;
// T0 = média dos T0ᵢ; erro padrão = desvio-padrão/√n. Pré + pós dão a deriva. T0 = tempo M (ns) do
// quadro R = 0; R = tempo do arquivo gravado (s) = pts − `start_time` do arquivo, a base de tempo de
// `media/ffmpeg.ts` (a mesma com ou sem janela).

import { ContrarregraError } from '../core/errors.ts';
import { median } from '../clock/fit.ts';
import { probeVideo, signalstats, type Ffmpeg, type WindowOptions } from '../media/ffmpeg.ts';

/**
 * Contraste mínimo (níveis de luma) entre o pico da janela e a mediana para haver marca. Constante de
 * implementação: a fonte é branca de tela inteira, então uma marca real fica muito acima disso.
 */
export const MIN_MARK_CONTRAST = 32;

export interface LumaSample {
  ptsS: number;
  yavg: number;
}

/** Primeiro quadro de uma marca. */
export interface Mark {
  ptsS: number;
  yavg: number;
}

export interface MeasuredMarks {
  fps: number;
  frameDurationS: number;
  marks: Mark[];
  series: LumaSample[];
}

/** Campos de `SyncReport.macToRecording` (S0.9) e os T0ᵢ de cada marca. */
export interface MarkerFit {
  t0MacNs: bigint;
  t0StdErrMs: number;
  fps: number;
  markers: number;
  maxMarkerDevMs: number;
  t0iNs: bigint[];
  /** Média dos R das marcas (s): onde este T0 vale, para a deriva entre pré e pós. */
  meanRS: number;
}

/** M → R: R = (M − T0)/(1 + deriva), com T0 = M do quadro R = 0. */
export interface RecordingMap {
  t0MacNs: bigint;
  drift: number;
  driftPpm: number;
}

/**
 * Marcas numa série de YAVG: subidas acima do meio entre a mediana (a tela parada) e o pico. Sem
 * contraste ≥ `minContrast`, não há marca.
 */
export function findMarks(series: readonly LumaSample[], minContrast = MIN_MARK_CONTRAST): Mark[] {
  if (series.length < 2) return [];
  const base = median(series.map((s) => s.yavg));
  const peak = series.reduce((max, s) => Math.max(max, s.yavg), -Infinity);
  if (peak - base < minContrast) return [];
  const threshold = (base + peak) / 2;
  const marks: Mark[] = [];
  for (let i = 1; i < series.length; i++) {
    const s = series[i]!;
    if (s.yavg >= threshold && series[i - 1]!.yavg < threshold) marks.push({ ptsS: s.ptsS, yavg: s.yavg });
  }
  return marks;
}

/** Mede YAVG do quadro inteiro na janela (pré-rolo ou pós-rolo) e acha as marcas. */
export async function measureMarks(ff: Ffmpeg, file: string, window: WindowOptions = {}): Promise<MeasuredMarks> {
  const info = await probeVideo(ff, file);
  const stats = await signalstats(ff, file, window);
  const series = stats.flatMap((s) => (s.values['YAVG'] === undefined ? [] : [{ ptsS: s.ptsS, yavg: s.values['YAVG'] }]));
  return { fps: info.fps, frameDurationS: info.frameDurationS, marks: findMarks(series), series };
}

/**
 * T0 pelas marcas: uma marca achada por envio, na mesma ordem. Contagem diferente (fonte "Sync
 * Flash" ausente, marca perdida) → `E_OBS_CONFIG` (E-7.2). Com uma marca só, o erro padrão fica 0.
 */
export function fitT0(sendsNs: readonly bigint[], marks: readonly Pick<Mark, 'ptsS'>[], fps: number): MarkerFit {
  if (marks.length === 0 || marks.length !== sendsNs.length) {
    throw new ContrarregraError(
      'E_OBS_CONFIG',
      `marcas "Sync Flash" achadas: ${marks.length} de ${sendsNs.length} enviadas (fonte ausente ou fora da janela; E-7.2)`,
      { sent: sendsNs.length, found: marks.length },
    );
  }
  if (!(fps > 0)) throw new RangeError(`fps inválido: ${fps}`);
  const halfFrameNs = BigInt(Math.round(1e9 / fps / 2));
  const t0iNs = marks.map((mark, i) => sendsNs[i]! - BigInt(Math.round(mark.ptsS * 1e9)) + halfFrameNs);
  const ref = t0iNs[0]!;
  const rel = t0iNs.map((t) => Number(t - ref));
  const mean = rel.reduce((a, b) => a + b, 0) / rel.length;
  const n = rel.length;
  const sd = n > 1 ? Math.sqrt(rel.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (n - 1)) : 0;
  return {
    t0MacNs: ref + BigInt(Math.round(mean)),
    t0StdErrMs: sd / Math.sqrt(n) / 1e6,
    fps,
    markers: n,
    maxMarkerDevMs: Math.max(...rel.map((v) => Math.abs(v - mean))) / 1e6,
    t0iNs,
    meanRS: marks.reduce((sum, m) => sum + m.ptsS, 0) / n,
  };
}

/** A reta M → R: só o pré (deriva 0) ou pré + pós (deriva pela diferença dos dois T0). */
export function recordingMap(pre: MarkerFit, post?: MarkerFit): RecordingMap {
  if (!post) return { t0MacNs: pre.t0MacNs, drift: 0, driftPpm: 0 };
  const spanNs = (post.meanRS - pre.meanRS) * 1e9;
  if (!(spanNs > 0)) throw new RangeError('marcas do pós-rolo precisam vir depois das do pré-rolo');
  const drift = Number(post.t0MacNs - pre.t0MacNs) / spanNs;
  return { t0MacNs: pre.t0MacNs - BigInt(Math.round(drift * pre.meanRS * 1e9)), drift, driftPpm: drift * 1e6 };
}

/** M (ns) → R (s). */
export function macToRecordingS(map: RecordingMap, macNs: bigint): number {
  return Number(macNs - map.t0MacNs) / 1e9 / (1 + map.drift);
}
