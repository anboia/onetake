// Testes da T-0.13: `contrarregra obs setup` (spec S9 item 1; constituição P-6; AC-9.8 e AC-9.10 com o
// OBS falso; deploy.md D3.4). O OBS é falso: o servidor WebSocket escrito à mão de `helpers/ws-server.ts`
// (P-2) respondendo como obs-websocket 5.6.2 / OBS 31.1.2, com estado de verdade — perfis com
// parâmetros e vídeo, coleções com cenas, fontes, itens de cena e fontes globais de áudio — e um
// registro de cada pedido com a conexão e o perfil/coleção ativos na chegada. "Processo do OBS" e
// "servidor ligado" são chaves do falso; `open` nunca roda. Nada conecta no OBS real nem lê o Chaveiro.
//
// Correspondência com o OBS real: o `basic.ini` do "Untitled" (AC-9.8) aqui é o estado do perfil
// "Untitled" do falso (parâmetros + vídeo), a coleção "Untitled" e um `basic.ini` de verdade numa pasta
// `basic/` temporária do falso; a prova byte a byte no OBS real é o procedimento com `shasum` do
// relatório da T-0.13 (G5, com o dono). O `recordEncoder.json` (S9 item 1, G1 de 2026-10-13) é escrito
// só nessa pasta temporária, injetada em todo teste: nenhum teste lê ou escreve a pasta real do OBS.

import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import { main } from '../src/cli/main.ts';
import { obsSetup, type ObsCommandDeps } from '../src/commands/obs.ts';
import { loadConfig } from '../src/core/config.ts';
import { isContrarregraError } from '../src/core/errors.ts';
import type { Secret } from '../src/core/secret.ts';
import {
  APPLE_VT_H264_HW,
  CANVAS,
  FLASH_COLOR,
  FLASH_INPUT_KIND,
  IPHONE_INPUT_KIND,
  obsLaunchArgs,
  obsLaunchCommand,
  RECORD_ENCODER_FILE,
  recordEncoderSettings,
  type ObsSetupResult,
} from '../src/obs/setup.ts';
import { OBS_SUBPROTOCOL, type JsonObject } from '../src/obs/ws.ts';
import { startWsServer, type WsTestConnection, type WsTestServer } from './helpers/ws-server.ts';

const UDID = '00008101-001E79203A68001E';
const IPHONE_ITEM = { itemName: 'VIVO_00G7', itemValue: UDID, itemEnabled: true };
const FACETIME_ITEM = { itemName: 'FaceTime HD Camera', itemValue: 'FaceTime-HD-0001', itemEnabled: true };
const P = 'Contrarregra';
const OWNER = 'Untitled';
const LAUNCH = ['-a', 'OBS', '--args', '--profile', 'Contrarregra', '--collection', 'Contrarregra', '--disable-shutdown-check', '--disable-missing-files-check'];
const D34_LINE = 'open -a OBS --args --profile Contrarregra --collection Contrarregra --disable-shutdown-check --disable-missing-files-check';
/** O que o setup põe no `recordEncoder.json` com `record.bitrateKbps` = 16000 (S9 item 1). */
const ENCODER = { rate_control: 'ABR', bitrate: 16000, keyint_sec: 1, profile: 'high' };
/** O `basic.ini` do dono no disco do falso, montado dos parâmetros do perfil dele (o OBS falso nunca o reescreve). */
const OWNER_BASIC_INI = basicIni(OWNER, ownerProfile().params);
/** As duas criações que não passam pela guarda (fase 1 do setup). */
const CREATIONS = new Set(['CreateProfile', 'CreateSceneCollection']);

// ---------------------------------------------------------------------------------------------------
// Estado do OBS falso

interface Video {
  baseWidth: number;
  baseHeight: number;
  outputWidth: number;
  outputHeight: number;
  fpsNumerator: number;
  fpsDenominator: number;
}

interface FakeProfile {
  /** `Categoria.Nome` → valor gravado (o que não está aqui vale o padrão). */
  params: Record<string, string>;
  video: Video;
}

interface FakeInput {
  uuid: string;
  kind: string;
  settings: JsonObject;
  muted: boolean;
  tracks: Record<string, boolean>;
}

interface FakeItem {
  id: number;
  source: string;
  enabled: boolean;
  transform: JsonObject;
}

interface FakeCollection {
  /** Itens de baixo para cima (índice 0 = fundo). */
  scenes: Record<string, FakeItem[]>;
  program: string;
  inputs: Record<string, FakeInput>;
  special: Record<string, string | null>;
  nextItemId: number;
}

const PARAM_DEFAULTS: Readonly<Record<string, string>> = {
  'Output.Mode': 'Simple',
  'AdvOut.RecType': 'Standard',
  'AdvOut.RecFormat2': 'hybrid_mp4',
  'AdvOut.RecEncoder': 'none',
  'AdvOut.RecTracks': '1',
  'Audio.SampleRate': '48000',
  'Audio.ChannelSetup': 'Stereo',
  'SimpleOutput.RecFormat2': 'hybrid_mp4',
};

const ALL_TRACKS = (): Record<string, boolean> => ({ '1': true, '2': true, '3': true, '4': true, '5': true, '6': true });
const NEW_TRANSFORM = (): JsonObject => ({
  positionX: 0,
  positionY: 0,
  rotation: 0,
  scaleX: 1,
  scaleY: 1,
  alignment: 5,
  boundsType: 'OBS_BOUNDS_NONE',
  boundsAlignment: 0,
  boundsWidth: 0,
  boundsHeight: 0,
  cropLeft: 0,
  cropRight: 0,
  cropTop: 0,
  cropBottom: 0,
});

let uuidCounter = 0;
function uuid(): string {
  uuidCounter += 1;
  return `00000000-0000-4000-8000-${String(uuidCounter).padStart(12, '0')}`;
}

function input(kind: string, settings: JsonObject = {}): FakeInput {
  return { uuid: uuid(), kind, settings, muted: false, tracks: ALL_TRACKS() };
}

/** O perfil do dono, como o `basic.ini` desta máquina (pesquisa F18): Simples, fragmented_mov, 1280×720@60. */
function ownerProfile(channelSetup = 'Stereo'): FakeProfile {
  return {
    params: {
      'Output.Mode': 'Simple',
      'AdvOut.RecType': 'Standard',
      'AdvOut.RecFormat2': 'fragmented_mov',
      'AdvOut.RecEncoder': 'none',
      'AdvOut.RecTracks': '1',
      'AdvOut.RecFilePath': '/Users/dono/Movies',
      'SimpleOutput.RecFormat2': 'fragmented_mov',
      'SimpleOutput.RecEncoder': 'apple_h264',
      'SimpleOutput.FilePath': '/Users/dono/Movies',
      'Audio.SampleRate': '48000',
      'Audio.ChannelSetup': channelSetup,
    },
    video: { baseWidth: 1280, baseHeight: 720, outputWidth: 1280, outputHeight: 720, fpsNumerator: 60, fpsDenominator: 1 },
  };
}

/** As cenas do dono: uma câmera e o microfone global. */
function ownerCollection(): FakeCollection {
  return {
    scenes: { Cena: [{ id: 1, source: 'Câmera', enabled: true, transform: NEW_TRANSFORM() }] },
    program: 'Cena',
    inputs: {
      'Câmera': input(IPHONE_INPUT_KIND, { device: FACETIME_ITEM.itemValue, use_preset: true, preset: 'AVCaptureSessionPreset1280x720' }),
      'Mic/Aux': input('coreaudio_input_capture', { device_id: 'default' }),
    },
    special: { desktop1: null, desktop2: null, mic1: 'Mic/Aux', mic2: null, mic3: null, mic4: null },
    nextItemId: 2,
  };
}

/** Um `basic.ini` como o OBS grava: `[General] Name=` e uma seção por categoria dos parâmetros. */
function basicIni(name: string, params: Record<string, string>): string {
  const sections = new Map<string, string[]>([['General', [`Name=${name}`]]]);
  for (const [key, value] of Object.entries(params)) {
    const [section, k] = key.split('.') as [string, string];
    if (!sections.has(section)) sections.set(section, []);
    sections.get(section)!.push(`${k}=${value}`);
  }
  return [...sections].map(([section, lines]) => `[${section}]\n${lines.join('\n')}\n`).join('\n');
}

/** Perfil novo: nada gravado (tudo no padrão), vídeo padrão. */
function newProfile(): FakeProfile {
  return { params: {}, video: { baseWidth: 1920, baseHeight: 1080, outputWidth: 1920, outputHeight: 1080, fpsNumerator: 30, fpsDenominator: 1 } };
}

/** Coleção nova como o OBS a cria sem arquivo (`CreateDefaultScene(true)`): "Scene" e o áudio global ligado. */
function newCollection(): FakeCollection {
  return {
    scenes: { Scene: [] },
    program: 'Scene',
    inputs: {
      'Desktop Audio': input('coreaudio_output_capture', { device_id: 'default' }),
      'Mic/Aux': input('coreaudio_input_capture', { device_id: 'default' }),
    },
    special: { desktop1: 'Desktop Audio', desktop2: null, mic1: 'Mic/Aux', mic2: null, mic3: null, mic4: null },
    nextItemId: 1,
  };
}

interface LogEntry {
  conn: number;
  requestType: string;
  requestData: JsonObject | undefined;
  /** Perfil e coleção ativos quando o pedido chegou. */
  profile: string;
  collection: string;
}

type Reply = { code?: number; comment?: string; data?: JsonObject } | undefined;

interface FakeObsOptions {
  profile?: string;
  collection?: string;
  profiles?: Record<string, FakeProfile>;
  collections?: Record<string, FakeCollection>;
  devices?: { itemName: string; itemValue: string; itemEnabled: boolean }[];
  /** Atraso entre a resposta do `CreateProfile` e a troca de perfil (o OBS enfileira; pesquisa F19). */
  profileSwitchDelayMs?: number;
  /** `true`: o `CreateProfile` cria mas a troca nunca acontece (diálogo aberto no OBS). */
  profileSwitchNever?: boolean;
  /** Há processo do OBS (padrão `true`). */
  running?: boolean;
  /** O servidor WebSocket aceita conexões (padrão `true`). */
  up?: boolean;
  /** Depois de `open`, quanto o falso leva para aceitar conexões (padrão 20 ms). */
  launchDelayMs?: number;
}

