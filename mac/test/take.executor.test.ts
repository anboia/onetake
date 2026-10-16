// Testes da M3 (trilha do demo): o executor passo a passo do Mac — passo → método do runner, espera do alvo,
// `E_TIMEOUT` rodando/na fila, `optional`, `onFail` com `control.json`, pontos de controle (aviso repetido,
// prazo), `block`, `cue` e duração mínima da cena com `--voice`, proibições em `scenes`, `--scenes/--from/
// --until`. Runner, relógio, aviso falado e `control.json` são falsos (`helpers/take-fakes.ts`).

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { ContrarregraError, isContrarregraError } from '../src/core/errors.ts';
import type { Choreography, Scene, Step } from '../src/core/types.ts';
import { checkTakeChoreography } from '../src/take/choreo.ts';
import {
  ALERT_REPEAT_MS,
  CHECKPOINT_SLICE_MS,
  DRAG_HOLD_MS,
  DRAG_PRESS_MS,
  LATE_EXPECT_TIMEOUT_MS,
  PAUSE_MAX_MS,
  planScenes,
  RPC_SLACK_MS,
  RUNNER_COMMAND_MS,
  TakeAborted,
  TakeExecutor,
  type TakeRecorder,
} from '../src/take/executor.ts';
import type { TakeRecord } from '../src/take/manifest.ts';
import type { VoicePlan } from '../src/take/voice.ts';
import {
  choreography,
  FakeClock,
  FakeControl,
  FakeRunner,
  newRecord,
  rpcError,
  waitTimesOut,
  waitTrueAfter,
  type RunnerHandler,
} from './helpers/take-fakes.ts';

interface Harness {
  clock: FakeClock;
  runner: FakeRunner;
  control: FakeControl;
  record: TakeRecord;
  executor: TakeExecutor;
  said: { at: number; text: string }[];
  lines: string[];
  doc: Choreography;
  t0: number;
}

interface HarnessOptions {
  handlers?: (clock: FakeClock) => Record<string, RunnerHandler | RunnerHandler[]>;
  voice?: VoicePlan | null;
  pads?: { padBeforeMs: number; padAfterMs: number };
  onSay?: (h: Harness, text: string) => void;
  recorder?: TakeRecorder;
  /** Sem validar (para provar as recusas do próprio executor). */
  raw?: boolean;
}

function harness(parts: Partial<Choreography>, options: HarnessOptions = {}): Harness {
  const base = choreography(parts);
  let doc = base;
  if (options.raw !== true) {
    const checked = checkTakeChoreography(base);
    assert.deepEqual(checked.errors, [], 'a coreografia do teste tem de ser válida');
    doc = checked.doc!;
  }
  const clock = new FakeClock();
  const runner = new FakeRunner(clock, options.handlers?.(clock) ?? {});
  const control = new FakeControl();
  const record = newRecord(doc);
  const said: { at: number; text: string }[] = [];
  const lines: string[] = [];
  const h = { clock, runner, control, record, said, lines, doc, t0: clock.now() } as Harness;
  h.executor = new TakeExecutor({
    doc,
    record,
    runner,
    clock,
    say: (text) => {
      said.push({ at: clock.now(), text });
      options.onSay?.(h, text);
    },
    log: (line) => lines.push(line),
    control,
    persist: () => {},
    voice: options.voice ?? null,
    pads: options.pads ?? { padBeforeMs: 0, padAfterMs: 0 },
    controlHint: 'contrarregra take control /tmp/tomada',
  });
  if (options.recorder !== undefined) h.executor.setRecorder(options.recorder);
  return h;
}

function oneScene(steps: Step[], extra: Partial<Scene> = {}): Partial<Choreography> {
  return { scenes: [{ id: 's01', title: 'Cena um', line: ['Uma.', 'Duas.', 'Três.'], steps, ...extra }] };
}

async function runAll(h: Harness): Promise<void> {
  await h.executor.runSection('prepare', h.doc.prepare);
  await h.executor.runScenes(planScenes(h.doc));
  await h.executor.runSection('cleanup', h.doc.cleanup);
}

async function rejectsAborted(promise: Promise<unknown>, reason: string): Promise<TakeAborted> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof TakeAborted, `esperava TakeAborted, veio ${String(error)}`);
    assert.equal(error.reason, reason);
    return error;
  }
  return assert.fail('esperava TakeAborted');
}

const A = { label: 'A', type: 'button' } as const;
const B = { label: 'B' } as const;

