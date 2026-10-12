// Testes da T-0.22, parte `align` e `media`: o invólucro do ffmpeg/ffprobe fixados (`paths.*`, versão
// 8.1.1 conferida; P-1, P-7), T0 pelas marcas (S7 item 3; forma sintética de AC-7.2), detecção por
// região (S7 item 4; AC-7.6), ajuste V = α + (1+β)·P e erro deixando um de fora (S7 itens 4–6; forma
// sintética de AC-7.3) e os tempos de cada evento (S7 item 5). Os vídeos de teste são gerados por
// `ffmpeg -f lavfi` (com `drawbox`; o 8.1.1 fixado não tem `drawtext`) num diretório temporário e
// apagados no fim — nunca no repositório (HC-7, P-3). Curtos e pequenos de propósito.

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { subscribe, unsubscribe } from 'node:diagnostics_channel';
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadConfig, type Config } from '../src/core/config.ts';
import { isContrarregraError } from '../src/core/errors.ts';
import type { Event, Rect } from '../src/core/types.ts';
import { fitClock, type ClockFit, type Exchange } from '../src/clock/ntp.ts';
import {
  eventTimes,
  fitCaptureLatency,
  predictRawS,
  type VisualPoint,
} from '../src/align/latency.ts';
import { fitT0, macToRecordingS, measureMarks, recordingMap, type RecordingMap } from '../src/align/marks.ts';
import { CHANGE_YMAX, detectRegionChange, PX_PER_PT, regionPx } from '../src/align/region.ts';
import {
  openFfmpeg,
  probeVideo,
  runFfmpeg,
  signalstats,
  type Ffmpeg,
  type FrameStats,
  type VideoInfo,
} from '../src/media/ffmpeg.ts';

const dir = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'contrarregra-align-test-')));
after(() => {
  rmSync(dir, { recursive: true, force: true });
});

const config = loadConfig({ configPath: join(dir, 'sem-config.json') });

/** PRNG determinístico (mulberry32). */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MS = 1_000_000;
const SECOND = 1_000_000_000n;
const FPS = 60;
const DT = 1 / FPS;
const DT_NS = 1e9 / FPS;

function ns(ms: number): bigint {
  return BigInt(Math.round(ms * MS));
}

let ffShared: Ffmpeg | undefined;
async function ff(): Promise<Ffmpeg> {
  ffShared ??= await openFfmpeg(config);
  return ffShared;
}

async function lavfi(out: string, size: string, frames: number, filters: string[], extra: string[] = []): Promise<void> {
  await runFfmpeg(await ff(), [
    '-f', 'lavfi', '-i', `color=c=0x303030:s=${size}:r=${FPS}`,
    '-vf', filters.join(','),
    '-frames:v', String(frames),
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', ...extra,
    '-y', out,
  ]);
}

// ── media/ffmpeg: o invólucro dos binários fixados ──────────────────────────────────────────────

