// Lógica do driver do SP-3 (T-0.18; S1 item 5, A10 PX-2/PX-3, AC-1.5, AC-1.18) que não depende do aparelho:
// variantes, escolha dos alvos na árvore do Hagah, relógio do Now Playing, contagem das linhas de espera no
// `xcodebuild.log`, estatística, critério e a fase de medição com o runner injetado (`Rpc`). Código de spike,
// descartável (architecture.md A5); testado em `sp3.test.ts` (`node --test spikes/sp-3/sp3.test.ts`).

import type { Rect, TreeNode } from '../../mac/src/core/types.ts';

export type Json = Record<string, unknown>;

// ---------------------------------------------------------------------------------------------------------
// Variantes

/** As quatro de T-0.18 mais o caminho do `ui.tap` de hoje (`a.coord`), na ordem padrão. */
export const DEFAULT_VARIANTS = ['a', 'a.coord', 'b', 'c', 'd'] as const;

/**
 * `a|b|c|d` + `.coord` (toque público pela coordenada do SpringBoard, o `ui.tap` de hoje, em vez de
 * `XCUIElement.tap()`) + `.obs` (só em `c`: troca que não pula, só cronometra as esperas); `ui` = o próprio `ui.tap`
 * de produção (para o AC-1.18, numa sessão sem PX-2/PX-3 liberados).
 */
export const KNOWN_VARIANTS = ['a', 'a.coord', 'b', 'b.coord', 'c', 'c.coord', 'c.obs', 'c.obs.coord', 'd', 'ui'] as const;

export interface VariantSpec {
  id: string;
  method: 'spike.tap' | 'ui.tap';
  /** Os campos de variante de `spike.tap` (`variant`, `base`, `quiescence`); vazio para `ui`. */
  params: Json;
  /** A variante usa API privada (PX-2 ou PX-3). */
  privateApi: 'PX-2' | 'PX-3' | null;
}

export function variantSpec(id: string): VariantSpec {
  if (id === 'ui') return { id, method: 'ui.tap', params: {}, privateApi: null };
  const [letter, ...mods] = id.split('.');
  if (letter !== 'a' && letter !== 'b' && letter !== 'c' && letter !== 'd') throw new Error(`variante desconhecida: ${id}`);
  const params: Json = { variant: letter };
  for (const mod of mods) {
    if (mod === 'coord' && letter !== 'd') params['base'] = 'coordinate';
    else if (mod === 'obs' && letter === 'c') params['quiescence'] = 'observe';
    else throw new Error(`variante desconhecida: ${id}`);
  }
  const privateApi = letter === 'b' || letter === 'c' ? 'PX-2' : letter === 'd' ? 'PX-3' : null;
  return { id, method: 'spike.tap', params, privateApi };
}

/** A letra da variante no `spike.tapProbe` (`a`, `b`, `c`, `d`), ou `null` para `ui`. */
export function probeLetter(id: string): string | null {
  return id === 'ui' ? null : (id.split('.')[0] ?? null);
}

// ---------------------------------------------------------------------------------------------------------
// Árvore do Hagah

/** Os nós em pré-ordem (a ordem das consultas do XCUIAutomation). */
export function flatten(roots: TreeNode[]): TreeNode[] {
  const out: TreeNode[] = [];
  const walk = (node: TreeNode): void => {
    out.push(node);
    for (const child of node.children ?? []) walk(child);
  };
  for (const root of roots) walk(root);
  return out;
}

/** O botão a medir: o primeiro padrão que acha um botão visível ganha (ordem = prioridade). */
export const MEASURE_PATTERNS: RegExp[] = [/^Forward 15 seconds$/i, /^(Skip )?forward\b/i, /\bforward\b|\+\s?15\b|avan[cç]ar/i];
/** O botão de restaurar a tela (desfaz o salto de 15 s). */
export const RESTORE_PATTERNS: RegExp[] = [/^Back 15 seconds$/i, /^(Skip )?back(ward)?\b/i, /\bback 15\b|rewind|[-−]\s?15\b|voltar/i];
/** Nunca: mudam de versículo (o efeito seria outro e a tela não volta igual). */
export const EXCLUDED_BUTTONS = /verse|chapter|close/i;

export interface Pick {
  node: TreeNode | undefined;
  /** Outros botões que também casaram (registrados no SP-3.md). */
  alternatives: TreeNode[];
}

export function pickButton(nodes: TreeNode[], patterns: RegExp[]): Pick {
  const buttons = nodes.filter((n) => n.type === 'button' && n.visible && n.enabled && n.label !== undefined && !EXCLUDED_BUTTONS.test(n.label));
  for (const pattern of patterns) {
    const hits = buttons.filter((n) => pattern.test(n.label ?? ''));
    if (hits.length > 0) return { node: hits[0], alternatives: hits.slice(1) };
  }
  return { node: undefined, alternatives: [] };
}

/** O relógio do Now Playing ("0:32", "-1:05", com U+2212 ou não) como `label MATCHES` do XCUIAutomation (ICU). */
export const CLOCK_PATTERN = '^[-−]?[0-9]{1,2}:[0-9]{2}$';
const CLOCK_RE = new RegExp(CLOCK_PATTERN);

