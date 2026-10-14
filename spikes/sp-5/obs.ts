// Operações do OBS do SP-5 (T-0.20; S9 itens 1–5): instantâneo só de leitura, fonte viva e "chute" (S9 item 3), as
// configurações da fonte, a gravação com a conferência de disco (HC-11) e a devolução de tudo ao que era. Toda escrita
// vai pelo `ObsClient` de `mac/src/obs/client.ts`, cuja guarda relê o perfil e a coleção ativos antes de cada uma e
// recusa fora do "Contrarregra" (P-6; nunca no "Untitled" do dono); o spike nunca troca de perfil nem mexe em
// parâmetro de perfil, vídeo ou codificador — só nos ajustes da fonte "iPhone", na pasta de gravação (devolvida no fim)
// e numa fonte temporária que ele mesmo cria e remove. O reinício do OBS (fase `kick`) usa SIGINT (o OBS 31.1.2 trata
// como fechar a janela) e `open -a OBS --args --profile Contrarregra …` só sem processo do OBS (S9 item 2), nunca
// SIGKILL. Código de spike, descartável.

import { execFile } from 'node:child_process';
import { closeSync, openSync, readdirSync, readSync, realpathSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

import { isContrarregraError } from '../../mac/src/core/errors.ts';
import { ADV_FILE_OUTPUT, type GetRecordStatusResponse, type GetStatsResponse, type ObsClient, type PropertyItem } from '../../mac/src/obs/client.ts';
import { IPHONE_TRANSFORM, OBS_APP, obsLaunchArgs } from '../../mac/src/obs/setup.ts';
import type { ObsEvent } from '../../mac/src/obs/ws.ts';
import {
  AVCAPTURE_KIND,
  FAST_KIND,
  NATIVE,
  TEMP_INPUT,
  base64Image,
  decodePng,
  diskCheck,
  estimateBytes,
  isOwnRecording,
  nonBlack,
  resolveDevice,
  sameJson,
  type DiskCheck,
  type Json,
  type RgbImage,
  type SourceConfig,
} from './lib.ts';

/** O que o spike usa do cliente (o `ObsClient` real nos testes também, contra um OBS falso). */
export type Obs = Pick<ObsClient, 'request' | 'onEvent' | 'close' | 'isOpen' | 'closed' | 'profile' | 'collection' | 'versions'>;

export interface ObsTargets {
  scene: string;
  /** `obs.source` ("iPhone"). */
  source: string;
  /** `device.name`: o `itemName` do iPhone na lista do OBS. */
  deviceName: string;
}

export type Log = (k: string, data?: Json) => void;

async function get<T = Json>(obs: Obs, type: string, data?: Json): Promise<T> {
  if (!type.startsWith('Get')) throw new TypeError(`${type} não é leitura`);
  return (await obs.request<T>(type, data)).data;
}

async function attempt<T>(fn: () => Promise<T>): Promise<T | { error: string }> {
  try {
    return await fn();
  } catch (error) {
    return { error: errCode(error) };
  }
}

export function errCode(error: unknown): string {
  if (isContrarregraError(error)) return `${error.code}: ${error.message.slice(0, 240)}`;
  if (error instanceof Error) return error.message.slice(0, 240);
  return String(error).slice(0, 240);
}

// ---------------------------------------------------------------------------------------------------------
// Instantâneo (só leitura)

export interface ListProperty {
  count: number;
  items: { name: string; value: unknown; enabled: boolean }[];
}

export interface ObsSnapshot {
  at: string;
  versions: { obs: string | undefined; obsWebSocket: string; rpc: number };
  profile: string;
  collection: string;
  programScene: string | null;
  sceneItems: { id: number; source: string; enabled: boolean; index: number }[];
  source: {
    name: string;
    kind: string;
    /** `GetInputSettings` (só o que difere do padrão): o que a devolução repõe com `overlay: false`. */
    settings: Json;
    itemId: number;
    transform: Json;
    audioSyncOffsetMs: number | null;
    volumeDb: number | null;
    monitorType: string | null;
    tracks: Json | null;
    muted: boolean | null;
  };
  defaults: { avcapture: Json | { error: string }; fast: Json | { error: string } };
  /** Listas da fonte (sem `device`, que fica só com o iPhone e a contagem). */
  lists: Record<string, ListProperty | { error: string }>;
  device: { name: string; value: string | null; count: number };
  recordDirectory: string;
  record: GetRecordStatusResponse;
  stats: GetStatsResponse;
  video: Json;
  params: Record<string, string | null>;
  /** Sobrou a fonte temporária de uma execução anterior (a devolução a remove). */
  tempInputPresent: boolean;
}

const LIST_PROPERTIES = ['preset', 'supported_format', 'input_format', 'color_space', 'video_range'] as const;
const PROFILE_PARAMS: [string, string][] = [
  ['Output', 'Mode'],
  ['AdvOut', 'RecFormat2'],
  ['AdvOut', 'RecEncoder'],
  ['AdvOut', 'RecTracks'],
  ['AdvOut', 'RecType'],
  ['Output', 'FilenameFormatting'],
  ['Audio', 'SampleRate'],
];

export async function listProperty(obs: Obs, input: string, propertyName: string): Promise<PropertyItem[]> {
  const data = await get<{ propertyItems: PropertyItem[] }>(obs, 'GetInputPropertiesListPropertyItems', { inputName: input, propertyName });
  return Array.isArray(data.propertyItems) ? data.propertyItems : [];
}

export async function itemIdOf(obs: Obs, scene: string, source: string): Promise<number> {
  return (await get<{ sceneItemId: number }>(obs, 'GetSceneItemId', { sceneName: scene, sourceName: source })).sceneItemId;
}

/** Lê tudo o que o spike muda ou mede, sem escrever nada. */
export async function readSnapshot(obs: Obs, t: ObsTargets): Promise<ObsSnapshot> {
  const [profiles, collections] = await Promise.all([
    get<{ currentProfileName: string }>(obs, 'GetProfileList'),
    get<{ currentSceneCollectionName: string }>(obs, 'GetSceneCollectionList'),
  ]);
  const scenes = await get<{ currentProgramSceneName: string | null }>(obs, 'GetSceneList');
  const items = await get<{ sceneItems: { sceneItemId: number; sourceName: string; sceneItemEnabled: boolean; sceneItemIndex: number }[] }>(obs, 'GetSceneItemList', {
    sceneName: t.scene,
  });
  const sceneItems = (items.sceneItems ?? []).map((i) => ({ id: i.sceneItemId, source: i.sourceName, enabled: i.sceneItemEnabled, index: i.sceneItemIndex }));
  const inputs = await get<{ inputs: { inputName: string; inputKind: string }[] }>(obs, 'GetInputList');
  const sourceItem = sceneItems.find((i) => i.source === t.source);
  if (sourceItem === undefined) throw new Error(`a fonte "${t.source}" não está na cena "${t.scene}"`);
  const settings = await get<{ inputSettings: Json; inputKind: string }>(obs, 'GetInputSettings', { inputName: t.source });
  const transform = await get<{ sceneItemTransform: Json }>(obs, 'GetSceneItemTransform', { sceneName: t.scene, sceneItemId: sourceItem.id });
  const sync = await attempt(() => get<{ inputAudioSyncOffset: number }>(obs, 'GetInputAudioSyncOffset', { inputName: t.source }));
  const volume = await attempt(() => get<{ inputVolumeDb: number }>(obs, 'GetInputVolume', { inputName: t.source }));
  const monitor = await attempt(() => get<{ monitorType: string }>(obs, 'GetInputAudioMonitorType', { inputName: t.source }));
  const tracks = await attempt(() => get<{ inputAudioTracks: Json }>(obs, 'GetInputAudioTracks', { inputName: t.source }));
  const muted = await attempt(() => get<{ inputMuted: boolean }>(obs, 'GetInputMute', { inputName: t.source }));
  const defaults = {
    avcapture: await attempt(async () => (await get<{ defaultInputSettings: Json }>(obs, 'GetInputDefaultSettings', { inputKind: AVCAPTURE_KIND })).defaultInputSettings),
    fast: await attempt(async () => (await get<{ defaultInputSettings: Json }>(obs, 'GetInputDefaultSettings', { inputKind: FAST_KIND })).defaultInputSettings),
  };
  const lists: Record<string, ListProperty | { error: string }> = {};
  for (const name of LIST_PROPERTIES) {
    lists[name] = await attempt(async () => {
      const list = await listProperty(obs, t.source, name);
      return { count: list.length, items: list.map((i) => ({ name: i.itemName, value: i.itemValue, enabled: i.itemEnabled })) };
    });
  }
  const devices = await listProperty(obs, t.source, 'device');
  const params: Record<string, string | null> = {};
  for (const [category, name] of PROFILE_PARAMS) {
    const p = await attempt(() => get<{ parameterValue: string | null; defaultParameterValue: string | null }>(obs, 'GetProfileParameter', { parameterCategory: category, parameterName: name }));
    params[`${category}.${name}`] = 'error' in p ? `erro: ${p.error}` : (p.parameterValue ?? p.defaultParameterValue);
  }
  const num = (v: unknown, key: string): number | null => (typeof v === 'object' && v !== null && typeof (v as Json)[key] === 'number' ? ((v as Json)[key] as number) : null);
  return {
    at: new Date().toISOString(),
    versions: { obs: obs.versions.obsStudioVersion, obsWebSocket: obs.versions.obsWebSocketVersion, rpc: obs.versions.rpcVersion },
    profile: profiles.currentProfileName,
    collection: collections.currentSceneCollectionName,
    programScene: scenes.currentProgramSceneName ?? null,
    sceneItems,
    source: {
      name: t.source,
      kind: settings.inputKind,
      settings: settings.inputSettings ?? {},
      itemId: sourceItem.id,
      transform: transform.sceneItemTransform ?? {},
      audioSyncOffsetMs: num(sync, 'inputAudioSyncOffset'),
      volumeDb: num(volume, 'inputVolumeDb'),
      monitorType: 'error' in monitor ? null : monitor.monitorType,
      tracks: 'error' in tracks ? null : tracks.inputAudioTracks,
      muted: 'error' in muted ? null : muted.inputMuted,
    },
    defaults,
    lists,
    device: { name: t.deviceName, value: resolveDevice(devices, t.deviceName), count: devices.length },
    recordDirectory: (await get<{ recordDirectory: string }>(obs, 'GetRecordDirectory')).recordDirectory,
    record: await get<GetRecordStatusResponse>(obs, 'GetRecordStatus'),
    stats: await get<GetStatsResponse>(obs, 'GetStats'),
    video: await get<Json>(obs, 'GetVideoSettings'),
    params,
    tempInputPresent: (inputs.inputs ?? []).some((i) => i.inputName === TEMP_INPUT),
  };
}

// ---------------------------------------------------------------------------------------------------------
// Fonte viva (S9 item 3)

export interface LiveState {
  w: number;
  h: number;
  nonBlack: boolean;
}

/** Tamanho da fonte (`GetSceneItemTransform`) e se a captura não é preta (`GetSourceScreenshot` de 64 px, só na memória). */
export async function liveState(obs: Obs, scene: string, source: string, itemId: number): Promise<LiveState> {
  const { sceneItemTransform: tr } = await get<{ sceneItemTransform: Json }>(obs, 'GetSceneItemTransform', { sceneName: scene, sceneItemId: itemId });
  const w = Number(tr['sourceWidth'] ?? 0);
  const h = Number(tr['sourceHeight'] ?? 0);
  let black = true;
  if (w > 0 && h > 0) {
    try {
      black = !nonBlack(await sourceShot(obs, source, 64));
    } catch {
      black = true;
    }
  }
  return { w, h, nonBlack: !black };
}

export function isNativeLive(s: LiveState): boolean {
  return s.w === NATIVE.width && s.h === NATIVE.height && s.nonBlack;
}

export function hasFrames(s: LiveState): boolean {
  return s.w > 0 && s.h > 0 && s.nonBlack;
}

/** `GetSourceScreenshot` em PNG (largura `width`, ou o tamanho da fonte), decodificado na memória; nada vai para o disco. */
export async function sourceShot(obs: Obs, source: string, width?: number): Promise<RgbImage> {
  const data: Json = { sourceName: source, imageFormat: 'png' };
  if (width !== undefined) data['imageWidth'] = width;
  const { imageData } = await get<{ imageData: string }>(obs, 'GetSourceScreenshot', data);
  return decodePng(base64Image(imageData));
}

export interface Waited<T> {
  ok: boolean;
  ms: number;
  last: T | null;
  polls: number;
}

/**
 * Sonda `read` a cada `pollMs` até `ok(valor)` ou `timeoutMs`; erros de leitura contam como "ainda não". `abort` (ex.:
 * a conexão com o OBS fechou) encerra na hora, sem sucesso.
 */
export async function pollUntil<T>(read: () => Promise<T>, ok: (v: T) => boolean, timeoutMs: number, pollMs: number,
  clock: { now(): number; sleep(ms: number): Promise<void> }, abort?: () => boolean): Promise<Waited<T>> {
  const start = clock.now();
  let last: T | null = null;
  let polls = 0;
  for (;;) {
    if (abort?.() === true) return { ok: false, ms: clock.now() - start, last, polls };
    polls++;
    try {
      last = await read();
      if (ok(last)) return { ok: true, ms: clock.now() - start, last, polls };
    } catch {
      // OBS ocupado ou fonte trocando: tenta de novo
    }
    if (clock.now() - start >= timeoutMs) return { ok: false, ms: clock.now() - start, last, polls };
    await clock.sleep(pollMs);
  }
}

/** O "chute" de S9 item 3: `plain` = SetInputSettings {device}; `reset` = device '' e depois o valor. */
export async function kick(obs: Obs, input: string, value: string, variant: 'plain' | 'reset'): Promise<void> {
  if (variant === 'reset') await obs.request('SetInputSettings', { inputName: input, inputSettings: { device: '' }, overlay: true });
  await obs.request('SetInputSettings', { inputName: input, inputSettings: { device: value }, overlay: true });
}

// ---------------------------------------------------------------------------------------------------------
// Configurações da fonte

export interface Applied {
  config: string;
  /** A fonte medida: "iPhone" ou a temporária do "Capture Card". */
  input: string;
  itemId: number;
  /** O que foi escrito (para o registro). */
  wrote: Json;
  /** Formato escolhido no modo manual. */
  format: { name: string; value: unknown } | null;
}

/**
 * Aplica uma configuração: na própria fonte "iPhone" (por cima dos ajustes atuais) ou, no "Capture Card", soltando o
 * aparelho da "iPhone" (device '') e criando a fonte temporária na cena com o mesmo enquadramento.
 */
export async function applyConfig(obs: Obs, t: ObsTargets, snap: ObsSnapshot, cfg: SourceConfig, deviceValue: string,
  format: { name: string; value: unknown } | null): Promise<Applied> {
  if (cfg.kind === AVCAPTURE_KIND) {
    const wrote: Json = { ...cfg.settings, device: deviceValue };
    if (cfg.needsFormat) wrote['supported_format'] = format?.value;
    await obs.request('SetInputSettings', { inputName: t.source, inputSettings: wrote, overlay: true });
    return { config: cfg.id, input: t.source, itemId: snap.source.itemId, wrote, format };
  }
  await obs.request('SetInputSettings', { inputName: t.source, inputSettings: { device: '' }, overlay: true });
  const settings: Json = { ...cfg.settings, device: deviceValue, buffering: false };
  const created = await obs.request<{ sceneItemId: number }>('CreateInput', {
    sceneName: t.scene,
    inputName: TEMP_INPUT,
    inputKind: FAST_KIND,
    inputSettings: settings,
    sceneItemEnabled: true,
  });
  const itemId = created.data.sceneItemId;
  await obs.request('SetSceneItemTransform', { sceneName: t.scene, sceneItemId: itemId, sceneItemTransform: { ...IPHONE_TRANSFORM } });
  return { config: cfg.id, input: TEMP_INPUT, itemId, wrote: settings, format: null };
}

export interface RestoreReport {
  settingsRestored: boolean;
  settingsEqual: boolean;
  tempRemoved: boolean;
  recordDirectoryRestored: boolean;
  live: boolean;
  kicked: boolean;
  errors: string[];
}

/**
 * Devolve o que o spike mudou: remove a fonte temporária (se houver), repõe os ajustes da "iPhone" exatamente como no
 * instantâneo (`overlay: false`), a pasta de gravação (menos com `recordDirectory: false`, entre uma configuração e
 * outra), e confere a fonte viva (chuta com o mesmo `device` se preciso).
 */
export async function restore(obs: Obs, t: ObsTargets, snap: ObsSnapshot, clock: { now(): number; sleep(ms: number): Promise<void> },
  log: Log, opts: { recordDirectory?: boolean } = {}): Promise<RestoreReport> {
  const report: RestoreReport = { settingsRestored: false, settingsEqual: false, tempRemoved: false, recordDirectoryRestored: false, live: false, kicked: false, errors: [] };
  const step = async (what: string, fn: () => Promise<void>): Promise<void> => {
    try {
      await fn();
    } catch (error) {
      report.errors.push(`${what}: ${errCode(error)}`);
    }
  };
  await step('fonte temporária', async () => {
    const { inputs } = await get<{ inputs: { inputName: string }[] }>(obs, 'GetInputList');
    if ((inputs ?? []).some((i) => i.inputName === TEMP_INPUT)) {
      await obs.request('RemoveInput', { inputName: TEMP_INPUT });
      log('restore', { removed: TEMP_INPUT });
    }
    report.tempRemoved = true;
  });
  await step('ajustes da fonte', async () => {
    const now = (await get<{ inputSettings: Json }>(obs, 'GetInputSettings', { inputName: t.source })).inputSettings ?? {};
    if (!sameJson(now, snap.source.settings)) {
      await obs.request('SetInputSettings', { inputName: t.source, inputSettings: snap.source.settings, overlay: false });
      log('restore', { settings: snap.source.settings, from: now });
    }
    report.settingsRestored = true;
  });
  await step('pasta de gravação', async () => {
    if (opts.recordDirectory === false) {
      report.recordDirectoryRestored = true;
      return;
    }
    const { recordDirectory } = await get<{ recordDirectory: string }>(obs, 'GetRecordDirectory');
    if (recordDirectory !== snap.recordDirectory) {
      await obs.request('SetRecordDirectory', { recordDirectory: snap.recordDirectory });
      log('restore', { recordDirectory: snap.recordDirectory, from: recordDirectory });
    }
    report.recordDirectoryRestored = true;
  });
  await step('fonte viva', async () => {
    const read = (): Promise<LiveState> => liveState(obs, t.scene, t.source, snap.source.itemId);
    let waited = await pollUntil(read, isNativeLive, 8_000, 500, clock);
    const value = typeof snap.source.settings['device'] === 'string' ? (snap.source.settings['device'] as string) : null;
    if (!waited.ok && value !== null && value !== '') {
      await kick(obs, t.source, value, 'plain');
      report.kicked = true;
      waited = await pollUntil(read, isNativeLive, 15_000, 500, clock);
    }
    report.live = waited.ok;
    log('restore', { live: waited.ok, ms: waited.ms, state: waited.last });
  });
  await step('conferência', async () => {
    const now = (await get<{ inputSettings: Json }>(obs, 'GetInputSettings', { inputName: t.source })).inputSettings ?? {};
    report.settingsEqual = sameJson(now, snap.source.settings);
    if (!report.settingsEqual) log('restore-diff', { now, snapshot: snap.source.settings });
  });
  return report;
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
  durationS: number;
  bitrateKbps: number;
  minFreeGiB: number;
  criticalGiB: number;
  /** Roda durante a gravação (toques, avisos); a gravação para depois que ela acaba E `durationS` passou. */
  during?: (ctl: RecordingControl) => Promise<void>;
  pollOutputMs?: number;
  pollStatsMs?: number;
  /** Parar antes do fim (SIGINT do driver). */
  stopRequested?: () => boolean;
}

export interface RecordingControl {
  /** ms desde o STARTED (relógio do Mac). */
  elapsedMs(): number;
  /** `GetRecordStatus.outputDuration` (ms do arquivo) agora, com o hrtime da resposta. */
  outputMs(): Promise<{ ms: number; tRecvNs: string }>;
  /** A gravação já foi parada (disco crítico). */
  aborted(): boolean;
}

export interface Recording {
  file: string;
  name: string;
  sizeBytes: number;
  /** O arquivo conferido no fim da gravação (o apagar exige o mesmo inode e a mesma criação). */
  ino: number;
  birthtimeMs: number;
  disk: DiskCheck;
  startedAtMs: number;
  startedNs: string;
  stoppedAtMs: number;
  finalizeMs: number;
  abortedLowDisk: boolean;
  /** `GetOutputStatus` logo antes do `StopRecord`. */
  outputStatus: Json | null;
  statsBefore: GetStatsResponse;
  statsAfter: GetStatsResponse | null;
}

const STATE_STARTED = 'OBS_WEBSOCKET_OUTPUT_STARTED';
const STATE_STOPPED = 'OBS_WEBSOCKET_OUTPUT_STOPPED';

function waitRecordState(obs: Obs, state: string, timeoutMs: number): { done: Promise<ObsEvent>; cancel(): void } {
  let cancel = (): void => {};
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
    cancel = () => {
      clearTimeout(timer);
      off();
    };
  });
  done.catch(() => {});
  return { done, cancel };
}

