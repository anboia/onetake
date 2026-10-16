// Coreografia da tomada da trilha do demo (spec/tasks.md "Trilha do demo"; S0.4, S3 item 1): lê o YAML,
// valida contra S0.4 (`ChoreographySchema`), confere o subconjunto que o executor do Mac sabe rodar e
// expande os `{ref: <nome>}` do catálogo `targets:` (recursivo, com detecção de ciclo). Nada aqui conhece
// um app em particular (US-17).
//
// Subconjunto (o executor manda um passo por vez ao runner):
// - `do` ∈ `SUPPORTED_ACTIONS`; `press` e `app {action: launch}` são recusados em qualquer seção (a tomada
//   nunca aperta botões nem chama `launch()`, P-4; fora dela não há uso nesta trilha);
// - `openURL` só em `prepare`/`cleanup` (S3 item 1, S1 item 9);
// - `type` nunca num alvo `secureTextField` nem com texto que pareça credencial (E-3.3, P-3);
// - `repeat` recusado (fora do subconjunto: o executor não o implementa);
// - `expect` com `state: changed` recusado (`wait.for` não o aceita);
// - `drag` precisa de `velocity` ou `durationMs` (o runner exige um dos dois);
// - `@eN` em `ref` recusado (só vale na exploração, S0.2); ids de passo únicos; `cue` dentro de `line`;
// - campos que o executor ignoraria são recusados: `expect`/`optional` em `waitFor`, `assert`, `wait`,
//   `block`, `mark`, `hold` e `checkpoint`; `steps` em `checkpoint who: human`; `alert` em `checkpoint`
//   (`confirm`, `device` e `guide` no topo só geram aviso).
// Erros saem como `{path, rule, message}` (a forma de `choreo validate`, S3) com o código
// `E_CHOREO_INVALID`.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { parse as parseYaml } from 'yaml';

import { ContrarregraError } from '../core/errors.ts';
import { formatPath, validateChoreography, type ValidationIssue } from '../core/schema.ts';
import type { Choreography, Condition, Step, Target } from '../core/types.ts';

export type { ValidationIssue };

/** Ações que o executor do Mac roda (o resto de S0.4 é recusado na validação). */
export const SUPPORTED_ACTIONS = [
  'tap', 'doubleTap', 'longPress', 'drag', 'scrollTo', 'type', 'lock', 'wake', 'home', 'controlCenter', 'app',
  'openURL', 'wait', 'waitFor', 'assert', 'checkpoint', 'block', 'mark', 'hold',
] as const;

/** Regras próprias desta validação (as de S0 vêm de `core/schema.ts`). */
export const TAKE_RULES = {
  yaml: 'yaml',
  file: 'file',
  unsupported: 'take/unsupported',
  repeat: 'take/repeat-unsupported',
  changed: 'take/expect-changed-unsupported',
  dragMotion: 'take/drag-motion',
  takeRule: 'S3/take-rule',
  secureType: 'S3/E-3.3-secure-type',
  stepIdUnique: 'S3/step-id-unique',
  cueRange: 'S3/E-3.1-cue-range',
  refUnknown: 'S0.4/ref-unknown',
  refCycle: 'S0.4/ref-cycle',
  nodeRef: 'S0.2/node-ref-outside-exploration',
  ignoredField: 'take/ignored-field',
} as const;

/** Passos em que o executor não usa `expect` nem `optional` (o campo seria ignorado em silêncio). */
const NO_EXPECT_OR_OPTIONAL = new Set(['waitFor', 'assert', 'wait', 'block', 'mark', 'hold', 'checkpoint']);

/** Texto com cara de credencial (e-mail/Apple ID): o mesmo critério do runner (S1 item 4 `ui.type`, E-3.3). */
const CREDENTIAL = /[^\s@]+@[^\s@]+\.[^\s@]+/;

export function looksLikeCredential(text: string): boolean {
  return CREDENTIAL.test(text);
}

const NODE_REF = /^@e[0-9]+$/;

