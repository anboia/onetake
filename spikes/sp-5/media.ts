// Medidas no arquivo gravado e no microfone do Mac (SP-5, T-0.20), sempre pelo ffmpeg/ffprobe 8.1.1 fixado
// (`openFfmpeg` de `mac/src/media/ffmpeg.ts`: caminho absoluto de `paths.*` e versão conferida; nunca o do PATH, P-7),
// na base de tempo R = pts − `start_time` do arquivo (`-copyts -start_at_zero`, A13). Nada aqui grava arquivo: quadros,
// PCM e o microfone vêm pelo stdout e ficam só na memória. Código de spike, descartável.

import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';

import { assertOpened, cropFilter, runFfprobe, timeBaseArgs, type Ffmpeg } from '../../mac/src/media/ffmpeg.ts';
import { grayFrames } from '../../mac/src/media/frames.ts';
import type { Rect } from '../../mac/src/core/types.ts';
import { parseProbe, type ProbeInfo, type RgbImage } from './lib.ts';

/** `ffprobe` com fluxos, formato, capítulos e pacotes contados (sem decodificar). */
export async function probe(ff: Ffmpeg, file: string): Promise<ProbeInfo> {
  const { stdout } = await runFfprobe(ff, ['-count_packets', '-show_streams', '-show_format', '-show_chapters', '-of', 'json', file]);
  return parseProbe(JSON.parse(stdout), statSync(file).size);
}

/** Legível pelo ffprobe (fim da finalização). */
export async function probeOk(ff: Ffmpeg, file: string): Promise<boolean> {
  try {
    await runFfprobe(ff, ['-show_format', '-of', 'json', file], { timeoutMs: 20_000 });
    return true;
  } catch {
    return false;
  }
}

interface Spawned {
  stdout: AsyncIterable<Buffer>;
  done: Promise<{ code: number | null; stderr: string }>;
  kill(): void;
}

function run(ff: Ffmpeg, args: string[], stdin: 'ignore' = 'ignore'): Spawned {
  assertOpened(ff);
  const child = spawn(ff.ffmpeg, args, { stdio: [stdin, 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr = (stderr + chunk).slice(-8_000);
  });
  const done = new Promise<{ code: number | null; stderr: string }>((resolve) => {
    child.on('error', (error) => resolve({ code: -1, stderr: `${stderr}\n${error.message}` }));
    child.on('close', (code) => resolve({ code, stderr }));
  });
  return {
    stdout: child.stdout as AsyncIterable<Buffer>,
    done,
    kill: () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    },
  };
}

/**
 * `frames` quadros RGB (24 bits) do arquivo a partir de R = `startS`, inteiros ou recortados em `crop`, um por vez na
 * memória. A conversão YUV → RGB segue as marcas de cor do próprio fluxo (faixa e matriz), como um tocador faria.
 */
export async function* rgbFrames(ff: Ffmpeg, file: string, opts: { startS: number; frames: number; width: number; height: number; crop?: Rect }): AsyncGenerator<RgbImage> {
  const w = opts.crop?.w ?? opts.width;
  const h = opts.crop?.h ?? opts.height;
  // Arredondamento exato e croma inteiro: o erro da própria medida fica abaixo de 1 nível (cinza 128 volta 128).
  const filters = [...(opts.crop ? [cropFilter(opts.crop)] : []), 'scale=flags=accurate_rnd+full_chroma_int', 'format=rgb24'];
  const p = run(ff, [
    '-hide_banner', '-nostdin', '-nostats', '-loglevel', 'error',
    ...timeBaseArgs({ startS: opts.startS }),
    '-i', file, '-an', '-sn', '-dn',
    '-frames:v', String(opts.frames),
    '-vf', filters.join(','),
    '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1',
  ]);
  const size = w * h * 3;
  const chunks: Buffer[] = [];
  let buffered = 0;
  try {
    for await (const chunk of p.stdout) {
      chunks.push(chunk);
      buffered += chunk.length;
      while (buffered >= size) {
        const all = chunks.length === 1 ? chunks[0]! : Buffer.concat(chunks, buffered);
        chunks.length = 0;
        yield { width: w, height: h, channels: 3, data: new Uint8Array(all.buffer, all.byteOffset, size).slice() };
        if (all.length > size) chunks.push(all.subarray(size));
        buffered -= size;
      }
    }
    const { code, stderr } = await p.done;
    if (code !== 0) throw new Error(`ffmpeg (rgb) falhou: ${stderr.trim().split('\n').slice(-3).join(' | ')}`);
  } finally {
    p.kill();
  }
}