describe('media/ffmpeg: ffmpeg/ffprobe só pelo caminho fixado da config, versão conferida', () => {
  test('abre pelos `paths.*` da config e confere a versão validada (8.1.1)', async () => {
    const opened = await ff();
    assert.equal(opened.ffmpeg, config.paths.ffmpeg);
    assert.equal(opened.ffprobe, config.paths.ffprobe);
    assert.equal(opened.ffmpeg, '/opt/homebrew/opt/ffmpeg/bin/ffmpeg');
    assert.equal(opened.version, '8.1.1');
    assert.equal(opened.version, config.toolchain.validated['ffmpeg']);
  });

  test('caminho relativo (busca no PATH, onde está o 4.4.7) → E_CONFIG sem criar processo', async () => {
    const spawned: unknown[] = [];
    const onChild = (message: unknown): void => {
      spawned.push(message);
    };
    subscribe('child_process', onChild);
    try {
      for (const paths of [
        { ...config.paths, ffmpeg: 'ffmpeg' },
        { ...config.paths, ffprobe: 'bin/ffprobe' },
      ]) {
        const bad: Config = { ...config, paths };
        await assert.rejects(openFfmpeg(bad), (err: unknown) => {
          assert.ok(isContrarregraError(err, 'E_CONFIG'), String(err));
          assert.match(err.message, /caminho absoluto/);
          return true;
        });
      }
      assert.deepEqual(spawned, []);
    } finally {
      unsubscribe('child_process', onChild);
    }
  });

  test('versão diferente da validada, ou binário ausente → E_TOOLCHAIN_MISMATCH', async () => {
    const fake = join(dir, 'ffmpeg-falso');
    writeFileSync(fake, '#!/bin/sh\necho "ffmpeg version 4.4.7 Copyright (c) 2000-2024 the FFmpeg developers"\n');
    chmodSync(fake, 0o755);
    await assert.rejects(openFfmpeg({ ...config, paths: { ...config.paths, ffmpeg: fake } }), (err: unknown) => {
      assert.ok(isContrarregraError(err, 'E_TOOLCHAIN_MISMATCH'), String(err));
      assert.deepEqual(err.data, { tool: 'ffmpeg', path: fake, found: '4.4.7', expected: '8.1.1' });
      return true;
    });
    const missing = join(dir, 'nao-existe', 'ffprobe');
    await assert.rejects(openFfmpeg({ ...config, paths: { ...config.paths, ffprobe: missing } }), (err: unknown) =>
      isContrarregraError(err, 'E_TOOLCHAIN_MISMATCH'),
    );
  });

  test('objeto que não veio do openFfmpeg é recusado (nada de caminho solto)', async () => {
    const loose: Ffmpeg = { ffmpeg: config.paths.ffmpeg, ffprobe: config.paths.ffprobe, version: '8.1.1' };
    await assert.rejects(probeVideo(loose, join(dir, 'x.mp4')), /openFfmpeg/);
    await assert.rejects(runFfmpeg(loose, ['-version']), /openFfmpeg/);
  });

  test('probeVideo e signalstats (pts_time e YAVG por quadro, janela com pts absolutos)', async () => {
    const video = join(dir, 'probe.mp4');
    await lavfi(video, '64x48', 30, [`drawbox=x=0:y=0:w=iw:h=ih:color=white:t=fill:enable='eq(n,10)'`]);
    const info = await probeVideo(await ff(), video);
    assert.deepEqual(
      { width: info.width, height: info.height, fps: info.fps, frames: Math.round(info.durationS * FPS) },
      { width: 64, height: 48, fps: 60, frames: 30 },
    );
    assert.ok(Math.abs(info.frameDurationS - DT) < 1e-12);
    const stats = await signalstats(await ff(), video, { startS: 8.5 * DT, durationS: 4 * DT });
    assert.deepEqual(stats.map((s) => Math.round(s.ptsS * FPS)), [9, 10, 11, 12]);
    const yavg = stats.map((s) => s.values['YAVG']!);
    assert.ok(yavg[1]! > 200 && yavg[0]! < 80 && yavg[2]! < 80, JSON.stringify(yavg));
  });

  const whiteFrames = (stats: FrameStats[], startR = 0): number[] =>
    stats.filter((s) => s.values['YAVG']! > 150).map((s) => Math.round((s.ptsS - startR) * FPS));

  test('base de tempo R = pts − start_time do arquivo: o mesmo quadro tem o mesmo R com e sem janela (start_time 0,5 s)', async (t) => {
    const video = join(dir, 'offset.mp4');
    await lavfi(video, '64x48', 120, [`drawbox=x=0:y=0:w=iw:h=ih:color=white:t=fill:enable='eq(n,10)+eq(n,60)'`], [
      '-output_ts_offset', '0.5',
    ]);
    const info = await probeVideo(await ff(), video);
    assert.ok(Math.abs(info.startTimeS - 0.5) < 1e-6, `premissa: start_time ${info.startTimeS}`);
    assert.ok(Math.abs(info.videoStartR) < 1e-6, `1.º quadro em R = ${info.videoStartR}`);

    const whole = await signalstats(await ff(), video);
    assert.equal(whole.length, 120);
    assert.ok(Math.abs(whole[0]!.ptsS) < 1e-6, `sem janela, 1.º quadro em R = ${whole[0]!.ptsS}`);
    assert.deepEqual(whiteFrames(whole), [10, 60]);
    assert.deepEqual(whiteFrames(await signalstats(await ff(), video, { startS: 0, durationS: 1 })), [10]);
    const early = await signalstats(await ff(), video, { startS: 0.1, durationS: 0.2 });
    assert.deepEqual(early.map((s) => Math.round(s.ptsS * FPS)), [6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17]);
    const late = await signalstats(await ff(), video, { startS: 0.95, durationS: 0.3 });
    assert.equal(Math.round(late[0]!.ptsS * FPS), 57);
    assert.deepEqual(whiteFrames(late), [60]);

    // As marcas (S7 item 3) saem no mesmo R com e sem janela.
    const all = await measureMarks(await ff(), video);
    const windowed = await measureMarks(await ff(), video, { startS: 0, durationS: 0.5 });
    assert.deepEqual(all.marks.map((m) => Math.round(m.ptsS * FPS)), [10, 60]);
    assert.deepEqual(windowed.marks.map((m) => m.ptsS), [all.marks[0]!.ptsS]);
    t.diagnostic(`start_time 0,5 s: quadro 10 em R = ${all.marks[0]!.ptsS} sem janela e ${windowed.marks[0]!.ptsS} com janela`);
  });

  test('áudio antes do vídeo: R parte do start_time do arquivo (o do áudio) e a janela vale nas duas pontas', async () => {
    const video = join(dir, 'av.mp4');
    await runFfmpeg(await ff(), [
      '-itsoffset', '0.5', '-f', 'lavfi', '-i', 'color=c=0x303030:s=64x48:r=60:d=1',
      '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono:d=1.5',
      '-vf', `drawbox=x=0:y=0:w=iw:h=ih:color=white:t=fill:enable='eq(n,10)'`,
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
      '-y', video,
    ]);
    const info = await probeVideo(await ff(), video);
    assert.ok(info.videoStartR > 0.4, `premissa: o vídeo começa depois do áudio (R = ${info.videoStartR})`);
    const r10 = info.videoStartR + 10 * DT;

    const whole = await signalstats(await ff(), video);
    assert.ok(Math.abs(whole[0]!.ptsS - info.videoStartR) < 2e-6, `1.º quadro em R = ${whole[0]!.ptsS}`);
    assert.deepEqual(whiteFrames(whole, info.videoStartR), [10]);
    const around = await signalstats(await ff(), video, { startS: r10 - 0.05, durationS: 0.1 });
    const white = around.filter((s) => s.values['YAVG']! > 150);
    assert.equal(white.length, 1);
    assert.ok(Math.abs(white[0]!.ptsS - r10) < 2e-6, `com janela, quadro 10 em R = ${white[0]!.ptsS} × ${r10}`);
    // Janela inteira antes do 1.º quadro de vídeo: nenhum quadro (o `-t` de entrada do ffmpeg sozinho
    // devolveria quadros depois do fim pedido).
    assert.deepEqual(await signalstats(await ff(), video, { startS: 0, durationS: info.videoStartR - 0.1 }), []);
    const span = { startS: info.videoStartR + 0.1, durationS: 0.1 };
    const inside = await signalstats(await ff(), video, span);
    assert.ok(inside.length >= 5 && inside.length <= 6, `${inside.length} quadros`);
    for (const s of inside) assert.ok(s.ptsS >= span.startS - 1e-6 && s.ptsS < span.startS + span.durationS, String(s.ptsS));
  });
});

