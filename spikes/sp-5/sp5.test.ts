// Testes do driver do SP-5 (T-0.20) sem aparelho e sem o OBS real: a lógica pura de `lib.ts`; as operações de
// `obs.ts` com o `ObsClient` de produção contra um OBS falso escrito sobre `mac/test/helpers/ws-server.ts` (guarda do
// perfil, gravação com HC-11, devolução, chute); as medidas de `media.ts` com vídeos de teste gerados pelo ffmpeg
// 8.1.1 fixado num diretório temporário (nunca no repositório); e o preparo do Hagah (`hagah.ts`) com um runner falso.
// `node --test spikes/sp-5/sp5.test.ts`.

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { deflateSync } from 'node:zlib';

import { loadConfig } from '../../mac/src/core/config.ts';
import { isContrarregraError } from '../../mac/src/core/errors.ts';
import type { TreeNode } from '../../mac/src/core/types.ts';
import { openFfmpeg, runFfmpeg, type Ffmpeg } from '../../mac/src/media/ffmpeg.ts';
import { ObsClient } from '../../mac/src/obs/client.ts';
import { OBS_SUBPROTOCOL } from '../../mac/src/obs/ws.ts';
import { startWsServer, type WsTestConnection, type WsTestServer } from '../../mac/test/helpers/ws-server.ts';
import { psalm23Screen, tapToggle, transportToggle, type PrepCtx } from './hagah.ts';
import {
  CONFIGS,
  CROP_LEFT_PX,
  GiB,
  PALETTE_REF,
  TEMP_INPUT,
  avVerdict,
  cellInteriorsPt,
  clockStats,
  colorVerdict,
  decodePng,
  diskCheck,
  envelope,
  estimateBytes,
  findAudioEdge,
  findFlip,
  frameColor,
  isOwnRecording,
  kickVerdict,
  longVerdict,
  maxXcorr,
  parseProbe,
  peakVerdict,
  pickFormat,
  requiredFreeBytes,
  resolveDevice,
  sameJson,
  scanObsLog,
  speakerVerdict,
  summarizeColor,
  windowStats,
  type AvEvent,
  type Json,
  type KickTrial,
  type RgbImage,
} from './lib.ts';
import { grayWindow, parseAvfAudioDevices, pcmMono, pickBuiltInMic, probe, rgbFrames } from './media.ts';
import { DiskLowError, applyConfig, discard, isNativeLive, kick, liveState, pollUntil, readSnapshot, record, restore, type ObsTargets } from './obs.ts';
import { cmdReport, parseArgs } from './sp5.ts';

const TMP = mkdtempSync(join(tmpdir(), 'sp5-test-'));
after(() => rmSync(TMP, { recursive: true, force: true }));

// ---------------------------------------------------------------------------------------------------------
// PNG de teste (codificador mínimo, com os 5 filtros por linha)

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

function solid(width: number, height: number, rgb: [number, number, number], channels = 4): RgbImage {
  const data = new Uint8Array(width * height * channels);
  for (let i = 0; i < width * height; i++) {
    data.set(channels >= 3 ? rgb : [rgb[0]], i * channels);
    if (channels === 4) data[i * channels + 3] = 255;
  }
  return { width, height, channels, data };
}

/** A tela do relógio em px (fundo cinza, células alternadas), com `map` para simular a captura. */
function clockScreen(width: number, offsetX: number, map: (v: number) => number = (v) => v): RgbImage {
  const height = 2532;
  const img = solid(width, height, [map(128), map(128), map(128)], 3);
  cellInteriorsPt().forEach((cell, i) => {
    const v = map(i % 3 === 0 ? 255 : 0);
    const x0 = Math.round((cell.x - 8) * 3) + offsetX;
    const y0 = Math.round((cell.y - 8) * 3);
    for (let y = y0; y < y0 + 132; y++) {
      for (let x = Math.max(0, x0); x < Math.min(width, x0 + 132); x++) img.data.set([v, v, v], (y * width + x) * 3);
    }
  });
  return img;
}

// ---------------------------------------------------------------------------------------------------------

describe('lib: disco (HC-11)', () => {
  it('estimativa de S9 item 4 e o livre exigido: 10 min a 16 Mbps → 1,5 GB e 6,19 GiB; 8 s → o piso de 4 GiB', () => {
    assert.equal(estimateBytes(16_000, 600), 1.5e9);
    assert.equal(Math.round((requiredFreeBytes(estimateBytes(16_000, 600), 4) / GiB) * 100) / 100, 6.19);
    assert.equal(requiredFreeBytes(estimateBytes(16_000, 8), 4), 4 * GiB);
  });

  it('vale o menor livre (statfs × GetStats) e recusa abaixo do limite', () => {
    const ok = diskCheck(20 * GiB, 30 * 1024, estimateBytes(16_000, 600), 4);
    assert.equal(ok.ok, true);
    assert.equal(ok.freeBytes, 20 * GiB);
    const low = diskCheck(20 * GiB, 5 * 1024, estimateBytes(16_000, 600), 4);
    assert.equal(low.ok, false);
    assert.equal(low.freeBytes, 5 * GiB);
  });
});

