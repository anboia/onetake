// Testes da T-0.9: cliente usbmuxd e repassador local (S2 item 2; E-2.1, E-2.2, E-2.3; P-3). Tudo contra
// um usbmuxd falso escrito aqui: socket Unix num diretório temporário, passado como `usbmux.socketPath`
// (nunca o `/var/run/usbmuxd` de verdade). O falso lê o cabeçalho e o plist dos pedidos por conta
// própria e responde com XML escrito à mão no formato do usbmuxd do macOS, sem usar o código testado.

import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { connect, createServer, type AddressInfo, type Server, type Socket } from 'node:net';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

import { isContrarregraError } from '../src/core/errors.ts';
import {
  connectDevice,
  findUsbDevice,
  listDevices,
  listen,
  openTunnel,
  selectUsbDevice,
  type UsbmuxDevice,
  type UsbmuxEvent,
} from '../src/usbmux/client.ts';
import { startForwarder } from '../src/usbmux/forwarder.ts';
import { decodePlist, encodePlist } from '../src/usbmux/plist.ts';
import { encodeFrame, FrameDecoder, htons, normalizeSerial } from '../src/usbmux/protocol.ts';
import { startWsServer, type WsTestServer } from './helpers/ws-server.ts';

// ── Fixtures ────────────────────────────────────────────────────────────────────────────────────────

/** UDID real do iPhone (`device.udid` em `config/defaults.json`). */
const UDID = '00008101-001E79203A68001E';
/** O mesmo serial como o usbmuxd costuma informar: sem hífen. */
const SERIAL_UNDASHED = '00008101001E79203A68001E';
/** Outro aparelho qualquer, que nunca pode ser escolhido. */
const OTHER_SERIAL = '00008030-000A1B2C3D4E5F60';
const RUNNER_PORT = 8700;
/** htons(8700): 8700 = 0x21FC → 0xFC21. */
const RUNNER_PORT_NETWORK_ORDER = 0xfc21;
/** `sun_path` do macOS tem 104 bytes, com o NUL do fim. */
const UNIX_PATH_MAX = 103;
/** Prazo de E-2.1/AC-2.3. */
const NO_USB_BOUND_MS = 1000;

interface FakeEntry {
  deviceId: number;
  connectionType: 'USB' | 'Network';
  serial: string;
}

const usbDashed: FakeEntry = { deviceId: 3, connectionType: 'USB', serial: UDID };
const usbUndashed: FakeEntry = { deviceId: 4, connectionType: 'USB', serial: SERIAL_UNDASHED };
const networkEntry: FakeEntry = { deviceId: 7, connectionType: 'Network', serial: UDID };
const otherUsb: FakeEntry = { deviceId: 9, connectionType: 'USB', serial: OTHER_SERIAL };

// ── usbmuxd falso ───────────────────────────────────────────────────────────────────────────────────

function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function plistDocument(body: string): string {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
    `<plist version="1.0">\n${body}\n</plist>\n`
  );
}

/** Uma entrada como o usbmuxd do macOS manda em `DeviceList` e no evento `Attached`. */
function entryXml(entry: FakeEntry): string {
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

function resultXml(number: number): string {
  return plistDocument(`<dict>\n\t<key>MessageType</key>\n\t<string>Result</string>\n\t<key>Number</key>\n\t<integer>${number}</integer>\n</dict>`);
}

function frameBytes(tag: number, xml: string): Buffer {
  const payload = Buffer.from(xml, 'utf8');
  const header = Buffer.alloc(16);
  header.writeUInt32LE(16 + payload.length, 0);
  header.writeUInt32LE(1, 4); // versão 1 = plist
  header.writeUInt32LE(8, 8); // mensagem 8 = plist
  header.writeUInt32LE(tag, 12);
  return Buffer.concat([header, payload]);
}

interface ReceivedRequest {
  length: number;
  version: number;
  message: number;
  tag: number;
  xml: string;
  /** Pares chave → valor simples do dicionário de cima, lidos por expressão regular. */
  fields: Record<string, string | number>;
}

function parseRequestFields(xml: string): Record<string, string | number> {
  const fields: Record<string, string | number> = {};
  for (const m of xml.matchAll(/<key>([^<]+)<\/key>\s*<(string|integer)>([^<]*)<\/\2>/g)) {
    fields[m[1]!] = m[2] === 'integer' ? Number(m[3]) : m[3]!;
  }
  return fields;
}

interface FakeUsbmuxdOptions {
  devices?: FakeEntry[];
  /** Porta do aparelho → destino: `'echo'` devolve os bytes; um número é uma porta TCP em 127.0.0.1. Ausente → Result 3. */
  devicePorts?: Record<number, 'echo' | number>;
  /** Força o `Number` do Result do `Connect`. */
  connectResult?: number;
  /** Aceita a conexão e nunca responde (usbmuxd travado). */
  silent?: boolean;
}

class FakeUsbmuxd {
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
    socket.on('close', (hadError) => {
      if (hadError) upstream.destroy();
    });
  }
}

