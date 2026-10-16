// `take run` da trilha do demo (spec/tasks.md "Trilha do demo"; S4 item 1 e S9 reduzidos): junta o runner,
// o OBS e o executor. Ordem, sem `--dry`:
//
//   validação → trava do aparelho → pré-voo reduzido (runner vivo: `health`; OBS no perfil/coleção da
//   configuração, sem gravação em curso, fonte viva em 1170×2532 com o "chute"; ffprobe fixado; disco ≥
//   max(4 GiB, 16 Mbps × duração estimada × 1,25 + 2 GiB)) → pasta da tomada e `take.json` → `prepare`
//   (fora do vídeo) → `SetRecordDirectory` (pasta da tomada) → `StartRecord` (espera `STARTED`) → pré-rolo
//   2 s → cenas → pós-rolo 2 s → `StopRecord` → finalização (tamanho estável e `ffprobe` legível) → pasta de
//   gravação anterior devolvida → `cleanup` → trava solta.
//
// Em qualquer falha, abort ou sinal (SIGINT, SIGTERM, SIGHUP) com a gravação ativa: pós-rolo, para a
// gravação, finaliza, devolve a pasta (reconectando uma vez ao OBS se a conexão caiu), solta a trava, grava o
// `take.json` e relata (nunca apaga arquivo); a `cleanup` não roda (fica `cleanupPending`). Durante a
// gravação, um vigia confere o disco a cada 5 s e, abaixo de `disk.criticalGiB`, aborta (S9 item 4). Se a
// tomada parar com o modo avião possivelmente ligado, avisa no resumo e com `say`. `--dry` = nada de OBS
// (nem conexão), o resto igual (sem pré/pós-rolo). Falha no pré-voo (antes da pasta existir) → o erro
// sobe com o código (`E_DISK_LOW`, `E_OBS_CONFIG`, `E_RUNNER_DOWN`…); depois disso, a tomada termina
// `aborted`/`failed` no `take.json` e no resumo.

import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import type { Config } from '../core/config.ts';
import { ContrarregraError } from '../core/errors.ts';
import type { HealthResult } from '../core/types.ts';
import { RunnerLink } from '../runner/link.ts';
import { runnerPaths } from '../runner/paths.ts';
import { processAlive } from '../runner/session.ts';
import { loadTakeChoreography } from './choreo.ts';
import { clearControl, readControl } from './control.ts';
import { errorInfo, estimateScenesMs, planScenes, TakeAborted, TakeExecutor, type SceneSelection, type TakeClock, type TakeRunner } from './executor.ts';
import { acquireTakeLock, releaseTakeLock } from './lock.ts';
import { appDirName, choreographyName, newTakeId, takeRecordPath, writeTakeRecord, type TakeMode, type TakeRecord, type TakeStatus } from './manifest.ts';
import {
  checkDisk,
  connectTakeObs,
  ffprobeChecker,
  freeBytesAt,
  GiB,
  liveTargetOf,
  obsPreflight,
  POSTROLL_MS,
  PREROLL_MS,
  startRecording,
  type ActiveRecording,
  type TakeObs,
} from './obs.ts';
import { loadVoicePlan, voiceWarnings } from './voice.ts';

/** Por quanto tempo uma chamada espera a linha com o runner voltar (reconexão, S2 item 6) antes de falhar. */
export const RECONNECT_WAIT_MS = 30_000;
export const SAY_PATH = '/usr/bin/say';

export interface TakeRunOptions {
  file: string;
  dry?: boolean;
  scenes?: string[];
  from?: string;
  until?: string;
  voice?: string;
  /** `false` com `--no-prepare`. */
  prepare?: boolean;
  /** `false` com `--no-cleanup`. */
  cleanup?: boolean;
}

export interface TakeRunnerHandle extends TakeRunner {
  close(): Promise<void>;
}

/** Só para testes: runner, OBS, relógio, aviso falado, disco, ffprobe e sinal falsos. */
export interface TakeRunDeps {
  openRunner?: (takeId: string) => Promise<TakeRunnerHandle>;
  connectObs?: () => Promise<TakeObs>;
  probeOk?: (file: string) => Promise<boolean>;
  freeBytes?: (dir: string) => Promise<number>;
  say?: (text: string) => void;
  clock?: TakeClock;
  /** Liga o tratador dos sinais; devolve quem desliga. Padrão: `SIGINT`, `SIGTERM` e `SIGHUP` do processo. */
  onInterrupt?: (handler: (signal: string) => void) => () => void;
  /** `pid` gravado na trava (padrão: o deste processo). */
  pid?: number;
  /** Intervalo do vigia de disco durante a gravação (padrão 5 s; S9 item 4). */
  diskWatchMs?: number;
}