describe('passo → método do runner (S0.5, S1 item 4)', () => {
  test('cada ação vai ao método certo com os parâmetros e prazos de RPC folgados', async () => {
    const h = harness({
      prepare: [{ do: 'openURL', url: 'demo://start' }],
      ...oneScene([
        { do: 'tap', target: A },
        { do: 'doubleTap', target: B },
        { do: 'longPress', target: A, durationMs: 800 },
        { do: 'drag', from: { nx: 0.5, ny: 0.6 }, to: { x: 195, y: 300 }, velocity: 600 },
        { do: 'drag', from: A, to: B, via: [{ x: 1, y: 1 }], pressMs: 40, durationMs: 500, holdMs: 400 },
        { do: 'scrollTo', target: A, within: B, direction: 'down', maxSwipes: 6 },
        { do: 'type', target: { type: 'searchField' }, text: 'Psalm 23' },
        { do: 'lock' },
        { do: 'wake' },
        { do: 'home' },
        { do: 'controlCenter', action: 'open' },
        { do: 'app', action: 'activate' },
        { do: 'app', action: 'terminate' },
      ]),
      cleanup: [{ do: 'openURL', url: 'demo://end' }],
    });
    await runAll(h);
    const calls = h.runner.calls.map((c) => [c.method, c.params]);
    assert.deepEqual(calls, [
      ['app.openURL', { url: 'demo://start' }],
      ['ui.tap', { target: A }],
      ['ui.doubleTap', { target: B }],
      ['ui.longPress', { target: A, durationMs: 800 }],
      ['ui.drag', { from: { nx: 0.5, ny: 0.6 }, to: { x: 195, y: 300 }, pressMs: DRAG_PRESS_MS, holdMs: DRAG_HOLD_MS, velocity: 600 }],
      ['ui.drag', { from: A, to: B, via: [{ x: 1, y: 1 }], pressMs: 40, holdMs: 400, durationMs: 500 }],
      ['ui.scrollTo', { target: A, within: B, direction: 'down', maxSwipes: 6 }],
      ['ui.type', { target: { type: 'searchField' }, text: 'Psalm 23' }],
      ['device.lock', {}],
      ['device.wake', {}],
      ['device.home', {}],
      ['device.controlCenter', { action: 'open' }],
      ['app.activate', { bundleId: 'app.example.demo' }],
      ['app.terminate', { bundleId: 'app.example.demo' }],
      ['app.openURL', { url: 'demo://end' }],
    ]);
    for (const c of h.runner.calls) assert.equal(c.timeoutMs, RUNNER_COMMAND_MS + RPC_SLACK_MS, c.method);
    assert.ok(h.record.steps.every((s) => s.status === 'ok' && s.attempts === 1));
    assert.equal(h.record.steps.length, 15);
    assert.match(h.lines.find((l) => l.startsWith('[s01 1/13]'))!, /^\[s01 1\/13\] tap "A" ok 0\.0s$/);
  });

  test('wait, waitFor e assert: wait não chama o runner; waitFor 3000 ms e assert 0 ms por padrão (S0.4)', async () => {
    const h = harness(oneScene([{ do: 'wait', ms: 1_000 }, { do: 'waitFor', condition: { locked: false } }, { do: 'assert', condition: { network: 'online' } }, { do: 'assert', condition: { locked: true }, timeoutMs: 500, onFail: 'continue' }]), {
      handlers: (clock) => ({ 'wait.for': [() => ({}), () => ({}), waitTimesOut(clock)] }),
    });
    await runAll(h);
    const [wait, waitFor, assertOk, assertKo] = h.record.steps;
    assert.equal(wait!.startMs - h.t0, 300, 'afterMs 300 desde o início da cena');
    assert.equal(wait!.durationMs, 1_000);
    assert.deepEqual(
      h.runner.calls.map((c) => [c.params['timeoutMs'], c.timeoutMs]),
      [
        [3_000, 3_000 + 1_000 + RPC_SLACK_MS],
        [0, 1_000 + RPC_SLACK_MS],
        [500, 500 + 1_000 + RPC_SLACK_MS],
      ],
    );
    assert.equal(waitFor!.status, 'ok');
    assert.equal(assertOk!.status, 'ok');
    assert.equal(assertKo!.status, 'failed');
    assert.equal(assertKo!.error?.code, 'E_TIMEOUT');
  });

  test('mark e cena viram capítulos; o tempo do vídeo fica em cada passo; capítulo recusado só avisa', async () => {
    const chapters: string[] = [];
    let video = 0;
    const recorder: TakeRecorder = {
      outputMs: async () => (video += 100),
      chapter: async (name) => {
        if (name === 'ruim') throw new Error('702');
        chapters.push(name);
      },
    };
    const h = harness(oneScene([{ do: 'mark', label: 'marca' }, { do: 'mark', label: 'ruim' }, { do: 'tap', target: A }]), { recorder });
    await runAll(h);
    assert.deepEqual(chapters, ['Cena um', 'marca']);
    assert.equal(h.record.scenes[0]!.videoStartMs, 100);
    assert.ok(h.record.steps.every((s) => typeof s.videoMs === 'number' && s.status === 'ok'));
    assert.equal(h.record.warnings.length, 1);
    assert.match(h.record.warnings[0]!, /capítulo "ruim"/);
  });
});

