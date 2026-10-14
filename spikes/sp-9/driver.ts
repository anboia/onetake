// A coreografia do SP-9 (T-0.27) sobre um ambiente injetado (`DriverEnv`): `sp9.ts` liga ao runner, ao OBS e ao
// ffmpeg; os testes, ao runner falso com a fila do XCTest e prazos (como `spikes/sp-4/sp4.test.ts`) e a uma captura
// falsa. Código de spike, descartável.
//
// Cada ciclo = ligar e desligar o modo avião pelo próprio runner, com o que o SP-2 (série 2, 10/10) e o SP-4 ensinaram:
// - a Central abre por `device.controlCenter {action: open}` — o arrasto de S1 item 7 (0,9 · 0,01 → 0,9 · 0,2) feito
//   DENTRO do runner (`ControlCenterGesture`). Um `ui.drag` com essa coordenada é recusado pela lista permitida (o
//   começo cai na faixa de gesto de 47 pt, A9); a sonda `probe-drag` só confere essa recusa, não a contorna;
// - toda ação da fila do XCTest que estoura o prazo do runner é lida pelo `data.phase` do `E_TIMEOUT`: `running` = vai
//   acontecer (até ~2 min depois; nunca se repete às cegas — um segundo toque desfaria o primeiro); `queued` = não
//   acontece (tenta de novo). Cada passo medido começa com a fila vazia (`health.xctestQueueDepth`, fila de controle);
// - o `value` do interruptor é lido por `ui.find` (AC-1.15; 10 s de prazo) e, se ele não servir, por `wait.for
//   {airplane}` (prazo `timeoutMs` + 1 s); a troca se confere pelo `value` com a Central ainda aberta (a fila é serial:
//   a leitura vem depois do toque) e pela rede (`wait.for {network}`, que não lê a tela);
// - a Central pode fechar sozinha: o motivo do `E_TIMEOUT` ("só se avalia com a Central de Controle aberta") ou o
//   `E_TARGET_NOT_FOUND` do toque → reabre (ler e reabrir não mudam o avião) e tenta uma vez;
// - o avião só liga no cabo (`transportType = wired`, regras comuns dos spikes) e sem o Acesso Pessoal (SP-2 §3);
//   parando com o avião possivelmente ligado, o runner esvazia a fila, lê o interruptor e só toca se ainda ligado; se
//   não conseguir, `OWNER_ACTION air-off`.

import { isContrarregraError } from '../../mac/src/core/errors.ts';
import type { HealthResult, Rect } from '../../mac/src/core/types.ts';
import {
  AIRPLANE_LABEL_TARGET,
  AIRPLANE_TARGET,
  BUTTON_FALLBACK_PT,
  CC_DRAG_PARAMS,
  airplaneReadFromMessage,
  ccClosedReason,
  newValue,
  oldValue,
  type AirState,
  type FindResult,
  type Json,
  type Lenient,
  type Probes,
  type SwitchValue,
  type ToggleRow,
  type TransportInfo,
  type VisualResult,
  type Want,
} from './lib.ts';

export interface Rpc {
  call<T = unknown>(method: string, params?: Json, options?: { timeoutMs?: number }): Promise<T>;
}

/** Instantes marcados na gravação de uma troca (o R de cada um vem do `GetRecordStatus.outputDuration`). */
export type MarkName = 'closed-before' | 'closed-before-2' | 'cc-before' | 'cc-after' | 'cc-after-end' | 'closed-after';

export interface MeasureContext {
  tag: string;
  want: Want;
  /** Frame do botão do avião em pontos. */
  button: Rect;
  buttonSource: 'find' | 'previous' | 'fallback';
}

export interface CaptureOutcome<T> {
  value: T;
  visual: VisualResult | null;
  visualErr?: string;
  recording: { name: string; bytes: number } | null;
}

/**
 * Uma gravação em volta de uma troca: começa (com o HC-11 conferido), roda `body` com `mark`, para, mede os quadros
 * e apaga a gravação — também quando `body` falha (aí relança o erro de `body`, sem medir).
 */
export interface Capture {
  around<T>(tag: string, body: (mark: (name: MarkName) => Promise<void>) => Promise<T>, context: () => MeasureContext): Promise<CaptureOutcome<T>>;
}