/** Segundos de um relógio dentro do texto ("m:ss", "-m:ss", "h:mm:ss"); `undefined` sem relógio. Igual ao do runner. */
export function clockSeconds(text: string): number | undefined {
  const m = /([-−])?(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(text);
  if (m === null) return undefined;
  const a = Number(m[2]);
  const b = Number(m[3]);
  const seconds = m[4] === undefined ? a * 60 + b : a * 3600 + b * 60 + Number(m[4]);
  return m[1] === undefined ? seconds : -seconds;
}

/** O critério `clockJump` do runner (SP3Effect.swift): o relógio se afastou mais do que o tempo explica. */
export function isClockJump(baseline: string, value: string, elapsedS: number, minJumpS = 10): boolean {
  const base = clockSeconds(baseline);
  const now = clockSeconds(value);
  if (base === undefined || now === undefined) return false;
  const delta = now - base;
  const threshold = minJumpS - 1.5;
  return Math.abs(delta - elapsedS) >= threshold && Math.abs(delta + elapsedS) >= threshold && Math.abs(delta) >= threshold;
}

/** Salto para o fim do capítulo: o "avançar 15 s" perto do fim para em `endS` (0:46 no Salmo 23 NIV), um salto menor que 15 s. */
export function isChapterEndJump(baseline: string, value: string, endS: number): boolean {
  const base = clockSeconds(baseline);
  const now = clockSeconds(value);
  return base !== undefined && now !== undefined && base >= 0 && base < endS - 1.5 && now >= endS - 1;
}

export interface EffectReading {
  /** `causal`: a 1ª mudança consistente com o toque; `ambiguous`: o fim natural do capítulo (tocando) também a explica; `missing`: nenhuma. */
  kind: 'causal' | 'ambiguous' | 'missing';
  /** Fim da leitura que mostrou a mudança (instante D). */
  tNs?: string;
  value?: string;
  /** O critério do runner (`clockJump`, sem o salto para o fim) só parou numa leitura posterior. */
  deviceLate: boolean;
}

/**
 * O efeito de um toque, decidido no Mac pelas mudanças do relógio registradas pelo runner (`effect.changes`); o
 * critério do runner (SP3Effect.swift) só decide quando parar de ler. Vale a 1ª mudança consistente com o toque: salto
 * de ±15 s (`isClockJump`) ou para o fim do capítulo (`isChapterEndJump`, com `endS`). Tocando, se a linha de base (+1 s
 * de resolução do rótulo) mais o tempo passado já chegaria ao fim do capítulo, a mudança é ambígua (o fim natural e a
 * volta do Repeat também a explicam).
 */
export function readEffect(effect: Json | undefined, state: string, endS: number | null): EffectReading {
  if (effect === undefined || effect['error'] !== undefined || typeof effect['baseline'] !== 'string') return { kind: 'missing', deviceLate: false };
  const baseline = effect['baseline'];
  const base = clockSeconds(baseline);
  const minJumpS = Number((effect['spec'] as Json | undefined)?.['minJumpS'] ?? 10);
  const changes = (effect['changes'] as Json[] | undefined) ?? [];
  for (const change of changes) {
    const value = String(change['value'] ?? '');
    const elapsedMs = nsDiffMs(effect['tBaselineNs'], change['tNs']);
    if (elapsedMs === null) continue;
    const elapsedS = elapsedMs / 1000;
    const consistent = isClockJump(baseline, value, elapsedS, minJumpS) || (endS !== null && isChapterEndJump(baseline, value, endS));
    if (!consistent) continue;
    // O rótulo da linha de base tem resolução de 1 s ("0:41" vai até 41,99 s): o fim natural conta com essa folga.
    const natural = state === 'playing' && endS !== null && base !== undefined && base >= 0 && base + 1 + elapsedS >= endS - 1;
    return { kind: natural ? 'ambiguous' : 'causal', tNs: String(change['tNs']), value, deviceLate: effect['tUpperNs'] !== change['tNs'] };
  }
  return { kind: 'missing', deviceLate: false };
}

/** A duração do capítulo (s): a da descoberta (`targets.chapterS`) ou o maior relógio visto nas leituras. */
export function chapterSeconds(rows: Json[]): number | null {
  const start = rows.find((r) => r['k'] === 'start');
  const declared = (start?.['targets'] as Json | undefined)?.['chapterS'];
  if (typeof declared === 'number' && declared > 0) return declared;
  let max = -1;
  for (const r of rows) {
    const effect = (r['item'] as Json | undefined)?.['effect'] as Json | undefined;
    if (effect === undefined) continue;
    for (const text of [effect['baseline'], ...((effect['changes'] as Json[] | undefined) ?? []).map((c) => c['value'])]) {
      const v = typeof text === 'string' ? clockSeconds(text) : undefined;
      if (v !== undefined && v > max) max = v;
    }
  }
  return max > 0 ? max : null;
}

export interface ClockPick {
  node: TreeNode;
  /** Ocorrência entre os nós do mesmo tipo com rótulo de relógio, em pré-ordem (o `index` da consulta). */
  index: number;
  alternatives: TreeNode[];
}

/**
 * O relógio para o efeito: entre os nós (árvore inteira, visíveis ou não, como a consulta vê) com rótulo de relógio,
 * o visível mais perto, na vertical, do botão medido (o Now Playing tem o relógio logo acima dos botões); com dois na
 * mesma distância, o primeiro (o tempo decorrido costuma vir antes do restante).
 */
export function pickClock(all: TreeNode[], near: Rect): ClockPick | undefined {
  const clocks = all.filter((n) => n.label !== undefined && CLOCK_RE.test(n.label));
  const visible = clocks.filter((n) => n.visible);
  if (visible.length === 0) return undefined;
  const cy = near.y + near.h / 2;
  const distance = (n: TreeNode): number => Math.abs(n.frame.y + n.frame.h / 2 - cy);
  const best = [...visible].sort((x, y) => distance(x) - distance(y))[0] as TreeNode;
  const sameType = clocks.filter((n) => n.type === best.type);
  return { node: best, index: sameType.indexOf(best), alternatives: clocks.filter((n) => n !== best) };
}

/** O Salmo 23 está na tela (título do Now Playing, do mini-player ou do leitor). */
export function showsPsalm23(nodes: TreeNode[]): boolean {
  return nodes.some((n) => /\bPsalms? 23\b/i.test(n.label ?? '') || /\bPsalms? 23\b/i.test(n.value ?? ''));
}

export type PlayState = 'playing' | 'paused' | 'unknown';

/**
 * Tocando = há botão "Pause" visível; pausado = há "Play" e nenhum "Pause". Com `nearY`, só os botões na faixa de
 * ±40 pt dessa altura (a fileira de transporte do Now Playing; a linha "Pause" de "Pause between repeats" fica
 * noutro lugar).
 */
export function playState(nodes: TreeNode[], nearY?: number): PlayState {
  const inBand = (n: TreeNode): boolean => nearY === undefined || Math.abs(n.frame.y + n.frame.h / 2 - nearY) <= 40;
  const buttons = nodes.filter((n) => n.type === 'button' && n.visible && inBand(n));
  if (buttons.some((n) => n.label === 'Pause')) return 'playing';
  if (buttons.some((n) => n.label === 'Play')) return 'paused';
  return 'unknown';
}

// ---------------------------------------------------------------------------------------------------------
// Preparo sozinho (o dono não fica ao lado do iPhone)

const centerY = (n: { frame: Rect }): number => n.frame.y + n.frame.h / 2;

/** O link de preparo do Salmo 23 NIV (research/hagah-targets.md F51; `urls.allowedPrefixes` tem `hagah://`). */
export const PSALM23_LINK = 'hagah://bible/ENGNIV/PSA/23';

/**
 * Onde o Hagah está, pela árvore: `reader` = leitor no Salmo 23 NIV (botão do título começando por "Psalms 23" e o
 * chip de versão "NIV", ou — com o cabeçalho rolado para fora — o mini-player "Open Now Playing: Psalms 23, NIV");
 * `nowPlaying` = o Now Playing aberto com o Salmo 23 (transporte e título); `null` = outra coisa.
 */
export function psalm23Screen(nodes: TreeNode[]): 'reader' | 'nowPlaying' | null {
  const visible = nodes.filter((n) => n.visible);
  const buttons = visible.filter((n) => n.type === 'button');
  if (pickButton(nodes, MEASURE_PATTERNS).node !== undefined && showsPsalm23(visible)) return 'nowPlaying';
  const title = buttons.some((n) => /^Psalms 23\b/.test(n.label ?? ''));
  const niv = buttons.some((n) => n.label === 'NIV');
  // O cabeçalho rola junto com os versículos (F3): rolado, vale o mini-player com o Salmo 23 NIV carregado no player.
  const miniPlayer = buttons.some((n) => /^Open Now Playing: Psalms 23, NIV\b/.test(n.label ?? ''));
  return (title && niv) || miniPlayer ? 'reader' : null;
}

/**
 * O título do capítulo no cabeçalho do leitor ("Genesis 3", "1 John 2", talvez com o símbolo do chevron no fim; F3):
 * botão no alto da tela (y < 350), só livro + número — não "Verse 1", "Back 15 seconds" nem o mini-player.
 */
export function chapterTitle(nodes: TreeNode[]): TreeNode | undefined {
  return nodes.find((n) => n.type === 'button' && n.visible && n.frame.y < 350 && !/^Verse /.test(n.label ?? '')
    && /^([1-3] )?\p{Lu}[\p{L} ]* \d+[^\p{L}\d]*$/u.test(n.label ?? ''));
}

/** O que exige o dono de verdade: tela travada (código/Face ID), outro app ou o sistema à frente, login no app. */
export function ownerReason(state: { locked: boolean; foregroundApp: string }, bundleId: string, nodes: TreeNode[] = []): string | null {
  if (state.locked) return 'a tela está travada: destrave o iPhone (código ou Face ID) e deixe a tela acesa';
  if (state.foregroundApp !== bundleId) {
    return `o Hagah não está à frente (à frente: ${state.foregroundApp || 'desconhecido'}); pode ser um alerta do sistema ou uma notificação cobrindo a tela`;
  }
  if (nodes.some((n) => n.visible && n.type === 'secureTextField')) return 'o Hagah está pedindo login (campo de senha na tela)';
  return null;
}

/** Os candidatos de `ui.find` (S1 item 4). */
export interface FindCandidate {
  ref?: string;
  frame: Rect;
  visible: boolean;
  hittable: boolean;
  value?: string;
}

/** O índice do candidato tocável mais perto da altura `y` (ou o mais de baixo, sem `y`: o mini-player fica no pé). */
export function nearestHittable(candidates: FindCandidate[], y?: number, maxDistance = Infinity): number | undefined {
  const ranked = candidates
    .map((c, index) => ({ index, c, d: y === undefined ? -centerY(c) : Math.abs(centerY(c) - y) }))
    .filter((x) => x.c.hittable && (y === undefined || x.d <= maxDistance))
    .sort((a, b) => a.d - b.d);
  return ranked[0]?.index;
}

/** A fileira de modos do Repeat do Now Playing (F13): os botões na altura do chip "Chapter". */
export interface RepeatRow {
  y: number;
  chips: TreeNode[];
  selected: string | null;
}

export const REPEAT_MODES = ['Off', 'Passage', 'Verse', 'Chapter', 'Book', '⋯'];

export function repeatRow(nodes: TreeNode[]): RepeatRow | undefined {
  const chapter = nodes.find((n) => n.type === 'button' && n.label === 'Chapter');
  if (chapter === undefined) return undefined;
  const y = centerY(chapter);
  const chips = nodes.filter((n) => n.type === 'button' && REPEAT_MODES.includes(n.label ?? '') && Math.abs(centerY(n) - y) <= 12);
  return { y, chips, selected: chips.find((n) => n.selected)?.label ?? null };
}

/** Rótulos visíveis (para o `OWNER_ACTION` dizer o que se viu), sem e-mails. */
export function visibleLabels(nodes: TreeNode[], max = 60): string[] {
  const out: string[] = [];
  for (const n of nodes) {
    if (!n.visible || n.label === undefined || out.includes(n.label)) continue;
    out.push(redact(`${n.type} "${n.label}"`));
    if (out.length >= max) break;
  }
  return out;
}

/** Tira e-mails de texto que vai para `out/` (P-3: o SP-3.md troca nome e e-mail da conta por `<redacted>`). */
export function redact(text: string): string {
  return text.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '<redacted>');
}

