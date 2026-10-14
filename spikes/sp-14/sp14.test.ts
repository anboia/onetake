// Testes do driver do SP-14 (T-0.34; AC-7.1) sem aparelho: `node --test spikes/sp-14/sp14.test.ts`. A análise roda
// sobre rajadas sintéticas com θ, deriva, curvatura, atrasos assimétricos e sono plantados (o mesmo formato de linha que
// o driver grava); a medição roda contra um runner falso sobre `mac/test/helpers/ws-server.ts` que responde
// `session.hello`, `clock.ping` (relógio "do aparelho" = o do Mac + deslocamento + deriva conhecidos) e `health`.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, describe, it } from 'node:test';

import { RpcConnection } from '../../mac/src/runner/rpc.ts';
import { startWsServer, type WsTestConnection, type WsTestServer } from '../../mac/test/helpers/ws-server.ts';
import {
  burstCount,
  burstsFromRows,
  burstTheta,
  CRITERIA,
  DEFAULT_OPTIONS,
  hotspotActive,
  markdownTable,
  runDrift,
  StopError,
  summarize,
  type Conn,
  type DriftEnv,
  type DriftOptions,
  type Json,
} from './lib.ts';

// ── Rajadas sintéticas ─────────────────────────────────────────────────────────────────────────────────────

/** PRNG determinístico (mulberry32). */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface SynthOptions {
  bursts?: number;
  everyS?: number;
  size?: number;
  intervalMs?: number;
  /** θ plantado (ns) em função do tempo do Mac desde o começo (s). */
  theta: (tS: number) => number;
  /** Atraso de ida e de volta (ns) de cada troca; padrão: 0,4 ms + jitter exponencial de média 0,05 ms em cada sentido. */
  delays?: (b: number, j: number, rand: () => number) => { up: number; down: number };
  /** `t2Raw − t2Uptime` (ns) em função do tempo (s); padrão constante. */
  rawMinusUptime?: (tS: number) => number;
  seed?: number;
}

const MAC_START = 1_000_000_000_000_000n;

/** Linhas `ntp` como as do `runDrift`: T1/T4 no relógio do Mac, T2/T3 no do aparelho (D = M + θ(M)). */
function synth(o: SynthOptions): Json[] {
  const rand = prng(o.seed ?? 7);
  const bursts = o.bursts ?? 121;
  const everyS = o.everyS ?? 10;
  const size = o.size ?? 32;
  const intervalMs = o.intervalMs ?? 10;
  const delays = o.delays ?? ((_b, _j, r) => ({ up: 400_000 + -Math.log(1 - r()) * 50_000, down: 400_000 + -Math.log(1 - r()) * 50_000 }));
  const rows: Json[] = [{ k: 'start', opts: { everyMs: everyS * 1000 }, bursts }];
  const proc = 60_000; // tempo dentro do runner (ns)
  for (let b = 0; b < bursts; b++) {
    for (let j = 0; j < size; j++) {
      const t1 = MAC_START + BigInt(Math.round(b * everyS * 1e9 + j * intervalMs * 1e6));
      const { up, down } = delays(b, j, rand);
      const m2 = t1 + BigInt(Math.round(up));
      const tS = Number(m2 - MAC_START) / 1e9;
      const t2 = m2 + BigInt(Math.round(o.theta(tS)));
      const t3 = t2 + BigInt(proc);
      const t4 = m2 + BigInt(proc) + BigInt(Math.round(down));
      const u2 = t2 - BigInt(Math.round(o.rawMinusUptime?.(tS) ?? 3_600e9));
      rows.push({ k: 'ntp', b, j, t1: String(t1), t2: String(t2), t3: String(t3), t4: String(t4), u2: String(u2) });
    }
  }
  return rows;
}

const THETA0 = 5_123_456_789;
const PPM = 9;
const linear = (tS: number): number => THETA0 + PPM * 1e3 * tS; // 9 ppm = 9 µs/s = 9e3 ns/s

