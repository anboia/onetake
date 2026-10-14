// Testes do driver do SP-3 (T-0.18) sem aparelho: `node --test spikes/sp-3/sp3.test.ts`. O runner é um `Rpc` falso
// que responde como `spike.tap` (SP3Taps.swift) e escreve no "xcodebuild.log" o que o runner e o XCTest escreveriam.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ContrarregraError } from '../../mac/src/core/errors.ts';
import type { TreeNode } from '../../mac/src/core/types.ts';
import {
  CLOCK_PATTERN,
  MEASURE_PATTERNS,
  chapterSeconds,
  heavyReport,
  readEffect,
  snapshotTimes,
  RESTORE_PATTERNS,
  clockSeconds,
  countLog,
  flatten,
  isClockJump,
  markdownTable,
  nsDiffMs,
  perTapLog,
  pickButton,
  pickClock,
  playState,
  redact,
  runPhase,
  showsPsalm23,
  summarize,
  variantSpec,
  chapterTitle,
  nearestHittable,
  ownerReason,
  psalm23Screen,
  repeatRow,
  type Json,
  type PhaseIo,
  type Rpc,
  type Targets,
} from './lib.ts';
import { OwnerNeeded, discover, finish, prepare, type PrepCtx } from './prepare.ts';

const HAGAH = 'app.kifactory.hagah';
let refs = 0;

function node(type: TreeNode['type'], label: string | undefined, y: number, extra: Partial<TreeNode> = {}): TreeNode {
  return {
    ref: `@e${++refs}`,
    type,
    ...(label === undefined ? {} : { label }),
    frame: { x: 20, y, w: 60, h: 44 },
    enabled: true,
    selected: false,
    visible: true,
    depth: 2,
    ...extra,
  };
}

/** Now Playing aberto por cima do mini-player (que ficou fora da tela), mais a linha "Pause" de "Pause between repeats". */
function nowPlaying(playing = true): TreeNode[] {
  const sheet = node('other', undefined, 400, {
    children: [
      node('staticText', 'Psalms 23', 430),
      node('staticText', '0:32', 560),
      node('staticText', '-1:05', 560),
      node('button', 'Previous verse', 600),
      node('button', 'Back 15 seconds', 600),
      node('button', playing ? 'Pause' : 'Play', 600),
      node('button', 'Forward 15 seconds', 600),
      node('button', 'Next verse', 600),
      node('button', 'Close', 410),
      node('button', 'Pause', 780),
    ],
  });
  const mini = node('button', 'Open Now Playing: Psalms 23, NIV · v. 3', 900, { visible: false });
  const miniClock = node('staticText', '0:31', 900, { visible: false });
  return [node('application', 'Hagah', 0, { children: [miniClock, mini, sheet] })];
}

describe('variantes', () => {
  it('lê as variantes de T-0.18 e os modificadores', () => {
    assert.deepEqual(variantSpec('a').params, { variant: 'a' });
    assert.deepEqual(variantSpec('a.coord').params, { variant: 'a', base: 'coordinate' });
    assert.deepEqual(variantSpec('c.obs.coord').params, { variant: 'c', quiescence: 'observe', base: 'coordinate' });
    assert.equal(variantSpec('b').privateApi, 'PX-2');
    assert.equal(variantSpec('d').privateApi, 'PX-3');
    assert.equal(variantSpec('ui').method, 'ui.tap');
    assert.throws(() => variantSpec('d.coord'));
    assert.throws(() => variantSpec('b.obs'));
    assert.throws(() => variantSpec('e'));
  });
});

describe('relógio', () => {
  it('lê m:ss, -m:ss (também com U+2212) e h:mm:ss', () => {
    assert.equal(clockSeconds('0:32'), 32);
    assert.equal(clockSeconds('-1:05'), -65);
    assert.equal(clockSeconds('−1:05'), -65);
    assert.equal(clockSeconds('1:02:03'), 3723);
    assert.equal(clockSeconds('Play'), undefined);
    assert.ok(new RegExp(CLOCK_PATTERN).test('−1:05'));
  });

  it('salto: ±15 s conta; o relógio andando ou parado não', () => {
    assert.equal(isClockJump('0:30', '0:45', 0.3), true);
    assert.equal(isClockJump('-1:30', '-1:15', 0.4), true);
    assert.equal(isClockJump('0:30', '0:33', 3), false);
    assert.equal(isClockJump('-1:30', '-1:27', 3), false);
    assert.equal(isClockJump('0:30', '0:30', 2), false);
    assert.equal(isClockJump('0:30', '0:15', 0.5), true);
  });
});

