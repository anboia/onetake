// Driver do SP-5 parte 1 (T-0.20; S9 itens 1, 3 e 6; ADR-4, ADR-14; AC-9.3 parcial, AC-9.7; ⏳ Q-8): a fonte do iPhone
// no OBS 31.1.2 (perfil "Contrarregra"), o áudio do iPhone, uma gravação de 10 min e o "chute" da fonte. Código de
// spike, descartável (architecture.md A5); usa as peças de `mac/src` (cliente do OBS com a guarda do perfil, ffmpeg
// fixado, cliente JSON-RPC do runner, decodificador do relógio de S0.10) e só métodos que o runner já tem.
//
// Regras (tasks.md "Regras comuns" dos spikes; S9; P-6, P-7):
// - Todo pedido que escreve no OBS passa pela guarda do `ObsClient` (perfil e coleção "Contrarregra"); o spike nunca
//   troca de perfil, nunca mexe em parâmetro de perfil/vídeo/codificador; muda só os ajustes da fonte "iPhone", a
//   pasta de gravação e uma fonte temporária própria ("SP-5 Capture Card") — tudo devolvido no fim de cada fase (e no
//   SIGINT) a partir do instantâneo gravado em `out/<label>-snapshot.json` ANTES da primeira escrita (`restore`
//   refaz a devolução por ele).
// - Gravações só em ~/Movies/contrarregra/spikes/SP-5/, cada uma conferida contra HC-11 antes (livre ≥
//   max(disk.minFreeGiB, 3 × estimativa + 2 GiB), estimativa de S9 item 4) e apagada logo depois de medida, só se for
//   gravação deste spike (caminho, nome novo, criada depois do StartRecord); o nome vai para `out/<label>-files.ndjson`
//   e para o SP-5.md. Nunca apaga pasta nem nada recursivo.
// - ffmpeg/ffprobe só pelo 8.1.1 de `paths.*` (`openFfmpeg`). A senha do OBS só pelo Chaveiro, na memória (nunca
//   impressa; nunca o `config.json` do obs-websocket). O microfone do Mac (alto-falante do iPhone) só com
//   `--speaker mic`, depois do sim do dono, e só na memória.
// - Nunca instala, sobe nem derruba o runner (o orquestrador roda `contrarregra runner up`). O runner opera só o Hagah
//   (`app.explore`) e o hospedeiro (fora de tomada). `OWNER_ACTION {...}` na saída padrão só para o que é humano.
//
// Uso (Node 22 ≥ 22.18, TypeScript direto; ver spikes/SP-5.md):
//   node spikes/sp-5/sp5.ts probe   --label <l>                       (só leitura: OBS, disco, sessão do runner, registro)
//   node spikes/sp-5/sp5.ts configs --label <l> [--configs high,format60,capturecard,preset4k] [--seconds 8] [--frames 30]
//   node spikes/sp-5/sp5.ts audio   --label <l> [--play-s 45] [--toggles 16] [--speaker human|mic|skip] [--mic-s 20]
//   node spikes/sp-5/sp5.ts long    --label <l> [--minutes 10] [--screen host|hagah] [--no-audio] [--no-decode-clock]
//   node spikes/sp-5/sp5.ts kick    --label <l> [--mode restart|cable|replug] [--trials 5] [--observe-s 5]
//   node spikes/sp-5/sp5.ts restore --label <l>                       (devolve pelo instantâneo de <l>)
//   node spikes/sp-5/sp5.ts report  --labels <l1,l2,…>                (tabelas para o SP-5.md)
// Saída: out/<label>.ndjson (uma linha por evento), <label>-snapshot.json, <label>-files.ndjson, <label>-summary.json
// (pasta fora do git). Códigos de saída: 0 = medido (o veredicto está no resumo); 1 = erro; 2 = disco abaixo do HC-11
// (nada gravado); 4 = `OWNER_ACTION` (algo humano); 5 = OBS fora do perfil/coleção "Contrarregra" ou fora do conjunto
// validado; 6 = a devolução não fechou (conferir o OBS antes de qualquer outra coisa). Parar só com `kill -INT`.

import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, statfsSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { decodeClockVideo } from '../../mac/src/clock/code.ts';
import { loadConfig, type Config } from '../../mac/src/core/config.ts';
import { isContrarregraError } from '../../mac/src/core/errors.ts';
import { ObsClient, obsClientOptions } from '../../mac/src/obs/client.ts';
import { openFfmpeg, type Ffmpeg } from '../../mac/src/media/ffmpeg.ts';
import { openRunner, type RunnerConnection } from '../../mac/src/runner/client.ts';
import { runnerPaths } from '../../mac/src/runner/paths.ts';
import { currentSession, sessionAlive } from '../../mac/src/runner/session.ts';
import { OwnerNeeded, finish, prepare, showHost, tapToggle, type PrepCtx, type Prepared } from './hagah.ts';
import {
  CANVAS,
  CLOCK_LAYOUT,
  CONFIGS,
  CROP_LEFT_PX,
  DEFAULT_CONFIGS,
  KICK,
  NATIVE,
  PALETTE_REF,
  PX_PER_PT,
  avVerdict,
  base64Image,
  clockStats,
  colorVerdict,
  decodePng,
  deviceRef,
  envelope,
  estimateBytes,
  findAudioEdge,
  findFlip,
  fmt,
  frameColor,
  gib,
  kickVerdict,
  longVerdict,
  markdownTable,
  maxXcorr,
  peakVerdict,
  pickFormat,
  ptToPx,
  requiredFreeBytes,
  resolveDevice,
  rmsDb,
  scanObsLog,
  speakerVerdict,
  summarizeColor,
  toDb,
  windowStats,
  type AvEvent,
  type ColorRef,
  type FrameColor,
  type Json,
  type KickTrial,
  type ProbeInfo,
} from './lib.ts';
import { grayWindow, listAudioDevices, pcmMono, pickBuiltInMic, probe, probeOk, recordMic, rgbFrames } from './media.ts';
import {
  DiskLowError,
  applyConfig,
  defaultObsLogDir,
  discard,
  errCode,
  hasFrames,
  isNativeLive,
  itemIdOf,
  kick,
  listProperty,
  liveState,
  newestLog,
  pollUntil,
  readFrom,
  readSnapshot,
  realObsProcess,
  record,
  restore,
  sourceShot,
  type Obs,
  type ObsSnapshot,
  type ObsTargets,
  type Recording,
  type RecordingControl,
} from './obs.ts';

const OUT = join(dirname(fileURLToPath(import.meta.url)), 'out');
const SPIKE_DIR = join(homedir(), 'Movies', 'contrarregra', 'spikes', 'SP-5');
const OBS_LOGS = defaultObsLogDir(homedir());
const VOICE = 'Luciana';
const EXIT = { error: 1, disk: 2, owner: 4, obsConfig: 5, restore: 6 } as const;

