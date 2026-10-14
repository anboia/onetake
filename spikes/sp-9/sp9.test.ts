// Testes do driver do SP-9 (T-0.27) sem aparelho e sem o OBS real: `node --test spikes/sp-9/sp9.test.ts`.
// - `lib.ts`: lógica pura (arrasto × faixa de gesto, regiões, disco, PNG, imagem, relógio, veredicto, argumentos);
// - `driver.ts`: a série inteira contra um runner falso EM MEMÓRIA com a fila serial do XCTest e os prazos do
//   `XCTestLane.swift` (10 s; `wait.for` = `timeoutMs` + 1 s; em escala), `E_TIMEOUT` com `data.phase` (`queued` não
//   roda; `running` roda e o efeito acontece depois do erro), a Central que fecha sozinha, a rede que segue o avião, a
//   lista permitida recusando o `ui.drag` na faixa de gesto — e uma captura falsa;
// - `obs.ts` e `capture.ts`: o `ObsClient` de produção contra um OBS falso (`mac/test/helpers/ws-server.ts`): só
//   leituras no instantâneo, HC-11 antes de gravar, gravação parada no teto, devolução, gravação apagada logo depois
//   de medida (também quando a troca falha), recortes apagados no fim;
// - `media.ts`: um vídeo de teste do ffmpeg 8.1.1 fixado com "9:41" desenhado pelo `--render-text` do OCR (T-0.14),
//   a orelha direita mudando e o botão ficando laranja; o OCR do Mac de verdade lê o relógio. Tudo num diretório
//   temporário, nunca no repositório.

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { deflateSync } from 'node:zlib';

import { loadConfig } from '../../mac/src/core/config.ts';
import { ContrarregraError, isContrarregraError } from '../../mac/src/core/errors.ts';
import { openFfmpeg, runFfmpeg, type Ffmpeg } from '../../mac/src/media/ffmpeg.ts';
import { ocrImages, renderText } from '../../mac/src/media/ocr.ts';
import { ObsClient } from '../../mac/src/obs/client.ts';
import { OBS_SUBPROTOCOL } from '../../mac/src/obs/ws.ts';
import { rpcError } from '../../mac/src/runner/rpc.ts';
import { startWsServer, type WsTestConnection, type WsTestServer } from '../../mac/test/helpers/ws-server.ts';
import { ObsCapture, cleanupFiles } from './capture.ts';
import { DEFAULT_OPTIONS, StopError, runSpike, type Capture, type CaptureOutcome, type DriverEnv, type MarkName, type MeasureContext, type Rpc, type RunOptions } from './driver.ts';
import {
  BUTTON_FALLBACK_PT,
  GiB,
  RIGHT_EAR_PT,
  STATUS_BAND_PT,
  airplaneReadFromMessage,
  buttonState,
  ccClosedReason,
  ccDragStart,
  clockMatches,
  decodePng,
  diskCheck,
  estimateBytes,
  gestureBands,
  grayMeanAbsDiff,
  insetRect,
  isOwnFile,
  orangeFraction,
  parseArgs,
  pendingFiles,
  ptToPx,
  readClock,
  requiredFreeBytes,
  subImage,
  summarize,
  summaryTable,
  toggleFunctional,
  toggleStrict,
  toggleTable,
  type Json,
  type RgbImage,
  type ToggleRow,
  type VisualResult,
  type Want,
} from './lib.ts';
import { measureVisual } from './media.ts';
import { DiskLowError, discard, readSnapshot, restoreObs, startRecording, type ObsTargets } from './obs.ts';

const TMP = realpathSync(mkdtempSync(join(tmpdir(), 'sp9-test-')));
after(() => rmSync(TMP, { recursive: true, force: true }));

