// Pasta e registro da tomada da trilha do demo (S0.8 simplificado; spec/tasks.md "Trilha do demo": sem
// `events.json`/`sync.json`/`.srt`). Pasta `<paths.takes>/<app>/<takeId>/`, com `<app>` = nome da pasta da
// coreografia e `takeId = YYYYMMDD-HHMMSS-<nome do arquivo sem .choreo.yaml>` (hora local, S0.8).
//
// `take.json` é regravado a cada passo (arquivo novo + rename) e é o que a pós-produção usa para encaixar a
// narração: a coreografia (caminho + SHA-256 do arquivo), o modo, a gravação (arquivo, início, fim), as
// cenas (início no Mac; início e fim no vídeo em ms, de `GetRecordStatus.outputDuration`) e os passos (cena,
// índice, id, do, status, tempos no Mac, tempo do vídeo no início, cue, erro). O esquema é próprio
// (`contrarregra.demo-take/1`), não o `TakeManifest` de S0.8, que exige o que esta trilha não produz.

import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { ContrarregraError } from '../core/errors.ts';

export const TAKE_RECORD_SCHEMA = 'contrarregra.demo-take/1';
export const TAKE_FILE = 'take.json';

export type TakeMode = 'take' | 'dry';
export type TakeStatus = 'preparing' | 'recording' | 'finished' | 'aborted' | 'failed';
export type TakeSection = 'prepare' | 'scenes' | 'cleanup';
/** `running` só enquanto o passo roda (ou se o processo morreu no meio dele). */
export type StepStatus = 'running' | 'ok' | 'skipped' | 'failed';

export interface SceneRecord {
  id: string;
  title: string;
  /** Início da cena no Mac (ISO e epoch ms). */
  startedAt: string;
  startMs: number;
  endedAt?: string;
  endMs?: number;
  /** Tempo do vídeo (ms, `GetRecordStatus.outputDuration`) no início e no fim da cena; `null` sem gravação. */
  videoStartMs: number | null;
  videoEndMs?: number | null;
  padBeforeMs: number;
  padAfterMs: number;
  /** Narração da cena pelo `--voice` (0 sem ele). */
  narrationMs: number;
  /** `padBeforeMs + narrationMs + padAfterMs`: a cena dura pelo menos isto. */
  minDurationMs: number;
  /** A cena parou antes do fim (`--until`, abort). */
  truncated?: boolean;
  /** Tempo do Mac com a gravação pausada dentro da cena (`--pause-recording-at`; fora do vídeo e da duração mínima). */
  pausedMs?: number;
}

export interface StepRecord {
  section: TakeSection;
  /** Id da cena; `null` em `prepare`/`cleanup`. */
  sceneId: string | null;
  /** Posição do passo na lista da seção ou da cena (1-based); aninhados em `block`/`checkpoint`: `"4.2"`. */
  index: string;
  id?: string;
  do: string;
  caption?: string;
  status: StepStatus;
  startedAt: string;
  startMs: number;
  endMs?: number;
  durationMs?: number;
  /** Tempo do vídeo (ms) no início do passo; `null` sem gravação. */
  videoMs: number | null;
  cue?: number;
  /** Início planejado da frase `cue`, relativo ao início da cena (ms). */
  cueAtMs?: number;
  /** Ponto de controle: tempo esperando `until` e quantos avisos falados. */
  waitedMs?: number;
  alerts?: number;
  /** Execuções do passo (1 = sem nova tentativa). */
  attempts: number;
  /** A ação estourou o prazo do runner rodando (`E_TIMEOUT` com `phase: running`) e foi confirmada depois. */
  late?: boolean;
  /** Comandos do dono durante pausas deste passo (`take control`). */
  interventions?: string[];
  error?: { code: string | null; message: string };
}

/**
 * Uma pausa da gravação (`--pause-recording-at`): o trecho não existe no vídeo. `videoBeforeMs` /
 * `videoAfterMs` = `GetRecordStatus.outputDuration` antes do `PauseRecord` e depois do `ResumeRecord` (ficam
 * quase iguais: o tempo pausado não entra no arquivo); `durationMs` = tempo do Mac com a gravação pausada.
 */
export interface RecordingPause {
  /** O `checkpoint` que pausou. */
  stepId: string;
  sceneId: string | null;
  pausedAt: string;
  pausedAtMs: number;
  resumedAt?: string;
  resumedAtMs?: number;
  durationMs?: number;
  videoBeforeMs: number | null;
  videoAfterMs: number | null;
  /** `resume` = retomada depois do ponto de controle; `stop` = a tomada parou com a gravação pausada. */
  endedBy?: 'resume' | 'stop';
  /** `--dry`: nada foi pausado, só registrado onde pausaria. */
  simulated?: boolean;
}

