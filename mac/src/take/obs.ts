// Gravação da tomada no OBS (S9 itens 2–5, reduzido para a trilha do demo). O que já foi provado nos
// spikes, copiado (o produto não importa `spikes/`): a fonte viva e o "chute" (`spikes/sp-1/sp1.ts`
// `ensureLive`, `spikes/sp-5/obs.ts` `liveState`/`pollUntil`/`kick`), a gravação com a conferência de disco
// (HC-11) e a finalização (`spikes/sp-5/obs.ts` `record`), e a pasta de gravação própria devolvida no fim.
//
// Toda escrita vai pelo `ObsClient` (`obs/client.ts`), cuja guarda relê o perfil e a coleção ativos antes
// de cada uma e recusa fora do "Contrarregra" (P-6); nunca `SetCurrentProfile`. Aqui só se escrevem
// `SetInputSettings {device}` (o chute), `SetRecordDirectory` (a pasta da tomada, e a anterior de volta),
// `StartRecord` e `CreateRecordChapter`; `StopRecord` não passa pela guarda (parar nunca é bloqueado).
// Nada é apagado: a gravação só é renomeada para `recording.mp4` dentro da pasta da tomada (S9 item 5).
// Nenhuma gravação fica órfã: sem `STARTED` confirmado, manda `StopRecord` por garantia; se a conexão cair
// na hora de parar, reconecta uma vez para o `StopRecord` e para devolver a pasta.
//
// Pausa (`take run --pause-recording-at`, decisão do dono de 2026-10-16: o destravar com código não pode
// aparecer no vídeo): `PauseRecord`/`ResumeRecord` passam pela guarda do perfil e são confirmados pelo
// `RecordStateChanged` PAUSED/RESUMED ou por `GetRecordStatus.outputPaused` (≤ 5 s). Parar com a gravação
// pausada: PARA DIRETO, sem retomar. No obs-websocket 5.x o `StopRecord` só recusa sem gravação ativa (501;
// `obs_frontend_recording_active()` é verdadeiro pausado — só `PauseRecord`/`ResumeRecord` têm 502/503 de
// estado), e o OBS para pela interface uma gravação pausada; retomar antes gravaria a tela do iPhone (o
// teclado do código) no pós-rolo. Se mesmo assim o OBS continuar ativo e pausado sem `STOPPED`, aí sim
// `ResumeRecord` de emergência (sem guarda, como o `StopRecord`) e `StopRecord` de novo.

