// Ajudante de OCR do Mac (T-0.14; architecture.md A1, A2 `media`). O Node não chama o Vision: este
// módulo roda `mac/tools/ocr.swift` com `xcrun swift` e lê o JSON que ele devolve. `media` é o único
// módulo que chama o ajudante e só importa `core` (A2). Usado nas checagens de quadros de S7/S13
// (ex.: AC-13.5 acha "Hagah Bible"; AC-13.7 quer 0 ocorrências de `bundle.displayNames`).

import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** `xcrun` pelo caminho absoluto: usa o Xcode selecionado (26.6, P-1). */
export const XCRUN_PATH = '/usr/bin/xcrun';
export const OCR_TOOL_PATH = fileURLToPath(new URL('../../tools/ocr.swift', import.meta.url));
/**
 * Teto do `fontSize` do `--render-text`, em px (o mesmo `maxFontSize` de `ocr.swift`). Folga para
 * quadros de 1080p/1170×2532; acima disso a tela de desenho cresce sem utilidade até esgotar memória.
 */
export const MAX_FONT_SIZE = 512;
/**
 * Prazo-base de cada chamada do ajudante, em ms. O `xcrun swift` compila o script a cada chamada:
 * 1–2 s com o cache de módulos quente, mas com o cache frio (primeira chamada depois de limpá-lo ou
 * de trocar o Xcode) e a CPU disputada (suíte de testes em paralelo, OBS gravando) pode passar de
 * 60 s. O prazo só existe contra travamento, por isso é folgado.
 */
export const BASE_TIMEOUT_MS = 300_000;

/** Retângulo em pixels da imagem, origem no canto superior esquerdo. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Caixa de texto do Vision: uma linha reconhecida (padrão) ou uma palavra (`words: true`). */
export interface OcrBox {
  text: string;
  frame: Rect;
  /** 0–1, do candidato principal do Vision. */
  confidence: number;
}

export interface OcrImage {
  path: string;
  width: number;
  height: number;
  boxes: OcrBox[];
}

export interface RenderedLine {
  text: string;
  /** Caixa tipográfica da linha desenhada (ascendente + descendente). */
  frame: Rect;
}

export interface RenderedText {
  path: string;
  width: number;
  height: number;
  lines: RenderedLine[];
}

export interface OcrOptions {
  /** Uma caixa por palavra em vez de uma por linha. */
  words?: boolean;
  /** Prazo do processo; padrão: `BASE_TIMEOUT_MS` (5 min; compilação do script) + 2 s por imagem. */
  timeoutMs?: number;
}

export interface RenderTextOptions {
  /** Tamanho da fonte do sistema em pixels: finito, > 0 e ≤ `MAX_FONT_SIZE`; padrão 64. */
  fontSize?: number;
  /** Prazo do processo; padrão `BASE_TIMEOUT_MS` (5 min; compilação do script). */
  timeoutMs?: number;
}

const PER_IMAGE_TIMEOUT_MS = 2_000;
const MAX_OUTPUT_BYTES = 256 * 1024 * 1024;

function runTool(args: readonly string[], timeoutMs: number): Promise<string> {
  return new Promise((resolveRun, reject) => {
    execFile(
      XCRUN_PATH,
      ['swift', OCR_TOOL_PATH, ...args],
      { encoding: 'utf8', timeout: timeoutMs, maxBuffer: MAX_OUTPUT_BYTES },
      (error, stdout, stderr) => {
        if (error) {
          const detail = stderr.trim() || error.message;
          const how = error.killed ? `parado depois de ${timeoutMs} ms` : `saída ${String(error.code ?? error.signal)}`;
          reject(new Error(`ajudante de OCR falhou (${how}): ${detail}`, { cause: error }));
          return;
        }
        resolveRun(stdout);
      },
    );
  });
}

function parseOutput<T>(stdout: string, check: (value: unknown) => value is T): T {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch (error) {
    throw new Error(`ajudante de OCR devolveu JSON inválido: ${stdout.slice(0, 200)}`, { cause: error });
  }
  if (!check(value)) throw new Error(`ajudante de OCR devolveu formato inesperado: ${stdout.slice(0, 200)}`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Roda o Vision (nível acurado) em cada PNG, numa só chamada do ajudante (compila uma vez).
 * Devolve um resultado por imagem, na ordem recebida; o `path` é o caminho absoluto pedido.
 */
export async function ocrImages(paths: readonly string[], options: OcrOptions = {}): Promise<OcrImage[]> {
  if (paths.length === 0) return [];
  const absolute = paths.map((path) => resolve(path));
  const args = [...(options.words ? ['--words'] : []), '--', ...absolute];
  const timeoutMs = options.timeoutMs ?? BASE_TIMEOUT_MS + PER_IMAGE_TIMEOUT_MS * absolute.length;
  const output = parseOutput(
    await runTool(args, timeoutMs),
    (value): value is { images: OcrImage[] } => {
      if (!isRecord(value)) return false;
      const images = value['images'];
      return Array.isArray(images) && images.length === absolute.length;
    },
  );
  return output.images;
}

/**
 * Gera a imagem de teste: o texto (linhas separadas por "\n") em preto sobre branco, desenhado com o
 * CoreText, gravado como PNG em `outPath`. Use um diretório temporário — imagem nunca entra no
 * repositório (HC-7, P-3). `fontSize` fora de (0, `MAX_FONT_SIZE`] rejeita sem chamar o ajudante.
 */
export async function renderText(text: string, outPath: string, options: RenderTextOptions = {}): Promise<RenderedText> {
  const { fontSize } = options;
  if (fontSize !== undefined && !(Number.isFinite(fontSize) && fontSize > 0 && fontSize <= MAX_FONT_SIZE)) {
    throw new Error(`renderText: fontSize inválido: ${String(fontSize)} (finito, > 0 e ≤ ${MAX_FONT_SIZE} px)`);
  }
  const args = ['--render-text', text, '--out', resolve(outPath)];
  if (fontSize !== undefined) args.push('--font-size', String(fontSize));
  return parseOutput(
    await runTool(args, options.timeoutMs ?? BASE_TIMEOUT_MS),
    (value): value is RenderedText => isRecord(value) && typeof value['path'] === 'string' && Array.isArray(value['lines']),
  );
}

function normalize(text: string): string {
  return text.normalize('NFC').toLowerCase().replace(/\s+/gu, ' ').trim();
}

/**
 * Caixas cujo texto contém o trecho, sem diferenciar maiúsculas e com espaços repetidos tratados como
 * um. Trecho vazio não acha nada. A ordem das caixas é mantida.
 */
export function findText<T extends { text: string }>(boxes: readonly T[], text: string): T[] {
  const needle = normalize(text);
  if (needle === '') return [];
  return boxes.filter((box) => normalize(box.text).includes(needle));
}
