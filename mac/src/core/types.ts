// Tipos de S0 (spec.md): o espelho TypeScript dos formatos. O Swift (`ContrarregraKit`) espelha os
// mesmos; nenhum dos dois inventa campo fora de S0. Os esquemas zod que conferem estes tipos em tempo
// de execução estão em `schema.ts`. `core` não importa nenhum outro módulo (architecture.md A2).

export type { Config } from './config.ts';

// ── Valores JSON e escalares ──────────────────────────────────────────────────────────────────────

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

/** Inteiro de 64 bits em string decimal: todo tempo D e M em ns (S0.7; campos terminados em `Ns`). */
export type Int64String = string;

/** Nomes e versões dos documentos (S0: `schema` = `contrarregra.<tipo>/<n>`; architecture.md A4). */
export const SCHEMA_IDS = {
  choreography: 'contrarregra.choreography/1',
  events: 'contrarregra.events/1',
  take: 'contrarregra.take/1',
  preflight: 'contrarregra.preflight/1',
  sync: 'contrarregra.sync/1',
  status: 'contrarregra.status/1',
  voice: 'contrarregra.voice/1',
} as const;

// ── S0.2 Ponto e alvo ─────────────────────────────────────────────────────────────────────────────

/** `{x, y}` em pontos da tela, ou `{nx, ny}` normalizado (0–1). */
export type Point = AbsolutePoint | NormalizedPoint;
export interface AbsolutePoint {
  x: number;
  y: number;
}
export interface NormalizedPoint {
  nx: number;
  ny: number;
}

/** Retângulo em pontos (mesma forma do `frame` de S0.6). */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Size {
  w: number;
  h: number;
}

export interface Offset {
  dx: number;
  dy: number;
}

/** `XCUIElement.ElementType` com o nome do caso em Swift (minúsculas iniciais), na ordem do `rawValue`. */
export const ELEMENT_TYPES = [
  'any', 'other', 'application', 'group', 'window', 'sheet', 'drawer', 'alert', 'dialog', 'button',
  'radioButton', 'radioGroup', 'checkBox', 'disclosureTriangle', 'popUpButton', 'comboBox', 'menuButton',
  'toolbarButton', 'popover', 'keyboard', 'key', 'navigationBar', 'tabBar', 'tabGroup', 'toolbar',
  'statusBar', 'table', 'tableRow', 'tableColumn', 'outline', 'outlineRow', 'browser', 'collectionView',
  'slider', 'pageIndicator', 'progressIndicator', 'activityIndicator', 'segmentedControl', 'picker',
  'pickerWheel', 'switch', 'toggle', 'link', 'image', 'icon', 'searchField', 'scrollView', 'scrollBar',
  'staticText', 'textField', 'secureTextField', 'datePicker', 'textView', 'menu', 'menuItem', 'menuBar',
  'menuBarItem', 'map', 'webView', 'incrementArrow', 'decrementArrow', 'timeline', 'ratingIndicator',
  'valueIndicator', 'splitGroup', 'splitter', 'relevanceIndicator', 'colorWell', 'helpTag', 'matte',
  'dockItem', 'ruler', 'rulerMarker', 'grid', 'levelIndicator', 'cell', 'layoutArea', 'layoutItem',
  'handle', 'stepper', 'tab', 'touchBar', 'statusItem',
] as const;
export type ElementType = (typeof ELEMENT_TYPES)[number];

/** Seletores primários de um alvo: exatamente um por alvo (`type` sozinho só sem primário). */
export const PRIMARY_SELECTORS = ['ref', 'label', 'labelPrefix', 'labelContains', 'identifier', 'ocr', 'point'] as const;

/** `ocr` de um alvo (e de `{text: {ocr}}` em S0.3): texto visível achado pelo Vision. */
export interface OcrSelector {
  text: string;
  within?: Target;
  region?: Rect;
  occurrence?: number;
}

export interface Target {
  ref?: string;
  app?: string;
  label?: string;
  labelPrefix?: string;
  labelContains?: string;
  identifier?: string;
  type?: ElementType;
  within?: Target;
  below?: Target;
  above?: Target;
  index?: number;
  ocr?: OcrSelector;
  point?: Point;
  offset?: Offset;
  fallback?: Target[];
}

// ── S0.3 Condição ─────────────────────────────────────────────────────────────────────────────────

export const ELEMENT_STATES = ['exists', 'gone', 'hittable', 'selected', 'value', 'changed'] as const;
export type ElementState = (typeof ELEMENT_STATES)[number];