// ---------------------------------------------------------------------------------------------------------
// xcodebuild.log

/** Linhas de espera do XCTest e falhas engolidas pelo runner, contadas por janela do registro. */
export const LOG_PATTERNS: Record<string, RegExp> = {
  waitForIdle: /Wait for \S+ to idle/g,
  waitingQuiescence: /Waiting for .* quiescence/g,
  failedToQuiesce: /failed to quiesce/g,
  eventLoopIdleNotReceived: /event loop idle notification not received/gi,
  animationsNotReceived: /animations complete notification not received/gi,
  skippingPre: /Skipping pre-event quiescence check/g,
  skippingPost: /Skipping post-event quiescence check/g,
  xctestFailureIgnored: /falha do XCTest registrada e ignorada/g,
};

export function countLog(text: string, bundleId: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const [name, pattern] of Object.entries(LOG_PATTERNS)) counts[name] = (text.match(pattern) ?? []).length;
  counts['waitForTargetIdle'] = text.split(`Wait for ${bundleId} to idle`).length - 1;
  return counts;
}

const MARKER = /SP-3 tap seq=(\S+) i=(\d+) role=(\w+) variant=(\S+) (begin|end)/;

export interface TapLogCount {
  seq: string;
  role: string;
  variant: string;
  /** "Wait for <alvo> to idle" entre a marca `begin` deste toque e a do próximo. */
  waitForTargetIdle: number;
  waitForIdle: number;
}