function listNames(dir: string): Set<string> {
  return new Set(readdirSync(dir));
}

/** Confere que `file` é gravação deste spike (ver `isOwnRecording`); senão lança — nunca se apaga o que não é nosso. */
export function assertOwn(file: string, dir: string, before: ReadonlySet<string>, startedMs: number): { realPath: string; sizeBytes: number; ino: number; birthtimeMs: number } {
  const realPath = realpathSync(file);
  const st = statSync(realPath);
  const name = realPath.slice(realPath.lastIndexOf('/') + 1);
  const check = isOwnRecording({ realPath, dirRealPath: realpathSync(dir), name, birthtimeMs: st.birthtimeMs, mtimeMs: st.mtimeMs }, before, startedMs);
  if (!check.ok) throw new Error(`não é gravação do SP-5: ${check.why}`);
  return { realPath, sizeBytes: st.size, ino: st.ino, birthtimeMs: st.birthtimeMs };
}

/**
 * Grava `durationS` na pasta do spike: confere o disco (HC-11) e nada grava abaixo do limite (`DiskLowError`);
 * StartRecord → STARTED (≤ 5 s); durante, `GetOutputStatus` a cada 1 s e `GetStats` a cada 5 s (abaixo de
 * `disk.criticalGiB`, para); StopRecord → STOPPED (≤ 10 s) → finalização (tamanho estável por 500 ms e `ffprobe`
 * legível, ≤ 60 s). A pasta de gravação já tem de ser a do spike (`SetRecordDirectory` antes).
 */
