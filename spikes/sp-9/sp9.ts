// Driver do SP-9 (T-0.27; S1 itens 7 e 11, S0.3, S13 item 7; AC-1.15, AC-5.7 parcial): a Central de Controle, o modo
// avião, a rede e a barra de estado, com o PRÓPRIO runner abrindo a Central, achando e tocando o interruptor e
// fechando (o dono não está ao lado). Código de spike, descartável (architecture.md A5); usa as peças de `mac/src`
// (cliente JSON-RPC do runner, `devicectl`, cliente do OBS com a guarda do perfil, ffmpeg fixado, OCR do Mac) e só
// métodos que o runner já tem (um build já aprovado basta; nada do `Spike`).
//
// Regras (tasks.md "Regras comuns" dos spikes; S9; P-6, P-7):
// - O avião só liga no cabo (`transportType = wired`) e sem o Acesso Pessoal; o driver nunca deixa o avião ligado (no
//   fim, num erro ou no SIGINT o runner o desliga pelo `value`; se não conseguir, `OWNER_ACTION air-off`).
// - Nada de arrasto por coordenada na Central: abre por `device.controlCenter {action: open}` (o arrasto de S1 item 7
//   dentro do runner); a sonda `probe-drag` só confere que o `ui.drag` com a coordenada é RECUSADO (A9).
// - Toda escrita no OBS passa pela guarda do `ObsClient` (perfil e coleção "Contrarregra"): só `SetRecordDirectory`
//   (devolvida no fim), o chute da fonte (o mesmo `device`), `StartRecord`/`StopRecord`.
// - Gravações e recortes só em ~/Movies/contrarregra/spikes/SP-9/<rótulo>/; antes de cada gravação, livre ≥
//   max(disk.minFreeGiB, 3 × estimativa + 2 GiB) com a estimativa do teto `--max-record-s`; cada gravação é apagada
//   logo depois de medida; os recortes, no fim da execução (ou `cleanup`); tudo no livro `out/<rótulo>-files.ndjson`.
//   Nunca apaga pasta com conteúdo nem nada recursivo.
// - ffmpeg/ffprobe só o 8.1.1 de `paths.*` (`openFfmpeg`). A senha do OBS só pelo Chaveiro, na memória.
// - Nunca instala, sobe nem derruba o runner (`contrarregra runner up` é do orquestrador).
//
// Uso (Node 22 ≥ 22.18, TypeScript direto; ver spikes/SP-9.md):
//   node spikes/sp-9/sp9.ts probe   --label <l> [--runner]     (só leitura: OBS por Get*, disco, sessão; --runner
//                                                               acrescenta health, devicectl e Acesso Pessoal)
//   node spikes/sp-9/sp9.ts run     --label <l> [--cycles 10] [--base hagah|home] [--record both|on|none]
//                                   [--max-record-s 300] [--hold-s 2] [--min-phase-s 20] [--no-probe-drag]
//                                   [--no-probe-label] [--keep-crops]
//   node spikes/sp-9/sp9.ts report  --labels <l1,l2,…>         (tabelas para o SP-9.md)
//   node spikes/sp-9/sp9.ts cleanup --label <l>                (apaga o que o livro de <l> diz criado e não apagado)
// Saída: out/<label>.ndjson, <label>-files.ndjson (livro do G4), <label>-obs-snapshot.json, <label>-summary.json
// (pasta fora do git). Códigos de saída: 0 = os ciclos rodaram até o fim (o veredicto está no resumo); 1 = erro;
// 2 = disco abaixo do HC-11 (nada gravado); 3 = a série parou antes do fim (uma troca falhou; o resumo diz qual);
// 4 = `OWNER_ACTION` (algo humano); 5 = fora do cabo, OBS fora do "Contrarregra" ou fora do conjunto validado;
// 6 = a devolução do OBS não fechou. Rodar em segundo plano e parar só com `kill -INT` (o segundo SIGINT sai na hora).

