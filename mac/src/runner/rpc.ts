// JSON-RPC 2.0 sobre o WebSocket global do Node 22 (S0.5; P-2: sem `ws`): uma mensagem de texto = um
// objeto; pedidos com `id` numérico crescente, prazo por pedido, todos os pendentes rejeitados quando a
// conexão fecha (por qualquer lado), notificações do runner (`event`, `log`) entregues a quem assinou.
// Erros da tabela de S0.5 viram `ContrarregraError` com o nome (`E_BUSY`…) e o `data` do runner; os do
// JSON-RPC (-32700…-32603) viram `RpcProtocolError`. Não conhece usbmux nem sessão (isso é `client.ts`).

import { ContrarregraError, RPC_ERROR_CODES, type RpcErrorCode } from '../core/errors.ts';
import type { JsonValue } from '../core/types.ts';
import { RUNNER_UP_HINT } from '../usbmux/client.ts';

/** Prazo padrão no Mac: o do runner (⚠️ 10 s por comando, S1 item 3) mais folga para o transporte. */
export const DEFAULT_CALL_TIMEOUT_MS = 12_000;
/** Prazo para abrir o WebSocket (o túnel usbmux já tem prazo próprio). */
export const OPEN_TIMEOUT_MS = 5_000;
/** Prazo para o outro lado completar o fechamento. */
export const CLOSE_TIMEOUT_MS = 1_000;

type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const RPC_NAMES = new Map<number, RpcErrorCode>(Object.entries(RPC_ERROR_CODES).map(([name, code]) => [code, name as RpcErrorCode]));

/** Erro do JSON-RPC fora da tabela de S0.5 (ex.: -32601 método inexistente, -32602 parâmetros). */
export class RpcProtocolError extends Error {
  override readonly name = 'RpcProtocolError';
  readonly method: string;
  readonly code: number;
  readonly data: unknown;

  constructor(method: string, code: number, message: string, data?: unknown) {
    super(`${method}: ${message} (JSON-RPC ${code})`);
    this.method = method;
    this.code = code;
    this.data = data;
  }
}

/** Converte o `error` de uma resposta: código da tabela de S0.5 → `ContrarregraError`; outro → `RpcProtocolError`. */
export function rpcError(method: string, error: unknown): Error {
  const object = isJsonObject(error) ? error : {};
  const code = typeof object['code'] === 'number' ? object['code'] : 0;
  const message = typeof object['message'] === 'string' ? object['message'] : 'erro sem mensagem';
  const name = RPC_NAMES.get(code);
  if (name === undefined) return new RpcProtocolError(method, code, message, object['data']);
  const raw = object['data'];
  const data = isJsonObject(raw) ? { ...raw } : raw === undefined ? undefined : { detail: raw };
  return new ContrarregraError(name, message, data);
}

export interface RpcCallOptions {
  timeoutMs?: number;
}

export type RpcNotificationHandler = (method: string, params: unknown) => void;

export interface RpcCloseInfo {
  code: number;
  reason: string;
}

interface Pending {
  method: string;
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export interface RpcOpenOptions {
  timeoutMs?: number;
  /** Erro para a falha de abertura (ex.: o do túnel usbmux, que sabe dizer `E_NO_USB`/`E_RUNNER_DOWN`). */
  explainFailure?: () => Error | undefined;
}

function connectionClosed(method: string): ContrarregraError {
  return new ContrarregraError('E_RUNNER_DOWN', `${method}: a conexão com o runner fechou antes da resposta`, {
    reason: 'connection-closed',
    method,
    hint: RUNNER_UP_HINT,
  });
}

/** Uma conexão JSON-RPC aberta com o runner. */
export class RpcConnection {
  readonly url: string;
  /** Resolve quando a conexão fecha (por qualquer lado). */
  readonly closed: Promise<RpcCloseInfo>;

  #ws: WebSocket;
  #pending = new Map<number, Pending>();
  #handlers = new Set<RpcNotificationHandler>();
  #nextId = 1;
  #closeInfo: RpcCloseInfo | null = null;
  #resolveClosed!: (info: RpcCloseInfo) => void;

