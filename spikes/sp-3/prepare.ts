// Preparo sozinho do SP-3 (T-0.18): o dono não fica ao lado do iPhone (no cabo, destravado, tela acesa). Pelo runner:
// o Hagah à frente (`app.activate`), o Salmo 23 NIV (link `hagah://bible/ENGNIV/PSA/23` ou o seletor de capítulo),
// o Now Playing aberto, Repeat "Chapter" ligado (devolvido no fim) e o áudio tocando; no fim, áudio pausado. Só para
// com `OwnerNeeded` no que exige uma pessoa: tela travada (código/Face ID), o Hagah fora da frente (alerta do sistema,
// notificação), login no Hagah, ou caminho não achado — com os rótulos vistos. Rótulos do Hagah: research/
// hagah-targets.md F2–F13, F51 (conferidos no build 7 pelo `ui.tree`, registrado em `out/`). Código de spike,
// descartável; testado com um Hagah falso em `sp3.test.ts`.

import { isContrarregraError } from '../../mac/src/core/errors.ts';
import type { TreeNode } from '../../mac/src/core/types.ts';
import {
  CLOCK_PATTERN,
  MEASURE_PATTERNS,
  PSALM23_LINK,
  RESTORE_PATTERNS,
  chapterTitle,
  clockSeconds,
  flatten,
  nearestHittable,
  ownerReason,
  pickButton,
  pickClock,
  playState,
  psalm23Screen,
  redact,
  repeatRow,
  showsPsalm23,
  visibleLabels,
  type FindCandidate,
  type Json,
  type Rpc,
  type TargetInfo,
  type Targets,
} from './lib.ts';

/** Algo que só o dono resolve: o driver para e diz o que viu. */
export class OwnerNeeded extends Error {
  readonly step: string;
  readonly seen: string[];
  constructor(step: string, message: string, seen: string[] = []) {
    super(message);
    this.step = step;
    this.seen = seen;
  }
}

/** O que o preparo usa do driver (injetado nos testes). */
export interface PrepCtx {
  rpc: Rpc;
  bundleId: string;
  write(k: string, data: Json): void;
  /** Grava `out/<label>-<suffix>`. */
  save(suffix: string, text: string): void;
  now(): number;
  sleep(ms: number): Promise<void>;
}

export interface Prepared {
  /** Como chegou ao Salmo 23: `already`, `link` ou `picker`. */
  route: string;
  /** O modo e as vezes do Repeat antes de mexer (devolvidos no fim) e se algo mudou. */
  repeatBefore: string | null;
  timesBefore: string | null;
  repeatChanged: boolean;
}

type RepeatInfo = Pick<Prepared, 'repeatBefore' | 'timesBefore' | 'repeatChanged'>;

function errCode(error: unknown): string {
  if (isContrarregraError(error)) return `${error.code}: ${error.message.slice(0, 200)}`;
  return error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200);
}

/**
 * Espera a fila do XCTest esvaziar (`health` na fila de controle). Um comando que estourou o prazo "rodando" continua
 * no aparelho e segura a fila; com o Hagah tocando, cada leitura da tela leva segundos (SP-2: até minutos de fila).
 */
export async function drainQueue(ctx: PrepCtx, maxMs = 180_000): Promise<void> {
  const deadline = ctx.now() + maxMs;
  for (;;) {
    try {
      const health = await ctx.rpc.call<{ xctestQueueDepth: number }>('health', {}, { timeoutMs: 3_000 });
      if (health.xctestQueueDepth === 0) return;
      ctx.write('drain', { depth: health.xctestQueueDepth });
    } catch (error) {
      ctx.write('drain', { err: errCode(error) });
    }
    if (ctx.now() > deadline) throw new Error(`a fila do XCTest não esvaziou em ${Math.round(maxMs / 1000)} s`);
    await ctx.sleep(1_000);
  }
}