/** Pedido que o falso recusa (ex.: `SetVideoSettings` com 500, como com uma saída ativa). */
type FailOn = Record<string, { code: number; comment?: string }>;

const fakes: FakeObs[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(fakes.splice(0).map((f) => f.server.close()));
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function clone<T>(value: T): T {
  return structuredClone(value);
}

class FakeObs {
  profiles: Record<string, FakeProfile>;
  collections: Record<string, FakeCollection>;
  currentProfile: string;
  currentCollection: string;
  devices: { itemName: string; itemValue: string; itemEnabled: boolean }[];
  running: boolean;
  up: boolean;
  recording = false;
  readonly log: LogEntry[] = [];
  readonly launches: string[][] = [];
  /** Conteúdo do `recordEncoder.json` do "Contrarregra" no momento de cada `open` (`null` = não existia). */
  readonly encoderAtLaunch: (string | null)[] = [];
  /** A pasta `basic/` do OBS falso (perfis com `basic.ini`), temporária. */
  readonly basicDir: string;
  /** `paths.cache` dos testes com este falso (o marcador de reinício fica em `obs/`), temporária. */
  readonly cacheDir: string;
  /** Quando o processo do OBS falso começou (epoch ms); muda a cada `open` ou `restart()`. */
  startedAtMs = Date.now() - 3_600_000;
  /** Pedidos que o falso recusa agora. */
  failOn: FailOn = {};
  readonly events: { eventType: string; eventData: JsonObject }[] = [];
  readonly errors: unknown[] = [];
  readonly server: WsTestServer;
  readonly #options: FakeObsOptions;
  readonly #identified = new Set<WsTestConnection>();
  #connections = 0;

  private constructor(server: WsTestServer, options: FakeObsOptions, basicDir: string, cacheDir: string) {
    this.server = server;
    this.basicDir = basicDir;
    this.cacheDir = cacheDir;
    this.#options = options;
    this.profiles = options.profiles ?? { [OWNER]: ownerProfile() };
    this.collections = options.collections ?? { [OWNER]: ownerCollection() };
    this.currentProfile = options.profile ?? OWNER;
    this.currentCollection = options.collection ?? OWNER;
    this.devices = options.devices ?? [FACETIME_ITEM, IPHONE_ITEM];
    this.running = options.running ?? true;
    this.up = options.up ?? true;
    for (const name of Object.keys(this.profiles)) this.#profileFolder(name);
  }

  static async start(options: FakeObsOptions = {}): Promise<FakeObs> {
    let fake: FakeObs | undefined;
    const basicDir = mkdtempSync(join(tmpdir(), 'contrarregra-obs-basic-'));
    tempDirs.push(basicDir);
    mkdirSync(join(basicDir, 'profiles'));
    const cacheDir = mkdtempSync(join(tmpdir(), 'contrarregra-obs-cache-'));
    tempDirs.push(cacheDir);
    const server = await startWsServer({ protocols: [OBS_SUBPROTOCOL], onConnection: (c) => fake!.#accept(c) });
    fake = new FakeObs(server, options, basicDir, cacheDir);
    fakes.push(fake);
    return fake;
  }

  /** Pasta do perfil com o `basic.ini` (como o OBS a cria). */
  #profileFolder(name: string): void {
    const dir = join(this.basicDir, 'profiles', name);
    if (existsSync(dir)) return;
    mkdirSync(dir);
    writeFileSync(join(dir, 'basic.ini'), basicIni(name, this.profiles[name]?.params ?? {}));
  }

  get encoderPath(): string {
    return join(this.basicDir, 'profiles', P, RECORD_ENCODER_FILE);
  }

  get markerPath(): string {
    return join(this.cacheDir, 'obs', 'restart-pending');
  }

  /** O dono fecha e reabre o OBS à mão (no perfil em que estava): processo novo, servidor ligado. */
  restart(): void {
    for (const c of this.server.connections) c.terminate();
    this.running = true;
    this.up = true;
    this.startedAtMs = Date.now();
  }

  get url(): string {
    return this.server.url;
  }

  get profile(): FakeProfile {
    return this.profiles[this.currentProfile]!;
  }

  get collection(): FakeCollection {
    return this.collections[this.currentCollection]!;
  }

  /** Pedidos que escrevem (não `Get*`), a partir de `from` no registro. */
  writes(from = 0): LogEntry[] {
    return this.log.slice(from).filter((e) => !e.requestType.startsWith('Get'));
  }

  /** O que `open -a OBS --args …` faz: abre no perfil/coleção pedidos (se existirem) e liga o servidor. */
  launch(args: string[]): void {
    this.launches.push([...args]);
    this.encoderAtLaunch.push(existsSync(this.encoderPath) ? readFileSync(this.encoderPath, 'utf8') : null);
    const profile = args[args.indexOf('--profile') + 1];
    const collection = args[args.indexOf('--collection') + 1];
    if (profile !== undefined && profile in this.profiles) this.currentProfile = profile;
    if (collection !== undefined && collection in this.collections) this.currentCollection = collection;
    this.running = true;
    this.startedAtMs = Date.now();
    setTimeout(() => {
      this.up = true;
    }, this.#options.launchDelayMs ?? 20).unref();
  }

  /** O dono fecha o OBS (⌘Q). */
  quit(): void {
    this.running = false;
    this.up = false;
    for (const c of this.server.connections) c.terminate();
  }

  broadcast(eventType: string, eventData: JsonObject): void {
    this.events.push({ eventType, eventData });
    for (const c of this.#identified) {
      try {
        c.sendJson({ op: 5, d: { eventType, eventIntent: 2, eventData } });
      } catch {
        // conexão fechando
      }
    }
  }

  #accept(c: WsTestConnection): void {
    if (!this.up) {
      c.terminate();
      return;
    }
    this.#connections += 1;
    const conn = this.#connections;
    void c.closed.then(() => this.#identified.delete(c));
    c.onMessage((text) => {
      try {
        this.#onMessage(c, conn, text);
      } catch (error) {
        this.errors.push(error);
      }
    });
    c.sendJson({ op: 0, d: { obsStudioVersion: '31.1.2', obsWebSocketVersion: '5.6.2', rpcVersion: 1 } });
  }

  #onMessage(c: WsTestConnection, conn: number, text: string): void {
    const { op, d } = JSON.parse(text) as { op: number; d: JsonObject };
    if (op === 1) {
      this.#identified.add(c);
      c.sendJson({ op: 2, d: { negotiatedRpcVersion: 1 } });
      return;
    }
    if (op !== 6) return;
    const requestType = d['requestType'] as string;
    const requestData = d['requestData'] as JsonObject | undefined;
    this.log.push({ conn, requestType, requestData: clone(requestData), profile: this.currentProfile, collection: this.currentCollection });
    const reply: Reply = this.failOn[requestType] ?? this.#handle(requestType, requestData ?? {});
    const code = reply?.code ?? 100;
    const status: JsonObject = { result: code === 100, code };
    if (reply?.comment !== undefined) status['comment'] = reply.comment;
    const response: JsonObject = { requestType, requestId: d['requestId'], requestStatus: status };
    if (reply?.data !== undefined) response['responseData'] = reply.data;
    try {
      c.sendJson({ op: 7, d: response });
    } catch {
      // conexão fechando
    }
  }

  #item(sceneName: unknown, sceneItemId: unknown): FakeItem | undefined {
    return this.collection.scenes[sceneName as string]?.find((i) => i.id === sceneItemId);
  }

  #handle(type: string, d: JsonObject): Reply {
    const col = this.collection;
    switch (type) {
      case 'GetVersion':
        return {
          data: {
            obsVersion: '31.1.2',
            obsWebSocketVersion: '5.6.2',
            rpcVersion: 1,
            availableRequests: ['GetVersion', 'CreateRecordChapter', 'CreateProfile', 'CreateSceneCollection', 'SetProfileParameter'],
            supportedImageFormats: ['png'],
            platform: 'macos',
            platformDescription: 'macOS 26.5',
          },
        };
      case 'GetProfileList':
        return { data: { currentProfileName: this.currentProfile, profiles: Object.keys(this.profiles) } };
      case 'GetSceneCollectionList':
        return { data: { currentSceneCollectionName: this.currentCollection, sceneCollections: Object.keys(this.collections) } };
      case 'CreateProfile': {
        const name = d['profileName'] as string;
        if (name in this.profiles) return { code: 601, comment: 'A profile already exists by that name.' };
        this.profiles[name] = newProfile();
        this.#profileFolder(name);
        if (this.#options.profileSwitchNever) return undefined;
        // Só enfileira: a resposta sai antes da troca (pesquisa F19).
        setTimeout(() => {
          this.broadcast('CurrentProfileChanging', { profileName: this.currentProfile });
          this.currentProfile = name;
          this.broadcast('CurrentProfileChanged', { profileName: name });
        }, this.#options.profileSwitchDelayMs ?? 0);
        return undefined;
      }
      case 'SetCurrentProfile': {
        const name = d['profileName'] as string;
        if (!(name in this.profiles)) return { code: 600 };
        this.currentProfile = name;
        this.broadcast('CurrentProfileChanged', { profileName: name });
        return undefined;
      }
      case 'CreateSceneCollection': {
        const name = d['sceneCollectionName'] as string;
        if (name in this.collections) return { code: 601, comment: 'A scene collection already exists by that name.' };
        this.collections[name] = newCollection();
        this.broadcast('CurrentSceneCollectionChanging', { sceneCollectionName: this.currentCollection });
        this.currentCollection = name;
        this.broadcast('CurrentSceneCollectionChanged', { sceneCollectionName: name });
        return undefined;
      }
      case 'SetCurrentSceneCollection': {
        const name = d['sceneCollectionName'] as string;
        if (!(name in this.collections)) return { code: 600 };
        this.currentCollection = name;
        return undefined;
      }
      case 'GetProfileParameter': {
        const key = `${String(d['parameterCategory'])}.${String(d['parameterName'])}`;
        return { data: { parameterValue: this.profile.params[key] ?? null, defaultParameterValue: PARAM_DEFAULTS[key] ?? null } };
      }
      case 'SetProfileParameter': {
        const key = `${String(d['parameterCategory'])}.${String(d['parameterName'])}`;
        if (d['parameterValue'] === null) delete this.profile.params[key];
        else this.profile.params[key] = d['parameterValue'] as string;
        return undefined;
      }
      case 'GetVideoSettings': {
        // Como o OBS 31.1.2 real (medido na T-0.13): a saída aplicada tem largura múltipla de 4 e altura
        // par; OutputCX = 1170 no perfil vira outputWidth = 1168. A base passa como está.
        const v = this.profile.video;
        return { data: { ...v, outputWidth: v.outputWidth & ~3, outputHeight: v.outputHeight & ~1 } };
      }
      case 'SetVideoSettings':
        if (this.recording) return { code: 500, comment: 'Video settings cannot be changed while an output is active.' };
        Object.assign(this.profile.video, d);
        return undefined;
      case 'GetSceneList':
        return {
          data: {
            currentProgramSceneName: col.program,
            currentPreviewSceneName: null,
            scenes: Object.keys(col.scenes).map((sceneName, sceneIndex) => ({ sceneIndex, sceneName, sceneUuid: `scene-${sceneName}` })),
          },
        };
      case 'CreateScene': {
        const name = d['sceneName'] as string;
        if (name in col.scenes || name in col.inputs) return { code: 601 };
        col.scenes[name] = [];
        return { data: { sceneUuid: `scene-${name}` } };
      }
      case 'SetCurrentProgramScene': {
        const name = d['sceneName'] as string;
        if (!(name in col.scenes)) return { code: 600 };
        col.program = name;
        return undefined;
      }
      case 'GetInputList':
        return {
          data: {
            inputs: Object.entries(col.inputs).map(([inputName, i]) => ({
              inputName,
              inputUuid: i.uuid,
              inputKind: i.kind,
              unversionedInputKind: i.kind.replace(/_v\d+$/, ''),
            })),
          },
        };
      case 'GetInputDefaultSettings': {
        const kind = d['inputKind'];
        if (kind === IPHONE_INPUT_KIND) return { data: { defaultInputSettings: { use_preset: true, preset: 'AVCaptureSessionPresetHigh', buffering: false } } };
        if (kind === FLASH_INPUT_KIND) {
          return { data: { defaultInputSettings: { color: 0xffd1d1d1, width: this.profile.video.baseWidth, height: this.profile.video.baseHeight } } };
        }
        return { data: { defaultInputSettings: {} } };
      }
      case 'CreateInput': {
        const sceneName = d['sceneName'] as string;
        const inputName = d['inputName'] as string;
        if (!(sceneName in col.scenes)) return { code: 600 };
        if (inputName in col.inputs || inputName in col.scenes) return { code: 601 };
        col.inputs[inputName] = input(d['inputKind'] as string, clone((d['inputSettings'] as JsonObject | undefined) ?? {}));
        const id = col.nextItemId++;
        col.scenes[sceneName]!.push({ id, source: inputName, enabled: d['sceneItemEnabled'] !== false, transform: NEW_TRANSFORM() });
        return { data: { inputUuid: col.inputs[inputName].uuid, sceneItemId: id } };
      }
      case 'GetInputSettings': {
        const i = col.inputs[d['inputName'] as string];
        return i === undefined ? { code: 600 } : { data: { inputSettings: clone(i.settings), inputKind: i.kind } };
      }
      case 'SetInputSettings': {
        const i = col.inputs[d['inputName'] as string];
        if (i === undefined) return { code: 600 };
        const settings = clone(d['inputSettings'] as JsonObject);
        i.settings = d['overlay'] === false ? settings : { ...i.settings, ...settings };
        return undefined;
      }
      case 'GetInputPropertiesListPropertyItems': {
        const i = col.inputs[d['inputName'] as string];
        if (i === undefined) return { code: 600 };
        if (i.kind !== IPHONE_INPUT_KIND || d['propertyName'] !== 'device') return { code: 600, comment: 'Unknown property.' };
        return { data: { propertyItems: clone(this.devices) } };
      }
      case 'GetSceneItemList': {
        const items = col.scenes[d['sceneName'] as string];
        if (items === undefined) return { code: 600 };
        return {
          data: {
            sceneItems: items.map((it, sceneItemIndex) => ({
              sceneItemId: it.id,
              sceneItemIndex,
              sourceName: it.source,
              sourceUuid: col.inputs[it.source]?.uuid ?? null,
              inputKind: col.inputs[it.source]?.kind ?? null,
              isGroup: false,
              sceneItemEnabled: it.enabled,
              sceneItemLocked: false,
              sceneItemTransform: clone(it.transform),
              sceneItemBlendMode: 'OBS_BLEND_NORMAL',
            })),
          },
        };
      }
      case 'CreateSceneItem': {
        const items = col.scenes[d['sceneName'] as string];
        if (items === undefined || !((d['sourceName'] as string) in col.inputs)) return { code: 600 };
        const id = col.nextItemId++;
        items.push({ id, source: d['sourceName'] as string, enabled: d['sceneItemEnabled'] !== false, transform: NEW_TRANSFORM() });
        return { data: { sceneItemId: id } };
      }
      case 'SetSceneItemEnabled': {
        const item = this.#item(d['sceneName'], d['sceneItemId']);
        if (item === undefined) return { code: 600 };
        item.enabled = d['sceneItemEnabled'] as boolean;
        return undefined;
      }
      case 'SetSceneItemTransform': {
        const item = this.#item(d['sceneName'], d['sceneItemId']);
        if (item === undefined) return { code: 600 };
        Object.assign(item.transform, d['sceneItemTransform']);
        return undefined;
      }
      case 'SetSceneItemIndex': {
        const items = col.scenes[d['sceneName'] as string];
        const at = items?.findIndex((i) => i.id === d['sceneItemId']) ?? -1;
        if (items === undefined || at < 0) return { code: 600 };
        const [item] = items.splice(at, 1);
        items.splice(d['sceneItemIndex'] as number, 0, item!);
        return undefined;
      }
      case 'GetInputAudioTracks': {
        const i = col.inputs[d['inputName'] as string];
        return i === undefined ? { code: 600 } : { data: { inputAudioTracks: clone(i.tracks) } };
      }
      case 'SetInputAudioTracks': {
        const i = col.inputs[d['inputName'] as string];
        if (i === undefined) return { code: 600 };
        Object.assign(i.tracks, d['inputAudioTracks']);
        return undefined;
      }
      case 'GetSpecialInputs':
        return { data: { ...col.special } };
      case 'GetInputMute': {
        const i = col.inputs[d['inputName'] as string];
        return i === undefined ? { code: 600 } : { data: { inputMuted: i.muted } };
      }
      case 'SetInputMute': {
        const i = col.inputs[d['inputName'] as string];
        if (i === undefined) return { code: 600 };
        i.muted = d['inputMuted'] as boolean;
        return undefined;
      }
      default:
        return { code: 204, comment: 'Unknown request type.' };
    }
  }
}

// ---------------------------------------------------------------------------------------------------
// Ajudantes

function configFor(fake: FakeObs, obs: JsonObject = {}): { configPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'contrarregra-obs-setup-'));
  tempDirs.push(dir);
  const configPath = join(dir, 'config.json');
  // paths.cache do falso: o marcador de reinício sobrevive entre as passadas do mesmo teste.
  writeFileSync(configPath, JSON.stringify({ obs: { url: fake.url, ...obs }, paths: { cache: fake.cacheDir } }));
  return { configPath };
}