const cleanups: (() => Promise<void> | void)[] = [];
after(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
});

/**
 * Diretório temporário onde cabe o socket do usbmuxd falso. O Node trunca **sem erro** um caminho de
 * socket Unix maior que `sun_path` (o socket vai parar noutro lugar e dois falsos podem cair no mesmo
 * nome); com um `TMPDIR` longo — comum nas sessões do Claude Code — o diretório fica em `/tmp`.
 */
function tmp(): string {
  const prefix = 'crr-usbmux-';
  const longest = join(tmpdir(), `${prefix}XXXXXX`, 'usbmuxd');
  const base = Buffer.byteLength(longest) <= UNIX_PATH_MAX ? tmpdir() : '/tmp';
  const dir = mkdtempSync(join(base, prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function fakeUsbmuxd(options: FakeUsbmuxdOptions = {}): Promise<FakeUsbmuxd> {
  const fake = new FakeUsbmuxd(join(tmp(), 'usbmuxd'), options);
  await fake.start();
  cleanups.push(() => fake.close());
  return fake;
}

async function wsServer(): Promise<WsTestServer> {
  const server = await startWsServer();
  cleanups.push(() => server.close());
  return server;
}

async function rejectsWith(promise: Promise<unknown>, code: string): Promise<{ message: string; data: Record<string, unknown> }> {
  try {
    await promise;
  } catch (error) {
    assert.ok(isContrarregraError(error), `esperava ContrarregraError, veio ${String(error)}`);
    assert.equal(error.code, code, `esperava ${code}, veio ${error.code}: ${error.message}`);
    return { message: error.message, data: { ...error.data } };
  }
  assert.fail(`esperava ${code}, mas a promessa foi cumprida`);
}

function readAll(socket: Socket, bytes: number, timeoutMs = 2000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const timer = setTimeout(() => reject(new Error(`só chegaram ${buffer.length} de ${bytes} bytes`)), timeoutMs);
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length >= bytes) {
        clearTimeout(timer);
        resolve(buffer);
      }
    });
    socket.resume();
  });
}

function closed(socket: Socket, timeoutMs = 2000): Promise<void> {
  if (socket.destroyed) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('o socket não fechou')), timeoutMs);
    socket.once('close', () => {
      clearTimeout(timer);
      resolve();
    });
    socket.resume();
  });
}

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Lê até o FIN do outro lado e devolve tudo o que chegou. */
function readToEnd(socket: Socket, timeoutMs = 20_000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    const timer = setTimeout(() => reject(new Error(`sem FIN depois de ${total} bytes`)), timeoutMs);
    socket.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
      total += chunk.length;
    });
    socket.once('end', () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks));
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

/** Um servidor TCP em 127.0.0.1 que faz o papel da porta do runner no aparelho (com meio-fechamento). */
async function deviceServer(onConnection: (socket: Socket) => void): Promise<number> {
  const sockets = new Set<Socket>();
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => socket.destroy());
    onConnection(socket);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  );
  return (server.address() as AddressInfo).port;
}

async function waitFor(predicate: () => boolean, what: string, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(what);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function openClient(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.addEventListener('open', () => resolve(ws), { once: true });
    ws.addEventListener('error', () => reject(new Error(`não conectou em ${url}`)), { once: true });
  });
}

function nextClientMessage(ws: WebSocket): Promise<string> {
  return new Promise((resolve) => {
    ws.addEventListener('message', (e) => resolve(String(e.data)), { once: true });
  });
}

// ── Plist XML ───────────────────────────────────────────────────────────────────────────────────────