/** Leitura que pode estourar o prazo com o app animando: espera a fila esvaziar e tenta de novo (até 4 vezes). */
async function reading<T>(ctx: PrepCtx, what: string, read: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await read();
    } catch (error) {
      if (!isContrarregraError(error, 'E_TIMEOUT') || attempt >= 3) throw error;
      ctx.write('retry', { what, attempt, err: errCode(error) });
      await drainQueue(ctx);
    }
  }
}

export async function tree(ctx: PrepCtx, visibleOnly: boolean): Promise<TreeNode[]> {
  const result = await reading(ctx, 'ui.tree', () =>
    ctx.rpc.call<{ nodes: TreeNode[] }>('ui.tree', { format: 'json', visibleOnly }, { timeoutMs: 15_000 }));
  return flatten(result.nodes);
}

/** O estado do aparelho e, com o Hagah à frente, a árvore visível; para no que exige o dono. */
export async function look(ctx: PrepCtx): Promise<TreeNode[]> {
  const state = await reading(ctx, 'device.state', () =>
    ctx.rpc.call<{ foregroundApp: string; locked: boolean }>('device.state', {}, { timeoutMs: 15_000 }));
  const early = ownerReason(state, ctx.bundleId);
  if (early !== null) throw new OwnerNeeded('owner', early);
  const nodes = await tree(ctx, true);
  const reason = ownerReason(state, ctx.bundleId, nodes);
  if (reason !== null) throw new OwnerNeeded('owner', reason, visibleLabels(nodes));
  return nodes;
}

/**
 * Repete `look` até `ok` valer ou `timeoutMs` passar; devolve a última árvore e se valeu. Dentro do prazo, o Hagah
 * fora da frente é tolerado (a troca de app depois de `app.activate`/`app.openURL` leva um instante); no fim do
 * prazo, vira `OwnerNeeded`.
 */
export async function lookUntil(ctx: PrepCtx, ok: (nodes: TreeNode[]) => boolean, timeoutMs: number): Promise<{ nodes: TreeNode[]; ok: boolean }> {
  const deadline = ctx.now() + timeoutMs;
  for (;;) {
    let nodes: TreeNode[] = [];
    try {
      nodes = await look(ctx);
      if (ok(nodes)) return { nodes, ok: true };
    } catch (error) {
      if (!(error instanceof OwnerNeeded) || ctx.now() > deadline) throw error;
    }
    if (ctx.now() > deadline) return { nodes, ok: false };
    await ctx.sleep(700);
  }
}

/**
 * Acha `target` com `ui.find` e toca (`method`) no candidato tocável escolhido por `choose` (padrão: o primeiro
 * tocável), com `index` quando há mais de um. `false` se não houver candidato tocável. `E_FORBIDDEN_APP` = algo do
 * sistema na frente: para e pede o dono.
 */
export async function tapFound(ctx: PrepCtx, step: string, target: Json, choose?: (candidates: FindCandidate[]) => number | undefined,
  method = 'ui.tap'): Promise<boolean> {
  try {
    const found = await reading(ctx, 'ui.find', () =>
      ctx.rpc.call<{ candidates: FindCandidate[] }>('ui.find', { target }, { timeoutMs: 15_000 }));
    const index = choose === undefined ? found.candidates.findIndex((c) => c.hittable) : choose(found.candidates);
    if (index === undefined || index < 0) {
      ctx.write('prep-step', { step, target, ok: false, why: 'sem candidato tocável', candidates: found.candidates.length });
      return false;
    }
    const finalTarget = found.candidates.length > 1 ? { ...target, index } : target;
    try {
      await ctx.rpc.call(method, { target: finalTarget }, { timeoutMs: 15_000 });
    } catch (error) {
      // SP-2: E_TIMEOUT "rodando" = o toque aconteceu, só a resposta se perdeu. Nunca repetir (Play viraria Pause).
      if (!isContrarregraError(error, 'E_TIMEOUT')) throw error;
      ctx.write('prep-step', { step, target: finalTarget, ok: true, method, timedOut: errCode(error) });
      await drainQueue(ctx);
      return true;
    }
    ctx.write('prep-step', { step, target: finalTarget, ok: true, method });
    return true;
  } catch (error) {
    if (isContrarregraError(error, 'E_FORBIDDEN_APP')) throw new OwnerNeeded(step, `algo do sistema está na frente do Hagah (${errCode(error)})`);
    if (isContrarregraError(error, 'E_TARGET_NOT_FOUND') || isContrarregraError(error, 'E_TARGET_NOT_HITTABLE')
      || isContrarregraError(error, 'E_TARGET_AMBIGUOUS')) {
      ctx.write('prep-step', { step, target, ok: false, err: errCode(error) });
      return false;
    }
    throw error;
  }
}

