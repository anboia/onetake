// Lógica do driver do SP-5 parte 1 (T-0.20; S9 itens 1, 3 e 6; ADR-4, ADR-14; AC-9.3 parcial, AC-9.7; ⏳ Q-8) que não
// depende do OBS, do aparelho nem do ffmpeg: as configurações da fonte, a conta de disco (HC-11), um leitor de PNG,
// as regiões da tela do relógio de calibração e a medida de cor, o áudio (picos por janela, bordas de pausa/play,
// envelope e correlação do microfone), a virada do ícone de Play/Pause (A/V), a leitura do `ffprobe` e do registro do
// OBS, a estatística do código do relógio e os veredictos de cada critério. Código de spike, descartável
// (architecture.md A5); testado em `sp5.test.ts` (`node --test spikes/sp-5/sp5.test.ts`).

import { inflateSync } from 'node:zlib';

import type { Rect } from '../../mac/src/core/types.ts';

export type Json = Record<string, unknown>;

export const GiB = 1024 ** 3;

// ---------------------------------------------------------------------------------------------------------
// Tela, quadro e fonte (S9 item 1)

/** A fonte nativa do iPhone 12 (S9 item 3: tamanho antes do recorte). */
export const NATIVE = { width: 1170, height: 2532 } as const;
/** Tela base = saída do perfil "Contrarregra" (G1 de 2026-10-13). */
export const CANVAS = { width: 1168, height: 2532 } as const;
/** Recorte de 1 px à esquerda (e à direita): x no quadro gravado = x nativo − 1. */
export const CROP_LEFT_PX = 1;
/** px por ponto no iPhone 12. */
export const PX_PER_PT = 3;
/** Tela do iPhone 12 em pontos. */
export const SCREEN_PT = { w: 390, h: 844 } as const;
/** Os dois tipos de fonte de captura do OBS 31.1.2 no macOS (pesquisa capture F6). */
export const AVCAPTURE_KIND = 'macos-avcapture';
export const FAST_KIND = 'macos-avcapture-fast';
/** A fonte temporária do teste "Capture Card": criada e removida pelo próprio spike, só na coleção "Contrarregra". */
export const TEMP_INPUT = 'SP-5 Capture Card';
/** Saída de arquivo do modo Avançado. */
export const ADV_FILE_OUTPUT = 'adv_file_output';
/** Taxa do vídeo gravado (`record.fps`). */
export const FPS = 60;

/** Uma das configurações da fonte medidas (T-0.20). `settings` entra por cima dos ajustes atuais da fonte. */
export interface SourceConfig {
  id: string;
  label: string;
  kind: typeof AVCAPTURE_KIND | typeof FAST_KIND;
  settings: Json;
  /** Precisa do formato listado pelo OBS (`supported_format`); sem ele, a configuração não se aplica. */
  needsFormat?: boolean;
}

export const PRESET_HIGH = 'AVCaptureSessionPresetHigh';
export const PRESET_4K = 'AVCaptureSessionPreset3840x2160';

/**
 * As quatro da T-0.20 (pesquisa capture, risco "não nativo / cor lavada") e duas variantes de cor (plano B do mesmo
 * risco, só com `--configs`): `video_range` 1 = parcial, 2 = cheia (enum `video_range_type` da libobs). No OBS 31.1.2
 * a fonte só expõe `video_range`/`color_space`/`input_format` no modo de formato (`use_preset: false`; o probe-1 de
 * 2026-10-14 achou "Unable to find a property by that name" com o preset), por isso as variantes de cor são do formato.
 */
export const CONFIGS: Readonly<Record<string, SourceConfig>> = {
  high: { id: 'high', label: 'preset High', kind: AVCAPTURE_KIND, settings: { use_preset: true, preset: PRESET_HIGH } },
  format60: {
    id: 'format60',
    label: 'formato manual, 60 fps',
    kind: AVCAPTURE_KIND,
    settings: { use_preset: false, frame_rate: { numerator: FPS, denominator: 1 } },
    needsFormat: true,
  },
  capturecard: { id: 'capturecard', label: '"Capture Card" (macos-avcapture-fast), preset High', kind: FAST_KIND, settings: { use_preset: true, preset: PRESET_HIGH } },
  preset4k: { id: 'preset4k', label: 'preset 4K (3840×2160)', kind: AVCAPTURE_KIND, settings: { use_preset: true, preset: PRESET_4K } },
  'format60-partial': {
    id: 'format60-partial',
    label: 'formato manual, 60 fps, faixa parcial',
    kind: AVCAPTURE_KIND,
    settings: { use_preset: false, frame_rate: { numerator: FPS, denominator: 1 }, video_range: 1 },
    needsFormat: true,
  },
  'format60-full': {
    id: 'format60-full',
    label: 'formato manual, 60 fps, faixa cheia',
    kind: AVCAPTURE_KIND,
    settings: { use_preset: false, frame_rate: { numerator: FPS, denominator: 1 }, video_range: 2 },
    needsFormat: true,
  },
};

export const DEFAULT_CONFIGS = ['high', 'format60', 'capturecard', 'preset4k'] as const;

/** O formato a usar no modo manual: o que tem 1170×2532 no nome; sem ele, o primeiro habilitado. */
export function pickFormat(items: readonly { itemName: string; itemEnabled: boolean; itemValue: unknown }[]): { name: string; value: unknown } | null {
  const enabled = items.filter((i) => i.itemEnabled !== false && i.itemValue !== undefined && i.itemValue !== null && i.itemValue !== '');
  const native = enabled.find((i) => /1170\s*x\s*2532|2532\s*x\s*1170/i.test(i.itemName));
  const chosen = native ?? enabled[0];
  return chosen === undefined ? null : { name: chosen.itemName, value: chosen.itemValue };
}

