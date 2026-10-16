// Sessão do runner no Mac (S2 itens 1, 3 e 7; P-3). Uma sessão = um `xcodebuild test-without-building`
// destacado + o `.xctestrun` dela (0600, com o token, em `paths.cache/sessions/`) + um arquivo de estado
// (`<sessionId>.json`, sem o token) com os pids e caminhos. O token mora **só** no `.xctestrun`: quem
// precisa dele (o `session.hello`) o lê de lá, num `Secret`. "Caído" = o `xcodebuild` da sessão não
// existe mais (S2 item 7); nada religa sozinho.

import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, chmodSync, closeSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeSync } from 'node:fs';
import { basename, join } from 'node:path';

import { ContrarregraError } from '../core/errors.ts';
import { Secret } from '../core/secret.ts';
import { RUNNER_UP_HINT } from '../usbmux/client.ts';
import type { RunnerPaths } from './paths.ts';
import { parseXctestrun, xctestrunEnv } from './xctestrun.ts';

export { RUNNER_UP_HINT };
export const SESSION_SCHEMA = 'contrarregra.session/1';
const PS_PATH = '/bin/ps';
/**
 * Um `.xctestrun`/estado sem sessão viva mais novo que isto é de um `runner up` concorrente no meio da
 * escrita (o `.xctestrun` nasce milissegundos antes do estado): a varredura da subida não o apaga.
 */
export const ORPHAN_GRACE_MS = 30_000;

export interface SessionState {
  schema: typeof SESSION_SCHEMA;
  sessionId: string;
  udid: string;
  /** `runner.port` com que a sessão subiu (`CONTRARREGRA_PORT`). */
  port: number;
  /** `Debug` ou `Spike`. */
  configuration: string;
  spike: boolean;
  /** `CONTRARREGRA_BIND` (só no `Spike`). */
  bind?: string;
  /** O `.xctestrun` da sessão (0600). */
  xctestrun: string;
  /** Saída padrão e de erro do `xcodebuild` (arquivo, nunca pipe). */
  log: string;
  xcodebuildPid: number;
  caffeinatePid?: number;
  startedAt: string;
  /** Quando o Mac viu o `xcodebuild` morto (S2 item 7). */
  downAt?: string;
}

