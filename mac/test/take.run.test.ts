// Testes da M3 (trilha do demo): `take run` de ponta a ponta com falsos — ordem da gravação (StartRecord
// antes da s01, StopRecord depois da última, pasta de gravação devolvida mesmo em falha), pré-voo reduzido
// (disco, perfil, fonte viva com o "chute", runner), `--dry` sem OBS, `take.json`, trava do aparelho,
// `take control` e Ctrl-C. O runner e o OBS são falsos (`helpers/take-fakes.ts`); nada fala com o iPhone, o
// runner ou o OBS reais. Os arquivos ficam numa pasta temporária.

import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import { main } from '../src/cli/main.ts';
import { takeControl, takeRun } from '../src/commands/take.ts';
import type { CommandContext } from '../src/commands/context.ts';
import { isContrarregraError, type ErrorCode } from '../src/core/errors.ts';
import { runnerPaths } from '../src/runner/paths.ts';
import { readTakeLock } from '../src/runner/session.ts';
import { readTakeRecord, type TakeRecord } from '../src/take/manifest.ts';
import { GiB, POSTROLL_MS, PREROLL_MS } from '../src/take/obs.ts';
import { parseSayDevices, sayArgs, type TakeRunDeps, type TakeSummary } from '../src/take/run.ts';
import { FakeClock, FakeObs, FakeRunner, rpcError, takeEnv, waitTrueAfter, type FakeObsOptions, type RunnerHandler, type TakeEnv } from './helpers/take-fakes.ts';

const CHOREO = `
schema: contrarregra.choreography/1
app: {bundleId: app.example.demo, iconLabel: "Demo", expectVersion: "1.0.0 (7)", urlPrefixes: ["demo://"]}
device: {language: en, screenPt: {w: 390, h: 844}, textSize: large, appearance: light}
targets:
  play: {label: "Play", type: button}
prepare:
  - {id: p.open, do: openURL, url: "demo://start"}
scenes:
  - id: s01
    title: "Abertura"
    line: ["Hello.", "Welcome."]
    hold: {padBeforeMs: 500, padAfterMs: 500}
    steps:
      - {id: s01.play, do: tap, target: {ref: play}}
      - {id: s01.mark, do: mark, label: "meio"}
      - {id: s01.cue, do: tap, target: {label: "Next"}, cue: 1}
  - id: s02
    title: "Fim"
    line: ["Bye."]
    steps:
      - {id: s02.stop, do: tap, target: {label: "Stop"}, onFail: abort}
cleanup:
  - {id: c.term, do: app, action: terminate}
`;

interface World {
  env: TakeEnv;
  file: string;
  clock: FakeClock;
  trace: string[];
  runner: FakeRunner;
  obs: FakeObs;
  said: string[];
  lines: string[];
  sigint: ((signal: string) => void) | undefined;
  connectObsCalls: number;
  deps: TakeRunDeps;
  ctx: CommandContext;
}

const worlds: World[] = [];
afterEach(() => {
  for (const w of worlds.splice(0)) w.env.cleanup();
});

function world(options: { obs?: Omit<FakeObsOptions, 'clock' | 'trace'>; handlers?: Record<string, RunnerHandler | RunnerHandler[]>; freeGiB?: number; yaml?: string } = {}): World {
  const env = takeEnv();
  const file = join(env.choreoDir, 'review.choreo.yaml');
  writeFileSync(file, options.yaml ?? CHOREO);
  const clock = new FakeClock();
  const trace: string[] = [];
  const runner = new FakeRunner(clock, options.handlers ?? {}, trace);
  const obs = new FakeObs({ clock, trace, ...options.obs });
  const w = { env, file, clock, trace, runner, obs, said: [], lines: [], sigint: undefined, connectObsCalls: 0 } as unknown as World;
  w.deps = {
    openRunner: async () => runner,
    connectObs: async () => {
      w.connectObsCalls += 1;
      return obs;
    },
    probeOk: async () => true,
    freeBytes: async () => (options.freeGiB ?? 100) * GiB,
    say: (text) => {
      w.said.push(text);
      trace.push(`say ${text}`);
    },
    clock,
    onInterrupt: (handler) => {
      w.sigint = handler;
      return () => {
        w.sigint = undefined;
      };
    },
  };
  w.ctx = { config: env.config, configDir: env.root, onProgress: (line) => void w.lines.push(line) };
  worlds.push(w);
  return w;
}

function at(trace: string[], entry: string, from = 0): number {
  const i = trace.findIndex((t, k) => k >= from && t === entry);
  assert.ok(i >= 0, `não achei "${entry}" em:\n${trace.join('\n')}`);
  return i;
}

function lastIndex(trace: string[], predicate: (t: string) => boolean): number {
  for (let i = trace.length - 1; i >= 0; i--) if (predicate(trace[i]!)) return i;
  return -1;
}

async function rejectsCode(promise: Promise<unknown>, code: ErrorCode): Promise<void> {
  try {
    await promise;
  } catch (error) {
    assert.ok(isContrarregraError(error), String(error));
    assert.equal(error.code, code, error.message);
    return;
  }
  assert.fail(`esperava ${code}`);
}

function takeDirs(w: World): string[] {
  const dir = join(w.env.takes, 'demo');
  return existsSync(dir) ? readdirSync(dir) : [];
}