function now(): number {
  return Math.round((performance.timeOrigin + performance.now()) * 10) / 10;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const clock = { now, sleep };

// ---------------------------------------------------------------------------------------------------------
// Registro (out/, fora do git), voz e dono

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

  save(suffix: string, value: unknown): void {
    writeFileSync(this.file(suffix), `${JSON.stringify(value, null, 2)}\n`);
  }

  /** Cada gravação criada e apagada (G4; os nomes vão para o SP-5.md). */
  ledger(row: Json): void {
    appendFileSync(this.file('files.ndjson'), `${JSON.stringify({ at: new Date().toISOString(), ...row })}\n`);
    this.write('file', row);
  }
}

const voices = new Set<Promise<void>>();

/** Fala no alto-falante do Mac (`alerts.sayDevice`; o OBS não grava o áudio do Mac). */
function say(rec: Recorder, config: Config, text: string): Promise<void> {
  rec.write('say', { text });
  const child = spawn('/usr/bin/say', ['-v', VOICE, '-a', config.alerts.sayDevice, text], { stdio: 'ignore' });
  const done = new Promise<void>((resolve) => {
    child.once('exit', () => resolve());
    child.once('error', () => resolve());
  });
  voices.add(done);
  void done.then(() => voices.delete(done));
  return done;
}

class OwnerAction extends Error {
  readonly payload: Json;
  constructor(payload: Json) {
    super(String(payload['text'] ?? 'ação do dono'));
    this.payload = payload;
  }
}

let interrupted = false;

function onSignals(handler: () => void): () => void {
  const fn = (): void => {
    interrupted = true;
    handler();
  };
  process.on('SIGINT', fn);
  process.on('SIGTERM', fn);
  return () => {
    process.off('SIGINT', fn);
    process.off('SIGTERM', fn);
  };
}

// ---------------------------------------------------------------------------------------------------------
// Argumentos

export interface Args {
  cmd: string;
  label: string;
  labels: string[];
  configs: string[];
  seconds: number;
  frames: number;
  playS: number;
  toggles: number;
  speaker: 'human' | 'mic' | 'skip';
  micS: number;
  minutes: number;
  screen: 'host' | 'hagah';
  audio: boolean;
  decodeClock: boolean;
  mode: 'restart' | 'cable' | 'replug';
  trials: number;
  observeS: number;
}

export function parseArgs(argv: string[]): Args {
  const [cmd = '', ...rest] = argv;
  const flags = new Map<string, string>();
  const bools = new Set<string>();
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (!a.startsWith('--')) throw new Error(`argumento solto: ${a}`);
    const next = rest[i + 1];
    if (next === undefined || next.startsWith('--')) bools.add(a.slice(2));
    else {
      flags.set(a.slice(2), next);
      i++;
    }
  }
  const numFlag = (name: string, def: number): number => {
    const v = flags.get(name);
    if (v === undefined) return def;
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`--${name} inválido: ${v}`);
    return n;
  };
  const choice = <T extends string>(name: string, options: readonly T[], def: T): T => {
    const v = flags.get(name) ?? def;
    if (!options.includes(v as T)) throw new Error(`--${name} deve ser ${options.join('|')}`);
    return v as T;
  };
  const configs = (flags.get('configs') ?? DEFAULT_CONFIGS.join(',')).split(',').filter((c) => c !== '');
  for (const c of configs) if (CONFIGS[c] === undefined) throw new Error(`configuração desconhecida: ${c} (conhecidas: ${Object.keys(CONFIGS).join(', ')})`);
  const label = flags.get('label') ?? '';
  if (cmd !== 'report' && cmd !== '' && !/^[A-Za-z0-9._-]+$/.test(label)) throw new Error('--label <rótulo> é obrigatório ([A-Za-z0-9._-])');
  return {
    cmd,
    label,
    labels: (flags.get('labels') ?? '').split(',').filter((l) => l !== ''),
    configs,
    seconds: numFlag('seconds', 8),
    frames: numFlag('frames', 30),
    playS: numFlag('play-s', 45),
    toggles: numFlag('toggles', 16),
    speaker: choice('speaker', ['human', 'mic', 'skip'] as const, 'human'),
    micS: numFlag('mic-s', 20),
    minutes: numFlag('minutes', 10),
    screen: choice('screen', ['host', 'hagah'] as const, 'host'),
    audio: !bools.has('no-audio'),
    decodeClock: !bools.has('no-decode-clock'),
    mode: choice('mode', ['restart', 'cable', 'replug'] as const, 'restart'),
    trials: numFlag('trials', KICK.trials),
    observeS: numFlag('observe-s', 5),
  };
}

// ---------------------------------------------------------------------------------------------------------
// Conexões

function targets(config: Config): ObsTargets {
  return { scene: config.obs.scene, source: config.obs.source, deviceName: config.device.name };
}

async function connectObs(config: Config, rec: Recorder): Promise<ObsClient> {
  const client = await ObsClient.connect(obsClientOptions(config, { log: (line) => rec.write('obs-log', { line }) }));
  return client;
}

/** Recusa seguir fora do perfil/coleção "Contrarregra" (a guarda recusaria cada escrita; aqui, nem começa). */
function assertContrarregra(snap: ObsSnapshot, config: Config): void {
  if (snap.profile !== config.obs.profile || snap.collection !== config.obs.collection) {
    throw new ProfileError(`o OBS está no perfil "${snap.profile}" e na coleção "${snap.collection}"; o SP-5 só roda no "${config.obs.profile}"/"${config.obs.collection}" (P-6). Nada foi escrito`);
  }
}

class ProfileError extends Error {}

function prepCtx(rpc: RunnerConnection, config: Config, rec: Recorder): PrepCtx {
  const bundleId = config.app.explore;
  if (bundleId === undefined) throw new Error('app.explore (o Hagah) não está no config.json');
  return { rpc, bundleId, write: (k, data) => rec.write(k, data), now, sleep };
}

async function openFf(config: Config): Promise<Ffmpeg> {
  return openFfmpeg(config);
}

function freeBytes(dir: string): Promise<number> {
  const st = statfsSync(dir);
  return Promise.resolve(Number(st.bavail) * Number(st.bsize));
}

/** Cria a pasta do spike (só ela) e devolve o caminho real. */
function spikeDir(): string {
  mkdirSync(SPIKE_DIR, { recursive: true });
  return realpathSync(SPIKE_DIR);
}

/** O registro do OBS a partir de agora: o arquivo mais recente e o tamanho dele (as linhas novas vêm depois). */
function logMark(): { path: string; offset: number } | null {
  const latest = newestLog(OBS_LOGS);
  return latest === null ? null : { path: latest.path, offset: latest.size };
}

