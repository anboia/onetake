// Pós-produção da trilha do demo (spec/tasks.md "Trilha do demo", M6): corta o pré-rolo e o pós-rolo da gravação,
// encaixa cada frase da narração (voice.json do `spikes/demo/voice.ts`) no vídeo e abaixa o áudio do app enquanto o
// narrador fala (mixagem; nada além disso é editado — P-7). Código de spike, descartável.
//
//   node spikes/demo/mix.ts <pasta-da-tomada> --voice <voice.json> --out <arquivo.mp4> [--no-narration] [--plan]
//   node spikes/demo/mix.ts --take <pasta>@s01-s08 --take <pasta2>@s09-s10 --voice … --out …   (trechos de tomadas, em ordem)
//
// Onde cada frase entra (tempo do vídeo, ms): frase i da cena S começa em
//   max(planejado, cue real, fim da frase anterior + gap)
// com planejado = início da cena no vídeo + padBeforeMs + Σ (durMs + gap) das anteriores, e "cue real" = o tempo
// do vídeo do primeiro passo da cena com `cue: i` (o passo começa quando a frase começa; se ele atrasou — um ponto
// de controle humano, um toque lento —, a frase espera por ele). `--plan` só imprime o encaixe.
// O corte: começa 1 s antes da cena 1 (tela de início parada) e termina 1,5 s depois do fim da última cena.

import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const FFMPEG = '/opt/homebrew/opt/ffmpeg/bin/ffmpeg';
const FFPROBE = '/opt/homebrew/opt/ffmpeg/bin/ffprobe';
const LEAD_MS = 1000;
const TAIL_MS = 1500;

interface Scene { id: string; videoStartMs: number | null; videoEndMs?: number | null; padBeforeMs: number }
interface StepRec { sceneId: string | null; cue?: number; videoMs: number | null; status: string }
interface Take { scenes: Scene[]; steps: StepRec[]; recording: { file: string | null } | null }
interface Voice { gapMs?: number; scenes: Record<string, { text: string; durMs: number; file: string }[]> }
export interface Placement { scene: string; i: number; file: string; atMs: number; durMs: number; planned: number; cue: number | null }