export interface Pcm {
  rate: number;
  /** Mono (média dos canais), em [−1, 1]. */
  samples: Float32Array;
  /** R (s) da primeira amostra: `start_time` do áudio − `start_time` do arquivo. */
  startR: number;
}

async function readAll(stream: AsyncIterable<Buffer>): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const chunk of stream) parts.push(chunk);
  return Buffer.concat(parts);
}

function s16ToFloat(buf: Buffer): Float32Array {
  const n = buf.length >> 1;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = buf.readInt16LE(i * 2) / 32768;
  return out;
}

/** O primeiro fluxo de áudio inteiro, mono 48 kHz s16 (o OBS grava áudio contínuo: amostra i ↔ R = startR + i/48000). */
export async function pcmMono(ff: Ffmpeg, file: string, info: ProbeInfo, rate = 48_000): Promise<Pcm> {
  if (info.audio === null) throw new Error(`${file} não tem áudio`);
  const p = run(ff, ['-hide_banner', '-nostdin', '-nostats', '-loglevel', 'error', '-i', file, '-map', '0:a:0', '-ac', '1', '-ar', String(rate), '-f', 's16le', 'pipe:1']);
  try {
    const buf = await readAll(p.stdout);
    const { code, stderr } = await p.done;
    if (code !== 0) throw new Error(`ffmpeg (pcm) falhou: ${stderr.trim().split('\n').slice(-3).join(' | ')}`);
    return { rate, samples: s16ToFloat(buf), startR: Math.max(0, info.audio.startS - info.formatStartS) };
  } finally {
    p.kill();
  }
}

/** Quadros em cinza recortados numa janela (para a virada do ícone; `mac/src/media/frames.ts`). */
export async function grayWindow(ff: Ffmpeg, file: string, crop: Rect, startS: number, durationS: number): Promise<{ ptsS: number; data: Uint8Array }[]> {
  const out: { ptsS: number; data: Uint8Array }[] = [];
  for await (const f of grayFrames(ff, file, { startS: Math.max(0, startS), durationS, crop })) out.push({ ptsS: f.ptsS, data: f.data });
  return out;
}

// ---------------------------------------------------------------------------------------------------------
// Microfone do Mac (só com o sim do dono; só na memória)

/** Dispositivos de áudio do AVFoundation (`-list_devices`): índice e nome. */
export async function listAudioDevices(ff: Ffmpeg): Promise<{ index: number; name: string }[]> {
  const p = run(ff, ['-hide_banner', '-nostdin', '-f', 'avfoundation', '-list_devices', 'true', '-i', '']);
  await readAll(p.stdout);
  const { stderr } = await p.done;
  return parseAvfAudioDevices(stderr);
}

export function parseAvfAudioDevices(stderr: string): { index: number; name: string }[] {
  const out: { index: number; name: string }[] = [];
  let inAudio = false;
  for (const line of stderr.split('\n')) {
    if (/AVFoundation audio devices/.test(line)) inAudio = true;
    else if (/AVFoundation video devices/.test(line)) inAudio = false;
    else if (inAudio) {
      const m = /\[(\d+)\]\s+(.+?)\s*$/.exec(line);
      if (m) out.push({ index: Number(m[1]), name: m[2]! });
    }
  }
  return out;
}

/** O microfone embutido do Mac (nunca BlackHole, agregados ou o iPhone). */
export function pickBuiltInMic(devices: { index: number; name: string }[]): { index: number; name: string } | null {
  return devices.find((d) => /MacBook.*Microphone|Built-in Microphone|Microfone d/i.test(d.name) && !/BlackHole|Aggregate|Multi-Output|iPhone/i.test(d.name)) ?? null;
}

/** `seconds` s do microfone `index`, mono 48 kHz, só na memória (nenhum arquivo). */
export async function recordMic(ff: Ffmpeg, index: number, seconds: number, rate = 48_000): Promise<Float32Array> {
  const p = run(ff, ['-hide_banner', '-nostdin', '-nostats', '-loglevel', 'error', '-f', 'avfoundation', '-i', `:${index}`, '-t', String(seconds), '-ac', '1', '-ar', String(rate), '-f', 's16le', 'pipe:1']);
  try {
    const buf = await readAll(p.stdout);
    const { code, stderr } = await p.done;
    if (code !== 0) throw new Error(`ffmpeg (microfone) falhou: ${stderr.trim().split('\n').slice(-3).join(' | ')}`);
    return s16ToFloat(buf);
  } finally {
    p.kill();
  }
}
