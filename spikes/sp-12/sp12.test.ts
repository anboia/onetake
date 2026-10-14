// Testes do driver do SP-12 parte 1 (T-0.30; AC-1.11, AC-2.8, SM-5) sem aparelho: `node --test spikes/sp-12/sp12.test.ts`.
// O leitor do `xctrace` e do registro do `xcodebuild` rodam sobre textos no formato real (encurtados); as falhas e o
// laço principal rodam contra um runner falso em memória (`FakeRunner`), com o plano encolhido para milissegundos.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ContrarregraError } from '../../mac/src/core/errors.ts';
import {
  AC111,
  analyzeSessionLog,
  CRITERIA,
  defaultPlan,
  edgeGrowth,
  FAILURES,
  hotspotActive,
  markdown,
  maxGap,
  parseRows,
  parseXctraceTable,
  pilotPlan,
  planCounts,
  processMemory,
  redact,
  relevantProcs,
  runEndurance,
  RUNNER_EXE,
  slope,
  summarize,
  type Conn,
  type Ctx,
  type EnduranceEnv,
  type Json,
  type Plan,
  type Row,
  type SessionRef,
  type SyncLinkLike,
} from './lib.ts';

// ── xctrace ──────────────────────────────────────────────────────────────────────────────────────────

const COLS = ['start', 'process', 'responsible-process', 'duration', 'pid', 'uid', 'cpu-percent', 'cpu-total', 'thread-count', 'mach-port-count', 'memory-physical-footprint', 'memory-real', 'memory-real-private'];

function xmlTable(rows: string[]): string {
  const cols = COLS.map((c) => `<col><mnemonic>${c}</mnemonic><name>${c}</name></col>`).join('');
  return `<?xml version="1.0"?>\n<trace-query-result>\n<node xpath='x'><schema name="activity-monitor-process-live">${cols}</schema>\n${rows.join('\n')}\n</node></trace-query-result>`;
}

describe('xctrace: tabela do Activity Monitor', () => {
  const xml = xmlTable([
    // amostra 0: o runner (com ids) e o SpringBoard
    `<row><start-time id="1" fmt="00:00.000">0</start-time><process id="2" fmt="${RUNNER_EXE} (34219)"><pid id="3" fmt="34219">34219</pid><device-session id="4" fmt="TODO">TODO</device-session></process><process id="5" fmt="launchd (1)"><pid id="6" fmt="1">1</pid><device-session ref="4"/></process><duration id="7" fmt="1 s">1000000000</duration><pid ref="3"/><process-uid id="8" fmt="mobile">501</process-uid><sentinel/><duration-on-core id="9" fmt="1 s">1500000000</duration-on-core><event-count id="10" fmt="12">12</event-count><event-count id="11" fmt="300">300</event-count><size-in-bytes id="12" fmt="40 MiB">41943040</size-in-bytes><size-in-bytes id="13" fmt="60 MiB">62914560</size-in-bytes><size-in-bytes id="14" fmt="30 MiB">31457280</size-in-bytes></row>`,
    `<row><start-time ref="1"/><process id="20" fmt="SpringBoard (35)"><pid id="21" fmt="35">35</pid><device-session ref="4"/></process><process ref="5"/><duration ref="7"/><pid ref="21"/><process-uid ref="8"/><sentinel/><duration-on-core ref="9"/><event-count ref="10"/><event-count ref="11"/><size-in-bytes id="22" fmt="196 MiB">205509056</size-in-bytes><size-in-bytes id="23" fmt="155 MiB">162873344</size-in-bytes><size-in-bytes ref="14"/></row>`,
    // amostra 1: o runner de novo, só com referências e um valor novo de RSS
    `<row><start-time id="30" fmt="00:01.000">1000000000</start-time><process ref="2"/><process ref="5"/><duration ref="7"/><pid ref="3"/><process-uid ref="8"/><sentinel/><duration-on-core ref="9"/><event-count ref="10"/><event-count ref="11"/><size-in-bytes ref="12"/><size-in-bytes id="31" fmt="61 MiB">63963136</size-in-bytes><size-in-bytes ref="14"/></row>`,
    `<row><start-time ref="30"/><process id="40" fmt="HagahBible (33997)"><pid id="41" fmt="33997">33997</pid><device-session ref="4"/></process><process ref="5"/><duration ref="7"/><pid ref="41"/><process-uid ref="8"/><sentinel/><duration-on-core ref="9"/><event-count ref="10"/><event-count ref="11"/><size-in-bytes ref="22"/><size-in-bytes ref="23"/><size-in-bytes ref="14"/></row>`,
  ]);

  it('lê colunas e resolve id/ref, inclusive o pid aninhado no process', () => {
    const t = parseXctraceTable(xml);
    assert.deepEqual(t.columns, COLS);
    assert.equal(t.rows.length, 4);
    assert.equal(t.rows[0]?.[t.columns.indexOf('cpu-percent')], null, 'sentinel = sem valor');
    assert.equal(t.rows[2]?.[t.columns.indexOf('pid')]?.text, '34219', 'pid só por ref');
    assert.equal(t.rows[2]?.[t.columns.indexOf('process')]?.fmt, `${RUNNER_EXE} (34219)`);
  });

  it('fica com a última amostra de cada processo', () => {
    const procs = processMemory(parseXctraceTable(xml));
    const runner = procs.find((p) => p.name === RUNNER_EXE);
    assert.equal(runner?.pid, 34219);
    assert.equal(runner?.real, 63963136, 'a amostra 1 vence a 0');
    assert.equal(runner?.footprint, 41943040);
    assert.equal(runner?.threads, 12);
    const sb = procs.find((p) => p.name === 'SpringBoard');
    assert.equal(sb?.real, 162873344);
    assert.deepEqual(relevantProcs(procs, /hagah/i).map((p) => p.name).sort(), ['ContrarregraRunner-Runner', 'HagahBible', 'SpringBoard']);
  });
});

