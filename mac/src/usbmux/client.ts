// Cliente usbmuxd nativo (S2 item 2; ADR-9): `ListDevices`, `Listen` e `Connect` pelo socket Unix
// `usbmux.socketPath`. Só aceita a entrada `USB` cujo `SerialNumber` normalizado é o UDID configurado
// normalizado; `Connect {DeviceID, PortNumber: htons(porta)}` devolve o socket já como túnel TCP cru até
// o loopback do aparelho. Uma conexão nova ao usbmuxd por pedido e nenhuma nova tentativa às cegas
// (E-2.1): quem decide repetir é quem chamou.

import { createConnection, type Socket } from 'node:net';

import { ContrarregraError } from '../core/errors.ts';
import { isPlistDict, type PlistDict, type PlistValue } from './plist.ts';
import { CLIENT_FIELDS, decodeMessage, encodeFrame, FrameDecoder, htons, normalizeSerial, RESULT } from './protocol.ts';

/** Prazo padrão de cada troca com o usbmuxd: cabe no `E_NO_USB` em ≤ 1 s de E-2.1, com folga. */
export const DEFAULT_TIMEOUT_MS = 750;
/** A dica de S2 item 7 para `E_RUNNER_DOWN`. */
export const RUNNER_UP_HINT = 'contrarregra runner up';

export interface UsbmuxOptions {
  /** `usbmux.socketPath` da configuração. */
  socketPath: string;
  /** Prazo de cada troca (abrir o socket, pedir e receber a resposta). Padrão: `DEFAULT_TIMEOUT_MS`. */
  timeoutMs?: number;
}

export interface UsbmuxDevice {
  /** A alça do usbmuxd para o aparelho (muda quando o cabo é religado). */
  deviceId: number;
  /** `USB`, `Network`… como o usbmuxd informou. */
  connectionType: string;
  /** O `SerialNumber` cru, como o usbmuxd informou (o formato é registrado no SP-4). */
  serialNumber: string;
  properties: PlistDict;
}

export type UsbmuxEvent =
  | { type: 'attached'; device: UsbmuxDevice }
  | { type: 'detached'; deviceId: number }
  | { type: 'paired'; deviceId: number };

export interface UsbmuxListener {
  /** Fecha o socket do `Listen`. Idempotente. */
  close(): void;
  /** Cumprida quando o socket fecha, por `close()` ou pelo usbmuxd. */
  readonly closed: Promise<void>;
}

function noUsb(message: string, data: Record<string, unknown>, cause?: unknown): ContrarregraError {
  return new ContrarregraError('E_NO_USB', message, data, cause === undefined ? undefined : { cause });
}

let lastTag = 0;
function nextTag(): number {
  lastTag = lastTag >= 0xffff_ffff ? 1 : lastTag + 1;
  return lastTag;
}

interface Exchange {
  /** Pausado; quem recebe religa com `pipe()`/`resume()`. */
  socket: Socket;
  reply: PlistDict;
  /** Ainda pode guardar quadros (`Listen`) ou bytes crus (`Connect`) que chegaram junto com a resposta. */
  decoder: FrameDecoder;
}

/**
 * Abre uma conexão ao usbmuxd, manda um pedido e espera a resposta com a mesma tag, dentro do prazo.
 * `allowHalfOpen` é para o `Connect`: no túnel, o FIN de um sentido não pode fechar o outro.
 */