/**
 * Atribui as linhas de espera ao toque cuja marca `begin` veio antes (até a próxima `begin`): as atividades do
 * XCTest e a saída do runner chegam ao `xcodebuild.log` por canais diferentes, então é aproximado; o total da janela
 * da variante (`countLog`) é o número do critério.
 */
export function perTapLog(text: string, bundleId: string): { pre: number; taps: TapLogCount[] } {
  let pre = 0;
  const taps: TapLogCount[] = [];
  let current: TapLogCount | undefined;
  for (const line of text.split('\n')) {
    const marker = MARKER.exec(line);
    if (marker !== null) {
      if (marker[5] === 'begin') {
        current = { seq: marker[1] ?? '', role: marker[3] ?? '', variant: marker[4] ?? '', waitForTargetIdle: 0, waitForIdle: 0 };
        taps.push(current);
      }
      continue;
    }
    if (!/Wait for \S+ to idle/.test(line)) continue;
    if (current === undefined) {
      pre++;
      continue;
    }
    current.waitForIdle++;
    if (line.includes(`Wait for ${bundleId} to idle`)) current.waitForTargetIdle++;
  }
  return { pre, taps };
}

/**
 * Quanto cada snapshot do XCTest levou, pelos carimbos `t = …s` do registro: "Requesting snapshot … pid N" até a
 * atividade seguinte. Separa o snapshot inteiro do app (logo depois de "Find the Application 'X'") das consultas
 * menores (janelas, elementos) — o do SpringBoard separa "Hagah pesado" de "aparelho carregado". Intervalos > 30 s
 * (fila parada entre comandos) ficam de fora.
 */