import { execFile, spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statfsSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig, type Config } from '../../mac/src/core/config.ts';
import { isContrarregraError } from '../../mac/src/core/errors.ts';
import type { HealthResult } from '../../mac/src/core/types.ts';
import { readDeviceTransport } from '../../mac/src/device/devicectl.ts';
import { openFfmpeg } from '../../mac/src/media/ffmpeg.ts';
import { ocrImages } from '../../mac/src/media/ocr.ts';
import { ObsClient, obsClientOptions } from '../../mac/src/obs/client.ts';
import { RunnerLink } from '../../mac/src/runner/link.ts';
import { runnerPaths } from '../../mac/src/runner/paths.ts';
import { currentSession, sessionAlive } from '../../mac/src/runner/session.ts';
import { ObsCapture, cleanupFiles } from './capture.ts';
import { DEFAULT_OPTIONS, StopError, TEXT, errCode, runSpike, type Capture, type DriverEnv, type RunOptions } from './driver.ts';
import { ccDragStart, estimateBytes, gib, hotspotActive, parseArgs, requiredFreeBytes, summarize, summaryTable, toggleTable, type AirState, type Args, type Json, type Summary, type ToggleRow } from './lib.ts';
import { DiskLowError, assertOwn, isNativeLive, kick, liveState, pollUntil, readSnapshot, restoreObs, type ObsTargets } from './obs.ts';

const OUT = join(dirname(fileURLToPath(import.meta.url)), 'out');
const TMP = join(OUT, 'tmp');
const SPIKE_DIR = join(homedir(), 'Movies', 'contrarregra', 'spikes', 'SP-9');
const VOICE = 'Luciana';
const EXIT = { error: 1, disk: 2, stopped: 3, owner: 4, config: 5, restore: 6 } as const;

function now(): number {
  return Math.round((performance.timeOrigin + performance.now()) * 10) / 10;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------------------------------------
// Registro (out/, fora do git), livro de arquivos, voz e dono

class Recorder {
  readonly label: string;
  readonly path: string;

  constructor(label: string, fresh: boolean) {
    mkdirSync(TMP, { recursive: true });
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

  /** Cada arquivo criado e apagado na pasta do spike (G4; os nomes vão para o SP-9.md). */
  ledger(row: Json): void {
    appendFileSync(this.file('files.ndjson'), `${JSON.stringify({ at: new Date().toISOString(), ...row })}\n`);
    this.write('file', row);
  }

  ledgerRows(): Json[] {
    const path = this.file('files.ndjson');
    if (!existsSync(path)) return [];
    return readFileSync(path, 'utf8').split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l) as Json);
  }
}

const voices = new Set<Promise<void>>();

/** Fala no alto-falante do Mac (`alerts.sayDevice`; o OBS não grava o áudio do Mac). Só avisa. */
function say(rec: Recorder, config: Config, text: string): void {
  rec.write('say', { text });
  const child = spawn('/usr/bin/say', ['-v', VOICE, '-a', config.alerts.sayDevice, text], { stdio: 'ignore' });
  const done = new Promise<void>((resolve) => {
    child.once('exit', () => resolve());
    child.once('error', () => resolve());
  });
  voices.add(done);
  void done.then(() => voices.delete(done));
}

async function voicesDone(maxMs = 20_000): Promise<void> {
  await Promise.race([Promise.all([...voices]), sleep(maxMs)]);
}

class OwnerAction extends Error {
  readonly payload: Json;
  constructor(payload: Json) {
    super(String(payload['text'] ?? 'ação do dono'));
    this.payload = payload;
  }
}

class ConfigStop extends Error {}

/** `ifconfig` (todas as interfaces): o Mac na rede do Acesso Pessoal do iPhone? */
function macOnHotspot(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('/sbin/ifconfig', [], { timeout: 5_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => resolve(error === null && hotspotActive(stdout)));
  });
}

function freeBytes(dir: string): Promise<number> {
  const st = statfsSync(dir);
  return Promise.resolve(Number(st.bavail) * Number(st.bsize));
}

