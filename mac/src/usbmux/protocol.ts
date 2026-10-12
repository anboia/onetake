// Quadros do protocolo do usbmuxd (S2 item 2): cabeçalho de 16 bytes em little-endian — comprimento
// total, versão (1 = plist), tipo da mensagem (8 = plist) e tag — seguido do plist XML. Referência:
// `usbmuxd-proto.h` do libusbmuxd (architecture.md, fontes).

import { decodePlist, encodePlist, isPlistDict, type PlistDict } from './plist.ts';

export const HEADER_BYTES = 16;
export const VERSION_PLIST = 1;
export const MESSAGE_PLIST = 8;
/** Teto de um quadro; a `DeviceList` real tem poucos KiB. */
export const MAX_FRAME_BYTES = 4 * 1024 * 1024;

/** `Number` do `MessageType: Result`. */
export const RESULT = { OK: 0, BADCOMMAND: 1, BADDEV: 2, CONNREFUSED: 3, BADVERSION: 6 } as const;

/** Identificação do cliente em todo pedido, como o `libusbmuxd` faz. */
export const CLIENT_FIELDS = { ClientVersionString: 'contrarregra', ProgName: 'contrarregra', kLibUSBMuxVersion: 3 } as const;

export interface UsbmuxFrame {
  tag: number;
  /** O plist XML, ainda como bytes. */
  payload: Buffer;
}

export function encodeFrame(tag: number, message: PlistDict): Buffer {
  const payload = Buffer.from(encodePlist(message), 'utf8');
  const header = Buffer.alloc(HEADER_BYTES);
  header.writeUInt32LE(HEADER_BYTES + payload.length, 0);
  header.writeUInt32LE(VERSION_PLIST, 4);
  header.writeUInt32LE(MESSAGE_PLIST, 8);
  header.writeUInt32LE(tag >>> 0, 12);
  return Buffer.concat([header, payload]);
}

/**
 * Junta os pedaços que chegam do socket e tira **um quadro por vez**: depois do `Result` de um
 * `Connect` aceito, o que sobra são bytes crus do túnel e sai por `rest()`, sem ser lido como quadro.
 */
export class FrameDecoder {
  private buffer: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): void {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
  }

  /** O próximo quadro completo, ou `undefined` se ainda faltam bytes. Lança `Error` em quadro inválido. */
  next(): UsbmuxFrame | undefined {
    if (this.buffer.length < HEADER_BYTES) return undefined;
    const length = this.buffer.readUInt32LE(0);
    const version = this.buffer.readUInt32LE(4);
    const message = this.buffer.readUInt32LE(8);
    if (length < HEADER_BYTES || length > MAX_FRAME_BYTES) throw new Error(`usbmuxd: quadro com comprimento ${length}`);
    if (version !== VERSION_PLIST || message !== MESSAGE_PLIST) {
      throw new Error(`usbmuxd: quadro com versão ${version} e tipo ${message} (esperava plist: 1 e 8)`);
    }
    if (this.buffer.length < length) return undefined;
    const frame = { tag: this.buffer.readUInt32LE(12), payload: this.buffer.subarray(HEADER_BYTES, length) };
    this.buffer = this.buffer.subarray(length);
    return frame;
  }

  /** Os bytes ainda não lidos como quadro (e esvazia o acumulador). */
  rest(): Buffer {
    const rest = this.buffer;
    this.buffer = Buffer.alloc(0);
    return rest;
  }
}

/** O plist de um quadro, que tem de ser um dicionário. */
export function decodeMessage(frame: UsbmuxFrame): PlistDict {
  const value = decodePlist(frame.payload.toString('utf8'));
  if (!isPlistDict(value)) throw new Error('usbmuxd: a mensagem não é um dicionário plist');
  return value;
}

/** `htons(port)` como o usbmuxd espera em `PortNumber`: a porta em big-endian lida como little-endian. */
export function htons(port: number): number {
  if (!Number.isInteger(port) || port < 1 || port > 0xffff) throw new RangeError(`porta TCP inválida: ${port}`);
  return ((port & 0xff) << 8) | (port >>> 8);
}

/** Serial/UDID normalizado de S2 item 2: sem hífens, em maiúsculas. */
export function normalizeSerial(serial: string): string {
  return serial.replace(/-/g, '').toUpperCase();
}
