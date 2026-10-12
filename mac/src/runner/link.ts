// Linha com o runner que se refaz sozinha (S2 itens 6 e 8): para quem segura uma conexão por muito tempo
// (o supervisor da tomada; fora de tomada, um driver de spike). Batimento a 1 Hz (`health` em `control`,
// `clock.ping` em `sync`); 3 faltas seguidas = caiu. Reconecta com recuo exponencial até 2 s; depois de
// reconectar: `session.hello` (na abertura), `events.fetch {takeId, sinceSeq}` com o último evento
// recebido, e `onReconnected` (a rajada de sincronia de S7 é de quem chama). Nenhum evento se perde: o
// assinante entra na conexão antes do hello; na recuperação, o que chega por notificação fica guardado até
// a resposta do `events.fetch` e sai mesclado com ela, em ordem de `seq` e sem repetir; depois disso
// (inclusive durante `onReconnected`) os eventos saem na hora. Enquanto caída, toda chamada
// falha na hora com o último erro (sem cabo: `E_NO_USB`, "ligue o cabo"). `sever(forS)` fecha os
// próprios sockets usbmux e não reconecta por `forS` segundos, com cabo e sessão do XCTest intactos;
// `installSeverHandler` liga isso ao `sever.json {forS}` + `SIGUSR1` do `runner sever`.

import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import type { Config } from '../core/config.ts';
import { ContrarregraError, isContrarregraError } from '../core/errors.ts';
import type { Event, EventsFetchResult } from '../core/types.ts';
import { openRunner, type OpenRunnerOptions, type RunnerConnection, type RunnerRole } from './client.ts';
import type { RpcCallOptions } from './rpc.ts';
import { RUNNER_UP_HINT } from './session.ts';

export const HEARTBEAT_MS = 1_000;
export const MISSES_TO_DROP = 3;
export const BACKOFF_INITIAL_MS = 100;
export const BACKOFF_MAX_MS = 2_000;
/** O arquivo do pedido de corte na pasta da tomada (S0.8, S2 item 8). */
export const SEVER_FILE = 'sever.json';

/** A espera depois da tentativa falha número `attempt` (0, 1, …): dobra a partir de `initialMs` até `maxMs` (S2 item 6). */
export function backoffDelay(attempt: number, initialMs = BACKOFF_INITIAL_MS, maxMs = BACKOFF_MAX_MS): number {
  return Math.min(initialMs * 2 ** Math.min(attempt, 30), maxMs);
}

/** As `count` primeiras esperas de `backoffDelay`. */
export function backoffDelays(count: number, initialMs = BACKOFF_INITIAL_MS, maxMs = BACKOFF_MAX_MS): number[] {
  return Array.from({ length: count }, (_, attempt) => backoffDelay(attempt, initialMs, maxMs));
}

export type LinkState = 'up' | 'down' | 'severed' | 'closed';

export interface RunnerLinkOptions {
  role: RunnerRole;
  /** Tomada em curso: depois de reconectar, `events.fetch {takeId, sinceSeq}`. */
  takeId?: string;
  /** Repassado a `openRunner` (o supervisor passa o próprio `takeId`). */
  lockOwner?: string;
  heartbeatMs?: number;
  missesToDrop?: number;
  backoffInitialMs?: number;
  backoffMaxMs?: number;
  /** Cada evento novo (notificação `event` ou recuperado por `events.fetch`), em ordem de `seq`, sem repetir. */
  onEvent?: (event: Event) => void;
  /** Depois de cada reconexão (não na primeira abertura): a rajada de sincronia de S7. */
  onReconnected?: (connection: RunnerConnection) => Promise<void> | void;
  onStateChange?: (state: LinkState, error?: Error) => void;
  /** Para testes: como abrir a conexão (padrão: `openRunner(config, …)`). */
  open?: (options: OpenRunnerOptions) => Promise<RunnerConnection>;
}

/** Os eventos de uma conexão: guardados enquanto a recuperação não terminou, entregues na hora depois. */
interface Inbox {
  buffering: boolean;
  buffered: Event[];
}

function isEvent(value: unknown): value is Event {
  return typeof value === 'object' && value !== null && typeof (value as { seq?: unknown }).seq === 'number';
}

const localLinks = new Set<RunnerLink>();

/** As linhas abertas neste processo ("o próprio processo fora de tomada", S2 item 8). */
export function openLinks(): RunnerLink[] {
  return [...localLinks];
}

export class RunnerLink {
  readonly role: RunnerRole;
  #config: Config;
  #options: RunnerLinkOptions;
  #connection: RunnerConnection | undefined;
  #state: LinkState = 'down';
  #lastError: Error | undefined;
  #lastSeq: number | undefined;
  #misses = 0;
  #heartbeat: NodeJS.Timeout | undefined;
  #severedUntil = 0;
  #reconnecting: Promise<void> | undefined;
  #wake: (() => void) | undefined;
  #reconnects = 0;

  private constructor(config: Config, options: RunnerLinkOptions) {
    this.#config = config;
    this.#options = options;
    this.role = options.role;
  }