describe('lib: PNG e cor', () => {
  it('decodifica PNG de 8 bits RGB, RGBA e cinza com os 5 filtros', () => {
    for (const channels of [1, 3, 4]) {
      const img = solid(17, 9, [10, 200, 77], channels);
      img.data[5] = 99;
      img.data[img.data.length - 2] = 3;
      const back = decodePng(encodePng(img));
      assert.equal(back.width, 17);
      assert.equal(back.channels, channels);
      assert.deepEqual(Array.from(back.data), Array.from(img.data));
    }
  });

  it('PNG com outra profundidade é recusado', () => {
    const png = encodePng(solid(2, 2, [0, 0, 0], 3));
    png[8 + 8 + 8] = 16;
    assert.throws(() => decodePng(png), /profundidade/);
  });

  it('tela do relógio fiel → Δ ≤ 3 contra a paleta, nos dois enquadramentos (fonte nativa e quadro com recorte)', () => {
    for (const [width, offsetX] of [[1170, 0], [1168, -CROP_LEFT_PX]] as const) {
      const measured = summarizeColor([frameColor(clockScreen(width, offsetX), offsetX)]);
      const v = colorVerdict(measured, PALETTE_REF);
      assert.equal(v.ok, true, JSON.stringify({ measured, v }));
      assert.equal(v.maxDiff, 0);
      assert.equal(v.washedOut, false);
    }
  });

  it('faixa parcial lida como cheia (16–235) → reprova e marca "lavado"', () => {
    const limited = (v: number): number => Math.round(16 + (v * 219) / 255);
    const measured = summarizeColor([frameColor(clockScreen(1168, -1, limited), -1)]);
    const v = colorVerdict(measured, PALETTE_REF);
    assert.equal(v.ok, false);
    assert.equal(v.washedOut, true);
    assert.ok((v.blackDiff ?? 0) >= 16);
  });

  it('desvio de 4 no cinza reprova; de 3 passa', () => {
    const m3 = summarizeColor([frameColor(clockScreen(1170, 0, (v) => (v === 128 ? 131 : v)), 0)]);
    const m4 = summarizeColor([frameColor(clockScreen(1170, 0, (v) => (v === 128 ? 132 : v)), 0)]);
    assert.equal(colorVerdict(m3, PALETTE_REF).ok, true);
    assert.equal(colorVerdict(m4, PALETTE_REF).ok, false);
  });
});

describe('lib: áudio', () => {
  const rate = 48_000;
  const tone = (seconds: number, amp: number, gaps: [number, number][] = []): Float32Array => {
    const out = new Float32Array(Math.round(seconds * rate));
    for (let i = 0; i < out.length; i++) {
      const t = i / rate;
      out[i] = gaps.some(([a, b]) => t >= a && t < b) ? 0 : amp * Math.sin(2 * Math.PI * 300 * t);
    }
    return out;
  };

  it('picos entre −20 e −3 dBFS passam; baixo, clipado e sem áudio reprovam', () => {
    assert.equal(peakVerdict(windowStats(tone(10, 10 ** (-10 / 20)), rate)).ok, true);
    assert.match(peakVerdict(windowStats(tone(10, 10 ** (-30 / 20)), rate)).reason, /mediana/);
    assert.match(peakVerdict(windowStats(tone(10, 0.99), rate)).reason, /pico máximo/);
    assert.match(peakVerdict(windowStats(new Float32Array(rate * 10), rate)).reason, /não chegou/);
  });

  it('borda de parada e de começo com 1 s de silêncio; pausa natural curta não conta', () => {
    const s = tone(6, 0.3, [[1.0, 1.3], [3.0, 4.2]]);
    const stop = findAudioEdge(s, rate, 0.5, 0, s.length, 'stop', 1_000);
    assert.ok(stop !== null && Math.abs(stop.edgeS - 3.5) < 0.002, JSON.stringify(stop));
    assert.equal(stop!.valid, true);
    const start = findAudioEdge(s, rate, 0.5, 0, s.length, 'start', 1_000);
    assert.ok(start !== null && Math.abs(start.edgeS - 4.7) < 0.002, JSON.stringify(start));
    assert.equal(start!.valid, true);
  });

  it('corte fora da fala (som fraco junto da borda) fica inválido', () => {
    const s = tone(4, 0.001, [[2, 3.5]]);
    const stop = findAudioEdge(s, rate, 0, 0, s.length, 'stop', 1_000);
    assert.ok(stop !== null);
    assert.equal(stop!.valid, false);
  });

  it('correlação acha o atraso do envelope; veredicto do alto-falante', () => {
    const a = new Float32Array(500);
    for (let i = 0; i < a.length; i++) a[i] = Math.abs(Math.sin(i / 7)) * (i % 37 < 20 ? 1 : 0.1);
    const b = new Float32Array(800);
    b.set(a, 120);
    const x = maxXcorr(a, b, 0, 300);
    assert.equal(x.lag, 120);
    assert.ok(x.r > 0.99);
    assert.equal(speakerVerdict({ micFloorDb: -60, controlRiseDb: 20, xcorrR: 0.05 }).verdict, 'silent');
    assert.equal(speakerVerdict({ micFloorDb: -60, controlRiseDb: 20, xcorrR: 0.6 }).verdict, 'audible');
    assert.equal(speakerVerdict({ micFloorDb: -240, controlRiseDb: 0, xcorrR: 0 }).verdict, 'inconclusive');
    assert.equal(speakerVerdict({ micFloorDb: -60, controlRiseDb: 2, xcorrR: 0 }).verdict, 'inconclusive');
    assert.equal(envelope(new Float32Array(4800), 48_000, 10).length, 10);
  });
});