type Path = (string | number)[];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface TakeValidation {
  ok: boolean;
  file: string;
  /** SHA-256 (hex) dos bytes do arquivo; `null` se não deu para ler. */
  sha256: string | null;
  errors: ValidationIssue[];
  warnings: string[];
  scenes: number;
  /** Passos ao todo, inclusive os de dentro de `block` e `checkpoint`. */
  steps: number;
}

export interface LoadedChoreography {
  /** Caminho absoluto do arquivo. */
  path: string;
  sha256: string;
  /** A coreografia validada, com todo `ref` do catálogo expandido. */
  doc: Choreography;
  warnings: string[];
}

interface Checked {
  errors: ValidationIssue[];
  warnings: string[];
  doc?: Choreography;
}

/**
 * Expande os `{ref: <nome>}` (em qualquer profundidade) pelo catálogo `targets:`. O objeto que cita o
 * `ref` pode trazer modificadores (`offset`, `index`, `within`…), que valem por cima dos do catálogo
 * (AC-0.7: `{ref: focusStage, offset: {dx: 0, dy: 200}}`).
 */
function expandRefs(doc: Choreography, issues: ValidationIssue[]): Choreography {
  const catalog = doc.targets;
  const resolved = new Map<string, Target>();
  const failed = new Set<string>();
  const resolving: string[] = [];
  const issue = (path: Path, rule: string, message: string): void => {
    issues.push({ path: formatPath(path), rule, message });
  };

  const resolveName = (name: string, path: Path): Target | undefined => {
    const done = resolved.get(name);
    if (done !== undefined) return done;
    if (failed.has(name)) return undefined;
    if (!Object.hasOwn(catalog, name)) {
      issue(path, TAKE_RULES.refUnknown, `ref "${name}" não existe no catálogo targets (E-3.1)`);
      return undefined;
    }
    const at = resolving.indexOf(name);
    if (at >= 0) {
      issue(path, TAKE_RULES.refCycle, `ref em ciclo: ${[...resolving.slice(at), name].join(' → ')}`);
      return undefined;
    }
    resolving.push(name);
    const out = expandValue(catalog[name], ['targets', name]);
    resolving.pop();
    if (!isPlainObject(out) || containsUnresolved(out)) {
      failed.add(name);
      return undefined;
    }
    resolved.set(name, out as Target);
    return out as Target;
  };

  // Alvos que não puderam ser expandidos (o erro já foi registrado): um nome do catálogo que os contém
  // também falha, sem repetir o erro.
  const unresolved = new WeakSet<object>();
  const mark = (value: Record<string, unknown>): Record<string, unknown> => {
    unresolved.add(value);
    return value;
  };
  const containsUnresolved = (value: unknown): boolean => {
    if (Array.isArray(value)) return value.some(containsUnresolved);
    if (!isPlainObject(value)) return false;
    return unresolved.has(value) || Object.values(value).some(containsUnresolved);
  };

  const expandValue = (value: unknown, path: Path): unknown => {
    if (Array.isArray(value)) return value.map((item, i) => expandValue(item, [...path, i]));
    if (!isPlainObject(value)) return value;
    const ref = value['ref'];
    const rest: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (key !== 'ref' || typeof ref !== 'string') rest[key] = expandValue(item, [...path, key]);
    }
    if (typeof ref !== 'string') return rest;
    if (NODE_REF.test(ref)) {
      issue([...path, 'ref'], TAKE_RULES.nodeRef, `ref "${ref}" é um nó da árvore (@eN): só vale na exploração, nunca numa coreografia (S0.2)`);
      return mark(rest);
    }
    const base = resolveName(ref, [...path, 'ref']);
    if (base === undefined) return mark(rest);
    return { ...base, ...rest };
  };

  for (const name of Object.keys(catalog)) resolveName(name, ['targets', name]);
  const out = { ...doc };
  out.targets = Object.fromEntries([...resolved.entries()]);
  out.prepare = expandValue(doc.prepare, ['prepare']) as Step[];
  out.scenes = doc.scenes.map((scene, i) => ({ ...scene, steps: expandValue(scene.steps, ['scenes', i, 'steps']) as Step[] }));
  out.cleanup = expandValue(doc.cleanup, ['cleanup']) as Step[];
  return out;
}