// ── registro do xcodebuild ───────────────────────────────────────────────────────────────────────────

const NORMAL_LOG = [
  'Command line invocation:',
  '2026-10-14 07:29:46.345757-0300 ContrarregraRunner-Runner[34219:2016533] [Default] Running tests...',
  "Test Case '-[ContrarregraRunner.RunnerTests testServe]' started.",
  '    t =     0.00s Start Test at 2026-10-14 07:29:46.874',
  '2026-10-14 07:29:46.878522-0300 ContrarregraRunner-Runner[34219:2016533] [runner] subindo runner',
  'CONTRARREGRA INFO session.hello ok (control)',
  'CONTRARREGRA INFO session.hello ok (control)',
  'CONTRARREGRA INFO session.hello ok (sync)',
  'CONTRARREGRA WARN falha do XCTest registrada e ignorada: No matches found',
].join('\n');

describe('registro do xcodebuild', () => {
  it('subida normal: sem pedido de código, um testServe, PIDs e hellos', () => {
    const s = analyzeSessionLog(NORMAL_LOG);
    assert.equal(s.subidas.length, 1);
    assert.equal(s.subidas[0]?.gapMs, 529);
    assert.equal(s.subidas[0]?.prompt, false);
    assert.equal(s.testServeStarts, 1);
    assert.deepEqual(s.runnerPids, [34219]);
    assert.deepEqual(s.hellos, { control: 2, sync: 1 });
    assert.equal(s.xctestIssues, 1);
  });

  it('o XCTest esperando o código (gap > 5 s) conta como pedido', () => {
    const s = analyzeSessionLog(NORMAL_LOG.replace('Start Test at 2026-10-14 07:29:46.874', 'Start Test at 2026-10-14 07:30:31.000'));
    assert.equal(s.subidas[0]?.prompt, true);
    assert.ok((s.subidas[0]?.gapMs ?? 0) > 44_000);
  });

  it('"Timed out while enabling automation mode" conta como pedido', () => {
    const log = [
      '2026-10-13 22:25:35.159203-0300 ContrarregraRunner-Runner[28845:1725235] [Default] Running tests...',
      '2026-10-13 22:26:35.292201-0300 ContrarregraRunner-Runner[28845:1725235] [Default] Failed to initialize for UI testing: Error Domain=com.apple.dt.XCTest.XCTFuture Code=1000 "Timed out while enabling automation mode."',
      '** TEST EXECUTE FAILED **',
    ].join('\n');
    const s = analyzeSessionLog(log);
    assert.equal(s.subidas.length, 1);
    assert.equal(s.subidas[0]?.prompt, true);
    assert.equal(s.automationTimeouts, 1);
    assert.equal(s.patterns['TEST EXECUTE FAILED'], 1);
    assert.equal(s.testServeStarts, 0);
  });
});

