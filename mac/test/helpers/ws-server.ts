// Servidor WebSocket mínimo (RFC 6455) para os testes, escrito à mão sobre node:http e node:crypto: a
// constituição (P-2) proíbe `ws`. Faz o papel do runner (JSON-RPC, S0.5) e, adiante, do obs-websocket
// (subprotocolo `obswebsocket.json`). Sem extensões (nada de permessage-deflate); quadros do cliente têm
// de vir mascarados; erro de protocolo fecha com o código da RFC (1002, 1007, 1009).

import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import type { Duplex } from 'node:stream';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const OPCODE = { continuation: 0x0, text: 0x1, binary: 0x2, close: 0x8, ping: 0x9, pong: 0xa } as const;
const DEFAULT_MAX_MESSAGE_BYTES = 16 * 1024 * 1024;
const CLOSE_TIMEOUT_MS = 1000;
/** Quadro de controle tem no máximo 125 bytes: 2 do código + até 123 do motivo (RFC 6455 §5.5, §5.5.1). */
const MAX_CLOSE_REASON_BYTES = 123;
const utf8 = new TextDecoder('utf-8', { fatal: true });

/** `Sec-WebSocket-Accept` para uma `Sec-WebSocket-Key` (RFC 6455 §4.2.2). */
export function acceptKey(key: string): string {
  return createHash('sha1').update(key + GUID).digest('base64');
}

export interface WsCloseInfo {
  /** Código do quadro de fechamento recebido; sem ele, o enviado; sem nenhum, 1006. */
  code: number;
  reason: string;
  /** Os dois lados trocaram quadros de fechamento. */
  clean: boolean;
}

export interface WsTestServerOptions {
  /** Padrão: `127.0.0.1` (só loopback). */
  host?: string;
  /** Padrão: 0 (porta efêmera). */
  port?: number;
  /** Subprotocolos aceitos; escolhe o primeiro que o cliente oferecer e estiver aqui. */
  protocols?: string[];
  maxMessageBytes?: number;
  /** Chamado a cada conexão aceita, antes de qualquer mensagem chegar. */
  onConnection?: (connection: WsTestConnection) => void;
}

interface Frame {
  fin: boolean;
  opcode: number;
  payload: Buffer;
}

interface Waiter {
  resolve: (text: string) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/** Uma conexão aceita pelo servidor de teste. */
export class WsTestConnection {
  readonly request: IncomingMessage;
  /** Subprotocolo escolhido no handshake (`''` se nenhum). */
  readonly protocol: string;
  /** Todas as mensagens de texto recebidas, em ordem. */
  readonly messages: string[] = [];
  readonly binaryMessages: Buffer[] = [];
  /** Resolve quando o TCP fecha. */
  readonly closed: Promise<WsCloseInfo>;

  #socket: Duplex;
  #maxMessageBytes: number;
  #buffer: Buffer = Buffer.alloc(0);
  #fragmentOpcode: number | null = null;
  #fragments: Buffer[] = [];
  #fragmentBytes = 0;
  #failed = false;
  #closeSent: { code: number; reason: string } | null = null;
  #closeReceived: { code: number; reason: string } | null = null;
  #closeTimer: NodeJS.Timeout | undefined;
  #handlers: ((text: string) => void)[] = [];
  #unread: string[] = [];
  #waiters: Waiter[] = [];
  #resolveClosed!: (info: WsCloseInfo) => void;