function exchange(options: UsbmuxOptions, messageType: string, fields: PlistDict = {}, allowHalfOpen = false): Promise<Exchange> {
  const { socketPath } = options;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const tag = nextTag();
  return new Promise((resolve, reject) => {
    const socket = createConnection({ path: socketPath, allowHalfOpen });
    const decoder = new FrameDecoder();
    const cleanup = (): void => {
      clearTimeout(timer);
      socket.off('connect', onConnect);
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('end', onClose);
      socket.off('close', onClose);
    };
    const fail = (error: ContrarregraError): void => {
      cleanup();
      socket.on('error', () => {});
      socket.destroy();
      reject(error);
    };
    const onConnect = (): void => {
      socket.write(encodeFrame(tag, { MessageType: messageType, ...CLIENT_FIELDS, ...fields }));
    };
    const onData = (chunk: Buffer): void => {
      decoder.push(chunk);
      try {
        for (let frame = decoder.next(); frame !== undefined; frame = decoder.next()) {
          if (frame.tag !== tag) continue;
          const reply = decodeMessage(frame);
          cleanup();
          socket.pause();
          resolve({ socket, reply, decoder });
          return;
        }
      } catch (error) {
        fail(noUsb(`resposta inválida do usbmuxd ao ${messageType}: ${(error as Error).message}`, { reason: 'usbmuxd-protocol', socketPath }, error));
      }
    };
    const onError = (error: NodeJS.ErrnoException): void => {
      fail(
        noUsb(
          `não consegui falar com o usbmuxd em ${socketPath} (${error.code ?? error.message})`,
          { reason: 'usbmuxd-unreachable', socketPath, errno: error.code ?? null },
          error,
        ),
      );
    };
    const onClose = (): void => {
      fail(noUsb(`o usbmuxd fechou a conexão antes de responder ao ${messageType}`, { reason: 'usbmuxd-unreachable', socketPath }));
    };
    const timer = setTimeout(() => {
      fail(noUsb(`o usbmuxd não respondeu ao ${messageType} em ${timeoutMs} ms (${socketPath})`, { reason: 'usbmuxd-timeout', socketPath, timeoutMs }));
    }, timeoutMs);
    socket.on('connect', onConnect);
    socket.on('data', onData);
    socket.on('error', onError);
    // Com `allowHalfOpen`, o FIN do usbmuxd antes da resposta não fecha o socket: `end` também é falha.
    socket.on('end', onClose);
    socket.on('close', onClose);
  });
}

function discard(socket: Socket): void {
  socket.on('error', () => {});
  socket.destroy();
}

/** Uma entrada de `DeviceList` ou de um evento `Attached`; entradas sem os campos de S2 são ignoradas. */
function parseDevice(entry: PlistValue | undefined): UsbmuxDevice | undefined {
  if (!isPlistDict(entry)) return undefined;
  const properties = entry['Properties'];
  if (!isPlistDict(properties)) return undefined;
  const deviceId = entry['DeviceID'] ?? properties['DeviceID'];
  const connectionType = properties['ConnectionType'];
  const serialNumber = properties['SerialNumber'];
  if (typeof deviceId !== 'number' || typeof connectionType !== 'string' || typeof serialNumber !== 'string') return undefined;
  return { deviceId, connectionType, serialNumber, properties };
}

/** `ListDevices`: todas as entradas, USB e Network, como o usbmuxd as lista. */
export async function listDevices(options: UsbmuxOptions): Promise<UsbmuxDevice[]> {
  const { socket, reply } = await exchange(options, 'ListDevices');
  discard(socket);
  const list = reply['DeviceList'];
  if (!Array.isArray(list)) {
    throw noUsb(`o usbmuxd não devolveu DeviceList ao ListDevices (Result ${String(reply['Number'] ?? '?')})`, {
      reason: 'usbmuxd-protocol',
      socketPath: options.socketPath,
    });
  }
  return list.map(parseDevice).filter((device) => device !== undefined);
}

/**
 * A entrada `USB` do aparelho configurado (serial normalizado igual ao UDID normalizado). Sem ela,
 * `E_NO_USB`: só pela rede (E-2.2) ou ausente (E-2.1).
 */
export function selectUsbDevice(devices: readonly UsbmuxDevice[], udid: string): UsbmuxDevice {
  const wanted = normalizeSerial(udid);
  const mine = devices.filter((device) => normalizeSerial(device.serialNumber) === wanted);
  const usb = mine.find((device) => device.connectionType === 'USB');
  if (usb !== undefined) return usb;
  if (mine.length > 0) {
    const types = [...new Set(mine.map((device) => device.connectionType))];
    throw noUsb(
      `o iPhone ${udid} só aparece no usbmuxd pela rede (entrada ${types.join(', ')}); o canal de comandos só usa a entrada USB: ligue o cabo`,
      { reason: 'network-only', udid, connectionTypes: types },
    );
  }
  throw noUsb(`o usbmuxd não lista o iPhone ${udid}: ligue o cabo USB`, { reason: 'not-listed', udid });
}

