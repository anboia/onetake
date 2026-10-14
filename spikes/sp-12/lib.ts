// Núcleo do driver do SP-12 parte 1 (T-0.30; S1 item 2, SM-5, AC-1.11, AC-2.8): o runner de pé por 4 h no cabo com
// comandos periódicos, 10 tipos de falha induzida, religamentos (PID, `uptimeS`, vida do `xcodebuild`), memória do
// runner (Activity Monitor do `xctrace`) e pedidos de código / "Untrusted Developer" (registro do `xcodebuild`).
// Código de spike, descartável (architecture.md A5). Tudo que toca o aparelho ou o Mac vem por `EnduranceEnv`
// (`sp12.ts` liga ao cliente de produção de `mac/src/runner`, T-0.10), para os testes rodarem sem aparelho.
//
// Nunca usa PX-4 (⏳ Q-5d), nunca liga o modo avião, nunca opera Ajustes, Telefone, Mensagens, Mail, Wallet ou lojas;
// o único app operado é o app alvo (`app.explore`), e só com leituras, `app.activate|terminate` e as falhas abaixo.

import { isContrarregraError } from '../../mac/src/core/errors.ts';
import type { HealthResult } from '../../mac/src/core/types.ts';

export type Json = Record<string, unknown>;

/** O executável do runner no aparelho (o XCTRunner renomeado pelo Xcode). */
export const RUNNER_EXE = 'ContrarregraRunner-Runner';
/** Critério da T-0.30 (Done) e o limite do AC-1.11. */
export const CRITERIA = { restarts: 0, rssGrowthMB: 100, codePromptsMax: 1, healthAfterMs: 200 } as const;
/** Um "pedido de código" na subida: o XCTest espera o código entre "Running tests..." e "Start Test" (normal < 1 s). */
export const PROMPT_GAP_MS = 5_000;
const MB = 1_000_000;

export function r1(x: number | null | undefined): number | null {
  return x === null || x === undefined || !Number.isFinite(x) ? null : Math.round(x * 10) / 10;
}

export function errCode(error: unknown): string {
  if (isContrarregraError(error)) {
    const reason = error.data?.['reason'];
    const phase = error.data?.['phase'];
    return `${error.code}${typeof reason === 'string' ? `/${reason}` : ''}${typeof phase === 'string' ? `@${phase}` : ''}`;
  }
  if (error instanceof Error && error.name === 'RpcProtocolError') return `RPC${String((error as Error & { code?: unknown }).code)}`;
  if (error instanceof Error) return error.message.slice(0, 160);
  return String(error).slice(0, 160);
}

export function hotspotActive(ifconfigText: string): boolean {
  return /\binet 172\.20\.10\./.test(ifconfigText);
}

/** E-mails trocados por `<redacted>` (SP-n.md e saídas de spike não levam a conta Apple). */
export function redact(text: string): string {
  return text.replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '<redacted>');
}

export function quantile(values: readonly number[], q: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? null;
}

// ── xctrace (Activity Monitor) ────────────────────────────────────────────────────────────────────────

export interface XVal {
  tag: string;
  fmt?: string;
  text: string;
}

export interface XTable {
  columns: string[];
  rows: Array<Array<XVal | null>>;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&');
}

function attrs(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of raw.matchAll(/([\w-]+)=(?:"([^"]*)"|'([^']*)')/g)) out[m[1] as string] = decodeEntities(m[2] ?? m[3] ?? '');
  return out;
}

/**
 * Uma tabela do `xctrace export --xpath …/table[@schema=…]`: as colunas (`<mnemonic>`) e as linhas, com as
 * referências do formato resolvidas (um valor aparece uma vez com `id="n"` e depois só como `ref="n"`, inclusive os
 * aninhados, como o `<pid>` dentro de `<process>`). `<sentinel/>` = sem valor.
 */
export function parseXctraceTable(xml: string): XTable {
  const schema = /<schema\b[\s\S]*?<\/schema>/.exec(xml)?.[0] ?? '';
  const columns = [...schema.matchAll(/<mnemonic>([^<]*)<\/mnemonic>/g)].map((m) => m[1] as string);
  const byId = new Map<string, XVal>();
  const rows: Array<Array<XVal | null>> = [];
  const tag = /<(\/?)([A-Za-z][\w.-]*)((?:\s+[\w-]+=(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g;
  for (const rowMatch of xml.matchAll(/<row>([\s\S]*?)<\/row>/g)) {
    const body = rowMatch[1] as string;
    const cells: Array<XVal | null> = [];
    const stack: Array<{ tag: string; a: Record<string, string>; contentStart: number }> = [];
    tag.lastIndex = 0;
    for (let m = tag.exec(body); m !== null; m = tag.exec(body)) {
      const closing = m[1] === '/';
      const name = m[2] as string;
      const a = attrs(m[3] ?? '');
      const selfClosing = m[4] === '/';
      if (!closing && !selfClosing) {
        stack.push({ tag: name, a, contentStart: m.index + m[0].length });
        continue;
      }
      let value: XVal | null;
      if (selfClosing) {
        value = a['ref'] !== undefined ? (byId.get(a['ref']) ?? null) : name === 'sentinel' ? null : { tag: name, ...(a['fmt'] === undefined ? {} : { fmt: a['fmt'] }), text: '' };
        if (a['id'] !== undefined && value !== null) byId.set(a['id'], value);
        if (stack.length === 0) cells.push(value);
        continue;
      }
      const open = stack.pop();
      if (open === undefined || open.tag !== name) continue; // XML fora do formato: ignora a marca
      const inner = body.slice(open.contentStart, m.index);
      value = { tag: name, ...(open.a['fmt'] === undefined ? {} : { fmt: open.a['fmt'] }), text: decodeEntities(inner.replace(/<[^>]*>/g, '').trim()) };
      if (open.a['id'] !== undefined) byId.set(open.a['id'], value);
      if (stack.length === 0) cells.push(value);
    }
    rows.push(cells);
  }
  return { columns, rows };
}

export interface ProcMem {
  name: string;
  pid: number;
  /** `memory-physical-footprint` ("Memory" no Instruments), bytes. */
  footprint: number | null;
  /** `memory-real` ("Real Mem" = RSS), bytes. */
  real: number | null;
  realPrivate: number | null;
  threads: number | null;
  ports: number | null;
  cpuTotalNs: number | null;
}

function num(v: XVal | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v.text);
  return v.text !== '' && Number.isFinite(n) ? n : null;
}

/** A última amostra de cada processo (maior `start`), da tabela `activity-monitor-process-live`. */
export function processMemory(table: XTable): ProcMem[] {
  const col = (name: string): number => table.columns.indexOf(name);
  const iStart = col('start');
  const iProc = col('process');
  const iPid = col('pid');
  const latest = new Map<number, { start: number; mem: ProcMem }>();
  for (const row of table.rows) {
    const proc = row[iProc];
    const fmt = proc?.fmt ?? '';
    const m = /^(.*) \((\d+)\)$/.exec(fmt);
    const pid = num(row[iPid]) ?? (m ? Number(m[2]) : null);
    if (pid === null) continue;
    const name = m ? (m[1] as string) : fmt;
    const start = num(row[iStart]) ?? 0;
    const mem: ProcMem = {
      name,
      pid,
      footprint: num(row[col('memory-physical-footprint')]),
      real: num(row[col('memory-real')]),
      realPrivate: num(row[col('memory-real-private')]),
      threads: num(row[col('thread-count')]),
      ports: num(row[col('mach-port-count')]),
      cpuTotalNs: num(row[col('cpu-total')]),
    };
    const prev = latest.get(pid);
    if (prev === undefined || start >= prev.start) latest.set(pid, { start, mem });
  }
  return [...latest.values()].map((x) => x.mem);
}

/** Os processos que interessam: o runner, o testmanagerd, o SpringBoard e o app alvo (por nome). */
export function relevantProcs(procs: readonly ProcMem[], targetName: RegExp): ProcMem[] {
  return procs.filter((p) => p.name === RUNNER_EXE || p.name === 'testmanagerd' || p.name === 'SpringBoard' || targetName.test(p.name));
}

// ── registro do xcodebuild ────────────────────────────────────────────────────────────────────────────

/** O que procurar no registro da sessão (o runner repassa a saída dele por lá). */
export const LOG_PATTERNS = [
  'Timed out while enabling automation mode',
  'automation mode',
  'Untrusted',
  'not been explicitly trusted',
  'passcode',
  'IDE disconnection',
  'Lost connection',
  'lost connection',
  'Test runner exited',
  'Early unexpected exit',
  'TEST EXECUTE FAILED',
  'Testing failed',
  'crash',
  'CONTRARREGRA ERROR',
  'CONTRARREGRA_FATAL',
] as const;

export interface Subida {
  runningAt: string | null;
  startTestAt: string | null;
  gapMs: number | null;
  /** O XCTest esperou o código (gap > 5 s) ou desistiu de ligar a automação. */
  prompt: boolean;
}

export interface SessionLogSummary {
  runnerPids: number[];
  testServeStarts: number;
  subidas: Subida[];
  automationTimeouts: number;
  /** "falha do XCTest registrada e ignorada" (S1 item 2: `record(_:)` só registra). */
  xctestIssues: number;
  hellos: { control: number; sync: number };
  patterns: Record<string, number>;
  lines: number;
}

/** `2026-10-14 07:29:46.345757-0300` → ms desde a época. */
function parseLogStamp(date: string, time: string, tz: string): number | null {
  const frac = (time.split('.')[1] ?? '0').padEnd(3, '0').slice(0, 3);
  const iso = `${date}T${time.split('.')[0]}.${frac}${tz.slice(0, 3)}:${tz.slice(3)}`;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

export function analyzeSessionLog(text: string): SessionLogSummary {
  const lines = text.split('\n');
  const pids = new Set<number>();
  const subidas: Subida[] = [];
  let pending: { at: number | null; tz: string; iso: string } | undefined;
  const patterns: Record<string, number> = {};
  for (const p of LOG_PATTERNS) patterns[p] = 0;
  let testServeStarts = 0;
  let xctestIssues = 0;
  const hellos = { control: 0, sync: 0 };
  for (const line of lines) {
    for (const m of line.matchAll(new RegExp(`${RUNNER_EXE}\\[(\\d+):`, 'g'))) pids.add(Number(m[1]));
    const running = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}(?:\.\d+)?)([+-]\d{4}) .*\] Running tests\.\.\./.exec(line);
    if (running) {
      if (pending !== undefined) subidas.push({ runningAt: pending.iso, startTestAt: null, gapMs: null, prompt: true });
      const tz = running[3] as string;
      const at = parseLogStamp(running[1] as string, running[2] as string, tz);
      pending = { at, tz, iso: at === null ? `${running[1]} ${running[2]}` : new Date(at).toISOString() };
    }
    const start = /Start Test at (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}(?:\.\d+)?)/.exec(line);
    if (start && pending !== undefined) {
      const at = parseLogStamp(start[1] as string, start[2] as string, pending.tz);
      const gapMs = at !== null && pending.at !== null ? at - pending.at : null;
      subidas.push({ runningAt: pending.iso, startTestAt: at === null ? null : new Date(at).toISOString(), gapMs, prompt: gapMs !== null && gapMs > PROMPT_GAP_MS });
      pending = undefined;
    }
    if (line.includes('Timed out while enabling automation mode') && pending !== undefined) {
      subidas.push({ runningAt: pending.iso, startTestAt: null, gapMs: null, prompt: true });
      pending = undefined;
    }
    if (line.includes("Test Case '-[ContrarregraRunner.RunnerTests testServe]' started")) testServeStarts++;
    if (line.startsWith('CONTRARREGRA WARN falha do XCTest registrada e ignorada')) xctestIssues++;
    if (line.startsWith('CONTRARREGRA INFO session.hello ok (control)')) hellos.control++;
    if (line.startsWith('CONTRARREGRA INFO session.hello ok (sync)')) hellos.sync++;
    for (const p of LOG_PATTERNS) if (line.includes(p)) patterns[p] = (patterns[p] ?? 0) + 1;
  }
  if (pending !== undefined) subidas.push({ runningAt: pending.iso, startTestAt: null, gapMs: null, prompt: false });
  return {
    runnerPids: [...pids],
    testServeStarts,
    subidas,
    automationTimeouts: patterns['Timed out while enabling automation mode'] ?? 0,
    xctestIssues,
    hellos,
    patterns,
    lines: lines.length,
  };
}