function depsFor(fake: FakeObs, extra: ObsCommandDeps = {}): ObsCommandDeps {
  return {
    // O falso não pede senha: o Chaveiro nunca é consultado.
    readPassword: async (): Promise<Secret> => {
      throw new Error('o Chaveiro não deveria ser lido');
    },
    isObsRunning: async () => fake.running,
    obsStartedAt: async () => (fake.running ? fake.startedAtMs : null),
    launchObs: async (args) => fake.launch(args),
    // Sempre a pasta temporária do falso, nunca ~/Library/Application Support/obs-studio.
    obsBasicDir: fake.basicDir,
    launchTimeoutMs: 3_000,
    launchRetryMs: 25,
    ...extra,
  };
}

async function setup(fake: FakeObs, extra: ObsCommandDeps = {}, obs: JsonObject = {}): Promise<ObsSetupResult> {
  const config = loadConfig(configFor(fake, obs));
  return obsSetup({ config }, depsFor(fake, extra));
}

/**
 * O procedimento completo de D3.4: 1.ª passada com o OBS aberto no perfil do dono, o dono fecha o OBS
 * (⌘Q), 2.ª passada com o OBS fechado (escreve o `recordEncoder.json` e reabre o OBS no perfil).
 */
async function fullSetup(fake: FakeObs): Promise<[ObsSetupResult, ObsSetupResult]> {
  const first = await setup(fake);
  fake.quit();
  const second = await setup(fake);
  return [first, second];
}

/** Cada arquivo da pasta (relativo) → sha256; links simbólicos aparecem como `-> alvo`. */
function tree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      const path = join(d, name);
      const st = lstatSync(path);
      if (st.isSymbolicLink()) out[relative(dir, path)] = '-> link';
      else if (st.isDirectory()) walk(path);
      else out[relative(dir, path)] = createHash('sha256').update(readFileSync(path)).digest('hex');
    }
  };
  walk(dir);
  return out;
}

async function rejectsWith(promise: Promise<unknown>, code: string): Promise<Record<string, unknown>> {
  try {
    await promise;
  } catch (error) {
    assert.ok(isContrarregraError(error), `esperava ContrarregraError, veio ${String(error)}`);
    assert.equal(error.code, code, error.message);
    return { ...(error.data ?? {}), message: error.message };
  }
  assert.fail(`esperava ${code}`);
}