describe('espera do alvo e nova tentativa (S0.4)', () => {
  test('E_TARGET_NOT_FOUND → wait.for {element: alvo, state: exists} até timeoutMs → uma nova tentativa', async () => {
    const h = harness(oneScene([{ do: 'tap', target: A, timeoutMs: 4_000 }]), {
      handlers: (clock) => ({
        'ui.tap': [() => Promise.reject(rpcError('E_TARGET_NOT_FOUND')), () => ({})],
        'wait.for': waitTrueAfter(clock, 1_500),
      }),
    });
    await runAll(h);
    assert.deepEqual(h.runner.methods(), ['ui.tap', 'wait.for', 'ui.tap']);
    assert.deepEqual(h.runner.of('wait.for')[0]!.params, { condition: { element: A, state: 'exists' }, timeoutMs: 4_000 });
    const step = h.record.steps[0]!;
    assert.equal(step.status, 'ok');
    assert.equal(step.attempts, 1);
    assert.equal(step.durationMs, 1_500);
  });

  test('o alvo não aparece: optional → skipped sem pausa; sem optional e onFail continue → failed', async () => {
    const h = harness(oneScene([{ do: 'tap', target: A, optional: true, timeoutMs: 6_000 }, { do: 'tap', target: B, onFail: 'continue' }]), {
      handlers: (clock) => ({ 'ui.tap': () => Promise.reject(rpcError('E_TARGET_NOT_FOUND')), 'wait.for': waitTimesOut(clock) }),
    });
    await runAll(h);
    const [optional, required] = h.record.steps;
    assert.equal(optional!.status, 'skipped');
    assert.equal(optional!.durationMs, 6_000);
    assert.equal(required!.status, 'failed');
    assert.equal(required!.error?.code, 'E_TARGET_NOT_FOUND');
    assert.deepEqual(h.said, []);
    assert.deepEqual(h.runner.methods(), ['ui.tap', 'wait.for', 'ui.tap', 'wait.for']);
  });

  test('drag espera o primeiro alvo que não é ponto', async () => {
    const h = harness(oneScene([{ do: 'drag', from: { x: 1, y: 1 }, to: B, durationMs: 300 }]), {
      handlers: () => ({ 'ui.drag': [() => Promise.reject(rpcError('E_TARGET_NOT_FOUND')), () => ({})] }),
    });
    await runAll(h);
    assert.deepEqual(h.runner.of('wait.for')[0]!.params['condition'], { element: B, state: 'exists' });
  });
});

describe('E_TIMEOUT do runner (SP-2: running = a ação ainda vai acontecer)', () => {
  const running = (): Promise<never> => Promise.reject(rpcError('E_TIMEOUT', { method: 'ui.tap', deadlineMs: 10_000, phase: 'running' }));
  const queued = (): Promise<never> => Promise.reject(rpcError('E_TIMEOUT', { method: 'ui.tap', deadlineMs: 10_000, phase: 'queued' }));

  test('running com expect: nunca repete; o expect espera até 120 s', async () => {
    const h = harness(oneScene([{ do: 'tap', target: A, expect: { element: B, state: 'exists' } }]), {
      handlers: (clock) => ({ 'ui.tap': running, 'wait.for': waitTrueAfter(clock, 70_000) }),
    });
    await runAll(h);
    assert.deepEqual(h.runner.methods(), ['ui.tap', 'wait.for']);
    assert.equal(h.runner.of('wait.for')[0]!.params['timeoutMs'], LATE_EXPECT_TIMEOUT_MS);
    const step = h.record.steps[0]!;
    assert.equal(step.status, 'ok');
    assert.equal(step.late, true);
    assert.equal(step.attempts, 1);
  });

  test('running sem expect: espera a fila do XCTest esvaziar (health) e segue sem repetir', async () => {
    const h = harness(oneScene([{ do: 'controlCenter', action: 'open' }]), {
      handlers: () => ({
        'device.controlCenter': () => Promise.reject(rpcError('E_TIMEOUT', { phase: 'running' })),
        health: [() => ({ ok: true, xctestQueueDepth: 1 }), () => ({ ok: true, xctestQueueDepth: 1 }), () => ({ ok: true, xctestQueueDepth: 0 })],
      }),
    });
    await runAll(h);
    assert.deepEqual(h.runner.methods(), ['device.controlCenter']);
    assert.equal(h.runner.of('health').length, 3);
    assert.equal(h.record.steps[0]!.status, 'ok');
    assert.equal(h.record.steps[0]!.late, true);
  });

  test('sem resposta do runner (prazo do Mac) conta como running: não repete', async () => {
    const h = harness(oneScene([{ do: 'tap', target: A, expect: { element: B, state: 'exists' } }]), {
      handlers: () => ({ 'ui.tap': () => Promise.reject(new ContrarregraError('E_TIMEOUT', 'ui.tap: sem resposta', { method: 'ui.tap', timeoutMs: 20_000 })) }),
    });
    await runAll(h);
    assert.deepEqual(h.runner.methods(), ['ui.tap', 'wait.for']);
    assert.equal(h.runner.of('wait.for')[0]!.params['timeoutMs'], LATE_EXPECT_TIMEOUT_MS);
  });

  test('running e o expect não confirma (onFail pause): pausa sem nova tentativa automática', async () => {
    const h = harness(oneScene([{ do: 'tap', target: A, expect: { element: B, state: 'exists' } }]), {
      handlers: (clock) => ({ 'ui.tap': running, 'wait.for': waitTimesOut(clock) }),
      onSay: (x) => {
        x.control.op = 'skip';
      },
    });
    await runAll(h);
    assert.deepEqual(h.runner.methods(), ['ui.tap', 'wait.for']);
    assert.equal(h.said.length, 1);
    const step = h.record.steps[0]!;
    assert.equal(step.status, 'skipped');
    assert.deepEqual(step.interventions, ['skip']);
  });

  test('queued: não rodou → espera a fila e tenta de novo (pause faz a nova tentativa automática)', async () => {
    const h = harness(oneScene([{ do: 'tap', target: A }]), { handlers: () => ({ 'ui.tap': [queued, () => ({})] }) });
    await runAll(h);
    assert.deepEqual(h.runner.methods(), ['ui.tap', 'ui.tap']);
    assert.equal(h.runner.of('health').length, 1, 'esperou a fila antes de repetir');
    assert.equal(h.record.steps[0]!.status, 'ok');
    assert.equal(h.record.steps[0]!.attempts, 2);
  });
});

