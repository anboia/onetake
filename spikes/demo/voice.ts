// Narração da trilha do demo (spec/tasks.md "Trilha do demo"; M6): gera, frase a frase, a fala de cada cena da
// coreografia com o Google Cloud Text-to-Speech (voz escolhida pelo dono em 2026-10-16) e escreve o `voice.json` que o
// `take run --voice` usa para `cue` e para a duração mínima das cenas. Código de spike, descartável.
//
//   node spikes/demo/voice.ts <choreo.yaml> <pasta-de-saída> [--voice en-US-Chirp3-HD-Charon] [--dry]
//
// A chave vem do Chaveiro (serviço `contrarregra`, conta `GOOGLE_TTS_API_KEY`), lida em memória e mandada só no
// cabeçalho `x-goog-api-key`; nunca é impressa. Cada frase vira `<sNN>-<nn>.wav` (LINEAR16 mono 24 kHz, a duração é
// exata); uma frase já gerada com o mesmo texto e a mesma voz não é pedida de novo (índice `voice-index.json`).
// `--dry` só conta frases e caracteres, sem chamar o serviço.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { parse } from 'yaml';

import { readSecret } from '../../mac/src/core/secret.ts';

const ENDPOINT = 'https://texttospeech.googleapis.com/v1/text:synthesize';
const SAMPLE_RATE = 24_000;
const GAP_MS = 250;

interface Scene {
  id: string;
  line?: string[];
}

function opt(args: string[], name: string, fallback: string): string {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1]! : fallback;
}

/** Duração de um WAV PCM pelo cabeçalho (tamanho do bloco `data` ÷ bytes por segundo). */
export function wavDurationMs(buf: Buffer): number {
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') throw new Error('não é WAV');
  let off = 12;
  let byteRate = 0;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'fmt ') byteRate = buf.readUInt32LE(off + 16);
    if (id === 'data') {
      if (byteRate === 0) throw new Error('WAV sem fmt antes de data');
      return Math.round((Math.min(size, buf.length - off - 8) / byteRate) * 1000);
    }
    off += 8 + size + (size % 2);
  }
  throw new Error('WAV sem bloco data');
}

async function synthesize(key: string, voice: string, text: string): Promise<Buffer> {
  const languageCode = voice.split('-').slice(0, 2).join('-');
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({
      input: { text },
      voice: { languageCode, name: voice },
      audioConfig: { audioEncoding: 'LINEAR16', sampleRateHertz: SAMPLE_RATE },
    }),
  });
  const body = (await res.json()) as { audioContent?: string; error?: { code: number; message: string } };
  if (!res.ok || body.audioContent === undefined) throw new Error(`TTS ${res.status}: ${body.error?.message?.slice(0, 200) ?? 'sem áudio'}`);
  return Buffer.from(body.audioContent, 'base64');
}

async function main(): Promise<void> {
  const [choreo, outDir, ...rest] = process.argv.slice(2);
  if (choreo === undefined || outDir === undefined) throw new Error('uso: voice.ts <choreo.yaml> <pasta> [--voice …] [--dry]');
  const voice = opt(rest, 'voice', 'en-US-Chirp3-HD-Charon');
  const dry = rest.includes('--dry');
  const doc = parse(readFileSync(choreo, 'utf8')) as { scenes: Scene[] };
  const sentences = doc.scenes.flatMap((s) => (s.line ?? []).map((text, i) => ({ scene: s.id, i, text })));
  const chars = sentences.reduce((n, s) => n + s.text.length, 0);
  console.log(JSON.stringify({ voice, sentences: sentences.length, chars }));
  if (dry) return;

  mkdirSync(outDir, { recursive: true });
  const indexPath = join(outDir, 'voice-index.json');
  const index: Record<string, string> = existsSync(indexPath) ? (JSON.parse(readFileSync(indexPath, 'utf8')) as Record<string, string>) : {};
  const key = await readSecret('GOOGLE_TTS_API_KEY');
  const scenes: Record<string, { text: string; durMs: number; file: string }[]> = {};
  let requested = 0;
  for (const s of sentences) {
    const file = join(outDir, `${s.scene}-${String(s.i).padStart(2, '0')}.wav`);
    const hash = createHash('sha256').update(`${voice}\n${s.text}`).digest('hex');
    if (!(index[file] === hash && existsSync(file))) {
      writeFileSync(file, await synthesize(key.reveal(), voice, s.text));
      index[file] = hash;
      requested++;
      writeFileSync(indexPath, JSON.stringify(index, null, 2));
    }
    (scenes[s.scene] ??= []).push({ text: s.text, durMs: wavDurationMs(readFileSync(file)), file });
  }
  const out = { voice, gapMs: GAP_MS, scenes };
  writeFileSync(join(outDir, 'voice.json'), JSON.stringify(out, null, 2));
  const total = Object.values(scenes).flat().reduce((n, x) => n + x.durMs, 0);
  const perScene = Object.fromEntries(Object.entries(scenes).map(([k, v]) => [k, Math.round((v.reduce((n, x) => n + x.durMs, 0) + (v.length - 1) * GAP_MS) / 100) / 10]));
  console.log(JSON.stringify({ requested, voiceJson: join(outDir, 'voice.json'), totalS: Math.round(total / 100) / 10, perSceneS: perScene }));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
