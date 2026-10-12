// Detecção por região (spec S7 item 4; E-7.3; AC-7.6): para um passo `visual: true`, recorta uma
// região em volta do alvo (frame em pontos × 3 px/pt) e acha o primeiro quadro que muda depois do
// previsto: o tempo vem do `signalstats` YDIF e a classificação da mudança do `tblend` (diferença)
// YMAX ≥ 64 (research/timing-post.md F14: no recorte, ruído de keyframe 26–37 × mudança real 232).
// Sem mudança classificada na janela → `null` (o evento fica marcado e fora do ajuste).

import type { Rect } from '../core/types.ts';
import { signalstats, type Ffmpeg, type VideoInfo } from '../media/ffmpeg.ts';

/** Canvas do OBS em 1170×2532 = tela do iPhone 12 a 3 px/pt (S9 item 1). */
export const PX_PER_PT = 3;
/** YMAX da diferença entre quadros a partir do qual a região "muda" (S7 item 4). */
export const CHANGE_YMAX = 64;
/** Folga ao comparar `pts_time` (impresso com 6 casas) com o previsto. */
const PTS_EPSILON_S = 1e-6;

export interface RegionChange {
  /** R (s) do primeiro quadro que muda (pts − `start_time` do arquivo). */
  ptsS: number;
  /** YDIF desse quadro (vai para `detectScore`). */
  score: number;
  /** YMAX da diferença nesse quadro (≥ `CHANGE_YMAX`). */
  ymax: number;
}

export interface RegionWindow {
  /** Região em px do quadro (de `regionPx`). */
  region: Rect;
  /** Tempo previsto (R, s): só quadros com pts ≥ este contam. */
  fromS: number;
  /** Fim da janela de busca (R, s), exclusivo. */
  toS: number;
}

/**
 * Frame em pontos → região em px (× `pxPerPt`), arredondada para fora e recortada nos limites do
 * vídeo. Vazia (ou toda fora) → `null`.
 */
export function regionPx(framePt: Rect, video: Pick<VideoInfo, 'width' | 'height'>, pxPerPt = PX_PER_PT): Rect | null {
  if (!(framePt.w > 0 && framePt.h > 0)) return null;
  const x0 = Math.max(0, Math.floor(framePt.x * pxPerPt));
  const y0 = Math.max(0, Math.floor(framePt.y * pxPerPt));
  const x1 = Math.min(video.width, Math.ceil((framePt.x + framePt.w) * pxPerPt));
  const y1 = Math.min(video.height, Math.ceil((framePt.y + framePt.h) * pxPerPt));
  if (x1 <= x0 || y1 <= y0) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/**
 * Primeiro quadro com pts em [fromS, toS) cuja diferença para o anterior tem YMAX ≥ 64 na região.
 * A decodificação começa 1,5 quadro antes de `fromS` para o primeiro quadro da janela ter anterior.
 */
export async function detectRegionChange(
  ff: Ffmpeg,
  file: string,
  video: Pick<VideoInfo, 'frameDurationS'>,
  window: RegionWindow,
): Promise<RegionChange | null> {
  const startS = Math.max(0, window.fromS - 1.5 * video.frameDurationS);
  if (!(window.toS > window.fromS)) throw new RangeError(`janela vazia: ${window.fromS}…${window.toS}`);
  const span = { startS, durationS: window.toS - startS };
  const [ydif, diff] = await Promise.all([
    signalstats(ff, file, { ...span, crop: window.region }),
    signalstats(ff, file, { ...span, crop: window.region, difference: true }),
  ]);
  const key = (ptsS: number): number => Math.round(ptsS * 1e6);
  const ymaxByPts = new Map(diff.map((s) => [key(s.ptsS), s.values['YMAX']]));
  for (const frame of ydif) {
    if (frame.ptsS < window.fromS - PTS_EPSILON_S) continue;
    const ymax = ymaxByPts.get(key(frame.ptsS));
    if (ymax !== undefined && ymax >= CHANGE_YMAX) {
      return { ptsS: frame.ptsS, score: frame.values['YDIF'] ?? 0, ymax };
    }
  }
  return null;
}
