// Driver do SP-3 (T-0.18; S1 item 5, A10 PX-2/PX-3, AC-1.5, AC-1.18): toques no Hagah com o Salmo 23 tocando (a palavra
// destacada animando) e de novo com o áudio pausado (base), nas variantes (a) público, (b) opções de interação, (c)
// troca do método de espera, (d) evento sintetizado — mais `a.coord`, o caminho do `ui.tap` de hoje. Código de spike,
// descartável (architecture.md A5); usa o cliente JSON-RPC de `mac/src/runner` (T-0.10) e os métodos `spike.tap`/
// `spike.tapProbe` do build `Spike` (ios/ContrarregraRunner/Spikes/SP3Taps.swift).
//
// O dono não fica ao lado do iPhone (no cabo, destravado, tela acesa): o driver prepara tudo pelo runner — põe o Hagah
// à frente (`app.activate`), vai ao Salmo 23 NIV (link `hagah://bible/ENGNIV/PSA/23`, ou pelo seletor de capítulo),
// abre o Now Playing, liga Repeat "Chapter" (e o devolve ao que era no fim), dá play, mede, e no fim deixa o áudio
// pausado. Se o áudio parar ou o capítulo mudar no meio, refaz o preparo sozinho. A voz do Mac (`say -v Luciana`) só
// avisa. Só para e pede o dono (`OWNER_ACTION {...}` na saída padrão, código de saída 3) no que exige uma pessoa: tela
// travada (código/Face ID), o Hagah fora da frente (alerta do sistema, notificação), login no Hagah, ou caminho até o
// Salmo 23 não achado — com os rótulos que viu na árvore.
//
// Nunca instala nem sobe o runner (o build `Spike` e a instalação são G5, pelo orquestrador). Só opera o app de
// `app.explore` (o Hagah), pela lista permitida do runner.
//
// Uso (Node 22 ≥ 22.18, TypeScript direto; ver spikes/SP-3.md):
//   node spikes/sp-3/sp3.ts probe    --label <l>
//   node spikes/sp-3/sp3.ts prepare  --label <l> [--ui-only] [--keep]     (só o preparo; sem --keep, pausa e desfaz)
//   node spikes/sp-3/sp3.ts discover --label <l>
//   node spikes/sp-3/sp3.ts run      --label <l> [--n 50] [--variants a,a.coord,b,c,d] [--states playing,paused]
//                                    [--gap-ms 700] [--settle-ms 3000] [--press-ms 50] [--effect-timeout-ms 3000]
//                                    [--no-effect] [--no-restore] [--restore-states paused] [--restore-variant <v>]
//                                    [--slow-ms 25000]
//                                    [--ui-only] [--no-repeat] [--repeat-before <modo>] [--targets <arquivo>]
//   node spikes/sp-3/sp3.ts heavy    [--label sp3-heavy] [--n-d 20] [--n-coord 5]
//        (repetição curta no estado pesado: fecha o Hagah, reabre pelo link, play e logo 20 × (d) + 5 × a.coord +
//         `ui.tree` cronometrado, tocando e depois pausado; o snapshot do SpringBoard sai do registro)
//   node spikes/sp-3/sp3.ts analyze  --label <l>
// Saída bruta em spikes/sp-3/out/ (fora do git): <label>.ndjson (uma linha por evento), <label>-prepare.json (o caminho
// feito e o Repeat de antes), <label>-targets.json, <label>-tree.json, <label>-<estado>-<variante>.log (o trecho do
// xcodebuild.log), <label>-summary.json (e a tabela em Markdown na saída padrão).

import { spawn } from 'node:child_process';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '../../mac/src/core/config.ts';
import { isContrarregraError } from '../../mac/src/core/errors.ts';
import type { TreeNode } from '../../mac/src/core/types.ts';
import { RunnerLink } from '../../mac/src/runner/link.ts';
import {
  DEFAULT_VARIANTS,
  KNOWN_VARIANTS,
  PSALM23_LINK,
  flatten,
  heavyReport,
  markdownTable,
  ownerReason,
  probeLetter,
  runPhase,
  summarize,
  variantSpec,
  type FindCandidate,
  type Json,
  type Rpc,
  type Targets,
} from './lib.ts';
import { OwnerNeeded, audioState, autoPause, discover, drainQueue, finish, prepare, tapFound, toggleAudio, type PrepCtx } from './prepare.ts';

