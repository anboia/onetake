// Executor da tomada no Mac (spec/tasks.md "Trilha do demo": o Mac manda um passo por vez ao runner, sem
// o executor de prazos absolutos do aparelho de S4). Para cada passo (S0.4):
//
// - tempo: começa em `max(fim do anterior + afterMs (300), instante planejado da frase cue)`; a frase n
//   da cena começa em `início da cena + padBeforeMs + Σ frases anteriores + n × gapMs` (só com `--voice`);
// - ação → um método do runner (S0.5/S1 item 4) com prazo de RPC folgado (prazo do runner + 10 s);
// - alvo não achado (`E_TARGET_NOT_FOUND`) → `wait.for {element: alvo, state: exists}` até `timeoutMs`
//   (3000) e uma nova tentativa; não apareceu e `optional: true` → `skipped`;
// - `E_TIMEOUT` com `data.phase = running` (ou sem resposta do runner) = a ação ainda pode acontecer (até
//   ~2 min; SP-2): nunca se repete às cegas — confirma-se pelo `expect` (prazo estendido a 120 s) ou, sem
//   `expect`, esperando a fila do XCTest esvaziar (`health.xctestQueueDepth = 0`); `phase: queued` = não
//   rodou, pode tentar de novo;
// - `expect` → `wait.for` até `expectTimeoutMs` (3000);
// - falha → `onFail`: `continue` segue; `abort` encerra; `pause` (padrão) faz uma nova tentativa automática
//   (se a falha não deixou a ação em dúvida) e então pausa: aviso falado no Mac e espera de
//   `take control` (`control.json`: resume = segue como sucesso, retry = refaz, skip = pula, abort) por
//   até 10 min, depois aborta.
//
// Regras da tomada na seção `scenes` (S1 item 9, P-4): `openURL`, `app launch` e `press` → `E_FORBIDDEN_IN_TAKE`
// antes de falar com o runner; em qualquer seção, `type` com texto de credencial → `E_SECURE_FIELD` sem
// chamar o runner (P-3). Pontos de controle (S5): `who: human` avalia `until` uma vez; falsa, avisa no Mac
// (`say`, nunca no iPhone) e sonda em fatias de ≤ 20 s, repetindo o aviso a cada 20 s, até `timeoutMs` →
// `onTimeout`. `who: runner` roda `steps` e espera `until`, sem aviso. Cena: capítulo no OBS com o título,
// espera `padBeforeMs`, roda os passos e garante a duração mínima (`padBeforeMs + narração + padAfterMs`).
//
// Relógio, runner, OBS, aviso falado e `control.json` são injetados (os testes usam falsos).

import { ContrarregraError, isContrarregraError } from '../core/errors.ts';
import type { Choreography, Condition, PointOrTarget, Scene, Step, Target } from '../core/types.ts';
import { RpcProtocolError } from '../runner/rpc.ts';
import { looksLikeCredential } from './choreo.ts';
import type { ControlOp } from './control.ts';
import type { SceneRecord, StepRecord, TakeRecord, TakeSection } from './manifest.ts';
import { cueOffsetMs, narrationMs, type VoicePlan } from './voice.ts';

/** Padrões de S0.4. */
export const DEFAULT_AFTER_MS = 300;
export const DEFAULT_TARGET_TIMEOUT_MS = 3_000;
export const DEFAULT_EXPECT_TIMEOUT_MS = 3_000;
/** `expect` depois de uma ação que estourou o prazo rodando: ela pode acontecer até ~2 min depois (SP-2). */
export const LATE_EXPECT_TIMEOUT_MS = 120_000;
/** Prazo do runner por comando na fila do XCTest (S1 item 3) e a folga do lado do Mac. */
export const RUNNER_COMMAND_MS = 10_000;
export const RPC_SLACK_MS = 10_000;
/** `wait.for`: o runner responde até `timeoutMs + 1 s` (S1 item 3). */
export const WAIT_FOR_LANE_EXTRA_MS = 1_000;
/** Espera da fila do XCTest esvaziar depois de um `E_TIMEOUT`. */
export const DRAIN_MAX_MS = 120_000;
export const DRAIN_POLL_MS = 1_000;
/** Pontos de controle (S5 item 2): sondagem em fatias e aviso repetido. */
export const CHECKPOINT_SLICE_MS = 20_000;
export const ALERT_REPEAT_MS = 20_000;
/** Pausa: prazo para o `take control` e a sondagem do `control.json`. */
export const PAUSE_MAX_MS = 600_000;
export const CONTROL_POLL_MS = 250;
/** Granularidade das esperas (o `abort` corta qualquer espera em até isto). */
export const SLEEP_SLICE_MS = 250;
/** `ui.drag` exige `pressMs` e `holdMs`; padrões quando o passo não diz (o `scrollTo` de S0.4 usa 50 ms). */
export const DRAG_PRESS_MS = 50;
export const DRAG_HOLD_MS = 0;

/** O que o executor usa do runner: uma chamada JSON-RPC com prazo (a linha que reconecta, ou um falso). */
export interface TakeRunner {
  call<T = unknown>(method: string, params: Record<string, unknown>, options: { timeoutMs: number }): Promise<T>;
}

/** Relógio do Mac em ms (epoch) e espera; os testes avançam um relógio falso. */
export interface TakeClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

/** O lado do OBS durante a gravação; ausente no `--dry` e fora da gravação (`prepare`/`cleanup`). */
export interface TakeRecorder {
  /** `GetRecordStatus.outputDuration` (ms do arquivo) agora. */
  outputMs(): Promise<number | null>;
  /** `CreateRecordChapter {chapterName}` (702 etc. → erro, que o executor só registra). */
  chapter(name: string): Promise<void>;
}

/** `control.json` da pasta da tomada. */
export interface TakeControl {
  read(): ControlOp | undefined;
  clear(): void;
}