export type Condition =
  | { element: Target; state: ElementState; equals?: string }
  | { text: { ocr: OcrSelector; state: 'visible' | 'gone' } }
  | { appState: { app: string; state: 'foreground' | 'background' | 'notRunning' } }
  | { locked: boolean }
  | { airplane: 'on' | 'off' }
  | { network: 'online' | 'offline' }
  | { all: Condition[] }
  | { any: Condition[] }
  | { not: Condition };

// ── S0.4 Coreografia (passos) ─────────────────────────────────────────────────────────────────────

export const STEP_ACTIONS = [
  'tap', 'doubleTap', 'longPress', 'drag', 'scrollTo', 'type', 'press', 'lock', 'wake', 'home',
  'controlCenter', 'app', 'openURL', 'wait', 'waitFor', 'assert', 'checkpoint', 'block', 'mark', 'hold',
] as const;
export type StepAction = (typeof STEP_ACTIONS)[number];

/** Campos comuns a todo passo (`do` e os argumentos da ação ficam no mesmo objeto). */
export interface StepCommon {
  id?: string;
  target?: Target;
  cue?: number;
  afterMs?: number;
  timeoutMs?: number;
  expect?: Condition;
  expectTimeoutMs?: number;
  repeat?: { until: Condition; max: number };
  onFail?: 'pause' | 'abort' | 'continue';
  optional?: boolean;
  caption?: string;
  visual?: boolean;
  sim?: 'run' | 'skip' | 'simulate';
}

/** `from`/`to`/`via` de um `drag`: `Point` ou `Target`. */
export type PointOrTarget = Point | Target;

export interface TapStep extends StepCommon { do: 'tap'; target: Target }
export interface DoubleTapStep extends StepCommon { do: 'doubleTap'; target: Target }
export interface LongPressStep extends StepCommon { do: 'longPress'; target: Target; durationMs: number }
export interface DragStep extends StepCommon {
  do: 'drag';
  from: PointOrTarget;
  to: PointOrTarget;
  via?: PointOrTarget[];
  pressMs?: number;
  velocity?: number;
  durationMs?: number;
  holdMs?: number;
}
export interface ScrollToStep extends StepCommon {
  do: 'scrollTo';
  target: Target;
  within?: Target;
  direction: 'down' | 'up';
  maxSwipes: number;
}
export interface TypeStep extends StepCommon { do: 'type'; text: string }
export interface PressStep extends StepCommon { do: 'press'; button: 'home' | 'volumeUp' | 'volumeDown' }
export interface LockStep extends StepCommon { do: 'lock' }
export interface WakeStep extends StepCommon { do: 'wake' }
export interface HomeStep extends StepCommon { do: 'home' }
/** `controlCenter {open|close}`: a spec não nomeia o campo; `action`, como em `app {action}`. */
export interface ControlCenterStep extends StepCommon { do: 'controlCenter'; action: 'open' | 'close' }
export interface AppStep extends StepCommon { do: 'app'; action: 'activate' | 'terminate' | 'launch' }
export interface OpenUrlStep extends StepCommon { do: 'openURL'; url: string }
export interface WaitStep extends StepCommon { do: 'wait'; ms: number }
export interface WaitForStep extends StepCommon { do: 'waitFor'; condition: Condition }
export interface AssertStep extends StepCommon { do: 'assert'; condition: Condition }
/** Ponto de controle (S5 item 1). */
export interface CheckpointStep extends StepCommon {
  do: 'checkpoint';
  id: string;
  who: 'human' | 'runner';
  ask: string;
  until: Condition;
  timeoutMs: number;
  onTimeout: 'pause' | 'abort';
  steps?: Step[];
  alert?: { sound: JsonValue; say: JsonValue };
}
export interface BlockStep extends StepCommon { do: 'block'; when?: Condition; steps: Step[] }
export interface MarkStep extends StepCommon { do: 'mark'; label: string }
export interface HoldStep extends StepCommon { do: 'hold' }

export type Step =
  | TapStep
  | DoubleTapStep
  | LongPressStep
  | DragStep
  | ScrollToStep
  | TypeStep
  | PressStep
  | LockStep
  | WakeStep
  | HomeStep
  | ControlCenterStep
  | AppStep
  | OpenUrlStep
  | WaitStep
  | WaitForStep
  | AssertStep
  | CheckpointStep
  | BlockStep
  | MarkStep
  | HoldStep;

// ── S0.4 Coreografia (documento) ──────────────────────────────────────────────────────────────────

