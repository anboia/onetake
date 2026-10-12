// usbmuxd falso dos testes (extraído de usbmux.test.ts pela T-0.10; S2 item 2): escuta num socket Unix
// num diretório temporário curto, passado como `usbmux.socketPath` (nunca o `/var/run/usbmuxd` de
// verdade). Lê o cabeçalho e o plist dos pedidos por conta própria e responde com XML escrito à mão no
// formato do usbmuxd do macOS, sem usar o código testado: `ListDevices`, `Listen` (com `Attached` e
// `Detached`) e `Connect`, que vira túnel até um eco ou até uma porta TCP em 127.0.0.1 (o "aparelho").

import { mkdtempSync } from 'node:fs';
import { connect, createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** `sun_path` do macOS tem 104 bytes, com o NUL do fim. */
export const UNIX_PATH_MAX = 103;

export interface FakeEntry {
  deviceId: number;
  connectionType: 'USB' | 'Network';
  serial: string;
}

export function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function plistDocument(body: string): string {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
    `<plist version="1.0">\n${body}\n</plist>\n`
  );
}

/** Uma entrada como o usbmuxd do macOS manda em `DeviceList` e no evento `Attached`. */
export function entryXml(entry: FakeEntry): string {
  const props =
    entry.connectionType === 'USB'
      ? `\t\t<key>ConnectionSpeed</key>\n\t\t<integer>480000000</integer>\n` +
        `\t\t<key>ConnectionType</key>\n\t\t<string>USB</string>\n` +
        `\t\t<key>DeviceID</key>\n\t\t<integer>${entry.deviceId}</integer>\n` +
        `\t\t<key>LocationID</key>\n\t\t<integer>336592896</integer>\n` +
        `\t\t<key>ProductID</key>\n\t\t<integer>4776</integer>\n` +
        `\t\t<key>SerialNumber</key>\n\t\t<string>${escapeXml(entry.serial)}</string>\n` +
        `\t\t<key>USBSerialNumber</key>\n\t\t<string>${escapeXml(entry.serial.replace(/-/g, ''))}</string>\n`
      : `\t\t<key>ConnectionType</key>\n\t\t<string>Network</string>\n` +
        `\t\t<key>DeviceID</key>\n\t\t<integer>${entry.deviceId}</integer>\n` +
        `\t\t<key>EscapedFullServiceName</key>\n\t\t<string>aa:bb:cc:dd:ee:ff@fe80::1._apple-mobdev2._tcp.local.</string>\n` +
        `\t\t<key>InterfaceIndex</key>\n\t\t<integer>14</integer>\n` +
        `\t\t<key>NetworkAddress</key>\n\t\t<data>\n\t\tEAIAAMCoAWsAAAAAAAAAAA==\n\t\t</data>\n` +
        `\t\t<key>SerialNumber</key>\n\t\t<string>${escapeXml(entry.serial)}</string>\n`;
  return (
    `\t<dict>\n\t\t<key>DeviceID</key>\n\t\t<integer>${entry.deviceId}</integer>\n` +
    `\t\t<key>MessageType</key>\n\t\t<string>Attached</string>\n` +
    `\t\t<key>Properties</key>\n\t\t<dict>\n${props}\t\t</dict>\n\t</dict>`
  );
}

export function resultXml(number: number): string {
  return plistDocument(`<dict>\n\t<key>MessageType</key>\n\t<string>Result</string>\n\t<key>Number</key>\n\t<integer>${number}</integer>\n</dict>`);
}

export function frameBytes(tag: number, xml: string): Buffer {
  const payload = Buffer.from(xml, 'utf8');
  const header = Buffer.alloc(16);
  header.writeUInt32LE(16 + payload.length, 0);
  header.writeUInt32LE(1, 4); // versão 1 = plist
  header.writeUInt32LE(8, 8); // mensagem 8 = plist
  header.writeUInt32LE(tag, 12);
  return Buffer.concat([header, payload]);
}

