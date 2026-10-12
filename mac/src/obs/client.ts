// Cliente do OBS (spec S9 item 2; constituição P-6; AC-9.9) sobre a conexão de `ws.ts`. Ao conectar,
// confere as versões validadas (`toolchain.validated`: OBS 31.1.2 ⏳ Q-8, obs-websocket 5.6.2), rpc 1 e
// que `CreateRecordChapter` existe. **Guarda do perfil:** antes de todo pedido que escreve — e de todo
// lote `SerialFrame` —, lê `GetProfileList` e `GetSceneCollectionList` e só envia a escrita depois das
// duas respostas, se o perfil e a coleção ativos forem `obs.profile`/`obs.collection`; senão
// `E_OBS_CONFIG` e nada é escrito (nunca no "Untitled" do dono). A guarda roda a cada escrita, sem
// cache. Fora dela só ficam as leituras (`Get*`), o `Sleep` e o `StopRecord` (fora da lista de S9
// item 2: parar a gravação nunca é bloqueado). A senha vem do Chaveiro por `core/secret.ts`, na hora
// do handshake e só se o OBS pedir.

import type { Config } from '../core/config.ts';
import { ContrarregraError } from '../core/errors.ts';
import { readSecret, type Secret } from '../core/secret.ts';
import {
  OBS_BATCH_EXECUTION,
  OBS_RPC_VERSION,
  ObsSocket,
  type JsonObject,
  type ObsBatchOptions,
  type ObsBatchRequest,
  type ObsBatchResponse,
  type ObsCloseInfo,
  type ObsEvent,
  type ObsHello,
  type ObsLog,
  type ObsResponse,
  type ObsSocketOptions,
} from './ws.ts';

/** Pedidos que o OBS conectado precisa oferecer (S9 item 2). */
export const REQUIRED_REQUESTS: readonly string[] = ['CreateRecordChapter'];
/** Saída de arquivo do modo Avançado (S9 itens 1 e 5). */
export const ADV_FILE_OUTPUT = 'adv_file_output';
/** Pedidos que não são `Get*` e passam sem a guarda: não escrevem (`Sleep`) ou param a gravação (`StopRecord`). */
export const UNGUARDED_REQUESTS: ReadonlySet<string> = new Set(['Sleep', 'StopRecord']);

/** Escreve no OBS, logo passa pela guarda do perfil. */
export function isWriteRequest(requestType: string): boolean {
  return !requestType.startsWith('Get') && !UNGUARDED_REQUESTS.has(requestType);
}

export interface ObsExpectedVersions {
  /** `toolchain.validated.obs` (⏳ Q-8). */
  obs: string;
  /** `toolchain.validated.obsWebsocket`. */
  obsWebsocket: string;
}

export interface ObsClientOptions extends ObsSocketOptions {
  /** `obs.profile`. */
  profile: string;
  /** `obs.collection`. */
  collection: string;
  expected: ObsExpectedVersions;
  /** Padrão `true`: versão fora do conjunto → `E_TOOLCHAIN_MISMATCH`. `false` só relata (`obs status`). */
  strictVersions?: boolean;
}

export interface ObsVersions {
  obsStudioVersion: string | undefined;
  obsWebSocketVersion: string;
  rpcVersion: number;
  availableRequests: string[];
}

export interface GetVersionResponse {
  obsVersion: string;
  obsWebSocketVersion: string;
  rpcVersion: number;
  availableRequests: string[];
  supportedImageFormats: string[];
  platform: string;
  platformDescription: string;
}

export interface GetProfileListResponse {
  currentProfileName: string;
  profiles: string[];
}

export interface GetSceneCollectionListResponse {
  currentSceneCollectionName: string;
  sceneCollections: string[];
}

export interface GetRecordStatusResponse {
  outputActive: boolean;
  outputPaused: boolean;
  outputTimecode: string;
  outputDuration: number;
  outputBytes: number;
}

export interface StopRecordResponse {
  /** O arquivo que está sendo escrito (ainda não finalizado; pesquisa F6, F14). */
  outputPath: string;
}

export interface GetStatsResponse {
  cpuUsage: number;
  memoryUsage: number;
  /** MiB livres no volume da pasta de gravação (S9 item 4). */
  availableDiskSpace: number;
  activeFps: number;
  averageFrameRenderTime: number;
  renderSkippedFrames: number;
  renderTotalFrames: number;
  outputSkippedFrames: number;
  outputTotalFrames: number;
  webSocketSessionIncomingMessages: number;
  webSocketSessionOutgoingMessages: number;
}