/** Toda escrita da reconciliação vem logo depois das duas leituras da guarda, na mesma conexão, no "Contrarregra". */
function assertGuardBeforeEachWrite(fake: FakeObs, from = 0): number {
  const entries = fake.log.slice(from);
  let checked = 0;
  for (const conn of new Set(entries.map((e) => e.conn))) {
    const seq = entries.filter((e) => e.conn === conn);
    seq.forEach((e, i) => {
      if (e.requestType.startsWith('Get') || CREATIONS.has(e.requestType)) return;
      const before = [seq[i - 2]?.requestType, seq[i - 1]?.requestType].sort();
      assert.deepEqual(before, ['GetProfileList', 'GetSceneCollectionList'], `guarda antes de ${e.requestType} (#${i} da conexão ${conn})`);
      assert.equal(e.profile, P, `${e.requestType} chegou com o perfil "${e.profile}" ativo`);
      assert.equal(e.collection, P, `${e.requestType} chegou com a coleção "${e.collection}" ativa`);
      checked += 1;
    });
  }
  return checked;
}

function effective(profile: FakeProfile, key: string): string | undefined {
  return profile.params[key] ?? PARAM_DEFAULTS[key];
}

// ---------------------------------------------------------------------------------------------------

describe('obs setup: primeira passada a partir do perfil do dono (S9 item 1; P-6)', () => {
  test('cria o perfil e a coleção "Contrarregra" e deixa os parâmetros de S9 item 1; relata cada diferença', async () => {
    const fake = await FakeObs.start();
    const result = await setup(fake);

    assert.equal(fake.currentProfile, P);
    assert.equal(fake.currentCollection, P);
    const profile = fake.profiles[P]!;
    assert.equal(effective(profile, 'Output.Mode'), 'Advanced');
    assert.equal(effective(profile, 'AdvOut.RecType'), 'Standard');
    assert.equal(effective(profile, 'AdvOut.RecFormat2'), 'hybrid_mp4');
    assert.equal(effective(profile, 'AdvOut.RecEncoder'), APPLE_VT_H264_HW);
    assert.equal(effective(profile, 'AdvOut.RecTracks'), '1');
    assert.equal(effective(profile, 'Audio.SampleRate'), '48000');
    assert.equal(effective(profile, 'Audio.ChannelSetup'), 'Stereo');
    assert.deepEqual(profile.video, { baseWidth: 1168, baseHeight: 2532, outputWidth: 1168, outputHeight: 2532, fpsNumerator: 60, fpsDenominator: 1 });

    const col = fake.collections[P]!;
    assert.equal(col.program, P);
    const items = col.scenes[P]!;
    assert.deepEqual(items.map((i) => [i.source, i.enabled]), [['iPhone', true], ['Sync Flash', false]], 'iPhone ligado; Sync Flash desligada e acima');
    assert.deepEqual(col.inputs['iPhone']!.kind, IPHONE_INPUT_KIND);
    assert.deepEqual(col.inputs['iPhone']!.settings, { use_preset: true, preset: 'AVCaptureSessionPresetHigh', buffering: false, device: UDID });
    assert.deepEqual(col.inputs['iPhone']!.tracks, { '1': true, '2': false, '3': false, '4': false, '5': false, '6': false });
    const t = items[0]!.transform;
    // Sem escala nem reamostragem: a fonte nativa 1170×2532 entra recortada 1 px de cada lado (S9 item 1).
    assert.deepEqual(
      Object.fromEntries(['boundsType', 'scaleX', 'scaleY', 'rotation', 'alignment', 'positionX', 'positionY', 'cropLeft', 'cropRight', 'cropTop', 'cropBottom'].map((k) => [k, t[k]])),
      { boundsType: 'OBS_BOUNDS_NONE', scaleX: 1, scaleY: 1, rotation: 0, alignment: 5, positionX: 0, positionY: 0, cropLeft: 1, cropRight: 1, cropTop: 0, cropBottom: 0 },
    );
    assert.deepEqual([CANVAS.width, CANVAS.height], [1168, 2532]);
    assert.equal(col.inputs['Sync Flash']!.kind, FLASH_INPUT_KIND);
    assert.deepEqual(col.inputs['Sync Flash']!.settings, { color: FLASH_COLOR, width: CANVAS.width, height: CANVAS.height });
    assert.equal(col.inputs['Desktop Audio']!.muted, true, 'áudio da área de trabalho desligado');
    assert.equal(col.inputs['Mic/Aux']!.muted, true, 'microfone do Mac desligado');

    assert.deepEqual(result.changes.slice(0, 2), [
      { item: 'profile', from: null, to: P },
      { item: 'sceneCollection', from: null, to: P },
    ]);
    const items2 = result.changes.map((c) => c.item);
    // O perfil novo já nasce com RecFormat2 = hybrid_mp4, RecType = Standard, RecTracks = 1 e 48 kHz (padrões):
    // só o que difere é escrito.
    assert.deepEqual(
      result.changes.filter((c) => /^[A-Za-z]+\.[A-Za-z0-9]+$/.test(c.item)).map((c) => c.item),
      ['Output.Mode', 'AdvOut.RecEncoder'],
    );
    for (const expected of ['Output.Mode', 'AdvOut.RecEncoder', 'video', `scene:${P}`, 'programScene', 'input:iPhone', 'input:Sync Flash', 'input:Desktop Audio.muted', 'input:Mic/Aux.muted', 'input:iPhone.device']) {
      assert.ok(items2.includes(expected), `relata ${expected}`);
    }
    assert.deepEqual(result.changes.find((c) => c.item === 'Output.Mode'), { item: 'Output.Mode', from: 'Simple', to: 'Advanced' });
    assert.equal(result.restartRequired, true, 'parâmetro de saída mudou: o OBS precisa remontar as saídas');
    assert.equal(result.launched, false);
    assert.deepEqual(result.device, { name: 'VIVO_00G7', value: UDID });
    // Com o OBS aberto, o recordEncoder.json não é escrito: fica pendente para a passada com o OBS fechado.
    assert.deepEqual(result.recordEncoder, { path: fake.encoderPath, status: 'pending' });
    assert.equal(existsSync(fake.encoderPath), false);
    assert.equal(fake.launches.length, 0);
    assert.deepEqual(fake.errors, []);

    // Só as duas criações saíram da conexão crua; nada de trocar perfil/coleção nem apagar.
    const creations = fake.log.filter((e) => CREATIONS.has(e.requestType));
    assert.deepEqual(creations.map((e) => [e.requestType, e.requestData]), [
      ['CreateProfile', { profileName: P }],
      ['CreateSceneCollection', { sceneCollectionName: P }],
    ]);
    const clientConn = fake.log[0]!.conn;
    assert.ok(creations.every((e) => e.conn !== clientConn), 'criação por outra conexão (sem a guarda)');
    const types = new Set(fake.log.map((e) => e.requestType));
    for (const forbidden of ['SetCurrentProfile', 'SetCurrentSceneCollection', 'RemoveProfile', 'RemoveInput', 'RemoveScene', 'RemoveSceneItem', 'SetRecordDirectory', 'StartRecord']) {
      assert.ok(!types.has(forbidden), `nunca ${forbidden}`);
    }
  });

  test('AC-9.8 (OBS falso): o perfil e as cenas do dono ficam idênticos, e nenhuma escrita chega com o "Untitled" ativo além das duas criações', async () => {
    const fake = await FakeObs.start();
    const ownerBefore = clone(fake.profiles[OWNER]);
    const scenesBefore = clone(fake.collections[OWNER]);
    await setup(fake);

    assert.deepEqual(fake.profiles[OWNER], ownerBefore, 'perfil "Untitled" (parâmetros e vídeo) igual ao de antes');
    assert.deepEqual(fake.collections[OWNER], scenesBefore, 'coleção "Untitled" igual à de antes');
    const whileOwner = fake.writes().filter((e) => e.profile === OWNER || e.collection === OWNER);
    assert.deepEqual(
      whileOwner.map((e) => [e.requestType, e.requestData, e.profile, e.collection]),
      [
        ['CreateProfile', { profileName: P }, OWNER, OWNER],
        ['CreateSceneCollection', { sceneCollectionName: P }, P, OWNER],
      ],
      'só as duas criações chegaram com algo do dono ativo',
    );
    // O arranjo de canais do dono vem do basic.ini dele no disco (só leitura): nada de GetProfileParameter nele.
    assert.deepEqual(fake.log.filter((e) => e.profile === OWNER && e.requestType === 'GetProfileParameter'), []);
    // Logo antes de cada criação, na mesma conexão, as listas foram relidas.
    for (const e of fake.log.filter((x) => CREATIONS.has(x.requestType))) {
      const seq = fake.log.filter((x) => x.conn === e.conn);
      const i = seq.indexOf(e);
      assert.ok(seq.slice(Math.max(0, i - 2), i).some((x) => x.requestType === 'GetProfileList'), `listas relidas antes de ${e.requestType}`);
    }
  });

  test('AC-9.8 (disco do falso): depois do procedimento completo, o basic.ini do "Untitled" está byte a byte igual e o único arquivo que a ferramenta escreveu é o recordEncoder.json do "Contrarregra"', async () => {
    const fake = await FakeObs.start();
    const before = tree(fake.basicDir);
    await fullSetup(fake);
    await setup(fake);
    const after = tree(fake.basicDir);
    assert.equal(after['profiles/Untitled/basic.ini'], before['profiles/Untitled/basic.ini']);
    assert.equal(readFileSync(join(fake.basicDir, 'profiles', OWNER, 'basic.ini'), 'utf8'), OWNER_BASIC_INI);
    const added = Object.keys(after).filter((k) => !(k in before)).sort();
    const changed = Object.keys(before).filter((k) => after[k] !== before[k]);
    // profiles/Contrarregra/basic.ini é do OBS (falso), criado no CreateProfile; o resto é da ferramenta.
    assert.deepEqual(added, ['profiles/Contrarregra/basic.ini', 'profiles/Contrarregra/recordEncoder.json']);
    assert.deepEqual(changed, []);
  });

  test('guarda: toda escrita da reconciliação sai depois de GetProfileList e GetSceneCollectionList, com o "Contrarregra" ativo; nada é escrito antes do CurrentProfileChanged', async () => {
    // O OBS só troca de perfil 300 ms depois de responder ao CreateProfile.
    const fake = await FakeObs.start({ profileSwitchDelayMs: 300 });
    await setup(fake);
    const checked = assertGuardBeforeEachWrite(fake);
    // Output.Mode, RecEncoder, vídeo, cena, cena do programa, iPhone (criação, enquadramento, faixas),
    // Sync Flash, 2 mudos e o device.
    assert.equal(checked, 12, `${checked} escritas conferidas`);
    assert.equal(checked, fake.writes().length - 2, 'todas as escritas menos as duas criações');
    const created = fake.log.findIndex((e) => e.requestType === 'CreateProfile');
    const firstAfter = fake.log.slice(created + 1).find((e) => !e.requestType.startsWith('Get'));
    assert.equal(firstAfter?.requestType, 'CreateSceneCollection');
    assert.equal(firstAfter?.profile, P, 'a coleção só foi criada depois da troca de perfil');
    assert.ok(fake.events.some((e) => e.eventType === 'CurrentProfileChanged'));
  });

  test('mesmas configurações de áudio do perfil do dono: o arranjo de canais é lido do "Untitled" antes de criar o perfil e copiado; 48 kHz', async () => {
    const fake = await FakeObs.start({ profiles: { [OWNER]: ownerProfile('Mono') } });
    const result = await setup(fake);
    assert.equal(effective(fake.profiles[P]!, 'Audio.ChannelSetup'), 'Mono');
    assert.equal(effective(fake.profiles[P]!, 'Audio.SampleRate'), '48000');
    assert.deepEqual(result.changes.find((c) => c.item === 'Audio.ChannelSetup'), { item: 'Audio.ChannelSetup', from: 'Stereo', to: 'Mono' });
    assert.equal(result.changes.some((c) => c.item === 'Audio.SampleRate'), false, '48 kHz já era o valor (padrão): nenhuma escrita');
  });

  test('o OBS cria o perfil mas não confirma a troca no prazo → E_OBS_CONFIG e nada mais é escrito', async () => {
    const fake = await FakeObs.start({ profileSwitchNever: true });
    const data = await rejectsWith(setup(fake, { profileSwitchTimeoutMs: 200 }), 'E_OBS_CONFIG');
    assert.match(String(data['message']), /não confirmou a troca/);
    assert.deepEqual(fake.writes().map((e) => e.requestType), ['CreateProfile']);
    assert.deepEqual(fake.profiles[OWNER], ownerProfile());
  });
});

