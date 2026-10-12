// Testes da T-0.22, parte `clock`: relógio aparelho → Mac por trocas NTP com ajuste Theil-Sen (S7
// item 2; forma sintética de AC-7.1) e o código do relógio de calibração (S0.10; AC-0.8, parte do
// decodificador do Mac). Dados sintéticos com deslocamento e deriva plantados; o vídeo de teste do
// código é gerado pelo ffmpeg 8.1.1 fixado (`paths.ffmpeg` da config) com `drawbox` num diretório
// temporário e apagado no fim — nunca no repositório (HC-7, P-3).

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadConfig } from '../src/core/config.ts';
import { isContrarregraError } from '../src/core/errors.ts';
import {
  CODE_BITS,
  CODE_COLUMNS,
  CODE_ROWS,
  clockCodeValueMs,
  decodeClockCode,
  decodeClockVideo,
  encodeClockCode,
  type ClockCodeGeometry,
  type GrayImage,
} from '../src/clock/code.ts';
import {
  deviceToMacNs,
  exchangeDelayNs,
  exchangeOffsetNs,
  fitClock,
  macToDeviceNs,
  offsetAtNs,
  selectLowestDelay,
  type Exchange,
} from '../src/clock/ntp.ts';
import { openFfmpeg, probeVideo, runFfmpeg, type Ffmpeg } from '../src/media/ffmpeg.ts';

