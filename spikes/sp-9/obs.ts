// Operações do OBS do SP-9 (T-0.27; S9 itens 3–5), adaptadas de `spikes/sp-5/obs.ts`: instantâneo só de leitura,
// fonte viva e "chute" (S9 item 3), gravação com a conferência de disco (HC-11) que para quando a troca acaba (ou no
// teto `maxS`), e a devolução da pasta de gravação. Toda escrita vai pelo `ObsClient` de `mac/src/obs/client.ts`, cuja
// guarda relê o perfil e a coleção antes de cada uma e recusa fora do "Contrarregra" (P-6). O SP-9 só escreve:
// `SetRecordDirectory` (devolvida no fim), o chute (`SetInputSettings {device}` com o mesmo valor), `StartRecord` e
// `StopRecord`. Nunca troca de perfil, nunca mexe em parâmetro de perfil, vídeo ou codificador. Código de spike.

import { readdirSync, realpathSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

import { isContrarregraError } from '../../mac/src/core/errors.ts';
import { ADV_FILE_OUTPUT, type GetRecordStatusResponse, type GetStatsResponse, type ObsClient, type PropertyItem } from '../../mac/src/obs/client.ts';
import type { ObsEvent } from '../../mac/src/obs/ws.ts';
import { base64Image, decodePng, diskCheck, estimateBytes, isOwnFile, nonBlack, type DiskCheck, type Json } from './lib.ts';

/** O que o spike usa do cliente (o `ObsClient` real nos testes também, contra um OBS falso). */
export type Obs = Pick<ObsClient, 'request' | 'onEvent' | 'close' | 'isOpen' | 'versions'>;

export interface ObsTargets {
  scene: string;
  /** `obs.source` ("iPhone"). */
  source: string;
  /** `device.name`: o `itemName` do iPhone na lista do OBS. */
  deviceName: string;
}

export type Log = (k: string, data?: Json) => void;

/** A fonte nativa do iPhone 12 (S9 item 3: tamanho antes do recorte). */
export const NATIVE = { width: 1170, height: 2532 } as const;

async function get<T = Json>(obs: Obs, type: string, data?: Json): Promise<T> {
  if (!type.startsWith('Get')) throw new TypeError(`${type} não é leitura`);
  return (await obs.request<T>(type, data)).data;
}

export function errCode(error: unknown): string {
  if (isContrarregraError(error)) return `${error.code}: ${error.message.slice(0, 240)}`;
  if (error instanceof Error) return error.message.slice(0, 240);
  return String(error).slice(0, 240);
}

// ---------------------------------------------------------------------------------------------------------
// Instantâneo (só pedidos Get*; sem GetSourceScreenshot: nada é capturado)

export interface ObsSnapshot {
  at: string;
  versions: { obs: string | undefined; obsWebSocket: string; rpc: number };
  profile: string;
  collection: string;
  recordActive: boolean;
  recordDirectory: string;
  source: { name: string; kind: string; settings: Json; itemId: number; width: number; height: number };
  device: { name: string; value: string | null; count: number };
  availableDiskMiB: number | null;
}

export function resolveDevice(items: readonly { itemName: string; itemEnabled: boolean; itemValue: unknown }[], name: string): string | null {
  const hit = items.find((i) => i.itemName === name && i.itemEnabled && typeof i.itemValue === 'string' && i.itemValue !== '');
  return hit === undefined ? null : (hit.itemValue as string);
}

export async function readSnapshot(obs: Obs, t: ObsTargets): Promise<ObsSnapshot> {
  const profiles = await get<{ currentProfileName: string }>(obs, 'GetProfileList');
  const collections = await get<{ currentSceneCollectionName: string }>(obs, 'GetSceneCollectionList');
  const record = await get<GetRecordStatusResponse>(obs, 'GetRecordStatus');
  const { recordDirectory } = await get<{ recordDirectory: string }>(obs, 'GetRecordDirectory');
  const { sceneItemId } = await get<{ sceneItemId: number }>(obs, 'GetSceneItemId', { sceneName: t.scene, sourceName: t.source });
  const settings = await get<{ inputSettings: Json; inputKind: string }>(obs, 'GetInputSettings', { inputName: t.source });
  const { sceneItemTransform: tr } = await get<{ sceneItemTransform: Json }>(obs, 'GetSceneItemTransform', { sceneName: t.scene, sceneItemId });
  const devices = (await get<{ propertyItems: PropertyItem[] }>(obs, 'GetInputPropertiesListPropertyItems', { inputName: t.source, propertyName: 'device' })).propertyItems ?? [];
  let availableDiskMiB: number | null = null;
  try {
    availableDiskMiB = (await get<GetStatsResponse>(obs, 'GetStats')).availableDiskSpace;
  } catch {
    availableDiskMiB = null;
  }
  return {
    at: new Date().toISOString(),
    versions: { obs: obs.versions.obsStudioVersion, obsWebSocket: obs.versions.obsWebSocketVersion, rpc: obs.versions.rpcVersion },
    profile: profiles.currentProfileName,
    collection: collections.currentSceneCollectionName,
    recordActive: record.outputActive,
    recordDirectory,
    source: {
      name: t.source,
      kind: settings.inputKind,
      settings: settings.inputSettings ?? {},
      itemId: sceneItemId,
      width: Number(tr['sourceWidth'] ?? 0),
      height: Number(tr['sourceHeight'] ?? 0),
    },
    device: { name: t.deviceName, value: resolveDevice(devices, t.deviceName), count: devices.length },
    availableDiskMiB,
  };
}

export function sameJson(a: unknown, b: unknown): boolean {
  const norm = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(norm);
    if (v !== null && typeof v === 'object') return Object.fromEntries(Object.keys(v as Json).sort().map((k) => [k, norm((v as Json)[k])]));
    return v;
  };
  return JSON.stringify(norm(a)) === JSON.stringify(norm(b));
}