/** `ui.scrollTo` até o alvo ficar tocável; `false` se não deu (sem erro). */
export async function scrollTo(ctx: PrepCtx, step: string, target: Json, direction: 'up' | 'down', maxSwipes: number): Promise<boolean> {
  try {
    await ctx.rpc.call('ui.scrollTo', { target, direction, maxSwipes }, { timeoutMs: 60_000 });
    ctx.write('prep-step', { step, target, ok: true, method: 'ui.scrollTo', direction });
    return true;
  } catch (error) {
    if (isContrarregraError(error, 'E_FORBIDDEN_APP')) throw new OwnerNeeded(step, `algo do sistema está na frente do Hagah (${errCode(error)})`);
    ctx.write('prep-step', { step, target, ok: false, method: 'ui.scrollTo', err: errCode(error) });
    return false;
  }
}

/** A altura do centro do botão de avançar (a fileira do transporte do Now Playing), se visível. */
export function forwardY(nodes: TreeNode[]): number | undefined {
  const node = pickButton(nodes, MEASURE_PATTERNS).node;
  return node === undefined ? undefined : node.frame.y + node.frame.h / 2;
}

// Com o Hagah tocando, cada consulta do XCTest ao app leva ~1 s e o `ui.tree` (prazo fixo de 5 s no runner) estoura
// sempre (SP-3, 2026-10-14). Enquanto toca, só `health` (fila de controle) e `ui.find` (10 s); a árvore só com o áudio
// pausado.

/** O candidato tocável de `{label, type: button}` mais perto da altura `y` (±40 pt); sem `y`, o de cima. */
async function findButton(ctx: PrepCtx, label: string, y?: number): Promise<{ index: number; count: number } | undefined> {
  let found: { candidates: FindCandidate[] };
  try {
    found = await reading(ctx, 'ui.find', () =>
      ctx.rpc.call<{ candidates: FindCandidate[] }>('ui.find', { target: { label, type: 'button' } }, { timeoutMs: 15_000 }));
  } catch (error) {
    // `ui.find` sem candidato responde E_TARGET_NOT_FOUND.
    if (isContrarregraError(error, 'E_TARGET_NOT_FOUND')) return undefined;
    throw error;
  }
  const index = y === undefined
    ? found.candidates.map((c, i) => ({ c, i })).filter((x) => x.c.hittable).sort((a, b) => a.c.frame.y - b.c.frame.y)[0]?.i
    : nearestHittable(found.candidates, y, 40);
  return index === undefined ? undefined : { index, count: found.candidates.length };
}

/** Tocando × pausado pelo botão da fileira do transporte, só com `ui.find`. */
export async function audioState(ctx: PrepCtx, y?: number): Promise<'playing' | 'paused' | 'unknown'> {
  if ((await findButton(ctx, 'Pause', y)) !== undefined) return 'playing';
  if ((await findButton(ctx, 'Play', y)) !== undefined) return 'paused';
  return 'unknown';
}

/** Toca "Pause" (ou "Play") da fileira do transporte e confere pelo `ui.find`; `false` se não deu. */
export async function toggleAudio(ctx: PrepCtx, want: 'playing' | 'paused', y?: number): Promise<boolean> {
  const label = want === 'paused' ? 'Pause' : 'Play';
  for (let attempt = 0; attempt < 2; attempt++) {
    const state = await audioState(ctx, y);
    if (state === want) return true;
    const hit = await findButton(ctx, label, y);
    if (hit === undefined) return false;
    await tapFound(ctx, want === 'paused' ? 'pause' : 'play', { label, type: 'button' }, () => hit.index);
    await ctx.sleep(1_000);
  }
  return (await audioState(ctx, y)) === want;
}