describe('obs setup: idempotência e reconciliação (AC-9.10)', () => {
  test('a segunda passada não manda nenhuma escrita e relata nada a corrigir', async () => {
    const fake = await FakeObs.start();
    await setup(fake);
    const mark = fake.log.length;
    const again = await setup(fake);
    assert.deepEqual(again.changes, []);
    assert.deepEqual(fake.writes(mark), [], 'nenhuma escrita no OBS na 2.ª passada');
    // Com o OBS aberto o recordEncoder.json segue pendente (só se escreve com o OBS fechado).
    assert.equal(again.recordEncoder.status, 'pending');
    assert.equal(again.restartRequired, true);
  });

  test('depois do procedimento completo (OBS aberto → fechado), a passada seguinte não escreve nada, nem no OBS nem no disco', async () => {
    const fake = await FakeObs.start();
    await fullSetup(fake);
    const st = statSync(fake.encoderPath);
    const mark = fake.log.length;
    const again = await setup(fake);
    assert.deepEqual(again.changes, []);
    assert.equal(again.restartRequired, false);
    assert.equal(again.recordEncoder.status, 'ok');
    assert.deepEqual([statSync(fake.encoderPath).ino, statSync(fake.encoderPath).mtimeMs], [st.ino, st.mtimeMs]);
    assert.deepEqual(fake.writes(mark), [], 'nenhuma escrita na 2.ª passada');
    assert.ok(fake.log.length > mark, 'a 2.ª passada leu tudo de novo');
    assert.ok(fake.log.slice(mark).every((e) => e.profile === P && e.collection === P));
  });

  const cases: { name: string; mutate: (f: FakeObs) => void; write: string; change: { item: string; from: unknown; to: unknown }; restart: boolean }[] = [
    {
      name: 'AC-9.10: AdvOut.RecFormat2 trocado à mão',
      mutate: (f) => {
        f.profiles[P]!.params['AdvOut.RecFormat2'] = 'fragmented_mov';
      },
      write: 'SetProfileParameter',
      change: { item: 'AdvOut.RecFormat2', from: 'fragmented_mov', to: 'hybrid_mp4' },
      restart: true,
    },
    {
      name: 'Output.Mode de volta para Simples',
      mutate: (f) => {
        f.profiles[P]!.params['Output.Mode'] = 'Simple';
      },
      write: 'SetProfileParameter',
      change: { item: 'Output.Mode', from: 'Simple', to: 'Advanced' },
      restart: true,
    },
    {
      name: 'vídeo a 30 fps',
      mutate: (f) => {
        f.profiles[P]!.video.fpsNumerator = 30;
      },
      write: 'SetVideoSettings',
      change: {
        item: 'video',
        from: { fpsNumerator: 30, fpsDenominator: 1, baseWidth: 1168, baseHeight: 2532, outputWidth: 1168, outputHeight: 2532 },
        to: { fpsNumerator: 60, fpsDenominator: 1, baseWidth: 1168, baseHeight: 2532, outputWidth: 1168, outputHeight: 2532 },
      },
      restart: false,
    },
    {
      name: 'preset do iPhone trocado',
      mutate: (f) => {
        f.collections[P]!.inputs['iPhone']!.settings['preset'] = 'AVCaptureSessionPreset1280x720';
      },
      write: 'SetInputSettings',
      change: { item: 'input:iPhone.preset', from: 'AVCaptureSessionPreset1280x720', to: 'AVCaptureSessionPresetHigh' },
      restart: false,
    },
    {
      name: 'recorte esquerdo do iPhone desfeito',
      mutate: (f) => {
        f.collections[P]!.scenes[P]![0]!.transform['cropLeft'] = 0;
      },
      write: 'SetSceneItemTransform',
      change: { item: 'sceneItem:iPhone.cropLeft', from: 0, to: 1 },
      restart: false,
    },
    {
      name: 'iPhone também na faixa 2',
      mutate: (f) => {
        f.collections[P]!.inputs['iPhone']!.tracks['2'] = true;
      },
      write: 'SetInputAudioTracks',
      change: { item: 'input:iPhone.audioTrack2', from: true, to: false },
      restart: false,
    },
    {
      name: 'Sync Flash ligada à mão',
      mutate: (f) => {
        f.collections[P]!.scenes[P]![1]!.enabled = true;
      },
      write: 'SetSceneItemEnabled',
      change: { item: 'sceneItem:Sync Flash.enabled', from: true, to: false },
      restart: false,
    },
    {
      name: 'Sync Flash posta abaixo do iPhone',
      mutate: (f) => {
        f.collections[P]!.scenes[P]!.reverse();
      },
      write: 'SetSceneItemIndex',
      change: { item: 'sceneItem:Sync Flash.index', from: 0, to: 1 },
      restart: false,
    },
    {
      name: 'microfone do Mac ligado de novo',
      mutate: (f) => {
        f.collections[P]!.inputs['Mic/Aux']!.muted = false;
      },
      write: 'SetInputMute',
      change: { item: 'input:Mic/Aux.muted', from: false, to: true },
      restart: false,
    },
  ];
  for (const c of cases) {
    test(`${c.name} → a nova passada corrige só isso e o relata`, async () => {
      const fake = await FakeObs.start();
      await fullSetup(fake);
      c.mutate(fake);
      const before = clone({ profiles: fake.profiles, collections: fake.collections });
      const mark = fake.log.length;
      const result = await setup(fake);
      assert.deepEqual(fake.writes(mark).map((e) => e.requestType), [c.write], 'uma escrita só');
      assert.deepEqual(result.changes, [c.change]);
      assert.equal(result.restartRequired, c.restart);
      assert.deepEqual(fake.profiles[OWNER], before.profiles[OWNER], 'o "Untitled" segue intocado');
      assertGuardBeforeEachWrite(fake, mark);
      assert.deepEqual(await setup(fake).then((r) => r.changes), [], 'e a passada seguinte não acha mais nada');
    });
  }

  test('estado deixado pela versão anterior no OBS real (vídeo 1170 → aplicado 1168, iPhone em "bounds inner" 1170×2532) → corrige vídeo e enquadramento uma vez; a passada seguinte não escreve', async () => {
    const fake = await FakeObs.start();
    await fullSetup(fake);
    // O que a T-0.13 deixou antes do G1 da opção (b): OutputCX/BaseCX 1170 e o item em bounds inner.
    Object.assign(fake.profiles[P]!.video, { baseWidth: 1170, outputWidth: 1170 });
    Object.assign(fake.collections[P]!.scenes[P]![0]!.transform, {
      boundsType: 'OBS_BOUNDS_SCALE_INNER',
      boundsWidth: 1170,
      boundsHeight: 2532,
      cropLeft: 0,
      cropRight: 0,
    });
    const mark = fake.log.length;
    const r = await setup(fake);
    assert.deepEqual(
      r.changes.map((c) => c.item),
      ['video', 'sceneItem:iPhone.boundsType', 'sceneItem:iPhone.cropLeft', 'sceneItem:iPhone.cropRight'],
    );
    assert.deepEqual(r.changes[0], {
      item: 'video',
      from: { fpsNumerator: 60, fpsDenominator: 1, baseWidth: 1170, baseHeight: 2532, outputWidth: 1168, outputHeight: 2532 },
      to: { fpsNumerator: 60, fpsDenominator: 1, baseWidth: 1168, baseHeight: 2532, outputWidth: 1168, outputHeight: 2532 },
    });
    assert.deepEqual(fake.writes(mark).map((e) => e.requestType), ['SetVideoSettings', 'SetSceneItemTransform']);
    assert.equal(r.restartRequired, false, 'vídeo e enquadramento valem na hora: sem reinício');
    const again = await setup(fake);
    assert.deepEqual(again.changes, []);
    assert.equal(again.restartRequired, false);
  });

  test('saída gravada 1170 no perfil e aplicada 1168 pelo OBS (como o real): com o alvo 1168×2532 a passada compara com o aplicado e não reescreve o vídeo', async () => {
    const fake = await FakeObs.start();
    await fullSetup(fake);
    fake.profiles[P]!.video.outputWidth = 1170;
    const mark = fake.log.length;
    const r = await setup(fake);
    const reported = fake.log.slice(mark).find((e) => e.requestType === 'GetVideoSettings');
    assert.ok(reported !== undefined);
    assert.deepEqual(r.changes, []);
    assert.deepEqual(fake.writes(mark), []);
  });

  test('ajustes no padrão do tipo (que o OBS não devolve no GetInputSettings) não são reescritos', async () => {
    const fake = await FakeObs.start();
    await fullSetup(fake);
    // Só o device gravado; preset High, use_preset e buffering ficam no padrão do macos-avcapture.
    fake.collections[P]!.inputs['iPhone']!.settings = { device: UDID };
    const mark = fake.log.length;
    const result = await setup(fake);
    assert.deepEqual(result.changes, []);
    assert.deepEqual(fake.writes(mark), []);
  });

  test('uma fonte "iPhone" de outro tipo → E_OBS_CONFIG pedindo para renomear ou apagar à mão; a ferramenta não apaga nada', async () => {
    const fake = await FakeObs.start();
    await setup(fake);
    const col = fake.collections[P]!;
    col.inputs['iPhone'] = input('color_source_v3', {});
    const mark = fake.log.length;
    const data = await rejectsWith(setup(fake), 'E_OBS_CONFIG');
    assert.deepEqual([data['expectedKind'], data['actualKind']], [IPHONE_INPUT_KIND, 'color_source_v3']);
    assert.deepEqual(fake.writes(mark), []);
  });
});