// ---------------------------------------------------------------------------------------------------------
// Fonte viva e chute (S9 item 3) — de spikes/sp-5/obs.ts

export interface LiveState {
  w: number;
  h: number;
  nonBlack: boolean;
}

/** Tamanho da fonte e se a captura não é preta (`GetSourceScreenshot` de 64 px, só na memória). */
export async function liveState(obs: Obs, scene: string, source: string, itemId: number): Promise<LiveState> {
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
  return s.w === NATIVE.width && s.h === NATIVE.height && s.nonBlack;
}

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export async function pollUntil<T>(read: () => Promise<T>, ok: (v: T) => boolean, timeoutMs: number, pollMs: number, clock: Clock): Promise<{ ok: boolean; ms: number; last: T | null }> {
  const start = clock.now();
  let last: T | null = null;
  for (;;) {
    try {
      last = await read();
      if (ok(last)) return { ok: true, ms: clock.now() - start, last };
    } catch {
      // OBS ocupado ou fonte trocando: tenta de novo
    }
    if (clock.now() - start >= timeoutMs) return { ok: false, ms: clock.now() - start, last };
    await clock.sleep(pollMs);
  }
}

/** O "chute" de S9 item 3: `SetInputSettings {device}` com o mesmo valor (overlay). */
export async function kick(obs: Obs, input: string, value: string): Promise<void> {
  await obs.request('SetInputSettings', { inputName: input, inputSettings: { device: value }, overlay: true });
}

// ---------------------------------------------------------------------------------------------------------
// Gravação (S9 itens 4 e 5; HC-11)

export class DiskLowError extends Error {
  readonly check: DiskCheck;
  constructor(check: DiskCheck) {
    super(`disco abaixo do limite (HC-11): livre ${(check.freeBytes / 1024 ** 3).toFixed(2)} GiB < ${(check.requiredBytes / 1024 ** 3).toFixed(2)} GiB; nada foi gravado`);
    this.check = check;
  }
}