export interface GetOutputStatusResponse {
  outputActive: boolean;
  outputReconnecting: boolean;
  outputTimecode: string;
  outputDuration: number;
  outputCongestion: number;
  outputBytes: number;
  outputSkippedFrames: number;
  outputTotalFrames: number;
}

export interface PropertyItem {
  itemName: string;
  itemEnabled: boolean;
  itemValue: unknown;
}

export interface GetInputPropertiesListPropertyItemsResponse {
  propertyItems: PropertyItem[];
}

/** O que está fora do conjunto validado (vazio = tudo certo). */
export function versionProblems(versions: ObsVersions, expected: ObsExpectedVersions): string[] {
  const problems: string[] = [];
  if (versions.obsStudioVersion !== expected.obs) {
    problems.push(`OBS ${versions.obsStudioVersion ?? 'desconhecido'} (validado: ${expected.obs})`);
  }
  if (versions.obsWebSocketVersion !== expected.obsWebsocket) {
    problems.push(`obs-websocket ${versions.obsWebSocketVersion} (validado: ${expected.obsWebsocket})`);
  }
  if (versions.rpcVersion !== OBS_RPC_VERSION) problems.push(`rpc ${versions.rpcVersion} (esperado: ${OBS_RPC_VERSION})`);
  for (const request of REQUIRED_REQUESTS) {
    if (!versions.availableRequests.includes(request)) problems.push(`pedido ${request} ausente`);
  }
  return problems;
}

export class ObsClient {
  readonly profile: string;
  readonly collection: string;
  readonly versions: ObsVersions;
  /** Vazio quando OBS, obs-websocket, rpc e `CreateRecordChapter` batem com o validado. */
  readonly versionProblems: readonly string[];

  #socket: ObsSocket;
  #log: ObsLog;

  private constructor(socket: ObsSocket, options: ObsClientOptions, version: GetVersionResponse) {
    this.#socket = socket;
    this.#log = options.log ?? (() => {});
    this.profile = options.profile;
    this.collection = options.collection;
    this.versions = {
      obsStudioVersion: socket.hello.obsStudioVersion ?? version.obsVersion,
      obsWebSocketVersion: socket.hello.obsWebSocketVersion,
      rpcVersion: socket.negotiatedRpcVersion,
      availableRequests: Array.isArray(version.availableRequests) ? version.availableRequests : [],
    };
    this.versionProblems = versionProblems(this.versions, options.expected);
  }

  /** Conecta, identifica e confere as versões (`E_TOOLCHAIN_MISMATCH` se `strictVersions` e algo não bate). */
  static async connect(options: ObsClientOptions): Promise<ObsClient> {
    const socket = await ObsSocket.connect(options);
    try {
      const { data } = await socket.request<GetVersionResponse>('GetVersion');
      const client = new ObsClient(socket, options, data);
      if ((options.strictVersions ?? true) && client.versionProblems.length > 0) {
        throw new ContrarregraError(
          'E_TOOLCHAIN_MISMATCH',
          `OBS fora do conjunto validado: ${client.versionProblems.join('; ')}`,
          { problems: [...client.versionProblems], versions: { ...client.versions, availableRequests: undefined } },
        );
      }
      return client;
    } catch (error) {
      // Não espera o fechamento: com o OBS travado ele leva até `closeTimeoutMs`, e o erro já é a resposta.
      void socket.close();
      throw error;
    }
  }

  get hello(): ObsHello {
    return this.#socket.hello;
  }

  get isOpen(): boolean {
    return this.#socket.isOpen;
  }

  get closed(): Promise<ObsCloseInfo> {
    return this.#socket.closed;
  }

  /**
   * Guarda do perfil: lê os dois nomes ativos (pedidos independentes, em paralelo) e só retorna quando
   * as duas respostas chegaram e batem; senão `E_OBS_CONFIG`.
   */
  async assertProfile(): Promise<void> {
    const [profiles, collections] = await Promise.all([
      this.#socket.request<GetProfileListResponse>('GetProfileList'),
      this.#socket.request<GetSceneCollectionListResponse>('GetSceneCollectionList'),
    ]);
    const profile = profiles.data.currentProfileName;
    const collection = collections.data.currentSceneCollectionName;
    if (profile === this.profile && collection === this.collection) return;
    this.#log(`obs: escrita recusada; ativos: perfil "${profile}", coleção "${collection}"`);
    throw new ContrarregraError(
      'E_OBS_CONFIG',
      `o OBS está no perfil "${profile}" e na coleção "${collection}"; a ferramenta só escreve no perfil "${this.profile}" e na coleção "${this.collection}" (P-6) e nada foi escrito. Feche o OBS: a ferramenta o reabre no perfil certo`,
      { expected: { profile: this.profile, collection: this.collection }, actual: { profile, collection } },
    );
  }