import { existsSync, readdirSync, realpathSync, renameSync, statfsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { Config } from '../core/config.ts';
import { ContrarregraError, isContrarregraError } from '../core/errors.ts';
import { openFfmpeg, runFfprobe } from '../media/ffmpeg.ts';
import { ObsClient, obsClientOptions, type GetRecordStatusResponse, type GetStatsResponse, type PropertyItem } from '../obs/client.ts';
import type { ObsEvent } from '../obs/ws.ts';
import type { TakeClock, TakeRecorder } from './executor.ts';
import type { RecordingInfo } from './manifest.ts';
import { base64Image, decodePng, nonBlack } from './png.ts';

/** O que a tomada usa do cliente (o `ObsClient` real; nos testes, um falso com a mesma forma). */
export type TakeObs = Pick<ObsClient, 'request' | 'onEvent' | 'close' | 'assertProfile' | 'pauseRecord' | 'resumeRecord' | 'emergencyResumeRecord'>;

export const GiB = 1024 ** 3;
/** Pré-rolo e pós-rolo da gravação (trilha do demo: sem marcas de sincronia). */
export const PREROLL_MS = 2_000;
export const POSTROLL_MS = 2_000;
export const STARTED_TIMEOUT_MS = 5_000;
export const STOPPED_TIMEOUT_MS = 10_000;
/** Confirmação de `PauseRecord`/`ResumeRecord` (evento ou `GetRecordStatus.outputPaused`). */
export const PAUSE_CONFIRM_MS = 5_000;
/** Finalização (S9 item 5): tamanho estável por 500 ms e `ffprobe` legível, prazo 60 s. */
export const STABLE_MS = 500;
export const FINALIZE_TIMEOUT_MS = 60_000;
export const FINALIZE_POLL_MS = 100;
/** Fonte viva (S9 item 3): olhada inicial, espera depois de cada chute e quantos chutes. */
export const SOURCE_FIRST_LOOK_MS = 3_000;
export const SOURCE_KICK_WAIT_MS = 15_000;
export const SOURCE_POLL_MS = 500;
export const MAX_KICKS = 3;
/** Tamanho nativo da fonte do iPhone (antes do recorte; S9 itens 1 e 3). */
export const NATIVE_SOURCE = { width: 1170, height: 2532 } as const;
export const RECORDING_FILE = 'recording.mp4';

const STATE_STARTED = 'OBS_WEBSOCKET_OUTPUT_STARTED';
const STATE_STOPPED = 'OBS_WEBSOCKET_OUTPUT_STOPPED';
const STATE_PAUSED = 'OBS_WEBSOCKET_OUTPUT_PAUSED';
const STATE_RESUMED = 'OBS_WEBSOCKET_OUTPUT_RESUMED';

type Json = Record<string, unknown>;
type Log = (line: string) => void;

async function get<T>(obs: TakeObs, type: string, data?: Json): Promise<T> {
  return (await obs.request<T>(type, data)).data;
}

/** Conecta no OBS da configuração (versões conferidas; a senha do Chaveiro pelo nome, só no handshake). */
export function connectTakeObs(config: Config, log?: Log): Promise<ObsClient> {
  return ObsClient.connect(obsClientOptions(config, log === undefined ? {} : { log }));
}

// ── Fonte viva (S9 item 3) ────────────────────────────────────────────────────────────────────────

export interface LiveTarget {
  /** `obs.scene`. */
  scene: string;
  /** `obs.source` ("iPhone"). */
  source: string;
  /** `device.name`: o `itemName` do iPhone na lista do OBS. */
  deviceName: string;
}

export function liveTargetOf(config: Config): LiveTarget {
  return { scene: config.obs.scene, source: config.obs.source, deviceName: config.device.name };
}

export interface LiveState {
  w: number;
  h: number;
  nonBlack: boolean;
}

/** Tamanho da fonte (`GetSceneItemTransform`) e se a captura não é preta (`GetSourceScreenshot` de 64 px, na memória). */
export async function liveState(obs: TakeObs, scene: string, source: string, itemId: number): Promise<LiveState> {
  const { sceneItemTransform: tr } = await get<{ sceneItemTransform: Json }>(obs, 'GetSceneItemTransform', { sceneName: scene, sceneItemId: itemId });
  const w = Number(tr['sourceWidth'] ?? 0);
  const h = Number(tr['sourceHeight'] ?? 0);
  let black = true;
  if (w > 0 && h > 0) {
    try {
      const { imageData } = await get<{ imageData: string }>(obs, 'GetSourceScreenshot', { sourceName: source, imageFormat: 'png', imageWidth: 64 });
      black = !nonBlack(decodePng(base64Image(imageData)));
    } catch {
      black = true;
    }
  }
  return { w, h, nonBlack: !black };
}

export function isNativeLive(s: LiveState): boolean {
  return s.w === NATIVE_SOURCE.width && s.h === NATIVE_SOURCE.height && s.nonBlack;
}

/** Sonda `read` a cada `pollMs` até `ok(valor)` ou `timeoutMs`; erro de leitura conta como "ainda não". */
export async function pollUntil<T>(read: () => Promise<T>, ok: (v: T) => boolean, timeoutMs: number, pollMs: number, clock: TakeClock): Promise<{ ok: boolean; last: T | null }> {
  const start = clock.now();
  let last: T | null = null;
  for (;;) {
    try {
      last = await read();
      if (ok(last)) return { ok: true, last };
    } catch {
      // OBS ocupado ou fonte trocando: tenta de novo
    }
    if (clock.now() - start >= timeoutMs) return { ok: false, last };
    await clock.sleep(pollMs);
  }
}

/** O `device` da fonte é o `itemValue` cujo `itemName` é `device.name` (S9 item 1). */
export function resolveDevice(items: readonly PropertyItem[], name: string): string | null {
  const match = items.find((i) => i.itemName === name && typeof i.itemValue === 'string' && i.itemValue !== '');
  return match === undefined ? null : (match.itemValue as string);
}

/** O "chute" (S9 item 3; bug #12062 do OBS 31): `plain` = `SetInputSettings {device}`; `reset` = '' e depois o valor. */
export async function kick(obs: TakeObs, input: string, value: string, variant: 'plain' | 'reset'): Promise<void> {
  if (variant === 'reset') await obs.request('SetInputSettings', { inputName: input, inputSettings: { device: '' }, overlay: true });
  await obs.request('SetInputSettings', { inputName: input, inputSettings: { device: value }, overlay: true });
}

/** A fonte com quadros nativos (1170×2532) e não preta; senão chuta (até 3 vezes, 15 s cada) → `E_OBS_SOURCE`. */
export async function ensureLiveSource(obs: TakeObs, target: LiveTarget, clock: TakeClock, log: Log = () => {}): Promise<{ w: number; h: number; kicked: number }> {
  const { sceneItemId } = await get<{ sceneItemId: number }>(obs, 'GetSceneItemId', { sceneName: target.scene, sourceName: target.source });
  const read = (): Promise<LiveState> => liveState(obs, target.scene, target.source, sceneItemId);
  let waited = await pollUntil(read, isNativeLive, SOURCE_FIRST_LOOK_MS, SOURCE_POLL_MS, clock);
  let kicked = 0;
  while (!waited.ok && kicked < MAX_KICKS) {
    const items = (await get<{ propertyItems?: PropertyItem[] }>(obs, 'GetInputPropertiesListPropertyItems', { inputName: target.source, propertyName: 'device' })).propertyItems ?? [];
    const value = resolveDevice(items, target.deviceName);
    if (value === null) {
      throw new ContrarregraError('E_OBS_SOURCE', `o OBS não lista o aparelho "${target.deviceName}" na fonte "${target.source}": confira o cabo e se o iPhone está destravado`, {
        source: target.source,
        device: target.deviceName,
      });
    }
    const last = waited.last;
    log(`obs: fonte "${target.source}" sem quadros nativos (${last === null ? 'sem leitura' : `${last.w}×${last.h}${last.nonBlack ? '' : ', preta'}`}); chute ${kicked + 1}`);
    await kick(obs, target.source, value, kicked === 0 ? 'plain' : 'reset');
    kicked += 1;
    waited = await pollUntil(read, isNativeLive, SOURCE_KICK_WAIT_MS, SOURCE_POLL_MS, clock);
  }
  const last = waited.last ?? { w: 0, h: 0, nonBlack: false };
  if (!waited.ok) {
    throw new ContrarregraError('E_OBS_SOURCE', `a fonte "${target.source}" não ficou viva em ${NATIVE_SOURCE.width}×${NATIVE_SOURCE.height} depois de ${kicked} chute(s) (vi ${last.w}×${last.h}${last.nonBlack ? '' : ', preta'})`, {
      source: target.source,
      last,
      kicked,
    });
  }
  return { w: last.w, h: last.h, kicked };
}

/** Pré-voo do OBS: perfil/coleção da configuração (sem escrever nada), sem gravação em curso, fonte viva. */
export async function obsPreflight(obs: TakeObs, target: LiveTarget, clock: TakeClock, log: Log = () => {}): Promise<{ w: number; h: number; kicked: number }> {
  await obs.assertProfile();
  const status = await get<GetRecordStatusResponse>(obs, 'GetRecordStatus');
  if (status.outputActive) {
    throw new ContrarregraError('E_OBS_CONFIG', 'o OBS já está gravando: pare a gravação no OBS antes da tomada (nada foi feito)', { outputActive: true });
  }
  return ensureLiveSource(obs, target, clock, log);
}

// ── Disco (HC-11) ─────────────────────────────────────────────────────────────────────────────────

/** Bytes estimados: `bitrate × duração × 1,25` (S9 item 4). */
export function estimateRecordingBytes(bitrateKbps: number, durationMs: number): number {
  return ((bitrateKbps * 1000) / 8) * (durationMs / 1000) * 1.25;
}

/** Livre exigido: `max(disk.minFreeGiB, estimativa + 2 GiB)` (trilha do demo: só a gravação, sem `review`/`final`). */
export function requiredFreeBytes(estimateBytes: number, minFreeGiB: number): number {
  return Math.max(minFreeGiB * GiB, estimateBytes + 2 * GiB);
}

/** Bytes livres no volume de `dir` (`fs.statfs` na pasta existente mais próxima). */
export async function freeBytesAt(dir: string): Promise<number> {
  let at = dir;
  while (!existsSync(at) && dirname(at) !== at) at = dirname(at);
  const s = statfsSync(at);
  return Number(s.bavail) * Number(s.bsize);
}

export interface DiskCheck {
  freeBytes: number;
  /** `GetStats.availableDiskSpace` em bytes (`null` sem leitura). */
  freeObsBytes: number | null;
  estimateBytes: number;
  requiredBytes: number;
  estimateMs: number;
}

/** Confere o disco antes de gravar; abaixo do limite → `E_DISK_LOW` e nada é gravado (AC-9.4). */
export async function checkDisk(
  obs: TakeObs | undefined,
  options: { dir: string; estimateMs: number; bitrateKbps: number; minFreeGiB: number; freeBytes: (dir: string) => Promise<number> },
): Promise<DiskCheck> {
  const fsFree = await options.freeBytes(options.dir);
  let freeObsBytes: number | null = null;
  if (obs !== undefined) {
    try {
      const mib = (await get<GetStatsResponse>(obs, 'GetStats')).availableDiskSpace;
      if (Number.isFinite(mib)) freeObsBytes = mib * 1024 * 1024;
    } catch {
      freeObsBytes = null;
    }
  }
  const freeBytes = freeObsBytes === null ? fsFree : Math.min(fsFree, freeObsBytes);
  const estimateBytes = estimateRecordingBytes(options.bitrateKbps, options.estimateMs);
  const requiredBytes = requiredFreeBytes(estimateBytes, options.minFreeGiB);
  const check: DiskCheck = { freeBytes, freeObsBytes, estimateBytes, requiredBytes, estimateMs: options.estimateMs };
  if (freeBytes < requiredBytes) {
    throw new ContrarregraError(
      'E_DISK_LOW',
      `disco abaixo do limite (HC-11): ${(freeBytes / GiB).toFixed(2)} GiB livres em ${options.dir}, preciso de ${(requiredBytes / GiB).toFixed(2)} GiB para ~${Math.ceil(options.estimateMs / 60_000)} min; nada foi gravado`,
      { ...check },
    );
  }
  return check;
}

/** O `ffprobe` fixado (`paths.ffprobe`, versão conferida; nunca o do PATH): `true` quando o arquivo é legível. */
export async function ffprobeChecker(config: Config): Promise<(file: string) => Promise<boolean>> {
  const ff = await openFfmpeg(config);
  return async (file) => {
    try {
      await runFfprobe(ff, ['-show_entries', 'format=duration', '-of', 'csv=p=0', file], { timeoutMs: 30_000 });
      return true;
    } catch {
      return false;
    }
  };
}

// ── Gravação (S9 item 5) ──────────────────────────────────────────────────────────────────────────

function waitRecordState(obs: TakeObs, state: string, timeoutMs: number): { done: Promise<ObsEvent>; cancel(): void } {
  let cancel = (): void => {};
  const done = new Promise<ObsEvent>((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(new Error(`RecordStateChanged ${state} não veio em ${timeoutMs} ms`));
    }, timeoutMs);
    const off = obs.onEvent((event) => {
      if (event.eventType !== 'RecordStateChanged' || event.eventData['outputState'] !== state) return;
      clearTimeout(timer);
      off();
      resolve(event);
    });
    cancel = () => {
      clearTimeout(timer);
      off();
    };
  });
  done.catch(() => {});
  return { done, cancel };
}

