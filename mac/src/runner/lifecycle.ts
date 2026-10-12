// `runner build|up|down|status|sever` (S2 itens 1, 3, 7 e 8; deploy.md D3.3).
//
// - build: `xcodegen generate` + `xcodebuild build-for-testing` (time fixo, assinatura automática), saída
//   em arquivo; devolve o `.xctestrun` gerado da configuração (`Debug` ou `Spike`).
// - up: recusa durante tomada (`E_BUSY`), exige o cabo (`E_NO_USB` em ≤ 1 s), para a sessão viva que
//   houver, apaga `.xctestrun` de sessões velhas, escreve o da sessão (0600, com as variáveis de S1 e as
//   capturas do XCTest desligadas), sobe o `xcodebuild test-without-building` destacado com saída em
//   arquivo e `caffeinate -dimsu -w <pid>`, e espera o runner responder `session.hello` (⚠️ 120 s, E-2.4).
// - down: recusa durante tomada; `runner.shutdown` se o runner responder, senão SIGTERM/SIGKILL no
//   `xcodebuild`; apaga o `.xctestrun` e o estado da sessão (AC-2.9).
// - status: `{state: down|starting|up, pid, sessionId, transport, rttMs, uptimeS, controlHeldBy?}`.
// - sever: acha o dono de `control` (o supervisor pela trava, ou este processo fora de tomada) e lhe
//   pede o corte por `sever.json {forS}` + `SIGUSR1`.

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

import type { Config } from '../core/config.ts';
import { ContrarregraError, isContrarregraError } from '../core/errors.ts';
import type { HealthResult } from '../core/types.ts';
import { readDeviceTransport } from '../device/devicectl.ts';
import { findUsbDevice } from '../usbmux/client.ts';
import { encodePlist } from '../usbmux/plist.ts';
import { openRunner, withRunner, type RunnerConnection } from './client.ts';
import { severLocalLinks, SEVER_FILE } from './link.ts';
import { REPO_ROOT, runnerPaths, type RunnerPaths } from './paths.ts';
import {
  assertNoTake,
  currentSession,
  deleteSessionFiles,
  deleteSessionFilesFor,
  ensureSessionsDir,
  logRunner,
  markSessionDown,
  newSessionId,
  newSessionToken,
  processAlive,
  readSessionStates,
  readTakeLock,
  RUNNER_UP_HINT,
  sessionAlive,
  sessionXctestrunPath,
  sweepSessionFiles,
  writePrivateFile,
  writeSessionState,
  SESSION_SCHEMA,
  type SessionState,
} from './session.ts';
import {
  buildForTestingArgs,
  caffeinateArgs,
  resolveTools,
  runToFile,
  spawnDetached,
  testWithoutBuildingArgs,
  xcodegenArgs,
  type RunResult,
  type RunnerTools,
} from './xcodebuild.ts';
import {
  BIND_ENV_KEY,
  DEFAULT_CONFIGURATION,
  findBuiltXctestrun,
  makeSessionXctestrun,
  SPIKE_CONFIGURATION,
  type BindMode,
} from './xctestrun.ts';

/** Espera do `session.hello` na subida (E-2.4: ⚠️ 120 s, o dono pode ter de digitar o código). */
export const READY_TIMEOUT_MS = 120_000;
export const READY_POLL_MS = 500;
/** Depois disso em `starting`, avisa no Mac sobre o código da automação (E-2.4). */
export const STARTING_NOTICE_MS = 5_000;
/** Depois do `runner.shutdown`, quanto esperar o `xcodebuild` sair sozinho. */
export const SHUTDOWN_GRACE_MS = 8_000;
/** Depois do SIGTERM, quanto esperar antes do SIGKILL. */
export const TERM_GRACE_MS = 5_000;
/** Amostras de ida e volta no `runner status`. */
export const STATUS_SAMPLES = 10;

export const CONFIGURATIONS = [DEFAULT_CONFIGURATION, SPIKE_CONFIGURATION] as const;

