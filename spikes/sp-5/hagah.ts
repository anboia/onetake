// Preparo sozinho do Hagah para o SP-5 (T-0.20): o dono não fica ao lado do iPhone (no cabo, destravado, tela acesa).
// Copiado e enxugado de `spikes/sp-3/prepare.ts` + `spikes/sp-3/lib.ts` (SP-3, T-0.18; rótulos de
// research/hagah-targets.md F2–F13, F51, conferidos no build 7): pelo runner, o Hagah à frente (`app.activate`), o
// Salmo 23 NIV pelo link `hagah://bible/ENGNIV/PSA/23` (sem o seletor de capítulo: se o link não levar, para e pede o
// dono), o Now Playing aberto, Repeat "Chapter" ligado (devolvido no fim) e o áudio tocando; no fim, áudio pausado.
// Mais: o botão Play/Pause do transporte (quadro em pontos, para a virada do ícone no A/V), o toque nele e o
// hospedeiro à frente (o relógio de calibração, S0.10). Só para com `OwnerNeeded` no que exige uma pessoa.
// Código de spike, descartável.

import { isContrarregraError } from '../../mac/src/core/errors.ts';
import type { Rect, TreeNode } from '../../mac/src/core/types.ts';
import type { Json } from './lib.ts';

export interface Rpc {
  call<T = unknown>(method: string, params?: Record<string, unknown>, options?: { timeoutMs?: number }): Promise<T>;
}

/** Os candidatos de `ui.find` (S1 item 4). */
export interface FindCandidate {
  ref?: string;
  frame: Rect;
  visible: boolean;
  hittable: boolean;
  value?: string;
}

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

export interface PrepCtx {
  rpc: Rpc;
  /** `app.explore` (o Hagah). */
  bundleId: string;
  write(k: string, data: Json): void;
  now(): number;
  sleep(ms: number): Promise<void>;
}

// ---------------------------------------------------------------------------------------------------------
// Árvore do Hagah (de spikes/sp-3/lib.ts)

export function flatten(roots: TreeNode[]): TreeNode[] {
  const out: TreeNode[] = [];
  const walk = (node: TreeNode): void => {
    out.push(node);
    for (const child of node.children ?? []) walk(child);
  };
  for (const root of roots) walk(root);
  return out;
}

const FORWARD_PATTERNS: RegExp[] = [/^Forward 15 seconds$/i, /^(Skip )?forward\b/i];
const EXCLUDED_BUTTONS = /verse|chapter|close/i;

function pickButton(nodes: TreeNode[], patterns: RegExp[]): TreeNode | undefined {
  const buttons = nodes.filter((n) => n.type === 'button' && n.visible && n.enabled && n.label !== undefined && !EXCLUDED_BUTTONS.test(n.label));
  for (const pattern of patterns) {
    const hit = buttons.find((n) => pattern.test(n.label ?? ''));
    if (hit !== undefined) return hit;
  }
  return undefined;
}

const centerY = (n: { frame: Rect }): number => n.frame.y + n.frame.h / 2;

export function showsPsalm23(nodes: TreeNode[]): boolean {
  return nodes.some((n) => /\bPsalms? 23\b/i.test(n.label ?? '') || /\bPsalms? 23\b/i.test(n.value ?? ''));
}

export const PSALM23_LINK = 'hagah://bible/ENGNIV/PSA/23';

/** `reader` = leitor no Salmo 23 NIV; `nowPlaying` = o Now Playing aberto com ele; `null` = outra coisa. */
export function psalm23Screen(nodes: TreeNode[]): 'reader' | 'nowPlaying' | null {
  const visible = nodes.filter((n) => n.visible);
  const buttons = visible.filter((n) => n.type === 'button');
  if (pickButton(nodes, FORWARD_PATTERNS) !== undefined && showsPsalm23(visible)) return 'nowPlaying';
  const title = buttons.some((n) => /^Psalms 23\b/.test(n.label ?? ''));
  const niv = buttons.some((n) => n.label === 'NIV');
  const miniPlayer = buttons.some((n) => /^Open Now Playing: Psalms 23, NIV\b/.test(n.label ?? ''));
  return (title && niv) || miniPlayer ? 'reader' : null;
}