export interface DriverEnv {
  rpc: Rpc;
  /** O bundle id do Hagah (`app.explore`). */
  app: string;
  now(): number;
  sleep(ms: number): Promise<void>;
  write(k: string, data?: Json): void;
  /** Aviso pela voz do Mac (nunca pedido). */
  say(text: string): void;
  /** Pedido ao dono (`OWNER_ACTION`); o driver para logo depois. */
  owner(step: string, text: string): void;
  stopRequested(): boolean;
  setAir?(air: AirState): void;
  transport?(): Promise<TransportInfo | undefined>;
  hotspot?(): Promise<boolean>;
  sessionAlive?(): boolean;
  capture?: Capture;
}

export interface RunOptions {
  cycles: number;
  /** O que fica por baixo da Central: o Hagah (`app.explore`, como na cena 9) ou a tela de início. */
  base: 'hagah' | 'home';
  /** Gravar as trocas de ligar e de desligar (`both`), só as de ligar (`on`) ou nenhuma. */
  record: 'both' | 'on' | 'none';
  /** O critério da T-0.27: achar o interruptor em ≤ 2 s. */
  findLimitMs: number;
  /** Prazo no Mac das chamadas de 10 s do runner (folga para a resposta "rodando"). */
  callTimeoutMs: number;
  /** `wait.for {airplane}`: prazo de cada leitura (SP-2: cada varredura do SpringBoard com a Central aberta leva 10–60 s). */
  airplaneReadMs: number;
  /** Folga do prazo do Mac sobre o do runner no `wait.for`. */
  waitSlackMs: number;
  netOnMs: number;
  netOffMs: number;
  /** A Central aberta depois da troca confirmada (S13 item 7: ~2 s). */
  holdMs: number;
  /** Quadros da barra antes de abrir: espera, depois um segundo quadro (ruído) `noiseGapMs` depois. */
  baselineMs: number;
  noiseGapMs: number;
  /** Depois da rede confirmada, antes de parar a gravação (a barra com o novo estado). */
  tailMs: number;
  /** Entre a rede confirmada de uma troca e o começo da seguinte. */
  minPhaseMs: number;
  drainMaxMs: number;
  pollMs: number;
  /** `app.activate` do Hagah: espera normal e a de um pedido que estourou rodando. */
  appWaitMs: number;
  lateActionMs: number;
  probeDrag: boolean;
  probeLabel: boolean;
  /** A rede só conta como certa com `transportType = wired` depois da troca. */
  requireWired: boolean;
}

export const DEFAULT_OPTIONS: RunOptions = {
  cycles: 10,
  base: 'hagah',
  record: 'both',
  findLimitMs: 2_000,
  callTimeoutMs: 30_000,
  airplaneReadMs: 90_000,
  waitSlackMs: 15_000,
  netOnMs: 60_000,
  netOffMs: 90_000,
  holdMs: 2_000,
  baselineMs: 2_000,
  noiseGapMs: 500,
  tailMs: 4_000,
  minPhaseMs: 20_000,
  drainMaxMs: 180_000,
  pollMs: 500,
  appWaitMs: 10_000,
  lateActionMs: 150_000,
  probeDrag: true,
  probeLabel: true,
  requireWired: true,
};

export const TEXT = {
  start: (cycles: number): string => `SP-9 começando: ${cycles} ciclos do modo avião pelo runner. Não precisa fazer nada.`,
  end: 'SP-9 terminado. O modo avião está desligado.',
  unlock: 'SP-9 parado: o iPhone está travado. Destrave e deixe a tela acesa; depois o orquestrador roda de novo.',
  screen: (why: string): string =>
    `SP-9 parado: algo cobre a tela do iPhone e o runner não consegue pôr o Hagah na frente (${why}). Feche o alerta, a ` +
    'notificação ou o app que estiver na frente; depois o orquestrador roda de novo.',
  hotspot: 'SP-9 parado antes de ligar o modo avião: o Mac está na rede do Acesso Pessoal do iPhone (172.20.10.x). Desligue o Acesso Pessoal; depois o orquestrador roda de novo.',
  ownerAirOff: 'SP-9 parado com o modo avião possivelmente ligado, e o runner não conseguiu desligá-lo. Desligue o modo avião pela Central de Controle.',
  notWired: (tt: string): string =>
    `transportType = ${tt}, não wired: o modo avião com o runner vivo só roda no cabo (regras comuns dos spikes). O SP-2 viu ` +
    'que religar o cabo com o iPhone destravado volta para wired em ≤ 2 s; depois, rodar de novo.',
};

/** Parada do driver: `owner` = pediu algo humano; `transport` = fora do cabo; `stop` = SIGINT; `session` = runner caído. */
export class StopError extends Error {
  override readonly name = 'StopError';
  readonly kind: 'owner' | 'transport' | 'stop' | 'session';
  readonly step: string;