export interface Scene {
  id: string;
  title: string;
  line?: string[];
  hold?: { padBeforeMs?: number; padAfterMs?: number };
  steps: Step[];
}

export interface Choreography {
  schema: typeof SCHEMA_IDS.choreography;
  app: { bundleId: string; iconLabel: string; expectVersion: string; urlPrefixes: string[] };
  device: { language: string; screenPt: Size; textSize: string; appearance: 'light' | 'dark' };
  guide?: { voice: string; targetWpm: number };
  confirm?: string[];
  targets: Record<string, Target>;
  prepare: Step[];
  scenes: Scene[];
  cleanup: Step[];
}

export interface CompiledScene {
  id: string;
  sentences: { text: string; startMs: number; durMs: number }[];
  holdMs: number;
}

export interface CompiledInfo {
  /** SHA-256 (hex minúsculo) do JCS do documento compilado sem `compiled.sha256` e `compiled.compiledAt`. */
  sha256: string;
  compiledAt: string;
  guide: { voice: string; wpm: number; factor: number };
  scenes: CompiledScene[];
}

/** A fonte validada + `compiled`, com todos os `ref` expandidos e os padrões preenchidos. */
export interface CompiledChoreography extends Choreography {
  compiled: CompiledInfo;
}

// ── S0.5 Protocolo Mac ↔ runner (JSON-RPC 2.0) ────────────────────────────────────────────────────

export type RpcId = string | number;

export interface RpcRequest<P = JsonObject> {
  jsonrpc: '2.0';
  id: RpcId;
  method: string;
  params?: P;
}

export interface RpcNotification<P = JsonObject> {
  jsonrpc: '2.0';
  method: string;
  params?: P;
}

export interface RpcSuccess<R = JsonValue> {
  jsonrpc: '2.0';
  id: RpcId;
  result: R;
}

export interface RpcErrorObject {
  code: number;
  message: string;
  data?: JsonValue;
}

export interface RpcFailure {
  jsonrpc: '2.0';
  id: RpcId | null;
  error: RpcErrorObject;
}

export type RpcMessage = RpcRequest | RpcNotification | RpcSuccess | RpcFailure;

export type EmptyParams = Record<string, never>;

export interface SessionHelloParams {
  token: string;
  role: 'control' | 'sync';
  client: JsonValue;
}

export interface DeviceInfo {
  model: string;
  os: string;
  screenPt: Size;
  scale: number;
  language: string;
  textSize: string;
  appearance: 'light' | 'dark';
}

export interface SessionHelloResult {
  runnerVersion: string;
  capabilities: JsonValue;
  device: DeviceInfo;
  clock: { nowRawNs: Int64String; nowUptimeNs: Int64String };
}

export interface HealthResult {
  ok: boolean;
  uptimeS: number;
  xctestQueueDepth: number;
  treeVersion: number;
  foregroundApp: string;
  locked: boolean;
}

export interface ClockPingParams {
  seq: number;
  pad?: string;
}

export interface ClockPingResult {
  seq: number;
  t2RawNs: Int64String;
  t3RawNs: Int64String;
  t2UptimeNs: Int64String;
  pad?: string;
}

export interface EventsFetchParams {
  takeId: string;
  sinceSeq: number;
}

export interface EventsFetchResult {
  events: Event[];
  lastSeq: number;
}

export const PRIVATE_API_IDS = ['PX-1', 'PX-2', 'PX-3', 'PX-4', 'PX-5', 'PX-6'] as const;
export type PrivateApiId = (typeof PRIVATE_API_IDS)[number];
export type RunnerCapabilities = Record<PrivateApiId, { present: boolean; allowed: boolean }>;

/** Resposta das ações `ui.*`. */
export interface UiActionResult {
  point: AbsolutePoint;
  nodeRef?: string;
  tDevStartNs: Int64String;
  tDispatchNs: Int64String;
  tDevEndNs: Int64String;
  path: 'private' | 'public';
}

// ── S0.6 Nó da árvore ─────────────────────────────────────────────────────────────────────────────

export interface TreeNode {
  ref: string;
  type: ElementType;
  label?: string;
  identifier?: string;
  value?: string;
  frame: Rect;
  enabled: boolean;
  selected: boolean;
  visible: boolean;
  depth: number;
  children?: TreeNode[];
}

// ── S0.7 Evento e events.json ─────────────────────────────────────────────────────────────────────

