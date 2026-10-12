// Testes da T-0.12: cliente obs-websocket próprio e segredos (spec S9 item 2, E-9.1, E-9.2, E-9.4;
// S8 item 8, E-8.2; AC-8.5 parte do segredo; AC-9.9 parcial: a guarda do cliente com um OBS falso).
// O OBS é falso, sobre o servidor WebSocket escrito à mão de `helpers/ws-server.ts` (P-2); nada
// conecta no OBS real. Os testes nunca leem o Chaveiro real nem a senha real: o `security` é um
// executor falso, e a única chamada ao `/usr/bin/security` de verdade procura um item num serviço de
// teste que não existe, só para provar o caminho de ausência. As senhas daqui são inventadas.
//
// Vetores de autenticação calculados fora do Node, com openssl (o exemplo da documentação do
// obs-websocket não é vetor válido; pesquisa F3):
//   h() { printf '%s' "$1" | /usr/bin/openssl dgst -sha256 -binary | /usr/bin/base64; }
//   h "$(h "$senha$salt")$challenge"

import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createServer, type AddressInfo, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { format, inspect } from 'node:util';

import { loadConfig } from '../src/core/config.ts';
import { isContrarregraError, type ContrarregraError, type ErrorCode } from '../src/core/errors.ts';
import {
  addSecretCommand,
  KEYCHAIN_SERVICE,
  readSecret,
  REDACTED,
  Secret,
  SECRET_TIMEOUT_MS,
  SECURITY_PATH,
  type SecurityResult,
  type SecurityRunner,
} from '../src/core/secret.ts';
import { ADV_FILE_OUTPUT, isWriteRequest, ObsClient, obsClientOptions, type ObsClientOptions } from '../src/obs/client.ts';
import {
  CLOSE_TIMEOUT_MS,
  CONNECT_TIMEOUT_MS,
  OBS_BATCH_EXECUTION,
  OBS_EVENT_SUBSCRIPTIONS,
  OBS_SERVER_SETTINGS_MENU,
  OBS_SUBPROTOCOL,
  obsAuthentication,
  ObsRequestError,
  REQUEST_TIMEOUT_MS,
  STOP_RECORD_TIMEOUT_MS,
  type JsonObject,
  type ObsEvent,
} from '../src/obs/ws.ts';
import { acceptKey, startWsServer, type WsTestConnection, type WsTestServer } from './helpers/ws-server.ts';

// ---------------------------------------------------------------------------------------------------
// Vetores e dados fixos

interface AuthVector {
  password: string;
  salt: string;
  challenge: string;
  authentication: string;
}

const V1: AuthVector = {
  password: 'contrarregra-teste-9f3k2',
  salt: 'c2FsdC1kZS10ZXN0ZQ==',
  challenge: 'Y2hhbGxlbmdlLWRlLXRlc3Rl',
  authentication: 'ayFS0hKKwvmaIc4dQAxpQp9EaTocyFfn2aG0zmu2rrM=',
};
const V2: AuthVector = {
  password: 'Sénha çom ✓ acentos',
  salt: 'lM1GncleQOaCu9lT1yeUZhFYnqhsLLP1G5lAGo3ixaI=',
  challenge: '+IxH4CnCiqpX1rM9scsNynZzbOe4KhDeYcTNS3PDaeY=',
  authentication: 'eFplNJHCTvCgH2pNgrFFzegLAIzskbN4zW5qL0grZtU=',
};
const V3: AuthVector = { password: 'x', salt: 'abc', challenge: 'def', authentication: 'DjBAB/LR10+2Sxn4z8KGpwp1VDex0WrQ/VbuYf9NfGI=' };
/** O exemplo da documentação: o `authentication` do Identify de lá não é o que o algoritmo dá. */
const DOC_EXAMPLE = {
  password: 'supersecretpassword',
  salt: V2.salt,
  challenge: V2.challenge,
  documented: 'Dj6cLS+jrNA0HpCArRg0Z/Fc+YHdt2FQfAvgD1mip6Y=',
  computed: '1Ct943GAT+6YQUUX47Ia/ncufilbe6+oD6lY+5kaCu4=',
};
const WRONG_PASSWORD = 'senha-errada-inventada-77';
const D02_COMMAND = "security add-generic-password -s contrarregra -a OBS_WEBSOCKET_PASSWORD -l 'Contrarregra OBS WebSocket' -U -w";

const STARTED = { outputActive: true, outputState: 'OBS_WEBSOCKET_OUTPUT_STARTED', outputPath: '/tmp/contrarregra-falso/rec.mp4' };
const STATS = {
  cpuUsage: 3.5,
  memoryUsage: 420.5,
  availableDiskSpace: 9216,
  activeFps: 60,
  averageFrameRenderTime: 1.2,
  renderSkippedFrames: 0,
  renderTotalFrames: 3600,
  outputSkippedFrames: 0,
  outputTotalFrames: 3600,
  webSocketSessionIncomingMessages: 10,
  webSocketSessionOutgoingMessages: 12,
};
const OUTPUT_STATUS = {
  outputActive: true,
  outputReconnecting: false,
  outputTimecode: '00:01:00.000',
  outputDuration: 60000,
  outputCongestion: 0,
  outputBytes: 122_000_000,
  outputSkippedFrames: 0,
  outputTotalFrames: 3600,
};
const DEVICE_ITEMS = [{ itemName: 'VIVO_00G7', itemValue: '00008101-001E79203A68001E', itemEnabled: true }];
const AVAILABLE_REQUESTS = [
  'GetVersion', 'GetStats', 'GetProfileList', 'GetSceneCollectionList', 'GetRecordStatus', 'StartRecord', 'StopRecord',
  'CreateRecordChapter', 'GetOutputStatus', 'GetInputPropertiesListPropertyItems', 'SetSceneItemEnabled', 'Sleep',
  'SetRecordDirectory', 'SetInputSettings', 'SetProfileParameter', 'SetVideoSettings', 'CreateInput',
];

// ---------------------------------------------------------------------------------------------------
// OBS falso

type Reply = { code?: number; comment?: string; data?: JsonObject } | undefined;
type Handler = (requestData: JsonObject | undefined, fake: FakeObs) => Reply | Promise<Reply>;

interface FakeObsOptions {
  /** Ausente: o Hello não pede senha. */
  auth?: AuthVector;
  hello?: { obsStudioVersion?: string; obsWebSocketVersion?: string; rpcVersion?: number };
  availableRequests?: string[];
  profile?: string;
  collection?: string;
  handlers?: Record<string, Handler>;
  /** Subprotocolos que o servidor aceita (padrão: só `obswebsocket.json`). */
  protocols?: string[];
  /** `false`: aceita a conexão e nunca manda o Hello. */
  sendHello?: boolean;
  /** Atraso antes de responder cada lote (op 8). */
  batchDelayMs?: number;
}