/** Pelo seletor de capítulo (F3–F5): título do capítulo → (versão NIV) → "Psalms" → "23". */
export async function navigateByPicker(ctx: PrepCtx): Promise<boolean> {
  let nodes = await look(ctx);
  if (chapterTitle(nodes) === undefined) {
    await tapFound(ctx, 'tab-bible', { label: 'Bible' });
    nodes = (await lookUntil(ctx, (n) => chapterTitle(n) !== undefined, 4_000)).nodes;
  }
  const openPicker = async (): Promise<boolean> => {
    const title = chapterTitle(await look(ctx));
    if (title === undefined || !(await tapFound(ctx, 'open-picker', { label: title.label ?? '', type: 'button' }))) return false;
    await ctx.sleep(1_000);
    const all = await tree(ctx, false);
    return all.some((n) => n.type === 'button' && /New International Version|^Psalms$|^Genesis$/.test(n.label ?? ''));
  };
  if (!nodes.some((n) => n.type === 'button' && n.visible && n.label === 'NIV')) {
    // F4: escolher a versão fecha o seletor e navega na hora; depois, outra passada para o capítulo.
    if (!(await openPicker())) return false;
    if (!(await tapFound(ctx, 'version-niv', { labelContains: 'New International Version', type: 'button' }))) return false;
    await lookUntil(ctx, (n) => n.some((x) => x.type === 'button' && x.label === 'NIV'), 6_000);
  }
  if (!(await openPicker())) return false;
  const chapter: Json = { label: '23', type: 'button', below: { label: 'Psalms', type: 'button' } };
  const found = await reading(ctx, 'ui.find', () =>
    ctx.rpc.call<{ candidates: FindCandidate[] }>('ui.find', { target: chapter }, { timeoutMs: 15_000 }))
    .catch(() => ({ candidates: [] as FindCandidate[] }));
  if (found.candidates.length === 0) {
    await scrollTo(ctx, 'scroll-psalms', { label: 'Psalms', type: 'button' }, 'down', 10);
    if (!(await tapFound(ctx, 'book-psalms', { label: 'Psalms', type: 'button' }))) return false;
    await ctx.sleep(800);
  }
  await scrollTo(ctx, 'scroll-23', chapter, 'down', 8);
  if (!(await tapFound(ctx, 'chapter-23', chapter))) return false;
  return (await lookUntil(ctx, (n) => psalm23Screen(n) === 'reader', 8_000)).ok;
}

const TIMES = ['∞', '2×', '3×', '5×'];

/** Liga Repeat "Chapter" (e ∞) no Now Playing, se a fileira existir (F13, F14); devolve o que havia antes. */
export async function setRepeatChapter(ctx: PrepCtx): Promise<RepeatInfo> {
  const all = await tree(ctx, false);
  const row = repeatRow(all);
  const timesBefore = all.find((n) => n.type === 'button' && TIMES.includes(n.label ?? '') && n.selected)?.label ?? null;
  if (row === undefined) {
    ctx.write('repeat', { found: false });
    return { repeatBefore: null, timesBefore, repeatChanged: false };
  }
  if (row.selected === 'Chapter' && (timesBefore === null || timesBefore === '∞')) {
    ctx.write('repeat', { found: true, before: row.selected, times: timesBefore, changed: false });
    return { repeatBefore: row.selected, timesBefore, repeatChanged: false };
  }
  await scrollTo(ctx, 'scroll-repeat', { label: 'Chapter', type: 'button' }, 'down', 4);
  if (row.selected !== 'Chapter') {
    const fresh = repeatRow(await tree(ctx, true));
    await tapFound(ctx, 'repeat-chapter', { label: 'Chapter', type: 'button' }, (c) => nearestHittable(c, fresh?.y, 20));
    await ctx.sleep(600);
  }
  const infinite = (await tree(ctx, true)).find((n) => n.type === 'button' && n.label === '∞');
  if (infinite !== undefined && !infinite.selected && infinite.enabled) {
    await tapFound(ctx, 'repeat-infinite', { label: '∞', type: 'button' });
    await ctx.sleep(600);
  }
  const after = repeatRow(await tree(ctx, false));
  ctx.write('repeat', { found: true, before: row.selected, times: timesBefore, changed: true, after: after?.selected ?? null });
  return { repeatBefore: row.selected, timesBefore, repeatChanged: true };
}

