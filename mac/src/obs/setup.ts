// `contrarregra obs setup` (spec S9 item 1; constituição P-6; AC-9.8, AC-9.10; deploy.md D3.4): cria ou
// reconcilia o perfil e a coleção "Contrarregra" sem tocar no perfil/cenas do dono, e relata cada
// diferença que corrigiu. Idempotente: cada valor é lido antes e só é escrito se diferir — uma segunda
// passada sem diferenças não manda nenhuma escrita.
//
// Duas fases:
// 1. **Criação** (só quando falta o perfil ou a coleção): `CreateProfile` e `CreateSceneCollection`
//    criam e ativam o perfil/coleção novos (pesquisa F19). Como a guarda do cliente (`client.ts`) exige
//    o "Contrarregra" já ativo, esses dois pedidos — fora da lista de escritas de S9 item 2, e que não
//    escrevem no perfil nem nas cenas de ninguém — vão por uma conexão crua (`ObsSocket`), cada um logo
//    depois de reler as listas e confirmar que o nome ainda não existe. O `CreateProfile` só enfileira
//    a troca: espera-se o `CurrentProfileChanged` antes de qualquer outra coisa.
// 2. **Reconciliação**: toda escrita passa pelo `ObsClient`, cuja guarda relê `GetProfileList` e
//    `GetSceneCollectionList` antes de cada uma e recusa (`E_OBS_CONFIG`, nada escrito) fora do
//    "Contrarregra". Nunca `SetCurrentProfile`/`SetCurrentSceneCollection` (S9 item 2): com o OBS aberto
//    noutro perfil e o "Contrarregra" já existente, o pedido ao dono é fechar o OBS; sem processo do
//    OBS, a ferramenta o reabre no perfil com `open -a OBS --args --profile … --collection …`.
//
// Mudar parâmetro do perfil (saída, formato, codificador, áudio) só vale quando o OBS remonta as
// saídas (pesquisa F17): o resultado traz `restartRequired`, e a segunda passada (OBS fechado → reaberto
// pela ferramenta no perfil) confere tudo sem escrever. O reinício pendente sobrevive entre passadas: antes
// do primeiro `SetProfileParameter`, um marcador em `paths.cache` (`obs/restart-pending`) guarda o
// instante; ele só é limpo quando o processo do OBS em execução começou depois disso (ou quando a própria
// ferramenta abriu o OBS). Erro depois de alguma escrita leva no `data` as mudanças já feitas e o
// `restartRequired`.
//
// **Mesmas configurações de áudio do perfil do dono**: o `Audio.ChannelSetup` de referência vem, em toda
// passada, do `basic.ini` dos outros perfis no disco (só leitura, sem seguir link; o nome de cada perfil
// é o `[General] Name` do arquivo, cruzado com `GetProfileList`); se eles discordam, é ambíguo e o valor
// fica como está. Nunca o `config.json` do obs-websocket.
//
// **Codificador de gravação** (S9 item 1, G1 de 2026-10-13): o obs-websocket 5.6.2 não alcança taxa,
// keyframe e perfil H.264, que ficam em `basic/profiles/Contrarregra/recordEncoder.json`. A ferramenta o
// cria ou reconcilia só quando não há processo do OBS (conferido de novo logo antes de escrever) e logo
// antes de reabri-lo no perfil; com o OBS aberto, só lê e relata o que está pendente. O caminho é montado
// do nome do perfil (um nome de pasta simples) e conferido: a pasta tem de ser uma pasta de verdade
// dentro de `profiles/` (nada de link simbólico), com o `basic.ini` do próprio perfil (`[General]
// Name=…`); o arquivo é aberto sem seguir link (`O_NOFOLLOW`), as outras chaves são preservadas, e a
// escrita é atômica (temporário na mesma pasta + `rename`).

import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, mkdir, open, readdir, readFile, realpath, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import type { Config } from '../core/config.ts';
import { ContrarregraError, isContrarregraError } from '../core/errors.ts';
import type { GetProfileListResponse, GetSceneCollectionListResponse, ObsClient, PropertyItem } from './client.ts';
import { ObsRequestError, REQUEST_TIMEOUT_MS, type JsonObject, type ObsSocket } from './ws.ts';

/**
 * Tela base = saída (S9 item 1, G1 de 2026-10-13): 1168×2532. O OBS 31.1.2 exige largura múltipla de 4
 * na saída e aplica 1170 como 1168 (medido na T-0.13: `OutputCX=1170` no perfil, `outputWidth: 1168` no
 * `GetVideoSettings`), o que deixava o setup reescrevendo o vídeo a cada passada.
 */
export const CANVAS = { width: 1168, height: 2532 } as const;
/** A fonte nativa do iPhone 12 (S9 item 3: o tamanho antes do recorte). */
export const IPHONE_NATIVE = { width: 1170, height: 2532 } as const;
/** "Video Capture Device" do OBS 31 no macOS (pesquisa capture F21). */
export const IPHONE_INPUT_KIND = 'macos-avcapture';
/** Fonte de cor (pesquisa obs-websocket F27). */
export const FLASH_INPUT_KIND = 'color_source_v3';
/** "Apple VT H264 Hardware Encoder" (pesquisa capture F19). */
export const APPLE_VT_H264_HW = 'com.apple.videotoolbox.videoencoder.ave.avc';
/** Branco opaco (ABGR) da fonte de cor. */
export const FLASH_COLOR = 0xffffffff;
/** Preset High, sem buffering (S9 item 1); o `device` é resolvido pelo nome do aparelho. */
export const IPHONE_SETTINGS: Readonly<JsonObject> = { use_preset: true, preset: 'AVCaptureSessionPresetHigh', buffering: false };
/** Áudio do iPhone só na faixa 1 (S9 item 1). */
export const IPHONE_AUDIO_TRACKS: Readonly<Record<string, boolean>> = { '1': true, '2': false, '3': false, '4': false, '5': false, '6': false };
/**
 * Enquadramento sem escala (S9 item 1, G1 de 2026-10-13): a fonte nativa de 1170×2532 entra em escala 1,
 * sem caixa (`OBS_BOUNDS_NONE`, nada que reamostre), sem rotação, ancorada no canto superior esquerdo
 * (alinhamento 5 = esquerda | topo) em 0,0, e recortada 1 px à esquerda e 1 px à direita: os 1168 px do
 * meio cobrem a tela de 1168 de largura pixel a pixel.
 */