  private constructor(ws: WebSocket, url: string) {
    this.#ws = ws;
    this.url = url;
    this.closed = new Promise((resolve) => {
      this.#resolveClosed = resolve;
    });
    ws.addEventListener('message', (event) => this.#onMessage(event.data));
    ws.addEventListener('close', (event) => this.#finish(event.code, event.reason));
  }

  /** Abre o WebSocket. Falha → o erro de `explainFailure`, ou `E_RUNNER_DOWN`. */
  static open(url: string, options: RpcOpenOptions = {}): Promise<RpcConnection> {
    const timeoutMs = options.timeoutMs ?? OPEN_TIMEOUT_MS;
    return new Promise((resolve, reject) => {
      let ws: WebSocket;
      try {
        ws = new WebSocket(url);
      } catch (error) {
        reject(new ContrarregraError('E_RUNNER_DOWN', `endereço inválido para o runner: ${url}`, { reason: 'bad-url', url }, { cause: error }));
        return;
      }
      let settled = false;
      const fail = (why: string): void => {
        if (settled) return;
        settled = true;
        cleanup();
        if (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN) ws.close();
        reject(
          options.explainFailure?.() ??
            new ContrarregraError('E_RUNNER_DOWN', `o runner não respondeu ao WebSocket (${why}): rode \`${RUNNER_UP_HINT}\``, {
              reason: 'websocket',
              detail: why,
              hint: RUNNER_UP_HINT,
            }),
        );
      };
      const onOpen = (): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(new RpcConnection(ws, url));
      };
      // Conexão recusada ou handshake rejeitado: o WebSocket do Node 22 dispara `error` (e às vezes não
      // dispara `close`).
      const onError = (): void => fail('sem conexão');
      const onClose = (event: CloseEvent): void => fail(`fechou com ${event.code}`);
      const timer = setTimeout(() => fail(`sem abertura em ${timeoutMs} ms`), timeoutMs);
      const cleanup = (): void => {
        clearTimeout(timer);
        ws.removeEventListener('open', onOpen);
        ws.removeEventListener('error', onError);
        ws.removeEventListener('close', onClose);
      };
      ws.addEventListener('open', onOpen);
      ws.addEventListener('error', onError);
      ws.addEventListener('close', onClose);
    });
  }

  get isOpen(): boolean {
    return this.#closeInfo === null && this.#ws.readyState === WebSocket.OPEN;
  }

  /** Um pedido. Sem resposta no prazo → `E_TIMEOUT`; conexão fechada → `E_RUNNER_DOWN`. */
  call<T = unknown>(method: string, params?: JsonObject, options: RpcCallOptions = {}): Promise<T> {
    if (!this.isOpen) return Promise.reject(connectionClosed(method));
    const id = this.#nextId++;
    const timeoutMs = options.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
    const message: JsonObject = { jsonrpc: '2.0', id, method };
    if (params !== undefined) message['params'] = params;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new ContrarregraError('E_TIMEOUT', `${method}: sem resposta do runner em ${timeoutMs} ms`, { method, timeoutMs }));
      }, timeoutMs);
      this.#pending.set(id, { method, resolve: resolve as (result: unknown) => void, reject, timer });
      try {
        this.#ws.send(JSON.stringify(message));
      } catch (error) {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /** Assina as notificações (`event`, `log`). Devolve a função que cancela. */
  onNotification(handler: RpcNotificationHandler): () => void {
    this.#handlers.add(handler);
    return () => this.#handlers.delete(handler);
  }

  /** Fecha (1000) e espera o fim, com prazo; os pendentes são rejeitados na hora. */
  async close(timeoutMs = CLOSE_TIMEOUT_MS): Promise<void> {
    if (this.#closeInfo !== null) return;
    this.#rejectAll();
    if (this.#ws.readyState === WebSocket.CONNECTING || this.#ws.readyState === WebSocket.OPEN) this.#ws.close(1000);
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([this.closed, new Promise<void>((resolve) => (timer = setTimeout(resolve, timeoutMs)))]);
    clearTimeout(timer);
  }

  #onMessage(data: unknown): void {
    if (typeof data !== 'string') return;
    let message: unknown;
    try {
      message = JSON.parse(data);
    } catch {
      return;
    }
    if (!isJsonObject(message) || message['jsonrpc'] !== '2.0') return;
    const method = message['method'];
    if (typeof method === 'string') {
      if (message['id'] !== undefined) return; // o runner não faz pedidos ao Mac
      for (const handler of this.#handlers) {
        try {
          handler(method, message['params']);
        } catch {
          // quem assinou não derruba a conexão
        }
      }
      return;
    }
    const id = message['id'];
    if (typeof id !== 'number') return;
    const pending = this.#pending.get(id);
    if (pending === undefined) return;
    this.#pending.delete(id);
    clearTimeout(pending.timer);
    if ('error' in message) pending.reject(rpcError(pending.method, message['error']));
    else if ('result' in message) pending.resolve(message['result'] as JsonValue);
    else pending.reject(new RpcProtocolError(pending.method, -32600, 'resposta sem result nem error'));
  }

  #rejectAll(): void {
    for (const [id, pending] of this.#pending) {
      this.#pending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(connectionClosed(pending.method));
    }
  }

  #finish(code: number, reason: string): void {
    if (this.#closeInfo !== null) return;
    this.#closeInfo = { code, reason };
    this.#rejectAll();
    this.#resolveClosed(this.#closeInfo);
  }
}
