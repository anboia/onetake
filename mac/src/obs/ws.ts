// Conexão com o obs-websocket 5.6.2 (spec S9 item 2, E-9.1, E-9.2; research/obs-websocket.md F2–F5,
// F16, F26): WebSocket global do Node 22 (P-2: sem `ws` nem `obs-websocket-js`), subprotocolo
// `obswebsocket.json`, Hello → Identify → Identified com a autenticação
// base64(sha256(base64(sha256(senha + salt)) + challenge)), prazo por pedido (5 s; `StopRecord` 10 s,
// também em lote), todos os pendentes rejeitados quando a conexão fecha — por qualquer lado, na hora —,
// fechamento com prazo (1 s; depois derruba o TCP), eventos e lotes (`RequestBatch`) com o hrtime de
// envio e de recebimento. A leitura da senha fica fora do prazo do handshake (tem prazo próprio). Não conhece perfil nem gravação: a guarda do perfil e os pedidos com tipo ficam em
// `client.ts`. A senha chega como `Secret` (core/secret.ts), é aberta só para o hash, não fica guardada
// depois do handshake e nunca vai para log, erro ou fio. Sem reconexão automática (E-9.2).

import { createHash } from 'node:crypto';

import { ContrarregraError } from '../core/errors.ts';
import type { Secret } from '../core/secret.ts';

export const OBS_SUBPROTOCOL = 'obswebsocket.json';
export const OBS_RPC_VERSION = 1;
/** General (1) | Config (2) | Outputs (64) | MediaInputs (256) = 323 (S9 item 2; pesquisa F4). */
export const OBS_EVENT_SUBSCRIPTIONS = 323;
/** Prazo ⚠️ de cada pedido (S9 item 2). */
export const REQUEST_TIMEOUT_MS = 5_000;
/** Prazo do `StopRecord` (S9 item 2). */
export const STOP_RECORD_TIMEOUT_MS = 10_000;
/** Prazo do handshake inteiro (abrir, Hello, Identify, Identified); o mesmo de um pedido. */
export const CONNECT_TIMEOUT_MS = 5_000;
/** Prazo para o outro lado completar o fechamento; depois o TCP é derrubado. */
export const CLOSE_TIMEOUT_MS = 1_000;
/** Onde o dono liga o servidor no OBS (E-9.1). */
export const OBS_SERVER_SETTINGS_MENU = 'Tools › WebSocket Server Settings';

export const OBS_OP = {
  Hello: 0,
  Identify: 1,
  Identified: 2,
  Event: 5,
  Request: 6,
  RequestResponse: 7,
  RequestBatch: 8,
  RequestBatchResponse: 9,
} as const;

export const OBS_CLOSE = { AuthenticationFailed: 4009, SessionInvalidated: 4011 } as const;

export const OBS_BATCH_EXECUTION = { SerialRealtime: 0, SerialFrame: 1, Parallel: 2 } as const;
export type ObsBatchExecutionType = (typeof OBS_BATCH_EXECUTION)[keyof typeof OBS_BATCH_EXECUTION];

export type JsonObject = Record<string, unknown>;

/** `authentication` do Identify (pesquisa F3; `Crypto.cpp` do 5.6.2). */
export function obsAuthentication(password: Secret, salt: string, challenge: string): string {
  const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('base64');
  return sha256(sha256(password.reveal() + salt) + challenge);
}

/** Pedido que o OBS respondeu com `requestStatus.result = false` (ex.: 702 no `CreateRecordChapter`, E-9.4). */
export class ObsRequestError extends Error {
  override readonly name = 'ObsRequestError';
  readonly requestType: string;
  readonly code: number;
  readonly comment: string | undefined;

  constructor(requestType: string, code: number, comment: string | undefined) {
    super(`OBS recusou ${requestType}: código ${code}${comment === undefined ? '' : ` (${comment})`}`);
    this.requestType = requestType;
    this.code = code;
    this.comment = comment;
  }
}

export interface ObsHello {
  /** Presente desde o obs-websocket 5.6.0. */
  obsStudioVersion: string | undefined;
  obsWebSocketVersion: string;
  rpcVersion: number;
  /** O servidor pediu senha (o `challenge` e o `salt` não ficam guardados). */
  authRequired: boolean;
}