  constructor(kind: 'owner' | 'transport' | 'stop' | 'session', step: string, message: string) {
    super(message);
    this.kind = kind;
    this.step = step;
  }
}

export interface RunResult {
  rows: ToggleRow[];
  probes: Probes;
  /** Por que a série parou antes do fim (ou `undefined`). */
  stopped?: string;
  /** `transport` (fora do cabo), `stop` (SIGINT), `session` (runner caído) ou `error` (uma troca ou sonda falhou). */
  stopKind?: 'transport' | 'stop' | 'session' | 'error';
  /** O avião no fim, como o driver sabe. */
  air: AirState;
}

export function errCode(error: unknown): string {
  if (isContrarregraError(error)) return `${error.code}: ${error.message.slice(0, 200)}`;
  if (error instanceof Error) return error.message.slice(0, 200);
  return String(error).slice(0, 200);
}

interface ActionResult {
  tDevStartNs?: string;
  tDispatchNs?: string;
  tDevEndNs?: string;
  path?: string;
}

function devMs(r: unknown): number | null {
  const a = r as ActionResult | undefined;
  if (a?.tDevStartNs === undefined || a.tDevEndNs === undefined) return null;
  try {
    return Number(BigInt(a.tDevEndNs) - BigInt(a.tDevStartNs)) / 1e6;
  } catch {
    return null;
  }
}

function pathOf(r: unknown): string | null {
  const p = (r as ActionResult | undefined)?.path;
  return typeof p === 'string' ? p : null;
}

interface FindCandidate {
  frame?: Rect;
  visible?: boolean;
  hittable?: boolean;
  value?: string;
}

/**
 * Roda o SP-9 inteiro: sondas (arrasto por coordenada, rótulo), normalização (avião desligado, lido pelo `value`),
 * `cycles` × (ligar, desligar), e no fim (ou parando) o avião desligado de certeza. Nunca lança por falha de uma
 * troca: a série para, o avião é desligado e o resultado diz por quê. Lança `StopError` só quando precisa do dono.
 */
