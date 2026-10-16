// SP-1 reduzido da trilha do demo (M1; spec/tasks.md "Trilha do demo"): o aviso "Automation Running" entra na
// captura do OBS? E o toque humano funciona com o runner vivo? Código de spike, descartável.
//
//   node spikes/sp-1/sp1.ts live                       — confere perfil/coleção e põe a fonte "iPhone" viva (o "chute")
//   node spikes/sp-1/sp1.ts record --seconds 180       — grava em ~/Movies/contrarregra/spikes/SP-1 (devolve a pasta)
//   node spikes/sp-1/sp1.ts call <method> '<json>' [--timeout ms]   — uma chamada ao runner (conexão `control`)
//   node spikes/sp-1/sp1.ts analyze <arquivo.mp4> [--fps 2]          — quadros + OCR do Mac atrás do aviso
//
// Toda escrita no OBS passa pelo `ObsClient` (guarda do perfil "Contrarregra", P-6). Quadros extraídos vão para
// `~/Library/Caches/contrarregra/sp-1/` e a gravação fica fora do repositório (HC-7).

import { spawn } from 'node:child_process';
import { mkdirSync, readdirSync, realpathSync, rmSync, statfsSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { loadConfig, type Config } from '../../mac/src/core/config.ts';
import { isContrarregraError } from '../../mac/src/core/errors.ts';
import { openFfmpeg, runFfmpeg, runFfprobe } from '../../mac/src/media/ffmpeg.ts';
import { findText, ocrImages } from '../../mac/src/media/ocr.ts';
import { ObsClient, obsClientOptions } from '../../mac/src/obs/client.ts';
import { withRunner } from '../../mac/src/runner/client.ts';
import { errCode, isNativeLive, itemIdOf, kick, listProperty, liveState, pollUntil, record, type Obs } from '../sp-5/obs.ts';
import { resolveDevice } from '../sp-5/lib.ts';

const SP1_DIR = join(homedir(), 'Movies', 'contrarregra', 'spikes', 'SP-1');
const FRAMES_DIR = join(homedir(), 'Library', 'Caches', 'contrarregra', 'sp-1');
const NEEDLES = ['Automation Running', 'volume buttons', 'Hold both'];
const clock = { now: () => Date.now(), sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)) };

function opt(args: string[], name: string, fallback: string): string {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1]! : fallback;
}

async function connectObs(config: Config): Promise<ObsClient> {
  const obs = await ObsClient.connect(obsClientOptions(config));
  const [{ currentProfileName }, { currentSceneCollectionName }] = await Promise.all([
    obs.request<{ currentProfileName: string }>('GetProfileList').then((r) => r.data),
    obs.request<{ currentSceneCollectionName: string }>('GetSceneCollectionList').then((r) => r.data),
  ]);
  if (currentProfileName !== config.obs.profile || currentSceneCollectionName !== config.obs.collection) {
    await obs.close();
    throw new Error(`OBS em perfil/coleção "${currentProfileName}"/"${currentSceneCollectionName}", não "${config.obs.profile}": nada foi escrito`);
  }
  return obs;
}

/** A fonte "iPhone" com quadros nativos; se não, o chute (reescolher o aparelho pelo `itemName`). */
async function ensureLive(config: Config, obs: Obs): Promise<{ w: number; h: number; kicked: number }> {
  const scene = config.obs.scene;
  const source = config.obs.source;
  const itemId = await itemIdOf(obs, scene, source);
  const read = () => liveState(obs, scene, source, itemId);
  let w = await pollUntil(read, isNativeLive, 3_000, 500, clock);
  let kicked = 0;
  while (!w.ok && kicked < 3) {
    const value = resolveDevice(await listProperty(obs, source, 'device'), config.device.name);
    if (value === null) throw new Error(`o OBS não lista o aparelho "${config.device.name}" na fonte ${source}`);
    await kick(obs, source, value, kicked === 0 ? 'plain' : 'reset');
    kicked++;
    w = await pollUntil(read, isNativeLive, 15_000, 500, clock);
  }
  const last = w.last ?? { w: 0, h: 0, nonBlack: false };
  if (!w.ok) throw new Error(`fonte ${source} não ficou viva: ${JSON.stringify(last)}`);
  return { w: last.w, h: last.h, kicked };
}

async function cmdLive(config: Config): Promise<void> {
  const obs = await connectObs(config);
  try {
    console.log(JSON.stringify({ profile: obs.profile, versions: { obs: obs.versions.obsStudioVersion, ws: obs.versions.obsWebSocketVersion }, live: await ensureLive(config, obs) }));
  } finally {
    await obs.close();
  }
}