// ── plano ────────────────────────────────────────────────────────────────────────────────────────────

describe('plano', () => {
  it('4 h: as 10 falhas, AC-1.11 ≥ 10 vezes, tudo dentro da janela e espaçado', () => {
    const plan = defaultPlan(4);
    const counts = planCounts(plan);
    for (const kind of ['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10'] as const) assert.ok(counts[kind] >= 1, kind);
    assert.ok(AC111.reduce((n, k) => n + counts[k], 0) >= 10);
    assert.equal(plan.durationMs, 4 * 3600_000);
    const ats = plan.slots.map((s) => s.atMs).sort((a, b) => a - b);
    for (const at of ats) assert.ok(at > 0 && at <= plan.durationMs - 15 * 60_000, 'a última falha ≥ 15 min antes do fim');
    for (let i = 1; i < ats.length; i++) assert.ok((ats[i] as number) - (ats[i - 1] as number) >= 10 * 60_000, 'falhas a ≥ 10 min uma da outra');
    assert.equal(plan.tickMs, 10_000, 'health a cada 10 s (AC-2.8)');
  });

  it('piloto: todas as falhas em < 10 min', () => {
    const plan = pilotPlan();
    const counts = planCounts(plan);
    for (const kind of ['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10'] as const) assert.ok(counts[kind] >= 1, kind);
    assert.ok(plan.durationMs <= 10 * 60_000);
  });
});

describe('miúdos', () => {
  it('inclinação e crescimento pelas bordas', () => {
    const pts = [[0, 10], [1, 12], [2, 14], [3, 16]] as const;
    assert.equal(slope(pts), 2);
    assert.equal(edgeGrowth(pts, 0, 3, 1), 4, 'média de [14,16] − média de [10,12]');
    assert.equal(edgeGrowth([[0, 1]], 0, 10, 2), null);
  });
  it('maior intervalo conta as bordas', () => {
    assert.deepEqual(maxGap([10, 20, 50], 0, 60), { maxGapMs: 30, at: 20 });
    assert.equal(maxGap([], 0, 60).maxGapMs, 60);
  });
  it('Acesso Pessoal e e-mail', () => {
    assert.equal(hotspotActive('en5: inet 172.20.10.2 netmask'), true);
    assert.equal(hotspotActive('en0: inet 192.168.0.4'), false);
    assert.equal(redact('alert "Sign in as fulano.de.tal@icloud.com"'), 'alert "Sign in as <redacted>"');
  });
});

// ── runner falso ─────────────────────────────────────────────────────────────────────────────────────

type Handler = (params: Record<string, unknown>) => Promise<unknown> | unknown;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