export interface LifecycleOptions {
  tools?: Partial<RunnerTools>;
  /** Linhas de andamento para o dono (a CLI as manda para a saída de erro). */
  onProgress?: (line: string) => void;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stamp(now = new Date()): string {
  return now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

// ── build ──────────────────────────────────────────────────────────────────────────────────────────

export interface BuildOptions extends LifecycleOptions {
  /** `Debug` (padrão) ou `Spike`. */
  configuration?: string;
  repoRoot?: string;
}

export interface BuildResult {
  configuration: string;
  /** O `.xctestrun` gerado (sem token: o da sessão é uma cópia feita no `up`). */
  xctestrun: string;
  log: string;
  durationMs: number;
}

function buildFailed(step: string, result: RunResult, log: string): ContrarregraError {
  return new ContrarregraError('E_RUNNER_DOWN', `o ${step} falhou (saída ${result.exitCode ?? result.signal ?? 'desconhecida'}); veja ${log}`, {
    reason: 'build-failed',
    step,
    exitCode: result.exitCode,
    signal: result.signal,
    log,
  });
}

export async function buildRunner(config: Config, options: BuildOptions = {}): Promise<BuildResult> {
  const configuration = options.configuration ?? DEFAULT_CONFIGURATION;
  if (!(CONFIGURATIONS as readonly string[]).includes(configuration)) {
    throw new ContrarregraError('E_CONFIG', `configuração de build desconhecida: ${configuration} (use ${CONFIGURATIONS.join(' ou ')})`, { configuration });
  }
  const tools = resolveTools(options.tools);
  const paths = runnerPaths(config);
  const repoRoot = options.repoRoot ?? REPO_ROOT;
  const log = join(paths.logs, `runner-build-${stamp()}-${configuration}.log`);
  const started = performance.now();

  options.onProgress?.(`runner build: xcodegen generate (registro em ${log})`);
  const generated = await runToFile(tools.xcodegen, xcodegenArgs(repoRoot), log, { cwd: repoRoot });
  if (generated.exitCode !== 0) throw buildFailed('xcodegen generate', generated, log);

  options.onProgress?.(`runner build: xcodebuild build-for-testing (${configuration})`);
  const built = await runToFile(
    tools.xcodebuild,
    buildForTestingArgs({
      repoRoot,
      derivedData: paths.derivedData,
      team: config.signing.team,
      ...(configuration === DEFAULT_CONFIGURATION ? {} : { configuration }),
    }),
    log,
    { cwd: repoRoot },
  );
  if (built.exitCode !== 0) throw buildFailed('xcodebuild build-for-testing', built, log);

  const xctestrun = findBuiltXctestrun(paths.products, configuration);
  if (xctestrun === undefined) {
    throw new ContrarregraError('E_RUNNER_DOWN', `o build terminou sem um .xctestrun único da configuração ${configuration} em ${paths.products}`, {
      reason: 'no-build',
      configuration,
      products: paths.products,
      log,
    });
  }
  return { configuration, xctestrun: xctestrun.path, log, durationMs: Math.round(performance.now() - started) };
}

// ── parar uma sessão ───────────────────────────────────────────────────────────────────────────────

export type StopOutcome = 'already-exited' | 'shutdown' | 'SIGTERM' | 'SIGKILL';

interface StopOptions {
  /** Tenta `runner.shutdown` antes dos sinais. */
  tryShutdown: boolean;
  shutdownGraceMs?: number;
  termGraceMs?: number;
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal); // o `xcodebuild` é líder da própria sessão de processo (destacado)
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // já saiu
    }
  }
}

async function waitGone(state: SessionState, ms: number): Promise<boolean> {
  const deadline = performance.now() + ms;
  for (;;) {
    if (!sessionAlive(state)) return true;
    if (performance.now() >= deadline) return false;
    await sleep(50);
  }
}