/** Volta o Repeat ao que era antes do preparo (melhor esforço; registrado). Vezes antes do modo: com "Off" ficam desligadas. */
export async function restoreRepeat(ctx: PrepCtx, prepared: Prepared): Promise<void> {
  if (!prepared.repeatChanged) return;
  await scrollTo(ctx, 'scroll-repeat', { label: 'Chapter', type: 'button' }, 'down', 4);
  if (prepared.timesBefore !== null && prepared.timesBefore !== '∞') {
    await tapFound(ctx, 'restore-times', { label: prepared.timesBefore, type: 'button' });
    await ctx.sleep(500);
  }
  if (prepared.repeatBefore !== null && prepared.repeatBefore !== 'Chapter') {
    const row = repeatRow(await tree(ctx, true));
    await tapFound(ctx, 'restore-repeat', { label: prepared.repeatBefore, type: 'button' }, (c) => nearestHittable(c, row?.y, 20));
    await ctx.sleep(500);
  }
  ctx.write('repeat-restored', { now: repeatRow(await tree(ctx, false))?.selected ?? null, wanted: prepared.repeatBefore });
}

export interface PrepOptions {
  /** Não tenta o link; vai direto pelo seletor. */
  uiOnly: boolean;
  /** Liga Repeat "Chapter". */
  repeat: boolean;
  /** O preparo anterior (no refazer do meio da medição, o "antes" do Repeat que vale é o do primeiro). */
  previous?: Prepared;
}

/** A árvore já, numa tentativa só; `undefined` se estourou o prazo (o Hagah tocando). */
async function treeOnce(ctx: PrepCtx): Promise<TreeNode[] | undefined> {
  try {
    const result = await ctx.rpc.call<{ nodes: TreeNode[] }>('ui.tree', { format: 'json', visibleOnly: true }, { timeoutMs: 15_000 });
    return flatten(result.nodes);
  } catch (error) {
    if (!isContrarregraError(error, 'E_TIMEOUT')) throw error;
    ctx.write('prep-step', { step: 'tree-timeout', err: errCode(error) });
    await drainQueue(ctx);
    return undefined;
  }
}

/**
 * Hagah à frente, no Salmo 23 NIV, Now Playing aberto, Repeat "Chapter", alvos descobertos (com o áudio pausado, a
 * árvore cabe no prazo) e, por último, o áudio tocando. Para com `OwnerNeeded` no que exige o dono.
 */