// ── Análise ────────────────────────────────────────────────────────────────────────────────────────────────

describe('análise (rajadas sintéticas)', () => {
  it('121 rajadas em 20 min a cada 10 s (a primeira em 0, a última em 20 min)', () => {
    assert.equal(burstCount(DEFAULT_OPTIONS), 121);
    assert.equal(DEFAULT_OPTIONS.size, 32);
    assert.equal(DEFAULT_OPTIONS.intervalMs, 10);
  });

  it('deriva linear plantada: o completo recupera b, o resíduo fica pequeno, pré+pós acerta o meio e só-pré erra b·Δt', () => {
    const s = summarize('linear', synth({ theta: linear }));
    assert.equal(s.bursts.withData, 121);
    assert.equal(s.bursts.samples, 121 * 8);
    assert.ok(Math.abs(s.full.bPpm - PPM) < 0.05, `b = ${s.full.bPpm} ppm`);
    assert.ok(s.full.fitResidualMs < 0.1, `resíduo ${s.full.fitResidualMs} ms`);
    assert.ok(Math.abs(s.prePost.bPpm - PPM) < 0.5, `b pré+pós = ${s.prePost.bPpm} ppm`);
    assert.ok(Math.abs(s.prePost.midErrorMs) < 0.1, `pré+pós no meio ${s.prePost.midErrorMs} ms`);
    assert.ok(Math.abs(s.prePost.midVsFullMs) < 0.1);
    // Só-pré: θ constante; no meio (600 s) erra 9 µs/s × 600 s = 5,4 ms; no pós, 10,8 ms.
    assert.equal(s.preOnly.slopeEstimated, false);
    assert.ok(Math.abs(s.preOnly.midErrorMs - 5.4) < 0.1, `só-pré no meio ${s.preOnly.midErrorMs} ms`);
    assert.ok(Math.abs(s.preOnly.postErrorMs - 10.8) < 0.1, `só-pré no pós ${s.preOnly.postErrorMs} ms`);
    assert.ok(Math.abs(s.driftOverRunMs - 10.8) < 0.1);
    assert.ok(Math.abs(s.full20s.bPpm - PPM) < 0.05);
    assert.equal(s.full20s.bursts, 61);
    assert.deepEqual(s.criteria, { residualMs: 1, midErrorMs: 2, residualOk: true, midOk: true, met: true });
    assert.equal(s.sleep.slept, false);
    assert.equal(s.residuals.length, 121);
    assert.ok(Math.abs(s.residuals[60]!.min - 10) < 0.01, 'a rajada 60 está no minuto 10');
  });

  it('curvatura plantada (flecha de 3 ms no meio): pré+pós erra −3 ms e reprova; o critério do resíduo é separado', () => {
    const T = 1200;
    const c = 3e6 / (T * T / 4); // ns/s²: c·T²/4 = 3 ms
    const s = summarize('curva', synth({ theta: (t) => THETA0 + c * t * t }));
    // Medido − reta pelas pontas no meio = c·T²/4 − c·T²/2 = −c·T²/4.
    assert.ok(Math.abs(s.prePost.midErrorMs + 3) < 0.15, `pré+pós no meio ${s.prePost.midErrorMs} ms`);
    assert.equal(s.criteria.midOk, false);
    assert.equal(s.criteria.met, false);
    // A reta completa de uma parábola deixa resíduo RMS ≈ c·T²/(6√5) ≈ 0,89 ms.
    assert.ok(s.full.fitResidualMs > 0.7 && s.full.fitResidualMs < 1.1, `resíduo ${s.full.fitResidualMs} ms`);
    assert.match(markdownTable(s), /NÃO atingido/);
  });

  it('o quarto de menor atraso descarta trocas com atraso assimétrico (θ sem viés)', () => {
    // 20 de 32 trocas com 5 ms a mais só na ida: θ dessas fica 2,5 ms enviesado; as 8 de menor atraso estão limpas.
    const rows = synth({
      theta: linear,
      delays: (_b, j, r) => ({ up: 400_000 + r() * 20_000 + (j % 8 < 5 ? 5_000_000 : 0), down: 400_000 + r() * 20_000 }),
    });
    const bursts = burstsFromRows(rows);
    const p = burstTheta(bursts[0]!)!;
    const plantedAt = linear(Number(p.macNs - MAC_START) / 1e9);
    assert.ok(Math.abs(Number(p.thetaNs) - plantedAt) / 1e6 < 0.05, `θ da rajada ${Number(p.thetaNs)} × ${plantedAt}`);
    const s = summarize('assim', rows);
    assert.ok(s.full.fitResidualMs < 0.05);
    assert.ok(s.criteria.met);
  });

  it('sono do aparelho (t2Raw − t2Uptime cresce) é marcado; sem sono, espalhamento ≈ 0', () => {
    const slept = summarize('sono', synth({ theta: linear, rawMinusUptime: (t) => 3_600e9 + (t > 500 ? 5e9 : 0) }));
    assert.equal(slept.sleep.slept, true);
    assert.ok((slept.sleep.spreadMs ?? 0) > 4_999);
    const awake = summarize('acordado', synth({ theta: linear }));
    assert.equal(awake.sleep.slept, false);
    assert.equal(awake.sleep.spreadMs, 0);
  });

  it('tomadas menores: janelas de 5 e 10 min deslizando de 1 em 1 min, com o pior erro de pré+pós e de só-pré', () => {
    const s = summarize('janelas', synth({ theta: linear }));
    const w5 = s.windows.find((w) => w.minutes === 5)!;
    const w10 = s.windows.find((w) => w.minutes === 10)!;
    assert.equal(w5.windows, 16); // começos 0, 6, …, 90 (span de 30 rajadas até a 120)
    assert.equal(w10.windows, 11);
    assert.ok(w5.prePostWorstMidMs < 0.1);
    // Só-pré no meio de 5 min: 9 µs/s × 150 s = 1,35 ms; de 10 min: 2,7 ms.
    assert.ok(Math.abs(w5.preOnlyWorstMidMs - 1.35) < 0.1, `${w5.preOnlyWorstMidMs}`);
    assert.ok(Math.abs(w10.preOnlyWorstMidMs - 2.7) < 0.1, `${w10.preOnlyWorstMidMs}`);
  });

  it('rajada sem trocas boas fica de fora; com menos de 3 rajadas com dados, a análise recusa', () => {
    const rows = synth({ theta: linear, bursts: 5 }).map((r) => (r['k'] === 'ntp' && r['b'] === 2 ? { k: 'ntp', b: 2, j: r['j'], err: 'E_TIMEOUT' } : r));
    const s = summarize('buraco', rows);
    assert.equal(s.bursts.withData, 4);
    assert.equal(s.bursts.errors, 32);
    assert.throws(() => summarize('pouco', synth({ theta: linear, bursts: 2 })), /≥ 3/);
  });

  it('Acesso Pessoal pelo ifconfig', () => {
    assert.equal(hotspotActive('bridge100: flags=8863\n\tinet 172.20.10.2 netmask 0xfffffff0'), true);
    assert.equal(hotspotActive('en0: flags=8863\n\tinet 192.168.1.20 netmask 0xffffff00'), false);
  });
});