describe('obs setup: OBS fechado, aberto noutro perfil ou sem o iPhone (S9 item 2; deploy.md D3.4)', () => {
  test('reabrir no perfil: sem processo do OBS, roda o open do D3.4, espera o servidor e confere sem escrever', async () => {
    assert.deepEqual(obsLaunchArgs(P, P), LAUNCH);
    assert.equal(obsLaunchCommand(P, P), D34_LINE, 'a mesma linha de deploy.md D3.4 e S9 item 2');

    const fake = await FakeObs.start();
    const first = await setup(fake);
    assert.equal(first.restartRequired, true);
    // O dono fecha o OBS (⌘Q); mesmo que o OBS voltasse noutro perfil, o --profile o põe no certo.
    fake.quit();
    fake.currentProfile = OWNER;
    fake.currentCollection = OWNER;
    const mark = fake.log.length;
    const second = await setup(fake);
    assert.deepEqual(fake.launches, [LAUNCH], 'open -a OBS --args --profile Contrarregra --collection Contrarregra …');
    assert.equal(second.launched, true);
    // A única coisa escrita nessa passada é o recordEncoder.json, antes do open; no OBS, nada.
    assert.deepEqual(second.changes.map((c) => c.item), ['recordEncoder.rate_control', 'recordEncoder.bitrate', 'recordEncoder.keyint_sec', 'recordEncoder.profile']);
    assert.equal(second.recordEncoder.status, 'written');
    assert.equal(second.restartRequired, false);
    assert.deepEqual(fake.writes(mark), []);
    assert.equal(fake.currentProfile, P);
    assert.deepEqual(JSON.parse(fake.encoderAtLaunch[0]!), ENCODER, 'o arquivo já estava escrito quando o OBS foi aberto');

    fake.quit();
    const mark3 = fake.log.length;
    const third = await setup(fake);
    assert.equal(third.launched, true);
    assert.deepEqual(third.changes, []);
    assert.equal(third.recordEncoder.status, 'ok');
    assert.deepEqual(fake.writes(mark3), []);
  });

  test('sem processo do OBS e o servidor não sobe no prazo → E_OBS_UNREACHABLE dizendo que abriu o OBS', async () => {
    const fake = await FakeObs.start({ running: false, up: false, launchDelayMs: 60_000 });
    const data = await rejectsWith(setup(fake, { launchTimeoutMs: 300 }), 'E_OBS_UNREACHABLE');
    assert.equal(data['launched'], true);
    assert.match(String(data['message']), /abri o OBS \(open -a OBS --args --profile Contrarregra/);
    assert.equal(fake.launches.length, 1);
    assert.deepEqual(fake.log, []);
  });

  test('OBS aberto com o servidor desligado → E_OBS_UNREACHABLE com o menu, e nenhum outro OBS é aberto', async () => {
    const fake = await FakeObs.start({ running: true, up: false });
    const data = await rejectsWith(setup(fake), 'E_OBS_UNREACHABLE');
    assert.match(String(data['message']), /Tools › WebSocket Server Settings/);
    assert.deepEqual(fake.launches, []);
  });

  test('OBS aberto no "Untitled" com o "Contrarregra" já existente → E_OBS_CONFIG com a dica de fechar; nada escrito, nada aberto, nenhuma troca de perfil', async () => {
    const fake = await FakeObs.start();
    await setup(fake);
    fake.currentProfile = OWNER;
    fake.currentCollection = OWNER;
    const mark = fake.log.length;
    const data = await rejectsWith(setup(fake), 'E_OBS_CONFIG');
    assert.match(String(data['hint']), /feche o OBS/);
    assert.ok(String(data['hint']).includes(D34_LINE));
    assert.deepEqual(data['actual'], { profile: OWNER, collection: OWNER });
    assert.deepEqual(fake.writes(mark), []);
    assert.deepEqual(fake.launches, []);

    // Perfil certo e coleção do dono (com a "Contrarregra" existente): também E_OBS_CONFIG, sem escrita.
    fake.currentProfile = P;
    const mark2 = fake.log.length;
    await rejectsWith(setup(fake), 'E_OBS_CONFIG');
    assert.deepEqual(fake.writes(mark2), []);
  });

  test('perfil "Contrarregra" ativo e coleção ainda inexistente → cria só a coleção (com o perfil certo ativo)', async () => {
    const fake = await FakeObs.start({ profiles: { [OWNER]: ownerProfile(), [P]: newProfile() }, profile: P });
    const result = await setup(fake);
    const creations = fake.log.filter((e) => CREATIONS.has(e.requestType));
    assert.deepEqual(creations.map((e) => [e.requestType, e.profile]), [['CreateSceneCollection', P]]);
    assert.deepEqual(result.changes[0], { item: 'sceneCollection', from: null, to: P });
    assert.equal(result.changes.some((c) => c.item === 'profile'), false);
    assert.equal(fake.currentCollection, P);
  });

  test('iPhone fora da lista de dispositivos → E_OBS_SOURCE depois de conferir o resto; com o cabo ligado, a passada seguinte só grava o device', async () => {
    const fake = await FakeObs.start({ devices: [FACETIME_ITEM] });
    const data = await rejectsWith(setup(fake), 'E_OBS_SOURCE');
    assert.deepEqual(data['available'], ['FaceTime HD Camera']);
    assert.equal(data['restartRequired'], true);
    assert.match(String(data['hint']), /ligue o cabo/);
    assert.ok(Array.isArray(data['changes']) && data['changes'].length > 10, 'o resto foi conferido e relatado');
    assert.equal(fake.collections[P]!.inputs['iPhone']!.settings['device'], undefined, 'nenhum device inventado');

    fake.devices = [FACETIME_ITEM, IPHONE_ITEM];
    const mark = fake.log.length;
    const result = await setup(fake);
    assert.deepEqual(result.changes, [{ item: 'input:iPhone.device', from: null, to: UDID }]);
    assert.deepEqual(fake.writes(mark).map((e) => [e.requestType, e.requestData]), [
      ['SetInputSettings', { inputName: 'iPhone', inputSettings: { device: UDID }, overlay: true }],
    ]);
  });
});

describe('recordEncoder.json do perfil "Contrarregra" (S9 item 1; G1 de 2026-10-13)', () => {
  /** Uma pasta fora da pasta `basic/` do falso. */
  function outsideDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'contrarregra-fora-'));
    tempDirs.push(dir);
    return dir;
  }

  test('com o OBS fechado: cria o arquivo antes de abrir o OBS, sem sobra de temporário; a passada seguinte com o OBS fechado não escreve (mesmo inode e mtime)', async () => {
    assert.deepEqual(recordEncoderSettings(16000), ENCODER);
    const fake = await FakeObs.start();
    await setup(fake); // OBS aberto: cria o perfil (o OBS falso cria a pasta)
    fake.quit();
    const r = await setup(fake);
    assert.equal(r.recordEncoder.status, 'written');
    assert.equal(r.recordEncoder.path, fake.encoderPath);
    assert.deepEqual(JSON.parse(readFileSync(fake.encoderPath, 'utf8')), ENCODER);
    assert.deepEqual(r.changes.slice(0, 4), [
      { item: 'recordEncoder.rate_control', from: null, to: 'ABR' },
      { item: 'recordEncoder.bitrate', from: null, to: 16000 },
      { item: 'recordEncoder.keyint_sec', from: null, to: 1 },
      { item: 'recordEncoder.profile', from: null, to: 'high' },
    ]);
    assert.deepEqual(readdirSync(join(fake.basicDir, 'profiles', P)).sort(), ['basic.ini', 'recordEncoder.json'], 'sem temporário sobrando');
    assert.deepEqual(JSON.parse(fake.encoderAtLaunch[0]!), ENCODER, 'escrito antes do open');

    const st = statSync(fake.encoderPath);
    fake.quit();
    const again = await setup(fake);
    assert.equal(again.launched, true);
    assert.equal(again.recordEncoder.status, 'ok');
    assert.deepEqual(again.changes, []);
    const st2 = statSync(fake.encoderPath);
    assert.deepEqual([st2.ino, st2.mtimeMs], [st.ino, st.mtimeMs], 'nenhuma escrita na 2.ª passada');
  });

  test('preserva as outras chaves que o OBS pôs no arquivo (e a ordem) e corrige só as divergentes, relatando cada uma', async () => {
    const fake = await FakeObs.start();
    await setup(fake);
    fake.quit();
    writeFileSync(fake.encoderPath, JSON.stringify({ rate_control: 'CBR', bitrate: 2500, keyint_sec: 1, profile: 'high', bframes: true, max_bitrate: 30000 }, null, 4));
    const r = await setup(fake);
    assert.deepEqual(r.changes, [
      { item: 'recordEncoder.rate_control', from: 'CBR', to: 'ABR' },
      { item: 'recordEncoder.bitrate', from: 2500, to: 16000 },
    ]);
    const after = JSON.parse(readFileSync(fake.encoderPath, 'utf8')) as JsonObject;
    assert.deepEqual(Object.keys(after), ['rate_control', 'bitrate', 'keyint_sec', 'profile', 'bframes', 'max_bitrate']);
    assert.deepEqual(after, { ...ENCODER, bframes: true, max_bitrate: 30000 });
  });

  test('com o OBS aberto só lê: arquivo divergente → pendente e restartRequired; nenhuma escrita, bytes iguais', async () => {
    const fake = await FakeObs.start();
    await fullSetup(fake);
    const divergent = JSON.stringify({ ...ENCODER, keyint_sec: 2, bframes: false });
    writeFileSync(fake.encoderPath, divergent);
    const mark = fake.log.length;
    const r = await setup(fake);
    assert.equal(r.recordEncoder.status, 'pending');
    assert.equal(r.restartRequired, true);
    assert.deepEqual(r.changes, []);
    assert.deepEqual(fake.writes(mark), []);
    assert.equal(readFileSync(fake.encoderPath, 'utf8'), divergent);
    // Fechado o OBS, a passada seguinte corrige só o keyint_sec e mantém o bframes.
    fake.quit();
    const fixed = await setup(fake);
    assert.deepEqual(fixed.changes, [{ item: 'recordEncoder.keyint_sec', from: 2, to: 1 }]);
    assert.deepEqual(JSON.parse(readFileSync(fake.encoderPath, 'utf8')), { ...ENCODER, bframes: false });
  });

  test('o OBS abre entre a conferência e a escrita → E_OBS_CONFIG; nada escrito, nada aberto', async () => {
    const fake = await FakeObs.start();
    await setup(fake);
    fake.quit();
    let calls = 0;
    const data = await rejectsWith(setup(fake, { isObsRunning: async () => ++calls > 1 }), 'E_OBS_CONFIG');
    assert.equal(calls, 2, 'o processo foi conferido de novo logo antes de escrever');
    assert.match(String(data['message']), /o OBS abriu/);
    assert.equal(existsSync(fake.encoderPath), false);
    assert.deepEqual(fake.launches, []);
  });

  test('primeira vez com o OBS fechado (o perfil ainda não existe): a ferramenta não cria a pasta; abre o OBS, cria o perfil e deixa o arquivo pendente', async () => {
    const fake = await FakeObs.start({ running: false, up: false });
    const r = await setup(fake);
    assert.equal(r.launched, true);
    assert.deepEqual(fake.encoderAtLaunch, [null]);
    assert.equal(r.recordEncoder.status, 'pending');
    assert.equal(r.restartRequired, true);
    assert.deepEqual(r.changes[0], { item: 'profile', from: null, to: P });
    assert.equal(existsSync(fake.encoderPath), false);
    fake.quit();
    assert.equal((await setup(fake)).recordEncoder.status, 'written');
  });

  test('nunca fora da pasta do perfil: pasta do perfil que é link simbólico para fora → E_OBS_CONFIG; nada escrito lá nem aberto', async () => {
    const fake = await FakeObs.start({ running: false, up: false });
    const outside = outsideDir();
    writeFileSync(join(outside, 'basic.ini'), `[General]\nName=${P}\n`);
    symlinkSync(outside, join(fake.basicDir, 'profiles', P));
    const data = await rejectsWith(setup(fake), 'E_OBS_CONFIG');
    assert.match(String(data['message']), /link simbólico|não é uma pasta/);
    assert.deepEqual(readdirSync(outside), ['basic.ini']);
    assert.deepEqual(fake.launches, []);
    assert.deepEqual(fake.log, []);
  });

  test('recordEncoder.json que é link simbólico → E_OBS_CONFIG; o alvo fica intocado e o link continua link (com o OBS aberto ou fechado)', async () => {
    const fake = await FakeObs.start();
    await setup(fake);
    const target = join(outsideDir(), 'alvo.json');
    writeFileSync(target, '{"rate_control":"CBR"}');
    symlinkSync(target, fake.encoderPath);
    await rejectsWith(setup(fake), 'E_OBS_CONFIG');
    fake.quit();
    await rejectsWith(setup(fake), 'E_OBS_CONFIG');
    assert.equal(readFileSync(target, 'utf8'), '{"rate_control":"CBR"}');
    assert.ok(lstatSync(fake.encoderPath).isSymbolicLink());
    assert.deepEqual(fake.launches, []);
  });

  test('pasta cujo basic.ini não é do perfil "Contrarregra" → E_OBS_CONFIG e nada escrito', async () => {
    const fake = await FakeObs.start();
    await setup(fake);
    fake.quit();
    writeFileSync(join(fake.basicDir, 'profiles', P, 'basic.ini'), '[General]\nName=Outro\n');
    const data = await rejectsWith(setup(fake), 'E_OBS_CONFIG');
    assert.match(String(data['message']), /Name=Outro|não é do perfil/);
    assert.equal(existsSync(fake.encoderPath), false);
    assert.deepEqual(fake.launches, []);
  });

  test('JSON inválido no arquivo → E_OBS_CONFIG sem sobrescrever', async () => {
    const fake = await FakeObs.start();
    await setup(fake);
    fake.quit();
    writeFileSync(fake.encoderPath, '{ isto não é json');
    await rejectsWith(setup(fake), 'E_OBS_CONFIG');
    assert.equal(readFileSync(fake.encoderPath, 'utf8'), '{ isto não é json');
    assert.deepEqual(fake.launches, []);
  });

  test('obs.profile que não é um nome de pasta simples ("../Untitled") → E_CONFIG antes de qualquer conexão, abertura ou escrita', async () => {
    const fake = await FakeObs.start({ running: false, up: false });
    const before = tree(fake.basicDir);
    for (const profile of ['../Untitled', 'a/b', '.', '..', '']) {
      await rejectsWith(setup(fake, {}, { profile }), 'E_CONFIG');
    }
    assert.deepEqual(fake.log, []);
    assert.deepEqual(fake.launches, []);
    assert.deepEqual(tree(fake.basicDir), before);
  });
});