function stopCaffeinate(state: SessionState): void {
  if (state.caffeinatePid !== undefined && processAlive(state.caffeinatePid, 'caffeinate')) signalGroup(state.caffeinatePid, 'SIGTERM');
}

async function stopSession(config: Config, state: SessionState, options: StopOptions): Promise<StopOutcome> {
  try {
    if (!sessionAlive(state)) return 'already-exited';
    if (options.tryShutdown) {
      let sent = false;
      try {
        await withRunner(config, { role: 'control', session: state, helloTimeoutMs: 2_000 }, (c) => c.call('runner.shutdown', {}, { timeoutMs: 2_000 }));
        sent = true;
      } catch {
        // sem cabo, runner travado ou já saindo: segue para os sinais
      }
      if (sent && (await waitGone(state, options.shutdownGraceMs ?? SHUTDOWN_GRACE_MS))) return 'shutdown';
    }
    signalGroup(state.xcodebuildPid, 'SIGTERM');
    if (await waitGone(state, options.termGraceMs ?? TERM_GRACE_MS)) return 'SIGTERM';
    signalGroup(state.xcodebuildPid, 'SIGKILL');
    await waitGone(state, 2_000);
    return 'SIGKILL';
  } finally {
    stopCaffeinate(state);
  }
}

// ── up ─────────────────────────────────────────────────────────────────────────────────────────────

export interface UpOptions extends LifecycleOptions {
  /** `runner up --spike`: configuração `Spike` e `CONTRARREGRA_BIND`. */
  spike?: boolean;
  /** `CONTRARREGRA_BIND` (só com `spike`); padrão `loopback`. */
  bind?: BindMode;
  readyTimeoutMs?: number;
  pollMs?: number;
  /** Para a sessão viva anterior (repassado a `stopSession`). */
  shutdownGraceMs?: number;
  termGraceMs?: number;
}

export interface UpResult {
  state: 'up';
  sessionId: string;
  /** Pid do `xcodebuild` da sessão. */
  pid: number;
  configuration: string;
  port: number;
  readyMs: number;
  runnerVersion: string;
  xctestrun: string;
  log: string;
}

/** As variáveis de S1 que o `.xctestrun` da sessão leva (listas separadas por vírgula; vazio = nenhum). */
export function sessionEnv(config: Config, sessionId: string, token: string, spike: boolean, bind: BindMode): Record<string, string> {
  const env: Record<string, string> = {
    CONTRARREGRA_PORT: String(config.runner.port),
    CONTRARREGRA_TOKEN: token,
    CONTRARREGRA_SESSION: sessionId,
    CONTRARREGRA_PRIVATE: config.runner.privateAllowed.join(','),
    CONTRARREGRA_ALLOWED: [...config.apps.allowed, ...config.urls.allowedPrefixes].join(','),
    CONTRARREGRA_EXPLORE: config.app.explore ?? '',
  };
  if (spike) env[BIND_ENV_KEY] = bind;
  return env;
}