// ── S7 item 3: T0 pelas marcas ──────────────────────────────────────────────────────────────────

const T0_TRUE = 1_234_567_890_123_456n + 30n * SECOND; // M (ns) do quadro R = 0

/** Marcas plantadas: primeiro quadro de cada uma e o T1 do envio (dentro do quadro anterior à marca). */
function plantMarks(rand: () => number, firstFrame: number, t0: bigint, drift = 0): { frames: number[]; sends: bigint[] } {
  const frames: number[] = [];
  let k = firstFrame;
  for (let i = 0; i < 8; i++) {
    frames.push(k);
    k += Math.round((400 + rand() * 500) / (1000 * DT)); // 400–900 ms
  }
  const sends = frames.map((f) => {
    const u = 0.05 + rand() * 0.9;
    return t0 + BigInt(Math.round((f - u) * DT_NS * (1 + drift)));
  });
  return { frames, sends };
}

describe('S7 item 3: T0 pelas marcas "Sync Flash" (YAVG)', () => {
  const video = join(dir, 'marks.mp4');
  const rand = rng(33);
  const planted = plantMarks(rand, 120, T0_TRUE); // 2 s parado antes da 1.ª marca
  const totalFrames = planted.frames.at(-1)! + 2 + 90; // ≥ 1,5 s parado depois

  before(async () => {
    const flash = planted.frames.map((f) => `between(n,${f},${f + 1})`).join('+');
    await lavfi(video, '390x844', totalFrames, [
      'drawgrid=w=65:h=65:t=4:c=0x6a6a6a',
      'drawbox=x=40:y=120:w=80:h=80:color=0x9a5a2a:t=fill',
      'drawbox=x=270:y=600:w=80:h=80:color=0x2a7a9a:t=fill',
      `drawbox=x=0:y=0:w=iw:h=ih:color=white:t=fill:enable='${flash}'`,
      // B-frames sem edit list, como uma gravação sem áudio: start_time ≈ 0,033 s ≠ 0.
    ], ['-crf', '23', '-g', '60', '-bf', '2', '-use_editlist', '0']);
  });

  test('AC-7.2 (sintético): as 8 marcas são achadas no quadro certo; |T0ᵢ − T0| ≤ 17 ms; erro padrão ≤ 3 ms; T0 recuperado', async (t) => {
    const info = await probeVideo(await ff(), video);
    assert.ok(info.startTimeS > 0.01, `premissa: start_time ${info.startTimeS} ≠ 0`);
    const measured = await measureMarks(await ff(), video);
    assert.equal(measured.fps, 60);
    assert.deepEqual(measured.marks.map((m) => Math.round(m.ptsS * FPS)), planted.frames);
    for (const m of measured.marks) assert.ok(Math.abs(m.ptsS * FPS - Math.round(m.ptsS * FPS)) < 1e-4);
    // Só o pré-rolo como janela: as mesmas marcas, no mesmo R.
    const windowed = await measureMarks(await ff(), video, { startS: 1.9, durationS: totalFrames * DT - 1.9 });
    assert.deepEqual(windowed.marks.map((m) => m.ptsS), measured.marks.map((m) => m.ptsS));

    const fit = fitT0(planted.sends, measured.marks, measured.fps);
    assert.equal(fit.markers, 8);
    assert.equal(fit.fps, 60);
    assert.ok(fit.maxMarkerDevMs <= 17, `maxMarkerDevMs ${fit.maxMarkerDevMs}`);
    assert.ok(fit.t0StdErrMs <= 3, `t0StdErrMs ${fit.t0StdErrMs}`);
    const errMs = Number(fit.t0MacNs - T0_TRUE) / MS;
    assert.ok(Math.abs(errMs) <= (DT * 1000) / 2, `T0 recuperado erra ${errMs} ms`);
    // T0ᵢ = T1ᵢ − kᵢ·Δ + Δ/2, um por marca; T0 = média. (O `pts_time` vem com 6 casas: ±0,5 µs.)
    assert.equal(fit.t0iNs.length, 8);
    fit.t0iNs.forEach((t0i, i) => {
      const expected = planted.sends[i]! - BigInt(Math.round(planted.frames[i]! * DT_NS)) + BigInt(Math.round(DT_NS / 2));
      assert.ok(Math.abs(Number(t0i - expected)) <= 1000, `T0${i}: ${Number(t0i - expected)} ns`);
    });
    t.diagnostic(
      `8/8 marcas nos quadros plantados ${planted.frames.join(',')}; T0 recuperado − plantado = ${errMs.toFixed(3)} ms; ` +
        `erro padrão ${fit.t0StdErrMs.toFixed(3)} ms; máx |T0ᵢ − T0| ${fit.maxMarkerDevMs.toFixed(3)} ms`,
    );
  });

  test('E-7.2: sem marca na janela (ou faltando uma) → E_OBS_CONFIG', async () => {
    const still = await measureMarks(await ff(), video, { startS: 0, durationS: 1.9 });
    assert.deepEqual(still.marks, []);
    assert.throws(() => fitT0(planted.sends, still.marks, 60), (err: unknown) => isContrarregraError(err, 'E_OBS_CONFIG'));
    const seven = planted.frames.slice(1).map((f) => ({ ptsS: f * DT }));
    assert.throws(() => fitT0(planted.sends, seven, 60), (err: unknown) => {
      assert.ok(isContrarregraError(err, 'E_OBS_CONFIG'));
      assert.deepEqual(err.data, { sent: 8, found: 7 });
      return true;
    });
  });

  test('pré + pós dão a deriva (numérico, 10 min entre os rolos)', (t) => {
    const r = rng(34);
    const drift = 50e-6;
    const pre = plantMarks(r, 120, T0_TRUE, drift);
    const post = plantMarks(r, 120 + 600 * FPS, T0_TRUE, drift);
    const preFit = fitT0(pre.sends, pre.frames.map((f) => ({ ptsS: f * DT })), FPS);
    const postFit = fitT0(post.sends, post.frames.map((f) => ({ ptsS: f * DT })), FPS);
    const map = recordingMap(preFit, postFit);
    assert.ok(Math.abs(map.driftPpm - 50) <= 15, `deriva ${map.driftPpm} ppm`);
    assert.ok(Math.abs(Number(map.t0MacNs - T0_TRUE)) <= DT_NS, `T0 da reta ${Number(map.t0MacNs - T0_TRUE) / MS} ms`);
    const midFrame = 300 * FPS;
    const midMac = T0_TRUE + BigInt(Math.round(midFrame * DT_NS * (1 + drift)));
    assert.ok(Math.abs(macToRecordingS(map, midMac) - midFrame * DT) <= DT, 'M → R no meio');

    t.diagnostic(`deriva plantada 50 ppm → recuperada ${map.driftPpm.toFixed(2)} ppm; T0 da reta − plantado ${(Number(map.t0MacNs - T0_TRUE) / MS).toFixed(3)} ms`);
    const preOnly = recordingMap(preFit);
    assert.equal(preOnly.drift, 0);
    assert.equal(preOnly.t0MacNs, preFit.t0MacNs);
  });
});