// ── plano ─────────────────────────────────────────────────────────────────────────────────────────────

export type FailureKind = 'F1' | 'F2' | 'F3' | 'F4' | 'F5' | 'F6' | 'F7' | 'F8' | 'F9' | 'F10';

export const FAILURE_TITLES: Record<FailureKind, string> = {
  F1: 'alvo inexistente (`ui.tap`)',
  F2: '`typeText` sem foco (`ui.type`)',
  F3: 'bundle id falso (`app.activate`)',
  F4: 'pedido inválido (método, parâmetros, JSON, sem hello, token errado)',
  F5: '`E_TIMEOUT` na fila do XCTest (`wait.for` 15 s + `ui.find`)',
  F6: '`runner sever --for 30` (corte da `sync` pelo SIGUSR1) e reconexão usbmux',
  F7: 'cliente morto (SIGKILL) com `control` aberta',
  F8: 'app alvo encerrado (`app.terminate`) e reaberto',
  F9: 'cliente morto no meio de uma resposta grande (`screen.shot` PNG nativo)',
  F10: '`xcodebuild` morto (SIGKILL) e `runner up` de novo',
};

/** As falhas do AC-1.11 (falhas do XCTest nomeadas). */
export const AC111: readonly FailureKind[] = ['F1', 'F2', 'F3'];

export interface Slot {
  atMs: number;
  kinds: FailureKind[];
}

export interface Plan {
  name: string;
  durationMs: number;
  tickMs: number;
  /** Extras dos ticks (a cada n ticks, com deslocamento). */
  shotEvery: number;
  findEvery: number;
  findOffset: number;
  treeEvery: number;
  treeOffset: number;
  syncPingEveryMs: number;
  xcbEveryMs: number;
  pidEveryMs: number;
  transportEveryMs: number;
  hotspotEveryMs: number;
  memEveryMs: number;
  macMemEveryMs: number;
  slots: Slot[];
  /** F10 depois da janela. */
  f10: boolean;
  severForS: number;
  f5WaitMs: number;
  /** Ticks seguidos sem resposta com o `xcodebuild` vivo = runner pendurado (2 min). */
  hungTicks: number;
}

const MIN = 60_000;

/** 4 h: trio do AC-1.11 a cada 30 min a partir dos 15; F4…F9 nos minutos 25, 55, …, 175; F10 depois da janela. */
export function defaultPlan(hours = 4): Plan {
  const durationMs = hours * 60 * MIN;
  const slots: Slot[] = [];
  for (let m = 15; m * MIN < durationMs; m += 30) slots.push({ atMs: m * MIN, kinds: [...AC111] });
  const singles: FailureKind[] = ['F4', 'F5', 'F6', 'F7', 'F8', 'F9'];
  singles.forEach((kind, i) => {
    const at = (25 + 30 * i) * MIN;
    if (at < durationMs) slots.push({ atMs: at, kinds: [kind] });
  });
  slots.sort((a, b) => a.atMs - b.atMs);
  return {
    name: `${hours}h`,
    durationMs,
    tickMs: 10_000,
    shotEvery: 6,
    findEvery: 6,
    findOffset: 3,
    treeEvery: 30,
    treeOffset: 15,
    syncPingEveryMs: 10_000,
    xcbEveryMs: 5_000,
    pidEveryMs: 60_000,
    transportEveryMs: 60_000,
    hotspotEveryMs: 60_000,
    memEveryMs: 5 * MIN,
    macMemEveryMs: 60_000,
    slots,
    f10: true,
    severForS: 30,
    f5WaitMs: 15_000,
    hungTicks: 12,
  };
}

/** Piloto (~9 min): todas as falhas em seguida, para provar o caminho antes das 4 h. */
export function pilotPlan(): Plan {
  const p = defaultPlan(4);
  return {
    ...p,
    name: 'pilot',
    durationMs: 8 * MIN,
    treeEvery: 12,
    treeOffset: 2,
    memEveryMs: 3 * MIN,
    slots: [
      { atMs: 0.5 * MIN, kinds: [...AC111] },
      { atMs: 1.5 * MIN, kinds: ['F4'] },
      { atMs: 2.5 * MIN, kinds: ['F5'] },
      { atMs: 3.5 * MIN, kinds: ['F6'] },
      { atMs: 5 * MIN, kinds: ['F7'] },
      { atMs: 5.75 * MIN, kinds: ['F8'] },
      { atMs: 6.75 * MIN, kinds: ['F9'] },
    ],
  };
}

export function planCounts(plan: Plan): Record<FailureKind, number> {
  const counts = { F1: 0, F2: 0, F3: 0, F4: 0, F5: 0, F6: 0, F7: 0, F8: 0, F9: 0, F10: plan.f10 ? 1 : 0 } as Record<FailureKind, number>;
  for (const slot of plan.slots) for (const k of slot.kinds) counts[k]++;
  return counts;
}

// ── ambiente ──────────────────────────────────────────────────────────────────────────────────────────

export interface Conn {
  call<T = unknown>(method: string, params?: Record<string, unknown>, options?: { timeoutMs?: number }): Promise<T>;
  close(): Promise<void>;
}

export interface SyncLinkLike extends Conn {
  readonly state: string;
  readonly reconnects: number;
}

export interface SessionRef {
  sessionId: string;
  xcodebuildPid: number;
  xctestrun: string;
  log: string;
  startedAt: string;
}

export interface Spawned {
  readonly pid: number;
  kill(): void;
  readonly exited: Promise<unknown>;
}

export type RawStep = 'garbage' | 'no-hello' | 'bad-token';

export interface MemSample {
  ok: boolean;
  ms: number;
  err?: string;
  procs: ProcMem[];
}

export interface PidSample {
  ok: boolean;
  dt: number;
  runner: number[];
  target: number[];
  err?: string;
}

export interface UpResult {
  ok: boolean;
  ms: number;
  code: number | null;
  out: string;
}

export interface EnduranceEnv {
  /** Relógio de parede em ms (contínuo). */
  now(): number;
  sleep(ms: number): Promise<void>;
  write(k: string, data?: Json): void;
  log(line: string): void;
  /** `app.explore`. */
  targetBundle: string;
  targetName: RegExp;
  /** A sessão mais recente no disco. */
  session(): SessionRef | undefined;
  sessionAlive(s: SessionRef): boolean;
  openControl(): Promise<Conn>;
  openSync(): Promise<SyncLinkLike>;
  /** O caminho do `runner sever` (S2 item 8): `sever.json {forS}` + SIGUSR1 a este processo → a `sync` aberta. */
  severSync(forS: number): Promise<void>;
  hotspot(): Promise<boolean>;
  devicePids(): Promise<PidSample>;
  transport(): Promise<{ tt: string | null; ts: string | null; dt: number }>;
  memory(): Promise<MemSample>;
  macMem(s: SessionRef): Promise<Json>;
  /** Um processo filho com `control` aberta: `idle` resolve com ela aberta; `bigshot` depois de pedir o PNG nativo. */
  spawnClient(mode: 'idle' | 'bigshot'): Promise<Spawned>;
  rawProbe(step: RawStep): Promise<{ outcome: string; ms: number }>;
  killPid(pid: number): void;
  runnerUp(): Promise<UpResult>;
  readLog(path: string): string | undefined;
}

export class StopError extends Error {
  readonly kind: 'hotspot' | 'takeover' | 'up-failed' | 'no-session' | 'signal';
  constructor(kind: StopError['kind'], message: string) {
    super(message);
    this.kind = kind;
  }
}

/** Estado compartilhado do laço (mutável). */
export interface Ctx {
  plan: Plan;
  session: SessionRef;
  sessions: SessionRef[];
  sync: SyncLinkLike | undefined;
  start: number;
  /** Religamento induzido ou recuperação em curso: o vigia não marca morte nem troca de sessão. */
  inducing: boolean;
  dead: string | undefined;
  takeover: string | undefined;
  stop: StopError | undefined;
  tickFails: number;
  lastUptime: number | undefined;
  restarts: number;
  lastRestore: number;
  syncSeq: number;
  alertsSeen: Set<string>;
}