describe('take run: gravação e ordem (S9 item 5)', () => {
  test('prepare fora do vídeo → StartRecord → pré-rolo → cenas → pós-rolo → StopRecord → pasta devolvida → cleanup', async () => {
    const w = world();
    let lockDuringTake: string | undefined;
    w.runner.handlers['ui.tap'] = () => {
      lockDuringTake = readTakeLock(runnerPaths(w.env.config));
      return {};
    };
    const summary = await takeRun(w.ctx, { file: w.file }, w.deps);
    assert.equal(summary.status, 'finished', JSON.stringify(summary));
    const t = w.trace;
    const prepare = at(t, 'runner app.openURL');
    const startRecord = at(t, 'obs StartRecord');
    const setDir = at(t, 'obs SetRecordDirectory');
    const chapter1 = at(t, 'obs CreateRecordChapter Abertura');
    const firstScene = at(t, 'runner ui.tap "Play"');
    const lastScene = at(t, 'runner ui.tap "Stop"');
    const stop = at(t, 'obs StopRecord');
    const restore = at(t, 'obs SetRecordDirectory', stop);
    const cleanup = at(t, 'runner app.terminate');
    assert.ok(prepare < setDir && setDir < startRecord, 'prepare antes de gravar; a pasta antes do StartRecord');
    assert.ok(startRecord < chapter1 && chapter1 < firstScene, 'StartRecord antes da s01');
    assert.ok(at(t, 'obs CreateRecordChapter meio') < at(t, 'runner ui.tap "Next"'));
    assert.ok(lastScene < stop && stop < restore && restore < cleanup, 'StopRecord depois da última cena; pasta devolvida; cleanup depois');
    assert.equal(lastIndex(t, (x) => x.startsWith('obs CreateRecordChapter')), at(t, 'obs CreateRecordChapter Fim'));
    assert.deepEqual(w.obs.chapters, ['Abertura', 'meio', 'Fim']);
    assert.equal(w.obs.recordDirectory, w.obs.originalDirectory, 'a pasta de gravação do dono voltou');
    assert.equal(w.obs.recording, false);
    assert.equal(lockDuringTake, summary.takeId, 'a trava existe durante a tomada');
    assert.equal(readTakeLock(runnerPaths(w.env.config)), undefined, 'e sai no fim');
    assert.equal(w.runner.closed, true);
    assert.equal(w.obs.closed, true);
    assert.deepEqual(w.obs.writesRefused, []);

    // Pasta, arquivo e take.json.
    assert.match(summary.takeId, /^\d{8}-\d{6}-review$/);
    assert.equal(summary.dir, join(w.env.takes, 'demo', summary.takeId));
    const record = readTakeRecord(summary.dir!);
    assert.equal(record.schema, 'contrarregra.demo-take/1');
    assert.equal(record.mode, 'take');
    assert.equal(record.status, 'finished');
    assert.deepEqual(record.choreography, { path: w.file, sha256: createHash('sha256').update(CHOREO).digest('hex') });
    assert.ok(record.recording !== null);
    assert.equal(basename(record.recording.file!), 'recording.mp4');
    assert.ok(existsSync(record.recording.file!));
    assert.equal(record.recording.sizeBytes, 4096);
    assert.equal(record.recording.directoryRestored, true);
    assert.equal(record.recording.previousDirectory, w.obs.originalDirectory);
    assert.equal(record.cleanupPending, false);
    assert.equal(record.pause, null);
    assert.deepEqual(record.scenes.map((s) => s.id), ['s01', 's02']);
    for (const s of record.scenes) {
      assert.equal(typeof s.videoStartMs, 'number');
      assert.equal(typeof s.videoEndMs, 'number');
      assert.ok(s.videoEndMs! > s.videoStartMs!);
    }
    const first = record.scenes[0]!;
    assert.equal(first.videoStartMs, PREROLL_MS, 'a s01 começa depois do pré-rolo');
    assert.ok(record.recording.stoppedAtMs! - record.scenes[1]!.endMs! >= POSTROLL_MS, 'pós-rolo');
    assert.deepEqual(
      record.steps.map((s) => [s.section, s.sceneId, s.index, s.id, s.do, s.status]),
      [
        ['prepare', null, '1', 'p.open', 'openURL', 'ok'],
        ['scenes', 's01', '1', 's01.play', 'tap', 'ok'],
        ['scenes', 's01', '2', 's01.mark', 'mark', 'ok'],
        ['scenes', 's01', '3', 's01.cue', 'tap', 'ok'],
        ['scenes', 's02', '1', 's02.stop', 'tap', 'ok'],
        ['cleanup', null, '1', 'c.term', 'app', 'ok'],
      ],
    );
    assert.equal(record.steps[0]!.videoMs, null, 'prepare fora do vídeo');
    assert.ok(record.steps.slice(1, 5).every((s) => typeof s.videoMs === 'number'));
    assert.equal(record.steps[5]!.videoMs, null, 'cleanup fora do vídeo');
    assert.deepEqual(summary.steps, { ok: 6, skipped: 0, failed: 0 });
    assert.ok(w.lines.some((l) => /^\[s01 1\/3 s01\.play\] tap "Play" ok \d+\.\ds$/.test(l)), w.lines.join('\n'));
  });

  test('falha no meio da cena (onFail: abort): gravação parada e finalizada, pasta devolvida, cleanup pendente, nada apagado', async () => {
    const w = world({ handlers: { 'ui.tap': [() => ({}), () => ({}), () => Promise.reject(rpcError('E_TARGET_NOT_HITTABLE'))] } });
    const summary = await takeRun(w.ctx, { file: w.file }, w.deps);
    assert.equal(summary.status, 'aborted');
    assert.equal(summary.cause, 'step-failed');
    const t = w.trace;
    assert.ok(at(t, 'obs StopRecord') < at(t, 'obs SetRecordDirectory', at(t, 'obs StopRecord')));
    assert.equal(w.obs.recordDirectory, w.obs.originalDirectory);
    assert.ok(!t.includes('runner app.terminate'), 'a cleanup não roda depois de abortar');
    const record = readTakeRecord(summary.dir!);
    assert.equal(record.status, 'aborted');
    assert.equal(record.cleanupPending, true);
    assert.ok(existsSync(record.recording!.file!), 'a gravação fica');
    assert.equal(record.recording!.directoryRestored, true);
    assert.equal(readTakeLock(runnerPaths(w.env.config)), undefined);
  });

  test('Ctrl-C no meio da s01: corta, para a gravação, devolve a pasta, aborted (SIGINT)', async () => {
    const w = world();
    w.runner.handlers['ui.tap'] = () => {
      w.sigint?.('SIGINT');
      return new Promise(() => {});
    };
    const summary = await takeRun(w.ctx, { file: w.file }, w.deps);
    assert.equal(summary.status, 'aborted');
    assert.equal(summary.cause, 'SIGINT');
    assert.equal(w.obs.recording, false);
    assert.equal(w.obs.recordDirectory, w.obs.originalDirectory);
    assert.equal(w.runner.of('ui.tap').length, 1);
    assert.equal(w.sigint, undefined, 'o tratador do SIGINT foi desligado');
  });

  test('StartRecord falha: nada de cenas, pasta devolvida, status failed com o código', async () => {
    const w = world({ obs: { startFails: true } });
    const summary = await takeRun(w.ctx, { file: w.file }, w.deps);
    assert.equal(summary.status, 'failed');
    assert.equal(summary.error?.code, 'E_OBS_CONFIG');
    assert.equal(w.obs.recordDirectory, w.obs.originalDirectory);
    assert.deepEqual(w.runner.methods(), ['app.openURL'], 'só o prepare rodou');
  });

  test('capítulo 702 só vira aviso (E-9.4)', async () => {
    const w = world({ obs: { chapters702: true } });
    const summary = await takeRun(w.ctx, { file: w.file }, w.deps);
    assert.equal(summary.status, 'finished');
    assert.equal(summary.warnings.filter((x) => x.includes('702')).length, 3);
  });
});