export function snapshotTimes(text: string): Record<string, number[]> {
  const acts: { t: number; text: string }[] = [];
  // O registro do xcodebuild termina as linhas com CRLF (e `.` não casa `\r`).
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s+t =\s+([\d.]+)s\s+(.*)$/.exec(line);
    if (m !== null) acts.push({ t: Number(m[1]), text: m[2] ?? '' });
  }
  const pidOf = (i: number): string | undefined => /Requesting snapshot of accessibility hierarchy for app with pid (\d+)/.exec(acts[i]?.text ?? '')?.[1];
  const appBefore = (i: number): string | undefined => /^Find the Application '(.+)'$/.exec(acts[i - 1]?.text ?? '')?.[1];
  // 1ª passada: o nome de cada pid, pelo snapshot inteiro do app (que pode vir depois das consultas menores).
  const names = new Map<string, string>();
  for (let i = 0; i < acts.length; i++) {
    const pid = pidOf(i);
    const app = appBefore(i);
    if (pid !== undefined && app !== undefined) names.set(pid, app);
  }
  const out: Record<string, number[]> = {};
  for (let i = 0; i < acts.length - 1; i++) {
    const pid = pidOf(i);
    if (pid === undefined) continue;
    const app = appBefore(i) ?? null;
    const ms = ((acts[i + 1]?.t ?? 0) - (acts[i]?.t ?? 0)) * 1000;
    if (ms < 0 || ms > 30_000) continue;
    const key = `${names.get(pid) ?? `pid ${pid}`}${app !== null ? '' : ' (consultas)'}`;
    (out[key] ??= []).push(Math.round(ms));
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------
// Números

/** Diferença `b − a` em ms entre dois instantes D em string de inteiro (S0.7); `null` se faltar um. */
export function nsDiffMs(a: unknown, b: unknown): number | null {
  if (typeof a !== 'string' || typeof b !== 'string' || !/^-?\d+$/.test(a) || !/^-?\d+$/.test(b)) return null;
  return Number(BigInt(b) - BigInt(a)) / 1e6;
}

/** Quantil por posição (o mesmo do SP-2): o valor de índice ⌊q·n⌋ na lista ordenada. */
export function quantile(values: number[], q: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? null;
}

export interface Stats {
  n: number;
  p50: number | null;
  p95: number | null;
  p99: number | null;
  max: number | null;
}

const r1 = (x: number | null): number | null => (x === null ? null : Math.round(x * 10) / 10);

export function stats(values: number[]): Stats {
  return {
    n: values.length,
    p50: r1(quantile(values, 0.5)),
    p95: r1(quantile(values, 0.95)),
    p99: r1(quantile(values, 0.99)),
    max: r1(values.length === 0 ? null : Math.max(...values)),
  };
}

// ---------------------------------------------------------------------------------------------------------
// Fase de medição (runner injetado)

export interface Rpc {
  call<T = unknown>(method: string, params?: Record<string, unknown>, options?: { timeoutMs?: number }): Promise<T>;
}

export interface PhaseIo {
  /** Relógio de parede em ms (o do registro). */
  now(): number;
  sleep(ms: number): Promise<void>;
  /** Tamanho atual do `xcodebuild.log` da sessão (bytes). */
  logSize(): number;
  /** Os bytes [from, to) do `xcodebuild.log`. */
  readLog(from: number, to: number): string;
  write(k: string, data: Json): void;
  /** Guarda o trecho do registro de uma variante (em `out/`). */
  saveLog?(name: string, text: string): void;
  /** Espera a fila do XCTest esvaziar (depois de um toque que estourou o prazo: o seguinte não pode nascer na fila). */
  drain?(): Promise<void>;
}

export interface TargetInfo {
  target: Json;
  label: string;
  frame: Rect;
}

export interface Targets {
  bundleId: string;
  measure: TargetInfo;
  restore?: TargetInfo;
  /** `effect` de `spike.tap` (SP3Effect.swift), sem `timeoutMs` (vem da fase). */
  effect?: Json;
  /** A duração do capítulo (s), do relógio decorrido + o restante na descoberta (para `readEffect`). */
  chapterS?: number;
}

export interface PhaseOptions {
  state: 'playing' | 'paused';
  variant: string;
  n: number;
  gapMs: number;
  settleMs: number;
  pressMs: number;
  effectTimeoutMs: number;
  /** Faz o toque de restaurar depois de cada toque medido (mesma variante). */
  restore: boolean;
  /** Mede o efeito (relógio) nos toques medidos. */
  effect: boolean;
  /** Primeiro `seq` (único no rótulo). */
  seqStart: number;
  /** Erros seguidos que param a fase. */
  maxConsecutiveErrors?: number;
  /** Variante dos toques de restaurar (padrão: a mesma; ex.: `d`, mais rápida, quando a medida é de uma pública). */
  restoreVariant?: string;
  /**
   * Toque medido "lento": a chamada levou mais que isto (ms) ou deu `E_TIMEOUT`. Com `maxSlow` lentos a fase para —
   * a variante fica caracterizada com menos amostras, em vez de prender a fila do XCTest por horas se a espera de
   * ociosidade não acabar (o XCTest espera até ~60 s por vez, wda.md F16).
   */
  slowMs?: number;
  maxSlow?: number;
  /** Conferência a cada 10 toques (app à frente, Salmo 23, estado do áudio); `false` para a fase. */
  check?: () => Promise<boolean>;
}

export interface PhaseResult {
  measured: number;
  errors: number;
  stopped: string | null;
  nextSeq: number;
  logCounts: Record<string, number>;
}

function errorText(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error && typeof (error as { code: unknown }).code === 'string') {
    return `${(error as { code: string }).code}: ${error instanceof Error ? error.message.slice(0, 200) : ''}`;
  }
  return error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200);
}

/** Um toque pelo método da variante; devolve o item (como o de `spike.tap`) ou o erro da chamada. */
async function tapOnce(rpc: Rpc, spec: VariantSpec, target: Json, role: 'measure' | 'restore', seq: number, opts: PhaseOptions,
  targets: Targets): Promise<{ item?: Json; err?: string }> {
  try {
    if (spec.method === 'ui.tap') {
      const result = await rpc.call<Json>('ui.tap', { target }, { timeoutMs: 15_000 });
      return { item: { ...result, role, variant: 'ui', seq } };
    }
    // Com o Hagah tocando, só a resolução (duas leituras da tela + a árvore) leva ~4–6 s e o efeito armado mais alguns:
    // o prazo da fila (SP3Taps.deadlineSeconds) cresce com `gapMs` e `completionTimeoutMs`, que num toque único
    // (`count: 1`) não pausam nada — só o espera da conclusão do (d) até 10 s.
    const params: Json = { ...spec.params, target, seq, count: 1, gapMs: 10_000, completionTimeoutMs: 10_000 };
    if (spec.params['variant'] === 'd') params['pressMs'] = opts.pressMs;
    if (role === 'measure' && opts.effect && targets.effect !== undefined) {
      params['effect'] = { ...targets.effect, timeoutMs: opts.effectTimeoutMs };
    }
    const result = await rpc.call<{ taps?: Json[] }>('spike.tap', params, { timeoutMs: 60_000 + opts.effectTimeoutMs });
    const item = result.taps?.[0];
    if (item === undefined) return { err: 'spike.tap sem item' };
    return { item };
  } catch (error) {
    return { err: errorText(error) };
  }
}