export async function record(obs: Obs, opts: RecordOptions, deps: RecordDeps): Promise<Recording> {
  const free = await deps.freeBytes(opts.dir);
  const statsBefore = await get<GetStatsResponse>(obs, 'GetStats');
  const disk = diskCheck(free, statsBefore.availableDiskSpace, estimateBytes(opts.bitrateKbps, opts.durationS), opts.minFreeGiB);
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
  let startedNs: string;
  try {
    startedNs = String((await started.done).tRecvNs);
  } catch (error) {
    const s = await get<GetRecordStatusResponse>(obs, 'GetRecordStatus');
    if (!s.outputActive) throw error;
    startedNs = String(process.hrtime.bigint());
  }
  deps.log('record-started', { startedNs });
  const t0 = deps.now();

  let aborted = false;
  let outputStatus: Json | null = null;
  let stopping = false;
  const poller = (async () => {
    let lastStats = deps.now();
    while (!stopping) {
      await deps.sleep(opts.pollOutputMs ?? 1_000);
      if (stopping) break;
      try {
        outputStatus = (await obs.request<Json>('GetOutputStatus', { outputName: ADV_FILE_OUTPUT })).data;
        deps.log('output', { ...outputStatus });
        if (deps.now() - lastStats >= (opts.pollStatsMs ?? 5_000)) {
          lastStats = deps.now();
          const s = await get<GetStatsResponse>(obs, 'GetStats');
          deps.log('stats', { ...s });
          if (s.availableDiskSpace * 1024 * 1024 < opts.criticalGiB * 1024 ** 3) {
            aborted = true;
            deps.log('disk-critical', { availableMiB: s.availableDiskSpace });
            return;
          }
        }
      } catch (error) {
        deps.log('poll-error', { err: errCode(error) });
      }
    }
  })();

  const control: RecordingControl = {
    elapsedMs: () => deps.now() - t0,
    outputMs: async () => {
      const r = await obs.request<GetRecordStatusResponse>('GetRecordStatus');
      return { ms: r.data.outputDuration, tRecvNs: String(r.tRecvNs) };
    },
    aborted: () => aborted,
  };
  let duringError: unknown;
  try {
    if (opts.during !== undefined) await opts.during(control);
    while (!aborted && !(opts.stopRequested?.() ?? false) && deps.now() - t0 < opts.durationS * 1000) await deps.sleep(Math.min(250, opts.durationS * 1000));
  } catch (error) {
    duringError = error;
  }
  stopping = true;
  await poller;
  try {
    outputStatus = (await obs.request<Json>('GetOutputStatus', { outputName: ADV_FILE_OUTPUT })).data;
  } catch (error) {
    deps.log('poll-error', { err: errCode(error) });
  }
  const stopped = waitRecordState(obs, STATE_STOPPED, 10_000);
  const stopResponse = await obs.request<{ outputPath?: string }>('StopRecord');
  const stoppedAtMs = deps.now();
  let file = typeof stopResponse.data.outputPath === 'string' ? stopResponse.data.outputPath : '';
  try {
    const event = await stopped.done;
    if (typeof event.eventData['outputPath'] === 'string' && event.eventData['outputPath'] !== '') file = event.eventData['outputPath'];
  } catch (error) {
    deps.log('record-stop', { warn: errCode(error) });
  }
  if (file === '') throw new Error('o OBS não disse o caminho da gravação');
  const own = assertOwn(file, opts.dir, before, startedAtMs);
  deps.log('record-file', { name: own.realPath.slice(own.realPath.lastIndexOf('/') + 1), bytes: own.sizeBytes });

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
    if (deps.now() - fStart > 60_000) throw new Error(`a gravação ${own.realPath} não finalizou em 60 s`);
    await deps.sleep(100);
  }
  const finalizeMs = deps.now() - fStart;
  const statsAfter = await attempt(() => get<GetStatsResponse>(obs, 'GetStats'));
  const recording: Recording = {
    file: own.realPath,
    name: own.realPath.slice(own.realPath.lastIndexOf('/') + 1),
    sizeBytes: statSync(own.realPath).size,
    ino: own.ino,
    birthtimeMs: own.birthtimeMs,
    disk,
    startedAtMs,
    startedNs,
    stoppedAtMs,
    finalizeMs,
    abortedLowDisk: aborted,
    outputStatus,
    statsBefore,
    statsAfter: 'error' in statsAfter ? null : statsAfter,
  };
  if (duringError !== undefined) {
    (duringError as { recording?: Recording }).recording = recording;
    throw duringError;
  }
  return recording;
}