export const IPHONE_TRANSFORM: Readonly<JsonObject> = {
  boundsType: 'OBS_BOUNDS_NONE',
  scaleX: 1,
  scaleY: 1,
  rotation: 0,
  alignment: 5,
  positionX: 0,
  positionY: 0,
  cropLeft: (IPHONE_NATIVE.width - CANVAS.width) / 2,
  cropRight: (IPHONE_NATIVE.width - CANVAS.width) / 2,
  cropTop: 0,
  cropBottom: 0,
};
/** A fonte de cor cobre a tela inteira a partir do canto. */
export const FLASH_TRANSFORM: Readonly<JsonObject> = { positionX: 0, positionY: 0 };
/** Áudio da área de trabalho e microfones globais do Mac (`GetSpecialInputs`): ficam mudos. */
export const SPECIAL_AUDIO_INPUTS = ['desktop1', 'desktop2', 'mic1', 'mic2', 'mic3', 'mic4'] as const;
/** Taxa de áudio do perfil (S9 item 1). */
export const SAMPLE_RATE = '48000';
/** Nome do app e do processo do OBS. */
export const OBS_APP = 'OBS';
/** ⚠️ Prazo para o OBS aberto pela ferramenta aceitar a conexão (a spec não fixa; ver relatório da T-0.13). */
export const OBS_LAUNCH_TIMEOUT_MS = 30_000;
/** Intervalo entre tentativas de conexão depois de abrir o OBS. */
export const OBS_LAUNCH_RETRY_MS = 500;
/** Ajustes do codificador de gravação do modo Avançado, na pasta do perfil (S9 item 1). */
export const RECORD_ENCODER_FILE = 'recordEncoder.json';

/** `~/Library/Application Support/obs-studio/basic` (perfis em `profiles/<nome>/`). */
export function defaultObsBasicDir(): string {
  return join(homedir(), 'Library', 'Application Support', 'obs-studio', 'basic');
}

/** O que o `recordEncoder.json` tem de ter (S9 item 1): ABR `record.bitrateKbps`, keyframe 1 s, perfil high. */
export function recordEncoderSettings(bitrateKbps: number): JsonObject {
  return { rate_control: 'ABR', bitrate: bitrateKbps, keyint_sec: 1, profile: 'high' };
}

/** O que o setup garante, tirado da configuração (S0.1). */
export interface ObsSetupTarget {
  profile: string;
  collection: string;
  scene: string;
  /** Fonte de captura do iPhone (`obs.source`). */
  source: string;
  /** Fonte de cor das marcas (`obs.flashSource`). */
  flashSource: string;
  /** `device.name`: o `itemName` do iPhone na lista de dispositivos do OBS. */
  deviceName: string;
  /** `record.fps`. */
  fps: number;
  /** `record.bitrateKbps`. */
  bitrateKbps: number;
}

export function setupTarget(config: Config): ObsSetupTarget {
  return {
    profile: config.obs.profile,
    collection: config.obs.collection,
    scene: config.obs.scene,
    source: config.obs.source,
    flashSource: config.obs.flashSource,
    deviceName: config.device.name,
    fps: config.record.fps,
    bitrateKbps: config.record.bitrateKbps,
  };
}

export interface ProfileParameter {
  category: string;
  name: string;
  value: string;
}

/**
 * Parâmetros do perfil (S9 item 1): saída Avançada, gravação Padrão, Hybrid MP4, Apple VT H.264 por
 * hardware, faixa 1, áudio 48 kHz e, quando conhecido, o mesmo arranjo de canais do perfil do dono.
 */
export function profileParameters(ownerChannelSetup?: string): ProfileParameter[] {
  const parameters: ProfileParameter[] = [
    { category: 'Output', name: 'Mode', value: 'Advanced' },
    { category: 'AdvOut', name: 'RecType', value: 'Standard' },
    { category: 'AdvOut', name: 'RecFormat2', value: 'hybrid_mp4' },
    { category: 'AdvOut', name: 'RecEncoder', value: APPLE_VT_H264_HW },
    { category: 'AdvOut', name: 'RecTracks', value: '1' },
    { category: 'Audio', name: 'SampleRate', value: SAMPLE_RATE },
  ];
  if (ownerChannelSetup !== undefined) parameters.push({ category: 'Audio', name: 'ChannelSetup', value: ownerChannelSetup });
  return parameters;
}

/** `open -a OBS --args …` (S9 item 2; deploy.md D3.4): só vale quando não há processo do OBS. */
export function obsLaunchArgs(profile: string, collection: string): string[] {
  return ['-a', OBS_APP, '--args', '--profile', profile, '--collection', collection, '--disable-shutdown-check', '--disable-missing-files-check'];
}

/** A linha que o dono roda (ou que a ferramenta roda por ele, sem processo do OBS). */
export function obsLaunchCommand(profile: string, collection: string): string {
  return ['open', ...obsLaunchArgs(profile, collection)].join(' ');
}

/** Uma diferença corrigida. `from: null` = não existia. */
export interface ObsSetupChange {
  /** Ex.: `profile`, `Output.Mode`, `video`, `scene:Contrarregra`, `input:iPhone.preset`, `sceneItem:Sync Flash.enabled`. */
  item: string;
  from: unknown;
  to: unknown;
}

export interface ObsSetupResult {
  profile: string;
  collection: string;
  /** A ferramenta abriu o OBS (não havia processo). */
  launched: boolean;
  /** Na ordem em que foram feitas; vazio = nada a corrigir e nenhuma escrita. */
  changes: ObsSetupChange[];
  /** Algum parâmetro do perfil mudou: só vale depois de fechar o OBS e reabri-lo no perfil (pesquisa F17). */
  restartRequired: boolean;
  /** O iPhone na lista de dispositivos do OBS (`itemName` → `itemValue`): no OBS 31.1.2, um identificador do macOS, não o UDID (SP-5). */
  device: { name: string; value: string };
  /**
   * `profiles/<perfil>/recordEncoder.json`: `ok` = igual ao alvo; `written` = corrigido nesta passada,
   * antes de abrir o OBS; `pending` = difere ou falta (ou o perfil ainda não existe) com o OBS aberto —
   * só se escreve com o OBS fechado, por isso entra em `restartRequired`.
   */
  recordEncoder: { path: string; status: 'ok' | 'written' | 'pending' };
}