  constructor(request: IncomingMessage, socket: Duplex, head: Buffer, protocol: string, maxMessageBytes: number) {
    this.request = request;
    this.protocol = protocol;
    this.#socket = socket;
    this.#maxMessageBytes = maxMessageBytes;
    this.closed = new Promise((resolve) => {
      this.#resolveClosed = resolve;
    });
    (socket as Socket).setNoDelay?.(true);
    socket.on('data', (chunk: Buffer) => this.#onData(chunk));
    socket.on('error', () => {
      // o 'close' que vem em seguida resolve `closed`
    });
    socket.on('close', () => this.#onSocketClosed());
    // Bytes que chegaram junto com o handshake: processados depois que `onConnection` registrou os handlers.
    if (head.length > 0) process.nextTick(() => this.#onData(head));
  }

  /** Registra um tratador para cada mensagem de texto. */
  onMessage(handler: (text: string) => void): void {
    this.#handlers.push(handler);
  }

  /** A próxima mensagem de texto ainda não lida por `nextMessage`. */
  nextMessage(timeoutMs = 2000): Promise<string> {
    const queued = this.#unread.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          this.#waiters = this.#waiters.filter((w) => w !== waiter);
          reject(new Error(`nenhuma mensagem em ${timeoutMs} ms`));
        }, timeoutMs),
      };
      this.#waiters.push(waiter);
    });
  }

  send(text: string): void {
    this.#assertOpen();
    this.#sendFrame(OPCODE.text, Buffer.from(text, 'utf8'));
  }

  sendJson(value: unknown): void {
    this.send(JSON.stringify(value));
  }

  sendBinary(data: Buffer): void {
    this.#assertOpen();
    this.#sendFrame(OPCODE.binary, data);
  }

  ping(payload: Buffer = Buffer.alloc(0)): void {
    this.#assertOpen();
    this.#sendFrame(OPCODE.ping, payload);
  }

  /** Inicia o fechamento (RFC 6455 §7); resolve quando o TCP fecha. Sem resposta em 1 s, derruba. */
  close(code = 1000, reason = ''): Promise<WsCloseInfo> {
    if (this.#closeSent === null && !this.#socket.destroyed) {
      this.#sendClose(code, reason);
      if (this.#closeReceived !== null) this.#socket.end();
      else this.#closeTimer = setTimeout(() => this.#socket.destroy(), CLOSE_TIMEOUT_MS);
    }
    return this.closed;
  }

  /** Derruba o TCP sem quadro de fechamento (simula queda do runner ou do cabo). */
  terminate(): void {
    this.#socket.destroy();
  }

  #assertOpen(): void {
    if (this.#closeSent !== null || this.#closeReceived !== null || this.#socket.destroyed) {
      throw new Error('conexão WebSocket fechando ou fechada');
    }
  }

  #onData(chunk: Buffer): void {
    if (this.#failed) return;
    this.#buffer = this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk]);
    for (;;) {
      const frame = this.#readFrame();
      if (frame === null) return;
      this.#handleFrame(frame);
      if (this.#failed || this.#closeReceived !== null) return;
    }
  }

  #readFrame(): Frame | null {
    const b = this.#buffer;
    if (b.length < 2) return null;
    const fin = (b[0]! & 0x80) !== 0;
    const opcode = b[0]! & 0x0f;
    const masked = (b[1]! & 0x80) !== 0;
    if ((b[0]! & 0x70) !== 0) return this.#fail(1002, 'bits RSV sem extensão negociada');
    if (!masked) return this.#fail(1002, 'quadro do cliente sem máscara');
    let length = b[1]! & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (b.length < 4) return null;
      length = b.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (b.length < 10) return null;
      const big = b.readBigUInt64BE(2);
      if (big > BigInt(this.#maxMessageBytes)) return this.#fail(1009, 'mensagem grande demais');
      length = Number(big);
      offset = 10;
    }
    if (opcode >= 0x8 && (!fin || length > 125)) return this.#fail(1002, 'quadro de controle fragmentado ou com mais de 125 bytes');
    if (length > this.#maxMessageBytes) return this.#fail(1009, 'mensagem grande demais');
    if (b.length < offset + 4 + length) return null;
    const mask = b.subarray(offset, offset + 4);
    const payload = Buffer.allocUnsafe(length);
    const start = offset + 4;
    for (let i = 0; i < length; i++) payload[i] = b[start + i]! ^ mask[i & 3]!;
    this.#buffer = b.subarray(start + length);
    return { fin, opcode, payload };
  }

  #handleFrame({ fin, opcode, payload }: Frame): void {
    switch (opcode) {
      case OPCODE.text:
      case OPCODE.binary:
        if (this.#fragmentOpcode !== null) {
          this.#fail(1002, 'mensagem nova no meio de uma fragmentada');
          return;
        }
        if (fin) {
          this.#deliver(opcode, payload);
          return;
        }
        this.#fragmentOpcode = opcode;
        this.#fragments = [payload];
        this.#fragmentBytes = payload.length;
        return;
      case OPCODE.continuation: {
        if (this.#fragmentOpcode === null) {
          this.#fail(1002, 'continuação sem mensagem iniciada');
          return;
        }
        this.#fragmentBytes += payload.length;
        if (this.#fragmentBytes > this.#maxMessageBytes) {
          this.#fail(1009, 'mensagem grande demais');
          return;
        }
        this.#fragments.push(payload);
        if (!fin) return;
        const messageOpcode = this.#fragmentOpcode;
        const data = Buffer.concat(this.#fragments);
        this.#fragmentOpcode = null;
        this.#fragments = [];
        this.#deliver(messageOpcode, data);
        return;
      }
      case OPCODE.ping:
        if (this.#closeSent === null) this.#sendFrame(OPCODE.pong, payload);
        return;
      case OPCODE.pong:
        return;
      case OPCODE.close:
        this.#onCloseFrame(payload);
        return;
      default:
        this.#fail(1002, `opcode desconhecido 0x${opcode.toString(16)}`);
    }
  }

  #deliver(opcode: number, data: Buffer): void {
    if (opcode === OPCODE.binary) {
      this.binaryMessages.push(data);
      return;
    }
    let text: string;
    try {
      text = utf8.decode(data);
    } catch {
      this.#fail(1007, 'texto com UTF-8 inválido');
      return;
    }
    this.messages.push(text);
    const waiter = this.#waiters.shift();
    if (waiter !== undefined) {
      clearTimeout(waiter.timer);
      waiter.resolve(text);
    } else {
      this.#unread.push(text);
    }
    for (const handler of this.#handlers) handler(text);
  }

  #onCloseFrame(payload: Buffer): void {
    if (payload.length === 1) {
      this.#fail(1002, 'quadro de fechamento com 1 byte');
      return;
    }
    let code = 1005;
    let reason = '';
    if (payload.length >= 2) {
      code = payload.readUInt16BE(0);
      if (!isValidCloseCode(code)) {
        this.#fail(1002, `código de fechamento inválido ${code}`);
        return;
      }
      try {
        reason = utf8.decode(payload.subarray(2));
      } catch {
        this.#fail(1007, 'motivo de fechamento com UTF-8 inválido');
        return;
      }
    }
    this.#closeReceived = { code, reason };
    if (this.#closeSent === null) this.#sendClose(code === 1005 ? undefined : code, reason);
    // Depois da troca dos quadros, o servidor fecha o TCP primeiro (RFC 6455 §7.1.1).
    this.#socket.end();
  }

  #fail(code: number, reason: string): null {
    this.#failed = true;
    if (this.#closeSent === null && !this.#socket.destroyed) this.#sendClose(code, reason);
    this.#socket.end();
    this.#closeTimer ??= setTimeout(() => this.#socket.destroy(), CLOSE_TIMEOUT_MS);
    return null;
  }

  #sendClose(code: number | undefined, reason = ''): void {
    let payload = Buffer.alloc(0);
    let sentReason = '';
    if (code !== undefined) {
      sentReason = truncateUtf8(reason, MAX_CLOSE_REASON_BYTES);
      const text = Buffer.from(sentReason, 'utf8');
      payload = Buffer.alloc(2 + text.length);
      payload.writeUInt16BE(code, 0);
      text.copy(payload, 2);
    }
    this.#closeSent = { code: code ?? 1005, reason: sentReason };
    this.#sendFrame(OPCODE.close, payload);
  }

  #sendFrame(opcode: number, payload: Buffer): void {
    if (this.#socket.destroyed || !this.#socket.writable) return;
    const length = payload.length;
    let header: Buffer;
    if (length < 126) {
      header = Buffer.from([0x80 | opcode, length]);
    } else if (length < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(length), 2);
    }
    this.#socket.write(Buffer.concat([header, payload]));
  }

  #onSocketClosed(): void {
    clearTimeout(this.#closeTimer);
    for (const waiter of this.#waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error('conexão WebSocket fechada'));
    }
    const first = this.#closeReceived ?? this.#closeSent;
    this.#resolveClosed({
      code: first?.code ?? 1006,
      reason: first?.reason ?? '',
      clean: this.#closeReceived !== null && this.#closeSent !== null,
    });
  }
}