/**
 * Apaga UMA gravação do spike (G4): o mesmo arquivo conferido no fim da gravação (direto na pasta do spike, mesmo
 * nome, mesmo inode, mesma criação); nunca pasta, nunca recursivo.
 */
export function discard(recording: Pick<Recording, 'file' | 'name' | 'ino' | 'birthtimeMs'>, dir: string): { name: string; bytes: number } {
  const realPath = realpathSync(recording.file);
  const dirReal = realpathSync(dir);
  const st = statSync(realPath);
  const name = realPath.slice(realPath.lastIndexOf('/') + 1);
  if (realPath !== join(dirReal, name) || name !== recording.name || !st.isFile() || st.ino !== recording.ino || st.birthtimeMs !== recording.birthtimeMs) {
    throw new Error(`não é a gravação do SP-5 conferida (${realPath}): nada foi apagado`);
  }
  unlinkSync(realPath);
  return { name, bytes: st.size };
}

// ---------------------------------------------------------------------------------------------------------
// Processo do OBS (fase `kick`)

export interface ObsProcess {
  pids(): Promise<number[]>;
  /** SIGINT: o OBS 31.1.2 fecha como pelo menu (ProcessSigInt). Nunca SIGKILL. */
  interrupt(pid: number): void;
  /** `open -a OBS --args --profile … --collection … --disable-shutdown-check --disable-missing-files-check`. */
  launch(profile: string, collection: string): Promise<void>;
}