describe('onFail e a pausa com control.json', () => {
  const notHittable = (): Promise<never> => Promise.reject(rpcError('E_TARGET_NOT_HITTABLE'));

  test('pause: uma nova tentativa automática, depois pausa (aviso no Mac); retry refaz o passo', async () => {
    const h = harness(oneScene([{ id: 's01.a', do: 'tap', target: A }]), {
      handlers: () => ({ 'ui.tap': [notHittable, notHittable, () => ({})] }),
      onSay: (x) => {
        assert.ok(x.record.pause !== null, 'take.json mostra a pausa');
        assert.equal(x.record.pause!.stepId, 's01.a');
        x.control.op = 'retry';
      },
    });
    await runAll(h);
    assert.equal(h.runner.of('ui.tap').length, 3);
    assert.equal(h.said.length, 1);
    assert.match(h.said[0]!.text, /pausada no passo s01\.a/);
    const step = h.record.steps[0]!;
    assert.equal(step.status, 'ok');
    assert.equal(step.attempts, 3);
    assert.deepEqual(step.interventions, ['retry']);
    assert.equal(h.record.pause, null);
    assert.ok(h.lines.some((l) => l.includes('contrarregra take control /tmp/tomada resume|retry|skip|abort')));
  });

  test('resume segue como sucesso; skip pula; continue não pausa', async () => {
    for (const [op, status] of [['resume', 'ok'], ['skip', 'skipped']] as const) {
      const h = harness(oneScene([{ do: 'tap', target: A }, { do: 'tap', target: B }]), {
        handlers: () => ({ 'ui.tap': [notHittable, notHittable, () => ({})] }),
        onSay: (x) => {
          x.control.op = op;
        },
      });
      await runAll(h);
      assert.equal(h.record.steps[0]!.status, status, op);
      assert.equal(h.record.steps[1]!.status, 'ok', 'o passo seguinte roda');
    }
    const h = harness(oneScene([{ do: 'tap', target: A, onFail: 'continue' }, { do: 'tap', target: B }]), { handlers: () => ({ 'ui.tap': [notHittable, () => ({})] }) });
    await runAll(h);
    assert.deepEqual(h.record.steps.map((s) => s.status), ['failed', 'ok']);
    assert.equal(h.runner.of('ui.tap').length, 2, 'continue não tenta de novo');
  });

  test('abort pela pausa, onFail: abort e prazo de 10 min encerram a tomada', async () => {
    const h1 = harness(oneScene([{ do: 'tap', target: A }, { do: 'tap', target: B }]), {
      handlers: () => ({ 'ui.tap': notHittable }),
      onSay: (x) => {
        x.control.op = 'abort';
      },
    });
    await rejectsAborted(runAll(h1), 'control-abort');
    assert.equal(h1.record.steps.length, 1, 'nenhum passo novo depois do abort');
    assert.equal(h1.record.steps[0]!.status, 'failed');

    const h2 = harness(oneScene([{ do: 'tap', target: A, onFail: 'abort' }, { do: 'tap', target: B }]), { handlers: () => ({ 'ui.tap': notHittable }) });
    await rejectsAborted(runAll(h2), 'step-failed');
    assert.equal(h2.runner.of('ui.tap').length, 1);

    const h3 = harness(oneScene([{ do: 'tap', target: A }]), { handlers: () => ({ 'ui.tap': notHittable }) });
    const started = h3.clock.now();
    await rejectsAborted(runAll(h3), 'pause-timeout');
    assert.ok(h3.clock.now() - started >= PAUSE_MAX_MS);
    assert.equal(h3.record.pause, null);
  });

  test('take control abort fora de pausa vale no meio de uma espera e no começo do passo seguinte', async () => {
    const h = harness(oneScene([{ do: 'tap', target: A }, { do: 'wait', ms: 60_000 }, { do: 'tap', target: B }]));
    h.control.schedule(h.clock, h.t0 + 10_000, 'abort');
    await rejectsAborted(runAll(h), 'control-abort');
    assert.equal(h.runner.of('ui.tap').length, 1);
    const wait = h.record.steps[1]!;
    assert.equal(wait.status, 'failed');
    assert.ok(wait.endMs! - h.t0 >= 10_000 && wait.endMs! - h.t0 <= 10_000 + 250 + 100, String(wait.endMs! - h.t0));
    assert.equal(h.control.op, undefined, 'o comando é consumido');

    const h2 = harness(oneScene([{ do: 'tap', target: A }, { do: 'tap', target: B }]));
    h2.runner.handlers['ui.tap'] = () => {
      h2.control.op = 'abort';
      return {};
    };
    await rejectsAborted(runAll(h2), 'control-abort');
    assert.equal(h2.runner.of('ui.tap').length, 1);
  });

  test('abort() (SIGINT) corta uma chamada em curso na hora', async () => {
    const h = harness(oneScene([{ do: 'waitFor', condition: { locked: false }, timeoutMs: 90_000 }]), {
      handlers: () => ({ 'wait.for': () => new Promise(() => {}) }),
    });
    const run = runAll(h);
    await new Promise((resolve) => setTimeout(resolve, 20));
    h.executor.abort('SIGINT', 'interrompida');
    await rejectsAborted(run, 'SIGINT');
    assert.equal(h.record.steps[0]!.status, 'failed');
    assert.equal(h.record.scenes[0]!.truncated, true);
  });
});

