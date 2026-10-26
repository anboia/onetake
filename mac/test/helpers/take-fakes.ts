// Falsos da tomada (trilha do demo, M3): relógio que avança na hora, runner que implementa `call`, OBS em
// memória com a mesma forma do `ObsClient` (inclusive a guarda do perfil antes de cada escrita), `control.json`
// em memória e uma configuração com pastas temporárias. Nada aqui fala com o iPhone, o runner ou o OBS reais.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';

import { loadConfig, type Config } from '../../src/core/config.ts';
import { ContrarregraError, type ErrorCode } from '../../src/core/errors.ts';
import type { Choreography } from '../../src/core/types.ts';
import { ObsRequestError, type ObsCloseInfo, type ObsEvent, type ObsResponse } from '../../src/obs/ws.ts';
import type { ControlOp } from '../../src/take/control.ts';
import type { TakeClock, TakeControl } from '../../src/take/executor.ts';
import { TAKE_RECORD_SCHEMA, type TakeRecord } from '../../src/take/manifest.ts';
import type { TakeObs } from '../../src/take/obs.ts';
import type { TakeRunnerHandle } from '../../src/take/run.ts';

// ── Relógio ───────────────────────────────────────────────────────────────────────────────────────

/** Relógio falso: `sleep` avança o tempo na hora (e cede a vez ao laço de eventos). */
export class FakeClock implements TakeClock {
  t: number;
  constructor(start = Date.UTC(2026, 9, 16, 15, 0, 0)) {
    this.t = start;
  }
  now(): number {
    return this.t;
  }
  async sleep(ms: number): Promise<void> {
    this.t += Math.max(0, ms);
    await new Promise((resolve) => setImmediate(resolve));
  }
  advance(ms: number): void {
    this.t += ms;
  }
}

// ── Runner ────────────────────────────────────────────────────────────────────────────────────────

export interface RunnerCallRecord {
  method: string;
  params: Record<string, unknown>;
  timeoutMs: number;
  at: number;
}

export type RunnerHandler = (params: Record<string, unknown>, call: RunnerCallRecord) => unknown;

export function rpcError(code: ErrorCode, data?: Record<string, unknown>): ContrarregraError {
  return new ContrarregraError(code, `${code} (falso)`, data);
}

export const ACTION_RESULT = { point: { x: 1, y: 2 }, tDevStartNs: '1', tDispatchNs: '2', tDevEndNs: '3', path: 'public' };

/** Runner falso: grava cada chamada; por método, um tratador (ou uma fila deles, um por chamada). */
export class FakeRunner implements TakeRunnerHandle {
  readonly calls: RunnerCallRecord[] = [];
  readonly handlers: Record<string, RunnerHandler | RunnerHandler[]>;
  readonly clock: FakeClock;
  readonly trace: string[] | undefined;
  closed = false;

  constructor(clock: FakeClock, handlers: Record<string, RunnerHandler | RunnerHandler[]> = {}, trace?: string[]) {
    this.clock = clock;
    this.handlers = handlers;
    this.trace = trace;
  }

