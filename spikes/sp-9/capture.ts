// A gravação em volta de cada troca do SP-9 (o `Capture` de `driver.ts`) com o OBS de verdade: HC-11 antes, marcas
// pelo `GetRecordStatus.outputDuration`, parada, recortes e medidas (`media.ts`) e a gravação APAGADA logo depois de
// medida — também quando a troca falha (G4: só arquivos que este spike criou na pasta dele, conferidos por nome,
// inode e criação). Os recortes PNG ficam na pasta até o fim da execução (`cleanupFiles`). Código de spike.

import { realpathSync, rmdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import type { Ffmpeg } from '../../mac/src/media/ffmpeg.ts';
import type { OcrImage } from '../../mac/src/media/ocr.ts';
import type { Capture, CaptureOutcome, MarkName, MeasureContext } from './driver.ts';
import { pendingFiles, type Json } from './lib.ts';
import { measureVisual, probeOk, type Mark } from './media.ts';
import { discard, errCode, startRecording, type Obs, type Recording } from './obs.ts';

export interface CaptureOptions {
  obs: Obs;
  ff: Ffmpeg;
  /** Pasta do spike (já criada; caminho real; é a pasta de gravação do OBS). */
  dir: string;
  maxS: number;
  bitrateKbps: number;
  minFreeGiB: number;
  criticalGiB: number;
  freeBytes(dir: string): Promise<number>;
  ocr(paths: string[]): Promise<OcrImage[]>;
  now(): number;
  sleep(ms: number): Promise<void>;
  log(k: string, data?: Json): void;
  /** Livro de arquivos (G4): cada arquivo criado e apagado. */
  ledger(row: Json): void;
  pollMs?: number;
}

export class ObsCapture implements Capture {
  readonly #o: CaptureOptions;

  constructor(options: CaptureOptions) {
    this.#o = options;
  }

  async around<T>(tag: string, body: (mark: (name: MarkName) => Promise<void>) => Promise<T>, context: () => MeasureContext): Promise<CaptureOutcome<T>> {
    const o = this.#o;
    const active = await startRecording(o.obs, { dir: o.dir, maxS: o.maxS, bitrateKbps: o.bitrateKbps, minFreeGiB: o.minFreeGiB, criticalGiB: o.criticalGiB, pollMs: o.pollMs }, {
      freeBytes: o.freeBytes,
      probeOk: (file) => probeOk(o.ff, file),
      now: o.now,
      sleep: o.sleep,
      log: o.log,
    });
    const marks: Partial<Record<MarkName, Mark>> = {};
    let value: T | undefined;
    let bodyError: unknown;
    let failed = false;
    try {
      value = await body(async (name) => {
        try {
          const m = await active.mark();
          if (m !== null) marks[name] = { rS: m.ms / 1000, atMs: m.at };
          o.log('mark', { tag, name, ...(m === null ? { stopped: true } : { ms: m.ms }) });
        } catch (error) {
          o.log('mark', { tag, name, err: errCode(error) });
        }
      });
    } catch (error) {
      bodyError = error;
      failed = true;
    }
    let recording: Recording;
    try {
      recording = await active.stop();
    } catch (error) {
      const own = (error as { file?: { realPath: string; ino: number; birthtimeMs: number } }).file;
      if (own !== undefined) this.#drop({ file: own.realPath, name: own.realPath.slice(own.realPath.lastIndexOf('/') + 1), ino: own.ino, birthtimeMs: own.birthtimeMs, sizeBytes: 0 });
      if (failed) throw bodyError;
      throw error;
    }
    o.ledger({ event: 'created', kind: 'recording', name: recording.name, bytes: recording.sizeBytes, ino: recording.ino, autoStopped: recording.autoStopped, disk: { freeGiB: gib(recording.disk.freeBytes), requiredGiB: gib(recording.disk.requiredBytes), estimateGiB: gib(recording.disk.estimateBytes) } });
    let visual: CaptureOutcome<T>['visual'] = null;
    let visualErr: string | undefined;
    try {
      if (!failed) {
        visual = await measureVisual(
          {
            ff: o.ff,
            dir: o.dir,
            ocr: o.ocr,
            created: (f) => o.ledger({ event: 'created', kind: f.kind, name: f.name, bytes: f.bytes, ino: f.ino }),
          },
          recording.file,
          marks,
          context(),
        );
      }
    } catch (error) {
      visualErr = errCode(error);
      o.log('visual-error', { tag, err: visualErr });
    } finally {
      this.#drop(recording);
    }
    if (failed) throw bodyError;
    return { value: value as T, visual, ...(visualErr === undefined ? {} : { visualErr }), recording: { name: recording.name, bytes: recording.sizeBytes } };
  }

  #drop(recording: Pick<Recording, 'file' | 'name' | 'ino' | 'birthtimeMs' | 'sizeBytes'>): void {
    const gone = discard(recording, this.#o.dir);
    this.#o.ledger({ event: 'deleted', kind: 'recording', name: gone.name, bytes: gone.bytes });
  }
}

function gib(bytes: number): number {
  return Math.round((bytes / 1024 ** 3) * 100) / 100;
}

/**
 * Apaga os arquivos que o livro diz criados e não apagados (G4: recortes e, depois de uma queda, uma gravação que
 * sobrou): cada um conferido por estar direto na pasta, com o mesmo nome e o mesmo inode; depois remove a pasta do
 * rótulo se ficou vazia (`rmdir`, nunca recursivo). Devolve o que apagou e o que recusou.
 */
export function cleanupFiles(ledgerRows: readonly Json[], dir: string, ledger: (row: Json) => void): { deleted: string[]; refused: string[]; dirRemoved: boolean } {
  const deleted: string[] = [];
  const refused: string[] = [];
  for (const f of pendingFiles(ledgerRows)) {
    if (f.kind !== 'crop' && f.kind !== 'recording') {
      refused.push(`${f.name} (${f.kind}: tipo desconhecido)`);
      continue;
    }
    try {
      const gone = discard({ file: join(dir, f.name), name: f.name, ino: f.ino }, dir);
      ledger({ event: 'deleted', kind: f.kind, name: gone.name, bytes: gone.bytes });
      deleted.push(gone.name);
    } catch (error) {
      refused.push(`${f.name}: ${errCode(error)}`);
    }
  }
  let dirRemoved = false;
  try {
    const real = realpathSync(dir);
    if (statSync(real).isDirectory()) {
      rmdirSync(real);
      dirRemoved = true;
      ledger({ event: 'deleted', kind: 'dir', name: real });
    }
  } catch {
    dirRemoved = false;
  }
  return { deleted, refused, dirRemoved };
}