describe('plist XML (S2 item 2)', () => {
  test('lê a resposta de ListDevices no formato do usbmuxd do macOS (USB e Network)', () => {
    const xml = plistDocument(`<dict>\n\t<key>DeviceList</key>\n\t<array>\n${entryXml(usbDashed)}\n${entryXml(networkEntry)}\n\t</array>\n</dict>`);
    const value = decodePlist(xml) as { DeviceList: { DeviceID: number; Properties: Record<string, unknown> }[] };
    assert.equal(value.DeviceList.length, 2);
    const [usb, net] = value.DeviceList;
    assert.equal(usb!.DeviceID, 3);
    assert.equal(usb!.Properties['ConnectionType'], 'USB');
    assert.equal(usb!.Properties['SerialNumber'], UDID);
    assert.equal(usb!.Properties['LocationID'], 336592896);
    assert.equal(net!.Properties['ConnectionType'], 'Network');
    assert.deepEqual([...(net!.Properties['NetworkAddress'] as Uint8Array)], [...Buffer.from('EAIAAMCoAWsAAAAAAAAAAA==', 'base64')]);
  });

  test('ida e volta: dicionários, listas, inteiros, reais, booleanos, dados e escape de &<>"\'', () => {
    const value = {
      MessageType: 'Connect',
      DeviceID: 3,
      PortNumber: RUNNER_PORT_NETWORK_ORDER,
      Negative: -12,
      Ratio: 0.5,
      Yes: true,
      No: false,
      Bytes: new Uint8Array([0, 1, 254, 255]),
      Text: 'a & b < c > d "e" \'f\' — ç',
      Empty: '',
      List: [1, 'dois', { tres: 3 }, []],
      Nested: { inner: {} },
    };
    const xml = encodePlist(value);
    assert.match(xml, /^<\?xml version="1.0" encoding="UTF-8"\?>\n<!DOCTYPE plist /);
    assert.ok(xml.includes('<key>PortNumber</key>'));
    assert.ok(xml.includes('a &amp; b &lt; c &gt; d'));
    assert.deepEqual(decodePlist(xml), value);
  });

  test('etiquetas vazias e entidades numéricas', () => {
    const xml = plistDocument('<dict><key>a</key><string/><key>b</key><dict/><key>c</key><array/><key>d</key><string>&#65;&#x42;</string></dict>');
    assert.deepEqual(decodePlist(xml), { a: '', b: {}, c: [], d: 'AB' });
  });

  test('a chave "__proto__" vira propriedade comum e não troca o protótipo', () => {
    const value = decodePlist(plistDocument('<dict><key>__proto__</key><dict><key>polluted</key><true/></dict></dict>')) as Record<string, unknown>;
    assert.equal(Object.getPrototypeOf(value), Object.prototype);
    assert.ok(Object.hasOwn(value, '__proto__'));
    assert.equal(({} as Record<string, unknown>)['polluted'], undefined);
  });

  test('XML malformado ou fora do subconjunto do plist é recusado', () => {
    for (const bad of [
      '',
      '<plist version="1.0"><dict><key>a</key></dict></plist>',
      '<plist version="1.0"><dict><key>a</key><string>x</dict></plist>',
      '<plist version="1.0"><integer>12x</integer></plist>',
      '<plist version="1.0"><string><![CDATA[x]]></string></plist>',
      '<plist version="1.0"><foo/></plist>',
      '<plist version="1.0"><string>a</string><string>b</string></plist>',
      '<plist version="1.0"><string>&bogus;</string></plist>',
    ]) {
      assert.throws(() => decodePlist(bad), Error, `devia recusar ${JSON.stringify(bad)}`);
    }
  });
});

// ── Cabeçalho de 16 bytes ───────────────────────────────────────────────────────────────────────────

describe('cabeçalho de 16 bytes do usbmuxd', () => {
  test('encodeFrame: comprimento total, versão 1, mensagem 8 (plist) e tag em little-endian', () => {
    const frame = encodeFrame(42, { MessageType: 'ListDevices' });
    assert.equal(frame.readUInt32LE(0), frame.length);
    assert.equal(frame.readUInt32LE(4), 1);
    assert.equal(frame.readUInt32LE(8), 8);
    assert.equal(frame.readUInt32LE(12), 42);
    assert.deepEqual(parseRequestFields(frame.subarray(16).toString('utf8')), { MessageType: 'ListDevices' });
  });

  test('FrameDecoder: quadros partidos em pedaços, vários num pedaço só e o resto cru depois', () => {
    const a = frameBytes(1, resultXml(0));
    const b = frameBytes(2, resultXml(3));
    const raw = Buffer.from('bytes crus do túnel');
    const all = Buffer.concat([a, b, raw]);
    const decoder = new FrameDecoder();
    decoder.push(all.subarray(0, 7));
    assert.equal(decoder.next(), undefined);
    decoder.push(all.subarray(7, a.length + 20));
    const first = decoder.next();
    assert.equal(first?.tag, 1);
    assert.equal(decoder.next(), undefined);
    decoder.push(all.subarray(a.length + 20, a.length + b.length));
    const second = decoder.next();
    assert.equal(second?.tag, 2);
    assert.deepEqual(decodePlist(second!.payload.toString('utf8')), { MessageType: 'Result', Number: 3 });
    decoder.push(raw);
    assert.deepEqual(decoder.rest(), raw);
  });

  test('FrameDecoder recusa comprimento menor que o cabeçalho, versão ou tipo que não são plist', () => {
    const short = Buffer.alloc(16);
    short.writeUInt32LE(8, 0);
    const binary = frameBytes(1, resultXml(0));
    binary.writeUInt32LE(0, 4);
    const notPlist = frameBytes(1, resultXml(0));
    notPlist.writeUInt32LE(1, 8);
    for (const bad of [short, binary, notPlist]) {
      const decoder = new FrameDecoder();
      decoder.push(bad);
      assert.throws(() => decoder.next());
    }
  });

  test('htons: a porta vai em big-endian no campo PortNumber', () => {
    assert.equal(htons(RUNNER_PORT), RUNNER_PORT_NETWORK_ORDER);
    assert.equal(htons(0x1234), 0x3412);
    assert.equal(htons(1), 0x0100);
    for (const bad of [0, -1, 65536, 1.5, Number.NaN]) assert.throws(() => htons(bad), RangeError);
  });
});