describe('take run: revisão — sinais, ordem da saída, gravação órfã, disco, modo avião', () => {
  test('SIGTERM e SIGHUP de verdade (tratador padrão) param a gravação, devolvem a pasta e soltam a trava', async () => {
    for (const signal of ['SIGTERM', 'SIGHUP'] as const) {
      const w = world();
      delete w.deps.onInterrupt;
      w.runner.handlers['ui.tap'] = () => {
        process.kill(process.pid, signal);
        return new Promise(() => {});
      };
      // O tratador de sinal não segura o laço de eventos (na tomada real, a conexão com o runner segura).
      const keepAlive = setTimeout(() => {}, 10_000);
      let summary: TakeSummary;
      try {
        summary = await takeRun(w.ctx, { file: w.file }, w.deps);
      } finally {
        clearTimeout(keepAlive);
      }
      assert.equal(summary.status, 'aborted', signal);
      assert.equal(summary.cause, signal);
      assert.equal(w.obs.recording, false);
      assert.equal(w.obs.recordDirectory, w.obs.originalDirectory);
      assert.equal(readTakeLock(runnerPaths(w.env.config)), undefined);
      assert.equal(process.listenerCount(signal), 0, 'o tratador saiu');
    }
  });

  test('a trava é solta e o take.json gravado antes de fechar as conexões', async () => {
    const w = world();
    let atClose: { lock: string | undefined; status: string } | undefined;
    w.runner.close = async () => {
      const dir = join(w.env.takes, 'demo', takeDirs(w)[0]!);
      atClose = { lock: readTakeLock(runnerPaths(w.env.config)), status: readTakeRecord(dir).status };
    };
    await takeRun(w.ctx, { file: w.file }, w.deps);
    assert.deepEqual(atClose, { lock: undefined, status: 'finished' });
  });

  test('STARTED sem confirmação: StopRecord por garantia antes de lançar', async () => {
    const w = world({ obs: { startFails: true } });
    await takeRun(w.ctx, { file: w.file }, w.deps);
    const types = w.obs.requests.map((r) => r.type);
    assert.ok(types.indexOf('StopRecord') > types.indexOf('StartRecord'), types.join(' '));
  });

  test('conexão com o OBS cai no StopRecord (antes ou depois de o OBS parar): reconecta uma vez, para, finaliza e devolve a pasta', async () => {
    for (const dropStop of ['before', 'after'] as const) {
      const w = world({ obs: { dropStop } });
      const summary = await takeRun(w.ctx, { file: w.file }, w.deps);
      assert.equal(summary.status, 'finished', dropStop);
      assert.equal(w.connectObsCalls, 2, 'uma reconexão');
      assert.equal(w.obs.recording, false);
      assert.equal(w.obs.recordDirectory, w.obs.originalDirectory);
      assert.equal(basename(summary.recording!.file!), 'recording.mp4');
      assert.equal(summary.recording!.directoryRestored, true);
    }
  });

  test('vigia de disco: abaixo de disk.criticalGiB durante a gravação → para e aborta (disk-critical)', async () => {
    const w = world();
    let free = 100 * GiB;
    w.deps.freeBytes = async () => free;
    w.deps.diskWatchMs = 5;
    w.runner.handlers['ui.tap'] = () => {
      free = 1 * GiB;
      return new Promise(() => {});
    };
    // O vigia usa um temporizador que não segura o laço de eventos (na tomada real, a conexão segura).
    const keepAlive = setTimeout(() => {}, 10_000);
    let summary: TakeSummary;
    try {
      summary = await takeRun(w.ctx, { file: w.file }, w.deps);
    } finally {
      clearTimeout(keepAlive);
    }
    assert.equal(summary.status, 'aborted');
    assert.equal(summary.cause, 'disk-critical');
    assert.equal(w.obs.recording, false);
    assert.ok(existsSync(summary.recording!.file!));
    assert.ok(summary.warnings.some((x) => x.includes('disco crítico')));
  });

  test('abort com o modo avião possivelmente ligado: aviso no resumo, no take.json e falado', async () => {
    const yaml = CHOREO.replace('      - {id: s02.stop, do: tap, target: {label: "Stop"}, onFail: abort}', '      - {id: s02.air, do: tap, target: {identifier: airplane-mode-button}}\n      - {id: s02.stop, do: tap, target: {label: "Stop"}, onFail: abort}');
    const w = world({ yaml, handlers: { 'ui.tap': [() => ({}), () => ({}), () => ({}), () => Promise.reject(rpcError('E_TARGET_NOT_HITTABLE'))] } });
    const summary = await takeRun(w.ctx, { file: w.file }, w.deps);
    assert.equal(summary.status, 'aborted');
    assert.equal(summary.airplaneMaybeOn, true);
    assert.ok(w.said.some((t) => t.includes('modo avião pode ter ficado ligado')));
    assert.equal(readTakeRecord(summary.dir!).airplaneLeftOn, true);
  });

  test('--voice: frase acima de 60 s ou pausa acima de 5 s → E_CONFIG', async () => {
    const w = world();
    const voice = join(w.env.root, 'voice.json');
    for (const body of [{ scenes: { s01: [{ text: 'x', durMs: 60_001 }] } }, { gapMs: 5_001, scenes: {} }]) {
      writeFileSync(voice, JSON.stringify(body));
      await rejectsCode(takeRun(w.ctx, { file: w.file, voice }, w.deps), 'E_CONFIG');
    }
  });
});