export interface ExecutorOptions {
  /** A coreografia validada, com os `ref` expandidos. */
  doc: Choreography;
  record: TakeRecord;
  runner: TakeRunner;
  clock: TakeClock;
  /** Aviso falado no Mac (nunca no iPhone; P-7). */
  say: (text: string) => void;
  /** Linhas curtas para o dono (stderr). */
  log: (line: string) => void;
  control: TakeControl;
  /** Regrava `take.json`. */
  persist: () => void;
  voice?: VoicePlan | null;
  /** `guide.padBeforeMs`/`guide.padAfterMs` da configuração (quando a cena não tem `hold`). */
  pads: { padBeforeMs: number; padAfterMs: number };
  /** Como o dono responde a uma pausa, ex.: `contrarregra take control <dir>`. */
  controlHint: string;
}

/** A tomada foi encerrada (dono, `onFail: abort`, prazo da pausa): não é erro da ferramenta. */
export class TakeAborted extends Error {
  override readonly name = 'TakeAborted';
  /** `SIGINT`, `control-abort`, `pause-timeout`, `step-failed`. */
  readonly reason: string;

  constructor(reason: string, message: string) {
    super(message);
    this.reason = reason;
  }
}

// ── Plano das cenas (--scenes, --from, --until) ───────────────────────────────────────────────────

export interface SceneSelection {
  /** `--scenes s02,s05`: só estas cenas, na ordem da coreografia. */
  scenes?: readonly string[];
  /** `--from <stepId|sceneId>`: começa nesta cena, ou neste passo (de primeiro nível) da cena dele. */
  from?: string;
  /** `--until <stepId|sceneId>`: para ANTES deste passo (ou cena) e encerra limpo. */
  until?: string;
}

export interface ScenePlan {
  scene: Scene;
  /** Índice (0-based) do primeiro passo a rodar. */
  startAt: number;
  /** Para antes deste índice (o `--until`); `null` = a cena inteira. A última cena do plano. */
  stopBefore: number | null;
}

function optionError(option: string, message: string): ContrarregraError {
  return new ContrarregraError('E_CHOREO_INVALID', `${option}: ${message}`, { option });
}

function locate(scenes: readonly Scene[], id: string): { scene: number; step: number | null } | undefined {
  const sceneIndex = scenes.findIndex((s) => s.id === id);
  if (sceneIndex >= 0) return { scene: sceneIndex, step: null };
  for (let i = 0; i < scenes.length; i++) {
    const step = scenes[i]!.steps.findIndex((s) => s.id === id);
    if (step >= 0) return { scene: i, step };
  }
  return undefined;
}

/** As cenas a rodar e onde começar/parar; id desconhecido → `E_CHOREO_INVALID` citando a opção. */
export function planScenes(doc: Choreography, selection: SceneSelection = {}): ScenePlan[] {
  let scenes = doc.scenes;
  if (selection.scenes !== undefined) {
    const known = new Set(doc.scenes.map((s) => s.id));
    const unknown = selection.scenes.filter((id) => !known.has(id));
    if (unknown.length > 0) throw optionError('--scenes', `cena(s) inexistente(s): ${unknown.join(', ')} (há ${[...known].join(', ')})`);
    const wanted = new Set(selection.scenes);
    scenes = doc.scenes.filter((s) => wanted.has(s.id));
  }
  let startAt = 0;
  if (selection.from !== undefined) {
    const at = locate(scenes, selection.from);
    if (at === undefined) throw optionError('--from', `"${selection.from}" não é id de cena nem de passo (de primeiro nível) das cenas escolhidas`);
    scenes = scenes.slice(at.scene);
    startAt = at.step ?? 0;
  }
  const plan: ScenePlan[] = scenes.map((scene, i) => ({ scene, startAt: i === 0 ? startAt : 0, stopBefore: null }));
  if (selection.until !== undefined) {
    const at = locate(scenes, selection.until);
    if (at === undefined) throw optionError('--until', `"${selection.until}" não é id de cena nem de passo (de primeiro nível) das cenas a rodar`);
    // Parar antes do primeiro passo que rodaria na cena = parar antes da cena (sem capítulo nem espera).
    if (at.step === null || at.step <= plan[at.scene]!.startAt) return plan.slice(0, at.scene);
    const out = plan.slice(0, at.scene + 1);
    out[at.scene]!.stopBefore = at.step;
    return out;
  }
  return plan;
}

/** Permanência mínima da cena: `padBeforeMs + narração + padAfterMs` (S4 item 3, S6 item 3). */
export function sceneTiming(scene: Scene, voice: VoicePlan | null, pads: { padBeforeMs: number; padAfterMs: number }): { padBeforeMs: number; padAfterMs: number; narrationMs: number; minDurationMs: number } {
  const padBeforeMs = scene.hold?.padBeforeMs ?? pads.padBeforeMs;
  const padAfterMs = scene.hold?.padAfterMs ?? pads.padAfterMs;
  const narration = voice === null ? 0 : narrationMs(voice, scene.id);
  return { padBeforeMs, padAfterMs, narrationMs: narration, minDurationMs: padBeforeMs + narration + padAfterMs };
}

/** Estimativa grosseira da duração de um passo (para a conta de disco, HC-11): ações ≈ 2 s; esperas pelo prazo. */
export function estimateStepMs(step: Step): number {
  const after = step.afterMs ?? DEFAULT_AFTER_MS;
  switch (step.do) {
    case 'wait':
      return after + step.ms;
    case 'waitFor':
      return after + (step.timeoutMs ?? DEFAULT_TARGET_TIMEOUT_MS);
    case 'checkpoint':
      return after + step.timeoutMs + (step.steps ?? []).reduce((sum, s) => sum + estimateStepMs(s), 0);
    case 'block':
      return after + step.steps.reduce((sum, s) => sum + estimateStepMs(s), 0);
    case 'mark':
    case 'hold':
      return after;
    default:
      return after + 2_000;
  }
}

/** Duração estimada das cenas do plano (cada uma: o maior entre a permanência mínima e a soma dos passos). */
export function estimateScenesMs(plan: readonly ScenePlan[], voice: VoicePlan | null, pads: { padBeforeMs: number; padAfterMs: number }): number {
  let total = 0;
  for (const item of plan) {
    const timing = sceneTiming(item.scene, voice, pads);
    const steps = item.scene.steps.slice(item.startAt, item.stopBefore ?? undefined).reduce((sum, s) => sum + estimateStepMs(s), 0);
    total += Math.max(timing.minDurationMs, timing.padBeforeMs + steps);
  }
  return total;
}