  /** Pedido genérico; se escreve (`isWriteRequest`), passa antes pela guarda do perfil. */
  async request<T = JsonObject>(requestType: string, requestData?: JsonObject, options: { timeoutMs?: number } = {}): Promise<ObsResponse<T>> {
    if (isWriteRequest(requestType)) await this.assertProfile();
    return this.#socket.request<T>(requestType, requestData, options);
  }

  /** Lote genérico; com algum pedido que escreve, ou `SerialFrame`, passa antes pela guarda do perfil. */
  async batch(requests: readonly ObsBatchRequest[], options: ObsBatchOptions = {}): Promise<ObsBatchResponse> {
    if (options.executionType === OBS_BATCH_EXECUTION.SerialFrame || requests.some((r) => isWriteRequest(r.requestType))) {
      await this.assertProfile();
    }
    return this.#socket.batch(requests, options);
  }

  /** Lote `SerialFrame` (marcas de sincronia: liga/desliga a fonte "Sync Flash"; pesquisa F16, F27). */
  serialFrameBatch(requests: readonly ObsBatchRequest[], options: Omit<ObsBatchOptions, 'executionType'> = {}): Promise<ObsBatchResponse> {
    return this.batch(requests, { ...options, executionType: OBS_BATCH_EXECUTION.SerialFrame });
  }

  async getVersion(): Promise<GetVersionResponse> {
    return (await this.request<GetVersionResponse>('GetVersion')).data;
  }

  async getRecordStatus(): Promise<GetRecordStatusResponse> {
    return (await this.request<GetRecordStatusResponse>('GetRecordStatus')).data;
  }

  /** Só enfileira o início no OBS (pesquisa F6): quem grava espera o `RecordStateChanged` STARTED. */
  startRecord(): Promise<ObsResponse<JsonObject>> {
    return this.request('StartRecord');
  }

  /** Prazo de 10 s (o da conexão para `StopRecord`); o arquivo de `outputPath` ainda não está finalizado (pesquisa F14). */
  stopRecord(): Promise<ObsResponse<StopRecordResponse>> {
    return this.request<StopRecordResponse>('StopRecord');
  }

  /** 702 (saída sem capítulos) ou 501 (sem gravação) chegam como `ObsRequestError` (E-9.4). */
  createRecordChapter(chapterName: string): Promise<ObsResponse<JsonObject>> {
    return this.request('CreateRecordChapter', { chapterName });
  }

  async getStats(): Promise<GetStatsResponse> {
    return (await this.request<GetStatsResponse>('GetStats')).data;
  }

  getOutputStatus(outputName: string = ADV_FILE_OUTPUT): Promise<ObsResponse<GetOutputStatusResponse>> {
    return this.request<GetOutputStatusResponse>('GetOutputStatus', { outputName });
  }

  async getInputPropertiesListPropertyItems(inputName: string, propertyName: string): Promise<PropertyItem[]> {
    const { data } = await this.request<GetInputPropertiesListPropertyItemsResponse>('GetInputPropertiesListPropertyItems', {
      inputName,
      propertyName,
    });
    return Array.isArray(data.propertyItems) ? data.propertyItems : [];
  }

  onEvent(listener: (event: ObsEvent) => void): () => void {
    return this.#socket.onEvent(listener);
  }

  close(): Promise<ObsCloseInfo> {
    return this.#socket.close();
  }
}

export interface ObsClientOptionsFromConfig {
  /** Padrão: `readSecret` (Chaveiro, serviço `contrarregra`). */
  readPassword?: (name: string) => Promise<Secret>;
  log?: ObsLog;
}

/** Opções do cliente a partir da configuração (S0.1): a senha é buscada pelo nome só no handshake. */
export function obsClientOptions(config: Config, options: ObsClientOptionsFromConfig = {}): ObsClientOptions {
  const obs = config.toolchain.validated['obs'];
  const obsWebsocket = config.toolchain.validated['obsWebsocket'];
  if (obs === undefined || obsWebsocket === undefined) {
    throw new ContrarregraError('E_CONFIG', 'toolchain.validated precisa de `obs` e `obsWebsocket`', { field: 'toolchain.validated' });
  }
  const name = config.secrets.obsPassword;
  const readPassword = options.readPassword ?? ((secretName: string) => readSecret(secretName));
  const result: ObsClientOptions = {
    url: config.obs.url,
    profile: config.obs.profile,
    collection: config.obs.collection,
    expected: { obs, obsWebsocket },
    password: () => readPassword(name),
  };
  if (options.log !== undefined) result.log = options.log;
  return result;
}