describe('efeito lido no Mac (1ª mudança consistente com o toque)', () => {
  const ns = (ms: number): string => String(1_000_000_000n + BigInt(ms) * 1_000_000n);
  const effect = (baseline: string, changes: [number, string][], upperMs?: number): Json => ({
    baseline, tBaselineNs: ns(0), spec: { minJumpS: 10 }, changes: changes.map(([ms, value]) => ({ tNs: ns(ms), value })),
    ...(upperMs === undefined ? { satisfied: false } : { satisfied: true, tUpperNs: ns(upperMs) }),
  });

  it('salto de 15 s no meio do capítulo: causal, no instante da leitura', () => {
    const r = readEffect(effect('0:29', [[2500, '0:44']], 2500), 'playing', 46);
    assert.deepEqual([r.kind, r.tNs, r.deviceLate], ['causal', ns(2500), false]);
  });

  it('salto para o fim do capítulo (0:37 → 0:46): causal no 0:46 — o runner só parou na volta do Repeat (tarde)', () => {
    const r = readEffect(effect('0:37', [[950, '0:46'], [1600, '0:00']], 1600), 'playing', 46);
    assert.deepEqual([r.kind, r.value, r.tNs, r.deviceLate], ['causal', '0:46', ns(950), true]);
  });

  it('perto do fim, tocando: o fim natural também explica a mudança → ambíguo (com a folga de 1 s do rótulo)', () => {
    assert.equal(readEffect(effect('0:43', [[3100, '0:46'], [4000, '0:00']], 4000), 'playing', 46).kind, 'ambiguous');
    assert.equal(readEffect(effect('0:41', [[3100, '0:46']]), 'playing', 46).kind, 'ambiguous', '41 + 1 + 3,1 ≥ 45');
    assert.equal(readEffect(effect('0:41', [[3100, '0:46']]), 'paused', 46).kind, 'causal', 'pausado, o relógio não anda');
  });

  it('o tique natural do relógio não conta; sem mudança consistente, ausente', () => {
    const r = readEffect(effect('0:20', [[900, '0:21'], [1900, '0:37']], 1900), 'playing', 46);
    assert.deepEqual([r.kind, r.value], ['causal', '0:37']);
    assert.equal(readEffect(effect('0:20', [[900, '0:21']]), 'playing', 46).kind, 'missing');
    assert.equal(readEffect(undefined, 'playing', 46).kind, 'missing');
  });

  it('duração do capítulo: a declarada na descoberta, ou o maior relógio visto', () => {
    assert.equal(chapterSeconds([{ k: 'start', targets: { chapterS: 46 } }]), 46);
    assert.equal(chapterSeconds([{ k: 'tap', item: { effect: effect('0:40', [[900, '0:46'], [1800, '0:00']]) } }]), 46);
  });

  it('tempos de snapshot por processo: o app inteiro × as consultas menores', () => {
    const log = [
      "    t =    10.00s Find the Application 'com.apple.springboard'",
      '    t =    10.00s     Requesting snapshot of accessibility hierarchy for app with pid 35',
      '    t =    10.70s Get all elements bound by index for: Descendants matching type Window',
      '    t =    10.70s     Requesting snapshot of accessibility hierarchy for app with pid 900',
      '    t =    10.95s     Find: Descendants matching type Window',
      "    t =    11.00s Find the Application 'app.kifactory.hagah'",
      '    t =    11.00s     Requesting snapshot of accessibility hierarchy for app with pid 900',
      "    t =    11.20s Find the Application 'com.apple.springboard'",
    ].join('\n');
    assert.deepEqual(snapshotTimes(log), { 'com.apple.springboard': [700], 'app.kifactory.hagah': [200], 'app.kifactory.hagah (consultas)': [250] });
    assert.deepEqual(snapshotTimes(log.replaceAll('\n', '\r\n')), snapshotTimes(log), 'o registro do aparelho vem em CRLF');
  });
});

describe('alvos no Now Playing', () => {
  const all = flatten(nowPlaying());

  it('acha "Forward 15 seconds" para medir e "Back 15 seconds" para restaurar', () => {
    assert.equal(pickButton(all, MEASURE_PATTERNS).node?.label, 'Forward 15 seconds');
    assert.equal(pickButton(all, RESTORE_PATTERNS).node?.label, 'Back 15 seconds');
  });

  it('escolhe o relógio visível mais perto do botão, com a ocorrência que a consulta vê', () => {
    const forward = pickButton(all, MEASURE_PATTERNS).node as TreeNode;
    const clock = pickClock(all, forward.frame);
    assert.equal(clock?.node.label, '0:32');
    assert.equal(clock?.index, 1, 'o relógio do mini-player (fora da tela) vem antes na árvore');
  });

  it('estado do áudio pela fileira do transporte, sem confundir com a linha "Pause"', () => {
    assert.equal(playState(all, 622), 'playing');
    assert.equal(playState(flatten(nowPlaying(false)), 622), 'paused');
    assert.equal(playState(flatten(nowPlaying(false))), 'playing', 'sem faixa, a linha "Pause" engana — por isso a faixa');
    assert.equal(showsPsalm23(all), true);
  });

  it('tira e-mails do que vai para out/', () => {
    assert.equal(redact('Signed in as someone@icloud.com'), 'Signed in as <redacted>');
  });
});

