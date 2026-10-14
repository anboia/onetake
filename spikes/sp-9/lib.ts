// Lógica do driver do SP-9 (T-0.27; S1 itens 7 e 11, S0.3, S13 item 7; AC-1.15, AC-5.7 parcial) que não depende do
// aparelho, do OBS nem do ffmpeg: o alvo do interruptor do modo avião, o arrasto de S1 item 7 e as faixas de gesto
// (A9), a conta de disco (HC-11), um leitor de PNG (copiado de `spikes/sp-5/lib.ts`), as regiões do quadro gravado
// (barra de estado e botão do avião na Central), as medidas de imagem (diferença em cinza, fração laranja), a
// leitura do relógio pelo OCR, o veredicto de cada troca e de cada ciclo e as tabelas do SP-9.md. Código de spike,
// descartável (architecture.md A5); testado em `sp9.test.ts` (`node --test spikes/sp-9/sp9.test.ts`).

import { inflateSync } from 'node:zlib';

import type { Rect } from '../../mac/src/core/types.ts';

export type Json = Record<string, unknown>;

export const GiB = 1024 ** 3;

// ---------------------------------------------------------------------------------------------------------
// Alvos e gestos (S1 itens 7 e 11; A9)

/** O interruptor do modo avião (S1 item 7, AC-1.15): com a Central aberta, a lista permitida só libera ele. */
export const AIRPLANE_TARGET = { app: 'springboard', identifier: 'airplane-mode-button' } as const;
/** O mesmo controle pelo rótulo (plano B da T-0.27): só para medir se o rótulo resolve, nunca para tocar. */
export const AIRPLANE_LABEL_TARGET = { app: 'springboard', label: 'Airplane Mode' } as const;
/**
 * O arrasto de S1 item 7 por coordenada normalizada (0,9 · 0,01 → 0,9 · 0,2), como um `ui.drag` pediria. Só serve à
 * sonda que confere que a lista permitida o RECUSA (o começo cai na faixa de gesto de cima, A9); quem abre a Central é
 * `device.controlCenter {action: open}`, que faz esse mesmo arrasto dentro do runner (`ControlCenterGesture`).
 */
export const CC_DRAG_PARAMS = { from: { nx: 0.9, ny: 0.01 }, to: { nx: 0.9, ny: 0.2 }, pressMs: 50, durationMs: 300, holdMs: 0 } as const;
/** Tela do iPhone 12 em pontos. */
export const SCREEN_PT = { w: 390, h: 844 } as const;

/** Faixas de gesto do sistema de A9 (`GestureBands` do Kit): 47/34 pt em telas com ≥ 812 pt de altura, 20/20 nas outras. */
export function gestureBands(screen: { w: number; h: number }): { top: number; bottom: number } {
  return screen.h >= 812 ? { top: 47, bottom: 34 } : { top: 20, bottom: 20 };
}

/** O começo do arrasto de S1 item 7 em pontos, e se ele cai numa faixa de gesto (onde A9 recusa arrasto). */
export function ccDragStart(screen: { w: number; h: number } = SCREEN_PT): { x: number; y: number; inTopBand: boolean } {
  const x = CC_DRAG_PARAMS.from.nx * screen.w;
  const y = CC_DRAG_PARAMS.from.ny * screen.h;
  return { x, y, inTopBand: y < gestureBands(screen).top };
}

// ---------------------------------------------------------------------------------------------------------
// Estado do avião e ações da fila do XCTest

export type Want = 'on' | 'off';
/** O `value` do interruptor: "1" ligado, "0" desligado. */
export type SwitchValue = '0' | '1';
/** O modo avião como o driver sabe; só `off` é certeza de desligado. */
export type AirState = 'off' | 'on' | 'maybe-on';
/** O resultado de uma ação da fila do XCTest que pode estourar o prazo do runner (S1 item 3, `XCTestLane`). */
export type Lenient = 'ok' | 'ran-late' | 'not-run';

export function oldValue(want: Want): SwitchValue {
  return want === 'on' ? '0' : '1';
}

export function newValue(want: Want): SwitchValue {
  return want === 'on' ? '1' : '0';
}

/** A saída do `ifconfig` mostra o Mac na rede do Acesso Pessoal do iPhone (172.20.10.0/28; SP-2 §3). */
export function hotspotActive(ifconfigText: string): boolean {
  return /\binet 172\.20\.10\./.test(ifconfigText);
}

/** O `E_TIMEOUT` de `wait.for {airplane}` diz que a Central não estava aberta (`ConditionEvaluator.airplane`). */
export function ccClosedReason(message: string): boolean {
  return /só se avalia com a Central de Controle aberta/.test(message);
}

/** O `E_TIMEOUT` de `wait.for {airplane}` diz o estado lido na última sondagem ("o modo avião está on|off"). */
export function airplaneReadFromMessage(message: string): Want | null {
  const m = /o modo avião está (on|off)/.exec(message);
  return m ? (m[1] as Want) : null;
}

// ---------------------------------------------------------------------------------------------------------
// Disco (HC-11; S9 item 4) — copiado de spikes/sp-5/lib.ts