function opt(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

/**
 * O encaixe das frases (tempo do vídeo da gravação, antes do corte). Se a fala de uma cena passar do fim dela
 * (+ `spillMs`; na última cena, `lastSpillMs`), as frases do fim recuam (passada de trás para a frente) até caber,
 * sem começar antes do fim da frase anterior + gap.
 */
export function place(take: Take, voice: Voice, spillMs = 400, lastSpillMs = TAIL_MS - 300): Placement[] {
  const gap = voice.gapMs ?? 250;
  const out: Placement[] = [];
  let prevEnd = -Infinity;
  take.scenes.forEach((scene, k) => {
    const lines = voice.scenes[scene.id];
    if (lines === undefined || scene.videoStartMs === null) return;
    let planned = scene.videoStartMs + scene.padBeforeMs;
    const floor = prevEnd;
    const mine: Placement[] = [];
    lines.forEach((line, i) => {
      const cues = take.steps.filter((s) => s.sceneId === scene.id && s.cue === i && s.videoMs !== null && s.status !== 'skipped').map((s) => s.videoMs!);
      const cue = cues.length > 0 ? Math.min(...cues) : null;
      const atMs = Math.max(planned, cue ?? -Infinity, prevEnd + gap);
      mine.push({ scene: scene.id, i, file: line.file, atMs: Math.round(atMs), durMs: line.durMs, planned: Math.round(planned), cue });
      prevEnd = atMs + line.durMs;
      planned += line.durMs + gap;
    });
    const end = scene.videoEndMs;
    if (end != null) {
      let limit = end + (k === take.scenes.length - 1 ? lastSpillMs : spillMs);
      for (let j = mine.length - 1; j >= 0; j--) {
        const p = mine[j]!;
        const earliest = j === 0 ? Math.max(scene.videoStartMs, floor + gap) : -Infinity;
        if (p.atMs + p.durMs > limit) p.atMs = Math.round(Math.max(limit - p.durMs, earliest));
        limit = p.atMs - gap;
      }
      for (let j = 1; j < mine.length; j++) mine[j]!.atMs = Math.max(mine[j]!.atMs, mine[j - 1]!.atMs + mine[j - 1]!.durMs + gap);
      const last = mine[mine.length - 1];
      if (last !== undefined) prevEnd = last.atMs + last.durMs;
    }
    out.push(...mine);
  });
  return out;
}

function probeDurationMs(file: string): number {
  return Math.round(Number(execFileSync(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf8' }).trim()) * 1000);
}

/** Um trecho de uma gravação: as cenas `from`…`to` de uma tomada (`--take <pasta>[@s01-s08]`). */
interface Segment { dir: string; take: Take; recording: string; startMs: number; endMs: number; outOffsetMs: number }

function segments(specs: string[]): Segment[] {
  const out: Segment[] = [];
  let offset = 0;
  specs.forEach((spec, k) => {
    const [dir, range] = spec.split('@') as [string, string | undefined];
    const take = JSON.parse(readFileSync(join(dir, 'take.json'), 'utf8')) as Take;
    const recording = take.recording?.file;
    if (recording === null || recording === undefined) throw new Error(`${dir}: a tomada não tem gravação`);
    const [from, to] = range === undefined ? [undefined, undefined] : range.split('-');
    const lo = from === undefined ? 0 : take.scenes.findIndex((x) => x.id === from);
    const hi = to === undefined ? take.scenes.length - 1 : take.scenes.findIndex((x) => x.id === to);
    if (lo < 0 || hi < lo) throw new Error(`${spec}: cenas fora da tomada`);
    const scenes = take.scenes.slice(lo, hi + 1);
    const ids = new Set(scenes.map((x) => x.id));
    const first = scenes[0]!;
    const last = scenes[scenes.length - 1]!;
    if (first.videoStartMs == null) throw new Error(`${spec}: sem tempo de vídeo`);
    const durationMs = probeDurationMs(recording);
    // O primeiro trecho começa 1 s antes (tela de início parada); os seguintes, no início exato da cena (corte entre
    // cenas). O último termina TAIL_MS depois; os do meio, no fim exato da última cena.
    const startMs = Math.max(0, first.videoStartMs - (k === 0 ? LEAD_MS : 0));
    const endMs = Math.min(durationMs, (last.videoEndMs ?? durationMs) + (k === specs.length - 1 ? TAIL_MS : 0));
    out.push({ dir, take: { ...take, scenes, steps: take.steps.filter((x) => x.sceneId !== null && ids.has(x.sceneId)) }, recording, startMs, endMs, outOffsetMs: offset });
    offset += endMs - startMs;
  });
  return out;
}

function main(): void {
  const args = process.argv.slice(2);
  const takes: string[] = [];
  args.forEach((a, i) => { if (a === '--take' && args[i + 1] !== undefined) takes.push(args[i + 1]!); });
  if (takes.length === 0 && args[0] !== undefined && !args[0].startsWith('--')) takes.push(args[0]);
  const voicePath = opt(args, 'voice');
  const outFile = opt(args, 'out');
  if (takes.length === 0 || voicePath === undefined || outFile === undefined) throw new Error('uso: mix.ts (<pasta> | --take <pasta>[@sA-sB] …) --voice <voice.json> --out <mp4> [--no-narration] [--plan]');
  const voice = JSON.parse(readFileSync(voicePath, 'utf8')) as Voice;
  const segs = segments(takes);
  const totalMs = segs.reduce((n, g) => n + g.endMs - g.startMs, 0);
  const narration = args.includes('--no-narration') ? [] : segs.flatMap((g) => place(g.take, voice).map((p) => ({ ...p, outMs: g.outOffsetMs + p.atMs - g.startMs })));
  const overrun = narration.filter((p) => p.outMs + p.durMs > totalMs);
  console.log(JSON.stringify({ segments: segs.map((g) => ({ recording: g.recording, startMs: g.startMs, endMs: g.endMs, outOffsetMs: g.outOffsetMs })), outMs: totalMs, sentences: narration.length, overrun: overrun.map((p) => `${p.scene}#${p.i}`) }));
  if (args.includes('--plan')) {
    for (const p of narration) console.log(`${p.scene}#${p.i} at ${(p.outMs / 1000).toFixed(2)}s (+${((p.atMs - p.planned) / 1000).toFixed(2)}s vs plano${p.cue === null ? '' : ', cue'}) dur ${(p.durMs / 1000).toFixed(2)}s`);
    return;
  }

  const ff = ['-hide_banner', '-nostdin', '-loglevel', 'error', '-y'];
  for (const g of segs) ff.push('-ss', (g.startMs / 1000).toFixed(3), '-to', (g.endMs / 1000).toFixed(3), '-i', g.recording);
  for (const p of narration) ff.push('-i', p.file);
  const n = segs.length;
  const parts: string[] = [];
  parts.push(segs.map((_, k) => `[${k}:v:0][${k}:a:0]`).join('') + `concat=n=${n}:v=1:a=1[v][rec]`);
  if (narration.length === 0) {
    parts.push('[rec]anull[aout]');
  } else {
    narration.forEach((p, k) => parts.push(`[${n + k}:a]aresample=48000,aformat=channel_layouts=stereo,adelay=${Math.round(p.outMs)}:all=1[n${k}]`));
    parts.push(`${narration.map((_, k) => `[n${k}]`).join('')}amix=inputs=${narration.length}:normalize=0:dropout_transition=0,asplit=2[narr][side]`);
    // O áudio do app abaixa (~-18 dB) enquanto o narrador fala e volta devagar.
    parts.push('[rec]aresample=48000,aformat=channel_layouts=stereo[app]');
    parts.push('[app][side]sidechaincompress=threshold=0.015:ratio=10:attack=15:release=600:makeup=1[ducked]');
    parts.push('[ducked][narr]amix=inputs=2:normalize=0:duration=first,alimiter=limit=0.95[aout]');
  }
  ff.push('-filter_complex', parts.join(';'), '-map', '[v]', '-map', '[aout]',
    '-c:v', 'libx264', '-crf', '23', '-preset', 'slow', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', outFile);
  execFileSync(FFMPEG, ff, { stdio: 'inherit' });
  const probe = execFileSync(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height:format=duration', '-of', 'json', outFile], { encoding: 'utf8' });
  console.log(JSON.stringify({ out: outFile, sizeMB: Math.round(statSync(outFile).size / 1e5) / 10, probe: JSON.parse(probe) }));
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