describe('xcodebuild.log', () => {
  const text = [
    `    t =     1.00s         Wait for ${HAGAH} to idle`,
    'CONTRARREGRA INFO SP-3 tap seq=1 i=0 role=measure variant=a/element begin',
    '    t =     2.00s Tap "Forward 15 seconds" Button',
    `    t =     2.01s     Wait for ${HAGAH} to idle`,
    `    t =     2.40s     Wait for ${HAGAH} to idle`,
    'CONTRARREGRA INFO SP-3 tap seq=1 i=0 role=measure variant=a/element end ms=450.0',
    'CONTRARREGRA INFO SP-3 tap seq=2 i=0 role=restore variant=a/element begin',
    '    t =     3.01s     Wait for com.apple.springboard to idle',
    'CONTRARREGRA WARN falha do XCTest registrada e ignorada: x',
  ].join('\n');

  it('conta as esperas da janela e as do app alvo', () => {
    const counts = countLog(text, HAGAH);
    assert.equal(counts['waitForIdle'], 4);
    assert.equal(counts['waitForTargetIdle'], 3);
    assert.equal(counts['xctestFailureIgnored'], 1);
  });

  it('atribui as esperas ao toque da última marca begin', () => {
    const { pre, taps } = perTapLog(text, HAGAH);
    assert.equal(pre, 1);
    assert.deepEqual(taps.map((t) => [t.seq, t.role, t.waitForTargetIdle, t.waitForIdle]), [['1', 'measure', 2, 2], ['2', 'restore', 0, 1]]);
  });

  it('diferença de instantes D em ms', () => {
    assert.equal(nsDiffMs('1000000000', '1150000000'), 150);
    assert.equal(nsDiffMs(undefined, '1'), null);
  });
});

// ---------------------------------------------------------------------------------------------------------

interface Fake {
  rpc: Rpc;
  io: PhaseIo;
  rows: Json[];
  calls: { method: string; params: Json }[];
}

interface FakeOptions {
  /** A partir desta chamada, toda chamada falha com `E_TIMEOUT`. */
  failFrom?: number;
  /** O efeito (salto do relógio) aparece nos toques medidos (padrão: sim). */
  effectSeen?: boolean;
  /** O runner registra uma falha do XCTest engolida em cada toque. */
  xctestFailure?: boolean;
}

/** Runner falso: cada `spike.tap` leva `ms(variant)` e, na variante `a`, deixa 2 "Wait for … to idle" no registro. */
function fake(ms: (variant: string, i: number) => number, options: FakeOptions = {}): Fake {
  const { failFrom = Infinity, effectSeen = true, xctestFailure = false } = options;
  let log = '';
  let clock = 0;
  const rows: Json[] = [];
  const calls: { method: string; params: Json }[] = [];
  let n = 0;
  const rpc: Rpc = {
    async call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
      calls.push({ method, params });
      const i = n++;
      if (i >= failFrom) throw Object.assign(new Error('E_TIMEOUT: spike.tap passou do prazo'), { code: 'E_TIMEOUT' });
      const variant = String(params['variant']);
      const role = params['effect'] === undefined ? 'restore' : 'measure';
      log += `CONTRARREGRA INFO SP-3 tap seq=${String(params['seq'])} i=0 role=${role} variant=${variant} begin\n`;
      if (variant === 'a') log += `    t = 1s Wait for ${HAGAH} to idle\n    t = 2s Wait for ${HAGAH} to idle\n`;
      if (xctestFailure) log += 'CONTRARREGRA WARN falha do XCTest registrada e ignorada: Failed to synthesize event\n';
      // Como o registro do aparelho: leitura do SpringBoard (700 ms) e snapshot do Hagah (200 ms) na resolução.
      log += "    t =     1.00s Find the Application 'com.apple.springboard'\n    t =     1.00s     Requesting snapshot of accessibility hierarchy for app with pid 35\n"
        + "    t =     1.70s Find the Application 'app.kifactory.hagah'\n    t =     1.70s     Requesting snapshot of accessibility hierarchy for app with pid 900\n"
        + "    t =     1.90s Find the Application 'com.apple.springboard'\n";
      const start = BigInt(1_000_000_000 + i * 10_000_000_000);
      const dispatch = start + 30_000_000n;
      const end = start + BigInt(Math.round(ms(variant, i) * 1e6));
      log += `CONTRARREGRA INFO SP-3 tap seq=${String(params['seq'])} i=0 role=${role} variant=${variant} end\n`;
      const item: Json = { i: 0, role, variant, tDevStartNs: String(start), tDispatchNs: String(dispatch), tDevEndNs: String(end),
        path: variant === 'a' ? 'public' : 'private', detail: variant === 'd' ? { tSubmittedNs: String(dispatch), tCompletedNs: String(end) } : {} };
      if (params['effect'] !== undefined) {
        const seenAt = String(end + 40_000_000n);
        item['effect'] = effectSeen
          ? { satisfied: true, baseline: '0:10', tBaselineNs: String(start), tLowerNs: String(dispatch), tUpperNs: seenAt,
            changes: [{ tNs: seenAt, value: '0:25' }] }
          : { satisfied: false, polls: 30, baseline: '0:10', tBaselineNs: String(start), changes: [] };
      }
      return { taps: [item] } as T;
    },
  };
  const io: PhaseIo = {
    now: () => (clock += 5),
    sleep: async () => {},
    logSize: () => Buffer.byteLength(log),
    readLog: (from, to) => Buffer.from(log).subarray(from, to).toString('utf8'),
    write: (k, data) => rows.push({ k, ...data }),
  };
  return { rpc, io, rows, calls };
}