/** O `device` da fonte é o `itemValue` cujo `itemName` é `device.name` (S9 item 1; não é o UDID no OBS 31.1.2). */
export function resolveDevice(items: readonly { itemName: string; itemEnabled: boolean; itemValue: unknown }[], name: string): string | null {
  const match = items.find((i) => i.itemName === name && typeof i.itemValue === 'string' && i.itemValue !== '');
  return match === undefined ? null : (match.itemValue as string);
}

/** Igualdade profunda de ajustes JSON (ordem das chaves não importa). */
export function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) < 1e-9;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => sameJson(v, b[i]));
  const ka = Object.keys(a as Json).sort();
  const kb = Object.keys(b as Json).sort();
  return ka.length === kb.length && ka.every((k, i) => k === kb[i] && sameJson((a as Json)[k], (b as Json)[k]));
}

// ---------------------------------------------------------------------------------------------------------
// Disco (HC-11; S9 item 4)

/** Estimativa de S9 item 4: bitrate × duração × 1,25, em bytes. */
export function estimateBytes(bitrateKbps: number, durationS: number): number {
  return ((bitrateKbps * 1000) / 8) * durationS * 1.25;
}

/** Livre exigido antes de gravar: max(disk.minFreeGiB, 3 × estimativa + 2 GiB) (HC-11; Regras comuns dos spikes). */
export function requiredFreeBytes(estimate: number, minFreeGiB: number): number {
  return Math.max(minFreeGiB * GiB, 3 * estimate + 2 * GiB);
}

export interface DiskCheck {
  /** `fs.statfs` na pasta do spike. */
  freeFsBytes: number;
  /** `GetStats.availableDiskSpace` (MiB no volume da gravação), em bytes; `null` se não lido. */
  freeObsBytes: number | null;
  /** O menor dos dois. */
  freeBytes: number;
  estimateBytes: number;
  requiredBytes: number;
  ok: boolean;
}

export function diskCheck(freeFsBytes: number, obsMiB: number | null, estimate: number, minFreeGiB: number): DiskCheck {
  const freeObsBytes = obsMiB === null || !Number.isFinite(obsMiB) ? null : obsMiB * 1024 * 1024;
  const freeBytes = freeObsBytes === null ? freeFsBytes : Math.min(freeFsBytes, freeObsBytes);
  const requiredBytes = requiredFreeBytes(estimate, minFreeGiB);
  return { freeFsBytes, freeObsBytes, freeBytes, estimateBytes: estimate, requiredBytes, ok: freeBytes >= requiredBytes };
}

export function gib(bytes: number): number {
  return Math.round((bytes / GiB) * 100) / 100;
}

// ---------------------------------------------------------------------------------------------------------
// PNG (GetSourceScreenshot e `screen.shot {format: png}`): 8 bits, sem entrelaçamento

export interface RgbImage {
  width: number;
  height: number;
  /** 1 (cinza), 2 (cinza + alfa), 3 (RGB) ou 4 (RGBA). */
  channels: number;
  /** Por linhas, `width × height × channels` bytes. */
  data: Uint8Array;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_CHANNELS: Readonly<Record<number, number>> = { 0: 1, 2: 3, 4: 2, 6: 4 };

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/** PNG de 8 bits (tipos 0, 2, 4, 6), sem entrelaçamento; o resto é recusado com erro. */
export function decodePng(input: Uint8Array): RgbImage {
  const buf = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error('PNG: assinatura inválida');
  let offset = 8;
  let width = 0;
  let height = 0;
  let channels = 0;
  const idat: Buffer[] = [];
  while (offset + 8 <= buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString('latin1', offset + 4, offset + 8);
    const body = buf.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      const depth = body[8];
      const colorType = body[9] ?? -1;
      const interlace = body[12];
      if (depth !== 8) throw new Error(`PNG: profundidade ${depth} não suportada (só 8 bits)`);
      if (interlace !== 0) throw new Error('PNG: entrelaçado não suportado');
      const c = PNG_CHANNELS[colorType];
      if (c === undefined) throw new Error(`PNG: tipo de cor ${colorType} não suportado`);
      channels = c;
    } else if (type === 'IDAT') {
      idat.push(body);
    } else if (type === 'IEND') {
      break;
    }
  }
  if (width === 0 || height === 0 || channels === 0) throw new Error('PNG: sem IHDR');
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  if (raw.length < height * (stride + 1)) throw new Error(`PNG: dados curtos (${raw.length} < ${height * (stride + 1)})`);
  const out = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const v = raw[src + x]!;
      const a = x >= channels ? out[dst + x - channels]! : 0;
      const b = y > 0 ? out[dst - stride + x]! : 0;
      const c = x >= channels && y > 0 ? out[dst - stride + x - channels]! : 0;
      let r: number;
      switch (filter) {
        case 0: r = v; break;
        case 1: r = v + a; break;
        case 2: r = v + b; break;
        case 3: r = v + ((a + b) >> 1); break;
        case 4: r = v + paeth(a, b, c); break;
        default: throw new Error(`PNG: filtro ${String(filter)} inválido na linha ${y}`);
      }
      out[dst + x] = r & 0xff;
    }
  }
  return { width, height, channels, data: out };
}

/** `data:image/png;base64,…` (GetSourceScreenshot) ou base64 puro (`screen.shot`) → bytes. */
export function base64Image(text: string): Buffer {
  const comma = text.startsWith('data:') ? text.indexOf(',') : -1;
  return Buffer.from(comma >= 0 ? text.slice(comma + 1) : text, 'base64');
}

// ---------------------------------------------------------------------------------------------------------
// Regiões e cor (tela do relógio de calibração do hospedeiro, S0.10; A13)

export interface MeanRgb {
  r: number;
  g: number;
  b: number;
  /** Pixels somados. */
  n: number;
}