function sessionRow(s: SessionRef): Json {
  return { sessionId: s.sessionId, xcodebuildPid: s.xcodebuildPid, log: s.log, startedAt: s.startedAt };
}

export interface HealthProbe {
  h: HealthResult;
  /** RTT do `health` no Mac. */
  ms: number;
}

/** `health` registrado (linha `h`): toda resposta conta para o maior intervalo sem resposta (AC-2.8). */
export async function health(env: EnduranceEnv, ctx: Ctx, conn: Conn, tag: string, timeoutMs = 2_000): Promise<HealthProbe | undefined> {
  const s = env.now();
  try {
    const h = await conn.call<HealthResult>('health', {}, { timeoutMs });
    const r = env.now();
    const row: Json = { tag, s, r, ms: r1(r - s), up: h.uptimeS, q: h.xctestQueueDepth, fg: h.foregroundApp, lk: h.locked };
    if (ctx.lastUptime !== undefined && h.uptimeS + 2 < ctx.lastUptime && !ctx.inducing) {
      env.write('uptime-reset', { from: ctx.lastUptime, to: h.uptimeS, tag });
    }
    ctx.lastUptime = h.uptimeS;
    env.write('h', row);
    return { h, ms: r1(r - s) ?? 0 };
  } catch (error) {
    env.write('h', { tag, s, f: env.now(), err: errCode(error) });
    return undefined;
  }
}

async function timed<T>(env: EnduranceEnv, fn: () => Promise<T>): Promise<{ ok: true; ms: number; value: T } | { ok: false; ms: number; err: string; error: unknown }> {
  const s = env.now();
  try {
    const value = await fn();
    return { ok: true, ms: r1(env.now() - s) ?? 0, value };
  } catch (error) {
    return { ok: false, ms: r1(env.now() - s) ?? 0, err: errCode(error), error };
  }
}

async function withControl<T>(env: EnduranceEnv, fn: (c: Conn) => Promise<T>): Promise<T> {
  const c = await env.openControl();
  try {
    return await fn(c);
  } finally {
    await c.close().catch(() => undefined);
  }
}

// ── tick (comandos periódicos, SM-5 / AC-2.8) ─────────────────────────────────────────────────────────

interface FindResult {
  candidates?: unknown[];
}

/** O alerta à frente (se houver), lido pela árvore compacta: as linhas a partir do nó `alert`, sem e-mails. */
async function describeAlert(env: EnduranceEnv, conn: Conn): Promise<string[]> {
  const tree = await timed(env, () => conn.call<{ nodes?: unknown }>('ui.tree', { format: 'compact' }, { timeoutMs: 12_000 }));
  if (!tree.ok || !Array.isArray(tree.value.nodes)) return [`(árvore ilegível: ${tree.ok ? 'sem nodes' : tree.err})`];
  const lines = (tree.value.nodes as unknown[]).map(String);
  const i = lines.findIndex((l) => /^\s*@e\d+ alert\b/.test(l));
  return (i < 0 ? lines.slice(0, 8) : lines.slice(i, i + 12)).map((l) => redact(l).slice(0, 160));
}

async function restoreTarget(env: EnduranceEnv, ctx: Ctx, conn: Conn, why: string): Promise<void> {
  if (env.now() - ctx.lastRestore < 5 * MIN) return;
  ctx.lastRestore = env.now();
  const r = await timed(env, () => conn.call('app.activate', { bundleId: env.targetBundle }, { timeoutMs: 20_000 }));
  env.write('restore', { why, ok: r.ok, ms: r.ms, ...(r.ok ? {} : { err: r.err }) });
}

export async function tick(env: EnduranceEnv, ctx: Ctx, i: number): Promise<void> {
  const plan = ctx.plan;
  const s = env.now();
  const row: Json = { i, s };
  let conn: Conn | undefined;
  try {
    conn = await env.openControl();
    row['helloMs'] = r1(env.now() - s);
    const hp = await health(env, ctx, conn, 'tick');
    if (hp === undefined) throw new Error('health falhou');
    const h = hp.h;
    const c = conn;
    if (i % plan.shotEvery === 0) {
      const shot = await timed(env, () => c.call<{ image?: string; widthPx?: number }>('screen.shot', { format: 'jpeg', scale: 'points' }, { timeoutMs: 8_000 }));
      row['shot'] = shot.ok ? { ms: shot.ms, bytes: Math.round(((shot.value.image ?? '').length * 3) / 4), w: shot.value.widthPx ?? null } : { ms: shot.ms, err: shot.err };
      if (!shot.ok && shot.err.startsWith('E_FORBIDDEN_APP') && h.foregroundApp !== env.targetBundle) await restoreTarget(env, ctx, c, `fg=${h.foregroundApp}`);
    }
    if (i % plan.findEvery === plan.findOffset) {
      const find = await timed(env, () => c.call<FindResult>('ui.find', { target: { type: 'button' } }, { timeoutMs: 12_000 }));
      row['find'] = find.ok ? { ms: find.ms, n: find.value.candidates?.length ?? null } : { ms: find.ms, err: find.err };
      const alert = await timed(env, () => c.call<FindResult>('ui.find', { target: { type: 'alert' } }, { timeoutMs: 12_000 }));
      // Sem alerta, `ui.find` responde E_TARGET_NOT_FOUND (S0.2): conta como 0.
      row['alert'] = alert.ok
        ? { ms: alert.ms, n: alert.value.candidates?.length ?? null }
        : alert.err.startsWith('E_TARGET_NOT_FOUND')
          ? { ms: alert.ms, n: 0 }
          : { ms: alert.ms, err: alert.err };
      if (alert.ok && (alert.value.candidates?.length ?? 0) > 0) {
        const lines = await describeAlert(env, c);
        const key = lines.join('|');
        if (!ctx.alertsSeen.has(key)) {
          ctx.alertsSeen.add(key);
          env.write('alert', { lines, n: alert.value.candidates?.length ?? null });
        }
      }
    }
    if (i % plan.treeEvery === plan.treeOffset) {
      const tree = await timed(env, () => c.call<{ nodes?: unknown; treeVersion?: number }>('ui.tree', { format: 'compact' }, { timeoutMs: 12_000 }));
      row['tree'] = tree.ok
        ? { ms: tree.ms, n: Array.isArray(tree.value.nodes) ? tree.value.nodes.length : null, v: tree.value.treeVersion ?? null }
        : { ms: tree.ms, err: tree.err };
    }
    ctx.tickFails = 0;
  } catch (error) {
    row['err'] = errCode(error);
    ctx.tickFails++;
  } finally {
    await conn?.close().catch(() => undefined);
    row['ms'] = r1(env.now() - s);
    env.write('tick', row);
  }
}

// ── falhas induzidas ──────────────────────────────────────────────────────────────────────────────────

export interface FailResult {
  /** `null` = não induzida (pulada, com o motivo em `got`). */
  ok: boolean | null;
  expect: string;
  got: string;
  /** Do pedido até a resposta de erro. */
  ms?: number | null;
  /** RTT do primeiro `health` logo depois da falha, na mesma conexão (AC-1.11: ≤ 200 ms). */
  healthAfterMs?: number | null;
  /** Até o runner voltar a servir como antes (quando faz sentido). */
  recoveryMs?: number | null;
  detail?: Json;
}

async function expectError(env: EnduranceEnv, ctx: Ctx, kind: string, expect: string, call: (c: Conn) => Promise<unknown>): Promise<FailResult> {
  return withControl(env, async (c) => {
    const r = await timed(env, () => call(c));
    const got = r.ok ? 'ok (sem erro)' : r.err;
    const hp = await health(env, ctx, c, `${kind}-after`);
    return { ok: !r.ok && got.startsWith(expect), expect, got, ms: r.ms, healthAfterMs: hp?.ms ?? null };
  });
}