export interface ObsSetupOptions {
  target: ObsSetupTarget;
  /** Cliente com a guarda do perfil (`ObsClient.connect`). */
  connectClient: () => Promise<ObsClient>;
  /** Conexão crua, só para `CreateProfile`/`CreateSceneCollection` (`ObsSocket.connect`). */
  connectSocket: () => Promise<ObsSocket>;
  /** Há processo do OBS? Padrão nos comandos: `obsProcessRunning`. */
  isObsRunning: () => Promise<boolean>;
  /** Início (epoch ms) do processo do OBS em execução; `null` sem processo ou desconhecido. Padrão: `obsProcessStartedAt`. */
  obsStartedAt: () => Promise<number | null>;
  /** Marcador do reinício pendente, em `paths.cache` (padrão nos comandos: `<paths.cache>/obs/restart-pending`). */
  restartMarkerPath: string;
  /** Roda `open` com estes argumentos. Padrão nos comandos: `openObs`. */
  launchObs: (args: string[]) => Promise<void>;
  /** A pasta `basic/` do OBS (padrão nos comandos: `defaultObsBasicDir()`; nos testes, uma pasta temporária). */
  obsBasicDir: string;
  launchTimeoutMs?: number;
  launchRetryMs?: number;
  /** Prazo para o `CurrentProfileChanged` depois do `CreateProfile` (padrão: o de um pedido, 5 s). */
  profileSwitchTimeoutMs?: number;
  log?: (line: string) => void;
}

interface ProfileParameterResponse {
  parameterValue: string | null;
  defaultParameterValue: string | null;
}

interface VideoSettings {
  fpsNumerator: number;
  fpsDenominator: number;
  baseWidth: number;
  baseHeight: number;
  outputWidth: number;
  outputHeight: number;
}

interface SceneListResponse {
  currentProgramSceneName: string | null;
  scenes: { sceneName: string }[];
}

interface InputListResponse {
  inputs: { inputName: string; inputKind: string }[];
}

interface SceneItem {
  sceneItemId: number;
  sceneItemIndex: number;
  sourceName: string;
  sceneItemEnabled: boolean;
  sceneItemTransform: JsonObject;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sameValue(a: unknown, b: unknown): boolean {
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) < 1e-6;
  return a === b;
}

/** Recusa do OBS a um pedido do setup → `E_OBS_CONFIG` com o código e o comentário do OBS. */
function refused(error: unknown): unknown {
  if (!(error instanceof ObsRequestError)) return error;
  return new ContrarregraError(
    'E_OBS_CONFIG',
    `o OBS recusou ${error.requestType} (código ${error.code}${error.comment === undefined ? '' : `: ${error.comment}`})`,
    { requestType: error.requestType, obsCode: error.code, comment: error.comment ?? null },
    { cause: error },
  );
}

/** O que o dono faz quando `restartRequired` (a mesma frase na CLI, no sucesso e no erro). */
export function restartHint(profile: string, collection: string): string {
  return `os parâmetros do perfil só valem quando o OBS remonta as saídas, e o ${RECORD_ENCODER_FILE} só é escrito com o OBS fechado. Feche o OBS (⌘Q) e rode \`contrarregra obs setup\` de novo: sem processo do OBS, a ferramenta escreve o que falta no ${RECORD_ENCODER_FILE}, reabre o OBS no perfil "${profile}" (\`${obsLaunchCommand(profile, collection)}\`) e confere tudo`;
}

function reopenHint(target: ObsSetupTarget): string {
  return `feche o OBS (⌘Q) e rode \`contrarregra obs setup\` de novo: sem processo do OBS, a ferramenta o reabre com \`${obsLaunchCommand(target.profile, target.collection)}\``;
}

/** Fase 2: leituras e escritas pelo cliente com guarda; cada escrita é anotada. */
class Reconciler {
  readonly changes: ObsSetupChange[];
  readonly #client: ObsClient;
  readonly #log: (line: string) => void;

  constructor(client: ObsClient, log: (line: string) => void, changes: ObsSetupChange[]) {
    this.#client = client;
    this.#log = log;
    this.changes = changes;
  }