const OUT = join(dirname(fileURLToPath(import.meta.url)), 'out');
const VOICE = 'Luciana';

function now(): number {
  return Math.round((performance.timeOrigin + performance.now()) * 10) / 10;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errCode(error: unknown): string {
  if (isContrarregraError(error)) return `${error.code}: ${error.message.slice(0, 200)}`;
  if (error instanceof Error) return error.message.slice(0, 200);
  return String(error).slice(0, 200);
}

// ---------------------------------------------------------------------------------------------------------
// Registro e voz

class Recorder {
  readonly label: string;
  readonly path: string;
  constructor(label: string, fresh: boolean) {
    mkdirSync(OUT, { recursive: true });
    this.label = label;
    this.path = join(OUT, `${label}.ndjson`);
    if (fresh && existsSync(this.path)) throw new Error(`${this.path} já existe: use outro --label`);
  }
  write(k: string, data: Json = {}): void {
    appendFileSync(this.path, `${JSON.stringify({ k, m: now(), ...data })}\n`);
  }
  file(suffix: string): string {
    return join(OUT, `${this.label}-${suffix}`);
  }
}

/** Aviso falado no Mac (nunca no iPhone, P-7); não pede nada. */
function say(rec: Recorder | undefined, text: string, meta: Json): void {
  rec?.write('say', { ...meta, text });
  const child = spawn('/usr/bin/say', ['-v', VOICE, text], { stdio: 'ignore' });
  child.once('error', (error) => rec?.write('say-error', { err: errCode(error) }));
}

// ---------------------------------------------------------------------------------------------------------
// Opções

function args(argv: string[]): Map<string, string> {
  const map = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? '';
    if (!a.startsWith('--')) continue;
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) map.set(a.slice(2), 'true');
    else {
      map.set(a.slice(2), next);
      i++;
    }
  }
  return map;
}

function num(opts: Map<string, string>, key: string, fallback: number): number {
  const v = opts.get(key);
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`--${key} inválido: ${v}`);
  return n;
}

function list(opts: Map<string, string>, key: string, fallback: readonly string[]): string[] {
  const v = opts.get(key);
  return v === undefined ? [...fallback] : v.split(',').map((x) => x.trim()).filter((x) => x !== '');
}

// ---------------------------------------------------------------------------------------------------------
// Runner

interface Session {
  link: RunnerLink;
  rpc: Rpc;
  bundleId: string;
  log: string;
  configuration: string;
  capabilities: unknown;
}

async function connect(rec: Recorder | undefined): Promise<Session> {
  const config = loadConfig();
  const bundleId = config.app.explore;
  if (bundleId === undefined) throw new Error('app.explore não configurado: o SP-3 opera o app de app.explore (o Hagah)');
  const link = await RunnerLink.connect(config, {
    role: 'control',
    onStateChange: (state, error) => rec?.write('link', { state, ...(error === undefined ? {} : { err: errCode(error) }) }),
  });
  const connection = link.connection;
  if (connection === undefined) throw new Error('a linha com o runner caiu logo depois de abrir');
  return {
    link,
    rpc: link,
    bundleId,
    log: connection.session.log,
    configuration: connection.session.configuration,
    capabilities: connection.hello.capabilities,
  };
}

/** O build `Spike` com os métodos do SP-3; devolve o `spike.tapProbe`. */
async function probe(session: Session, rec: Recorder | undefined): Promise<Json> {
  if (session.configuration !== 'Spike') {
    throw new Error(`o runner de pé é o build ${session.configuration}, não o Spike: o orquestrador sobe o build Spike (G5)`);
  }
  let result: Json;
  try {
    result = await session.rpc.call<Json>('spike.tapProbe', {}, { timeoutMs: 15_000 });
  } catch (error) {
    throw new Error(`spike.tapProbe falhou (${errCode(error)}): o build Spike instalado tem os métodos do SP-3 registrados? `
      + '(SpikeMethods.register no RunnerMethods)');
  }
  rec?.write('probe', { result, capabilities: session.capabilities, configuration: session.configuration });
  return result;
}