export interface RecordingInfo {
  /** O arquivo final na pasta da tomada (renomeado para `recording.mp4` quando possível). */
  file: string | null;
  /** O nome que o OBS deu (antes do rename). */
  obsFile?: string;
  startedAt: string;
  startedAtMs: number;
  stoppedAt?: string;
  stoppedAtMs?: number;
  sizeBytes?: number;
  finalizeMs?: number;
  /** A pasta de gravação do OBS antes da tomada, e se foi devolvida. */
  previousDirectory: string;
  directoryRestored?: boolean;
}

export interface TakeRecord {
  schema: typeof TAKE_RECORD_SCHEMA;
  takeId: string;
  mode: TakeMode;
  status: TakeStatus;
  /** Por que a tomada não terminou `finished` (`SIGINT`, `control-abort`, `pause-timeout`, `step-failed`, código do erro…). */
  cause?: string;
  error?: { code: string | null; message: string };
  pid: number;
  choreography: { path: string; sha256: string };
  app: { bundleId: string; expectVersion: string };
  options: {
    scenes: string[] | null;
    from: string | null;
    until: string | null;
    voice: { path: string; sha256: string; gapMs: number } | null;
    pauseRecordingAt: string[];
    prepare: boolean;
    cleanup: boolean;
  };
  startedAt: string;
  endedAt?: string;
  disk?: { freeBytes: number; requiredBytes: number; estimateMs: number };
  recording: RecordingInfo | null;
  scenesStartedAt?: string;
  /** Pausas da gravação (`--pause-recording-at`), em ordem. */
  recordingPauses: RecordingPause[];
  /** A `cleanup` não rodou (tomada abortada ou falha depois do começo das cenas). */
  cleanupPending: boolean;
  /** O modo avião pode ter ficado ligado quando a tomada parou (S4 item 6). */
  airplaneLeftOn?: boolean;
  /** A tomada está parada esperando `take control` (`null` fora de pausa). */
  pause: { at: string; step: string; stepId: string | null; reason: string } | null;
  scenes: SceneRecord[];
  steps: StepRecord[];
  warnings: string[];
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** Nome da coreografia: o arquivo sem `.choreo.yaml` (ou `.yaml`/`.yml`). */
export function choreographyName(path: string): string {
  const name = basename(path);
  for (const suffix of ['.choreo.yaml', '.choreo.yml', '.yaml', '.yml']) {
    if (name.endsWith(suffix) && name.length > suffix.length) return name.slice(0, -suffix.length);
  }
  return name;
}

/** `<app>` da pasta da tomada: o nome da pasta onde está a coreografia (`choreographies/<app>/`). */
export function appDirName(path: string): string {
  return basename(dirname(path));
}

/** `YYYYMMDD-HHMMSS-<coreografia>` em hora local (S0.8). */
export function newTakeId(name: string, now: Date): string {
  const date = `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}`;
  const time = `${pad2(now.getHours())}${pad2(now.getMinutes())}${pad2(now.getSeconds())}`;
  return `${date}-${time}-${name}`;
}

export function takeRecordPath(dir: string): string {
  return join(dir, TAKE_FILE);
}

/** Grava `take.json` inteiro (arquivo novo + rename: quem lê nunca vê meio arquivo). */
export function writeTakeRecord(dir: string, record: TakeRecord): void {
  const path = takeRecordPath(dir);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`);
  renameSync(tmp, path);
}

/** Lê `take.json`; ausente ou de outro formato → `E_CHOREO_STATE` (não é uma pasta de tomada desta trilha). */
export function readTakeRecord(dir: string): TakeRecord {
  const path = takeRecordPath(dir);
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new ContrarregraError('E_CHOREO_STATE', `não há take.json legível em ${dir} (${(error as NodeJS.ErrnoException).code ?? (error as Error).message})`, { dir });
  }
  if (typeof value !== 'object' || value === null || (value as Record<string, unknown>)['schema'] !== TAKE_RECORD_SCHEMA) {
    throw new ContrarregraError('E_CHOREO_STATE', `${path} não é um registro de tomada (${TAKE_RECORD_SCHEMA})`, { dir });
  }
  return value as TakeRecord;
}