  async read<T>(requestType: string, requestData?: JsonObject): Promise<T> {
    if (!requestType.startsWith('Get')) throw new TypeError(`${requestType} não é leitura`);
    try {
      return (await this.#client.request<T>(requestType, requestData)).data;
    } catch (error) {
      throw refused(error);
    }
  }

  /** Escrita: o cliente confere o perfil e a coleção ativos antes (guarda, sem cache). */
  async write(requestType: string, requestData: JsonObject, change: ObsSetupChange | ObsSetupChange[]): Promise<void> {
    try {
      await this.#client.request(requestType, requestData);
    } catch (error) {
      throw refused(error);
    }
    for (const c of Array.isArray(change) ? change : [change]) {
      this.changes.push(c);
      this.#log(`obs setup: ${c.item}: ${JSON.stringify(c.from)} → ${JSON.stringify(c.to)}`);
    }
  }
}

/**
 * Fase 1: cria o perfil e/ou a coleção pela conexão crua, conferindo as listas logo antes de cada um.
 * Cada criação entra em `changes` assim que acontece (se a seguinte falhar, o erro ainda a relata).
 */
async function create(
  connectSocket: () => Promise<ObsSocket>,
  target: ObsSetupTarget,
  plan: { profile: boolean; collection: boolean },
  switchTimeoutMs: number,
  log: (line: string) => void,
  changes: ObsSetupChange[],
): Promise<void> {
  const socket = await connectSocket();
  const lists = async (): Promise<[GetProfileListResponse, GetSceneCollectionListResponse]> => {
    const [profiles, collections] = await Promise.all([
      socket.request<GetProfileListResponse>('GetProfileList'),
      socket.request<GetSceneCollectionListResponse>('GetSceneCollectionList'),
    ]);
    return [profiles.data, collections.data];
  };
  try {
    if (plan.profile) {
      const [profiles] = await lists();
      if (profiles.profiles.includes(target.profile)) {
        throw new ContrarregraError('E_OBS_CONFIG', `o perfil "${target.profile}" apareceu durante o setup; nada foi escrito`, { profile: target.profile });
      }
      // O CreateProfile só enfileira a troca (pesquisa F19): nada é escrito antes do CurrentProfileChanged.
      const switched = waitForEvent(socket, 'CurrentProfileChanged', (d) => d['profileName'] === target.profile, switchTimeoutMs);
      try {
        await socket.request('CreateProfile', { profileName: target.profile });
      } catch (error) {
        switched.cancel();
        throw refused(error);
      }
      try {
        await switched.done;
      } catch (error) {
        if (!(error instanceof EventTimeout)) throw error;
        throw new ContrarregraError(
          'E_OBS_CONFIG',
          `o OBS criou o perfil "${target.profile}" mas não confirmou a troca em ${switchTimeoutMs} ms (há um diálogo aberto no OBS?); nada mais foi escrito`,
          { profile: target.profile, timeoutMs: switchTimeoutMs, hint: reopenHint(target) },
        );
      }
      changes.push({ item: 'profile', from: null, to: target.profile });
      log(`obs setup: perfil "${target.profile}" criado e ativo`);
    }
    if (plan.collection) {
      const [profiles, collections] = await lists();
      if (profiles.currentProfileName !== target.profile) {
        throw new ContrarregraError(
          'E_OBS_CONFIG',
          `o OBS está no perfil "${profiles.currentProfileName}"; a coleção "${target.collection}" só é criada com o perfil "${target.profile}" ativo. Nada foi escrito`,
          { expected: target.profile, actual: profiles.currentProfileName, hint: reopenHint(target) },
        );
      }
      if (collections.sceneCollections.includes(target.collection)) {
        throw new ContrarregraError('E_OBS_CONFIG', `a coleção "${target.collection}" apareceu durante o setup; nada foi escrito`, {
          collection: target.collection,
        });
      }
      // Bloqueia até a coleção nova estar ativa (protocolo 5.6.2).
      try {
        await socket.request('CreateSceneCollection', { sceneCollectionName: target.collection });
      } catch (error) {
        throw refused(error);
      }
      changes.push({ item: 'sceneCollection', from: null, to: target.collection });
      log(`obs setup: coleção "${target.collection}" criada e ativa`);
    }
  } finally {
    await socket.close();
  }
}

class EventTimeout extends Error {}

function waitForEvent(
  socket: ObsSocket,
  eventType: string,
  matches: (eventData: JsonObject) => boolean,
  timeoutMs: number,
): { done: Promise<void>; cancel: () => void } {
  let cancel = (): void => {};
  const done = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new EventTimeout(`${eventType} não chegou em ${timeoutMs} ms`));
    }, timeoutMs);
    const unsubscribe = socket.onEvent((event) => {
      if (event.eventType !== eventType || !matches(event.eventData)) return;
      clearTimeout(timer);
      unsubscribe();
      resolve();
    });
    void socket.closed.then(() => {
      clearTimeout(timer);
      reject(new ContrarregraError('E_OBS_UNREACHABLE', `a conexão com o OBS fechou antes de ${eventType}`, { eventType }));
    });
    cancel = () => {
      clearTimeout(timer);
      unsubscribe();
      resolve();
    };
  });
  // Quem cancela não espera; sem ouvinte, a rejeição tardia (conexão fechada) não vira erro solto.
  done.catch(() => {});
  return { done, cancel: () => cancel() };
}

async function connectAfterLaunch(options: ObsSetupOptions): Promise<ObsClient> {
  const timeoutMs = options.launchTimeoutMs ?? OBS_LAUNCH_TIMEOUT_MS;
  const retryMs = options.launchRetryMs ?? OBS_LAUNCH_RETRY_MS;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await options.connectClient();
    } catch (error) {
      if (!isContrarregraError(error, 'E_OBS_UNREACHABLE')) throw error;
      if (Date.now() + retryMs > deadline) {
        throw new ContrarregraError(
          'E_OBS_UNREACHABLE',
          `abri o OBS (${obsLaunchCommand(options.target.profile, options.target.collection)}) e o servidor WebSocket não respondeu em ${timeoutMs} ms: ${error.message}`,
          { ...(error.data ?? {}), launched: true, timeoutMs },
          { cause: error },
        );
      }
      await new Promise((resolve) => setTimeout(resolve, retryMs));
    }
  }
}

/** O que a passada já fez: vai no resultado e, se algo falhar depois de escrever, no `data` do erro. */
interface Progress {
  changes: ObsSetupChange[];
  restartRequired: boolean;
}

/** Erro depois de alguma escrita (ou com reinício pendente) leva as mudanças feitas e o `restartRequired`. */
function withProgress(error: unknown, progress: Progress, target: ObsSetupTarget): unknown {
  if (!isContrarregraError(error) || (progress.changes.length === 0 && !progress.restartRequired)) return error;
  return new ContrarregraError(
    error.code,
    error.message,
    { ...(error.data ?? {}), profile: target.profile, collection: target.collection, changes: progress.changes, restartRequired: progress.restartRequired },
    { cause: error },
  );
}

/** Cria/reconcilia o perfil e a coleção "Contrarregra" (S9 item 1). Ver o cabeçalho do arquivo. */
export async function setupObs(options: ObsSetupOptions): Promise<ObsSetupResult> {
  const log = options.log ?? (() => {});
  const running = await options.isObsRunning();
  // Com o OBS fechado, o recordEncoder.json é escrito aqui, logo antes de reabri-lo; aberto, só lido.
  const encoder = await reconcileRecordEncoder(options, !running, log);
  const progress: Progress = { changes: [...encoder.changes], restartRequired: encoder.status === 'pending' };
  try {
    return await reconcile(options, running, encoder, progress, log);
  } catch (error) {
    throw withProgress(error, progress, options.target);
  }
}

