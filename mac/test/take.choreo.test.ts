// Testes da M3 (trilha do demo): a coreografia da tomada — YAML → S0.4 → subconjunto do executor do Mac →
// `ref` expandidos (recursivo, ciclo, `@eN`), e o `take validate` da CLI. Nada fala com o iPhone nem o OBS.

import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { main } from '../src/cli/main.ts';
import { isContrarregraError } from '../src/core/errors.ts';
import type { Step } from '../src/core/types.ts';
import { checkTakeChoreography, loadTakeChoreography, looksLikeCredential, TAKE_RULES } from '../src/take/choreo.ts';
import { choreography, takeEnv, type TakeEnv } from './helpers/take-fakes.ts';

const envs: TakeEnv[] = [];
afterEach(() => {
  for (const env of envs.splice(0)) env.cleanup();
});

function env(): TakeEnv {
  const e = takeEnv();
  envs.push(e);
  return e;
}

function scene(steps: unknown[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: 's01', title: 'Abertura', line: ['Uma.', 'Duas.'], steps, ...extra };
}

function check(parts: Record<string, unknown>) {
  return checkTakeChoreography({ ...choreography(), ...parts });
}

function rules(result: { errors: { path: string; rule: string }[] }): string[] {
  return result.errors.map((e) => `${e.path} ${e.rule}`);
}

const YAML_OK = `
schema: contrarregra.choreography/1
app: {bundleId: app.example.demo, iconLabel: "Demo", expectVersion: "1.0.0 (7)", urlPrefixes: ["demo://"]}
device: {language: en, screenPt: {w: 390, h: 844}, textSize: large, appearance: light}
targets:
  tabBar:  {type: tabBar}
  tabHome: {label: "Home", type: button, within: {ref: tabBar}}
  play:    {label: "Play", type: button}
  pause:   {label: "Pause", type: button}
prepare:
  - {do: openURL, url: "demo://start", expect: {element: {ref: tabHome}, state: exists}, expectTimeoutMs: 15000}
scenes:
  - id: s01
    title: "Abertura"
    line: ["Hello.", "This is the app."]
    steps:
      - {id: s01.home, do: tap, target: {ref: tabHome}, caption: "Início"}
      - {id: s01.play, do: tap, target: {ref: play}, cue: 1, expect: {element: {ref: pause}, state: exists}}
      - {id: s01.scroll, do: drag, from: {nx: 0.5, ny: 0.6}, to: {ref: play, offset: {dx: 0, dy: -200}}, velocity: 600}
      - id: s01.cp
        do: checkpoint
        who: human
        ask: "Face ID: olhe para o iPhone."
        until: {element: {ref: pause}, state: exists}
        timeoutMs: 90000
        onTimeout: pause
      - {id: s01.end, do: hold}
cleanup:
  - {do: app, action: terminate}
`;

describe('take validate: refs do catálogo (S0.4)', () => {
  test('expande ref aninhado (within → ref) e os modificadores de quem cita valem por cima', () => {
    const e = env();
    const file = join(e.choreoDir, 'ok.choreo.yaml');
    writeFileSync(file, YAML_OK);
    const loaded = loadTakeChoreography(file);
    assert.equal(loaded.sha256, createHash('sha256').update(YAML_OK).digest('hex'));
    const steps = loaded.doc.scenes[0]!.steps;
    assert.deepEqual((steps[0] as Extract<Step, { do: 'tap' }>).target, { label: 'Home', type: 'button', within: { type: 'tabBar' } });
    const drag = steps[2] as Extract<Step, { do: 'drag' }>;
    assert.deepEqual(drag.from, { nx: 0.5, ny: 0.6 });
    assert.deepEqual(drag.to, { label: 'Play', type: 'button', offset: { dx: 0, dy: -200 } });
    const cp = steps[3] as Extract<Step, { do: 'checkpoint' }>;
    assert.deepEqual(cp.until, { element: { label: 'Pause', type: 'button' }, state: 'exists' });
    assert.deepEqual(loaded.doc.prepare[0]!.expect, { element: { label: 'Home', type: 'button', within: { type: 'tabBar' } }, state: 'exists' });
    assert.ok(!JSON.stringify(loaded.doc).includes('"ref"'), 'nenhum ref sobra');
    assert.deepEqual(loaded.warnings, ['device (idioma, tela, texto, aparência) não é conferido nesta trilha (pré-voo reduzido)']);
  });

  test('ref inexistente → caminho exato (E-3.1)', () => {
    const r = check({ scenes: [scene([{ do: 'tap', target: { ref: 'nada' } }])] });
    assert.deepEqual(rules(r), [`scenes[0].steps[0].target.ref ${TAKE_RULES.refUnknown}`]);
  });

  test('ciclo no catálogo (a → b → a, e a → a) → erro com a cadeia, uma vez só', () => {
    const r = check({
      targets: { a: { label: 'A', within: { ref: 'b' } }, b: { label: 'B', within: { ref: 'a' } }, self: { label: 'S', below: { ref: 'self' } } },
      scenes: [scene([{ do: 'tap', target: { ref: 'a' } }])],
    });
    assert.equal(r.errors.length, 2, JSON.stringify(r.errors));
    const cycle = r.errors.find((e) => e.message.includes('a → b → a'));
    assert.ok(cycle !== undefined, JSON.stringify(r.errors));
    assert.equal(cycle.rule, TAKE_RULES.refCycle);
    assert.equal(cycle.path, 'targets.b.within.ref');
    assert.ok(r.errors.some((e) => e.message.includes('self → self') && e.path === 'targets.self.below.ref'));
  });

  test('@eN (nó da árvore) é recusado numa coreografia (S0.2)', () => {
    const r = check({ scenes: [scene([{ do: 'tap', target: { ref: '@e12' } }])] });
    assert.deepEqual(rules(r), [`scenes[0].steps[0].target.ref ${TAKE_RULES.nodeRef}`]);
  });
});

