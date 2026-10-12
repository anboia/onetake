// Extração de quadros do vídeo pelo ffmpeg fixado (architecture.md A2 `media`): quadros em cinza
// (8 bits, um byte por pixel) lidos em fluxo do stdout (`-f rawvideo`), cada um com o seu tempo R
// (pts − `start_time` do arquivo, a base de tempo de `ffmpeg.ts`, com ou sem janela) tirado do
// `showinfo` no stderr — nunca índice × 1/fps (research/timing-post.md F15). Em fluxo
// porque uma calibração de 10 min (S7 item 7) tem ~36 mil quadros: só um quadro por vez fica na
// memória. Usado pelo decodificador do código de S0.10.

import { spawn } from 'node:child_process';

import type { Rect } from '../core/types.ts';
import { assertOpened, cropFilter, inWindow, timeBaseArgs, type Ffmpeg, type WindowOptions } from './ffmpeg.ts';

export interface GrayFrame {
  /** Ordem do quadro na extração (0 = primeiro da janela). */
  index: number;
  /** R (s) = pts − `start_time` do arquivo. */
  ptsS: number;
  width: number;
  height: number;
  /** `width × height` bytes, por linhas, 0 = preto, 255 = branco. */
  data: Uint8Array;
}

export interface GrayFramesOptions extends WindowOptions {
  /** Região em px; sem ela, o quadro inteiro. */
  crop?: Rect;
}

interface FrameInfo {
  ptsS: number;
  width: number;
  height: number;
}

const SHOWINFO = /\bn:\s*\d+\s+pts:\s*-?\d+\s+pts_time:(\S+).*?\ss:(\d+)x(\d+)/;
const STDERR_TAIL = 20;

/**
 * Quadros em cinza, em ordem, com o tempo R; com janela, só os de [startS, startS + durationS). Parar
 * a iteração mata o ffmpeg. Erro do ffmpeg, quadro incompleto ou quadro sem `showinfo` → exceção.
 */
export async function* grayFrames(ff: Ffmpeg, file: string, options: GrayFramesOptions = {}): AsyncGenerator<GrayFrame> {
  assertOpened(ff);
  const filters = ['format=gray', ...(options.crop ? [cropFilter(options.crop)] : []), 'showinfo'];
  const args = [
    '-hide_banner', '-nostdin', '-nostats', '-loglevel', 'info',
    ...timeBaseArgs(options),
    '-i', file, '-an', '-sn', '-dn',
    '-vf', filters.join(','),
    '-fps_mode', 'passthrough', '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1',
  ];
  const child = spawn(ff.ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'] });

  const infos: FrameInfo[] = [];
  const tail: string[] = [];
  let stderrDone = false;
  let spawnError: Error | undefined;
  let wake: (() => void) | undefined;
  const notify = (): void => {
    const w = wake;
    wake = undefined;
    w?.();
  };
  let partial = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    partial += chunk;
    const lines = partial.split('\n');
    partial = lines.pop() ?? '';
    for (const line of lines) {
      const match = SHOWINFO.exec(line);
      if (match) infos.push({ ptsS: Number(match[1]), width: Number(match[2]), height: Number(match[3]) });
      else if (line.trim() !== '') {
        tail.push(line);
        if (tail.length > STDERR_TAIL) tail.shift();
      }
    }
    notify();
  });
  child.stderr.on('end', () => {
    stderrDone = true;
    notify();
  });
  child.on('error', (error) => {
    spawnError = error;
    notify();
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on('close', (code, signal) => resolve({ code, signal }));
  });

  const infoAt = async (i: number): Promise<FrameInfo | undefined> => {
    while (infos.length <= i && !stderrDone && spawnError === undefined) {
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
    return infos[i];
  };

  let index = 0;
  let read = 0;
  const chunks: Buffer[] = [];
  let buffered = 0;
  try {
    for await (const chunk of child.stdout as AsyncIterable<Buffer>) {
      chunks.push(chunk);
      buffered += chunk.length;
      while (buffered > 0) {
        const info = await infoAt(read);
        if (!info) throw new Error(`ffmpeg: quadro ${read} sem showinfo (${tail.join(' | ')})`);
        const size = info.width * info.height;
        if (buffered < size) break;
        const all = chunks.length === 1 ? chunks[0]! : Buffer.concat(chunks, buffered);
        chunks.length = 0;
        const inside = inWindow(info.ptsS, options);
        const data = inside ? new Uint8Array(all.buffer, all.byteOffset, size).slice() : undefined;
        if (all.length > size) chunks.push(all.subarray(size));
        buffered -= size;
        read++;
        if (data) {
          yield { index, ptsS: info.ptsS, width: info.width, height: info.height, data };
          index++;
        }
      }
    }
    const { code, signal } = await exited;
    if (spawnError) throw new Error(`ffmpeg não rodou: ${spawnError.message}`, { cause: spawnError });
    if (code !== 0) throw new Error(`ffmpeg falhou (saída ${String(code ?? signal)}): ${tail.join(' | ')}`);
    if (buffered !== 0) throw new Error(`ffmpeg: ${buffered} bytes sobrando depois do último quadro`);
    if (infos.length !== read) throw new Error(`ffmpeg: ${infos.length} quadros no showinfo × ${read} no stdout`);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
}