export interface RecordDeps {
  /** Bytes livres no volume da pasta (`fs.statfs`). */
  freeBytes(dir: string): Promise<number>;
  /** `ffprobe` do arquivo; `true` quando legível (a finalização acabou). */
  probeOk(file: string): Promise<boolean>;
  now(): number;
  sleep(ms: number): Promise<void>;
  log: Log;
}

export interface RecordOptions {
  /** Pasta do spike (já criada; o caminho real). */
  dir: string;
  /** Teto da gravação (s): a estimativa do HC-11 usa ele, e a gravação para sozinha ao passar dele. */
  maxS: number;
  bitrateKbps: number;
  minFreeGiB: number;
  criticalGiB: number;
  pollMs?: number;
}

export interface Recording {
  file: string;
  name: string;
  sizeBytes: number;
  ino: number;
  birthtimeMs: number;
  disk: DiskCheck;
  startedAtMs: number;
  stoppedAtMs: number;
  /** Parou sozinha: `cap` (passou de `maxS`) ou `disk` (abaixo de `disk.criticalGiB`). */
  autoStopped: 'cap' | 'disk' | null;
  outputStatus: Json | null;
}

export interface ActiveRecording {
  /** `GetRecordStatus.outputDuration` (ms do arquivo) agora; `null` se a gravação já parou. */
  mark(): Promise<{ ms: number; at: number } | null>;
  /** Para (se ainda não parou), espera a finalização e confere que o arquivo é deste spike. */
  stop(): Promise<Recording>;
}

const STATE_STARTED = 'OBS_WEBSOCKET_OUTPUT_STARTED';
const STATE_STOPPED = 'OBS_WEBSOCKET_OUTPUT_STOPPED';

function waitRecordState(obs: Obs, state: string, timeoutMs: number): Promise<ObsEvent> {
  const done = new Promise<ObsEvent>((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(new Error(`RecordStateChanged ${state} não veio em ${timeoutMs} ms`));
    }, timeoutMs);
    const off = obs.onEvent((e) => {
      if (e.eventType !== 'RecordStateChanged' || e.eventData['outputState'] !== state) return;
      clearTimeout(timer);
      off();
      resolve(e);
    });
  });
  done.catch(() => {});
  return done;
}

function listNames(dir: string): Set<string> {
  return new Set(readdirSync(dir));
}

/** Confere que `file` é deste spike (`isOwnFile`); senão lança — nunca se apaga o que não é nosso. */
export function assertOwn(file: string, dir: string, before: ReadonlySet<string>, startedMs: number): { realPath: string; sizeBytes: number; ino: number; birthtimeMs: number } {
  const realPath = realpathSync(file);
  const st = statSync(realPath);
  const name = realPath.slice(realPath.lastIndexOf('/') + 1);
  const check = isOwnFile({ realPath, dirRealPath: realpathSync(dir), name, birthtimeMs: st.birthtimeMs, mtimeMs: st.mtimeMs }, before, startedMs);
  if (!check.ok) throw new Error(`não é arquivo do SP-9: ${check.why}`);
  return { realPath, sizeBytes: st.size, ino: st.ino, birthtimeMs: st.birthtimeMs };
}

/**
 * Começa a gravar na pasta do spike: confere o disco (HC-11; estimativa = `maxS`) e nada grava abaixo do limite
 * (`DiskLowError`); a pasta de gravação do OBS já tem de ser a do spike. Um vigia para a gravação ao passar de `maxS`
 * ou com o disco abaixo de `criticalGiB`.
 */