// ── Passo → método do runner ──────────────────────────────────────────────────────────────────────

export interface RunnerCall {
  method: string;
  params: Record<string, unknown>;
}

const POINT_KEYS = ['x', 'y', 'nx', 'ny'];

function isPoint(value: PointOrTarget): boolean {
  const keys = Object.keys(value);
  return keys.length > 0 && keys.every((k) => POINT_KEYS.includes(k));
}

/** O método e os parâmetros do runner para uma ação; `null` para os passos que o Mac resolve sozinho. */
export function actionCall(step: Step, bundleId: string): RunnerCall | null {
  switch (step.do) {
    case 'tap':
      return { method: 'ui.tap', params: { target: step.target } };
    case 'doubleTap':
      return { method: 'ui.doubleTap', params: { target: step.target } };
    case 'longPress':
      return { method: 'ui.longPress', params: { target: step.target, durationMs: step.durationMs } };
    case 'drag': {
      const params: Record<string, unknown> = {
        from: step.from,
        to: step.to,
        pressMs: step.pressMs ?? DRAG_PRESS_MS,
        holdMs: step.holdMs ?? DRAG_HOLD_MS,
      };
      if (step.via !== undefined) params['via'] = step.via;
      if (step.velocity !== undefined) params['velocity'] = step.velocity;
      if (step.durationMs !== undefined) params['durationMs'] = step.durationMs;
      return { method: 'ui.drag', params };
    }
    case 'scrollTo': {
      const params: Record<string, unknown> = { target: step.target, direction: step.direction, maxSwipes: step.maxSwipes };
      if (step.within !== undefined) params['within'] = step.within;
      return { method: 'ui.scrollTo', params };
    }
    case 'type': {
      const params: Record<string, unknown> = { text: step.text };
      if (step.target !== undefined) params['target'] = step.target;
      return { method: 'ui.type', params };
    }
    case 'lock':
      return { method: 'device.lock', params: {} };
    case 'wake':
      return { method: 'device.wake', params: {} };
    case 'home':
      return { method: 'device.home', params: {} };
    case 'controlCenter':
      return { method: 'device.controlCenter', params: { action: step.action } };
    case 'app':
      return { method: `app.${step.action}`, params: { bundleId } };
    case 'openURL':
      return { method: 'app.openURL', params: { url: step.url } };
    case 'press':
      return { method: 'device.press', params: { button: step.button } };
    default:
      return null;
  }
}

/**
 * O alvo a esperar quando a ação responde `E_TARGET_NOT_FOUND`. O `scrollTo` não tem: ele mesmo procura o alvo
 * arrastando, e o `E_TARGET_NOT_FOUND` dele pode vir depois dos arrastos (nada se repete).
 */
export function waitTargetOf(step: Step): Target | undefined {
  switch (step.do) {
    case 'tap':
    case 'doubleTap':
    case 'longPress':
      return step.target;
    case 'type':
      return step.target;
    case 'drag':
      for (const end of [step.from, step.to]) if (!isPoint(end)) return end as Target;
      return undefined;
    default:
      return undefined;
  }
}

/** Toque no interruptor do modo avião da Central de Controle (S1 item 7: `airplane-mode-button`). */
export function isAirplaneToggle(step: Step): boolean {
  if (step.do !== 'tap' && step.do !== 'doubleTap') return false;
  const t = step.target;
  return t.identifier === 'airplane-mode-button' || [t.label, t.labelPrefix, t.labelContains].some((x) => x !== undefined && /airplane/i.test(x));
}

/** Ação proibida na seção (S1 item 9, P-3, P-4): o erro, sem falar com o runner. */
export function forbiddenAction(step: Step, section: TakeSection): ContrarregraError | undefined {
  if (section === 'scenes') {
    if (step.do === 'openURL') return new ContrarregraError('E_FORBIDDEN_IN_TAKE', 'openURL é proibido durante a tomada (S1 item 9); só em prepare/cleanup', { do: step.do });
    if (step.do === 'press') return new ContrarregraError('E_FORBIDDEN_IN_TAKE', 'press é proibido durante a tomada (botões mostram o HUD; P-4)', { do: step.do });
    if (step.do === 'app' && step.action === 'launch') {
      return new ContrarregraError('E_FORBIDDEN_IN_TAKE', 'app launch é proibido durante a tomada (P-4); use activate', { do: step.do });
    }
  }
  if (step.do === 'type' && (looksLikeCredential(step.text) || step.target?.type === 'secureTextField')) {
    return new ContrarregraError('E_SECURE_FIELD', 'type recusado: texto com cara de credencial ou campo seguro (P-3, E-3.3); é ponto de controle humano', { do: step.do });
  }
  return undefined;
}

// ── Classificação de erros ────────────────────────────────────────────────────────────────────────

/**
 * Erros que garantidamente acontecem ANTES da ação (nada foi feito no aparelho): os únicos com nova
 * tentativa automática. O alvo que não resolve (`E_TARGET_NOT_FOUND`, `E_TARGET_AMBIGUOUS`) ou não é
 * tocável (`E_TARGET_NOT_HITTABLE`) — fora do `scrollTo`, que dá esses erros depois de esgotar os arrastos —,
 * o comando que estourou o prazo ainda na fila (`E_TIMEOUT phase: queued`), a linha caída antes de mandar
 * (`E_RUNNER_DOWN` reconectando) e o runner ocupado (`E_BUSY`). Todo o resto (inclusive `E_XCTEST` e
 * `E_APP_STATE`, que o runner pode devolver depois de o evento já ter sido enviado) = "pode ter rodado":
 * nunca repetir sozinho; vai direto ao `onFail` (a pausa deixa o dono pedir `retry`).
 */
const TARGET_ERRORS = new Set(['E_TARGET_NOT_FOUND', 'E_TARGET_AMBIGUOUS', 'E_TARGET_NOT_HITTABLE']);