/** Livre no volume da pasta do spike (ou do primeiro antepassado que existe). */
async function freeNear(dir: string): Promise<number> {
  for (let d = dir; ; d = dirname(d)) {
    if (existsSync(d)) return freeBytes(d);
    if (d === dirname(d)) return 0;
  }
}

function targets(config: Config): ObsTargets {
  return { scene: config.obs.scene, source: config.obs.source, deviceName: config.device.name };
}

function labelDir(label: string): string {
  return join(SPIKE_DIR, label);
}

/** Plano de disco do HC-11 para uma gravação de `maxS` (o teto de cada troca). */
function diskPlan(config: Config, maxS: number, free: number): Json {
  const est = estimateBytes(config.record.bitrateKbps, maxS);
  const req = requiredFreeBytes(est, config.disk.minFreeGiB);
  return { maxRecordS: maxS, estimateGiB: gib(est), requiredGiB: gib(req), freeGiB: gib(free), okNow: free >= req };
}

// ---------------------------------------------------------------------------------------------------------
// probe (só leitura)

async function cmdProbe(config: Config, rec: Recorder, args: Args): Promise<Json> {
  let obs: Json;
  try {
    const client = await ObsClient.connect(obsClientOptions(config, { log: (line) => rec.write('obs-log', { line }) }));
    try {
      const snap = await readSnapshot(client, targets(config));
      rec.save('obs-snapshot.json', snap);
      obs = {
        versions: snap.versions,
        profile: snap.profile,
        collection: snap.collection,
        isContrarregra: snap.profile === config.obs.profile && snap.collection === config.obs.collection,
        recording: snap.recordActive,
        recordDirectory: snap.recordDirectory,
        source: { kind: snap.source.kind, width: snap.source.width, height: snap.source.height, live: snap.source.width === 1170 && snap.source.height === 2532 },
        device: snap.device,
        availableDiskMiB: snap.availableDiskMiB,
      };
    } finally {
      await client.close();
    }
  } catch (error) {
    obs = { error: errCode(error) };
  }
  const free = await freeNear(SPIKE_DIR);
  const session = currentSession(runnerPaths(config));
  const out: Json = {
    obs,
    disk: { spikeDir: SPIKE_DIR, spikeDirExists: existsSync(SPIKE_DIR), ...diskPlan(config, args.maxRecordS, free) },
    runnerSession: session === undefined ? null : { sessionId: session.sessionId, configuration: session.configuration, alive: sessionAlive(session) },
    ccDrag: { ...ccDragStart(), note: 'o começo do arrasto de S1 item 7 cai na faixa de gesto de 47 pt (A9): ui.drag é recusado; abre por device.controlCenter' },
    app: config.app.explore ?? null,
  };
  if (args.runner) {
    // Só a fila de controle (`health`) e o Mac (`devicectl`, `ifconfig`): nada na fila do XCTest, nada na tela.
    const link = await RunnerLink.connect(config, { role: 'control' });
    try {
      const h = await link.call<HealthResult>('health', {}, { timeoutMs: 5_000 });
      out['runner'] = { uptimeS: h.uptimeS, foregroundApp: h.foregroundApp, locked: h.locked, queue: h.xctestQueueDepth };
    } finally {
      await link.close();
    }
    out['transport'] = (await readDeviceTransport({ udid: config.device.udid, coreDeviceId: config.device.coreDeviceId, outDir: TMP })) ?? null;
    out['hotspot'] = await macOnHotspot();
  }
  rec.save('probe.json', out);
  return out;
}

// ---------------------------------------------------------------------------------------------------------
// run

interface ObsSessionResult<T> {
  value: T;
  restoreOk: boolean;
}

/**
 * Conecta, confere o perfil, grava o instantâneo ANTES de escrever, aponta a gravação para a pasta do rótulo, garante
 * a fonte viva (chute, S9 item 3) e roda `fn`; no fim, para uma gravação ainda ativa (registrada no livro para o
 * G4), devolve a pasta de gravação e confere os ajustes da fonte.
 */