export async function startRecording(obs: Obs, opts: RecordOptions, deps: RecordDeps): Promise<ActiveRecording> {
  const free = await deps.freeBytes(opts.dir);
  const statsBefore = await get<GetStatsResponse>(obs, 'GetStats');
  const disk = diskCheck(free, statsBefore.availableDiskSpace, estimateBytes(opts.bitrateKbps, opts.maxS), opts.minFreeGiB);
  deps.log('disk', { ...disk });
  if (!disk.ok) throw new DiskLowError(disk);
  const status = await get<GetRecordStatusResponse>(obs, 'GetRecordStatus');
  if (status.outputActive) throw new Error('o OBS já está gravando: nada foi feito');
  const { recordDirectory } = await get<{ recordDirectory: string }>(obs, 'GetRecordDirectory');
  if (realpathSync(recordDirectory) !== realpathSync(opts.dir)) throw new Error(`a pasta de gravação do OBS é ${recordDirectory}, não a do spike`);
  const before = listNames(opts.dir);

  const started = waitRecordState(obs, STATE_STARTED, 5_000);
  const startedAtMs = deps.now();
  await obs.request('StartRecord');
  try {
    await started;
  } catch (error) {
    const s = await get<GetRecordStatusResponse>(obs, 'GetRecordStatus');
    if (!s.outputActive) throw error;
  }
  deps.log('record-started', {});

  let stopRequest: Promise<{ path: string; stoppedAtMs: number }> | undefined;
  let autoStopped: Recording['autoStopped'] = null;
  let outputStatus: Json | null = null;
  const requestStop = (): Promise<{ path: string; stoppedAtMs: number }> => {
    stopRequest ??= (async () => {
      try {
        outputStatus = (await obs.request<Json>('GetOutputStatus', { outputName: ADV_FILE_OUTPUT })).data;
      } catch (error) {
        deps.log('poll-error', { err: errCode(error) });
      }
      const stopped = waitRecordState(obs, STATE_STOPPED, 10_000);
      const response = await obs.request<{ outputPath?: string }>('StopRecord');
      const stoppedAtMs = deps.now();
      let path = typeof response.data.outputPath === 'string' ? response.data.outputPath : '';
      try {
        const event = await stopped;
        if (typeof event.eventData['outputPath'] === 'string' && event.eventData['outputPath'] !== '') path = event.eventData['outputPath'];
      } catch (error) {
        deps.log('record-stop', { warn: errCode(error) });
      }
      return { path, stoppedAtMs };
    })();
    return stopRequest;
  };

  let watching = true;
  const watcher = (async () => {
    let lastStats = deps.now();
    while (watching && stopRequest === undefined) {
      await deps.sleep(opts.pollMs ?? 1_000);
      if (!watching || stopRequest !== undefined) break;
      if (deps.now() - startedAtMs > opts.maxS * 1000) {
        autoStopped = 'cap';
        deps.log('record-cap', { maxS: opts.maxS });
        void requestStop().catch(() => undefined);
        break;
      }
      if (deps.now() - lastStats >= 5_000) {
        lastStats = deps.now();
        try {
          const s = await get<GetStatsResponse>(obs, 'GetStats');
          if (s.availableDiskSpace * 1024 * 1024 < opts.criticalGiB * 1024 ** 3) {
            autoStopped = 'disk';
            deps.log('disk-critical', { availableMiB: s.availableDiskSpace });
            void requestStop().catch(() => undefined);
            break;
          }
        } catch (error) {
          deps.log('poll-error', { err: errCode(error) });
        }
      }
    }
  })();

  return {
    mark: async () => {
      if (stopRequest !== undefined) return null;
      const r = await get<GetRecordStatusResponse>(obs, 'GetRecordStatus');
      return r.outputActive ? { ms: r.outputDuration, at: deps.now() } : null;
    },
    stop: async () => {
      watching = false;
      const { path, stoppedAtMs } = await requestStop();
      await watcher;
      let file = path;
      if (file === '') {
        // Sem o caminho do OBS: o único arquivo novo da pasta do spike.
        const fresh = [...listNames(opts.dir)].filter((n) => !before.has(n) && /\.(mp4|mov|mkv)$/i.test(n));
        if (fresh.length !== 1) throw new Error(`o OBS não disse o caminho da gravação e há ${fresh.length} arquivo(s) novo(s) na pasta`);
        file = join(opts.dir, fresh[0]!);
      }
      const own = assertOwn(file, opts.dir, before, startedAtMs);
      // Finalização (S9 item 5): tamanho estável por 500 ms e ffprobe legível; prazo 60 s.
      const fStart = deps.now();
      let last = -1;
      let stableSince = deps.now();
      for (;;) {
        const size = statSync(own.realPath).size;
        if (size !== last) {
          last = size;
          stableSince = deps.now();
        } else if (deps.now() - stableSince >= 500 && (await deps.probeOk(own.realPath))) {
          break;
        }
        if (deps.now() - fStart > 60_000) throw Object.assign(new Error(`a gravação ${own.realPath} não finalizou em 60 s`), { file: own });
        await deps.sleep(100);
      }
      return {
        file: own.realPath,
        name: own.realPath.slice(own.realPath.lastIndexOf('/') + 1),
        sizeBytes: statSync(own.realPath).size,
        ino: own.ino,
        birthtimeMs: own.birthtimeMs,
        disk,
        startedAtMs,
        stoppedAtMs,
        autoStopped,
        outputStatus,
      };
    },
  };
}