/** A altura do centro do botão medido (a fileira do transporte). */
function targetY(targets: Targets): number {
  return targets.measure.frame.y + targets.measure.frame.h / 2;
}

/** O contexto do preparo (prepare.ts) sobre a sessão e o registro. */
function prepCtx(session: Session, rec: Recorder): PrepCtx {
  return {
    rpc: session.rpc,
    bundleId: session.bundleId,
    write: (k, data) => rec.write(k, data),
    save: (suffix, text) => writeFileSync(rec.file(suffix), text),
    now: () => Date.now(),
    sleep,
  };
}

// ---------------------------------------------------------------------------------------------------------
// Comandos

function logReader(path: string): { size: () => number; read: (from: number, to: number) => string } {
  return {
    size: () => {
      try {
        return statSync(path).size;
      } catch {
        return 0;
      }
    },
    read: (from, to) => {
      if (to <= from) return '';
      const fd = openSync(path, 'r');
      try {
        const buffer = Buffer.alloc(to - from);
        const n = readSync(fd, buffer, 0, buffer.length, from);
        return buffer.subarray(0, n).toString('utf8');
      } finally {
        closeSync(fd);
      }
    },
  };
}

/** Espera a fila do XCTest esvaziar (um toque que estourou o prazo continua rodando no aparelho, S1 item 3). */
async function drain(session: Session, rec: Recorder, maxS = 180): Promise<void> {
  const deadline = Date.now() + maxS * 1000;
  for (;;) {
    try {
      const health = await session.rpc.call<{ xctestQueueDepth: number }>('health', {}, { timeoutMs: 3_000 });
      if (health.xctestQueueDepth === 0) return;
      rec.write('drain', { depth: health.xctestQueueDepth });
    } catch (error) {
      rec.write('drain', { err: errCode(error) });
    }
    if (Date.now() > deadline) throw new Error(`a fila do XCTest não esvaziou em ${maxS} s`);
    await sleep(2_000);
  }
}

async function cmdProbe(opts: Map<string, string>): Promise<void> {
  const rec = new Recorder(opts.get('label') ?? 'probe', false);
  const session = await connect(rec);
  try {
    const result = await probe(session, rec);
    writeFileSync(rec.file('probe.json'), `${JSON.stringify({ configuration: session.configuration, capabilities: session.capabilities, probe: result }, null, 2)}\n`);
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await session.link.close();
  }
}

async function cmdPrepare(opts: Map<string, string>): Promise<void> {
  const rec = new Recorder(opts.get('label') ?? 'prepare', false);
  const session = await connect(rec);
  const ctx = prepCtx(session, rec);
  try {
    const { prepared, targets } = await prepare(ctx, { uiOnly: opts.has('ui-only'), repeat: !opts.has('no-repeat') });
    console.log(JSON.stringify({ prepared, targets }, null, 2));
    if (!opts.has('keep')) await finish(ctx, prepared, targetY(targets));
  } finally {
    await session.link.close();
  }
}

async function cmdDiscover(opts: Map<string, string>): Promise<void> {
  const rec = new Recorder(opts.get('label') ?? 'discover', false);
  const session = await connect(rec);
  const ctx = prepCtx(session, rec);
  try {
    console.log(JSON.stringify(await discover(ctx), null, 2));
  } finally {
    await session.link.close();
  }
}