const PAUSE_CHOREO = `
schema: contrarregra.choreography/1
app: {bundleId: app.example.demo, iconLabel: "Demo", expectVersion: "1.0.0 (7)", urlPrefixes: ["demo://"]}
device: {language: en, screenPt: {w: 390, h: 844}, textSize: large, appearance: light}
targets: {}
prepare:
  - {id: p.cp, do: checkpoint, who: human, ask: "Prepare o iPhone.", until: {network: online}, timeoutMs: 1000, onTimeout: abort}
scenes:
  - id: s01
    title: "Tela travada"
    line: ["Locked.", "Unlocked."]
    hold: {padBeforeMs: 500, padAfterMs: 500}
    steps:
      - {id: s01.lock, do: lock}
      - {id: s01.unlock, do: checkpoint, who: human, ask: "Destrave o iPhone.", until: {locked: false}, timeoutMs: 90000, onTimeout: pause}
      - {id: s01.cue, do: tap, target: {label: "Next"}, cue: 1}
  - id: s02
    title: "Depois"
    line: ["After."]
    steps:
      - {id: s02.tap, do: tap, target: {label: "Stop"}}
cleanup: []
`;

describe('take run --pause-recording-at (destravar fora do vídeo)', () => {
  function pauseWorld(options: Parameters<typeof world>[0] = {}): World {
    const w = world({ yaml: PAUSE_CHOREO, ...options });
    w.deps.obsConfirmMs = { started: 50, stopped: 50, paused: 50 };
    return w;
  }

  test('pausa antes do primeiro aviso, retoma 1 s depois de until; o tempo pausado não conta na cena nem no cue', async () => {
    const w = pauseWorld();
    // until {locked: false} fica verdadeira 30 s depois da primeira avaliação; o resto do wait.for vale na hora.
    const unlock = waitTrueAfter(w.clock, 30_000);
    w.runner.handlers['wait.for'] = (params, call) => ((params['condition'] as Record<string, unknown>)['locked'] === false ? unlock(params, call) : {});
    const voice = join(w.env.root, 'voice.json');
    writeFileSync(voice, JSON.stringify({ scenes: { s01: [{ text: 'Locked.', durMs: 20_000 }, { text: 'Unlocked.', durMs: 20_000 }], s02: [{ text: 'After.', durMs: 1_000 }] } }));
    const summary = await takeRun(w.ctx, { file: w.file, voice, pauseRecordingAt: ['s01.unlock'] }, w.deps);
    assert.equal(summary.status, 'finished', JSON.stringify(summary));
    const t = w.trace;
    const pause = at(t, 'obs PauseRecord');
    assert.ok(pause < at(t, 'say Destrave o iPhone.'), 'PauseRecord antes do primeiro aviso');
    assert.ok(at(t, 'obs ResumeRecord') > pause);
    assert.ok(at(t, 'obs ResumeRecord') < at(t, 'runner ui.tap "Next"'));
    assert.equal(t.filter((x) => x === 'obs PauseRecord').length, 1);
    const record = readTakeRecord(summary.dir!);
    assert.deepEqual(record.options.pauseRecordingAt, ['s01.unlock']);
    assert.equal(record.recordingPauses.length, 1);
    const p = record.recordingPauses[0]!;
    assert.equal(p.stepId, 's01.unlock');
    assert.equal(p.sceneId, 's01');
    assert.equal(p.endedBy, 'resume');
    assert.equal(p.durationMs, 30_000 + 1_000, 'até until + 1 s para a tela assentar');
    assert.equal(p.videoAfterMs, p.videoBeforeMs, 'o trecho pausado não entra no vídeo');
    const s01 = record.scenes[0]!;
    assert.equal(s01.pausedMs, 31_000);
    assert.equal(s01.minDurationMs, 500 + 40_250 + 500);
    assert.equal(s01.videoEndMs! - s01.videoStartMs!, s01.minDurationMs, 'no vídeo a cena dura a permanência mínima');
    assert.equal(s01.endMs! - s01.startMs, s01.minDurationMs + 31_000, 'no Mac, mais o tempo pausado');
    const cue = record.steps.find((x) => x.id === 's01.cue')!;
    assert.equal(cue.videoMs! - s01.videoStartMs!, 500 + 20_000 + 250, 'a frase 1 no tempo do vídeo');
    assert.equal(record.scenes[1]!.pausedMs, undefined);
  });

  test('until já verdadeira na primeira avaliação (a pessoa se adiantou): pausa mesmo assim, antes da leitura, e retoma', async () => {
    const w = pauseWorld();
    const summary = await takeRun(w.ctx, { file: w.file, pauseRecordingAt: ['s01.unlock'] }, w.deps);
    assert.equal(summary.status, 'finished');
    const pause = w.trace.findIndex((x) => x.startsWith('obs PauseRecord'));
    const resume = w.trace.findIndex((x) => x.startsWith('obs ResumeRecord'));
    assert.ok(pause >= 0 && resume > pause, 'PauseRecord e depois ResumeRecord');
    assert.equal(readTakeRecord(summary.dir!).recordingPauses.length, 1);
  });

  test('saída com a gravação pausada (Ctrl-C no meio do destravar): para direto, sem ResumeRecord nem pós-rolo', async () => {
    const w = pauseWorld();
    w.runner.handlers['wait.for'] = (params) => {
      if ((params['condition'] as Record<string, unknown>)['locked'] !== false) return {};
      if (Number(params['timeoutMs']) === 0) throw rpcError('E_TIMEOUT');
      w.sigint?.('SIGINT');
      return new Promise(() => {});
    };
    const summary = await takeRun(w.ctx, { file: w.file, pauseRecordingAt: ['s01.unlock'] }, w.deps);
    assert.equal(summary.status, 'aborted');
    assert.ok(!w.trace.some((x) => x.startsWith('obs ResumeRecord')));
    assert.equal(w.obs.stoppedWhilePaused, true);
    assert.equal(w.obs.recordDirectory, w.obs.originalDirectory);
    const record = readTakeRecord(summary.dir!);
    assert.equal(record.recordingPauses[0]!.endedBy, 'stop');
    assert.equal(record.recording!.stoppedAtMs, record.recordingPauses[0]!.pausedAtMs, 'sem pós-rolo');
  });

  test('OBS que não para pausado: ResumeRecord de emergência (sem guarda) e StopRecord de novo', async () => {
    const w = pauseWorld({ obs: { stopIgnoredWhilePaused: true } });
    w.runner.handlers['wait.for'] = (params) => {
      if ((params['condition'] as Record<string, unknown>)['locked'] !== false) return {};
      if (Number(params['timeoutMs']) === 0) throw rpcError('E_TIMEOUT');
      w.sigint?.('SIGINT');
      return new Promise(() => {});
    };
    const summary = await takeRun(w.ctx, { file: w.file, pauseRecordingAt: ['s01.unlock'] }, w.deps);
    assert.equal(summary.status, 'aborted');
    const stops = w.trace.filter((x) => x.startsWith('obs StopRecord') || x.startsWith('obs ResumeRecord'));
    assert.deepEqual(stops, ['obs StopRecord', 'obs ResumeRecord (emergência)', 'obs StopRecord']);
    assert.equal(w.obs.recording, false);
    assert.ok(existsSync(summary.recording!.file!));
  });

  test('PauseRecord sem confirmação: o aviso de destravar não toca; a tomada pausa e o dono decide', async () => {
    const w = pauseWorld({ obs: { pauseIgnored: true } });
    w.runner.handlers['wait.for'] = (params) => {
      if ((params['condition'] as Record<string, unknown>)['locked'] === false && Number(params['timeoutMs']) === 0) throw rpcError('E_TIMEOUT');
      return {};
    };
    w.deps.say = (text) => {
      w.said.push(text);
      if (text.startsWith('Tomada pausada')) writeFileSync(join(w.env.takes, 'demo', takeDirs(w)[0]!, 'control.json'), JSON.stringify({ op: 'abort' }));
    };
    const summary = await takeRun(w.ctx, { file: w.file, pauseRecordingAt: ['s01.unlock'] }, w.deps);
    assert.equal(summary.status, 'aborted');
    assert.ok(!w.said.includes('Destrave o iPhone.'), 'nunca pedir para destravar com a gravação rodando');
    assert.ok(w.said.some((x) => x.startsWith('Tomada pausada')));
    assert.deepEqual(readTakeRecord(summary.dir!).recordingPauses, []);
  });

  test('ResumeRecord sem confirmação: aborta (recording-resume-failed) e para a gravação pausada', async () => {
    const w = pauseWorld({ obs: { resumeIgnored: true } });
    const unlock = waitTrueAfter(w.clock, 5_000);
    w.runner.handlers['wait.for'] = (params, call) => ((params['condition'] as Record<string, unknown>)['locked'] === false ? unlock(params, call) : {});
    const summary = await takeRun(w.ctx, { file: w.file, pauseRecordingAt: ['s01.unlock'] }, w.deps);
    assert.equal(summary.status, 'aborted');
    assert.equal(summary.cause, 'recording-resume-failed');
    assert.equal(w.obs.stoppedWhilePaused, true);
    assert.equal(w.runner.of('ui.tap').length, 0, 'nada mais roda sem gravar');
  });

  test('--dry: só registra que pausaria (sem OBS)', async () => {
    const w = pauseWorld();
    w.deps.connectObs = async () => assert.fail('--dry não conecta no OBS');
    const unlock = waitTrueAfter(w.clock, 10_000);
    w.runner.handlers['wait.for'] = (params, call) => ((params['condition'] as Record<string, unknown>)['locked'] === false ? unlock(params, call) : {});
    const summary = await takeRun(w.ctx, { file: w.file, dry: true, pauseRecordingAt: ['s01.unlock'] }, w.deps);
    assert.equal(summary.status, 'finished');
    const [p] = readTakeRecord(summary.dir!).recordingPauses;
    assert.equal(p!.simulated, true);
    assert.equal(p!.videoBeforeMs, null);
    assert.equal(p!.endedBy, 'resume');
    assert.ok(w.lines.some((l) => l.includes('aqui a gravação pausaria')));
  });

  test('pré-voo: id que não é checkpoint das cenas → E_CHOREO_INVALID antes de conectar; a CLI repassa a opção', async () => {
    const w = pauseWorld();
    for (const ids of [['s01.cue'], ['p.cp'], ['nada']]) {
      await rejectsCode(takeRun(w.ctx, { file: w.file, pauseRecordingAt: ids }, w.deps), 'E_CHOREO_INVALID');
    }
    assert.deepEqual(w.runner.calls, []);
    const out: string[] = [];
    const code = await main(['take', 'run', w.file, '--dry', '--json', '--pause-recording-at', 's01.unlock'], {
      config: { configPath: w.env.configPath },
      io: { stdout: (x) => void out.push(x), stderr: () => {} },
      take: w.deps,
    });
    assert.equal(code, 0);
    const summary = JSON.parse(out.join('')) as TakeSummary;
    assert.deepEqual(readTakeRecord(summary.dir!).options.pauseRecordingAt, ['s01.unlock']);
  });
});