const TARGETS: Targets = {
  bundleId: HAGAH,
  measure: { target: { label: 'Forward 15 seconds', type: 'button' }, label: 'Forward 15 seconds', frame: { x: 250, y: 600, w: 44, h: 44 } },
  restore: { target: { label: 'Back 15 seconds', type: 'button' }, label: 'Back 15 seconds', frame: { x: 100, y: 600, w: 44, h: 44 } },
  effect: { type: 'staticText', labelMatches: CLOCK_PATTERN, index: 1, attribute: 'label', until: 'clockJump', minJumpS: 10 },
};

const OPTS = { state: 'playing' as const, n: 50, gapMs: 0, settleMs: 0, pressMs: 50, effectTimeoutMs: 3000, restore: true, effect: true, seqStart: 1 };

describe('fase de medição', () => {
  it('50 toques medidos e 50 de restaurar; efeito e pressMs só onde valem; janela do registro por variante', async () => {
    const f = fake(() => 120);
    const result = await runPhase(f.rpc, f.io, TARGETS, { ...OPTS, variant: 'd' });
    assert.equal(result.measured, 50);
    assert.equal(result.errors, 0);
    assert.equal(result.nextSeq, 101);
    const taps = f.rows.filter((r) => r['k'] === 'tap');
    assert.equal(taps.filter((r) => r['role'] === 'measure').length, 50);
    assert.equal(taps.filter((r) => r['role'] === 'restore').length, 50);
    const measure = f.calls[0]?.params as Json;
    const restore = f.calls[1]?.params as Json;
    assert.deepEqual(measure['target'], TARGETS.measure.target);
    assert.equal(measure['pressMs'], 50);
    assert.equal((measure['effect'] as Json)['timeoutMs'], 3000);
    assert.equal(restore['effect'], undefined);
    assert.deepEqual(restore['target'], TARGETS.restore?.target);
    const block = f.rows.find((r) => r['k'] === 'block') as Json;
    assert.equal((block['counts'] as Json)['waitForTargetIdle'], 0);
    assert.equal((block['perTap'] as unknown[]).length, 100);
  });

  it('para depois de 5 erros seguidos', async () => {
    const f = fake(() => 100, { failFrom: 4 });
    const result = await runPhase(f.rpc, f.io, TARGETS, { ...OPTS, variant: 'b' });
    assert.ok(result.stopped?.includes('erros seguidos'));
    assert.ok(result.measured < 50);
  });

  it('para a variante lenta depois de 3 toques acima do limite (não prende a fila por horas)', async () => {
    const f = fake((variant) => (variant === 'a' ? 20_000 : 100));
    let t = 0;
    f.io.now = () => (t += 9_000);
    const result = await runPhase(f.rpc, f.io, TARGETS, { ...OPTS, variant: 'a', restoreVariant: 'd' });
    assert.ok(result.stopped?.startsWith('lento'));
    assert.equal(result.measured, 3);
    const restores = f.calls.filter((c) => c.params['effect'] === undefined);
    assert.ok(restores.every((c) => c.params['variant'] === 'd' && c.params['pressMs'] === 50), 'restaura com a variante pedida');
  });

  it('critério: rápido mas sem o efeito visto não cumpre; sem efeito armado fica indeterminado', async () => {
    const noEffect = fake(() => 90, { effectSeen: false });
    await runPhase(noEffect.rpc, noEffect.io, TARGETS, { ...OPTS, variant: 'b' });
    const b = summarize('t', noEffect.rows).variants[0];
    assert.equal(b?.ok, 50);
    assert.equal(b?.effectSeen, 0);
    assert.equal(b?.meetsCriterion, false);
    assert.equal(summarize('t', noEffect.rows).success, false);

    const unarmed = fake(() => 90);
    await runPhase(unarmed.rpc, unarmed.io, TARGETS, { ...OPTS, variant: 'b', effect: false });
    assert.equal(summarize('t', unarmed.rows).variants[0]?.meetsCriterion, null);
    assert.equal(summarize('t', unarmed.rows).success, false);
  });

  it('critério: falha do XCTest engolida na janela não cumpre', async () => {
    const f = fake(() => 90, { xctestFailure: true });
    await runPhase(f.rpc, f.io, TARGETS, { ...OPTS, variant: 'd' });
    const d = summarize('t', f.rows).variants[0];
    assert.equal(d?.log?.['xctestFailureIgnored'], 100);
    assert.equal(d?.meetsCriterion, false);
  });

  it('critério: menos de 50 toques medidos (fase curta ou interrompida) não cumpre', async () => {
    const f = fake(() => 90);
    await runPhase(f.rpc, f.io, TARGETS, { ...OPTS, variant: 'c', n: 10 });
    const c = summarize('t', f.rows).variants[0];
    assert.equal(c?.ok, 10);
    assert.equal(c?.effectSeen, 10);
    assert.equal(c?.meetsCriterion, false);
    assert.equal(summarize('t', f.rows).success, false);
  });

  it('relatório da repetição no estado pesado: (d), a.coord, snapshots por processo, ui.tree e o reinício a frio', async () => {
    const f = fake((variant) => (variant === 'd' ? 2_000 : 3_000));
    await runPhase(f.rpc, f.io, TARGETS, { ...OPTS, variant: 'd', n: 20, restore: false });
    await runPhase(f.rpc, f.io, TARGETS, { ...OPTS, variant: 'a.coord', n: 5, restore: false });
    f.rows.push({ k: 'uitree', state: 'playing', when: 'start', ok: false, replyMs: 5012, drainedMs: 7400, err: 'E_TIMEOUT' });
    f.rows.push({ k: 'cold', terminate: 900, openURL: 1200, foregroundMs: 800, nowPlayingMs: 4000, playMs: 2100 });
    const report = heavyReport(f.rows);
    assert.match(report, /\| tocando \| d total \(tDevEnd−tDevStart\) \| 2000 \/ 2000 \/ 2000 \(n 20\) \|/);
    assert.match(report, /\| tocando \| a\.coord total/);
    assert.match(report, /\| tocando \| snapshot com\.apple\.springboard \| 700 \/ 700 \/ 700 \(n 25\) \|/);
    assert.match(report, /\| tocando \| snapshot app\.kifactory\.hagah \| 200 \/ 200 \/ 200/);
    assert.match(report, /ui\.tree \(start\) \| estourou; fila livre em 7400 ms/);
    assert.match(report, /\| frio \|.*"nowPlayingMs":4000/);
  });

  it('resumo: (b) rápido e sem esperas cumpre; (a) com esperas não; tabela para o SP-3.md', async () => {
    const f = fake((variant, i) => (variant === 'a' ? 400 + i : 90 + (i % 10)));
    f.rows.push({ k: 'start', bundleId: HAGAH });
    await runPhase(f.rpc, f.io, TARGETS, { ...OPTS, variant: 'a', seqStart: 1 });
    await runPhase(f.rpc, f.io, TARGETS, { ...OPTS, variant: 'b', seqStart: 101 });
    const summary = summarize('t', f.rows);
    const a = summary.variants.find((v) => v.variant === 'a');
    const b = summary.variants.find((v) => v.variant === 'b');
    assert.equal(a?.meetsCriterion, false);
    assert.equal(a?.log?.['waitForTargetIdle'], 200);
    assert.equal(b?.meetsCriterion, true);
    assert.equal(b?.totalMs.p50, 94);
    assert.equal(b?.totalMs.p95, 98);
    assert.equal(b?.effectSeen, 50);
    assert.equal(b?.effectFromStartMs.p50, 134);
    assert.deepEqual(summary.passing, ['b']);
    assert.equal(summary.success, true);
    assert.match(markdownTable(summary), /\| tocando \| b \| 50\/50 \| 94 \| 98 \| 98 \| 98 \|/);
  });
});