/** `ListDevices` uma vez e escolhe a entrada USB do UDID (E-2.1, E-2.2). */
export async function findUsbDevice(options: UsbmuxOptions & { udid: string }): Promise<UsbmuxDevice> {
  return selectUsbDevice(await listDevices(options), options.udid);
}

/**
 * `Connect {DeviceID, PortNumber: htons(port)}`. Com `Result 0` devolve o socket, **pausado**, já como
 * túnel TCP cru até `port` no aparelho (`pipe()` ou `resume()` o religam; quem recebe trata `error`).
 * O túnel tem `allowHalfOpen`: o FIN do aparelho não fecha a escrita; quem recebe chama `end()` ao
 * terminar. `Result 3` (recusado) → `E_RUNNER_DOWN` (E-2.3); `Result 2` (aparelho saiu) → `E_NO_USB`.
 */
export async function connectDevice(options: UsbmuxOptions, deviceId: number, port: number): Promise<Socket> {
  const portNumber = htons(port);
  const { socket, reply, decoder } = await exchange(options, 'Connect', { DeviceID: deviceId, PortNumber: portNumber }, true);
  const result = reply['Number'];
  if (reply['MessageType'] === 'Result' && result === RESULT.OK) {
    const rest = decoder.rest();
    if (rest.length > 0) socket.unshift(rest);
    return socket;
  }
  discard(socket);
  if (result === RESULT.CONNREFUSED) {
    throw new ContrarregraError(
      'E_RUNNER_DOWN',
      `o runner não está escutando na porta ${port} do aparelho (Connect recusado pelo usbmuxd): rode \`${RUNNER_UP_HINT}\``,
      { deviceId, port, hint: RUNNER_UP_HINT },
    );
  }
  if (result === RESULT.BADDEV) {
    throw noUsb(`o aparelho ${deviceId} não está mais no usbmuxd: ligue o cabo`, { reason: 'device-gone', deviceId, port });
  }
  throw noUsb(`o usbmuxd recusou o Connect (Result ${String(result)})`, {
    reason: 'usbmuxd-protocol',
    deviceId,
    port,
    result: typeof result === 'number' ? result : null,
  });
}

/** Acha a entrada USB do UDID e abre o túnel até `port` no aparelho. */
export async function openTunnel(options: UsbmuxOptions & { udid: string; port: number }): Promise<{ socket: Socket; device: UsbmuxDevice }> {
  const device = await findUsbDevice(options);
  const socket = await connectDevice(options, device.deviceId, options.port);
  return { socket, device };
}

function toEvent(message: PlistDict): UsbmuxEvent | undefined {
  const type = message['MessageType'];
  if (type === 'Attached') {
    const device = parseDevice(message);
    return device === undefined ? undefined : { type: 'attached', device };
  }
  const deviceId = message['DeviceID'];
  if (typeof deviceId !== 'number') return undefined;
  if (type === 'Detached') return { type: 'detached', deviceId };
  if (type === 'Paired') return { type: 'paired', deviceId };
  return undefined;
}

/**
 * `Listen`: depois do `Result 0`, entrega os eventos `Attached` (inclusive os dos aparelhos já
 * presentes), `Detached` e `Paired`, sem filtrar — quem chama aplica `selectUsbDevice`. Um quadro
 * inválido fecha o socket.
 */
export async function listen(options: UsbmuxOptions, onEvent: (event: UsbmuxEvent) => void): Promise<UsbmuxListener> {
  const { socket, reply, decoder } = await exchange(options, 'Listen');
  if (reply['MessageType'] !== 'Result' || reply['Number'] !== RESULT.OK) {
    discard(socket);
    throw noUsb(`o usbmuxd recusou o Listen (Result ${String(reply['Number'] ?? '?')})`, {
      reason: 'usbmuxd-protocol',
      socketPath: options.socketPath,
    });
  }
  const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
  const drain = (): void => {
    while (!socket.destroyed) {
      let event: UsbmuxEvent | undefined;
      try {
        const frame = decoder.next();
        if (frame === undefined) return;
        event = toEvent(decodeMessage(frame));
      } catch {
        socket.destroy();
        return;
      }
      if (event !== undefined) onEvent(event);
    }
  };
  socket.on('error', () => {});
  socket.on('data', (chunk: Buffer) => {
    decoder.push(chunk);
    drain();
  });
  drain();
  socket.resume();
  return { close: () => void socket.destroy(), closed };
}