export async function prepare(ctx: PrepCtx, opts: PrepOptions): Promise<{ prepared: Prepared; targets: Targets }> {
  await drainQueue(ctx);
  await reading(ctx, 'app.activate', () => ctx.rpc.call('app.activate', { bundleId: ctx.bundleId }, { timeoutMs: 15_000 }));
  await ctx.sleep(1_000);
  // Tocando, a árvore não cabe no prazo: pausa antes (pelo `ui.find`), e o play volta no fim.
  if ((await treeOnce(ctx)) === undefined) {
    const state = await ctx.rpc.call<{ foregroundApp: string; locked: boolean }>('health', {}, { timeoutMs: 3_000 });
    const reason = ownerReason(state, ctx.bundleId);
    if (reason !== null) throw new OwnerNeeded('owner', reason);
    if (!(await toggleAudio(ctx, 'paused'))) throw new OwnerNeeded('pause', 'o Hagah está ocupado demais para ler a tela e não achei o botão Pause');
  }
  let { nodes } = await lookUntil(ctx, (n) => n.length > 3, 6_000);
  let route = 'already';
  if (psalm23Screen(nodes) === null) {
    let there = false;
    if (!opts.uiOnly) {
      route = 'link';
      try {
        await ctx.rpc.call('app.openURL', { url: PSALM23_LINK }, { timeoutMs: 15_000 });
        await ctx.sleep(1_500);
        there = (await lookUntil(ctx, (n) => psalm23Screen(n) !== null, 8_000)).ok;
      } catch (error) {
        if (error instanceof OwnerNeeded) throw error;
        ctx.write('prep-step', { step: 'open-link', ok: false, err: errCode(error) });
      }
    }
    if (!there) {
      route = 'picker';
      there = await navigateByPicker(ctx);
    }
    nodes = await look(ctx);
    if (!there || psalm23Screen(nodes) === null) {
      throw new OwnerNeeded('path', 'não achei o caminho até o Salmo 23 NIV no Hagah', visibleLabels(nodes));
    }
  }

  if (psalm23Screen(nodes) !== 'nowPlaying') {
    const opened = await tapFound(ctx, 'open-now-playing', { labelPrefix: 'Open Now Playing', type: 'button' }, (c) => nearestHittable(c));
    if (!opened) {
      // Sem mini-player ainda: tocar pelo versículo 1 (toque duplo no corpo do versículo, F7) faz o player aparecer.
      await tapFound(ctx, 'listen-verse-1', { labelContains: 'shepherd' }, undefined, 'ui.doubleTap');
      await ctx.sleep(2_000);
      await toggleAudio(ctx, 'paused');
      await tapFound(ctx, 'open-now-playing', { labelPrefix: 'Open Now Playing', type: 'button' }, (c) => nearestHittable(c));
    }
    const open = await lookUntil(ctx, (n) => psalm23Screen(n) === 'nowPlaying', 6_000);
    if (!open.ok) throw new OwnerNeeded('path', 'o Now Playing do Salmo 23 não abriu', visibleLabels(open.nodes));
  }

  let repeat: RepeatInfo = { repeatBefore: null, timesBefore: null, repeatChanged: false };
  if (opts.repeat) {
    const current = await setRepeatChapter(ctx);
    const first = opts.previous ?? current;
    repeat = { repeatBefore: first.repeatBefore, timesBefore: first.timesBefore, repeatChanged: first.repeatChanged || current.repeatChanged };
  }

  // De volta ao transporte (o Repeat fica abaixo da metade da folha).
  await scrollTo(ctx, 'scroll-transport', { label: 'Forward 15 seconds', type: 'button' }, 'up', 4);
  nodes = await look(ctx);
  const fy = forwardY(nodes);
  if (fy === undefined) throw new OwnerNeeded('path', 'o transporte do Now Playing (avançar 15 s) não aparece', visibleLabels(nodes));
  if (!showsPsalm23(nodes)) throw new OwnerNeeded('path', 'o Now Playing não mostra o Salmo 23', visibleLabels(nodes));
  const targets = await discover(ctx);
  if (!(await toggleAudio(ctx, 'playing', fy))) throw new OwnerNeeded('play', 'o áudio do Salmo 23 não começou a tocar', visibleLabels(nodes));
  const prepared: Prepared = { route, ...repeat };
  ctx.write('prepared', { ...prepared });
  ctx.save('prepare.json', `${JSON.stringify({ at: new Date().toISOString(), ...prepared }, null, 2)}\n`);
  return { prepared, targets };
}

/** Pausa pelo "Pause" da fileira do transporte (`y` = altura do botão medido; toque público `ui.tap`). */
export async function autoPause(ctx: PrepCtx, y?: number): Promise<boolean> {
  return toggleAudio(ctx, 'paused', y);
}

/** Fim: áudio pausado e, com ele pausado (a árvore volta a caber no prazo), o Repeat devolvido. */
export async function finish(ctx: PrepCtx, prepared: Prepared | undefined, y?: number): Promise<void> {
  if (!(await autoPause(ctx, y)) && !(await autoPause(ctx))) {
    throw new OwnerNeeded('pause', 'não consegui pausar o áudio do Hagah no fim');
  }
  if (prepared !== undefined) await restoreRepeat(ctx, prepared);
}

