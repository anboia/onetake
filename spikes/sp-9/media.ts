// Medidas na gravação de uma troca (SP-9, T-0.27): recortes PNG de quadros pelo ffmpeg 8.1.1 fixado (`openFfmpeg` de
// `mac/src/media/ffmpeg.ts`: caminho absoluto e versão conferida; nunca o do PATH, P-7), na base de tempo R = pts −
// `start_time` (`-copyts -start_at_zero`, A13), e o OCR do Mac (T-0.14, `mac/tools/ocr.swift` por `ocrImages`). Os
// recortes vão para a pasta do spike (~/Movies/contrarregra/spikes/SP-9/<rótulo>/), nunca para o repositório.
// Código de spike, descartável.

import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import type { Rect } from '../../mac/src/core/types.ts';
import { cropFilter, probeVideo, runFfmpeg, runFfprobe, timeBaseArgs, type Ffmpeg } from '../../mac/src/media/ffmpeg.ts';
import type { OcrImage } from '../../mac/src/media/ocr.ts';
import type { MarkName, MeasureContext } from './driver.ts';
import {
  STATUS_BAND_PT,
  VISUAL,
  buttonState,
  decodePng,
  earWithinBand,
  grayMeanAbsDiff,
  insetRect,
  meanRgb,
  orangeFraction,
  ptToPx,
  readClock,
  subImage,
  type ButtonRead,
  type ClockRead,
  type RgbImage,
  type VisualResult,
} from './lib.ts';

/** Legível pelo ffprobe (fim da finalização). */
export async function probeOk(ff: Ffmpeg, file: string): Promise<boolean> {
  try {
    await runFfprobe(ff, ['-show_format', '-of', 'json', file], { timeoutMs: 20_000 });
    return true;
  } catch {
    return false;
  }
}

/** Um quadro em R = `rS`, recortado em `crop` (px), gravado como PNG em `out` (que não pode existir: `-n`). */
export async function extractPng(ff: Ffmpeg, file: string, rS: number, crop: Rect, out: string): Promise<void> {
  await runFfmpeg(ff, [
    ...timeBaseArgs({ startS: Math.max(0, rS) }),
    '-i', file, '-an', '-sn', '-dn',
    '-frames:v', '1',
    '-vf', `${cropFilter(crop)},format=rgb24`,
    '-c:v', 'png', '-f', 'image2', '-n', out,
  ], { timeoutMs: 60_000 });
}

/** Um instante marcado: R no arquivo (s, de `outputDuration`) e a hora do Mac (ms). */
export interface Mark {
  rS: number;
  atMs: number;
}

export interface MeasureDeps {
  ff: Ffmpeg;
  /** Pasta do spike (onde os recortes ficam). */
  dir: string;
  ocr(paths: string[]): Promise<OcrImage[]>;
  /** Cada recorte criado (para o livro de arquivos e a limpeza do G4). */
  created(file: { name: string; path: string; ino: number; bytes: number; kind: string }): void;
}

/**
 * Os recortes e as medidas de uma troca:
 * - barra de estado (`STATUS_BAND_PT`) em `closed-before`, `closed-before-2` (ruído) e `closed-after`: OCR do relógio
 *   (9:41? hora de verdade?) e a orelha direita (ícone de avião numa barra de verdade) antes × depois;
 * - o botão do avião (frame do `ui.find`, miolo) em `cc-before` e no meio de `cc-after`…`cc-after-end`: fração
 *   laranja (ligado) e a mudança de aparência.
 */
