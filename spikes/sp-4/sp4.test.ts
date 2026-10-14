// Testes do driver do SP-4 (T-0.19) sem aparelho: `node --test spikes/sp-4/sp4.test.ts`. O "aparelho" é o usbmuxd
// falso de `mac/test/helpers/usbmuxd.ts` com um túnel até um runner falso sobre `mac/test/helpers/ws-server.ts`, que
// responde como o runner: `session.hello` com token e um controlador; `clock.ping` com o relógio "do aparelho" = o do
// Mac + um deslocamento conhecido e o `pad` ecoado só no tamanho; `health` com a fila do XCTest; `device.state`
// (deixa a fila cheia, como no SP-2); `device.controlCenter`, `ui.find`/`ui.tap` só no interruptor
// `airplane-mode-button` com a Central aberta; `app.activate`; `screen.shot` só com o Hagah à frente. O caminho medido
// é o de verdade: `findUsbDevice` → repassador → `Connect` → WebSocket.

import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { after, before, describe, it } from 'node:test';

import type { Config } from '../../mac/src/core/config.ts';
import { Secret } from '../../mac/src/core/secret.ts';
import { RunnerLink, severLocalLinks } from '../../mac/src/runner/link.ts';
import type { SessionState } from '../../mac/src/runner/session.ts';
import { htons } from '../../mac/src/usbmux/protocol.ts';
import { shortTempDir, startFakeUsbmuxd, type FakeEntry, type FakeUsbmuxd } from '../../mac/test/helpers/usbmuxd.ts';
import { startWsServer, type WsTestConnection, type WsTestServer } from '../../mac/test/helpers/ws-server.ts';
import { openChannel, probeReach, rawConnect, readyLine, usbmuxSnapshot } from './channel.ts';
import {
  analyzeNtp,
  C2,
  PHASES,
  transitOverlaps,
  compare,
  DEFAULT_OPTIONS,
  markdownTable,
  measureBursts,
  measureEcho,
  measureOpens,
  PAD_LARGE,
  PAD_SMALL,
  percentile,
  pingWireBytes,
  PLAN_B,
  probeSpike,
  runSpike,
  sessionProblem,
  stats,
  hotspotActive,
  signalExit,
  StopError,
  TEXT,
  summarize,
  type DriverEnv,
  type Io,
  type Json,
  type RunOptions,
} from './lib.ts';

const UDID = '00008101-001E79203A68001E';
const PORT = 8700;
const HAGAH = 'app.kifactory.hagah';
const TOKEN = 'token-de-teste-do-sp4';
/** Relógio "do aparelho" = o do Mac + isto (θ que a rajada tem de achar). */
const OFFSET_NS = 5_123_456_789n;
const HELLO = (JSON.parse(readFileSync(new URL('../../mac/test/fixtures/protocol/RpcResponse.session.hello.json', import.meta.url), 'utf8')) as { result: unknown }).result;
const USB: FakeEntry = { deviceId: 7, connectionType: 'USB', serial: UDID };
const NETWORK: FakeEntry = { deviceId: 9, connectionType: 'Network', serial: UDID };

