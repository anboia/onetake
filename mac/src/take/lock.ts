// Trava do aparelho durante a tomada (S2 item 3): `paths.cache/locks/<udid>.lock`, o arquivo que
// `readTakeLock`/`assertNoTake` (runner/session.ts) já leem. Enquanto existe e o dono vive, todo outro
// controlador (CLI, MCP, `runner up|down`) recebe `E_BUSY` com o `takeId`; só a tomada, dona da trava, abre
// `control` (`openRunner {lockOwner: takeId}`). Conteúdo: `{takeId, pid, startedAt}`. Criada com O_EXCL.
// Sobra = o `pid` não existe mais OU a linha de comando dele não contém o `takeId` (pid reaproveitado; a
// tomada põe o `takeId` no `process.title`, que o `ps` mostra): é trocada de forma atômica (arquivo
// temporário + `rename`) e relida — se outra tomada a trocou no mesmo instante, `E_BUSY`. Trava sem `pid`
// (formato antigo, texto) nunca é sobra.

import { randomBytes } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from 'node:fs';

import { ContrarregraError } from '../core/errors.ts';
import type { RunnerPaths } from '../runner/paths.ts';
import { processAlive } from '../runner/session.ts';

export interface TakeLockInfo {
  takeId: string;
  pid: number;
  startedAt: string;
}

function readLock(path: string): Partial<TakeLockInfo> | undefined {
  let text: string;
  try {
    text = readFileSync(path, 'utf8').trim();
  } catch {
    return undefined;
  }
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value === 'object' && value !== null) return value as Partial<TakeLockInfo>;
  } catch {
    // texto cru: só o takeId
  }
  return { takeId: text === '' ? 'unknown' : text };
}

function createExclusive(path: string, info: TakeLockInfo): boolean {
  let fd: number;
  try {
    fd = openSync(path, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
  try {
    writeSync(fd, `${JSON.stringify(info)}\n`);
  } finally {
    closeSync(fd);
  }
  return true;
}

/** A trava é sobra: tem `pid` e esse processo não vive, ou não é a tomada (a linha de comando não tem o `takeId`). */
export function isStaleLock(held: Partial<TakeLockInfo> | undefined): boolean {
  if (held === undefined || typeof held.pid !== 'number') return false;
  return !processAlive(held.pid, typeof held.takeId === 'string' && held.takeId !== '' ? held.takeId : undefined);
}

/**
 * Cria a trava da tomada. Devolve a trava velha que foi trocada (sobra), se houver. Outra tomada viva →
 * `E_BUSY` com o `takeId` dela.
 */
export function acquireTakeLock(paths: RunnerPaths, takeId: string, startedAt: Date = new Date(), pid: number = process.pid): { replaced?: Partial<TakeLockInfo> } {
  mkdirSync(paths.locks, { recursive: true });
  const info: TakeLockInfo = { takeId, pid, startedAt: startedAt.toISOString() };
  if (createExclusive(paths.lockFile, info)) return {};
  const held = readLock(paths.lockFile);
  if (isStaleLock(held)) {
    const tmp = `${paths.lockFile}.${pid}.${randomBytes(4).toString('hex')}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(info)}\n`, { mode: 0o600 });
    renameSync(tmp, paths.lockFile);
    if (readLock(paths.lockFile)?.takeId === takeId) return { replaced: held! };
  }
  const heldBy = readLock(paths.lockFile)?.takeId ?? 'unknown';
  throw new ContrarregraError('E_BUSY', `a tomada ${heldBy} segura o aparelho (${paths.lockFile}); espere ela terminar`, {
    takeId: heldBy,
    lockFile: paths.lockFile,
    hint: `se nenhuma tomada está rodando, a trava é sobra: confira o pid dela em ${paths.lockFile}`,
  });
}

/** Solta a trava, só se ainda for desta tomada. Devolve se apagou. */
export function releaseTakeLock(paths: RunnerPaths, takeId: string): boolean {
  const held = readLock(paths.lockFile);
  if (held?.takeId !== takeId) return false;
  rmSync(paths.lockFile, { force: true });
  return true;
}