export async function runSpike(env: DriverEnv, opts: RunOptions): Promise<RunResult> {
  const rows: ToggleRow[] = [];
  const probes: Probes = {};
  let air = 'maybe-on' as AirState;
  let lastButton: Rect | undefined;
  const setAir = (next: AirState): void => {
    if (next === air) return;
    air = next;
    env.setAir?.(next);
    env.write('air', { air });
  };

  // ── chamadas ────────────────────────────────────────────────────────────────────────────────────────────

  const check = (): void => {
    if (env.sessionAlive !== undefined && !env.sessionAlive()) throw new StopError('session', 'session', 'o xcodebuild da sessão saiu: runner caído');
    if (env.stopRequested()) throw new StopError('stop', 'signal', 'parada pedida (SIGINT/SIGTERM)');
  };

  const healthNow = (): Promise<HealthResult> => env.rpc.call<HealthResult>('health', {}, { timeoutMs: 5_000 });

  /** Uma chamada registrada (`xop`), com o prazo do Mac; o erro sobe. */
  const xcall = async <T>(op: string, method: string, params: Json, timeoutMs = opts.callTimeoutMs): Promise<T> => {
    const t0 = env.now();
    try {
      const r = await env.rpc.call<T>(method, params, { timeoutMs });
      env.write('xop', { op, method, ms: env.now() - t0 });
      return r;
    } catch (error) {
      const phase = isContrarregraError(error) ? error.data?.['phase'] : undefined;
      env.write('xop', { op, method, ms: env.now() - t0, err: errCode(error), ...(phase === undefined ? {} : { lanePhase: phase }) });
      throw error;
    }
  };

  /** `E_TIMEOUT` do runner com o comando ainda na fila: não rodou e nunca vai rodar. */
  const queued = (error: unknown): boolean => isContrarregraError(error, 'E_TIMEOUT') && error.data?.['phase'] === 'queued';

  /** Ação da fila que pode estourar os 10 s do runner: na fila → tenta de novo; rodando (ou sem `phase`) → vai acontecer. */
  const lenient = async (op: string, method: string, params: Json, tries = 3): Promise<{ outcome: Lenient; result?: unknown }> => {
    for (let i = 0; i < tries; i++) {
      try {
        return { outcome: 'ok', result: await xcall(op, method, params) };
      } catch (error) {
        if (!isContrarregraError(error, 'E_TIMEOUT')) throw error;
        if (!queued(error)) return { outcome: 'ran-late' };
      }
    }
    return { outcome: 'not-run' };
  };

  /** Espera a fila do XCTest esvaziar (pelo `health`, que não entra nela). */
  const drain = async (why: string): Promise<number> => {
    const t0 = env.now();
    let polls = 0;
    for (;;) {
      const h = await healthNow();
      if (h.xctestQueueDepth === 0) {
        if (polls > 0) env.write('drain', { why, polls, ms: env.now() - t0 });
        return env.now() - t0;
      }
      polls++;
      if (env.now() - t0 > opts.drainMaxMs) throw new Error(`a fila do XCTest não esvaziou em ${Math.round(opts.drainMaxMs / 1000)} s (profundidade ${h.xctestQueueDepth})`);
      await env.sleep(opts.pollMs);
    }
  };

  const stopOwner = (step: string, text: string): never => {
    env.owner(step, text);
    throw new StopError('owner', step, text);
  };

  const transport = async (when: string): Promise<TransportInfo | null> => {
    if (env.transport === undefined) return null;
    const t = (await env.transport()) ?? null;
    env.write('transport', { when, tt: t?.transportType ?? null, ts: t?.tunnelState ?? null });
    return t;
  };

  /** Antes de ligar o avião: no cabo (fail-closed: `devicectl` sem resposta conta como fora) e sem o Acesso Pessoal. */
  const requireSafeToGoOffline = async (): Promise<void> => {
    if (env.transport !== undefined) {
      const t = await transport('before-on');
      if (t?.transportType !== 'wired') throw new StopError('transport', 'wired', TEXT.notWired(t?.transportType ?? 'desconhecido (devicectl sem resposta)'));
    }
    if (env.hotspot !== undefined && (await env.hotspot())) stopOwner('hotspot', TEXT.hotspot);
  };

  /** O que fica por baixo da Central: o Hagah à frente (`app.activate`) ou a tela de início (`device.home`). */
  const ensureBase = async (): Promise<HealthResult> => {
    const t0 = env.now();
    let activations = 0;
    let closedCc = false;
    for (;;) {
      check();
      const h = await healthNow();
      if (h.locked) stopOwner('unlock', TEXT.unlock);
      if (opts.base === 'home') {
        if (activations > 0) return h;
        activations++;
        const r = await lenient('home', 'device.home', {});
        if (r.outcome === 'ran-late') await drain('home-late');
        continue;
      }
      if (h.foregroundApp === env.app) {
        if (activations > 0) env.write('base', { activations, ms: env.now() - t0 });
        return h;
      }
      if (activations >= 2) stopOwner('screen', TEXT.screen(`à frente: ${h.foregroundApp === '' ? 'desconhecido' : h.foregroundApp}`));
      activations++;
      let outcome: Lenient;
      try {
        outcome = (await lenient('activate', 'app.activate', { bundleId: env.app })).outcome;
      } catch (error) {
        if (!isContrarregraError(error, 'E_FORBIDDEN_APP')) throw error;
        if (closedCc) stopOwner('screen', TEXT.screen(errCode(error)));
        // A Central aberta (sobra de uma troca interrompida) é a única camada que o runner fecha.
        closedCc = true;
        await lenient('cc-close', 'device.controlCenter', { action: 'close' }).catch(() => undefined);
        activations--;
        continue;
      }
      if (outcome === 'not-run') continue;
      const deadline = env.now() + (outcome === 'ran-late' ? Math.max(opts.appWaitMs, opts.lateActionMs) : opts.appWaitMs);
      while (env.now() < deadline) {
        const x = await healthNow();
        if (x.locked || (x.foregroundApp === env.app && x.xctestQueueDepth === 0)) break;
        await env.sleep(Math.min(opts.pollMs, 500));
      }
    }
  };

  /**
   * O interruptor pelo `wait.for {airplane}` (prazo do runner = `timeoutMs` + 1 s). `yes` = vale; `no` = a última
   * sondagem viu o contrário; `cc-closed` = a Central não estava aberta; `unknown` = não se leu.
   */
  const airplaneIs = async (state: Want): Promise<'yes' | 'no' | 'unknown' | 'cc-closed'> => {
    for (let i = 0; i < 3; i++) {
      try {
        await xcall(`wait-airplane-${state}`, 'wait.for', { condition: { airplane: state }, timeoutMs: opts.airplaneReadMs }, opts.airplaneReadMs + opts.waitSlackMs);
        return 'yes';
      } catch (error) {
        if (isContrarregraError(error, 'E_FORBIDDEN_APP')) return 'cc-closed';
        if (!isContrarregraError(error, 'E_TIMEOUT')) throw error;
        const seen = airplaneReadFromMessage(error.message);
        if (seen !== null) return seen === state ? 'yes' : 'no';
        if (ccClosedReason(error.message)) return 'cc-closed';
        // Sem leitura: na fila (algo atrasado na frente) ou o prazo venceu no meio de uma varredura lenta. Espera a fila
        // esvaziar (a leitura não muda o avião) e lê de novo.
        await drain(`wait-airplane-${state}`);
      }
    }
    return 'unknown';
  };

  /** Reabre a Central que fechou sozinha (abrir de novo não muda o avião). */
  const reopen = async (row: ToggleRow | undefined, why: string): Promise<boolean> => {
    if (row !== undefined) row.ccReopened++;
    env.write('cc-closed', { why, cycle: row?.cycle, want: row?.want });
    const o = await lenient('cc-reopen', 'device.controlCenter', { action: 'open' });
    if (o.outcome === 'ran-late') await drain('reopen-late');
    return o.outcome !== 'not-run';
  };

  /** Lê o interruptor; se a Central fechou sozinha, reabre uma vez e lê de novo. */
  const readSwitch = async (state: Want, row?: ToggleRow): Promise<'yes' | 'no' | 'unknown'> => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const r = await airplaneIs(state);
      if (r !== 'cc-closed') return r;
      if (attempt === 0 && !(await reopen(row, `ler ${state}`))) return 'unknown';
    }
    return 'unknown';
  };

  /** AC-1.15: `ui.find` no interruptor, com a fila vazia; o tempo do pedido à resposta é o critério de ≤ 2 s. */
  const findSwitch = async (target: Json = AIRPLANE_TARGET, op = 'find'): Promise<FindResult> => {
    await drain(`${op}-before`);
    const t0 = env.now();
    try {
      const r = await xcall<{ candidates?: FindCandidate[] }>(op, 'ui.find', { target });
      const ms = env.now() - t0;
      const c = r.candidates ?? [];
      const first = c[0];
      return {
        outcome: c.length === 1 ? 'ok' : c.length === 0 ? 'empty' : 'ambiguous',
        ms,
        count: c.length,
        value: typeof first?.value === 'string' ? first.value : null,
        frame: first?.frame ?? null,
        hittable: typeof first?.hittable === 'boolean' ? first.hittable : null,
      };
    } catch (error) {
      const ms = env.now() - t0;
      if (isContrarregraError(error, 'E_TIMEOUT')) {
        if (queued(error)) return { outcome: 'queued', ms, err: errCode(error) };
        await drain(`${op}-late`);
        return { outcome: 'late', ms, lateMs: env.now() - t0, err: errCode(error) };
      }
      if (isContrarregraError(error, 'E_FORBIDDEN_APP') || isContrarregraError(error, 'E_TARGET_NOT_FOUND')) return { outcome: 'forbidden', ms, err: errCode(error) };
      throw error;
    }
  };

  /** O toque no interruptor; `E_TARGET_NOT_FOUND`/`E_FORBIDDEN_APP` = a Central fechou (nada tocado) → reabre e toca uma vez. */
  const tapSwitch = async (row: ToggleRow): Promise<NonNullable<ToggleRow['tap']>> => {
    const t0 = env.now();
    let reopened = false;
    let r: { outcome: Lenient; result?: unknown };
    try {
      r = await lenient('tap', 'ui.tap', { target: AIRPLANE_TARGET });
    } catch (error) {
      if (!isContrarregraError(error, 'E_TARGET_NOT_FOUND') && !isContrarregraError(error, 'E_FORBIDDEN_APP')) throw error;
      reopened = true;
      if (!(await reopen(row, 'tocar'))) return { outcome: 'not-run', ms: env.now() - t0, reopened, path: null };
      r = await lenient('tap', 'ui.tap', { target: AIRPLANE_TARGET });
    }
    return { outcome: r.outcome, ms: env.now() - t0, reopened, path: pathOf(r.result) };
  };

  /** A rede pelo `wait.for {network}` (não lê a tela); tempos desde o pedido do toque e desde o toque (real). */
  const netCheck = async (expect: 'online' | 'offline', timeoutMs: number, tapRequestAt: number | null, tapDoneAt: number | null): Promise<NonNullable<ToggleRow['net']>> => {
    let err: string | undefined;
    for (let i = 0; i < 4; i++) {
      try {
        await xcall(`wait-${expect}`, 'wait.for', { condition: { network: expect }, timeoutMs }, timeoutMs + opts.waitSlackMs);
        const at = env.now();
        return { expect, ok: true, msFromTap: tapDoneAt === null ? null : at - tapDoneAt, msFromTapRequest: tapRequestAt === null ? null : at - tapRequestAt, tries: i + 1 };
      } catch (error) {
        err = errCode(error);
        if (!queued(error)) return { expect, ok: false, msFromTap: null, msFromTapRequest: null, tries: i + 1, err };
      }
    }
    return { expect, ok: false, msFromTap: null, msFromTapRequest: null, tries: 4, err: err ?? 'na fila' };
  };

  const deviceState = async (): Promise<NonNullable<ToggleRow['deviceState']>> => {
    try {
      const s = await xcall<{ network: string; foregroundApp: string }>('device-state', 'device.state', {});
      return { network: s.network, foregroundApp: s.foregroundApp };
    } catch (error) {
      if (isContrarregraError(error, 'E_TIMEOUT') && !queued(error)) await drain('state-late').catch(() => undefined);
      return { err: errCode(error) };
    }
  };

  /**
   * Desligado pelo `value` do interruptor: fila vazia → Central → `wait.for {airplane: off}`; se ligado, um toque e
   * outra leitura; nunca toca sem ler. `true` = desligado de certeza.
   */
  const ensureOffByValue = async (why: string): Promise<boolean> => {
    const row: Json = { why };
    try {
      try {
        await drain('recover');
      } catch (error) {
        row['drainErr'] = errCode(error);
      }
      if ((await lenient('cc-open', 'device.controlCenter', { action: 'open' })).outcome === 'not-run') throw new Error('a Central de Controle não abriu');
      let read = await readSwitch('off');
      if (read === 'unknown') read = await readSwitch('off');
      row['before'] = read;
      if (read === 'no') {
        setAir('on');
        const tap = await lenient('tap', 'ui.tap', { target: AIRPLANE_TARGET });
        row['tap'] = tap.outcome;
        read = await readSwitch('off');
        if (read === 'unknown') read = await readSwitch('off');
        row['after'] = read;
      }
      await lenient('cc-close', 'device.controlCenter', { action: 'close' }).catch(() => undefined);
      if (read === 'yes') setAir('off');
      row['ok'] = read === 'yes';
    } catch (error) {
      row['ok'] = false;
      row['err'] = errCode(error);
      await lenient('cc-close', 'device.controlCenter', { action: 'close' }).catch(() => undefined);
    }
    env.write('recover', row);
    return row['ok'] === true;
  };

  // ── sondas ──────────────────────────────────────────────────────────────────────────────────────────────

  /** O arrasto de S1 item 7 por coordenada (`ui.drag`): a lista permitida deve recusar (faixa de gesto, A9). */
  const probeDrag = async (): Promise<void> => {
    await drain('probe-drag');
    const h = await ensureBase();
    try {
      await xcall('probe-drag', 'ui.drag', { ...CC_DRAG_PARAMS, from: { ...CC_DRAG_PARAMS.from }, to: { ...CC_DRAG_PARAMS.to } });
      probes.drag = { outcome: 'executed', front: h.foregroundApp };
      // Inesperado: o arrasto passou (lacuna da lista permitida, achado para G1). A Central pode ter aberto: fecha.
      await lenient('cc-close', 'device.controlCenter', { action: 'close' }).catch(() => undefined);
    } catch (error) {
      if (isContrarregraError(error, 'E_FORBIDDEN_APP')) probes.drag = { outcome: 'refused', code: 'E_FORBIDDEN_APP', message: error.message.slice(0, 240), front: h.foregroundApp };
      else {
        probes.drag = { outcome: 'error', code: isContrarregraError(error) ? error.code : 'erro', message: errCode(error), front: h.foregroundApp };
        if (isContrarregraError(error, 'E_TIMEOUT')) await drain('probe-drag-late');
      }
    }
    env.write('probe-drag', { ...probes.drag });
  };

  /** O mesmo interruptor pelo rótulo "Airplane Mode" (plano B da T-0.27): resolve? em quanto tempo? */
  const probeLabel = async (): Promise<void> => {
    await drain('probe-label');
    await ensureBase();
    const o = await lenient('cc-open', 'device.controlCenter', { action: 'open' });
    if (o.outcome === 'not-run') {
      probes.label = { outcome: 'cc-not-open' };
    } else {
      if (o.outcome === 'ran-late') await drain('probe-label-open');
      const f = await findSwitch(AIRPLANE_LABEL_TARGET, 'find-label');
      probes.label = { outcome: f.outcome, ms: f.ms, count: f.count, value: f.value ?? null, sameFrame: null, ...(f.err === undefined ? {} : { err: f.err }) };
      if (f.frame !== null && f.frame !== undefined) lastButton ??= f.frame;
    }
    const c = await lenient('cc-close', 'device.controlCenter', { action: 'close' });
    if (c.outcome === 'ran-late') await drain('probe-label-close');
    env.write('probe-label', { ...probes.label });
  };

  // ── uma troca ───────────────────────────────────────────────────────────────────────────────────────────

  const shouldRecord = (want: Want): boolean => env.capture !== undefined && (opts.record === 'both' || (opts.record === 'on' && want === 'on'));

  const toggle = async (cycle: number, want: Want): Promise<ToggleRow> => {
    const t0 = env.now();
    const row: ToggleRow = { cycle, want, at: new Date(t0).toISOString(), ccReopened: 0, ms: 0 };
    const old: SwitchValue = oldValue(want);
    const neu: SwitchValue = newValue(want);
    const oldState: Want = want === 'on' ? 'off' : 'on';
    const tag = `c${String(cycle).padStart(2, '0')}-${want}`;
    try {
      check();
      await drain('toggle');
      const h = await ensureBase();
      row.frontBefore = h.foregroundApp;
      if (want === 'on') await requireSafeToGoOffline();
      row.transportBefore = await transport(`before-${tag}`);
      let tapRequestAt: number | null = null;
      /** A resposta do toque ou, se ele estourou rodando, o fim da fila (o toque real). */
      let tapDoneAt: number | null = null;
      const body = async (mark: (name: MarkName) => Promise<void>): Promise<void> => {
        await env.sleep(opts.baselineMs);
        await mark('closed-before');
        await env.sleep(opts.noiseGapMs);
        await mark('closed-before-2');
        // 1. Abrir: o arrasto 0,9 · 0,01 → 0,9 · 0,2 de S1 item 7, feito pelo runner.
        check();
        const o0 = env.now();
        const open = await lenient('cc-open', 'device.controlCenter', { action: 'open' });
        row.open = { outcome: open.outcome, ms: env.now() - o0, devMs: devMs(open.result), path: pathOf(open.result) };
        if (open.outcome === 'not-run') throw new Error('a Central de Controle não abriu (o pedido ficou na fila)');
        if (open.outcome === 'ran-late') await drain('open-late');
        // 2. Achar (AC-1.15) e ler o `value` antes.
        row.find = await findSwitch();
        if (row.find.frame !== null && row.find.frame !== undefined) lastButton = row.find.frame;
        let before: SwitchValue | null = row.find.outcome === 'ok' && (row.find.value === '0' || row.find.value === '1') ? row.find.value : null;
        row.valueBeforeFrom = 'find';
        if (before === null) {
          const read = await readSwitch(oldState, row);
          before = read === 'yes' ? old : read === 'no' ? neu : null;
          row.valueBeforeFrom = 'wait';
        }
        row.valueBefore = before;
        if (before === null) throw new Error('o interruptor do modo avião ficou ilegível antes do toque');
        if (before === '1') setAir('on');
        await mark('cc-before');
        // 3. Tocar (só se ainda no antigo; nunca de novo às cegas).
        if (before === neu) {
          row.already = true;
        } else {
          check();
          if (want === 'on') setAir('maybe-on');
          tapRequestAt = env.now();
          row.tap = await tapSwitch(row);
          if (row.tap.outcome === 'not-run') throw new Error('o toque no interruptor não rodou (ficou na fila)');
          // Estourou rodando: o toque acontece quando a fila esvaziar (SP-2: até ~2 min depois); esse é o instante dele.
          if (row.tap.outcome === 'ran-late') await drain('tap-late');
          tapDoneAt = env.now();
        }
        // 4. Conferir a troca pelo `value`, com a Central aberta (a fila serial põe a leitura depois do toque).
        const a0 = env.now();
        const after = await readSwitch(want, row);
        row.afterReadMs = env.now() - a0;
        row.valueAfter = after === 'yes' ? neu : after === 'no' ? old : null;
        setAir(row.valueAfter === '0' ? 'off' : row.valueAfter === '1' ? 'on' : 'maybe-on');
        // 5. A Central aberta ~2 s com o botão no novo estado (a prova de S13 item 7).
        await mark('cc-after');
        await env.sleep(opts.holdMs);
        await mark('cc-after-end');
        // 6. Fechar (`press(.home)`) e ver o que ficou à frente.
        const c0 = env.now();
        const close = await lenient('cc-close', 'device.controlCenter', { action: 'close' });
        row.close = { outcome: close.outcome, ms: env.now() - c0 };
        if (close.outcome === 'ran-late') await drain('close-late');
        row.frontAfterClose = (await healthNow()).foregroundApp;
        // 7. A rede (offline com o avião mesmo com o túnel no cabo) e o cabo.
        await drain('net');
        row.net = await netCheck(want === 'on' ? 'offline' : 'online', want === 'on' ? opts.netOnMs : opts.netOffMs, tapRequestAt, tapDoneAt);
        row.deviceState = await deviceState();
        row.transportAfter = await transport(`after-${tag}`);
        await env.sleep(opts.tailMs);
        await mark('closed-after');
      };
      if (shouldRecord(want)) {
        const out = await env.capture!.around(tag, body, () => ({
          tag,
          want,
          button: lastButton ?? BUTTON_FALLBACK_PT,
          buttonSource: row.find?.frame !== null && row.find?.frame !== undefined ? 'find' : lastButton !== undefined ? 'previous' : 'fallback',
        }));
        row.visual = out.visual;
        if (out.visualErr !== undefined) row.visualErr = out.visualErr;
        row.recording = out.recording;
      } else {
        await body(async () => {});
      }
      if (row.valueAfter !== neu) throw new Error(`a troca não se confirmou pelo value (depois: ${row.valueAfter ?? 'ilegível'})`);
    } catch (error) {
      if (error instanceof StopError) {
        row.err = `${error.kind}: ${error.message.slice(0, 160)}`;
        row.ms = env.now() - t0;
        env.write('toggle', { ...row });
        throw error;
      }
      row.err = errCode(error);
      // Uma leitura ou toque que estourou deixa a Central aberta: fecha (sem esperar o efeito).
      await lenient('cc-close', 'device.controlCenter', { action: 'close' }).catch(() => undefined);
    }
    row.ms = env.now() - t0;
    env.write('toggle', { ...row });
    return row;
  };

  // ── a série ─────────────────────────────────────────────────────────────────────────────────────────────

  let stopped: string | undefined;
  let stopKind: RunResult['stopKind'];
  env.say(TEXT.start(opts.cycles));
  try {
    check();
    const h0 = await healthNow();
    env.write('start', { uptimeS: h0.uptimeS, fg: h0.foregroundApp, locked: h0.locked, queue: h0.xctestQueueDepth });
    if (h0.locked) stopOwner('unlock', TEXT.unlock);
    if (opts.probeDrag) await probeDrag();
    // Ponto de partida conhecido: avião desligado pelo `value` (uma execução anterior pode tê-lo deixado ligado).
    const normalized = await ensureOffByValue('início');
    probes.normalize = { ok: normalized };
    if (!normalized) throw new Error('o modo avião não se confirmou desligado no começo');
    if (opts.probeLabel) await probeLabel();
    let notBefore = env.now();
    for (let cycle = 1; cycle <= opts.cycles && stopped === undefined; cycle++) {
      for (const want of ['on', 'off'] as const) {
        while (env.now() < notBefore) {
          check();
          await env.sleep(Math.min(250, notBefore - env.now()));
        }
        const row = await toggle(cycle, want);
        rows.push(row);
        notBefore = env.now() + opts.minPhaseMs;
        if (row.err !== undefined) {
          stopped = `ciclo ${cycle} (${want}): ${row.err}`;
          stopKind = 'error';
          break;
        }
      }
    }
  } catch (error) {
    if (error instanceof StopError && error.kind === 'owner') {
      // Pedido humano já feito; ainda assim, se o avião pode estar ligado e o runner vive, tenta desligar — e, se não
      // der, o dono também desliga o avião.
      if (air !== 'off') {
        const ok = (env.sessionAlive?.() ?? true) && (await ensureOffByValue('parada (dono)'));
        if (!ok) env.owner('air-off', TEXT.ownerAirOff);
      }
      env.write('end', { why: `dono: ${error.step}`, air });
      throw error;
    }
    stopped = errCode(error);
    stopKind = error instanceof StopError ? (error.kind === 'owner' ? 'error' : error.kind) : 'error';
    if (error instanceof StopError && error.kind === 'session') {
      env.write('end', { why: stopped, air });
      if (air !== 'off') stopOwner('air-off', TEXT.ownerAirOff);
      return { rows, probes, stopped, stopKind, air };
    }
  }
  if (air !== 'off') {
    const ok = await ensureOffByValue(stopped === undefined ? 'fim' : 'recuperação');
    if (!ok) {
      env.write('end', { why: stopped ?? 'fim', air });
      stopOwner('air-off', TEXT.ownerAirOff);
    }
  }
  if (stopped === undefined) env.say(TEXT.end);
  env.write('end', { why: stopped ?? 'done', air });
  return { rows, probes, ...(stopped === undefined ? {} : { stopped, stopKind }), air };
}