// ── Serial normalizado ──────────────────────────────────────────────────────────────────────────────

describe('serial normalizado (sem hífens, maiúsculas)', () => {
  test('normalizeSerial tira hífens e passa para maiúsculas', () => {
    assert.equal(normalizeSerial(UDID), SERIAL_UNDASHED);
    assert.equal(normalizeSerial(SERIAL_UNDASHED), SERIAL_UNDASHED);
    assert.equal(normalizeSerial(UDID.toLowerCase()), SERIAL_UNDASHED);
  });

  for (const [label, entry] of [
    ['serial com hífen', usbDashed],
    ['serial sem hífen', usbUndashed],
    ['serial em minúsculas', { ...usbDashed, serial: UDID.toLowerCase() }],
  ] as const) {
    test(`acha o aparelho pelo UDID configurado: ${label}`, async () => {
      const fake = await fakeUsbmuxd({ devices: [otherUsb, entry] });
      const device = await findUsbDevice({ socketPath: fake.socketPath, udid: UDID });
      assert.equal(device.deviceId, entry.deviceId);
      assert.equal(device.connectionType, 'USB');
      assert.equal(device.serialNumber, entry.serial, 'o serial cru é preservado (o SP-4 registra o formato)');
    });
  }

  test('UDID configurado sem hífen também casa com o serial com hífen', async () => {
    const fake = await fakeUsbmuxd({ devices: [usbDashed] });
    const device = await findUsbDevice({ socketPath: fake.socketPath, udid: SERIAL_UNDASHED });
    assert.equal(device.deviceId, usbDashed.deviceId);
  });

  test('outro aparelho no cabo não é escolhido: E_NO_USB', async () => {
    const fake = await fakeUsbmuxd({ devices: [otherUsb] });
    const { data } = await rejectsWith(findUsbDevice({ socketPath: fake.socketPath, udid: UDID }), 'E_NO_USB');
    assert.equal(data['reason'], 'not-listed');
  });

  test('selectUsbDevice é pura e usa a mesma regra', () => {
    const devices: UsbmuxDevice[] = [
      { deviceId: 1, connectionType: 'Network', serialNumber: UDID, properties: {} },
      { deviceId: 2, connectionType: 'USB', serialNumber: SERIAL_UNDASHED.toLowerCase(), properties: {} },
    ];
    assert.equal(selectUsbDevice(devices, UDID).deviceId, 2);
  });
});

// ── E-2.2: só a entrada Network ─────────────────────────────────────────────────────────────────────

describe('E-2.2: só existe entrada Network para o UDID', () => {
  test('recusa com E_NO_USB e explica que falta o cabo USB; não tenta Connect', async () => {
    const fake = await fakeUsbmuxd({ devices: [networkEntry, otherUsb], devicePorts: { [RUNNER_PORT]: 'echo' } });
    const { message, data } = await rejectsWith(openTunnel({ socketPath: fake.socketPath, udid: UDID, port: RUNNER_PORT }), 'E_NO_USB');
    assert.equal(data['reason'], 'network-only');
    assert.equal(data['udid'], UDID);
    assert.match(message, /Network/);
    assert.match(message, /cabo/);
    assert.equal(fake.messages('Connect').length, 0);
  });

  test('com as entradas Network e USB do mesmo aparelho, escolhe a USB', async () => {
    const fake = await fakeUsbmuxd({ devices: [networkEntry, usbUndashed] });
    const device = await findUsbDevice({ socketPath: fake.socketPath, udid: UDID });
    assert.equal(device.deviceId, usbUndashed.deviceId);
    assert.equal(device.connectionType, 'USB');
  });

  test('listDevices devolve as duas entradas; a escolha é que filtra', async () => {
    const fake = await fakeUsbmuxd({ devices: [networkEntry, usbDashed] });
    const devices = await listDevices({ socketPath: fake.socketPath });
    assert.deepEqual(
      devices.map((d) => [d.deviceId, d.connectionType, d.serialNumber]),
      [
        [7, 'Network', UDID],
        [3, 'USB', UDID],
      ],
    );
  });
});