export interface TakeSummary {
  takeId: string;
  mode: TakeMode;
  status: TakeStatus;
  cause?: string;
  error?: { code: string | null; message: string };
  /** `null` quando a tomada parou antes de a pasta existir (SIGINT no pré-voo). */
  dir: string | null;
  takeJson: string | null;
  recording: { file: string | null; sizeBytes: number | null; directoryRestored: boolean | null } | null;
  scenes: { planned: number; started: number };
  steps: { ok: number; skipped: number; failed: number };
  cleanupPending: boolean;
  /** O modo avião pode ter ficado ligado (ver `TakeExecutor.airplaneMaybeOn`): desligue-o à mão. */
  airplaneMaybeOn: boolean;
  warnings: string[];
}

/** Intervalo do vigia de disco e o limite crítico padrão (S9 item 4; `disk.criticalGiB`). */
export const DISK_WATCH_MS = 5_000;
export const DEFAULT_CRITICAL_GIB = 2;
export const AIRPLANE_WARNING = 'o modo avião pode ter ficado ligado: desligue-o no iPhone';
const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;

export const REAL_CLOCK: TakeClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms))),
};

/** Argumentos do `say`: `--` antes do texto (um `ask` que comece com "-" não vira opção). */
export function sayArgs(voice: string, text: string, device?: string): string[] {
  return ['-v', voice, ...(device === undefined ? [] : ['-a', device]), '--', text];
}

/** Os nomes de `say -a '?'` (linhas `  <id> <nome>`). */
export function parseSayDevices(output: string): string[] {
  const names: string[] = [];
  for (const line of output.split('\n')) {
    const match = /^\s*\d+\s+(.+?)\s*$/.exec(line);
    if (match !== null) names.push(match[1]!);
  }
  return names;
}

/**
 * Aviso falado no Mac (`/usr/bin/say -v <alerts.voice> [-a <alerts.sayDevice>] -- <texto>`), sem esperar;
 * nunca no iPhone (P-7). O dispositivo é conferido no primeiro aviso (`say -a '?'`); se `alerts.sayDevice`
 * não existe, o aviso sai no dispositivo padrão do Mac — simplificação desta trilha (S5 item 2 pede nenhum
 * som nesse caso): o OBS do perfil "Contrarregra" não grava o som do Mac.
 */
export function macSay(voice: string, device: string | undefined, log: (line: string) => void = () => {}): (text: string) => void {
  let resolved: string | null | undefined;
  return (text) => {
    try {
      if (resolved === undefined) {
        resolved = null;
        if (device !== undefined && device !== '') {
          const listed = spawnSync(SAY_PATH, ['-a', '?'], { encoding: 'utf8', timeout: 3_000 });
          if (parseSayDevices(listed.stdout ?? '').includes(device)) resolved = device;
          else log(`aviso: alerts.sayDevice "${device}" não existe neste Mac; o aviso sai no dispositivo padrão`);
        }
      }
      const child = spawn(SAY_PATH, sayArgs(voice, text, resolved ?? undefined), { stdio: 'ignore' });
      child.once('error', () => {});
      child.unref();
    } catch {
      // sem aviso falado: a linha no terminal continua
    }
  };
}

/**
 * SIGINT, SIGTERM e SIGHUP com o mesmo tratador (a tomada para a gravação e solta a trava antes de sair). Com
 * o terminal fechado (SIGHUP), escrever no stdout/stderr dá erro: os erros dos fluxos são engolidos enquanto
 * o tratador está ligado.
 */
function onSignals(handler: (signal: string) => void): () => void {
  const handlers = SIGNALS.map((signal) => [signal, () => handler(signal)] as const);
  const swallow = (): void => {};
  for (const [signal, h] of handlers) process.on(signal, h);
  process.stdout.on('error', swallow);
  process.stderr.on('error', swallow);
  return () => {
    for (const [signal, h] of handlers) process.off(signal, h);
    process.stdout.off('error', swallow);
    process.stderr.off('error', swallow);
  };
}

/** A linha `control` da tomada (dona da trava), que reconecta sozinha; a chamada espera a linha voltar. */
async function openLinkRunner(config: Config, takeId: string, clock: TakeClock, log: (line: string) => void): Promise<TakeRunnerHandle> {
  const link = await RunnerLink.connect(config, {
    role: 'control',
    lockOwner: takeId,
    onStateChange: (state, error) => log(`runner: ${state}${error === undefined ? '' : ` (${error.message})`}`),
  });
  return {
    async call<T = unknown>(method: string, params: Record<string, unknown>, options: { timeoutMs: number }): Promise<T> {
      const deadline = clock.now() + RECONNECT_WAIT_MS;
      while ((link.state === 'down' || link.state === 'severed') && clock.now() < deadline) await clock.sleep(250);
      return link.call<T>(method, params, options);
    },
    close: () => link.close(),
  };
}