/** Média de R, G e B (cinza: o mesmo valor nos três) num retângulo em px, recortado nos limites da imagem. */
export function regionMean(img: RgbImage, rect: Rect): MeanRgb {
  const x0 = Math.max(0, Math.floor(rect.x));
  const y0 = Math.max(0, Math.floor(rect.y));
  const x1 = Math.min(img.width, Math.floor(rect.x + rect.w));
  const y1 = Math.min(img.height, Math.floor(rect.y + rect.h));
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  const c = img.channels;
  for (let y = y0; y < y1; y++) {
    let i = (y * img.width + x0) * c;
    for (let x = x0; x < x1; x++, i += c) {
      if (c >= 3) {
        r += img.data[i]!;
        g += img.data[i + 1]!;
        b += img.data[i + 2]!;
      } else {
        const v = img.data[i]!;
        r += v;
        g += v;
        b += v;
      }
      n++;
    }
  }
  return n === 0 ? { r: NaN, g: NaN, b: NaN, n } : { r: r / n, g: g / n, b: b / n, n };
}

/** Pontos → px de uma imagem: `offsetX` = −1 no quadro gravado (recorte de 1 px), 0 na fonte nativa. */
export function ptToPx(rect: Rect, scale = PX_PER_PT, offsetX = 0): Rect {
  return { x: Math.round(rect.x * scale) + offsetX, y: Math.round(rect.y * scale), w: Math.round(rect.w * scale), h: Math.round(rect.h * scale) };
}

/**
 * A tela do relógio (A13, `CalibrationLayout`): fundo cinza médio (0,5 → 128), grade 8 × 6 de células de 44 pt com
 * origem em (19, 290) pt no iPhone 12, dígitos numa faixa de 88 pt 22 pt acima da grade (y 180–268), barra de status e
 * indicador de início escondidos. As duas faixas lisas de cinza ficam longe dos dígitos, da grade e das bordas.
 */
export const CLOCK_LAYOUT = {
  gridOriginPt: { x: 19, y: 290 },
  cellPt: 44,
  rows: 6,
  columns: 8,
  greyRegionsPt: [
    { x: 30, y: 60, w: 330, h: 100 },
    { x: 30, y: 590, w: 330, h: 190 },
  ] as Rect[],
  /** Margem dentro de cada célula (bordas e transições fora da média). */
  cellInsetPt: 8,
  palette: { grey: 128, white: 255, black: 0 },
} as const;

/** Interior de cada célula, em pontos. */
export function cellInteriorsPt(): Rect[] {
  const out: Rect[] = [];
  const { gridOriginPt: o, cellPt, rows, columns, cellInsetPt: inset } = CLOCK_LAYOUT;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < columns; c++) out.push({ x: o.x + c * cellPt + inset, y: o.y + r * cellPt + inset, w: cellPt - 2 * inset, h: cellPt - 2 * inset });
  }
  return out;
}

export interface FrameColor {
  grey: MeanRgb[];
  /** Médias das células classificadas brancas (> 170) e pretas (< 85) neste quadro; `null` sem nenhuma. */
  white: MeanRgb | null;
  black: MeanRgb | null;
}

function pool(means: MeanRgb[]): MeanRgb | null {
  const n = means.reduce((s, m) => s + m.n, 0);
  if (n === 0) return null;
  return { r: means.reduce((s, m) => s + m.r * m.n, 0) / n, g: means.reduce((s, m) => s + m.g * m.n, 0) / n, b: means.reduce((s, m) => s + m.b * m.n, 0) / n, n };
}

/** Cor de um quadro da tela do relógio; `offsetX` −1 no quadro gravado, 0 na fonte nativa/captura do aparelho. */
export function frameColor(img: RgbImage, offsetX: number, scale = PX_PER_PT): FrameColor {
  const grey = CLOCK_LAYOUT.greyRegionsPt.map((r) => regionMean(img, ptToPx(r, scale, offsetX)));
  const white: MeanRgb[] = [];
  const black: MeanRgb[] = [];
  for (const cell of cellInteriorsPt()) {
    const m = regionMean(img, ptToPx(cell, scale, offsetX));
    const luma = (m.r + m.g + m.b) / 3;
    if (luma > 170) white.push(m);
    else if (luma < 85) black.push(m);
  }
  return { grey, white: pool(white), black: pool(black) };
}

export interface ColorRef {
  grey: number[];
  white: number[];
  black: number[];
  /** `device` = medido na captura do próprio aparelho (`screen.shot` png nativo); `palette` = os valores desenhados. */
  source: 'device' | 'palette';
}

export const PALETTE_REF: ColorRef = {
  grey: [128, 128, 128],
  white: [255, 255, 255],
  black: [0, 0, 0],
  source: 'palette',
};