// ── E-2.1: aparelho ausente ─────────────────────────────────────────────────────────────────────────

describe('E-2.1: aparelho ausente → E_NO_USB em ≤ 1 s, sem novas tentativas', () => {
  test('usbmuxd sem o aparelho: E_NO_USB em ≤ 1 s, um único ListDevices e nenhum Connect', async () => {
    const fake = await fakeUsbmuxd({ devices: [], devicePorts: { [RUNNER_PORT]: 'echo' } });
    const start = performance.now();
    const { message, data } = await rejectsWith(openTunnel({ socketPath: fake.socketPath, udid: UDID, port: RUNNER_PORT }), 'E_NO_USB');
    const elapsed = performance.now() - start;
    assert.ok(elapsed <= NO_USB_BOUND_MS, `levou ${elapsed.toFixed(0)} ms`);
    assert.equal(data['reason'], 'not-listed');
    assert.match(message, /cabo/);
    assert.equal(fake.messages('ListDevices').length, 1);
    assert.equal(fake.requests.length, 1, 'nenhuma nova tentativa às cegas');
  });

  test('usbmuxd que não responde: E_NO_USB em ≤ 1 s', async () => {
    const fake = await fakeUsbmuxd({ silent: true });
    const start = performance.now();
    const { data } = await rejectsWith(findUsbDevice({ socketPath: fake.socketPath, udid: UDID }), 'E_NO_USB');
    const elapsed = performance.now() - start;
    assert.ok(elapsed <= NO_USB_BOUND_MS, `levou ${elapsed.toFixed(0)} ms`);
    assert.equal(data['reason'], 'usbmuxd-timeout');
    assert.equal(fake.requests.length, 1);
    await waitFor(() => fake.sockets.size === 0, 'o socket do pedido vencido não foi fechado');
  });

  test('socket do usbmuxd inexistente: E_NO_USB na hora', async () => {
    const socketPath = join(tmp(), 'nada');
    const start = performance.now();
    const { data } = await rejectsWith(findUsbDevice({ socketPath, udid: UDID }), 'E_NO_USB');
    assert.ok(performance.now() - start <= NO_USB_BOUND_MS);
    assert.equal(data['reason'], 'usbmuxd-unreachable');
    assert.equal(data['socketPath'], socketPath);
  });
});

// ── Connect ─────────────────────────────────────────────────────────────────────────────────────────