describe('nova tentativa automática só antes da ação (revisão: nunca repetir o que pode ter rodado)', () => {
  const reject = (code: Parameters<typeof rpcError>[0]) => (): Promise<never> => Promise.reject(rpcError(code));

  test('E_XCTEST e E_APP_STATE (o evento pode já ter saído) vão direto à pausa, sem repetir', async () => {
    for (const code of ['E_XCTEST', 'E_APP_STATE'] as const) {
      const h = harness(oneScene([{ do: 'tap', target: A }]), { handlers: () => ({ 'ui.tap': reject(code) }), onSay: (x) => void (x.control.op = 'skip') });
      await runAll(h);
      assert.equal(h.runner.of('ui.tap').length, 1, code);
      assert.equal(h.said.length, 1, code);
      assert.equal(h.record.steps[0]!.attempts, 1);
      assert.equal(h.record.steps[0]!.status, 'skipped');
    }
  });

  test('expect falso, ou a leitura dele falhando, depois de a ação dar certo: sem nova tentativa', async () => {
    for (const expectHandler of [waitTimesOut, () => () => Promise.reject(rpcError('E_FORBIDDEN_APP'))] as const) {
      const h = harness(oneScene([{ do: 'tap', target: A, expect: { element: B, state: 'exists' } }]), {
        handlers: (clock) => ({ 'wait.for': expectHandler(clock) }),
        onSay: (x) => void (x.control.op = 'skip'),
      });
      await runAll(h);
      assert.deepEqual(h.runner.methods(), ['ui.tap', 'wait.for']);
      assert.equal(h.record.steps[0]!.status, 'skipped');
    }
  });

  test('scrollTo que esgotou os arrastos (NOT_FOUND/NOT_HITTABLE): nem espera do alvo nem nova tentativa; optional → skipped', async () => {
    for (const code of ['E_TARGET_NOT_FOUND', 'E_TARGET_NOT_HITTABLE'] as const) {
      const h = harness(oneScene([{ do: 'scrollTo', target: A, direction: 'down', maxSwipes: 6 }, { do: 'scrollTo', target: B, direction: 'down', maxSwipes: 6, optional: true }]), {
        handlers: () => ({ 'ui.scrollTo': reject(code) }),
        onSay: (x) => void (x.control.op = 'skip'),
      });
      await runAll(h);
      assert.deepEqual(h.runner.methods(), ['ui.scrollTo', 'ui.scrollTo'], code);
      assert.deepEqual(h.record.steps.map((x) => x.status), ['skipped', 'skipped']);
      assert.equal(h.said.length, 1, 'o primeiro pausou; o optional não');
    }
  });

  test('E_TARGET_AMBIGUOUS, E_BUSY e E_RUNNER_DOWN reconectando (antes da ação): uma nova tentativa automática', async () => {
    for (const error of [rpcError('E_TARGET_AMBIGUOUS'), rpcError('E_BUSY'), rpcError('E_RUNNER_DOWN', { reason: 'reconnecting' })]) {
      const h = harness(oneScene([{ do: 'tap', target: A }]), { handlers: () => ({ 'ui.tap': [() => Promise.reject(error), () => ({})] }) });
      await runAll(h);
      assert.equal(h.runner.of('ui.tap').length, 2, error.code);
      assert.equal(h.record.steps[0]!.status, 'ok');
    }
  });

  test('waitFor que não ficou verdadeira não repete sozinha', async () => {
    const h = harness(oneScene([{ do: 'waitFor', condition: { locked: false }, timeoutMs: 1_000 }]), {
      handlers: (clock) => ({ 'wait.for': waitTimesOut(clock) }),
      onSay: (x) => void (x.control.op = 'skip'),
    });
    await runAll(h);
    assert.equal(h.runner.of('wait.for').length, 1);
  });

  test('take control abort gravado durante a falha vale antes da nova tentativa e antes da pausa', async () => {
    const h1 = harness(oneScene([{ do: 'tap', target: A }]));
    h1.runner.handlers['ui.tap'] = () => {
      h1.control.op = 'abort';
      return Promise.reject(rpcError('E_TARGET_NOT_HITTABLE'));
    };
    await rejectsAborted(runAll(h1), 'control-abort');
    assert.equal(h1.runner.of('ui.tap').length, 1, 'sem nova tentativa');

    const h2 = harness(oneScene([{ do: 'tap', target: A }]));
    h2.runner.handlers['ui.tap'] = () => {
      h2.control.op = 'abort';
      return Promise.reject(rpcError('E_XCTEST'));
    };
    await rejectsAborted(runAll(h2), 'control-abort');
    assert.deepEqual(h2.said, [], 'o abort não se perde no clear da pausa');
  });
});