// ── S7 item 4: detecção por região ──────────────────────────────────────────────────────────────

describe('S7 item 4: detecção por região (YDIF; tblend YMAX ≥ 64)', () => {
  const video = join(dir, 'region.mp4');
  let info: VideoInfo;
  // Alvos em pontos (frame da árvore de acessibilidade); a região em px = pt × 3.
  const A: Rect = { x: 40, y: 300, w: 100, h: 44 };
  const SUBTLE: Rect = { x: 40, y: 500, w: 100, h: 44 };
  const STILL: Rect = { x: 200, y: 500, w: 100, h: 44 };

  before(async () => {
    await lavfi(video, '1170x2532', 150, [
      'drawgrid=w=90:h=90:t=3:c=0x707070',
      // Fora da região A: muda no quadro 20.
      `drawbox=x=600:y=300:w=200:h=200:color=white:t=fill:enable='gte(n,20)'`,
      // Dentro de A: acende no quadro 30 e muda de novo no 60.
      `drawbox=x=150:y=920:w=240:h=92:color=white:t=fill:enable='between(n,30,59)'`,
      `drawbox=x=150:y=920:w=240:h=92:color=0x606060:t=fill:enable='gte(n,60)'`,
      // Mudança sutil (|Δ| = 32 < 64, sobre o fundo e sobre a grade) no quadro 90, dentro de SUBTLE.
      `drawbox=x=150:y=1520:w=240:h=92:color=0x505050:t=fill:enable='gte(n,90)'`,
    ], ['-crf', '28', '-g', '30', '-output_ts_offset', '0.5']); // start_time 0,5 s: as janelas são em R
    info = await probeVideo(await ff(), video);
  });

  test('a janela pedida em R vale com start_time ≠ 0 (0,5 s): mudança em R = 1,0 achada; fora da janela, não', async () => {
    assert.ok(Math.abs(info.startTimeS - 0.5) < 1e-6, `premissa: start_time ${info.startTimeS}`);
    const region = regionPx(A, info)!;
    const at1 = await detectRegionChange(await ff(), video, info, { region, fromS: 0.95, toS: 1.25 });
    assert.ok(at1, 'mudança do quadro 60 (R = 1,0) não achada');
    assert.ok(Math.abs(at1.ptsS - 1) < 1e-6, `R ${at1.ptsS}`);
    assert.equal(await detectRegionChange(await ff(), video, info, { region, fromS: 0.55, toS: 0.9 }), null);
    const at05 = await detectRegionChange(await ff(), video, info, { region, fromS: 0.45, toS: 0.75 });
    assert.ok(at05 && Math.abs(at05.ptsS - 0.5) < 1e-6, JSON.stringify(at05));
  });

  test('região = frame em pontos × 3 px/pt, arredondada para fora e recortada na tela', () => {
    assert.equal(PX_PER_PT, 3);
    assert.equal(CHANGE_YMAX, 64);
    const screen = { width: 1170, height: 2532 };
    assert.deepEqual(regionPx(A, screen), { x: 120, y: 900, w: 300, h: 132 });
    assert.deepEqual(regionPx({ x: 40.2, y: 300.5, w: 100, h: 44 }, screen), { x: 120, y: 901, w: 301, h: 133 });
    assert.deepEqual(regionPx({ x: 380, y: 830, w: 20, h: 30 }, screen), { x: 1140, y: 2490, w: 30, h: 42 });
    assert.equal(regionPx({ x: 400, y: 10, w: 20, h: 20 }, screen), null);
    assert.equal(regionPx({ x: 10, y: 10, w: 0, h: 20 }, screen), null);
    assert.deepEqual(regionPx(A, { width: 390, height: 844 }, 1), { x: 40, y: 300, w: 100, h: 44 });
  });

  test('acha o primeiro quadro que muda depois do previsto, no quadro exato; mudança fora da região é ignorada', async (t) => {
    const region = regionPx(A, info)!;
    const first = await detectRegionChange(await ff(), video, info, { region, fromS: 0.2, toS: 0.9 });
    assert.ok(first, 'mudança não achada');
    assert.equal(Math.round(first.ptsS * FPS), 30); // o quadro 20 (fora da região) não conta
    assert.ok(Math.abs(first.ptsS - 30 * DT) < 1e-6);
    assert.ok(first.ymax >= 64 && first.score > 0, JSON.stringify(first));

    const later = await detectRegionChange(await ff(), video, info, { region, fromS: 0.6, toS: 1.4 });
    assert.ok(later);
    assert.equal(Math.round(later.ptsS * FPS), 60); // a mudança do quadro 30 é antes do previsto
    t.diagnostic(`plantado quadro 30 → achado ${first.ptsS} s (YDIF ${first.score}, YMAX ${first.ymax}); plantado 60 → achado ${later.ptsS} s`);
  });

  test('mudança sutil (YMAX < 64) não é classificada como mudança → null', async (t) => {
    const region = regionPx(SUBTLE, info)!;
    assert.equal(await detectRegionChange(await ff(), video, info, { region, fromS: 1.2, toS: 2.4 }), null);
    // Controle: a mudança existe (YDIF > 0 no quadro 90), só não passa da classificação.
    const ydif = await signalstats(await ff(), video, { crop: region, startS: 1.45, durationS: 0.1 });
    const diff = await signalstats(await ff(), video, { crop: region, difference: true, startS: 1.45, durationS: 0.1 });
    const at90 = ydif.find((s) => Math.round(s.ptsS * FPS) === 90);
    const ymax90 = diff.find((s) => Math.round(s.ptsS * FPS) === 90)?.values['YMAX'];
    assert.ok(at90 && at90.values['YDIF']! > 0, 'a mudança sutil deveria existir');
    assert.ok(ymax90 !== undefined && ymax90 < CHANGE_YMAX, `YMAX ${ymax90}`);
    t.diagnostic(`quadro 90: YDIF ${at90.values['YDIF']} e YMAX ${ymax90} (< ${CHANGE_YMAX}) → não conta`);
  });

  test('AC-7.6: região sem mudança (com keyframes no meio) → null, sem exceção', async () => {
    const region = regionPx(STILL, info)!;
    assert.equal(await detectRegionChange(await ff(), video, info, { region, fromS: 0, toS: 2.45 }), null);
  });
});