/**
 * `opts.n` toques medidos numa variante (cada um seguido do de restaurar, se pedido), registrados um a um
 * (`k: 'tap'`), depois `settleMs` de espera e a janela do `xcodebuild.log` da variante (`k: 'block'`).
 */
export async function runPhase(rpc: Rpc, io: PhaseIo, targets: Targets, opts: PhaseOptions): Promise<PhaseResult> {
  const spec = variantSpec(opts.variant);
  const restoreSpec = variantSpec(opts.restoreVariant ?? opts.variant);
  const maxErrors = opts.maxConsecutiveErrors ?? 5;
  const slowMs = opts.slowMs ?? 8_000;
  const maxSlow = opts.maxSlow ?? 3;
  let slow = 0;
  let seq = opts.seqStart;
  let measured = 0;
  let errors = 0;
  let consecutive = 0;
  let stopped: string | null = null;
  const logFrom = io.logSize();
  io.write('phase', { state: opts.state, variant: opts.variant, n: opts.n, logFrom, params: spec.params, method: spec.method,
    restoreVariant: restoreSpec.id, effect: opts.effect && targets.effect !== undefined && spec.method === 'spike.tap' });

  const one = async (role: 'measure' | 'restore', target: Json, i: number): Promise<boolean> => {
    const tapSeq = seq++;
    const from = io.logSize();
    const m0 = io.now();
    const { item, err } = await tapOnce(rpc, role === 'measure' ? spec : restoreSpec, target, role, tapSeq, opts, targets);
    const m1 = io.now();
    const itemErr = item !== undefined && item['error'] !== undefined ? (item['error'] as Json) : undefined;
    io.write('tap', { state: opts.state, variant: opts.variant, role, i, seq: tapSeq, m0, m1, logFrom: from, logTo: io.logSize(),
      ...(role === 'restore' && restoreSpec.id !== spec.id ? { restoreVariant: restoreSpec.id } : {}),
      ...(item === undefined ? {} : { item }), ...(err === undefined ? {} : { err }) });
    const timedOut = (err ?? String(itemErr?.['message'] ?? '')).includes('E_TIMEOUT');
    if (role === 'measure' && (m1 - m0 > slowMs || timedOut)) slow++;
    if (timedOut) await io.drain?.();
    return err === undefined && itemErr === undefined;
  };

  for (let i = 0; i < opts.n; i++) {
    if (opts.check !== undefined && i > 0 && i % 10 === 0 && !(await opts.check())) {
      stopped = 'check';
      break;
    }
    const ok = await one('measure', targets.measure.target, i);
    measured++;
    if (ok) consecutive = 0;
    else {
      errors++;
      consecutive++;
    }
    await io.sleep(opts.gapMs);
    if (opts.restore && targets.restore !== undefined) {
      const restored = await one('restore', targets.restore.target, i);
      if (!restored) consecutive++;
      await io.sleep(opts.gapMs);
    }
    if (consecutive >= maxErrors) {
      stopped = `${consecutive} erros seguidos`;
      break;
    }
    if (slow >= maxSlow) {
      stopped = `lento: ${slow} toques acima de ${slowMs} ms`;
      break;
    }
  }
  await io.sleep(opts.settleMs);
  const logTo = io.logSize();
  const text = io.readLog(logFrom, logTo);
  const logCounts = countLog(text, targets.bundleId);
  const perTap = perTapLog(text, targets.bundleId);
  io.saveLog?.(`${opts.state}-${opts.variant}`, text);
  io.write('block', { state: opts.state, variant: opts.variant, logFrom, logTo, counts: logCounts, perTapPre: perTap.pre,
    perTap: perTap.taps, measured, errors, stopped, snapshotsMs: snapshotTimes(text) });
  return { measured, errors, stopped, nextSeq: seq, logCounts };
}

// ---------------------------------------------------------------------------------------------------------
// Resumo e critério

/**
 * T-0.18 "Done": p95 ≤ 150 ms, p99 ≤ 300 ms e 0 linhas de espera (AC-1.5), com o áudio tocando, em 50 toques (a fase
 * inteira: interrompida ou com `--n` menor não conta), todos sem erro, sem falha do XCTest engolida na janela e — com
 * o efeito armado — com o efeito visto em todos (um toque que não fez efeito não é toque rápido). Sem efeito armado
 * (`--no-effect`), o critério fica indeterminado (`null`).
 */
export const CRITERION = { p95Ms: 150, p99Ms: 300, waitLines: 0, minTaps: 50, xctestFailures: 0 } as const;