describe('lib: A/V, ffprobe, AC-9.7, chute, registro, relógio, arquivos', () => {
  it('a virada do ícone: o realce do toque (ícone escurecido) não conta; a forma nova conta', () => {
    const A = new Uint8Array(100).map((_, i) => (i < 50 ? 200 : 20));
    const dim = A.map((v) => Math.round(v * 0.6));
    const B = new Uint8Array(100).map((_, i) => (i % 2 === 0 ? 200 : 20));
    const frames = [A, A, dim, dim, B, B, B, B].map((data, i) => ({ ptsS: i / 60, data }));
    const flip = findFlip(frames);
    assert.deepEqual(flip, { ptsS: 4 / 60, index: 4 });
    assert.equal(findFlip([A, A, A, A].map((data, i) => ({ ptsS: i, data }))), null);
  });

  it('defasagem A/V: mediana das pausas válidas, ≥ 10; play só registra', () => {
    const ev = (kind: 'pause' | 'play', offsetMs: number, valid = true): AvEvent => ({ kind, videoS: 1, audioS: 1 + offsetMs / 1000, offsetMs, valid });
    const ok = avVerdict([...Array.from({ length: 10 }, (_, i) => ev('pause', 10 + i)), ev('play', 300)]);
    assert.equal(ok.ok, true);
    assert.equal(ok.pause.medianMs, 14.5);
    assert.equal(ok.play.medianMs, 300);
    assert.match(avVerdict(Array.from({ length: 9 }, () => ev('pause', 0))).reason, /inconclusivo/);
    assert.match(avVerdict(Array.from({ length: 12 }, () => ev('pause', 60))).reason, /fora de ±45/);
    assert.equal(avVerdict([...Array.from({ length: 10 }, () => ev('pause', 0)), ev('pause', 500, false)]).pause.medianMs, 0);
  });

  const probeJson = (overrides: Json = {}, size = 1.2e9): ReturnType<typeof parseProbe> =>
    parseProbe({
      streams: [
        { codec_type: 'video', codec_name: 'h264', width: 1168, height: 2532, r_frame_rate: '60/1', avg_frame_rate: '60/1', nb_read_packets: '36000', duration: '600.000', start_time: '0.000', profile: 'High', level: 51, pix_fmt: 'yuv420p', color_range: 'tv', color_space: 'bt709', ...overrides },
        { codec_type: 'audio', codec_name: 'aac', sample_rate: '48000', channels: 2, start_time: '0.000', duration: '600.0' },
      ],
      format: { start_time: '0.000', duration: '600.0' },
      chapters: [],
    }, size);

  it('ffprobe → ProbeInfo', () => {
    const p = probeJson();
    assert.equal(p.fps, 60);
    assert.equal(p.frames, 36000);
    assert.equal(p.audio?.sampleRate, 48000);
    assert.equal(p.colorRange, 'tv');
  });

  it('AC-9.7: passa com 0 pulados, 1168×2532@60 e 1,2 GB; reprova cada desvio', () => {
    const zero = { output: 0, renderDelta: 0, outputDelta: 0, logEncoding: 0, logRender: null };
    assert.equal(longVerdict(probeJson(), zero).ok, true);
    assert.equal(longVerdict(probeJson(), { ...zero, output: 3 }).ok, false);
    assert.equal(longVerdict(probeJson({ r_frame_rate: '30/1' }), zero).ok, false);
    assert.equal(longVerdict(probeJson({ width: 1170 }), zero).ok, false);
    assert.equal(longVerdict(probeJson({}, 0.8e9), zero).ok, false);
    assert.equal(longVerdict(probeJson({}, 1.45e9), zero).ok, true);
    assert.equal(longVerdict(probeJson(), { output: null, renderDelta: null, outputDelta: null, logEncoding: null, logRender: null }).ok, false);
  });

  it('chute: 5/5 mortas e de volta em ≤ 15 s; viva sozinha não conta; queda do OBS reprova', () => {
    const trial = (over: Partial<KickTrial> = {}): KickTrial => ({ trial: 1, mode: 'restart', deadBeforeKick: true, unableInitLogged: true, kickToLiveMs: 900, variant: 'plain', deviceValue: 'X', obsCrashed: false, ...over });
    assert.equal(kickVerdict(Array.from({ length: 5 }, () => trial())).ok, true);
    assert.match(kickVerdict([...Array.from({ length: 4 }, () => trial()), trial({ deadBeforeKick: false })]).reason, /só 4/);
    assert.match(kickVerdict(Array.from({ length: 5 }, (_, i) => trial({ kickToLiveMs: i === 0 ? 16_000 : 900 }))).reason, /sem fonte viva/);
    assert.match(kickVerdict([...Array.from({ length: 5 }, () => trial()), trial({ obsCrashed: true })]).reason, /Q-8/);
  });

  it('registro do OBS: só as linhas que casam, e os pulados', () => {
    const text = [
      '23:10:51.624: iPhone: Unable to initialize device with unique ID \'EE35\'',
      '23:10:52.000: algo pessoal que não interessa',
      '23:20:00.000: Video stopped, number of skipped frames due to encoding lag: 3/36000 (0.0%)',
      '23:20:00.001: Output \'adv_file_output\': Number of lagged frames due to rendering lag/stalls: 2 (0.0%)',
    ].join('\n');
    const scan = scanObsLog(text);
    assert.equal(scan.counts['unableInit'], 1);
    assert.equal(scan.encodingSkipped, 3);
    assert.equal(scan.renderLagged, 2);
    assert.ok(!scan.lines.some((l) => l.includes('pessoal')));
  });

  it('relógio por quadro: repetidos, saltos e para trás', () => {
    const s = clockStats([0, 17, 33, 33, 50, 100, null, 117, 110]);
    assert.equal(s.decoded, 8);
    assert.equal(s.repeats, 1);
    assert.equal(s.jumps, 1);
    assert.equal(s.backwards, 1);
    assert.equal(s.maxAdvanceMs, 50);
  });

  it('gravação do spike: só nova, direto na pasta, criada depois do StartRecord', () => {
    const base = { realPath: '/m/SP-5/a.mp4', dirRealPath: '/m/SP-5', name: 'a.mp4', birthtimeMs: 1_000_000, mtimeMs: 1_000_500 };
    assert.equal(isOwnRecording(base, new Set(), 999_000).ok, true);
    assert.equal(isOwnRecording({ ...base, realPath: '/m/outra/a.mp4' }, new Set(), 999_000).ok, false);
    assert.equal(isOwnRecording({ ...base, realPath: '/m/SP-5/sub/a.mp4' }, new Set(), 999_000).ok, false);
    assert.equal(isOwnRecording(base, new Set(['a.mp4']), 999_000).ok, false);
    assert.equal(isOwnRecording(base, new Set(), 1_100_000).ok, false);
  });

  it('device pelo itemName, formato preferindo 1170×2532, igualdade de ajustes', () => {
    const items = [
      { itemName: 'FaceTime HD Camera', itemEnabled: true, itemValue: 'cam' },
      { itemName: 'VIVO_00G7', itemEnabled: true, itemValue: 'EE35C40D' },
    ];
    assert.equal(resolveDevice(items, 'VIVO_00G7'), 'EE35C40D');
    assert.equal(resolveDevice(items, 'outro'), null);
    assert.equal(pickFormat([]), null);
    assert.deepEqual(pickFormat([{ itemName: '1920x1080', itemEnabled: true, itemValue: 'a' }, { itemName: '1170x2532 420v', itemEnabled: true, itemValue: 'b' }]), { name: '1170x2532 420v', value: 'b' });
    assert.equal(sameJson({ a: 1, b: { c: [1, 2] } }, { b: { c: [1, 2] }, a: 1 }), true);
    assert.equal(sameJson({ a: 1 }, { a: 1, b: 2 }), false);
  });
});