async function withObs<T>(config: Config, rec: Recorder, dir: string, fn: (obs: ObsClient, realDir: string) => Promise<T>): Promise<ObsSessionResult<T>> {
  const obs = await ObsClient.connect(obsClientOptions(config, { log: (line) => rec.write('obs-log', { line }) }));
  const t = targets(config);
  let restoreOk = false;
  try {
    const snap = await readSnapshot(obs, t);
    rec.save('obs-snapshot.json', snap);
    rec.write('obs-snapshot', { profile: snap.profile, collection: snap.collection, recordDirectory: snap.recordDirectory, source: { w: snap.source.width, h: snap.source.height } });
    if (snap.profile !== config.obs.profile || snap.collection !== config.obs.collection) {
      throw new ConfigStop(`o OBS está no perfil "${snap.profile}" e na coleção "${snap.collection}"; o SP-9 só grava no "${config.obs.profile}"/"${config.obs.collection}" (P-6). Nada foi escrito`);
    }
    if (snap.recordActive) throw new Error('o OBS já está gravando: o SP-9 não começa com uma gravação em curso');
    const device = snap.device.value;
    if (device === null) throw new OwnerAction({ step: 'device', text: `o iPhone "${t.deviceName}" não está na lista de dispositivos do OBS: confira o cabo e o iPhone destravado` });
    mkdirSync(dir, { recursive: true });
    const realDir = realpathSync(dir);
    const beforeNames = new Set(readdirSync(realDir));
    const startedAt = now();
    try {
      await obs.request('SetRecordDirectory', { recordDirectory: realDir });
      rec.write('record-directory', { dir: realDir });
      const clock = { now, sleep };
      const read = (): ReturnType<typeof liveState> => liveState(obs, t.scene, t.source, snap.source.itemId);
      let live = await pollUntil(read, isNativeLive, 5_000, 500, clock);
      if (!live.ok) {
        await kick(obs, t.source, device);
        live = await pollUntil(read, isNativeLive, 15_000, 500, clock);
        rec.write('kick', { ok: live.ok, ms: live.ms, state: live.last });
        if (!live.ok) throw new OwnerAction({ step: 'source', text: 'a fonte do iPhone no OBS não ficou viva nem com o chute: confira o cabo e o iPhone destravado', state: live.last });
      }
      return { value: await fn(obs, realDir), restoreOk: true };
    } finally {
      try {
        const status = await obs.request<{ outputActive: boolean }>('GetRecordStatus');
        if (status.data.outputActive) {
          const stopped = await obs.request<{ outputPath?: string }>('StopRecord');
          rec.write('emergency-stop', { outputPath: stopped.data.outputPath ?? null });
          // Uma gravação que a troca não chegou a parar: se é deste spike (direto na pasta, nova), entra no livro e o
          // `cleanupFiles` do fim a apaga; senão fica registrada para o dono.
          if (typeof stopped.data.outputPath === 'string') {
            await sleep(2_000);
            try {
              const own = assertOwn(stopped.data.outputPath, realDir, beforeNames, startedAt);
              rec.ledger({ event: 'created', kind: 'recording', name: own.realPath.slice(own.realPath.lastIndexOf('/') + 1), bytes: own.sizeBytes, ino: own.ino, note: 'parada de emergência' });
            } catch (error) {
              rec.ledger({ event: 'orphan', kind: 'recording', path: stopped.data.outputPath, err: errCode(error) });
            }
          }
        }
      } catch (error) {
        rec.write('emergency-stop', { err: errCode(error) });
      }
      const report = await restoreObs(obs, t, snap, (k, data) => rec.write(k, data ?? {}));
      rec.write('restore-report', { ...report });
      restoreOk = report.errors.length === 0 && report.settingsEqual && report.recordDirectoryRestored;
      if (!restoreOk) console.error(`DEVOLUÇÃO DO OBS INCOMPLETA: ${JSON.stringify(report)}`);
    }
  } finally {
    await obs.close();
    if (!restoreOk) process.exitCode = EXIT.restore;
  }
}