async function cmdRun(opts: Map<string, string>): Promise<void> {
  const label = opts.get('label') ?? `run-${Date.now()}`;
  const n = num(opts, 'n', 50);
  const variants = list(opts, 'variants', DEFAULT_VARIANTS);
  const states = list(opts, 'states', ['playing', 'paused']);
  const restoreVariant = opts.get('restore-variant');
  for (const v of restoreVariant === undefined ? variants : [...variants, restoreVariant]) {
    if (!(KNOWN_VARIANTS as readonly string[]).includes(v)) throw new Error(`variante desconhecida: ${v} (${KNOWN_VARIANTS.join(', ')})`);
    variantSpec(v);
  }
  for (const s of states) if (s !== 'playing' && s !== 'paused') throw new Error(`estado desconhecido: ${s}`);
  const prepOpts = { uiOnly: opts.has('ui-only'), repeat: !opts.has('no-repeat') };
  /** `--restore-states paused`: toques de restaurar só nesses estados (tocando, o Repeat "Chapter" já dá a volta). */
  const restoreStates = opts.has('restore-states') ? list(opts, 'restore-states', []) : undefined;
  const rec = new Recorder(label, true);
  const session = await connect(rec);
  const ctx = prepCtx(session, rec);
  try {
    const probed = variants.some((v) => v !== 'ui') ? await probe(session, rec) : {};
    const available = (v: string): string | null => {
      const letter = probeLetter(v);
      if (letter === null) return null;
      const info = ((probed['variants'] as Json | undefined)?.[letter] ?? {}) as Json;
      return info['available'] === true ? null : String(info['reason'] ?? 'indisponível');
    };
    if (restoreVariant !== undefined && available(restoreVariant) !== null) {
      throw new Error(`--restore-variant ${restoreVariant} indisponível: ${available(restoreVariant)}`);
    }
    const runnable = variants.filter((v) => available(v) === null);
    for (const v of variants.filter((x) => available(x) !== null)) rec.write('skip-variant', { variant: v, why: available(v) });

    say(rec, 'SP-3: preparando o Hagah sozinho. Não precisa mexer no iPhone.', { step: 'intro' });
    const { prepared, targets: found } = await prepare(ctx, prepOpts);
    // `--repeat-before <modo>`: o modo do Repeat de antes de um preparo anterior (ex.: `prepare --keep`), para o fim o devolver.
    const before = opts.get('repeat-before');
    if (before !== undefined && before !== 'true') Object.assign(prepared, { repeatBefore: before, repeatChanged: before !== 'Chapter' || prepared.repeatChanged });
    const targets: Targets = opts.has('targets')
      ? (JSON.parse(readFileSync(opts.get('targets') as string, 'utf8')) as Targets)
      : found;
    const log = logReader(session.log);
    rec.write('start', {
      bundleId: session.bundleId, n, variants: runnable, skipped: variants.filter((v) => !runnable.includes(v)), states, restoreVariant,
      log: session.log, configuration: session.configuration, capabilities: session.capabilities, targets, prepared,
    });
    const io = {
      now,
      sleep,
      logSize: log.size,
      readLog: log.read,
      write: (k: string, data: Json) => rec.write(k, data),
      saveLog: (name: string, text: string) => writeFileSync(rec.file(`${name}.log`), text),
      drain: () => drainQueue(ctx),
    };

    // O estado pedido na fileira do transporte, só com `health` (fila de controle) e `ui.find` — com o Hagah tocando, o
    // `ui.tree` não cabe no prazo. Se o áudio parou ou a folha fechou, refaz o preparo (e os alvos). Três tentativas;
    // depois, o dono. O Salmo 23 fica garantido pelo Repeat "Chapter" (e o relógio do efeito mostra a posição).
    const ensure = async (want: 'playing' | 'paused'): Promise<void> => {
      for (let attempt = 0; ; attempt++) {
        const health = await session.rpc.call<{ foregroundApp: string; locked: boolean }>('health', {}, { timeoutMs: 3_000 });
        const reason = ownerReason(health, session.bundleId);
        if (reason !== null) throw new OwnerNeeded('owner', reason);
        const state = await audioState(ctx, targetY(targets));
        if (state === want) return;
        if (attempt >= 3) throw new OwnerNeeded('heal', `não consegui deixar o Salmo 23 ${want === 'playing' ? 'tocando' : 'pausado'} no Now Playing`);
        rec.write('heal', { want, attempt, state });
        const again = await prepare(ctx, { ...prepOpts, previous: prepared });
        Object.assign(targets, again.targets);
        if (want === 'paused') await autoPause(ctx, targetY(targets));
      }
    };

    say(rec, `SP-3 medindo: ${n} toques por variante, ${runnable.length} variantes.`, { step: 'measure' });
    let seq = 1;
    for (const state of states as ('playing' | 'paused')[]) {
      if (state === 'paused') {
        if (!(await autoPause(ctx, targetY(targets)))) await ensure('paused');
        // Pausado, o "avançar" para no fim do capítulo (0:46): volta ao começo antes, e cada toque medido é seguido do de
        // voltar 15 s (`--restore-states paused`), para todo salto aparecer no relógio.
        if (targets.restore !== undefined) {
          for (let i = 0; i < 4; i++) {
            await drainQueue(ctx);
            await session.rpc.call('ui.tap', { target: targets.restore.target }, { timeoutMs: 30_000 }).catch((error: unknown) => rec.write('rewind', { err: errCode(error) }));
          }
          rec.write('rewind', { taps: 4 });
        }
      }
      for (const variant of runnable) {
        await drain(session, rec);
        await ensure(state);
        const result = await runPhase(session.rpc, io, targets, {
          state, variant, n, seqStart: seq,
          check: async () => {
            await ensure(state);
            return true;
          },
          gapMs: num(opts, 'gap-ms', 700),
          settleMs: num(opts, 'settle-ms', 3_000),
          pressMs: num(opts, 'press-ms', 50),
          effectTimeoutMs: num(opts, 'effect-timeout-ms', 3_000),
          restore: !opts.has('no-restore') && (restoreStates === undefined || restoreStates.includes(state)),
          effect: !opts.has('no-effect'),
          slowMs: num(opts, 'slow-ms', 25_000),
          ...(restoreVariant === undefined ? {} : { restoreVariant }),
        });
        seq = result.nextSeq;
        console.log(`${state}/${variant}: ${result.measured - result.errors}/${result.measured} ok, "Wait for … to idle" = ${result.logCounts['waitForTargetIdle'] ?? 0}${result.stopped === null ? '' : `, parou: ${result.stopped}`}`);
      }
    }
    await drain(session, rec);
    await finish(ctx, prepared, targetY(targets));
    rec.write('end', { reconnects: session.link.reconnects });
    say(rec, 'SP-3 terminado. O áudio do Hagah ficou pausado.', { step: 'end' });
  } finally {
    await session.link.close();
  }
  cmdAnalyze(label);
}