describe('argumentos e relatório', () => {
  it('valores padrão e recusas', () => {
    const a = parseArgs(['configs', '--label', 'c1']);
    assert.deepEqual(a.configs, ['high', 'format60', 'capturecard', 'preset4k']);
    assert.equal(a.speaker, 'human');
    assert.equal(parseArgs(['long', '--label', 'l', '--no-audio']).audio, false);
    assert.throws(() => parseArgs(['configs', '--label', 'c', '--configs', 'nada']), /desconhecida/);
    assert.throws(() => parseArgs(['configs']), /label/);
    assert.throws(() => parseArgs(['audio', '--label', 'a', '--speaker', 'alto']), /speaker/);
    assert.ok(CONFIGS['format60-full']?.needsFormat);
  });

  it('report monta as tabelas a partir dos resumos', () => {
    const dir = join(TMP, 'out');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'k1-summary.json'), JSON.stringify({ phase: 'kick', trials: [{ trial: 1, mode: 'restart', deadBeforeKick: true, unableInitLogged: true, kickToLiveMs: 800, variant: 'plain', deviceValue: 'X', obsCrashed: false }], verdict: { ok: false } }));
    const text = cmdReport(['k1', 'nada'], dir);
    assert.match(text, /\| 1 \| restart \| sim \| sim \| plain \| 800 \| não \|/);
    assert.match(text, /nada: sem resumo/);
  });
});

// ---------------------------------------------------------------------------------------------------------
// OBS falso (obs-websocket 5.6.2 mínimo) com o ObsClient de produção

interface FakeState {
  profile: string;
  collection: string;
  device: string;
  settings: Json;
  alive: boolean;
  /** Chutes (SetInputSettings com o device) que ainda não fazem efeito. */
  stubbornKicks: number;
  recordDirectory: string;
  recording: boolean;
  availableMiB: number;
  inputs: Map<string, { kind: string; settings: Json; itemId: number }>;
  nextItemId: number;
  fileName: string;
}

class FakeObs {
  readonly state: FakeState;
  readonly requests: { type: string; data: Json | undefined }[] = [];
  server!: WsTestServer;
  #conns = new Set<WsTestConnection>();