/** Saída capturada de uma chamada da CLI. */
function cliIo(): { out: string[]; err: string[]; io: { stdout: (t: string) => void; stderr: (t: string) => void } } {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { stdout: (t) => void out.push(t), stderr: (t) => void err.push(t) } };
}

describe('arranjo de canais do dono (S9 item 1): toda passada o reconcilia, lendo o basic.ini do dono no disco', () => {
  test('passada criadora abortada depois do CreateProfile (CreateSceneCollection recusado) → a passada seguinte ainda copia o Mono do dono', async () => {
    const fake = await FakeObs.start({ profiles: { [OWNER]: ownerProfile('Mono') } });
    fake.failOn = { CreateSceneCollection: { code: 702, comment: 'falha de teste' } };
    const data = await rejectsWith(setup(fake), 'E_OBS_CONFIG');
    assert.deepEqual(data['changes'], [{ item: 'profile', from: null, to: P }], 'o erro leva o que já foi feito');
    assert.equal(effective(fake.profiles[P]!, 'Audio.ChannelSetup'), 'Stereo', 'a passada abortada não chegou aos parâmetros');

    fake.failOn = {};
    const r = await setup(fake);
    assert.deepEqual(r.changes.find((c) => c.item === 'Audio.ChannelSetup'), { item: 'Audio.ChannelSetup', from: 'Stereo', to: 'Mono' });
    assert.equal(effective(fake.profiles[P]!, 'Audio.ChannelSetup'), 'Mono');
    assert.equal((await setup(fake)).changes.some((c) => c.item === 'Audio.ChannelSetup'), false, 'e não mexe mais');
  });

  test('passada criadora abortada no prazo do CurrentProfileChanged → com o OBS reaberto no perfil pela ferramenta, a passada copia o Mono do dono', async () => {
    const fake = await FakeObs.start({ profiles: { [OWNER]: ownerProfile('Mono') }, profileSwitchNever: true });
    await rejectsWith(setup(fake, { profileSwitchTimeoutMs: 100 }), 'E_OBS_CONFIG');
    // O OBS ficou no "Untitled" com o perfil já criado: a ferramenta não troca de perfil, pede para fechar.
    await rejectsWith(setup(fake), 'E_OBS_CONFIG');
    fake.quit();
    const r = await setup(fake);
    assert.equal(r.launched, true);
    assert.equal(fake.currentProfile, P);
    assert.deepEqual(r.changes.find((c) => c.item === 'Audio.ChannelSetup'), { item: 'Audio.ChannelSetup', from: 'Stereo', to: 'Mono' });
    assert.equal(effective(fake.profiles[P]!, 'Audio.ChannelSetup'), 'Mono');
    assert.deepEqual(fake.profiles[OWNER], ownerProfile('Mono'), 'o perfil do dono segue intocado');
  });

  test('com o "Contrarregra" ativo e ChannelSetup trocado à mão, a passada corrige pelo basic.ini do dono (sem o perfil do dono ativo)', async () => {
    const fake = await FakeObs.start({ profiles: { [OWNER]: ownerProfile('Mono') } });
    await fullSetup(fake);
    fake.profiles[P]!.params['Audio.ChannelSetup'] = 'Stereo';
    const mark = fake.log.length;
    const r = await setup(fake);
    assert.deepEqual(r.changes, [{ item: 'Audio.ChannelSetup', from: 'Stereo', to: 'Mono' }]);
    assert.ok(fake.log.slice(mark).every((e) => e.profile === P), 'o perfil do dono nunca esteve ativo nessa passada');
  });

  for (const [name, other, expected] of [
    ['dois perfis do dono com o mesmo arranjo → usado', 'Mono', 'Mono'],
    ['dois perfis do dono com arranjos diferentes → ambíguo: o ChannelSetup não é mexido e o setup segue', 'Stereo', 'Stereo'],
  ] as const) {
    test(name, async () => {
      const fake = await FakeObs.start({ profiles: { [OWNER]: ownerProfile('Mono'), Outro: ownerProfile(other) } });
      const r = await setup(fake);
      assert.equal(effective(fake.profiles[P]!, 'Audio.ChannelSetup'), expected);
      assert.equal(r.changes.some((c) => c.item === 'Audio.ChannelSetup'), expected !== 'Stereo');
    });
  }
});