describe('take validate: subconjunto da tomada', () => {
  test('press e app launch recusados em qualquer seção; openURL só fora de scenes (AC-3.2, AC-3.3)', () => {
    const r = check({
      prepare: [{ do: 'openURL', url: 'demo://x' }, { do: 'press', button: 'home' }],
      scenes: [scene([{ do: 'openURL', url: 'demo://y' }, { do: 'app', action: 'launch' }, { do: 'press', button: 'volumeUp' }])],
      cleanup: [{ do: 'openURL', url: 'demo://z' }],
    });
    assert.deepEqual(rules(r).sort(), [
      `prepare[1].do ${TAKE_RULES.unsupported}`,
      `scenes[0].steps[0].do ${TAKE_RULES.takeRule}`,
      `scenes[0].steps[1].action ${TAKE_RULES.unsupported}`,
      `scenes[0].steps[2].do ${TAKE_RULES.unsupported}`,
    ]);
  });

  test('repeat recusado; expect com changed recusado (mesmo dentro de all/not)', () => {
    const r = check({
      scenes: [
        scene([
          { do: 'tap', target: { label: 'A' }, repeat: { until: { locked: false }, max: 2 } },
          { do: 'tap', target: { label: 'B' }, expect: { all: [{ locked: false }, { not: { element: { label: 'C' }, state: 'changed' } }] } },
        ]),
      ],
    });
    assert.deepEqual(rules(r), [`scenes[0].steps[0].repeat ${TAKE_RULES.repeat}`, `scenes[0].steps[1].expect ${TAKE_RULES.changed}`]);
  });

  test('type num secureTextField (via ref) ou com e-mail é recusado (E-3.3, AC-3.8)', () => {
    assert.ok(looksLikeCredential('dono@example.com'));
    assert.ok(!looksLikeCredential('Psalm 23'));
    const r = check({
      targets: { senha: { type: 'secureTextField' } },
      scenes: [scene([{ do: 'type', target: { ref: 'senha' }, text: 'abc' }, { do: 'type', text: 'eu@icloud.com' }])],
    });
    assert.deepEqual(rules(r), [`scenes[0].steps[0].target ${TAKE_RULES.secureType}`, `scenes[0].steps[1].text ${TAKE_RULES.secureType}`]);
  });

  test('ids de passo repetidos (inclusive aninhados), cue fora de line e drag sem velocity/durationMs', () => {
    const r = check({
      scenes: [
        scene([
          { id: 'x', do: 'wait', ms: 10 },
          { do: 'block', steps: [{ id: 'x', do: 'wait', ms: 10 }] },
          { do: 'tap', target: { label: 'A' }, cue: 2 },
          { do: 'drag', from: { x: 1, y: 2 }, to: { x: 3, y: 4 } },
        ]),
      ],
    });
    assert.deepEqual(rules(r), [
      `scenes[0].steps[1].steps[0].id ${TAKE_RULES.stepIdUnique}`,
      `scenes[0].steps[2].cue ${TAKE_RULES.cueRange}`,
      `scenes[0].steps[3] ${TAKE_RULES.dragMotion}`,
    ]);
  });

  test('campos que o executor ignoraria são recusados; confirm/guide/device no topo só avisam', () => {
    const until = { locked: false };
    const r = check({
      confirm: ['iPhone carregado'],
      guide: { voice: 'Samantha', targetWpm: 150 },
      scenes: [
        scene([
          { do: 'waitFor', condition: until, expect: until },
          { do: 'assert', condition: until, optional: true },
          { do: 'wait', ms: 10, optional: true },
          { do: 'block', steps: [], expect: until },
          { do: 'mark', label: 'x', optional: true },
          { do: 'hold', expect: until },
          { id: 'cp1', do: 'checkpoint', who: 'human', ask: 'x', until, timeoutMs: 1, onTimeout: 'pause', steps: [{ do: 'home' }] },
          { id: 'cp2', do: 'checkpoint', who: 'runner', ask: 'x', until, timeoutMs: 1, onTimeout: 'pause', alert: { sound: true, say: true }, steps: [{ do: 'home' }] },
          { do: 'tap', target: { label: 'A' }, expect: until, optional: true },
        ]),
      ],
    });
    assert.deepEqual(rules(r), [
      `scenes[0].steps[0].expect ${TAKE_RULES.ignoredField}`,
      `scenes[0].steps[1].optional ${TAKE_RULES.ignoredField}`,
      `scenes[0].steps[2].optional ${TAKE_RULES.ignoredField}`,
      `scenes[0].steps[3].expect ${TAKE_RULES.ignoredField}`,
      `scenes[0].steps[4].optional ${TAKE_RULES.ignoredField}`,
      `scenes[0].steps[5].expect ${TAKE_RULES.ignoredField}`,
      `scenes[0].steps[6].steps ${TAKE_RULES.ignoredField}`,
      `scenes[0].steps[7].alert ${TAKE_RULES.ignoredField}`,
    ]);
    assert.ok(r.warnings.some((w) => w.startsWith('confirm é ignorado')));
    assert.ok(r.warnings.some((w) => w.startsWith('guide é ignorado')));
    assert.ok(r.warnings.some((w) => w.startsWith('device ')));
  });

  test('erros de S0.4 (campo desconhecido) saem antes, com o caminho (AC-0.1)', () => {
    const r = check({ scenes: [scene([{ do: 'tap', tagret: { label: 'A' } }])] });
    assert.ok(r.errors.some((e) => e.path === 'scenes[0].steps[0].tagret' && e.rule === 'unknown-field'), JSON.stringify(r.errors));
  });

  test('loadTakeChoreography: YAML quebrado ou inválido → E_CHOREO_INVALID com data.errors', () => {
    const e = env();
    const broken = join(e.choreoDir, 'broken.choreo.yaml');
    writeFileSync(broken, 'scenes: [\n');
    assert.throws(() => loadTakeChoreography(broken), (error: unknown) => isContrarregraError(error, 'E_CHOREO_INVALID') && (error.data?.['errors'] as { rule: string }[])[0]!.rule === TAKE_RULES.yaml);
    const bad = join(e.choreoDir, 'bad.choreo.yaml');
    writeFileSync(bad, YAML_OK.replace('do: hold}', 'do: press, button: home}'));
    assert.throws(() => loadTakeChoreography(bad), (error: unknown) => isContrarregraError(error, 'E_CHOREO_INVALID') && error.message.includes('scenes[0].steps[4].do'));
  });

  test('cena sem line vira aviso (E-3.2); cue sem line é erro', () => {
    const r = check({ scenes: [{ id: 's01', title: 'Sem fala', steps: [{ do: 'wait', ms: 1 }] }] });
    assert.deepEqual(r.errors, []);
    assert.equal(r.warnings.filter((w) => w.includes('E-3.2')).length, 1);
    const withCue = check({ scenes: [{ id: 's01', title: 'Sem fala', steps: [{ do: 'wait', ms: 1, cue: 0 }] }] });
    assert.deepEqual(rules(withCue), [`scenes[0].steps[0].cue ${TAKE_RULES.cueRange}`]);
  });
});