interface Failure {
  status: 'failed';
  error: unknown;
  /** A falha foi antes da ação: uma nova tentativa automática é segura. */
  autoRetry: boolean;
  /**
   * A ação pode estar rodando ainda (`E_TIMEOUT` rodando, sem resposta, conexão caída no meio): confirma-se
   * pelo `expect` (prazo estendido) ou esperando a fila do XCTest esvaziar, nunca repetindo.
   */
  late: boolean;
  /** Esperar a fila do XCTest esvaziar antes de outra tentativa. */
  drain: boolean;
  /** Ponto de controle: o `onTimeout` vale no lugar do `onFail`. */
  onFail?: 'pause' | 'abort';
}

type Attempt = { status: 'ok' | 'skipped' } | Failure;

const OK: Attempt = { status: 'ok' };
const SKIPPED: Attempt = { status: 'skipped' };

/** Novas leituras de uma condição cuja avaliação estourou o prazo do runner sem terminar (aparelho lento). */
const SLOW_READ_RETRIES = 3;

/** O que um erro diz sobre a ação do passo (S0.5; SP-2: `phase` do `E_TIMEOUT`). */
export function classifyActionError(error: unknown, action?: Step['do']): Omit<Failure, 'status' | 'error'> {
  if (isContrarregraError(error, 'E_TIMEOUT')) {
    if (error.data?.['phase'] === 'queued') return { autoRetry: true, late: false, drain: true };
    // `running`, ou o prazo do lado do Mac (sem resposta): a ação pode ter acontecido ou ainda acontecer.
    return { autoRetry: false, late: true, drain: true };
  }
  if (isContrarregraError(error, 'E_RUNNER_DOWN')) {
    // Fechou no meio da chamada: não se sabe se rodou. Caída antes de mandar: não rodou.
    const midCall = error.data?.['reason'] === 'connection-closed';
    return { autoRetry: !midCall, late: midCall, drain: false };
  }
  if (isContrarregraError(error, 'E_BUSY')) return { autoRetry: true, late: false, drain: false };
  if (isContrarregraError(error) && TARGET_ERRORS.has(error.code)) return { autoRetry: action !== 'scrollTo', late: false, drain: false };
  return { autoRetry: false, late: false, drain: false };
}

function failure(error: unknown, action?: Step['do'], override: Partial<Omit<Failure, 'status' | 'error'>> = {}): Failure {
  return { status: 'failed', error, ...classifyActionError(error, action), ...override };
}

/** Falha depois de a ação ter dado certo (ou com ela em dúvida): nunca há nova tentativa automática. */
function failureAfterAction(error: unknown, late: boolean): Failure {
  return { status: 'failed', error, autoRetry: false, late, drain: false };
}

export function errorInfo(error: unknown): { code: string | null; message: string } {
  if (isContrarregraError(error)) return { code: error.code, message: error.message };
  if (error instanceof RpcProtocolError) return { code: null, message: error.message };
  return { code: null, message: error instanceof Error ? error.message : String(error) };
}

// ── Descrição curta de passos (saída para o dono) ─────────────────────────────────────────────────

function describeTarget(target: PointOrTarget | undefined): string {
  if (target === undefined) return '(foco)';
  const t = target as Target & { x?: number; y?: number; nx?: number; ny?: number };
  if (t.x !== undefined && t.y !== undefined) return `(${t.x},${t.y})`;
  if (t.nx !== undefined && t.ny !== undefined) return `(${t.nx}n,${t.ny}n)`;
  if (t.label !== undefined) return JSON.stringify(t.label);
  if (t.labelPrefix !== undefined) return `${JSON.stringify(t.labelPrefix)}…`;
  if (t.labelContains !== undefined) return `…${JSON.stringify(t.labelContains)}…`;
  if (t.identifier !== undefined) return `#${t.identifier}`;
  if (t.ocr !== undefined) return `ocr ${JSON.stringify(t.ocr.text)}`;
  if (t.point !== undefined) return describeTarget(t.point);
  if (t.type !== undefined) return `<${t.type}>`;
  return '(alvo)';
}