const dir = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'contrarregra-clock-test-')));
after(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** PRNG determinístico (mulberry32): os mesmos dados sintéticos a cada execução. */
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

// ── S7 item 2: trocas NTP e ajuste θ(t) = a + b·t ───────────────────────────────────────────────

/** A verdade plantada: D = a + (1 + b)·M (θ = D − M = a + b·M), com M e D em ns. */
interface Truth {
  aNs: bigint;
  b: number;
}

function trueDevice(truth: Truth, macNs: bigint): bigint {
  return truth.aNs + macNs + BigInt(Math.round(truth.b * Number(macNs)));
}

function trueOffset(truth: Truth, macNs: bigint): number {
  return Number(truth.aNs) + truth.b * Number(macNs);
}

function ns(ms: number): bigint {
  return BigInt(Math.round(ms * MS));
}

interface DelayModel {
  /** Atraso de ida (Mac → aparelho) e de volta, em ms. */
  forward: (rand: () => number) => number;
  back: (rand: () => number) => number;
}

/** Atraso típico do cabo: base + cauda exponencial + 15 % de picos de 2–40 ms (bloqueio de fila). */
function usbDelay(baseMs: number): (rand: () => number) => number {
  return (rand) => {
    const tail = -Math.log(1 - rand()) * 0.3;
    const spike = rand() < 0.15 ? 2 + rand() * 38 : 0;
    return baseMs + tail + spike;
  };
}

const USB: DelayModel = { forward: usbDelay(0.25), back: usbDelay(0.3) };

/** Uma rajada de S7 item 2: 32 trocas de 4 carimbos a 10 ms de intervalo. */
function simulateBurst(truth: Truth, startMacNs: bigint, rand: () => number, model: DelayModel = USB): Exchange[] {
  const out: Exchange[] = [];
  for (let i = 0; i < 32; i++) {
    const t1 = startMacNs + BigInt(i) * 10n * BigInt(MS);
    const received = t1 + ns(model.forward(rand));
    const replied = received + ns(0.05 + -Math.log(1 - rand()) * 0.05);
    const t4 = replied + ns(model.back(rand));
    out.push({ t1, t2: trueDevice(truth, received), t3: trueDevice(truth, replied), t4 });
  }
  return out;
}

const M_START = 1_234_567_890_123_456n; // ~14 dias de Mac ligado
const SECOND = 1_000_000_000n;

describe('S7 item 2: aparelho → Mac por trocas NTP e ajuste Theil-Sen', () => {
  test('θ = ½[(T2−T1)+(T3−T4)] e atraso = (T4−T1)−(T3−T2) de uma troca', () => {
    // Deslocamento verdadeiro 5.000.000 ns; ida 500 ns, processamento 200 ns, volta 300 ns.
    const e: Exchange = { t1: 1_000n, t2: 5_001_500n, t3: 5_001_700n, t4: 2_000n };
    assert.equal(exchangeOffsetNs(e), 5_000_100n); // erro = (ida − volta)/2 = 100 ns
    assert.equal(exchangeDelayNs(e), 800n);
  });

  test('fica o quarto de menor atraso de cada rajada (8 de 32)', () => {
    const rand = rng(7);
    const truth: Truth = { aNs: 42_000_000_000n, b: 0 };
    const burst = simulateBurst(truth, M_START, rand);
    const kept = selectLowestDelay(burst, 3);
    assert.equal(kept.length, 8);
    const delays = burst.map(exchangeDelayNs).sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
    assert.deepEqual(
      kept.map((s) => s.delayNs).sort((x, y) => (x < y ? -1 : x > y ? 1 : 0)),
      delays.slice(0, 8),
    );
    for (const s of kept) {
      assert.equal(s.burst, 3);
      assert.ok(s.delayNs <= delays[7]!);
    }
  });

  for (const bPpm of [62.5, -87.43]) {
    test(`AC-7.1 (sintético): 20 min, 32 trocas a cada 10 s, deriva plantada ${bPpm} ppm → deslocamento e deriva recuperados, resíduo RMS ≤ 1 ms, pré+pós erram ≤ 2 ms no meio`, (t) => {
      const rand = rng(bPpm > 0 ? 11 : 12);
      const truth: Truth = { aNs: 259_200_000_000_000n + 123_456_789n, b: bPpm * 1e-6 };
      const bursts: Exchange[][] = [];
      for (let k = 0; k <= 120; k++) bursts.push(simulateBurst(truth, M_START + BigInt(k) * 10n * SECOND, rand));

      const fit = fitClock(bursts);
      assert.equal(fit.bursts, 121);
      assert.equal(fit.samples, 121 * 8);
      assert.equal(fit.slopeEstimated, true);
      assert.ok(Math.abs(fit.bPpm - bPpm) <= 0.5, `b recuperado ${fit.bPpm} ppm × plantado ${bPpm}`);
      assert.ok(fit.residualMs <= 1, `resíduo RMS ${fit.residualMs} ms`);
      assert.deepEqual(fit.warnings, []);
      let maxThetaErrMs = 0;
      for (const k of [0, 30, 60, 90, 120]) {
        const m = M_START + BigInt(k) * 10n * SECOND;
        const err = Number(offsetAtNs(fit, m)) - trueOffset(truth, m);
        assert.ok(Math.abs(err) <= 0.2 * MS, `θ em ${k * 10} s erra ${err / MS} ms`);
        maxThetaErrMs = Math.max(maxThetaErrMs, Math.abs(err) / MS);
      }

      // Só a rajada pré e a pós: interpolação no meio (10 min).
      const prePost = fitClock([bursts[0]!, bursts[120]!]);
      assert.equal(prePost.bursts, 2);
      const mid = M_START + 600n * SECOND;
      const midErrMs = (Number(offsetAtNs(prePost, mid)) - trueOffset(truth, mid)) / MS;
      assert.ok(Math.abs(midErrMs) <= 2, `pré+pós erram ${midErrMs} ms no meio`);
      assert.ok(Math.abs(prePost.bPpm - bPpm) <= 2, `b pré+pós ${prePost.bPpm} ppm`);

      // D → M → D e M → D → M voltam (±1 ns).
      const d = trueDevice(truth, mid);
      const m = deviceToMacNs(fit, d);
      assert.ok(Math.abs(Number(m - mid)) <= 0.2 * MS, `D→M erra ${Number(m - mid) / MS} ms`);
      const back = macToDeviceNs(fit, m);
      assert.ok(back - d >= -1n && back - d <= 1n, `ida e volta: ${back - d} ns`);
      t.diagnostic(
        `plantado b = ${bPpm} ppm → recuperado ${fit.bPpm.toFixed(4)} ppm; |θ̂ − θ| máx ${maxThetaErrMs.toFixed(4)} ms; ` +
          `resíduo RMS ${fit.residualMs.toFixed(4)} ms; pré+pós: b ${prePost.bPpm.toFixed(3)} ppm, erro no meio ${midErrMs.toFixed(4)} ms`,
      );
    });
  }

  test('qualidade: |b| > 150 ppm → aviso E_SYNC_QUALITY (não exceção)', () => {
    const rand = rng(21);
    const truth: Truth = { aNs: -3_000_000_000n, b: 200e-6 };
    const bursts = [0, 1, 2, 3].map((k) => simulateBurst(truth, M_START + BigInt(k) * 20n * SECOND, rand));
    const fit = fitClock(bursts);
    assert.ok(Math.abs(fit.bPpm - 200) <= 1, `b ${fit.bPpm}`);
    assert.equal(fit.warnings.length, 1);
    assert.equal(fit.warnings[0]!.code, 'E_SYNC_QUALITY');
    assert.match(fit.warnings[0]!.message, /150 ppm/);
  });

  test('qualidade: resíduo > 2 ms (atrasos assimétricos alternados) → aviso E_SYNC_QUALITY', () => {
    const rand = rng(22);
    const truth: Truth = { aNs: 10_000_000_000n, b: 10e-6 };
    const slowForward: DelayModel = { forward: (r) => 8 + r(), back: (r) => 0.3 + r() * 0.1 };
    const slowBack: DelayModel = { forward: (r) => 0.3 + r() * 0.1, back: (r) => 8 + r() };
    const bursts = Array.from({ length: 10 }, (_, k) =>
      simulateBurst(truth, M_START + BigInt(k) * 20n * SECOND, rand, k % 2 === 0 ? slowForward : slowBack),
    );
    const fit = fitClock(bursts);
    assert.ok(fit.residualMs > 2, `resíduo ${fit.residualMs} ms`);
    assert.ok(fit.warnings.some((w) => w.code === 'E_SYNC_QUALITY' && /resíduo/.test(w.message)));
  });

  test('só a rajada pré (E-7.1): b = 0, sem inclinação estimada', () => {
    const rand = rng(23);
    const truth: Truth = { aNs: 77_000_000_000n, b: 30e-6 };
    const fit = fitClock([simulateBurst(truth, M_START, rand)]);
    assert.equal(fit.bursts, 1);
    assert.equal(fit.b, 0);
    assert.equal(fit.slopeEstimated, false);
    const err = Number(offsetAtNs(fit, M_START)) - trueOffset(truth, M_START);
    assert.ok(Math.abs(err) <= 0.2 * MS, `θ erra ${err / MS} ms`);
  });

  test('sem trocas → E_SYNC_QUALITY (não há o que ajustar)', () => {
    assert.throws(() => fitClock([[], []]), (err: unknown) => isContrarregraError(err, 'E_SYNC_QUALITY'));
  });
});

// ── S0.10: código do relógio de calibração ───────────────────────────────────────────────────────

const WIDTH = 1170;
const HEIGHT = 2532;
/** Células de 44 pt × 3 px/pt; a posição da grade na tela é parâmetro (S0.10 não a fixa). */
const GEOMETRY: ClockCodeGeometry = { x: 57, y: 1300, cellPx: 132 };
const GRAY = 128;

function blankImage(): GrayImage {
  return { width: WIDTH, height: HEIGHT, data: new Uint8Array(WIDTH * HEIGHT).fill(GRAY) };
}

function paintCell(image: GrayImage, row: number, col: number, luma: number): void {
  const x0 = GEOMETRY.x + col * GEOMETRY.cellPx;
  const y0 = GEOMETRY.y + row * GEOMETRY.cellPx;
  for (let y = y0; y < y0 + GEOMETRY.cellPx; y++) {
    image.data.fill(luma, y * image.width + x0, y * image.width + x0 + GEOMETRY.cellPx);
  }
}

function paintCode(image: GrayImage, cells: number[][]): void {
  cells.forEach((row, r) => row.forEach((bit, c) => paintCell(image, r, c, bit ? 255 : 0)));
}

/** D aleatório de 64 bits (ns). */
function randomRawNs(rand: () => number): bigint {
  const hi = BigInt(Math.floor(rand() * 2 ** 31));
  const lo = BigInt(Math.floor(rand() * 2 ** 32));
  return (hi << 32n) | lo;
}

function popcount(cells: number[][], col: number): number {
  return cells.reduce((sum, row) => sum + row[col]!, 0);
}

describe('S0.10: código do relógio de calibração', () => {
  test('valor = floor(D/1e6) mod 2^40; MSB na célula de cima à esquerda, por linhas; 6.ª linha = paridade par', () => {
    assert.equal(clockCodeValueMs(1_999_999n), 1);
    assert.equal(clockCodeValueMs(2n ** 40n * 1_000_000n + 5_000_000n), 5);
    assert.equal(CODE_BITS, 40);
    const cells = encodeClockCode(2 ** 39 + 1); // só o MSB e o LSB
    assert.equal(cells.length, CODE_ROWS);
    for (const row of cells) assert.equal(row.length, CODE_COLUMNS);
    assert.equal(cells[0]![0], 1);
    assert.equal(cells[4]![7], 1);
    assert.equal(cells.slice(0, 5).flat().reduce((a, b) => a + b, 0), 2);
    for (let c = 0; c < CODE_COLUMNS; c++) assert.equal(popcount(cells, c) % 2, 0, `coluna ${c} com paridade ímpar`);
    assert.deepEqual(cells[5], [1, 0, 0, 0, 0, 0, 0, 1]);
    assert.throws(() => encodeClockCode(2 ** 40));
    assert.throws(() => encodeClockCode(-1));
    assert.throws(() => encodeClockCode(1.5));
  });

  test('AC-0.8: 1.000 valores aleatórios de D, renderizados a 1170×2532 e decodificados, voltam iguais; 1 bit trocado é detectado pela paridade', (t) => {
    const rand = rng(80);
    const image = blankImage();
    const raws = [0n, 2n ** 40n * 1_000_000n - 1n];
    while (raws.length < 1000) raws.push(randomRawNs(rand));
    let flipsDetected = 0;
    for (const raw of raws) {
      const value = clockCodeValueMs(raw);
      const cells = encodeClockCode(value);
      paintCode(image, cells);
      const decoded = decodeClockCode(image, GEOMETRY);
      assert.deepEqual(decoded, { ok: true, valueMs: value }, `D = ${raw}`);

      const row = Math.floor(rand() * CODE_ROWS);
      const col = Math.floor(rand() * CODE_COLUMNS);
      paintCell(image, row, col, cells[row]![col] ? 0 : 255);
      const flipped = decodeClockCode(image, GEOMETRY);
      assert.equal(flipped.ok, false, `D = ${raw}, célula (${row}, ${col}) trocada passou`);
      assert.ok(!flipped.ok && flipped.reason === 'parity' && flipped.columns.length === 1 && flipped.columns[0] === col);
      flipsDetected++;
      paintCell(image, row, col, cells[row]![col] ? 255 : 0);
    }
    assert.equal(flipsDetected, 1000);
    let allCells = 0;

    // Todas as 48 células, para 5 valores: qualquer bit trocado (dado ou paridade) é detectado.
    for (const raw of raws.slice(0, 5)) {
      const cells = encodeClockCode(clockCodeValueMs(raw));
      paintCode(image, cells);
      for (let r = 0; r < CODE_ROWS; r++) {
        for (let c = 0; c < CODE_COLUMNS; c++) {
          paintCell(image, r, c, cells[r]![c] ? 0 : 255);
          const result = decodeClockCode(image, GEOMETRY);
          assert.ok(!result.ok && result.reason === 'parity', `célula (${r}, ${c})`);
          allCells++;
          paintCell(image, r, c, cells[r]![c] ? 255 : 0);
        }
      }
    }
    t.diagnostic(`1000/1000 valores decodificados iguais; ${flipsDetected}/1000 trocas de 1 bit acusadas; ${allCells}/240 trocas (48 células × 5 valores) acusadas`);
  });

  test('célula cinza (grade fora do lugar ou quadro de transição) → ilegível, não um valor', () => {
    const image = blankImage();
    paintCode(image, encodeClockCode(123_456_789));
    paintCell(image, 2, 3, GRAY);
    const result = decodeClockCode(image, GEOMETRY);
    assert.ok(!result.ok && result.reason === 'unreadable');
    assert.deepEqual(result.cells.map(({ row, col }) => [row, col]), [[2, 3]]);
    // Grade deslocada para o fundo cinza: tudo ilegível.
    const off = decodeClockCode(image, { ...GEOMETRY, y: 100 });
    assert.ok(!off.ok && off.reason === 'unreadable' && off.cells.length === CODE_ROWS * CODE_COLUMNS);
    // Grade fora da imagem: erro de uso.
    assert.throws(() => decodeClockCode(image, { ...GEOMETRY, x: WIDTH - 100 }), /fora da imagem/);
  });

  describe('código desenhado com drawbox num vídeo H.264 1170×2532 (ffmpeg 8.1.1 fixado)', () => {
    let ff: Ffmpeg;
    const video = join(dir, 'clock-code.mp4');
    const rand = rng(81);
    const values = Array.from({ length: 12 }, () => clockCodeValueMs(randomRawNs(rand)));
    const FLIP = { row: 1, col: 6 };
    const frames: number[][][] = values.map((v) => encodeClockCode(v));
    // Quadro 12: o último valor com um bit de dado trocado → a paridade acusa.
    const corrupted = encodeClockCode(values[11]!).map((row) => [...row]);
    corrupted[FLIP.row]![FLIP.col] ^= 1;
    frames.push(corrupted);

    before(async () => {
      ff = await openFfmpeg(loadConfig({ configPath: join(dir, 'sem-config.json') }));
      const { x, y, cellPx } = GEOMETRY;
      const filters = [`drawbox=x=${x}:y=${y}:w=${cellPx * CODE_COLUMNS}:h=${cellPx * CODE_ROWS}:color=black:t=fill`];
      for (let r = 0; r < CODE_ROWS; r++) {
        for (let c = 0; c < CODE_COLUMNS; c++) {
          const on = frames.flatMap((cells, n) => (cells[r]![c] ? [`eq(n,${n})`] : []));
          if (on.length === 0) continue;
          filters.push(
            `drawbox=x=${x + c * cellPx}:y=${y + r * cellPx}:w=${cellPx}:h=${cellPx}:color=white:t=fill:enable='${on.join('+')}'`,
          );
        }
      }
      await runFfmpeg(ff, [
        '-f', 'lavfi', '-i', `color=c=0x808080:s=${WIDTH}x${HEIGHT}:r=60`,
        '-vf', filters.join(','),
        '-frames:v', String(frames.length),
        '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '20', '-pix_fmt', 'yuv420p',
        '-output_ts_offset', '0.25', // start_time ≠ 0: os pts saem em R (desde o início do arquivo)
        '-y', video,
      ]);
    });

    test('cada quadro decodificado volta com o seu pts e o seu valor; o bit trocado é acusado', async (t) => {
      const results: { ptsS: number; decode: ReturnType<typeof decodeClockCode> }[] = [];
      const info = await probeVideo(ff, video);
      assert.ok(Math.abs(info.startTimeS - 0.25) < 1e-6, `premissa: start_time ${info.startTimeS}`);
      for await (const frame of decodeClockVideo(ff, video, GEOMETRY)) results.push(frame);
      assert.equal(results.length, frames.length);
      results.forEach((frame, n) => {
        assert.ok(Math.abs(frame.ptsS - n / 60) < 1e-6, `pts do quadro ${n}: ${frame.ptsS}`);
        if (n < values.length) assert.deepEqual(frame.decode, { ok: true, valueMs: values[n] }, `quadro ${n}`);
      });
      const last = results.at(-1)!.decode;
      assert.ok(!last.ok && last.reason === 'parity');
      assert.deepEqual(last.columns, [FLIP.col]);
      t.diagnostic(`${values.length}/${values.length} quadros H.264 decodificados no valor e pts plantados; quadro com bit trocado → paridade na coluna ${last.columns[0]}`);
    });

    test('janela de tempo: só os quadros pedidos (pts absolutos)', async () => {
      const results: number[] = [];
      for await (const frame of decodeClockVideo(ff, video, GEOMETRY, { startS: 4.5 / 60, durationS: 3 / 60 })) {
        assert.ok(frame.decode.ok);
        results.push(Math.round(frame.ptsS * 60));
      }
      assert.deepEqual(results, [5, 6, 7]);
    });
  });
});