  constructor(over: Partial<FakeState> = {}) {
    this.state = {
      profile: 'Contrarregra',
      collection: 'Contrarregra',
      device: 'EE35C40D-6B59-489B-8BA2-BF347E8D712C',
      settings: { buffering: false, device: 'EE35C40D-6B59-489B-8BA2-BF347E8D712C', device_name: 'VIVO_00G7', preset: 'AVCaptureSessionPresetHigh', use_preset: true },
      alive: true,
      stubbornKicks: 0,
      recordDirectory: join(TMP, 'owner-movies'),
      recording: false,
      availableMiB: 50 * 1024,
      inputs: new Map(),
      nextItemId: 3,
      fileName: '2026-10-14 10-00-00.mp4',
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
    const shot = (alive: boolean): string => `data:image/png;base64,${encodePng(solid(64, 139, alive ? [128, 128, 128] : [0, 0, 0])).toString('base64')}`;
    switch (type) {
      case 'GetVersion': return { data: { obsVersion: '31.1.2', obsWebSocketVersion: '5.6.2', rpcVersion: 1, availableRequests: ['CreateRecordChapter'], supportedImageFormats: ['png'], platform: 'macos', platformDescription: '' } };
      case 'GetProfileList': return { data: { currentProfileName: s.profile, profiles: ['Untitled', 'Contrarregra'] } };
      case 'GetSceneCollectionList': return { data: { currentSceneCollectionName: s.collection, sceneCollections: ['Untitled', 'Contrarregra'] } };
      case 'GetSceneList': return { data: { currentProgramSceneName: 'Contrarregra', scenes: [{ sceneName: 'Contrarregra' }] } };
      case 'GetSceneItemList': return { data: { sceneItems: [{ sceneItemId: 1, sourceName: 'iPhone', sceneItemEnabled: true, sceneItemIndex: 0 }, { sceneItemId: 2, sourceName: 'Sync Flash', sceneItemEnabled: false, sceneItemIndex: 1 }, ...[...s.inputs].map(([n, i]) => ({ sceneItemId: i.itemId, sourceName: n, sceneItemEnabled: true, sceneItemIndex: 2 }))] } };
      case 'GetSceneItemId': return { data: { sceneItemId: data['sourceName'] === 'iPhone' ? 1 : (s.inputs.get(String(data['sourceName']))?.itemId ?? 0) } };
      case 'GetInputList': return { data: { inputs: [{ inputName: 'iPhone', inputKind: 'macos-avcapture' }, { inputName: 'Sync Flash', inputKind: 'color_source_v3' }, ...[...s.inputs].map(([n, i]) => ({ inputName: n, inputKind: i.kind }))] } };
      case 'GetInputSettings': return { data: { inputKind: 'macos-avcapture', inputSettings: data['inputName'] === 'iPhone' ? structuredClone(s.settings) : (s.inputs.get(String(data['inputName']))?.settings ?? {}) } };
      case 'SetInputSettings': {
        const incoming = data['inputSettings'] as Json;
        if (data['inputName'] === 'iPhone') {
          s.settings = data['overlay'] === false ? structuredClone(incoming) : { ...s.settings, ...incoming };
          if (incoming['device'] === '') s.alive = false;
          else if (incoming['device'] === s.device || data['overlay'] === false) {
            if (s.stubbornKicks > 0) s.stubbornKicks--;
            else s.alive = s.settings['device'] === s.device;
          }
        }
        return {};
      }
      case 'GetSceneItemTransform': {
        const id = Number(data['sceneItemId']);
        const live = id === 1 ? s.alive : [...s.inputs.values()].some((i) => i.itemId === id);
        return { data: { sceneItemTransform: { sourceWidth: live ? 1170 : 0, sourceHeight: live ? 2532 : 0, cropLeft: 1, cropRight: 1 } } };
      }
      case 'GetSourceScreenshot': return { data: { imageData: shot(data['sourceName'] === 'iPhone' ? s.alive : true) } };
      case 'GetInputAudioSyncOffset': return { data: { inputAudioSyncOffset: 0 } };
      case 'GetInputVolume': return { data: { inputVolumeMul: 1, inputVolumeDb: 0 } };
      case 'GetInputAudioMonitorType': return { data: { monitorType: 'OBS_MONITORING_TYPE_NONE' } };
      case 'GetInputAudioTracks': return { data: { inputAudioTracks: { '1': true } } };
      case 'GetInputMute': return { data: { inputMuted: false } };
      case 'GetInputDefaultSettings': return { data: { defaultInputSettings: { device: '', use_preset: true } } };
      case 'GetInputPropertiesListPropertyItems': {
        if (data['propertyName'] === 'device') return { data: { propertyItems: [{ itemName: 'FaceTime HD Camera', itemEnabled: true, itemValue: 'cam' }, { itemName: 'VIVO_00G7', itemEnabled: true, itemValue: s.device }] } };
        if (data['propertyName'] === 'preset') return { data: { propertyItems: [{ itemName: 'High', itemEnabled: true, itemValue: 'AVCaptureSessionPresetHigh' }] } };
        if (data['propertyName'] === 'supported_format') return { data: { propertyItems: [] } };
        return { code: 600 };
      }
      case 'GetProfileParameter': return { data: { parameterValue: 'x', defaultParameterValue: null } };
      case 'GetRecordDirectory': return { data: { recordDirectory: s.recordDirectory } };
      case 'SetRecordDirectory': s.recordDirectory = String(data['recordDirectory']); return {};
      case 'GetRecordStatus': return { data: { outputActive: s.recording, outputPaused: false, outputTimecode: '00:00:00', outputDuration: 1234, outputBytes: 10 } };
      case 'GetStats': return { data: { availableDiskSpace: s.availableMiB, renderSkippedFrames: 0, renderTotalFrames: 100, outputSkippedFrames: 0, outputTotalFrames: 100, activeFps: 60 } };
      case 'GetVideoSettings': return { data: { baseWidth: 1168, baseHeight: 2532, outputWidth: 1168, outputHeight: 2532, fpsNumerator: 60, fpsDenominator: 1 } };
      case 'GetOutputStatus': return { data: { outputActive: s.recording, outputSkippedFrames: 0, outputTotalFrames: 50 } };
      case 'StartRecord': {
        s.recording = true;
        const path = join(s.recordDirectory, s.fileName);
        return { after: () => {
          writeFileSync(path, Buffer.alloc(1000, 1));
          this.emit('RecordStateChanged', { outputActive: false, outputState: 'OBS_WEBSOCKET_OUTPUT_STARTING', outputPath: null });
          this.emit('RecordStateChanged', { outputActive: true, outputState: 'OBS_WEBSOCKET_OUTPUT_STARTED', outputPath: null });
        } };
      }
      case 'StopRecord': {
        s.recording = false;
        const path = join(s.recordDirectory, s.fileName);
        return { data: { outputPath: path }, after: () => this.emit('RecordStateChanged', { outputActive: false, outputState: 'OBS_WEBSOCKET_OUTPUT_STOPPED', outputPath: path }) };
      }
      case 'CreateInput': {
        const itemId = s.nextItemId++;
        s.inputs.set(String(data['inputName']), { kind: String(data['inputKind']), settings: data['inputSettings'] as Json, itemId });
        return { data: { inputUuid: 'u', sceneItemId: itemId } };
      }
      case 'RemoveInput': s.inputs.delete(String(data['inputName'])); return {};
      case 'SetSceneItemTransform': return {};
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
const quickClock = { now: () => performance.now(), sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, Math.min(ms, 20))) };

describe('obs: com o ObsClient real e um OBS falso', () => {
  let fake: FakeObs;
  let obs: ObsClient;
  let spikeDir: string;

  before(() => {
    spikeDir = realpathSync(mkdtempSync(join(TMP, 'SP-5-')));
  });

  const fresh = async (over: Partial<FakeState> = {}): Promise<void> => {
    if (obs !== undefined) await obs.close();
    if (fake !== undefined) await fake.close();
    fake = new FakeObs(over);
    mkdirSync(fake.state.recordDirectory, { recursive: true });
    await fake.start();
    obs = await fake.connect();
  };

  after(async () => {
    await obs?.close();
    await fake?.close();
  });

  it('o instantâneo só lê (nenhuma escrita) e acha o device pelo itemName', async () => {
    await fresh();
    const snap = await readSnapshot(obs, T);
    assert.deepEqual(fake.writes(), []);
    assert.equal(snap.device.value, fake.state.device);
    assert.equal(snap.device.count, 2);
    assert.equal(snap.source.itemId, 1);
    assert.deepEqual(snap.lists['supported_format'], { count: 0, items: [] });
    assert.ok('error' in (snap.lists['video_range'] as Json));
  });

  it('fora do perfil "Contrarregra" a guarda recusa a configuração e nada é escrito', async () => {
    await fresh();
    const snap = await readSnapshot(obs, T);
    fake.state.profile = 'Untitled';
    await assert.rejects(applyConfig(obs, T, snap, CONFIGS['preset4k']!, fake.state.device, null), (e: unknown) => isContrarregraError(e, 'E_OBS_CONFIG'));
    assert.deepEqual(fake.writes(), []);
  });

  it('Capture Card: solta o iPhone, cria a fonte temporária; a devolução remove e repõe tudo exatamente', async () => {
    await fresh();
    const snap = await readSnapshot(obs, T);
    await obs.request('SetRecordDirectory', { recordDirectory: spikeDir });
    const applied = await applyConfig(obs, T, snap, CONFIGS['capturecard']!, fake.state.device, null);
    assert.equal(applied.input, TEMP_INPUT);
    assert.equal(fake.state.alive, false);
    assert.ok(fake.state.inputs.has(TEMP_INPUT));
    const report = await restore(obs, T, snap, quickClock, () => {});
    assert.deepEqual(report.errors, []);
    assert.equal(report.settingsEqual, true);
    assert.equal(report.live, true);
    assert.equal(fake.state.inputs.has(TEMP_INPUT), false);
    assert.equal(fake.state.recordDirectory, snap.recordDirectory);
    assert.ok(sameJson(fake.state.settings, snap.source.settings));
  });

  it('entre configurações, a devolução sem a pasta de gravação mantém a pasta do spike', async () => {
    await fresh();
    const snap = await readSnapshot(obs, T);
    await obs.request('SetRecordDirectory', { recordDirectory: spikeDir });
    await applyConfig(obs, T, snap, CONFIGS['preset4k']!, fake.state.device, null);
    await restore(obs, T, snap, quickClock, () => {}, { recordDirectory: false });
    assert.equal(fake.state.recordDirectory, spikeDir);
    assert.equal(fake.state.settings['preset'], 'AVCaptureSessionPresetHigh');
  });

  it('fonte morta → o chute a traz de volta; liveState lê tamanho e não-preto', async () => {
    await fresh({ alive: false });
    assert.equal(isNativeLive(await liveState(obs, T.scene, T.source, 1)), false);
    await kick(obs, T.source, fake.state.device, 'plain');
    const w = await pollUntil(() => liveState(obs, T.scene, T.source, 1), isNativeLive, 2_000, 20, quickClock);
    assert.equal(w.ok, true);
    fake.state.alive = false;
    fake.state.stubbornKicks = 1;
    await kick(obs, T.source, fake.state.device, 'plain');
    assert.equal(fake.state.alive, false);
    await kick(obs, T.source, fake.state.device, 'reset');
    assert.equal(fake.state.alive, true);
    const sent = fake.requests.filter((r) => r.type === 'SetInputSettings').map((r) => (r.data?.['inputSettings'] as Json)['device']);
    assert.deepEqual(sent.slice(-3), [fake.state.device, '', fake.state.device]);
  });

  it('gravação: HC-11 abaixo do limite → nada é gravado (nenhum StartRecord)', async () => {
    await fresh({ availableMiB: 100 });
    await obs.request('SetRecordDirectory', { recordDirectory: spikeDir });
    await assert.rejects(
      record(obs, { dir: spikeDir, durationS: 600, bitrateKbps: 16_000, minFreeGiB: 4, criticalGiB: 2 }, { freeBytes: async () => 100 * GiB, probeOk: async () => true, now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)), log: () => {} }),
      DiskLowError,
    );
    assert.equal(fake.requests.some((r) => r.type === 'StartRecord'), false);
  });

  it('gravação: guarda antes do StartRecord, STOPPED com o caminho, arquivo nosso; o apagar só leva ele', async () => {
    await fresh({ fileName: 'nova.mp4' });
    await obs.request('SetRecordDirectory', { recordDirectory: spikeDir });
    writeFileSync(join(spikeDir, 'de-antes.txt'), 'x');
    let duringRan = false;
    const r = await record(obs, {
      dir: spikeDir, durationS: 0.3, bitrateKbps: 16_000, minFreeGiB: 4, criticalGiB: 2, pollOutputMs: 50,
      during: async (ctl) => {
        duringRan = (await ctl.outputMs()).ms === 1234;
      },
    }, { freeBytes: async () => 100 * GiB, probeOk: async () => true, now: () => Date.now(), sleep: (ms) => new Promise((res) => setTimeout(res, ms)), log: () => {} });
    assert.equal(duringRan, true);
    assert.equal(r.name, 'nova.mp4');
    const types = fake.requests.map((q) => q.type);
    const start = types.indexOf('StartRecord');
    assert.ok(types.slice(0, start).includes('GetProfileList') && types.slice(0, start).includes('GetSceneCollectionList'));
    assert.ok(types.includes('StopRecord') && types.includes('GetOutputStatus'));
    assert.throws(() => discard({ ...r, file: join(spikeDir, 'de-antes.txt'), name: 'de-antes.txt' }, spikeDir), /nada foi apagado/);
    assert.throws(() => discard({ ...r, ino: r.ino + 1 }, spikeDir), /nada foi apagado/);
    const gone = discard(r, spikeDir);
    assert.equal(gone.name, 'nova.mp4');
    assert.equal(existsSync(r.file), false);
    assert.equal(existsSync(join(spikeDir, 'de-antes.txt')), true);
  });

  it('gravação fora da pasta do spike é recusada antes de gravar', async () => {
    await fresh();
    await assert.rejects(
      record(obs, { dir: spikeDir, durationS: 0.1, bitrateKbps: 16_000, minFreeGiB: 4, criticalGiB: 2 }, { freeBytes: async () => 100 * GiB, probeOk: async () => true, now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)), log: () => {} }),
      /não a do spike/,
    );
    assert.equal(fake.requests.some((q) => q.type === 'StartRecord'), false);
  });
});