async function reconcile(
  options: ObsSetupOptions,
  running: boolean,
  encoder: EncoderOutcome,
  progress: Progress,
  log: (line: string) => void,
): Promise<ObsSetupResult> {
  const { target } = options;
  let launched = false;
  let client: ObsClient;
  if (running) {
    client = await options.connectClient();
  } else {
    const args = obsLaunchArgs(target.profile, target.collection);
    log(`obs setup: sem processo do OBS; abrindo no perfil: open ${args.join(' ')}`);
    await options.launchObs(args);
    launched = true;
    client = await connectAfterLaunch(options);
  }
  try {
    await checkPendingRestart(options, launched, progress, log);
    const r = new Reconciler(client, log, progress.changes);
    const [profiles, collections] = await Promise.all([
      r.read<GetProfileListResponse>('GetProfileList'),
      r.read<GetSceneCollectionListResponse>('GetSceneCollectionList'),
    ]);
    const profileExists = profiles.profiles.includes(target.profile);
    const collectionExists = collections.sceneCollections.includes(target.collection);
    const profileActive = profiles.currentProfileName === target.profile;
    const collectionActive = collections.currentSceneCollectionName === target.collection;
    // Nunca SetCurrentProfile/SetCurrentSceneCollection em execução (S9 item 2): o dono fecha o OBS.
    if ((profileExists && !profileActive) || (collectionExists && !collectionActive)) {
      throw new ContrarregraError(
        'E_OBS_CONFIG',
        `o OBS está aberto no perfil "${profiles.currentProfileName}" e na coleção "${collections.currentSceneCollectionName}"; o perfil/coleção "${target.profile}"/"${target.collection}" já existe e a ferramenta não troca de perfil com o OBS aberto (P-6). Nada foi escrito`,
        {
          expected: { profile: target.profile, collection: target.collection },
          actual: { profile: profiles.currentProfileName, collection: collections.currentSceneCollectionName },
          hint: reopenHint(target),
        },
      );
    }

    if (!profileExists || !collectionExists) {
      const plan = { profile: !profileExists, collection: !collectionExists };
      await create(options.connectSocket, target, plan, options.profileSwitchTimeoutMs ?? REQUEST_TIMEOUT_MS, log, r.changes);
    }

    // Arranjo de canais do dono, do basic.ini dos outros perfis no disco (vale em toda passada); o padrão
    // do OBS cobre um basic.ini sem a chave.
    const channel = await r.read<ProfileParameterResponse>('GetProfileParameter', { parameterCategory: 'Audio', parameterName: 'ChannelSetup' });
    const ownerChannelSetup = await ownerChannelSetupFromDisk(options.obsBasicDir, target.profile, profiles.profiles, channel.defaultParameterValue, log);

    // O marcador vai para o disco antes da primeira escrita de parâmetro: uma queda logo depois dela não
    // perde o reinício pendente.
    let marked = false;
    await reconcileParameters(r, profileParameters(ownerChannelSetup), async () => {
      if (!marked) {
        if ((await readRestartMarker(options.restartMarkerPath)) === null) await writeRestartMarker(options.restartMarkerPath, Date.now());
        marked = true;
      }
      progress.restartRequired = true;
    });
    await reconcileVideo(r, target);
    await reconcileScene(r, target);
    await reconcileInputs(r, target);
    await reconcileSpecialInputs(r);
    const device = await reconcileDevice(r, target);
    return {
      profile: target.profile,
      collection: target.collection,
      launched,
      changes: r.changes,
      restartRequired: progress.restartRequired,
      device,
      recordEncoder: { path: encoder.path, status: encoder.status },
    };
  } finally {
    await client.close();
  }
}

/**
 * Reinício pendente de uma passada anterior: some quando o OBS em execução começou depois da escrita
 * marcada (ou foi aberto agora pela ferramenta); com o início do processo desconhecido, continua pendente.
 */
async function checkPendingRestart(options: ObsSetupOptions, launched: boolean, progress: Progress, log: (line: string) => void): Promise<void> {
  const since = await readRestartMarker(options.restartMarkerPath);
  if (since === null) return;
  const startedAt = launched ? null : await options.obsStartedAt().catch(() => null);
  if (launched || (startedAt !== null && startedAt > since)) {
    await rm(options.restartMarkerPath, { force: true });
    log(`obs setup: o OBS reiniciou depois da escrita de ${new Date(since).toISOString()}; reinício feito`);
    return;
  }
  progress.restartRequired = true;
  log(`obs setup: reinício pendente desde ${new Date(since).toISOString()} (o OBS em execução começou antes)`);
}

/** Instante (epoch ms) do marcador de reinício; `null` sem marcador. Conteúdo ilegível → o mtime do arquivo. */
async function readRestartMarker(path: string): Promise<number | null> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  const at = Date.parse(text.trim());
  return Number.isFinite(at) ? at : (await stat(path)).mtimeMs;
}

async function writeRestartMarker(path: string, at: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${new Date(at).toISOString()}\n`, { mode: 0o600 });
}

async function reconcileParameters(r: Reconciler, parameters: ProfileParameter[], beforeWrite: () => Promise<void>): Promise<void> {
  for (const p of parameters) {
    const current = await r.read<ProfileParameterResponse>('GetProfileParameter', { parameterCategory: p.category, parameterName: p.name });
    const value = current.parameterValue ?? current.defaultParameterValue ?? null;
    if (value === p.value) continue;
    await beforeWrite();
    await r.write(
      'SetProfileParameter',
      { parameterCategory: p.category, parameterName: p.name, parameterValue: p.value },
      { item: `${p.category}.${p.name}`, from: value, to: p.value },
    );
  }
}

async function reconcileVideo(r: Reconciler, target: ObsSetupTarget): Promise<void> {
  const want: VideoSettings = {
    fpsNumerator: target.fps,
    fpsDenominator: 1,
    baseWidth: CANVAS.width,
    baseHeight: CANVAS.height,
    outputWidth: CANVAS.width,
    outputHeight: CANVAS.height,
  };
  const current = await r.read<VideoSettings>('GetVideoSettings');
  const keys = Object.keys(want) as (keyof VideoSettings)[];
  if (keys.every((k) => sameValue(current[k], want[k]))) return;
  const from = Object.fromEntries(keys.map((k) => [k, current[k] ?? null]));
  await r.write('SetVideoSettings', { ...want }, { item: 'video', from, to: { ...want } });
}

async function reconcileScene(r: Reconciler, target: ObsSetupTarget): Promise<void> {
  const list = await r.read<SceneListResponse>('GetSceneList');
  const scenes = Array.isArray(list.scenes) ? list.scenes : [];
  if (!scenes.some((s) => s.sceneName === target.scene)) {
    await r.write('CreateScene', { sceneName: target.scene }, { item: `scene:${target.scene}`, from: null, to: 'created' });
  }
  if (list.currentProgramSceneName !== target.scene) {
    await r.write('SetCurrentProgramScene', { sceneName: target.scene }, { item: 'programScene', from: list.currentProgramSceneName ?? null, to: target.scene });
  }
}

async function sceneItems(r: Reconciler, scene: string): Promise<SceneItem[]> {
  const data = await r.read<{ sceneItems: SceneItem[] }>('GetSceneItemList', { sceneName: scene });
  return Array.isArray(data.sceneItems) ? data.sceneItems : [];
}

/** Cria a fonte que falta (na cena, já com os ajustes) ou corrige os ajustes que diferem. */
async function reconcileInput(
  r: Reconciler,
  target: ObsSetupTarget,
  existing: Map<string, string>,
  name: string,
  kind: string,
  settings: Readonly<JsonObject>,
  sceneItemEnabled: boolean,
): Promise<void> {
  const currentKind = existing.get(name);
  if (currentKind === undefined) {
    await r.write(
      'CreateInput',
      { sceneName: target.scene, inputName: name, inputKind: kind, inputSettings: { ...settings }, sceneItemEnabled },
      { item: `input:${name}`, from: null, to: kind },
    );
    return;
  }
  if (currentKind !== kind) {
    throw new ContrarregraError(
      'E_OBS_CONFIG',
      `a coleção "${target.collection}" já tem uma fonte "${name}" do tipo ${currentKind} (esperado ${kind}); renomeie ou apague essa fonte no OBS e rode \`contrarregra obs setup\` de novo`,
      { input: name, expectedKind: kind, actualKind: currentKind },
    );
  }
  // O `GetInputSettings` não traz o que está no padrão (pesquisa F21): vale o padrão do tipo por baixo.
  const defaults = await r.read<{ defaultInputSettings: JsonObject }>('GetInputDefaultSettings', { inputKind: kind });
  const current = await r.read<{ inputSettings: JsonObject }>('GetInputSettings', { inputName: name });
  const have: JsonObject = {
    ...(isJsonObject(defaults.defaultInputSettings) ? defaults.defaultInputSettings : {}),
    ...(isJsonObject(current.inputSettings) ? current.inputSettings : {}),
  };
  const diff = Object.entries(settings).filter(([k, v]) => !sameValue(have[k], v));
  if (diff.length === 0) return;
  await r.write(
    'SetInputSettings',
    { inputName: name, inputSettings: Object.fromEntries(diff), overlay: true },
    diff.map(([k, v]) => ({ item: `input:${name}.${k}`, from: have[k] ?? null, to: v })),
  );
}