// ---------------------------------------------------------------------------------------------------------
// Repetição curta no estado pesado (`heavy`): o Hagah frio (fechado e reaberto pelo link), play e LOGO os toques.

/** A altura do transporte do Now Playing agora (pelo `ui.find` do "Forward 15 seconds"); `undefined` se não está na tela. */
async function transportY(ctx: PrepCtx): Promise<{ y: number; frame: FindCandidate['frame'] } | undefined> {
  try {
    const found = await ctx.rpc.call<{ candidates: FindCandidate[] }>('ui.find', { target: { label: 'Forward 15 seconds', type: 'button' } },
      { timeoutMs: 20_000 });
    const c = found.candidates.find((x) => x.hittable);
    return c === undefined ? undefined : { y: c.frame.y + c.frame.h / 2, frame: c.frame };
  } catch (error) {
    if (isContrarregraError(error, 'E_TIMEOUT')) await drainQueue(ctx);
    return undefined;
  }
}

/** Um `ui.tree` cronometrado; se estourar o prazo (5 s), a duração real é até a fila esvaziar (sondada a 250 ms). */
async function timeTree(ctx: PrepCtx, rec: Recorder, state: string, when: string): Promise<void> {
  await drainQueue(ctx);
  const t0 = Date.now();
  let nodes: number | undefined;
  let err: string | undefined;
  try {
    const result = await ctx.rpc.call<{ nodes: TreeNode[] }>('ui.tree', { format: 'json', visibleOnly: true }, { timeoutMs: 15_000 });
    nodes = flatten(result.nodes).length;
  } catch (error) {
    err = errCode(error);
  }
  const replyMs = Date.now() - t0;
  let drainedMs = replyMs;
  if (err !== undefined) {
    for (let i = 0; i < 480; i++) {
      const health = await ctx.rpc.call<{ xctestQueueDepth: number }>('health', {}, { timeoutMs: 3_000 }).catch(() => ({ xctestQueueDepth: 1 }));
      if (health.xctestQueueDepth === 0) break;
      await sleep(250);
    }
    drainedMs = Date.now() - t0;
  }
  rec.write('uitree', { state, when, ok: err === undefined, replyMs, drainedMs, ...(nodes === undefined ? {} : { nodes }), ...(err === undefined ? {} : { err }) });
  console.log(`ui.tree ${state}/${when}: ${err === undefined ? `${replyMs} ms (${nodes} nós)` : `${err.split(':')[0]} — fila livre em ${drainedMs} ms`}`);
}