// ---------------------------------------------------------------------------------------------------------
// Preparo sozinho contra um Hagah falso (rótulos de research/hagah-targets.md F2–F13)

interface HagahState {
  fg: boolean;
  locked: boolean;
  screen: 'reader' | 'picker' | 'np' | 'other';
  chapter: string;
  version: 'NIV' | 'NVI';
  /** O mini-player existe (algo carregado no player). */
  loaded: boolean;
  playing: boolean;
  repeat: string;
  times: string;
  /** A folha do Now Playing rolada até o Repeat (o transporte sai da tela). */
  repeatVisible: boolean;
  psalmsVisible: boolean;
  psalmsExpanded: boolean;
  linkWorks: boolean;
  /** Como no aparelho com o áudio tocando: o `ui.tree` estoura o prazo de 5 s. */
  slowTree: boolean;
  calls: string[];
}

function hagahState(over: Partial<HagahState> = {}): HagahState {
  return { fg: false, locked: false, screen: 'reader', chapter: 'Genesis 1', version: 'NIV', loaded: false, playing: false,
    repeat: 'Off', times: '∞', repeatVisible: false, psalmsVisible: false, psalmsExpanded: false, linkWorks: true, slowTree: false, calls: [], ...over };
}

function hagahNodes(st: HagahState): TreeNode[] {
  const at = (type: TreeNode['type'], label: string, y: number, visible = true, extra: Partial<TreeNode> = {}): TreeNode =>
    node(type, label, y, { visible, ...extra });
  if (st.screen === 'other') return [at('application', 'Hagah', 0, true, { children: [at('staticText', 'Welcome', 200), at('button', 'Continue', 600)] })];
  const behind = st.screen === 'reader';
  const title = st.version === 'NVI' ? st.chapter.replace('Genesis', 'Gênesis').replace('Psalms', 'Salmos') : st.chapter;
  const reader = [
    at('button', title, 120, behind),
    at('button', st.version, 120, behind),
    at('button', 'Verse 1', 300, behind),
    ...(st.chapter === 'Psalms 23' ? [at('other', 'The LORD is my shepherd, I lack nothing.', 330, behind)] : []),
    ...(st.loaded ? [at('button', 'Open Now Playing: Psalms 23, NIV', 760, behind), at('button', st.playing ? 'Pause' : 'Play', 760, behind)] : []),
    at('button', 'Bible', 820, behind),
  ];
  const extra: TreeNode[] = [];
  if (st.screen === 'picker') {
    extra.push(at('staticText', 'Choose a reading', 80), at('button', 'Close', 80),
      at('button', 'Holy Bible, New International Version®', 150), at('button', st.version === 'NIV' ? 'Genesis' : 'Gênesis', 200),
      at('button', st.version === 'NIV' ? 'Psalms' : 'Salmos', st.psalmsVisible ? 500 : 1200, st.psalmsVisible));
    if (st.psalmsExpanded) extra.push(at('button', '22', 560), at('button', '23', 560));
  }
  if (st.screen === 'np') {
    const top = !st.repeatVisible;
    const repeatY = st.repeatVisible ? 600 : 1000;
    extra.push(at('staticText', 'Psalms 23', 430, top), at('staticText', '0:32', 560, top),
      at('button', 'Back 15 seconds', 600, top), at('button', st.playing ? 'Pause' : 'Play', 600, top), at('button', 'Forward 15 seconds', 600, top),
      ...['Off', 'Passage', 'Verse', 'Chapter'].map((m) => at('button', m, repeatY, st.repeatVisible, { selected: st.repeat === m })),
      ...['∞', '2×'].map((t) => at('button', t, repeatY + 50, st.repeatVisible, { selected: st.times === t, enabled: st.repeat !== 'Off' })),
      at('button', 'Off', repeatY + 120, st.repeatVisible));
  }
  return [at('application', 'Hagah', 0, true, { children: [...reader, ...extra] })];
}