describe('modo avião possivelmente ligado (S4 item 6)', () => {
  test('toque no airplane-mode-button ou {network: offline}/{airplane: on} sem o desligar → airplaneMaybeOn', async () => {
    const tapAirplane: Step = { do: 'tap', target: { identifier: 'airplane-mode-button' } };
    const h1 = harness(oneScene([tapAirplane]));
    await runAll(h1);
    assert.equal(h1.executor.airplaneMaybeOn, true);

    const h2 = harness(oneScene([tapAirplane, { do: 'waitFor', condition: { all: [{ airplane: 'off' }, { locked: false }] } }]));
    await runAll(h2);
    assert.equal(h2.executor.airplaneMaybeOn, false, '{airplane: off} confirmado desliga');

    const h3 = harness(oneScene([tapAirplane, tapAirplane]));
    await runAll(h3);
    assert.equal(h3.executor.airplaneMaybeOn, false, 'o segundo toque é o desligar');

    const h4 = harness(oneScene([{ id: 'cp', do: 'checkpoint', who: 'human', ask: 'ligue o modo avião', until: { network: 'offline' }, timeoutMs: 1_000, onTimeout: 'abort' } as Step]));
    await runAll(h4);
    assert.equal(h4.executor.airplaneMaybeOn, true);

    const h5 = harness(oneScene([{ do: 'waitFor', condition: { not: { airplane: 'on' } } }, { do: 'waitFor', condition: { any: [{ airplane: 'on' }, { locked: true }] } }]));
    await runAll(h5);
    assert.equal(h5.executor.airplaneMaybeOn, false, 'not/any não dizem qual folha valeu');
  });
});

describe('proibições na tomada (S1 item 9, P-3, P-4)', () => {
  test('openURL, app launch e press em scenes → E_FORBIDDEN_IN_TAKE sem chamar o runner; type com e-mail → E_SECURE_FIELD', async () => {
    const h = harness(
      {
        prepare: [{ do: 'type', text: 'dono@icloud.com', onFail: 'continue' }],
        ...oneScene([
          { do: 'openURL', url: 'demo://x', onFail: 'continue' },
          { do: 'app', action: 'launch', onFail: 'continue' },
          { do: 'press', button: 'volumeUp', onFail: 'continue' },
          { do: 'type', target: { type: 'secureTextField' }, text: 'x', onFail: 'continue' },
        ]),
      },
      { raw: true },
    );
    await runAll(h);
    assert.deepEqual(h.runner.methods(), []);
    assert.deepEqual(
      h.record.steps.map((s) => s.error?.code),
      ['E_SECURE_FIELD', 'E_FORBIDDEN_IN_TAKE', 'E_FORBIDDEN_IN_TAKE', 'E_FORBIDDEN_IN_TAKE', 'E_SECURE_FIELD'],
    );
  });

  test('proibido não tem nova tentativa automática: pausa direto', async () => {
    const h = harness(oneScene([{ do: 'openURL', url: 'demo://x' }]), { raw: true, onSay: (x) => void (x.control.op = 'skip') });
    await runAll(h);
    assert.equal(h.record.steps[0]!.attempts, 1);
    assert.equal(h.record.steps[0]!.status, 'skipped');
  });
});