export const FAILURES: Record<FailureKind, (env: EnduranceEnv, ctx: Ctx) => Promise<FailResult>> = {
  // AC-1.11: alvo inexistente. O runner resolve o alvo antes de agir (S0.2): nada é tocado.
  F1: (env, ctx) => expectError(env, ctx, 'F1', 'E_TARGET_NOT_FOUND', (c) => c.call('ui.tap', { target: { label: 'sp12-alvo-inexistente' } }, { timeoutMs: 20_000 })),

  // AC-1.11: typeText sem foco. Só digita se nada tiver foco; com o teclado à vista, não induz (nada vai para o app).
  F2: (env, ctx) =>
    withControl(env, async (c) => {
      // `ui.find` sem candidato responde E_TARGET_NOT_FOUND (S0.2): aí não há teclado.
      const kb = await timed(env, () => c.call<FindResult>('ui.find', { target: { type: 'keyboard' } }, { timeoutMs: 12_000 }));
      if (!kb.ok && !kb.err.startsWith('E_TARGET_NOT_FOUND')) return { ok: null, expect: 'E_NO_FOCUS', got: `pulada: teclado ilegível (${kb.err})` };
      if (kb.ok && (kb.value.candidates?.length ?? 0) > 0) return { ok: null, expect: 'E_NO_FOCUS', got: 'pulada: teclado à vista (algo tem foco)' };
      const r = await timed(env, () => c.call('ui.type', { text: 'sp12' }, { timeoutMs: 20_000 }));
      const got = r.ok ? 'ok (DIGITOU)' : r.err;
      const hp = await health(env, ctx, c, 'F2-after');
      return { ok: !r.ok && got.startsWith('E_NO_FOCUS'), expect: 'E_NO_FOCUS', got, ms: r.ms, healthAfterMs: hp?.ms ?? null };
    }),

  // AC-1.11: bundle id falso.
  F3: (env, ctx) => expectError(env, ctx, 'F3', 'E_FORBIDDEN_APP', (c) => c.call('app.activate', { bundleId: 'app.kifactory.sp12.inexistente' }, { timeoutMs: 20_000 })),

  // Pedidos inválidos: na conexão autenticada e em conexões cruas (sem o cliente de produção).
  F4: async (env, ctx) => {
    const detail: Json = {};
    let allErrored = true;
    const res = await withControl(env, async (c) => {
      for (const [name, method, params] of [
        ['unknownMethod', 'sp12.metodoInexistente', {}],
        ['missingTarget', 'ui.tap', {}],
        ['badFormat', 'screen.shot', { format: 'gif' }],
      ] as const) {
        const r = await timed(env, () => c.call(method, params as Record<string, unknown>, { timeoutMs: 10_000 }));
        detail[name] = r.ok ? 'ok (sem erro)' : `${r.err} (${r.ms} ms)`;
        if (r.ok) allErrored = false;
      }
      const hp = await health(env, ctx, c, 'F4-after');
      return hp?.ms ?? null;
    });
    for (const step of ['garbage', 'no-hello', 'bad-token'] as const) {
      const r = await timed(env, () => env.rawProbe(step));
      detail[step] = r.ok ? `${r.value.outcome} (${r.value.ms} ms)` : `falhou: ${r.err}`;
      if (r.ok && /^result/.test(r.value.outcome)) allErrored = false;
    }
    const post = await withControl(env, (c) => health(env, ctx, c, 'F4-post'));
    return {
      ok: allErrored && post !== undefined,
      expect: 'erro em todos; runner segue',
      got: Object.values(detail).join(' · '),
      healthAfterMs: res,
      detail,
    };
  },

  // E_TIMEOUT "na fila": um `wait.for` que nunca fica verdadeiro segura a fila do XCTest por 15 s; um `ui.find`
  // atrás dele estoura os 10 s ainda na fila (= não acontece). `health` a 5 Hz durante (AC-1.12).
  F5: (env, ctx) =>
    withControl(env, async (c) => {
      const waitMs = ctx.plan.f5WaitMs;
      const s = env.now();
      const wait = timed(env, () => c.call('wait.for', { condition: { network: 'offline' }, timeoutMs: waitMs }, { timeoutMs: waitMs + 15_000 }));
      await env.sleep(Math.min(500, waitMs / 4));
      const findS = env.now();
      const find = timed(env, () => c.call('ui.find', { target: { type: 'button' } }, { timeoutMs: 30_000 }));
      let done = false;
      void Promise.allSettled([wait, find]).then(() => (done = true));
      const rtts: number[] = [];
      let healthFails = 0;
      while (!done && env.now() - s < waitMs + 20_000) {
        const hp = await health(env, ctx, c, 'F5-during', 1_000);
        if (hp === undefined) healthFails++;
        else rtts.push(hp.ms);
        await env.sleep(200);
      }
      const [w, f] = await Promise.all([wait, find]);
      const findAt = r1(env.now() - findS);
      const after = await timed(env, () => c.call<FindResult>('ui.find', { target: { type: 'button' } }, { timeoutMs: 12_000 }));
      const got = `wait.for ${w.ok ? 'ok' : w.err} (${w.ms} ms) · ui.find ${f.ok ? 'ok' : f.err} (${f.ms} ms) · depois ui.find ${after.ok ? 'ok' : after.err} (${after.ms} ms)`;
      return {
        ok: !f.ok && f.err.startsWith('E_TIMEOUT') && f.err.includes('@queued') && after.ok && healthFails === 0,
        expect: 'ui.find E_TIMEOUT@queued; health ≤ 200 ms durante; fila livre depois',
        got,
        ms: f.ms,
        healthAfterMs: rtts.length ? Math.max(...rtts) : null,
        recoveryMs: after.ok ? r1(w.ms + after.ms) : null,
        detail: { healthDuring: { n: rtts.length, p50: r1(quantile(rtts, 0.5)), max: r1(rtts.length ? Math.max(...rtts) : null), fails: healthFails }, findAt },
      };
    }),

  // `runner sever --for N` (S2 item 8) na `sync`: fecha os sockets usbmux e não reconecta por N s; depois a linha se
  // refaz sozinha (S2 item 6). A `control` por comando segue a 1 Hz durante.
  F6: async (env, ctx) => {
    const link = ctx.sync;
    if (link === undefined || link.state !== 'up') return { ok: null, expect: 'sync de pé', got: `pulada: sync ${link?.state ?? 'ausente'}` };
    const forS = ctx.plan.severForS;
    const rc0 = link.reconnects;
    const s = env.now();
    await env.severSync(forS);
    let severedAt: number | null = null;
    let upAt: number | null = null;
    const controlRtts: number[] = [];
    let controlFails = 0;
    let lastControl = 0;
    while (env.now() - s < (forS + 30) * 1000) {
      if (severedAt === null && link.state !== 'up') severedAt = env.now();
      if (severedAt !== null && link.state === 'up' && link.reconnects > rc0) {
        upAt = env.now();
        break;
      }
      if (env.now() - lastControl >= 1_000) {
        lastControl = env.now();
        const r = await timed(env, () => withControl(env, (c) => health(env, ctx, c, 'F6-control')));
        if (r.ok && r.value !== undefined) controlRtts.push(r.value.ms);
        else controlFails++;
      }
      await env.sleep(100);
    }
    const ping = upAt === null ? null : await timed(env, () => link.call('clock.ping', { seq: 900_000 }, { timeoutMs: 2_000 }));
    const reconnectAfterWindowMs = upAt === null ? null : r1(upAt - s - forS * 1000);
    return {
      ok: upAt !== null && ping?.ok === true && controlFails === 0,
      expect: `sync volta sozinha logo depois de ${forS} s; control intacta`,
      got: `cortada em ${severedAt === null ? '—' : r1(severedAt - s)} ms; de pé de novo ${reconnectAfterWindowMs === null ? 'NÃO' : `${reconnectAfterWindowMs} ms depois da janela`}; clock.ping ${ping === null ? '—' : ping.ok ? 'ok' : ping.err}; control ${controlRtts.length} ok / ${controlFails} falhas`,
      recoveryMs: reconnectAfterWindowMs,
      healthAfterMs: controlRtts.length ? Math.max(...controlRtts) : null,
      detail: { forS, reconnects: link.reconnects - rc0, controlMaxMs: r1(controlRtts.length ? Math.max(...controlRtts) : null) },
    };
  },

  // Cliente morto com a `control` aberta: o runner libera a vaga? Em quanto tempo?
  F7: (env, ctx) => killedClient(env, ctx, 'idle'),

  // App alvo encerrado: a captura é recusada com o SpringBoard à frente (S1 item 11); `app.activate` o traz de volta.
  F8: (env, ctx) =>
    withControl(env, async (c) => {
      const s = env.now();
      const term = await timed(env, () => c.call('app.terminate', { bundleId: env.targetBundle }, { timeoutMs: 20_000 }));
      const shot = await timed(env, () => c.call('screen.shot', { format: 'jpeg', scale: 'points' }, { timeoutMs: 8_000 }));
      const hp = await health(env, ctx, c, 'F8-after');
      const act = await timed(env, () => c.call('app.activate', { bundleId: env.targetBundle }, { timeoutMs: 30_000 }));
      let back: number | null = null;
      for (let k = 0; k < 40 && back === null; k++) {
        const r = await timed(env, () => c.call('screen.shot', { format: 'jpeg', scale: 'points' }, { timeoutMs: 8_000 }));
        if (r.ok) back = env.now();
        else await env.sleep(500);
      }
      return {
        ok: term.ok && !shot.ok && shot.err.startsWith('E_FORBIDDEN_APP') && back !== null,
        expect: 'captura E_FORBIDDEN_APP com o alvo fechado; volta com app.activate',
        got: `terminate ${term.ok ? 'ok' : term.err} (${term.ms} ms) · shot ${shot.ok ? 'ok' : shot.err} · fg=${hp?.h.foregroundApp ?? '?'} · activate ${act.ok ? 'ok' : act.err} (${act.ms} ms) · captura de volta ${back === null ? 'NÃO' : `${r1(back - s)} ms`}`,
        ms: term.ms,
        healthAfterMs: hp?.ms ?? null,
        recoveryMs: back === null ? null : r1(back - s),
      };
    }),

  // Cliente morto no meio de uma resposta grande (o runner escreve num socket sem leitor).
  F9: (env, ctx) => killedClient(env, ctx, 'bigshot'),

  F10: (env, ctx) => killXcodebuild(env, ctx),
};

async function killedClient(env: EnduranceEnv, ctx: Ctx, mode: 'idle' | 'bigshot'): Promise<FailResult> {
  const child = await env.spawnClient(mode);
  const killAt = env.now();
  child.kill();
  await child.exited;
  let busy = 0;
  let other = 0;
  let freedAt: number | null = null;
  let healthAfter: number | null = null;
  let shotOk: string | null = null;
  const lastErr: string[] = [];
  while (env.now() - killAt < 60_000) {
    const r = await timed(env, () => env.openControl());
    if (r.ok) {
      freedAt = env.now();
      const c = r.value;
      try {
        const hp = await health(env, ctx, c, `${mode === 'idle' ? 'F7' : 'F9'}-after`);
        healthAfter = hp?.ms ?? null;
        const shot = await timed(env, () => c.call('screen.shot', { format: 'jpeg', scale: 'points' }, { timeoutMs: 8_000 }));
        shotOk = shot.ok ? `ok (${shot.ms} ms)` : shot.err;
      } finally {
        await c.close().catch(() => undefined);
      }
      break;
    }
    if (r.err.startsWith('E_BUSY')) busy++;
    else other++;
    if (lastErr.length < 3 && !lastErr.includes(r.err)) lastErr.push(r.err);
    await env.sleep(250);
  }
  return {
    ok: freedAt !== null && shotOk !== null && shotOk.startsWith('ok'),
    expect: 'a vaga de control volta; captura ok',
    got: `vaga de volta ${freedAt === null ? 'NÃO (60 s)' : `${r1(freedAt - killAt)} ms`} (E_BUSY ${busy}×, outros ${other}×${lastErr.length ? `: ${lastErr.join(', ')}` : ''}); captura depois ${shotOk ?? '—'}`,
    recoveryMs: freedAt === null ? null : r1(freedAt - killAt),
    healthAfterMs: healthAfter,
    detail: { mode, childPid: child.pid, busy, other },
  };
}