export interface VariantSummary {
  state: string;
  variant: string;
  measured: number;
  ok: number;
  errors: Record<string, number>;
  /** `tDevEndNs − tDevStartNs` (a medida do AC-1.5). */
  totalMs: Stats;
  /** `tDispatchNs − tDevStartNs` (resolução + montagem; onde o AC-1.18 quer a espera). */
  resolveMs: Stats;
  /** `tDevEndNs − tDispatchNs` (o envio; no público, a espera de ociosidade cai aqui). */
  sendMs: Stats;
  /** Efeito: fim da 1ª leitura com a mudança consistente (causais + ambíguos) − `tDevStartNs` / − `tDispatchNs`; e o limite de baixo do runner − `tDispatchNs`. */
  effectFromStartMs: Stats;
  effectFromDispatchMs: Stats;
  effectLowerFromDispatchMs: Stats;
  /** Efeito pela leitura do Mac (`readEffect`): causal, ambíguo (fim natural do capítulo) ou ausente. */
  effectSeen: number;
  effectAmbiguous: number;
  effectMissing: number;
  /** Causais em que o critério do runner parou numa leitura posterior (o salto para o fim do capítulo). */
  effectDeviceLate: number;
  /** Ida e volta da chamada vista do Mac. */
  callMs: Stats;
  /** Toques de restaurar (mesma variante). */
  restoreTotalMs: Stats;
  /** Variante c: tempo dentro das esperas não puladas (pré + pós) por toque. */
  quiescenceWaitMs?: Stats;
  /** Variante d: conclusão − envio. */
  completionMs?: Stats;
  paths: Record<string, number>;
  log: Record<string, number> | null;
  meetsCriterion: boolean | null;
}

function tally(values: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of values) out[v] = (out[v] ?? 0) + 1;
  return out;
}

const nums = (xs: (number | null)[]): number[] => xs.filter((x): x is number => x !== null && Number.isFinite(x));

export function summarizeVariant(rows: Json[], state: string, variant: string): VariantSummary {
  const taps = rows.filter((r) => r['k'] === 'tap' && r['state'] === state && r['variant'] === variant);
  const measure = taps.filter((r) => r['role'] === 'measure');
  const restore = taps.filter((r) => r['role'] === 'restore');
  const item = (r: Json): Json | undefined => r['item'] as Json | undefined;
  const okItems = measure.map(item).filter((x): x is Json => x !== undefined && x['error'] === undefined);
  const errs = measure.map((r) => {
    if (typeof r['err'] === 'string') return (r['err'] as string).split(':')[0] ?? 'erro';
    const e = item(r)?.['error'] as Json | undefined;
    return e === undefined ? null : String(e['message'] ?? e['code']).split(':')[0] ?? 'erro';
  }).filter((x): x is string => x !== null);
  const effect = (x: Json): Json | undefined => x['effect'] as Json | undefined;
  const endS = chapterSeconds(rows);
  const readings = okItems.map((x) => ({ x, r: readEffect(effect(x), state, endS) }));
  const seen = okItems.filter((x) => effect(x)?.['satisfied'] === true);
  const causal = readings.filter((y) => y.r.kind === 'causal');
  // A coluna do efeito usa a 1ª mudança visível consistente com o toque em todos (causais e ambíguos); a contagem separa.
  const visible = readings.filter((y) => y.r.kind !== 'missing');
  const block = [...rows].reverse().find((r) => r['k'] === 'block' && r['state'] === state && r['variant'] === variant);
  const detail = (x: Json): Json => (x['detail'] as Json | undefined) ?? {};
  const totalMs = stats(nums(okItems.map((x) => nsDiffMs(x['tDevStartNs'], x['tDevEndNs']))));
  const log = (block?.['counts'] as Record<string, number> | undefined) ?? null;
  const summary: VariantSummary = {
    state,
    variant,
    measured: measure.length,
    ok: okItems.length,
    errors: tally(errs),
    totalMs,
    resolveMs: stats(nums(okItems.map((x) => nsDiffMs(x['tDevStartNs'], x['tDispatchNs'])))),
    sendMs: stats(nums(okItems.map((x) => nsDiffMs(x['tDispatchNs'], x['tDevEndNs'])))),
    effectFromStartMs: stats(nums(visible.map((y) => nsDiffMs(y.x['tDevStartNs'], y.r.tNs)))),
    effectFromDispatchMs: stats(nums(visible.map((y) => nsDiffMs(y.x['tDispatchNs'], y.r.tNs)))),
    effectLowerFromDispatchMs: stats(nums(seen.map((x) => nsDiffMs(x['tDispatchNs'], effect(x)?.['tLowerNs'])))),
    effectSeen: causal.length,
    effectAmbiguous: readings.filter((y) => y.r.kind === 'ambiguous').length,
    effectMissing: readings.filter((y) => y.r.kind === 'missing' && effect(y.x) !== undefined).length,
    effectDeviceLate: causal.filter((y) => y.r.deviceLate).length,
    callMs: stats(nums(measure.map((r) => (typeof r['m0'] === 'number' && typeof r['m1'] === 'number' ? (r['m1'] as number) - (r['m0'] as number) : null)))),
    restoreTotalMs: stats(nums(restore.map(item).filter((x): x is Json => x !== undefined && x['error'] === undefined)
      .map((x) => nsDiffMs(x['tDevStartNs'], x['tDevEndNs'])))),
    paths: tally(okItems.map((x) => String(x['path'] ?? '?'))),
    log,
    meetsCriterion: null,
  };
  if (variant.startsWith('c')) {
    summary.quiescenceWaitMs = stats(nums(okItems.map((x) => {
      const pre = detail(x)['waitedPreMs'];
      const post = detail(x)['waitedPostMs'];
      return typeof pre === 'number' && typeof post === 'number' ? pre + post : null;
    })));
  }
  if (variant === 'd') {
    summary.completionMs = stats(nums(okItems.map((x) => nsDiffMs(detail(x)['tSubmittedNs'], detail(x)['tCompletedNs']))));
  }
  const phase = [...rows].reverse().find((r) => r['k'] === 'phase' && r['state'] === state && r['variant'] === variant);
  const effectArmed = phase?.['effect'] === undefined ? okItems.some((x) => effect(x) !== undefined) : phase['effect'] === true;
  if (effectArmed && okItems.length > 0 && totalMs.p95 !== null && totalMs.p99 !== null && log !== null) {
    summary.meetsCriterion = totalMs.p95 <= CRITERION.p95Ms && totalMs.p99 <= CRITERION.p99Ms
      && (log['waitForTargetIdle'] ?? 0) <= CRITERION.waitLines
      && (log['xctestFailureIgnored'] ?? 0) <= CRITERION.xctestFailures
      && measure.length >= CRITERION.minTaps && okItems.length === measure.length && summary.effectMissing === 0;
  }
  return summary;
}