describe('take validate na CLI', () => {
  function io() {
    const out: string[] = [];
    const err: string[] = [];
    return { out, err, io: { stdout: (t: string) => void out.push(t), stderr: (t: string) => void err.push(t) } };
  }

  test('--json: {ok, errors, scenes, steps}; código 0 quando ok e 1 com erros', async () => {
    const e = env();
    const good = join(e.choreoDir, 'good.choreo.yaml');
    writeFileSync(good, YAML_OK);
    const ok = io();
    assert.equal(await main(['take', 'validate', good, '--json'], { config: { configPath: e.configPath }, io: ok.io }), 0, ok.err.join(''));
    const result = JSON.parse(ok.out.join('')) as { ok: boolean; errors: unknown[]; scenes: number; steps: number; sha256: string };
    assert.equal(result.ok, true);
    assert.deepEqual(result.errors, []);
    assert.equal(result.scenes, 1);
    assert.equal(result.steps, 7);

    const bad = join(e.choreoDir, 'bad.choreo.yaml');
    writeFileSync(bad, YAML_OK.replace('{ref: tabHome}, caption', '{ref: semNome}, caption'));
    const ko = io();
    assert.equal(await main(['take', 'validate', bad], { config: { configPath: e.configPath }, io: ko.io }), 1);
    assert.match(ko.out.join(''), /scenes\[0\]\.steps\[0\]\.target\.ref: ref "semNome" não existe/);
  });

  test('uso: falta o arquivo, argumento a mais, comando de control desconhecido, opção de outro subcomando', async () => {
    const e = env();
    for (const argv of [['take', 'validate'], ['take', 'run', 'a', 'b'], ['take', 'control', '/tmp/x', 'pular'], ['take', 'validate', 'a', '--dry'], ['take', 'run', 'a', '--scenes', ',']]) {
      const c = io();
      assert.equal(await main(argv, { config: { configPath: e.configPath }, io: c.io }), 2, argv.join(' '));
      assert.match(c.err.join(''), /uso:/);
    }
  });
});
