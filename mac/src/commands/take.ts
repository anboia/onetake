// Operações `take validate|run|control` (trilha do demo; S8: CLI `take run`, aqui sem supervisor destacado
// nem `take_*` no MCP). A lógica está em `mac/src/take`: a coreografia (`choreo.ts`), o executor passo a
// passo (`executor.ts`), a gravação no OBS (`obs.ts`) e a orquestração (`run.ts`).

import { realpathSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';

import { ContrarregraError } from '../core/errors.ts';
import { readTakeLock } from '../runner/session.ts';
import { runnerPaths } from '../runner/paths.ts';
import { validateTakeFile, type TakeValidation } from '../take/choreo.ts';
import { isControlOp, writeControl, type ControlOp, CONTROL_OPS } from '../take/control.ts';
import { readTakeRecord } from '../take/manifest.ts';
import { runTake, type TakeRunDeps, type TakeRunOptions, type TakeSummary } from '../take/run.ts';
import type { CommandContext } from './context.ts';

export { CONTROL_OPS, type ControlOp, type TakeRunDeps, type TakeRunOptions, type TakeSummary, type TakeValidation };

/** `take validate <coreografia>`: `{ok, errors: [{path, rule, message}], warnings, scenes, steps}`, sem lançar. */
export function takeValidate(file: string): TakeValidation {
  return validateTakeFile(file);
}

/** `take run <coreografia> [...]`: a tomada inteira; volta o resumo (o detalhe fica em `take.json`). */
export function takeRun(ctx: CommandContext, options: TakeRunOptions, deps: TakeRunDeps = {}): Promise<TakeSummary> {
  return runTake(ctx.config, options, deps, ctx.onProgress ?? (() => {}));
}

export interface TakeControlResult {
  takeId: string;
  dir: string;
  op: ControlOp;
  file: string;
  /** O passo em que a tomada está pausada (`null` se não está: só `abort` vale então). */
  pausedAt: string | null;
}

/**
 * `take control <takeDir> resume|retry|skip|abort`: grava `control.json` para a tomada em curso. Pasta que não
 * é `<paths.takes>/<app>/<takeId>` (caminho real), tomada terminada, sem trava viva dela, ou
 * `resume|retry|skip` sem pausa → `E_CHOREO_STATE` e nada é gravado.
 */
export function takeControl(ctx: CommandContext, dir: string, op: string): TakeControlResult {
  if (!isControlOp(op)) throw new ContrarregraError('E_CHOREO_STATE', `comando "${op}" desconhecido: use ${CONTROL_OPS.join(', ')}`, { op });
  const takeDir = resolve(dir);
  const paths = runnerPaths(ctx.config);
  const record = readTakeRecord(takeDir);
  // A pasta tem de ser `<paths.takes>/<app>/<takeId>` desta tomada (caminho real, sem atalhos nem cópias).
  let real: string;
  let takesRoot: string;
  try {
    real = realpathSync(takeDir);
    takesRoot = realpathSync(paths.takes);
  } catch {
    throw new ContrarregraError('E_CHOREO_STATE', `${takeDir} não é uma pasta de tomada em ${paths.takes}; nada foi enviado`, { dir: takeDir });
  }
  if (basename(real) !== record.takeId || dirname(dirname(real)) !== takesRoot) {
    throw new ContrarregraError('E_CHOREO_STATE', `${takeDir} não é <paths.takes>/<app>/${record.takeId} (${paths.takes}); nada foi enviado`, {
      dir: takeDir,
      takeId: record.takeId,
      takes: paths.takes,
    });
  }
  if (record.status === 'finished' || record.status === 'aborted' || record.status === 'failed') {
    throw new ContrarregraError('E_CHOREO_STATE', `a tomada ${record.takeId} já terminou (${record.status}); nada foi enviado`, { takeId: record.takeId, status: record.status });
  }
  const lockTakeId = readTakeLock(paths);
  if (lockTakeId !== record.takeId) {
    throw new ContrarregraError('E_CHOREO_STATE', `a tomada ${record.takeId} não está rodando (a trava do aparelho é ${lockTakeId === undefined ? 'de ninguém' : `de ${lockTakeId}`}); nada foi enviado`, {
      takeId: record.takeId,
      lockTakeId: lockTakeId ?? null,
    });
  }
  if (op !== 'abort' && record.pause === null) {
    throw new ContrarregraError('E_CHOREO_STATE', `a tomada ${record.takeId} não está pausada: só abort vale agora`, { takeId: record.takeId, op });
  }
  const file = writeControl(takeDir, op);
  return { takeId: record.takeId, dir: takeDir, op, file, pausedAt: record.pause?.step ?? null };
}