async function cmdRecord(config: Config, args: string[]): Promise<void> {
  const seconds = Number(opt(args, 'seconds', '180'));
  mkdirSync(SP1_DIR, { recursive: true });
  const dir = realpathSync(SP1_DIR);
  const obs = await connectObs(config);
  const { recordDirectory: previous } = (await obs.request<{ recordDirectory: string }>('GetRecordDirectory')).data;
  try {
    const live = await ensureLive(config, obs);
    console.log(JSON.stringify({ live }));
    await obs.request('SetRecordDirectory', { recordDirectory: dir });
    let stop = false;
    process.once('SIGINT', () => {
      stop = true;
    });
    const rec = await record(obs, {
      dir, durationS: seconds, bitrateKbps: 16_000, minFreeGiB: 4, criticalGiB: 2, stopRequested: () => stop,
    }, {
      freeBytes: async (d) => {
        const s = statfsSync(d);
        return Number(s.bavail) * Number(s.bsize);
      },
      probeOk: async (file) => {
        try {
          await runFfprobe(await openFfmpeg(config), ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]);
          return true;
        } catch {
          return false;
        }
      },
      now: clock.now, sleep: clock.sleep,
      log: (k, data) => console.log(JSON.stringify({ k, ...(data ?? {}) })),
    });
    console.log(JSON.stringify({ file: rec.file, sizeBytes: rec.sizeBytes, startedAtMs: rec.startedAtMs, stoppedAtMs: rec.stoppedAtMs }));
  } finally {
    await obs.request('SetRecordDirectory', { recordDirectory: previous }).catch((e: unknown) => console.error('devolver a pasta falhou:', errCode(e)));
    await obs.close();
  }
}

async function cmdCall(config: Config, args: string[]): Promise<void> {
  const [method, json] = args;
  if (method === undefined) throw new Error('uso: call <method> [json]');
  const params = json === undefined || json.startsWith('--') ? {} : (JSON.parse(json) as Record<string, unknown>);
  const timeoutMs = Number(opt(args, 'timeout', '30000'));
  const t0 = Date.now();
  try {
    const result = await withRunner(config, { role: 'control' }, (c) => c.call(method, params, { timeoutMs }));
    console.log(JSON.stringify({ ok: true, ms: Date.now() - t0, result }));
  } catch (error) {
    console.log(JSON.stringify({ ok: false, ms: Date.now() - t0, code: isContrarregraError(error) ? error.code : undefined, err: errCode(error), data: isContrarregraError(error) ? error.data : undefined }));
    process.exitCode = 2;
  }
}

async function cmdAnalyze(config: Config, args: string[]): Promise<void> {
  const file = args[0];
  if (file === undefined) throw new Error('uso: analyze <arquivo>');
  const fps = opt(args, 'fps', '2');
  const ff = await openFfmpeg(config);
  const out = join(FRAMES_DIR, String(Date.now()));
  mkdirSync(out, { recursive: true });
  await runFfmpeg(ff, ['-i', file, '-vf', `fps=${fps}`, '-q:v', '3', join(out, 'f%05d.jpg')]);
  const frames = readdirSync(out).filter((n) => n.endsWith('.jpg')).sort().map((n) => join(out, n));
  const hits: { frame: string; tS: number; text: string }[] = [];
  const BATCH = 40;
  for (let i = 0; i < frames.length; i += BATCH) {
    const images = await ocrImages(frames.slice(i, i + BATCH));
    images.forEach((img, j) => {
      for (const needle of NEEDLES) {
        for (const box of findText(img.boxes, needle)) hits.push({ frame: frames[i + j]!, tS: (i + j) / Number(fps), text: box.text });
      }
    });
  }
  const report = { file, fps: Number(fps), frames: frames.length, hits: hits.length, sample: hits.slice(0, 10), framesDir: out };
  writeFileSync(join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  if (hits.length === 0 && args.includes('--clean')) rmSync(out, { recursive: true, force: true });
}

/** Aviso falado no Mac (nunca no iPhone; P-7), em português. */
export function say(text: string): void {
  spawn('/usr/bin/say', ['-v', 'Luciana', text], { stdio: 'ignore' }).once('error', () => {});
}

const [cmd, ...rest] = process.argv.slice(2);
const config = loadConfig();
const run = cmd === 'live' ? cmdLive(config) : cmd === 'record' ? cmdRecord(config, rest) : cmd === 'call' ? cmdCall(config, rest)
  : cmd === 'analyze' ? cmdAnalyze(config, rest) : Promise.reject(new Error(`comando desconhecido: ${cmd ?? ''}`));
run.catch((error: unknown) => {
  console.error(errCode(error));
  process.exitCode = 1;
});