/** `YYYYMMDD-HHMMSS-<6 hex>` (hora local, como o `takeId` de S0.8). */
export function newSessionId(now = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${date}-${time}-${randomBytes(3).toString('hex')}`;
}

/** Token de sessão novo a cada subida (P-3): 256 bits em base64url. */
export function newSessionToken(): Secret {
  return new Secret(randomBytes(32).toString('base64url'));
}

export function ensureSessionsDir(paths: RunnerPaths): void {
  mkdirSync(paths.sessions, { recursive: true, mode: 0o700 });
  chmodSync(paths.sessions, 0o700);
}

/** Cria o arquivo já com 0600 (nunca existe legível por outros, nem por um instante) e falha se já existir. */
export function writePrivateFile(path: string, content: string): void {
  const fd = openSync(path, 'wx', 0o600);
  try {
    writeSync(fd, content);
  } finally {
    closeSync(fd);
  }
  chmodSync(path, 0o600);
}

export function sessionXctestrunPath(paths: RunnerPaths, sessionId: string): string {
  return join(paths.sessions, `${sessionId}.xctestrun`);
}

function statePath(paths: RunnerPaths, sessionId: string): string {
  return join(paths.sessions, `${sessionId}.json`);
}

export function writeSessionState(paths: RunnerPaths, state: SessionState): void {
  const path = statePath(paths, state.sessionId);
  rmSync(path, { force: true });
  writePrivateFile(path, `${JSON.stringify(state, null, 2)}\n`);
}

function isSessionState(value: unknown): value is SessionState {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v['schema'] === SESSION_SCHEMA &&
    typeof v['sessionId'] === 'string' &&
    typeof v['xctestrun'] === 'string' &&
    typeof v['xcodebuildPid'] === 'number' &&
    typeof v['port'] === 'number' &&
    typeof v['startedAt'] === 'string'
  );
}

/** Os estados de sessão na pasta, do mais novo para o mais velho; arquivos ilegíveis são ignorados. */
export function readSessionStates(paths: RunnerPaths): SessionState[] {
  let names: string[];
  try {
    names = readdirSync(paths.sessions);
  } catch {
    return [];
  }
  const states: SessionState[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const value: unknown = JSON.parse(readFileSync(join(paths.sessions, name), 'utf8'));
      if (isSessionState(value)) states.push(value);
    } catch {
      // ilegível: sobra que a próxima subida apaga
    }
  }
  return states.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

/** A sessão mais recente (viva ou não). */
export function currentSession(paths: RunnerPaths): SessionState | undefined {
  return readSessionStates(paths)[0];
}

/** Apaga o `.xctestrun` e o estado de uma sessão só (o caminho de falha da própria subida). */
export function deleteSessionFilesFor(paths: RunnerPaths, sessionId: string): string[] {
  const deleted: string[] = [];
  for (const path of [sessionXctestrunPath(paths, sessionId), statePath(paths, sessionId)]) {
    try {
      rmSync(path);
      deleted.push(path);
    } catch {
      // já não existia
    }
  }
  return deleted;
}

/**
 * A limpeza da subida (S2 item 1: "apaga `.xctestrun` de sessões velhas"): os arquivos de toda sessão cujo
 * `xcodebuild` não vive mais, e as sobras sem estado mais velhas que `graceMs`. Nunca toca numa sessão viva
 * nem numa sobra recém-criada (outra subida em curso). Devolve os caminhos apagados.
 */
export function sweepSessionFiles(paths: RunnerPaths, graceMs = ORPHAN_GRACE_MS, now = Date.now()): string[] {
  let names: string[];
  try {
    names = readdirSync(paths.sessions);
  } catch {
    return [];
  }
  const owner = new Map<string, SessionState>();
  for (const state of readSessionStates(paths)) {
    owner.set(`${state.sessionId}.json`, state);
    owner.set(`${state.sessionId}.xctestrun`, state);
    if (state.xctestrun.startsWith(`${paths.sessions}/`)) owner.set(basename(state.xctestrun), state);
  }
  const alive = new Map<SessionState, boolean>();
  const deleted: string[] = [];
  for (const name of names.sort()) {
    if (!name.endsWith('.xctestrun') && !name.endsWith('.json')) continue;
    const path = join(paths.sessions, name);
    const state = owner.get(name);
    if (state !== undefined) {
      if (!alive.has(state)) alive.set(state, sessionAlive(state));
      if (alive.get(state)) continue;
    } else {
      let mtimeMs: number;
      try {
        mtimeMs = statSync(path).mtimeMs;
      } catch {
        continue;
      }
      if (now - mtimeMs < graceMs) continue;
    }
    rmSync(path, { force: true });
    deleted.push(path);
  }
  return deleted;
}

/**
 * Apaga todo `.xctestrun` e todo estado de sessão da pasta (`runner down`, AC-2.9). Devolve os caminhos
 * apagados.
 */
export function deleteSessionFiles(paths: RunnerPaths): string[] {
  let names: string[];
  try {
    names = readdirSync(paths.sessions);
  } catch {
    return [];
  }
  const deleted: string[] = [];
  for (const name of names.sort()) {
    if (!name.endsWith('.xctestrun') && !name.endsWith('.json')) continue;
    const path = join(paths.sessions, name);
    rmSync(path, { force: true });
    deleted.push(path);
  }
  return deleted;
}

/**
 * O processo existe e a linha de comando dele contém `mustContain` (guarda contra pid reaproveitado:
 * o do `xcodebuild` da sessão tem o caminho do `.xctestrun` dela).
 */
export function processAlive(pid: number | undefined, mustContain?: string): boolean {
  if (pid === undefined || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EPERM') return false;
  }
  if (mustContain === undefined) return true;
  const ps = spawnSync(PS_PATH, ['-ww', '-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
  return ps.status === 0 && ps.stdout.includes(mustContain);
}

/** O `xcodebuild` da sessão está vivo (S2 item 7). */
export function sessionAlive(state: SessionState): boolean {
  return processAlive(state.xcodebuildPid, state.xctestrun);
}

/** Lê o token do `.xctestrun` da sessão. Sem o arquivo ou sem o token → `E_RUNNER_DOWN`. */
export function readSessionToken(state: SessionState): Secret {
  let token: string | undefined;
  try {
    token = xctestrunEnv(parseXctestrun(readFileSync(state.xctestrun, 'utf8')))['CONTRARREGRA_TOKEN'];
  } catch {
    token = undefined;
  }
  if (token === undefined || token === '') {
    throw new ContrarregraError('E_RUNNER_DOWN', `a sessão ${state.sessionId} não tem mais o .xctestrun com o token: rode \`${RUNNER_UP_HINT}\``, {
      reason: 'no-session',
      sessionId: state.sessionId,
      hint: RUNNER_UP_HINT,
    });
  }
  return new Secret(token);
}