function logSince(mark: { path: string; offset: number } | null): string {
  if (mark === null) return '';
  try {
    return readFrom(mark.path, mark.offset);
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------------------------------------
// Sessão de OBS com devolução garantida

interface ObsSession {
  config: Config;
  rec: Recorder;
  obs: ObsClient;
  t: ObsTargets;
  snap: ObsSnapshot;
  dir: string;
  deviceValue: string;
}

/**
 * Conecta, confere o perfil, grava o instantâneo ANTES de escrever, aponta a gravação para a pasta do spike, garante a
 * fonte viva e roda `fn`; no fim (e no SIGINT), para uma gravação ativa, devolve tudo e confere. Devolução que não
 * fecha → código 6.
 */
async function withObs<T>(config: Config, rec: Recorder, fn: (s: ObsSession) => Promise<T>): Promise<T> {
  const obs = await connectObs(config, rec);
  const t = targets(config);
  let restoreFailed = false;
  try {
    const snap = await readSnapshot(obs, t);
    rec.save('snapshot.json', snap);
    rec.write('snapshot', { profile: snap.profile, collection: snap.collection, settings: snap.source.settings, recordDirectory: snap.recordDirectory });
    assertContrarregra(snap, config);
    if (snap.record.outputActive) throw new Error('o OBS já está gravando: o SP-5 não começa com uma gravação em curso');
    const deviceValue = snap.device.value;
    if (deviceValue === null) throw new OwnerAction({ step: 'device', text: `o iPhone "${t.deviceName}" não está na lista de dispositivos do OBS: confira o cabo e o iPhone destravado` });
    const dir = spikeDir();
    const off = onSignals(() => rec.write('signal', {}));
    try {
      await obs.request('SetRecordDirectory', { recordDirectory: dir });
      rec.write('record-directory', { dir });
      const live = await pollUntil(() => liveState(obs, t.scene, t.source, snap.source.itemId), isNativeLive, 5_000, 500, clock);
      if (!live.ok) {
        await kick(obs, t.source, deviceValue, 'plain');
        const again = await pollUntil(() => liveState(obs, t.scene, t.source, snap.source.itemId), isNativeLive, 15_000, 500, clock);
        rec.write('initial-kick', { ok: again.ok, ms: again.ms, state: again.last });
        if (!again.ok) throw new OwnerAction({ step: 'source', text: 'a fonte do iPhone não ficou viva nem com o chute: confira o cabo e o iPhone destravado', state: again.last });
      }
      return await fn({ config, rec, obs, t, snap, dir, deviceValue });
    } finally {
      off();
      try {
        const status = await obs.request<{ outputActive: boolean }>('GetRecordStatus');
        if (status.data.outputActive) {
          await obs.request('StopRecord');
          rec.write('emergency-stop', {});
        }
      } catch (error) {
        rec.write('emergency-stop', { err: errCode(error) });
      }
      const report = await restore(obs, t, snap, clock, (k, data) => rec.write(k, data ?? {}));
      rec.write('restore-report', { ...report });
      rec.save('restore.json', report);
      restoreFailed = report.errors.length > 0 || !report.settingsEqual || !report.live;
      if (restoreFailed) console.error(`DEVOLUÇÃO INCOMPLETA: ${JSON.stringify(report)}`);
    }
  } finally {
    await obs.close();
    if (restoreFailed) process.exitCode = EXIT.restore;
  }
}

function recordDeps(rec: Recorder, ff: Ffmpeg): Parameters<typeof record>[2] {
  return { freeBytes, probeOk: (file) => probeOk(ff, file), now, sleep, log: (k, data) => rec.write(k, data ?? {}) };
}

/** Apaga a gravação depois de medida e registra o nome (G4). */
function drop(rec: Recorder, recording: Recording, dir: string): void {
  const gone = discard(recording, dir);
  rec.ledger({ event: 'deleted', name: gone.name, bytes: gone.bytes });
}

/** Gravação com registro no livro de arquivos e apagada mesmo quando a medida falha. */
async function recordAndMeasure<T>(s: ObsSession, ff: Ffmpeg, opts: Omit<Parameters<typeof record>[1], 'dir' | 'bitrateKbps' | 'minFreeGiB' | 'criticalGiB'>,
  measure: (r: Recording) => Promise<T>): Promise<T> {
  let recording: Recording | undefined;
  try {
    recording = await record(s.obs, {
      ...opts,
      dir: s.dir,
      bitrateKbps: s.config.record.bitrateKbps,
      minFreeGiB: s.config.disk.minFreeGiB,
      criticalGiB: s.config.disk.criticalGiB,
      stopRequested: () => interrupted,
    }, recordDeps(s.rec, ff));
  } catch (error) {
    const partial = (error as { recording?: Recording }).recording;
    if (partial !== undefined) {
      s.rec.ledger({ event: 'created', name: partial.name, bytes: partial.sizeBytes });
      drop(s.rec, partial, s.dir);
    }
    throw error;
  }
  s.rec.ledger({ event: 'created', name: recording.name, bytes: recording.sizeBytes, disk: { freeGiB: gib(recording.disk.freeBytes), requiredGiB: gib(recording.disk.requiredBytes), estimateGiB: gib(recording.disk.estimateBytes) } });
  try {
    return await measure(recording);
  } finally {
    drop(s.rec, recording, s.dir);
  }
}

// ---------------------------------------------------------------------------------------------------------
// probe (só leitura)

/** Os pedidos do obs-websocket que as fases usam (o probe confere que o OBS os oferece). */
const USED_REQUESTS = [
  'GetRecordDirectory', 'SetRecordDirectory', 'GetRecordStatus', 'StartRecord', 'StopRecord', 'GetOutputStatus', 'GetStats',
  'GetInputSettings', 'SetInputSettings', 'GetInputPropertiesListPropertyItems', 'GetSceneItemId', 'GetSceneItemTransform',
  'SetSceneItemTransform', 'GetSourceScreenshot', 'CreateInput', 'RemoveInput', 'GetInputList', 'GetInputDefaultSettings',
];

async function cmdProbe(config: Config, rec: Recorder): Promise<Json> {
  const obs = await connectObs(config, rec);
  let snap: ObsSnapshot;
  let missingRequests: string[];
  try {
    snap = await readSnapshot(obs, targets(config));
    missingRequests = USED_REQUESTS.filter((r) => !obs.versions.availableRequests.includes(r));
  } finally {
    await obs.close();
  }
  const session = currentSession(runnerPaths(config));
  let free = 0;
  for (let dir = SPIKE_DIR; ; dir = dirname(dir)) {
    if (existsSync(dir)) {
      free = await freeBytes(dir);
      break;
    }
    if (dir === dirname(dir)) break;
  }
  const latest = newestLog(OBS_LOGS);
  const scan = latest === null ? null : scanObsLog(readFrom(latest.path, 0));
  const rate = config.record.bitrateKbps;
  const plan = [
    { phase: 'configs', seconds: 8, n: 4 },
    { phase: 'audio', seconds: 45 + 16 * 12, n: 1 },
    { phase: 'long', seconds: 600, n: 1 },
  ].map((p) => {
    const est = estimateBytes(rate, p.seconds);
    return { ...p, estimateGiB: gib(est), requiredGiB: gib(requiredFreeBytes(est, config.disk.minFreeGiB)), okNow: free >= requiredFreeBytes(est, config.disk.minFreeGiB) };
  });
  const summary: Json = {
    obs: {
      versions: snap.versions,
      missingRequests,
      profile: snap.profile,
      collection: snap.collection,
      isContrarregra: snap.profile === config.obs.profile && snap.collection === config.obs.collection,
      programScene: snap.programScene,
      source: { ...snap.source },
      device: snap.device,
      defaults: snap.defaults,
      lists: snap.lists,
      recordDirectory: snap.recordDirectory,
      recording: snap.record.outputActive,
      video: snap.video,
      params: snap.params,
      availableDiskMiB: snap.stats.availableDiskSpace,
      tempInputPresent: snap.tempInputPresent,
      sceneItems: snap.sceneItems,
    },
    disk: { spikeDir: SPIKE_DIR, spikeDirExists: existsSync(SPIKE_DIR), freeGiB: gib(free), plan },
    runner: session === undefined ? null : { sessionId: session.sessionId, configuration: session.configuration, alive: sessionAlive(session) },
    obsLog: latest === null ? null : { file: latest.path.slice(latest.path.lastIndexOf('/') + 1), counts: scan?.counts, lines: scan?.lines.filter((l) => /avcapture|device|Preset|fourcc|resolution|fps/i.test(l)) },
  };
  rec.save('probe.json', summary);
  return summary;
}

// ---------------------------------------------------------------------------------------------------------
// configs: as quatro configurações da fonte e a cor

interface ConfigResult {
  config: string;
  label: string;
  applied: boolean;
  why?: string;
  format?: { name: string; value: unknown } | null;
  live: { ok: boolean; ms: number; kicked: boolean; w: number; h: number };
  native: boolean;
  /** Cor na fonte do OBS (GetSourceScreenshot nativo) e no arquivo gravado. */
  sourceColor?: { measured: Json; vsDevice: Json; vsPalette: Json };
  fileColor?: { measured: Json; vsDevice: Json; vsPalette: Json };
  file?: Json;
  logLines: string[];
  ok: boolean;
}

async function cmdConfigs(config: Config, rec: Recorder, args: Args): Promise<Json> {
  const ff = await openFf(config);
  const runner = await openRunner(config, { role: 'control' });
  const ctx = prepCtx(runner, config, rec);
  try {
    await showHost(ctx, config.bundle.host);
    // Referência do aparelho: a captura do próprio iPhone (png nativo), só na memória.
    let ref: ColorRef = PALETTE_REF;
    try {
      const shot = await runner.call<{ image: string }>('screen.shot', { format: 'png', scale: 'native' }, { timeoutMs: 15_000 });
      const img = decodePng(base64Image(shot.image));
      ref = img.width === NATIVE.width ? deviceRef(frameColor(img, 0)) : PALETTE_REF;
      rec.write('device-ref', { ref, w: img.width, h: img.height });
    } catch (error) {
      rec.write('device-ref', { err: errCode(error), fallback: 'palette' });
    }
    const results: ConfigResult[] = [];
    await withObs(config, rec, async (s) => {
      for (const id of args.configs) {
        if (interrupted) break;
        const cfg = CONFIGS[id]!;
        const mark = logMark();
        rec.write('config-start', { config: id });
        // Cada configuração parte dos ajustes do instantâneo (sem sobra da anterior).
        const reset = await restore(s.obs, s.t, s.snap, clock, (k, data) => rec.write(k, data ?? {}), { recordDirectory: false });
        rec.write('config-reset', { ...reset });
        const format = cfg.needsFormat ? pickFormat((await listProperty(s.obs, s.t.source, 'supported_format')).map((i) => i)) : null;
        const result: ConfigResult = { config: id, label: cfg.label, applied: false, live: { ok: false, ms: 0, kicked: false, w: 0, h: 0 }, native: false, logLines: [], ok: false };
        if (cfg.needsFormat && format === null) {
          result.why = 'o OBS não lista nenhum formato para o iPhone (pesquisa capture F9: formato 0×0)';
          result.logLines = scanObsLog(logSince(mark)).lines;
          results.push(result);
          rec.write('config-result', { ...result });
          continue;
        }
        result.format = format;
        const applied = await applyConfig(s.obs, s.t, s.snap, cfg, s.deviceValue, format);
        result.applied = true;
        rec.write('config-applied', { ...applied });
        const read = (): ReturnType<typeof liveState> => liveState(s.obs, s.t.scene, applied.input, applied.itemId);
        // A troca reinicia a sessão de captura sem avisar: espera assentar antes de ler (senão mede a anterior).
        await sleep(2_500);
        let waited = await pollUntil(read, hasFrames, 15_000, 500, clock);
        let kicked = false;
        if (!waited.ok) {
          await kick(s.obs, applied.input, s.deviceValue, 'plain');
          kicked = true;
          waited = await pollUntil(read, hasFrames, 15_000, 500, clock);
        }
        const state = waited.last ?? { w: 0, h: 0, nonBlack: false };
        result.live = { ok: waited.ok, ms: waited.ms, kicked, w: state.w, h: state.h };
        result.native = state.w === NATIVE.width && state.h === NATIVE.height;
        if (waited.ok && result.native) {
          await sleep(1_000);
          const img = await sourceShot(s.obs, applied.input);
          const measured = summarizeColor([frameColor(img, 0, img.width / 390)]);
          result.sourceColor = { measured, vsDevice: { ...colorVerdict(measured, ref) }, vsPalette: { ...colorVerdict(measured, PALETTE_REF) } };
          await recordAndMeasure(s, ff, { durationS: args.seconds }, async (r) => {
            const info = await probe(ff, r.file);
            const frames: FrameColor[] = [];
            const startS = Math.max(0, Math.min(3, info.durationS - args.frames / 60 - 0.5));
            for await (const f of rgbFrames(ff, r.file, { startS, frames: args.frames, width: info.width, height: info.height })) {
              frames.push(frameColor(f, -CROP_LEFT_PX));
            }
            const fileMeasured = summarizeColor(frames);
            result.fileColor = { measured: fileMeasured, vsDevice: { ...colorVerdict(fileMeasured, ref) }, vsPalette: { ...colorVerdict(fileMeasured, PALETTE_REF) } };
            result.file = { name: r.name, width: info.width, height: info.height, fps: info.rFrameRate, pixFmt: info.pixFmt, colorRange: info.colorRange,
              colorSpace: info.colorSpace, colorTransfer: info.colorTransfer, colorPrimaries: info.colorPrimaries, codec: info.videoCodec, profile: info.profile, level: info.level };
          });
        }
        result.logLines = scanObsLog(logSince(mark)).lines;
        const fileOk = result.fileColor !== undefined && (result.fileColor.vsDevice['ok'] as boolean);
        result.ok = result.native && fileOk && result.file?.['width'] === CANVAS.width && result.file?.['height'] === CANVAS.height;
        results.push(result);
        rec.write('config-result', { ...result });
      }
    });
    const summary = { phase: 'configs', ref, results, anyOk: results.some((r) => r.ok) };
    rec.save('summary.json', summary);
    return summary;
  } finally {
    await runner.close();
  }
}

// ---------------------------------------------------------------------------------------------------------
// audio: picos, alto-falante e A/V com o Salmo 23 tocando

interface Toggle {
  kind: 'pause' | 'play';
  beforeMs: number;
  afterMs: number;
  response: Json;
}

async function cmdAudio(config: Config, rec: Recorder, args: Args): Promise<Json> {
  const ff = await openFf(config);
  const runner = await openRunner(config, { role: 'control' });
  const ctx = prepCtx(runner, config, rec);
  let prepared: Prepared | undefined;
  let mic: { index: number; name: string } | null = null;
  if (args.speaker === 'mic') {
    mic = pickBuiltInMic(await listAudioDevices(ff));
    rec.write('mic', { device: mic });
    if (mic === null) throw new Error('não achei o microfone embutido do Mac na lista do AVFoundation');
  }
  try {
    const summary = await withObs(config, rec, async (s) => {
      prepared = await prepare(ctx, { repeat: true, play: true });
      const toggles: Toggle[] = [];
      let micData: { samples: Float32Array; startNs: string; controlAtS: number } | null = null;
      let micError: string | null = null;
      const during = async (ctl: RecordingControl): Promise<void> => {
        // Fala contínua; com --speaker mic, o microfone grava `micS` s (só na memória) e o `say` de controle no fim.
        if (mic !== null) {
          while (ctl.elapsedMs() < 5_000) await sleep(100);
          const startNs = String(process.hrtime.bigint());
          const controlAtS = args.micS - 3;
          const recording = recordMic(ff, mic.index, args.micS);
          recording.catch(() => {});
          await sleep(controlAtS * 1000);
          await say(rec, config, 'Teste de controle do microfone.');
          try {
            micData = { samples: await recording, startNs, controlAtS };
          } catch (error) {
            // Sem permissão de Microfone ou dispositivo ocupado: o alto-falante fica inconclusivo, o resto segue.
            micError = errCode(error);
            rec.write('mic-error', { err: micError });
          }
        } else if (args.speaker === 'human') {
          await say(rec, config, 'Se estiver perto do iPhone: o alto-falante dele deve estar em silêncio agora.');
        }
        while (ctl.elapsedMs() < args.playS * 1000 && !interrupted) await sleep(200);
        let misses = 0;
        for (let i = 0; i < args.toggles && !interrupted; i++) {
          for (const kind of ['pause', 'play'] as const) {
            const before = await ctl.outputMs();
            let response: Json;
            try {
              response = await tapToggle(ctx, kind === 'pause' ? 'Pause' : 'Play', prepared!.toggle.forwardY);
            } catch (error) {
              // O botão esperado não está lá (um toque anterior que estourou o prazo e caiu depois): pula este, sem par.
              if (!(error instanceof OwnerNeeded) || ++misses > 4) throw error;
              rec.write('toggle-miss', { i, kind, err: error.message });
              continue;
            }
            const after = await ctl.outputMs();
            toggles.push({ kind, beforeMs: before.ms, afterMs: after.ms, response });
            rec.write('toggle', { i, kind, beforeMs: before.ms, afterMs: after.ms, response });
            await sleep(kind === 'pause' ? 2_500 : 3_500);
          }
        }
      };
      return recordAndMeasure(s, ff, { durationS: args.playS + args.toggles * 12, during }, async (r) => {
        const info = await probe(ff, r.file);
        const pcm = await pcmMono(ff, r.file, info);
        const windows = windowStats(pcm.samples, pcm.rate, pcm.startR, 1).filter((w) => w.startS < args.playS);
        const peaks = peakVerdict(windows);
        // A/V: borda do áudio (≥ 1 s de silêncio) × virada do ícone, numa janela em volta de cada toque.
        const box = ptToPx(prepared!.toggle.frame, PX_PER_PT, -CROP_LEFT_PX);
        const events: AvEvent[] = [];
        for (const tg of toggles) {
          const fromS = tg.beforeMs / 1000 - 0.3;
          const toS = tg.afterMs / 1000 + 1.5;
          const a = findAudioEdge(pcm.samples, pcm.rate, pcm.startR, Math.round((fromS - pcm.startR) * pcm.rate), Math.round((toS - pcm.startR) * pcm.rate),
            tg.kind === 'pause' ? 'stop' : 'start', 1_000);
          const frames = await grayWindow(ff, r.file, box, fromS, toS - fromS);
          const flip = findFlip(frames);
          const offsetMs = a !== null && flip !== null ? (a.edgeS - flip.ptsS) * 1000 : null;
          events.push({ kind: tg.kind, videoS: flip?.ptsS ?? null, audioS: a?.edgeS ?? null, offsetMs, valid: a !== null && a.valid && flip !== null,
            ...(a === null ? { why: 'sem borda de áudio' } : flip === null ? { why: 'sem virada do ícone' } : a.valid ? {} : { why: `corte fora da fala (${a.soundDb.toFixed(1)} dBFS)` }) });
        }
        const av = avVerdict(events);
        let speaker: Json = { mode: args.speaker, ...(micError === null ? {} : { verdict: 'inconclusive', reason: micError }) };
        if (micData !== null) {
          const m = micData as { samples: Float32Array; startNs: string; controlAtS: number };
          const corrEnd = Math.round((m.controlAtS - 1) * 48_000);
          const micPart = m.samples.subarray(0, Math.max(0, corrEnd));
          const bins = envelope(micPart, 48_000, 10);
          const floorBins = Array.from(envelope(micPart, 48_000, 100)).map((v) => toDb(v)).sort((x, y) => x - y);
          const micFloorDb = floorBins[Math.floor(0.1 * floorBins.length)] ?? -240;
          const controlDb = rmsDb(m.samples, Math.round(m.controlAtS * 48_000), Math.round((m.controlAtS + 2.5) * 48_000));
          const r0 = Number(BigInt(m.startNs) - BigInt(r.startedNs)) / 1e9;
          const capFrom = Math.max(0, Math.round((r0 - 3 - pcm.startR) * pcm.rate));
          const captured = envelope(pcm.samples.subarray(capFrom, capFrom + Math.round((args.micS + 6) * pcm.rate)), pcm.rate, 10);
          const x = maxXcorr(bins, captured, 0, 600);
          const verdict = speakerVerdict({ micFloorDb, controlRiseDb: controlDb - micFloorDb, xcorrR: x.r });
          speaker = { mode: 'mic', device: mic?.name, micFloorDb, controlDb, xcorr: x, ...verdict };
        }
        return {
          phase: 'audio',
          file: { name: r.name, sizeBytes: r.sizeBytes, durationS: info.durationS, audio: info.audio },
          prepared: { route: prepared!.route, repeatChanged: prepared!.repeatChanged, toggle: prepared!.toggle },
          peaks,
          windowsPeakDb: windows.map((w) => Math.round(w.peakDb * 10) / 10),
          av,
          avEvents: events,
          speaker,
          obsSource: { volumeDb: s.snap.source.volumeDb, audioSyncOffsetMs: s.snap.source.audioSyncOffsetMs, monitorType: s.snap.source.monitorType, buffering: s.snap.source.settings['buffering'] ?? null },
        };
      });
    });
    rec.save('summary.json', summary);
    return summary;
  } finally {
    await finishHagah(config, rec, runner, prepared);
  }
}

/** Fim do Hagah (áudio pausado, Repeat devolvido); reabre a conexão com o runner se ela caiu no meio. */
async function finishHagah(config: Config, rec: Recorder, runner: RunnerConnection, prepared: Prepared | undefined): Promise<void> {
  let link: RunnerConnection | null = runner;
  try {
    if (prepared === undefined) return;
    if (!runner.isOpen) link = await openRunner(config, { role: 'control' }).catch((error: unknown) => {
      rec.write('finish', { err: `runner: ${errCode(error)}` });
      return null;
    });
    if (link === null) {
      console.log(`OWNER_ACTION ${JSON.stringify({ step: 'finish', text: 'não consegui pausar o Salmo 23 no Hagah (runner fora do ar): pause o áudio no iPhone' })}`);
      return;
    }
    await finish(prepCtx(link, config, rec), prepared);
  } catch (error) {
    rec.write('finish', { err: errCode(error) });
  } finally {
    await runner.close();
    if (link !== null && link !== runner) await link.close();
  }
}

// ---------------------------------------------------------------------------------------------------------
// long: 10 min a 1168×2532@60 (AC-9.7)

async function cmdLong(config: Config, rec: Recorder, args: Args): Promise<Json> {
  const ff = await openFf(config);
  const runner = await openRunner(config, { role: 'control' });
  const ctx = prepCtx(runner, config, rec);
  let prepared: Prepared | undefined;
  try {
    const summary = await withObs(config, rec, async (s) => {
      if (args.audio) prepared = await prepare(ctx, { repeat: true, play: true });
      if (args.screen === 'host') await showHost(ctx, config.bundle.host);
      const mark = logMark();
      const durationS = args.minutes * 60;
      // Só `health` (fila de controle, nunca a do XCTest) a cada 30 s: a conexão com o runner fica viva para o fim.
      const during = async (ctl: RecordingControl): Promise<void> => {
        while (ctl.elapsedMs() < durationS * 1000 && !interrupted && !ctl.aborted()) {
          await sleep(Math.min(30_000, Math.max(0, durationS * 1000 - ctl.elapsedMs())));
          try {
            const h = await runner.call<Json>('health', {}, { timeoutMs: 3_000 });
            rec.write('health', { elapsedMs: ctl.elapsedMs(), foregroundApp: h['foregroundApp'] ?? null });
          } catch (error) {
            rec.write('health', { elapsedMs: ctl.elapsedMs(), err: errCode(error) });
          }
        }
      };
      return recordAndMeasure(s, ff, { durationS, during }, async (r) => {
        const info: ProbeInfo = await probe(ff, r.file);
        const os = r.outputStatus ?? {};
        const delta = (key: 'renderSkippedFrames' | 'outputSkippedFrames'): number | null =>
          r.statsAfter === null ? null : Number(r.statsAfter[key]) - Number(r.statsBefore[key]);
        const scan = scanObsLog(logSince(mark));
        const skipped = {
          output: typeof os['outputSkippedFrames'] === 'number' ? (os['outputSkippedFrames'] as number) : null,
          renderDelta: delta('renderSkippedFrames'),
          outputDelta: delta('outputSkippedFrames'),
          logEncoding: scan.encodingSkipped,
          logRender: scan.renderLagged,
        };
        const verdict = longVerdict(info, skipped);
        let audio: Json | null = null;
        if (info.audio !== null) {
          const pcm = await pcmMono(ff, r.file, info);
          const windows = windowStats(pcm.samples, pcm.rate, pcm.startR, 1);
          audio = { ...peakVerdict(windows) };
        }
        let clockInfo: Json | null = null;
        if (args.screen === 'host' && args.decodeClock) {
          const values: (number | null)[] = [];
          const o = CLOCK_LAYOUT.gridOriginPt;
          const geometry = { x: o.x * PX_PER_PT - CROP_LEFT_PX, y: o.y * PX_PER_PT, cellPx: CLOCK_LAYOUT.cellPt * PX_PER_PT };
          for await (const f of decodeClockVideo(ff, r.file, geometry)) values.push(f.decode.ok ? f.decode.valueMs : null);
          clockInfo = { ...clockStats(values) };
        }
        return {
          phase: 'long',
          screen: args.screen,
          file: { name: r.name, sizeBytes: r.sizeBytes, finalizeMs: r.finalizeMs, abortedLowDisk: r.abortedLowDisk, disk: { freeGiB: gib(r.disk.freeBytes), requiredGiB: gib(r.disk.requiredBytes) } },
          probe: info,
          outputStatus: r.outputStatus,
          stats: { before: r.statsBefore, after: r.statsAfter },
          skipped,
          ac97: verdict,
          audio,
          clock: clockInfo,
          obsLog: scan.lines,
        };
      });
    });
    rec.save('summary.json', summary);
    return summary;
  } finally {
    await finishHagah(config, rec, runner, prepared);
  }
}

// ---------------------------------------------------------------------------------------------------------
// kick: OBS aberto antes do cabo (ou reaberto) e o "chute" (AC-9.3 parcial)

async function connectRetry(config: Config, rec: Recorder, timeoutMs: number): Promise<{ obs: ObsClient; ms: number }> {
  const start = now();
  for (;;) {
    try {
      return { obs: await connectObs(config, rec), ms: now() - start };
    } catch (error) {
      if (!isContrarregraError(error, 'E_OBS_UNREACHABLE') || now() - start > timeoutMs) throw error;
      await sleep(500);
    }
  }
}

async function waitObsExit(timeoutMs: number): Promise<boolean> {
  const start = now();
  while (now() - start < timeoutMs) {
    if ((await realObsProcess.pids()).length === 0) return true;
    await sleep(500);
  }
  return false;
}

async function deviceListed(obs: Obs, t: ObsTargets): Promise<string | null> {
  return resolveDevice(await listProperty(obs, t.source, 'device'), t.deviceName);
}

async function cmdKick(config: Config, rec: Recorder, args: Args): Promise<Json> {
  const t = targets(config);
  let obs = await connectObs(config, rec);
  const snap = await readSnapshot(obs, t);
  rec.save('snapshot.json', snap);
  assertContrarregra(snap, config);
  if (snap.record.outputActive) throw new Error('o OBS está gravando: o kick não reinicia o OBS com gravação em curso');
  const trials: KickTrial[] = [];
  const off = onSignals(() => rec.write('signal', {}));
  try {
    for (let i = 1; i <= args.trials && !interrupted; i++) {
      rec.write('trial-start', { trial: i, mode: args.mode });
      const gone = (): boolean => !obs.isOpen;
      const trial: KickTrial = { trial: i, mode: args.mode, deadBeforeKick: false, unableInitLogged: false, kickToLiveMs: null, variant: 'none', deviceValue: null, obsCrashed: false };
      // replug: o registro do OBS em execução, daqui em diante; restart/cable: o arquivo novo do OBS reaberto, inteiro.
      let mark = logMark();
      try {
        let unplugged = false;
        if (args.mode === 'cable' || args.mode === 'replug') {
          await say(rec, config, `Tentativa ${i}. Tire o cabo do iPhone.`);
          const out = await pollUntil(() => deviceListed(obs, t), (v) => v === null, 120_000, 500, clock, gone);
          if (!out.ok && !gone()) throw new OwnerAction({ step: 'unplug', text: 'o iPhone continua na lista do OBS: tire o cabo do iPhone' });
          unplugged = true;
          rec.write('unplugged', { ms: out.ms });
        }
        if (args.mode === 'restart' || args.mode === 'cable') {
          const pids = await realObsProcess.pids();
          await obs.close();
          for (const pid of pids) realObsProcess.interrupt(pid);
          if (!(await waitObsExit(30_000))) throw new OwnerAction({ step: 'quit', text: 'o OBS não fechou em 30 s depois do SIGINT: feche o OBS (⌘Q)' });
          await realObsProcess.launch(config.obs.profile, config.obs.collection);
          const c = await connectRetry(config, rec, 30_000);
          obs = c.obs;
          rec.write('relaunched', { connectMs: c.ms });
          const fresh = newestLog(OBS_LOGS);
          mark = fresh === null ? null : { path: fresh.path, offset: 0 };
        }
        if (unplugged) await say(rec, config, 'Agora ligue o cabo do iPhone.');
        const appear = await pollUntil(() => deviceListed(obs, t), (v) => v !== null, unplugged ? 120_000 : 15_000, 250, clock, gone);
        trial.deviceValue = appear.last ?? null;
        rec.write('device-listed', { ok: appear.ok, ms: appear.ms, value: trial.deviceValue });
        const itemId = await itemIdOf(obs, t.scene, t.source);
        const read = (): ReturnType<typeof liveState> => liveState(obs, t.scene, t.source, itemId);
        const observed = await pollUntil(read, isNativeLive, args.observeS * 1000, 250, clock, gone);
        trial.deadBeforeKick = !observed.ok;
        rec.write('observed', { liveWithoutKick: observed.ok, ms: observed.ms, state: observed.last });
        if (trial.deviceValue !== null && !observed.ok && !gone()) {
          const t0 = now();
          await kick(obs, t.source, trial.deviceValue, 'plain');
          trial.variant = 'plain';
          let w = await pollUntil(read, isNativeLive, KICK.limitMs, 250, clock, gone);
          if (!w.ok && !gone()) {
            await kick(obs, t.source, trial.deviceValue, 'reset');
            trial.variant = 'reset';
            w = await pollUntil(read, isNativeLive, KICK.limitMs, 250, clock, gone);
          }
          trial.kickToLiveMs = w.ok ? now() - t0 : null;
          rec.write('kicked', { variant: trial.variant, ok: w.ok, ms: trial.kickToLiveMs, state: w.last });
        }
      } catch (error) {
        // Conexão perdida com o OBS fora do nosso reinício = o OBS caiu (⏳ Q-8): registra e para; outro erro sobe.
        if (!(gone() && (await realObsProcess.pids()).length === 0)) throw error;
        rec.write('trial-error', { err: errCode(error) });
      }
      trial.obsCrashed = gone() || (await realObsProcess.pids()).length === 0;
      const scan = mark === null ? null : scanObsLog(logSince(mark));
      trial.unableInitLogged = (scan?.counts['unableInit'] ?? 0) > 0;
      trials.push(trial);
      rec.write('trial', { ...trial, logLines: scan?.lines.filter((l) => /avcapture|device|connect|Unable/i.test(l)) ?? [] });
      // O OBS caiu: é achado, não ação do dono; para as tentativas e o `finally` o reabre no perfil.
      if (trial.obsCrashed) break;
    }
  } finally {
    off();
    try {
      // Nunca deixa o OBS fechado: sem processo, reabre no perfil (S9 item 2); sem conexão, reconecta.
      if ((await realObsProcess.pids()).length === 0) {
        await realObsProcess.launch(config.obs.profile, config.obs.collection);
        rec.write('relaunched-at-end', {});
        obs = (await connectRetry(config, rec, 30_000)).obs;
      } else if (!obs.isOpen) {
        obs = (await connectRetry(config, rec, 30_000)).obs;
      }
      const report = await restore(obs, t, snap, clock, (k, data) => rec.write(k, data ?? {}));
      rec.save('restore.json', report);
      if (report.errors.length > 0 || !report.settingsEqual || !report.live) {
        console.error(`DEVOLUÇÃO INCOMPLETA: ${JSON.stringify(report)}`);
        process.exitCode = EXIT.restore;
      }
    } catch (error) {
      console.error(`DEVOLUÇÃO NÃO FEITA: ${errCode(error)}`);
      process.exitCode = EXIT.restore;
    } finally {
      await obs.close();
    }
  }
  const verdict = kickVerdict(trials);
  const summary = { phase: 'kick', mode: args.mode, trials, verdict, deviceValueBefore: snap.device.value };
  rec.save('summary.json', summary);
  return summary;
}

// ---------------------------------------------------------------------------------------------------------
// restore e report

async function cmdRestore(config: Config, rec: Recorder, label: string): Promise<Json> {
  const path = join(OUT, `${label}-snapshot.json`);
  const snap = JSON.parse(readFileSync(path, 'utf8')) as ObsSnapshot;
  const obs = await connectObs(config, rec);
  try {
    const t = targets(config);
    const status = await obs.request<{ outputActive: boolean }>('GetRecordStatus');
    const dir = (await obs.request<{ recordDirectory: string }>('GetRecordDirectory')).data.recordDirectory;
    if (status.data.outputActive && existsSync(SPIKE_DIR) && existsSync(dir) && realpathSync(dir) === realpathSync(SPIKE_DIR)) {
      await obs.request('StopRecord');
      rec.write('emergency-stop', {});
    }
    const report = await restore(obs, t, snap, clock, (k, data) => rec.write(k, data ?? {}));
    rec.save('restore.json', report);
    if (report.errors.length > 0 || !report.settingsEqual || !report.live) process.exitCode = EXIT.restore;
    return { ...report };
  } finally {
    await obs.close();
  }
}

export function cmdReport(labels: string[], outDir: string = OUT): string {
  const parts: string[] = [];
  for (const label of labels) {
    const path = join(outDir, `${label}-summary.json`);
    if (!existsSync(path)) {
      parts.push(`(${label}: sem resumo)`);
      continue;
    }
    const s = JSON.parse(readFileSync(path, 'utf8')) as Json;
    if (s['phase'] === 'configs') {
      const rows = (s['results'] as ConfigResult[]).map((r) => [
        r.label,
        r.applied ? 'sim' : `não (${r.why ?? ''})`,
        `${r.live.w}×${r.live.h}${r.live.kicked ? ' (chute)' : ''}`,
        fmt(r.live.ms, 0),
        r.sourceColor === undefined ? '—' : fmt(r.sourceColor.vsDevice['maxDiff'] as number),
        r.fileColor === undefined ? '—' : fmt(r.fileColor.vsDevice['maxDiff'] as number),
        r.file === undefined ? '—' : `${String(r.file['colorRange'])}/${String(r.file['colorSpace'])}`,
        r.ok ? '✔' : '✘',
      ]);
      parts.push(`### ${label} (configs)\n\n${markdownTable(['configuração', 'aplicada', 'fonte (px)', 'até viva (ms)', 'Δcor fonte', 'Δcor arquivo', 'faixa/matriz', 'ok'], rows)}`);
    } else if (s['phase'] === 'audio') {
      const p = s['peaks'] as Json;
      const av = s['av'] as Json;
      const pause = av['pause'] as Json;
      const play = av['play'] as Json;
      parts.push(`### ${label} (audio)\n\n${markdownTable(['medida', 'valor', 'ok'], [
        ['pico máximo (dBFS)', fmt(p['maxPeakDb'] as number), ''],
        ['mediana dos picos (dBFS)', fmt(p['medianPeakDb'] as number), p['ok'] ? '✔' : `✘ ${String(p['reason'])}`],
        ['A/V pausa: válidas / mediana / p5–p95 (ms)', `${String(pause['valid'])}/${String(pause['n'])} · ${fmt(pause['medianMs'] as number)} · ${fmt(pause['p5Ms'] as number)}–${fmt(pause['p95Ms'] as number)}`, av['ok'] ? '✔' : `✘ ${String(av['reason'])}`],
        ['A/V play (só registro)', `${String(play['valid'])}/${String(play['n'])} · ${fmt(play['medianMs'] as number)}`, ''],
        ['alto-falante', String((s['speaker'] as Json)['verdict'] ?? (s['speaker'] as Json)['mode']), ''],
      ])}`);
    } else if (s['phase'] === 'long') {
      const ac = s['ac97'] as { ok: boolean; checks: { name: string; ok: boolean; value: string }[] };
      const rows = ac.checks.map((c) => [c.name, c.value, c.ok ? '✔' : '✘']);
      parts.push(`### ${label} (long)\n\n${markdownTable(['AC-9.7', 'valor', 'ok'], rows)}\n\nrelógio: ${JSON.stringify(s['clock'])}`);
    } else if (s['phase'] === 'kick') {
      const rows = (s['trials'] as KickTrial[]).map((tr) => [String(tr.trial), tr.mode, tr.deadBeforeKick ? 'sim' : 'não', tr.unableInitLogged ? 'sim' : 'não', tr.variant, fmt(tr.kickToLiveMs, 0), tr.obsCrashed ? 'sim' : 'não']);
      parts.push(`### ${label} (kick)\n\n${markdownTable(['#', 'modo', 'morta antes', '"Unable to initialize"', 'chute', 'chute→viva (ms)', 'OBS caiu'], rows)}\n\n${JSON.stringify(s['verdict'])}`);
    }
  }
  return parts.join('\n\n');
}

// ---------------------------------------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.cmd === 'report') {
    console.log(cmdReport(args.labels));
    return;
  }
  const commands = ['probe', 'configs', 'audio', 'long', 'kick', 'restore'];
  if (!commands.includes(args.cmd)) throw new Error(`uso: node spikes/sp-5/sp5.ts <${[...commands, 'report'].join('|')}> --label <l> (ver o cabeçalho)`);
  const config = loadConfig();
  const rec = new Recorder(args.label, args.cmd !== 'restore' && args.cmd !== 'probe');
  rec.write('start', { cmd: args.cmd, args: { ...args } });
  try {
    let out: Json;
    switch (args.cmd) {
      case 'probe': out = await cmdProbe(config, rec); break;
      case 'configs': out = await cmdConfigs(config, rec, args); break;
      case 'audio': out = await cmdAudio(config, rec, args); break;
      case 'long': out = await cmdLong(config, rec, args); break;
      case 'kick': out = await cmdKick(config, rec, args); break;
      default: out = await cmdRestore(config, rec, args.label);
    }
    rec.write('end', { ok: true });
    console.log(JSON.stringify(out, null, 2));
    if (args.cmd !== 'probe' && args.cmd !== 'restore') console.log(`\n${cmdReport([args.label])}`);
  } catch (error) {
    rec.write('end', { ok: false, err: errCode(error) });
    if (error instanceof OwnerNeeded) {
      console.log(`OWNER_ACTION ${JSON.stringify({ step: error.step, text: error.message, seen: error.seen })}`);
      process.exitCode = EXIT.owner;
    } else if (error instanceof OwnerAction) {
      console.log(`OWNER_ACTION ${JSON.stringify(error.payload)}`);
      process.exitCode = EXIT.owner;
    } else if (error instanceof DiskLowError) {
      console.error(error.message);
      process.exitCode = EXIT.disk;
    } else if (error instanceof ProfileError || isContrarregraError(error, 'E_OBS_CONFIG') || isContrarregraError(error, 'E_TOOLCHAIN_MISMATCH')) {
      console.error(errCode(error));
      process.exitCode = EXIT.obsConfig;
    } else {
      console.error(errCode(error));
      if (process.exitCode === undefined || process.exitCode === 0) process.exitCode = EXIT.error;
    }
  } finally {
    await Promise.all([...voices]);
  }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  await main();
}