  async call<T = unknown>(method: string, params: Record<string, unknown>, options: { timeoutMs: number }): Promise<T> {
    const record: RunnerCallRecord = { method, params, timeoutMs: options.timeoutMs, at: this.clock.now() };
    this.calls.push(record);
    this.trace?.push(`runner ${method}${typeof params['target'] === 'object' ? ` ${JSON.stringify((params['target'] as Record<string, unknown>)['label'] ?? '')}` : ''}`);
    await new Promise((resolve) => setImmediate(resolve));
    const entry = this.handlers[method];
    let handler: RunnerHandler | undefined;
    if (Array.isArray(entry)) handler = entry.length > 1 ? entry.shift() : entry[0];
    else handler = entry;
    if (handler !== undefined) return (await handler(params, record)) as T;
    return defaultResult(method) as T;
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  /** As chamadas de um método. */
  of(method: string): RunnerCallRecord[] {
    return this.calls.filter((c) => c.method === method);
  }

  /** Métodos chamados, em ordem (sem o `health`). */
  methods(): string[] {
    return this.calls.map((c) => c.method).filter((m) => m !== 'health');
  }
}

function defaultResult(method: string): unknown {
  if (method === 'health') return { ok: true, uptimeS: 10, xctestQueueDepth: 0, treeVersion: 1, foregroundApp: 'app.example.demo', locked: false };
  if (method === 'wait.for') return { tDevStartNs: '1', tDevEndNs: '2' };
  if (method.startsWith('ui.')) return ACTION_RESULT;
  return { tDevStartNs: '1', tDispatchNs: '2', tDevEndNs: '3', path: 'public' };
}

/** `wait.for` falso que não fica verdadeiro: o relógio anda o prazo inteiro e vem `E_TIMEOUT`. */
export function waitTimesOut(clock: FakeClock): RunnerHandler {
  return (params) => {
    clock.advance(Number(params['timeoutMs'] ?? 0));
    throw new ContrarregraError('E_TIMEOUT', 'E_TIMEOUT: a condição não ficou verdadeira (falso)');
  };
}

/** `wait.for` falso que fica verdadeiro depois de `afterMs` de relógio (contado da primeira chamada). */
export function waitTrueAfter(clock: FakeClock, afterMs: number): RunnerHandler {
  let start: number | undefined;
  return (params) => {
    start ??= clock.now();
    const timeoutMs = Number(params['timeoutMs'] ?? 0);
    const left = start + afterMs - clock.now();
    if (left <= timeoutMs) {
      clock.advance(Math.max(0, left));
      return { tDevStartNs: '1', tDevEndNs: '2' };
    }
    clock.advance(timeoutMs);
    throw new ContrarregraError('E_TIMEOUT', 'E_TIMEOUT: a condição não ficou verdadeira (falso)');
  };
}

// ── control.json em memória ───────────────────────────────────────────────────────────────────────

export class FakeControl implements TakeControl {
  op: ControlOp | undefined;
  reads = 0;
  #scheduled: { clock: FakeClock; at: number; op: ControlOp } | undefined;
  /** O dono grava `op` quando o relógio falso chegar em `at`. */
  schedule(clock: FakeClock, at: number, op: ControlOp): void {
    this.#scheduled = { clock, at, op };
  }
  read(): ControlOp | undefined {
    this.reads += 1;
    if (this.#scheduled !== undefined && this.#scheduled.clock.now() >= this.#scheduled.at) {
      this.op = this.#scheduled.op;
      this.#scheduled = undefined;
    }
    return this.op;
  }
  clear(): void {
    this.op = undefined;
  }
}

// ── PNG e OBS ─────────────────────────────────────────────────────────────────────────────────────

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([length, body, crc]);
}

/** PNG RGB de uma cor só, em base64. */
export function solidPngBase64(width: number, height: number, rgb: [number, number, number]): string {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1);
    raw[row] = 0;
    for (let x = 0; x < width; x++) raw.set(rgb, row + 1 + x * 3);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([signature, pngChunk('IHDR', ihdr), pngChunk('IDAT', deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0))]).toString('base64');
}

const WHITE_PNG = solidPngBase64(8, 8, [240, 240, 240]);
const BLACK_PNG = solidPngBase64(8, 8, [0, 0, 0]);