function median(values: number[]): number {
  if (values.length === 0) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 === 1 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** Medianas por canal ao longo dos quadros (uma por classe: cinza (as duas faixas juntas), branco, preto). */
export function summarizeColor(frames: FrameColor[]): { grey: number[]; white: number[] | null; black: number[] | null; frames: number } {
  const ch = (ms: (MeanRgb | null)[]): number[] | null => {
    const ok = ms.filter((m): m is MeanRgb => m !== null && m.n > 0);
    if (ok.length === 0) return null;
    return [median(ok.map((m) => m.r)), median(ok.map((m) => m.g)), median(ok.map((m) => m.b))];
  };
  return {
    grey: ch(frames.map((f) => pool(f.grey))) ?? [NaN, NaN, NaN],
    white: ch(frames.map((f) => f.white)),
    black: ch(frames.map((f) => f.black)),
    frames: frames.length,
  };
}

/** Referência do aparelho: cinza, branco e preto de uma captura do próprio iPhone; o que faltar vem da paleta. */
export function deviceRef(color: FrameColor): ColorRef {
  const g = pool(color.grey);
  return {
    grey: g === null ? PALETTE_REF.grey : [g.r, g.g, g.b],
    white: color.white === null ? PALETTE_REF.white : [color.white.r, color.white.g, color.white.b],
    black: color.black === null ? PALETTE_REF.black : [color.black.r, color.black.g, color.black.b],
    source: 'device',
  };
}

export const COLOR_MAX_DIFF = 3;

export interface ColorVerdict {
  /** Maior |diferença| por canal em cada classe (0–255); `null` = classe não medida. */
  greyDiff: number | null;
  whiteDiff: number | null;
  blackDiff: number | null;
  maxDiff: number | null;
  ok: boolean;
  /** A cara de "lavado" (faixa parcial lida como cheia): preto ≥ 12 e branco ≤ 243. */
  washedOut: boolean;
}

function maxAbsDiff(a: number[] | null, b: number[]): number | null {
  if (a === null || a.some((v) => !Number.isFinite(v))) return null;
  return Math.max(...a.map((v, i) => Math.abs(v - b[i]!)));
}

/** Critério da T-0.20: diferença ≤ 3/255 nas áreas lisas (cinza, branco e preto) contra a referência. */
export function colorVerdict(measured: { grey: number[]; white: number[] | null; black: number[] | null }, ref: ColorRef): ColorVerdict {
  const greyDiff = maxAbsDiff(measured.grey, ref.grey);
  const whiteDiff = maxAbsDiff(measured.white, ref.white);
  const blackDiff = maxAbsDiff(measured.black, ref.black);
  const diffs = [greyDiff, whiteDiff, blackDiff].filter((d): d is number => d !== null);
  const maxDiff = diffs.length === 0 ? null : Math.max(...diffs);
  const washedOut = measured.black !== null && measured.white !== null && Math.min(...measured.black) >= 12 && Math.max(...measured.white) <= 243;
  return { greyDiff, whiteDiff, blackDiff, maxDiff, ok: greyDiff !== null && maxDiff !== null && maxDiff <= COLOR_MAX_DIFF, washedOut };
}

/** Não preta: ao menos 1 % dos pixels com luma > 16 (S9 item 3, "GetSourceScreenshot não pode ser preta"). */
export function nonBlack(img: RgbImage): boolean {
  const c = img.channels;
  const total = img.width * img.height;
  let bright = 0;
  for (let i = 0; i < total; i++) {
    const p = i * c;
    const luma = c >= 3 ? (img.data[p]! + img.data[p + 1]! + img.data[p + 2]!) / 3 : img.data[p]!;
    if (luma > 16) bright++;
  }
  return total > 0 && bright / total >= 0.01;
}

// ---------------------------------------------------------------------------------------------------------
// Áudio: picos por janela, bordas de pausa/play, envelope

export function toDb(x: number): number {
  return 20 * Math.log10(Math.max(Math.abs(x), 1e-12));
}

export interface AudioWindow {
  /** Início da janela em R (s). */
  startS: number;
  /** Pico de amostra (dBFS). */
  peakDb: number;
  rmsDb: number;
}

/** Pico e RMS por janela de `windowS` (padrão 1 s) de amostras em [−1, 1]; `startR` = R da primeira amostra. */
export function windowStats(samples: Float32Array, rate: number, startR = 0, windowS = 1): AudioWindow[] {
  const size = Math.max(1, Math.round(rate * windowS));
  const out: AudioWindow[] = [];
  for (let i = 0; i + size <= samples.length; i += size) {
    let peak = 0;
    let sum = 0;
    for (let j = i; j < i + size; j++) {
      const v = samples[j]!;
      const a = Math.abs(v);
      if (a > peak) peak = a;
      sum += v * v;
    }
    out.push({ startS: startR + i / rate, peakDb: toDb(peak), rmsDb: toDb(Math.sqrt(sum / size)) });
  }
  return out;
}

/** Limites da T-0.20 para os picos e o que conta como "janela com fala". */
export const PEAKS = { lowDb: -20, highDb: -3, speechRmsDb: -45 } as const;

export interface PeakVerdict {
  windows: number;
  speechWindows: number;
  maxPeakDb: number | null;
  medianPeakDb: number | null;
  p10PeakDb: number | null;
  ok: boolean;
  reason: string;
}

/**
 * "Picos entre −20 e −3 dBFS" (T-0.20), medido no arquivo: nas janelas de 1 s com fala (RMS ≥ −45 dBFS), o maior pico
 * de amostra ≤ −3 dBFS (folga, sem clipe) e a mediana dos picos ≥ −20 dBFS (alto o bastante); e fala em ≥ 50 % das
 * janelas (o áudio do iPhone chegou).
 */
export function peakVerdict(windows: AudioWindow[]): PeakVerdict {
  const speech = windows.filter((w) => w.rmsDb >= PEAKS.speechRmsDb);
  const peaks = speech.map((w) => w.peakDb).sort((a, b) => a - b);
  const maxPeakDb = peaks.length === 0 ? null : peaks[peaks.length - 1]!;
  const medianPeakDb = peaks.length === 0 ? null : median(peaks);
  const p10PeakDb = peaks.length === 0 ? null : peaks[Math.max(0, Math.ceil(0.1 * peaks.length) - 1)]!;
  let reason = 'ok';
  if (windows.length === 0 || speech.length < 0.5 * windows.length) reason = `fala em ${speech.length}/${windows.length} janelas (< 50 %): o áudio do iPhone não chegou inteiro`;
  else if (maxPeakDb! > PEAKS.highDb) reason = `pico máximo ${maxPeakDb!.toFixed(1)} dBFS > ${PEAKS.highDb}`;
  else if (medianPeakDb! < PEAKS.lowDb) reason = `mediana dos picos ${medianPeakDb!.toFixed(1)} dBFS < ${PEAKS.lowDb}`;
  return { windows: windows.length, speechWindows: speech.length, maxPeakDb, medianPeakDb, p10PeakDb, ok: reason === 'ok', reason };
}

/** RMS (dBFS) de [from, to) amostras. */
export function rmsDb(samples: Float32Array, from: number, to: number): number {
  const a = Math.max(0, from);
  const b = Math.min(samples.length, to);
  if (b <= a) return -240;
  let sum = 0;
  for (let i = a; i < b; i++) sum += samples[i]! * samples[i]!;
  return toDb(Math.sqrt(sum / (b - a)));
}

export interface AudioEdge {
  /** Índice da amostra da borda. */
  index: number;
  /** R (s) da borda. */
  edgeS: number;
  /** RMS (dBFS) dos 30 ms do lado com som (antes da parada, depois do começo). */
  soundDb: number;
  /** Corte no meio da fala (som ≥ −40 dBFS junto da borda): só essas valem para a defasagem. */
  valid: boolean;
}

export const EDGE = { silenceDb: -60, minSilenceMs: 200, soundMs: 30, validSoundDb: -40 } as const;

/**
 * Borda de parada em [from, to): o começo da primeira corrida de ≥ `minSilenceMs` (padrão 200 ms; o A/V usa 1 s, mais
 * que as pausas naturais da leitura) com todas as amostras abaixo de −60 dBFS que vem depois de som. A borda de começo:
 * a primeira amostra ≥ −60 dBFS depois de uma corrida dessas. `null` se não há.
 */
export function findAudioEdge(samples: Float32Array, rate: number, startR: number, from: number, to: number, kind: 'stop' | 'start',
  minSilenceMs: number = EDGE.minSilenceMs): AudioEdge | null {
  const thr = 10 ** (EDGE.silenceDb / 20);
  const minRun = Math.round((minSilenceMs / 1000) * rate);
  const soundN = Math.round((EDGE.soundMs / 1000) * rate);
  const a = Math.max(0, from);
  const b = Math.min(samples.length, to);
  let run = 0;
  let heardSound = false;
  for (let i = a; i < b; i++) {
    const quiet = Math.abs(samples[i]!) < thr;
    if (!quiet) {
      if (kind === 'start' && run >= minRun) {
        const soundDb = rmsDb(samples, i, i + soundN);
        return { index: i, edgeS: startR + i / rate, soundDb, valid: soundDb >= EDGE.validSoundDb };
      }
      run = 0;
      heardSound = true;
      continue;
    }
    run++;
    if (kind === 'stop' && heardSound && run === minRun) {
      const index = i - minRun + 1;
      const soundDb = rmsDb(samples, index - soundN, index);
      return { index, edgeS: startR + index / rate, soundDb, valid: soundDb >= EDGE.validSoundDb };
    }
  }
  return null;
}

/** Envelope RMS (linear) em caixas de `binMs`. */
export function envelope(samples: Float32Array, rate: number, binMs = 10): Float32Array {
  const size = Math.max(1, Math.round((binMs / 1000) * rate));
  const n = Math.floor(samples.length / size);
  const out = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    let sum = 0;
    for (let j = k * size; j < (k + 1) * size; j++) sum += samples[j]! * samples[j]!;
    out[k] = Math.sqrt(sum / size);
  }
  return out;
}