const DEFAULT_HANDLERS: Record<string, Handler> = {
  GetVersion: (_d, f) => ({
    data: {
      obsVersion: '31.1.2',
      obsWebSocketVersion: '5.6.2',
      rpcVersion: 1,
      availableRequests: f.availableRequests,
      supportedImageFormats: ['png', 'jpg'],
      platform: 'macos',
      platformDescription: 'macOS 26.5',
    },
  }),
  GetProfileList: (_d, f) => ({ data: { currentProfileName: f.profile, profiles: ['Untitled', 'Contrarregra'] } }),
  GetSceneCollectionList: (_d, f) => ({ data: { currentSceneCollectionName: f.collection, sceneCollections: ['Untitled', 'Contrarregra'] } }),
  GetRecordStatus: (_d, f) => ({
    data: { outputActive: f.recording, outputPaused: false, outputTimecode: '00:00:00.000', outputDuration: 0, outputBytes: 0 },
  }),
  // Como no OBS (pesquisa F5): o evento STARTED pode chegar antes da resposta do StartRecord.
  StartRecord: (_d, f) => {
    if (f.recording) return { code: 500 };
    f.recording = true;
    f.emit('RecordStateChanged', STARTED);
    return undefined;
  },
  StopRecord: (_d, f) => {
    if (!f.recording) return { code: 501 };
    f.recording = false;
    return { data: { outputPath: STARTED.outputPath } };
  },
  CreateRecordChapter: (_d, f) => (f.recording ? undefined : { code: 501 }),
  GetStats: () => ({ data: STATS }),
  GetOutputStatus: (d) => (d?.['outputName'] === ADV_FILE_OUTPUT ? { data: OUTPUT_STATUS } : { code: 600, comment: 'No output was found.' }),
  GetInputPropertiesListPropertyItems: (d) =>
    d?.['propertyName'] === 'device' ? { data: { propertyItems: DEVICE_ITEMS } } : { code: 600, comment: 'Unknown property.' },
};

const fakes: FakeObs[] = [];
const clients: ObsClient[] = [];

class FakeObs {
  profile: string;
  collection: string;
  recording = false;
  readonly availableRequests: string[];
  /** `recv:<tipo>` / `send:<tipo>` / `recv:batch` / `send:batch` / `event:<tipo>`, na ordem em que aconteceram. */
  readonly trace: string[] = [];
  readonly requests: { requestType: string; requestData: JsonObject | undefined }[] = [];
  readonly batches: JsonObject[] = [];
  readonly identifies: JsonObject[] = [];
  /** Todo texto que o cliente mandou, cru. */
  readonly wire: string[] = [];
  readonly errors: unknown[] = [];
  connectionCount = 0;
  connection: WsTestConnection | undefined;
  readonly server: WsTestServer;
  readonly #options: FakeObsOptions;

  private constructor(server: WsTestServer, options: FakeObsOptions) {
    this.server = server;
    this.#options = options;
    this.profile = options.profile ?? 'Contrarregra';
    this.collection = options.collection ?? 'Contrarregra';
    this.availableRequests = options.availableRequests ?? AVAILABLE_REQUESTS;
  }

  static async start(options: FakeObsOptions = {}): Promise<FakeObs> {
    let fake: FakeObs | undefined;
    const server = await startWsServer({
      protocols: options.protocols ?? [OBS_SUBPROTOCOL],
      onConnection: (c) => fake!.#accept(c),
    });
    fake = new FakeObs(server, options);
    fakes.push(fake);
    return fake;
  }

  get url(): string {
    return this.server.url;
  }

  /** Tipos dos pedidos que escrevem (não `Get*`) e dos que vieram em lote. */
  writes(): string[] {
    const single = this.requests.map((r) => r.requestType).filter((t) => !t.startsWith('Get'));
    const batched = this.batches.flatMap((b) => (b['requests'] as { requestType: string }[]).map((r) => r.requestType));
    return [...single, ...batched];
  }

  emit(eventType: string, eventData: JsonObject): void {
    this.trace.push(`event:${eventType}`);
    this.connection?.sendJson({ op: 5, d: { eventType, eventIntent: 64, eventData } });
  }

  #accept(c: WsTestConnection): void {
    this.connectionCount += 1;
    this.connection = c;
    c.onMessage((text) => {
      this.#onMessage(c, text).catch((error: unknown) => this.errors.push(error));
    });
    if (this.#options.sendHello === false) return;
    const hello: JsonObject = { obsStudioVersion: '31.1.2', obsWebSocketVersion: '5.6.2', rpcVersion: 1, ...this.#options.hello };
    const auth = this.#options.auth;
    if (auth !== undefined) hello['authentication'] = { challenge: auth.challenge, salt: auth.salt };
    c.sendJson({ op: 0, d: hello });
  }

  async #onMessage(c: WsTestConnection, text: string): Promise<void> {
    this.wire.push(text);
    const { op, d } = JSON.parse(text) as { op: number; d: JsonObject };
    if (op === 1) {
      this.identifies.push(d);
      const auth = this.#options.auth;
      if (auth !== undefined && d['authentication'] !== auth.authentication) {
        await c.close(4009, 'Authentication failed.');
        return;
      }
      c.sendJson({ op: 2, d: { negotiatedRpcVersion: 1 } });
      return;
    }
    if (op === 6) {
      const requestType = d['requestType'] as string;
      const requestData = d['requestData'] as JsonObject | undefined;
      this.requests.push({ requestType, requestData });
      this.trace.push(`recv:${requestType}`);
      const handler = this.#options.handlers?.[requestType] ?? DEFAULT_HANDLERS[requestType];
      const reply: Reply = handler === undefined ? { code: 204, comment: 'Unknown request type.' } : await handler(requestData, this);
      const code = reply?.code ?? 100;
      const status: JsonObject = { result: code === 100, code };
      if (reply?.comment !== undefined) status['comment'] = reply.comment;
      const response: JsonObject = { requestType, requestId: d['requestId'], requestStatus: status };
      if (reply?.data !== undefined) response['responseData'] = reply.data;
      this.#send(c, `send:${requestType}`, { op: 7, d: response });
      return;
    }
    if (op === 8) {
      this.batches.push(d);
      this.trace.push('recv:batch');
      if (this.#options.batchDelayMs !== undefined) await sleep(this.#options.batchDelayMs);
      const results = (d['requests'] as JsonObject[]).map((r) => ({
        requestType: r['requestType'],
        requestId: r['requestId'],
        requestStatus: { result: true, code: 100 },
      }));
      this.#send(c, 'send:batch', { op: 9, d: { requestId: d['requestId'], results } });
    }
  }

  #send(c: WsTestConnection, label: string, message: JsonObject): void {
    try {
      c.sendJson(message);
      this.trace.push(label);
    } catch {
      // conexão já fechando: a resposta se perde, como no OBS
    }
  }
}

// ---------------------------------------------------------------------------------------------------
// OBS congelado: servidor WebSocket cru (node:net), porque o de `helpers/ws-server.ts` sempre devolve o
// quadro de fechamento. Completa o handshake (101, Hello sem senha, Identified), responde só os pedidos
// de `answer` e ignora todo o resto — inclusive o quadro de fechamento — sem nunca fechar o TCP, como
// um OBS travado ou suspenso.

interface FrozenObs {
  url: string;
  /** `requestType` de cada pedido recebido. */
  readonly requests: string[];
  /** Quadros de fechamento recebidos (e ignorados). */
  readonly closeFrames: () => number;
  /** TCPs que caíram (o cliente derrubou). */
  readonly socketsClosed: () => number;
  stop(): Promise<void>;
}

const frozens: FrozenObs[] = [];

function serverTextFrame(text: string): Buffer {
  const payload = Buffer.from(text, 'utf8');
  if (payload.length < 126) return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
  const head = Buffer.from([0x81, 126, 0, 0]);
  head.writeUInt16BE(payload.length, 2);
  return Buffer.concat([head, payload]);
}