function conditionHasChanged(condition: Condition): boolean {
  if ('element' in condition) return condition.state === 'changed';
  if ('all' in condition) return condition.all.some(conditionHasChanged);
  if ('any' in condition) return condition.any.some(conditionHasChanged);
  if ('not' in condition) return conditionHasChanged(condition.not);
  return false;
}

type Section = 'prepare' | 'scenes' | 'cleanup';

/** As regras do subconjunto, passo a passo (com os `ref` já expandidos). */
function checkSteps(
  steps: readonly Step[],
  section: Section,
  path: Path,
  ctx: { issues: ValidationIssue[]; warnings: string[]; ids: Map<string, string>; sentences: number | undefined; count: { steps: number } },
): void {
  const issue = (at: Path, rule: string, message: string): void => {
    ctx.issues.push({ path: formatPath(at), rule, message });
  };
  steps.forEach((step, i) => {
    const at = [...path, i];
    ctx.count.steps += 1;
    if (step.id !== undefined) {
      const first = ctx.ids.get(step.id);
      if (first === undefined) ctx.ids.set(step.id, formatPath(at));
      else issue([...at, 'id'], TAKE_RULES.stepIdUnique, `id de passo "${step.id}" repetido (já em ${first}) (S3 item 1)`);
    }
    if (!(SUPPORTED_ACTIONS as readonly string[]).includes(step.do)) {
      issue([...at, 'do'], TAKE_RULES.unsupported, `do: ${step.do} fora do subconjunto da tomada (a tomada nunca aperta botões do aparelho; P-4)`);
    }
    if (step.do === 'app' && step.action === 'launch') {
      issue([...at, 'action'], TAKE_RULES.unsupported, 'app {action: launch} recusado: a ferramenta nunca chama launch() no app alvo (P-4); use activate');
    }
    if (step.do === 'openURL' && section === 'scenes') {
      issue([...at, 'do'], TAKE_RULES.takeRule, 'openURL dentro de scenes é proibido na tomada; só em prepare/cleanup (S3 item 1, S1 item 9)');
    }
    if (step.repeat !== undefined) {
      issue([...at, 'repeat'], TAKE_RULES.repeat, 'repeat fora do subconjunto da tomada: escreva os passos repetidos um a um');
    }
    if (step.expect !== undefined && conditionHasChanged(step.expect)) {
      issue([...at, 'expect'], TAKE_RULES.changed, 'expect com state: changed fora do subconjunto da tomada (wait.for não o aceita); use exists/gone/value');
    }
    if (step.do === 'type') {
      if (step.target?.type === 'secureTextField') {
        issue([...at, 'target'], TAKE_RULES.secureType, 'type num campo seguro (secureTextField) é sempre recusado (E-3.3, P-3)');
      }
      if (looksLikeCredential(step.text)) {
        issue([...at, 'text'], TAKE_RULES.secureType, 'type com texto que parece credencial (e-mail/Apple ID) é sempre recusado (E-3.3, P-3)');
      }
    }
    if (NO_EXPECT_OR_OPTIONAL.has(step.do)) {
      for (const key of ['expect', 'optional'] as const) {
        if (step[key] !== undefined) issue([...at, key], TAKE_RULES.ignoredField, `${key} não vale em ${step.do}: o executor o ignoraria`);
      }
    }
    if (step.do === 'checkpoint') {
      if (step.who === 'human' && step.steps !== undefined) {
        issue([...at, 'steps'], TAKE_RULES.ignoredField, 'steps só vale em checkpoint who: runner (who: human = a pessoa age; S5 item 1)');
      }
      if (step.alert !== undefined) {
        issue([...at, 'alert'], TAKE_RULES.ignoredField, 'alert é ignorado nesta trilha: o aviso falado no Mac é o ask');
      }
    }
    if (step.do === 'drag' && step.velocity === undefined && step.durationMs === undefined) {
      issue(at, TAKE_RULES.dragMotion, 'drag precisa de velocity (pt/s) ou de durationMs (o runner exige exatamente um)');
    }
    if (step.cue !== undefined) {
      if (section !== 'scenes') ctx.warnings.push(`${formatPath([...at, 'cue'])}: cue fora de scenes é ignorado`);
      else if (ctx.sentences !== undefined && step.cue >= ctx.sentences) {
        issue([...at, 'cue'], TAKE_RULES.cueRange, `cue ${step.cue} ≥ número de frases da cena (${ctx.sentences}) (E-3.1)`);
      }
    }
    if ((step.do === 'block' || step.do === 'checkpoint') && step.steps !== undefined) {
      checkSteps(step.steps, section, [...at, 'steps'], ctx);
    }
  });
}