/** Correlação de Pearson de a[i] com b[i + lag] na sobreposição. */
export function pearsonAt(a: Float32Array, b: Float32Array, lag: number): number {
  const start = Math.max(0, -lag);
  const end = Math.min(a.length, b.length - lag);
  const n = end - start;
  if (n < 10) return 0;
  let sa = 0;
  let sb = 0;
  for (let i = start; i < end; i++) {
    sa += a[i]!;
    sb += b[i + lag]!;
  }
  const ma = sa / n;
  const mb = sb / n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = start; i < end; i++) {
    const x = a[i]! - ma;
    const y = b[i + lag]! - mb;
    num += x * y;
    da += x * x;
    db += y * y;
  }
  return da === 0 || db === 0 ? 0 : num / Math.sqrt(da * db);
}

/** Maior correlação de a[i] com b[i + lag] para lag em [minLag, maxLag] caixas. */
export function maxXcorr(a: Float32Array, b: Float32Array, minLag: number, maxLag: number): { r: number; lag: number } {
  let best = { r: -Infinity, lag: minLag };
  for (let lag = minLag; lag <= maxLag; lag++) {
    const r = pearsonAt(a, b, lag);
    if (r > best.r) best = { r, lag };
  }
  return best;
}

export const SPEAKER = { audibleR: 0.3, silentR: 0.15, controlMinRiseDb: 6, deadMicDb: -90 } as const;

export interface SpeakerVerdict {
  verdict: 'silent' | 'audible' | 'inconclusive';
  reason: string;
}

/**
 * Alto-falante do iPhone em silêncio, pelo microfone do Mac (só na memória): o controle positivo (a fala do `say` no
 * alto-falante do Mac, que o OBS não grava) tem de subir ≥ 6 dB acima do fundo (o microfone ouve a sala); então
 * correlação do envelope do microfone com o do áudio capturado < 0,15 = silêncio; ≥ 0,3 = audível; no meio, inconclusivo.
 */
export function speakerVerdict(input: { micFloorDb: number; controlRiseDb: number; xcorrR: number }): SpeakerVerdict {
  if (input.micFloorDb <= SPEAKER.deadMicDb) return { verdict: 'inconclusive', reason: `microfone mudo (fundo ${input.micFloorDb.toFixed(1)} dBFS): sem permissão de Microfone?` };
  if (input.controlRiseDb < SPEAKER.controlMinRiseDb) return { verdict: 'inconclusive', reason: `o controle (say) subiu só ${input.controlRiseDb.toFixed(1)} dB` };
  if (input.xcorrR >= SPEAKER.audibleR) return { verdict: 'audible', reason: `correlação ${input.xcorrR.toFixed(2)} ≥ ${SPEAKER.audibleR}` };
  if (input.xcorrR < SPEAKER.silentR) return { verdict: 'silent', reason: `correlação ${input.xcorrR.toFixed(2)} < ${SPEAKER.silentR}` };
  return { verdict: 'inconclusive', reason: `correlação ${input.xcorrR.toFixed(2)} entre ${SPEAKER.silentR} e ${SPEAKER.audibleR}` };
}