export interface FakeObsOptions {
  clock: FakeClock;
  trace?: string[];
  profile?: string;
  /** Fonte: `dead` = 0×0 até um chute; `black` = 1170×2532 preta até um chute; `live` = viva. */
  source?: 'live' | 'dead' | 'black';
  /** O chute não ressuscita a fonte. */
  kickFails?: boolean;
  /** MiB livres de `GetStats`. */
  availableMiB?: number;
  alreadyRecording?: boolean;
  /** `CreateRecordChapter` responde 702 (E-9.4). */
  chapters702?: boolean;
  /** `StartRecord` falha (500) e nada é gravado. */
  startFails?: boolean;
  /** A conexão cai no primeiro `StopRecord`: antes de o OBS parar (`before`) ou depois (`after`). */
  dropStop?: 'before' | 'after';
  /** `PauseRecord` responde, mas a gravação não pausa (nem evento, nem `outputPaused`). */
  pauseIgnored?: boolean;
  /** `ResumeRecord` (o guardado) responde, mas a gravação não retoma. */
  resumeIgnored?: boolean;
  /** `StopRecord` com a gravação pausada é aceito, mas não para (sem `STOPPED`): força o `ResumeRecord` de emergência. */
  stopIgnoredWhilePaused?: boolean;
}

/** OBS em memória com a forma de `TakeObs`; as escritas passam pela guarda do perfil, como no `ObsClient`. */
export class FakeObs implements TakeObs {
  readonly options: FakeObsOptions;
  profile: string;
  recording = false;
  paused = false;
  /** Instante (relógio falso) em que a pausa atual começou, e o total pausado (fora do `outputDuration`). */
  pausedSince = 0;
  pausedTotal = 0;
  recordDirectory = '/Users/dono/Movies/OBS';
  readonly originalDirectory = '/Users/dono/Movies/OBS';
  startedAt = 0;
  readonly requests: { type: string; data: Record<string, unknown> | undefined }[] = [];
  readonly chapters: string[] = [];
  readonly kicks: Record<string, unknown>[] = [];
  readonly writesRefused: string[] = [];
  readonly listeners = new Set<(event: ObsEvent) => void>();
  live: 'live' | 'dead' | 'black';
  closed = false;
  lastFile: string | undefined;
  /** O `StopRecord` que parou a gravação a encontrou pausada. */
  stoppedWhilePaused = false;
  #dropped = false;

  constructor(options: FakeObsOptions) {
    this.options = options;
    this.profile = options.profile ?? 'Contrarregra';
    this.live = options.source ?? 'live';
    this.recording = options.alreadyRecording === true;
  }

  async assertProfile(): Promise<void> {
    this.options.trace?.push('obs assertProfile');
    if (this.profile !== 'Contrarregra') {
      throw new ContrarregraError('E_OBS_CONFIG', `o OBS está no perfil "${this.profile}" (falso); nada foi escrito`, {});
    }
  }

  emit(eventType: string, eventData: Record<string, unknown>): void {
    for (const listener of [...this.listeners]) listener({ eventType, eventIntent: 64, eventData, tRecvNs: 0n });
  }

  onEvent(listener: (event: ObsEvent) => void): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  pauseRecord(): Promise<ObsResponse<Record<string, unknown>>> {
    return this.request('PauseRecord');
  }

  resumeRecord(): Promise<ObsResponse<Record<string, unknown>>> {
    return this.request('ResumeRecord');
  }

  /** Sem a guarda do perfil (como no `ObsClient`). */
  emergencyResumeRecord(): Promise<ObsResponse<Record<string, unknown>>> {
    return this.#handle('ResumeRecord', { emergency: true });
  }

  async close(): Promise<ObsCloseInfo> {
    this.closed = true;
    return { code: 1000, reason: '' };
  }

  /** Tipos dos pedidos que escrevem, na ordem. */
  writes(): string[] {
    return this.requests.map((r) => r.type).filter((t) => !t.startsWith('Get'));
  }

  async request<T = Record<string, unknown>>(type: string, data?: Record<string, unknown>): Promise<ObsResponse<T>> {
    const write = !type.startsWith('Get') && type !== 'StopRecord' && type !== 'Sleep';
    if (write) {
      try {
        await this.assertProfile();
      } catch (error) {
        this.writesRefused.push(type);
        throw error;
      }
    }
    return this.#handle(type, data);
  }