/** Sobe um runner novo (F10, morte espontânea ou runner pendurado): sessão nova, `sync` nova, app alvo à frente. */
export async function freshRunner(env: EnduranceEnv, ctx: Ctx, why: string): Promise<{ up: UpResult; session: SessionRef | undefined }> {
  ctx.inducing = true;
  try {
    await ctx.sync?.close().catch(() => undefined);
    ctx.sync = undefined;
    const up = await env.runnerUp();
    const session = env.session();
    env.write('up', { why, ...up, sessionId: session?.sessionId ?? null, xcodebuildPid: session?.xcodebuildPid ?? null });
    if (!up.ok || session === undefined || !env.sessionAlive(session)) return { up, session: undefined };
    ctx.session = session;
    ctx.sessions.push(session);
    ctx.lastUptime = undefined;
    ctx.dead = undefined;
    ctx.tickFails = 0;
    env.write('session', sessionRow(session));
    await activateTarget(env, ctx);
    try {
      ctx.sync = await env.openSync();
    } catch (error) {
      env.write('sync-open', { ok: false, err: errCode(error) });
    }
    return { up, session };
  } finally {
    ctx.inducing = false;
  }
}

async function activateTarget(env: EnduranceEnv, ctx: Ctx): Promise<void> {
  const r = await timed(env, () => withControl(env, async (c) => {
    await c.call('app.activate', { bundleId: env.targetBundle }, { timeoutMs: 30_000 });
    return health(env, ctx, c, 'activate');
  }));
  env.write('activate', { ok: r.ok, ms: r.ms, ...(r.ok ? { fg: r.value?.h.foregroundApp ?? null } : { err: r.err }) });
}

async function killXcodebuild(env: EnduranceEnv, ctx: Ctx): Promise<FailResult> {
  const old = ctx.session;
  const pidsBefore = await env.devicePids();
  ctx.inducing = true;
  const s = env.now();
  env.killPid(old.xcodebuildPid);
  let xcbGone: number | null = null;
  while (env.now() - s < 15_000) {
    if (!env.sessionAlive(old)) {
      xcbGone = env.now();
      break;
    }
    await env.sleep(100);
  }
  const ctl = await timed(env, () => env.openControl());
  if (ctl.ok) await ctl.value.close().catch(() => undefined);
  let runnerGone: number | null = null;
  const oldRunner = pidsBefore.runner;
  for (let k = 0; k < 45 && runnerGone === null; k++) {
    const p = await env.devicePids();
    if (p.ok && !p.runner.some((pid) => oldRunner.includes(pid))) runnerGone = env.now();
    else await env.sleep(2_000);
  }
  const { up, session } = await freshRunner(env, ctx, 'F10');
  let healthAfter: number | null = null;
  let pidsAfter: PidSample | null = null;
  if (session !== undefined) {
    const h = await timed(env, () => withControl(env, (c) => health(env, ctx, c, 'F10-after')));
    healthAfter = h.ok ? (h.value?.ms ?? null) : null;
    pidsAfter = await env.devicePids();
  }
  return {
    ok: up.ok && session !== undefined && healthAfter !== null,
    expect: 'E_RUNNER_DOWN na hora; runner up de novo de pé',
    got: `xcodebuild fora em ${xcbGone === null ? 'NÃO' : `${r1(xcbGone - s)} ms`}; control ${ctl.ok ? 'ABRIU' : ctl.err}; runner some do aparelho em ${runnerGone === null ? 'NÃO (90 s)' : `${r1(runnerGone - s)} ms`}; runner up ${up.ok ? `ok em ${up.ms} ms` : `FALHOU (${up.code})`}; PID ${JSON.stringify(oldRunner)} → ${JSON.stringify(pidsAfter?.runner ?? null)}`,
    recoveryMs: up.ok ? r1(env.now() - s) : null,
    healthAfterMs: healthAfter,
    detail: { oldSession: old.sessionId, newSession: session?.sessionId ?? null, upOut: up.out.slice(-600) },
  };
}

export async function runFailure(env: EnduranceEnv, ctx: Ctx, kind: FailureKind, n: number): Promise<FailResult> {
  const s = env.now();
  env.write('fail-start', { kind, n, s });
  env.log(`falha ${kind} #${n}: ${FAILURE_TITLES[kind]}`);
  let res: FailResult;
  try {
    res = await FAILURES[kind](env, ctx);
  } catch (error) {
    res = { ok: false, expect: '?', got: `exceção: ${errCode(error)}` };
  }
  env.write('fail', { kind, n, s, e: env.now(), ...res });
  env.log(`falha ${kind} #${n}: ${res.ok === null ? 'pulada' : res.ok ? 'ok' : 'NÃO OK'} — ${res.got}`);
  return res;
}

// ── laço principal ────────────────────────────────────────────────────────────────────────────────────