function runOptions(args: Args): RunOptions {
  return {
    ...DEFAULT_OPTIONS,
    cycles: args.cycles,
    base: args.base,
    record: args.record,
    holdMs: args.holdS * 1000,
    minPhaseMs: args.minPhaseS * 1000,
    probeDrag: args.probeDrag,
    probeLabel: args.probeLabel,
  };
}

interface RunOutput {
  summary: Summary;
  rows: ToggleRow[];
  stopped?: string;
  stopKind?: string;
  air: AirState;
  cleanup?: Json;
}

async function cmdRun(config: Config, rec: Recorder, args: Args): Promise<RunOutput> {
  const session = currentSession(runnerPaths(config));
  if (session === undefined || !sessionAlive(session)) throw new Error('o runner não está de pé: o orquestrador roda `bin/contrarregra runner up` (build já aprovado)');
  const app = config.app.explore;
  if (app === undefined && args.base === 'hagah') throw new Error('app.explore (o Hagah) não está no config.json; use --base home');
  const opts = runOptions(args);
  rec.write('start', { cmd: 'run', opts: { ...opts }, session: { id: session.sessionId, configuration: session.configuration, xcodebuildPid: session.xcodebuildPid } });

  // SIGINT/SIGTERM: o primeiro pede a parada (o driver termina o passo e desliga o avião); o segundo sai na hora.
  let stop = false;
  let air: AirState = 'maybe-on';
  let signals = 0;
  const onSignal = (signal: string): void => {
    signals++;
    rec.write('signal', { signal, n: signals, air });
    if (signals === 1) {
      stop = true;
      return;
    }
    if (air !== 'off') {
      console.log(`OWNER_ACTION ${JSON.stringify({ step: 'air-off', text: TEXT.ownerAirOff })}`);
      process.exit(EXIT.owner);
    }
    process.exit(130);
  };
  process.on('SIGINT', () => onSignal('SIGINT'));
  process.on('SIGTERM', () => onSignal('SIGTERM'));

  const link = await RunnerLink.connect(config, {
    role: 'control',
    onStateChange: (state, error) => rec.write('link', { state, ...(error === undefined ? {} : { err: errCode(error) }) }),
  });
  const env = (capture: Capture | undefined): DriverEnv => ({
    rpc: { call: (method, params, options) => link.call(method, params, options) },
    app: app ?? '',
    now,
    sleep,
    write: (k, data) => rec.write(k, data ?? {}),
    say: (text) => say(rec, config, text),
    owner: (step, text) => {
      console.log(`OWNER_ACTION ${JSON.stringify({ step, text })}`);
      say(rec, config, text);
    },
    stopRequested: () => stop,
    setAir: (next) => {
      air = next;
    },
    transport: async () => (await readDeviceTransport({ udid: config.device.udid, coreDeviceId: config.device.coreDeviceId, outDir: TMP })) ?? undefined,
    hotspot: macOnHotspot,
    sessionAlive: () => sessionAlive(session),
    ...(capture === undefined ? {} : { capture }),
  });

  const dir = labelDir(rec.label);
  let result: Awaited<ReturnType<typeof runSpike>>;
  try {
    if (opts.record === 'none') {
      result = await runSpike(env(undefined), opts);
    } else {
      const ff = await openFfmpeg(config);
      const obsRun = await withObs(config, rec, dir, (obs, realDir) =>
        runSpike(
          env(
            new ObsCapture({
              obs,
              ff,
              dir: realDir,
              maxS: args.maxRecordS,
              bitrateKbps: config.record.bitrateKbps,
              minFreeGiB: config.disk.minFreeGiB,
              criticalGiB: config.disk.criticalGiB,
              freeBytes,
              ocr: (paths) => ocrImages(paths),
              now,
              sleep,
              log: (k, data) => rec.write(k, data ?? {}),
              ledger: (row) => rec.ledger(row),
            }),
          ),
          opts,
        ),
      );
      result = obsRun.value;
    }
  } finally {
    await link.close();
  }
  const summary = summarize(rec.label, result.rows, result.probes, { cycles: opts.cycles, findLimitMs: opts.findLimitMs, requireWired: opts.requireWired });
  const out: RunOutput = { summary, rows: result.rows, ...(result.stopped === undefined ? {} : { stopped: result.stopped, stopKind: result.stopKind }), air: result.air };
  if (opts.record !== 'none' && !args.keepCrops && existsSync(dir)) {
    const cleaned = cleanupFiles(rec.ledgerRows(), dir, (row) => rec.ledger(row));
    out.cleanup = { deleted: cleaned.deleted.length, refused: cleaned.refused, dirRemoved: cleaned.dirRemoved };
  }
  rec.save('summary.json', out);
  if (result.stopKind === 'transport') process.exitCode = EXIT.config;
  else if (result.rows.some((r) => r.err?.includes('disco abaixo do limite'))) process.exitCode = EXIT.disk;
  else if (result.stopped !== undefined && (process.exitCode === undefined || process.exitCode === 0)) process.exitCode = EXIT.stopped;
  return out;
}

