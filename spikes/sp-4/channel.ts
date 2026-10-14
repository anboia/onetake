// Canal do SP-4 (T-0.19; S2 item 2, ADR-9) com cronômetro por etapa: as mesmas peças de `mac/src` que o
// `openRunner` usa (ListDevices → repassador em 127.0.0.1 → túnel usbmux → WebSocket → `session.hello`), na mesma
// ordem, sem a leitura do estado da sessão nem o `ps` do `requireLiveSession` (custo só do Mac, feito uma vez no
// começo do driver). Também o `Connect` cru (sem WebSocket), o retrato do `ListDevices` com o `SerialNumber` cru e a
// sonda de alcance do loopback. Código de spike, descartável (architecture.md A5).

import type { Secret } from '../../mac/src/core/secret.ts';
import { SessionHelloResultSchema, validate } from '../../mac/src/core/schema.ts';
import { ContrarregraError, isContrarregraError } from '../../mac/src/core/errors.ts';
import type { SessionHelloResult } from '../../mac/src/core/types.ts';
import { clientInfo, HELLO_TIMEOUT_MS, type RunnerConnection, type RunnerRole } from '../../mac/src/runner/client.ts';
import { RpcConnection, type RpcNotificationHandler } from '../../mac/src/runner/rpc.ts';
import type { SessionState } from '../../mac/src/runner/session.ts';
import { connectDevice, findUsbDevice, listDevices, selectUsbDevice } from '../../mac/src/usbmux/client.ts';
import { startForwarder, type Forwarder } from '../../mac/src/usbmux/forwarder.ts';
import type { PlistValue } from '../../mac/src/usbmux/plist.ts';
import { normalizeSerial } from '../../mac/src/usbmux/protocol.ts';

const hr = (): bigint => process.hrtime.bigint();
const ms = (ns: bigint): number => Math.round(Number(ns) / 1e3) / 1e3;

export interface UsbmuxTarget {
  /** `usbmux.socketPath`. */
  socketPath: string;
  /** `device.udid`. */
  udid: string;
  /** Porta do runner no loopback do aparelho (a da sessão). */
  port: number;
  /** Prazo de cada troca com o usbmuxd (padrão: o do cliente, 750 ms). */
  timeoutMs?: number;
}

export interface ChannelOptions extends UsbmuxTarget {
  role: RunnerRole;
  /** O token da sessão (lido uma vez do `.xctestrun`). */
  token: Secret;
  /** Devolvido em `RunnerConnection.session` (para a `RunnerLink`). */
  session: SessionState;
  helloTimeoutMs?: number;
  /** Ligado antes do `session.hello`, como no `openRunner`. */
  onNotification?: RpcNotificationHandler;
}

/** Etapas da abertura, em ms: `list` (ListDevices), `fwd` (escuta local), `ws` (ListDevices + Connect + upgrade), `hello`. */
export type ChannelPhases = Record<'list' | 'fwd' | 'ws' | 'hello', number>;

export interface Channel extends RunnerConnection {
  readonly phases: ChannelPhases;
}

/** Abre uma conexão com o runner como o `openRunner` (S2 itens 2–3), cronometrando cada etapa. */
export async function openChannel(o: ChannelOptions): Promise<Channel> {
  const usbmux = { socketPath: o.socketPath, ...(o.timeoutMs === undefined ? {} : { timeoutMs: o.timeoutMs }) };
  const t0 = hr();
  await findUsbDevice({ ...usbmux, udid: o.udid });
  const t1 = hr();
  let tunnelError: ContrarregraError | undefined;
  const forwarder: Forwarder = await startForwarder({
    ...usbmux,
    udid: o.udid,
    port: o.port,
    onTunnelError: (error) => {
      tunnelError = error;
    },
  });
  const t2 = hr();
  let rpc: RpcConnection;
  try {
    rpc = await RpcConnection.open(`ws://${forwarder.host}:${forwarder.port}/`, { explainFailure: () => tunnelError });
  } catch (error) {
    await forwarder.close();
    throw error;
  }
  const t3 = hr();
  if (o.onNotification !== undefined) rpc.onNotification(o.onNotification);
  const close = async (): Promise<void> => {
    await rpc.close();
    await forwarder.close();
  };
  void rpc.closed.then(() => forwarder.close());
  let hello: SessionHelloResult;
  try {
    const result = await rpc.call('session.hello', { token: o.token.reveal(), role: o.role, client: clientInfo() }, {
      timeoutMs: o.helloTimeoutMs ?? HELLO_TIMEOUT_MS,
    });
    const checked = validate(SessionHelloResultSchema, result);
    if (!checked.ok) {
      throw new ContrarregraError('E_RUNNER_DOWN', 'a resposta do session.hello não segue S0.5', { reason: 'protocol-mismatch', errors: checked.errors });
    }
    hello = checked.value;
  } catch (error) {
    await close();
    throw error;
  }
  const t4 = hr();
  return {
    role: o.role,
    session: o.session,
    hello,
    phases: { list: ms(t1 - t0), fwd: ms(t2 - t1), ws: ms(t3 - t2), hello: ms(t4 - t3) },
    closed: rpc.closed,
    get isOpen() {
      return rpc.isOpen;
    },
    call: (method, params, callOptions) => rpc.call(method, params, callOptions),
    onNotification: (handler) => rpc.onNotification(handler),
    close,
  };
}

