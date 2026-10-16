// Pós-produção da trilha do demo (spec/tasks.md "Trilha do demo", M6): corta o pré-rolo e o pós-rolo da gravação,
// encaixa cada frase da narração (voice.json do `spikes/demo/voice.ts`) no vídeo e abaixa o áudio do app enquanto o
// narrador fala (mixagem; nada além disso é editado — P-7). Código de spike, descartável.
//
//   node spikes/demo/mix.ts <pasta-da-tomada> --voice <voice.json> --out <arquivo.mp4> [--no-narration] [--plan]
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

/** O encaixe das frases (tempo do vídeo da gravação, antes do corte). */
export function place(take: Take, voice: Voice): Placement[] {
  const gap = voice.gapMs ?? 250;
  const out: Placement[] = [];
  let prevEnd = -Infinity;
  for (const scene of take.scenes) {
    const lines = voice.scenes[scene.id];
    if (lines === undefined || scene.videoStartMs === null) continue;
    let planned = scene.videoStartMs + scene.padBeforeMs;
    lines.forEach((line, i) => {
      const cues = take.steps.filter((s) => s.sceneId === scene.id && s.cue === i && s.videoMs !== null && s.status !== 'skipped').map((s) => s.videoMs!);
      const cue = cues.length > 0 ? Math.min(...cues) : null;
      const atMs = Math.max(planned, cue ?? -Infinity, prevEnd + gap);
      out.push({ scene: scene.id, i, file: line.file, atMs: Math.round(atMs), durMs: line.durMs, planned: Math.round(planned), cue });
      prevEnd = atMs + line.durMs;
      planned += line.durMs + gap;
    });
  }
  return out;
}

function probeDurationMs(file: string): number {
  return Math.round(Number(execFileSync(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf8' }).trim()) * 1000);
}

function main(): void {
  const [takeDir, ...rest] = process.argv.slice(2);
  const voicePath = opt(rest, 'voice');
  const outFile = opt(rest, 'out');
  if (takeDir === undefined || voicePath === undefined || outFile === undefined) throw new Error('uso: mix.ts <pasta> --voice <voice.json> --out <mp4> [--no-narration] [--plan]');
  const take = JSON.parse(readFileSync(join(takeDir, 'take.json'), 'utf8')) as Take;
  const voice = JSON.parse(readFileSync(voicePath, 'utf8')) as Voice;
  const recording = take.recording?.file;
  if (recording === null || recording === undefined) throw new Error('a tomada não tem gravação');
  const first = take.scenes[0];
  const last = take.scenes[take.scenes.length - 1];
  if (first?.videoStartMs == null || last === undefined) throw new Error('take.json sem tempos de vídeo das cenas');
  const durationMs = probeDurationMs(recording);
  const startMs = Math.max(0, first.videoStartMs - LEAD_MS);
  const endMs = Math.min(durationMs, (last.videoEndMs ?? durationMs) + TAIL_MS);
  const narration = rest.includes('--no-narration') ? [] : place(take, voice);
  const overrun = narration.filter((p) => p.atMs + p.durMs > endMs);
  console.log(JSON.stringify({ recording, durationMs, startMs, endMs, outMs: endMs - startMs, sentences: narration.length, overrun: overrun.map((p) => `${p.scene}#${p.i}`) }));
  if (rest.includes('--plan')) {
    for (const p of narration) console.log(`${p.scene}#${p.i} at ${((p.atMs - startMs) / 1000).toFixed(2)}s (+${((p.atMs - p.planned) / 1000).toFixed(2)}s vs plano${p.cue === null ? '' : ', cue'}) dur ${(p.durMs / 1000).toFixed(2)}s`);
    return;
  }

  const args = ['-hide_banner', '-nostdin', '-loglevel', 'error', '-y', '-ss', (startMs / 1000).toFixed(3), '-to', (endMs / 1000).toFixed(3), '-i', recording];
  for (const p of narration) args.push('-i', p.file);
  let filter: string;
  if (narration.length === 0) {
    filter = '[0:a:0]anull[aout]';
  } else {
    const delayed = narration.map((p, k) => `[${k + 1}:a]aresample=48000,aformat=channel_layouts=stereo,adelay=${p.atMs - startMs}:all=1[n${k}]`);
    const mixIn = narration.map((_, k) => `[n${k}]`).join('');
    filter = [
      ...delayed,
      `${mixIn}amix=inputs=${narration.length}:normalize=0:dropout_transition=0,asplit=2[narr][side]`,
      // O áudio do app abaixa (~-18 dB) enquanto o narrador fala e volta devagar.
      `[0:a:0]aresample=48000,aformat=channel_layouts=stereo[app]`,
      `[app][side]sidechaincompress=threshold=0.015:ratio=10:attack=15:release=600:makeup=1[ducked]`,
      `[ducked][narr]amix=inputs=2:normalize=0:duration=first,alimiter=limit=0.95[aout]`,
    ].join(';');
  }
  args.push('-filter_complex', filter, '-map', '0:v:0', '-map', '[aout]',
    '-c:v', 'libx264', '-crf', '23', '-preset', 'slow', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', outFile);
  execFileSync(FFMPEG, args, { stdio: 'inherit' });
  const probe = execFileSync(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height:format=duration', '-of', 'json', outFile], { encoding: 'utf8' });
  console.log(JSON.stringify({ out: outFile, sizeMB: Math.round(statSync(outFile).size / 1e5) / 10, probe: JSON.parse(probe) }));
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
