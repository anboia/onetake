// Plano da narração (`take run --voice <voice.json>`, trilha do demo): as durações das frases já
// sintetizadas fora da ferramenta (o TTS da narração), cena a cena. O executor usa o plano para os `cue`
// (o passo não começa antes da frase n da cena) e para a duração mínima da cena (S4 item 3, S6 item 3);
// sem `--voice`, `cue` é ignorado e a cena dura no mínimo `padBeforeMs + padAfterMs`.
//
// Formato (JSON; campos a mais são ignorados, para o gerador da narração poder anotar o que quiser):
//
//   {
//     "gapMs": 250,                                   // opcional: pausa entre frases (padrão 250 ms)
//     "scenes": {
//       "s01": [{"text": "Frase 1.", "durMs": 4200}, {"text": "Frase 2.", "durMs": 3100}],
//       "s02": [...]
//     }
//   }
//
// Tetos: `durMs` ≤ 60 000 por frase e `gapMs` ≤ 5 000; fora disso, erro (`E_CONFIG` com o caminho do campo).
//
// Frase n da cena começa em `início da cena + padBeforeMs + Σ durMs das frases anteriores + n × gapMs`;
// a narração da cena dura `Σ durMs + (frases − 1) × gapMs`.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { z } from 'zod';

import { ContrarregraError } from '../core/errors.ts';
import { validate } from '../core/schema.ts';
import type { Choreography } from '../core/types.ts';

/** Pausa entre frases quando o arquivo não diz outra (trilha do demo). */
export const DEFAULT_GAP_MS = 250;

export interface VoiceSentence {
  text: string;
  durMs: number;
}

export interface VoicePlan {
  /** Caminho absoluto do arquivo lido. */
  path: string;
  sha256: string;
  gapMs: number;
  scenes: Record<string, VoiceSentence[]>;
}

/** Tetos de sanidade: uma frase de narração passa de 60 s ou uma pausa de 5 s = arquivo errado (ms em vez de s…). */
export const MAX_SENTENCE_MS = 60_000;
export const MAX_GAP_MS = 5_000;

const SentenceSchema = z.looseObject({ text: z.string(), durMs: z.int().min(0).max(MAX_SENTENCE_MS) });
const VoiceFileSchema = z.looseObject({
  gapMs: z.int().min(0).max(MAX_GAP_MS).optional(),
  scenes: z.record(z.string().regex(/^s[0-9]{2}$/, 'id de cena no formato ^s\\d{2}$'), z.array(SentenceSchema)),
});

/** Lê o plano; arquivo ilegível ou fora do formato → `E_CONFIG` com o caminho do campo. */
export function loadVoicePlan(file: string): VoicePlan {
  const path = resolve(file);
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (error) {
    throw new ContrarregraError('E_CONFIG', `--voice: não consegui ler ${path} (${(error as NodeJS.ErrnoException).code ?? String(error)})`, { file: path });
  }
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    throw new ContrarregraError('E_CONFIG', `--voice: JSON inválido em ${path}: ${(error as Error).message}`, { file: path });
  }
  const checked = validate(VoiceFileSchema, value);
  if (!checked.ok) {
    const summary = checked.errors.map((e) => `${e.path === '' ? '(raiz)' : e.path}: ${e.message}`).join('; ');
    throw new ContrarregraError('E_CONFIG', `--voice: ${path} fora do formato {gapMs?, scenes: {sNN: [{text, durMs}]}} — ${summary}`, {
      file: path,
      errors: checked.errors,
    });
  }
  const scenes: Record<string, VoiceSentence[]> = {};
  for (const [id, sentences] of Object.entries(checked.value.scenes)) scenes[id] = sentences.map((s) => ({ text: s.text, durMs: s.durMs }));
  return { path, sha256: createHash('sha256').update(bytes).digest('hex'), gapMs: checked.value.gapMs ?? DEFAULT_GAP_MS, scenes };
}

/** Duração da narração da cena: `Σ durMs + (n − 1) × gapMs` (0 sem frases). */
export function narrationMs(plan: VoicePlan, sceneId: string): number {
  const sentences = plan.scenes[sceneId] ?? [];
  if (sentences.length === 0) return 0;
  return sentences.reduce((sum, s) => sum + s.durMs, 0) + (sentences.length - 1) * plan.gapMs;
}

/** Início da frase `cue` relativo ao fim do `padBeforeMs` da cena; `undefined` se a cena não tem essa frase. */
export function cueOffsetMs(plan: VoicePlan, sceneId: string, cue: number): number | undefined {
  const sentences = plan.scenes[sceneId] ?? [];
  if (!Number.isInteger(cue) || cue < 0 || cue >= sentences.length) return undefined;
  let offset = 0;
  for (let i = 0; i < cue; i++) offset += sentences[i]!.durMs + plan.gapMs;
  return offset;
}

/** Diferenças entre o plano e a coreografia que não impedem a tomada (cena sem narração, contagem de frases). */
export function voiceWarnings(plan: VoicePlan, doc: Choreography): string[] {
  const warnings: string[] = [];
  const ids = new Set(doc.scenes.map((s) => s.id));
  for (const id of Object.keys(plan.scenes)) if (!ids.has(id)) warnings.push(`--voice: a cena ${id} não existe na coreografia`);
  for (const scene of doc.scenes) {
    const sentences = plan.scenes[scene.id];
    if (sentences === undefined) {
      if ((scene.line?.length ?? 0) > 0) warnings.push(`--voice: sem narração para ${scene.id} (cue ignorado; duração mínima sem a fala)`);
      continue;
    }
    if (scene.line !== undefined && scene.line.length !== sentences.length) {
      warnings.push(`--voice: ${scene.id} tem ${sentences.length} frase(s) no plano e ${scene.line.length} em line`);
    }
  }
  return warnings;
}