export async function upRunner(config: Config, options: UpOptions = {}): Promise<UpResult> {
  const paths = runnerPaths(config);
  const tools = resolveTools(options.tools);
  const spike = options.spike ?? false;
  if (options.bind !== undefined && !spike) throw new ContrarregraError('E_CONFIG', '`--bind` só vale com `--spike` (CONTRARREGRA_BIND existe só no build Spike)', {});
  const bind: BindMode = options.bind ?? 'loopback';
  const configuration = spike ? SPIKE_CONFIGURATION : DEFAULT_CONFIGURATION;

  // Pré-requisitos antes de derrubar qualquer coisa: sem tomada, com cabo, com o build pedido. Faltando
  // um, a sessão que estiver de pé continua de pé.
  assertNoTake(paths, 'runner up');
  await findUsbDevice({ socketPath: config.usbmux.socketPath, udid: config.device.udid });
  const built = findBuiltXctestrun(paths.products, configuration);
  if (built === undefined) {
    const hint = spike ? 'contrarregra runner build --configuration Spike' : 'contrarregra runner build';
    throw new ContrarregraError('E_RUNNER_DOWN', `não há build ${configuration} do runner em ${paths.products}: rode \`${hint}\``, {
      reason: 'no-build',
      configuration,
      hint,
    });
  }

  // Uma sessão por vez: a viva anterior para; depois, os arquivos das sessões mortas são apagados (a
  // varredura nunca toca numa sessão viva nem na sobra recém-criada de outra subida em curso).
  for (const old of readSessionStates(paths)) {
    if (sessionAlive(old)) {
      options.onProgress?.(`runner up: parando a sessão anterior ${old.sessionId}`);
      const stopOptions: StopOptions = { tryShutdown: true };
      if (options.shutdownGraceMs !== undefined) stopOptions.shutdownGraceMs = options.shutdownGraceMs;
      if (options.termGraceMs !== undefined) stopOptions.termGraceMs = options.termGraceMs;
      await stopSession(config, old, stopOptions);
    } else {
      stopCaffeinate(old);
    }
  }
  const removed = sweepSessionFiles(paths);
  if (removed.length > 0) logRunner(paths, `runner up: apagados ${removed.length} arquivos de sessões velhas`);

  const sessionId = newSessionId();
  const token = newSessionToken();
  ensureSessionsDir(paths);
  const xctestrun = sessionXctestrunPath(paths, sessionId);
  const doc = makeSessionXctestrun(built.doc, { testRoot: paths.products, env: sessionEnv(config, sessionId, token.reveal(), spike, bind) });
  writePrivateFile(xctestrun, encodePlist(doc));
  const log = join(paths.logs, `xcodebuild-${sessionId}.log`);

  let state: SessionState;
  let exited: RunResult | undefined;
  let spawnedPid: number | undefined;
  let caffeinatePid: number | undefined;
  try {
    const xcodebuild = spawnDetached(tools.xcodebuild, testWithoutBuildingArgs(xctestrun, config.device.udid), log);
    spawnedPid = xcodebuild.pid;
    xcodebuild.child.once('exit', (exitCode, signal) => {
      exited = { exitCode, signal };
    });
    try {
      caffeinatePid = spawnDetached(tools.caffeinate, caffeinateArgs(xcodebuild.pid)).pid;
    } catch {
      logRunner(paths, `runner up: caffeinate não iniciou para a sessão ${sessionId}`);
    }
    state = {
      schema: SESSION_SCHEMA,
      sessionId,
      udid: config.device.udid,
      port: config.runner.port,
      configuration,
      spike,
      ...(spike ? { bind } : {}),
      xctestrun,
      log,
      xcodebuildPid: xcodebuild.pid,
      ...(caffeinatePid === undefined ? {} : { caffeinatePid }),
      startedAt: new Date().toISOString(),
    };
    writeSessionState(paths, state);
  } catch (error) {
    // Nada fica órfão: sem o estado, ninguém acharia esses processos depois.
    for (const pid of [spawnedPid, caffeinatePid]) if (pid !== undefined) signalGroup(pid, 'SIGTERM');
    deleteSessionFilesFor(paths, sessionId);
    throw new ContrarregraError('E_RUNNER_DOWN', `não consegui iniciar a sessão do runner: ${(error as Error).message}`, { reason: 'spawn-failed', log }, { cause: error });
  }
  logRunner(paths, `runner up: sessão ${sessionId} (${configuration}) com xcodebuild ${state.xcodebuildPid}; registro ${log}`);

  const fail = async (error: ContrarregraError): Promise<never> => {
    await stopSession(config, state, { tryShutdown: false, termGraceMs: options.termGraceMs ?? TERM_GRACE_MS });
    deleteSessionFilesFor(paths, sessionId); // só os desta sessão: outra subida pode estar escrevendo a dela
    logRunner(paths, `runner up: sessão ${sessionId} falhou (${error.code}: ${error.message})`);
    throw error;
  };

  const readyTimeoutMs = options.readyTimeoutMs ?? READY_TIMEOUT_MS;
  const pollMs = options.pollMs ?? READY_POLL_MS;
  const started = performance.now();
  let lastError: unknown;
  let noticed = false;
  for (;;) {
    if (exited !== undefined) {
      return fail(
        new ContrarregraError('E_RUNNER_DOWN', `o xcodebuild da sessão saiu antes do runner responder (saída ${exited.exitCode ?? exited.signal}); veja ${log}`, {
          reason: 'xcodebuild-exited',
          exitCode: exited.exitCode,
          signal: exited.signal,
          log,
          hint: RUNNER_UP_HINT,
        }),
      );
    }
    let connection: RunnerConnection | undefined;
    try {
      connection = await openRunner(config, { role: 'control', session: state });
    } catch (error) {
      lastError = error;
      // Sem cabo, ou uma tomada pegou a trava no meio: não adianta esperar. O resto (Connect recusado,
      // runner velho com outro token, xcodebuild ainda no exec) é "ainda subindo".
      if (isContrarregraError(error, 'E_NO_USB')) return fail(error);
      if (isContrarregraError(error, 'E_BUSY') && readTakeLock(paths) !== undefined) return fail(error);
    }
    if (connection !== undefined) {
      const readyMs = Math.round(performance.now() - started);
      const runnerVersion = connection.hello.runnerVersion;
      await connection.close();
      logRunner(paths, `runner up: sessão ${sessionId} pronta em ${readyMs} ms`);
      return { state: 'up', sessionId, pid: state.xcodebuildPid, configuration, port: state.port, readyMs, runnerVersion, xctestrun, log };
    }
    const elapsed = performance.now() - started;
    if (elapsed >= readyTimeoutMs) {
      return fail(
        new ContrarregraError('E_RUNNER_DOWN', `o runner não respondeu session.hello em ${Math.round(readyTimeoutMs / 1000)} s; veja ${log}`, {
          reason: 'ready-timeout',
          waitedMs: Math.round(elapsed),
          lastError: isContrarregraError(lastError) ? lastError.code : lastError instanceof Error ? lastError.message : null,
          log,
          hint: RUNNER_UP_HINT,
        }),
      );
    }
    if (!noticed && elapsed >= STARTING_NOTICE_MS) {
      noticed = true;
      options.onProgress?.(
        `runner up: starting — esperando o session.hello (até ${Math.round(readyTimeoutMs / 1000)} s). Se o iPhone pedir o código para a automação (Enable UI Automation), digite-o no aparelho.`,
      );
    }
    await sleep(pollMs);
  }
}