async function cmdHeavy(opts: Map<string, string>): Promise<void> {
  const label = opts.get('label') ?? 'sp3-heavy';
  const nD = num(opts, 'n-d', 20);
  const nCoord = num(opts, 'n-coord', 5);
  const prepOpts = { uiOnly: false, repeat: true };
  const rec = new Recorder(label, true);
  const session = await connect(rec);
  const ctx = prepCtx(session, rec);
  try {
    const probed = await probe(session, rec);
    const variants = (probed['variants'] ?? {}) as Json;
    for (const letter of ['a', 'd']) {
      if ((variants[letter] as Json | undefined)?.['available'] !== true) throw new Error(`a variante ${letter} não está disponível: ${JSON.stringify(variants[letter])}`);
    }
    say(rec, 'SP-3, repetição curta: o Hagah vai fechar e reabrir sozinho. Não precisa mexer no iPhone.', { step: 'intro' });

    // 1) Preparo normal: Repeat "Chapter" (fica gravado no app) e os alvos.
    const { prepared, targets } = await prepare(ctx, prepOpts);
    rec.write('start', { bundleId: session.bundleId, mode: 'heavy', nD, nCoord, log: session.log, configuration: session.configuration, targets, prepared });

    // 2) Frio: fecha o Hagah, reabre pelo link, abre o Now Playing e dá play.
    await drainQueue(ctx);
    const cold: Json = {};
    const timed = async (name: string, fn: () => Promise<unknown>): Promise<void> => {
      const t0 = Date.now();
      try {
        await fn();
        cold[name] = Date.now() - t0;
      } catch (error) {
        cold[name] = `${Date.now() - t0} ms, ${errCode(error)}`;
        if (isContrarregraError(error, 'E_TIMEOUT')) await drainQueue(ctx);
      }
    };
    await timed('terminate', () => session.rpc.call('app.terminate', { bundleId: session.bundleId }, { timeoutMs: 30_000 }));
    await sleep(2_000);
    await timed('openURL', () => session.rpc.call('app.openURL', { url: PSALM23_LINK }, { timeoutMs: 30_000 }));
    const tOpen = Date.now();
    let foreground = false;
    while (!foreground && Date.now() - tOpen < 20_000) {
      const st = await session.rpc.call<{ state: string }>('app.state', { bundleId: session.bundleId }, { timeoutMs: 15_000 }).catch(() => ({ state: '?' }));
      foreground = st.state === 'foreground';
      if (!foreground) await sleep(500);
    }
    cold['foregroundMs'] = Date.now() - tOpen;
    if (!foreground) throw new OwnerNeeded('cold', 'o Hagah não voltou à frente depois do link');
    let transport: Awaited<ReturnType<typeof transportY>>;
    const tNp = Date.now();
    for (let attempt = 0; attempt < 10 && transport === undefined; attempt++) {
      await tapFound(ctx, 'open-now-playing', { labelPrefix: 'Open Now Playing', type: 'button' }, (c) => c.findIndex((x) => x.hittable));
      await sleep(1_500);
      transport = await transportY(ctx);
    }
    cold['nowPlayingMs'] = Date.now() - tNp;
    if (transport === undefined) throw new OwnerNeeded('cold', 'o Now Playing não abriu depois de reabrir o Hagah');
    targets.measure.frame = transport.frame;
    const tPlay = Date.now();
    if (!(await toggleAudio(ctx, 'playing', transport.y))) throw new OwnerNeeded('cold', 'o áudio não começou a tocar depois de reabrir o Hagah');
    cold['playMs'] = Date.now() - tPlay;
    rec.write('cold', cold);
    console.log(`frio: ${JSON.stringify(cold)}`);

    const log = logReader(session.log);
    const io = {
      now,
      sleep,
      logSize: log.size,
      readLog: log.read,
      write: (k: string, data: Json) => rec.write(k, data),
      saveLog: (name: string, text: string) => writeFileSync(rec.file(`${name}.log`), text),
      drain: () => drainQueue(ctx),
    };
    const phase = async (state: 'playing' | 'paused', variant: string, n: number, seqStart: number): Promise<number> => {
      const result = await runPhase(session.rpc, io, targets, {
        state, variant, n, seqStart, gapMs: 700, settleMs: 3_000, pressMs: 50, effectTimeoutMs: 3_000,
        restore: state === 'paused', restoreVariant: 'd', effect: true, slowMs: 45_000,
      });
      console.log(`${state}/${variant}: ${result.measured - result.errors}/${result.measured} ok${result.stopped === null ? '' : `, parou: ${result.stopped}`}`);
      return result.nextSeq;
    };

    // 3) Tocando, logo depois do play.
    let seq = 1;
    await timeTree(ctx, rec, 'playing', 'start');
    seq = await phase('playing', 'd', nD, seq);
    seq = await phase('playing', 'a.coord', nCoord, seq);
    await timeTree(ctx, rec, 'playing', 'end');

    // 4) Pausado (com o toque de voltar 15 s depois de cada medido, e volta ao começo antes).
    await drainQueue(ctx);
    if (!(await autoPause(ctx, transport.y))) throw new OwnerNeeded('pause', 'não consegui pausar o áudio');
    for (let i = 0; i < 4 && targets.restore !== undefined; i++) {
      await drainQueue(ctx);
      await session.rpc.call('ui.tap', { target: targets.restore.target }, { timeoutMs: 30_000 }).catch((error: unknown) => rec.write('rewind', { err: errCode(error) }));
    }
    await timeTree(ctx, rec, 'paused', 'start');
    seq = await phase('paused', 'd', nD, seq);
    seq = await phase('paused', 'a.coord', nCoord, seq);
    await timeTree(ctx, rec, 'paused', 'end');

    await drainQueue(ctx);
    await finish(ctx, prepared, transport.y);
    rec.write('end', { reconnects: session.link.reconnects });
    say(rec, 'SP-3 terminado. O áudio do Hagah ficou pausado.', { step: 'end' });
  } finally {
    await session.link.close();
  }
  cmdAnalyze(label);
  const text = readFileSync(join(OUT, `${label}.ndjson`), 'utf8');
  console.log(`\n${heavyReport(text.split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l) as Json))}`);
}