/** Estimativa de S9 item 4: bitrate × duração × 1,25, em bytes. */
export function estimateBytes(bitrateKbps: number, durationS: number): number {
  return ((bitrateKbps * 1000) / 8) * durationS * 1.25;
}

/** Livre exigido antes de gravar: max(disk.minFreeGiB, 3 × estimativa + 2 GiB) (HC-11; Regras comuns dos spikes). */
export function requiredFreeBytes(estimate: number, minFreeGiB: number): number {
  return Math.max(minFreeGiB * GiB, 3 * estimate + 2 * GiB);
}

export interface DiskCheck {
  freeFsBytes: number;
  /** `GetStats.availableDiskSpace` (MiB) em bytes; `null` se não lido. */
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
// PNG de 8 bits sem entrelaçamento (quadros extraídos pelo ffmpeg; GetSourceScreenshot) — copiado de spikes/sp-5/lib.ts

export interface RgbImage {
  width: number;
  height: number;
  /** 1 (cinza), 2 (cinza + alfa), 3 (RGB) ou 4 (RGBA). */
  channels: number;
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
      if (depth !== 8) throw new Error(`PNG: profundidade ${depth} não suportada (só 8 bits)`);
      if (body[12] !== 0) throw new Error('PNG: entrelaçado não suportado');
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

/** `data:image/png;base64,…` (GetSourceScreenshot) ou base64 puro → bytes. */
export function base64Image(text: string): Buffer {
  const comma = text.startsWith('data:') ? text.indexOf(',') : -1;
  return Buffer.from(comma >= 0 ? text.slice(comma + 1) : text, 'base64');
}

/** Ao menos 1 % dos pixels com luma > 16 (a fonte do OBS não está preta). */
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
// Regiões do quadro gravado (perfil "Contrarregra": 1168×2532, iPhone a 3 px/pt, recorte de 1 px à esquerda)

export const FRAME = { width: 1168, height: 2532, pxPerPt: 3, cropLeftPx: 1 } as const;
/** A barra de estado inteira (47 pt de altura no iPhone 12) com folga: é onde o OCR procura o relógio. */
export const STATUS_BAND_PT: Rect = { x: 0, y: 0, w: 390, h: 54 };
/** A "orelha" direita da barra (sinal, Wi-Fi, bateria): onde o ícone de avião apareceria numa barra de verdade. */
export const RIGHT_EAR_PT: Rect = { x: 292, y: 6, w: 92, h: 40 };
/**
 * O botão do avião na Central, quando o `ui.find` não deu o frame: o centro do toque do SP-2 ("Tap … (78.7, 191.7)"
 * no registro do `xcodebuild`) ± 20 pt.
 */
export const BUTTON_FALLBACK_PT: Rect = { x: 58.7, y: 171.7, w: 40, h: 40 };

/**
 * Limiares fixados antes de medir:
 * - `iconDiffMin`/`noiseFactor`: a orelha direita "mudou" entre o antes e o depois quando a diferença média em cinza
 *   passa de max(`iconDiffMin`, `noiseFactor` × ruído), com o ruído = a diferença entre dois quadros do antes (0,5 s);
 * - `buttonOnMin`/`buttonOffMax`: fração de pixels laranja (systemOrange) no miolo do botão: ligado ≥ 0,25, desligado
 *   ≤ 0,05, entre = indefinido; `buttonInset`: o miolo tira 20 % de cada lado do frame;
 * - `buttonChangedMin`: o botão "mudou de aparência" (sem depender da cor) quando a diferença média em cinza ≥ 12.
 */
export const VISUAL = { iconDiffMin: 6, noiseFactor: 3, buttonOnMin: 0.25, buttonOffMax: 0.05, buttonInset: 0.2, buttonChangedMin: 12 } as const;

/** Retângulo em pontos → pixels do quadro gravado (x no quadro = 3·x − 1), inteiro e dentro do quadro. */
export function ptToPx(rect: Rect, frame: { width: number; height: number; pxPerPt: number; cropLeftPx: number } = FRAME): Rect {
  const x0 = Math.max(0, Math.round(rect.x * frame.pxPerPt) - frame.cropLeftPx);
  const x1 = Math.min(frame.width, Math.round((rect.x + rect.w) * frame.pxPerPt) - frame.cropLeftPx);
  const y0 = Math.max(0, Math.round(rect.y * frame.pxPerPt));
  const y1 = Math.min(frame.height, Math.round((rect.y + rect.h) * frame.pxPerPt));
  if (x1 - x0 <= 0 || y1 - y0 <= 0) throw new RangeError(`região fora do quadro: ${JSON.stringify(rect)}`);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** O miolo de um retângulo (tira `frac` da largura e da altura de cada lado), em inteiros. */
export function insetRect(rect: Rect, frac: number): Rect {
  const dx = Math.floor(rect.w * frac);
  const dy = Math.floor(rect.h * frac);
  return { x: rect.x + dx, y: rect.y + dy, w: Math.max(1, rect.w - 2 * dx), h: Math.max(1, rect.h - 2 * dy) };
}

/** Recorte de uma imagem já na memória (coordenadas da imagem). */
export function subImage(img: RgbImage, rect: Rect): RgbImage {
  const x0 = Math.max(0, Math.min(img.width, rect.x));
  const y0 = Math.max(0, Math.min(img.height, rect.y));
  const x1 = Math.max(x0, Math.min(img.width, rect.x + rect.w));
  const y1 = Math.max(y0, Math.min(img.height, rect.y + rect.h));
  const w = x1 - x0;
  const h = y1 - y0;
  const c = img.channels;
  const out = new Uint8Array(w * h * c);
  for (let y = 0; y < h; y++) out.set(img.data.subarray(((y0 + y) * img.width + x0) * c, ((y0 + y) * img.width + x1) * c), y * w * c);
  return { width: w, height: h, channels: c, data: out };
}

/** A orelha direita dentro do recorte da barra (os dois em pixels do quadro; o da barra começa em `bandPx`). */
export function earWithinBand(bandPx: Rect, earPx: Rect = ptToPx(RIGHT_EAR_PT)): Rect {
  return { x: earPx.x - bandPx.x, y: earPx.y - bandPx.y, w: earPx.w, h: earPx.h };
}

function luma(img: RgbImage, i: number): number {
  const p = i * img.channels;
  if (img.channels >= 3) return 0.2126 * img.data[p]! + 0.7152 * img.data[p + 1]! + 0.0722 * img.data[p + 2]!;
  return img.data[p]!;
}

/** Diferença média absoluta em cinza entre duas imagens do mesmo tamanho (0–255). */
export function grayMeanAbsDiff(a: RgbImage, b: RgbImage): number {
  if (a.width !== b.width || a.height !== b.height) throw new Error(`tamanhos diferentes: ${a.width}×${a.height} × ${b.width}×${b.height}`);
  const n = a.width * a.height;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += Math.abs(luma(a, i) - luma(b, i));
  return n === 0 ? 0 : sum / n;
}

export function meanRgb(img: RgbImage): [number, number, number] {
  const n = img.width * img.height;
  const c = img.channels;
  let r = 0;
  let g = 0;
  let b = 0;
  for (let i = 0; i < n; i++) {
    const p = i * c;
    r += img.data[p]!;
    g += c >= 3 ? img.data[p + 1]! : img.data[p]!;
    b += c >= 3 ? img.data[p + 2]! : img.data[p]!;
  }
  const k = n === 0 ? 1 : n;
  return [Math.round(r / k), Math.round(g / k), Math.round(b / k)];
}

/** Pixel "laranja" do botão ligado (systemOrange: claro 255,149,0; escuro 255,159,10), com folga para a compressão. */
export function isOrange(r: number, g: number, b: number): boolean {
  return r >= 200 && g >= 90 && g <= 200 && b <= 90;
}

export function orangeFraction(img: RgbImage): number {
  if (img.channels < 3) return 0;
  const n = img.width * img.height;
  let hits = 0;
  for (let i = 0; i < n; i++) {
    const p = i * img.channels;
    if (isOrange(img.data[p]!, img.data[p + 1]!, img.data[p + 2]!)) hits++;
  }
  return n === 0 ? 0 : hits / n;
}

export type ButtonState = 'on' | 'off' | 'unclear';

export function buttonState(orange: number): ButtonState {
  if (orange >= VISUAL.buttonOnMin) return 'on';
  if (orange <= VISUAL.buttonOffMax) return 'off';
  return 'unclear';
}

// ---------------------------------------------------------------------------------------------------------
// Relógio da barra de estado (OCR do Mac, T-0.14)

export interface ClockRead {
  /** As linhas que o Vision leu na barra. */
  texts: string[];
  /** Alguma linha tem "9:41" (a barra limpa da captura, S13 item 7). */
  shows941: boolean;
  /** O primeiro "h:mm" lido. */
  clock: string | null;
  /** O "h:mm" lido bate com a hora do Mac no instante do quadro (± 2 min, 12 h ou 24 h): barra de verdade. */
  clockReal: boolean | null;
}

const CLOCK_RE = /\b(\d{1,2}):(\d{2})\b/;

/** `h:mm` contra a hora local do Mac em `atMs` (± 2 min; aceita 12 h e 24 h). */
export function clockMatches(clock: string, atMs: number): boolean {
  const m = CLOCK_RE.exec(clock);
  if (!m) return false;
  const shown = (Number(m[1]) % 12) * 60 + Number(m[2]);
  const d = new Date(atMs);
  const real = (d.getHours() % 12) * 60 + d.getMinutes();
  const diff = Math.abs(shown - real);
  return Math.min(diff, 720 - diff) <= 2;
}

export function readClock(texts: readonly string[], atMs: number | null): ClockRead {
  const shows941 = texts.some((t) => /(^|\D)9:41(\D|$)/.test(t));
  let clock: string | null = null;
  for (const t of texts) {
    const m = CLOCK_RE.exec(t);
    if (m) {
      clock = `${m[1]}:${m[2]}`;
      break;
    }
  }
  return { texts: [...texts], shows941, clock, clockReal: clock === null || atMs === null ? null : clockMatches(clock, atMs) };
}

// ---------------------------------------------------------------------------------------------------------
// Uma troca do interruptor e o seu veredicto

export interface TransportInfo {
  transportType: string | null;
  tunnelState: string | null;
}

export interface FindResult {
  /** `ok` = 1 candidato; `late` = estourou os 10 s do runner rodando (a leitura aconteceu, a resposta se perdeu). */
  outcome: 'ok' | 'empty' | 'ambiguous' | 'late' | 'queued' | 'forbidden';
  /** Do pedido à resposta, no Mac (a fila estava vazia: é o tempo da leitura). */
  ms: number;
  /** Com `late`: do pedido até a fila do XCTest esvaziar (estimativa do tempo real da leitura). */
  lateMs?: number;
  count?: number;
  value?: string | null;
  frame?: Rect | null;
  hittable?: boolean | null;
  err?: string;
}

export interface ButtonRead {
  orange: number;
  rgb: [number, number, number];
  state: ButtonState;
}

export interface VisualResult {
  statusBar: {
    before: ClockRead | null;
    after: ClockRead | null;
    /** Diferença na orelha direita entre dois quadros do antes (ruído) e entre o antes e o depois. */
    earNoise: number | null;
    earChange: number | null;
    iconChanged: boolean | null;
  };
  button: {
    frameSource: 'find' | 'previous' | 'fallback';
    rectPx: Rect;
    /** Com a Central aberta, antes do toque e durante a pausa de ~2 s depois da troca confirmada. */
    before: ButtonRead | null;
    after: ButtonRead | null;
    diff: number | null;
    changed: boolean | null;
  };
  /** Os recortes PNG gravados (nomes, na pasta do spike). */
  crops: string[];
}

export interface ToggleRow {
  cycle: number;
  want: Want;
  at: string;
  frontBefore?: string;
  transportBefore?: TransportInfo | null;
  transportAfter?: TransportInfo | null;
  open?: { outcome: Lenient; ms: number; devMs: number | null; path: string | null };
  find?: FindResult;
  valueBefore?: SwitchValue | null;
  valueBeforeFrom?: 'find' | 'wait';
  /** O interruptor já estava no estado pedido (nada tocado). */
  already?: boolean;
  tap?: { outcome: Lenient; ms: number; reopened: boolean; path: string | null };
  valueAfter?: SwitchValue | null;
  afterReadMs?: number;
  /** Quantas vezes a Central fechou sozinha e foi reaberta nesta troca. */
  ccReopened: number;
  close?: { outcome: Lenient; ms: number };
  /** O app à frente depois de fechar a Central (`press(.home)`; DeviceMethods: "o SP-9 confere"). */
  frontAfterClose?: string | null;
  /** `msFromTap`: da resposta do toque ou, se ele estourou rodando, do fim da fila (o toque real). */
  net?: { expect: 'online' | 'offline'; ok: boolean; msFromTap: number | null; msFromTapRequest: number | null; tries: number; err?: string };
  deviceState?: { network: string; foregroundApp: string } | { err: string };
  visual?: VisualResult | null;
  visualErr?: string;
  recording?: { name: string; bytes: number } | null;
  err?: string;
  ms: number;
}

export function networkCorrect(r: ToggleRow, requireWired = true): boolean {
  if (r.net?.ok !== true) return false;
  return !requireWired || r.transportAfter?.transportType === 'wired';
}

/** A troca funcionou: Central aberta, `value` antes = antigo e depois = novo, Central fechada, rede certa no cabo. */
export function toggleFunctional(r: ToggleRow, requireWired = true): boolean {
  return (
    r.err === undefined &&
    r.open !== undefined && r.open.outcome !== 'not-run' &&
    r.valueBefore === oldValue(r.want) &&
    r.valueAfter === newValue(r.want) &&
    r.close !== undefined && r.close.outcome !== 'not-run' &&
    networkCorrect(r, requireWired)
  );
}

/** O `ui.find` (AC-1.15) achou o interruptor em ≤ `limitMs`, com o `value` legível. */
export function findWithin(r: ToggleRow, limitMs: number): boolean {
  return r.find?.outcome === 'ok' && r.find.ms <= limitMs && (r.find.value === '0' || r.find.value === '1');
}

export function toggleStrict(r: ToggleRow, limitMs: number, requireWired = true): boolean {
  return toggleFunctional(r, requireWired) && findWithin(r, limitMs);
}

/** O botão na Central mostra o estado: antes = o antigo, depois = o pedido. */
export function buttonMatches(r: ToggleRow): boolean | null {
  const b = r.visual?.button;
  if (b === undefined || b.before === null || b.after === null) return null;
  return b.before.state === (r.want === 'on' ? 'off' : 'on') && b.after.state === r.want;
}

// ---------------------------------------------------------------------------------------------------------
// Resumo, critério e decisão (regras fixadas antes de medir; ver SP-9.md)

export interface Probes {
  drag?: { outcome: 'refused' | 'executed' | 'error'; code?: string; message?: string; front?: string };
  label?: { outcome: string; ms?: number; count?: number; value?: string | null; sameFrame?: boolean | null; err?: string };
  normalize?: Json;
}

export interface Stats {
  n: number;
  p50: number | null;
  p95: number | null;
  max: number | null;
}

export function percentile(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1]!;
}

export function stats(values: readonly number[]): Stats {
  const s = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  return { n: s.length, p50: percentile(s, 50), p95: percentile(s, 95), max: s.length === 0 ? null : s[s.length - 1]! };
}

export interface Summary {
  label: string;
  cycles: number;
  toggles: number;
  findLimitMs: number;
  functionalCycles: number;
  strictCycles: number;
  functionalToggles: number;
  networkCorrect: number;
  find: { ok: Stats; withinLimit: number; late: number; lateMs: Stats; other: Record<string, number> };
  open: Stats;
  tap: { ok: number; ranLate: number; notRun: number; reopened: number };
  afterRead: Stats;
  netOffline: Stats;
  netOnline: Stats;
  ccReopened: number;
  frontAfterClose: Record<string, number>;
  statusBar: { frames: number; shows941: number; clockReal: number; clocks: string[]; iconChangedOn: number; visualOn: number; iconChangedOff: number; visualOff: number };
  button: { readable: number; matches: number; changed: number; orangeOn: number[]; orangeOff: number[] };
  probes: Probes;
  verdict: { strict: boolean; functional: boolean; network: boolean; visualProof: string; statusBar: string; decision: string };
}

const count = (rows: readonly ToggleRow[], pred: (r: ToggleRow) => boolean): number => rows.filter(pred).length;

/** Agrupa por ciclo: um ciclo vale quando as duas trocas (ligar e desligar) existem e valem. */
function cycleCount(rows: readonly ToggleRow[], ok: (r: ToggleRow) => boolean): number {
  const byCycle = new Map<number, ToggleRow[]>();
  for (const r of rows) byCycle.set(r.cycle, [...(byCycle.get(r.cycle) ?? []), r]);
  let n = 0;
  for (const list of byCycle.values()) {
    const on = list.find((r) => r.want === 'on');
    const off = list.find((r) => r.want === 'off');
    if (on !== undefined && off !== undefined && ok(on) && ok(off)) n++;
  }
  return n;
}

export function summarize(label: string, rows: readonly ToggleRow[], probes: Probes, opts: { cycles: number; findLimitMs: number; requireWired?: boolean }): Summary {
  const wired = opts.requireWired ?? true;
  const functionalCycles = cycleCount(rows, (r) => toggleFunctional(r, wired));
  const strictCycles = cycleCount(rows, (r) => toggleStrict(r, opts.findLimitMs, wired));
  const finds = rows.map((r) => r.find).filter((f): f is FindResult => f !== undefined);
  const other: Record<string, number> = {};
  for (const f of finds) if (f.outcome !== 'ok' && f.outcome !== 'late') other[f.outcome] = (other[f.outcome] ?? 0) + 1;
  const frontAfterClose: Record<string, number> = {};
  for (const r of rows) {
    if (r.close === undefined) continue;
    const k = r.frontAfterClose === undefined || r.frontAfterClose === null || r.frontAfterClose === '' ? '?' : r.frontAfterClose;
    frontAfterClose[k] = (frontAfterClose[k] ?? 0) + 1;
  }
  const visualRows = rows.filter((r) => r.visual !== undefined && r.visual !== null);
  const clocks = new Set<string>();
  let frames = 0;
  let shows941 = 0;
  let clockReal = 0;
  for (const r of visualRows) {
    for (const read of [r.visual!.statusBar.before, r.visual!.statusBar.after]) {
      if (read === null) continue;
      frames++;
      if (read.shows941) shows941++;
      if (read.clockReal === true) clockReal++;
      if (read.clock !== null) clocks.add(read.clock);
    }
  }
  const onVisual = visualRows.filter((r) => r.want === 'on' && r.visual!.statusBar.iconChanged !== null);
  const offVisual = visualRows.filter((r) => r.want === 'off' && r.visual!.statusBar.iconChanged !== null);
  const buttonReadable = visualRows.filter((r) => buttonMatches(r) !== null);
  const orangeOn: number[] = [];
  const orangeOff: number[] = [];
  for (const r of visualRows) {
    const b = r.visual!.button;
    // o "depois" mostra o estado pedido; o "antes", o antigo
    if (b.after !== null) (r.want === 'on' ? orangeOn : orangeOff).push(Math.round(b.after.orange * 1000) / 1000);
    if (b.before !== null) (r.want === 'on' ? orangeOff : orangeOn).push(Math.round(b.before.orange * 1000) / 1000);
  }
  const s: Summary = {
    label,
    cycles: opts.cycles,
    toggles: rows.length,
    findLimitMs: opts.findLimitMs,
    functionalCycles,
    strictCycles,
    functionalToggles: count(rows, (r) => toggleFunctional(r, wired)),
    networkCorrect: count(rows, (r) => networkCorrect(r, wired)),
    find: {
      ok: stats(finds.filter((f) => f.outcome === 'ok').map((f) => f.ms)),
      withinLimit: count(rows, (r) => findWithin(r, opts.findLimitMs)),
      late: finds.filter((f) => f.outcome === 'late').length,
      lateMs: stats(finds.filter((f) => f.outcome === 'late' && f.lateMs !== undefined).map((f) => f.lateMs!)),
      other,
    },
    open: stats(rows.filter((r) => r.open?.outcome === 'ok').map((r) => r.open!.ms)),
    tap: {
      ok: count(rows, (r) => r.tap?.outcome === 'ok'),
      ranLate: count(rows, (r) => r.tap?.outcome === 'ran-late'),
      notRun: count(rows, (r) => r.tap?.outcome === 'not-run'),
      reopened: count(rows, (r) => r.tap?.reopened === true),
    },
    afterRead: stats(rows.filter((r) => r.afterReadMs !== undefined).map((r) => r.afterReadMs!)),
    netOffline: stats(rows.filter((r) => r.want === 'on' && r.net?.ok === true && r.net.msFromTap !== null).map((r) => r.net!.msFromTap!)),
    netOnline: stats(rows.filter((r) => r.want === 'off' && r.net?.ok === true && r.net.msFromTap !== null).map((r) => r.net!.msFromTap!)),
    ccReopened: rows.reduce((a, r) => a + r.ccReopened, 0),
    frontAfterClose,
    statusBar: {
      frames,
      shows941,
      clockReal,
      clocks: [...clocks].sort(),
      iconChangedOn: count(onVisual, (r) => r.visual!.statusBar.iconChanged === true),
      visualOn: onVisual.length,
      iconChangedOff: count(offVisual, (r) => r.visual!.statusBar.iconChanged === true),
      visualOff: offVisual.length,
    },
    button: {
      readable: buttonReadable.length,
      matches: count(buttonReadable, (r) => buttonMatches(r) === true),
      changed: count(visualRows, (r) => r.visual!.button.changed === true),
      orangeOn,
      orangeOff,
    },
    probes,
    verdict: { strict: false, functional: false, network: false, visualProof: '', statusBar: '', decision: '' },
  };
  s.verdict = verdict(s);
  return s;
}

/** "Quase todos": ≥ 90 % de `n`, com `n` ≥ `min`. */
function mostly(hits: number, n: number, min: number): boolean {
  return n >= min && hits >= Math.ceil(0.9 * n);
}

/**
 * Regras fixadas antes de medir (SP-9.md "Decisão"):
 * - `strict` = os `cycles` ciclos com as duas trocas valendo E o `ui.find` em ≤ `findLimitMs` em todas;
 * - `functional` = os `cycles` ciclos valendo, sem olhar o tempo do `ui.find`;
 * - `network` = rede certa (offline com o avião, online sem) no cabo em todas as trocas;
 * - prova visual: o botão na Central (laranja ligado, sem laranja desligado) concorda com o `value` em ≥ 90 % das
 *   trocas legíveis (≥ 10) → `cc-button-orange`; senão, só a mudança de aparência → `cc-button-change`; senão a barra
 *   de estado com o ícone → `status-bar-icon`; senão `indefinida`;
 * - barra de estado: 9:41 em ≥ 90 % dos quadros lidos e a orelha direita sem mudança nas trocas de ligar → `limpa`;
 *   relógio de verdade e a orelha mudando ao ligar → `real`; o resto → `mista`.
 */
export function verdict(s: Summary): Summary['verdict'] {
  const strict = s.strictCycles >= s.cycles;
  const functional = s.functionalCycles >= s.cycles;
  const network = s.toggles >= 2 * s.cycles && s.networkCorrect === s.toggles;
  let visualProof = 'indefinida';
  if (mostly(s.button.matches, s.button.readable, 10)) visualProof = 'cc-button-orange';
  else if (mostly(s.button.changed, s.button.readable, 10)) visualProof = 'cc-button-change';
  else if (mostly(s.statusBar.iconChangedOn, s.statusBar.visualOn, 5)) visualProof = 'status-bar-icon';
  let statusBar = 'sem quadros';
  if (s.statusBar.frames > 0) {
    if (mostly(s.statusBar.shows941, s.statusBar.frames, 1) && s.statusBar.iconChangedOn === 0) statusBar = 'limpa';
    else if (s.statusBar.shows941 === 0 && s.statusBar.visualOn > 0 && mostly(s.statusBar.iconChangedOn, s.statusBar.visualOn, 1)) statusBar = 'real';
    else statusBar = 'mista';
  }
  let decision: string;
  if (strict && network) decision = 'principal: S1 item 7 / AC-1.15 / AC-5.7 confirmados como estão';
  else if (functional && network) decision = `principal com G1 de tempo: a troca vale 10/10, mas o ui.find passou de ${s.findLimitMs} ms (prazo do passo e AC-1.15 com os números)`;
  else if (functional) decision = 'G1 em S0.3 {network}: a troca vale, mas a rede não ficou como devia no cabo';
  else decision = 'plano B: rótulo "Airplane Mode" e a pessoa toca (ponto de controle who: human, ADR-7)';
  return { strict, functional, network, visualProof, statusBar, decision };
}

// ---------------------------------------------------------------------------------------------------------
// Tabelas (SP-9.md)

export function fmt(value: number | null | undefined, digits = 0): string {
  return value === null || value === undefined || !Number.isFinite(value) ? '—' : value.toFixed(digits);
}

export function table(header: string[], rows: string[][]): string {
  return [`| ${header.join(' | ')} |`, `|${header.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n');
}

const statsCell = (st: Stats, unit = 'ms'): string => (st.n === 0 ? '—' : `n ${st.n} · p50 ${fmt(st.p50)} · p95 ${fmt(st.p95)} · máx ${fmt(st.max)} ${unit}`);

export function toggleTable(rows: readonly ToggleRow[], limitMs: number): string {
  return table(
    ['ciclo', 'troca', 'abrir (ms)', 'achar (ms)', '≤ 2 s', 'value antes → depois', 'toque', 'reaberta', 'fechar → à frente', 'rede (s após o toque)', 'cabo', 'barra antes/depois', 'orelha Δ (ruído)', 'botão antes → depois', 'ok'],
    rows.map((r) => [
      String(r.cycle),
      r.want,
      r.open === undefined ? '—' : `${fmt(r.open.ms)}${r.open.outcome === 'ok' ? '' : ` (${r.open.outcome})`}`,
      r.find === undefined ? '—' : `${fmt(r.find.ms)}${r.find.outcome === 'ok' ? '' : ` (${r.find.outcome}${r.find.lateMs === undefined ? '' : ` ${fmt(r.find.lateMs)}`})`}`,
      findWithin(r, limitMs) ? 'sim' : 'não',
      `${r.valueBefore ?? '?'}${r.valueBeforeFrom === 'wait' ? '*' : ''} → ${r.valueAfter ?? '?'}${r.already === true ? ' (já estava)' : ''}`,
      r.tap === undefined ? '—' : `${r.tap.outcome} ${fmt(r.tap.ms)} ms`,
      String(r.ccReopened),
      r.close === undefined ? '—' : `${r.close.outcome} → ${r.frontAfterClose ?? '?'}`,
      r.net === undefined ? '—' : `${r.net.expect} ${r.net.ok ? fmt((r.net.msFromTap ?? NaN) / 1000, 1) : `não (${r.net.err ?? '?'})`}`,
      r.transportAfter?.transportType ?? '?',
      r.visual === undefined || r.visual === null
        ? '—'
        : [r.visual.statusBar.before, r.visual.statusBar.after].map((c) => (c === null ? '?' : c.clock ?? 'sem relógio')).join(' / '),
      r.visual === undefined || r.visual === null ? '—' : `${fmt(r.visual.statusBar.earChange, 1)} (${fmt(r.visual.statusBar.earNoise, 1)})`,
      r.visual === undefined || r.visual === null
        ? '—'
        : `${r.visual.button.before?.state ?? '?'} → ${r.visual.button.after?.state ?? '?'} (${r.visual.button.frameSource})`,
      toggleFunctional(r) ? (findWithin(r, limitMs) ? '✔' : '✔ (tempo ✘)') : `✘${r.err === undefined ? '' : ` ${r.err.slice(0, 60)}`}`,
    ]),
  );
}

export function summaryTable(s: Summary): string {
  const v = s.verdict;
  return table(
    ['medida', 'valor'],
    [
      ['ciclos (estrito: ≤ 2 s) / (funcional)', `${s.strictCycles}/${s.cycles} · ${s.functionalCycles}/${s.cycles}`],
      ['trocas que valem', `${s.functionalToggles}/${s.toggles}`],
      ['ui.find (ok)', statsCell(s.find.ok)],
      [`ui.find em ≤ ${s.findLimitMs} ms`, `${s.find.withinLimit}/${s.toggles}`],
      ['ui.find estourado rodando (tempo até a fila esvaziar)', `${s.find.late} · ${statsCell(s.find.lateMs)}`],
      ['abrir a Central (ok)', statsCell(s.open)],
      ['toque: ok / estourado rodando / não rodou / reaberta', `${s.tap.ok} / ${s.tap.ranLate} / ${s.tap.notRun} / ${s.tap.reopened}`],
      ['leitura do value depois do toque', statsCell(s.afterRead)],
      ['rede offline após o toque', statsCell(s.netOffline)],
      ['rede online após o toque', statsCell(s.netOnline)],
      ['rede certa no cabo', `${s.networkCorrect}/${s.toggles}`],
      ['Central reaberta (fechou sozinha)', String(s.ccReopened)],
      ['à frente depois de fechar', Object.entries(s.frontAfterClose).map(([k, n]) => `${k} ${n}`).join(' · ') || '—'],
      ['barra: 9:41 / relógio de verdade / quadros', `${s.statusBar.shows941} / ${s.statusBar.clockReal} / ${s.statusBar.frames} (${s.statusBar.clocks.join(', ') || '—'})`],
      ['orelha direita mudou ao ligar / ao desligar', `${s.statusBar.iconChangedOn}/${s.statusBar.visualOn} · ${s.statusBar.iconChangedOff}/${s.statusBar.visualOff}`],
      ['botão na Central concorda com o value / mudou', `${s.button.matches}/${s.button.readable} · ${s.button.changed}`],
      ['fração laranja: ligado / desligado', `${s.button.orangeOn.join(' ')} / ${s.button.orangeOff.join(' ')}`],
      ['sonda do arrasto por coordenada', s.probes.drag === undefined ? '—' : `${s.probes.drag.outcome}${s.probes.drag.code === undefined ? '' : ` ${s.probes.drag.code}`}`],
      ['sonda do rótulo "Airplane Mode"', s.probes.label === undefined ? '—' : `${s.probes.label.outcome} (${s.probes.label.count ?? '?'} candidato(s), ${fmt(s.probes.label.ms)} ms)`],
      ['veredicto', `estrito ${v.strict ? '✔' : '✘'} · funcional ${v.functional ? '✔' : '✘'} · rede ${v.network ? '✔' : '✘'} · prova visual: ${v.visualProof} · barra: ${v.statusBar}`],
      ['decisão', v.decision],
    ],
  );
}

// ---------------------------------------------------------------------------------------------------------
// Arquivos do próprio spike (G4: só o que o SP-9 criou em ~/Movies/contrarregra/spikes/SP-9/)

/**
 * O arquivo é do spike: está direto na pasta (sem subpasta, sem `..`), não existia antes e foi criado depois do
 * começo (birthtime/mtime ≥ início − 2 s). Copiado de spikes/sp-5/lib.ts.
 */
export function isOwnFile(file: { realPath: string; dirRealPath: string; name: string; birthtimeMs: number; mtimeMs: number },
  before: ReadonlySet<string>, startedMs: number): { ok: boolean; why: string } {
  const sep = file.dirRealPath.endsWith('/') ? '' : '/';
  if (!file.realPath.startsWith(file.dirRealPath + sep)) return { ok: false, why: `${file.realPath} fora de ${file.dirRealPath}` };
  const rest = file.realPath.slice(file.dirRealPath.length + sep.length);
  if (rest.includes('/') || rest !== file.name) return { ok: false, why: `${file.realPath} não está direto na pasta do spike` };
  if (before.has(file.name)) return { ok: false, why: `${file.name} já existia antes` };
  const created = Math.min(file.birthtimeMs > 0 ? file.birthtimeMs : file.mtimeMs, file.mtimeMs);
  if (created < startedMs - 2_000) return { ok: false, why: `${file.name} foi criado antes do começo` };
  return { ok: true, why: 'ok' };
}

/** Do livro de arquivos (`<label>-files.ndjson`): os criados e ainda não apagados, com o inode registrado. */
export function pendingFiles(rows: readonly Json[]): { name: string; ino: number; kind: string }[] {
  const live = new Map<string, { name: string; ino: number; kind: string }>();
  for (const r of rows) {
    const name = typeof r['name'] === 'string' ? r['name'] : null;
    if (name === null) continue;
    if (r['event'] === 'created' && typeof r['ino'] === 'number') live.set(name, { name, ino: r['ino'], kind: String(r['kind'] ?? '?') });
    if (r['event'] === 'deleted') live.delete(name);
  }
  return [...live.values()];
}

// ---------------------------------------------------------------------------------------------------------
// Argumentos

export interface Args {
  cmd: string;
  label: string;
  labels: string[];
  cycles: number;
  base: 'hagah' | 'home';
  record: 'both' | 'on' | 'none';
  maxRecordS: number;
  holdS: number;
  minPhaseS: number;
  probeDrag: boolean;
  probeLabel: boolean;
  keepCrops: boolean;
  runner: boolean;
}

export function parseArgs(argv: readonly string[]): Args {
  const [cmd = '', ...rest] = argv;
  const flags = new Map<string, string>();
  const bools = new Set<string>();
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (!a.startsWith('--')) throw new Error(`argumento solto: ${a}`);
    const next = rest[i + 1];
    if (next === undefined || next.startsWith('--')) bools.add(a.slice(2));
    else {
      flags.set(a.slice(2), next);
      i++;
    }
  }
  const known = new Set(['label', 'labels', 'cycles', 'base', 'record', 'max-record-s', 'hold-s', 'min-phase-s', 'no-probe-drag', 'no-probe-label', 'keep-crops', 'runner']);
  for (const k of [...flags.keys(), ...bools]) if (!known.has(k)) throw new Error(`opção desconhecida: --${k}`);
  const numFlag = (name: string, def: number, min = 0): number => {
    const v = flags.get(name);
    if (v === undefined) return def;
    const n = Number(v);
    if (!Number.isFinite(n) || n < min) throw new Error(`--${name} inválido: ${v}`);
    return n;
  };
  const choice = <T extends string>(name: string, options: readonly T[], def: T): T => {
    const v = flags.get(name) ?? def;
    if (!options.includes(v as T)) throw new Error(`--${name} deve ser ${options.join('|')}`);
    return v as T;
  };
  const label = flags.get('label') ?? '';
  if (cmd !== 'report' && cmd !== '' && !/^[A-Za-z0-9._-]+$/.test(label)) throw new Error('--label <rótulo> é obrigatório ([A-Za-z0-9._-])');
  return {
    cmd,
    label,
    labels: (flags.get('labels') ?? '').split(',').filter((l) => l !== ''),
    cycles: Math.round(numFlag('cycles', 10, 1)),
    base: choice('base', ['hagah', 'home'] as const, 'hagah'),
    record: choice('record', ['both', 'on', 'none'] as const, 'both'),
    maxRecordS: numFlag('max-record-s', 300, 30),
    holdS: numFlag('hold-s', 2),
    minPhaseS: numFlag('min-phase-s', 20),
    probeDrag: !bools.has('no-probe-drag'),
    probeLabel: !bools.has('no-probe-label'),
    keepCrops: bools.has('keep-crops'),
    runner: bools.has('runner'),
  };
}