describe('take run: pré-voo reduzido', () => {
  test('disco abaixo de max(4 GiB, estimativa + 2 GiB) → E_DISK_LOW, nada gravado nem criado', async () => {
    const w = world({ freeGiB: 2.5 });
    await rejectsCode(takeRun(w.ctx, { file: w.file }, w.deps), 'E_DISK_LOW');
    assert.deepEqual(w.obs.writes(), []);
    assert.deepEqual(w.runner.methods(), []);
    assert.deepEqual(takeDirs(w), []);
    assert.equal(readTakeLock(runnerPaths(w.env.config)), undefined);
    assert.equal(w.runner.closed, true);
    assert.equal(w.obs.closed, true);
  });

  test('o menor entre statfs e GetStats vale', async () => {
    const w = world({ freeGiB: 100, obs: { availableMiB: 1024 } });
    await rejectsCode(takeRun(w.ctx, { file: w.file }, w.deps), 'E_DISK_LOW');
  });

  test('OBS noutro perfil → E_OBS_CONFIG e nada escrito; OBS já gravando → E_OBS_CONFIG', async () => {
    const w = world({ obs: { profile: 'Untitled' } });
    await rejectsCode(takeRun(w.ctx, { file: w.file }, w.deps), 'E_OBS_CONFIG');
    assert.deepEqual(w.obs.writes(), []);
    const w2 = world({ obs: { alreadyRecording: true } });
    await rejectsCode(takeRun(w2.ctx, { file: w2.file }, w2.deps), 'E_OBS_CONFIG');
    assert.deepEqual(w2.obs.writes(), []);
  });

  test('fonte sem quadros → o chute (SetInputSettings {device}) a ressuscita; sem jeito → E_OBS_SOURCE', async () => {
    const w = world({ obs: { source: 'dead' } });
    const summary = await takeRun(w.ctx, { file: w.file }, w.deps);
    assert.equal(summary.status, 'finished');
    assert.deepEqual(w.obs.kicks, [{ device: 'dev-123' }]);
    assert.ok(w.lines.some((l) => l.includes('chute 1')));

    const w2 = world({ obs: { source: 'black', kickFails: true } });
    await rejectsCode(takeRun(w2.ctx, { file: w2.file }, w2.deps), 'E_OBS_SOURCE');
    assert.deepEqual(w2.obs.kicks, [{ device: 'dev-123' }, { device: '' }, { device: 'dev-123' }, { device: '' }, { device: 'dev-123' }]);
    assert.ok(!w2.obs.writes().includes('StartRecord'));
  });

  test('runner sem ok no health → E_RUNNER_DOWN antes de tocar no OBS', async () => {
    const w = world({ handlers: { health: () => ({ ok: false, xctestQueueDepth: 0 }) } });
    await rejectsCode(takeRun(w.ctx, { file: w.file }, w.deps), 'E_RUNNER_DOWN');
    assert.equal(w.connectObsCalls, 0);
  });

  test('coreografia inválida → E_CHOREO_INVALID antes de qualquer conexão; --from desconhecido também', async () => {
    const w = world({ yaml: CHOREO.replace('{ref: play}', '{ref: nada}') });
    let opened = 0;
    w.deps.openRunner = async () => {
      opened += 1;
      return w.runner;
    };
    await rejectsCode(takeRun(w.ctx, { file: w.file }, w.deps), 'E_CHOREO_INVALID');
    const w2 = world();
    await rejectsCode(takeRun(w2.ctx, { file: w2.file, from: 'zz' }, w2.deps), 'E_CHOREO_INVALID');
    assert.equal(opened, 0);
    assert.equal(readTakeLock(runnerPaths(w.env.config)), undefined);
  });
});