export const EVENT_KINDS = [
  'take.start', 'preroll.marker', 'scene.start', 'step.start', 'step.end', 'step.fail', 'checkpoint.wait',
  'checkpoint.alert', 'checkpoint.resolved', 'checkpoint.timeout', 'scene.hold', 'scene.end', 'device.state',
  'runner.reconnect', 'sync.burst', 'obs.state', 'obs.chapter', 'intervention', 'take.pause', 'take.resume',
  'take.end', 'take.abort',
] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

/**
 * Uma linha de `events.ndjson`. Os campos de S0.7 (e os de `checkpoint.*`, S5) são tipados; os campos
 * próprios de cada `kind` descritos noutras seções passam como JSON (o esquema é aberto a eles), mas
 * todo campo terminado em `Ns` é tempo D/M em string de inteiro.
 */
export interface Event {
  seq: number;
  kind: EventKind;
  sceneId?: string;
  stepId?: string;
  action?: string;
  target?: Target;
  caption?: string;
  tDevStartNs?: Int64String;
  tDispatchNs?: Int64String;
  tDevEndNs?: Int64String;
  tDevUptimeNs?: Int64String;
  tMacNs?: Int64String;
  tPredRawS?: number;
  tRecS?: number;
  tFinalS?: number;
  /** `null` = nenhuma mudança detectada no quadro: o evento fica marcado e fora do ajuste (S7 item 4, AC-7.6). */
  tVideoObservedS?: number | null;
  detectScore?: number;
  status?: string;
  lateMs?: number;
  path?: 'private' | 'public';
  detail?: JsonObject;
  overrunMs?: number;
  id?: string;
  who?: 'human' | 'runner';
  ask?: string;
  timeoutMs?: number;
  waitedMs?: number;
  at?: string;
  [field: string]: unknown;
}

export interface EventsScene {
  id: string;
  title: string;
  startF: number;
  endF: number;
  guideS: number;
  holdS: number;
  checkpointsS: number;
  overrunMs: number;
}

export interface EventsJson {
  schema: typeof SCHEMA_IDS.events;
  take: TakeManifest;
  clock: SyncReport;
  trim: { startR: number; endR: number; leadInS: number };
  scenes: EventsScene[];
  checkpoints: JsonObject[];
  events: Event[];
}

// ── S0.8 Tomada ───────────────────────────────────────────────────────────────────────────────────

export interface TakeManifest {
  schema: typeof SCHEMA_IDS.take;
  takeId: string;
  mode: 'take' | 'rehearsal' | 'dry';
  status: 'preparing' | 'recording' | 'finished' | 'aborted' | 'failed';
  scenesStartedAt?: string;
  scenesResult?: 'finished' | 'aborted';
  cause?: string;
  choreography: { path: string; sha256: string };
  app: { bundleId: string; version: string };
  device: { udid: string; os: string; transport: string };
  toolchain: JsonObject;
  startedAt: string;
  endedAt: string;
  interventions: JsonValue;
  syncOk: boolean;
  cleanupPending: boolean;
  obsStats: { renderSkipped: number; outputSkipped: number };
  airplaneLeftOn: boolean;
}

/** `status.json`: estado vivo; S0.8 só fixa o `schema` (o resto é `…`). */
export interface StatusFile {
  schema: typeof SCHEMA_IDS.status;
  [field: string]: unknown;
}

export interface VoiceFile {
  schema: typeof SCHEMA_IDS.voice;
  offsetMs: number;
  calibrationMs: number;
}

// ── S0.9 Relatórios ───────────────────────────────────────────────────────────────────────────────

export interface PreflightCheck {
  id: string;
  title: string;
  status: 'pass' | 'fail' | 'warn' | 'human';
  detail: JsonValue;
  fix?: JsonValue;
}

export interface PreflightReport {
  schema: typeof SCHEMA_IDS.preflight;
  at: string;
  checks: PreflightCheck[];
  ok: boolean;
}

export interface SyncReport {
  schema: typeof SCHEMA_IDS.sync;
  deviceToMac: { aNs: Int64String; bPpm: number; residualMs: number; samples: number; bursts: number };
  macToRecording: { t0MacNs: Int64String; t0StdErrMs: number; fps: number; markers: number; maxMarkerDevMs: number };
  captureLatency: { alphaMs: number; beta: number; method: string; eventsUsed: number };
  /** `null` com menos de 10 passos visuais detectados: não avaliado, e então `ok: false` (S7 item 6). */
  error: { method: 'leave-one-out'; medianMs: number; maxMs: number; rawMedianMs: number; rawMaxMs: number } | null;
  ok: boolean;
}