class FakeRunner {
  sessions: SessionRef[] = [];
  alive = new Set<string>();
  uptime0 = Date.now();
  laneBusyUntil = 0;
  busyControl = 0;
  fg = 'app.kifactory.hagah';
  calls: string[] = [];
  runnerPid = 100;
  handlers: Record<string, Handler> = {
    health: () => ({ ok: true, uptimeS: Math.round((Date.now() - this.uptime0) / 1000), xctestQueueDepth: 0, treeVersion: 1, foregroundApp: this.fg, locked: false }),
    'clock.ping': (p) => ({ seq: p['seq'], t2RawNs: '1', t3RawNs: '2', t2UptimeNs: '3' }),
    'screen.shot': (p) => {
      if (p['format'] !== undefined && p['format'] !== 'jpeg' && p['format'] !== 'png') {
        const e = new Error('screen.shot: parâmetros inválidos (JSON-RPC -32602)');
        e.name = 'RpcProtocolError';
        (e as Error & { code: number }).code = -32602;
        throw e;
      }
      if (this.fg !== 'app.kifactory.hagah') throw new ContrarregraError('E_FORBIDDEN_APP', 'captura recusada');
      return { image: 'AAAA', format: 'jpeg', widthPx: 390, heightPx: 844, scale: 1 };
    },
    'ui.find': async (p) => {
      if (Date.now() < this.laneBusyUntil) {
        await sleep(10);
        throw new ContrarregraError('E_TIMEOUT', 'na fila', { phase: 'queued' });
      }
      const type = (p['target'] as Json | undefined)?.['type'];
      // Como o runner de verdade: zero candidatos = E_TARGET_NOT_FOUND (S0.2).
      if (type !== 'button') throw new ContrarregraError('E_TARGET_NOT_FOUND', 'nenhum candidato');
      return { candidates: [{}, {}] };
    },
    'ui.tree': () => ({ treeVersion: 1, nodes: ['@e1 button "Play" (1,2 3x4)'] }),
    'ui.tap': () => {
      throw new ContrarregraError('E_TARGET_NOT_FOUND', 'nada');
    },
    'ui.type': () => {
      throw new ContrarregraError('E_NO_FOCUS', 'sem foco');
    },
    'app.activate': (p) => {
      if (p['bundleId'] !== 'app.kifactory.hagah') throw new ContrarregraError('E_FORBIDDEN_APP', 'fora da lista');
      this.fg = 'app.kifactory.hagah';
      return {};
    },
    'app.terminate': () => {
      this.fg = 'com.apple.springboard';
      return {};
    },
    'wait.for': async (p) => {
      const ms = Number(p['timeoutMs']);
      this.laneBusyUntil = Date.now() + ms;
      await sleep(ms);
      throw new ContrarregraError('E_TIMEOUT', 'condição falsa', { phase: 'running' });
    },
  };

  constructor() {
    this.newSession();
  }

  newSession(): SessionRef {
    const n = this.sessions.length + 1;
    const s: SessionRef = { sessionId: `s${n}`, xcodebuildPid: 1000 + n, xctestrun: `/x/s${n}.xctestrun`, log: `/x/s${n}.log`, startedAt: new Date().toISOString() };
    this.sessions.push(s);
    this.alive.add(s.sessionId);
    this.uptime0 = Date.now();
    this.runnerPid += 1;
    return s;
  }

  conn(): Conn {
    return {
      call: async <T,>(method: string, params: Record<string, unknown> = {}): Promise<T> => {
        this.calls.push(method);
        const h = this.handlers[method];
        if (h === undefined) {
          const e = new Error(`${method}: método inexistente (JSON-RPC -32601)`);
          e.name = 'RpcProtocolError';
          (e as Error & { code: number }).code = -32601;
          throw e;
        }
        if (method === 'ui.tap' && params['target'] === undefined) throw new ContrarregraError('E_TARGET_NOT_FOUND', 'sem alvo');
        return (await h(params)) as T;
      },
      close: async () => undefined,
    };
  }
}

interface FakeOpts {
  hotspotAfterMs?: number;
  dieAfterMs?: number;
}