describe('pontos de controle (S5)', () => {
  const until = { element: { labelPrefix: 'Signed in' }, state: 'exists' } as const;
  const cp = (extra: Record<string, unknown> = {}): Step =>
    ({ id: 's01.cp', do: 'checkpoint', who: 'human', ask: 'Face ID: olhe para o iPhone.', until, timeoutMs: 90_000, onTimeout: 'pause', ...extra }) as Step;

  test('condição já verdadeira: nenhum aviso, waitedMs 0, uma avaliação só (timeoutMs 0)', async () => {
    const h = harness(oneScene([cp()]));
    await runAll(h);
    assert.deepEqual(h.said, []);
    assert.deepEqual(h.runner.of('wait.for').map((c) => c.params['timeoutMs']), [0]);
    assert.equal(h.record.steps[0]!.waitedMs, 0);
  });

  test('humano: aviso na chegada e a cada 20 s, sondagem em fatias de ≤ 20 s, waitedMs', async () => {
    const h = harness(oneScene([cp()]), { handlers: (clock) => ({ 'wait.for': waitTrueAfter(clock, 45_000) }) });
    await runAll(h);
    const arrival = h.record.steps[0]!.startMs;
    assert.deepEqual(h.said.map((s) => s.at - arrival), [0, ALERT_REPEAT_MS, 2 * ALERT_REPEAT_MS]);
    assert.ok(h.said.every((s) => s.text === 'Face ID: olhe para o iPhone.'));
    assert.ok(h.runner.of('wait.for').every((c) => Number(c.params['timeoutMs']) <= CHECKPOINT_SLICE_MS));
    const step = h.record.steps[0]!;
    assert.equal(step.status, 'ok');
    assert.equal(step.waitedMs, 45_000);
    assert.equal(step.alerts, 3);
  });

  test('prazo estourado: onTimeout abort encerra; onTimeout pause pausa (resume = resolvido)', async () => {
    const h1 = harness(oneScene([cp({ timeoutMs: 50_000, onTimeout: 'abort' }), { do: 'tap', target: A }]), { handlers: (clock) => ({ 'wait.for': waitTimesOut(clock) }) });
    await rejectsAborted(runAll(h1), 'step-failed');
    assert.equal(h1.said.length, 3, 'avisos em 0, 20 e 40 s');
    assert.equal(h1.record.steps[0]!.waitedMs, 50_000);
    assert.equal(h1.runner.of('ui.tap').length, 0);

    const h2 = harness(oneScene([cp({ timeoutMs: 30_000 }), { do: 'tap', target: A }]), {
      handlers: (clock) => ({ 'wait.for': waitTimesOut(clock) }),
      onSay: (x, text) => {
        if (text.startsWith('Tomada pausada')) x.control.op = 'resume';
      },
    });
    await runAll(h2);
    assert.equal(h2.record.steps[0]!.status, 'ok');
    assert.deepEqual(h2.record.steps[0]!.interventions, ['resume']);
    assert.equal(h2.record.steps[0]!.attempts, 1, 'ponto de controle não tem nova tentativa automática');
    assert.equal(h2.record.steps[1]!.status, 'ok');
  });

  test('who: runner roda os passos e espera until, sem aviso (AC-5.7)', async () => {
    const h = harness(
      oneScene([
        {
          id: 's01.air',
          do: 'checkpoint',
          who: 'runner',
          ask: 'modo avião',
          until: { network: 'offline' },
          timeoutMs: 60_000,
          onTimeout: 'pause',
          steps: [{ do: 'controlCenter', action: 'open' }, { do: 'tap', target: { identifier: 'airplane-mode-button' } }, { do: 'wait', ms: 2_000 }, { do: 'controlCenter', action: 'close' }],
        } as Step,
      ]),
      { handlers: (clock) => ({ 'wait.for': waitTrueAfter(clock, 5_000) }) },
    );
    await runAll(h);
    assert.deepEqual(h.runner.methods(), ['device.controlCenter', 'ui.tap', 'device.controlCenter', 'wait.for', 'wait.for']);
    assert.deepEqual(h.said, []);
    assert.deepEqual(h.record.steps.map((s) => s.index), ['1', '1.1', '1.2', '1.3', '1.4']);
    assert.ok(h.record.steps.every((s) => s.status === 'ok'));
  });
});

describe('block (S0.4)', () => {
  test('when falsa (avaliada uma vez): o bloco fica skipped e nada dentro roda (AC-4.9); verdadeira: roda', async () => {
    const h = harness(
      oneScene([
        { do: 'block', when: { locked: true }, steps: [{ do: 'tap', target: A }, { id: 'cp', do: 'checkpoint', who: 'human', ask: 'x', until: { locked: false }, timeoutMs: 1_000, onTimeout: 'abort' } as Step] },
        { do: 'block', when: { locked: false }, steps: [{ do: 'tap', target: B }] },
      ]),
      { handlers: (clock) => ({ 'wait.for': [waitTimesOut(clock), () => ({})] }) },
    );
    await runAll(h);
    assert.deepEqual(h.runner.of('wait.for').map((c) => c.params['timeoutMs']), [0, 0]);
    assert.deepEqual(h.runner.of('ui.tap').map((c) => c.params['target']), [B]);
    assert.deepEqual(h.record.steps.map((s) => [s.index, s.status]), [['1', 'skipped'], ['2', 'ok'], ['2.1', 'ok']]);
    assert.deepEqual(h.said, []);
  });
});