describe('Connect', () => {
  test('pedido com cabeçalho plist, DeviceID da entrada USB e PortNumber = htons(porta)', async () => {
    const fake = await fakeUsbmuxd({ devices: [networkEntry, usbDashed], devicePorts: { [RUNNER_PORT]: 'echo' } });
    const { socket, device } = await openTunnel({ socketPath: fake.socketPath, udid: UDID, port: RUNNER_PORT });
    socket.destroy();
    assert.equal(device.deviceId, usbDashed.deviceId);
    const [request] = fake.messages('Connect');
    assert.ok(request);
    assert.equal(request.version, 1);
    assert.equal(request.message, 8);
    assert.equal(request.length, 16 + Buffer.byteLength(request.xml));
    assert.equal(request.fields['DeviceID'], usbDashed.deviceId);
    assert.equal(request.fields['PortNumber'], RUNNER_PORT_NETWORK_ORDER);
    assert.match(request.xml, /<key>PortNumber<\/key>\s*<integer>64545<\/integer>/);
    assert.equal(request.fields['ProgName'], 'contrarregra');
    const [list] = fake.messages('ListDevices');
    assert.notEqual(list!.tag, request.tag, 'cada pedido leva a sua tag');
  });

  test('Result 0: o socket vira um túnel TCP cru até a porta do aparelho', async () => {
    const fake = await fakeUsbmuxd({ devices: [usbUndashed], devicePorts: { [RUNNER_PORT]: 'echo' } });
    const socket = await connectDevice({ socketPath: fake.socketPath }, usbUndashed.deviceId, RUNNER_PORT);
    const payload = Buffer.from(Array.from({ length: 70_000 }, (_, i) => i % 251));
    const echoed = readAll(socket, payload.length);
    socket.write(payload);
    assert.deepEqual(await echoed, payload);
    socket.destroy();
  });

  test('E-2.3: Connect devolve 3 (recusado) → E_RUNNER_DOWN com a dica runner up', async () => {
    const fake = await fakeUsbmuxd({ devices: [usbDashed], devicePorts: {} });
    const { message, data } = await rejectsWith(openTunnel({ socketPath: fake.socketPath, udid: UDID, port: RUNNER_PORT }), 'E_RUNNER_DOWN');
    assert.equal(data['port'], RUNNER_PORT);
    assert.equal(data['hint'], 'contrarregra runner up');
    assert.match(message, /runner up/);
    assert.equal(fake.messages('Connect').length, 1, 'sem nova tentativa');
  });

  test('E-2.3 com a porta do runner fechada no "aparelho": o usbmuxd responde 3 → E_RUNNER_DOWN', async () => {
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', () => resolve()));
    const closedPort = (probe.address() as AddressInfo).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    const fake = await fakeUsbmuxd({ devices: [usbUndashed], devicePorts: { [RUNNER_PORT]: closedPort } });
    await rejectsWith(openTunnel({ socketPath: fake.socketPath, udid: UDID, port: RUNNER_PORT }), 'E_RUNNER_DOWN');
  });

  test('E-2.3 pelo código forçado: Result 3 → E_RUNNER_DOWN também no connectDevice', async () => {
    const fake = await fakeUsbmuxd({ devices: [usbDashed], connectResult: 3 });
    await rejectsWith(connectDevice({ socketPath: fake.socketPath }, usbDashed.deviceId, RUNNER_PORT), 'E_RUNNER_DOWN');
  });

  test('Result 2 (o aparelho saiu do usbmuxd) → E_NO_USB', async () => {
    const fake = await fakeUsbmuxd({ devices: [usbDashed] });
    const { data } = await rejectsWith(connectDevice({ socketPath: fake.socketPath }, 99, RUNNER_PORT), 'E_NO_USB');
    assert.equal(data['reason'], 'device-gone');
  });
});

// ── Listen ──────────────────────────────────────────────────────────────────────────────────────────

describe('Listen', () => {
  test('Result 0, depois Attached dos aparelhos presentes e dos que chegam, e Detached', async () => {
    const fake = await fakeUsbmuxd({ devices: [networkEntry] });
    const events: UsbmuxEvent[] = [];
    const listener = await listen({ socketPath: fake.socketPath }, (event) => events.push(event));
    await waitFor(() => events.length >= 1, 'faltou o Attached do aparelho presente');
    fake.attach(usbUndashed);
    fake.detach(usbUndashed.deviceId);
    await waitFor(() => events.length >= 3, 'faltaram os eventos Attached/Detached');
    assert.deepEqual(
      events.map((e) => (e.type === 'attached' ? [e.type, e.device.deviceId, e.device.connectionType, e.device.serialNumber] : [e.type, e.deviceId])),
      [
        ['attached', 7, 'Network', UDID],
        ['attached', 4, 'USB', SERIAL_UNDASHED],
        ['detached', 4],
      ],
    );
    assert.equal(fake.messages('Listen').length, 1);
    listener.close();
    await listener.closed;
  });

  test('usbmuxd ausente: E_NO_USB', async () => {
    await rejectsWith(listen({ socketPath: join(tmp(), 'nada') }, () => {}), 'E_NO_USB');
  });
});

// ── Repassador em 127.0.0.1:<efêmera> ───────────────────────────────────────────────────────────────

