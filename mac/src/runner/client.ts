// Conexão com o runner no aparelho (S2 itens 2, 3 e 7; S0.5): cabo (`E_NO_USB` em ≤ 1 s) → sessão viva
// (`E_RUNNER_DOWN` com a dica `runner up`) → repassador local em 127.0.0.1 → túnel usbmux até
// `runner.port` no aparelho → WebSocket → `session.hello {token, role, client}`. A CLI e o MCP abrem
// `control` por comando (`withRunner`: hello → chamada → fecha); com a trava de uma tomada no aparelho,
// `control` é recusado com `E_BUSY` e o `takeId` (só o supervisor, dono da trava, passa).

import type { Config } from '../core/config.ts';
import { ContrarregraError, isContrarregraError } from '../core/errors.ts';
import { SessionHelloResultSchema, validate } from '../core/schema.ts';
import type { JsonValue, SessionHelloResult } from '../core/types.ts';
import { findUsbDevice } from '../usbmux/client.ts';
import { startForwarder, type Forwarder } from '../usbmux/forwarder.ts';
import { runnerPaths } from './paths.ts';
import { RpcConnection, type RpcCallOptions, type RpcCloseInfo, type RpcNotificationHandler } from './rpc.ts';
import { assertNoTake, currentSession, readSessionToken, RUNNER_UP_HINT, sessionAlive, type SessionState } from './session.ts';

export type RunnerRole = 'control' | 'sync';

/** Prazo do `session.hello` (fila de controle do runner, nunca espera o XCTest). */
export const HELLO_TIMEOUT_MS = 5_000;

/** O `client` do `session.hello`. */
export function clientInfo(): JsonValue {
  return { name: 'contrarregra', pid: process.pid };
}

export interface OpenRunnerOptions {
  role: RunnerRole;
  /** Sessão a usar; padrão: a mais recente em `paths.cache/sessions/`. */
  session?: SessionState;
  /** O supervisor passa o `takeId` da própria trava; os demais recebem `E_BUSY` com a trava de outra tomada. */
  lockOwner?: string;
  helloTimeoutMs?: number;
  /**
   * Assinante das notificações (`event`, `log`) ligado **antes** do `session.hello`: depois do hello o
   * runner já trata a conexão como controlador e manda eventos, que chegariam sem ninguém para recebê-los.
   */
  onNotification?: RpcNotificationHandler;
}

export interface RunnerConnection {
  readonly role: RunnerRole;
  readonly session: SessionState;
  readonly hello: SessionHelloResult;
  readonly closed: Promise<RpcCloseInfo>;
  readonly isOpen: boolean;
  call<T = unknown>(method: string, params?: Record<string, unknown>, options?: RpcCallOptions): Promise<T>;
  onNotification(handler: RpcNotificationHandler): () => void;
  /** Fecha o WebSocket e o repassador (o túnel usbmux junto). Idempotente. */
  close(): Promise<void>;
}

function runnerDown(message: string, data: Record<string, unknown>): ContrarregraError {
  return new ContrarregraError('E_RUNNER_DOWN', message, { ...data, hint: RUNNER_UP_HINT });
}

/** A sessão viva do runner, ou `E_RUNNER_DOWN` com a dica `runner up` (S2 item 7). */
export function requireLiveSession(config: Config, session?: SessionState): SessionState {
  const state = session ?? currentSession(runnerPaths(config));
  if (state === undefined) throw runnerDown(`o runner não está de pé (nenhuma sessão): rode \`${RUNNER_UP_HINT}\``, { reason: 'no-session' });
  if (!sessionAlive(state)) {
    throw runnerDown(`o runner caiu: o xcodebuild da sessão ${state.sessionId} saiu; nada religa sozinho, rode \`${RUNNER_UP_HINT}\``, {
      reason: 'xcodebuild-exited',
      sessionId: state.sessionId,
    });
  }
  return state;
}

/** Abre uma conexão com o runner e faz o `session.hello`. */
export async function openRunner(config: Config, options: OpenRunnerOptions): Promise<RunnerConnection> {
  const paths = runnerPaths(config);
  if (options.role === 'control') {
    const takeId = options.lockOwner;
    try {
      assertNoTake(paths, 'control');
    } catch (error) {
      if (!(isContrarregraError(error, 'E_BUSY') && takeId !== undefined && error.data?.['takeId'] === takeId)) throw error;
    }
  }
  const socketPath = config.usbmux.socketPath;
  const udid = config.device.udid;
  await findUsbDevice({ socketPath, udid });
  const session = requireLiveSession(config, options.session);
  const token = readSessionToken(session);

  let tunnelError: ContrarregraError | undefined;
  const forwarder: Forwarder = await startForwarder({
    socketPath,
    udid,
    port: session.port,
    onTunnelError: (error) => {
      tunnelError = error;
    },
  });
  let rpc: RpcConnection;
  try {
    rpc = await RpcConnection.open(`ws://${forwarder.host}:${forwarder.port}/`, { explainFailure: () => tunnelError });
  } catch (error) {
    await forwarder.close();
    throw error;
  }
  if (options.onNotification !== undefined) rpc.onNotification(options.onNotification);
  const close = async (): Promise<void> => {
    await rpc.close();
    await forwarder.close();
  };
  // O WebSocket fechou sozinho (runner caiu, cabo saiu): o repassador vai junto.
  void rpc.closed.then(() => forwarder.close());

  let hello: SessionHelloResult;
  try {
    const result = await rpc.call('session.hello', { token: token.reveal(), role: options.role, client: clientInfo() }, {
      timeoutMs: options.helloTimeoutMs ?? HELLO_TIMEOUT_MS,
    });
    const checked = validate(SessionHelloResultSchema, result);
    if (!checked.ok) {
      throw new ContrarregraError('E_RUNNER_DOWN', 'a resposta do session.hello não segue S0.5: o runner instalado é de outra versão?', {
        reason: 'protocol-mismatch',
        errors: checked.errors,
        hint: 'contrarregra runner build && contrarregra runner up',
      });
    }
    hello = checked.value;
  } catch (error) {
    await close();
    throw error;
  }

  return {
    role: options.role,
    session,
    hello,
    closed: rpc.closed,
    get isOpen() {
      return rpc.isOpen;
    },
    call: (method, params, callOptions) => rpc.call(method, params, callOptions),
    onNotification: (handler) => rpc.onNotification(handler),
    close,
  };
}

/** Abre, roda `fn` e fecha sempre (S2 item 3: a CLI e o MCP abrem `control` por comando). */
export async function withRunner<T>(config: Config, options: OpenRunnerOptions, fn: (connection: RunnerConnection) => Promise<T>): Promise<T> {
  const connection = await openRunner(config, options);
  try {
    return await fn(connection);
  } finally {
    await connection.close();
  }
}