function fakeHagah(st: HagahState): { ctx: PrepCtx; rows: Json[] } {
  let t = 0;
  const rows: Json[] = [];
  const matches = (n: TreeNode, target: Json): boolean => {
    const label = n.label ?? '';
    if (typeof target['type'] === 'string' && n.type !== target['type']) return false;
    if (typeof target['label'] === 'string' && label !== target['label']) return false;
    if (typeof target['labelPrefix'] === 'string' && !label.startsWith(target['labelPrefix'] as string)) return false;
    if (typeof target['labelContains'] === 'string' && !label.includes(target['labelContains'] as string)) return false;
    return n.type !== 'application';
  };
  const find = (target: Json): TreeNode[] => {
    const all = flatten(hagahNodes(st));
    let hits = all.filter((n) => matches(n, target));
    const below = target['below'] as Json | undefined;
    if (below !== undefined) {
      const anchor = all.find((n) => matches(n, below));
      hits = anchor === undefined ? [] : hits.filter((n) => n.frame.y >= anchor.frame.y + anchor.frame.h);
    }
    return hits;
  };
  const resolve = (target: Json): TreeNode => {
    const hits = find(target);
    if (hits.length === 0) throw new ContrarregraError('E_TARGET_NOT_FOUND', 'não achado');
    if (hits.length > 1 && target['index'] === undefined) throw new ContrarregraError('E_TARGET_AMBIGUOUS', 'ambíguo');
    const hit = hits[(target['index'] as number | undefined) ?? 0] as TreeNode;
    if (!hit.visible) throw new ContrarregraError('E_TARGET_NOT_HITTABLE', 'fora da tela');
    return hit;
  };
  const rpc: Rpc = {
    async call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
      st.calls.push(method === 'ui.tap' || method === 'ui.doubleTap' ? `${method} ${JSON.stringify(params['target'])}` : method);
      const target = (params['target'] ?? {}) as Json;
      switch (method) {
        case 'health':
          return { xctestQueueDepth: 0, foregroundApp: st.fg ? HAGAH : 'com.apple.springboard', locked: st.locked } as T;
        case 'app.activate':
          st.fg = true;
          return {} as T;
        case 'device.state':
          return { foregroundApp: st.fg ? HAGAH : 'com.apple.springboard', locked: st.locked } as T;
        case 'ui.tree': {
          if (st.slowTree && st.playing) throw new ContrarregraError('E_TIMEOUT', 'E_TIMEOUT: ui.tree passou do prazo de 5.0 s (rodando na fila do XCTest)');
          const roots = hagahNodes(st);
          const prune = (n: TreeNode): TreeNode => ({ ...n, children: (n.children ?? []).filter((c) => c.visible || params['visibleOnly'] === false).map(prune) });
          return { treeVersion: 1, nodes: roots.map(prune) } as T;
        }
        case 'app.openURL':
          if (st.linkWorks) Object.assign(st, { screen: 'reader', chapter: 'Psalms 23', version: 'NIV', loaded: true });
          return {} as T;
        case 'ui.find': {
          const hits = find(target);
          // Como o runner: sem candidato, E_TARGET_NOT_FOUND.
          if (hits.length === 0) throw new ContrarregraError('E_TARGET_NOT_FOUND', `nenhum candidato para ${JSON.stringify(target)}`);
          return { candidates: hits.map((n) => ({ frame: n.frame, visible: n.visible, hittable: n.visible })) } as T;
        }
        case 'ui.scrollTo':
          if (target['label'] === 'Chapter') st.repeatVisible = true;
          if (target['label'] === 'Forward 15 seconds') st.repeatVisible = false;
          if (target['label'] === 'Psalms') st.psalmsVisible = true;
          return {} as T;
        case 'ui.tap':
        case 'ui.doubleTap': {
          const hit = resolve(target);
          const label = hit.label ?? '';
          if (label.startsWith('Open Now Playing')) Object.assign(st, { screen: 'np', repeatVisible: false });
          else if (label === 'Play' || label.includes('shepherd')) Object.assign(st, { playing: true, loaded: true });
          else if (label === 'Pause') st.playing = false;
          else if (['Off', 'Passage', 'Verse', 'Chapter'].includes(label) && Math.abs(hit.frame.y - (st.repeatVisible ? 600 : 1000)) < 1) st.repeat = label;
          else if (['∞', '2×'].includes(label)) st.times = label;
          else if (label.includes('New International Version')) Object.assign(st, { version: 'NIV', screen: 'reader' });
          else if (st.screen === 'reader' && hit.frame.y === 120 && label !== st.version) st.screen = 'picker';
          else if (label === 'Psalms') st.psalmsExpanded = !st.psalmsExpanded;
          else if (label === '23') Object.assign(st, { chapter: 'Psalms 23', screen: 'reader', loaded: true });
          else if (label === 'Bible') st.screen = 'reader';
          return {} as T;
        }
        default:
          throw new Error(`método inesperado: ${method}`);
      }
    },
  };
  const ctx: PrepCtx = {
    rpc,
    bundleId: HAGAH,
    write: (k, data) => rows.push({ k, ...data }),
    save: () => {},
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
  };
  return { ctx, rows };
}