export function describeStep(step: Step): string {
  switch (step.do) {
    case 'tap':
    case 'doubleTap':
    case 'longPress':
    case 'scrollTo':
      return `${step.do} ${describeTarget(step.target)}`;
    case 'type':
      return `type ${describeTarget(step.target)} ${JSON.stringify(step.text)}`;
    case 'drag':
      return `drag ${describeTarget(step.from)} → ${describeTarget(step.to)}`;
    case 'controlCenter':
    case 'app':
      return `${step.do} ${step.action}`;
    case 'openURL':
      return `openURL ${step.url}`;
    case 'press':
      return `press ${step.button}`;
    case 'wait':
      return `wait ${step.ms} ms`;
    case 'checkpoint':
      return `checkpoint ${step.id} (${step.who})`;
    case 'mark':
      return `mark ${JSON.stringify(step.label)}`;
    default:
      return step.do;
  }
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

// ── Executor ──────────────────────────────────────────────────────────────────────────────────────

interface SceneState {
  scene: Scene;
  record: SceneRecord;
  startMs: number;
  padBeforeMs: number;
  minDurationMs: number;
}

interface Scope {
  section: TakeSection;
  scene: SceneState | null;
  /** Fim do passo anterior (ms), compartilhado com os passos aninhados. */
  timing: { prevEndMs: number };
  /** Índice do passo pai (`"4"`) nos aninhados; `''` no primeiro nível. */
  prefix: string;
  /** Passos da lista de primeiro nível (para `[s02 3/7]`). */
  total: number;
  /** Primeiro índice da lista (o `--from` no meio de uma cena). */
  offset: number;
}

export class TakeExecutor {
  readonly #doc: Choreography;
  readonly #record: TakeRecord;
  readonly #runner: TakeRunner;
  readonly #clock: TakeClock;
  readonly #say: (text: string) => void;
  readonly #log: (line: string) => void;
  readonly #control: TakeControl;
  readonly #persist: () => void;
  readonly #voice: VoicePlan | null;
  readonly #pads: { padBeforeMs: number; padAfterMs: number };
  readonly #controlHint: string;
  #recorder: TakeRecorder | null = null;
  #aborted: TakeAborted | undefined;
  #rejectAbort!: (error: TakeAborted) => void;
  readonly #abortPromise: Promise<never>;
  readonly #warnedCues = new Set<string>();
  /** O que se sabe do modo avião (para avisar se a tomada parar com ele possivelmente ligado). */
  #airplane: 'off' | 'on' | 'maybe-on' = 'off';

  constructor(options: ExecutorOptions) {
    this.#doc = options.doc;
    this.#record = options.record;
    this.#runner = options.runner;
    this.#clock = options.clock;
    this.#say = options.say;
    this.#log = options.log;
    this.#control = options.control;
    this.#persist = options.persist;
    this.#voice = options.voice ?? null;
    this.#pads = options.pads;
    this.#controlHint = options.controlHint;
    this.#abortPromise = new Promise<never>((_resolve, reject) => {
      this.#rejectAbort = reject;
    });
    this.#abortPromise.catch(() => {});
  }

  /** Liga o OBS (o começo da gravação) ou desliga (`null`). */
  setRecorder(recorder: TakeRecorder | null): void {
    this.#recorder = recorder;
  }

  get aborted(): TakeAborted | undefined {
    return this.#aborted;
  }

  /**
   * O modo avião pode ter ficado ligado: uma condição com `{airplane: on}` (ou `{network: offline}`) ficou
   * verdadeira, ou o interruptor `airplane-mode-button` foi tocado, sem o desligar correspondente depois
   * (`{airplane: off}`, `{network: online}` ou outro toque no interruptor).
   */
  get airplaneMaybeOn(): boolean {
    return this.#airplane !== 'off';
  }

  /** Encerra a tomada: corta esperas e chamadas em curso (a resposta atrasada é descartada). Idempotente. */
  abort(reason: string, message = `tomada encerrada (${reason})`): void {
    if (this.#aborted !== undefined) return;
    this.#aborted = new TakeAborted(reason, message);
    this.#rejectAbort(this.#aborted);
  }

  /** Espera `ms` (cortada pelo abort). */
  async sleep(ms: number): Promise<void> {
    await this.#sleepUntil(this.#clock.now() + ms);
  }

  /** `prepare` ou `cleanup` (fora do vídeo). */
  async runSection(section: 'prepare' | 'cleanup', steps: readonly Step[]): Promise<void> {
    if (steps.length === 0) return;
    this.#log(`[${section}] ${steps.length} passo(s)`);
    const scope: Scope = { section, scene: null, timing: { prevEndMs: this.#clock.now() }, prefix: '', total: steps.length, offset: 0 };
    await this.#runSteps(steps, scope);
  }

  /** As cenas do plano, em ordem (S4 item 3 simplificado). */
  async runScenes(plan: readonly ScenePlan[]): Promise<void> {
    for (const item of plan) {
      this.#throwIfAborted();
      await this.#runScene(item);
    }
  }

  async #runScene(item: ScenePlan): Promise<void> {
    const { scene } = item;
    const { padBeforeMs, padAfterMs, narrationMs: narration, minDurationMs } = sceneTiming(scene, this.#voice, this.#pads);
    const startMs = this.#clock.now();
    const videoStartMs = await this.#videoMs();
    const record: SceneRecord = {
      id: scene.id,
      title: scene.title,
      startedAt: new Date(startMs).toISOString(),
      startMs,
      videoStartMs,
      padBeforeMs,
      padAfterMs,
      narrationMs: narration,
      minDurationMs,
    };
    this.#record.scenes.push(record);
    this.#persist();
    this.#log(`[${scene.id}] ${scene.title} (mínimo ${seconds(minDurationMs)})`);
    await this.#chapter(scene.title);
    const state: SceneState = { scene, record, startMs, padBeforeMs, minDurationMs };
    let complete = false;
    try {
      await this.#sleepUntil(startMs + padBeforeMs);
      const steps = scene.steps.slice(item.startAt, item.stopBefore ?? undefined);
      const scope: Scope = { section: 'scenes', scene: state, timing: { prevEndMs: startMs }, prefix: '', total: scene.steps.length, offset: item.startAt };
      await this.#runSteps(steps, scope);
      if (item.stopBefore === null) await this.#sleepUntil(startMs + minDurationMs);
      complete = item.stopBefore === null && item.startAt === 0;
    } finally {
      if (!complete) record.truncated = true;
      record.endMs = this.#clock.now();
      record.endedAt = new Date(record.endMs).toISOString();
      record.videoEndMs = await this.#videoMs();
      this.#persist();
    }
  }

  async #runSteps(steps: readonly Step[], scope: Scope): Promise<void> {
    for (let i = 0; i < steps.length; i++) await this.#runStep(steps[i]!, scope, scope.offset + i);
  }

  async #runStep(step: Step, scope: Scope, i: number): Promise<void> {
    this.#checkControlAbort();
    this.#throwIfAborted();
    const index = scope.prefix === '' ? String(i + 1) : `${scope.prefix}.${i + 1}`;
    let notBefore = scope.timing.prevEndMs + (step.afterMs ?? DEFAULT_AFTER_MS);
    let cueAtMs: number | undefined;
    if (step.cue !== undefined && scope.scene !== null && this.#voice !== null) {
      const offset = cueOffsetMs(this.#voice, scope.scene.scene.id, step.cue);
      if (offset === undefined) {
        const key = `${scope.scene.scene.id}/${step.cue}`;
        if (!this.#warnedCues.has(key)) {
          this.#warnedCues.add(key);
          this.#log(`  aviso: ${scope.scene.scene.id} não tem a frase ${step.cue} no --voice; cue ignorado`);
        }
      } else {
        cueAtMs = scope.scene.padBeforeMs + offset;
        notBefore = Math.max(notBefore, scope.scene.startMs + cueAtMs);
      }
    }
    await this.#sleepUntil(notBefore);

    const startMs = this.#clock.now();
    const video = this.#videoMs();
    const rec: StepRecord = {
      section: scope.section,
      sceneId: scope.scene?.scene.id ?? null,
      index,
      do: step.do,
      status: 'running',
      startedAt: new Date(startMs).toISOString(),
      startMs,
      videoMs: null,
      attempts: 0,
    };
    if (step.id !== undefined) rec.id = step.id;
    if (step.caption !== undefined) rec.caption = step.caption;
    if (step.cue !== undefined) rec.cue = step.cue;
    if (cueAtMs !== undefined) rec.cueAtMs = cueAtMs;
    this.#record.steps.push(rec);
    this.#persist();
    try {
      await this.#execute(step, scope, rec, index);
    } finally {
      if (rec.status === 'running') rec.status = 'failed';
      rec.videoMs = await video;
      rec.endMs = this.#clock.now();
      rec.durationMs = rec.endMs - startMs;
      scope.timing.prevEndMs = rec.endMs;
      this.#log(this.#stepLine(step, scope, rec));
      this.#persist();
    }
  }

  #stepLine(step: Step, scope: Scope, rec: StepRecord): string {
    const where = scope.scene?.scene.id ?? scope.section;
    const id = step.id === undefined ? '' : ` ${step.id}`;
    const extra: string[] = [];
    if (rec.waitedMs !== undefined && rec.waitedMs > 0) extra.push(`esperou ${seconds(rec.waitedMs)}`);
    if (rec.late) extra.push('atrasado');
    if (rec.attempts > 1) extra.push(`${rec.attempts} tentativas`);
    if (rec.interventions !== undefined) extra.push(rec.interventions.join(', '));
    const suffix = extra.length === 0 ? '' : ` (${extra.join('; ')})`;
    const error = rec.status === 'failed' && rec.error !== undefined ? ` — ${rec.error.code ?? 'erro'}: ${rec.error.message}` : '';
    return `[${where} ${rec.index}/${scope.total}${id}] ${describeStep(step)} ${rec.status} ${seconds(rec.durationMs ?? 0)}${suffix}${error}`;
  }

  /** Uma execução do passo com o `onFail` (S0.4, S4 item 5 simplificado). */
  async #execute(step: Step, scope: Scope, rec: StepRecord, index: string): Promise<void> {
    let autoRetried = false;
    for (;;) {
      rec.attempts += 1;
      const attempt = await this.#attempt(step, scope, rec, index);
      if (attempt.status !== 'failed') {
        rec.status = attempt.status;
        delete rec.error;
        if (attempt.status === 'ok' && isAirplaneToggle(step)) this.#airplane = this.#airplane === 'off' ? 'maybe-on' : 'off';
        return;
      }
      rec.error = errorInfo(attempt.error);
      const onFail = attempt.onFail ?? step.onFail ?? 'pause';
      if (onFail === 'continue') {
        rec.status = 'failed';
        return;
      }
      if (onFail === 'abort') {
        rec.status = 'failed';
        this.abort('step-failed', `o passo ${this.#label(scope, rec)} falhou com onFail: abort (${rec.error.message})`);
        this.#throwIfAborted();
      }
      if (!autoRetried && attempt.autoRetry && attempt.onFail === undefined) {
        autoRetried = true;
        // Um `take control abort` gravado agora vale antes de qualquer nova tentativa.
        this.#checkControlAbort();
        this.#throwIfAborted();
        this.#log(`  ${this.#label(scope, rec)}: ${rec.error.code ?? 'erro'} antes da ação — nova tentativa automática`);
        if (attempt.drain) await this.#drain();
        continue;
      }
      autoRetried = true;
      const op = await this.#pause(scope, rec);
      (rec.interventions ??= []).push(op);
      if (op === 'resume') {
        rec.status = 'ok';
        return;
      }
      if (op === 'skip') {
        rec.status = 'skipped';
        return;
      }
      if (op === 'abort') {
        rec.status = 'failed';
        this.abort('control-abort', `tomada encerrada pelo dono na pausa de ${this.#label(scope, rec)}`);
        this.#throwIfAborted();
      }
      // retry: refaz o passo
    }
  }

  #label(scope: Scope, rec: StepRecord): string {
    const where = scope.scene?.scene.id ?? scope.section;
    return rec.id === undefined ? `${where} ${rec.index}` : `${where} ${rec.index} (${rec.id})`;
  }

  async #attempt(step: Step, scope: Scope, rec: StepRecord, index: string): Promise<Attempt> {
    switch (step.do) {
      case 'wait':
        await this.#sleepUntil(this.#clock.now() + step.ms);
        return OK;
      case 'hold':
        if (scope.scene !== null) await this.#sleepUntil(scope.scene.startMs + scope.scene.minDurationMs);
        return OK;
      case 'mark':
        await this.#chapter(step.label);
        return OK;
      case 'waitFor':
        return this.#conditionStep(step.condition, step.timeoutMs ?? DEFAULT_TARGET_TIMEOUT_MS);
      case 'assert':
        return this.#conditionStep(step.condition, step.timeoutMs ?? 0);
      case 'block':
        return this.#block(step, scope, index);
      case 'checkpoint':
        return this.#checkpoint(step, scope, rec, index);
      default:
        return this.#action(step, scope, rec);
    }
  }

  async #conditionStep(condition: Condition, timeoutMs: number): Promise<Attempt> {
    try {
      if (await this.#waitCondition(condition, timeoutMs)) return OK;
    } catch (error) {
      if (error instanceof TakeAborted) throw error;
      return failure(error);
    }
    return failureAfterAction(new ContrarregraError('E_TIMEOUT', `a condição não ficou verdadeira em ${timeoutMs} ms`, { timeoutMs }), false);
  }

  async #block(step: Extract<Step, { do: 'block' }>, scope: Scope, index: string): Promise<Attempt> {
    if (step.when !== undefined) {
      let holds: boolean;
      try {
        holds = await this.#waitCondition(step.when, 0);
      } catch (error) {
        if (error instanceof TakeAborted) throw error;
        return failure(error);
      }
      if (!holds) return SKIPPED;
    }
    await this.#runSteps(step.steps, { ...scope, prefix: index, offset: 0 });
    return OK;
  }

  /** Ponto de controle (S5 itens 1–3). */
  async #checkpoint(step: Extract<Step, { do: 'checkpoint' }>, scope: Scope, rec: StepRecord, index: string): Promise<Attempt> {
    if (step.who === 'runner' && step.steps !== undefined) await this.#runSteps(step.steps, { ...scope, prefix: index, offset: 0 });
    const waitStart = this.#clock.now();
    let alerts = 0;
    const done = (): Attempt => {
      rec.waitedMs = this.#clock.now() - waitStart;
      if (alerts > 0) rec.alerts = alerts;
      return OK;
    };
    try {
      if (await this.#waitCondition(step.until, 0)) {
        rec.waitedMs = 0;
        return OK;
      }
    } catch (error) {
      if (error instanceof TakeAborted) throw error;
      this.#log(`  ${step.id}: até agora sem leitura (${errorInfo(error).code ?? 'erro'}); sigo sondando`);
    }
    const deadline = waitStart + step.timeoutMs;
    let nextAlert = this.#clock.now();
    let quietUntil = 0;
    for (;;) {
      this.#checkControlAbort();
      this.#throwIfAborted();
      const now = this.#clock.now();
      if (step.who === 'human' && now >= nextAlert && now < deadline) {
        alerts += 1;
        this.#say(step.ask);
        this.#log(`  aviso ${alerts} (${step.id}): ${step.ask}`);
        nextAlert = now + ALERT_REPEAT_MS;
      }
      const left = deadline - now;
      if (left <= 0) break;
      const slice = Math.min(CHECKPOINT_SLICE_MS, left, step.who === 'human' ? Math.max(1, nextAlert - now) : CHECKPOINT_SLICE_MS);
      try {
        if (await this.#waitCondition(step.until, slice)) return done();
      } catch (error) {
        if (error instanceof TakeAborted) throw error;
        if (now >= quietUntil) this.#log(`  ${step.id}: leitura falhou (${errorInfo(error).message}); sigo sondando`);
        quietUntil = now + 10_000;
        await this.#sleepUntil(Math.min(deadline, this.#clock.now() + 1_000));
      }
    }
    rec.waitedMs = this.#clock.now() - waitStart;
    if (alerts > 0) rec.alerts = alerts;
    return { ...failureAfterAction(new ContrarregraError('E_TIMEOUT', `ponto de controle ${step.id}: until não ficou verdadeira em ${step.timeoutMs} ms`, { checkpoint: step.id }), false), onFail: step.onTimeout };
  }

  /** Uma ação no aparelho (S0.4: espera do alvo, `expect`, `optional`). */
  async #action(step: Step, scope: Scope, rec: StepRecord): Promise<Attempt> {
    const forbidden = forbiddenAction(step, scope.section);
    if (forbidden !== undefined) return failure(forbidden, step.do);
    const call = actionCall(step, this.#doc.app.bundleId);
    if (call === null) return failure(new ContrarregraError('E_CHOREO_INVALID', `do: ${step.do} fora do subconjunto da tomada`, { do: step.do }), step.do);
    const rpcMs = Math.max(RUNNER_COMMAND_MS, step.timeoutMs ?? DEFAULT_TARGET_TIMEOUT_MS) + RPC_SLACK_MS;
    let error = await this.#tryCall(call, rpcMs);
    const target = waitTargetOf(step);
    if (error !== undefined && isContrarregraError(error.value, 'E_TARGET_NOT_FOUND') && target !== undefined) {
      // Espera do alvo (S0.4) e uma nova tentativa: o alvo não resolveu, nada foi feito no aparelho.
      let appeared: boolean;
      try {
        appeared = await this.#waitCondition({ element: target, state: 'exists' }, step.timeoutMs ?? DEFAULT_TARGET_TIMEOUT_MS);
      } catch (waitError) {
        if (waitError instanceof TakeAborted) throw waitError;
        return failure(waitError, step.do);
      }
      if (!appeared) return step.optional === true ? SKIPPED : failure(error.value, step.do);
      this.#checkControlAbort();
      this.#throwIfAborted();
      error = await this.#tryCall(call, rpcMs);
    }
    let late = false;
    if (error !== undefined) {
      // `optional`: o alvo não está lá (no `scrollTo`, nem depois dos arrastos) → o passo não se aplica.
      if (step.optional === true && isContrarregraError(error.value) && (error.value.code === 'E_TARGET_NOT_FOUND' || (step.do === 'scrollTo' && error.value.code === 'E_TARGET_NOT_HITTABLE'))) {
        return SKIPPED;
      }
      const f = failure(error.value, step.do);
      if (!f.late) return f;
      late = true;
      rec.late = true;
      this.#log(`  ${this.#label(scope, rec)}: o runner não confirmou a ação a tempo; ela ainda pode acontecer — confirmando sem repetir`);
    }
    if (step.expect !== undefined) {
      // Daqui em diante a ação já foi feita (ou pode estar sendo): nenhuma falha tem nova tentativa automática.
      const timeoutMs = late ? Math.max(step.expectTimeoutMs ?? DEFAULT_EXPECT_TIMEOUT_MS, LATE_EXPECT_TIMEOUT_MS) : (step.expectTimeoutMs ?? DEFAULT_EXPECT_TIMEOUT_MS);
      let holds: boolean;
      try {
        holds = await this.#waitCondition(step.expect, timeoutMs);
      } catch (expectError) {
        if (expectError instanceof TakeAborted) throw expectError;
        return failureAfterAction(expectError, late);
      }
      if (holds) return OK;
      return failureAfterAction(new ContrarregraError('E_TIMEOUT', `expect não ficou verdadeiro em ${timeoutMs} ms`, { expect: true, timeoutMs }), late);
    }
    if (late) {
      if (await this.#drain()) return OK;
      return failureAfterAction(new ContrarregraError('E_TIMEOUT', `a fila do runner não esvaziou em ${DRAIN_MAX_MS / 1000} s depois da ação`, { drain: true }), true);
    }
    return OK;
  }

  // ── Pausa ───────────────────────────────────────────────────────────────────────────────────────

  async #pause(scope: Scope, rec: StepRecord): Promise<ControlOp> {
    const label = this.#label(scope, rec);
    // Um `take control abort` gravado antes da pausa não se perde: só o resto (comando velho) é apagado.
    if (this.#control.read() === 'abort') {
      this.#control.clear();
      this.abort('control-abort', `tomada encerrada pelo dono (take control abort) em ${label}`);
      this.#throwIfAborted();
    }
    this.#control.clear();
    this.#record.pause = { at: new Date(this.#clock.now()).toISOString(), step: label, stepId: rec.id ?? null, reason: rec.error?.message ?? 'falha' };
    this.#persist();
    this.#say(`Tomada pausada no passo ${rec.id ?? rec.index}. Responda com take control.`);
    this.#log(`  PAUSADO em ${label}: ${rec.error?.message ?? 'falha'}`);
    this.#log(`  responda: ${this.#controlHint} resume|retry|skip|abort (prazo ${PAUSE_MAX_MS / 60_000} min; depois aborta)`);
    const deadline = this.#clock.now() + PAUSE_MAX_MS;
    try {
      for (;;) {
        this.#throwIfAborted();
        const op = this.#control.read();
        if (op !== undefined) {
          this.#control.clear();
          this.#log(`  take control: ${op}`);
          return op;
        }
        if (this.#clock.now() >= deadline) {
          this.abort('pause-timeout', `ninguém respondeu à pausa de ${label} em ${PAUSE_MAX_MS / 60_000} min`);
          this.#throwIfAborted();
        }
        await this.#clock.sleep(CONTROL_POLL_MS);
      }
    } finally {
      this.#record.pause = null;
      this.#persist();
    }
  }

  // ── Runner, OBS e esperas ───────────────────────────────────────────────────────────────────────

  /** A ação; o erro (fora o abort) volta embrulhado, `undefined` = deu certo. */
  async #tryCall(call: RunnerCall, timeoutMs: number): Promise<{ value: unknown } | undefined> {
    try {
      await this.#call(call.method, call.params, timeoutMs);
      return undefined;
    } catch (error) {
      if (error instanceof TakeAborted) throw error;
      return { value: error };
    }
  }

  async #call<T = unknown>(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<T> {
    this.#throwIfAborted();
    return Promise.race([this.#runner.call<T>(method, params, { timeoutMs }), this.#abortPromise]);
  }

  /** `wait.for`: `true` se a condição ficou verdadeira no prazo; `E_TIMEOUT` (qualquer fase) = `false`. */
  async #waitCondition(condition: Condition, timeoutMs: number): Promise<boolean> {
    for (let attempt = 0; ; attempt++) {
      try {
        await this.#call('wait.for', { condition, timeoutMs: attempt === 0 ? timeoutMs : 0 }, timeoutMs + WAIT_FOR_LANE_EXTRA_MS + RPC_SLACK_MS);
        this.#observeAirplane(condition);
        return true;
      } catch (error) {
        if (!isContrarregraError(error, 'E_TIMEOUT')) throw error;
        // `phase` = o prazo do runner estourou com a leitura ainda na fila ou rodando (aparelho lento: a avaliação
        // única de `when`/`assert` ganha ~1 s): não é "falso". Espera a fila esvaziar e avalia de novo (é só leitura;
        // ensaio de 2026-10-16). Sem `phase`, a condição foi lida e não ficou verdadeira.
        const phase = error.data?.['phase'];
        if ((phase === 'running' || phase === 'queued') && attempt < SLOW_READ_RETRIES) {
          await this.#drain();
          continue;
        }
        return false;
      }
    }
  }

  /** Uma condição que ficou verdadeira diz algo do modo avião (só as folhas certas: fora de `any`/`not`). */
  #observeAirplane(condition: Condition): void {
    if ('airplane' in condition) this.#airplane = condition.airplane;
    else if ('network' in condition) {
      if (condition.network === 'offline' && this.#airplane === 'off') this.#airplane = 'maybe-on';
      if (condition.network === 'online' && this.#airplane === 'maybe-on') this.#airplane = 'off';
    } else if ('all' in condition) for (const c of condition.all) this.#observeAirplane(c);
  }

  /** Espera a fila do XCTest esvaziar (um comando que estourou o prazo continua rodando no aparelho; SP-2, SP-17). */
  async #drain(): Promise<boolean> {
    const deadline = this.#clock.now() + DRAIN_MAX_MS;
    for (;;) {
      try {
        const health = await this.#call<{ xctestQueueDepth?: unknown }>('health', {}, 5_000);
        if (health?.xctestQueueDepth === 0) return true;
      } catch (error) {
        if (error instanceof TakeAborted) throw error;
      }
      if (this.#clock.now() >= deadline) return false;
      await this.#sleepUntil(this.#clock.now() + DRAIN_POLL_MS);
    }
  }

  async #videoMs(): Promise<number | null> {
    if (this.#recorder === null) return null;
    try {
      return await this.#recorder.outputMs();
    } catch {
      return null;
    }
  }

  async #chapter(name: string): Promise<void> {
    if (this.#recorder === null) return;
    try {
      await this.#recorder.chapter(name);
    } catch (error) {
      const message = `capítulo "${name}" recusado pelo OBS (${errorInfo(error).message}); sigo (E-9.4)`;
      this.#record.warnings.push(message);
      this.#log(`  aviso: ${message}`);
    }
  }

  async #sleepUntil(t: number): Promise<void> {
    for (;;) {
      this.#throwIfAborted();
      this.#checkControlAbort();
      const left = t - this.#clock.now();
      if (left <= 0) return;
      await this.#clock.sleep(Math.min(left, SLEEP_SLICE_MS));
    }
  }

  /** `take control <dir> abort` vale a qualquer hora, não só na pausa. */
  #checkControlAbort(): void {
    if (this.#aborted !== undefined || this.#control.read() !== 'abort') return;
    this.#control.clear();
    this.abort('control-abort', 'tomada encerrada pelo dono (take control abort)');
  }

  #throwIfAborted(): void {
    if (this.#aborted !== undefined) throw this.#aborted;
  }
}