/** Põe a fonte na cena, se faltar, e corrige ligada/desligada e o enquadramento. */
async function reconcileSceneItem(
  r: Reconciler,
  target: ObsSetupTarget,
  name: string,
  enabled: boolean,
  transform: Readonly<JsonObject>,
): Promise<void> {
  let item = (await sceneItems(r, target.scene)).find((i) => i.sourceName === name);
  if (item === undefined) {
    await r.write('CreateSceneItem', { sceneName: target.scene, sourceName: name, sceneItemEnabled: enabled }, { item: `sceneItem:${name}`, from: null, to: target.scene });
    item = (await sceneItems(r, target.scene)).find((i) => i.sourceName === name);
    if (item === undefined) throw new ContrarregraError('E_OBS_CONFIG', `a fonte "${name}" não apareceu na cena "${target.scene}"`, { input: name });
  }
  if (item.sceneItemEnabled !== enabled) {
    await r.write(
      'SetSceneItemEnabled',
      { sceneName: target.scene, sceneItemId: item.sceneItemId, sceneItemEnabled: enabled },
      { item: `sceneItem:${name}.enabled`, from: item.sceneItemEnabled, to: enabled },
    );
  }
  const have = isJsonObject(item.sceneItemTransform) ? item.sceneItemTransform : {};
  const diff = Object.entries(transform).filter(([k, v]) => !sameValue(have[k], v));
  if (diff.length > 0) {
    await r.write(
      'SetSceneItemTransform',
      { sceneName: target.scene, sceneItemId: item.sceneItemId, sceneItemTransform: Object.fromEntries(diff) },
      diff.map(([k, v]) => ({ item: `sceneItem:${name}.${k}`, from: have[k] ?? null, to: v })),
    );
  }
}

async function reconcileInputs(r: Reconciler, target: ObsSetupTarget): Promise<void> {
  const list = await r.read<InputListResponse>('GetInputList');
  const existing = new Map((Array.isArray(list.inputs) ? list.inputs : []).map((i) => [i.inputName, i.inputKind]));

  // iPhone: preset High, sem buffering, ligado, sem escala e recortado 1 px de cada lado, áudio só na faixa 1.
  await reconcileInput(r, target, existing, target.source, IPHONE_INPUT_KIND, IPHONE_SETTINGS, true);
  await reconcileSceneItem(r, target, target.source, true, IPHONE_TRANSFORM);
  const tracks = await r.read<{ inputAudioTracks: Record<string, boolean> }>('GetInputAudioTracks', { inputName: target.source });
  const haveTracks = isJsonObject(tracks.inputAudioTracks) ? tracks.inputAudioTracks : {};
  const trackDiff = Object.entries(IPHONE_AUDIO_TRACKS).filter(([k, v]) => haveTracks[k] !== v);
  if (trackDiff.length > 0) {
    await r.write(
      'SetInputAudioTracks',
      { inputName: target.source, inputAudioTracks: Object.fromEntries(trackDiff) },
      trackDiff.map(([k, v]) => ({ item: `input:${target.source}.audioTrack${k}`, from: haveTracks[k] ?? null, to: v })),
    );
  }

  // "Sync Flash": branca, tela inteira, desligada, acima do iPhone (para aparecer quando ligada).
  const flashSettings: JsonObject = { color: FLASH_COLOR, width: CANVAS.width, height: CANVAS.height };
  await reconcileInput(r, target, existing, target.flashSource, FLASH_INPUT_KIND, flashSettings, false);
  await reconcileSceneItem(r, target, target.flashSource, false, FLASH_TRANSFORM);
  const items = await sceneItems(r, target.scene);
  const flash = items.find((i) => i.sourceName === target.flashSource);
  const iphone = items.find((i) => i.sourceName === target.source);
  if (flash !== undefined && iphone !== undefined && flash.sceneItemIndex < iphone.sceneItemIndex) {
    const top = Math.max(...items.map((i) => i.sceneItemIndex));
    await r.write(
      'SetSceneItemIndex',
      { sceneName: target.scene, sceneItemId: flash.sceneItemId, sceneItemIndex: top },
      { item: `sceneItem:${target.flashSource}.index`, from: flash.sceneItemIndex, to: top },
    );
  }
}

/** Áudio da área de trabalho e microfone do Mac desligados: as fontes globais que existirem ficam mudas. */
async function reconcileSpecialInputs(r: Reconciler): Promise<void> {
  const special = await r.read<Record<string, unknown>>('GetSpecialInputs');
  for (const key of SPECIAL_AUDIO_INPUTS) {
    const name = special[key];
    if (typeof name !== 'string' || name === '') continue;
    const { inputMuted } = await r.read<{ inputMuted: boolean }>('GetInputMute', { inputName: name });
    if (inputMuted === true) continue;
    await r.write('SetInputMute', { inputName: name, inputMuted: true }, { item: `input:${name}.muted`, from: inputMuted ?? null, to: true });
  }
}