export interface RecordingDeps {
  clock: TakeClock;
  /** `ffprobe` legível (a finalização acabou). */
  probeOk: (file: string) => Promise<boolean>;
  log?: Log;
  /**
   * Uma conexão nova com o OBS, usada uma vez se a da tomada cair (`E_OBS_UNREACHABLE`) na hora de parar a
   * gravação ou de devolver a pasta: a gravação nunca fica órfã por causa da conexão.
   */
  reconnect?: () => Promise<TakeObs>;
  /** Só para testes: prazos das confirmações do OBS (padrão 5 s, 10 s e 5 s). */
  confirmMs?: { started?: number; stopped?: number; paused?: number };
}

export interface ActiveRecording extends TakeRecorder {
  /** O registro da gravação (atualizado no `stop`). */
  readonly info: RecordingInfo;
  /** A gravação está pausada (`PauseRecord` confirmado e sem `ResumeRecord` depois). */
  readonly paused: boolean;
  /**
   * Para (`StopRecord` → `STOPPED`), espera a finalização, renomeia para `recording.mp4` e devolve a pasta
   * de gravação anterior — esta sempre, mesmo se algo antes falhar. Idempotente.
   */
  stop(): Promise<RecordingInfo>;
}

/** Espera o arquivo ficar pronto: tamanho estável por 500 ms e `ffprobe` legível, prazo 60 s. */
async function finalize(file: string, deps: RecordingDeps): Promise<number> {
  const start = deps.clock.now();
  let last = -1;
  let stableSince = start;
  for (;;) {
    let size = -1;
    try {
      size = statSync(file).size;
    } catch {
      // ainda não existe
    }
    if (size !== last) {
      last = size;
      stableSince = deps.clock.now();
    } else if (size >= 0 && deps.clock.now() - stableSince >= STABLE_MS && (await deps.probeOk(file))) {
      return deps.clock.now() - start;
    }
    if (deps.clock.now() - start > FINALIZE_TIMEOUT_MS) {
      throw new ContrarregraError('E_OBS_CONFIG', `a gravação ${file} não finalizou em ${FINALIZE_TIMEOUT_MS / 1000} s (tamanho instável ou ffprobe ilegível); o arquivo ficou como está`, { file });
    }
    await deps.clock.sleep(FINALIZE_POLL_MS);
  }
}