// ── down ───────────────────────────────────────────────────────────────────────────────────────────

export interface DownOptions extends LifecycleOptions {
  shutdownGraceMs?: number;
  termGraceMs?: number;
}

export interface DownResult {
  state: 'down';
  /** Uma entrada por sessão encontrada. */
  stopped: { sessionId: string; pid: number; how: StopOutcome }[];
  /** `.xctestrun` e estados apagados (AC-2.9). */
  deleted: string[];
}

export async function downRunner(config: Config, options: DownOptions = {}): Promise<DownResult> {
  const paths = runnerPaths(config);
  assertNoTake(paths, 'runner down');
  const stopped: DownResult['stopped'] = [];
  for (const state of readSessionStates(paths)) {
    const stopOptions: StopOptions = { tryShutdown: true };
    if (options.shutdownGraceMs !== undefined) stopOptions.shutdownGraceMs = options.shutdownGraceMs;
    if (options.termGraceMs !== undefined) stopOptions.termGraceMs = options.termGraceMs;
    const how = await stopSession(config, state, stopOptions);
    stopped.push({ sessionId: state.sessionId, pid: state.xcodebuildPid, how });
  }
  const deleted = deleteSessionFiles(paths);
  logRunner(paths, `runner down: ${stopped.map((s) => `${s.sessionId} (${s.how})`).join(', ') || 'nenhuma sessão'}; ${deleted.length} arquivos apagados`);
  return { state: 'down', stopped, deleted };
}