const SESSION: SessionState = {
  schema: 'contrarregra.session/1',
  sessionId: '20261014-120000-abcdef',
  udid: UDID,
  port: PORT,
  configuration: 'Spike',
  spike: true,
  bind: 'loopback',
  xctestrun: '/nao/existe.xctestrun',
  log: '/nao/existe.log',
  xcodebuildPid: 1,
  startedAt: '2026-10-14T12:00:00.000Z',
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// ── Runner falso ───────────────────────────────────────────────────────────────────────────────────────────

interface FakeRunner {
  server: WsTestServer;
  fg: string;
  locked: boolean;
  /** O modo avião (o `value` do interruptor); a rede é `offline` com ele ligado. */
  airplane: boolean;
  /** A rede: `follow` = acompanha o avião; `online`/`offline` = presa (não acompanha). */
  net: 'follow' | 'online' | 'offline';
  /** A Central de Controle aberta. */
  cc: boolean;
  /** Um alerta do sistema cobrindo a tela: `app.activate` e a Central recusam (E_FORBIDDEN_APP). */
  alert: boolean;
  /** Runner caído: derruba toda conexão em vez de responder. */
  dead: boolean;
  /** Cai logo depois de um `wait.for {network: offline}` que valeu (o avião fica ligado). */
  dieWhenOffline: boolean;
  /** Duração do trabalho de cada método da fila do XCTest, em ms (padrão 2; `screen.shot` 3). */
  workMs: Record<string, number>;
  /** Antes do próximo pedido deste método, a fila fica ocupada por tantos ms (força o `E_TIMEOUT` "na fila"). */
  blockBeforeNext: Record<string, number>;
  /** Comandos na fila do XCTest (na fila ou rodando): o `xctestQueueDepth` do `health`. */
  depth: number;
  /** Toques que de fato trocaram o interruptor. */
  taps: number;
  /** Ocupa a fila do XCTest por `ms` (um `screen.shot` atrasado, por exemplo). */
  occupy(ms: number): void;
  /** Ecoa o `pad` com um byte a menos (eco errado). */
  badPad: boolean;
  hellos: string[];
  calls: Map<string, number>;
}

const forbidden = -32003;
/** Milissegundos de teste por segundo do runner: os prazos de `RpcRouter.swift` (10 s; `screen.shot` 3 s; `wait.for` = `timeoutMs` + 1 s) em escala. */
const MS_PER_RUNNER_S = 20;
/** A folga do prazo do `wait.for` sobre o `timeoutMs` (no runner, 1 s sobre prazos de 60–90 s). */
const WAIT_SLACK_MS = 100;
const LANE_METHODS = new Set(['device.state', 'device.controlCenter', 'ui.find', 'ui.tap', 'app.activate', 'wait.for', 'screen.shot']);

function laneDeadlineMs(method: string, params: Record<string, unknown> | undefined): number {
  if (method === 'screen.shot') return 3 * MS_PER_RUNNER_S;
  if (method === 'wait.for') return Number(params?.['timeoutMs'] ?? 0) + WAIT_SLACK_MS;
  return 10 * MS_PER_RUNNER_S;
}

type Reply = { result: unknown } | { error: { code: number; message: string; data?: unknown } };

async function startFakeRunner(): Promise<FakeRunner> {
  const started = process.hrtime.bigint();
  const roles = new Map<WsTestConnection, string>();
  const live = new Set<WsTestConnection>();
  let control: WsTestConnection | null = null;
  const image = Buffer.alloc(20_000, 7).toString('base64');
  // A fila serial do XCTest, como `XCTestLane.swift`: o prazo responde `E_TIMEOUT` com `phase` (`queued` = nunca roda;
  // `running` = termina e o efeito acontece, a resposta se perde); comando de conexão fechada não roda.
  const lane: (() => Promise<void>)[] = [];
  let pumping = false;
  const pump = async (): Promise<void> => {
    if (pumping) return;
    pumping = true;
    while (lane.length > 0) await lane.shift()!();
    pumping = false;
  };
  const submit = (conn: WsTestConnection | null, method: string, deadlineMs: number, work: () => Promise<Reply>, reply: (r: Reply) => void): void => {
    const job = { phase: 'queued' as 'queued' | 'running' | 'done', replied: false };
    fake.depth++;
    const timer = setTimeout(() => {
      if (job.replied || job.phase === 'done') return;
      job.replied = true;
      const where = job.phase === 'queued' ? 'ainda na fila do XCTest' : 'rodando na fila do XCTest';
      reply({ error: { code: -32020, message: `E_TIMEOUT: ${method} passou do prazo (${where})`, data: { method, deadlineMs, phase: job.phase } } });
    }, deadlineMs);
    lane.push(async () => {
      if (job.replied || (conn !== null && !live.has(conn))) {
        job.phase = 'done';
        clearTimeout(timer);
        fake.depth--;
        return;
      }
      job.phase = 'running';
      const out = await work();
      job.phase = 'done';
      clearTimeout(timer);
      fake.depth--;
      if (!job.replied) {
        job.replied = true;
        reply(out);
      }
    });
    void pump();
  };
  const fake: FakeRunner = {
    server: undefined as unknown as WsTestServer,
    fg: 'com.apple.springboard',
    locked: false,
    airplane: false,
    net: 'follow',
    cc: false,
    alert: false,
    dead: false,
    dieWhenOffline: false,
    workMs: {},
    blockBeforeNext: {},
    depth: 0,
    taps: 0,
    occupy: (ms) => submit(null, 'occupy', 10 * MS_PER_RUNNER_S + ms, () => sleep(ms).then(() => ({ result: {} })), () => {}),
    badPad: false,
    hellos: [],
    calls: new Map(),
  };
  const send = (conn: WsTestConnection, message: unknown): void => {
    try {
      conn.sendJson(message);
    } catch {
      // fechando
    }
  };
  const fail = (conn: WsTestConnection, id: unknown, code: number, message: string): void => send(conn, { jsonrpc: '2.0', id, error: { code, message } });
  const action = { tDevStartNs: '1', tDispatchNs: '2', tDevEndNs: '3', path: 'public' };
  const isAirplaneSwitch = (target: unknown): boolean => {
    const t = target as Record<string, unknown> | undefined;
    return t?.['app'] === 'springboard' && t['identifier'] === 'airplane-mode-button';
  };
  const refused = (message: string): Reply => ({ error: { code: forbidden, message: `E_FORBIDDEN_APP: ${message}` } });
  const network = (): 'online' | 'offline' => (fake.net !== 'follow' ? fake.net : fake.airplane ? 'offline' : 'online');
  /** O trabalho de cada método da fila: o efeito acontece no fim do trabalho (mesmo que a resposta já tenha estourado o prazo). */
  const laneWork = (method: string, params: Record<string, unknown> | undefined): (() => Promise<Reply>) => {
    const ms = fake.workMs[method] ?? (method === 'screen.shot' ? 3 : 2);
    const after = (fn: () => Reply) => async (): Promise<Reply> => {
      await sleep(ms);
      return fn();
    };
    switch (method) {
      case 'device.state':
        return after(() => ({ result: { locked: fake.locked, network: network(), foregroundApp: fake.fg, language: 'en', screenPt: { w: 390, h: 844 }, textSize: 'large', appearance: 'light' } }));
      case 'device.controlCenter':
        return after(() => {
          if (params?.['action'] === 'open') {
            if (fake.locked || fake.alert) return refused('a Central só se abre sobre a tela de início ou um app operável');
            fake.cc = true;
          } else {
            if (!fake.cc && (fake.locked || fake.alert)) return refused('nada a fechar');
            // Fechar é press(.home): aqui vai para a tela de início (o caso em que o driver tem de reativar o Hagah).
            if (fake.cc) fake.fg = 'com.apple.springboard';
            fake.cc = false;
          }
          return { result: action };
        });
      case 'ui.find':
        return after(() => {
          if (!isAirplaneSwitch(params?.['target'])) return refused('só o interruptor do modo avião neste falso');
          return { result: { candidates: fake.cc ? [{ frame: { x: 30, y: 60, w: 60, h: 60 }, visible: true, hittable: true, value: fake.airplane ? '1' : '0' }] : [] } };
        });
      case 'ui.tap':
        return after(() => {
          if (!isAirplaneSwitch(params?.['target']) || !fake.cc) return refused('no SpringBoard só o interruptor do modo avião, com a Central aberta');
          fake.airplane = !fake.airplane;
          fake.taps++;
          return { result: { point: { x: 60, y: 90 }, ...action } };
        });
      case 'app.activate':
        return after(() => {
          if (fake.locked || fake.alert || fake.cc) return refused('app.activate só com app operável ou a tela de início à frente');
          fake.fg = String(params?.['bundleId']);
          return { result: action };
        });
      case 'screen.shot':
        return after(() => {
          if (fake.fg !== HAGAH || fake.locked || fake.cc) return refused('captura só com o app alvo à frente');
          return { result: { image, format: 'jpeg', widthPx: 390, heightPx: 844, scale: 1 } };
        });
      default: {
        // wait.for {condition: {airplane|network}, timeoutMs}: sonda até valer ou o prazo (`ConditionEvaluator.swift`).
        const condition = (params?.['condition'] ?? {}) as Record<string, string>;
        const timeoutMs = Number(params?.['timeoutMs'] ?? 0);
        const evaluate = (): { holds: boolean; reason: string } => {
          if (condition['airplane'] !== undefined) {
            if (!fake.cc) return { holds: false, reason: 'airplane só se avalia com a Central de Controle aberta' };
            const state = fake.airplane ? 'on' : 'off';
            return { holds: state === condition['airplane'], reason: `o modo avião está ${state}` };
          }
          return { holds: network() === condition['network'], reason: `a rede está ${network()}` };
        };
        return async (): Promise<Reply> => {
          const deadline = Date.now() + timeoutMs;
          for (let polls = 1; ; polls++) {
            const truth = evaluate();
            if (truth.holds) {
              if (fake.dieWhenOffline && condition['network'] === 'offline') fake.dead = true;
              return { result: { tDevStartNs: '1', tDevEndNs: '2' } };
            }
            if (Date.now() >= deadline) {
              return { error: { code: -32020, message: `E_TIMEOUT: a condição não ficou verdadeira em ${timeoutMs} ms (${polls} sondagens; a última: ${truth.reason})` } };
            }
            await sleep(5);
          }
        };
      }
    }
  };
  const handle = (conn: WsTestConnection, text: string): void => {
    const t2 = process.hrtime.bigint() + OFFSET_NS;
    if (fake.dead) return conn.terminate();
    const { id, method, params } = JSON.parse(text) as { id: unknown; method: string; params?: Record<string, unknown> };
    fake.calls.set(method, (fake.calls.get(method) ?? 0) + 1);
    const role = roles.get(conn);
    const ok = (result: unknown): void => send(conn, { jsonrpc: '2.0', id, result });
    if (method === 'session.hello') {
      if (params?.['token'] !== TOKEN) return fail(conn, id, -32001, 'E_AUTH: token errado');
      const asked = String(params?.['role']);
      if (asked === 'control') {
        if (control !== null && control !== conn) return fail(conn, id, -32002, 'E_BUSY: já há um controlador');
        control = conn;
      }
      roles.set(conn, asked);
      fake.hellos.push(asked);
      return ok(HELLO);
    }
    if (role === undefined) return fail(conn, id, -32001, 'E_AUTH: sem session.hello');
    if (role === 'sync' && method !== 'clock.ping') return fail(conn, id, -32001, 'E_AUTH: a sync só leva clock.ping');
    if (LANE_METHODS.has(method)) {
      const block = fake.blockBeforeNext[method];
      if (block !== undefined) {
        delete fake.blockBeforeNext[method];
        fake.occupy(block);
      }
      submit(conn, method, laneDeadlineMs(method, params), laneWork(method, params), (r) =>
        'result' in r ? ok(r.result) : send(conn, { jsonrpc: '2.0', id, error: r.error }),
      );
      return;
    }
    switch (method) {
      case 'clock.ping': {
        const pad = params?.['pad'];
        const size = typeof pad === 'string' ? Buffer.byteLength(pad) - (fake.badPad ? 1 : 0) : 0;
        return ok({ seq: params?.['seq'], t2RawNs: String(t2), t3RawNs: String(process.hrtime.bigint() + OFFSET_NS), t2UptimeNs: String(t2), ...(typeof pad === 'string' ? { pad: '.'.repeat(size) } : {}) });
      }
      case 'health':
        return ok({ ok: true, uptimeS: Number(process.hrtime.bigint() - started) / 1e9, xctestQueueDepth: fake.depth, treeVersion: 1, foregroundApp: fake.cc ? 'com.apple.springboard' : fake.fg, locked: fake.locked });
      default:
        return fail(conn, id, -32601, `método inexistente: ${method}`);
    }
  };
  fake.server = await startWsServer({
    onConnection: (conn) => {
      live.add(conn);
      void conn.closed.then(() => {
        live.delete(conn);
        if (control === conn) control = null;
        roles.delete(conn);
      });
      conn.onMessage((text) => handle(conn, text));
    },
  });
  return fake;
}

// ── Ambiente ───────────────────────────────────────────────────────────────────────────────────────────────

let dir: string;
let runner: FakeRunner;
let usbmuxd: FakeUsbmuxd;
let target: { socketPath: string; udid: string; port: number };
const token = new Secret(TOKEN);

before(async () => {
  dir = shortTempDir('crr-sp4-');
  runner = await startFakeRunner();
  usbmuxd = await startFakeUsbmuxd(dir, { devices: [NETWORK, USB], devicePorts: { [PORT]: runner.server.port } });
  target = { socketPath: usbmuxd.socketPath, udid: UDID, port: PORT };
});

after(async () => {
  await usbmuxd.close();
  await runner.server.close();
  rmSync(dir, { recursive: true, force: true });
});

function memoryIo(): Io & { rows: Json[] } {
  const rows: Json[] = [];
  return {
    rows,
    hr: () => process.hrtime.bigint(),
    sleep,
    write: (k, data) => void rows.push({ k, ...data }),
  };
}

const open = (role: 'control' | 'sync') => openChannel({ ...target, role, token, session: SESSION });

// ── Testes ─────────────────────────────────────────────────────────────────────────────────────────────────

describe('estatística', () => {
  it('percentil pelo posto mais próximo', () => {
    const values = Array.from({ length: 100 }, (_, i) => i + 1);
    assert.equal(percentile(values, 50), 50);
    assert.equal(percentile(values, 95), 95);
    assert.equal(percentile(values, 99), 99);
    assert.equal(percentile([7], 99), 7);
    const thousand = Array.from({ length: 1000 }, (_, i) => i + 1);
    assert.equal(percentile(thousand, 50), 500);
    assert.equal(percentile(thousand, 99), 990);
  });

  it('stats ordena, conta erros e devolve null sem amostras', () => {
    const s = stats([3, 1, 2, 10], 2);
    assert.deepEqual({ n: s?.n, errors: s?.errors, min: s?.min, p50: s?.p50, max: s?.max, mean: s?.mean }, { n: 4, errors: 2, min: 1, p50: 2, max: 10, mean: 4 });
    assert.equal(stats([]), null);
  });

  it('tamanho no fio de um eco de 64 B e de 64 KB', () => {
    const small = pingWireBytes(PAD_SMALL);
    const large = pingWireBytes(PAD_LARGE);
    assert.ok(small.request > PAD_SMALL && small.request < PAD_SMALL + 120, `pedido ${small.request} B`);
    assert.ok(large.request > PAD_LARGE && large.response > PAD_LARGE);
  });
});

describe('canal pelo usbmuxd (o caminho de verdade, com o usbmuxd falso)', () => {
  it('openChannel: ListDevices, repassador, Connect na porta do runner, hello; etapas cronometradas', async () => {
    const lists = usbmuxd.messages('ListDevices').length;
    const connects = usbmuxd.messages('Connect').length;
    const channel = await open('sync');
    try {
      for (const key of ['list', 'fwd', 'ws', 'hello'] as const) assert.ok(channel.phases[key] >= 0, key);
      assert.equal(channel.hello.device.model, 'iPhone13,2');
      const ping = await channel.call<{ seq: number }>('clock.ping', { seq: 41 });
      assert.equal(ping.seq, 41);
    } finally {
      await channel.close();
    }
    assert.equal(usbmuxd.messages('ListDevices').length - lists, 2, 'um do openChannel (E-2.1) e um do repassador');
    const connect = usbmuxd.messages('Connect').slice(connects);
    assert.equal(connect.length, 1);
    assert.equal(connect[0]?.fields['DeviceID'], USB.deviceId, 'a entrada USB, não a Network');
    assert.equal(connect[0]?.fields['PortNumber'], htons(PORT));
  });

  it('retrato do ListDevices: SerialNumber cru com hífen e a escolha da entrada USB', async () => {
    const snap = await usbmuxSnapshot(target);
    assert.deepEqual(snap.entries.map((e) => e.connectionType).sort(), ['Network', 'USB']);
    assert.equal(snap.usb?.serialRaw, UDID);
    assert.equal(snap.usb?.hyphenated, true);
    assert.equal(snap.usb?.matchesUdid, true);
    assert.equal(snap.usb?.normalized, UDID.replace(/-/g, ''));
  });

  it('só pela rede: sem entrada USB, com o E_NO_USB registrado', async () => {
    const d = shortTempDir('crr-sp4n-');
    const net = await startFakeUsbmuxd(d, { devices: [NETWORK] });
    try {
      const snap = await usbmuxSnapshot({ socketPath: net.socketPath, udid: UDID });
      assert.equal(snap.usb, null);
      assert.match(snap.error ?? '', /E_NO_USB/);
    } finally {
      await net.close();
      rmSync(d, { recursive: true, force: true });
    }
  });

  it('sonda de alcance: Result 0 = alcançável; recusado com READY = inalcançável (plano B); sem READY = não pronto', async () => {
    assert.equal((await probeReach({ ...target, attempts: 3, retryMs: 5, ready: true, sleep })).verdict, 'reachable');
    const d = shortTempDir('crr-sp4r-');
    const refusing = await startFakeUsbmuxd(d, { devices: [USB], devicePorts: {} });
    try {
      const t = { socketPath: refusing.socketPath, udid: UDID, port: PORT };
      const down = await probeReach({ ...t, attempts: 3, retryMs: 5, ready: true, sleep });
      assert.equal(down.verdict, 'unreachable');
      assert.equal(down.attempts.length, 3);
      assert.match(down.attempts[0]?.err ?? '', /^E_RUNNER_DOWN/);
      assert.equal((await probeReach({ ...t, attempts: 2, retryMs: 5, ready: false, sleep })).verdict, 'not-ready');
    } finally {
      await refusing.close();
      rmSync(d, { recursive: true, force: true });
    }
  });

  it('Connect cru: ListDevices + Connect, sem WebSocket', async () => {
    const r = await rawConnect(target);
    assert.ok(r.list >= 0 && r.connect >= 0);
  });

  it('linha CONTRARREGRA_READY do registro do xcodebuild (a última vale)', () => {
    const log = 'x\nCONTRARREGRA INFO a\nCONTRARREGRA_READY port=8700 bind=loopback\n…\nCONTRARREGRA_READY port=8701 bind=endpoint\n';
    assert.deepEqual(readyLine(log), { port: 8701, bind: 'endpoint' });
    assert.equal(readyLine('nada'), undefined);
  });
});

describe('sonda do começo', () => {
  const deps = (over: Partial<Parameters<typeof probeSpike>[1]> = {}): Parameters<typeof probeSpike>[1] => ({
    session: SESSION,
    alive: true,
    wantBind: 'loopback',
    readLog: () => 'CONTRARREGRA_READY port=8700 bind=loopback\n',
    snapshot: () => usbmuxSnapshot(target),
    reach: (ready) => probeReach({ ...target, attempts: 2, retryMs: 5, ready, sleep }),
    hello: async () => {
      const c = await open('sync');
      await c.close();
      return c.hello;
    },
    ...over,
  });

  it('sessão errada para o SP-4: sem sessão, morta, build Debug, bind diferente', () => {
    assert.match(sessionProblem(undefined, false, undefined) ?? '', /runner up --spike/);
    assert.match(sessionProblem(SESSION, false, undefined) ?? '', /saiu/);
    assert.match(sessionProblem({ ...SESSION, configuration: 'Debug', spike: false }, true, undefined) ?? '', /build Debug/);
    assert.match(sessionProblem(SESSION, true, 'endpoint') ?? '', /bind=loopback, não endpoint/);
    assert.equal(sessionProblem({ ...SESSION, bind: 'endpoint' }, true, 'endpoint'), null);
  });

  it('alcançável: registra o SerialNumber cru, o READY e o hello', async () => {
    const io = memoryIo();
    const r = await probeSpike(io, deps());
    assert.equal(r.ok, true, r.message);
    assert.match(r.message, /00008101-001E79203A68001E/);
    const row = io.rows.find((x) => x['k'] === 'probe');
    assert.equal(row?.['verdict'], 'reachable');
    assert.equal(row?.['readyMatches'], true);
    assert.equal((row?.['hello'] as Json)['runnerVersion'], '0.0.0');
  });

  it('item 7 — inalcançável com o runner pronto: esta forma não serve; rodar a outra; o plano B só sai do compare', async () => {
    const io = memoryIo();
    const r = await probeSpike(io, deps({ reach: async () => ({ verdict: 'unreachable', attempts: [{ ok: false, ms: 1, err: 'E_RUNNER_DOWN' }] }) }));
    assert.equal(r.ok, false);
    assert.equal(r.verdict, 'unreachable');
    assert.match(r.message, /^forma loopback inalcançável/);
    assert.match(r.message, /rodar a outra forma/);
    assert.match(r.message, /só sai do `compare`/);
    assert.ok(!r.message.startsWith(PLAN_B), 'uma forma sozinha não é o plano B');
  });

  it('item 5 — READY do registro que não bate com a sessão: veredito session (saída 1), nunca unreachable, e nem tenta o Connect', async () => {
    const io = memoryIo();
    let reached = false;
    const r = await probeSpike(io, deps({
      readLog: () => 'CONTRARREGRA_READY port=8701 bind=endpoint\n',
      reach: async () => {
        reached = true;
        return { verdict: 'unreachable', attempts: [] };
      },
    }));
    assert.equal(r.verdict, 'session');
    assert.equal(r.ok, false);
    assert.equal(reached, false);
    assert.match(r.message, /port=8701 bind=endpoint.*port=8700 bind=loopback/);
    const row = io.rows.find((x) => x['k'] === 'probe');
    assert.deepEqual([row?.['verdict'], row?.['readyMatches']], ['session', false]);
    assert.equal(summarize('ready', io.rows).reach, 'session');
  });

  it('sessão que não é a pedida: nem toca no usbmuxd', async () => {
    const io = memoryIo();
    let touched = false;
    const r = await probeSpike(io, deps({ wantBind: 'endpoint', snapshot: async () => ((touched = true), usbmuxSnapshot(target)) }));
    assert.equal(r.verdict, 'session');
    assert.equal(touched, false);
  });
});

describe('medidas', () => {
  it('ecos de 64 B e 64 KB numa conexão sync persistente; o pad volta com o mesmo tamanho', async () => {
    const io = memoryIo();
    const channel = await open('sync');
    try {
      const small = await measureEcho(channel, io, { sc: 'ground', ph: 'echo64', n: 50, padBytes: PAD_SMALL });
      const large = await measureEcho(channel, io, { sc: 'ground', ph: 'echo64k', n: 5, padBytes: PAD_LARGE });
      assert.deepEqual([small.ok, small.errors, large.ok, large.errors], [50, 0, 5, 0]);
    } finally {
      await channel.close();
    }
    const rows = io.rows.filter((r) => r['k'] === 'rtt');
    assert.equal(rows.length, 55);
    assert.ok(rows.every((r) => typeof r['rtt'] === 'number' && typeof r['dly'] === 'number' && r['err'] === undefined));
  });

  it('eco com o pad de outro tamanho conta como erro; para depois de N erros seguidos', async () => {
    const io = memoryIo();
    const channel = await open('sync');
    runner.badPad = true;
    try {
      const r = await measureEcho(channel, io, { sc: 'ground', ph: 'echo64', n: 10, padBytes: PAD_SMALL, maxConsecutiveErrors: 3 });
      assert.deepEqual(r, { ok: 0, errors: 3, aborted: true });
      assert.match(String(io.rows[0]?.['err']), /eco errado/);
    } finally {
      runner.badPad = false;
      await channel.close();
    }
  });

  it('conexões novas: uma por amostra (Connect + hello), etapas e fechamento registrados', async () => {
    const io = memoryIo();
    const connects = usbmuxd.messages('Connect').length;
    const hellos = runner.hellos.length;
    const r = await measureOpens(() => open('sync'), io, { sc: 'ground', ph: 'fresh', n: 12, padBytes: PAD_SMALL });
    assert.deepEqual(r, { ok: 12, errors: 0, aborted: false });
    assert.equal(usbmuxd.messages('Connect').length - connects, 12);
    assert.equal(runner.hellos.length - hellos, 12);
    for (const row of io.rows) {
      for (const key of ['total', 'open', 'ping', 'close', 'list', 'fwd', 'ws', 'hello']) assert.equal(typeof row[key], 'number', key);
      assert.ok((row['total'] as number) >= (row['open'] as number));
    }
  });

  it('conexão nova cujo fechamento demora: espera só até o teto e termina os fechamentos no fundo', async () => {
    const io = memoryIo();
    let closed = 0;
    const slow = async () => ({
      call: async <T>(_m: string, params?: Record<string, unknown>): Promise<T> =>
        ({ seq: params?.['seq'], t2RawNs: '1', t3RawNs: '2', t2UptimeNs: '1', pad: '.'.repeat(PAD_SMALL) }) as T,
      close: () => sleep(400).then(() => void closed++),
    });
    const t0 = Date.now();
    const r = await measureOpens(slow, io, { sc: 'ground', ph: 'fresh', n: 5, padBytes: PAD_SMALL, closeCapMs: 20 });
    const elapsed = Date.now() - t0;
    assert.deepEqual(r, { ok: 5, errors: 0, aborted: false });
    assert.equal(closed, 5, 'todos os fechamentos terminaram antes de a fase acabar');
    assert.ok(elapsed < 1_200, `levou ${elapsed} ms (sem o teto seriam ≥ 2.000)`);
    assert.ok(io.rows.every((row) => row['closeCapped'] === true && (row['close'] as number) < 200));
    assert.equal(summarize('cap', io.rows.map((row) => ({ k: 'conn', ...row }))).rows[0]?.extra['closeCapped'], 5);
  });

  it('rajadas NTP pela sync: θ = o deslocamento do relógio do aparelho, resíduo < 1 ms', async () => {
    const io = memoryIo();
    const channel = await open('sync');
    try {
      await measureBursts(channel, io, { sc: 'ground', ph: 'ntp', bursts: 4, everyMs: 60, size: 16, intervalMs: 2 });
    } finally {
      await channel.close();
    }
    const n = analyzeNtp('ground', 'ntp', io.rows.filter((r) => r['k'] === 'ntp'));
    assert.ok(n !== null);
    assert.equal(n.bursts, 4);
    assert.equal(n.exchanges, 64);
    const thetaErrMs = Math.abs(Number(BigInt(n.thetaMidNs) - OFFSET_NS)) / 1e6;
    assert.ok(thetaErrMs < 2, `θ errou ${thetaErrMs} ms`);
    assert.ok(n.residualMs < 1, `resíduo ${n.residualMs} ms`);
  });

});

// ── A medição inteira contra o runner falso ─────────────────────────────────────────────────────────────────

const SMALL: RunOptions = {
  ...DEFAULT_OPTIONS,
  n64: 60,
  n64k: 4,
  nConnect: 6,
  nFresh: 15,
  nProduct: 4,
  nShots: 6,
  bursts: 3,
  burstEveryMs: 120,
  burstSize: 8,
  burstIntervalMs: 2,
  severRounds: 1,
  severS: 0.3,
  pollMs: 10,
  settleMs: 0,
  airplaneReadMs: 300,
  netOnMs: 300,
  netOffMs: 300,
  startNetMs: 60,
  waitSlackMs: 1_000,
  xctestTimeoutMs: 2_000,
  appWaitMs: 500,
  lateActionMs: 1_000,
  drainMaxMs: 3_000,
};

function resetRunner(): void {
  Object.assign(runner, {
    fg: 'com.apple.springboard', locked: false, airplane: false, net: 'follow', cc: false, alert: false, dead: false,
    dieWhenOffline: false, workMs: {}, blockBeforeNext: {}, taps: 0, badPad: false,
  });
}

function makeEnv(io: Io & { rows: Json[] }, asked: string[], said: string[], over: Partial<DriverEnv> = {}): DriverEnv {
  return {
    ...io,
    flush: () => {},
    log: () => {},
    say: (text) => void said.push(text),
    owner: (step) => void asked.push(step),
    app: HAGAH,
    bind: 'loopback',
    openControl: () => open('control'),
    openSync: () => open('sync'),
    openFresh: () => open('sync'),
    openProduct: () => open('sync'),
    rawConnect: () => rawConnect(target),
    transport: async () => ({ transportType: 'wired', tunnelState: 'connected' }),
    sessionAlive: () => true,
    openLink: (role, onState) =>
      RunnerLink.connect({} as Config, {
        role,
        onStateChange: onState,
        open: (o) => openChannel({ ...target, role: o.role, token, session: SESSION, ...(o.onNotification === undefined ? {} : { onNotification: o.onNotification }) }),
      }),
    sever: (forS) => severLocalLinks(forS),
    ...over,
  };
}

const isStop = (kind: 'owner' | 'transport', step?: string) => (error: unknown): boolean =>
  error instanceof StopError && error.kind === kind && (step === undefined || error.step === step);

/** Os intervalos [começo, fim] de cada fase (linhas `phase` com `t`). */
function phaseIntervals(rows: Json[]): [bigint, bigint][] {
  const intervals: [bigint, bigint][] = [];
  let begin: bigint | undefined;
  for (const r of rows) {
    if (r['k'] !== 'phase' || typeof r['t'] !== 'string') continue;
    if (r['at'] === 'begin') begin = BigInt(r['t']);
    else if (begin !== undefined) intervals.push([begin, BigInt(r['t'])]);
  }
  return intervals;
}

describe('medição inteira (runSpike) contra o runner falso', () => {
  it('o runner põe o Hagah à frente e liga/desliga o avião sozinho; nada pedido ao dono; a fila do XCTest fica fora das medidas', async () => {
    resetRunner();
    const io = memoryIo();
    const asked: string[] = [];
    const said: string[] = [];
    const airs: string[] = [];
    const probe = await probeSpike(io, {
      session: SESSION,
      alive: true,
      wantBind: 'loopback',
      readLog: () => 'CONTRARREGRA_READY port=8700 bind=loopback\n',
      snapshot: () => usbmuxSnapshot(target),
      reach: (ready) => probeReach({ ...target, attempts: 2, retryMs: 5, ready, sleep }),
      hello: async () => {
        const c = await open('sync');
        await c.close();
        return c.hello;
      },
    });
    assert.equal(probe.ok, true);
    const env = makeEnv(io, asked, said, {
      // Um screen.shot atrasado ocupando a fila logo antes de ligar o avião: a troca espera a fila esvaziar.
      say: (text) => {
        said.push(text);
        if (text === TEXT.airOn) runner.occupy(150);
      },
      setAir: (air) => void airs.push(air),
      hotspot: async () => false,
    });
    await runSpike(env, SMALL);

    assert.deepEqual(asked, [], 'nenhum OWNER_ACTION');
    assert.ok(said.includes(TEXT.airOn) && said.includes(TEXT.airOff), 'a voz só avisa');
    assert.deepEqual(airs, ['maybe-on', 'on', 'off'], 'o estado do avião chega ao tratador de sinais');
    assert.deepEqual([runner.airplane, runner.cc, runner.taps], [false, false, 2], 'avião desligado, Central fechada, um toque por troca');
    const toggles = io.rows.filter((r) => r['k'] === 'toggle').map((r) => [r['want'], r['before'], r['tap'], r['ok']]);
    assert.deepEqual(toggles, [[true, 'off', 'ok', true], [false, 'on', 'ok', true]]);
    assert.ok(io.rows.some((r) => r['k'] === 'drain' && r['ph'] === 'toggle'), 'esperou a fila esvaziar antes da troca');
    assert.ok(!io.rows.some((r) => r['k'] === 'xop' && r['op'] === 'cc-open' && r['err'] !== undefined), 'a Central abriu de primeira, sem E_TIMEOUT');
    const apps = io.rows.filter((r) => r['k'] === 'app');
    assert.ok(apps.some((r) => r['sc'] === 'ground' && (r['activations'] as number) >= 1), 'o Hagah posto à frente pelo app.activate');
    assert.ok(apps.some((r) => r['sc'] === 'air' && (r['activations'] as number) >= 1), 'de novo depois de fechar a Central (que foi para a tela de início)');
    assert.equal(runner.calls.get('device.state') ?? 0, 0, 'o device.state (lento, enche a fila) não é usado');
    assert.equal(runner.calls.get('wait.for'), 5, 'rede no começo; interruptor e rede ao ligar; interruptor e rede ao desligar');
    const intervals = phaseIntervals(io.rows);
    const xops = io.rows.filter((r) => r['k'] === 'xop');
    assert.ok(xops.length > 0 && intervals.length > 0);
    for (const x of xops) {
      const t = BigInt(String(x['t']));
      assert.ok(!intervals.some(([a, b]) => t >= a && t <= b), `${String(x['method'])} dentro de uma medida`);
    }

    const count = (k: string, sc: string, ph: string): number => io.rows.filter((r) => r['k'] === k && r['sc'] === sc && r['ph'] === ph).length;
    for (const sc of ['ground', 'air']) {
      assert.equal(count('rtt', sc, 'echo64'), SMALL.n64, `${sc} echo64`);
      assert.equal(count('rtt', sc, 'echo64k'), SMALL.n64k);
      assert.equal(count('conn', sc, 'connect'), SMALL.nConnect);
      assert.equal(count('conn', sc, 'fresh'), SMALL.nFresh);
      assert.equal(count('conn', sc, 'product'), SMALL.nProduct);
      assert.equal(count('shot', sc, 'shots'), SMALL.nShots);
      assert.equal(count('ntp', sc, 'ntp'), SMALL.bursts * SMALL.burstSize);
      assert.equal(count('rtt', sc, 'echo64+shots'), SMALL.n64);
      assert.equal(count('ntp', sc, 'ntp+shots'), SMALL.bursts * SMALL.burstSize);
      assert.ok(count('shot', sc, 'shots.bg') > 0, `${sc}: capturas no fundo`);
    }
    assert.ok(io.rows.some((r) => r['k'] === 'air' && r['state'] === 'on' && r['ok'] === true));
    assert.ok(io.rows.some((r) => r['k'] === 'air' && r['state'] === 'off' && r['ok'] === true));

    const sever = io.rows.filter((r) => r['k'] === 'sever');
    assert.equal(sever.length, 1);
    assert.equal(sever[0]?.['ok'], true, JSON.stringify(sever[0]));
    assert.equal(sever[0]?.['links'], 2);
    const failFast = sever[0]?.['failFast'] as Record<string, { code: string }>;
    assert.equal(failFast['control']?.code, 'E_RUNNER_DOWN/severed');
    assert.equal(failFast['sync']?.code, 'E_RUNNER_DOWN/severed');

    const summary = summarize('e2e', io.rows);
    const table = markdownTable(summary);
    assert.equal(summary.serialRaw, UDID);
    assert.equal(summary.reach, 'reachable');
    assert.equal(summary.drops, 0);
    assert.equal(summary.ac26, true);
    assert.equal(summary.success, true, table);
    assert.equal(summary.ac21, true);
    assert.ok(summary.thetaRef !== null && summary.bias.length === 3, 'reta de referência e o viés de ntp+shots, air/ntp e air/ntp+shots');
    assert.match(table, /\| ground \| echo64 \| 60 \| 0 \|/);
  });

  it('item 1 — o toque estoura o prazo RODANDO e depois a medição para: esvazia a fila, lê o interruptor e só então toca; não chama o dono', async () => {
    resetRunner();
    runner.workMs['ui.tap'] = 15 * MS_PER_RUNNER_S; // 15 "s" > os 10 do runner: E_TIMEOUT rodando, o toque acontece depois
    const io = memoryIo();
    const asked: string[] = [];
    let calls = 0;
    const env = makeEnv(io, asked, [], {
      transport: async () => {
        if (++calls === 3) throw new Error('devicectl explodiu'); // a 3ª leitura é a de depois de ligar o avião
        return { transportType: 'wired', tunnelState: 'connected' };
      },
    });
    try {
      await assert.rejects(runSpike(env, { ...SMALL, phases: ['echo64'], n64: 5 }), (e: unknown) => e instanceof Error && !(e instanceof StopError) && /devicectl explodiu/.test(e.message));
    } finally {
      const left = runner.airplane;
      resetRunner();
      assert.equal(left, false, 'o avião ficou desligado');
    }
    assert.deepEqual(asked, []);
    const taps = io.rows.filter((r) => r['k'] === 'xop' && r['op'] === 'tap');
    assert.equal(taps.length, 2, 'um toque para ligar e um para desligar — nunca retocou às cegas');
    assert.ok(taps.every((r) => r['lanePhase'] === 'running'));
    const toggle = io.rows.find((r) => r['k'] === 'toggle');
    assert.deepEqual([toggle?.['tap'], toggle?.['ok']], ['ran-late', true], 'o toque atrasado valeu (a rede confirmou)');
    const recover = io.rows.find((r) => r['k'] === 'recover');
    assert.deepEqual([recover?.['before'], recover?.['tap'], recover?.['after'], recover?.['ok']], ['no', 'ran-late', 'yes', true]);
    const abort = io.rows.find((r) => r['k'] === 'abort');
    assert.deepEqual([abort?.['air'], abort?.['recovered']], ['on', true]);
  });

  it('item 2 — toque que estoura o prazo NA FILA não roda: tenta de novo (lenient) e o interruptor troca uma vez só', async () => {
    resetRunner();
    runner.blockBeforeNext['ui.tap'] = 12 * MS_PER_RUNNER_S; // a fila ocupada além do prazo de 10 "s": o primeiro toque expira na fila
    const io = memoryIo();
    const asked: string[] = [];
    await runSpike(makeEnv(io, asked, []), { ...SMALL, phases: ['echo64'], n64: 5 });
    assert.deepEqual(asked, []);
    const taps = io.rows.filter((r) => r['k'] === 'xop' && r['op'] === 'tap').map((r) => r['lanePhase'] ?? 'ok');
    assert.deepEqual(taps, ['queued', 'ok', 'ok'], 'ligar: um expirado na fila e um que valeu; desligar: um');
    assert.deepEqual([runner.taps, runner.airplane], [2, false]);
    assert.equal(summarize('lenient', io.rows).air.on, true);
    resetRunner();
  });

  it('a rede não confirma o avião ligado: o runner desliga e o bloco com avião fica de fora', async () => {
    resetRunner();
    runner.net = 'online';
    const io = memoryIo();
    const asked: string[] = [];
    await runSpike(makeEnv(io, asked, []), { ...SMALL, phases: ['echo64'], n64: 5 });
    assert.deepEqual(asked, []);
    assert.equal(runner.airplane, false);
    assert.ok(io.rows.some((r) => r['k'] === 'skip' && r['sc'] === 'air'));
    assert.equal(io.rows.filter((r) => r['k'] === 'rtt' && r['sc'] === 'air').length, 0);
    assert.equal(io.rows.find((r) => r['k'] === 'air' && r['state'] === 'off')?.['ok'], true);
    resetRunner();
  });

  it('item 1 — sem rede nenhuma: o desligado vale pelo value do interruptor, sem exigir a rede', async () => {
    resetRunner();
    runner.net = 'offline';
    const io = memoryIo();
    const asked: string[] = [];
    await runSpike(makeEnv(io, asked, []), { ...SMALL, phases: ['echo64'], n64: 5 });
    assert.deepEqual(asked, []);
    assert.equal(runner.airplane, false);
    const off = io.rows.find((r) => r['k'] === 'air' && r['state'] === 'off');
    assert.equal(off?.['ok'], true);
    const recovers = io.rows.filter((r) => r['k'] === 'recover');
    assert.ok(recovers.length >= 1 && recovers.every((r) => r['ok'] === true && r['before'] === 'yes'), 'leu desligado e não tocou');
    resetRunner();
  });

  it('tela travada: para com OWNER_ACTION (código ou Face ID) antes de medir', async () => {
    resetRunner();
    runner.locked = true;
    const io = memoryIo();
    const asked: string[] = [];
    await assert.rejects(runSpike(makeEnv(io, asked, []), SMALL), isStop('owner', 'unlock'));
    assert.deepEqual(asked, ['unlock']);
    assert.ok(!io.rows.some((r) => r['k'] === 'rtt' || r['k'] === 'toggle'));
    resetRunner();
  });

  it('alerta cobrindo a tela: tenta fechar a Central, tenta o app.activate de novo e só então pede ao dono', async () => {
    resetRunner();
    runner.alert = true;
    const io = memoryIo();
    const asked: string[] = [];
    await assert.rejects(runSpike(makeEnv(io, asked, []), SMALL), isStop('owner', 'screen'));
    assert.deepEqual(asked, ['screen']);
    const ops = io.rows.filter((r) => r['k'] === 'xop').map((r) => String(r['op']));
    assert.deepEqual(ops.filter((op) => !op.startsWith('wait-')), ['activate', 'cc-close', 'activate']);
    resetRunner();
  });

  it('o runner cai com o avião ligado: não consegue desligar e para com OWNER_ACTION air-off (StopError, saída 4)', async () => {
    resetRunner();
    runner.dieWhenOffline = true;
    const io = memoryIo();
    const asked: string[] = [];
    try {
      await assert.rejects(runSpike(makeEnv(io, asked, []), { ...SMALL, phases: ['echo64'], n64: 5 }), isStop('owner', 'air-off'));
    } finally {
      resetRunner();
    }
    assert.deepEqual(asked, ['air-off']);
    const abort = io.rows.find((r) => r['k'] === 'abort');
    assert.deepEqual([abort?.['air'], abort?.['recovered']], ['on', false]);
  });

  it('avião deixado ligado por uma execução anterior: o runner lê o interruptor e desliga no começo, sem pedir nada', async () => {
    resetRunner();
    runner.airplane = true;
    const io = memoryIo();
    const asked: string[] = [];
    const airs: string[] = [];
    await runSpike(makeEnv(io, asked, [], { setAir: (air) => void airs.push(air) }), { ...SMALL, phases: ['echo64'], n64: 5, airplane: false });
    assert.deepEqual(asked, []);
    assert.deepEqual([runner.airplane, runner.taps], [false, 1]);
    assert.deepEqual(airs, ['maybe-on', 'off']);
    const recover = io.rows.find((r) => r['k'] === 'recover');
    assert.deepEqual([recover?.['before'], recover?.['after'], recover?.['ok']], ['no', 'yes', true]);
    assert.equal(io.rows.filter((r) => r['k'] === 'rtt').length, 5);
    resetRunner();
  });

  it('item 8 — Mac na rede do Acesso Pessoal: para com OWNER_ACTION hotspot antes de abrir conexão ou mexer no avião', async () => {
    resetRunner();
    const io = memoryIo();
    const asked: string[] = [];
    const hellos = runner.hellos.length;
    await assert.rejects(runSpike(makeEnv(io, asked, [], { hotspot: async () => true }), SMALL), isStop('owner', 'hotspot'));
    assert.deepEqual(asked, ['hotspot']);
    assert.equal(runner.hellos.length, hellos, 'nenhuma conexão aberta');
    assert.ok(!io.rows.some((r) => r['k'] === 'xop' || r['k'] === 'toggle'));
  });

  it('transportType ≠ wired: com avião, para antes de medir (sem pedir procedimento); sem avião, mede', async () => {
    resetRunner();
    const localNetwork = async () => ({ transportType: 'localNetwork', tunnelState: 'connected' });
    const io = memoryIo();
    const asked: string[] = [];
    await assert.rejects(runSpike(makeEnv(io, asked, [], { transport: localNetwork }), { ...SMALL, phases: ['echo64'], n64: 5 }), isStop('transport', 'wired'));
    assert.deepEqual(asked, []);
    assert.ok(!io.rows.some((r) => r['k'] === 'rtt'));
    const io2 = memoryIo();
    await runSpike(makeEnv(io2, asked, [], { transport: localNetwork }), { ...SMALL, phases: ['echo64'], n64: 5, airplane: false });
    assert.equal(io2.rows.filter((r) => r['k'] === 'rtt').length, 5);
  });
});

describe('fase suplementar concurrent2 (revisão do SP-4)', () => {
  it('janela "captura em trânsito": conta só as amostras que cruzam os últimos transitMs de alguma captura', () => {
    const ms = (x: number): bigint => BigInt(Math.round(x * 1e6));
    const ends = [ms(100), ms(200)];
    const samples = [
      { t1: ms(50), t4: ms(60) }, // antes da janela [80, 100]
      { t1: ms(79), t4: ms(81) }, // entra na janela da 1ª
      { t1: ms(99), t4: ms(105) }, // atravessa o fim da 1ª
      { t1: ms(101), t4: ms(150) }, // entre as duas
      { t1: ms(150), t4: ms(185) }, // encosta no começo da janela da 2ª [180, 200]
      { t1: ms(201), t4: ms(210) }, // depois de tudo
    ];
    assert.deepEqual(transitOverlaps(samples, ends, 20), [false, true, true, false, true, false]);
    assert.deepEqual(transitOverlaps(samples, [], 20), samples.map(() => false));
  });

  it('não entra na execução padrão; só com --phases concurrent2', () => {
    assert.ok((PHASES as readonly string[]).includes('concurrent2'));
    assert.ok(!DEFAULT_OPTIONS.phases.includes('concurrent2'));
  });

  it('capturas sem parar na control; ecos de 64 B espaçados por ~duração, 64 KB espaçados e conexões novas; conta os que cruzaram uma captura em trânsito', async () => {
    resetRunner();
    runner.workMs['screen.shot'] = 40; // capturas de 40 ms (prazo do falso: 60 ms) para haver janelas a cruzar
    const io = memoryIo();
    const asked: string[] = [];
    const opts: RunOptions = {
      ...SMALL,
      phases: ['concurrent2'],
      airplane: false,
      c2DurationMs: 600,
      c2GapMs: [5, 15],
      c2N64k: 5,
      c2GapMs64k: [10, 30],
      c2NFresh: 10,
      transitMs: 15,
    };
    try {
      await runSpike(makeEnv(io, asked, []), opts);
    } finally {
      resetRunner();
    }
    assert.deepEqual(asked, []);
    const bg = io.rows.find((r) => r['k'] === 'bg' && r['ph'] === C2.bg);
    assert.ok(bg !== undefined && bg['aborted'] === false && (bg['ok'] as number) > 0, JSON.stringify(bg));
    const shots = io.rows.filter((r) => r['k'] === 'shot' && r['ph'] === C2.bg);
    assert.ok(shots.every((r) => typeof r['ts'] === 'string' && typeof r['te'] === 'string'));
    const echoes = io.rows.filter((r) => r['k'] === 'rtt' && r['ph'] === C2.echo64);
    assert.ok(echoes.length >= 25, `${echoes.length} ecos em 600 ms a cada 5–15 ms`);
    const starts = echoes.map((r) => BigInt(String(r['t1'])));
    for (let i = 1; i < starts.length; i++) assert.ok(Number(starts[i]! - starts[i - 1]!) / 1e6 >= 4, `espaçamento ${i}`);
    assert.equal(io.rows.filter((r) => r['k'] === 'rtt' && r['ph'] === C2.echo64k).length, 5);
    assert.equal(io.rows.filter((r) => r['k'] === 'conn' && r['ph'] === C2.fresh).length, 10);
    // nada da fila do XCTest dentro da fase: as capturas de fundo são a carga medida, não uma interferência
    const xops = io.rows.filter((r) => r['k'] === 'xop').map((r) => BigInt(String(r['t'])));
    for (const t of xops) assert.ok(!phaseIntervals(io.rows).some(([a, b]) => t >= a && t <= b));

    const s = summarize('c2', io.rows);
    assert.equal(s.c2.length, 1);
    const g = s.c2[0]!;
    assert.equal(g.bgValid, true);
    assert.ok(g.echo64.overlaps >= 1, `cruzaram: ${g.echo64.overlaps}`);
    assert.equal(s.c2ok, true, markdownTable(s));
    assert.match(markdownTable(s), /Fase suplementar `concurrent2`/);
    assert.equal(s.checks.find((c) => c.id === 'ground.c2.echo64.overlaps')?.value, g.echo64.overlaps);
    assert.equal(s.checks.filter((c) => c.id.includes('.c2.')).every((c) => !c.required), true, 'não mexe no sucesso da execução principal');
  });

  it('sem as capturas de fundo rodando (bg parou ou sem nenhuma), o veredito da concurrent2 não passa e as medidas ficam em aberto', () => {
    const base: Json[] = [
      { k: 'run', bind: 'loopback', opts: { transitMs: 20 } },
      ...Array.from({ length: 50 }, (_, i) => ({ k: 'rtt', sc: 'ground', ph: C2.echo64, i, rtt: 1, t1: String(1_000_000n + BigInt(i) * 30_000_000n), t4: String(2_000_000n + BigInt(i) * 30_000_000n) })),
      { k: 'shot', sc: 'ground', ph: C2.bg, i: 0, rtt: 1500, ts: '0', te: String(31_000_000n) },
    ];
    for (const bg of [{ ok: 30, errors: 2, aborted: true }, { ok: 0, errors: 0, aborted: false }]) {
      const s = summarize('c2bg', [...base, { k: 'bg', sc: 'ground', ph: C2.bg, ...bg }]);
      assert.equal(s.c2ok, false);
      for (const id of ['ground.c2.echo64.p50', 'ground.c2.echo64.p95', 'ground.c2.echo64.overlaps']) {
        assert.deepEqual([s.checks.find((c) => c.id === id)?.value, s.checks.find((c) => c.id === id)?.ok], [null, null], id);
      }
    }
    const ok = summarize('c2ok', [...base, { k: 'bg', sc: 'ground', ph: C2.bg, ok: 30, errors: 0, aborted: false }]);
    assert.equal(ok.c2[0]?.echo64.overlaps, 1, 'o eco que termina em 32 ms cruza a janela [11, 31] ms da captura');
  });
});

describe('sinais e Acesso Pessoal', () => {
  it('item 3 — SIGINT/SIGTERM: com o avião possivelmente ligado, OWNER_ACTION air-off e saída 4; desligado, 130', () => {
    assert.deepEqual(signalExit('off'), { code: 130 });
    for (const air of ['on', 'maybe-on'] as const) {
      const exit = signalExit(air);
      assert.equal(exit.code, 4);
      assert.equal(exit.owner?.step, 'air-off');
      assert.equal(exit.owner?.text, TEXT.ownerAirOff);
    }
  });

  it('item 8 — ifconfig com inet 172.20.10.x = Acesso Pessoal; outras redes não', () => {
    assert.equal(hotspotActive('en7: flags=8863<UP>\n\tinet 172.20.10.2 netmask 0xfffffff0 broadcast 172.20.10.15\n'), true);
    assert.equal(hotspotActive('en0: flags=8863<UP>\n\tinet 192.168.1.20 netmask 0xffffff00\n\tinet 172.20.100.2 netmask 0xffffff00\n'), false);
    assert.equal(hotspotActive(''), false);
  });
});

describe('resumo, critério e decisão', () => {
  function rtt(sc: string, ph: string, values: number[]): Json[] {
    return values.map((v, i) => ({ k: 'rtt', sc, ph, i, rtt: v, dly: v, dev: 0 }));
  }
  function conn(sc: string, ph: string, values: number[]): Json[] {
    return values.map((v, i) => ({ k: 'conn', sc, ph, i, total: v }));
  }
  /** Rajadas sintéticas exatas: θ = OFFSET_NS + `biasNs`, atraso simétrico de 100 µs em cada sentido. */
  function ntp(sc: string, ph: string, biasNs = 0n, startNs = 1_000_000_000_000n): Json[] {
    const rows: Json[] = [];
    for (let b = 0; b < 3; b++) {
      for (let j = 0; j < 8; j++) {
        const t1 = startNs + BigInt(b) * 5_000_000_000n + BigInt(j) * 10_000_000n;
        const t2 = t1 + OFFSET_NS + biasNs + 100_000n;
        const t3 = t2 + 10_000n;
        const t4 = t3 - OFFSET_NS - biasNs + 100_000n;
        rows.push({ k: 'ntp', sc, ph, b, j, t1: String(t1), t2: String(t2), t3: String(t3), t4: String(t4) });
      }
    }
    return rows;
  }
  const fast = Array.from({ length: 100 }, (_, i) => 1 + (i % 10) / 10);
  function good(bind: string, sc: string[] = ['ground', 'air'], airBiasNs = 0n): Json[] {
    const rows: Json[] = [
      { k: 'probe', verdict: 'reachable', bind, configuration: 'Spike', sessionId: 's', usbmux: { usb: { serialRaw: UDID } } },
      { k: 'run', bind },
    ];
    sc.forEach((s, i) => {
      const start = 1_000_000_000_000n + BigInt(i) * 100_000_000_000n;
      const bias = s === 'air' ? airBiasNs : 0n;
      rows.push(
        ...rtt(s, 'echo64', fast),
        ...rtt(s, 'echo64+shots', fast),
        ...conn(s, 'fresh', fast.map((x) => x * 10)),
        ...ntp(s, 'ntp', bias, start),
        ...ntp(s, 'ntp+shots', bias, start + 20_000_000_000n),
        { k: 'bg', sc: s, ph: 'shots.bg', ok: 40, errors: 0, aborted: false },
      );
    });
    // A reta de referência também tem as rajadas do fim (sever.ntp), depois de todo o resto.
    rows.push(...ntp('ground', 'sever.ntp', 0n, 1_000_000_000_000n + 300_000_000_000n));
    if (sc.includes('air')) rows.push({ k: 'air', state: 'on', ok: true }, { k: 'air', state: 'off', ok: true });
    return rows;
  }

  it('tudo dentro: sucesso; θ sintético exato tem resíduo 0', () => {
    const s = summarize('ok', good('loopback'));
    assert.equal(s.success, true, markdownTable(s));
    assert.equal(s.ntp.find((n) => n.sc === 'ground' && n.ph === 'ntp')?.residualMs, 0);
    assert.equal(BigInt(s.ntp[0]!.thetaMidNs), OFFSET_NS);
    assert.equal(s.thetaRef?.residualMs, 0);
    assert.equal(s.thetaRef?.bursts, 6, 'ground/ntp (3) + sever.ntp (3); nada com carga ou com avião');
  });

  it('item 4 — viés constante de +1,5 ms com o avião: o resíduo por fase não vê (0), a reta de referência vê e reprova; com 0, passa', () => {
    const biased = summarize('bias', good('loopback', ['ground', 'air'], 1_500_000n));
    assert.equal(biased.ntp.find((n) => n.sc === 'air' && n.ph === 'ntp')?.residualMs, 0, 'a reta do próprio grupo absorve o viés');
    const check = biased.checks.find((c) => c.id === 'air.ntp.bias');
    assert.deepEqual([check?.value, check?.ok, check?.required], [1.5, false, true]);
    assert.equal(biased.checks.find((c) => c.id === 'air.ntp+shots.bias')?.ok, false);
    assert.equal(biased.checks.find((c) => c.id === 'ground.ntp+shots.bias')?.ok, true);
    assert.equal(biased.success, false);
    const clean = summarize('clean', good('loopback', ['ground', 'air'], 0n));
    assert.deepEqual([clean.checks.find((c) => c.id === 'air.ntp.bias')?.value, clean.checks.find((c) => c.id === 'air.ntp.bias')?.ok], [0, true]);
    assert.equal(clean.success, true);
    const negative = summarize('neg', good('loopback', ['ground', 'air'], -1_500_000n));
    assert.equal(negative.checks.find((c) => c.id === 'air.ntp.bias')?.ok, false, 'o limite vale nos dois sentidos');
  });

  it('item 6 — as medidas *+shots só valem com as capturas de fundo rodando (bg sem parar e com alguma)', () => {
    for (const bg of [{ ok: 40, aborted: true }, { ok: 0, aborted: false }, null]) {
      const rows = good('loopback').filter((r) => !(r['k'] === 'bg' && r['sc'] === 'ground'));
      if (bg !== null) rows.push({ k: 'bg', sc: 'ground', ph: 'shots.bg', errors: 20, ...bg });
      const s = summarize('bg', rows);
      for (const id of ['ground.echo64+shots.p50', 'ground.echo64+shots.p95', 'ground.ntp+shots.bias']) {
        const c = s.checks.find((x) => x.id === id);
        assert.deepEqual([c?.value, c?.ok], [null, null], `${id} com bg ${JSON.stringify(bg)}`);
      }
      assert.equal(s.success, false);
      assert.equal(s.checks.find((x) => x.id === 'air.echo64+shots.p95')?.ok, true, 'o outro cenário segue valendo');
    }
  });

  it('p95 do eco acima de 20 ms, conexão nova acima de 50 ms, queda com avião: cada um derruba o sucesso', () => {
    const slowEcho = good('loopback').map((r) => (r['k'] === 'rtt' && r['sc'] === 'ground' && r['ph'] === 'echo64' && (r['i'] as number) >= 90 ? { ...r, rtt: 25 } : r));
    const a = summarize('a', slowEcho);
    assert.equal(a.success, false);
    assert.equal(a.checks.find((c) => c.id === 'ground.echo64.p95')?.ok, false);
    assert.equal(a.ac21, false);

    const slowFresh = good('loopback').map((r) => (r['k'] === 'conn' && r['sc'] === 'air' && (r['i'] as number) >= 90 ? { ...r, total: 60 } : r));
    assert.equal(summarize('b', slowFresh).checks.find((c) => c.id === 'air.fresh.p95')?.ok, false);

    const drop = [...good('loopback'), { k: 'drop', role: 'sync', sc: 'air', ph: 'echo64' }];
    const c = summarize('c', drop);
    assert.equal(c.success, false);
    assert.equal(c.checks.find((x) => x.id === 'air.drops')?.ok, false);

    const err = [...good('loopback'), { k: 'rtt', sc: 'air', ph: 'echo64', i: 999, rtt: 1000, err: 'E_TIMEOUT' }];
    assert.equal(summarize('d', err).checks.find((x) => x.id === 'air.errors')?.ok, false);
  });

  it('sem o cenário com avião, o sucesso fica em aberto (o critério pede "sem mudança com avião")', () => {
    const s = summarize('g', good('loopback', ['ground']));
    assert.equal(s.success, false);
    assert.equal(s.checks.find((c) => c.id === 'air.on')?.ok, null);
    assert.equal(s.ac21, true, 'o AC-2.1 é só sem avião');
  });

  it('decisão: as duas formas inalcançáveis → plano B; loopback passa → principal; alcançável sem critério → indeciso', () => {
    const unreachable = (bind: string): Json[] => [{ k: 'probe', verdict: 'unreachable', bind }];
    assert.match(compare([summarize('l', unreachable('loopback')), summarize('e', unreachable('endpoint'))]).decision, /^PLANO B .*Q-13/);
    const both = compare([summarize('l', good('loopback')), summarize('e', good('endpoint'))]);
    assert.match(both.decision, /^PRINCIPAL .*padrão de produção/);
    assert.match(both.markdown, /\| bind \| loopback \| endpoint \|/);
    const onlyEndpoint = compare([summarize('l', good('loopback', ['ground'])), summarize('e', good('endpoint'))]);
    assert.match(onlyEndpoint.decision, /^PRINCIPAL .*Só a forma endpoint/);
    assert.match(compare([summarize('l', good('loopback', ['ground']))]).decision, /^INDECISO .*air\.on/);
  });
});