// ---------------------------------------------------------------------------------------------------------
// media.ts com vídeos de teste do ffmpeg fixado

describe('media: arquivos de teste gerados pelo ffmpeg 8.1.1 fixado', () => {
  let ff: Ffmpeg;
  const config = loadConfig({ configPath: join(TMP, 'sem-config.json') });

  before(async () => {
    ff = await openFfmpeg(config);
  });

  /**
   * 1168×2532 com o relógio: fundo 0x808080 e células brancas/pretas, 1 s, H.264 BT.709 de faixa parcial; `pc` troca só
   * a marca de faixa no fluxo (`h264_metadata`, sem recodificar): os dados parciais lidos como cheios = "lavado".
   */
  async function clockVideo(out: string, tagRange: 'tv' | 'pc'): Promise<void> {
    const boxes = cellInteriorsPt().map((cell, i) => {
      const x = Math.round((cell.x - 8) * 3) - CROP_LEFT_PX;
      const y = Math.round((cell.y - 8) * 3);
      return `drawbox=x=${x}:y=${y}:w=132:h=132:color=${i % 3 === 0 ? 'white' : 'black'}:t=fill`;
    });
    const tv = tagRange === 'tv' ? out : `${out}.tv.mp4`;
    await runFfmpeg(ff, [
      '-f', 'lavfi', '-i', 'color=c=0x808080:s=1168x2532:r=60:d=1',
      '-vf', [...boxes, 'scale=out_color_matrix=bt709:out_range=tv:flags=accurate_rnd+full_chroma_int', 'format=yuv420p'].join(','),
      '-c:v', 'libx264', '-preset', 'ultrafast', '-qp', '0',
      '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv',
      '-y', tv,
    ]);
    if (tagRange === 'pc') await runFfmpeg(ff, ['-i', tv, '-c', 'copy', '-bsf:v', 'h264_metadata=video_full_range_flag=1', '-color_range', 'pc', '-y', out]);
  }

  it('cor no arquivo: faixa certa passa (Δ ≤ 3); faixa parcial marcada como cheia sai "lavada"', async () => {
    for (const [tag, ok] of [['tv', true], ['pc', false]] as const) {
      const file = join(TMP, `clock-${tag}.mp4`);
      await clockVideo(file, tag);
      const info = await probe(ff, file);
      assert.equal(info.width, 1168);
      assert.equal(info.fps, 60);
      const frames = [];
      for await (const f of rgbFrames(ff, file, { startS: 0.2, frames: 3, width: info.width, height: info.height })) frames.push(frameColor(f, -CROP_LEFT_PX));
      assert.equal(frames.length, 3);
      const v = colorVerdict(summarizeColor(frames), PALETTE_REF);
      assert.equal(v.ok, ok, JSON.stringify({ tag, v, m: summarizeColor(frames) }));
      if (!ok) assert.equal(v.washedOut, true);
    }
  });

  it('PCM em R e bordas do áudio; virada de região numa janela', async () => {
    const file = join(TMP, 'av.mp4');
    await runFfmpeg(ff, [
      '-f', 'lavfi', '-i', 'color=c=black:s=64x48:r=60:d=4',
      '-f', 'lavfi', '-i', "aevalsrc='0.3*sin(2*PI*300*t)*(lt(t,1.5)+gte(t,2.7))':s=48000:d=4",
      '-vf', "drawbox=x=0:y=0:w=32:h=48:color=white:t=fill:enable='gte(t,1.5)'",
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k',
      '-y', file,
    ]);
    const info = await probe(ff, file);
    assert.ok(info.audio !== null);
    const pcm = await pcmMono(ff, file, info);
    const stop = findAudioEdge(pcm.samples, pcm.rate, pcm.startR, 0, pcm.samples.length, 'stop', 1_000);
    const start = findAudioEdge(pcm.samples, pcm.rate, pcm.startR, 0, pcm.samples.length, 'start', 1_000);
    assert.ok(stop !== null && Math.abs(stop.edgeS - 1.5) < 0.03, JSON.stringify(stop));
    assert.ok(start !== null && Math.abs(start.edgeS - 2.7) < 0.03, JSON.stringify(start));
    const frames = await grayWindow(ff, file, { x: 0, y: 0, w: 32, h: 48 }, 1.2, 0.8);
    const flip = findFlip(frames);
    assert.ok(flip !== null && Math.abs(flip.ptsS - 1.5) < 1 / 60 + 1e-6, JSON.stringify(flip));
  });

  it('lista do AVFoundation e o microfone embutido (texto de exemplo, sem abrir microfone)', () => {
    const devices = parseAvfAudioDevices([
      '[AVFoundation indev @ 0x1] AVFoundation video devices:',
      '[AVFoundation indev @ 0x1] [0] FaceTime HD Camera',
      '[AVFoundation indev @ 0x1] AVFoundation audio devices:',
      '[AVFoundation indev @ 0x1] [0] BlackHole 2ch',
      '[AVFoundation indev @ 0x1] [1] MacBook Air Microphone',
    ].join('\n'));
    assert.deepEqual(devices, [{ index: 0, name: 'BlackHole 2ch' }, { index: 1, name: 'MacBook Air Microphone' }]);
    assert.deepEqual(pickBuiltInMic(devices), { index: 1, name: 'MacBook Air Microphone' });
    assert.equal(pickBuiltInMic([{ index: 0, name: 'BlackHole 2ch' }]), null);
  });
});