// ---------------------------------------------------------------------------------------------------------
// A/V: a virada do ícone de Play/Pause no quadro × a borda do áudio

/** Diferença média absoluta entre duas imagens do mesmo tamanho (0–255). */
export function meanAbsDiff(a: Uint8Array, b: Uint8Array): number {
  if (a.length !== b.length || a.length === 0) return Infinity;
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i]! - b[i]!);
  return sum / a.length;
}

/**
 * O primeiro quadro que já se parece mais com o ícone de depois do que com o de antes, e segue assim nos 2 seguintes.
 * Os modelos são o primeiro e o último quadro da janela (o realce de toque do botão escurece o ícone, mas a forma
 * continua a de antes).
 */
export function findFlip(frames: { ptsS: number; data: Uint8Array }[], stable = 2): { ptsS: number; index: number } | null {
  if (frames.length < 3) return null;
  const before = frames[0]!.data;
  const after = frames[frames.length - 1]!.data;
  if (meanAbsDiff(before, after) < 4) return null;
  const isAfter = frames.map((f) => meanAbsDiff(f.data, after) < meanAbsDiff(f.data, before));
  for (let i = 1; i < frames.length; i++) {
    let ok = true;
    for (let k = 0; k <= stable && i + k < frames.length; k++) ok &&= isAfter[i + k]!;
    if (ok) return { ptsS: frames[i]!.ptsS, index: i };
  }
  return null;
}

export interface AvEvent {
  kind: 'pause' | 'play';
  /** R (s) da virada do ícone e da borda do áudio; `null` se não achada. */
  videoS: number | null;
  audioS: number | null;
  /** Áudio − vídeo, em ms (positivo = o som vem depois da imagem). */
  offsetMs: number | null;
  valid: boolean;
  why?: string;
}

export const AV = { maxAbsMedianMs: 45, minValid: 10 } as const;

export interface AvVerdict {
  pause: { n: number; valid: number; medianMs: number | null; p5Ms: number | null; p95Ms: number | null };
  play: { n: number; valid: number; medianMs: number | null; p5Ms: number | null; p95Ms: number | null };
  ok: boolean;
  reason: string;
}

function quantile(sorted: number[], q: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))]!;
}

/**
 * "Defasagem A/V ≤ ±45 ms" (T-0.20), definida assim: mediana de (áudio − vídeo) nas pausas válidas (o som cortado no
 * meio da fala e o ícone virado achados), com ≥ 10 válidas. As de play só se registram (o AVPlayer leva um tempo para
 * voltar a soar, que é do app, não da captura).
 */
export function avVerdict(events: AvEvent[]): AvVerdict {
  const side = (kind: 'pause' | 'play'): AvVerdict['pause'] => {
    const all = events.filter((e) => e.kind === kind);
    const ok = all.filter((e) => e.valid && e.offsetMs !== null).map((e) => e.offsetMs!).sort((a, b) => a - b);
    return { n: all.length, valid: ok.length, medianMs: ok.length === 0 ? null : median(ok), p5Ms: quantile(ok, 0.05), p95Ms: quantile(ok, 0.95) };
  };
  const pause = side('pause');
  const play = side('play');
  let reason = 'ok';
  if (pause.valid < AV.minValid) reason = `só ${pause.valid} pausas válidas (< ${AV.minValid}): inconclusivo`;
  else if (Math.abs(pause.medianMs!) > AV.maxAbsMedianMs) reason = `mediana ${pause.medianMs!.toFixed(1)} ms fora de ±${AV.maxAbsMedianMs}`;
  return { pause, play, ok: reason === 'ok', reason };
}

// ---------------------------------------------------------------------------------------------------------
// ffprobe

export interface ProbeInfo {
  width: number;
  height: number;
  rFrameRate: string;
  avgFrameRate: string;
  fps: number;
  /** `nb_read_packets` do vídeo (contados) ou, sem eles, `nb_frames`. */
  frames: number | null;
  durationS: number;
  formatStartS: number;
  videoStartS: number;
  sizeBytes: number;
  videoCodec: string;
  profile: string | null;
  level: number | null;
  pixFmt: string | null;
  colorRange: string | null;
  colorSpace: string | null;
  colorTransfer: string | null;
  colorPrimaries: string | null;
  audio: { codec: string; sampleRate: number; channels: number; startS: number; durationS: number } | null;
  chapters: number;
}

function rate(text: unknown): number {
  const m = typeof text === 'string' ? /^(\d+)\/(\d+)$/.exec(text) : null;
  return m && Number(m[2]) > 0 ? Number(m[1]) / Number(m[2]) : NaN;
}

function num(value: unknown): number {
  const n = typeof value === 'string' || typeof value === 'number' ? Number(value) : NaN;
  return Number.isFinite(n) ? n : NaN;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value !== '' && value !== 'unknown' ? value : null;
}

/** `ffprobe -show_streams -show_format -show_chapters -count_packets -of json` → o que o SP-5 olha. */
export function parseProbe(json: unknown, sizeBytes: number): ProbeInfo {
  const data = json as { streams?: Json[]; format?: Json; chapters?: unknown[] };
  const streams = data.streams ?? [];
  const video = streams.find((s) => s['codec_type'] === 'video');
  if (video === undefined) throw new Error('ffprobe: sem fluxo de vídeo');
  const audio = streams.find((s) => s['codec_type'] === 'audio');
  const formatStartS = num(data.format?.['start_time']);
  const counted = num(video['nb_read_packets']);
  const listed = num(video['nb_frames']);
  return {
    width: num(video['width']),
    height: num(video['height']),
    rFrameRate: String(video['r_frame_rate']),
    avgFrameRate: String(video['avg_frame_rate']),
    fps: rate(video['r_frame_rate']),
    frames: Number.isFinite(counted) ? counted : Number.isFinite(listed) ? listed : null,
    durationS: Number.isFinite(num(video['duration'])) ? num(video['duration']) : num(data.format?.['duration']),
    formatStartS: Number.isFinite(formatStartS) ? formatStartS : 0,
    videoStartS: Number.isFinite(num(video['start_time'])) ? num(video['start_time']) : 0,
    sizeBytes,
    videoCodec: String(video['codec_name']),
    profile: str(video['profile']),
    level: Number.isFinite(num(video['level'])) ? num(video['level']) : null,
    pixFmt: str(video['pix_fmt']),
    colorRange: str(video['color_range']),
    colorSpace: str(video['color_space']),
    colorTransfer: str(video['color_transfer']),
    colorPrimaries: str(video['color_primaries']),
    audio:
      audio === undefined
        ? null
        : {
            codec: String(audio['codec_name']),
            sampleRate: num(audio['sample_rate']),
            channels: num(audio['channels']),
            startS: Number.isFinite(num(audio['start_time'])) ? num(audio['start_time']) : 0,
            durationS: num(audio['duration']),
          },
    chapters: Array.isArray(data.chapters) ? data.chapters.length : 0,
  };
}