  async #handle<T = Record<string, unknown>>(type: string, data?: Record<string, unknown>): Promise<ObsResponse<T>> {
    this.requests.push({ type, data });
    this.options.trace?.push(`obs ${type}${type === 'CreateRecordChapter' ? ` ${String(data?.['chapterName'])}` : ''}${data?.['emergency'] === true ? ' (emergência)' : ''}`);
    const out = (body: Record<string, unknown> = {}): ObsResponse<T> => ({ requestType: type, data: body as T, tSendNs: 0n, tRecvNs: 0n });
    const clock = this.options.clock;
    switch (type) {
      case 'GetRecordStatus':
        return out({
          outputActive: this.recording,
          outputPaused: this.paused,
          outputTimecode: '00:00:00.000',
          outputDuration: this.recording ? clock.now() - this.startedAt - this.pausedTotal - (this.paused ? clock.now() - this.pausedSince : 0) : 0,
          outputBytes: 0,
        });
      case 'GetRecordDirectory':
        return out({ recordDirectory: this.recordDirectory });
      case 'SetRecordDirectory':
        this.recordDirectory = String(data?.['recordDirectory']);
        return out();
      case 'StartRecord':
        if (this.recording) throw new ObsRequestError(type, 500, 'já gravando');
        if (this.options.startFails === true) throw new ObsRequestError(type, 500, 'falha ao gravar (falso)');
        this.recording = true;
        this.startedAt = clock.now();
        this.emit('RecordStateChanged', { outputActive: true, outputState: 'OBS_WEBSOCKET_OUTPUT_STARTED', outputPath: null });
        return out();
      case 'PauseRecord':
        if (!this.recording) throw new ObsRequestError(type, 501, 'sem gravação');
        if (this.paused) throw new ObsRequestError(type, 502, 'já pausada');
        if (this.options.pauseIgnored === true) return out();
        this.paused = true;
        this.pausedSince = clock.now();
        this.emit('RecordStateChanged', { outputActive: true, outputState: 'OBS_WEBSOCKET_OUTPUT_PAUSED', outputPath: null });
        return out();
      case 'ResumeRecord':
        if (!this.recording) throw new ObsRequestError(type, 501, 'sem gravação');
        if (!this.paused) throw new ObsRequestError(type, 503, 'não pausada');
        if (this.options.resumeIgnored === true && data?.['emergency'] !== true) return out();
        this.paused = false;
        this.pausedTotal += clock.now() - this.pausedSince;
        this.emit('RecordStateChanged', { outputActive: true, outputState: 'OBS_WEBSOCKET_OUTPUT_RESUMED', outputPath: null });
        return out();
      case 'StopRecord': {
        if (this.paused && this.options.stopIgnoredWhilePaused === true) return out({ outputPath: join(this.recordDirectory, '2026-10-16 15-00-00.mp4') });
        const drop = this.options.dropStop !== undefined && !this.#dropped;
        if (drop) this.#dropped = true;
        const lost = (): ContrarregraError => new ContrarregraError('E_OBS_UNREACHABLE', 'OBS inalcançável: a conexão fechou com StopRecord pendente (falso)', { reason: 'closed' });
        if (drop && this.options.dropStop === 'before') throw lost();
        if (!this.recording) throw new ObsRequestError(type, 501, 'sem gravação');
        this.recording = false;
        this.stoppedWhilePaused = this.paused;
        this.paused = false;
        const file = join(this.recordDirectory, '2026-10-16 15-00-00.mp4');
        writeFileSync(file, Buffer.alloc(4096, 1));
        this.lastFile = file;
        if (drop) throw lost();
        this.emit('RecordStateChanged', { outputActive: false, outputState: 'OBS_WEBSOCKET_OUTPUT_STOPPED', outputPath: file });
        return out({ outputPath: file });
      }
      case 'CreateRecordChapter':
        if (!this.recording) throw new ObsRequestError(type, 501, 'sem gravação');
        if (this.options.chapters702 === true) throw new ObsRequestError(type, 702, 'sem capítulos');
        this.chapters.push(String(data?.['chapterName']));
        return out();
      case 'GetStats':
        return out({ availableDiskSpace: this.options.availableMiB ?? 500_000 });
      case 'GetSceneItemId':
        return out({ sceneItemId: 7 });
      case 'GetSceneItemTransform': {
        const size = this.live === 'dead' ? { sourceWidth: 0, sourceHeight: 0 } : { sourceWidth: 1170, sourceHeight: 2532 };
        return out({ sceneItemTransform: size });
      }
      case 'GetSourceScreenshot':
        return out({ imageData: `data:image/png;base64,${this.live === 'live' ? WHITE_PNG : BLACK_PNG}` });
      case 'GetInputPropertiesListPropertyItems':
        return out({ propertyItems: [{ itemName: 'Outro', itemValue: 'x', itemEnabled: true }, { itemName: 'VIVO_00G7', itemValue: 'dev-123', itemEnabled: true }] });
      case 'SetInputSettings':
        this.kicks.push({ ...(data?.['inputSettings'] as Record<string, unknown>) });
        if (this.options.kickFails !== true && (data?.['inputSettings'] as Record<string, unknown>)['device'] === 'dev-123') this.live = 'live';
        return out();
      default:
        throw new ObsRequestError(type, 204, 'pedido desconhecido (falso)');
    }
  }
}

