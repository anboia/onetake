// Esquemas zod de S0 (spec.md) e a validação com caminho exato. Conferem em tempo de execução os tipos
// de `types.ts` (cada esquema é anotado com o tipo que valida, então o `typecheck` pega divergência).
//
// Convenções:
// - Objetos são estritos: campo fora de S0 é erro `unknown-field` com o caminho do campo (AC-0.1). Os
//   únicos abertos são o `Event` (cada `kind` ganha campos descritos noutras seções), o `status.json`
//   (S0.8 só fixa o `schema`) e os campos que a spec deixa sem forma (`detail`, `checkpoints[]`,
//   `toolchain`), que aceitam qualquer JSON.
// - Campo sem `?`/"opcional" na spec é obrigatório.
// - Todo campo terminado em `Ns` é tempo D/M: inteiro de 64 bits em string decimal (S0.7, AC-0.4).
// - Erros saem como `{path, rule, message}` (a forma de `choreo validate`, S3), com o caminho no estilo
//   `scenes[1].steps[3].tagret`; `rule` é uma das `RULES`. Mensagens em português (locale pt-BR do zod).

import { z } from 'zod';

import { type Config, REQUIRED_TEAM } from './config.ts';
import { ContrarregraError, type ErrorCode, RPC_ERROR_CODES } from './errors.ts';
import { jcsSha256 } from './jcs.ts';
import {
  type AbsolutePoint,
  type Choreography,
  type ClockPingParams,
  type ClockPingResult,
  type CompiledChoreography,
  type CompiledInfo,
  type Condition,
  type DeviceInfo,
  ELEMENT_STATES,
  ELEMENT_TYPES,
  type Event,
  EVENT_KINDS,
  type EventsFetchParams,
  type EventsFetchResult,
  type EventsJson,
  type HealthResult,
  type JsonObject,
  type JsonValue,
  type OcrSelector,
  type Offset,
  type Point,
  type PointOrTarget,
  type PreflightReport,
  PRIMARY_SELECTORS,
  PRIVATE_API_IDS,
  type Rect,
  type RpcFailure,
  type RpcMessage,
  type RpcNotification,
  type RpcRequest,
  type RpcSuccess,
  type RunnerCapabilities,
  type Scene,
  SCHEMA_IDS,
  type SessionHelloParams,
  type SessionHelloResult,
  type Size,
  type StatusFile,
  type Step,
  type SyncReport,
  type TakeManifest,
  type Target,
  type TreeNode,
  type UiActionResult,
  type VoiceFile,
} from './types.ts';

// ── Regras e formatação dos erros ─────────────────────────────────────────────────────────────────

/** Identificadores estáveis das regras (o Swift usa os mesmos nas fixtures inválidas). */
export const RULES = {
  required: 'required',
  unknownField: 'unknown-field',
  type: 'type',
  value: 'value',
  format: 'format',
  range: 'range',
  pointForm: 'S0.2/point-form',
  onePrimarySelector: 'S0.2/one-primary-selector',
  conditionForm: 'S0.3/condition-form',
  changedOnlyInExpect: 'S0.3/changed-only-in-expect',
  velocityXorDuration: 'S0.4/velocity-xor-durationMs',
  captionMax: 'S0.4/caption-max-34',
  sceneIdUnique: 'S0.4/scene-id-unique',
  refExpanded: 'S0.4/ref-expanded',
  compiledDefaults: 'S0.4/compiled-defaults',
  padMax: 'S0.5/pad-max-64KB',
  int64String: 'S0.7/int64-string',
  seconds3: 'S0.7/seconds-3-decimals',
  syncNotEvaluated: 'S7/error-null-not-ok',
} as const;
export type Rule = (typeof RULES)[keyof typeof RULES];

export interface ValidationIssue {
  /** Caminho do campo, ex.: `scenes[1].steps[3].tagret`; `''` = o documento inteiro. */
  path: string;
  rule: string;
  message: string;
}

export type Validation<T> = { ok: true; value: T; errors: [] } | { ok: false; errors: ValidationIssue[] };