// ── status ─────────────────────────────────────────────────────────────────────────────────────────

export interface RunnerStatus {
  state: 'down' | 'starting' | 'up';
  /** Pid do `xcodebuild` da sessão viva. */
  pid: number | null;
  sessionId: string | null;
  transport: { usb: boolean; wired: boolean | null; tunnelState: string | null };
  rttMs: { p50: number; p95: number } | null;
  uptimeS: number | null;
  /** O `takeId` (ou `unknown`) de quem segura `control`, quando não é este comando. */
  controlHeldBy?: string;
}

export interface StatusOptions extends LifecycleOptions {
  samples?: number;
}

/** Percentil por posição (nearest-rank), arredondado a 0,01 ms. */
export function percentile(samples: readonly number[], p: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Math.round(sorted[index]! * 100) / 100;
}

async function measure(samples: number, round: () => Promise<unknown>): Promise<{ p50: number; p95: number }> {
  const rtts: number[] = [];
  for (let i = 0; i < samples; i++) {
    const t0 = performance.now();
    await round();
    rtts.push(performance.now() - t0);
  }
  return { p50: percentile(rtts, 50), p95: percentile(rtts, 95) };
}

export async function runnerStatus(config: Config, options: StatusOptions = {}): Promise<RunnerStatus> {
  const paths = runnerPaths(config);
  const tools = resolveTools(options.tools);
  const samples = Math.max(1, options.samples ?? STATUS_SAMPLES);
  await findUsbDevice({ socketPath: config.usbmux.socketPath, udid: config.device.udid });
  const device = await readDeviceTransport({
    xcrun: tools.xcrun,
    udid: config.device.udid,
    coreDeviceId: config.device.coreDeviceId,
    outDir: paths.cache,
  });
  const transport = {
    usb: true,
    wired: device?.transportType == null ? null : device.transportType === 'wired',
    tunnelState: device?.tunnelState ?? null,
  };
  const takeId = readTakeLock(paths);
  const held = takeId === undefined ? {} : { controlHeldBy: takeId };

  const state = currentSession(paths);
  if (state === undefined) return { state: 'down', pid: null, sessionId: null, transport, rttMs: null, uptimeS: null, ...held };
  if (!sessionAlive(state)) {
    markSessionDown(paths, state);
    return { state: 'down', pid: null, sessionId: state.sessionId, transport, rttMs: null, uptimeS: null, ...held };
  }
  const starting: RunnerStatus = { state: 'starting', pid: state.xcodebuildPid, sessionId: state.sessionId, transport, rttMs: null, uptimeS: null, ...held };

  const viaSync = async (heldBy: string): Promise<RunnerStatus> => {
    try {
      return await withRunner(config, { role: 'sync', session: state }, async (c) => {
        let seq = 0;
        const rttMs = await measure(samples, () => c.call('clock.ping', { seq: seq++ }, { timeoutMs: 2_000 }));
        return { state: 'up', pid: state.xcodebuildPid, sessionId: state.sessionId, transport, rttMs, uptimeS: null, controlHeldBy: heldBy };
      });
    } catch (error) {
      if (isContrarregraError(error, 'E_NO_USB')) throw error;
      return { ...starting, controlHeldBy: heldBy };
    }
  };

  if (takeId !== undefined) return viaSync(takeId);
  try {
    return await withRunner(config, { role: 'control', session: state }, async (c) => {
      let uptimeS: number | null = null;
      const rttMs = await measure(samples, async () => {
        const health = await c.call<HealthResult>('health', {}, { timeoutMs: 2_000 });
        if (typeof health?.uptimeS === 'number') uptimeS = health.uptimeS;
      });
      return { state: 'up', pid: state.xcodebuildPid, sessionId: state.sessionId, transport, rttMs, uptimeS };
    });
  } catch (error) {
    if (isContrarregraError(error, 'E_NO_USB')) throw error;
    if (isContrarregraError(error, 'E_BUSY')) {
      const heldBy = error.data?.['takeId'];
      return viaSync(typeof heldBy === 'string' ? heldBy : 'unknown');
    }
    return starting;
  }
}