function fakeEnv(runner: FakeRunner, opts: FakeOpts = {}): { env: EnduranceEnv; rows: Row[]; ups: number } {
  const rows: Row[] = [];
  const t0 = Date.now();
  let ups = 0;
  let syncState = 'up';
  let reconnects = 0;
  const killed = new Set<number>();
  const env: EnduranceEnv = {
    now: () => Date.now(),
    sleep,
    write: (k, d = {}) => rows.push({ k, m: Date.now(), ...d }),
    log: () => undefined,
    targetBundle: 'app.kifactory.hagah',
    targetName: /hagah/i,
    session: () => runner.sessions[runner.sessions.length - 1],
    sessionAlive: (s) => runner.alive.has(s.sessionId) && !killed.has(s.xcodebuildPid) && !(opts.dieAfterMs !== undefined && s.sessionId === 's1' && Date.now() - t0 > opts.dieAfterMs),
    openControl: async () => {
      if (runner.busyControl > 0) {
        runner.busyControl--;
        throw new ContrarregraError('E_BUSY', 'control ocupada');
      }
      return runner.conn();
    },
    openSync: async (): Promise<SyncLinkLike> => {
      const c = runner.conn();
      return {
        get state() {
          return syncState;
        },
        get reconnects() {
          return reconnects;
        },
        call: c.call,
        close: c.close,
      };
    },
    severSync: async (forS) => {
      syncState = 'severed';
      setTimeout(() => {
        syncState = 'up';
        reconnects++;
      }, forS * 1000 + 5);
    },
    hotspot: async () => opts.hotspotAfterMs !== undefined && Date.now() - t0 > opts.hotspotAfterMs,
    devicePids: async () => ({ ok: true, dt: 1, runner: [runner.runnerPid], target: [33997] }),
    transport: async () => ({ tt: 'wired', ts: 'connected', dt: 1 }),
    memory: async () => ({ ok: true, ms: 1, procs: [{ name: RUNNER_EXE, pid: runner.runnerPid, footprint: 40e6, real: 60e6 + (Date.now() - t0) * 1000, realPrivate: 30e6, threads: 10, ports: 100, cpuTotalNs: 1 }] }),
    macMem: async (s) => ({ xcodebuildPid: s.xcodebuildPid, xcodebuildKb: 150_000, driverRssMB: 80 }),
    spawnClient: async () => {
      runner.busyControl = 2;
      return { pid: 4242, kill: () => undefined, exited: Promise.resolve() };
    },
    rawProbe: async (step) => ({ outcome: step === 'bad-token' ? 'erro -32001 token' : step === 'garbage' ? 'erro -32700 parse' : 'erro -32001 sem hello', ms: 2 }),
    killPid: (pid) => {
      killed.add(pid);
      runner.runnerPid += 1000; // o runner some do aparelho
    },
    runnerUp: async () => {
      ups++;
      runner.newSession();
      return { ok: true, ms: 7, code: 0, out: 'state: up' };
    },
    readLog: () => NORMAL_LOG,
  };
  return { env, rows, ups };
}

function miniPlan(over: Partial<Plan> = {}): Plan {
  return {
    ...defaultPlan(4),
    name: 'mini',
    durationMs: 400,
    tickMs: 20,
    shotEvery: 2,
    findEvery: 3,
    findOffset: 1,
    treeEvery: 5,
    treeOffset: 2,
    syncPingEveryMs: 30,
    xcbEveryMs: 10,
    pidEveryMs: 50,
    transportEveryMs: 50,
    hotspotEveryMs: 20,
    memEveryMs: 100,
    macMemEveryMs: 50,
    slots: [{ atMs: 100, kinds: ['F1', 'F2', 'F3'] }],
    f10: false,
    severForS: 0.05,
    f5WaitMs: 120,
    hungTicks: 12,
    ...over,
  };
}

function ctxFor(env: EnduranceEnv, plan: Plan, sync?: SyncLinkLike): Ctx {
  const s = env.session() as SessionRef;
  return { plan, session: s, sessions: [s], sync, start: env.now(), inducing: false, dead: undefined, takeover: undefined, stop: undefined, tickFails: 0, lastUptime: undefined, restarts: 0, lastRestore: -Infinity, syncSeq: 0, alertsSeen: new Set() };
}