// ── Medição contra um runner falso ─────────────────────────────────────────────────────────────────────────

const TOKEN = 'token-de-teste-do-sp14';
/** Relógio "do aparelho" = o do Mac + isto + deriva de `DRIFT_PPM` desde a subida do falso. */
const OFFSET_NS = 7_654_321_000n;
const DRIFT_PPM = 50;
const HELLO = (JSON.parse(readFileSync(new URL('../../mac/test/fixtures/protocol/RpcResponse.session.hello.json', import.meta.url), 'utf8')) as { result: unknown }).result;

interface FakeRunner {
  server: WsTestServer;
  /** Derruba a conexão `sync` depois de tantos `clock.ping` (uma vez). */
  dropSyncAfter: number | null;
  pings: number;
  healths: number;
  depth: number;
}

let fake: FakeRunner;

async function startFakeRunner(): Promise<FakeRunner> {
  const born = process.hrtime.bigint();
  const device = (): bigint => {
    const mac = process.hrtime.bigint();
    return mac + OFFSET_NS + BigInt(Math.round((Number(mac - born) * DRIFT_PPM) / 1e6));
  };
  const roles = new Map<WsTestConnection, string>();
  const f: FakeRunner = { server: undefined as unknown as WsTestServer, dropSyncAfter: null, pings: 0, healths: 0, depth: 0 };
  const handle = (conn: WsTestConnection, text: string): void => {
    const t2 = device();
    const { id, method, params } = JSON.parse(text) as { id: unknown; method: string; params?: Record<string, unknown> };
    const ok = (result: unknown): void => conn.sendJson({ jsonrpc: '2.0', id, result });
    const fail = (code: number, message: string): void => conn.sendJson({ jsonrpc: '2.0', id, error: { code, message } });
    if (method === 'session.hello') {
      if (params?.['token'] !== TOKEN) return fail(-32001, 'E_AUTH: token errado');
      roles.set(conn, String(params?.['role']));
      return ok(HELLO);
    }
    const role = roles.get(conn);
    if (role === undefined) return fail(-32001, 'E_AUTH: sem session.hello');
    if (role === 'sync' && method !== 'clock.ping') return fail(-32001, 'E_AUTH: a sync só leva clock.ping');
    if (method === 'clock.ping') {
      f.pings++;
      if (f.dropSyncAfter !== null && f.pings > f.dropSyncAfter) {
        f.dropSyncAfter = null;
        return conn.terminate();
      }
      return ok({ seq: params?.['seq'], t2RawNs: String(t2), t3RawNs: String(device()), t2UptimeNs: String(t2 - 1_000_000n) });
    }
    if (method === 'health') {
      f.healths++;
      return ok({ ok: true, uptimeS: 1, xctestQueueDepth: f.depth, treeVersion: 1, foregroundApp: 'com.apple.springboard', locked: false });
    }
    return fail(-32601, `método inexistente: ${method}`);
  };
  f.server = await startWsServer({ onConnection: (conn) => conn.onMessage((text) => handle(conn, text)) });
  return f;
}