// ---------------------------------------------------------------------------------------------------------
// report e cleanup

function cmdReport(labels: string[]): string {
  const parts: string[] = [];
  for (const label of labels) {
    const path = join(OUT, `${label}-summary.json`);
    if (!existsSync(path)) {
      parts.push(`### ${label}\n\n(sem ${label}-summary.json)`);
      continue;
    }
    const data = JSON.parse(readFileSync(path, 'utf8')) as RunOutput;
    parts.push(`### ${label}\n\n${summaryTable(data.summary)}\n\n${toggleTable(data.rows, data.summary.findLimitMs)}${data.stopped === undefined ? '' : `\n\nParou: ${data.stopped}`}`);
  }
  return parts.join('\n\n');
}

function cmdCleanup(rec: Recorder): Json {
  const dir = labelDir(rec.label);
  if (!existsSync(dir)) return { dir, exists: false };
  const cleaned = cleanupFiles(rec.ledgerRows(), dir, (row) => rec.ledger(row));
  return { dir, ...cleaned };
}

// ---------------------------------------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.cmd === 'report') {
    console.log(cmdReport(args.labels));
    return;
  }
  const commands = ['probe', 'run', 'cleanup'];
  if (!commands.includes(args.cmd)) throw new Error(`uso: node spikes/sp-9/sp9.ts <${[...commands, 'report'].join('|')}> --label <l> (ver o cabeçalho)`);
  const config = loadConfig();
  const rec = new Recorder(args.label, args.cmd === 'run');
  rec.write('start', { cmd: args.cmd, args: { ...args } });
  try {
    if (args.cmd === 'probe') console.log(JSON.stringify(await cmdProbe(config, rec, args), null, 2));
    else if (args.cmd === 'cleanup') console.log(JSON.stringify(cmdCleanup(rec), null, 2));
    else {
      const out = await cmdRun(config, rec, args);
      console.log(`${summaryTable(out.summary)}\n\n${toggleTable(out.rows, out.summary.findLimitMs)}${out.stopped === undefined ? '' : `\n\nParou: ${out.stopped}`}`);
    }
    rec.write('end', { ok: true, exitCode: process.exitCode ?? 0 });
  } catch (error) {
    rec.write('end', { ok: false, err: errCode(error) });
    if (error instanceof StopError && error.kind === 'owner') {
      process.exitCode = EXIT.owner;
    } else if (error instanceof OwnerAction) {
      console.log(`OWNER_ACTION ${JSON.stringify(error.payload)}`);
      process.exitCode = EXIT.owner;
    } else if (error instanceof DiskLowError) {
      console.error(error.message);
      process.exitCode = EXIT.disk;
    } else if (error instanceof ConfigStop || isContrarregraError(error, 'E_OBS_CONFIG') || isContrarregraError(error, 'E_TOOLCHAIN_MISMATCH')) {
      console.error(errCode(error));
      process.exitCode = EXIT.config;
    } else {
      console.error(errCode(error));
      if (process.exitCode === undefined || process.exitCode === 0) process.exitCode = EXIT.error;
    }
  } finally {
    await voicesDone();
  }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  await main();
  process.exit(process.exitCode ?? 0);
}