/** Lê os quadros mascarados do cliente; devolve os completos e o que sobrou. */
function readClientFrames(buffer: Buffer): { frames: { opcode: number; payload: Buffer }[]; rest: Buffer } {
  const frames: { opcode: number; payload: Buffer }[] = [];
  let b = buffer;
  for (;;) {
    if (b.length < 2) break;
    const opcode = b[0]! & 0x0f;
    let length = b[1]! & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (b.length < 4) break;
      length = b.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (b.length < 10) break;
      length = Number(b.readBigUInt64BE(2));
      offset = 10;
    }
    if (b.length < offset + 4 + length) break;
    const mask = b.subarray(offset, offset + 4);
    const payload = Buffer.from(b.subarray(offset + 4, offset + 4 + length).map((x, i) => x ^ mask[i & 3]!));
    frames.push({ opcode, payload });
    b = b.subarray(offset + 4 + length);
  }
  return { frames, rest: b };
}

async function startFrozenObs(options: { hello?: boolean; answer?: Record<string, JsonObject> } = {}): Promise<FrozenObs> {
  const sockets = new Set<Socket>();
  const requests: string[] = [];
  let closeFrames = 0;
  let socketsClosed = 0;
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => {
      sockets.delete(socket);
      socketsClosed += 1;
    });
    socket.on('error', () => {});
    let upgraded = false;
    let buffer: Buffer = Buffer.alloc(0);
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!upgraded) {
        const end = buffer.indexOf('\r\n\r\n');
        if (end === -1) return;
        const key = /sec-websocket-key: *([^\r\n]+)/i.exec(buffer.subarray(0, end).toString('latin1'))?.[1]?.trim() ?? '';
        socket.write(
          'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
            `Sec-WebSocket-Accept: ${acceptKey(key)}\r\nSec-WebSocket-Protocol: ${OBS_SUBPROTOCOL}\r\n\r\n`,
        );
        if (options.hello !== false) {
          socket.write(serverTextFrame(JSON.stringify({ op: 0, d: { obsStudioVersion: '31.1.2', obsWebSocketVersion: '5.6.2', rpcVersion: 1 } })));
        }
        upgraded = true;
        buffer = buffer.subarray(end + 4);
      }
      const { frames, rest } = readClientFrames(buffer);
      buffer = rest;
      for (const { opcode, payload } of frames) {
        if (opcode === 0x8) {
          closeFrames += 1; // ignorado: não devolve o quadro nem fecha o TCP
          continue;
        }
        if (opcode !== 0x1) continue;
        const { op, d } = JSON.parse(payload.toString('utf8')) as { op: number; d: JsonObject };
        if (op === 1) {
          socket.write(serverTextFrame(JSON.stringify({ op: 2, d: { negotiatedRpcVersion: 1 } })));
        } else if (op === 6) {
          const requestType = d['requestType'] as string;
          requests.push(requestType);
          const data = options.answer?.[requestType];
          if (data !== undefined) {
            const response = { requestType, requestId: d['requestId'], requestStatus: { result: true, code: 100 }, responseData: data };
            socket.write(serverTextFrame(JSON.stringify({ op: 7, d: response })));
          }
        }
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  const frozen: FrozenObs = {
    url: `ws://127.0.0.1:${port}`,
    requests,
    closeFrames: () => closeFrames,
    socketsClosed: () => socketsClosed,
    stop: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
  frozens.push(frozen);
  return frozen;
}

const VERSION_DATA: JsonObject = {
  obsVersion: '31.1.2',
  obsWebSocketVersion: '5.6.2',
  rpcVersion: 1,
  availableRequests: AVAILABLE_REQUESTS,
  supportedImageFormats: ['png'],
  platform: 'macos',
  platformDescription: 'macOS 26.5',
};

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
  const closing = fakes.splice(0);
  await Promise.all(closing.map((f) => f.server.close()));
  for (const f of closing) assert.deepEqual(f.errors, [], 'o OBS falso não pode ter falhado');
  await Promise.all(frozens.splice(0).map((f) => f.stop()));
});

// ---------------------------------------------------------------------------------------------------
// Ajudantes

function clientOptions(fake: FakeObs, overrides: Partial<ObsClientOptions> = {}): ObsClientOptions {
  return {
    url: fake.url,
    profile: 'Contrarregra',
    collection: 'Contrarregra',
    expected: { obs: '31.1.2', obsWebsocket: '5.6.2' },
    password: new Secret(V1.password),
    ...overrides,
  };
}

async function connect(fake: FakeObs, overrides: Partial<ObsClientOptions> = {}): Promise<ObsClient> {
  const client = await ObsClient.connect(clientOptions(fake, overrides));
  clients.push(client);
  return client;
}

async function rejectsWithCode(promise: Promise<unknown>, code: ErrorCode): Promise<ContrarregraError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(isContrarregraError(error), `esperava ContrarregraError ${code}, veio ${inspect(error)}`);
    assert.equal(error.code, code, error.message);
    return error;
  }
  return assert.fail(`esperava ${code}, mas resolveu`);
}

function fakeSecurity(result: Partial<SecurityResult>): { run: SecurityRunner; calls: { file: string; args: string[]; timeoutMs: number }[] } {
  const calls: { file: string; args: string[]; timeoutMs: number }[] = [];
  const run: SecurityRunner = async (file, args, { timeoutMs }) => {
    calls.push({ file, args: [...args], timeoutMs });
    return { exitCode: 0, stdout: '', timedOut: false, ...result };
  };
  return { run, calls };
}

const CONSOLE_METHODS = ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const;

/** Troca os métodos do `console` por um coletor enquanto `fn` roda. */
async function captureConsole<T>(fn: () => Promise<T>): Promise<{ result: T; lines: string[] }> {
  const lines: string[] = [];
  const saved = CONSOLE_METHODS.map((m) => console[m]);
  for (const m of CONSOLE_METHODS) {
    console[m] = (...args: unknown[]): void => {
      lines.push(format(...args));
    };
  }
  try {
    return { result: await fn(), lines };
  } finally {
    CONSOLE_METHODS.forEach((m, i) => {
      console[m] = saved[i]!;
    });
  }
}

function occurrences(haystack: string, needle: string): number {
  let count = 0;
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + 1)) count += 1;
  return count;
}