describe('preparo sozinho (Hagah falso)', () => {
  it('ajudas: título do capítulo, tela do Salmo 23, Repeat, motivo para o dono, candidato mais perto', () => {
    const reader = flatten(hagahNodes(hagahState({ chapter: 'Psalms 23', loaded: true })));
    assert.equal(chapterTitle(reader)?.label, 'Psalms 23');
    assert.equal(psalm23Screen(reader), 'reader');
    assert.equal(psalm23Screen(flatten(hagahNodes(hagahState({ chapter: 'Psalms 23', version: 'NVI' })))), null);
    // Aparelho, 2026-10-14: o leitor rolado (sem o cabeçalho) e o mini-player com o Salmo 23 NIV.
    const scrolled = [node('application', 'Hagah Bible', 0, { children: [node('button', 'Verse 1', 200), node('button', 'Open Now Playing: Psalms 23, NIV', 760),
      node('button', 'Play', 760), node('button', 'Repeating v. 1', 760)] })];
    assert.equal(psalm23Screen(flatten(scrolled)), 'reader');
    const np = flatten(hagahNodes(hagahState({ screen: 'np', chapter: 'Psalms 23', loaded: true, repeat: 'Verse' })));
    assert.equal(psalm23Screen(np), 'nowPlaying');
    assert.equal(repeatRow(np)?.selected, 'Verse');
    assert.equal(repeatRow(np)?.chips.length, 4, 'o "Off" do eco/timer fica fora da fileira');
    assert.match(ownerReason({ locked: true, foregroundApp: HAGAH }, HAGAH) ?? '', /travada/);
    assert.match(ownerReason({ locked: false, foregroundApp: 'com.apple.springboard' }, HAGAH) ?? '', /não está à frente/);
    assert.match(ownerReason({ locked: false, foregroundApp: HAGAH }, HAGAH, [node('secureTextField', 'Password', 300)]) ?? '', /login/);
    assert.equal(ownerReason({ locked: false, foregroundApp: HAGAH }, HAGAH, np), null);
    const c = (y: number, hittable = true) => ({ frame: { x: 0, y, w: 40, h: 40 }, visible: hittable, hittable });
    assert.equal(nearestHittable([c(100), c(700), c(500)]), 1, 'sem altura: o mais de baixo (mini-player)');
    assert.equal(nearestHittable([c(100), c(580), c(600, false)], 620, 40), 1);
    assert.equal(nearestHittable([c(100)], 620, 40), undefined);
  });

  it('pelo link: abre o Hagah, vai ao Salmo 23, abre o Now Playing, liga Repeat "Chapter", toca; no fim pausa e devolve o Repeat', async () => {
    const st = hagahState();
    const { ctx, rows } = fakeHagah(st);
    const { prepared, targets } = await prepare(ctx, { uiOnly: false, repeat: true });
    assert.deepEqual(prepared, { route: 'link', repeatBefore: 'Off', timesBefore: '∞', repeatChanged: true });
    assert.equal(st.screen, 'np');
    assert.equal(st.playing, true);
    assert.equal(st.repeat, 'Chapter');
    assert.equal(st.repeatVisible, false, 'volta ao transporte depois do Repeat');
    assert.ok(st.calls.includes('app.openURL'));
    assert.equal(targets.measure.label, 'Forward 15 seconds');
    assert.equal(targets.restore?.label, 'Back 15 seconds');
    assert.equal(targets.effect?.['index'], 0);
    assert.deepEqual(await discover(ctx), targets);
    await finish(ctx, prepared, 622);
    assert.equal(st.playing, false);
    assert.equal(st.repeat, 'Off', 'o Repeat volta ao que era');
    assert.ok(rows.some((r) => r['k'] === 'repeat-restored' && r['now'] === 'Off'));
  });

  it('pelo seletor: sem link, troca a versão para NIV e escolhe Psalms → 23', async () => {
    const st = hagahState({ fg: true, version: 'NVI', linkWorks: false, repeat: 'Chapter' });
    const { ctx } = fakeHagah(st);
    const { prepared } = await prepare(ctx, { uiOnly: false, repeat: true });
    assert.equal(prepared.route, 'picker');
    assert.equal(prepared.repeatChanged, false, 'Repeat já estava em Chapter');
    assert.equal(st.chapter, 'Psalms 23');
    assert.equal(st.version, 'NIV');
    assert.equal(st.playing, true);
    const taps = st.calls.filter((c) => c.startsWith('ui.'));
    assert.ok(taps.some((c) => c.includes('New International Version')));
    assert.ok(taps.some((c) => c.includes('"label":"23"')));
  });

  it('com o áudio tocando a árvore estoura o prazo: pausa pelo ui.find, prepara e descobre pausado, toca por último', async () => {
    const st = hagahState({ fg: true, screen: 'np', chapter: 'Psalms 23', loaded: true, playing: true, repeat: 'Chapter', slowTree: true });
    const { ctx, rows } = fakeHagah(st);
    const { prepared, targets } = await prepare(ctx, { uiOnly: false, repeat: true });
    assert.equal(prepared.route, 'already');
    assert.equal(targets.measure.label, 'Forward 15 seconds');
    assert.equal(st.playing, true, 'o play volta no fim');
    assert.ok(rows.some((r) => r['k'] === 'prep-step' && r['step'] === 'tree-timeout'));
    const taps = st.calls.filter((c) => c.startsWith('ui.tap'));
    assert.match(taps[0] ?? '', /Pause/);
    assert.match(taps[taps.length - 1] ?? '', /Play/);
    await finish(ctx, prepared, 622);
    assert.equal(st.playing, false);
  });

  it('tela travada: para e pede o dono (código/Face ID), sem tocar em nada', async () => {
    const st = hagahState({ locked: true });
    const { ctx } = fakeHagah(st);
    await assert.rejects(prepare(ctx, { uiOnly: false, repeat: true }), (error: unknown) => {
      assert.ok(error instanceof OwnerNeeded);
      assert.equal(error.step, 'owner');
      assert.match(error.message, /travada/);
      return true;
    });
    assert.ok(!st.calls.some((c) => c.startsWith('ui.tap')));
  });

  it('caminho não achado: para e lista o que viu na árvore', async () => {
    const st = hagahState({ fg: true, screen: 'other', linkWorks: false });
    const { ctx } = fakeHagah(st);
    await assert.rejects(prepare(ctx, { uiOnly: false, repeat: true }), (error: unknown) => {
      assert.ok(error instanceof OwnerNeeded);
      assert.equal(error.step, 'path');
      assert.ok(error.seen.some((s) => s.includes('Welcome')));
      return true;
    });
  });
});