export const realObsProcess: ObsProcess = {
  pids: () =>
    new Promise((resolve, reject) => {
      execFile('/usr/bin/pgrep', ['-x', OBS_APP], { timeout: 5_000 }, (error, stdout) => {
        if (error !== null && error.code !== 1) {
          reject(error);
          return;
        }
        resolve(String(stdout ?? '').split(/\s+/).filter((p) => /^\d+$/.test(p)).map(Number));
      });
    }),
  interrupt: (pid) => {
    process.kill(pid, 'SIGINT');
  },
  launch: (profile, collection) =>
    new Promise((resolve, reject) => {
      execFile('/usr/bin/open', obsLaunchArgs(profile, collection), { timeout: 10_000 }, (error) => (error === null ? resolve() : reject(error)));
    }),
};

// ---------------------------------------------------------------------------------------------------------
// Registro do OBS: só as linhas novas do arquivo mais recente

export function defaultObsLogDir(home: string): string {
  return join(home, 'Library', 'Application Support', 'obs-studio', 'logs');
}

export function newestLog(dir: string): { path: string; size: number } | null {
  let best: { path: string; size: number; mtime: number } | null = null;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.txt')) continue;
    const path = join(dir, name);
    const st = statSync(path);
    if (best === null || st.mtimeMs > best.mtime) best = { path, size: st.size, mtime: st.mtimeMs };
  }
  return best === null ? null : { path: best.path, size: best.size };
}

/** O texto de `path` a partir do byte `offset` (até 4 MiB). */
export function readFrom(path: string, offset: number): string {
  const fd = openSync(path, 'r');
  try {
    const size = statSync(path).size;
    const length = Math.max(0, Math.min(size - offset, 4 * 1024 * 1024));
    const buf = Buffer.alloc(length);
    readSync(fd, buf, 0, length, offset);
    return buf.toString('utf8');
  } finally {
    closeSync(fd);
  }
}