/** Valida um documento já lido do YAML: S0.4, `ref`, subconjunto da tomada. */
export function checkTakeChoreography(input: unknown): Checked & { scenes: number; steps: number } {
  const base = validateChoreography(input);
  if (!base.ok) return { errors: base.errors, warnings: [], scenes: 0, steps: 0 };
  const issues: ValidationIssue[] = [];
  const warnings: string[] = [];
  const doc = expandRefs(base.value, issues);
  // Campos do topo que esta trilha não confere (pré-voo reduzido; a narração vem do --voice): só aviso.
  warnings.push('device (idioma, tela, texto, aparência) não é conferido nesta trilha (pré-voo reduzido)');
  if (doc.confirm !== undefined) warnings.push('confirm é ignorado nesta trilha (pré-voo reduzido): confira à mão antes da tomada');
  if (doc.guide !== undefined) warnings.push('guide é ignorado nesta trilha: os tempos da narração vêm do --voice');
  const ctx = { issues, warnings, ids: new Map<string, string>(), sentences: undefined as number | undefined, count: { steps: 0 } };
  checkSteps(doc.prepare, 'prepare', ['prepare'], ctx);
  doc.scenes.forEach((scene, i) => {
    ctx.sentences = scene.line?.length ?? 0;
    if (scene.line === undefined) warnings.push(`scenes[${i}] (${scene.id}): cena sem line (permanência mínima = padBeforeMs + padAfterMs; E-3.2)`);
    checkSteps(scene.steps, 'scenes', ['scenes', i, 'steps'], ctx);
  });
  ctx.sentences = undefined;
  checkSteps(doc.cleanup, 'cleanup', ['cleanup'], ctx);
  const result: Checked & { scenes: number; steps: number } = { errors: issues, warnings, scenes: doc.scenes.length, steps: ctx.count.steps };
  if (issues.length === 0) result.doc = doc;
  return result;
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function readAndCheck(file: string): Checked & { path: string; sha256: string | null; scenes: number; steps: number } {
  const path = resolve(file);
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? String(error);
    return { path, sha256: null, errors: [{ path: '', rule: TAKE_RULES.file, message: `não consegui ler ${path} (${code})` }], warnings: [], scenes: 0, steps: 0 };
  }
  const sha256 = sha256Hex(bytes);
  let input: unknown;
  try {
    input = parseYaml(bytes.toString('utf8'));
  } catch (error) {
    return { path, sha256, errors: [{ path: '', rule: TAKE_RULES.yaml, message: `YAML inválido: ${(error as Error).message}` }], warnings: [], scenes: 0, steps: 0 };
  }
  return { path, sha256, ...checkTakeChoreography(input) };
}

/** `take validate <arquivo>`: `{ok, errors: [{path, rule, message}], …}`, sem lançar. */
export function validateTakeFile(file: string): TakeValidation {
  const r = readAndCheck(file);
  return { ok: r.errors.length === 0, file: r.path, sha256: r.sha256, errors: r.errors, warnings: r.warnings, scenes: r.scenes, steps: r.steps };
}

/** Lê e valida para rodar; erro → `E_CHOREO_INVALID` com `data.errors` e os caminhos na mensagem. */
export function loadTakeChoreography(file: string): LoadedChoreography {
  const r = readAndCheck(file);
  if (r.doc === undefined || r.sha256 === null || r.errors.length > 0) {
    const summary = r.errors.map((e) => `${e.path === '' ? '(raiz)' : e.path}: ${e.message} [${e.rule}]`).join('; ');
    throw new ContrarregraError('E_CHOREO_INVALID', `coreografia inválida (${r.path}) — ${summary}`, { file: r.path, errors: r.errors });
  }
  return { path: r.path, sha256: r.sha256, doc: r.doc, warnings: r.warnings };
}