// ── Configuração, coreografia e registro ──────────────────────────────────────────────────────────

export interface TakeEnv {
  root: string;
  config: Config;
  configPath: string;
  takes: string;
  cache: string;
  choreoDir: string;
  cleanup(): void;
}

/** Pastas temporárias e uma configuração com `paths.takes`/`paths.cache` dentro delas. */
export function takeEnv(): TakeEnv {
  const root = mkdtempSync(join(tmpdir(), 'contrarregra-take-'));
  const takes = join(root, 'takes');
  const cache = join(root, 'cache');
  const choreoDir = join(root, 'choreographies', 'demo');
  mkdirSync(choreoDir, { recursive: true });
  const configPath = join(root, 'config.json');
  writeFileSync(configPath, JSON.stringify({ paths: { takes, cache }, device: { name: 'VIVO_00G7' } }));
  const config = loadConfig({ configPath });
  return { root, config, configPath, takes, cache, choreoDir, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** Coreografia mínima válida (S0.4) com as partes trocadas por `parts`. */
export function choreography(parts: Partial<Choreography> = {}): Choreography {
  return {
    schema: 'contrarregra.choreography/1',
    app: { bundleId: 'app.example.demo', iconLabel: 'Demo', expectVersion: '1.0.0 (7)', urlPrefixes: ['demo://'] },
    device: { language: 'en', screenPt: { w: 390, h: 844 }, textSize: 'large', appearance: 'light' },
    targets: {},
    prepare: [],
    scenes: [],
    cleanup: [],
    ...parts,
  };
}

export function newRecord(doc: Choreography): TakeRecord {
  return {
    schema: TAKE_RECORD_SCHEMA,
    takeId: '20261016-150000-teste',
    mode: 'dry',
    status: 'recording',
    pid: process.pid,
    choreography: { path: '/tmp/teste.choreo.yaml', sha256: '0'.repeat(64) },
    app: { bundleId: doc.app.bundleId, expectVersion: doc.app.expectVersion },
    options: { scenes: null, from: null, until: null, voice: null, pauseRecordingAt: [], prepare: true, cleanup: true },
    startedAt: new Date(0).toISOString(),
    recording: null,
    recordingPauses: [],
    cleanupPending: false,
    pause: null,
    scenes: [],
    steps: [],
    warnings: [],
  };
}