/** Renomeia para `recording.mp4` se a gravação está direto na pasta da tomada e o nome está livre. */
function moveIntoPlace(file: string, dir: string): string {
  try {
    const real = realpathSync(file);
    const target = join(realpathSync(dir), RECORDING_FILE);
    if (dirname(real) !== dirname(target) || real === target || existsSync(target)) return real;
    renameSync(real, target);
    return target;
  } catch {
    return file;
  }
}

const MEDIA = /\.(mp4|mov|mkv|flv)$/i;

/** A gravação mais nova na pasta da tomada (quando a conexão caiu e o caminho do `StopRecord` se perdeu). */
function newestRecording(dir: string): string | undefined {
  let newest: { path: string; mtimeMs: number } | undefined;
  for (const name of readdirSync(dir)) {
    if (!MEDIA.test(name)) continue;
    const path = join(dir, name);
    const { mtimeMs } = statSync(path);
    if (newest === undefined || mtimeMs > newest.mtimeMs) newest = { path, mtimeMs };
  }
  return newest?.path;
}

function connectionLost(error: unknown): boolean {
  return isContrarregraError(error, 'E_OBS_UNREACHABLE');
}

/**
 * Pasta da tomada → `SetRecordDirectory` → `StartRecord` → espera `STARTED` (≤ 5 s; confirma por
 * `GetRecordStatus`). Se não começar: `StopRecord` (ignorando erro, para nenhuma gravação ficar órfã),
 * devolve a pasta anterior e lança (`E_OBS_CONFIG`, E-9.5).
 */