/** O maior prefixo de `text` que cabe em `maxBytes` de UTF-8 sem partir um caractere. */
function truncateUtf8(text: string, maxBytes: number): string {
  let bytes = 0;
  let end = 0;
  for (const char of text) {
    const size = Buffer.byteLength(char, 'utf8');
    if (bytes + size > maxBytes) break;
    bytes += size;
    end += char.length;
  }
  return text.slice(0, end);
}

function isValidCloseCode(code: number): boolean {
  if (code >= 3000 && code <= 4999) return true;
  return code >= 1000 && code <= 1014 && code !== 1004 && code !== 1005 && code !== 1006;
}

export interface WsTestServer {
  /** `ws://127.0.0.1:<porta>`. */
  readonly url: string;
  readonly port: number;
  /** Conexões abertas (cada uma sai do conjunto quando o TCP fecha). */
  readonly connections: ReadonlySet<WsTestConnection>;
  /** A próxima conexão aceita ainda não entregue por esta função. */
  nextConnection(timeoutMs?: number): Promise<WsTestConnection>;
  /** Fecha toda conexão aberta com 1001 e para de escutar. Idempotente. */
  close(): Promise<void>;
}

/** Sobe o servidor de teste (padrão: loopback, porta efêmera). */
export async function startWsServer(options: WsTestServerOptions = {}): Promise<WsTestServer> {
  const host = options.host ?? '127.0.0.1';
  const maxMessageBytes = options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES;
  const connections = new Set<WsTestConnection>();
  const accepted: WsTestConnection[] = [];
  const waiting: ((connection: WsTestConnection) => void)[] = [];

  const http = createServer((_request, response) => {
    response.writeHead(426, { Upgrade: 'websocket', Connection: 'close', 'Content-Length': '0' });
    response.end();
  });

  http.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const key = request.headers['sec-websocket-key'];
    const upgrade = String(request.headers.upgrade ?? '').toLowerCase();
    const validKey = typeof key === 'string' && Buffer.from(key, 'base64').length === 16;
    if (request.method !== 'GET' || upgrade !== 'websocket' || request.headers['sec-websocket-version'] !== '13' || !validKey) {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    const offered = String(request.headers['sec-websocket-protocol'] ?? '')
      .split(',')
      .map((p) => p.trim())
      .filter((p) => p !== '');
    const protocol = offered.find((p) => options.protocols?.includes(p)) ?? '';
    const lines = [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${acceptKey(key)}`,
    ];
    if (protocol !== '') lines.push(`Sec-WebSocket-Protocol: ${protocol}`);
    socket.write(`${lines.join('\r\n')}\r\n\r\n`);

    const connection = new WsTestConnection(request, socket, head, protocol, maxMessageBytes);
    connections.add(connection);
    void connection.closed.then(() => connections.delete(connection));
    options.onConnection?.(connection);
    const waiter = waiting.shift();
    if (waiter !== undefined) waiter(connection);
    else accepted.push(connection);
  });

  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen(options.port ?? 0, host, () => {
      http.off('error', reject);
      resolve();
    });
  });
  const { port } = http.address() as AddressInfo;
  let closing: Promise<void> | undefined;

  return {
    url: `ws://${host}:${port}`,
    port,
    connections,
    nextConnection(timeoutMs = 2000): Promise<WsTestConnection> {
      const next = accepted.shift();
      if (next !== undefined) return Promise.resolve(next);
      return new Promise((resolve, reject) => {
        const deliver = (connection: WsTestConnection): void => {
          clearTimeout(timer);
          resolve(connection);
        };
        const timer = setTimeout(() => {
          waiting.splice(waiting.indexOf(deliver), 1);
          reject(new Error(`nenhuma conexão em ${timeoutMs} ms`));
        }, timeoutMs);
        waiting.push(deliver);
      });
    },
    close(): Promise<void> {
      closing ??= (async () => {
        const stopped = new Promise<void>((resolve) => http.close(() => resolve()));
        await Promise.all([...connections].map((c) => c.close(1001, 'servidor de teste encerrando')));
        http.closeAllConnections();
        await stopped;
      })();
      return closing;
    },
  };
}