// ── sever ──────────────────────────────────────────────────────────────────────────────────────────

export interface SeverResult {
  /** Quem recebeu o pedido: o supervisor da tomada ou este processo (fora de tomada). */
  owner: 'supervisor' | 'self';
  pid: number;
  forS: number;
  takeId?: string;
  /** Fora de tomada: quantas linhas deste processo foram cortadas. */
  links?: number;
}

function findTakeDir(paths: RunnerPaths, takeId: string): string | undefined {
  let apps: string[];
  try {
    apps = readdirSync(paths.takes, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return undefined;
  }
  for (const app of apps) {
    const dir = join(paths.takes, app, takeId);
    if (existsSync(join(dir, 'status.json'))) return dir;
  }
  return undefined;
}

/** Batimento do supervisor mais velho que isto = supervisor perdido (S8 item 5). */
export const SUPERVISOR_STALE_MS = 10_000;

/**
 * `runner sever --for <s>` (S2 item 8). Com a trava: o supervisor é o `pid` do `status.json` da tomada, e
 * só recebe o sinal se for mesmo ele — vivo, com o `takeId` na linha de comando (o supervisor é lançado com
 * a pasta da tomada nos argumentos) e com batimento recente (o `status.json` é regravado a 1 Hz; mais de
 * 10 s parado = perdido, S8 item 5). Senão, erro claro e nenhum sinal: um pid reaproveitado receberia um
 * `SIGUSR1`, que por padrão termina o processo.
 */
export function severRunner(config: Config, options: { forS: number }, now = Date.now()): SeverResult {
  const { forS } = options;
  if (!Number.isFinite(forS) || forS <= 0) throw new ContrarregraError('E_CONFIG', `--for precisa ser um número de segundos > 0 (veio ${forS})`, { forS });
  const paths = runnerPaths(config);
  const takeId = readTakeLock(paths);
  if (takeId === undefined) {
    return { owner: 'self', pid: process.pid, forS, links: severLocalLinks(forS) };
  }
  const noOwner = (why: string): ContrarregraError =>
    new ContrarregraError('E_RUNNER_DOWN', `a trava do aparelho é da tomada ${takeId}, mas ${why}: confira \`contrarregra take status\``, {
      reason: 'no-control-owner',
      takeId,
    });
  const dir = findTakeDir(paths, takeId);
  if (dir === undefined) throw noOwner(`a pasta da tomada não tem status.json em ${paths.takes}`);
  const statusPath = join(dir, 'status.json');
  let pid: unknown;
  let beatAgeMs: number;
  try {
    beatAgeMs = now - statSync(statusPath).mtimeMs;
    pid = (JSON.parse(readFileSync(statusPath, 'utf8')) as Record<string, unknown>)['pid'];
  } catch {
    throw noOwner('o status.json da tomada não pôde ser lido');
  }
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) throw noOwner('o status.json não tem o pid do supervisor');
  if (beatAgeMs > SUPERVISOR_STALE_MS) throw noOwner(`o batimento do supervisor parou há ${Math.round(beatAgeMs / 1000)} s`);
  if (!processAlive(pid, takeId)) throw noOwner(`o pid ${pid} do status.json não é o supervisor da tomada (morto ou reaproveitado)`);
  writeFileSync(join(dir, SEVER_FILE), `${JSON.stringify({ forS })}\n`);
  process.kill(pid, 'SIGUSR1');
  return { owner: 'supervisor', pid, forS, takeId };
}