export interface ReceivedRequest {
  length: number;
  version: number;
  message: number;
  tag: number;
  xml: string;
  /** Pares chave → valor simples do dicionário de cima, lidos por expressão regular. */
  fields: Record<string, string | number>;
}

export function parseRequestFields(xml: string): Record<string, string | number> {
  const fields: Record<string, string | number> = {};
  for (const m of xml.matchAll(/<key>([^<]+)<\/key>\s*<(string|integer)>([^<]*)<\/\2>/g)) {
    fields[m[1]!] = m[2] === 'integer' ? Number(m[3]) : m[3]!;
  }
  return fields;
}

export interface FakeUsbmuxdOptions {
  devices?: FakeEntry[];
  /** Porta do aparelho → destino: `'echo'` devolve os bytes; um número é uma porta TCP em 127.0.0.1. Ausente → Result 3. */
  devicePorts?: Record<number, 'echo' | number>;
  /** Força o `Number` do Result do `Connect`. */
  connectResult?: number;
  /** Aceita a conexão e nunca responde (usbmuxd travado). */
  silent?: boolean;
}

export class FakeUsbmuxd {
  readonly socketPath: string;
  readonly requests: ReceivedRequest[] = [];
  readonly sockets = new Set<Socket>();
  private readonly server: Server;
  private readonly listeners = new Set<Socket>();
  private readonly options: FakeUsbmuxdOptions;
  devices: FakeEntry[];

