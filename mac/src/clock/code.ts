// Código do relógio de calibração (spec S0.10; AC-0.8, lado do Mac): o hospedeiro desenha, a cada
// quadro, D em ms (`floor(rawNs / 1e6) mod 2^40`) num código de blocos de 5 linhas × 8 colunas de
// células de 44×44 pt (bit mais significativo na célula de cima à esquerda, ordem por linhas,
// branco = 1, preto = 0), com uma 6.ª linha de paridade par por coluna, sobre fundo cinza médio. O
// Mac decodifica amostrando o centro de cada célula. Usado na calibração da latência de captura
// (S7 item 7). A posição da grade na tela não é fixada por S0.10: entra como parâmetro (`geometry`).

import type { Rect } from '../core/types.ts';
import type { Ffmpeg, WindowOptions } from '../media/ffmpeg.ts';
import { grayFrames } from '../media/frames.ts';

export const CODE_COLUMNS = 8;
export const CODE_DATA_ROWS = 5;
/** 5 linhas de dados + 1 de paridade. */
export const CODE_ROWS = CODE_DATA_ROWS + 1;
export const CODE_BITS = CODE_DATA_ROWS * CODE_COLUMNS;
/** Lado da célula em pontos (S0.10); × 3 px/pt = 132 px num quadro 1170×2532. */
export const CELL_PT = 44;
/**
 * Classificação da amostra do centro (média, 0–255): ≥ `WHITE_MIN` → 1, ≤ `BLACK_MAX` → 0; no meio
 * (o cinza médio do fundo, ou um quadro de transição) a célula é ilegível. Constantes de
 * implementação, não da spec: o cinza médio (~128) fica longe dos dois lados.
 */
export const WHITE_MIN = 176;
export const BLACK_MAX = 80;

const MAX_VALUE = 2 ** CODE_BITS;

/** Onde está a grade no quadro: canto superior esquerdo da célula (0, 0) e lado da célula, em px. */
export interface ClockCodeGeometry {
  x: number;
  y: number;
  cellPx: number;
}

/** Imagem em cinza, 8 bits por pixel, por linhas (a forma de `GrayFrame` de `media/frames.ts`). */
export interface GrayImage {
  width: number;
  height: number;
  data: Uint8Array;
}

export interface UnreadableCell {
  row: number;
  col: number;
  luma: number;
}

export type ClockCodeDecode =
  | { ok: true; valueMs: number }
  | { ok: false; reason: 'unreadable'; cells: UnreadableCell[] }
  | { ok: false; reason: 'parity'; columns: number[] };

/** Valor desenhado: floor(D/1e6) mod 2^40, de D em ns. */
export function clockCodeValueMs(rawNs: bigint): number {
  if (rawNs < 0n) throw new RangeError(`D negativo: ${rawNs}`);
  return Number((rawNs / 1_000_000n) % BigInt(MAX_VALUE));
}

/** As 6 × 8 células (0/1): linhas 0–4 com os 40 bits (MSB primeiro, por linhas), linha 5 = paridade par. */
export function encodeClockCode(valueMs: number): number[][] {
  if (!Number.isInteger(valueMs) || valueMs < 0 || valueMs >= MAX_VALUE) {
    throw new RangeError(`valor fora de 0…2^40−1: ${valueMs}`);
  }
  const rows: number[][] = [];
  for (let r = 0; r < CODE_DATA_ROWS; r++) {
    const row: number[] = [];
    for (let c = 0; c < CODE_COLUMNS; c++) {
      const bit = CODE_BITS - 1 - (r * CODE_COLUMNS + c);
      row.push(Math.floor(valueMs / 2 ** bit) % 2);
    }
    rows.push(row);
  }
  rows.push(Array.from({ length: CODE_COLUMNS }, (_, c) => rows.reduce((sum, row) => sum + row[c]!, 0) % 2));
  return rows;
}

/** Retângulo em px que a grade ocupa (6 × 8 células). */
export function clockCodeBounds(geometry: ClockCodeGeometry): Rect {
  return { x: geometry.x, y: geometry.y, w: geometry.cellPx * CODE_COLUMNS, h: geometry.cellPx * CODE_ROWS };
}

/**
 * Decodifica pela média de um quadrado no centro de cada célula (lado = 1/3 da célula). Célula
 * ilegível → `unreadable`; coluna com paridade ímpar → `parity` (acusa qualquer bit trocado). A grade
 * fora da imagem é erro de uso (exceção).
 */
export function decodeClockCode(image: GrayImage, geometry: ClockCodeGeometry): ClockCodeDecode {
  const bounds = clockCodeBounds(geometry);
  if (
    !Number.isInteger(geometry.x) || !Number.isInteger(geometry.y) || !Number.isInteger(geometry.cellPx) ||
    geometry.cellPx < 1 || bounds.x < 0 || bounds.y < 0 ||
    bounds.x + bounds.w > image.width || bounds.y + bounds.h > image.height
  ) {
    throw new RangeError(`grade do código fora da imagem: ${JSON.stringify(bounds)} em ${image.width}×${image.height}`);
  }
  const patch = Math.max(1, Math.round(geometry.cellPx / 3));
  const inset = Math.floor((geometry.cellPx - patch) / 2);
  const bits: number[][] = [];
  const unreadable: UnreadableCell[] = [];
  for (let r = 0; r < CODE_ROWS; r++) {
    const row: number[] = [];
    for (let c = 0; c < CODE_COLUMNS; c++) {
      const x0 = geometry.x + c * geometry.cellPx + inset;
      const y0 = geometry.y + r * geometry.cellPx + inset;
      let sum = 0;
      for (let y = y0; y < y0 + patch; y++) {
        const offset = y * image.width;
        for (let x = x0; x < x0 + patch; x++) sum += image.data[offset + x]!;
      }
      const luma = sum / (patch * patch);
      if (luma >= WHITE_MIN) row.push(1);
      else if (luma <= BLACK_MAX) row.push(0);
      else {
        row.push(0);
        unreadable.push({ row: r, col: c, luma });
      }
    }
    bits.push(row);
  }
  if (unreadable.length > 0) return { ok: false, reason: 'unreadable', cells: unreadable };
  const columns: number[] = [];
  for (let c = 0; c < CODE_COLUMNS; c++) {
    if (bits.reduce((sum, row) => sum + row[c]!, 0) % 2 !== 0) columns.push(c);
  }
  if (columns.length > 0) return { ok: false, reason: 'parity', columns };
  let valueMs = 0;
  for (let r = 0; r < CODE_DATA_ROWS; r++) {
    for (let c = 0; c < CODE_COLUMNS; c++) valueMs = valueMs * 2 + bits[r]![c]!;
  }
  return { ok: true, valueMs };
}

export interface ClockCodeFrame {
  ptsS: number;
  decode: ClockCodeDecode;
}

/** Decodifica o código em cada quadro do vídeo (só a região da grade é extraída), com o tempo R. */
export async function* decodeClockVideo(
  ff: Ffmpeg,
  file: string,
  geometry: ClockCodeGeometry,
  window: WindowOptions = {},
): AsyncGenerator<ClockCodeFrame> {
  const local: ClockCodeGeometry = { x: 0, y: 0, cellPx: geometry.cellPx };
  for await (const frame of grayFrames(ff, file, { ...window, crop: clockCodeBounds(geometry) })) {
    yield { ptsS: frame.ptsS, decode: decodeClockCode(frame, local) };
  }
}