describe('repassador local (só loopback, P-3)', () => {
  test('escuta só em 127.0.0.1, numa porta efêmera, e repassa os bytes pelo túnel', async () => {
    const fake = await fakeUsbmuxd({ devices: [usbDashed], devicePorts: { [RUNNER_PORT]: 'echo' } });
    const forwarder = await startForwarder({ socketPath: fake.socketPath, udid: UDID, port: RUNNER_PORT });
    cleanups.push(() => forwarder.close());
    // O endereço em que o servidor ficou de fato ligado (getsockname), não uma constante.
    assert.equal(forwarder.address.address, '127.0.0.1');
    assert.equal(forwarder.address.family, 'IPv4');
    assert.equal(forwarder.host, forwarder.address.address);
    assert.equal(forwarder.port, forwarder.address.port);
    assert.ok(forwarder.port > 0 && forwarder.port !== RUNNER_PORT);
    // Conferência independente, pelo sistema: um bind em 0.0.0.0 aparece como `*.<porta>` no netstat.
    const netstat = spawnSync('/usr/sbin/netstat', ['-an', '-p', 'tcp'], { encoding: 'utf8' });
    assert.equal(netstat.status, 0, `netstat falhou: ${netstat.stderr}`);
    const listening = netstat.stdout
      .split('\n')
      .map((line) => line.trim().split(/\s+/))
      .filter((fields) => fields[5] === 'LISTEN' && fields[3]?.endsWith(`.${forwarder.port}`))
      .map((fields) => fields[3]);
    assert.deepEqual(listening, [`127.0.0.1.${forwarder.port}`]);

    const local = connect(forwarder.port, '127.0.0.1');
    const echoed = readAll(local, 5);
    local.write('hello');
    assert.equal((await echoed).toString(), 'hello');
    local.destroy();

    // Nada fora do loopback do IPv4: nem ::1 nem os endereços das interfaces de rede.
    const outside = ['::1'];
    for (const list of Object.values(networkInterfaces())) {
      for (const info of list ?? []) if (!info.internal && info.family === 'IPv4') outside.push(info.address);
    }
    for (const address of outside) {
      const code = await new Promise<string>((resolve) => {
        const probe = connect(forwarder.port, address);
        probe.once('connect', () => {
          probe.destroy();
          resolve('CONNECTED');
        });
        probe.once('error', (error: NodeJS.ErrnoException) => resolve(error.code ?? 'ERROR'));
      });
      assert.notEqual(code, 'CONNECTED', `o repassador aceitou conexão por ${address}`);
    }
  });

  test('liga o cliente WebSocket nativo do Node ao runner pelo túnel', async () => {
    const runner = await wsServer();
    const fake = await fakeUsbmuxd({ devices: [usbUndashed], devicePorts: { [RUNNER_PORT]: runner.port } });
    const forwarder = await startForwarder({ socketPath: fake.socketPath, udid: UDID, port: RUNNER_PORT });
    cleanups.push(() => forwarder.close());

    const ws = await openClient(`ws://127.0.0.1:${forwarder.port}`);
    const connection = await runner.nextConnection();
    const fromRunner = nextClientMessage(ws);
    connection.sendJson({ jsonrpc: '2.0', method: 'event', params: { seq: 0 } });
    assert.deepEqual(JSON.parse(await fromRunner), { jsonrpc: '2.0', method: 'event', params: { seq: 0 } });
    ws.send('{"jsonrpc":"2.0","id":1,"method":"health"}');
    assert.equal(await connection.nextMessage(), '{"jsonrpc":"2.0","id":1,"method":"health"}');
    ws.close();
    assert.equal(fake.messages('Connect')[0]?.fields['PortNumber'], RUNNER_PORT_NETWORK_ORDER);
  });

  for (const size of [1 << 20, 20 << 20]) {
    const label = `${size >> 20} MiB`;

    test(`meio-fechamento local→aparelho: ${label} e end() chegam inteiros ao aparelho`, async () => {
      const payload = randomBytes(size);
      const atDevice = deferred<Buffer>();
      const devicePort = await deviceServer((socket) => {
        readToEnd(socket).then((data) => {
          atDevice.resolve(data);
          socket.end();
        }, atDevice.reject);
      });
      const fake = await fakeUsbmuxd({ devices: [usbDashed], devicePorts: { [RUNNER_PORT]: devicePort } });
      const forwarder = await startForwarder({ socketPath: fake.socketPath, udid: UDID, port: RUNNER_PORT });
      cleanups.push(() => forwarder.close());
      const local = connect({ port: forwarder.port, host: '127.0.0.1', allowHalfOpen: true });
      const localEnded = readToEnd(local);
      local.end(payload);
      const data = await atDevice.promise;
      assert.equal(data.length, size);
      assert.equal(sha256(data), sha256(payload));
      assert.equal((await localEnded).length, 0, 'o FIN do aparelho também chega ao cliente');
    });

    test(`meio-fechamento aparelho→local: ${label} e end() chegam inteiros ao cliente`, async () => {
      const payload = randomBytes(size);
      const devicePort = await deviceServer((socket) => {
        socket.end(payload);
        socket.resume();
      });
      const fake = await fakeUsbmuxd({ devices: [usbDashed], devicePorts: { [RUNNER_PORT]: devicePort } });
      const forwarder = await startForwarder({ socketPath: fake.socketPath, udid: UDID, port: RUNNER_PORT });
      cleanups.push(() => forwarder.close());
      const local = connect({ port: forwarder.port, host: '127.0.0.1', allowHalfOpen: true });
      const data = await readToEnd(local);
      local.end();
      assert.equal(data.length, size);
      assert.equal(sha256(data), sha256(payload));
    });
  }

  test('o aparelho segue respondendo depois do FIN do cliente: eco de 4 MiB inteiro', async () => {
    const payload = randomBytes(4 << 20);
    const devicePort = await deviceServer((socket) => socket.pipe(socket));
    const fake = await fakeUsbmuxd({ devices: [usbDashed], devicePorts: { [RUNNER_PORT]: devicePort } });
    const forwarder = await startForwarder({ socketPath: fake.socketPath, udid: UDID, port: RUNNER_PORT });
    cleanups.push(() => forwarder.close());
    const local = connect({ port: forwarder.port, host: '127.0.0.1', allowHalfOpen: true });
    const back = readToEnd(local);
    local.end(payload);
    const data = await back;
    assert.equal(data.length, payload.length);
    assert.equal(sha256(data), sha256(payload));
  });

  test('Connect recusado: fecha a conexão local e avisa com E_RUNNER_DOWN (E-2.3)', async () => {
    const fake = await fakeUsbmuxd({ devices: [usbDashed], devicePorts: {} });
    const errors: unknown[] = [];
    const forwarder = await startForwarder({
      socketPath: fake.socketPath,
      udid: UDID,
      port: RUNNER_PORT,
      onTunnelError: (error) => errors.push(error),
    });
    cleanups.push(() => forwarder.close());
    const local = connect(forwarder.port, '127.0.0.1');
    local.on('error', () => {});
    await closed(local);
    assert.equal(errors.length, 1);
    assert.ok(isContrarregraError(errors[0], 'E_RUNNER_DOWN'));
  });

  test('aparelho ausente: fecha a conexão local e avisa com E_NO_USB em ≤ 1 s (E-2.1)', async () => {
    const fake = await fakeUsbmuxd({ devices: [] });
    const errors: unknown[] = [];
    const forwarder = await startForwarder({
      socketPath: fake.socketPath,
      udid: UDID,
      port: RUNNER_PORT,
      onTunnelError: (error) => errors.push(error),
    });
    cleanups.push(() => forwarder.close());
    const start = performance.now();
    const local = connect(forwarder.port, '127.0.0.1');
    local.on('error', () => {});
    await closed(local);
    assert.ok(performance.now() - start <= NO_USB_BOUND_MS);
    assert.ok(isContrarregraError(errors[0], 'E_NO_USB'));
  });

  test('close() fecha as conexões abertas e para de escutar', async () => {
    const fake = await fakeUsbmuxd({ devices: [usbDashed], devicePorts: { [RUNNER_PORT]: 'echo' } });
    const forwarder = await startForwarder({ socketPath: fake.socketPath, udid: UDID, port: RUNNER_PORT });
    const local = connect(forwarder.port, '127.0.0.1');
    local.on('error', () => {});
    const echoed = readAll(local, 2);
    local.write('ok');
    await echoed;
    const tunnelsBefore = fake.sockets.size;
    assert.ok(tunnelsBefore >= 1);
    await forwarder.close();
    await closed(local);
    const refused = await new Promise<string>((resolve) => {
      const probe = connect(forwarder.port, '127.0.0.1');
      probe.once('connect', () => {
        probe.destroy();
        resolve('CONNECTED');
      });
      probe.once('error', (error: NodeJS.ErrnoException) => resolve(error.code ?? 'ERROR'));
    });
    assert.equal(refused, 'ECONNREFUSED');
    await forwarder.close(); // idempotente
  });
});

