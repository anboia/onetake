// Invólucro do ffmpeg/ffprobe (architecture.md A1, A2 `media`; P-1, P-7): o único lugar que chama os
// dois, sempre pelo caminho absoluto fixado em `paths.ffmpeg`/`paths.ffprobe` da config (8.1.1 em
// /opt/homebrew/opt/ffmpeg/bin; o do PATH é o 4.4.7, cujo ffprobe não tem `pts_time`) e com a versão
// conferida contra `toolchain.validated.ffmpeg`. As funções daqui só aceitam o objeto devolvido por
// `openFfmpeg`, então nenhum chamador consegue passar um caminho solto.
//
// Base de tempo: todo tempo que entra ou sai deste módulo e de `frames.ts` está em R = pts −
// `start_time` do arquivo (o do formato, que é o menor entre os fluxos), em s, com ou sem janela.
// É a mesma origem que o `-ss` de entrada do ffmpeg usa, então uma janela pedida em R vira o `-ss`
// certo sem conta nenhuma, e o corte do pré-rolo (`-ss trim.startR`) cai no mesmo lugar. O ffmpeg é
// sempre chamado com `-copyts -start_at_zero`: sem isso, a saída sem janela vem relativa ao início
// e a com janela vem em pts absolutos (research/timing-post.md, risco "Tooling drift").

import { execFile } from 'node:child_process';
import { basename, isAbsolute } from 'node:path';

import type { Config } from '../core/config.ts';
import { ContrarregraError } from '../core/errors.ts';
import type { Rect } from '../core/types.ts';

/** Binários abertos e conferidos. Só `openFfmpeg` cria; os demais só leem. */
export interface Ffmpeg {
  readonly ffmpeg: string;
  readonly ffprobe: string;
  readonly version: string;
}

export interface VideoInfo {
  width: number;
  height: number;
  /** De `r_frame_rate` do fluxo de vídeo. */
  fps: number;
  frameDurationS: number;
  durationS: number;
  /** `start_time` do arquivo (formato), em pts absolutos: é o R = 0. Informativo. */
  startTimeS: number;
  /** R do primeiro quadro de vídeo (> 0 quando outro fluxo, ex. o áudio, começa antes). */
  videoStartR: number;
  codec: string;
}

/** Valores de `signalstats` de um quadro, no tempo R do arquivo. */
export interface FrameStats {
  /** R (s) = pts − `start_time` do arquivo. */
  ptsS: number;
  /** Chave sem o prefixo `lavfi.signalstats.` (ex.: `YAVG`, `YDIF`, `YMAX`). */
  values: Record<string, number>;
}

/** Janela [startS, startS + durationS) em R (s); só os quadros dentro dela saem. */
export interface WindowOptions {
  /** Início da janela em R (s). */
  startS?: number;
  /** Duração da janela em s. */
  durationS?: number;
}

export interface SignalstatsOptions extends WindowOptions {
  /** Região em px do quadro; com ela, a imagem passa a cinza antes do recorte (recorte exato). */
  crop?: Rect;
  /** `tblend=all_mode=difference` antes do `signalstats` (classificação de mudança, S7 item 4). */
  difference?: boolean;
  timeoutMs?: number;
}

export interface RunOptions {
  timeoutMs?: number;
}

/** Prazo de cada chamada (só contra travamento; análises longas passam o seu). */
export const DEFAULT_TIMEOUT_MS = 600_000;
const VERSION_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 512 * 1024 * 1024;

const opened = new WeakSet<Ffmpeg>();

/** Recusa objeto que não veio de `openFfmpeg` (caminho não conferido). */
export function assertOpened(ff: Ffmpeg): void {
  if (!opened.has(ff)) {
    throw new Error('ffmpeg: use o objeto devolvido por openFfmpeg (caminho fixado e versão conferida; P-1, P-7)');
  }
}

interface ExecResult {
  stdout: string;
  stderr: string;
}