export async function measureVisual(deps: MeasureDeps, file: string, marks: Partial<Record<MarkName, Mark>>, ctx: MeasureContext): Promise<VisualResult> {
  const info = await probeVideo(deps.ff, file);
  const lastR = Math.max(0, info.durationS - 2 * info.frameDurationS);
  const r = (m: Mark | undefined): number | null => (m === undefined ? null : Math.min(lastR, Math.max(0, m.rS - 0.05)));
  const mid = (a: Mark | undefined, b: Mark | undefined): Mark | undefined => (a === undefined ? b : b === undefined ? a : { rS: (a.rS + b.rS) / 2, atMs: (a.atMs + b.atMs) / 2 });
  const bandPx = ptToPx(STATUS_BAND_PT);
  const buttonPx = insetRect(ptToPx(ctx.button), VISUAL.buttonInset);
  const crops: string[] = [];
  const grab = async (kind: string, mark: Mark | undefined, rect: Rect): Promise<{ path: string; img: RgbImage } | null> => {
    const rS = r(mark);
    if (rS === null) return null;
    const name = `${ctx.tag}-${kind}.png`;
    const path = join(deps.dir, name);
    await extractPng(deps.ff, file, rS, rect, path);
    const st = statSync(path);
    deps.created({ name, path, ino: st.ino, bytes: st.size, kind: 'crop' });
    crops.push(name);
    return { path, img: decodePng(readFileSync(path)) };
  };
  const bandBefore = await grab('band-before', marks['closed-before'], bandPx);
  const bandBefore2 = await grab('band-before2', marks['closed-before-2'], bandPx);
  const bandAfter = await grab('band-after', marks['closed-after'], bandPx);
  const btnBefore = await grab('button-before', marks['cc-before'], buttonPx);
  const btnAfter = await grab('button-after', mid(marks['cc-after'], marks['cc-after-end']), buttonPx);

  const ear = earWithinBand(bandPx);
  const earOf = (b: { img: RgbImage } | null): RgbImage | null => (b === null ? null : subImage(b.img, ear));
  const e0 = earOf(bandBefore);
  const e1 = earOf(bandBefore2);
  const e2 = earOf(bandAfter);
  const earNoise = e0 !== null && e1 !== null ? grayMeanAbsDiff(e0, e1) : null;
  const earChange = e0 !== null && e2 !== null ? grayMeanAbsDiff(e0, e2) : null;
  const iconChanged = earChange === null ? null : earChange > Math.max(VISUAL.iconDiffMin, VISUAL.noiseFactor * (earNoise ?? 0));

  const ocrPaths = [bandBefore, bandAfter].filter((b): b is { path: string; img: RgbImage } => b !== null).map((b) => b.path);
  const ocr = ocrPaths.length === 0 ? [] : await deps.ocr(ocrPaths);
  const textsOf = (b: { path: string } | null): string[] | null => {
    if (b === null) return null;
    const hit = ocr.find((o) => o.path === b.path) ?? ocr[ocrPaths.indexOf(b.path)];
    return hit === undefined ? [] : hit.boxes.map((x) => x.text);
  };
  const clockOf = (b: { path: string } | null, m: Mark | undefined): ClockRead | null => {
    const texts = textsOf(b);
    return texts === null ? null : readClock(texts, m?.atMs ?? null);
  };

  const btn = (b: { img: RgbImage } | null): ButtonRead | null => {
    if (b === null) return null;
    const orange = orangeFraction(b.img);
    return { orange: Math.round(orange * 1000) / 1000, rgb: meanRgb(b.img), state: buttonState(orange) };
  };
  const btnDiff = btnBefore !== null && btnAfter !== null ? grayMeanAbsDiff(btnBefore.img, btnAfter.img) : null;
  return {
    statusBar: {
      before: clockOf(bandBefore, marks['closed-before']),
      after: clockOf(bandAfter, marks['closed-after']),
      earNoise: earNoise === null ? null : Math.round(earNoise * 100) / 100,
      earChange: earChange === null ? null : Math.round(earChange * 100) / 100,
      iconChanged,
    },
    button: {
      frameSource: ctx.buttonSource,
      rectPx: buttonPx,
      before: btn(btnBefore),
      after: btn(btnAfter),
      diff: btnDiff === null ? null : Math.round(btnDiff * 100) / 100,
      changed: btnDiff === null ? null : btnDiff >= VISUAL.buttonChangedMin,
    },
    crops,
  };
}