// ---------------------------------------------------------------------------------------------------------
// hagah.ts com árvore de exemplo e um runner falso

describe('hagah: transporte e toque do Play/Pause', () => {
  const node = (label: string, y: number, type: TreeNode['type'] = 'button'): TreeNode => ({ ref: label, type, label, frame: { x: 100, y, w: 44, h: 44 }, enabled: true, selected: false, visible: true, depth: 1 });
  const nodes: TreeNode[] = [
    node('Psalms 23 NIV', 100, 'staticText'),
    node('Back 15 seconds', 600),
    node('Play', 602),
    node('Forward 15 seconds', 600),
    node('Pause', 760),
  ];

  it('acha o Play da fileira (não o "Pause" da linha de repetição) e reconhece o Now Playing', () => {
    const t = transportToggle(nodes);
    assert.equal(t?.label, 'Play');
    assert.equal(t?.frame.y, 602);
    assert.equal(psalm23Screen(nodes), 'nowPlaying');
  });

  it('tapToggle escolhe o candidato mais perto da fileira e devolve a resposta do runner', async () => {
    const calls: { method: string; params: unknown }[] = [];
    const ctx: PrepCtx = {
      bundleId: 'app.kifactory.hagah',
      write: () => {},
      now: () => performance.now(),
      sleep: async () => {},
      rpc: {
        call: async <R>(method: string, params?: Record<string, unknown>): Promise<R> => {
          calls.push({ method, params });
          if (method === 'ui.find') {
            return { candidates: [
              { frame: { x: 100, y: 760, w: 44, h: 44 }, visible: true, hittable: true },
              { frame: { x: 100, y: 600, w: 44, h: 44 }, visible: true, hittable: true },
            ] } as R;
          }
          return { tDevStartNs: '1', tDispatchNs: '2', tDevEndNs: '3' } as R;
        },
      },
    };
    const r = await tapToggle(ctx, 'Pause', 622);
    assert.equal(r['tDispatchNs'], '2');
    assert.deepEqual(calls[1], { method: 'ui.tap', params: { target: { label: 'Pause', type: 'button', index: 1 } } });
  });
});