describe('take run: --dry, --scenes/--from/--until, --voice, --no-prepare/--no-cleanup', () => {
  test('--dry: nenhuma conexão com o OBS; o resto igual', async () => {
    const w = world();
    w.deps.connectObs = async () => assert.fail('--dry não conecta no OBS');
    const summary = await takeRun(w.ctx, { file: w.file, dry: true }, w.deps);
    assert.equal(summary.status, 'finished');
    assert.equal(summary.mode, 'dry');
    assert.equal(summary.recording, null);
    assert.deepEqual(w.runner.methods(), ['app.openURL', 'ui.tap', 'ui.tap', 'ui.tap', 'app.terminate']);
    const record = readTakeRecord(summary.dir!);
    assert.equal(record.mode, 'dry');
    assert.ok(record.scenes.every((s) => s.videoStartMs === null));
  });

  test('--scenes e --until: só o que foi pedido, encerrando limpo (gravação parada, cleanup roda)', async () => {
    const w = world();
    const summary = await takeRun(w.ctx, { file: w.file, until: 's01.cue' }, w.deps);
    assert.equal(summary.status, 'finished');
    assert.deepEqual(w.runner.methods(), ['app.openURL', 'ui.tap', 'app.terminate']);
    assert.deepEqual(w.obs.chapters, ['Abertura', 'meio']);
    const record = readTakeRecord(summary.dir!);
    assert.equal(record.scenes[0]!.truncated, true);
    assert.deepEqual(record.options.until, 's01.cue');

    const w2 = world();
    const s2 = await takeRun(w2.ctx, { file: w2.file, scenes: ['s02'], prepare: false, cleanup: false }, w2.deps);
    assert.equal(s2.status, 'finished');
    assert.deepEqual(w2.runner.methods(), ['ui.tap']);
    assert.deepEqual(w2.obs.chapters, ['Fim']);
    assert.equal(s2.cleanupPending, true, '--no-cleanup deixa a cleanup sem rodar');
  });

  test('--voice: o cue e a duração mínima entram na tomada e no take.json', async () => {
    const w = world();
    const voice = join(w.env.root, 'voice.json');
    writeFileSync(voice, JSON.stringify({ scenes: { s01: [{ text: 'Hello.', durMs: 4_000 }, { text: 'Welcome.', durMs: 2_000 }], s02: [{ text: 'Bye.', durMs: 1_000 }] } }));
    const summary = await takeRun(w.ctx, { file: w.file, voice }, w.deps);
    assert.equal(summary.status, 'finished');
    const record = readTakeRecord(summary.dir!);
    assert.equal(record.options.voice?.gapMs, 250);
    const s01 = record.scenes[0]!;
    assert.equal(s01.narrationMs, 4_000 + 250 + 2_000);
    assert.equal(s01.minDurationMs, 500 + 6_250 + 500);
    assert.ok(s01.endMs! - s01.startMs >= s01.minDurationMs);
    const cue = record.steps.find((s) => s.id === 's01.cue')!;
    assert.equal(cue.cueAtMs, 500 + 4_000 + 250);
    assert.ok(cue.startMs - s01.startMs >= 4_750);
    assert.equal(record.scenes[1]!.minDurationMs, 1_000 + 1_000 + 1_500, 'sem hold na cena: os pads da configuração');
  });

  test('--voice fora do formato → E_CONFIG antes de conectar', async () => {
    const w = world();
    const voice = join(w.env.root, 'voice.json');
    writeFileSync(voice, JSON.stringify({ scenes: { s01: [{ text: 'x' }] } }));
    await rejectsCode(takeRun(w.ctx, { file: w.file, voice }, w.deps), 'E_CONFIG');
    assert.deepEqual(w.runner.calls, []);
  });
});