export function ownerReason(state: { locked: boolean; foregroundApp: string }, bundleId: string, nodes: TreeNode[] = []): string | null {
  if (state.locked) return 'a tela está travada: destrave o iPhone (código ou Face ID) e deixe a tela acesa';
  if (state.foregroundApp !== bundleId) {
    return `o app esperado não está à frente (à frente: ${state.foregroundApp || 'desconhecido'}); pode ser um alerta do sistema ou uma notificação cobrindo a tela`;
  }
  if (nodes.some((n) => n.visible && n.type === 'secureTextField')) return 'o Hagah está pedindo login (campo de senha na tela)';
  return null;
}

export function nearestHittable(candidates: FindCandidate[], y?: number, maxDistance = Infinity): number | undefined {
  const ranked = candidates
    .map((c, index) => ({ index, c, d: y === undefined ? -centerY(c) : Math.abs(centerY(c) - y) }))
    .filter((x) => x.c.hittable && (y === undefined || x.d <= maxDistance))
    .sort((a, b) => a.d - b.d);
  return ranked[0]?.index;
}

const REPEAT_MODES = ['Off', 'Passage', 'Verse', 'Chapter', 'Book', '⋯'];

export function repeatRow(nodes: TreeNode[]): { y: number; selected: string | null } | undefined {
  const chapter = nodes.find((n) => n.type === 'button' && n.label === 'Chapter');
  if (chapter === undefined) return undefined;
  const y = centerY(chapter);
  const chips = nodes.filter((n) => n.type === 'button' && REPEAT_MODES.includes(n.label ?? '') && Math.abs(centerY(n) - y) <= 12);
  return { y, selected: chips.find((n) => n.selected)?.label ?? null };
}

export function redact(text: string): string {
  return text.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '<redacted>');
}

export function visibleLabels(nodes: TreeNode[], max = 60): string[] {
  const out: string[] = [];
  for (const n of nodes) {
    if (!n.visible || n.label === undefined || out.includes(n.label)) continue;
    out.push(redact(`${n.type} "${n.label}"`));
    if (out.length >= max) break;
  }
  return out;
}

/** O botão Play (ou Pause) da fileira do transporte: o mais perto da altura do "Forward 15 seconds" (±40 pt). */
export function transportToggle(nodes: TreeNode[]): { label: string; frame: Rect; forwardY: number } | undefined {
  const forward = pickButton(nodes, FORWARD_PATTERNS);
  if (forward === undefined) return undefined;
  const y = centerY(forward);
  const candidates = nodes
    .filter((n) => n.type === 'button' && n.visible && (n.label === 'Play' || n.label === 'Pause') && Math.abs(centerY(n) - y) <= 40)
    .sort((a, b) => Math.abs(centerY(a) - y) - Math.abs(centerY(b) - y));
  const hit = candidates[0];
  return hit === undefined ? undefined : { label: hit.label!, frame: hit.frame, forwardY: y };
}

// ---------------------------------------------------------------------------------------------------------
// Passos pelo runner (de spikes/sp-3/prepare.ts)

function errCode(error: unknown): string {
  if (isContrarregraError(error)) return `${error.code}: ${error.message.slice(0, 200)}`;
  return error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200);
}

/** Espera a fila do XCTest esvaziar (um comando que estourou o prazo "rodando" continua no aparelho; SP-2, SP-3). */
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
  const result = await reading(ctx, 'ui.tree', () => ctx.rpc.call<{ nodes: TreeNode[] }>('ui.tree', { format: 'json', visibleOnly }, { timeoutMs: 15_000 }));
  return flatten(result.nodes);
}