before(async () => {
  fake = await startFakeRunner();
});

after(async () => {
  await fake.server.close();
});

async function open(role: 'sync' | 'control'): Promise<Conn> {
  const rpc = await RpcConnection.open(fake.server.url);
  await rpc.call('session.hello', { token: TOKEN, role, client: { name: 'sp14-test', pid: process.pid } });
  return {
    get isOpen() {
      return rpc.isOpen;
    },
    call: (method, params, options) => rpc.call(method, params as never, options),
    close: () => rpc.close(),
  };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function env(over: Partial<DriftEnv> = {}): DriftEnv & { rows: Json[]; flushes: number } {
  const rows: Json[] = [];
  const e = {
    rows,
    flushes: 0,
    hr: () => process.hrtime.bigint(),
    sleep,
    write: (k: string, data: Json) => void rows.push({ k, ...data }),
    flush: () => {
      e.flushes++;
    },
    log: () => {},
    openSync: () => open('sync'),
    openControl: () => open('control'),
    hotspot: async () => false,
    sessionAlive: () => true,
    transport: async () => ({ transportType: 'wired', tunnelState: 'connected' }),
    ...over,
  };
  return e;
}

const FAST: DriftOptions = { ...DEFAULT_OPTIONS, durationMs: 400, everyMs: 200, size: 8, intervalMs: 2, healthEveryBursts: 1, queueWaitMs: 2_000 };

describe('medição (runner falso pelo WebSocket)', () => {
  it('3 rajadas de 8 trocas: linhas ntp com T1…T4 e u2, health, transporte no começo e no fim; θ recuperado', async () => {
    const e = env();
    const r = await runDrift(e, FAST);
    assert.deepEqual(r, { bursts: 3, ok: 24, errors: 0, reopens: 0 });
    const ntp = e.rows.filter((x) => x['k'] === 'ntp');
    assert.equal(ntp.length, 24);
    for (const row of ntp) for (const key of ['t1', 't2', 't3', 't4', 'u2']) assert.equal(typeof row[key], 'string', key);
    assert.deepEqual(ntp.map((x) => x['b']), [...Array(8).fill(0), ...Array(8).fill(1), ...Array(8).fill(2)]);
    assert.deepEqual(e.rows.filter((x) => x['k'] === 'transport').map((x) => x['when']), ['start', 'end']);
    assert.ok(e.rows.filter((x) => x['k'] === 'health').length >= 4, 'health no começo e depois de cada rajada');
    assert.ok(e.flushes >= 3, 'grava entre rajadas');
    // Rajadas agendadas a partir do começo: a 3ª começa ≈ 400 ms depois da 1ª.
    const firstT1 = (b: number): bigint => BigInt(String(ntp.find((x) => x['b'] === b)!['t1']));
    const gapMs = Number(firstT1(2) - firstT1(0)) / 1e6;
    assert.ok(gapMs >= 399 && gapMs < 460, `${gapMs} ms`);
    const s = summarize('falso', e.rows, { windowMinutes: [] });
    const theta = Number(burstTheta(burstsFromRows(e.rows)[1]!)!.thetaNs - OFFSET_NS) / 1e6;
    // θ = deslocamento + deriva desde a subida do falso (≤ alguns segundos × 50 ppm < 1 ms).
    assert.ok(theta >= 0 && theta < 1, `θ − deslocamento = ${theta} ms`);
    assert.equal(s.sleep.slept, false);
  });

  it('a sync cai no meio: reabre antes da rajada seguinte e continua', async () => {
    fake.dropSyncAfter = fake.pings + 8;
    const e = env();
    const r = await runDrift(e, FAST);
    assert.equal(r.reopens, 1);
    assert.equal(r.ok, 24 - (r.errors === 0 ? 0 : r.errors));
    assert.ok(r.errors >= 1 && r.errors <= 8, `${r.errors} erros`);
    assert.ok(e.rows.some((x) => x['k'] === 'reopen' && x['b'] === 2 && x['err'] === undefined));
  });

  it('Acesso Pessoal ligado: para antes de abrir qualquer conexão', async () => {
    let opened = 0;
    const e = env({ hotspot: async () => true, openControl: () => (opened++, open('control')), openSync: () => (opened++, open('sync')) });
    await assert.rejects(runDrift(e, FAST), (error: unknown) => error instanceof StopError && error.kind === 'hotspot');
    assert.equal(opened, 0);
  });

  it('fora do cabo (localNetwork): para com not-wired', async () => {
    const e = env({ transport: async () => ({ transportType: 'localNetwork', tunnelState: 'connected' }) });
    await assert.rejects(runDrift(e, FAST), (error: unknown) => error instanceof StopError && error.kind === 'not-wired');
  });

  it('o runner cai (xcodebuild saiu): para com session depois da rajada', async () => {
    const e = env({ sessionAlive: () => false });
    await assert.rejects(runDrift(e, FAST), (error: unknown) => error instanceof StopError && error.kind === 'session');
    assert.equal(e.rows.filter((x) => x['k'] === 'ntp').length, 8);
  });

  it('fila do XCTest ocupada que não esvazia: para sem medir', async () => {
    fake.depth = 2;
    try {
      const e = env();
      await assert.rejects(runDrift(e, { ...FAST, queueWaitMs: 50 }), (error: unknown) => error instanceof StopError && error.kind === 'session');
      assert.equal(e.rows.filter((x) => x['k'] === 'ntp').length, 0);
    } finally {
      fake.depth = 0;
    }
  });

  it('o critério é o do AC-7.1', () => {
    assert.deepEqual(CRITERIA, { residualMs: 1, midErrorMs: 2 });
  });
});