function exec(file: string, args: readonly string[], timeoutMs: number): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { encoding: 'utf8', timeout: timeoutMs, maxBuffer: MAX_OUTPUT_BYTES }, (error, stdout, stderr) => {
      if (error) {
        const how = error.killed ? `parado depois de ${timeoutMs} ms` : `saída ${String(error.code ?? error.signal)}`;
        const detail = stderr.trim().split('\n').slice(-5).join(' | ') || error.message;
        reject(new Error(`${basename(file)} falhou (${how}): ${detail}`, { cause: error }));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function readVersion(tool: 'ffmpeg' | 'ffprobe', path: string, expected: string): Promise<void> {
  let stdout: string;
  try {
    ({ stdout } = await exec(path, ['-version'], VERSION_TIMEOUT_MS));
  } catch (error) {
    throw new ContrarregraError(
      'E_TOOLCHAIN_MISMATCH',
      `não consegui rodar ${tool} em ${path} (${(error as Error).message}); a versão validada é ${expected} (P-1)`,
      { tool, path, found: null, expected },
      { cause: error },
    );
  }
  const found = new RegExp(`^${tool} version (\\S+)`, 'm').exec(stdout)?.[1] ?? null;
  if (found !== expected) {
    throw new ContrarregraError(
      'E_TOOLCHAIN_MISMATCH',
      `${tool} em ${path} é ${found ?? 'de versão desconhecida'}; a versão validada é ${expected} (P-1)`,
      { tool, path, found, expected },
    );
  }
}

/**
 * Abre o ffmpeg/ffprobe da config: caminhos absolutos (senão `E_CONFIG`, sem criar processo) e versão
 * igual a `toolchain.validated.ffmpeg` (senão `E_TOOLCHAIN_MISMATCH`).
 */
export async function openFfmpeg(config: Pick<Config, 'paths' | 'toolchain'>): Promise<Ffmpeg> {
  const { ffmpeg, ffprobe } = config.paths;
  for (const [field, path] of [
    ['paths.ffmpeg', ffmpeg],
    ['paths.ffprobe', ffprobe],
  ] as const) {
    if (typeof path !== 'string' || !isAbsolute(path)) {
      throw new ContrarregraError(
        'E_CONFIG',
        `${field} = ${JSON.stringify(path ?? null)}: o ffmpeg/ffprobe só é chamado pelo caminho absoluto fixado (o do PATH é o 4.4.7; P-1, P-7)`,
        { field, value: path ?? null },
      );
    }
  }
  const expected = config.toolchain.validated['ffmpeg'];
  if (typeof expected !== 'string' || expected === '') {
    throw new ContrarregraError('E_CONFIG', 'toolchain.validated.ffmpeg ausente: não há versão para conferir (P-1)', {
      field: 'toolchain.validated.ffmpeg',
    });
  }
  await Promise.all([readVersion('ffmpeg', ffmpeg, expected), readVersion('ffprobe', ffprobe, expected)]);
  const ff: Ffmpeg = Object.freeze({ ffmpeg, ffprobe, version: expected });
  opened.add(ff);
  return ff;
}

/** Roda o ffmpeg fixado (`-hide_banner -nostdin -nostats -loglevel error` antes dos argumentos). */
export async function runFfmpeg(ff: Ffmpeg, args: readonly string[], options: RunOptions = {}): Promise<ExecResult> {
  assertOpened(ff);
  return exec(ff.ffmpeg, ['-hide_banner', '-nostdin', '-nostats', '-loglevel', 'error', ...args], options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
}

/** Roda o ffprobe fixado (`-hide_banner -v error` antes dos argumentos). */
export async function runFfprobe(ff: Ffmpeg, args: readonly string[], options: RunOptions = {}): Promise<ExecResult> {
  assertOpened(ff);
  return exec(ff.ffprobe, ['-hide_banner', '-v', 'error', ...args], options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
}

function parseRate(rate: unknown): number {
  const match = typeof rate === 'string' ? /^(\d+)\/(\d+)$/.exec(rate) : null;
  const num = match ? Number(match[1]) : NaN;
  const den = match ? Number(match[2]) : NaN;
  if (!(num > 0 && den > 0)) throw new Error(`ffprobe: taxa de quadros inválida: ${String(rate)}`);
  return num / den;
}

function parseSeconds(value: unknown): number | undefined {
  const n = typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(n) ? n : undefined;
}

/** Tamanho, fps e duração do primeiro fluxo de vídeo; `start_time` do arquivo e onde o vídeo começa em R. */
export async function probeVideo(ff: Ffmpeg, file: string): Promise<VideoInfo> {
  const { stdout } = await runFfprobe(ff, [
    '-select_streams', 'v:0',
    '-show_entries', 'stream=codec_name,width,height,r_frame_rate,start_time,duration:format=duration,start_time',
    '-of', 'json',
    file,
  ]);
  const parsed = JSON.parse(stdout) as { streams?: Record<string, unknown>[]; format?: Record<string, unknown> };
  const stream = parsed.streams?.[0];
  if (!stream) throw new Error(`ffprobe: sem fluxo de vídeo em ${file}`);
  const fps = parseRate(stream['r_frame_rate']);
  const fileStart = parseSeconds(parsed.format?.['start_time']);
  const videoStart = parseSeconds(stream['start_time']);
  return {
    width: Number(stream['width']),
    height: Number(stream['height']),
    fps,
    frameDurationS: 1 / fps,
    durationS: parseSeconds(stream['duration']) ?? parseSeconds(parsed.format?.['duration']) ?? NaN,
    startTimeS: fileStart ?? 0,
    videoStartR: fileStart !== undefined && videoStart !== undefined ? videoStart - fileStart : 0,
    codec: String(stream['codec_name']),
  };
}

/** Folga ao comparar `pts_time` (impresso com 6 casas) com os limites da janela: meia unidade. */
const PTS_EPSILON_S = 5e-7;

/**
 * Argumentos de entrada da base de tempo R (antes do `-i`): sempre `-copyts -start_at_zero` (saída
 * em R, com ou sem janela) e, com janela, `-ss <R>` (o ffmpeg soma o `start_time` do arquivo) e
 * `-t`. O `-t` de entrada só limita a leitura (conta a partir do primeiro quadro lido, que pode vir
 * depois do `-ss`); o fim da janela é aplicado por `inWindow`.
 */
export function timeBaseArgs(window: WindowOptions = {}): string[] {
  const args = ['-copyts', '-start_at_zero'];
  if (window.startS !== undefined) args.push('-ss', Math.max(0, window.startS).toFixed(6));
  if (window.durationS !== undefined) {
    if (!(window.durationS > 0)) throw new RangeError(`janela com duração inválida: ${window.durationS}`);
    args.push('-t', window.durationS.toFixed(6));
  }
  return args;
}

/** O quadro em R (s) está em [startS, startS + durationS)? Sem limites, tudo está. */
export function inWindow(ptsS: number, window: WindowOptions): boolean {
  const start = window.startS ?? -Infinity;
  const end = window.durationS === undefined ? Infinity : (window.startS ?? 0) + window.durationS;
  return ptsS >= start - PTS_EPSILON_S && ptsS < end - PTS_EPSILON_S;
}

/** `crop=w:h:x:y` com inteiros conferidos (nada de texto livre no grafo de filtros). */
export function cropFilter(rect: Rect): string {
  const values = [rect.w, rect.h, rect.x, rect.y];
  if (!values.every((v) => Number.isInteger(v)) || rect.w <= 0 || rect.h <= 0 || rect.x < 0 || rect.y < 0) {
    throw new RangeError(`recorte inválido: ${JSON.stringify(rect)}`);
  }
  return `crop=${rect.w}:${rect.h}:${rect.x}:${rect.y}`;
}

const FRAME_LINE = /^frame:\d+\s+pts:-?\d+\s+pts_time:(\S+)/;
const STAT_LINE = /^lavfi\.signalstats\.(\w+)=(\S+)$/;

/**
 * `signalstats` por quadro (S7 itens 3 e 4): YAVG para as marcas, YDIF para achar o quadro que muda
 * e, com `difference`, YMAX da diferença para classificar a mudança. Lê o `metadata=mode=print` pelo
 * stdout; os tempos são o `pts_time` em R (base de tempo no topo do módulo), nunca índice × 1/fps
 * (F15). Só saem os quadros dentro da janela.
 */
export async function signalstats(ff: Ffmpeg, file: string, options: SignalstatsOptions = {}): Promise<FrameStats[]> {
  const filters: string[] = [];
  if (options.crop) filters.push('format=gray', cropFilter(options.crop));
  if (options.difference) {
    if (!options.crop) filters.push('format=gray');
    filters.push('tblend=all_mode=difference');
  }
  filters.push('signalstats', "metadata=mode=print:file='pipe\\:1'");
  const { stdout } = await runFfmpeg(
    ff,
    [...timeBaseArgs(options), '-i', file, '-an', '-sn', '-dn', '-vf', filters.join(','), '-f', 'null', '-'],
    { timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS },
  );
  const frames: FrameStats[] = [];
  for (const line of stdout.split('\n')) {
    const frame = FRAME_LINE.exec(line);
    if (frame) {
      frames.push({ ptsS: Number(frame[1]), values: {} });
      continue;
    }
    const stat = STAT_LINE.exec(line);
    const current = frames.at(-1);
    if (stat && current) {
      const value = Number(stat[2]);
      if (Number.isFinite(value)) current.values[stat[1]!] = value;
    }
  }
  return frames.filter((frame) => inWindow(frame.ptsS, options));
}