describe('reinício pendente (pesquisa F17): sobrevive entre passadas até o OBS reiniciar; erros relatam o que já foi feito', () => {
  test('erro depois de SetProfileParameter → o texto lista as mudanças e o reinício; a passada seguinte sem reiniciar ainda pede reinício; depois de o OBS reiniciar, limpa', async () => {
    const fake = await FakeObs.start();
    const deps = { config: configFor(fake), obs: depsFor(fake) };
    fake.failOn = { SetVideoSettings: { code: 500, comment: 'Video settings cannot be changed while an output is active.' } };
    const failed = cliIo();
    assert.equal(await main(['obs', 'setup'], { ...deps, io: failed.io }), 1);
    const err = failed.err.join('');
    assert.match(err, /E_OBS_CONFIG: o OBS recusou SetVideoSettings \(código 500/);
    assert.match(err, /\nmudanças feitas antes do erro \(\d+\):\n {2}profile: \(não existia\) → "Contrarregra"\n/);
    assert.match(err, /\n {2}Output\.Mode: "Simple" → "Advanced"\n/);
    assert.match(err, /\nreinício: /);
    assert.ok(existsSync(fake.markerPath), 'marcador em paths.cache');

    const asJson = cliIo();
    assert.equal(await main(['obs', 'setup', '--json'], { ...deps, io: asJson.io }), 1);
    const error = (JSON.parse(asJson.out.join('')) as { error: { code: string; data: { restartRequired: boolean; changes: unknown[] } } }).error;
    assert.equal(error.code, 'E_OBS_CONFIG');
    assert.equal(error.data.restartRequired, true, 'pendente da passada anterior, embora esta não tenha mudado parâmetro');

    fake.failOn = {};
    const next = cliIo();
    assert.equal(await main(['obs', 'setup'], { ...deps, io: next.io }), 0, next.err.join(''));
    assert.match(next.out.join(''), /\n {2}video: /);
    assert.doesNotMatch(next.out.join(''), /Output\.Mode/, 'o parâmetro já está certo no perfil');
    assert.match(next.out.join(''), /\nreinício: /, 'mas o OBS ainda usa a saída antiga');

    const still = cliIo();
    assert.equal(await main(['obs', 'setup'], { ...deps, io: still.io }), 0);
    assert.match(still.out.join(''), /nada a corrigir \(nenhuma escrita\)/);
    assert.match(still.out.join(''), /\nreinício: /);
    assert.ok(existsSync(fake.markerPath));

    fake.restart();
    const done = cliIo();
    assert.equal(await main(['obs', 'setup', '--json'], { ...deps, io: done.io }), 0);
    const result = JSON.parse(done.out.join('')) as ObsSetupResult;
    assert.equal(result.restartRequired, true, 'só o recordEncoder.json segue pendente (o OBS nunca esteve fechado)');
    assert.equal(result.recordEncoder.status, 'pending');
    assert.equal(existsSync(fake.markerPath), false, 'o OBS começou depois da escrita: marcador limpo');
  });

  test('o marcador guarda o instante da 1.ª escrita ainda não aplicada (não é renovado); o OBS aberto pela ferramenta também o limpa', async () => {
    const t0 = Date.now();
    const fake = await FakeObs.start();
    await setup(fake);
    const first = readFileSync(fake.markerPath, 'utf8');
    const at = Date.parse(first.trim());
    assert.ok(at >= t0 && at <= Date.now(), first);
    fake.profiles[P]!.params['AdvOut.RecTracks'] = '3';
    const r = await setup(fake);
    assert.deepEqual(r.changes, [{ item: 'AdvOut.RecTracks', from: '3', to: '1' }]);
    assert.equal(readFileSync(fake.markerPath, 'utf8'), first, 'mantém o instante mais antigo');
    fake.quit();
    const reopened = await setup(fake);
    assert.equal(reopened.launched, true);
    assert.equal(reopened.restartRequired, false);
    assert.equal(existsSync(fake.markerPath), false);
  });

  test('OBS em execução com o início do processo desconhecido → o reinício continua pendente (conservador)', async () => {
    const fake = await FakeObs.start();
    await setup(fake);
    fake.restart();
    const r = await setup(fake, { obsStartedAt: async () => null });
    assert.equal(r.restartRequired, true);
    assert.ok(existsSync(fake.markerPath));
  });

  test('E_OBS_SOURCE em modo texto: as mudanças feitas, o reinício e a dica do cabo', async () => {
    const fake = await FakeObs.start({ devices: [FACETIME_ITEM] });
    const cap = cliIo();
    assert.equal(await main(['obs', 'setup'], { config: configFor(fake), obs: depsFor(fake), io: cap.io }), 1);
    const err = cap.err.join('');
    assert.match(err, /(^|\n)contrarregra: E_OBS_SOURCE: o iPhone "VIVO_00G7" não está na lista/);
    assert.match(err, /\nmudanças feitas antes do erro \(\d+\):\n/);
    assert.match(err, /\nreinício: /);
    assert.match(err, /\ndica: ligue o cabo/);
  });
});

describe('CLI contrarregra obs setup (S8 item 2: só na CLI)', () => {
  function io(): { out: string[]; err: string[]; io: { stdout: (t: string) => void; stderr: (t: string) => void } } {
    const out: string[] = [];
    const err: string[] = [];
    return { out, err, io: { stdout: (t) => void out.push(t), stderr: (t) => void err.push(t) } };
  }

  test('--json devolve o objeto do comando; o texto lista as diferenças e o reinício, depois "nada a corrigir"; recusa sai com 1; erro de uso com 2', async () => {
    const fake = await FakeObs.start();
    const deps = { config: configFor(fake), obs: depsFor(fake) };

    const first = io();
    assert.equal(await main(['obs', 'setup', '--json'], { ...deps, io: first.io }), 0, first.err.join(''));
    const result = JSON.parse(first.out.join('')) as ObsSetupResult;
    assert.equal(result.profile, P);
    assert.equal(result.restartRequired, true);
    assert.deepEqual(result.changes[0], { item: 'profile', from: null, to: P });
    assert.deepEqual(result.device, { name: 'VIVO_00G7', value: UDID });
    assert.deepEqual(result.recordEncoder, { path: fake.encoderPath, status: 'pending' });

    // O dono fecha o OBS; a 2.ª passada escreve o recordEncoder.json e reabre o OBS no perfil.
    fake.quit();
    const closed = io();
    assert.equal(await main(['obs', 'setup'], { ...deps, io: closed.io }), 0, closed.err.join(''));
    const closedText = closed.out.join('');
    assert.match(closedText, /^OBS aberto pela ferramenta: open -a OBS --args --profile Contrarregra --collection Contrarregra --disable-shutdown-check --disable-missing-files-check\n/);
    assert.match(closedText, /\n {2}recordEncoder\.bitrate: \(não existia\) → 16000\n/);
    assert.match(closedText, /\nrecordEncoder\.json: corrigido antes de abrir o OBS — .*profiles\/Contrarregra\/recordEncoder\.json\n/);
    assert.doesNotMatch(closedText, /reinício/);

    fake.profiles[P]!.params['AdvOut.RecFormat2'] = 'fragmented_mov';
    const text = io();
    assert.equal(await main(['obs', 'setup'], { ...deps, io: text.io }), 0, text.err.join(''));
    const lines = text.out.join('');
    assert.match(lines, /1 diferença\(s\) corrigida\(s\):\n {2}AdvOut\.RecFormat2: "fragmented_mov" → "hybrid_mp4"\n/);
    assert.match(lines, /reinício: .*Feche o OBS \(⌘Q\) e rode `contrarregra obs setup` de novo/);

    // Sem reiniciar o OBS, a passada seguinte não tem o que corrigir, mas o reinício continua pendente.
    const quiet = io();
    assert.equal(await main(['obs', 'setup'], { ...deps, io: quiet.io }), 0);
    assert.match(quiet.out.join(''), /nada a corrigir \(nenhuma escrita\)/);
    assert.match(quiet.out.join(''), /\nreinício: /);
    fake.restart();
    const restarted = io();
    assert.equal(await main(['obs', 'setup'], { ...deps, io: restarted.io }), 0);
    assert.match(restarted.out.join(''), /nada a corrigir \(nenhuma escrita\)/);
    assert.doesNotMatch(restarted.out.join(''), /reinício/);

    fake.currentProfile = OWNER;
    fake.currentCollection = OWNER;
    const refused = io();
    assert.equal(await main(['obs', 'setup', '--json'], { ...deps, io: refused.io }), 1);
    assert.equal((JSON.parse(refused.out.join('')) as { error: { code: string } }).error.code, 'E_OBS_CONFIG');
    assert.match(refused.err.join(''), /dica: feche o OBS/);

    for (const argv of [['obs'], ['obs', 'setup', '--spike'], ['obs', 'setup', 'agora'], ['obs', 'status'], ['obs', 'setup', '--for', '1']]) {
      const cap = io();
      assert.equal(await main(argv, { ...deps, io: cap.io }), 2, argv.join(' '));
      assert.match(cap.err.join(''), /uso:/);
    }
    // Nomes herdados de Object.prototype não são grupos nem subcomandos.
    for (const argv of [
      ['obs', 'constructor'],
      ['obs', 'toString'],
      ['obs', '__proto__'],
      ['obs', 'hasOwnProperty'],
      ['constructor', 'name'],
      ['__proto__', 'setup'],
      ['toString'],
      ['runner', 'constructor'],
      ['runner', 'valueOf'],
    ]) {
      const cap = io();
      assert.equal(await main(argv, { ...deps, io: cap.io }), 2, argv.join(' '));
      assert.match(cap.err.join(''), /subcomando desconhecido/, argv.join(' '));
      assert.match(cap.err.join(''), /uso:/);
      assert.deepEqual(cap.out, []);
    }
    const help = io();
    assert.equal(await main(['--help'], { ...deps, io: help.io }), 0);
    assert.match(help.out.join(''), /contrarregra obs setup \[--json\]/);
  });
});