export async function look(ctx: PrepCtx): Promise<TreeNode[]> {
  const state = await reading(ctx, 'device.state', () => ctx.rpc.call<{ foregroundApp: string; locked: boolean }>('device.state', {}, { timeoutMs: 15_000 }));
  const early = ownerReason(state, ctx.bundleId);
  if (early !== null) throw new OwnerNeeded('owner', early);
  const nodes = await tree(ctx, true);
  const reason = ownerReason(state, ctx.bundleId, nodes);
  if (reason !== null) throw new OwnerNeeded('owner', reason, visibleLabels(nodes));
  return nodes;
}

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

export async function tapFound(ctx: PrepCtx, step: string, target: Json, choose?: (candidates: FindCandidate[]) => number | undefined): Promise<boolean> {
  try {
    const found = await reading(ctx, 'ui.find', () => ctx.rpc.call<{ candidates: FindCandidate[] }>('ui.find', { target }, { timeoutMs: 15_000 }));
    const index = choose === undefined ? found.candidates.findIndex((c) => c.hittable) : choose(found.candidates);
    if (index === undefined || index < 0) {
      ctx.write('prep-step', { step, target, ok: false, why: 'sem candidato tocável', candidates: found.candidates.length });
      return false;
    }
    const finalTarget = found.candidates.length > 1 ? { ...target, index } : target;
    try {
      await ctx.rpc.call('ui.tap', { target: finalTarget }, { timeoutMs: 15_000 });
    } catch (error) {
      // SP-2: E_TIMEOUT "rodando" = o toque aconteceu, só a resposta se perdeu. Nunca repetir (Play viraria Pause).
      if (!isContrarregraError(error, 'E_TIMEOUT')) throw error;
      ctx.write('prep-step', { step, target: finalTarget, ok: true, timedOut: errCode(error) });
      await drainQueue(ctx);
      return true;
    }
    ctx.write('prep-step', { step, target: finalTarget, ok: true });
    return true;
  } catch (error) {
    if (isContrarregraError(error, 'E_FORBIDDEN_APP')) throw new OwnerNeeded(step, `algo do sistema está na frente do Hagah (${errCode(error)})`);
    if (isContrarregraError(error, 'E_TARGET_NOT_FOUND') || isContrarregraError(error, 'E_TARGET_NOT_HITTABLE') || isContrarregraError(error, 'E_TARGET_AMBIGUOUS')) {
      ctx.write('prep-step', { step, target, ok: false, err: errCode(error) });
      return false;
    }
    throw error;
  }
}