export async function startRecording(obs: TakeObs, dir: string, deps: RecordingDeps): Promise<ActiveRecording> {
  const log = deps.log ?? (() => {});
  const previous = (await get<{ recordDirectory: string }>(obs, 'GetRecordDirectory')).recordDirectory;
  let connection = obs;
  let reconnected = false;
  /** Roda `fn` na conexão atual; se ela caiu, reconecta uma vez e tenta de novo. */
  const withReconnect = async <T>(what: string, fn: (conn: TakeObs) => Promise<T>): Promise<T> => {
    try {
      return await fn(connection);
    } catch (error) {
      if (!connectionLost(error) || reconnected || deps.reconnect === undefined) throw error;
      reconnected = true;
      log(`obs: a conexão caiu (${(error as Error).message}); reconectando uma vez para ${what}`);
      connection = await deps.reconnect();
      return fn(connection);
    }
  };
  const restore = async (): Promise<boolean> => {
    try {
      await withReconnect('devolver a pasta de gravação', (conn) => conn.request('SetRecordDirectory', { recordDirectory: previous }));
      return true;
    } catch (error) {
      log(`obs: não consegui devolver a pasta de gravação ${previous}: ${(error as Error).message}`);
      return false;
    }
  };
  const recordDir = realpathSync(dir);
  await obs.request('SetRecordDirectory', { recordDirectory: recordDir });
  const info: RecordingInfo = { file: null, startedAt: '', startedAtMs: 0, previousDirectory: previous };
  try {
    const started = waitRecordState(obs, STATE_STARTED, deps.confirmMs?.started ?? STARTED_TIMEOUT_MS);
    try {
      await obs.request('StartRecord');
      await started.done;
    } catch (error) {
      started.cancel();
      const status = await get<GetRecordStatusResponse>(obs, 'GetRecordStatus').catch(() => ({ outputActive: false }) as GetRecordStatusResponse);
      if (!status.outputActive) {
        // Sem confirmação: pode ter começado mesmo assim; para por garantia (sem gravação, o OBS só recusa).
        await obs.request('StopRecord').catch(() => {});
        throw new ContrarregraError('E_OBS_CONFIG', `a gravação não começou em ${STARTED_TIMEOUT_MS / 1000} s (${(error as Error).message}); olhe se há um diálogo aberto no OBS`, {
          cause: (error as Error).message,
        });
      }
    }
  } catch (error) {
    info.directoryRestored = await restore();
    throw error;
  }
  info.startedAtMs = deps.clock.now();
  info.startedAt = new Date(info.startedAtMs).toISOString();

  let paused = false;

  /** `StopRecord` e o `STOPPED`; devolve o caminho (do evento, ou da resposta) e se o `STOPPED` veio. */
  const stopRequest = async (conn: TakeObs): Promise<{ file: string; confirmed: boolean }> => {
    const stopped = waitRecordState(conn, STATE_STOPPED, deps.confirmMs?.stopped ?? STOPPED_TIMEOUT_MS);
    try {
      const response = await conn.request<{ outputPath?: string }>('StopRecord');
      info.stoppedAtMs = deps.clock.now();
      info.stoppedAt = new Date(info.stoppedAtMs).toISOString();
      let file = typeof response.data.outputPath === 'string' ? response.data.outputPath : '';
      try {
        const event = await stopped.done;
        const path = event.eventData['outputPath'];
        if (typeof path === 'string' && path !== '') file = path;
        return { file, confirmed: true };
      } catch (error) {
        log(`obs: ${(error as Error).message}; sigo com o caminho do StopRecord`);
        return { file, confirmed: false };
      }
    } finally {
      stopped.cancel();
    }
  };

  /** `StopRecord` → `STOPPED` → finalização → `recording.mp4`, numa conexão (pausada: para direto). */
  const stopOn = async (conn: TakeObs): Promise<void> => {
    let { file, confirmed } = await stopRequest(conn);
    if (!confirmed && paused) {
      const status = await get<GetRecordStatusResponse>(conn, 'GetRecordStatus').catch(() => undefined);
      if (status?.outputActive === true && status.outputPaused) {
        log('obs: o OBS não parou a gravação pausada; ResumeRecord de emergência e StopRecord de novo');
        await conn.emergencyResumeRecord().catch(() => {});
        paused = false;
        const again = await stopRequest(conn);
        file = again.file === '' ? file : again.file;
      }
    }
    paused = false;
    if (file === '') throw new ContrarregraError('E_OBS_CONFIG', 'o OBS não disse o caminho da gravação', {});
    await settle(file);
  };

  /** `PauseRecord`/`ResumeRecord` confirmados (evento ou `GetRecordStatus.outputPaused`, ≤ 5 s). */
  const setPaused = async (want: boolean): Promise<void> => {
    const what = want ? 'pausou' : 'retomou';
    const confirmMs = deps.confirmMs?.paused ?? PAUSE_CONFIRM_MS;
    const changed = waitRecordState(connection, want ? STATE_PAUSED : STATE_RESUMED, confirmMs);
    try {
      await (want ? connection.pauseRecord() : connection.resumeRecord());
      await changed.done;
    } catch (error) {
      changed.cancel();
      const status = await get<GetRecordStatusResponse>(connection, 'GetRecordStatus').catch(() => undefined);
      if (status?.outputActive !== true || status.outputPaused !== want) {
        throw new ContrarregraError('E_OBS_CONFIG', `a gravação não ${what} em ${confirmMs / 1000} s (${(error as Error).message})`, {
          want: want ? 'paused' : 'resumed',
          status: status === undefined ? null : { outputActive: status.outputActive, outputPaused: status.outputPaused },
        });
      }
    }
    paused = want;
  };
  const settle = async (file: string): Promise<void> => {
    info.obsFile = file;
    info.file = file;
    info.finalizeMs = await finalize(file, deps);
    info.sizeBytes = statSync(file).size;
    info.file = moveIntoPlace(file, dir);
  };

  let stopping: Promise<RecordingInfo> | undefined;
  const stop = async (): Promise<RecordingInfo> => {
    try {
      await withReconnect('parar a gravação', async (conn) => {
        if (!reconnected) return stopOn(conn);
        // Conexão nova: o StopRecord da velha pode ter chegado ao OBS antes de ela cair.
        const status = await get<GetRecordStatusResponse>(conn, 'GetRecordStatus');
        if (status.outputActive) return stopOn(conn);
        info.stoppedAtMs ??= deps.clock.now();
        info.stoppedAt ??= new Date(info.stoppedAtMs).toISOString();
        const found = newestRecording(dir);
        if (found === undefined) throw new ContrarregraError('E_OBS_CONFIG', `o OBS não está gravando e não há gravação em ${dir}`, { dir });
        return settle(found);
      });
    } finally {
      info.directoryRestored = await restore();
    }
    return info;
  };

  return {
    info,
    get paused() {
      return paused;
    },
    pause: () => setPaused(true),
    resume: () => setPaused(false),
    outputMs: async () => (await get<GetRecordStatusResponse>(connection, 'GetRecordStatus')).outputDuration,
    chapter: async (name) => {
      await connection.request('CreateRecordChapter', { chapterName: name });
    },
    stop: () => (stopping ??= stop()),
  };
}