describe('falhas contra o runner falso', () => {
  it('F1/F3: o erro esperado e o health logo depois (AC-1.11)', async () => {
    const runner = new FakeRunner();
    const { env } = fakeEnv(runner);
    const ctx = ctxFor(env, miniPlan());
    const f1 = await FAILURES.F1(env, ctx);
    assert.equal(f1.ok, true);
    assert.match(f1.got, /^E_TARGET_NOT_FOUND/);
    assert.ok(typeof f1.healthAfterMs === 'number' && f1.healthAfterMs <= CRITERIA.healthAfterMs);
    const f3 = await FAILURES.F3(env, ctx);
    assert.equal(f3.ok, true);
    assert.match(f3.got, /^E_FORBIDDEN_APP/);
  });

  it('F2: com o teclado à vista, não digita (pulada)', async () => {
    const runner = new FakeRunner();
    runner.handlers['ui.find'] = (p) => ({ candidates: (p['target'] as Json)['type'] === 'keyboard' ? [{}] : [] });
    const { env } = fakeEnv(runner);
    const r = await FAILURES.F2(env, ctxFor(env, miniPlan()));
    assert.equal(r.ok, null);
    assert.ok(!runner.calls.includes('ui.type'), 'nada foi digitado');
  });

  it('F2: sem teclado (ui.find → E_TARGET_NOT_FOUND) → E_NO_FOCUS', async () => {
    const runner = new FakeRunner();
    const { env } = fakeEnv(runner);
    const r = await FAILURES.F2(env, ctxFor(env, miniPlan()));
    assert.equal(r.ok, true);
    assert.match(r.got, /^E_NO_FOCUS/);
  });

  it('F4: todos os pedidos inválidos dão erro e o runner segue', async () => {
    const runner = new FakeRunner();
    const { env } = fakeEnv(runner);
    const r = await FAILURES.F4(env, ctxFor(env, miniPlan()));
    assert.equal(r.ok, true, r.got);
    assert.match(String(r.detail?.['unknownMethod']), /^RPC-32601/);
  });

  it('F5: ui.find atrás do wait.for estoura na fila; health segue; fila livre depois', async () => {
    const runner = new FakeRunner();
    const { env } = fakeEnv(runner);
    const r = await FAILURES.F5(env, ctxFor(env, miniPlan()));
    assert.equal(r.ok, true, r.got);
    assert.match(r.got, /ui\.find E_TIMEOUT@queued/);
  });

  it('F6: a sync cortada volta sozinha depois da janela; control intacta', async () => {
    const runner = new FakeRunner();
    const { env } = fakeEnv(runner);
    const sync = await env.openSync();
    const r = await FAILURES.F6(env, ctxFor(env, miniPlan(), sync));
    assert.equal(r.ok, true, r.got);
    assert.ok(typeof r.recoveryMs === 'number');
  });

  it('F7: a vaga de control volta depois do cliente morto', async () => {
    const runner = new FakeRunner();
    const { env } = fakeEnv(runner);
    const r = await FAILURES.F7(env, ctxFor(env, miniPlan()));
    assert.equal(r.ok, true, r.got);
    assert.match(r.got, /E_BUSY 2×/);
  });

  it('F8: captura recusada com o alvo fechado; volta com app.activate', async () => {
    const runner = new FakeRunner();
    const { env } = fakeEnv(runner);
    const r = await FAILURES.F8(env, ctxFor(env, miniPlan()));
    assert.equal(r.ok, true, r.got);
  });
});