async function scrollTo(ctx: PrepCtx, step: string, target: Json, direction: 'up' | 'down', maxSwipes: number): Promise<boolean> {
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

async function findButton(ctx: PrepCtx, label: string, y?: number): Promise<{ index: number; count: number } | undefined> {
  let found: { candidates: FindCandidate[] };
  try {
    found = await reading(ctx, 'ui.find', () => ctx.rpc.call<{ candidates: FindCandidate[] }>('ui.find', { target: { label, type: 'button' } }, { timeoutMs: 15_000 }));
  } catch (error) {
    if (isContrarregraError(error, 'E_TARGET_NOT_FOUND')) return undefined;
    throw error;
  }
  const index = y === undefined
    ? found.candidates.map((c, i) => ({ c, i })).filter((x) => x.c.hittable).sort((a, b) => a.c.frame.y - b.c.frame.y)[0]?.i
    : nearestHittable(found.candidates, y, 40);
  return index === undefined ? undefined : { index, count: found.candidates.length };
}

export async function audioState(ctx: PrepCtx, y?: number): Promise<'playing' | 'paused' | 'unknown'> {
  if ((await findButton(ctx, 'Pause', y)) !== undefined) return 'playing';
  if ((await findButton(ctx, 'Play', y)) !== undefined) return 'paused';
  return 'unknown';
}

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

/**
 * Um toque no Play/Pause do transporte, sem conferir antes (o A/V precisa do toque logo): `{label, type: button}` com o
 * índice do candidato mais perto da fileira. Devolve a resposta do runner (tDevStartNs, tDispatchNs, tDevEndNs).
 */
export async function tapToggle(ctx: PrepCtx, label: 'Play' | 'Pause', y: number): Promise<Json & { timedOut?: boolean }> {
  const hit = await findButton(ctx, label, y);
  if (hit === undefined) throw new OwnerNeeded('toggle', `o botão "${label}" do transporte sumiu do Now Playing`);
  const target = hit.count > 1 ? { label, type: 'button', index: hit.index } : { label, type: 'button' };
  try {
    return await ctx.rpc.call<Json>('ui.tap', { target }, { timeoutMs: 15_000 });
  } catch (error) {
    if (!isContrarregraError(error, 'E_TIMEOUT')) throw error;
    await drainQueue(ctx);
    return { timedOut: true };
  }
}

const TIMES = ['∞', '2×', '3×', '5×'];

export interface Prepared {
  route: string;
  repeatBefore: string | null;
  timesBefore: string | null;
  repeatChanged: boolean;
  /** O Play/Pause do transporte (pontos), lido com o áudio pausado. */
  toggle: { frame: Rect; forwardY: number };
}

async function setRepeatChapter(ctx: PrepCtx): Promise<Pick<Prepared, 'repeatBefore' | 'timesBefore' | 'repeatChanged'>> {
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
  ctx.write('repeat', { found: true, before: row.selected, times: timesBefore, changed: true, after: repeatRow(await tree(ctx, false))?.selected ?? null });
  return { repeatBefore: row.selected, timesBefore, repeatChanged: true };
}

async function restoreRepeat(ctx: PrepCtx, prepared: Prepared): Promise<void> {
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

async function treeOnce(ctx: PrepCtx): Promise<TreeNode[] | undefined> {
  try {
    return flatten((await ctx.rpc.call<{ nodes: TreeNode[] }>('ui.tree', { format: 'json', visibleOnly: true }, { timeoutMs: 15_000 })).nodes);
  } catch (error) {
    if (!isContrarregraError(error, 'E_TIMEOUT')) throw error;
    ctx.write('prep-step', { step: 'tree-timeout', err: errCode(error) });
    await drainQueue(ctx);
    return undefined;
  }
}

/**
 * Hagah à frente, no Salmo 23 NIV (pelo link), Now Playing aberto, Repeat "Chapter", o Play/Pause do transporte lido
 * com o áudio pausado e, por último, o áudio tocando (`play: false` deixa pausado).
 */
export async function prepare(ctx: PrepCtx, opts: { repeat: boolean; play: boolean }): Promise<Prepared> {
  await drainQueue(ctx);
  await reading(ctx, 'app.activate', () => ctx.rpc.call('app.activate', { bundleId: ctx.bundleId }, { timeoutMs: 15_000 }));
  await ctx.sleep(1_000);
  // Tocando, a árvore não cabe no prazo (SP-3): pausa antes pelo `ui.find`.
  if ((await treeOnce(ctx)) === undefined) {
    const state = await ctx.rpc.call<{ foregroundApp: string; locked: boolean }>('device.state', {}, { timeoutMs: 15_000 });
    const reason = ownerReason(state, ctx.bundleId);
    if (reason !== null) throw new OwnerNeeded('owner', reason);
    if (!(await toggleAudio(ctx, 'paused'))) throw new OwnerNeeded('pause', 'o Hagah está ocupado demais para ler a tela e não achei o botão Pause');
  }
  let { nodes } = await lookUntil(ctx, (n) => n.length > 3, 6_000);
  let route = 'already';
  if (psalm23Screen(nodes) === null) {
    route = 'link';
    try {
      await ctx.rpc.call('app.openURL', { url: PSALM23_LINK }, { timeoutMs: 15_000 });
      await ctx.sleep(1_500);
    } catch (error) {
      ctx.write('prep-step', { step: 'open-link', ok: false, err: errCode(error) });
    }
    const there = await lookUntil(ctx, (n) => psalm23Screen(n) !== null, 8_000);
    if (!there.ok) throw new OwnerNeeded('path', 'o link não levou ao Salmo 23 NIV no Hagah', visibleLabels(there.nodes));
    nodes = there.nodes;
  }
  if (psalm23Screen(nodes) !== 'nowPlaying') {
    const opened = await tapFound(ctx, 'open-now-playing', { labelPrefix: 'Open Now Playing', type: 'button' }, (c) => nearestHittable(c));
    if (!opened) throw new OwnerNeeded('path', 'não achei o mini-player para abrir o Now Playing', visibleLabels(nodes));
    const open = await lookUntil(ctx, (n) => psalm23Screen(n) === 'nowPlaying', 6_000);
    if (!open.ok) throw new OwnerNeeded('path', 'o Now Playing do Salmo 23 não abriu', visibleLabels(open.nodes));
  }
  const repeat = opts.repeat ? await setRepeatChapter(ctx) : { repeatBefore: null, timesBefore: null, repeatChanged: false };
  await scrollTo(ctx, 'scroll-transport', { label: 'Forward 15 seconds', type: 'button' }, 'up', 4);
  nodes = await look(ctx);
  const toggle = transportToggle(nodes);
  if (toggle === undefined) throw new OwnerNeeded('path', 'o transporte do Now Playing (Play/Pause) não aparece', visibleLabels(nodes));
  if (!showsPsalm23(nodes)) throw new OwnerNeeded('path', 'o Now Playing não mostra o Salmo 23', visibleLabels(nodes));
  const prepared: Prepared = { route, ...repeat, toggle: { frame: toggle.frame, forwardY: toggle.forwardY } };
  if (opts.play && !(await toggleAudio(ctx, 'playing', toggle.forwardY))) throw new OwnerNeeded('play', 'o áudio do Salmo 23 não começou a tocar', visibleLabels(nodes));
  ctx.write('prepared', { ...prepared, playing: opts.play });
  return prepared;
}

/** Fim: áudio pausado e, com ele pausado, o Repeat devolvido. Precisa do Hagah à frente. */
export async function finish(ctx: PrepCtx, prepared: Prepared | undefined): Promise<void> {
  await reading(ctx, 'app.activate', () => ctx.rpc.call('app.activate', { bundleId: ctx.bundleId }, { timeoutMs: 15_000 }));
  await ctx.sleep(1_000);
  const y = prepared?.toggle.forwardY;
  if (!(await toggleAudio(ctx, 'paused', y)) && !(await toggleAudio(ctx, 'paused'))) throw new OwnerNeeded('pause', 'não consegui pausar o áudio do Hagah no fim');
  if (prepared !== undefined) await restoreRepeat(ctx, prepared);
}

/** O hospedeiro (relógio de calibração, S0.10) à frente, fora de tomada (S1 item 11). */
export async function showHost(ctx: PrepCtx, hostBundle: string): Promise<void> {
  await drainQueue(ctx);
  await reading(ctx, 'app.activate', () => ctx.rpc.call('app.activate', { bundleId: hostBundle }, { timeoutMs: 15_000 }));
  for (let i = 0; i < 10; i++) {
    await ctx.sleep(700);
    const state = await ctx.rpc.call<{ foregroundApp: string; locked: boolean }>('device.state', {}, { timeoutMs: 15_000 });
    if (state.locked) throw new OwnerNeeded('owner', 'a tela está travada: destrave o iPhone (código ou Face ID) e deixe a tela acesa');
    if (state.foregroundApp === hostBundle) {
      ctx.write('host', { foreground: true });
      return;
    }
  }
  throw new OwnerNeeded('host', `o hospedeiro (${hostBundle}) não veio à frente`);
}