export interface ObsEvent {
  eventType: string;
  eventIntent: number;
  eventData: JsonObject;
  /** `process.hrtime.bigint()` na chegada (os eventos do OBS não têm carimbo; pesquisa F12). */
  tRecvNs: bigint;
}

export interface ObsResponse<T> {
  requestType: string;
  data: T;
  /** hrtime logo antes do envio e na chegada da resposta. */
  tSendNs: bigint;
  tRecvNs: bigint;
}

export interface ObsRequestStatus {
  result: boolean;
  code: number;
  comment?: string;
}

export interface ObsBatchRequest {
  requestType: string;
  requestId?: string;
  requestData?: JsonObject;
}

export interface ObsBatchResult {
  requestType: string;
  requestId?: string;
  requestStatus: ObsRequestStatus;
  responseData?: JsonObject;
}

export interface ObsBatchResponse {
  results: ObsBatchResult[];
  tSendNs: bigint;
  tRecvNs: bigint;
}

export interface ObsBatchOptions {
  executionType?: ObsBatchExecutionType;
  haltOnFailure?: boolean;
  timeoutMs?: number;
}

export interface ObsCloseInfo {
  code: number;
  reason: string;
}

/** A senha, ou quem a busca no Chaveiro só se o Hello pedir autenticação. */
export type ObsPassword = Secret | (() => Promise<Secret>);
export type ObsLog = (line: string) => void;

export interface ObsSocketOptions {
  /** Ex.: `ws://127.0.0.1:4455` (`obs.url`). */
  url: string;
  password?: ObsPassword;
  eventSubscriptions?: number;
  connectTimeoutMs?: number;
  /** Prazo comum de pedido e de lote (padrão 5 s). */
  requestTimeoutMs?: number;
  /** Prazo do `StopRecord`, sozinho ou num lote (padrão 10 s). */
  stopRecordTimeoutMs?: number;
  /** Prazo para o outro lado completar o fechamento (padrão 1 s). */
  closeTimeoutMs?: number;
  log?: ObsLog;
}

interface Pending {
  requestType: string;
  resolve: (d: JsonObject, tRecvNs: bigint) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function unreachable(url: string, why: string, data: Record<string, unknown> = {}): ContrarregraError {
  return new ContrarregraError(
    'E_OBS_UNREACHABLE',
    `OBS inalcançável em ${url}: ${why}. Confira se o OBS está aberto e o servidor ligado em ${OBS_SERVER_SETTINGS_MENU}`,
    { url, ...data },
  );
}

function closedDuringHandshake(url: string, code: number, reason: string): ContrarregraError {
  if (code === OBS_CLOSE.AuthenticationFailed) {
    return new ContrarregraError(
      'E_OBS_AUTH',
      `o OBS recusou a senha (fechou com 4009). Confira a senha em ${OBS_SERVER_SETTINGS_MENU} e o item do Chaveiro; não há nova tentativa automática`,
      { url, closeCode: code },
    );
  }
  return unreachable(url, `a conexão fechou durante o handshake (${code}${reason === '' ? '' : ` ${reason}`})`, { closeCode: code });
}

/**
 * Derruba o TCP por baixo do WebSocket. O do Node 22 (undici) não tem prazo de fechamento nem
 * `terminate()`: se o outro lado não devolve o quadro de fechamento e mantém o TCP (OBS travado ou
 * suspenso), a conexão fica em CLOSING para sempre e o evento `close` nunca vem. O socket está no
 * campo interno de símbolo `response` do undici (Node 22.19); sem ele (outra versão do Node), só se
 * desiste de esperar. Devolve se derrubou.
 */
function destroyTransport(ws: WebSocket): boolean {
  for (const symbol of Object.getOwnPropertySymbols(ws)) {
    if (symbol.description !== 'response') continue;
    const response = (ws as unknown as Record<symbol, unknown>)[symbol];
    const socket = isJsonObject(response) ? response['socket'] : undefined;
    if (isJsonObject(socket) && typeof socket['destroy'] === 'function') {
      (socket['destroy'] as () => void).call(socket);
      return true;
    }
  }
  return false;
}

/**
 * Pede o fechamento (1000) e, se o evento `close` não vier em `timeoutMs`, derruba o TCP e chama
 * `onForced`. Nunca espera sem prazo.
 */
function closeWithin(ws: WebSocket, timeoutMs: number, onForced?: (destroyed: boolean) => void): void {
  if (ws.readyState === WebSocket.CLOSED) return;
  const onClose = (): void => clearTimeout(timer);
  const timer = setTimeout(() => {
    ws.removeEventListener('close', onClose);
    const destroyed = ws.readyState !== WebSocket.CLOSED && destroyTransport(ws);
    onForced?.(destroyed);
  }, timeoutMs);
  ws.addEventListener('close', onClose, { once: true });
  if (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN) ws.close(1000);
}

function parseMessage(data: unknown): { op: number; d: JsonObject } | undefined {
  if (typeof data !== 'string') return undefined;
  let message: unknown;
  try {
    message = JSON.parse(data);
  } catch {
    return undefined;
  }
  if (!isJsonObject(message) || typeof message['op'] !== 'number' || !isJsonObject(message['d'])) return undefined;
  return { op: message['op'], d: message['d'] };
}

/** Uma sessão identificada com o obs-websocket. */
export class ObsSocket {
  readonly url: string;
  readonly hello: ObsHello;
  readonly negotiatedRpcVersion: number;
  /** Resolve quando a conexão fecha (por qualquer lado). */
  readonly closed: Promise<ObsCloseInfo>;