// ── S7 itens 4–6: ajuste V = α + (1+β)·P e erro deixando um de fora ─────────────────────────────

interface Truth {
  aNs: bigint;
  b: number;
}

function trueDevice(truth: Truth, macNs: bigint): bigint {
  return truth.aNs + macNs + BigInt(Math.round(truth.b * Number(macNs)));
}

function simulateBurst(truth: Truth, startMacNs: bigint, rand: () => number): Exchange[] {
  const out: Exchange[] = [];
  for (let i = 0; i < 32; i++) {
    const t1 = startMacNs + BigInt(i) * 10n * BigInt(MS);
    const received = t1 + ns(0.25 + -Math.log(1 - rand()) * 0.3 + (rand() < 0.15 ? 2 + rand() * 38 : 0));
    const replied = received + ns(0.05 + rand() * 0.05);
    const t4 = replied + ns(0.3 + -Math.log(1 - rand()) * 0.3 + (rand() < 0.15 ? 2 + rand() * 38 : 0));
    out.push({ t1, t2: trueDevice(truth, received), t3: trueDevice(truth, replied), t4 });
  }
  return out;
}

describe('S7 itens 4–6 de ponta a ponta: deslocamento, deriva e latência plantados e recuperados', () => {
  const video = join(dir, 'take.mp4');
  const rand = rng(46);
  const clockTruth: Truth = { aNs: 259_200_000_000_000n + 987_654_321n, b: 62.5e-6 };
  const ALPHA = 0.142; // latência de captura plantada (s)
  const BETA = 0.004; // inclinação plantada
  const NO_CHANGE = 6; // passo cujo quadro não muda (AC-7.6)
  const steps = Array.from({ length: 13 }, (_, i) => {
    const macNs = T0_TRUE + ns(1000 + 850 * i + rand() * 100);
    const pTrue = Number(macNs - T0_TRUE) / 1e9;
    const frame = Math.ceil((ALPHA + (1 + BETA) * pTrue) * FPS - 1e-9);
    const rectPt: Rect = { x: 20 + (i % 3) * 125, y: 40 + Math.floor(i / 3) * 150, w: 100, h: 60 };
    return { i, dNs: trueDevice(clockTruth, macNs), frame, rectPt };
  });
  const totalFrames = Math.max(...steps.map((s) => s.frame)) + 30;
  let clock: ClockFit;
  let recording: RecordingMap;
  let info: VideoInfo;
  const points: (VisualPoint & { frame: number })[] = [];

  before(async () => {
    const filters = ['drawgrid=w=50:h=50:t=2:c=0x5a5a5a'];
    for (const s of steps) {
      const { x, y, w, h } = s.rectPt;
      filters.push(`drawbox=x=${x}:y=${y}:w=${w}:h=${h}:color=0x505050:t=fill`);
      if (s.i !== NO_CHANGE) filters.push(`drawbox=x=${x + 10}:y=${y + 10}:w=${w - 20}:h=${h - 20}:color=white:t=fill:enable='gte(n,${s.frame})'`);
    }
    // B-frames sem edit list (start_time ≈ 0,033 s ≠ 0): previsto e observado na mesma base R.
    await lavfi(video, '390x844', totalFrames, filters, ['-crf', '26', '-g', '60', '-bf', '2', '-use_editlist', '0']);
    info = await probeVideo(await ff(), video);
    assert.ok(info.startTimeS > 0.01, `premissa: start_time ${info.startTimeS} ≠ 0`);

    // Elo 1 (S7 item 2): rajadas pré, no meio e pós.
    const r = rng(47);
    clock = fitClock([-5n, 6n, 14n].map((s) => simulateBurst(clockTruth, T0_TRUE + s * SECOND, r)));
    // Elo 2 (S7 item 3): 8 marcas do pré-rolo (numéricas aqui; o vídeo das marcas está testado acima).
    const marks = plantMarks(r, 3, T0_TRUE);
    recording = recordingMap(fitT0(marks.sends, marks.frames.map((f) => ({ ptsS: f * DT })), FPS));

    // Elo 3 (S7 item 4): região de cada passo visual, a partir do previsto.
    for (const s of steps) {
      const pS = predictRawS(s.dNs, clock, recording);
      const region = regionPx(s.rectPt, info, 1)!;
      const change = await detectRegionChange(await ff(), video, info, { region, fromS: pS, toS: pS + 0.6 });
      points.push({ pS, vS: change ? change.ptsS : null, frame: s.frame });
    }
  });

  test('cada mudança plantada é achada no quadro exato; o passo sem mudança fica null (AC-7.6)', () => {
    points.forEach((p, i) => {
      if (i === NO_CHANGE) assert.equal(p.vS, null);
      else {
        assert.ok(p.vS !== null, `passo ${i} não detectado`);
        assert.ok(Math.abs(p.vS - p.frame * DT) < 1e-6, `passo ${i}: ${p.vS} × quadro ${p.frame}`);
      }
    });
  });

  test('AC-7.3 (sintético): α e β recuperados; erro deixando um de fora com mediana ≤ 50 ms e máximo ≤ 100 ms', (t) => {
    const fit = fitCaptureLatency(points, { captureLatencyMs: ALPHA * 1000 });
    assert.equal(fit.basis, 'fit');
    assert.equal(fit.eventsUsed, 12);
    assert.ok(Math.abs(fit.alphaS - ALPHA) <= 1.5 * DT, `α ${fit.alphaS} × plantado ${ALPHA}`);
    assert.ok(Math.abs(fit.beta - BETA) <= 0.0015, `β ${fit.beta} × plantado ${BETA}`);
    assert.ok(fit.error, 'erro não avaliado');
    assert.equal(fit.error.method, 'leave-one-out');
    assert.ok(fit.error.medianMs <= 50 && fit.error.maxMs <= 100, JSON.stringify(fit.error));
    assert.ok(fit.error.rawMaxMs >= fit.error.rawMedianMs && fit.error.rawMedianMs >= 0);
    assert.equal(fit.ok, true);
    assert.deepEqual(fit.warnings, []);
    t.diagnostic(
      `relógio: b plantado 62.5 ppm → ${clock.bPpm.toFixed(3)} ppm (resíduo ${clock.residualMs.toFixed(3)} ms); ` +
        `α plantado ${ALPHA * 1000} ms → ${(fit.alphaS * 1000).toFixed(2)} ms; β plantado ${BETA} → ${fit.beta.toFixed(5)}; ` +
        `erro deixando um de fora: mediana ${fit.error.medianMs.toFixed(2)} ms, máx ${fit.error.maxMs.toFixed(2)} ms; ` +
        `bruto (só θ, T0 e 142 ms): mediana ${fit.error.rawMedianMs.toFixed(2)} ms, máx ${fit.error.rawMaxMs.toFixed(2)} ms`,
    );

    // S7 item 5: tRecS do passo cai no quadro observado (± 1 quadro); tFinalS = tRecS − trim.startR.
    const step = steps[0]!;
    const event: Event = { seq: 41, kind: 'step.end', tDispatchNs: step.dNs.toString() };
    const times = eventTimes(event, { clock, recording, latency: fit, trimStartR: 0.5 });
    assert.ok(times);
    assert.ok(Math.abs(times.tRecS - step.frame * DT) <= DT, `tRecS ${times.tRecS} × ${step.frame * DT}`);
    assert.ok(Math.abs(times.tFinalS - (times.tRecS - 0.5)) < 1e-9);
  });
});