/** O `device` da fonte é o `itemValue` cujo `itemName` é `device.name` (S9 item 1); sem ele, `E_OBS_SOURCE`. */
async function reconcileDevice(r: Reconciler, target: ObsSetupTarget): Promise<{ name: string; value: string }> {
  const list = await r.read<{ propertyItems: PropertyItem[] }>('GetInputPropertiesListPropertyItems', { inputName: target.source, propertyName: 'device' });
  const items = Array.isArray(list.propertyItems) ? list.propertyItems : [];
  const match = items.find((i) => i.itemName === target.deviceName && typeof i.itemValue === 'string' && i.itemValue !== '');
  if (match === undefined) {
    throw new ContrarregraError(
      'E_OBS_SOURCE',
      `o iPhone "${target.deviceName}" não está na lista de dispositivos do OBS; ligue o cabo com o iPhone destravado e rode \`contrarregra obs setup\` de novo (o resto já foi conferido)`,
      {
        deviceName: target.deviceName,
        available: items.map((i) => i.itemName),
        hint: 'ligue o cabo com o iPhone destravado (e aceite "Trust This Computer"), confira que ele aparece no OBS e rode `contrarregra obs setup` de novo',
      },
    );
  }
  const value = match.itemValue as string;
  const current = await r.read<{ inputSettings: JsonObject }>('GetInputSettings', { inputName: target.source });
  const have = isJsonObject(current.inputSettings) ? current.inputSettings['device'] : undefined;
  if (have !== value) {
    await r.write(
      'SetInputSettings',
      { inputName: target.source, inputSettings: { device: value }, overlay: true },
      { item: `input:${target.source}.device`, from: have ?? null, to: value },
    );
  }
  return { name: target.deviceName, value };
}

interface EncoderOutcome {
  path: string;
  status: 'ok' | 'written' | 'pending';
  /** Só quando `written`: o que foi corrigido no arquivo. */
  changes: ObsSetupChange[];
}

/** O nome do perfil vira nome de pasta: só um componente simples (nada de `/`, `.`, `..` ou NUL). */
function profileFolderName(profile: string): string {
  if (profile === '' || profile === '.' || profile === '..' || /[/\0]/.test(profile)) {
    throw new ContrarregraError(
      'E_CONFIG',
      `obs.profile = ${JSON.stringify(profile)} não é um nome de pasta simples; a ferramenta só escreve na pasta do próprio perfil`,
      { field: 'obs.profile', value: profile },
    );
  }
  return profile;
}

/** Valor de `chave` na `[seção]` de um `basic.ini` do OBS. */
function iniValue(text: string, wantedSection: string, key: string): string | undefined {
  let section = '';
  for (const raw of text.replace(/^﻿/, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('[') && line.endsWith(']')) section = line.slice(1, -1);
    else if (section === wantedSection && line.startsWith(`${key}=`)) return line.slice(key.length + 1);
  }
  return undefined;
}