/**
 * Vigia de disco durante a gravação (S9 item 4): a cada `intervalMs`, o livre na pasta da tomada; abaixo de
 * `criticalGiB`, chama `onCritical` uma vez. Relógio real (não o da tomada): devolve quem desliga.
 */
export function watchDisk(options: {
  dir: string;
  criticalGiB: number;
  intervalMs: number;
  freeBytes: (dir: string) => Promise<number>;
  onCritical: (freeBytes: number, criticalBytes: number) => void;
}): () => void {
  const criticalBytes = options.criticalGiB * GiB;
  let busy = false;
  let fired = false;
  const timer = setInterval(() => {
    if (busy || fired) return;
    busy = true;
    options
      .freeBytes(options.dir)
      .then((free) => {
        if (!fired && free < criticalBytes) {
          fired = true;
          options.onCritical(free, criticalBytes);
        }
      })
      .catch(() => {})
      .finally(() => {
        busy = false;
      });
  }, options.intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** `take run <coreografia>`. */
export async function runTake(config: Config, options: TakeRunOptions, deps: TakeRunDeps = {}, log: (line: string) => void = () => {}): Promise<TakeSummary> {
  const clock = deps.clock ?? REAL_CLOCK;
  const output = log;
  // O terminal pode ter fechado (SIGHUP): uma linha que não sai nunca derruba a tomada.
  log = (line) => {
    try {
      output(line);
    } catch {
      // sem terminal
    }
  };
  const say = deps.say ?? macSay(config.alerts.voice, config.alerts.sayDevice, log);
  const loaded = loadTakeChoreography(options.file);
  const voice = options.voice === undefined ? null : loadVoicePlan(options.voice);
  const selection: SceneSelection = {};
  if (options.scenes !== undefined) selection.scenes = options.scenes;
  if (options.from !== undefined) selection.from = options.from;
  if (options.until !== undefined) selection.until = options.until;
  const plan = planScenes(loaded.doc, selection);
  const pads = { padBeforeMs: config.guide.padBeforeMs, padAfterMs: config.guide.padAfterMs };
  const mode: TakeMode = options.dry === true ? 'dry' : 'take';
  const paths = runnerPaths(config);
  const startedMs = clock.now();
  const takeId = newTakeId(choreographyName(loaded.path), new Date(startedMs));
  const dir = join(paths.takes, appDirName(loaded.path), takeId);

  const record: TakeRecord = {
    schema: 'contrarregra.demo-take/1',
    takeId,
    mode,
    status: 'preparing',
    pid: deps.pid ?? process.pid,
    choreography: { path: loaded.path, sha256: loaded.sha256 },
    app: { bundleId: loaded.doc.app.bundleId, expectVersion: loaded.doc.app.expectVersion },
    options: {
      scenes: options.scenes ?? null,
      from: options.from ?? null,
      until: options.until ?? null,
      voice: voice === null ? null : { path: voice.path, sha256: voice.sha256, gapMs: voice.gapMs },
      prepare: options.prepare !== false,
      cleanup: options.cleanup !== false,
    },
    startedAt: iso(startedMs),
    recording: null,
    cleanupPending: false,
    pause: null,
    scenes: [],
    steps: [],
    warnings: [...loaded.warnings, ...(voice === null ? [] : voiceWarnings(voice, loaded.doc))],
  };
  for (const warning of record.warnings) log(`aviso: ${warning}`);
  if (plan.length === 0) log('aviso: nenhuma cena a rodar com --scenes/--from/--until');

  // O `takeId` na linha de comando (`ps`): é por ela que outra tomada sabe que a trava não é sobra.
  const previousTitle = process.title;
  if (record.pid === process.pid) process.title = `contrarregra ${takeId}`;
  let lock: ReturnType<typeof acquireTakeLock>;
  try {
    lock = acquireTakeLock(paths, takeId, new Date(startedMs), record.pid);
  } catch (error) {
    process.title = previousTitle;
    throw error;
  }
  if (lock.replaced !== undefined) {
    const warning = `trava velha da tomada ${lock.replaced.takeId ?? '?'} (pid ${lock.replaced.pid ?? '?'}, que não é mais ela) trocada`;
    record.warnings.push(warning);
    log(`aviso: ${warning}`);
  }
  if (record.pid === process.pid && !processAlive(process.pid, takeId)) {
    const warning = 'a linha de comando deste processo não mostra o takeId: outra tomada veria a trava como sobra';
    record.warnings.push(warning);
    log(`aviso: ${warning}`);
  }

  let runner: TakeRunnerHandle | undefined;
  let obs: TakeObs | undefined;
  const extraObs: TakeObs[] = [];
  let recording: ActiveRecording | undefined;
  let executor: TakeExecutor | undefined;
  let stopDiskWatch: (() => void) | undefined;
  let interrupted: string | undefined;
  let dirReady = false;
  let failure: unknown;
  const persist = (): void => {
    if (dirReady) writeTakeRecord(dir, record);
  };
  const off = (deps.onInterrupt ?? onSignals)((signal) => {
    if (interrupted !== undefined) {
      log(`${signal}: já estou parando — a gravação é parada e finalizada e a trava solta antes de sair`);
      return;
    }
    interrupted = signal;
    log(`${signal}: encerrando a tomada…`);
    executor?.abort(signal, `tomada interrompida (${signal})`);
  });
  const checkInterrupted = (): void => {
    if (interrupted !== undefined) throw new TakeAborted(interrupted, `tomada interrompida (${interrupted}) no pré-voo`);
  };
  const connectObs = deps.connectObs ?? (() => connectTakeObs(config, log));

  try {
    // ── Pré-voo reduzido ──────────────────────────────────────────────────────────────────────────
    runner = await (deps.openRunner ?? ((id: string) => openLinkRunner(config, id, clock, log)))(takeId);
    const health = await runner.call<HealthResult>('health', {}, { timeoutMs: 5_000 });
    if (health?.ok !== true) throw new ContrarregraError('E_RUNNER_DOWN', 'o runner respondeu ao health sem ok: rode `contrarregra runner status`', { health: health ?? null });
    log(`runner: vivo (à frente ${health.foregroundApp}${health.locked ? ', tela travada' : ''}; fila ${health.xctestQueueDepth})`);
    checkInterrupted();
    let probeOk = deps.probeOk;
    if (mode === 'take') {
      obs = await connectObs();
      const live = await obsPreflight(obs, liveTargetOf(config), clock, log);
      log(`obs: perfil "${config.obs.profile}", coleção "${config.obs.collection}"; fonte "${config.obs.source}" viva ${live.w}×${live.h}${live.kicked > 0 ? ` depois de ${live.kicked} chute(s)` : ''}`);
      probeOk ??= await ffprobeChecker(config);
      const estimateMs = PREROLL_MS + estimateScenesMs(plan, voice, pads) + POSTROLL_MS;
      const disk = await checkDisk(obs, {
        dir: paths.takes,
        estimateMs,
        bitrateKbps: config.record.bitrateKbps,
        minFreeGiB: config.disk.minFreeGiB,
        freeBytes: deps.freeBytes ?? freeBytesAt,
      });
      record.disk = { freeBytes: disk.freeBytes, requiredBytes: disk.requiredBytes, estimateMs };
      log(`disco: ${(disk.freeBytes / GiB).toFixed(1)} GiB livres (mínimo ${(disk.requiredBytes / GiB).toFixed(1)} GiB para ~${Math.ceil(estimateMs / 60_000)} min)`);
      checkInterrupted();
    }

    // ── Tomada ────────────────────────────────────────────────────────────────────────────────────
    mkdirSync(dir, { recursive: true });
    dirReady = true;
    persist();
    log(`tomada ${takeId} (${mode}) → ${dir}`);
    executor = new TakeExecutor({
      doc: loaded.doc,
      record,
      runner,
      clock,
      say,
      log,
      control: { read: () => readControl(dir), clear: () => clearControl(dir) },
      persist,
      voice,
      pads,
      controlHint: `contrarregra take control ${dir}`,
    });
    if (options.prepare !== false) await executor.runSection('prepare', loaded.doc.prepare);
    if (obs !== undefined) {
      recording = await startRecording(obs, dir, {
        clock,
        probeOk: probeOk!,
        log,
        reconnect: async () => {
          const fresh = await connectObs();
          extraObs.push(fresh);
          return fresh;
        },
      });
      record.status = 'recording';
      record.recording = recording.info;
      persist();
      executor.setRecorder(recording);
      stopDiskWatch = watchDisk({
        dir,
        criticalGiB: config.disk?.criticalGiB ?? DEFAULT_CRITICAL_GIB,
        intervalMs: deps.diskWatchMs ?? DISK_WATCH_MS,
        freeBytes: deps.freeBytes ?? freeBytesAt,
        onCritical: (freeBytes, criticalBytes) => {
          const warning = `disco crítico durante a gravação: ${(freeBytes / GiB).toFixed(2)} GiB livres < ${(criticalBytes / GiB).toFixed(2)} GiB; gravação parada (S9 item 4)`;
          record.warnings.push(warning);
          log(`aviso: ${warning}`);
          executor?.abort('disk-critical', warning);
        },
      });
      log(`obs: gravando em ${dir}; pré-rolo ${PREROLL_MS / 1000} s`);
      await executor.sleep(PREROLL_MS);
    }
    record.scenesStartedAt = iso(clock.now());
    record.cleanupPending = loaded.doc.cleanup.length > 0;
    persist();
    await executor.runScenes(plan);
    if (recording !== undefined) {
      log(`obs: pós-rolo ${POSTROLL_MS / 1000} s`);
      await executor.sleep(POSTROLL_MS);
      stopDiskWatch?.();
      executor.setRecorder(null);
      const active = recording;
      recording = undefined;
      record.recording = await active.stop();
      log(`obs: gravação pronta — ${record.recording.file ?? '?'} (${((record.recording.sizeBytes ?? 0) / 1024 ** 2).toFixed(1)} MB); pasta de gravação ${record.recording.directoryRestored ? 'devolvida' : 'NÃO devolvida'}`);
      persist();
    }
    if (options.cleanup !== false) {
      await executor.runSection('cleanup', loaded.doc.cleanup);
      record.cleanupPending = false;
    }
    record.status = 'finished';
  } catch (error) {
    failure = error;
    if (error instanceof TakeAborted) {
      record.status = 'aborted';
      record.cause = error.reason;
      log(`tomada abortada: ${error.message}`);
    } else {
      record.status = 'failed';
      record.error = errorInfo(error);
      record.cause = record.error.code ?? 'error';
      log(`tomada falhou: ${record.error.code ?? 'erro'}: ${record.error.message}`);
    }
  } finally {
    stopDiskWatch?.();
    executor?.setRecorder(null);
    if (recording !== undefined) {
      const active = recording;
      recording = undefined;
      try {
        log('obs: parando a gravação (pós-rolo, finalização e pasta devolvida)');
        await clock.sleep(POSTROLL_MS);
        await active.stop();
        log(`obs: gravação parada — ${active.info.file ?? '?'}`);
      } catch (error) {
        const warning = `a gravação não parou/finalizou direito: ${errorInfo(error).message}`;
        record.warnings.push(warning);
        log(`aviso: ${warning}`);
      }
      record.recording = active.info;
    }
    if (executor?.airplaneMaybeOn === true) {
      record.airplaneLeftOn = true;
      record.warnings.push(AIRPLANE_WARNING);
      log(`aviso: ${AIRPLANE_WARNING}`);
      say('Atenção: o modo avião pode ter ficado ligado. Desligue o modo avião no iPhone.');
    }
    // Trava solta e take.json gravado antes de qualquer coisa que possa travar (fechar conexões).
    releaseTakeLock(paths, takeId);
    record.endedAt = iso(clock.now());
    try {
      persist();
    } catch (error) {
      log(`aviso: não consegui gravar o take.json: ${errorInfo(error).message}`);
    }
    if (record.pid === process.pid) process.title = previousTitle;
    off();
    await runner?.close().catch(() => {});
    await obs?.close().catch(() => {});
    for (const extra of extraObs) await extra.close().catch(() => {});
  }
  if (failure !== undefined && !dirReady && !(failure instanceof TakeAborted)) throw failure;

  const count = (status: string): number => record.steps.filter((s) => s.status === status).length;
  const summary: TakeSummary = {
    takeId,
    mode,
    status: record.status,
    dir: dirReady ? dir : null,
    takeJson: dirReady ? takeRecordPath(dir) : null,
    recording:
      record.recording === null
        ? null
        : { file: record.recording.file, sizeBytes: record.recording.sizeBytes ?? null, directoryRestored: record.recording.directoryRestored ?? null },
    scenes: { planned: plan.length, started: record.scenes.length },
    steps: { ok: count('ok'), skipped: count('skipped'), failed: count('failed') },
    cleanupPending: record.cleanupPending,
    airplaneMaybeOn: record.airplaneLeftOn === true,
    warnings: record.warnings,
  };
  if (record.cause !== undefined) summary.cause = record.cause;
  if (record.error !== undefined) summary.error = record.error;
  return summary;
}