// ---------------------------------------------------------------------------------------------------------
// Alvos

/** O alvo de `ui.tap`/`spike.tap` para um botão: rótulo + tipo, com `index` se houver mais de um. */
export async function buttonTarget(ctx: PrepCtx, node: TreeNode): Promise<TargetInfo> {
  const label = node.label ?? '';
  const base: Json = { label, type: 'button' };
  const found = await reading(ctx, 'ui.find', () =>
    ctx.rpc.call<{ candidates: FindCandidate[] }>('ui.find', { target: base }, { timeoutMs: 15_000 }));
  if (found.candidates.length <= 1) return { target: base, label, frame: node.frame };
  const cy = node.frame.y + node.frame.h / 2;
  const cx = node.frame.x + node.frame.w / 2;
  const ranked = found.candidates
    .map((c, index) => ({ index, c, d: Math.hypot(c.frame.x + c.frame.w / 2 - cx, c.frame.y + c.frame.h / 2 - cy) }))
    .sort((a, b) => a.d - b.d);
  const best = ranked[0] as (typeof ranked)[number];
  return { target: { ...base, index: best.index }, label, frame: best.c.frame };
}

/** Os alvos no Now Playing já aberto (depois de `prepare`): o botão medido, o de restaurar e o relógio do efeito. */
export async function discover(ctx: PrepCtx): Promise<Targets> {
  const all = await tree(ctx, false);
  ctx.save('tree.json', `${redact(JSON.stringify(all.map(({ children: _c, ...n }) => n), null, 1))}\n`);
  const measure = pickButton(all, MEASURE_PATTERNS);
  const buttons = all.filter((n) => n.type === 'button' && n.visible).map((n) => ({ label: n.label, frame: n.frame }));
  if (measure.node === undefined) {
    ctx.write('targets', { ok: false, buttons });
    throw new OwnerNeeded('path', 'não achei o botão de avançar 15 s no Now Playing', visibleLabels(all));
  }
  const restorePick = pickButton(all, RESTORE_PATTERNS);
  const measureInfo = await buttonTarget(ctx, measure.node);
  const restoreInfo = restorePick.node === undefined ? undefined : await buttonTarget(ctx, restorePick.node);
  const clock = pickClock(all, measureInfo.frame);
  // A duração do capítulo: o relógio decorrido + o restante ("−0:42") na mesma fileira (para a leitura do efeito).
  const elapsed = clock === undefined ? undefined : clockSeconds(clock.node.label ?? '');
  const remaining = clock === undefined ? undefined : all
    .filter((n) => n.label !== undefined && Math.abs(n.frame.y - clock.node.frame.y) <= 5)
    .map((n) => clockSeconds(n.label ?? ''))
    .find((v) => v !== undefined && v < 0);
  const chapterS = elapsed !== undefined && elapsed >= 0 && remaining !== undefined ? elapsed - remaining : undefined;
  const targets: Targets = {
    bundleId: ctx.bundleId,
    ...(chapterS === undefined ? {} : { chapterS }),
    measure: measureInfo,
    ...(restoreInfo === undefined ? {} : { restore: restoreInfo }),
    ...(clock === undefined ? {} : {
      effect: { type: clock.node.type, labelMatches: CLOCK_PATTERN, index: clock.index, attribute: 'label', until: 'clockJump', minJumpS: 10 },
    }),
  };
  const record = {
    at: new Date().toISOString(),
    ...targets,
    measureAlternatives: measure.alternatives.map((n) => ({ label: n.label, frame: n.frame })),
    restoreAlternatives: restorePick.alternatives.map((n) => ({ label: n.label, frame: n.frame })),
    clock: clock === undefined ? null : { label: clock.node.label, type: clock.node.type, frame: clock.node.frame, index: clock.index,
      alternatives: clock.alternatives.map((n) => ({ label: n.label, type: n.type, frame: n.frame, visible: n.visible })) },
    buttons,
  };
  ctx.save('targets.json', `${redact(JSON.stringify(record, null, 2))}\n`);
  ctx.write('targets', { ok: true, ...record });
  return targets;
}