  constructor(socketPath: string, options: FakeUsbmuxdOptions) {
    this.socketPath = socketPath;
    this.options = options;
    this.devices = [...(options.devices ?? [])];
    // Meio-fechamento como num socket de verdade: o FIN de um sentido não fecha o outro.
    this.server = createServer({ allowHalfOpen: true }, (socket) => this.accept(socket));
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.socketPath, () => resolve());
    });
  }

  messages(type: string): ReceivedRequest[] {
    return this.requests.filter((r) => r.fields['MessageType'] === type);
  }

  attach(entry: FakeEntry): void {
    this.devices.push(entry);
    for (const socket of this.listeners) socket.write(frameBytes(0, plistDocument(entryXml(entry).replace(/^\t/gm, ''))));
  }

  detach(deviceId: number): void {
    this.devices = this.devices.filter((d) => d.deviceId !== deviceId);
    const xml = plistDocument(
      `<dict>\n\t<key>DeviceID</key>\n\t<integer>${deviceId}</integer>\n\t<key>MessageType</key>\n\t<string>Detached</string>\n</dict>`,
    );
    for (const socket of this.listeners) socket.write(frameBytes(0, xml));
  }

  close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  private accept(socket: Socket): void {
    this.sockets.add(socket);
    socket.on('close', () => {
      this.sockets.delete(socket);
      this.listeners.delete(socket);
    });
    socket.on('error', () => socket.destroy());
    // Fora do túnel, o FIN do cliente encerra a conversa.
    const onEnd = (): void => void socket.end();
    socket.on('end', onEnd);
    let buffer = Buffer.alloc(0);
    const onData = (chunk: Buffer): void => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 16) {
        const length = buffer.readUInt32LE(0);
        if (buffer.length < length) return;
        const request: ReceivedRequest = {
          length,
          version: buffer.readUInt32LE(4),
          message: buffer.readUInt32LE(8),
          tag: buffer.readUInt32LE(12),
          xml: buffer.subarray(16, length).toString('utf8'),
          fields: {},
        };
        request.fields = parseRequestFields(request.xml);
        buffer = buffer.subarray(length);
        this.requests.push(request);
        if (this.options.silent) continue;
        const type = request.fields['MessageType'];
        if (type === 'ListDevices') {
          const list = this.devices.map(entryXml).join('\n');
          const xml = plistDocument(`<dict>\n\t<key>DeviceList</key>\n\t<array>\n${list}\n\t</array>\n</dict>`);
          socket.write(frameBytes(request.tag, xml));
        } else if (type === 'Listen') {
          socket.write(frameBytes(request.tag, resultXml(0)));
          this.listeners.add(socket);
          for (const entry of this.devices) socket.write(frameBytes(0, plistDocument(entryXml(entry).replace(/^\t/gm, ''))));
        } else if (type === 'Connect') {
          socket.off('data', onData);
          socket.off('end', onEnd);
          this.connect(socket, request, buffer);
          return;
        } else {
          socket.write(frameBytes(request.tag, resultXml(1)));
        }
      }
    };
    socket.on('data', onData);
  }

  /** Igual ao usbmuxd: responde 0 só depois que o TCP do aparelho conectou; recusado → 3; aparelho que não existe → 2. */
  private connect(socket: Socket, request: ReceivedRequest, rest: Buffer): void {
    const reply = (n: number): boolean => socket.write(frameBytes(request.tag, resultXml(n)));
    const refuse = (n: number): void => {
      reply(n);
      socket.end();
    };
    if (this.options.connectResult !== undefined) return refuse(this.options.connectResult);
    const deviceId = request.fields['DeviceID'];
    if (!this.devices.some((d) => d.deviceId === deviceId)) return refuse(2);
    const raw = Number(request.fields['PortNumber']);
    const port = ((raw & 0xff) << 8) | ((raw >>> 8) & 0xff); // ntohs
    const target = this.options.devicePorts?.[port];
    if (target === undefined) return refuse(3);
    if (target === 'echo') {
      reply(0);
      if (rest.length > 0) socket.write(rest);
      socket.on('data', (chunk: Buffer) => socket.write(chunk));
      socket.on('end', () => socket.end());
      return;
    }
    // Túnel até uma porta TCP do "aparelho", com o FIN passado adiante em cada sentido.
    const upstream = connect({ port: target, host: '127.0.0.1', allowHalfOpen: true });
    let connected = false;
    upstream.once('connect', () => {
      connected = true;
      reply(0);
      if (rest.length > 0) upstream.write(rest);
      socket.pipe(upstream);
      upstream.pipe(socket);
    });
    upstream.on('error', () => {
      if (connected) socket.destroy();
      else refuse(3);
    });
    upstream.on('close', (hadError) => {
      if (hadError && connected) socket.destroy();
    });
    // O cliente sumiu de vez (fechou ou foi derrubado): como o usbmuxd de verdade, fecha o lado do
    // aparelho também — senão o "aparelho" fica meio aberto (CLOSE_WAIT) e o servidor dele nunca fecha.
    socket.on('close', (hadError) => {
      if (hadError) upstream.destroy();
      else upstream.end();
    });
  }
}

/**
 * Diretório temporário novo onde cabe o socket do usbmuxd falso. O Node trunca **sem erro** um caminho de
 * socket Unix maior que `sun_path` (o socket vai parar noutro lugar e dois falsos podem cair no mesmo
 * nome); com um `TMPDIR` longo — comum nas sessões do Claude Code — o diretório fica em `/tmp`. Quem
 * chama apaga o diretório.
 */
export function shortTempDir(prefix = 'crr-usbmux-'): string {
  const longest = join(tmpdir(), `${prefix}XXXXXX`, 'usbmuxd');
  const base = Buffer.byteLength(longest) <= UNIX_PATH_MAX ? tmpdir() : '/tmp';
  return mkdtempSync(join(base, prefix));
}

/** Sobe um usbmuxd falso em `<dir>/usbmuxd`; quem chama o fecha (`close()`) e apaga `dir`. */
export async function startFakeUsbmuxd(dir: string, options: FakeUsbmuxdOptions = {}): Promise<FakeUsbmuxd> {
  const fake = new FakeUsbmuxd(join(dir, 'usbmuxd'), options);
  await fake.start();
  return fake;
}