// ---------------------------------------------------------------------------------------------------------
// AC-9.7: 10 min a 1168×2532@60

export const AC97 = { width: 1168, height: 2532, fps: 60, bytesPer10Min: 1.2e9, tolerance: 0.25 } as const;

export interface SkipCounts {
  /** `GetOutputStatus.outputSkippedFrames` no fim (a saída de arquivo). */
  output: number | null;
  /** Diferença de `GetStats.renderSkippedFrames` e `outputSkippedFrames` (globais) entre o começo e o fim. */
  renderDelta: number | null;
  outputDelta: number | null;
  /** "skipped frames due to encoding lag" e "lagged frames due to rendering lag" do registro do OBS. */
  logEncoding: number | null;
  logRender: number | null;
}

export interface Check {
  name: string;
  ok: boolean;
  value: string;
}

/** AC-9.7 com a duração real: tamanho a ±25 % de 1,2 GB × duração/600 s. */
export function longVerdict(probe: ProbeInfo, skipped: SkipCounts): { ok: boolean; checks: Check[] } {
  const target = AC97.bytesPer10Min * (probe.durationS / 600);
  const sizeRatio = probe.sizeBytes / target;
  const counts = [skipped.output, skipped.renderDelta, skipped.outputDelta, skipped.logEncoding, skipped.logRender];
  const known = counts.filter((c): c is number => c !== null);
  const expectedFrames = Math.round(probe.durationS * AC97.fps);
  const checks: Check[] = [
    { name: 'quadros pulados = 0', ok: known.length > 0 && known.every((c) => c === 0), value: JSON.stringify(skipped) },
    { name: 'tamanho 1168×2532', ok: probe.width === AC97.width && probe.height === AC97.height, value: `${probe.width}×${probe.height}` },
    { name: '60 fps', ok: Math.abs(probe.fps - AC97.fps) < 0.01, value: `r=${probe.rFrameRate} avg=${probe.avgFrameRate}` },
    {
      name: 'quadros contados ≈ duração × 60 (±2)',
      ok: probe.frames !== null && Math.abs(probe.frames - expectedFrames) <= 2,
      value: `${probe.frames ?? '?'} × ${expectedFrames}`,
    },
    {
      name: 'arquivo a ±25 % de 1,2 GB por 10 min',
      ok: Math.abs(sizeRatio - 1) <= AC97.tolerance,
      value: `${(probe.sizeBytes / 1e9).toFixed(3)} GB (${(sizeRatio * 100).toFixed(0)} % de ${(target / 1e9).toFixed(3)} GB)`,
    },
  ];
  return { ok: checks.every((c) => c.ok), checks };
}

// ---------------------------------------------------------------------------------------------------------
// Fonte viva e "chute" (S9 item 3; AC-9.3 parcial)

export interface KickTrial {
  trial: number;
  mode: string;
  /** A fonte estava morta (sem 1170×2532 ou preta) antes do chute: só essas provam o chute. */
  deadBeforeKick: boolean;
  /** Linha "Unable to initialize device" no registro novo do OBS. */
  unableInitLogged: boolean;
  /** Do chute à fonte viva (ms); `null` = não voltou. */
  kickToLiveMs: number | null;
  /** `plain` = SetInputSettings {device}; `reset` = device '' e depois o valor. */
  variant: 'plain' | 'reset' | 'none';
  deviceValue: string | null;
  obsCrashed: boolean;
}

export const KICK = { limitMs: 15_000, trials: 5 } as const;

export function kickVerdict(trials: KickTrial[]): { valid: number; recovered: number; ok: boolean; reason: string } {
  const valid = trials.filter((t) => t.deadBeforeKick && !t.obsCrashed);
  const recovered = valid.filter((t) => t.kickToLiveMs !== null && t.kickToLiveMs <= KICK.limitMs);
  const crashed = trials.filter((t) => t.obsCrashed).length;
  let reason = 'ok';
  if (crashed > 0) reason = `o OBS caiu em ${crashed} tentativa(s) (⏳ Q-8)`;
  else if (valid.length < KICK.trials) reason = `só ${valid.length} tentativas com a fonte morta antes do chute (< ${KICK.trials})`;
  else if (recovered.length < valid.length) reason = `${valid.length - recovered.length} sem fonte viva em ≤ 15 s`;
  return { valid: valid.length, recovered: recovered.length, ok: reason === 'ok', reason };
}

// ---------------------------------------------------------------------------------------------------------
// Registro do OBS (só as linhas que o spike usa; nunca o arquivo inteiro)