function cmdAnalyze(label: string): void {
  const text = readFileSync(join(OUT, `${label}.ndjson`), 'utf8');
  const rows = text.split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l) as Json);
  const summary = summarize(label, rows);
  writeFileSync(join(OUT, `${label}-summary.json`), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(markdownTable(summary));
  console.log(`\nsucesso (T-0.18): ${summary.success ? `sim — ${summary.passing.join(', ')}` : 'não'}`);
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const opts = args(rest);
  switch (command) {
    case 'probe':
      await cmdProbe(opts);
      break;
    case 'prepare':
      await cmdPrepare(opts);
      break;
    case 'discover':
      await cmdDiscover(opts);
      break;
    case 'run':
      await cmdRun(opts);
      break;
    case 'heavy':
      await cmdHeavy(opts);
      break;
    case 'analyze':
      cmdAnalyze(opts.get('label') ?? '');
      break;
    default:
      console.error('uso: sp3.ts probe|prepare|discover|run|heavy|analyze --label <l> …');
      process.exitCode = 2;
  }
}

main().then(
  () => process.exit(process.exitCode ?? 0),
  (error: unknown) => {
    if (error instanceof OwnerNeeded) {
      // Só aqui o dono é chamado: o que exige uma pessoa, com o que se viu na tela.
      console.log(`OWNER_ACTION ${JSON.stringify({ step: error.step, text: error.message, seen: error.seen })}`);
      say(undefined, `SP-3 parado: ${error.message}.`, {});
      setTimeout(() => process.exit(3), 4_000);
      return;
    }
    console.error(`sp3: ${errCode(error)}`);
    process.exit(1);
  },
);