const PARSE_CONTEXT = { error: z.locales.ptBR().localeError } as const;

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** `['scenes', 1, 'steps', 3, 'tagret']` → `scenes[1].steps[3].tagret`; chaves fora de identificador viram `["PX-1"]`. */
export function formatPath(path: readonly PropertyKey[]): string {
  let out = '';
  for (const segment of path) {
    if (typeof segment === 'number') out += `[${segment}]`;
    else {
      const key = String(segment);
      out += IDENTIFIER.test(key) ? (out === '' ? key : `.${key}`) : `[${JSON.stringify(key)}]`;
    }
  }
  return out;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** O campo no fim de `path` não existe no objeto pai da entrada (campo obrigatório ausente). */
function isMissing(input: unknown, path: readonly PropertyKey[]): boolean {
  if (path.length === 0) return input === undefined;
  let parent: unknown = input;
  for (const segment of path.slice(0, -1)) {
    if (parent === null || typeof parent !== 'object') return false;
    parent = (parent as Record<PropertyKey, unknown>)[segment];
  }
  const last = path[path.length - 1]!;
  if (Array.isArray(parent)) return typeof last === 'number' && parent[last] === undefined;
  return isPlainObject(parent) && typeof last === 'string' && !Object.hasOwn(parent, last);
}

function toIssues(issues: readonly z.core.$ZodIssue[], input: unknown): ValidationIssue[] {
  const out: ValidationIssue[] = [];
  const seen = new Set<string>();
  const push = (path: readonly PropertyKey[], rule: string, message: string): void => {
    const formatted = formatPath(path);
    const key = `${formatted}\u0000${rule}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ path: formatted, rule, message });
  };
  for (const issue of issues) {
    const path = issue.path;
    if (issue.code === 'unrecognized_keys') {
      for (const key of issue.keys) push([...path, key], RULES.unknownField, `campo desconhecido "${key}" (fora de S0)`);
      continue;
    }
    if (issue.code === 'custom') {
      const rule = (issue.params as { rule?: string } | undefined)?.rule ?? 'custom';
      push(path, rule, issue.message);
      continue;
    }
    if (isMissing(input, path)) {
      push(path, RULES.required, 'campo obrigatório ausente');
      continue;
    }
    switch (issue.code) {
      case 'invalid_type':
        push(path, RULES.type, issue.message);
        break;
      case 'invalid_union':
        push(path, issue.discriminator === undefined ? RULES.type : RULES.value, issue.message);
        break;
      case 'invalid_value':
      case 'invalid_key':
      case 'invalid_element':
        push(path, RULES.value, issue.message);
        break;
      case 'invalid_format':
        push(path, RULES.format, issue.message);
        break;
      case 'too_big':
      case 'too_small':
      case 'not_multiple_of':
        push(path, RULES.range, issue.message);
        break;
      default:
        push(path, (issue as { code: string }).code, (issue as { message: string }).message);
    }
  }
  return out;
}

/** Valida sem lançar; `errors` traz um item por problema, com caminho e regra. */
export function validate<T>(schema: z.ZodType<T>, value: unknown): Validation<T> {
  const result = schema.safeParse(value, PARSE_CONTEXT);
  if (result.success) return { ok: true, value: result.data, errors: [] };
  return { ok: false, errors: toIssues(result.error.issues, value) };
}

/** Valida e lança `ContrarregraError(code)` com `data.errors` e os caminhos na mensagem. */
export function parseOrThrow<T>(schema: z.ZodType<T>, value: unknown, code: ErrorCode, what: string): T {
  const result = validate(schema, value);
  if (result.ok) return result.value;
  const summary = result.errors.map((e) => `${e.path === '' ? '(raiz)' : e.path}: ${e.message} [${e.rule}]`).join('; ');
  throw new ContrarregraError(code, `falha na validação de ${what} — ${summary}`, { errors: result.errors });
}

type RefinementCtx = z.core.$RefinementCtx<unknown>;

function addRuleIssue(ctx: RefinementCtx, rule: Rule, message: string, path: PropertyKey[] = []): void {
  ctx.addIssue({ code: 'custom', message, path, params: { rule } });
}

// ── Escalares ─────────────────────────────────────────────────────────────────────────────────────

const NonEmpty = z.string().min(1);
const NonNegInt = z.int().min(0);
const PosInt = z.int().min(1);
const JsonSchema: z.ZodType<JsonValue> = z.json();
const JsonObjectSchema: z.ZodType<JsonObject> = z.record(z.string(), JsonSchema);

const INT64_PATTERN = /^-?(0|[1-9][0-9]*)$/;
const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;

export function isInt64String(value: unknown): value is string {
  if (typeof value !== 'string' || !INT64_PATTERN.test(value) || value === '-0') return false;
  const n = BigInt(value);
  return n >= INT64_MIN && n <= INT64_MAX;
}

const INT64_MESSAGE = 'tempo D/M tem de ser inteiro de 64 bits em string decimal (S0.7)';

/** Tempo D ou M em ns: string decimal de inteiro de 64 bits (S0.7). */
export const Int64StringSchema = z.custom<string>(isInt64String, { message: INT64_MESSAGE, params: { rule: RULES.int64String } });

function hasAtMostThreeDecimals(n: number): boolean {
  return Number.isFinite(n) && Math.abs(n * 1000 - Math.round(n * 1000)) < 1e-6;
}

/** Tempo R ou F em segundos, com até 3 casas (S0.7). */
const Seconds3 = z.number().refine(hasAtMostThreeDecimals, {
  message: 'tempo R/F em segundos com no máximo 3 casas decimais (S0.7)',
  params: { rule: RULES.seconds3 },
});

/** Percorre o valor e acusa todo campo `…Ns` que não seja inteiro de 64 bits em string (AC-0.4). */
function checkNsFields(value: unknown, ctx: RefinementCtx, path: PropertyKey[] = []): void {
  if (Array.isArray(value)) {
    value.forEach((item, i) => checkNsFields(item, ctx, [...path, i]));
    return;
  }
  if (!isPlainObject(value)) return;
  for (const [key, item] of Object.entries(value)) {
    if (key.endsWith('Ns') && !isInt64String(item)) addRuleIssue(ctx, RULES.int64String, INT64_MESSAGE, [...path, key]);
    checkNsFields(item, ctx, [...path, key]);
  }
}

const SHA256_HEX = z.string().regex(/^[0-9a-f]{64}$/, 'SHA-256 em hex minúsculo (64 dígitos)');
/** Data e hora (S0 não fixa o formato; os documentos da ferramenta usam ISO 8601). */
const Timestamp = NonEmpty;
const TakeIdSchema = z.string().regex(/^[0-9]{8}-[0-9]{6}-.+$/, 'takeId no formato YYYYMMDD-HHMMSS-<coreografia> (S0.8)');
const SceneIdSchema = z.string().regex(/^s[0-9]{2}$/, 'id de cena no formato ^s\\d{2}$ (S0.4)');
const NodeRefSchema = z.string().regex(/^@e[0-9]+$/, 'ref de nó no formato @e<n> (S0.6)');

/**
 * União escolhida pelas chaves presentes (e não por tentativa em todas as opções): o erro sai do ramo
 * certo, com o caminho exato do campo (AC-0.1), em vez de um "nenhuma opção serviu".
 */
function keyedUnion<T>(
  branches: readonly { when: (o: Record<string, unknown>) => boolean; schema: z.ZodType }[],
  fallback: { message: string; rule: Rule },
): z.ZodType<T> {
  return z.unknown().transform((input, ctx): T => {
    if (!isPlainObject(input)) {
      ctx.addIssue({ code: 'invalid_type', expected: 'object', input, message: 'esperava um objeto' });
      return z.NEVER;
    }
    const branch = branches.find((b) => b.when(input));
    if (branch === undefined) {
      ctx.addIssue({ code: 'custom', message: fallback.message, params: { rule: fallback.rule } });
      return z.NEVER;
    }
    const result = branch.schema.safeParse(input, PARSE_CONTEXT);
    if (result.success) return result.data as T;
    for (const issue of result.error.issues) ctx.addIssue({ ...issue } as Parameters<typeof ctx.addIssue>[0]);
    return z.NEVER;
  });
}

const has =
  (...keys: string[]) =>
  (o: Record<string, unknown>): boolean =>
    keys.some((k) => Object.hasOwn(o, k));

// ── S0.2 Ponto e alvo ─────────────────────────────────────────────────────────────────────────────

const AbsolutePointSchema: z.ZodType<AbsolutePoint> = z.strictObject({ x: z.number(), y: z.number() });
const NormalizedPointSchema = z.strictObject({ nx: z.number().min(0).max(1), ny: z.number().min(0).max(1) });
const POINT_KEYS = new Set(['x', 'y', 'nx', 'ny']);

const MixedPointSchema = z.custom<never>(() => false, {
  message: 'ponto mistura {x, y} e {nx, ny}; use uma forma só (S0.2)',
  params: { rule: RULES.pointForm },
});

export const PointSchema: z.ZodType<Point> = keyedUnion<Point>(
  [
    { when: (o) => has('x', 'y')(o) && has('nx', 'ny')(o), schema: MixedPointSchema },
    { when: has('nx', 'ny'), schema: NormalizedPointSchema },
    { when: has('x', 'y'), schema: AbsolutePointSchema },
  ],
  { message: 'ponto precisa de {x, y} em pontos ou {nx, ny} normalizado 0–1 (S0.2)', rule: RULES.pointForm },
);

export const RectSchema: z.ZodType<Rect> = z.strictObject({
  x: z.number(),
  y: z.number(),
  w: z.number().min(0),
  h: z.number().min(0),
});
const SizeSchema: z.ZodType<Size> = z.strictObject({ w: z.number().positive(), h: z.number().positive() });
const OffsetSchema: z.ZodType<Offset> = z.strictObject({ dx: z.number(), dy: z.number() });

const TargetRef: z.ZodType<Target> = z.lazy(() => TargetSchema);

export const OcrSelectorSchema: z.ZodType<OcrSelector> = z.strictObject({
  text: NonEmpty,
  within: TargetRef.optional(),
  region: RectSchema.optional(),
  occurrence: NonNegInt.optional(),
});

const targetShape = {
  ref: NonEmpty.optional(),
  app: NonEmpty.optional(),
  label: z.string().optional(),
  labelPrefix: z.string().optional(),
  labelContains: z.string().optional(),
  identifier: z.string().optional(),
  type: z.enum(ELEMENT_TYPES).optional(),
  within: TargetRef.optional(),
  below: TargetRef.optional(),
  above: TargetRef.optional(),
  index: NonNegInt.optional(),
  ocr: OcrSelectorSchema.optional(),
  point: PointSchema.optional(),
  offset: OffsetSchema.optional(),
  fallback: z.array(TargetRef).optional(),
};

export const TargetSchema: z.ZodType<Target> = z
  .strictObject(targetShape)
  .superRefine((target, ctx) => {
    const primaries = PRIMARY_SELECTORS.filter((key) => target[key] !== undefined);
    if (primaries.length > 1) {
      addRuleIssue(
        ctx,
        RULES.onePrimarySelector,
        `alvo com ${primaries.length} seletores primários (${primaries.join(', ')}); use exatamente um (S0.2)`,
      );
    } else if (primaries.length === 0 && target.type === undefined) {
      addRuleIssue(ctx, RULES.onePrimarySelector, `alvo sem seletor primário (${PRIMARY_SELECTORS.join(', ')}) nem type (S0.2)`);
    }
  });

/**
 * `from`/`to`/`via` de um `drag`: com alguma chave de ponto (`x`, `y`, `nx`, `ny`) e nenhuma de alvo, é
 * `Point` (um erro de digitação como `{x, y, z}` acusa só `z`); senão, `Target`.
 */
const TARGET_KEYS = new Set(Object.keys(targetShape));

export const PointOrTargetSchema: z.ZodType<PointOrTarget> = keyedUnion<PointOrTarget>(
  [
    {
      when: (o) => Object.keys(o).some((k) => POINT_KEYS.has(k)) && !Object.keys(o).some((k) => TARGET_KEYS.has(k)),
      schema: PointSchema,
    },
    { when: () => true, schema: TargetRef },
  ],
  { message: 'esperava um Point ({x, y} ou {nx, ny}) ou um Target (S0.2)', rule: RULES.pointForm },
);

// ── S0.3 Condição ─────────────────────────────────────────────────────────────────────────────────

/**
 * Condição de S0.3. `state: changed` só vale em `expect` (S0.3): `ExpectConditionSchema` o aceita, em
 * qualquer profundidade; `ConditionSchema` (waitFor, assert, checkpoint.until, block.when, repeat.until,
 * condição solta) o recusa no próprio `state`.
 */
function conditionSchema(allowChanged: boolean): z.ZodType<Condition> {
  const self: z.ZodType<Condition> = keyedUnion<Condition>(
    [
      {
        when: has('element'),
        schema: z
          .strictObject({ element: TargetRef, state: z.enum(ELEMENT_STATES), equals: z.string().optional() })
          .superRefine((condition, ctx) => {
            if (!allowChanged && condition.state === 'changed') {
              addRuleIssue(ctx, RULES.changedOnlyInExpect, 'state: changed só vale em expect (S0.3)', ['state']);
            }
          }),
      },
      {
        when: has('text'),
        schema: z.strictObject({ text: z.strictObject({ ocr: OcrSelectorSchema, state: z.enum(['visible', 'gone']) }) }),
      },
      {
        when: has('appState'),
        schema: z.strictObject({
          appState: z.strictObject({ app: NonEmpty, state: z.enum(['foreground', 'background', 'notRunning']) }),
        }),
      },
      { when: has('locked'), schema: z.strictObject({ locked: z.boolean() }) },
      { when: has('airplane'), schema: z.strictObject({ airplane: z.enum(['on', 'off']) }) },
      { when: has('network'), schema: z.strictObject({ network: z.enum(['online', 'offline']) }) },
      { when: has('all'), schema: z.strictObject({ all: z.array(z.lazy(() => self)) }) },
      { when: has('any'), schema: z.strictObject({ any: z.array(z.lazy(() => self)) }) },
      { when: has('not'), schema: z.strictObject({ not: z.lazy(() => self) }) },
    ],
    {
      message: 'condição sem forma de S0.3 (element, text, appState, locked, airplane, network, all, any, not)',
      rule: RULES.conditionForm,
    },
  );
  return self;
}

export const ConditionSchema: z.ZodType<Condition> = conditionSchema(false);
export const ExpectConditionSchema: z.ZodType<Condition> = conditionSchema(true);

// ── S0.4 Coreografia ──────────────────────────────────────────────────────────────────────────────

const StepRef: z.ZodType<Step> = z.lazy(() => StepSchema);

const CaptionSchema = z.string().refine((s) => Array.from(s).length <= 34, {
  message: 'caption com mais de 34 caracteres (S0.4)',
  params: { rule: RULES.captionMax },
});

const stepCommon = {
  id: NonEmpty.optional(),
  target: TargetRef.optional(),
  cue: NonNegInt.optional(),
  afterMs: NonNegInt.optional(),
  timeoutMs: NonNegInt.optional(),
  expect: ExpectConditionSchema.optional(),
  expectTimeoutMs: NonNegInt.optional(),
  repeat: z.strictObject({ until: ConditionSchema, max: PosInt }).optional(),
  onFail: z.enum(['pause', 'abort', 'continue']).optional(),
  optional: z.boolean().optional(),
  caption: CaptionSchema.optional(),
  visual: z.boolean().optional(),
  sim: z.enum(['run', 'skip', 'simulate']).optional(),
};

/** Um passo = campos comuns + `do` + argumentos da ação no mesmo objeto (os da ação prevalecem). */
function step<const A extends string, S extends z.core.$ZodLooseShape>(action: A, shape: S) {
  const merged = { ...stepCommon, do: z.literal(action), ...shape };
  return z.strictObject(merged as Omit<typeof stepCommon, keyof S> & { do: z.ZodLiteral<A> } & S);
}

const DragStepSchema = step('drag', {
  from: PointOrTargetSchema,
  to: PointOrTargetSchema,
  via: z.array(PointOrTargetSchema).optional(),
  pressMs: NonNegInt.optional(),
  velocity: z.number().positive().optional(),
  durationMs: PosInt.optional(),
  holdMs: NonNegInt.optional(),
}).superRefine((s, ctx) => {
  if (s.velocity !== undefined && s.durationMs !== undefined) {
    addRuleIssue(ctx, RULES.velocityXorDuration, 'drag com velocity e durationMs juntos; são excludentes (S0.4)', ['durationMs']);
  }
});

export const StepSchema: z.ZodType<Step> = z.discriminatedUnion('do', [
  step('tap', { target: TargetRef }),
  step('doubleTap', { target: TargetRef }),
  step('longPress', { target: TargetRef, durationMs: PosInt }),
  DragStepSchema,
  step('scrollTo', { target: TargetRef, within: TargetRef.optional(), direction: z.enum(['down', 'up']), maxSwipes: PosInt }),
  step('type', { text: z.string() }),
  step('press', { button: z.enum(['home', 'volumeUp', 'volumeDown']) }),
  step('lock', {}),
  step('wake', {}),
  step('home', {}),
  step('controlCenter', { action: z.enum(['open', 'close']) }),
  step('app', { action: z.enum(['activate', 'terminate', 'launch']) }),
  step('openURL', { url: NonEmpty }),
  step('wait', { ms: NonNegInt }),
  step('waitFor', { condition: ConditionSchema }),
  step('assert', { condition: ConditionSchema }),
  step('checkpoint', {
    id: NonEmpty,
    who: z.enum(['human', 'runner']),
    ask: z.string(),
    until: ConditionSchema,
    timeoutMs: NonNegInt,
    onTimeout: z.enum(['pause', 'abort']),
    steps: z.array(StepRef).optional(),
    alert: z.strictObject({ sound: JsonSchema, say: JsonSchema }).optional(),
  }),
  step('block', { when: ConditionSchema.optional(), steps: z.array(StepRef) }),
  step('mark', { label: z.string() }),
  step('hold', {}),
]);

export const SceneSchema: z.ZodType<Scene> = z.strictObject({
  id: SceneIdSchema,
  title: z.string(),
  line: z.array(z.string()).optional(),
  hold: z.strictObject({ padBeforeMs: NonNegInt.optional(), padAfterMs: NonNegInt.optional() }).optional(),
  steps: z.array(StepRef),
});

const choreographyShape = {
  schema: z.literal(SCHEMA_IDS.choreography),
  app: z.strictObject({
    bundleId: NonEmpty,
    iconLabel: z.string(),
    expectVersion: z.string(),
    urlPrefixes: z.array(NonEmpty),
  }),
  device: z.strictObject({
    language: NonEmpty,
    screenPt: SizeSchema,
    textSize: NonEmpty,
    appearance: z.enum(['light', 'dark']),
  }),
  guide: z.strictObject({ voice: NonEmpty, targetWpm: PosInt }).optional(),
  confirm: z.array(z.string()).optional(),
  targets: z.record(z.string(), TargetRef),
  prepare: z.array(StepRef),
  scenes: z.array(SceneSchema),
  cleanup: z.array(StepRef),
};

function uniqueSceneIds(doc: { scenes: readonly { id: string }[] }, ctx: RefinementCtx): void {
  const seen = new Map<string, number>();
  doc.scenes.forEach((scene, i) => {
    const first = seen.get(scene.id);
    if (first === undefined) seen.set(scene.id, i);
    else addRuleIssue(ctx, RULES.sceneIdUnique, `id de cena "${scene.id}" repetido (já em scenes[${first}]) (S0.4)`, ['scenes', i, 'id']);
  });
}

/** Na forma compilada todo `ref` já foi expandido (S0.4): nenhum objeto pode ter a chave `ref`. */
function refsExpanded(value: unknown, ctx: RefinementCtx, path: PropertyKey[]): void {
  if (Array.isArray(value)) {
    value.forEach((item, i) => refsExpanded(item, ctx, [...path, i]));
    return;
  }
  if (!isPlainObject(value)) return;
  if (Object.hasOwn(value, 'ref')) {
    addRuleIssue(ctx, RULES.refExpanded, 'ref não expandido na coreografia compilada (S0.4)', [...path, 'ref']);
  }
  for (const [key, item] of Object.entries(value)) refsExpanded(item, ctx, [...path, key]);
}

export const ChoreographySchema: z.ZodType<Choreography> = z.strictObject(choreographyShape).superRefine(uniqueSceneIds);

const CompiledInfoSchema: z.ZodType<CompiledInfo> = z.strictObject({
  sha256: SHA256_HEX,
  compiledAt: Timestamp,
  guide: z.strictObject({ voice: NonEmpty, wpm: z.number().positive(), factor: z.number().positive() }),
  scenes: z.array(
    z.strictObject({
      id: SceneIdSchema,
      sentences: z.array(z.strictObject({ text: z.string(), startMs: NonNegInt, durMs: NonNegInt })),
      holdMs: NonNegInt,
    }),
  ),
});

/** Campos que a compilação preenche em todo passo (S0.4: `afterMs` 300, `timeoutMs` 3000 ou 0 no `assert`, `onFail` pause, `sim` run). */
const COMPILED_STEP_DEFAULTS = ['afterMs', 'timeoutMs', 'onFail', 'sim'] as const;

function missingDefault(ctx: RefinementCtx, what: string, path: PropertyKey[]): void {
  addRuleIssue(ctx, RULES.compiledDefaults, `padrão não preenchido na forma compilada: ${what} (S0.4)`, path);
}

function compiledStepDefaults(steps: readonly Step[], ctx: RefinementCtx, path: PropertyKey[]): void {
  steps.forEach((step, i) => {
    const at = [...path, i];
    for (const key of COMPILED_STEP_DEFAULTS) if (step[key] === undefined) missingDefault(ctx, key, [...at, key]);
    if (step.expect !== undefined && step.expectTimeoutMs === undefined) missingDefault(ctx, 'expectTimeoutMs', [...at, 'expectTimeoutMs']);
    if ((step.do === 'block' || step.do === 'checkpoint') && step.steps !== undefined) {
      compiledStepDefaults(step.steps, ctx, [...at, 'steps']);
    }
  });
}

/**
 * S0.4: a forma compilada tem os `ref` expandidos e os padrões preenchidos — `guide` no topo e `hold`
 * de cada cena (da Config), e os padrões de cada passo, inclusive dentro de `block` e `checkpoint`.
 */
function compiledInvariants(doc: CompiledChoreography, ctx: RefinementCtx): void {
  for (const section of ['targets', 'prepare', 'scenes', 'cleanup'] as const) refsExpanded(doc[section], ctx, [section]);
  if (doc.guide === undefined) missingDefault(ctx, 'guide', ['guide']);
  doc.scenes.forEach((scene, i) => {
    if (scene.hold === undefined) missingDefault(ctx, 'hold', ['scenes', i, 'hold']);
    else {
      for (const key of ['padBeforeMs', 'padAfterMs'] as const) {
        if (scene.hold[key] === undefined) missingDefault(ctx, `hold.${key}`, ['scenes', i, 'hold', key]);
      }
    }
    compiledStepDefaults(scene.steps, ctx, ['scenes', i, 'steps']);
  });
  compiledStepDefaults(doc.prepare, ctx, ['prepare']);
  compiledStepDefaults(doc.cleanup, ctx, ['cleanup']);
}

export const CompiledChoreographySchema: z.ZodType<CompiledChoreography> = z
  .strictObject({ ...choreographyShape, compiled: CompiledInfoSchema })
  .superRefine(uniqueSceneIds)
  .superRefine(compiledInvariants);

/** `compiled.sha256` (S0.4): SHA-256 do JCS do documento compilado sem `compiled.sha256` e `compiled.compiledAt`. */
export function choreographySha256(doc: CompiledChoreography): string {
  const { sha256: _sha256, compiledAt: _compiledAt, ...compiled } = doc.compiled;
  return jcsSha256({ ...doc, compiled });
}

// ── S0.1 Configuração ─────────────────────────────────────────────────────────────────────────────

export const ConfigSchema: z.ZodType<Config> = z.strictObject({
  device: z.strictObject({ udid: NonEmpty, coreDeviceId: NonEmpty, name: NonEmpty }),
  signing: z.strictObject({
    team: z.literal(REQUIRED_TEAM, `o time de assinatura é fixo em ${REQUIRED_TEAM} (P-3)`),
    identity: NonEmpty,
    ascKeyPath: z.string().optional(),
  }),
  bundle: z.strictObject({ host: NonEmpty, runnerTest: NonEmpty, displayNames: z.array(NonEmpty) }),
  runner: z.strictObject({ port: z.int().min(1).max(65535), privateAllowed: z.array(z.enum(PRIVATE_API_IDS)) }),
  usbmux: z.strictObject({ socketPath: NonEmpty }),
  app: z.strictObject({ explore: NonEmpty.optional() }),
  apps: z.strictObject({ allowed: z.array(NonEmpty) }),
  urls: z.strictObject({ allowedPrefixes: z.array(NonEmpty) }),
  paths: z.strictObject({ takes: NonEmpty, cache: NonEmpty, ffmpeg: NonEmpty, ffprobe: NonEmpty }),
  obs: z.strictObject({
    url: NonEmpty,
    profile: NonEmpty,
    collection: NonEmpty,
    scene: NonEmpty,
    source: NonEmpty,
    flashSource: NonEmpty,
  }),
  secrets: z.strictObject({ obsPassword: NonEmpty }),
  alerts: z.strictObject({ sayDevice: NonEmpty, voice: NonEmpty }),
  guide: z.strictObject({
    voice: NonEmpty,
    targetWpm: PosInt,
    sentenceGapMs: NonNegInt,
    padBeforeMs: NonNegInt,
    padAfterMs: NonNegInt,
  }),
  disk: z.strictObject({ minFreeGiB: z.number().min(0), criticalGiB: z.number().min(0) }),
  record: z.strictObject({ fps: PosInt, bitrateKbps: PosInt }),
  sync: z.strictObject({ captureLatencyMs: z.number().min(0).optional() }),
  toolchain: z.strictObject({ validated: z.record(z.string(), z.string()) }),
});

// ── S0.6 Nó da árvore ─────────────────────────────────────────────────────────────────────────────

export const TreeNodeSchema: z.ZodType<TreeNode> = z.strictObject({
  ref: NodeRefSchema,
  type: z.enum(ELEMENT_TYPES),
  label: z.string().optional(),
  identifier: z.string().optional(),
  value: z.string().optional(),
  frame: RectSchema,
  enabled: z.boolean(),
  selected: z.boolean(),
  visible: z.boolean(),
  depth: NonNegInt,
  children: z.array(z.lazy(() => TreeNodeSchema)).optional(),
});

// ── S0.7 Evento ───────────────────────────────────────────────────────────────────────────────────

export const EventSchema: z.ZodType<Event> = z
  .looseObject({
    seq: NonNegInt,
    kind: z.enum(EVENT_KINDS),
    sceneId: z.string().regex(/^(s[0-9]{2}|prepare|cleanup)$/, 'sceneId: id de cena (^s\\d{2}$), "prepare" ou "cleanup" (S0.7)').optional(),
    stepId: NonEmpty.optional(),
    action: NonEmpty.optional(),
    target: TargetRef.optional(),
    caption: z.string().optional(),
    tDevStartNs: Int64StringSchema.optional(),
    tDispatchNs: Int64StringSchema.optional(),
    tDevEndNs: Int64StringSchema.optional(),
    tDevUptimeNs: Int64StringSchema.optional(),
    tMacNs: Int64StringSchema.optional(),
    tPredRawS: Seconds3.optional(),
    tRecS: Seconds3.optional(),
    tFinalS: Seconds3.optional(),
    tVideoObservedS: Seconds3.nullable().optional(),
    detectScore: z.number().optional(),
    status: NonEmpty.optional(),
    lateMs: z.number().optional(),
    path: z.enum(['private', 'public']).optional(),
    detail: JsonObjectSchema.optional(),
    overrunMs: z.number().min(0).optional(),
    id: NonEmpty.optional(),
    who: z.enum(['human', 'runner']).optional(),
    ask: z.string().optional(),
    timeoutMs: NonNegInt.optional(),
    waitedMs: z.number().min(0).optional(),
    at: Timestamp.optional(),
  })
  .superRefine((event, ctx) => checkNsFields(event, ctx));

// ── S0.8 Tomada ───────────────────────────────────────────────────────────────────────────────────

export const TakeManifestSchema: z.ZodType<TakeManifest> = z.strictObject({
  schema: z.literal(SCHEMA_IDS.take),
  takeId: TakeIdSchema,
  mode: z.enum(['take', 'rehearsal', 'dry']),
  status: z.enum(['preparing', 'recording', 'finished', 'aborted', 'failed']),
  scenesStartedAt: Timestamp.optional(),
  scenesResult: z.enum(['finished', 'aborted']).optional(),
  cause: z.string().optional(),
  choreography: z.strictObject({ path: NonEmpty, sha256: SHA256_HEX }),
  app: z.strictObject({ bundleId: NonEmpty, version: z.string() }),
  device: z.strictObject({ udid: NonEmpty, os: z.string(), transport: NonEmpty }),
  toolchain: JsonObjectSchema,
  startedAt: Timestamp,
  endedAt: Timestamp,
  interventions: JsonSchema,
  syncOk: z.boolean(),
  cleanupPending: z.boolean(),
  obsStats: z.strictObject({ renderSkipped: NonNegInt, outputSkipped: NonNegInt }),
  airplaneLeftOn: z.boolean(),
});

export const StatusFileSchema: z.ZodType<StatusFile> = z.looseObject({ schema: z.literal(SCHEMA_IDS.status) });

export const VoiceFileSchema: z.ZodType<VoiceFile> = z.strictObject({
  schema: z.literal(SCHEMA_IDS.voice),
  offsetMs: z.number(),
  calibrationMs: z.number(),
});

// ── S0.9 Relatórios ───────────────────────────────────────────────────────────────────────────────

export const PreflightReportSchema: z.ZodType<PreflightReport> = z.strictObject({
  schema: z.literal(SCHEMA_IDS.preflight),
  at: Timestamp,
  checks: z.array(
    z.strictObject({
      id: z.string().regex(/^PF-[0-9]{2}$/, 'id de checagem no formato PF-nn (S0.9)'),
      title: z.string(),
      status: z.enum(['pass', 'fail', 'warn', 'human']),
      detail: JsonSchema,
      fix: JsonSchema.optional(),
    }),
  ),
  ok: z.boolean(),
});

export const SyncReportSchema: z.ZodType<SyncReport> = z.strictObject({
  schema: z.literal(SCHEMA_IDS.sync),
  deviceToMac: z.strictObject({
    aNs: Int64StringSchema,
    bPpm: z.number(),
    residualMs: z.number().min(0),
    samples: NonNegInt,
    bursts: NonNegInt,
  }),
  macToRecording: z.strictObject({
    t0MacNs: Int64StringSchema,
    t0StdErrMs: z.number().min(0),
    fps: z.number().positive(),
    markers: NonNegInt,
    maxMarkerDevMs: z.number().min(0),
  }),
  captureLatency: z.strictObject({ alphaMs: z.number(), beta: z.number(), method: NonEmpty, eventsUsed: NonNegInt }),
  error: z
    .strictObject({
      method: z.literal('leave-one-out'),
      medianMs: z.number().min(0),
      maxMs: z.number().min(0),
      rawMedianMs: z.number().min(0),
      rawMaxMs: z.number().min(0),
    })
    .nullable(),
  ok: z.boolean(),
}).superRefine((report, ctx) => {
  if (report.error === null && report.ok) {
    addRuleIssue(ctx, RULES.syncNotEvaluated, 'error null (menos de 10 passos detectados) exige ok: false (S7 item 6)', ['ok']);
  }
});

/** `events.json` (S0.7): a tomada, a sincronia, o corte, o resumo por cena e todos os eventos. */
export const EventsJsonSchema: z.ZodType<EventsJson> = z
  .strictObject({
    schema: z.literal(SCHEMA_IDS.events),
    take: TakeManifestSchema,
    clock: SyncReportSchema,
    trim: z.strictObject({ startR: Seconds3, endR: Seconds3, leadInS: z.number().min(0) }),
    scenes: z.array(
      z.strictObject({
        id: SceneIdSchema,
        title: z.string(),
        startF: Seconds3,
        endF: Seconds3,
        guideS: z.number().min(0),
        holdS: z.number().min(0),
        checkpointsS: z.number().min(0),
        overrunMs: z.number().min(0),
      }),
    ),
    checkpoints: z.array(JsonObjectSchema),
    events: z.array(EventSchema),
  })
  .superRefine((doc, ctx) => checkNsFields(doc, ctx));

// ── S0.5 Protocolo Mac ↔ runner (JSON-RPC 2.0) ────────────────────────────────────────────────────

const JsonRpcVersion = z.literal('2.0');
const RpcIdSchema = z.union([z.string(), z.int()]);

/** Códigos de erro do JSON-RPC 2.0 (parse, pedido, método, parâmetros, interno). */
export const JSON_RPC_STANDARD_ERRORS = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const;

const KNOWN_ERROR_CODES = new Set<number>([...Object.values(JSON_RPC_STANDARD_ERRORS), ...Object.values(RPC_ERROR_CODES)]);

export const RpcFailureSchema: z.ZodType<RpcFailure> = z.strictObject({
  jsonrpc: JsonRpcVersion,
  id: RpcIdSchema.nullable(),
  error: z.strictObject({
    code: z.int().refine((code) => KNOWN_ERROR_CODES.has(code), {
      message: 'código de erro fora da tabela de S0.5 e do JSON-RPC 2.0',
      params: { rule: RULES.value },
    }),
    message: z.string(),
    data: JsonSchema.optional(),
  }),
});

const EmptyParamsSchema = z.strictObject({});

const DeviceInfoSchema: z.ZodType<DeviceInfo> = z.strictObject({
  model: NonEmpty,
  os: NonEmpty,
  screenPt: SizeSchema,
  scale: z.number().positive(),
  language: NonEmpty,
  textSize: NonEmpty,
  appearance: z.enum(['light', 'dark']),
});

export const SessionHelloParamsSchema: z.ZodType<SessionHelloParams> = z.strictObject({
  token: NonEmpty,
  role: z.enum(['control', 'sync']),
  client: JsonSchema,
});

export const SessionHelloResultSchema: z.ZodType<SessionHelloResult> = z.strictObject({
  runnerVersion: NonEmpty,
  capabilities: JsonSchema,
  device: DeviceInfoSchema,
  clock: z.strictObject({ nowRawNs: Int64StringSchema, nowUptimeNs: Int64StringSchema }),
});

export const HealthResultSchema: z.ZodType<HealthResult> = z.strictObject({
  ok: z.boolean(),
  uptimeS: z.number().min(0),
  xctestQueueDepth: NonNegInt,
  treeVersion: NonNegInt,
  foregroundApp: z.string(),
  locked: z.boolean(),
});

const PadSchema = z.string().refine((s) => Buffer.byteLength(s, 'utf8') <= 65536, {
  message: 'pad do clock.ping com mais de 64 KB (S0.5)',
  params: { rule: RULES.padMax },
});

export const ClockPingParamsSchema: z.ZodType<ClockPingParams> = z.strictObject({ seq: NonNegInt, pad: PadSchema.optional() });

export const ClockPingResultSchema: z.ZodType<ClockPingResult> = z.strictObject({
  seq: NonNegInt,
  t2RawNs: Int64StringSchema,
  t3RawNs: Int64StringSchema,
  t2UptimeNs: Int64StringSchema,
  pad: PadSchema.optional(),
});

export const EventsFetchParamsSchema: z.ZodType<EventsFetchParams> = z.strictObject({
  takeId: TakeIdSchema,
  sinceSeq: NonNegInt,
});

export const EventsFetchResultSchema: z.ZodType<EventsFetchResult> = z.strictObject({
  events: z.array(EventSchema),
  lastSeq: NonNegInt,
});

const CapabilitySchema = z.strictObject({ present: z.boolean(), allowed: z.boolean() });
export const RunnerCapabilitiesSchema: z.ZodType<RunnerCapabilities> = z.strictObject({
  'PX-1': CapabilitySchema,
  'PX-2': CapabilitySchema,
  'PX-3': CapabilitySchema,
  'PX-4': CapabilitySchema,
  'PX-5': CapabilitySchema,
  'PX-6': CapabilitySchema,
});

export const UiActionResultSchema: z.ZodType<UiActionResult> = z.strictObject({
  point: AbsolutePointSchema,
  nodeRef: NodeRefSchema.optional(),
  tDevStartNs: Int64StringSchema,
  tDispatchNs: Int64StringSchema,
  tDevEndNs: Int64StringSchema,
  path: z.enum(['private', 'public']),
});

/** Métodos de base de S0.5 (os demais estão em S1 e entram com as tarefas do runner). */
export const RPC_BASE_METHODS = {
  'session.hello': { params: SessionHelloParamsSchema, result: SessionHelloResultSchema },
  health: { params: EmptyParamsSchema, result: HealthResultSchema },
  'clock.ping': { params: ClockPingParamsSchema, result: ClockPingResultSchema },
  'events.fetch': { params: EventsFetchParamsSchema, result: EventsFetchResultSchema },
  'runner.capabilities': { params: EmptyParamsSchema, result: RunnerCapabilitiesSchema },
} as const satisfies Record<string, { params: z.ZodType; result: z.ZodType }>;
export type RpcBaseMethod = keyof typeof RPC_BASE_METHODS;

/** Ações `ui.*` (S1 item 4): a resposta é a de S0.5. */
export const UI_ACTION_METHODS = ['ui.tap', 'ui.doubleTap', 'ui.longPress', 'ui.drag', 'ui.scrollTo', 'ui.type'] as const;

/** Notificações do runner (sem `id`): `event` leva um `Event` em `params`; `log`, um objeto JSON. */
const NOTIFICATION_PARAMS: Record<string, z.ZodType> = { event: EventSchema, log: JsonObjectSchema };

function baseMethod(method: string): (typeof RPC_BASE_METHODS)[RpcBaseMethod] | undefined {
  return Object.hasOwn(RPC_BASE_METHODS, method) ? RPC_BASE_METHODS[method as RpcBaseMethod] : undefined;
}

/** Pedido do `method` dado: parâmetros conferidos nos métodos de base; nos outros, um objeto JSON. */
export function rpcRequestSchemaFor(method: string): z.ZodType<RpcRequest<unknown>> {
  const known = baseMethod(method);
  return z.strictObject({
    jsonrpc: JsonRpcVersion,
    id: RpcIdSchema,
    method: z.literal(method),
    params: known ? known.params : JsonObjectSchema.optional(),
  });
}

/** Resposta de sucesso ao `method` dado (o JSON-RPC não repete o método: quem chamou sabe qual foi). */
export function rpcResponseSchemaFor(method: string): z.ZodType<RpcSuccess<unknown>> {
  const known = baseMethod(method);
  const isUiAction = (UI_ACTION_METHODS as readonly string[]).includes(method);
  return z.strictObject({
    jsonrpc: JsonRpcVersion,
    id: RpcIdSchema,
    result: known ? known.result : isUiAction ? UiActionResultSchema : JsonSchema,
  });
}

export function rpcNotificationSchemaFor(method: string): z.ZodType<RpcNotification<unknown>> {
  const params = Object.hasOwn(NOTIFICATION_PARAMS, method) ? NOTIFICATION_PARAMS[method]! : JsonObjectSchema.optional();
  return z.strictObject({ jsonrpc: JsonRpcVersion, method: z.literal(method), params });
}

const GenericRequestSchema = z.strictObject({
  jsonrpc: JsonRpcVersion,
  id: RpcIdSchema,
  method: NonEmpty,
  params: JsonObjectSchema.optional(),
});
const GenericNotificationSchema = z.strictObject({ jsonrpc: JsonRpcVersion, method: NonEmpty, params: JsonObjectSchema.optional() });
const GenericSuccessSchema = z.strictObject({ jsonrpc: JsonRpcVersion, id: RpcIdSchema, result: JsonSchema });

/** Qualquer mensagem do envelope (uma mensagem WebSocket = um objeto), pela forma: pedido, notificação, sucesso ou erro. */
export const RpcMessageSchema: z.ZodType<RpcMessage> = keyedUnion<RpcMessage>(
  [
    { when: (o) => has('method')(o) && has('id')(o), schema: GenericRequestSchema },
    { when: has('method'), schema: GenericNotificationSchema },
    { when: has('error'), schema: RpcFailureSchema },
    { when: has('result'), schema: GenericSuccessSchema },
  ],
  { message: 'mensagem JSON-RPC 2.0 sem method, result nem error', rule: RULES.type },
);

// ── Registro e atalhos ────────────────────────────────────────────────────────────────────────────

/** Esquema por nome de documento (o nome é o prefixo dos arquivos de fixture). */
export const DOCUMENT_SCHEMAS = {
  Config: ConfigSchema,
  Point: PointSchema,
  Target: TargetSchema,
  Condition: ConditionSchema,
  Step: StepSchema,
  Choreography: ChoreographySchema,
  CompiledChoreography: CompiledChoreographySchema,
  TreeNode: TreeNodeSchema,
  Event: EventSchema,
  EventsJson: EventsJsonSchema,
  TakeManifest: TakeManifestSchema,
  StatusFile: StatusFileSchema,
  VoiceFile: VoiceFileSchema,
  PreflightReport: PreflightReportSchema,
  SyncReport: SyncReportSchema,
  RpcMessage: RpcMessageSchema,
  RpcError: RpcFailureSchema,
} as const;

/** `{ok, errors: [{path, rule, message}]}` de S3 para uma coreografia fonte (já lida do YAML). */
export function validateChoreography(value: unknown): Validation<Choreography> {
  return validate(ChoreographySchema, value);
}

export function parseChoreography(value: unknown): Choreography {
  return parseOrThrow(ChoreographySchema, value, 'E_CHOREO_INVALID', 'coreografia');
}

export function parseCompiledChoreography(value: unknown): CompiledChoreography {
  return parseOrThrow(CompiledChoreographySchema, value, 'E_CHOREO_INVALID', 'coreografia compilada');
}

/** Um alvo solto (exploração, MCP): mesma regra do seletor primário (AC-0.3). */
export function parseTarget(value: unknown): Target {
  return parseOrThrow(TargetSchema, value, 'E_CHOREO_INVALID', 'alvo');
}

/** A configuração já mesclada (S0.1). */
export function parseConfig(value: unknown): Config {
  return parseOrThrow(ConfigSchema, value, 'E_CONFIG', 'configuração');
}