export const OBS_LOG_PATTERNS: Readonly<Record<string, RegExp>> = {
  unableInit: /Unable to initialize device with unique ID/,
  selectedDevice: /Selected device '/,
  connectEvent: /Received connect event/,
  disconnectEvent: /Received disconnect event/,
  presetUnsupported: /Preset .* not supported/,
  formatNotFound: /Configured format not found/,
  frameRate: /Frame rate is not supported|falling back to value supported|no supported fallback FPS/,
  fourcc: /Using (native|fallback) fourcc/,
  skippedEncoding: /skipped frames due to encoding lag/i,
  laggedRender: /lagged frames due to rendering lag/i,
  recording: /Recording Start|Recording Stop|recording.*(start|stop)/i,
  mp4: /\[mp4/i,
  videoReset: /video settings reset|base resolution|output resolution/,
  encoder: /VideoToolbox|videotoolbox|\[VT|encoder/i,
};

export interface ObsLogScan {
  counts: Record<string, number>;
  /** As linhas que casaram (até 200), cortadas em 240 caracteres. */
  lines: string[];
  /** De "skipped frames due to encoding lag: N/M" e "lagged frames due to rendering lag/stalls: N". */
  encodingSkipped: number | null;
  renderLagged: number | null;
}

export function scanObsLog(text: string): ObsLogScan {
  const counts: Record<string, number> = Object.fromEntries(Object.keys(OBS_LOG_PATTERNS).map((k) => [k, 0]));
  const lines: string[] = [];
  let encodingSkipped: number | null = null;
  let renderLagged: number | null = null;
  for (const line of text.split(/\r?\n/)) {
    let hit = false;
    for (const [key, pattern] of Object.entries(OBS_LOG_PATTERNS)) {
      if (pattern.test(line)) {
        counts[key] = (counts[key] ?? 0) + 1;
        hit = true;
      }
    }
    const enc = /skipped frames due to encoding lag:\s*(\d+)/i.exec(line);
    if (enc) encodingSkipped = (encodingSkipped ?? 0) + Number(enc[1]);
    const ren = /lagged frames due to rendering lag\/stalls:\s*(\d+)/i.exec(line);
    if (ren) renderLagged = (renderLagged ?? 0) + Number(ren[1]);
    if (hit && lines.length < 200) lines.push(line.slice(0, 240));
  }
  return { counts, lines, encodingSkipped, renderLagged };
}

// ---------------------------------------------------------------------------------------------------------
// Código do relógio por quadro (gravação longa): repetidos e saltos da captura

export interface ClockStats {
  frames: number;
  decoded: number;
  /** Quadros com o mesmo valor do anterior decodificado (a captura não trouxe quadro novo). */
  repeats: number;
  /** Avanços ≥ 1,5 quadro (o aparelho pulou quadros). */
  jumps: number;
  /** Avanço para trás (não deveria acontecer). */
  backwards: number;
  maxAdvanceMs: number | null;
  /** Histograma do avanço em quadros (arredondado): "0", "1", "2", "3+". */
  histogram: Record<string, number>;
}

export function clockStats(values: (number | null)[], fps = FPS): ClockStats {
  const frameMs = 1000 / fps;
  const histogram: Record<string, number> = { '0': 0, '1': 0, '2': 0, '3+': 0 };
  let prev: number | null = null;
  let decoded = 0;
  let repeats = 0;
  let jumps = 0;
  let backwards = 0;
  let maxAdvanceMs: number | null = null;
  for (const v of values) {
    if (v === null) continue;
    decoded++;
    if (prev !== null) {
      const d = v - prev;
      if (d < 0) backwards++;
      else {
        const k = Math.round(d / frameMs);
        histogram[k >= 3 ? '3+' : String(k)] = (histogram[k >= 3 ? '3+' : String(k)] ?? 0) + 1;
        if (d === 0) repeats++;
        if (d >= 1.5 * frameMs) jumps++;
        maxAdvanceMs = maxAdvanceMs === null ? d : Math.max(maxAdvanceMs, d);
      }
    }
    prev = v;
  }
  return { frames: values.length, decoded, repeats, jumps, backwards, maxAdvanceMs, histogram };
}

// ---------------------------------------------------------------------------------------------------------
// Arquivos do próprio spike (G4: só o que o SP-5 criou em ~/Movies/contrarregra/spikes/SP-5/)

/**
 * A gravação é do spike: está direto na pasta do spike (sem subpasta, sem `..`), não existia antes do `StartRecord` e
 * foi criada depois dele (birthtime/mtime ≥ início − 2 s).
 */
export function isOwnRecording(file: { realPath: string; dirRealPath: string; name: string; birthtimeMs: number; mtimeMs: number },
  before: ReadonlySet<string>, startedMs: number): { ok: boolean; why: string } {
  const sep = file.dirRealPath.endsWith('/') ? '' : '/';
  if (!file.realPath.startsWith(file.dirRealPath + sep)) return { ok: false, why: `${file.realPath} fora de ${file.dirRealPath}` };
  const rest = file.realPath.slice(file.dirRealPath.length + sep.length);
  if (rest.includes('/') || rest !== file.name) return { ok: false, why: `${file.realPath} não está direto na pasta do spike` };
  if (before.has(file.name)) return { ok: false, why: `${file.name} já existia antes da gravação` };
  const created = Math.min(file.birthtimeMs > 0 ? file.birthtimeMs : file.mtimeMs, file.mtimeMs);
  if (created < startedMs - 2_000) return { ok: false, why: `${file.name} foi criado antes da gravação` };
  return { ok: true, why: 'ok' };
}

// ---------------------------------------------------------------------------------------------------------
// Estatística e tabelas

export function stats(values: number[]): { n: number; p50: number | null; p95: number | null; max: number | null } {
  const s = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  return { n: s.length, p50: s.length === 0 ? null : median(s), p95: quantile(s, 0.95), max: s.length === 0 ? null : s[s.length - 1]! };
}

export function fmt(value: number | null | undefined, digits = 1): string {
  return value === null || value === undefined || !Number.isFinite(value) ? '—' : value.toFixed(digits);
}

export function markdownTable(header: string[], rows: string[][]): string {
  return [`| ${header.join(' | ')} |`, `|${header.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n');
}