describe('laço principal contra o runner falso', () => {
  it('ticks, falhas no horário, F10 e o resumo com o critério', async () => {
    const runner = new FakeRunner();
    const { env, rows } = fakeEnv(runner);
    const r = await runEndurance(env, miniPlan({ f10: true }));
    assert.equal(r.why, 'done');
    assert.equal(r.restarts, 0);
    assert.ok(r.ticks >= 10);
    const kinds = rows.filter((x) => x.k === 'fail').map((x) => x['kind']);
    assert.deepEqual(kinds, ['F1', 'F2', 'F3', 'F10']);
    const f10 = rows.find((x) => x.k === 'fail' && x['kind'] === 'F10');
    assert.equal(f10?.['ok'], true, String(f10?.['got']));
    assert.ok(rows.some((x) => x.k === 'up' && x['why'] === 'F10'));
    assert.ok(rows.some((x) => x.k === 'mem'));
    const alerts = rows.filter((x) => x.k === 'tick' && x['alert'] !== undefined).map((x) => x['alert'] as Json);
    assert.ok(alerts.length > 0 && alerts.every((a) => a['n'] === 0 && a['err'] === undefined), 'sem alerta = n 0, não erro');
    const s = summarize('mini', parseRows(rows.map((x) => JSON.stringify(x)).join('\n')));
    assert.equal(s.restarts.deaths, 0);
    assert.equal(s.criteria.zeroRestarts, true);
    assert.equal(s.ac111.ok, 3);
    assert.equal(s.codePrompts.atSubida, 0);
    assert.equal(s.criteria.rssOk, true);
    assert.equal(s.criteria.ok, true);
    assert.match(markdown(s), /Critério: 0 religamentos SIM/);
  });

  it('runner que cai sozinho: registra, sobe outro e segue; o critério reprova', async () => {
    const runner = new FakeRunner();
    const { env, rows } = fakeEnv(runner, { dieAfterMs: 150 });
    const r = await runEndurance(env, miniPlan());
    assert.equal(r.restarts, 1);
    assert.ok(rows.some((x) => x.k === 'death' && x['spontaneous'] === true));
    assert.ok(rows.some((x) => x.k === 'up' && x['why'] === 'death'));
    const s = summarize('die', rows);
    assert.equal(s.criteria.zeroRestarts, false);
    assert.equal(s.criteria.ok, false);
  });

  it('Acesso Pessoal ligado: para', async () => {
    const runner = new FakeRunner();
    const { env } = fakeEnv(runner, { hotspotAfterMs: 60 });
    const r = await runEndurance(env, miniPlan());
    assert.equal(r.stop, 'hotspot');
  });
});

describe('resumo: critério', () => {
  function rowsWith(memMB: [number, number], extra: Row[] = []): Row[] {
    const t = 1_000_000;
    const mem = (m: number, mb: number): Row => ({ k: 'mem', m, ok: true, ms: 1, procs: [{ name: RUNNER_EXE, pid: 9, real: mb * 1e6, fp: mb * 1e6 }] });
    return [
      { k: 'start', m: t, plan: { name: '4h' }, session: { sessionId: 's1' } },
      mem(t + 1, memMB[0]),
      { k: 'h', m: t + 2, tag: 'tick', s: t + 1, r: t + 2, ms: 1, up: 1 },
      mem(t + 3, memMB[1]),
      ...extra,
      { k: 'window-end', m: t + 10 },
      { k: 'log', m: t + 11, sessionId: 's1', ...analyzeSessionLog(NORMAL_LOG) },
      { k: 'end', m: t + 12, why: 'done' },
    ];
  }

  it('RSS crescendo 120 MB reprova; 30 MB passa', () => {
    assert.equal(summarize('a', rowsWith([60, 180])).criteria.rssOk, false);
    const ok = summarize('b', rowsWith([60, 90]));
    assert.equal(ok.criteria.rssGrowthMB, 30);
    assert.equal(ok.criteria.ok, true);
  });

  it('uptime zerado conta como religamento', () => {
    const s = summarize('c', rowsWith([60, 61], [{ k: 'uptime-reset', m: 1_000_005, from: 100, to: 1 }]));
    assert.equal(s.criteria.zeroRestarts, false);
  });

  it('pedido de código fora da subida reprova', () => {
    const rows = rowsWith([60, 61]);
    const log = rows.find((x) => x.k === 'log') as Row;
    (log['patterns'] as Record<string, number>)['passcode'] = 1;
    const s = summarize('d', rows);
    assert.equal(s.codePrompts.midRunSignals, 1);
    assert.equal(s.criteria.promptsOk, false);
  });
});