  /** Abre a linha; a primeira abertura tem de dar certo (`E_NO_USB`, `E_RUNNER_DOWN`, `E_BUSY` sobem). */
  static async connect(config: Config, options: RunnerLinkOptions): Promise<RunnerLink> {
    const link = new RunnerLink(config, options);
    const connection = await link.#open({ buffering: false, buffered: [] });
    link.#attach(connection);
    localLinks.add(link);
    return link;
  }

  get state(): LinkState {
    return this.#state;
  }

  /** O maior `seq` de evento recebido. */
  get lastSeq(): number | undefined {
    return this.#lastSeq;
  }

  /** Quantas reconexões deram certo. */
  get reconnects(): number {
    return this.#reconnects;
  }

  get connection(): RunnerConnection | undefined {
    return this.#state === 'up' ? this.#connection : undefined;
  }

  /** Uma chamada pela conexão atual; caída, falha na hora com o motivo. */
  call<T = unknown>(method: string, params?: Record<string, unknown>, options?: RpcCallOptions): Promise<T> {
    const connection = this.connection;
    if (connection === undefined) return Promise.reject(this.#unavailable(method));
    return connection.call<T>(method, params, options);
  }

  /** Fecha os próprios sockets e não reconecta por `forS` segundos (S2 item 8). */
  sever(forS: number): void {
    if (this.#state === 'closed') return;
    this.#severedUntil = Date.now() + Math.max(0, forS) * 1000;
    this.#drop('severed', new ContrarregraError('E_RUNNER_DOWN', `conexão cortada de propósito por ${forS} s (runner sever)`, { reason: 'severed', forS }));
  }

  async close(): Promise<void> {
    if (this.#state === 'closed') return;
    this.#setState('closed');
    localLinks.delete(this);
    clearInterval(this.#heartbeat);
    this.#wake?.();
    const connection = this.#connection;
    this.#connection = undefined;
    await connection?.close();
    await this.#reconnecting;
  }

  /** Lido por método: o estado muda entre os `await` (o TypeScript não enxerga). */
  #isClosed(): boolean {
    return this.#state === 'closed';
  }

  #unavailable(method: string): Error {
    const last = this.#lastError;
    if (this.#state === 'closed') return new ContrarregraError('E_RUNNER_DOWN', `${method}: a linha com o runner foi fechada`, { reason: 'closed', method });
    if (isContrarregraError(last, 'E_NO_USB')) return new ContrarregraError('E_NO_USB', `${method}: sem cabo — ligue o cabo USB (${last.message})`, { ...last.data, method });
    if (this.#state === 'severed') return new ContrarregraError('E_RUNNER_DOWN', `${method}: conexão cortada de propósito (runner sever)`, { reason: 'severed', method });
    return new ContrarregraError('E_RUNNER_DOWN', `${method}: reconectando ao runner${last === undefined ? '' : ` (${last.message})`}`, {
      reason: 'reconnecting',
      method,
      cause: isContrarregraError(last) ? last.code : null,
      hint: RUNNER_UP_HINT,
    });
  }

  #open(inbox: Inbox): Promise<RunnerConnection> {
    const options: OpenRunnerOptions = {
      role: this.role,
      onNotification: (method, params) => {
        if (method !== 'event' || !isEvent(params) || this.#isClosed()) return;
        if (inbox.buffering) inbox.buffered.push(params);
        else this.#deliver(params);
      },
    };
    if (this.#options.lockOwner !== undefined) options.lockOwner = this.#options.lockOwner;
    return this.#options.open ? this.#options.open(options) : openRunner(this.#config, options);
  }

  #setState(state: LinkState, error?: Error): void {
    if (this.#state === state) return;
    this.#state = state;
    this.#options.onStateChange?.(state, error);
  }

  #deliver(event: Event): void {
    if (this.#lastSeq !== undefined && event.seq <= this.#lastSeq) return;
    this.#lastSeq = event.seq;
    this.#options.onEvent?.(event);
  }

  #attach(connection: RunnerConnection): void {
    this.#connection = connection;
    this.#misses = 0;
    this.#setState('up');
    void connection.closed.then(() => {
      if (this.#connection === connection && this.#state === 'up') this.#drop('down', new ContrarregraError('E_RUNNER_DOWN', 'a conexão com o runner fechou', { reason: 'connection-closed' }));
    });
    clearInterval(this.#heartbeat);
    const heartbeatMs = this.#options.heartbeatMs ?? HEARTBEAT_MS;
    let seq = 0;
    this.#heartbeat = setInterval(() => {
      if (this.#connection !== connection || this.#state !== 'up') return;
      const beat =
        this.role === 'control'
          ? connection.call('health', {}, { timeoutMs: heartbeatMs })
          : connection.call('clock.ping', { seq: seq++ }, { timeoutMs: heartbeatMs });
      beat.then(
        () => {
          if (this.#connection === connection) this.#misses = 0;
        },
        (error: unknown) => {
          if (this.#connection !== connection || this.#state !== 'up') return;
          this.#misses += 1;
          if (this.#misses >= (this.#options.missesToDrop ?? MISSES_TO_DROP)) {
            this.#drop(
              'down',
              new ContrarregraError('E_RUNNER_DOWN', `${this.#misses} batimentos seguidos sem resposta`, { reason: 'heartbeat', misses: this.#misses, cause: String(error) }),
            );
          }
        },
      );
    }, heartbeatMs);
    this.#heartbeat.unref();
  }

  /** Larga a conexão atual e começa a reconectar (no fundo). */
  #drop(state: 'down' | 'severed', error: Error): void {
    clearInterval(this.#heartbeat);
    this.#lastError = error;
    const connection = this.#connection;
    this.#connection = undefined;
    this.#setState(state, error);
    void connection?.close();
    this.#reconnecting ??= this.#reconnect().finally(() => {
      this.#reconnecting = undefined;
    });
  }

  async #waitOrWake(ms: number): Promise<void> {
    if (ms <= 0) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(done, ms);
      function done(): void {
        clearTimeout(timer);
        resolve();
      }
      this.#wake = done;
    });
    this.#wake = undefined;
  }

  async #reconnect(): Promise<void> {
    const initialMs = this.#options.backoffInitialMs ?? BACKOFF_INITIAL_MS;
    const maxMs = this.#options.backoffMaxMs ?? BACKOFF_MAX_MS;
    let failures = 0;
    const backoff = (): Promise<void> => this.#waitOrWake(backoffDelay(failures++, initialMs, maxMs));
    for (;;) {
      if (this.#isClosed()) return;
      const severedFor = this.#severedUntil - Date.now();
      if (severedFor > 0) {
        await this.#waitOrWake(severedFor);
        continue;
      }
      if (this.#state === 'severed') this.#setState('down', this.#lastError);
      // Com tomada, os eventos que chegarem antes da resposta do events.fetch ficam guardados.
      const inbox: Inbox = { buffering: this.#fetchesEvents(), buffered: [] };
      let connection: RunnerConnection;
      try {
        connection = await this.#open(inbox);
      } catch (error) {
        this.#lastError = error instanceof Error ? error : new Error(String(error));
        await backoff();
        continue;
      }
      if (this.#isClosed() || this.#severedUntil > Date.now()) {
        await connection.close();
        continue;
      }
      try {
        await this.#recover(connection, inbox);
      } catch (error) {
        this.#lastError = error instanceof Error ? error : new Error(String(error));
        await connection.close();
        await backoff();
        continue;
      }
      if (this.#isClosed() || this.#severedUntil > Date.now()) {
        await connection.close();
        continue;
      }
      this.#reconnects += 1;
      this.#attach(connection);
      return;
    }
  }

  #fetchesEvents(): boolean {
    return this.#options.takeId !== undefined && this.role === 'control';
  }

  /**
   * Depois do hello (já feito na abertura): os eventos perdidos — a resposta do `events.fetch` mesclada
   * com o que chegou por notificação enquanto ela não vinha — e o gancho de quem chama (S2 item 6).
   */
  async #recover(connection: RunnerConnection, inbox: Inbox): Promise<void> {
    const takeId = this.#options.takeId;
    if (takeId !== undefined && this.#fetchesEvents()) {
      const fetched = await connection.call<EventsFetchResult>('events.fetch', { takeId, sinceSeq: this.#lastSeq ?? 0 });
      const fetchedEvents = Array.isArray(fetched?.events) ? fetched.events.filter(isEvent) : [];
      const merged = [...fetchedEvents, ...inbox.buffered].sort((a, b) => a.seq - b.seq);
      // Sem `await` entre ligar a entrega direta e esvaziar a mescla: nada fura a ordem.
      inbox.buffering = false;
      inbox.buffered = [];
      for (const event of merged) this.#deliver(event);
    }
    await this.#options.onReconnected?.(connection);
  }
}

/** Corta as linhas abertas neste processo (fora de tomada, S2 item 8). Devolve quantas. */
export function severLocalLinks(forS: number): number {
  const links = openLinks().filter((link) => link.state !== 'closed');
  for (const link of links) link.sever(forS);
  return links.length;
}

/**
 * Liga o `SIGUSR1` ao pedido de corte: lê e apaga `<dir>/sever.json {forS}` e corta as linhas de
 * `links()`. Pedido sem arquivo ou com `forS` inválido é ignorado. Devolve a função que desliga.
 */
export function installSeverHandler(dir: string, links: () => Iterable<RunnerLink> = openLinks): () => void {
  const handler = (): void => {
    const path = join(dir, SEVER_FILE);
    let forS: unknown;
    try {
      forS = (JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>)['forS'];
    } catch {
      return;
    } finally {
      rmSync(path, { force: true });
    }
    if (typeof forS !== 'number' || !Number.isFinite(forS) || forS <= 0) return;
    for (const link of links()) link.sever(forS);
  };
  process.on('SIGUSR1', handler);
  return () => void process.off('SIGUSR1', handler);
}