/** Registro de uma linha em `paths.cache/logs/runner.log` (nunca com o token). */
export function logRunner(paths: RunnerPaths, line: string): void {
  try {
    mkdirSync(paths.logs, { recursive: true });
    appendFileSync(join(paths.logs, 'runner.log'), `${new Date().toISOString()} ${line}\n`);
  } catch {
    // o registro nunca derruba o comando
  }
}

/** Marca a sessão como caída (uma vez) e registra (S2 item 7). */
export function markSessionDown(paths: RunnerPaths, state: SessionState): SessionState {
  if (state.downAt !== undefined) return state;
  const marked = { ...state, downAt: new Date().toISOString() };
  try {
    writeSessionState(paths, marked);
  } catch {
    // a pasta pode ter sido apagada por um `runner down` em paralelo
  }
  logRunner(paths, `runner caído: o xcodebuild ${state.xcodebuildPid} da sessão ${state.sessionId} não existe mais (log: ${state.log})`);
  return marked;
}

/**
 * O `takeId` da trava do aparelho (`paths.cache/locks/<udid>.lock`, S2 item 3), ou `undefined` sem
 * trava. O conteúdo é o `takeId` (texto) ou um objeto JSON com `takeId` (e `pid`). Trava com `pid` cujo
 * processo não vive — ou não é a tomada: a linha de comando não tem o `takeId` (pid reaproveitado) — é
 * sobra de uma tomada que morreu e conta como ausente.
 */
export function readTakeLock(paths: RunnerPaths): string | undefined {
  let text: string;
  try {
    text = readFileSync(paths.lockFile, 'utf8').trim();
  } catch {
    return undefined;
  }
  if (text.startsWith('{')) {
    try {
      const value: unknown = JSON.parse(text);
      const fields = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
      const takeId = typeof fields['takeId'] === 'string' && fields['takeId'] !== '' ? fields['takeId'] : undefined;
      const pid = fields['pid'];
      if (typeof pid === 'number' && !processAlive(pid, takeId)) return undefined;
      if (takeId !== undefined) return takeId;
    } catch {
      // cai no texto cru
    }
  }
  return text === '' ? 'unknown' : text;
}

/** `E_BUSY` com o `takeId` quando uma tomada segura o aparelho (S2 item 3; `runner up|down`, exploração). */
export function assertNoTake(paths: RunnerPaths, what: string): void {
  const takeId = readTakeLock(paths);
  if (takeId !== undefined) {
    throw new ContrarregraError('E_BUSY', `${what} recusado: a tomada ${takeId} segura o aparelho`, { takeId });
  }
}