describe('S7 itens 5–6: regras do ajuste e do erro (numérico)', () => {
  const line = (n: number, alpha = 0.1, beta = 0): VisualPoint[] =>
    Array.from({ length: n }, (_, i) => ({ pS: 1 + i, vS: alpha + (1 + beta) * (1 + i) }));

  test('erro deixando um de fora expõe um passo fora da reta (não esconde viés)', () => {
    const clean = fitCaptureLatency(line(12, 0.1, 0.002), {});
    assert.ok(clean.error && clean.error.maxMs < 1e-6 && clean.ok);
    assert.ok(Math.abs(clean.alphaS - 0.1) < 1e-9 && Math.abs(clean.beta - 0.002) < 1e-9);

    const points = line(12);
    points[5] = { pS: points[5]!.pS, vS: points[5]!.vS! + 0.2 };
    const fit = fitCaptureLatency(points, {});
    assert.ok(fit.error);
    assert.ok(Math.abs(fit.error.maxMs - 200) < 1e-6, `máximo ${fit.error.maxMs}`);
    assert.equal(fit.ok, false);
  });

  test('menos de 2 detectados: α = sync.captureLatencyMs e β = 0 ("calibrated"); campo vazio → α = 0, "none", aviso E_SYNC_QUALITY', () => {
    const one: VisualPoint[] = [{ pS: 1, vS: 1.2 }, { pS: 2, vS: null }];
    const calibrated = fitCaptureLatency(one, { captureLatencyMs: 120 });
    assert.deepEqual(
      { basis: calibrated.basis, alphaS: calibrated.alphaS, beta: calibrated.beta, eventsUsed: calibrated.eventsUsed, error: calibrated.error, ok: calibrated.ok, warnings: calibrated.warnings },
      { basis: 'calibrated', alphaS: 0.12, beta: 0, eventsUsed: 0, error: null, ok: false, warnings: [] },
    );
    const none = fitCaptureLatency([{ pS: 1, vS: null }], {});
    assert.equal(none.basis, 'none');
    assert.equal(none.alphaS, 0);
    assert.equal(none.beta, 0);
    assert.equal(none.ok, false);
    assert.equal(none.error, null);
    assert.equal(none.warnings.length, 1);
    assert.equal(none.warnings[0]!.code, 'E_SYNC_QUALITY');
  });

  test('de 2 a 9 detectados: ajusta, mas error = null e ok = false (não conta para SM-2)', () => {
    for (const n of [2, 9]) {
      const fit = fitCaptureLatency(line(n, 0.15), { captureLatencyMs: 100 });
      assert.equal(fit.basis, 'fit');
      assert.equal(fit.eventsUsed, n);
      assert.ok(Math.abs(fit.alphaS - 0.15) < 1e-9);
      assert.equal(fit.error, null);
      assert.equal(fit.ok, false);
    }
    const ten = fitCaptureLatency(line(10, 0.15), {});
    assert.ok(ten.error && ten.ok);
  });

  test('item 5: passo (tDispatchNs), evento do runner sem tDispatchNs (tDevStartNs) e evento do Mac (só T0)', () => {
    const clock: ClockFit = { aNs: 1_000_000_000n, b: 0, bPpm: 0, residualMs: 0, samples: 8, bursts: 1, slopeEstimated: false, warnings: [] };
    const recording: RecordingMap = { t0MacNs: 5_000_000_000n, drift: 0, driftPpm: 0 };
    const ctx = { clock, recording, latency: { alphaS: 0.15, beta: 0.01 }, trimStartR: 0.5 };
    const close = (actual: number | undefined, expected: number): void => {
      assert.ok(actual !== undefined && Math.abs(actual - expected) < 1e-9, `${actual} × ${expected}`);
    };

    const step = eventTimes({ seq: 1, kind: 'step.end', tDevStartNs: '6900000000', tDispatchNs: '7000000000' }, ctx);
    close(step?.tPredRawS, 1.0);
    close(step?.tRecS, 1.16);
    close(step?.tFinalS, 0.66);

    const scene = eventTimes({ seq: 2, kind: 'scene.start', tDevStartNs: '8500000000' }, ctx);
    close(scene?.tPredRawS, 2.5);
    close(scene?.tRecS, 2.675);
    close(scene?.tFinalS, 2.175);

    const mac = eventTimes({ seq: 3, kind: 'obs.chapter', tMacNs: '9000000000' }, ctx);
    close(mac?.tPredRawS, 4.0);
    close(mac?.tRecS, 4.0);
    close(mac?.tFinalS, 3.5);

    assert.equal(eventTimes({ seq: 4, kind: 'take.end' }, ctx), null);
  });
});