  #ws: WebSocket;
  #log: ObsLog;
  #requestTimeoutMs: number;
  #stopRecordTimeoutMs: number;
  #closeTimeoutMs: number;
  #pending = new Map<string, Pending>();
  #listeners = new Set<(event: ObsEvent) => void>();
  #nextId = 0;
  /** `close()` já foi chamado deste lado. */
  #closing = false;
  #closeInfo: ObsCloseInfo | null = null;
  #resolveClosed!: (info: ObsCloseInfo) => void;

  private constructor(ws: WebSocket, url: string, hello: ObsHello, negotiatedRpcVersion: number, options: ObsSocketOptions) {
    this.#ws = ws;
    this.url = url;
    this.hello = hello;
    this.negotiatedRpcVersion = negotiatedRpcVersion;
    this.#log = options.log ?? (() => {});
    this.#requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
    this.#stopRecordTimeoutMs = options.stopRecordTimeoutMs ?? STOP_RECORD_TIMEOUT_MS;
    this.#closeTimeoutMs = options.closeTimeoutMs ?? CLOSE_TIMEOUT_MS;
    this.closed = new Promise((resolve) => {
      this.#resolveClosed = resolve;
    });
    ws.addEventListener('message', (event) => this.#onMessage(event));
    ws.addEventListener('close', (event) => this.#finish(event.code, event.reason));
  }

  /** Abre a conexão e faz Hello → Identify → Identified (E-9.1: `E_OBS_UNREACHABLE`; E-9.2: `E_OBS_AUTH`). */
  static connect(options: ObsSocketOptions): Promise<ObsSocket> {
    const { url } = options;
    const log = options.log ?? (() => {});
    const connectTimeoutMs = options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
    const closeTimeoutMs = options.closeTimeoutMs ?? CLOSE_TIMEOUT_MS;
    return new Promise((resolve, reject) => {
      let ws: WebSocket;
      try {
        ws = new WebSocket(url, [OBS_SUBPROTOCOL]);
      } catch (error) {
        reject(unreachable(url, `endereço inválido (${(error as Error).message})`));
        return;
      }
      log(`obs: conectando a ${url}`);
      let settled = false;
      let hello: ObsHello | undefined;
      let timer: NodeJS.Timeout | undefined;
      /** (Re)arma o prazo do handshake; fica suspenso enquanto a senha é lida (o Chaveiro tem prazo próprio). */
      const armTimer = (): void => {
        clearTimeout(timer);
        timer = setTimeout(() => fail(unreachable(url, `sem handshake em ${connectTimeoutMs} ms`, { timeoutMs: connectTimeoutMs })), connectTimeoutMs);
      };

      const detach = (): void => {
        clearTimeout(timer);
        ws.removeEventListener('open', onOpen);
        ws.removeEventListener('message', onMessage);
        ws.removeEventListener('close', onClose);
        ws.removeEventListener('error', onError);
      };
      // Rejeita na hora; o fechamento segue em segundo plano, com prazo (OBS travado não segura o erro).
      const fail = (error: Error): void => {
        if (settled) return;
        settled = true;
        detach();
        closeWithin(ws, closeTimeoutMs);
        log(`obs: conexão falhou (${error instanceof ContrarregraError ? error.code : error.name})`);
        reject(error);
      };
      const onOpen = (): void => {
        if (ws.protocol !== OBS_SUBPROTOCOL) fail(unreachable(url, `o servidor não aceitou o subprotocolo ${OBS_SUBPROTOCOL}`));
      };
      const onClose = (event: CloseEvent): void => {
        fail(event.code === 1006 && hello === undefined ? unreachable(url, 'sem conexão') : closedDuringHandshake(url, event.code, event.reason));
      };
      // Conexão recusada ou handshake HTTP rejeitado (ex.: sem o subprotocolo): o WebSocket do Node 22
      // dispara `error` e não dispara `close` (fica em CONNECTING). Aberto, o `close` que segue decide.
      const onError = (): void => {
        if (ws.readyState === WebSocket.CONNECTING) fail(unreachable(url, 'sem conexão'));
      };
      const onMessage = (event: MessageEvent): void => {
        const message = parseMessage(event.data);
        if (message === undefined) return;
        if (message.op === OBS_OP.Hello && hello === undefined) {
          void identify(message.d);
        } else if (message.op === OBS_OP.Identified && hello !== undefined) {
          settled = true;
          detach();
          const negotiated = typeof message.d['negotiatedRpcVersion'] === 'number' ? message.d['negotiatedRpcVersion'] : OBS_RPC_VERSION;
          log(`obs: identificado (rpc ${negotiated})`);
          resolve(new ObsSocket(ws, url, hello, negotiated, options));
        }
      };
      const identify = async (d: JsonObject): Promise<void> => {
        const auth = d['authentication'];
        const authRequired = isJsonObject(auth);
        hello = {
          obsStudioVersion: typeof d['obsStudioVersion'] === 'string' ? d['obsStudioVersion'] : undefined,
          obsWebSocketVersion: typeof d['obsWebSocketVersion'] === 'string' ? d['obsWebSocketVersion'] : '',
          rpcVersion: typeof d['rpcVersion'] === 'number' ? d['rpcVersion'] : 0,
          authRequired,
        };
        log(
          `obs: Hello (OBS ${hello.obsStudioVersion ?? '?'}, obs-websocket ${hello.obsWebSocketVersion}, rpc ${hello.rpcVersion}, senha: ${authRequired ? 'sim' : 'não'})`,
        );
        const identifyData: JsonObject = { rpcVersion: OBS_RPC_VERSION, eventSubscriptions: options.eventSubscriptions ?? OBS_EVENT_SUBSCRIPTIONS };
        if (authRequired) {
          if (typeof auth['salt'] !== 'string' || typeof auth['challenge'] !== 'string') {
            fail(unreachable(url, 'Hello com `authentication` sem `salt`/`challenge`'));
            return;
          }
          if (options.password === undefined) {
            fail(new ContrarregraError('E_OBS_AUTH', 'o OBS pede senha e nenhuma foi configurada', { url }));
            return;
          }
          let password: Secret;
          if (typeof options.password === 'function') {
            // A leitura do Chaveiro tem prazo próprio (5 s) e erro próprio (`E_SECRET_MISSING` com a
            // dica certa): fica fora do prazo do handshake, que volta a contar inteiro depois dela.
            clearTimeout(timer);
            try {
              password = await options.password();
            } catch (error) {
              fail(error as Error);
              return;
            }
            if (settled) return;
            armTimer();
          } else {
            password = options.password;
          }
          identifyData['authentication'] = obsAuthentication(password, auth['salt'], auth['challenge']);
        }
        // O Identify (que leva a autenticação) nunca é registrado no log.
        ws.send(JSON.stringify({ op: OBS_OP.Identify, d: identifyData }));
      };
      armTimer();
      ws.addEventListener('open', onOpen);
      ws.addEventListener('message', onMessage);
      ws.addEventListener('close', onClose);
      ws.addEventListener('error', onError);
    });
  }

  get isOpen(): boolean {
    return this.#closeInfo === null && !this.#closing && this.#ws.readyState === WebSocket.OPEN;
  }

  /** Prazo de um pedido: o do `StopRecord` é 10 s, os demais 5 s (S9 item 2). Vale sozinho ou em lote. */
  timeoutFor(requestType: string): number {
    return requestType === 'StopRecord' ? this.#stopRecordTimeoutMs : this.#requestTimeoutMs;
  }

  /** Um pedido (op 6). Falha do OBS → `ObsRequestError`; sem resposta no prazo ou conexão fechada → `E_OBS_UNREACHABLE`. */
  async request<T = JsonObject>(requestType: string, requestData?: JsonObject, options: { timeoutMs?: number } = {}): Promise<ObsResponse<T>> {
    if (requestType === '') throw new TypeError('requestType vazio');
    const requestId = this.#newId();
    const d: JsonObject = { requestType, requestId };
    if (requestData !== undefined) d['requestData'] = requestData;
    const timeoutMs = options.timeoutMs ?? this.timeoutFor(requestType);
    const { d: response, tSendNs, tRecvNs } = await this.#send(OBS_OP.Request, d, requestId, requestType, timeoutMs);
    const status = response['requestStatus'];
    if (!isJsonObject(status) || status['result'] !== true) {
      const code = isJsonObject(status) && typeof status['code'] === 'number' ? status['code'] : 0;
      const comment = isJsonObject(status) && typeof status['comment'] === 'string' ? status['comment'] : undefined;
      throw new ObsRequestError(requestType, code, comment);
    }
    const data = isJsonObject(response['responseData']) ? response['responseData'] : {};
    return { requestType, data: data as T, tSendNs, tRecvNs };
  }

  /** Um lote (op 8). Devolve os resultados crus, um por pedido; não lança por pedido que falhou. */
  async batch(requests: readonly ObsBatchRequest[], options: ObsBatchOptions = {}): Promise<ObsBatchResponse> {
    if (requests.length === 0) throw new TypeError('lote vazio');
    const requestId = this.#newId();
    const executionType = options.executionType ?? OBS_BATCH_EXECUTION.SerialRealtime;
    const d: JsonObject = { requestId, haltOnFailure: options.haltOnFailure ?? false, executionType, requests };
    const label = `RequestBatch(${requests.map((r) => r.requestType).join(',')})`;
    const timeoutMs = options.timeoutMs ?? Math.max(...requests.map((r) => this.timeoutFor(r.requestType)));
    const { d: response, tSendNs, tRecvNs } = await this.#send(OBS_OP.RequestBatch, d, requestId, label, timeoutMs);
    const results = Array.isArray(response['results']) ? (response['results'] as ObsBatchResult[]) : [];
    return { results, tSendNs, tRecvNs };
  }

  /** Assina os eventos (op 5); devolve a função que desassina. */
  onEvent(listener: (event: ObsEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /**
   * Fecha deste lado: rejeita na hora todos os pendentes (`E_OBS_UNREACHABLE`, `reason: 'closed'`),
   * recusa pedidos novos, manda o quadro de fechamento (1000) e resolve quando o OBS completa o
   * fechamento ou, no máximo, em `closeTimeoutMs` (1 s), derrubando o TCP (OBS travado ou suspenso).
   */
  close(): Promise<ObsCloseInfo> {
    if (this.#closeInfo === null && !this.#closing) {
      this.#closing = true;
      this.#rejectPending('a conexão foi fechada por este lado', null);
      closeWithin(this.#ws, this.#closeTimeoutMs, (destroyed) => {
        this.#log(`obs: o OBS não completou o fechamento em ${this.#closeTimeoutMs} ms; ${destroyed ? 'conexão derrubada' : 'desisti de esperar'}`);
        this.#finish(1006, 'fechamento sem resposta do OBS');
      });
    }
    return this.closed;
  }

  #newId(): string {
    this.#nextId += 1;
    return `c${this.#nextId}`;
  }

  #send(
    op: number,
    d: JsonObject,
    requestId: string,
    requestType: string,
    timeoutMs: number | undefined,
  ): Promise<{ d: JsonObject; tSendNs: bigint; tRecvNs: bigint }> {
    if (!this.isOpen) {
      const info = this.#closeInfo;
      return Promise.reject(
        unreachable(this.url, `conexão fechada${info === null ? '' : ` (${info.code})`}; ${requestType} não foi enviado`, {
          requestType,
          closeCode: info?.code ?? null,
          reason: 'closed',
        }),
      );
    }
    const limit = timeoutMs ?? this.#requestTimeoutMs;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(requestId);
        this.#log(`obs: ${requestType} sem resposta em ${limit} ms`);
        reject(unreachable(this.url, `${requestType} sem resposta em ${limit} ms`, { requestType, timeoutMs: limit, reason: 'timeout' }));
      }, limit);
      const tSendNs = process.hrtime.bigint();
      this.#pending.set(requestId, {
        requestType,
        resolve: (response, tRecvNs) => resolve({ d: response, tSendNs, tRecvNs }),
        reject,
        timer,
      });
      this.#ws.send(JSON.stringify({ op, d }));
    });
  }

  #onMessage(event: MessageEvent): void {
    const tRecvNs = process.hrtime.bigint();
    const message = parseMessage(event.data);
    if (message === undefined) {
      this.#log('obs: mensagem ignorada (não é JSON do protocolo)');
      return;
    }
    const { op, d } = message;
    if (op === OBS_OP.Event) {
      if (typeof d['eventType'] !== 'string') return;
      const obsEvent: ObsEvent = {
        eventType: d['eventType'],
        eventIntent: typeof d['eventIntent'] === 'number' ? d['eventIntent'] : 0,
        eventData: isJsonObject(d['eventData']) ? d['eventData'] : {},
        tRecvNs,
      };
      for (const listener of [...this.#listeners]) {
        try {
          listener(obsEvent);
        } catch (error) {
          this.#log(`obs: ouvinte de ${obsEvent.eventType} falhou (${(error as Error).message})`);
        }
      }
      return;
    }
    if (op !== OBS_OP.RequestResponse && op !== OBS_OP.RequestBatchResponse) return;
    const requestId = d['requestId'];
    const pending = typeof requestId === 'string' ? this.#pending.get(requestId) : undefined;
    if (pending === undefined) {
      this.#log(`obs: resposta tardia ou desconhecida ignorada (${String(requestId)})`);
      return;
    }
    this.#pending.delete(requestId as string);
    clearTimeout(pending.timer);
    pending.resolve(d, tRecvNs);
  }

  /** Rejeita todos os pendentes com `E_OBS_UNREACHABLE` (`reason: 'closed'`). */
  #rejectPending(why: string, closeCode: number | null): void {
    for (const [requestId, pending] of this.#pending) {
      this.#pending.delete(requestId);
      clearTimeout(pending.timer);
      pending.reject(
        unreachable(this.url, `${why} com ${pending.requestType} pendente`, { requestType: pending.requestType, closeCode, reason: 'closed' }),
      );
    }
  }

  /** Fim da conexão (evento `close` ou fechamento forçado); idempotente. */
  #finish(code: number, reason: string): void {
    if (this.#closeInfo !== null) return;
    this.#closeInfo = { code, reason };
    const kicked = code === OBS_CLOSE.SessionInvalidated ? ', sessão encerrada pelo OBS' : '';
    this.#log(`obs: conexão fechada (${code}${kicked})`);
    this.#rejectPending(`a conexão fechou (${code}${kicked})`, code);
    this.#listeners.clear();
    this.#resolveClosed(this.#closeInfo);
  }
}