describe('trava do aparelho e take control', () => {
  test('trava de outra tomada viva → E_BUSY com o takeId; trava de pid morto é trocada com aviso', async () => {
    const w = world();
    const paths = runnerPaths(w.env.config);
    mkdirSync(paths.locks, { recursive: true });
    // Dono vivo, com o takeId na linha de comando (como a tomada faz pelo process.title).
    const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)', '20261016-100000-outra'], { stdio: 'ignore' });
    try {
      writeFileSync(paths.lockFile, JSON.stringify({ takeId: '20261016-100000-outra', pid: holder.pid, startedAt: 'x' }));
      try {
        await takeRun(w.ctx, { file: w.file }, w.deps);
        assert.fail('esperava E_BUSY');
      } catch (error) {
        assert.ok(isContrarregraError(error, 'E_BUSY'));
        assert.equal(error.data?.['takeId'], '20261016-100000-outra');
      }
      assert.deepEqual(w.runner.calls, []);
      assert.equal(readTakeLock(paths), '20261016-100000-outra', 'a trava alheia fica');
    } finally {
      holder.kill();
    }

    // pid vivo, mas a linha de comando não é a da tomada (pid reaproveitado) → sobra, para o leitor e para a tomada.
    writeFileSync(paths.lockFile, JSON.stringify({ takeId: '20261016-100000-reusada', pid: process.pid, startedAt: 'x' }));
    assert.equal(readTakeLock(paths), undefined);
    const reused = await takeRun(w.ctx, { file: w.file, dry: true }, w.deps);
    assert.equal(reused.status, 'finished');
    assert.ok(reused.warnings.some((x) => x.includes('20261016-100000-reusada')));

    writeFileSync(paths.lockFile, JSON.stringify({ takeId: '20261016-100000-morta', pid: 2 ** 22 + 12345, startedAt: 'x' }));
    assert.equal(readTakeLock(paths), undefined, 'trava de pid morto conta como ausente (assertNoTake não recusa)');
    const summary = await takeRun(w.ctx, { file: w.file, dry: true }, w.deps);
    assert.equal(summary.status, 'finished');
    assert.ok(summary.warnings.some((x) => x.includes('20261016-100000-morta')));
    assert.equal(readTakeLock(paths), undefined);
  });

  test('pausa → take control skip (control.json) → a tomada segue; control fora de pausa e depois do fim → E_CHOREO_STATE', async () => {
    const w = world({ handlers: { 'ui.tap': [() => ({}), () => Promise.reject(rpcError('E_TARGET_NOT_HITTABLE')), () => Promise.reject(rpcError('E_TARGET_NOT_HITTABLE')), () => ({})] } });
    let notPaused: unknown;
    let accepted: unknown;
    w.deps.say = (text) => {
      w.said.push(text);
      const dir = join(w.env.takes, 'demo', takeDirs(w)[0]!);
      const record = readTakeRecord(dir);
      assert.ok(record.pause !== null, 'take.json mostra a pausa');
      accepted = takeControl(w.ctx, dir, 'skip');
    };
    w.runner.handlers['app.openURL'] = () => {
      const dir = join(w.env.takes, 'demo', takeDirs(w)[0]!);
      try {
        takeControl(w.ctx, dir, 'resume');
      } catch (error) {
        notPaused = error;
      }
      return {};
    };
    const summary = await takeRun(w.ctx, { file: w.file }, w.deps);
    assert.ok(isContrarregraError(notPaused, 'E_CHOREO_STATE'), 'resume sem pausa é recusado');
    assert.deepEqual((accepted as { op: string }).op, 'skip');
    assert.equal(summary.status, 'finished');
    const record = readTakeRecord(summary.dir!);
    const skipped = record.steps.find((s) => s.id === 's01.cue')!;
    assert.equal(skipped.status, 'skipped');
    assert.deepEqual(skipped.interventions, ['skip']);
    assert.equal(skipped.attempts, 2);
    assert.ok(!existsSync(join(summary.dir!, 'control.json')), 'o comando é apagado depois de lido');
    assert.throws(() => takeControl(w.ctx, summary.dir!, 'abort'), (error: unknown) => isContrarregraError(error, 'E_CHOREO_STATE') && error.message.includes('já terminou'));
  });

  test('take control: a pasta tem de ser <paths.takes>/<app>/<takeId> de uma tomada com trava viva', async () => {
    const w = world();
    let refused: unknown[] = [];
    let viaLink: unknown;
    w.runner.handlers['ui.tap'] = () => {
      const dir = join(w.env.takes, 'demo', takeDirs(w)[0]!);
      const takeId = basename(dir);
      // Cópia da pasta fora de paths.takes, e pasta com outro nome: recusadas.
      const copy = join(w.env.root, 'copia', 'demo', takeId);
      cpSync(dir, copy, { recursive: true });
      const renamed = join(w.env.takes, 'demo', 'outro-nome');
      cpSync(dir, renamed, { recursive: true });
      refused = [copy, renamed].map((d) => {
        try {
          takeControl(w.ctx, d, 'abort');
          return 'aceito';
        } catch (error) {
          return isContrarregraError(error, 'E_CHOREO_STATE') ? 'recusado' : String(error);
        }
      });
      // Um atalho (link) para a pasta certa vale: o caminho real é o dela.
      const link = join(w.env.root, 'atalho');
      symlinkSync(dir, link);
      viaLink = takeControl(w.ctx, link, 'abort').op;
      return {};
    };
    const summary = await takeRun(w.ctx, { file: w.file }, w.deps);
    assert.deepEqual(refused, ['recusado', 'recusado']);
    assert.equal(viaLink, 'abort');
    assert.equal(summary.cause, 'control-abort');
  });

  test('take control abort fora de pausa encerra a tomada no passo seguinte', async () => {
    const w = world();
    w.runner.handlers['ui.tap'] = () => {
      const dir = join(w.env.takes, 'demo', takeDirs(w)[0]!);
      takeControl(w.ctx, dir, 'abort');
      return {};
    };
    const summary = await takeRun(w.ctx, { file: w.file }, w.deps);
    assert.equal(summary.status, 'aborted');
    assert.equal(summary.cause, 'control-abort');
    assert.equal(w.runner.of('ui.tap').length, 1);
    assert.equal(w.obs.recordDirectory, w.obs.originalDirectory);
  });
});