describe('cue e duração mínima da cena (--voice)', () => {
  const voice: VoicePlan = {
    path: '/tmp/voice.json',
    sha256: '0'.repeat(64),
    gapMs: 250,
    scenes: { s01: [{ text: 'Uma.', durMs: 2_000 }, { text: 'Duas.', durMs: 3_000 }, { text: 'Três.', durMs: 1_000 }] },
  };
  const pads = { padBeforeMs: 1_000, padAfterMs: 1_500 };

  test('o passo com cue não começa antes da frase; a cena dura padBefore + narração + padAfter', async () => {
    const h = harness(oneScene([{ do: 'tap', target: A }, { do: 'tap', target: B, cue: 1 }, { do: 'tap', target: A, cue: 2 }]), { voice, pads });
    await runAll(h);
    const scene = h.record.scenes[0]!;
    const narration = 2_000 + 250 + 3_000 + 250 + 1_000;
    assert.equal(scene.narrationMs, narration);
    assert.equal(scene.minDurationMs, 1_000 + narration + 1_500);
    assert.equal(scene.endMs! - scene.startMs, scene.minDurationMs);
    const [first, second, third] = h.record.steps;
    assert.equal(first!.startMs - scene.startMs, 1_000, 'espera padBeforeMs');
    assert.equal(second!.cueAtMs, 1_000 + 2_000 + 250);
    assert.equal(second!.startMs - scene.startMs, 3_250);
    assert.equal(third!.cueAtMs, 1_000 + 2_000 + 250 + 3_000 + 250);
    assert.equal(third!.startMs - scene.startMs, 6_500);
  });

  test('hold segura até a duração mínima; passos longos passam dela sem corte', async () => {
    const h = harness(oneScene([{ do: 'hold' }, { do: 'wait', ms: 1_000 }]), { voice, pads });
    await runAll(h);
    const scene = h.record.scenes[0]!;
    const hold = h.record.steps[0]!;
    assert.equal(hold.endMs! - scene.startMs, scene.minDurationMs);
    assert.equal(scene.endMs! - scene.startMs, scene.minDurationMs + 300 + 1_000);
  });

  test('sem --voice o cue é ignorado e a cena dura padBefore + padAfter', async () => {
    const h = harness(oneScene([{ do: 'tap', target: B, cue: 2 }]), { pads });
    await runAll(h);
    const scene = h.record.scenes[0]!;
    assert.equal(scene.minDurationMs, 2_500);
    assert.equal(h.record.steps[0]!.startMs - scene.startMs, 1_000);
    assert.equal(h.record.steps[0]!.cueAtMs, undefined);
    assert.equal(scene.endMs! - scene.startMs, 2_500);
  });
});

describe('--scenes, --from e --until (planScenes)', () => {
  const doc = choreography({
    scenes: [
      { id: 's01', title: 'Um', steps: [{ id: 'a1', do: 'wait', ms: 1 }, { id: 'a2', do: 'wait', ms: 1 }] },
      { id: 's02', title: 'Dois', steps: [{ id: 'b1', do: 'wait', ms: 1 }, { id: 'b2', do: 'wait', ms: 1 }, { id: 'b3', do: 'wait', ms: 1 }] },
      { id: 's03', title: 'Três', steps: [{ id: 'c1', do: 'wait', ms: 1 }] },
    ],
  });
  const summary = (selection: Parameters<typeof planScenes>[1]) => planScenes(doc, selection).map((p) => `${p.scene.id}:${p.startAt}-${p.stopBefore ?? 'fim'}`);

  test('seleção, começo e fim', () => {
    assert.deepEqual(summary({}), ['s01:0-fim', 's02:0-fim', 's03:0-fim']);
    assert.deepEqual(summary({ scenes: ['s03', 's01'] }), ['s01:0-fim', 's03:0-fim']);
    assert.deepEqual(summary({ from: 's02' }), ['s02:0-fim', 's03:0-fim']);
    assert.deepEqual(summary({ from: 'b2' }), ['s02:1-fim', 's03:0-fim']);
    assert.deepEqual(summary({ until: 'b2' }), ['s01:0-fim', 's02:0-1']);
    assert.deepEqual(summary({ until: 's03' }), ['s01:0-fim', 's02:0-fim']);
    assert.deepEqual(summary({ from: 'b2', until: 'b3' }), ['s02:1-2']);
    assert.deepEqual(summary({ scenes: ['s02'], until: 'b1' }), [], 'parar antes do primeiro passo = parar antes da cena');
  });

  test('id desconhecido ou fora das cenas escolhidas → E_CHOREO_INVALID citando a opção', () => {
    for (const [selection, option] of [[{ scenes: ['s09'] }, '--scenes'], [{ from: 'zz' }, '--from'], [{ until: 'zz' }, '--until'], [{ scenes: ['s01'], from: 'c1' }, '--from']] as const) {
      assert.throws(() => planScenes(doc, selection), (error: unknown) => isContrarregraError(error, 'E_CHOREO_INVALID') && error.data?.['option'] === option);
    }
  });

  test('o executor começa no passo do --from (índices originais) e para antes do --until', async () => {
    const h = harness({ scenes: doc.scenes });
    await h.executor.runScenes(planScenes(h.doc, { from: 'b2', until: 'c1' }));
    assert.deepEqual(h.record.steps.map((s) => `${s.sceneId} ${s.index} ${s.id}`), ['s02 2 b2', 's02 3 b3']);
    assert.deepEqual(h.record.scenes.map((s) => [s.id, s.truncated ?? false]), [['s02', true]]);
  });
});