/** Tudo que um erro mostra: mensagem, inspeção completa (pilha, `data`, `cause`) e o `data` em JSON. */
function dumpError(error: unknown): string {
  const data = isContrarregraError(error) ? JSON.stringify(error.data) : '';
  return [String(error), inspect(error, { depth: Infinity, showHidden: true }), data].join('\n');
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('tempo esgotado esperando a condição');
    await new Promise((r) => setTimeout(r, 5));
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------------------------------
// core/secret.ts

describe('segredos: core/secret.ts (S8 item 8, E-8.2, P-3, D2)', () => {
  test('Secret se imprime como [redacted] em String, template, JSON, inspect, util.format e console; só reveal() dá o valor', async () => {
    const secret = new Secret(V1.password);
    const { lines } = await captureConsole(async () => {
      console.log(secret);
      console.error({ secret });
      console.info('senha: %s', secret);
    });
    const shown = [
      String(secret),
      `${secret}`,
      secret + '',
      JSON.stringify({ secret, nested: [secret] }),
      inspect(secret),
      inspect({ secret }, { showHidden: true, depth: Infinity }),
      format('%s %o %O %j', secret, secret, secret, secret),
      JSON.stringify(Object.entries(secret)),
      JSON.stringify({ ...secret }),
      new Error(`falhou com ${secret}`).message,
      ...lines,
    ];
    for (const text of shown) {
      assert.equal(occurrences(text, V1.password), 0, `vazou em ${JSON.stringify(text)}`);
    }
    assert.equal(String(secret), REDACTED);
    assert.equal(JSON.stringify({ secret }), '{"secret":"[redacted]"}');
    assert.equal(inspect(secret), REDACTED);
    assert.equal(lines[0], REDACTED);
    assert.equal(secret.reveal(), V1.password);
  });

  test('readSecret chama /usr/bin/security find-generic-password -s contrarregra -a <nome> -w com prazo de 5 s; o valor nunca vai ao argv', async () => {
    assert.equal(SECURITY_PATH, '/usr/bin/security');
    assert.equal(KEYCHAIN_SERVICE, 'contrarregra');
    assert.equal(SECRET_TIMEOUT_MS, 5_000);
    const security = fakeSecurity({ stdout: `${V2.password}\n` });
    const secret = await readSecret('OBS_WEBSOCKET_PASSWORD', { run: security.run });
    assert.equal(secret.reveal(), V2.password, 'só o \\n final do `security -w` é tirado');
    assert.deepEqual(security.calls, [
      {
        file: '/usr/bin/security',
        args: ['find-generic-password', '-s', 'contrarregra', '-a', 'OBS_WEBSOCKET_PASSWORD', '-w'],
        timeoutMs: 5_000,
      },
    ]);
    assert.equal(occurrences(JSON.stringify(security.calls), V2.password), 0);
  });

  test('E-8.2: item ausente (saída 44) → E_SECRET_MISSING com o comando exato do D0.2 para o dono rodar', async () => {
    const security = fakeSecurity({ exitCode: 44 });
    const error = await rejectsWithCode(readSecret('OBS_WEBSOCKET_PASSWORD', { run: security.run }), 'E_SECRET_MISSING');
    assert.equal(addSecretCommand('OBS_WEBSOCKET_PASSWORD'), D02_COMMAND);
    assert.equal(error.data?.['command'], D02_COMMAND);
    assert.equal(error.data?.['reason'], 'not-found');
    assert.ok(error.message.includes(D02_COMMAND), error.message);
    assert.equal(security.calls.length, 1, 'uma leitura só, sem nova tentativa');
  });

  test('prazo esgotado, outra saída ou item vazio → E_SECRET_MISSING sem a saída do security; nome inválido → E_CONFIG sem chamar o security', async () => {
    const timeout = await rejectsWithCode(readSecret('OBS_WEBSOCKET_PASSWORD', { run: fakeSecurity({ exitCode: null, timedOut: true }).run }), 'E_SECRET_MISSING');
    assert.equal(timeout.data?.['reason'], 'timeout');
    // Uma saída estranha com texto na saída padrão: o texto nunca vai para o erro.
    const odd = await rejectsWithCode(readSecret('OBS_WEBSOCKET_PASSWORD', { run: fakeSecurity({ exitCode: 51, stdout: V1.password }).run }), 'E_SECRET_MISSING');
    assert.equal(odd.data?.['reason'], 'security-failed');
    assert.equal(occurrences(dumpError(odd), V1.password), 0);
    const empty = await rejectsWithCode(readSecret('OBS_WEBSOCKET_PASSWORD', { run: fakeSecurity({ stdout: '\n' }).run }), 'E_SECRET_MISSING');
    assert.equal(empty.data?.['reason'], 'empty');
    for (const name of ['-w', 'obs_password', '', 'A B']) {
      const security = fakeSecurity({ stdout: 'x\n' });
      await rejectsWithCode(readSecret(name, { run: security.run }), 'E_CONFIG');
      assert.equal(security.calls.length, 0, `nome ${JSON.stringify(name)} não pode chegar ao security`);
    }
  });

  test('o /usr/bin/security de verdade, num serviço de teste que não existe, sai com 44 → E_SECRET_MISSING', { skip: !existsSync(SECURITY_PATH) }, async () => {
    const tag = randomBytes(6).toString('hex');
    const name = `CONTRARREGRA_TESTE_${tag.toUpperCase()}`;
    const service = `contrarregra-teste-inexistente-${tag}`;
    const error = await rejectsWithCode(readSecret(name, { service }), 'E_SECRET_MISSING');
    assert.equal(error.data?.['reason'], 'not-found', error.message);
    assert.equal(error.data?.['command'], `security add-generic-password -s ${service} -a ${name} -U -w`);
  });
});

// ---------------------------------------------------------------------------------------------------
// Autenticação

describe('autenticação do obs-websocket (S9 item 2; pesquisa F3)', () => {
  test('vetores calculados localmente com openssl batem; o exemplo da documentação não é vetor válido', () => {
    for (const v of [V1, V2, V3]) {
      assert.equal(obsAuthentication(new Secret(v.password), v.salt, v.challenge), v.authentication, JSON.stringify(v.salt));
    }
    const doc = obsAuthentication(new Secret(DOC_EXAMPLE.password), DOC_EXAMPLE.salt, DOC_EXAMPLE.challenge);
    assert.equal(doc, DOC_EXAMPLE.computed);
    assert.notEqual(doc, DOC_EXAMPLE.documented);
  });
});

// ---------------------------------------------------------------------------------------------------
// Conexão

describe('cliente obs-websocket: conexão (S9 item 2, E-9.1, E-9.2)', () => {
  test('handshake: subprotocolo obswebsocket.json, Identify com rpc 1, assinaturas 323 e a autenticação do vetor; versões conferidas', async () => {
    assert.equal(OBS_EVENT_SUBSCRIPTIONS, 323);
    const fake = await FakeObs.start({ auth: V1 });
    const client = await connect(fake);
    assert.equal(fake.connection?.protocol, 'obswebsocket.json');
    assert.deepEqual(fake.identifies, [{ rpcVersion: 1, eventSubscriptions: 323, authentication: V1.authentication }]);
    assert.equal(client.hello.authRequired, true);
    assert.deepEqual(client.versions, {
      obsStudioVersion: '31.1.2',
      obsWebSocketVersion: '5.6.2',
      rpcVersion: 1,
      availableRequests: AVAILABLE_REQUESTS,
    });
    assert.deepEqual(client.versionProblems, []);
    assert.deepEqual(fake.requests.map((r) => r.requestType), ['GetVersion']);
    assert.equal(client.isOpen, true);
  });

  test('Hello sem senha: Identify sem `authentication` e o Chaveiro nem é consultado', async () => {
    const fake = await FakeObs.start();
    let reads = 0;
    const client = await connect(fake, {
      password: async () => {
        reads += 1;
        return new Secret(V1.password);
      },
    });
    assert.equal(client.hello.authRequired, false);
    assert.deepEqual(fake.identifies, [{ rpcVersion: 1, eventSubscriptions: 323 }]);
    assert.equal(reads, 0);
  });

  test('E-9.2: senha errada → o OBS fecha com 4009 → E_OBS_AUTH, sem nova tentativa automática', async () => {
    const fake = await FakeObs.start({ auth: V1 });
    const error = await rejectsWithCode(ObsClient.connect(clientOptions(fake, { password: new Secret(WRONG_PASSWORD) })), 'E_OBS_AUTH');
    assert.equal(error.data?.['closeCode'], 4009);
    await sleep(300);
    assert.equal(fake.connectionCount, 1);
    assert.equal(fake.identifies.length, 1);
  });

  test('E-9.1: servidor desligado → E_OBS_UNREACHABLE com o caminho no menu do OBS; sem Hello no prazo, ou sem o subprotocolo → E_OBS_UNREACHABLE', async () => {
    const off = await startWsServer();
    const url = off.url;
    await off.close();
    let started = performance.now();
    const refused = await rejectsWithCode(
      ObsClient.connect({ url, profile: 'Contrarregra', collection: 'Contrarregra', expected: { obs: '31.1.2', obsWebsocket: '5.6.2' } }),
      'E_OBS_UNREACHABLE',
    );
    assert.ok(performance.now() - started < 1000, 'conexão recusada falha na hora, sem esperar o prazo do handshake');
    assert.equal(refused.data?.['timeoutMs'], undefined);
    assert.ok(refused.message.includes(OBS_SERVER_SETTINGS_MENU), refused.message);
    assert.ok(refused.message.includes('Tools › WebSocket Server Settings'));

    assert.equal(CONNECT_TIMEOUT_MS, 5_000);
    const silent = await FakeObs.start({ sendHello: false });
    started = performance.now();
    const timeout = await rejectsWithCode(ObsClient.connect(clientOptions(silent, { connectTimeoutMs: 150 })), 'E_OBS_UNREACHABLE');
    assert.equal(timeout.data?.['timeoutMs'], 150);
    assert.ok(performance.now() - started < 1000);

    const noProtocol = await FakeObs.start({ protocols: [] });
    started = performance.now();
    const rejected = await rejectsWithCode(ObsClient.connect(clientOptions(noProtocol)), 'E_OBS_UNREACHABLE');
    assert.ok(performance.now() - started < 1000, 'servidor sem o subprotocolo falha na hora');
    assert.equal(rejected.data?.['timeoutMs'], undefined);
    assert.equal(noProtocol.identifies.length, 0);
  });

  test('segredo ausente na hora do handshake → E_SECRET_MISSING com o comando do D0.2 e a conexão fecha', async () => {
    const fake = await FakeObs.start({ auth: V1 });
    const security = fakeSecurity({ exitCode: 44 });
    const error = await rejectsWithCode(
      ObsClient.connect(clientOptions(fake, { password: () => readSecret('OBS_WEBSOCKET_PASSWORD', { run: security.run }) })),
      'E_SECRET_MISSING',
    );
    assert.equal(error.data?.['command'], D02_COMMAND);
    const closed = await fake.connection!.closed;
    assert.ok(closed.code === 1000 || closed.code === 1005, `fechou com ${closed.code}`);
    assert.equal(fake.identifies.length, 0, 'sem senha não há Identify');
  });

  test('a leitura do Chaveiro fica fora do prazo do handshake: Chaveiro lento conecta; Chaveiro que só termina pelo próprio prazo → E_SECRET_MISSING (timeout), não E_OBS_UNREACHABLE', { timeout: 10_000 }, async () => {
    /** `security` falso: devolve `stdout` depois de 300 ms, ou (`null`) só termina pelo próprio prazo. */
    const slowSecurity =
      (stdout: string | null): SecurityRunner =>
      async (_file, _args, { timeoutMs }) => {
        if (stdout === null) {
          await sleep(timeoutMs);
          return { exitCode: null, stdout: '', timedOut: true };
        }
        await sleep(300);
        return { exitCode: 0, stdout, timedOut: false };
      };
    const fake = await FakeObs.start({ auth: V1 });
    const client = await connect(fake, {
      connectTimeoutMs: 150,
      password: () => readSecret('OBS_WEBSOCKET_PASSWORD', { run: slowSecurity(`${V1.password}\n`) }),
    });
    assert.equal(client.isOpen, true, 'os 300 ms do Chaveiro não contam no prazo de 150 ms do handshake');
    assert.deepEqual(fake.identifies, [{ rpcVersion: 1, eventSubscriptions: 323, authentication: V1.authentication }]);

    const stuck = await FakeObs.start({ auth: V1 });
    const started = performance.now();
    const error = await rejectsWithCode(
      ObsClient.connect(
        clientOptions(stuck, {
          connectTimeoutMs: 150,
          password: () => readSecret('OBS_WEBSOCKET_PASSWORD', { run: slowSecurity(null), timeoutMs: 400 }),
        }),
      ),
      'E_SECRET_MISSING',
    );
    const elapsed = performance.now() - started;
    assert.equal(error.data?.['reason'], 'timeout');
    assert.equal(error.data?.['command'], D02_COMMAND);
    assert.ok(elapsed >= 390 && elapsed < 1500, `esperou o prazo do Chaveiro, não o do handshake (${elapsed} ms)`);
    assert.equal(stuck.identifies.length, 0);
  });

  test('versões fora do conjunto validado ou sem CreateRecordChapter → E_TOOLCHAIN_MISMATCH; com strictVersions false só relata', async () => {
    const newer = await FakeObs.start({ hello: { obsStudioVersion: '32.0.0', obsWebSocketVersion: '5.6.3' } });
    const mismatch = await rejectsWithCode(ObsClient.connect(clientOptions(newer)), 'E_TOOLCHAIN_MISMATCH');
    assert.deepEqual(mismatch.data?.['problems'], ['OBS 32.0.0 (validado: 31.1.2)', 'obs-websocket 5.6.3 (validado: 5.6.2)']);
    await newer.connection!.closed;

    const noChapters = await FakeObs.start({ availableRequests: AVAILABLE_REQUESTS.filter((r) => r !== 'CreateRecordChapter') });
    const missing = await rejectsWithCode(ObsClient.connect(clientOptions(noChapters)), 'E_TOOLCHAIN_MISMATCH');
    assert.deepEqual(missing.data?.['problems'], ['pedido CreateRecordChapter ausente']);

    const lenient = await FakeObs.start({ hello: { obsStudioVersion: '32.0.0' } });
    const client = await connect(lenient, { strictVersions: false });
    assert.deepEqual(client.versionProblems, ['OBS 32.0.0 (validado: 31.1.2)']);
    assert.equal(client.versions.obsStudioVersion, '32.0.0');
  });

  test('obsClientOptions: url, perfil, coleção e versões vêm da configuração; a senha é lida pelo nome só no handshake', async () => {
    const config = loadConfig({ configPath: join(tmpdir(), `contrarregra-sem-config-${randomBytes(4).toString('hex')}.json`) });
    const names: string[] = [];
    const options = obsClientOptions(config, {
      readPassword: async (name) => {
        names.push(name);
        return new Secret(V1.password);
      },
    });
    assert.equal(options.url, 'ws://127.0.0.1:4455');
    assert.equal(options.profile, 'Contrarregra');
    assert.equal(options.collection, 'Contrarregra');
    assert.deepEqual(options.expected, { obs: '31.1.2', obsWebsocket: '5.6.2' });
    assert.equal(typeof options.password, 'function');
    assert.deepEqual(names, [], 'montar as opções não lê o Chaveiro');
    const fake = await FakeObs.start({ auth: V1 });
    const client = await ObsClient.connect({ ...options, url: fake.url });
    clients.push(client);
    assert.deepEqual(names, ['OBS_WEBSOCKET_PASSWORD']);
  });
});

// ---------------------------------------------------------------------------------------------------
// Pedidos

describe('cliente obs-websocket: pedidos, prazos e fechamento (S9 item 2)', () => {
  test('prazo por pedido: 5 s por padrão e 10 s no StopRecord; sem resposta no prazo → E_OBS_UNREACHABLE e a conexão segue', async () => {
    assert.equal(REQUEST_TIMEOUT_MS, 5_000);
    assert.equal(STOP_RECORD_TIMEOUT_MS, 10_000);
    const hold = (): Promise<Reply> => new Promise<Reply>(() => {});
    const fake = await FakeObs.start({ handlers: { GetStats: hold, StopRecord: hold } });
    const client = await connect(fake, { requestTimeoutMs: 100, stopRecordTimeoutMs: 300 });
    const started = performance.now();
    let stopSettledAt = 0;
    const stop = client.stopRecord().then(
      () => assert.fail('StopRecord não devia resolver'),
      (error: unknown) => {
        stopSettledAt = performance.now() - started;
        return error;
      },
    );
    const stats = await rejectsWithCode(client.getStats(), 'E_OBS_UNREACHABLE');
    const statsAt = performance.now() - started;
    assert.equal(stats.data?.['reason'], 'timeout');
    assert.equal(stats.data?.['requestType'], 'GetStats');
    assert.ok(statsAt >= 90 && statsAt < 280, `GetStats expirou em ${statsAt} ms`);
    assert.equal(stopSettledAt, 0, 'o StopRecord tem prazo próprio, maior');
    const stopError = await stop;
    assert.ok(isContrarregraError(stopError, 'E_OBS_UNREACHABLE'));
    assert.equal(stopError.data?.['timeoutMs'], 300);
    assert.ok(stopSettledAt >= 290, `StopRecord expirou em ${stopSettledAt} ms`);
    assert.equal(client.isOpen, true);
    assert.equal((await client.getRecordStatus()).outputActive, false);
  });

  test('StopRecord tem o prazo de 10 s em qualquer caminho: stopRecord(), request("StopRecord") e lote com StopRecord (prazos 10× menores: 500/1000 ms; o OBS responde em 700 ms)', { timeout: 10_000 }, async () => {
    const slowStop: Handler = async () => {
      await sleep(700);
      return { data: { outputPath: STARTED.outputPath } };
    };
    const slowStats: Handler = async () => {
      await sleep(700);
      return { data: STATS };
    };
    const fake = await FakeObs.start({ handlers: { StopRecord: slowStop, GetStats: slowStats }, batchDelayMs: 700 });
    const client = await connect(fake, { requestTimeoutMs: 500, stopRecordTimeoutMs: 1000 });
    const [viaMethod, viaRequest, viaBatch] = await Promise.all([
      client.stopRecord(),
      client.request<{ outputPath: string }>('StopRecord'),
      client.batch([{ requestType: 'StopRecord' }]),
    ]);
    assert.equal(viaMethod.data.outputPath, STARTED.outputPath);
    assert.equal(viaRequest.data.outputPath, STARTED.outputPath);
    assert.deepEqual(viaBatch.results.map((r) => r.requestType), ['StopRecord']);
    // Controle: os outros pedidos e lotes seguem com o prazo comum.
    const [late, lateBatch] = await Promise.all([
      rejectsWithCode(client.getStats(), 'E_OBS_UNREACHABLE'),
      rejectsWithCode(client.batch([{ requestType: 'Sleep', requestData: { sleepMillis: 1 } }]), 'E_OBS_UNREACHABLE'),
    ]);
    assert.equal(late.data?.['timeoutMs'], 500);
    assert.equal(lateBatch.data?.['timeoutMs'], 500);
  });

  test('fechar a conexão rejeita todos os pendentes na hora; depois disso nenhum pedido vai ao fio', async () => {
    const hold = (): Promise<Reply> => new Promise<Reply>(() => {});
    const fake = await FakeObs.start({ handlers: { GetStats: hold, GetRecordStatus: hold } });
    const client = await connect(fake);
    const pending = [client.getStats(), client.getRecordStatus()].map((p) => rejectsWithCode(p, 'E_OBS_UNREACHABLE'));
    await waitFor(() => fake.requests.length === 3);
    const started = performance.now();
    await fake.connection!.close(4011, 'Kicked');
    const errors = await Promise.all(pending);
    assert.ok(performance.now() - started < 1000);
    assert.deepEqual(
      errors.map((e) => [e.data?.['requestType'], e.data?.['closeCode']]),
      [
        ['GetStats', 4011],
        ['GetRecordStatus', 4011],
      ],
    );
    assert.equal(client.isOpen, false);
    const before = fake.wire.length;
    await rejectsWithCode(client.getStats(), 'E_OBS_UNREACHABLE');
    assert.equal(fake.wire.length, before);

    // Queda sem quadro de fechamento (OBS morto): idem.
    const fake2 = await FakeObs.start({ handlers: { GetStats: hold } });
    const client2 = await connect(fake2);
    const lost = rejectsWithCode(client2.getStats(), 'E_OBS_UNREACHABLE');
    await waitFor(() => fake2.requests.length === 2);
    fake2.connection!.terminate();
    assert.equal((await lost).data?.['closeCode'], 1006);
  });

  test('OBS congelado (ignora o quadro de fechamento e mantém o TCP): close() rejeita os pendentes na hora e resolve no prazo de 1 s, derrubando o TCP', { timeout: 10_000 }, async () => {
    assert.equal(CLOSE_TIMEOUT_MS, 1_000);
    const frozen = await startFrozenObs({ answer: { GetVersion: VERSION_DATA } });
    const client = await ObsClient.connect({
      url: frozen.url,
      profile: 'Contrarregra',
      collection: 'Contrarregra',
      expected: { obs: '31.1.2', obsWebsocket: '5.6.2' },
    });
    clients.push(client);
    const pending = [client.stopRecord(), client.getStats()].map((p) => rejectsWithCode(p, 'E_OBS_UNREACHABLE'));
    await waitFor(() => frozen.requests.includes('StopRecord') && frozen.requests.includes('GetStats'));
    const started = performance.now();
    let closedAt = 0;
    const closing = client.close().then((info) => {
      closedAt = performance.now() - started;
      return info;
    });
    const errors = await Promise.all(pending);
    const rejectedAt = performance.now() - started;
    assert.ok(rejectedAt < 250, `pendentes rejeitados em ${rejectedAt} ms (o StopRecord não espera os 10 s dele)`);
    assert.deepEqual(
      errors.map((e) => [e.data?.['requestType'], e.data?.['reason']]),
      [
        ['StopRecord', 'closed'],
        ['GetStats', 'closed'],
      ],
    );
    assert.equal(client.isOpen, false);
    const sent = frozen.requests.length;
    await rejectsWithCode(client.getRecordStatus(), 'E_OBS_UNREACHABLE');
    assert.equal(frozen.requests.length, sent, 'nada vai ao fio depois do close()');
    const info = await closing;
    assert.ok(closedAt >= CLOSE_TIMEOUT_MS - 50 && closedAt < CLOSE_TIMEOUT_MS + 500, `close() resolveu em ${closedAt} ms`);
    assert.equal(info.code, 1006);
    assert.equal(frozen.closeFrames(), 1, 'o quadro de fechamento foi enviado antes de derrubar');
    await waitFor(() => frozen.socketsClosed() === 1, 1000);
  });

  test('OBS congelado no connect: GetVersion sem resposta → E_OBS_UNREACHABLE no prazo do pedido, sem esperar o fechamento; sem Hello → no prazo do handshake; o TCP cai depois', { timeout: 10_000 }, async () => {
    const options = { profile: 'Contrarregra', collection: 'Contrarregra', expected: { obs: '31.1.2', obsWebsocket: '5.6.2' } };
    const frozen = await startFrozenObs();
    let started = performance.now();
    const error = await rejectsWithCode(ObsClient.connect({ ...options, url: frozen.url, requestTimeoutMs: 200 }), 'E_OBS_UNREACHABLE');
    let elapsed = performance.now() - started;
    assert.equal(error.data?.['requestType'], 'GetVersion');
    assert.equal(error.data?.['reason'], 'timeout');
    assert.ok(elapsed >= 190 && elapsed < 450, `connect rejeitou em ${elapsed} ms`);
    await waitFor(() => frozen.socketsClosed() === 1, CLOSE_TIMEOUT_MS + 1000);

    const mute = await startFrozenObs({ hello: false });
    started = performance.now();
    const silent = await rejectsWithCode(ObsClient.connect({ ...options, url: mute.url, connectTimeoutMs: 150 }), 'E_OBS_UNREACHABLE');
    elapsed = performance.now() - started;
    assert.equal(silent.data?.['timeoutMs'], 150);
    assert.ok(elapsed < 450, `connect rejeitou em ${elapsed} ms`);
    await waitFor(() => mute.socketsClosed() === 1, CLOSE_TIMEOUT_MS + 1000);
  });

  test('respostas fora de ordem (o OBS atende em paralelo) vão para o pedido certo pelo requestId', async () => {
    let releaseStats!: () => void;
    const statsGate = new Promise<void>((resolve) => {
      releaseStats = resolve;
    });
    const fake = await FakeObs.start({
      handlers: {
        GetStats: async () => {
          await statsGate;
          return { data: STATS };
        },
        GetRecordStatus: (_d, f) => {
          setTimeout(releaseStats, 20);
          return DEFAULT_HANDLERS['GetRecordStatus']!(undefined, f);
        },
      },
    });
    const client = await connect(fake);
    const [stats, record] = await Promise.all([client.getStats(), client.getRecordStatus()]);
    assert.deepEqual(stats, STATS);
    assert.equal(record.outputActive, false);
    assert.ok(fake.trace.indexOf('send:GetRecordStatus') < fake.trace.indexOf('send:GetStats'), fake.trace.join(' '));
  });

  test('pedidos da T-0.12 no perfil certo: GetVersion, GetRecordStatus, StartRecord (STARTED antes da resposta), CreateRecordChapter UTF-8, GetStats, GetOutputStatus, GetInputPropertiesListPropertyItems, StopRecord', async () => {
    const fake = await FakeObs.start({ auth: V1 });
    const client = await connect(fake);
    assert.equal((await client.getVersion()).obsVersion, '31.1.2');
    assert.deepEqual(await client.getRecordStatus(), {
      outputActive: false,
      outputPaused: false,
      outputTimecode: '00:00:00.000',
      outputDuration: 0,
      outputBytes: 0,
    });
    await assert.rejects(client.createRecordChapter('antes de gravar'), (e: unknown) => e instanceof ObsRequestError && e.code === 501);

    const events: ObsEvent[] = [];
    client.onEvent((e) => events.push(e));
    const start = await client.startRecord();
    assert.equal(events.length, 1, 'o STARTED chegou antes da resposta do StartRecord');
    assert.equal(events[0]!.eventType, 'RecordStateChanged');
    assert.deepEqual(events[0]!.eventData, STARTED);
    assert.equal(typeof events[0]!.tRecvNs, 'bigint');
    assert.ok(events[0]!.tRecvNs <= start.tRecvNs && start.tSendNs <= start.tRecvNs);

    const title = 'Cena 9 — Modo avião';
    await client.createRecordChapter(title);
    const chapter = fake.requests.find((r) => r.requestType === 'CreateRecordChapter' && r.requestData?.['chapterName'] === title);
    assert.ok(chapter, 'o título UTF-8 chega idêntico');
    assert.ok(fake.wire.some((w) => w.includes(title)));

    assert.deepEqual(await client.getStats(), STATS);
    const output = await client.getOutputStatus();
    assert.deepEqual(output.data, OUTPUT_STATUS);
    assert.deepEqual(fake.requests.findLast((r) => r.requestType === 'GetOutputStatus')?.requestData, { outputName: 'adv_file_output' });
    assert.deepEqual(await client.getInputPropertiesListPropertyItems('iPhone', 'device'), DEVICE_ITEMS);
    assert.deepEqual(fake.requests.findLast((r) => r.requestType === 'GetInputPropertiesListPropertyItems')?.requestData, {
      inputName: 'iPhone',
      propertyName: 'device',
    });
    assert.equal((await client.stopRecord()).data.outputPath, STARTED.outputPath);
    assert.deepEqual(fake.writes(), ['CreateRecordChapter', 'StartRecord', 'CreateRecordChapter', 'StopRecord']);
  });

  test('E-9.4: CreateRecordChapter recusado com 702 chega como ObsRequestError com código e comentário', async () => {
    const comment = 'Verify that the output being used supports chapter markers.';
    const fake = await FakeObs.start({ handlers: { CreateRecordChapter: () => ({ code: 702, comment }) } });
    const client = await connect(fake);
    await assert.rejects(client.createRecordChapter('Cena 1'), (e: unknown) => {
      assert.ok(e instanceof ObsRequestError);
      assert.equal(e.code, 702);
      assert.equal(e.comment, comment);
      assert.equal(e.requestType, 'CreateRecordChapter');
      return true;
    });
    assert.equal(client.isOpen, true);
  });

  test('lote SerialFrame das marcas: op 8 com executionType 1, os pedidos na ordem e hrtime de envio e de chegada', async () => {
    const fake = await FakeObs.start();
    const client = await connect(fake);
    const requests = [
      { requestType: 'SetSceneItemEnabled', requestData: { sceneName: 'Contrarregra', sceneItemId: 2, sceneItemEnabled: true } },
      { requestType: 'Sleep', requestData: { sleepFrames: 2 } },
      { requestType: 'SetSceneItemEnabled', requestData: { sceneName: 'Contrarregra', sceneItemId: 2, sceneItemEnabled: false } },
    ];
    const response = await client.serialFrameBatch(requests, { haltOnFailure: true });
    assert.equal(fake.batches.length, 1);
    const { requestId, ...sent } = fake.batches[0]!;
    assert.equal(typeof requestId, 'string');
    assert.deepEqual(sent, { haltOnFailure: true, executionType: OBS_BATCH_EXECUTION.SerialFrame, requests });
    assert.deepEqual(
      response.results.map((r) => [r.requestType, r.requestStatus.code]),
      [
        ['SetSceneItemEnabled', 100],
        ['Sleep', 100],
        ['SetSceneItemEnabled', 100],
      ],
    );
    assert.ok(response.tSendNs <= response.tRecvNs);
    const batchAt = fake.trace.indexOf('recv:batch');
    assert.ok(fake.trace.slice(0, batchAt).includes('send:GetProfileList'), 'a guarda roda antes do lote');
  });
});

// ---------------------------------------------------------------------------------------------------
// Guarda do perfil

describe('guarda do perfil (S9 item 2, P-6; AC-9.9 parcial com o OBS falso)', () => {
  test('AC-9.9: no perfil "Untitled", StartRecord, capítulo, lote SerialFrame e toda escrita da lista → E_OBS_CONFIG e nada é escrito', async () => {
    const fake = await FakeObs.start({ auth: V1, profile: 'Untitled', collection: 'Untitled' });
    const client = await connect(fake);
    const attempts: [string, () => Promise<unknown>][] = [
      ['StartRecord', () => client.startRecord()],
      ['CreateRecordChapter', () => client.createRecordChapter('Cena 1')],
      [
        'SerialFrame',
        () => client.serialFrameBatch([{ requestType: 'SetSceneItemEnabled', requestData: { sceneName: 'Contrarregra', sceneItemId: 2, sceneItemEnabled: true } }]),
      ],
      ['SetRecordDirectory', () => client.request('SetRecordDirectory', { recordDirectory: '/tmp/contrarregra-falso' })],
      ['SetInputSettings', () => client.request('SetInputSettings', { inputName: 'iPhone', inputSettings: { device: 'x' } })],
      [
        'SetProfileParameter',
        () => client.request('SetProfileParameter', { parameterCategory: 'AdvOut', parameterName: 'RecFormat2', parameterValue: 'hybrid_mp4' }),
      ],
      ['SetVideoSettings', () => client.request('SetVideoSettings', { baseWidth: 1170, baseHeight: 2532 })],
      ['CreateInput', () => client.request('CreateInput', { sceneName: 'Contrarregra', inputName: 'x', inputKind: 'color_source_v3' })],
      ['batch SetSceneItemEnabled', () => client.batch([{ requestType: 'SetSceneItemEnabled', requestData: { sceneItemId: 2 } }])],
    ];
    for (const [label, attempt] of attempts) {
      const error = await rejectsWithCode(attempt(), 'E_OBS_CONFIG');
      assert.deepEqual(error.data?.['actual'], { profile: 'Untitled', collection: 'Untitled' }, label);
      assert.deepEqual(error.data?.['expected'], { profile: 'Contrarregra', collection: 'Contrarregra' }, label);
      assert.match(error.message, /Feche o OBS/, label);
    }
    assert.deepEqual(fake.writes(), [], 'nenhuma escrita chegou ao OBS');
    assert.equal(fake.batches.length, 0);
    assert.deepEqual(new Set(fake.requests.map((r) => r.requestType)), new Set(['GetVersion', 'GetProfileList', 'GetSceneCollectionList']));
    assert.equal(client.isOpen, true);
  });

  test('perfil certo com a coleção errada também é E_OBS_CONFIG sem escrita', async () => {
    const fake = await FakeObs.start({ profile: 'Contrarregra', collection: 'Untitled' });
    const client = await connect(fake);
    const error = await rejectsWithCode(client.startRecord(), 'E_OBS_CONFIG');
    assert.deepEqual(error.data?.['actual'], { profile: 'Contrarregra', collection: 'Untitled' });
    assert.deepEqual(fake.writes(), []);
  });

  test('a escrita só sai depois das duas respostas da guarda, e a guarda roda a cada escrita (sem cache)', async () => {
    const fake = await FakeObs.start({
      handlers: {
        GetProfileList: async (_d, f) => {
          await sleep(50);
          return DEFAULT_HANDLERS['GetProfileList']!(undefined, f);
        },
      },
    });
    const client = await connect(fake);
    await client.startRecord();
    const writeAt = fake.trace.indexOf('recv:StartRecord');
    const before = fake.trace.slice(0, writeAt);
    assert.ok(before.includes('send:GetProfileList') && before.includes('send:GetSceneCollectionList'), fake.trace.join(' '));

    fake.profile = 'Untitled'; // o dono trocou de perfil no meio
    await rejectsWithCode(client.createRecordChapter('Cena 2'), 'E_OBS_CONFIG');
    assert.deepEqual(fake.writes(), ['StartRecord']);
    assert.equal(fake.requests.filter((r) => r.requestType === 'GetProfileList').length, 2);
  });

  test('leituras e StopRecord não passam pela guarda; o resto que não é Get* passa', async () => {
    const fake = await FakeObs.start({ profile: 'Untitled', collection: 'Untitled' });
    const client = await connect(fake);
    fake.recording = true;
    await client.getStats();
    await client.getRecordStatus();
    await client.getOutputStatus();
    await client.stopRecord();
    assert.equal(fake.requests.filter((r) => r.requestType === 'GetProfileList').length, 0);
    for (const write of ['StartRecord', 'CreateRecordChapter', 'SetSceneItemEnabled', 'SetRecordDirectory', 'SetInputSettings', 'SetProfileParameter', 'SetVideoSettings', 'CreateInput']) {
      assert.equal(isWriteRequest(write), true, write);
    }
    for (const read of ['GetStats', 'GetRecordStatus', 'GetVersion', 'GetOutputStatus', 'StopRecord', 'Sleep']) {
      assert.equal(isWriteRequest(read), false, read);
    }
  });
});

// ---------------------------------------------------------------------------------------------------
// AC-8.5

describe('AC-8.5 (parte do segredo): busca literal da senha', () => {
  test('Chaveiro falso → handshake → pedidos → guarda recusando → senha errada → item ausente: a senha inventada aparece 0 vezes em logs, console, erros, inspeção, argv e no fio', async () => {
    const logs: string[] = [];
    const log = (line: string): void => {
      logs.push(line);
    };
    const keychain = fakeSecurity({ stdout: `${V1.password}\n` });
    const wrongKeychain = fakeSecurity({ stdout: `${WRONG_PASSWORD}\n` });
    const missingKeychain = fakeSecurity({ exitCode: 44 });
    const errors: unknown[] = [];
    const fake = await FakeObs.start({ auth: V1 });
    const wrong = await FakeObs.start({ auth: V1 });
    const missing = await FakeObs.start({ auth: V1 });
    let client: ObsClient | undefined;

    const { lines } = await captureConsole(async () => {
      client = await ObsClient.connect(clientOptions(fake, { password: () => readSecret('OBS_WEBSOCKET_PASSWORD', { run: keychain.run }), log }));
      clients.push(client);
      console.log(client);
      await client.getStats();
      await client.startRecord();
      await client.createRecordChapter('Cena 1 — Início');
      await client.serialFrameBatch([{ requestType: 'Sleep', requestData: { sleepFrames: 1 } }]);
      await client.stopRecord();
      fake.profile = 'Untitled';
      await client.startRecord().catch((e: unknown) => errors.push(e));
      await ObsClient.connect(clientOptions(wrong, { password: () => readSecret('OBS_WEBSOCKET_PASSWORD', { run: wrongKeychain.run }), log })).catch(
        (e: unknown) => errors.push(e),
      );
      await ObsClient.connect(clientOptions(missing, { password: () => readSecret('OBS_WEBSOCKET_PASSWORD', { run: missingKeychain.run }), log })).catch(
        (e: unknown) => errors.push(e),
      );
      await client.close();
      await client.getStats().catch((e: unknown) => errors.push(e));
    });

    assert.deepEqual(
      errors.map((e) => (isContrarregraError(e) ? e.code : String(e))),
      ['E_OBS_CONFIG', 'E_OBS_AUTH', 'E_SECRET_MISSING', 'E_OBS_UNREACHABLE'],
    );
    assert.ok(logs.length >= 6, `o log foi exercitado (${logs.length} linhas)`);
    const haystack = [
      ...logs,
      ...lines,
      ...errors.map(dumpError),
      inspect(client, { showHidden: true, depth: Infinity }),
      JSON.stringify(client),
      JSON.stringify([...keychain.calls, ...wrongKeychain.calls, ...missingKeychain.calls]),
      ...fake.wire,
      ...wrong.wire,
      ...missing.wire,
    ].join('\n');
    assert.equal(occurrences(haystack, V1.password), 0, 'a senha certa não pode aparecer');
    assert.equal(occurrences(haystack, WRONG_PASSWORD), 0, 'nem a errada');
    // No fio vai só o hash (uma vez, no Identify); no log, nem ele.
    assert.equal(occurrences(fake.wire.join('\n'), V1.authentication), 1);
    assert.equal(occurrences([...logs, ...lines].join('\n'), V1.authentication), 0);
  });
});