describe('aviso falado (say)', () => {
  test('-- antes do texto; -a só com o dispositivo listado por say -a ?', () => {
    assert.deepEqual(sayArgs('Luciana', '-olhe para o iPhone'), ['-v', 'Luciana', '--', '-olhe para o iPhone']);
    assert.deepEqual(sayArgs('Luciana', 'x', 'MacBook Air Speakers'), ['-v', 'Luciana', '-a', 'MacBook Air Speakers', '--', 'x']);
    assert.deepEqual(parseSayDevices('   79 BlackHole 2ch\n  100 MacBook Air Speakers\n\n'), ['BlackHole 2ch', 'MacBook Air Speakers']);
  });
});

describe('take run e take control na CLI', () => {
  function io() {
    const out: string[] = [];
    const err: string[] = [];
    return { out, err, io: { stdout: (t: string) => void out.push(t), stderr: (t: string) => void err.push(t) } };
  }

  test('--dry --json: 0 e o resumo; linhas por passo no stderr; abortada → 1', async () => {
    const w = world();
    const c = io();
    const code = await main(['take', 'run', w.file, '--dry', '--json', '--no-cleanup', '--scenes', 's01'], { config: { configPath: w.env.configPath }, io: c.io, take: w.deps });
    assert.equal(code, 0, c.err.join(''));
    const summary = JSON.parse(c.out.join('')) as TakeSummary;
    assert.equal(summary.status, 'finished');
    assert.equal(summary.mode, 'dry');
    assert.deepEqual(summary.scenes, { planned: 1, started: 1 });
    const record: TakeRecord = JSON.parse(readFileSync(summary.takeJson!, 'utf8'));
    assert.deepEqual(record.options.scenes, ['s01']);
    assert.equal(record.options.cleanup, false);
    assert.match(c.err.join(''), /\[s01 1\/3 s01\.play\] tap "Play" ok/);

    const w2 = world({ handlers: { 'ui.tap': [() => ({}), () => ({}), () => Promise.reject(rpcError('E_TARGET_NOT_HITTABLE'))] } });
    const c2 = io();
    assert.equal(await main(['take', 'run', w2.file, '--dry'], { config: { configPath: w2.env.configPath }, io: c2.io, take: w2.deps }), 1);
    assert.match(c2.out.join(''), /take run: aborted \(step-failed\)/);
  });

  test('take control sem take.json → E_CHOREO_STATE (código 1)', async () => {
    const w = world();
    const c = io();
    assert.equal(await main(['take', 'control', w.env.root, 'resume', '--json'], { config: { configPath: w.env.configPath }, io: c.io }), 1);
    assert.equal((JSON.parse(c.out.join('')) as { error: { code: string } }).error.code, 'E_CHOREO_STATE');
  });
});