const HAGAH = 'app.kifactory.hagah';
const SPRINGBOARD = 'com.apple.springboard';
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------------------------------------
// PNG de teste (codificador mínimo, de spikes/sp-5/sp5.test.ts)

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function encodePng(img: RgbImage): Buffer {
  const colorType = ({ 1: 0, 2: 4, 3: 2, 4: 6 } as Record<number, number>)[img.channels]!;
  const stride = img.width * img.channels;
  const rows: Buffer[] = [];
  const paeth = (a: number, b: number, c: number): number => {
    const p = a + b - c;
    const pa = Math.abs(p - a);
    const pb = Math.abs(p - b);
    const pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  for (let y = 0; y < img.height; y++) {
    const filter = y % 5;
    const row = Buffer.alloc(stride + 1);
    row[0] = filter;
    for (let x = 0; x < stride; x++) {
      const v = img.data[y * stride + x]!;
      const a = x >= img.channels ? img.data[y * stride + x - img.channels]! : 0;
      const b = y > 0 ? img.data[(y - 1) * stride + x]! : 0;
      const c = x >= img.channels && y > 0 ? img.data[(y - 1) * stride + x - img.channels]! : 0;
      const pred = [0, a, b, (a + b) >> 1, paeth(a, b, c)][filter]!;
      row[x + 1] = (v - pred) & 0xff;
    }
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(img.width, 0);
  ihdr.writeUInt32BE(img.height, 4);
  ihdr[8] = 8;
  ihdr[9] = colorType;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(Buffer.concat(rows))),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function solid(width: number, height: number, rgb: [number, number, number], channels = 3): RgbImage {
  const data = new Uint8Array(width * height * channels);
  for (let i = 0; i < width * height; i++) {
    data.set(channels >= 3 ? rgb : [rgb[0]], i * channels);
    if (channels === 4) data[i * channels + 3] = 255;
  }
  return { width, height, channels, data };
}

// ---------------------------------------------------------------------------------------------------------
// lib

describe('lib: arrasto de S1 item 7 × faixas de gesto (A9), regiões', () => {
  it('o começo do arrasto 0,9·0,01 cai na faixa de cima de 47 pt do iPhone 12 (por isso ui.drag é recusado)', () => {
    assert.deepEqual(gestureBands({ w: 390, h: 844 }), { top: 47, bottom: 34 });
    assert.deepEqual(gestureBands({ w: 320, h: 568 }), { top: 20, bottom: 20 });
    const s = ccDragStart();
    assert.ok(Math.abs(s.x - 351) < 1e-9 && Math.abs(s.y - 8.44) < 1e-9, JSON.stringify(s));
    assert.equal(s.inTopBand, true);
  });

  it('pt → px do quadro 1168×2532 (x = 3·x − 1, dentro do quadro) e o miolo do botão', () => {
    assert.deepEqual(ptToPx(STATUS_BAND_PT), { x: 0, y: 0, w: 1168, h: 162 });
    assert.deepEqual(ptToPx(RIGHT_EAR_PT), { x: 875, y: 18, w: 276, h: 120 });
    assert.deepEqual(ptToPx(BUTTON_FALLBACK_PT), { x: 175, y: 515, w: 120, h: 120 });
    assert.deepEqual(insetRect({ x: 175, y: 515, w: 120, h: 120 }, 0.2), { x: 199, y: 539, w: 72, h: 72 });
    assert.throws(() => ptToPx({ x: 400, y: 0, w: 10, h: 10 }), RangeError);
  });

  it('mensagens do runner: o estado lido e a Central fechada no E_TIMEOUT do wait.for {airplane}', () => {
    assert.equal(airplaneReadFromMessage('E_TIMEOUT: a condição não ficou verdadeira em 90000 ms (3 sondagens; a última: o modo avião está on)'), 'on');
    assert.equal(airplaneReadFromMessage('E_TIMEOUT: … a última: a rede está offline)'), null);
    assert.equal(ccClosedReason('E_TIMEOUT: … a última: airplane só se avalia com a Central de Controle aberta; à frente: o app x)'), true);
  });
});

describe('lib: disco (HC-11), PNG, imagem, relógio', () => {
  it('teto de 300 s a 16 Mbps: estimativa 0,70 GiB → livre exigido 4,10 GiB', () => {
    const est = estimateBytes(16_000, 300);
    assert.equal(est, 750_000_000);
    assert.ok(Math.abs(requiredFreeBytes(est, 4) / GiB - 4.0955) < 0.001);
    assert.equal(requiredFreeBytes(estimateBytes(16_000, 10), 4), 4 * GiB);
    const low = diskCheck(5 * GiB, 3 * 1024, est, 4);
    assert.equal(low.freeBytes, 3 * GiB);
    assert.equal(low.ok, false);
    assert.equal(diskCheck(21 * GiB, null, est, 4).ok, true);
  });

  it('PNG: decodifica o que o codificador de teste gera (os 5 filtros)', () => {
    const img = solid(7, 6, [10, 200, 30]);
    img.data[5] = 99;
    const back = decodePng(encodePng(img));
    assert.deepEqual({ w: back.width, h: back.height, c: back.channels }, { w: 7, h: 6, c: 3 });
    assert.deepEqual([...back.data], [...img.data]);
  });

  it('laranja (systemOrange claro e escuro) liga; cinza e branco não; diferença em cinza e recorte', () => {
    assert.equal(buttonState(orangeFraction(solid(10, 10, [255, 149, 0]))), 'on');
    assert.equal(buttonState(orangeFraction(solid(10, 10, [255, 159, 10]))), 'on');
    assert.equal(buttonState(orangeFraction(solid(10, 10, [60, 60, 62]))), 'off');
    assert.equal(buttonState(orangeFraction(solid(10, 10, [255, 255, 255]))), 'off');
    const half = solid(10, 10, [60, 60, 60]);
    for (let i = 0; i < 15; i++) half.data.set([255, 149, 0], i * 3);
    assert.equal(buttonState(orangeFraction(half)), 'unclear');
    assert.equal(grayMeanAbsDiff(solid(4, 4, [10, 10, 10]), solid(4, 4, [30, 30, 30])), 20);
    const sub = subImage(solid(10, 10, [1, 2, 3]), { x: 8, y: 8, w: 5, h: 5 });
    assert.deepEqual([sub.width, sub.height], [2, 2]);
  });

  it('relógio: 9:41, hora de verdade (12 h e 24 h, ± 2 min) e nada', () => {
    const at = new Date(2026, 9, 14, 15, 7).getTime();
    assert.deepEqual(readClock(['9:41'], at), { texts: ['9:41'], shows941: true, clock: '9:41', clockReal: false });
    assert.equal(readClock(['3:08', '100'], at).clockReal, true);
    assert.equal(readClock(['15:06'], at).clockReal, true);
    assert.equal(clockMatches('15:12', at), false);
    assert.deepEqual(readClock([], at), { texts: [], shows941: false, clock: null, clockReal: null });
    assert.equal(readClock(['19:41'], at).shows941, false);
  });

  it('arquivos do spike: só o que está direto na pasta, é novo e foi criado depois do começo; o livro', () => {
    const base = { dirRealPath: '/m/SP-9/l', name: 'a.mp4', birthtimeMs: 10_000, mtimeMs: 10_000 };
    assert.equal(isOwnFile({ ...base, realPath: '/m/SP-9/l/a.mp4' }, new Set(), 9_000).ok, true);
    assert.equal(isOwnFile({ ...base, realPath: '/m/SP-9/l/x/a.mp4' }, new Set(), 9_000).ok, false);
    assert.equal(isOwnFile({ ...base, realPath: '/m/SP-9/l/a.mp4' }, new Set(['a.mp4']), 9_000).ok, false);
    assert.equal(isOwnFile({ ...base, realPath: '/m/SP-9/l/a.mp4' }, new Set(), 20_000).ok, false);
    const rows: Json[] = [
      { event: 'created', kind: 'recording', name: 'r.mp4', ino: 1 },
      { event: 'deleted', kind: 'recording', name: 'r.mp4' },
      { event: 'created', kind: 'crop', name: 'c.png', ino: 2 },
      { event: 'orphan', kind: 'recording', path: '/x' },
    ];
    assert.deepEqual(pendingFiles(rows), [{ name: 'c.png', ino: 2, kind: 'crop' }]);
  });

  it('argumentos: padrões, escolhas e recusas', () => {
    const a = parseArgs(['run', '--label', 'sp9-a']);
    assert.deepEqual({ cycles: a.cycles, base: a.base, record: a.record, max: a.maxRecordS, drag: a.probeDrag, label: a.probeLabel, keep: a.keepCrops }, { cycles: 10, base: 'hagah', record: 'both', max: 300, drag: true, label: true, keep: false });
    const b = parseArgs(['run', '--label', 'x', '--cycles', '3', '--base', 'home', '--record', 'on', '--no-probe-drag', '--keep-crops']);
    assert.deepEqual({ cycles: b.cycles, base: b.base, record: b.record, drag: b.probeDrag, keep: b.keepCrops }, { cycles: 3, base: 'home', record: 'on', drag: false, keep: true });
    assert.throws(() => parseArgs(['run']), /--label/);
    assert.throws(() => parseArgs(['run', '--label', 'x', '--base', 'settings']), /--base/);
    assert.throws(() => parseArgs(['run', '--label', 'x', '--yolo']), /desconhecida/);
    assert.deepEqual(parseArgs(['report', '--labels', 'a,b']).labels, ['a', 'b']);
  });
});

// ---------------------------------------------------------------------------------------------------------
// Veredicto (regras fixadas antes de medir)

function visualFor(want: Want, opts: { icon?: boolean; clock?: string } = {}): VisualResult {
  const clock = opts.clock ?? '9:41';
  const read = { texts: [clock], shows941: clock === '9:41', clock, clockReal: clock !== '9:41' };
  return {
    statusBar: { before: read, after: read, earNoise: 0.5, earChange: opts.icon === true ? 30 : 0.7, iconChanged: opts.icon === true },
    button: {
      frameSource: 'find',
      rectPx: { x: 0, y: 0, w: 1, h: 1 },
      before: { orange: want === 'on' ? 0 : 0.6, rgb: [0, 0, 0], state: want === 'on' ? 'off' : 'on' },
      after: { orange: want === 'on' ? 0.6 : 0, rgb: [0, 0, 0], state: want },
      diff: 40,
      changed: true,
    },
    crops: [],
  };
}

function goodRow(cycle: number, want: Want, findMs: number, over: Partial<ToggleRow> = {}): ToggleRow {
  return {
    cycle,
    want,
    at: '2026-10-14T00:00:00Z',
    open: { outcome: 'ok', ms: 900, devMs: 800, path: 'private' },
    find: { outcome: 'ok', ms: findMs, count: 1, value: want === 'on' ? '0' : '1', frame: { x: 50, y: 165, w: 57, h: 57 }, hittable: true },
    valueBefore: want === 'on' ? '0' : '1',
    valueBeforeFrom: 'find',
    tap: { outcome: 'ok', ms: 8_000, reopened: false, path: 'private' },
    valueAfter: want === 'on' ? '1' : '0',
    afterReadMs: 9_000,
    ccReopened: 0,
    close: { outcome: 'ok', ms: 1_000 },
    frontAfterClose: HAGAH,
    net: { expect: want === 'on' ? 'offline' : 'online', ok: true, msFromTap: 7_000, msFromTapRequest: 15_000, tries: 1 },
    transportAfter: { transportType: 'wired', tunnelState: 'connected' },
    visual: visualFor(want),
    ms: 40_000,
    ...over,
  };
}

function series(findMs: number, mutate?: (r: ToggleRow) => ToggleRow): ToggleRow[] {
  const rows: ToggleRow[] = [];
  for (let c = 1; c <= 10; c++) for (const w of ['on', 'off'] as const) rows.push((mutate ?? ((r) => r))(goodRow(c, w, findMs)));
  return rows;
}

describe('veredicto do SP-9', () => {
  const opts = { cycles: 10, findLimitMs: 2_000 };

  it('10/10 com o ui.find em ≤ 2 s e a rede certa no cabo → principal; prova = botão laranja; barra limpa', () => {
    const s = summarize('t', series(1_500), { drag: { outcome: 'refused', code: 'E_FORBIDDEN_APP' } }, opts);
    assert.equal(s.strictCycles, 10);
    assert.deepEqual({ strict: s.verdict.strict, functional: s.verdict.functional, network: s.verdict.network }, { strict: true, functional: true, network: true });
    assert.equal(s.verdict.visualProof, 'cc-button-orange');
    assert.equal(s.verdict.statusBar, 'limpa');
    assert.match(s.verdict.decision, /^principal: /);
    assert.match(summaryTable(s), /10\/10 · 10\/10/);
    assert.match(toggleTable(series(1_500).slice(0, 2), 2_000), /\| 1 \| on \|/);
  });

  it('10/10 mas o ui.find passa de 2 s → principal com G1 de tempo (não plano B)', () => {
    const s = summarize('t', series(9_500), {}, opts);
    assert.equal(s.verdict.strict, false);
    assert.equal(s.verdict.functional, true);
    assert.match(s.verdict.decision, /G1 de tempo/);
    assert.equal(s.find.withinLimit, 0);
  });

  it('uma troca sem a confirmação pelo value → plano B', () => {
    const rows = series(1_500, (r) => (r.cycle === 4 && r.want === 'off' ? { ...r, valueAfter: null } : r));
    const s = summarize('t', rows, {}, opts);
    assert.equal(s.functionalCycles, 9);
    assert.match(s.verdict.decision, /plano B/);
  });

  it('a rede online com o avião ligado, ou o túnel fora do cabo → G1 em S0.3 {network}', () => {
    const offline = series(1_500, (r) => (r.want === 'on' && r.cycle === 2 ? { ...r, net: { ...r.net!, ok: false, err: 'E_TIMEOUT' } } : r));
    assert.equal(toggleFunctional(offline[2]!), false);
    const wifi = series(1_500, (r) => (r.cycle === 3 ? { ...r, transportAfter: { transportType: 'localNetwork', tunnelState: 'connected' } } : r));
    const s = summarize('t', wifi, {}, opts);
    assert.equal(s.verdict.network, false);
    assert.equal(s.networkCorrect, 18);
  });

  it('barra de verdade (hora do Mac, sem 9:41) com a orelha mudando ao ligar → "real" e prova pela barra quando o botão não serve', () => {
    const rows = series(1_500, (r) => {
      const v = visualFor(r.want, { icon: r.want === 'on', clock: '3:08' });
      v.button.before = null;
      v.button.after = null;
      v.button.changed = null;
      return { ...r, visual: v };
    });
    const s = summarize('t', rows, {}, opts);
    assert.equal(s.verdict.statusBar, 'real');
    assert.equal(s.verdict.visualProof, 'status-bar-icon');
  });

  it('estrito exige ≤ 2 s em TODAS; uma troca "já estava" não vale', () => {
    const r = goodRow(1, 'on', 2_001);
    assert.equal(toggleStrict(r, 2_000), false);
    assert.equal(toggleFunctional({ ...r, valueBefore: '1', already: true }), false);
  });
});

// ---------------------------------------------------------------------------------------------------------
// Runner falso em memória: a fila serial do XCTest e os prazos de `XCTestLane.swift`, em escala

/** Milissegundos de teste por segundo do runner: 10 s → 200 ms; o `wait.for` ganha `timeoutMs` + 1 s → + 20 ms. */
const MS_PER_RUNNER_S = 20;
const LANE_METHODS = new Set(['device.state', 'device.controlCenter', 'device.home', 'ui.find', 'ui.tap', 'ui.drag', 'app.activate', 'wait.for']);
const BUTTON_FRAME = { x: 50, y: 165, w: 57, h: 57 };

type Reply = { result: unknown } | { error: { code: number; message: string; data?: unknown } };
const forbidden = (message: string): Reply => ({ error: { code: -32003, message: `E_FORBIDDEN_APP: ${message}` } });
const action = { tDevStartNs: '1000000', tDispatchNs: '2000000', tDevEndNs: '3000000', path: 'private' };

class FakeRunner implements Rpc {
  /** O que fica à frente com a Central fechada: o Hagah ou a tela de início. */
  front: 'hagah' | 'home' = 'home';
  cc = false;
  airplane = false;
  /** O avião que a rede "vê" (segue `airplane` depois de `netLagMs`). */
  netAirplane = false;
  /** `follow` = acompanha o avião; `online`/`offline` = presa. */
  net: 'follow' | 'online' | 'offline' = 'follow';
  netLagMs = 15;
  locked = false;
  dead = false;
  /** Fechar a Central (`press(.home)`) volta ao app de baixo (`under`) ou à tela de início (`home`). */
  closeTo: 'under' | 'home' = 'under';
  /** A lista permitida deixaria o `ui.drag` na faixa de gesto passar (lacuna). */
  dragGap = false;
  /** A Central fecha sozinha uma vez: antes do próximo toque ou antes da próxima leitura `wait.for {airplane}`. */
  autoClose: 'before-tap' | 'before-read' | null = null;
  workMs: Record<string, number> = {};
  /** O próximo pedido deste método trabalha tantos ms (força o `E_TIMEOUT` "rodando"). */
  slowNext: Record<string, number> = {};
  depth = 0;
  taps = 0;
  calls: string[] = [];
  #lane: (() => Promise<void>)[] = [];
  #pumping = false;
  #started = Date.now();

  #frontId(): string {
    if (this.cc) return SPRINGBOARD;
    return this.front === 'hagah' ? HAGAH : SPRINGBOARD;
  }

  #network(): 'online' | 'offline' {
    return this.net !== 'follow' ? this.net : this.netAirplane ? 'offline' : 'online';
  }

  #setAirplane(on: boolean): void {
    this.airplane = on;
    setTimeout(() => (this.netAirplane = on), this.netLagMs);
  }

  async #pump(): Promise<void> {
    if (this.#pumping) return;
    this.#pumping = true;
    while (this.#lane.length > 0) await this.#lane.shift()!();
    this.#pumping = false;
  }

  #submit(method: string, deadlineMs: number, work: () => Promise<Reply>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const job = { phase: 'queued' as 'queued' | 'running' | 'done', replied: false };
      this.depth++;
      const timer = setTimeout(() => {
        if (job.replied || job.phase === 'done') return;
        job.replied = true;
        const where = job.phase === 'queued' ? 'ainda na fila do XCTest' : 'rodando na fila do XCTest';
        reject(rpcError(method, { code: -32020, message: `E_TIMEOUT: ${method} passou do prazo (${where})`, data: { method, deadlineMs, phase: job.phase } }));
      }, deadlineMs);
      this.#lane.push(async () => {
        if (job.replied) {
          job.phase = 'done';
          this.depth--;
          return;
        }
        job.phase = 'running';
        const out = await work();
        job.phase = 'done';
        clearTimeout(timer);
        this.depth--;
        if (job.replied) return;
        job.replied = true;
        if ('result' in out) resolve(out.result);
        else reject(rpcError(method, out.error));
      });
      void this.#pump();
    });
  }

  #isAirplane(target: unknown): 'identifier' | 'label' | null {
    const t = target as Record<string, unknown> | undefined;
    if (t?.['app'] !== 'springboard') return null;
    if (t['identifier'] === 'airplane-mode-button') return 'identifier';
    if (t['label'] === 'Airplane Mode') return 'label';
    return null;
  }

  #work(method: string, params: Json): () => Promise<Reply> {
    const ms = this.slowNext[method] ?? this.workMs[method] ?? 2;
    delete this.slowNext[method];
    const after = (fn: () => Reply) => async (): Promise<Reply> => {
      await sleep(ms);
      return fn();
    };
    switch (method) {
      case 'device.controlCenter':
        return after(() => {
          if (params['action'] === 'open') {
            if (this.locked) return forbidden('tela travada');
            this.cc = true;
          } else if (this.cc) {
            this.cc = false;
            if (this.closeTo === 'home') this.front = 'home';
          }
          return { result: action };
        });
      case 'device.home':
        return after(() => {
          this.cc = false;
          this.front = 'home';
          return { result: action };
        });
      case 'ui.drag':
        return after(() => {
          if (this.dragGap) {
            this.cc = true;
            return { result: { point: { x: 351, y: 8.44 }, ...action } };
          }
          return forbidden('gesto começando na faixa do sistema (y 8.44; faixas: 47 pt em cima, 34 pt embaixo) abriria uma camada do SpringBoard ou trocaria de app');
        });
      case 'ui.find':
        return after(() => {
          if (this.#isAirplane(params['target']) === null) return forbidden('só o interruptor do modo avião neste falso');
          return { result: { candidates: this.cc ? [{ frame: BUTTON_FRAME, visible: true, hittable: true, value: this.airplane ? '1' : '0' }] : [] } };
        });
      case 'ui.tap':
        return after(() => {
          if (this.autoClose === 'before-tap') {
            this.autoClose = null;
            this.cc = false;
          }
          if (this.#isAirplane(params['target']) !== 'identifier') return forbidden('no SpringBoard só o interruptor do modo avião');
          if (!this.cc) return { error: { code: -32010, message: 'E_TARGET_NOT_FOUND: o interruptor do modo avião não está na tela' } };
          this.#setAirplane(!this.airplane);
          this.taps++;
          return { result: { point: { x: 78.5, y: 193.5 }, ...action } };
        });
      case 'app.activate':
        return after(() => {
          if (this.cc || this.locked) return forbidden('app.activate só com app operável ou a tela de início à frente');
          if (params['bundleId'] === HAGAH) this.front = 'hagah';
          return { result: action };
        });
      case 'device.state':
        return after(() => ({ result: { locked: this.locked, network: this.#network(), foregroundApp: this.#frontId(), language: 'en', screenPt: { w: 390, h: 844 }, textSize: 'large', appearance: 'dark' } }));
      default: {
        const condition = (params['condition'] ?? {}) as Record<string, string>;
        const timeoutMs = Number(params['timeoutMs'] ?? 0);
        return async (): Promise<Reply> => {
          // Uma varredura lenta do SpringBoard antes da primeira sondagem (o prazo pode vencer "rodando").
          if (ms > 2) await sleep(ms);
          if (condition['airplane'] !== undefined && this.autoClose === 'before-read') {
            this.autoClose = null;
            this.cc = false;
          }
          const deadline = Date.now() + timeoutMs;
          for (let polls = 1; ; polls++) {
            let holds: boolean;
            let reason: string;
            if (condition['airplane'] !== undefined) {
              if (!this.cc) {
                holds = false;
                reason = `airplane só se avalia com a Central de Controle aberta; à frente: ${this.#frontId()}`;
              } else {
                const state = this.airplane ? 'on' : 'off';
                holds = state === condition['airplane'];
                reason = `o modo avião está ${state}`;
              }
            } else {
              holds = this.#network() === condition['network'];
              reason = `a rede está ${this.#network()}`;
            }
            if (holds) return { result: { tDevStartNs: '1', tDevEndNs: '2' } };
            if (Date.now() >= deadline) return { error: { code: -32020, message: `E_TIMEOUT: a condição não ficou verdadeira em ${timeoutMs} ms (${polls} sondagens; a última: ${reason})` } };
            await sleep(3);
          }
        };
      }
    }
  }

  call<T = unknown>(method: string, params: Json = {}, options: { timeoutMs?: number } = {}): Promise<T> {
    this.calls.push(method);
    if (this.dead) return Promise.reject(new ContrarregraError('E_RUNNER_DOWN', `${method}: runner caído`));
    let inner: Promise<unknown>;
    if (method === 'health') {
      inner = Promise.resolve({ ok: true, uptimeS: (Date.now() - this.#started) / 1000, xctestQueueDepth: this.depth, treeVersion: 1, foregroundApp: this.#frontId(), locked: this.locked });
    } else if (LANE_METHODS.has(method)) {
      const deadline = method === 'wait.for' ? Number(params['timeoutMs'] ?? 0) + MS_PER_RUNNER_S : 10 * MS_PER_RUNNER_S;
      inner = this.#submit(method, deadline, this.#work(method, params));
    } else {
      inner = Promise.reject(rpcError(method, { code: -32601, message: `método inexistente: ${method}` }));
    }
    // O prazo do Mac (`rpc.ts`): sem resposta → `E_TIMEOUT` sem `phase`.
    const timeoutMs = options.timeoutMs ?? 12_000;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new ContrarregraError('E_TIMEOUT', `${method}: sem resposta do runner em ${timeoutMs} ms`, { method, timeoutMs })), timeoutMs);
      inner.then(
        (v) => {
          clearTimeout(timer);
          resolve(v as T);
        },
        (e: unknown) => {
          clearTimeout(timer);
          reject(e);
        },
      );
    });
  }
}

const FAST: RunOptions = {
  ...DEFAULT_OPTIONS,
  cycles: 2,
  findLimitMs: 100,
  callTimeoutMs: 1_000,
  airplaneReadMs: 300,
  waitSlackMs: 300,
  netOnMs: 300,
  netOffMs: 300,
  holdMs: 5,
  baselineMs: 5,
  noiseGapMs: 5,
  tailMs: 5,
  minPhaseMs: 5,
  drainMaxMs: 3_000,
  pollMs: 10,
  appWaitMs: 200,
  lateActionMs: 1_000,
};

class FakeCapture implements Capture {
  calls: { tag: string; marks: MarkName[]; failed: boolean; ctx?: MeasureContext }[] = [];

  async around<T>(tag: string, body: (mark: (name: MarkName) => Promise<void>) => Promise<T>, context: () => MeasureContext): Promise<CaptureOutcome<T>> {
    const entry: { tag: string; marks: MarkName[]; failed: boolean; ctx?: MeasureContext } = { tag, marks: [], failed: false };
    this.calls.push(entry);
    try {
      const value = await body(async (name) => {
        entry.marks.push(name);
      });
      entry.ctx = context();
      return { value, visual: visualFor(entry.ctx.want), recording: { name: `${tag}.mp4`, bytes: 1 } };
    } catch (error) {
      entry.failed = true;
      throw error;
    }
  }
}

interface Harness {
  env: DriverEnv;
  rows: Json[];
  owner: { step: string; text: string }[];
  stop: { now: boolean };
  air: string[];
}

function harness(runner: FakeRunner, over: Partial<DriverEnv> = {}, transport: { tt: string } = { tt: 'wired' }): Harness {
  const rows: Json[] = [];
  const owner: { step: string; text: string }[] = [];
  const stop = { now: false };
  const air: string[] = [];
  const env: DriverEnv = {
    rpc: runner,
    app: HAGAH,
    now: () => Date.now(),
    sleep,
    write: (k, data) => void rows.push({ k, ...data }),
    say: () => {},
    owner: (step, text) => void owner.push({ step, text }),
    stopRequested: () => stop.now,
    setAir: (a) => void air.push(a),
    transport: async () => ({ transportType: transport.tt, tunnelState: 'connected' }),
    hotspot: async () => false,
    sessionAlive: () => !runner.dead,
    ...over,
  };
  return { env, rows, owner, stop, air };
}

describe('driver: a série contra o runner falso (fila do XCTest e prazos)', () => {
  it('10 ciclos ok: Central por device.controlCenter, ui.find ≤ limite, value 0→1→0, rede certa no cabo; sondas; avião desligado no fim', async () => {
    const runner = new FakeRunner();
    const capture = new FakeCapture();
    const h = harness(runner, { capture });
    const r = await runSpike(h.env, { ...FAST, cycles: 10 });
    assert.equal(r.stopped, undefined, JSON.stringify(r.rows.find((x) => x.err !== undefined)));
    assert.equal(r.rows.length, 20);
    assert.equal(runner.taps, 20);
    assert.equal(runner.airplane, false);
    assert.equal(r.air, 'off');
    assert.ok(r.rows.every((x) => toggleStrict(x, FAST.findLimitMs)), JSON.stringify(r.rows[0]));
    assert.equal(r.probes.drag?.outcome, 'refused');
    assert.equal(r.probes.label?.outcome, 'ok');
    assert.equal(r.probes.label?.count, 1);
    assert.ok(!runner.calls.includes('ui.drag') || runner.calls.filter((c) => c === 'ui.drag').length === 1, 'só a sonda usa ui.drag');
    assert.equal(r.rows[0]!.frontBefore, HAGAH, 'o Hagah por baixo da Central (base padrão)');
    assert.equal(r.rows[0]!.frontAfterClose, HAGAH);
    assert.equal(r.rows[0]!.deviceState !== undefined && 'network' in r.rows[0]!.deviceState ? r.rows[0]!.deviceState.network : null, 'offline');
    assert.equal(capture.calls.length, 20);
    assert.deepEqual(capture.calls[0]!.marks, ['closed-before', 'closed-before-2', 'cc-before', 'cc-after', 'cc-after-end', 'closed-after']);
    assert.equal(capture.calls[0]!.ctx?.buttonSource, 'find');
    assert.deepEqual(capture.calls[0]!.ctx?.button, BUTTON_FRAME);
    const s = summarize('t', r.rows, r.probes, { cycles: 10, findLimitMs: FAST.findLimitMs });
    assert.match(s.verdict.decision, /^principal: /);
    assert.equal(s.verdict.visualProof, 'cc-button-orange');
  });

  it('ui.find estoura os 10 s rodando: "late" com o tempo até a fila esvaziar; value por wait.for; vale, mas não no estrito', async () => {
    const runner = new FakeRunner();
    const h = harness(runner);
    const ref = { n: 0 };
    const origCall = runner.call.bind(runner);
    runner.call = <T>(method: string, params?: Json, options?: { timeoutMs?: number }): Promise<T> => {
      if (method === 'ui.find' && (params?.['target'] as Json | undefined)?.['identifier'] === 'airplane-mode-button' && ref.n++ === 0) runner.slowNext['ui.find'] = 350;
      return origCall<T>(method, params, options);
    };
    const r = await runSpike(h.env, { ...FAST, cycles: 1, probeLabel: false, probeDrag: false });
    assert.equal(r.stopped, undefined, JSON.stringify(r.rows));
    const on = r.rows[0]!;
    assert.equal(on.find?.outcome, 'late');
    assert.ok((on.find?.lateMs ?? 0) >= 300, JSON.stringify(on.find));
    assert.equal(on.valueBeforeFrom, 'wait');
    assert.equal(on.valueBefore, '0');
    assert.equal(toggleFunctional(on), true);
    assert.equal(toggleStrict(on, FAST.findLimitMs), false);
    assert.equal(runner.taps, 2);
  });

  it('o toque estoura rodando (efeito depois do erro): nunca toca de novo; a leitura na fila serial confirma o value', async () => {
    const runner = new FakeRunner();
    const h = harness(runner);
    runner.slowNext['ui.tap'] = 450;
    const r = await runSpike(h.env, { ...FAST, cycles: 1, probeLabel: false, probeDrag: false });
    assert.equal(r.stopped, undefined, JSON.stringify(r.rows));
    assert.equal(r.rows[0]!.tap?.outcome, 'ran-late');
    assert.ok((r.rows[0]!.net?.msFromTapRequest ?? 0) >= 450, 'a rede conta do pedido; o toque real veio depois do erro');
    assert.equal(r.rows[0]!.valueAfter, '1');
    assert.equal(runner.taps, 2, 'um toque por troca');
    assert.equal(runner.airplane, false);
  });

  it('a leitura do value depois do toque estoura o prazo rodando (varredura lenta): espera a fila e lê de novo', async () => {
    const runner = new FakeRunner();
    const h = harness(runner);
    const origCall = runner.call.bind(runner);
    let slowed = false;
    runner.call = <T>(method: string, params?: Json, options?: { timeoutMs?: number }): Promise<T> => {
      const c = params?.['condition'] as Json | undefined;
      if (method === 'wait.for' && c?.['airplane'] === 'on' && !slowed) {
        slowed = true;
        runner.slowNext['wait.for'] = 400;
      }
      return origCall<T>(method, params, options);
    };
    const r = await runSpike(h.env, { ...FAST, cycles: 1, probeLabel: false, probeDrag: false });
    assert.equal(r.stopped, undefined, JSON.stringify(r.rows));
    assert.equal(slowed, true);
    assert.equal(r.rows[0]!.valueAfter, '1');
    assert.ok((r.rows[0]!.afterReadMs ?? 0) >= 320, String(r.rows[0]!.afterReadMs));
    assert.equal(runner.taps, 2);
  });

  it('a Central fecha sozinha antes do toque: E_TARGET_NOT_FOUND → reabre e toca uma vez', async () => {
    const runner = new FakeRunner();
    const h = harness(runner);
    runner.autoClose = 'before-tap';
    const r = await runSpike(h.env, { ...FAST, cycles: 1, probeLabel: false, probeDrag: false });
    assert.equal(r.stopped, undefined, JSON.stringify(r.rows));
    assert.equal(r.rows[0]!.tap?.reopened, true);
    assert.equal(r.rows[0]!.ccReopened, 1);
    assert.equal(r.rows[0]!.valueAfter, '1');
    assert.equal(runner.taps, 2);
  });

  it('a Central fecha sozinha antes da leitura do depois: o motivo do E_TIMEOUT → reabre e lê', async () => {
    const runner = new FakeRunner();
    const h = harness(runner);
    const origCall = runner.call.bind(runner);
    runner.call = <T>(method: string, params?: Json, options?: { timeoutMs?: number }): Promise<T> => {
      if (method === 'ui.tap' && runner.taps === 0) runner.autoClose = 'before-read';
      return origCall<T>(method, params, options);
    };
    const r = await runSpike(h.env, { ...FAST, cycles: 1, probeLabel: false, probeDrag: false });
    assert.equal(r.stopped, undefined, JSON.stringify(r.rows));
    assert.equal(r.rows[0]!.ccReopened, 1);
    assert.equal(r.rows[0]!.valueAfter, '1');
    assert.equal(runner.taps, 2);
  });

  it('a rede não acompanha o avião: a troca vale pelo value, a série segue, e a rede fica errada no resumo', async () => {
    const runner = new FakeRunner();
    runner.net = 'online';
    const h = harness(runner);
    const r = await runSpike(h.env, { ...FAST, cycles: 2, probeLabel: false, probeDrag: false });
    assert.equal(r.stopped, undefined);
    assert.equal(r.rows.length, 4);
    assert.equal(r.rows[0]!.net?.ok, false);
    assert.equal(r.rows[1]!.net?.ok, true);
    const s = summarize('t', r.rows, r.probes, { cycles: 2, findLimitMs: FAST.findLimitMs });
    assert.equal(s.verdict.network, false);
    assert.equal(runner.airplane, false);
  });

  it('o avião ligado por uma execução anterior: a normalização desliga pelo value antes do ciclo 1', async () => {
    const runner = new FakeRunner();
    runner.airplane = true;
    runner.netAirplane = true;
    const h = harness(runner);
    const r = await runSpike(h.env, { ...FAST, cycles: 1, probeLabel: false, probeDrag: false });
    assert.equal(r.probes.normalize?.['ok'], true);
    assert.equal(runner.taps, 3);
    assert.equal(r.rows[0]!.valueBefore, '0');
    assert.equal(runner.airplane, false);
  });

  it('fora do cabo: para antes de ligar o avião (nenhum toque), stopKind transport', async () => {
    const runner = new FakeRunner();
    const h = harness(runner, {}, { tt: 'localNetwork' });
    const r = await runSpike(h.env, { ...FAST, probeLabel: false, probeDrag: false });
    assert.equal(r.stopKind, 'transport');
    assert.equal(runner.taps, 0);
    assert.equal(runner.airplane, false);
    assert.equal(r.air, 'off');
  });

  it('Acesso Pessoal ligado: OWNER_ACTION hotspot e StopError, sem tocar no avião', async () => {
    const runner = new FakeRunner();
    const h = harness(runner, { hotspot: async () => true });
    await assert.rejects(runSpike(h.env, { ...FAST, probeLabel: false, probeDrag: false }), (e: unknown) => e instanceof StopError && e.kind === 'owner' && e.step === 'hotspot');
    assert.deepEqual(h.owner.map((o) => o.step), ['hotspot']);
    assert.equal(runner.taps, 0);
  });

  it('SIGINT com o avião ligado: termina o passo, para e o runner desliga o avião', async () => {
    const runner = new FakeRunner();
    const h = harness(runner);
    h.env.setAir = (a) => {
      if (a === 'on') h.stop.now = true;
    };
    const r = await runSpike(h.env, { ...FAST, cycles: 3, probeLabel: false, probeDrag: false });
    assert.equal(r.stopKind, 'stop');
    assert.equal(r.air, 'off');
    assert.equal(runner.airplane, false);
    assert.ok(r.rows.length <= 2);
  });

  it('o iPhone trava com o avião ligado: OWNER_ACTION unlock e, sem conseguir desligar, também air-off', async () => {
    const runner = new FakeRunner();
    const h = harness(runner);
    h.env.setAir = (a) => {
      if (a === 'on') runner.locked = true;
    };
    await assert.rejects(runSpike(h.env, { ...FAST, probeLabel: false, probeDrag: false }), (e: unknown) => e instanceof StopError && e.step === 'unlock');
    assert.deepEqual(h.owner.map((o) => o.step), ['unlock', 'air-off']);
    assert.equal(runner.airplane, true);
  });

  it('runner caído com o avião ligado: OWNER_ACTION air-off', async () => {
    const runner = new FakeRunner();
    const h = harness(runner);
    h.env.setAir = (a) => {
      if (a === 'on') runner.dead = true;
    };
    await assert.rejects(runSpike(h.env, { ...FAST, probeLabel: false, probeDrag: false }), (e: unknown) => e instanceof StopError && e.step === 'air-off');
    assert.equal(h.owner.at(-1)?.step, 'air-off');
  });

  it('uma troca que falha dentro da gravação: a captura vê a falha, a série para e o avião é desligado', async () => {
    const runner = new FakeRunner();
    const capture = new FakeCapture();
    const h = harness(runner, { capture });
    const origCall = runner.call.bind(runner);
    let induced = false;
    runner.call = <T>(method: string, params?: Json, options?: { timeoutMs?: number }): Promise<T> => {
      if (method === 'ui.tap' && runner.taps === 1 && !induced) {
        induced = true;
        return Promise.reject(rpcError(method, { code: -32060, message: 'E_XCTEST: falha induzida' }));
      }
      return origCall<T>(method, params, options);
    };
    const r = await runSpike(h.env, { ...FAST, cycles: 2, probeLabel: false, probeDrag: false });
    assert.match(r.stopped ?? '', /ciclo 1 \(off\)/);
    assert.equal(r.stopKind, 'error');
    assert.equal(capture.calls[1]!.failed, true);
    assert.equal(r.air, 'off');
    assert.equal(runner.airplane, false);
  });

  it('lacuna da lista permitida: se o ui.drag na faixa passar, a sonda registra "executed" e fecha a Central', async () => {
    const runner = new FakeRunner();
    runner.dragGap = true;
    const h = harness(runner);
    const r = await runSpike(h.env, { ...FAST, cycles: 1, probeLabel: false });
    assert.equal(r.probes.drag?.outcome, 'executed');
    assert.equal(r.stopped, undefined);
    assert.equal(runner.cc, false);
  });

  it('base na tela de início: device.home, e fechar a Central que volta à tela de início não atrapalha', async () => {
    const runner = new FakeRunner();
    runner.closeTo = 'home';
    const h = harness(runner);
    const r = await runSpike(h.env, { ...FAST, cycles: 1, base: 'home', probeLabel: false, probeDrag: false });
    assert.equal(r.stopped, undefined, JSON.stringify(r.rows));
    assert.ok(runner.calls.includes('device.home'));
    assert.ok(!runner.calls.includes('app.activate'));
    assert.equal(r.rows[0]!.frontBefore, SPRINGBOARD);
  });

  it('Hagah por baixo e o fechar que vai para a tela de início: a troca seguinte reativa o Hagah', async () => {
    const runner = new FakeRunner();
    runner.closeTo = 'home';
    const h = harness(runner);
    const r = await runSpike(h.env, { ...FAST, cycles: 1, probeLabel: false, probeDrag: false });
    assert.equal(r.stopped, undefined, JSON.stringify(r.rows));
    assert.equal(r.rows[0]!.frontAfterClose, SPRINGBOARD);
    assert.equal(r.rows[1]!.frontBefore, HAGAH);
    assert.ok(runner.calls.filter((c) => c === 'app.activate').length >= 2);
  });
});

// ---------------------------------------------------------------------------------------------------------
// OBS falso (de spikes/sp-5/sp5.test.ts, enxugado): o `ObsClient` de produção fala com ele

interface FakeObsState {
  profile: string;
  collection: string;
  device: string;
  settings: Json;
  alive: boolean;
  recordDirectory: string;
  recording: boolean;
  outputDuration: number;
  availableMiB: number;
  /** O que o StartRecord "grava": um arquivo copiado (vídeo de teste) ou bytes soltos. */
  source: string | null;
  seq: number;
  lastPath: string;
}

class FakeObs {
  readonly state: FakeObsState;
  readonly requests: { type: string; data: Json | undefined }[] = [];
  server!: WsTestServer;
  #conns = new Set<WsTestConnection>();

  constructor(over: Partial<FakeObsState> = {}) {
    this.state = {
      profile: 'Contrarregra',
      collection: 'Contrarregra',
      device: 'EE35C40D-6B59-489B-8BA2-BF347E8D712C',
      settings: { buffering: false, device: 'EE35C40D-6B59-489B-8BA2-BF347E8D712C', device_name: 'VIVO_00G7', preset: 'AVCaptureSessionPresetHigh', use_preset: true },
      alive: false,
      recordDirectory: join(TMP, 'owner-movies'),
      recording: false,
      outputDuration: 0,
      availableMiB: 50 * 1024,
      source: null,
      seq: 0,
      lastPath: '',
      ...over,
    };
  }

  async start(): Promise<void> {
    this.server = await startWsServer({
      protocols: [OBS_SUBPROTOCOL],
      onConnection: (c) => {
        this.#conns.add(c);
        void c.closed.then(() => this.#conns.delete(c));
        c.onMessage((text) => this.#onMessage(c, text));
        c.sendJson({ op: 0, d: { obsStudioVersion: '31.1.2', obsWebSocketVersion: '5.6.2', rpcVersion: 1 } });
      },
    });
  }

  writes(): string[] {
    return this.requests.map((r) => r.type).filter((t) => !t.startsWith('Get'));
  }

  emit(eventType: string, eventData: Json): void {
    for (const c of this.#conns) c.sendJson({ op: 5, d: { eventType, eventIntent: 64, eventData } });
  }

  #onMessage(c: WsTestConnection, text: string): void {
    const { op, d } = JSON.parse(text) as { op: number; d: Json };
    if (op === 1) {
      c.sendJson({ op: 2, d: { negotiatedRpcVersion: 1 } });
      return;
    }
    if (op !== 6) return;
    const type = d['requestType'] as string;
    const data = d['requestData'] as Json | undefined;
    this.requests.push({ type, data });
    let reply: { code?: number; data?: Json; after?: () => void };
    try {
      reply = this.#handle(type, data ?? {});
    } catch (error) {
      reply = { code: 600, data: { comment: (error as Error).message } };
    }
    const code = reply.code ?? 100;
    c.sendJson({ op: 7, d: { requestType: type, requestId: d['requestId'], requestStatus: { result: code === 100, code }, ...(reply.data === undefined ? {} : { responseData: reply.data }) } });
    reply.after?.();
  }

  #handle(type: string, data: Json): { code?: number; data?: Json; after?: () => void } {
    const s = this.state;
    const shot = `data:image/png;base64,${encodePng(solid(64, 139, s.alive ? [128, 128, 128] : [0, 0, 0])).toString('base64')}`;
    switch (type) {
      case 'GetVersion': return { data: { obsVersion: '31.1.2', obsWebSocketVersion: '5.6.2', rpcVersion: 1, availableRequests: ['CreateRecordChapter'], supportedImageFormats: ['png'], platform: 'macos', platformDescription: '' } };
      case 'GetProfileList': return { data: { currentProfileName: s.profile, profiles: ['Untitled', 'Contrarregra'] } };
      case 'GetSceneCollectionList': return { data: { currentSceneCollectionName: s.collection, sceneCollections: ['Untitled', 'Contrarregra'] } };
      case 'GetSceneItemId': return { data: { sceneItemId: 1 } };
      case 'GetInputSettings': return { data: { inputKind: 'macos-avcapture', inputSettings: structuredClone(s.settings) } };
      case 'SetInputSettings': {
        const incoming = data['inputSettings'] as Json;
        s.settings = data['overlay'] === false ? structuredClone(incoming) : { ...s.settings, ...incoming };
        if (incoming['device'] === s.device) s.alive = true;
        return {};
      }
      case 'GetSceneItemTransform': return { data: { sceneItemTransform: { sourceWidth: s.alive ? 1170 : 0, sourceHeight: s.alive ? 2532 : 0 } } };
      case 'GetSourceScreenshot': return { data: { imageData: shot } };
      case 'GetInputPropertiesListPropertyItems': return { data: { propertyItems: [{ itemName: 'FaceTime HD Camera', itemEnabled: true, itemValue: 'cam' }, { itemName: 'VIVO_00G7', itemEnabled: true, itemValue: s.device }] } };
      case 'GetRecordDirectory': return { data: { recordDirectory: s.recordDirectory } };
      case 'SetRecordDirectory': s.recordDirectory = String(data['recordDirectory']); return {};
      case 'GetRecordStatus': return { data: { outputActive: s.recording, outputPaused: false, outputTimecode: '00:00:00', outputDuration: s.outputDuration, outputBytes: 10 } };
      case 'GetStats': return { data: { availableDiskSpace: s.availableMiB, renderSkippedFrames: 0, renderTotalFrames: 100, outputSkippedFrames: 0, outputTotalFrames: 100, activeFps: 60 } };
      case 'GetOutputStatus': return { data: { outputActive: s.recording, outputSkippedFrames: 0, outputTotalFrames: 50 } };
      case 'StartRecord': {
        s.recording = true;
        s.seq++;
        const path = join(s.recordDirectory, `2026-10-14 10-00-${String(s.seq).padStart(2, '0')}.mp4`);
        s.lastPath = path;
        return {
          after: () => {
            // Um arquivo NOVO (copyFileSync no APFS clona e herda as datas do original).
            if (s.source !== null) writeFileSync(path, readFileSync(s.source));
            else writeFileSync(path, Buffer.alloc(1000, 1));
            this.emit('RecordStateChanged', { outputActive: true, outputState: 'OBS_WEBSOCKET_OUTPUT_STARTED', outputPath: null });
          },
        };
      }
      case 'StopRecord': {
        s.recording = false;
        const path = s.lastPath;
        return { data: { outputPath: path }, after: () => this.emit('RecordStateChanged', { outputActive: false, outputState: 'OBS_WEBSOCKET_OUTPUT_STOPPED', outputPath: path }) };
      }
      default: return { code: 204 };
    }
  }

  async connect(): Promise<ObsClient> {
    return ObsClient.connect({ url: this.server.url, profile: 'Contrarregra', collection: 'Contrarregra', expected: { obs: '31.1.2', obsWebsocket: '5.6.2' } });
  }

  close(): Promise<void> {
    return this.server.close();
  }
}

const T: ObsTargets = { scene: 'Contrarregra', source: 'iPhone', deviceName: 'VIVO_00G7' };

// ---------------------------------------------------------------------------------------------------------
// ffmpeg fixado: o vídeo de teste (barra com "9:41", orelha que muda em 2 s, botão laranja a partir de 1,5 s)

const BUTTON_BOX_PX = { x: 170, y: 510, w: 130, h: 130 };

async function statusVideo(ff: Ffmpeg, out: string): Promise<void> {
  const text = await renderText('9:41', join(TMP, 'clock-941.png'), { fontSize: 40 });
  assert.ok(text.height <= 150, `a imagem do relógio cabe na barra: ${text.width}×${text.height}`);
  await runFfmpeg(ff, [
    '-f', 'lavfi', '-i', 'color=c=0x303030:s=1168x2532:r=60:d=3',
    '-i', text.path,
    '-filter_complex', [
      '[0][1]overlay=x=60:y=0',
      "drawbox=x=900:y=40:w=150:h=80:color=white:t=fill:enable='gte(t,2)'",
      `drawbox=x=${BUTTON_BOX_PX.x}:y=${BUTTON_BOX_PX.y}:w=${BUTTON_BOX_PX.w}:h=${BUTTON_BOX_PX.h}:color=0xFF9500:t=fill:enable='gte(t,1.5)'`,
      'format=yuv420p',
    ].join(','),
    '-c:v', 'libx264', '-preset', 'ultrafast', '-qp', '0', '-t', '3',
    '-y', out,
  ]);
}

describe('obs + capture + media (ObsClient real, OBS falso, ffmpeg 8.1.1 e OCR do Mac de verdade)', () => {
  let ff: Ffmpeg;
  let fake: FakeObs;
  let obs: ObsClient;
  let video: string;
  const config = loadConfig({ configPath: join(TMP, 'sem-config.json') });

  before(async () => {
    ff = await openFfmpeg(config);
    video = join(TMP, 'status.mp4');
    await statusVideo(ff, video);
  });

  const fresh = async (over: Partial<FakeObsState> = {}): Promise<string> => {
    if (obs !== undefined) await obs.close();
    if (fake !== undefined) await fake.close();
    fake = new FakeObs(over);
    mkdirSync(fake.state.recordDirectory, { recursive: true });
    await fake.start();
    obs = await fake.connect();
    const dir = realpathSync(mkdtempSync(join(TMP, 'SP-9-')));
    await obs.request('SetRecordDirectory', { recordDirectory: dir });
    return dir;
  };

  after(async () => {
    await obs?.close();
    await fake?.close();
  });

  const deps = (log: Json[] = []) => ({ freeBytes: async () => 100 * GiB, probeOk: async () => true, now: () => Date.now(), sleep, log: (k: string, d?: Json) => void log.push({ k, ...d }) });

  it('instantâneo: só pedidos Get* (nenhuma escrita, nenhuma captura) e o device pelo itemName', async () => {
    await fresh();
    const before = fake.requests.length;
    const snap = await readSnapshot(obs, T);
    const types = fake.requests.slice(before).map((r) => r.type);
    assert.ok(types.every((t) => t.startsWith('Get')), types.join(','));
    assert.ok(!types.includes('GetSourceScreenshot'));
    assert.equal(snap.device.value, fake.state.device);
    assert.deepEqual([snap.source.width, snap.source.height], [0, 0], 'a fonte morta depois de reabrir o OBS (S9 item 3)');
  });

  it('HC-11 abaixo do limite: DiskLowError e nenhum StartRecord', async () => {
    const dir = await fresh({ availableMiB: 1024 });
    await assert.rejects(startRecording(obs, { dir, maxS: 300, bitrateKbps: 16_000, minFreeGiB: 4, criticalGiB: 2 }, deps()), DiskLowError);
    assert.equal(fake.requests.some((r) => r.type === 'StartRecord'), false);
  });

  it('gravação: marcas pelo outputDuration, para no teto sozinha, arquivo nosso; apagar só leva ele', async () => {
    const dir = await fresh({ source: video });
    const log: Json[] = [];
    const active = await startRecording(obs, { dir, maxS: 0.2, bitrateKbps: 16_000, minFreeGiB: 4, criticalGiB: 2, pollMs: 30 }, { ...deps(log), probeOk: async () => true });
    fake.state.outputDuration = 1234;
    assert.deepEqual((await active.mark())?.ms, 1234);
    await sleep(400);
    assert.equal(await active.mark(), null, 'parou no teto');
    const rec = await active.stop();
    assert.equal(rec.autoStopped, 'cap');
    assert.equal(fake.requests.filter((r) => r.type === 'StopRecord').length, 1);
    assert.throws(() => discard({ ...rec, ino: rec.ino + 1 }, dir), /nada foi apagado/);
    assert.equal(discard(rec, dir).name, rec.name);
    assert.equal(existsSync(rec.file), false);
  });

  it('fora do perfil "Contrarregra" a guarda recusa o StartRecord', async () => {
    const dir = await fresh();
    fake.state.profile = 'Untitled';
    await assert.rejects(startRecording(obs, { dir, maxS: 10, bitrateKbps: 16_000, minFreeGiB: 4, criticalGiB: 2 }, deps()), (e: unknown) => isContrarregraError(e, 'E_OBS_CONFIG'));
    assert.equal(fake.requests.some((r) => r.type === 'StartRecord'), false);
  });

  it('devolução: a pasta de gravação e os ajustes da fonte como no instantâneo', async () => {
    await fresh();
    fake.state.recordDirectory = join(TMP, 'owner-movies');
    const snap = await readSnapshot(obs, T);
    await obs.request('SetRecordDirectory', { recordDirectory: join(TMP, 'outra') });
    await obs.request('SetInputSettings', { inputName: 'iPhone', inputSettings: { preset: 'X' }, overlay: true });
    const report = await restoreObs(obs, T, snap, () => {});
    assert.deepEqual(report.errors, []);
    assert.equal(report.settingsEqual, true);
    assert.equal(fake.state.recordDirectory, snap.recordDirectory);
  });

  it('medidas no vídeo de teste: OCR lê 9:41, a orelha muda, o botão vai de desligado a ligado (laranja)', async () => {
    const dir = realpathSync(mkdtempSync(join(TMP, 'crops-')));
    const created: string[] = [];
    const marks = {
      'closed-before': { rS: 0.5, atMs: Date.now() },
      'closed-before-2': { rS: 0.8, atMs: Date.now() },
      'cc-before': { rS: 1.0, atMs: Date.now() },
      'cc-after': { rS: 2.2, atMs: Date.now() },
      'cc-after-end': { rS: 2.4, atMs: Date.now() },
      'closed-after': { rS: 2.6, atMs: Date.now() },
    };
    const v = await measureVisual({ ff, dir, ocr: (p) => ocrImages(p), created: (f) => void created.push(f.name) }, video, marks, { tag: 'c01-on', want: 'on', button: BUTTON_FALLBACK_PT, buttonSource: 'fallback' });
    assert.equal(v.statusBar.before?.shows941, true, JSON.stringify(v.statusBar));
    assert.equal(v.statusBar.after?.shows941, true);
    assert.equal(v.statusBar.iconChanged, true, JSON.stringify(v.statusBar));
    assert.ok((v.statusBar.earNoise ?? 99) < 1);
    assert.equal(v.button.before?.state, 'off', JSON.stringify(v.button));
    assert.equal(v.button.after?.state, 'on', JSON.stringify(v.button));
    assert.equal(v.button.changed, true);
    assert.deepEqual(created.sort(), ['c01-on-band-after.png', 'c01-on-band-before.png', 'c01-on-band-before2.png', 'c01-on-button-after.png', 'c01-on-button-before.png']);
    const band = decodePng(readFileSync(join(dir, 'c01-on-band-before.png')));
    assert.deepEqual([band.width, band.height], [1168, 162]);
  });

  it('captura de ponta a ponta: grava, marca, mede, APAGA a gravação; os recortes saem no cleanup e a pasta vazia some', async () => {
    const dir = await fresh({ source: video });
    const ledger: Json[] = [];
    const cap = new ObsCapture({
      obs, ff, dir, maxS: 60, bitrateKbps: 16_000, minFreeGiB: 4, criticalGiB: 2,
      freeBytes: async () => 100 * GiB, ocr: (p) => ocrImages(p), now: () => Date.now(), sleep, log: () => {}, ledger: (row) => void ledger.push(row), pollMs: 30,
    });
    const at: Record<string, number> = { 'closed-before': 500, 'closed-before-2': 800, 'cc-before': 1000, 'cc-after': 2200, 'cc-after-end': 2400, 'closed-after': 2600 };
    const out = await cap.around('c01-on', async (mark) => {
      for (const name of Object.keys(at) as MarkName[]) {
        fake.state.outputDuration = at[name]!;
        await mark(name);
      }
      return 'feito';
    }, () => ({ tag: 'c01-on', want: 'on', button: BUTTON_FALLBACK_PT, buttonSource: 'fallback' }));
    assert.equal(out.value, 'feito');
    assert.equal(out.visual?.button.after?.state, 'on', JSON.stringify(out.visual));
    assert.equal(out.visual?.statusBar.before?.shows941, true);
    const recName = out.recording?.name ?? '';
    assert.equal(existsSync(join(dir, recName)), false, 'a gravação foi apagada logo depois de medida');
    assert.deepEqual(ledger.filter((r) => r['kind'] === 'recording').map((r) => r['event']), ['created', 'deleted']);
    assert.equal(readdirSync(dir).filter((n) => n.endsWith('.png')).length, 5);
    const cleaned = cleanupFiles(ledger, dir, (row) => void ledger.push(row));
    assert.equal(cleaned.deleted.length, 5);
    assert.deepEqual(cleaned.refused, []);
    assert.equal(cleaned.dirRemoved, true);
    assert.equal(existsSync(dir), false);
  });

  it('a troca falha dentro da gravação: a gravação é apagada mesmo assim, sem medir, e o erro sobe', async () => {
    const dir = await fresh({ source: video });
    const ledger: Json[] = [];
    let ocrCalls = 0;
    const cap = new ObsCapture({
      obs, ff, dir, maxS: 60, bitrateKbps: 16_000, minFreeGiB: 4, criticalGiB: 2,
      freeBytes: async () => 100 * GiB, ocr: async (p) => { ocrCalls++; return ocrImages(p); }, now: () => Date.now(), sleep, log: () => {}, ledger: (row) => void ledger.push(row), pollMs: 30,
    });
    await assert.rejects(cap.around('c01-off', async () => {
      throw new Error('toque falhou');
    }, () => ({ tag: 'c01-off', want: 'off', button: BUTTON_FALLBACK_PT, buttonSource: 'fallback' })), /toque falhou/);
    assert.equal(ocrCalls, 0);
    assert.deepEqual(ledger.map((r) => `${String(r['kind'])}:${String(r['event'])}`), ['recording:created', 'recording:deleted']);
    assert.deepEqual(readdirSync(dir), []);
  });
});