class Mutex {
  #tail: Promise<void> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(fn, fn);
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

class Loops {
  #stopped = false;
  #running = new Set<Promise<void>>();
  readonly env: EnduranceEnv;
  constructor(env: EnduranceEnv) {
    this.env = env;
  }
  every(ms: number, fn: () => Promise<void> | void): void {
    const loop = (async () => {
      let next = this.env.now();
      while (!this.#stopped) {
        try {
          await fn();
        } catch (error) {
          this.env.write('loop-error', { err: errCode(error) });
        }
        next += ms;
        while (!this.#stopped && this.env.now() < next) await this.env.sleep(Math.min(250, next - this.env.now()));
      }
    })();
    this.#running.add(loop);
  }
  async stop(): Promise<void> {
    this.#stopped = true;
    await Promise.allSettled([...this.#running]);
  }
}

export interface RunResult {
  why: string;
  stop?: StopError['kind'];
  restarts: number;
  ticks: number;
  failures: number;
}

/** O laço: ticks a cada `tickMs`, falhas nos horários do plano, vigias em paralelo; F10 depois da janela. */
export async function runEndurance(env: EnduranceEnv, plan: Plan, opts: { up?: boolean } = {}): Promise<RunResult> {
  if (opts.up) {
    const up = await env.runnerUp();
    const s0 = env.session();
    env.write('up', { why: 'start', ...up, sessionId: s0?.sessionId ?? null, xcodebuildPid: s0?.xcodebuildPid ?? null });
    if (!up.ok) throw new StopError('up-failed', `runner up falhou na partida (${up.code}): ${up.out.slice(-300)}`);
  }
  const first = env.session();
  if (first === undefined || !env.sessionAlive(first)) throw new StopError('no-session', 'o runner não está de pé (rode bin/contrarregra runner up --spike)');
  const ctx: Ctx = {
    plan,
    session: first,
    sessions: [first],
    sync: undefined,
    start: env.now(),
    inducing: false,
    dead: undefined,
    takeover: undefined,
    stop: undefined,
    tickFails: 0,
    lastUptime: undefined,
    restarts: 0,
    lastRestore: -Infinity,
    syncSeq: 0,
    alertsSeen: new Set(),
  };
  env.write('start', { plan: { ...plan, slots: plan.slots.map((x) => ({ atMin: r1(x.atMs / MIN), kinds: x.kinds })) }, counts: planCounts(plan), session: sessionRow(first), target: env.targetBundle });
  await activateTarget(env, ctx);
  try {
    ctx.sync = await env.openSync();
  } catch (error) {
    env.write('sync-open', { ok: false, err: errCode(error) });
  }

  const tools = new Mutex();
  const loops = new Loops(env);
  loops.every(plan.xcbEveryMs, () => {
    if (ctx.inducing) return;
    const alive = env.sessionAlive(ctx.session);
    if (!alive && ctx.dead === undefined) {
      ctx.dead = 'xcodebuild-exited';
      env.write('xcb', { alive, pid: ctx.session.xcodebuildPid });
    }
    const latest = env.session();
    if (latest !== undefined && latest.sessionId !== ctx.session.sessionId && ctx.takeover === undefined) {
      ctx.takeover = latest.sessionId;
      env.write('takeover', { mine: ctx.session.sessionId, theirs: latest.sessionId });
    }
  });
  loops.every(plan.hotspotEveryMs, async () => {
    const active = await env.hotspot();
    if (active) {
      env.write('hotspot', { active });
      ctx.stop ??= new StopError('hotspot', 'Acesso Pessoal ligado (inet 172.20.10.*): parado');
    }
  });
  loops.every(plan.syncPingEveryMs, async () => {
    const link = ctx.sync;
    if (link === undefined) return;
    const s = env.now();
    if (link.state !== 'up') {
      env.write('sp', { s, state: link.state });
      return;
    }
    try {
      await link.call('clock.ping', { seq: ctx.syncSeq++ }, { timeoutMs: 2_000 });
      env.write('sp', { s, ms: r1(env.now() - s), rc: link.reconnects });
    } catch (error) {
      env.write('sp', { s, err: errCode(error), state: link.state });
    }
  });
  loops.every(plan.pidEveryMs, () => tools.run(async () => env.write('pid', { ...(await env.devicePids()) })));
  loops.every(plan.transportEveryMs, () => tools.run(async () => env.write('tr', { ...(await env.transport()) })));
  loops.every(plan.memEveryMs, () => tools.run(async () => writeMem(env, await env.memory())));
  loops.every(plan.macMemEveryMs, async () => env.write('macmem', await env.macMem(ctx.session)));

  const pending = plan.slots.flatMap((slot) => slot.kinds.map((kind) => ({ atMs: slot.atMs, kind })));
  const counter: Partial<Record<FailureKind, number>> = {};
  let why = 'done';
  let ticks = 0;
  let failures = 0;
  try {
    for (let i = 0; ; i++) {
      const at = ctx.start + i * plan.tickMs;
      if (at >= ctx.start + plan.durationMs) break;
      while (env.now() < at) {
        if (ctx.stop) throw ctx.stop;
        await env.sleep(Math.min(250, at - env.now()));
      }
      if (ctx.stop) throw ctx.stop;
      if (ctx.takeover !== undefined) throw new StopError('takeover', `outra sessão (${ctx.takeover}) tomou o aparelho: parado para não brigar`);
      if (ctx.dead !== undefined || ctx.tickFails >= plan.hungTicks) {
        const reason = ctx.dead ?? `pendurado: ${ctx.tickFails} ticks sem resposta`;
        ctx.restarts++;
        env.write('death', { spontaneous: true, why: reason, session: ctx.session.sessionId });
        env.log(`runner caiu sem ser induzido (${reason}): subindo outro`);
        const { up } = await freshRunner(env, ctx, 'death');
        if (!up.ok) throw new StopError('up-failed', `runner up depois da queda falhou (${up.code})`);
        continue;
      }
      // Falhas vencidas (uma por vez, na ordem); senão, o tick.
      const due = pending.filter((p) => ctx.start + p.atMs <= env.now());
      if (due.length > 0) {
        for (const p of due) {
          pending.splice(pending.indexOf(p), 1);
          counter[p.kind] = (counter[p.kind] ?? 0) + 1;
          await runFailure(env, ctx, p.kind, counter[p.kind] ?? 1);
          failures++;
          if (ctx.stop) throw ctx.stop;
        }
        continue;
      }
      await tick(env, ctx, i);
      ticks++;
    }
    // Fim da janela: amostras finais com o runner da janela.
    await tools.run(async () => {
      env.write('pid', { ...(await env.devicePids()), final: true });
      writeMem(env, await env.memory(), true);
    });
    env.write('window-end', { at: env.now(), restarts: ctx.restarts, ticks, failures });
    await loops.stop();
    for (const s of ctx.sessions) env.write('log', { sessionId: s.sessionId, ...logSummary(env, s) });
    if (plan.f10) {
      await runFailure(env, ctx, 'F10', 1);
      failures++;
      const newest = ctx.sessions[ctx.sessions.length - 1];
      if (newest !== undefined && newest !== ctx.sessions[0]) env.write('log', { sessionId: newest.sessionId, after: 'F10', ...logSummary(env, newest) });
      await tools.run(async () => writeMem(env, await env.memory(), false, 'after-F10'));
    }
  } catch (error) {
    why = error instanceof StopError ? `stop:${error.kind}` : `error:${errCode(error)}`;
    env.write('abort', { why, msg: error instanceof Error ? error.message : String(error) });
    await loops.stop();
    for (const s of ctx.sessions) env.write('log', { sessionId: s.sessionId, ...logSummary(env, s) });
    if (!(error instanceof StopError)) throw error;
    return { why, stop: error.kind, restarts: ctx.restarts, ticks, failures };
  } finally {
    await loops.stop();
    await ctx.sync?.close().catch(() => undefined);
    env.write('end', { why, restarts: ctx.restarts, ticks, failures, session: ctx.session.sessionId });
  }
  return { why, restarts: ctx.restarts, ticks, failures };
}

function writeMem(env: EnduranceEnv, m: MemSample, final = false, tag?: string): void {
  const pick = (p: ProcMem): Json => ({ name: p.name, pid: p.pid, real: p.real, fp: p.footprint, rp: p.realPrivate, th: p.threads, ports: p.ports, cpuNs: p.cpuTotalNs });
  env.write('mem', { ok: m.ok, ms: m.ms, ...(m.err === undefined ? {} : { err: m.err }), procs: relevantProcs(m.procs, env.targetName).map(pick), ...(final ? { final } : {}), ...(tag ? { tag } : {}) });
}

function logSummary(env: EnduranceEnv, s: SessionRef): Json {
  const text = env.readLog(s.log);
  if (text === undefined) return { log: s.log, missing: true };
  return { log: s.log, ...analyzeSessionLog(text) };
}

// ── análise ───────────────────────────────────────────────────────────────────────────────────────────

export interface Row extends Json {
  k: string;
  m: number;
}

export function parseRows(text: string): Row[] {
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Row);
}

/** Maior intervalo entre chegadas consecutivas dentro de [from, to] (as bordas contam). */
export function maxGap(arrivals: readonly number[], from: number, to: number): { maxGapMs: number | null; at: number | null } {
  const inside = arrivals.filter((t) => t >= from && t <= to).sort((a, b) => a - b);
  const points = [from, ...inside, to];
  let best = 0;
  let at: number | null = null;
  for (let i = 1; i < points.length; i++) {
    const gap = (points[i] as number) - (points[i - 1] as number);
    if (gap > best) {
      best = gap;
      at = points[i - 1] as number;
    }
  }
  return { maxGapMs: r1(best), at };
}

function iso(m: number | null | undefined): string | null {
  return m === null || m === undefined ? null : new Date(m).toISOString();
}

function stats(values: readonly number[]): { n: number; p50: number | null; p95: number | null; max: number | null } {
  return { n: values.length, p50: r1(quantile(values, 0.5)), p95: r1(quantile(values, 0.95)), max: r1(values.length ? Math.max(...values) : null) };
}

interface MemPoint {
  m: number;
  min: number;
  real: number | null;
  fp: number | null;
  pid: number;
}

export interface Summary {
  label: string;
  plan: string | null;
  start: string | null;
  windowEnd: string | null;
  durationMin: number | null;
  end: { why: unknown; at: string | null } | null;
  sessions: Json[];
  ups: Json[];
  restarts: { deaths: number; uptimeResets: number; xcodebuildExits: number; runnerPidsInWindow: number[][]; testServeStartsMain: number | null; takeover: boolean };
  health: { sent: number; ok: number; failed: number; tickOk: number; tickFailed: number; tickFailedOutsideFailures: number; rttMs: ReturnType<typeof stats>; tickRttMs: ReturnType<typeof stats>; maxGapMs: number | null; maxGapAt: string | null; maxGapOutsideFailuresMs: number | null };
  sync: { pings: number; ok: number; failed: number; rttMs: ReturnType<typeof stats>; notUp: number; badOutsideFailures: number };
  ticks: { n: number; errors: number; helloMs: ReturnType<typeof stats>; shotMs: ReturnType<typeof stats>; shotErr: number; findMs: ReturnType<typeof stats>; findErr: number; treeMs: ReturnType<typeof stats>; treeErr: number; restores: number; queueMax: number | null; fgOther: string[] };
  memory: {
    samples: number;
    failed: number;
    runner: {
      firstMB: number | null;
      lastMB: number | null;
      maxMB: number | null;
      minMB: number | null;
      /** Última − primeira amostra (ruidoso: o "Real Mem" sobe e desce com a pressão de memória do aparelho). */
      growthMB: number | null;
      maxGrowthMB: number | null;
      /** Média das amostras do último trecho − a do primeiro (trecho = min(30 min, ¼ da janela)): a medida do critério. */
      growthEdgesMB: number | null;
      edgeMin: number | null;
      /** Inclinação por mínimos quadrados, MB/h. */
      trendMBPerH: number | null;
      fpFirstMB: number | null;
      fpLastMB: number | null;
      fpMaxMB: number | null;
      fpGrowthEdgesMB: number | null;
      fpTrendMBPerH: number | null;
      series: Array<[number, number | null, number | null]>;
    };
    others: Record<string, { firstMB: number | null; lastMB: number | null; maxMB: number | null }>;
    afterF10: Json | null;
  };
  macMem: { xcodebuildFirstMB: number | null; xcodebuildLastMB: number | null; xcodebuildMaxMB: number | null; driverMaxMB: number | null };
  transport: { samples: number; notWiredConnected: number };
  pids: { samples: number; failed: number };
  failures: Json[];
  byKind: Record<string, Json>;
  ac111: { n: number; ok: number; healthAfterMaxMs: number | null; healthAfterOver200: number };
  logs: Json[];
  codePrompts: { atSubida: number; subidas: number; midRunSignals: number; untrusted: number };
  alerts: Json[];
  criteria: { zeroRestarts: boolean; rssGrowthMB: number | null; rssOk: boolean | null; codePrompts: number; promptsOk: boolean; ok: boolean };
}

const toMB = (b: number | null | undefined): number | null => (b === null || b === undefined ? null : r1(b / MB));

/** Inclinação por mínimos quadrados de y(x). */
export function slope(points: ReadonlyArray<readonly [number, number]>): number | null {
  if (points.length < 2) return null;
  const n = points.length;
  const mx = points.reduce((a, p) => a + p[0], 0) / n;
  const my = points.reduce((a, p) => a + p[1], 0) / n;
  let num = 0;
  let den = 0;
  for (const [x, y] of points) {
    num += (x - mx) * (y - my);
    den += (x - mx) ** 2;
  }
  return den === 0 ? null : num / den;
}

/** Média do último trecho − média do primeiro (`edgeMs` cada), ou `null` sem amostra num dos dois. */
export function edgeGrowth(points: ReadonlyArray<readonly [number, number]>, from: number, to: number, edgeMs: number): number | null {
  const head = points.filter(([t]) => t >= from && t <= from + edgeMs).map(([, v]) => v);
  const tail = points.filter(([t]) => t >= to - edgeMs && t <= to).map(([, v]) => v);
  if (head.length === 0 || tail.length === 0) return null;
  const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
  return mean(tail) - mean(head);
}

export function summarize(label: string, rows: readonly Row[]): Summary {
  const start = rows.find((r) => r.k === 'start');
  const windowEndRow = rows.find((r) => r.k === 'window-end');
  const endRow = [...rows].reverse().find((r) => r.k === 'end');
  const t0 = start?.m ?? rows[0]?.m ?? 0;
  const tEnd = windowEndRow?.m ?? endRow?.m ?? rows[rows.length - 1]?.m ?? t0;
  const inWin = (r: Row): boolean => r.m >= t0 && r.m <= tEnd;
  const failRows = rows.filter((r) => r.k === 'fail');
  const failWindows = failRows.map((r) => [Number(r['s']), Number(r['e'])] as [number, number]);
  const inFailure = (t: number): boolean => failWindows.some(([a, b]) => t >= a - 1_000 && t <= b + 1_000);

  // Sessões e subidas.
  const sessions: Json[] = [];
  const startSession = start?.['session'] as Json | undefined;
  if (startSession) sessions.push({ ...startSession, why: 'start' });
  for (const r of rows.filter((x) => x.k === 'session')) sessions.push({ sessionId: r['sessionId'], xcodebuildPid: r['xcodebuildPid'], startedAt: r['startedAt'] });
  const ups = rows.filter((r) => r.k === 'up').map((r) => ({ at: iso(r.m), why: r['why'], ok: r['ok'], ms: r['ms'], sessionId: r['sessionId'] }));

  // Religamentos.
  const pidRows = rows.filter((r) => r.k === 'pid' && r['ok'] === true && inWin(r));
  const pidSets = new Map<string, number[]>();
  for (const r of pidRows) {
    const runner = (r['runner'] as number[] | undefined) ?? [];
    pidSets.set(JSON.stringify([...runner].sort((a, b) => a - b)), runner);
  }
  const logRows = rows.filter((r) => r.k === 'log' && r['after'] === undefined);
  const mainLog = logRows.find((r) => r['sessionId'] === startSession?.['sessionId']);

  // health.
  const h = rows.filter((r) => r.k === 'h' && inWin(r));
  const hOk = h.filter((r) => typeof r['r'] === 'number');
  const tickH = h.filter((r) => r['tag'] === 'tick');
  const tickOk = tickH.filter((r) => typeof r['r'] === 'number');
  const tickFailed = tickH.filter((r) => typeof r['r'] !== 'number');
  const arrivals = hOk.map((r) => r['r'] as number);
  const gap = maxGap(arrivals, t0, tEnd);
  // Maior intervalo sem resposta fora das janelas das falhas (os cortes induzidos ficam de fora).
  let gapOutside = 0;
  const sortedArr = [...arrivals].sort((a, b) => a - b);
  for (let i = 1; i < sortedArr.length; i++) {
    const a = sortedArr[i - 1] as number;
    const b = sortedArr[i] as number;
    if (failWindows.some(([fa, fb]) => fa <= b && fb >= a)) continue;
    gapOutside = Math.max(gapOutside, b - a);
  }

  // sync.
  const sp = rows.filter((r) => r.k === 'sp' && inWin(r));
  const spOk = sp.filter((r) => typeof r['ms'] === 'number');

  // ticks.
  const ticks = rows.filter((r) => r.k === 'tick' && inWin(r));
  const sub = (key: string): Json[] => ticks.map((t) => t[key] as Json | undefined).filter((x): x is Json => x !== undefined);
  const msOf = (xs: Json[]): number[] => xs.filter((x) => x['err'] === undefined && typeof x['ms'] === 'number').map((x) => x['ms'] as number);
  const fgOther = [...new Set(h.map((r) => r['fg']).filter((fg): fg is string => typeof fg === 'string'))];
  const qs = hOk.map((r) => Number(r['q'] ?? 0));

  // Memória.
  const memRows = rows.filter((r) => r.k === 'mem');
  const memWin = memRows.filter((r) => inWin(r) && r['tag'] === undefined);
  const series: MemPoint[] = [];
  const others: Record<string, number[]> = {};
  for (const r of memWin) {
    if (r['ok'] !== true) continue;
    const procs = (r['procs'] as Json[] | undefined) ?? [];
    const runner = procs.find((p) => p['name'] === RUNNER_EXE);
    if (runner) series.push({ m: r.m, min: (r.m - t0) / MIN, real: runner['real'] as number | null, fp: runner['fp'] as number | null, pid: runner['pid'] as number });
    for (const p of procs) {
      if (p['name'] === RUNNER_EXE) continue;
      const key = String(p['name']);
      (others[key] ??= []).push(Number(p['real'] ?? NaN));
    }
  }
  const reals = series.map((p) => p.real).filter((x): x is number => typeof x === 'number');
  const fps = series.map((p) => p.fp).filter((x): x is number => typeof x === 'number');
  const firstReal = reals[0] ?? null;
  const lastReal = reals[reals.length - 1] ?? null;
  const edgeMs = Math.min(30 * MIN, (tEnd - t0) / 4);
  const realPts = series.filter((p) => typeof p.real === 'number').map((p) => [p.m, p.real as number] as const);
  const fpPts = series.filter((p) => typeof p.fp === 'number').map((p) => [p.m, p.fp as number] as const);
  const growthEdges = edgeGrowth(realPts, t0, tEnd, edgeMs);
  const realSlope = slope(realPts);
  const fpSlope = slope(fpPts);
  const fpEdges = edgeGrowth(fpPts, t0, tEnd, edgeMs);
  const afterF10Row = memRows.find((r) => r['tag'] === 'after-F10');
  const macmem = rows.filter((r) => r.k === 'macmem' && inWin(r));
  const xcbKb = macmem.map((r) => Number(r['xcodebuildKb'])).filter((x) => Number.isFinite(x) && x > 0);
  const drvMb = macmem.map((r) => Number(r['driverRssMB'])).filter((x) => Number.isFinite(x));

  // Falhas.
  const failures = failRows.map((r) => ({
    kind: r['kind'],
    n: r['n'],
    at: iso(Number(r['s'])),
    min: r1((Number(r['s']) - t0) / MIN),
    ok: r['ok'],
    got: r['got'],
    ms: r['ms'] ?? null,
    healthAfterMs: r['healthAfterMs'] ?? null,
    recoveryMs: r['recoveryMs'] ?? null,
  }));
  const byKind: Record<string, Json> = {};
  for (const kind of Object.keys(FAILURE_TITLES)) {
    const fs = failures.filter((f) => f.kind === kind);
    if (fs.length === 0) continue;
    const ha = fs.map((f) => f.healthAfterMs).filter((x): x is number => typeof x === 'number');
    const rec = fs.map((f) => f.recoveryMs).filter((x): x is number => typeof x === 'number');
    byKind[kind] = {
      title: FAILURE_TITLES[kind as FailureKind],
      n: fs.length,
      ok: fs.filter((f) => f.ok === true).length,
      skipped: fs.filter((f) => f.ok === null).length,
      healthAfterMaxMs: r1(ha.length ? Math.max(...ha) : null),
      recoveryP50Ms: r1(quantile(rec, 0.5)),
      recoveryMaxMs: r1(rec.length ? Math.max(...rec) : null),
      got: fs[fs.length - 1]?.got ?? null,
    };
  }
  const ac = failures.filter((f) => AC111.includes(f.kind as FailureKind) && f.ok !== null);
  const acHealth = ac.map((f) => f.healthAfterMs).filter((x): x is number => typeof x === 'number');

  // Pedidos de código / Untrusted.
  const logs = rows
    .filter((r) => r.k === 'log')
    .map((r) => ({
      sessionId: r['sessionId'],
      after: r['after'] ?? null,
      missing: r['missing'] ?? false,
      subidas: r['subidas'] ?? [],
      testServeStarts: r['testServeStarts'] ?? null,
      runnerPids: r['runnerPids'] ?? [],
      xctestIssues: r['xctestIssues'] ?? null,
      hellos: r['hellos'] ?? null,
      patterns: Object.fromEntries(Object.entries((r['patterns'] as Record<string, number> | undefined) ?? {}).filter(([, v]) => v > 0)),
      lines: r['lines'] ?? null,
    }));
  const seenSessions = new Set<unknown>();
  let atSubida = 0;
  let subidas = 0;
  let midRun = 0;
  let untrusted = 0;
  for (const l of [...logs].reverse()) {
    if (seenSessions.has(l.sessionId)) continue; // a última leitura de cada sessão
    seenSessions.add(l.sessionId);
    const subs = l.subidas as Subida[];
    subidas += subs.length;
    atSubida += subs.filter((x) => x.prompt).length;
    const p = l.patterns as Record<string, number>;
    untrusted += (p['Untrusted'] ?? 0) + (p['not been explicitly trusted'] ?? 0);
    midRun += Math.max(0, (p['automation mode'] ?? 0) - (p['Timed out while enabling automation mode'] ?? 0)) + (p['passcode'] ?? 0);
  }

  const deaths = rows.filter((r) => r.k === 'death' && inWin(r)).length;
  const uptimeResets = rows.filter((r) => r.k === 'uptime-reset' && inWin(r)).length;
  const xcbExits = rows.filter((r) => r.k === 'xcb' && inWin(r) && r['alive'] === false).length;
  const testServeStartsMain = typeof mainLog?.['testServeStarts'] === 'number' ? (mainLog['testServeStarts'] as number) : null;
  const zeroRestarts = deaths === 0 && uptimeResets === 0 && xcbExits === 0 && pidSets.size <= 1 && (testServeStartsMain === null || testServeStartsMain <= 1);
  const growth = firstReal !== null && lastReal !== null ? (lastReal - firstReal) / MB : null;
  const growthForCriterion = growthEdges !== null ? growthEdges / MB : growth;
  const codePrompts = atSubida + midRun;
  const criteria = {
    zeroRestarts,
    rssGrowthMB: r1(growthForCriterion),
    rssOk: growthForCriterion === null ? null : growthForCriterion < CRITERIA.rssGrowthMB,
    codePrompts,
    promptsOk: codePrompts <= CRITERIA.codePromptsMax && midRun === 0,
    ok: false,
  };
  criteria.ok = criteria.zeroRestarts && criteria.rssOk === true && criteria.promptsOk;

  return {
    label,
    plan: ((start?.['plan'] as Json | undefined)?.['name'] as string | undefined) ?? null,
    start: iso(start?.m),
    windowEnd: iso(windowEndRow?.m ?? null),
    durationMin: r1((tEnd - t0) / MIN),
    end: endRow ? { why: endRow['why'], at: iso(endRow.m) } : null,
    sessions,
    ups,
    restarts: { deaths, uptimeResets, xcodebuildExits: xcbExits, runnerPidsInWindow: [...pidSets.values()], testServeStartsMain, takeover: rows.some((r) => r.k === 'takeover') },
    health: {
      sent: h.length,
      ok: hOk.length,
      failed: h.length - hOk.length,
      tickOk: tickOk.length,
      tickFailed: tickFailed.length,
      tickFailedOutsideFailures: tickFailed.filter((r) => !inFailure(Number(r['s']))).length,
      rttMs: stats(hOk.map((r) => Number(r['ms']))),
      tickRttMs: stats(tickOk.map((r) => Number(r['ms']))),
      maxGapMs: gap.maxGapMs,
      maxGapAt: iso(gap.at),
      maxGapOutsideFailuresMs: r1(gapOutside),
    },
    sync: {
      pings: sp.length,
      ok: spOk.length,
      failed: sp.filter((r) => typeof r['err'] === 'string').length,
      rttMs: stats(spOk.map((r) => Number(r['ms']))),
      notUp: sp.filter((r) => typeof r['state'] === 'string' && r['ms'] === undefined && r['err'] === undefined).length,
      badOutsideFailures: sp.filter((r) => typeof r['ms'] !== 'number' && !inFailure(Number(r['s']))).length,
    },
    ticks: {
      n: ticks.length,
      errors: ticks.filter((t) => t['err'] !== undefined).length,
      helloMs: stats(ticks.filter((t) => typeof t['helloMs'] === 'number').map((t) => t['helloMs'] as number)),
      shotMs: stats(msOf(sub('shot'))),
      shotErr: sub('shot').filter((x) => x['err'] !== undefined).length,
      findMs: stats(msOf(sub('find'))),
      findErr: sub('find').filter((x) => x['err'] !== undefined).length,
      treeMs: stats(msOf(sub('tree'))),
      treeErr: sub('tree').filter((x) => x['err'] !== undefined).length,
      restores: rows.filter((r) => r.k === 'restore' && inWin(r)).length,
      queueMax: qs.length ? Math.max(...qs) : null,
      fgOther,
    },
    memory: {
      samples: memWin.length,
      failed: memWin.filter((r) => r['ok'] !== true).length,
      runner: {
        firstMB: toMB(firstReal),
        lastMB: toMB(lastReal),
        maxMB: toMB(reals.length ? Math.max(...reals) : null),
        minMB: toMB(reals.length ? Math.min(...reals) : null),
        growthMB: r1(growth),
        maxGrowthMB: firstReal === null || reals.length === 0 ? null : r1((Math.max(...reals) - firstReal) / MB),
        growthEdgesMB: toMB(growthEdges),
        edgeMin: r1(edgeMs / MIN),
        trendMBPerH: realSlope === null ? null : r1((realSlope * 60 * MIN) / MB),
        fpFirstMB: toMB(fps[0] ?? null),
        fpLastMB: toMB(fps[fps.length - 1] ?? null),
        fpMaxMB: toMB(fps.length ? Math.max(...fps) : null),
        fpGrowthEdgesMB: toMB(fpEdges),
        fpTrendMBPerH: fpSlope === null ? null : r1((fpSlope * 60 * MIN) / MB),
        series: series.map((p) => [r1(p.min) ?? 0, toMB(p.real), toMB(p.fp)]),
      },
      others: Object.fromEntries(
        Object.entries(others).map(([k, v]) => {
          const ok = v.filter((x) => Number.isFinite(x));
          return [k, { firstMB: toMB(ok[0] ?? null), lastMB: toMB(ok[ok.length - 1] ?? null), maxMB: toMB(ok.length ? Math.max(...ok) : null) }];
        }),
      ),
      afterF10: afterF10Row ? { ok: afterF10Row['ok'], runner: ((afterF10Row['procs'] as Json[] | undefined) ?? []).find((p) => p['name'] === RUNNER_EXE) ?? null } : null,
    },
    macMem: {
      xcodebuildFirstMB: xcbKb.length ? r1((xcbKb[0] as number) / 1024) : null,
      xcodebuildLastMB: xcbKb.length ? r1((xcbKb[xcbKb.length - 1] as number) / 1024) : null,
      xcodebuildMaxMB: xcbKb.length ? r1(Math.max(...xcbKb) / 1024) : null,
      driverMaxMB: drvMb.length ? r1(Math.max(...drvMb)) : null,
    },
    transport: {
      samples: rows.filter((r) => r.k === 'tr' && inWin(r)).length,
      notWiredConnected: rows.filter((r) => r.k === 'tr' && inWin(r) && !(r['tt'] === 'wired' && r['ts'] === 'connected')).length,
    },
    pids: { samples: rows.filter((r) => r.k === 'pid' && inWin(r)).length, failed: rows.filter((r) => r.k === 'pid' && inWin(r) && r['ok'] !== true).length },
    failures,
    byKind,
    ac111: { n: ac.length, ok: ac.filter((f) => f.ok === true).length, healthAfterMaxMs: r1(acHealth.length ? Math.max(...acHealth) : null), healthAfterOver200: acHealth.filter((x) => x > CRITERIA.healthAfterMs).length },
    logs,
    codePrompts: { atSubida, subidas, midRunSignals: midRun, untrusted },
    alerts: rows.filter((r) => r.k === 'alert').map((r) => ({ at: iso(r.m), min: r1((r.m - t0) / MIN), n: r['n'], lines: r['lines'] })),
    criteria,
  };
}

const fmt = (x: unknown): string => (x === null || x === undefined ? '—' : typeof x === 'number' ? String(x).replace('.', ',') : String(x));

export function markdown(s: Summary): string {
  const out: string[] = [];
  out.push(`### ${s.label} (${s.plan ?? '?'}) — ${s.start ?? '?'} → ${s.windowEnd ?? '?'} (${fmt(s.durationMin)} min); fim: ${fmt(s.end?.why)}`);
  out.push('');
  out.push('| medida | valor |');
  out.push('|---|---|');
  out.push(`| religamentos na janela | mortes ${s.restarts.deaths} · \`uptimeS\` zerado ${s.restarts.uptimeResets} · xcodebuild saiu ${s.restarts.xcodebuildExits} · PIDs do runner ${JSON.stringify(s.restarts.runnerPidsInWindow)} · \`testServe\` iniciado ${fmt(s.restarts.testServeStartsMain)}× |`);
  out.push(`| health (todas) | ${s.health.ok}/${s.health.sent} ok; RTT p50 ${fmt(s.health.rttMs.p50)} / p95 ${fmt(s.health.rttMs.p95)} / máx ${fmt(s.health.rttMs.max)} ms |`);
  out.push(`| health dos ticks (10 s) | ${s.health.tickOk} ok, ${s.health.tickFailed} falhas (${s.health.tickFailedOutsideFailures} fora das falhas induzidas); RTT p50 ${fmt(s.health.tickRttMs.p50)} / máx ${fmt(s.health.tickRttMs.max)} ms |`);
  out.push(`| maior intervalo sem health | ${fmt(s.health.maxGapMs)} ms (fora das falhas: ${fmt(s.health.maxGapOutsideFailuresMs)} ms) |`);
  out.push(`| sync (clock.ping a cada 10 s) | ${s.sync.ok}/${s.sync.pings} ok (${s.sync.badOutsideFailures} sem resposta fora das falhas); RTT p50 ${fmt(s.sync.rttMs.p50)} / máx ${fmt(s.sync.rttMs.max)} ms |`);
  out.push(`| comandos da fila do XCTest | screen.shot p50 ${fmt(s.ticks.shotMs.p50)} / máx ${fmt(s.ticks.shotMs.max)} ms (${s.ticks.shotMs.n}, ${s.ticks.shotErr} erros) · ui.find p50 ${fmt(s.ticks.findMs.p50)} / máx ${fmt(s.ticks.findMs.max)} ms (${s.ticks.findMs.n}, ${s.ticks.findErr}) · ui.tree p50 ${fmt(s.ticks.treeMs.p50)} / máx ${fmt(s.ticks.treeMs.max)} ms (${s.ticks.treeMs.n}, ${s.ticks.treeErr}) |`);
  out.push(`| abrir control (hello) | p50 ${fmt(s.ticks.helloMs.p50)} / máx ${fmt(s.ticks.helloMs.max)} ms em ${s.ticks.helloMs.n} conexões |`);
  out.push(`| RSS do runner (Real Mem) | ${fmt(s.memory.runner.firstMB)} → ${fmt(s.memory.runner.lastMB)} MB (mín ${fmt(s.memory.runner.minMB)}, máx ${fmt(s.memory.runner.maxMB)}); média dos últimos ${fmt(s.memory.runner.edgeMin)} min − primeiros: ${fmt(s.memory.runner.growthEdgesMB)} MB; tendência ${fmt(s.memory.runner.trendMBPerH)} MB/h; ${s.memory.samples} amostras, ${s.memory.failed} falhas |`);
  out.push(`| footprint do runner | ${fmt(s.memory.runner.fpFirstMB)} → ${fmt(s.memory.runner.fpLastMB)} MB (máx ${fmt(s.memory.runner.fpMaxMB)}); bordas ${fmt(s.memory.runner.fpGrowthEdgesMB)} MB; tendência ${fmt(s.memory.runner.fpTrendMBPerH)} MB/h |`);
  for (const [name, o] of Object.entries(s.memory.others)) out.push(`| RSS ${name} | ${fmt(o.firstMB)} → ${fmt(o.lastMB)} MB (máx ${fmt(o.maxMB)}) |`);
  out.push(`| xcodebuild no Mac (RSS) | ${fmt(s.macMem.xcodebuildFirstMB)} → ${fmt(s.macMem.xcodebuildLastMB)} MB (máx ${fmt(s.macMem.xcodebuildMaxMB)}) |`);
  out.push(`| túnel | ${s.transport.samples} amostras, ${s.transport.notWiredConnected} fora de wired/connected |`);
  out.push(`| pedidos de código | ${s.codePrompts.atSubida} nas ${s.codePrompts.subidas} subidas; sinais no meio ${s.codePrompts.midRunSignals}; "Untrusted" ${s.codePrompts.untrusted} |`);
  out.push(`| alertas vistos | ${s.alerts.length} |`);
  out.push(`| AC-1.11 | ${s.ac111.ok}/${s.ac111.n} com o erro esperado; health depois máx ${fmt(s.ac111.healthAfterMaxMs)} ms (${s.ac111.healthAfterOver200} acima de 200 ms) |`);
  out.push('');
  out.push('| falha | n | ok | health depois máx (ms) | recuperação p50 / máx (ms) | último resultado |');
  out.push('|---|---|---|---|---|---|');
  for (const [kind, k] of Object.entries(s.byKind)) {
    out.push(`| ${kind} ${fmt(k['title'])} | ${fmt(k['n'])} | ${fmt(k['ok'])}${Number(k['skipped']) > 0 ? ` (+${fmt(k['skipped'])} puladas)` : ''} | ${fmt(k['healthAfterMaxMs'])} | ${fmt(k['recoveryP50Ms'])} / ${fmt(k['recoveryMaxMs'])} | ${fmt(k['got']).replace(/\|/g, '\\|')} |`);
  }
  out.push('');
  out.push(`Critério: 0 religamentos ${s.criteria.zeroRestarts ? 'SIM' : 'NÃO'} · RSS cresce ${fmt(s.criteria.rssGrowthMB)} MB (bordas; < 100: ${s.criteria.rssOk === null ? '—' : s.criteria.rssOk ? 'SIM' : 'NÃO'}) · pedidos de código ${s.criteria.codePrompts} (≤ 1, só na subida: ${s.criteria.promptsOk ? 'SIM' : 'NÃO'}) → **${s.criteria.ok ? 'atingido' : 'não atingido'}**`);
  return out.join('\n');
}