/** `[General] Name` → texto do `basic.ini`, para cada pasta de verdade (não link) em `profiles/`; só leitura. */
async function profileInis(basicDir: string): Promise<Map<string, string>> {
  const profilesDir = join(basicDir, 'profiles');
  const found = new Map<string, string>();
  let entries: string[];
  try {
    entries = await readdir(profilesDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return found;
    throw error;
  }
  for (const entry of entries.sort()) {
    const folder = join(profilesDir, entry);
    try {
      const st = await lstat(folder);
      if (st.isSymbolicLink() || !st.isDirectory()) continue;
      const text = await readNoFollow(join(folder, 'basic.ini'), (why) => new Error(why));
      const name = text === undefined ? undefined : iniValue(text, 'General', 'Name');
      if (name !== undefined && text !== undefined && !found.has(name)) found.set(name, text);
    } catch {
      // pasta ilegível, link ou basic.ini que não é arquivo: não serve de referência
    }
  }
  return found;
}

/**
 * `Audio.ChannelSetup` dos perfis do dono (todos os da lista menos o da ferramenta), lido do `basic.ini`
 * de cada um no disco; sem a chave vale `fallback` (o padrão do OBS). `undefined` (não mexer) se algum não
 * for achado ou se eles discordarem.
 */
async function ownerChannelSetupFromDisk(
  basicDir: string,
  toolProfile: string,
  profileNames: readonly string[],
  fallback: string | null,
  log: (line: string) => void,
): Promise<string | undefined> {
  const owners = profileNames.filter((name) => name !== toolProfile);
  if (owners.length === 0) return undefined;
  const inis = await profileInis(basicDir);
  const values = new Set<string>();
  for (const name of owners) {
    const text = inis.get(name);
    const value = text === undefined ? undefined : (iniValue(text, 'Audio', 'ChannelSetup') ?? fallback ?? undefined);
    if (value === undefined) {
      log(`obs setup: Audio.ChannelSetup não conferido: sem o basic.ini do perfil "${name}" em ${join(basicDir, 'profiles')}`);
      return undefined;
    }
    values.add(value);
  }
  if (values.size !== 1) {
    log(`obs setup: Audio.ChannelSetup não conferido: os perfis do dono discordam (${[...values].join(', ')})`);
    return undefined;
  }
  return [...values][0];
}

/** Lê sem seguir link simbólico (`O_NOFOLLOW`); `undefined` se não existe. Link ou não-arquivo → recusa. */
async function readNoFollow(path: string, refuse: (why: string) => Error): Promise<string | undefined> {
  let handle;
  try {
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return undefined;
    if (code === 'ELOOP') throw refuse(`${path} é um link simbólico`);
    throw error;
  }
  try {
    if (!(await handle.stat()).isFile()) throw refuse(`${path} não é um arquivo comum`);
    return await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
}

/** Escreve num temporário novo da mesma pasta (sem seguir link) e o renomeia por cima: nunca meio arquivo. */
async function writeAtomic(dir: string, path: string, text: string): Promise<void> {
  const tmp = join(dir, `.${RECORD_ENCODER_FILE}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  const handle = await open(tmp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o644);
  try {
    try {
      await handle.writeFile(text, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmp, path);
  } catch (error) {
    await unlink(tmp).catch(() => {});
    throw error;
  }
}

/**
 * Cria ou reconcilia `profiles/<perfil>/recordEncoder.json` (S9 item 1). Só escreve com `canWrite` (não
 * havia processo do OBS) e se o processo continuar ausente logo antes da escrita; senão só lê e relata
 * `pending`. Pasta do perfil ainda inexistente (o OBS a cria no `CreateProfile`) → `pending`, sem criar
 * nada.
 */
async function reconcileRecordEncoder(options: ObsSetupOptions, canWrite: boolean, log: (line: string) => void): Promise<EncoderOutcome> {
  const { target } = options;
  const name = profileFolderName(target.profile);
  const profilesDir = join(options.obsBasicDir, 'profiles');
  const dir = join(profilesDir, name);
  const path = join(dir, RECORD_ENCODER_FILE);
  const refuse = (why: string, extra: Record<string, unknown> = {}): ContrarregraError =>
    new ContrarregraError('E_OBS_CONFIG', `${RECORD_ENCODER_FILE}: ${why}; nada foi escrito`, { path, ...extra });

  let folder;
  try {
    folder = await lstat(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    log(`obs setup: ${RECORD_ENCODER_FILE} pendente: o perfil "${target.profile}" ainda não existe no disco`);
    return { path, status: 'pending', changes: [] };
  }
  // A pasta do perfil tem de ser uma pasta de verdade, filha direta de profiles/ (nada de link para fora).
  if (folder.isSymbolicLink() || !folder.isDirectory()) throw refuse(`a pasta do perfil (${dir}) é um link simbólico ou não é uma pasta`);
  if ((await realpath(dir)) !== join(await realpath(profilesDir), name)) throw refuse(`a pasta do perfil (${dir}) não fica dentro de ${profilesDir}`);
  const ini = await readNoFollow(join(dir, 'basic.ini'), (why) => refuse(why));
  const iniName = ini === undefined ? undefined : iniValue(ini, 'General', 'Name');
  if (iniName !== target.profile) {
    throw refuse(
      `a pasta ${dir} não é do perfil "${target.profile}" (basic.ini: ${iniName === undefined ? 'sem [General] Name' : `Name=${iniName}`})`,
      { basicIniName: iniName ?? null },
    );
  }

  const text = await readNoFollow(path, (why) => refuse(why));
  let current: JsonObject = {};
  if (text !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw refuse(`${path} não é JSON válido`);
    }
    if (!isJsonObject(parsed)) throw refuse(`${path} não tem um objeto JSON`);
    current = parsed;
  }
  const want = recordEncoderSettings(target.bitrateKbps);
  const diff = Object.entries(want).filter(([k, v]) => !sameValue(current[k], v));
  if (diff.length === 0) return { path, status: 'ok', changes: [] };
  if (!canWrite) {
    log(`obs setup: ${RECORD_ENCODER_FILE} pendente (${diff.map(([k]) => k).join(', ')}): só é escrito com o OBS fechado`);
    return { path, status: 'pending', changes: [] };
  }
  // Só com o OBS fechado: confere o processo de novo logo antes de escrever.
  if (await options.isObsRunning()) {
    throw new ContrarregraError(
      'E_OBS_CONFIG',
      `o OBS abriu durante o setup; o ${RECORD_ENCODER_FILE} só é escrito com o OBS fechado. Nada foi escrito`,
      { path, hint: reopenHint(target) },
    );
  }
  // As outras chaves (as que o OBS põe) ficam, na mesma ordem.
  await writeAtomic(dir, path, `${JSON.stringify({ ...current, ...want }, null, 4)}\n`);
  const changes = diff.map(([k, v]) => ({ item: `recordEncoder.${k}`, from: current[k] ?? null, to: v }));
  for (const c of changes) log(`obs setup: ${c.item}: ${JSON.stringify(c.from)} → ${JSON.stringify(c.to)}`);
  return { path, status: 'written', changes };
}

/** Há processo do OBS? (`pgrep -x OBS`: 0 sim, 1 não.) */
export function obsProcessRunning(): Promise<boolean> {
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/pgrep', ['-x', OBS_APP], { timeout: REQUEST_TIMEOUT_MS }, (error) => {
      if (error === null) {
        resolve(true);
        return;
      }
      if (error.code === 1) {
        resolve(false);
        return;
      }
      reject(new ContrarregraError('E_OBS_UNREACHABLE', `não consegui conferir se o OBS está aberto (pgrep: ${error.message})`, {}, { cause: error }));
    });
  });
}

/**
 * Início (epoch ms, resolução de 1 s) do processo do OBS mais antigo em execução (`pgrep -x OBS` + `ps -o
 * lstart=`, em hora local); `null` sem processo.
 */
export function obsProcessStartedAt(): Promise<number | null> {
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/pgrep', ['-x', OBS_APP], { timeout: REQUEST_TIMEOUT_MS }, (error, stdout) => {
      if (error !== null) {
        if (error.code === 1) resolve(null);
        else reject(new ContrarregraError('E_OBS_UNREACHABLE', `não consegui achar o processo do OBS (pgrep: ${error.message})`, {}, { cause: error }));
        return;
      }
      const pids = stdout.split(/\s+/).filter((p) => /^\d+$/.test(p));
      if (pids.length === 0) {
        resolve(null);
        return;
      }
      const env = { ...process.env, LC_ALL: 'C', LANG: 'C' };
      execFile('/bin/ps', ['-o', 'lstart=', '-p', pids.join(',')], { timeout: REQUEST_TIMEOUT_MS, env }, (psError, psOut) => {
        const starts = psOut
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line !== '')
          .map((line) => Date.parse(line));
        if (psError !== null || starts.length === 0 || starts.some((t) => !Number.isFinite(t))) {
          reject(new ContrarregraError('E_OBS_UNREACHABLE', `não consegui ler o início do processo do OBS (ps: ${psError?.message ?? psOut.trim()})`, {}));
          return;
        }
        resolve(Math.min(...starts));
      });
    });
  });
}

/** Abre o OBS com `open` (só chamado quando não há processo do OBS). */
export function openObs(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/open', args, { timeout: REQUEST_TIMEOUT_MS }, (error) => {
      if (error === null) {
        resolve();
        return;
      }
      reject(new ContrarregraError('E_OBS_UNREACHABLE', `não consegui abrir o OBS (open ${args.join(' ')}: ${error.message})`, { args }, { cause: error }));
    });
  });
}