/**
 * Apaga UM arquivo do spike (G4): o mesmo arquivo conferido (direto na pasta do spike, mesmo nome, mesmo inode e, se
 * dado, a mesma criação); nunca pasta, nunca recursivo.
 */
export function discard(file: { file: string; name: string; ino: number; birthtimeMs?: number }, dir: string): { name: string; bytes: number } {
  const realPath = realpathSync(file.file);
  const dirReal = realpathSync(dir);
  const st = statSync(realPath);
  const name = realPath.slice(realPath.lastIndexOf('/') + 1);
  if (realPath !== join(dirReal, name) || name !== file.name || !st.isFile() || st.ino !== file.ino || (file.birthtimeMs !== undefined && st.birthtimeMs !== file.birthtimeMs)) {
    throw new Error(`não é o arquivo do SP-9 conferido (${realPath}): nada foi apagado`);
  }
  unlinkSync(realPath);
  return { name, bytes: st.size };
}

// ---------------------------------------------------------------------------------------------------------
// Devolução

export interface RestoreReport {
  recordDirectoryRestored: boolean;
  settingsEqual: boolean;
  settingsRestored: boolean;
  errors: string[];
}

/** Devolve a pasta de gravação e, se mudaram, os ajustes da fonte (exatamente os do instantâneo, `overlay: false`). */
export async function restoreObs(obs: Obs, t: ObsTargets, snap: ObsSnapshot, log: Log): Promise<RestoreReport> {
  const report: RestoreReport = { recordDirectoryRestored: false, settingsEqual: false, settingsRestored: false, errors: [] };
  try {
    const { recordDirectory } = await get<{ recordDirectory: string }>(obs, 'GetRecordDirectory');
    if (recordDirectory !== snap.recordDirectory) {
      await obs.request('SetRecordDirectory', { recordDirectory: snap.recordDirectory });
      log('restore', { recordDirectory: snap.recordDirectory, from: recordDirectory });
    }
    report.recordDirectoryRestored = true;
  } catch (error) {
    report.errors.push(`pasta de gravação: ${errCode(error)}`);
  }
  try {
    const now = (await get<{ inputSettings: Json }>(obs, 'GetInputSettings', { inputName: t.source })).inputSettings ?? {};
    if (!sameJson(now, snap.source.settings)) {
      await obs.request('SetInputSettings', { inputName: t.source, inputSettings: snap.source.settings, overlay: false });
      log('restore', { settings: snap.source.settings, from: now });
    }
    report.settingsRestored = true;
    const after = (await get<{ inputSettings: Json }>(obs, 'GetInputSettings', { inputName: t.source })).inputSettings ?? {};
    report.settingsEqual = sameJson(after, snap.source.settings);
  } catch (error) {
    report.errors.push(`ajustes da fonte: ${errCode(error)}`);
  }
  return report;
}