export interface Summary {
  label: string;
  bundleId: string | null;
  variants: VariantSummary[];
  /** T-0.18: alguma de (b), (c), (d) cumpre o critério com o áudio tocando. */
  success: boolean;
  passing: string[];
}

export function summarize(label: string, rows: Json[]): Summary {
  const start = rows.find((r) => r['k'] === 'start');
  const pairs: [string, string][] = [];
  for (const r of rows) {
    if (r['k'] !== 'phase') continue;
    const key: [string, string] = [String(r['state']), String(r['variant'])];
    if (!pairs.some(([s, v]) => s === key[0] && v === key[1])) pairs.push(key);
  }
  const variants = pairs.map(([state, variant]) => summarizeVariant(rows, state, variant));
  const passing = variants
    .filter((v) => v.state === 'playing' && /^[bcd]/.test(v.variant) && !v.variant.startsWith('c.obs') && v.meetsCriterion === true)
    .map((v) => v.variant);
  return { label, bundleId: (start?.['bundleId'] as string | undefined) ?? null, variants, success: passing.length > 0, passing };
}

const fmt = (x: number | null): string => (x === null ? '—' : String(x));

/** Tabela em Markdown para o SP-3.md. */
export function markdownTable(summary: Summary): string {
  const lines = [
    '| áudio | variante | ok/n | p50 | p95 | p99 | máx (ms, tDevEnd−tDevStart) | p95 resolução | p95 envio | p95 efeito (do início, 1ª mudança) | efeito causal | "Wait for … to idle" (Hagah) | critério |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|',
  ];
  for (const v of summary.variants) {
    const crit = v.meetsCriterion === null ? '—' : v.meetsCriterion ? 'cumpre' : 'não';
    lines.push(`| ${v.state === 'playing' ? 'tocando' : 'pausado'} | ${v.variant} | ${v.ok}/${v.measured} | ${fmt(v.totalMs.p50)} | ${fmt(v.totalMs.p95)} | `
      + `${fmt(v.totalMs.p99)} | ${fmt(v.totalMs.max)} | ${fmt(v.resolveMs.p95)} | ${fmt(v.sendMs.p95)} | ${fmt(v.effectFromStartMs.p95)} | `
      + `${v.effectSeen}${v.effectAmbiguous > 0 ? ` (+${v.effectAmbiguous} ambíguos)` : ''}/${v.ok} | ${v.log === null ? '—' : String(v.log['waitForTargetIdle'] ?? 0)} | ${crit} |`);
  }
  return lines.join('\n');
}

/**
 * A repetição curta no estado pesado (`sp3.ts heavy`), por estado: (d) e `a.coord` (total, resolução, envio, efeito),
 * os `ui.tree` cronometrados, e os snapshots do SpringBoard e do Hagah (do registro), que separam "Hagah pesado" de
 * "aparelho carregado"; mais os tempos do reinício a frio.
 */
export function heavyReport(rows: Json[]): string {
  const f = (x: Stats): string => `${fmt(x.p50)} / ${fmt(x.p95)} / ${fmt(x.p99)} (n ${x.n})`;
  const lines = ['| áudio | medida | p50 / p95 / p99 (ms) |', '|---|---|---|'];
  for (const state of ['playing', 'paused']) {
    const name = state === 'playing' ? 'tocando' : 'pausado';
    for (const variant of ['d', 'a.coord']) {
      const v = summarizeVariant(rows, state, variant);
      if (v.measured === 0) continue;
      lines.push(`| ${name} | ${variant} total (tDevEnd−tDevStart) | ${f(v.totalMs)} |`);
      lines.push(`| ${name} | ${variant} resolução | ${f(v.resolveMs)} |`);
      lines.push(`| ${name} | ${variant} envio | ${f(v.sendMs)} |`);
      lines.push(`| ${name} | ${variant} efeito do envio (1ª mudança; ${v.effectSeen} causais, ${v.effectAmbiguous} ambíguos, ${v.effectMissing} sem) | ${f(v.effectFromDispatchMs)} |`);
    }
    const snaps: Record<string, number[]> = {};
    for (const b of rows.filter((r) => r['k'] === 'block' && r['state'] === state)) {
      for (const [k, v] of Object.entries((b['snapshotsMs'] as Record<string, number[]> | undefined) ?? {})) (snaps[k] ??= []).push(...v);
    }
    for (const k of Object.keys(snaps).sort()) lines.push(`| ${name} | snapshot ${k} | ${f(stats(snaps[k] ?? []))} |`);
    for (const t of rows.filter((r) => r['k'] === 'uitree' && r['state'] === state)) {
      lines.push(`| ${name} | ui.tree (${String(t['when'])}) | ${t['ok'] === true ? `${String(t['replyMs'])} ms` : `estourou; fila livre em ${String(t['drainedMs'])} ms`} |`);
    }
  }
  const cold = rows.find((r) => r['k'] === 'cold');
  if (cold !== undefined) {
    const { k: _k, m: _m, ...times } = cold;
    lines.push(`| frio | terminate, openURL, à frente, Now Playing, play | ${JSON.stringify(times)} |`);
  }
  return lines.join('\n');
}