// ── Diretório do usbmuxd falso ──────────────────────────────────────────────────────────────────────

describe('diretório temporário do usbmuxd falso', () => {
  test('com TMPDIR longo (> 104 bytes), o socket fica num caminho curto e existe de fato onde foi pedido', async () => {
    const long = join(tmpdir(), `crr-long-${'x'.repeat(100)}`);
    mkdirSync(long, { recursive: true });
    cleanups.push(() => rmSync(long, { recursive: true, force: true }));
    const saved = process.env['TMPDIR'];
    let fake: FakeUsbmuxd;
    process.env['TMPDIR'] = long;
    try {
      assert.ok(Buffer.byteLength(join(tmpdir(), 'usbmuxd')) > UNIX_PATH_MAX, 'o os.tmpdir() leu o TMPDIR longo');
      fake = await fakeUsbmuxd({ devices: [usbDashed] });
    } finally {
      if (saved === undefined) delete process.env['TMPDIR'];
      else process.env['TMPDIR'] = saved;
    }
    assert.ok(Buffer.byteLength(fake.socketPath) <= UNIX_PATH_MAX, `caminho com ${Buffer.byteLength(fake.socketPath)} bytes`);
    assert.ok(statSync(fake.socketPath).isSocket(), 'o socket existe no caminho pedido (sem truncamento silencioso)');
    const device = await findUsbDevice({ socketPath: fake.socketPath, udid: UDID });
    assert.equal(device.deviceId, usbDashed.deviceId);
  });
});