/** `Connect` cru: ListDevices + `Connect` até o `Result 0`, sem WebSocket; o túnel é fechado na hora. */
export async function rawConnect(o: UsbmuxTarget): Promise<{ list: number; connect: number }> {
  const usbmux = { socketPath: o.socketPath, ...(o.timeoutMs === undefined ? {} : { timeoutMs: o.timeoutMs }) };
  const t0 = hr();
  const device = await findUsbDevice({ ...usbmux, udid: o.udid });
  const t1 = hr();
  const socket = await connectDevice(usbmux, device.deviceId, o.port);
  const t2 = hr();
  socket.on('error', () => {});
  socket.destroy();
  return { list: ms(t1 - t0), connect: ms(t2 - t1) };
}

/** Um valor de plist em JSON (inteiros grandes como texto, dados em base64). */
export function plainPlist(value: PlistValue): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Uint8Array) return { base64: Buffer.from(value).toString('base64') };
  if (Array.isArray(value)) return value.map(plainPlist);
  if (typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, plainPlist(v)]));
  return value;
}

export interface UsbmuxEntry {
  deviceId: number;
  connectionType: string;
  /** O `SerialNumber` cru, como o usbmuxd mandou (S2 item 2: "o formato cru é registrado no SP-4"). */
  serialNumber: string;
  properties: unknown;
}

export interface UsbmuxSnapshot {
  entries: UsbmuxEntry[];
  /** A entrada `USB` escolhida pela regra de S2 item 2, ou `null` (com `error`). */
  usb: { deviceId: number; serialRaw: string; hyphenated: boolean; normalized: string; matchesUdid: boolean } | null;
  error: string | null;
}

/** `ListDevices` inteiro, com o `SerialNumber` cru de cada entrada, e a escolha da entrada USB do UDID. */
export async function usbmuxSnapshot(o: Omit<UsbmuxTarget, 'port'>): Promise<UsbmuxSnapshot> {
  const devices = await listDevices({ socketPath: o.socketPath, ...(o.timeoutMs === undefined ? {} : { timeoutMs: o.timeoutMs }) });
  const entries = devices.map((d) => ({ deviceId: d.deviceId, connectionType: d.connectionType, serialNumber: d.serialNumber, properties: plainPlist(d.properties) }));
  try {
    const usb = selectUsbDevice(devices, o.udid);
    return {
      entries,
      usb: {
        deviceId: usb.deviceId,
        serialRaw: usb.serialNumber,
        hyphenated: usb.serialNumber.includes('-'),
        normalized: normalizeSerial(usb.serialNumber),
        matchesUdid: normalizeSerial(usb.serialNumber) === normalizeSerial(o.udid),
      },
      error: null,
    };
  } catch (error) {
    return { entries, usb: null, error: isContrarregraError(error) ? `${error.code}: ${error.message}` : String(error) };
  }
}

export type Reach = 'reachable' | 'unreachable' | 'not-ready' | 'no-usb';

export interface ReachAttempt {
  ok: boolean;
  ms: number;
  err?: string;
}

/**
 * Sonda de alcance do loopback (T-0.11, T-0.19): até `attempts` `Connect` crus, `retryMs` entre eles. Algum dá
 * `Result 0` → `reachable`. Todos recusados (`Result 3` → `E_RUNNER_DOWN`) com o runner pronto (a linha
 * `CONTRARREGRA_READY` no registro do `xcodebuild`, A13) → `unreachable` (o plano B); sem a linha → `not-ready`.
 * Sem a entrada USB → `no-usb`.
 */
export async function probeReach(
  o: UsbmuxTarget & { attempts: number; retryMs: number; ready: boolean; sleep: (ms: number) => Promise<void> },
): Promise<{ verdict: Reach; attempts: ReachAttempt[] }> {
  const attempts: ReachAttempt[] = [];
  for (let i = 0; i < o.attempts; i++) {
    const t0 = hr();
    try {
      await rawConnect(o);
      attempts.push({ ok: true, ms: ms(hr() - t0) });
      return { verdict: 'reachable', attempts };
    } catch (error) {
      const err = isContrarregraError(error) ? `${error.code}${typeof error.data?.['reason'] === 'string' ? `/${error.data['reason']}` : ''}` : String(error);
      attempts.push({ ok: false, ms: ms(hr() - t0), err });
      if (isContrarregraError(error, 'E_NO_USB')) return { verdict: 'no-usb', attempts };
    }
    if (i + 1 < o.attempts) await o.sleep(o.retryMs);
  }
  return { verdict: o.ready ? 'unreachable' : 'not-ready', attempts };
}

/** A última linha `CONTRARREGRA_READY port=<p> bind=<b>` do registro do `xcodebuild` (A13), ou `undefined`. */
export function readyLine(logText: string): { port: number; bind: string } | undefined {
  let last: { port: number; bind: string } | undefined;
  for (const m of logText.matchAll(/CONTRARREGRA_READY port=(\d+) bind=([a-z]+)/g)) last = { port: Number(m[1]), bind: m[2] ?? '' };
  return last;
}
