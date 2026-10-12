// Testes da T-0.3: esquemas de S0 em zod (AC-0.1, AC-0.3, AC-0.4, AC-0.7), serialização JCS (RFC 8785),
// fixtures compartilhadas com o Swift (AC-0.6, lado TypeScript) e o servidor WebSocket de teste.
//
// Convenção das fixtures (a mesma que o `swift test` da T-0.4 lê):
//   fixtures/protocol/<Tipo>.<caso>.json     válida; decodifica → recodifica (AC-0.6)
//   fixtures/protocol/<Tipo>.<caso>.jcs      bytes UTF-8 esperados do JCS da anterior (sem fim de linha)
//     · para RpcRequest/RpcResponse/RpcNotification o <caso> é o nome do método (ex.: session.hello)
//   fixtures/protocol/invalid/<Tipo>.<caso>.json
//                                            {type, method?, expect: {path, rule, code?}, value}: `value`
//                                            tem de ser recusado com um erro nesse caminho e regra
//   fixtures/protocol/jcs/numbers.json       vetores do Apêndice B da RFC 8785 (bits IEEE 754 → texto)
//   fixtures/protocol/jcs/<caso>.json + .jcs  exemplos da RFC 8785 (texto JSON de entrada → JCS)
//   fixtures/artifacts/…                     mesma convenção, para arquivos só do Mac (events.json,
//                                            take.json, relatórios, config); sem .jcs

import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse as parseYaml } from 'yaml';
import type { z } from 'zod';

import { DEFAULTS_PATH, loadConfig } from '../src/core/config.ts';
import { isContrarregraError, RPC_ERROR_CODES, type ErrorCode } from '../src/core/errors.ts';
import { canonicalize, jcsSha256 } from '../src/core/jcs.ts';
import {
  choreographySha256,
  ConfigSchema,
  DOCUMENT_SCHEMAS,
  EventsJsonSchema,
  parseChoreography,
  parseCompiledChoreography,
  parseConfig,
  parseOrThrow,
  parseTarget,
  rpcNotificationSchemaFor,
  rpcRequestSchemaFor,
  rpcResponseSchemaFor,
  RULES,
  SessionHelloResultSchema,
  validate,
  validateChoreography,
  type ValidationIssue,
} from '../src/core/schema.ts';
import type { Choreography, CompiledChoreography, DragStep, EventsJson, JsonValue } from '../src/core/types.ts';
import { acceptKey, startWsServer, type WsTestConnection, type WsTestServer } from './helpers/ws-server.ts';

const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));
const PROTOCOL = join(FIXTURES, 'protocol');
const ARTIFACTS = join(FIXTURES, 'artifacts');

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

/** `<Tipo>.<caso>.json` → tipo e caso (o caso pode ter pontos: é o método nas mensagens RPC). */
function splitName(file: string): { type: string; rest: string } {
  const base = file.replace(/\.json$/, '');
  const dot = base.indexOf('.');
  return { type: base.slice(0, dot), rest: base.slice(dot + 1) };
}

function schemaFor(type: string, rest: string): z.ZodType {
  if (type === 'RpcRequest') return rpcRequestSchemaFor(rest);
  if (type === 'RpcResponse') return rpcResponseSchemaFor(rest);
  if (type === 'RpcNotification') return rpcNotificationSchemaFor(rest);
  const schema = (DOCUMENT_SCHEMAS as Record<string, z.ZodType | undefined>)[type];
  assert.ok(schema, `fixture de tipo desconhecido: ${type}`);
  return schema;
}

function jsonFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort();
}

function hasIssue(errors: readonly ValidationIssue[], path: string, rule?: string): boolean {
  return errors.some((e) => e.path === path && (rule === undefined || e.rule === rule));
}

function assertRejected(schema: z.ZodType, value: unknown, path: string, rule?: string): readonly ValidationIssue[] {
  const result = validate(schema, value);
  assert.equal(result.ok, false, `esperava recusa em ${path}`);
  assert.ok(
    hasIssue(result.errors, path, rule),
    `esperava erro em "${path}"${rule ? ` (${rule})` : ''}; veio ${JSON.stringify(result.errors)}`,
  );
  return result.errors;
}

function assertAccepted<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = validate(schema, value);
  assert.ok(result.ok, `esperava aceitar; veio ${JSON.stringify(result.ok ? [] : result.errors)}`);
  return result.value;
}

function assertThrowsCode(fn: () => unknown, code: ErrorCode, path?: string): void {
  assert.throws(fn, (err: unknown) => {
    assert.ok(isContrarregraError(err, code), `esperava ${code}, veio ${String(err)}`);
    if (path !== undefined) {
      const errors = err.data?.['errors'] as ValidationIssue[] | undefined;
      assert.ok(errors && hasIssue(errors, path), `esperava erro em "${path}"; veio ${JSON.stringify(errors)}`);
      assert.ok(err.message.includes(path), `a mensagem deve citar ${path}: ${err.message}`);
    }
    return true;
  });
}

function choreographyFixture(): Choreography {
  return readJson(join(PROTOCOL, 'Choreography.ac07.json')) as Choreography;
}

// ── AC-0.1 ──────────────────────────────────────────────────────────────────────────────────────────

describe('coreografia: campo desconhecido (AC-0.1)', () => {
  test('AC-0.1: um campo desconhecido em scenes[1].steps[3] falha apontando scenes[1].steps[3].tagret', () => {
    const wrapper = readJson(join(PROTOCOL, 'invalid', 'Choreography.unknown-field.json')) as { value: unknown };
    const result = validateChoreography(wrapper.value);
    assert.equal(result.ok, false);
    assert.ok(hasIssue(result.errors, 'scenes[1].steps[3].tagret', RULES.unknownField), JSON.stringify(result.errors));
    assertThrowsCode(() => parseChoreography(wrapper.value), 'E_CHOREO_INVALID', 'scenes[1].steps[3].tagret');
  });

  test('AC-0.1: campo desconhecido no topo, num alvo do catálogo, numa condição e dentro de um bloco aninhado', () => {
    const base = choreographyFixture();
    const top = { ...clone(base), sceness: [] };
    assertRejected(DOCUMENT_SCHEMAS.Choreography, top, 'sceness', RULES.unknownField);

    const catalog = clone(base) as unknown as { targets: Record<string, Record<string, unknown>> };
    catalog.targets['focusStage']!['lable'] = 'Focus';
    assertRejected(DOCUMENT_SCHEMAS.Choreography, catalog, 'targets.focusStage.lable', RULES.unknownField);

    const nested = clone(base) as unknown as { scenes: { steps: unknown[] }[] };
    nested.scenes[0]!.steps.push({
      do: 'block',
      when: { element: { label: 'Focus' }, state: 'exists', equal: '1' },
      steps: [{ do: 'tap', target: { label: 'Go' }, captoin: 'x' }],
    });
    const errors = assertRejected(DOCUMENT_SCHEMAS.Choreography, nested, 'scenes[0].steps[2].when.equal', RULES.unknownField);
    assert.ok(hasIssue(errors, 'scenes[0].steps[2].steps[0].captoin', RULES.unknownField), JSON.stringify(errors));
  });
});

// ── AC-0.3 ──────────────────────────────────────────────────────────────────────────────────────────

describe('alvo: regra do seletor primário (AC-0.3)', () => {
  test('AC-0.3: {label, point} e {ref, identifier} são recusados com E_CHOREO_INVALID', () => {
    for (const target of [
      { label: 'Focus', point: { x: 10, y: 20 } },
      { ref: 'focusStage', identifier: 'focus-stage' },
    ]) {
      assertThrowsCode(() => parseTarget(target), 'E_CHOREO_INVALID');
      assertRejected(DOCUMENT_SCHEMAS.Target, target, '', RULES.onePrimarySelector);
    }
  });

  test('AC-0.3: {label, type} e {type: tabBar} passam', () => {
    assert.deepEqual(parseTarget({ label: 'Focus', type: 'button' }), { label: 'Focus', type: 'button' });
    assert.deepEqual(parseTarget({ type: 'tabBar' }), { type: 'tabBar' });
  });

  test('AC-0.3: a regra vale em todo alvo aninhado (catálogo, within, fallback, ocr.within, condição, drag)', () => {
    const base = choreographyFixture();
    const bad = { label: 'A', labelPrefix: 'B' };
    const cases: [string, (c: Record<string, any>) => void][] = [
      ['targets.bad', (c) => (c['targets']['bad'] = bad)],
      ['scenes[0].steps[0].from.within', (c) => (c['scenes'][0]['steps'][0]['from']['within'] = bad)],
      ['scenes[0].steps[0].from.fallback[0]', (c) => (c['scenes'][0]['steps'][0]['from']['fallback'] = [bad])],
      [
        'prepare[0].target.ocr.within',
        (c) => c['prepare'].push({ do: 'tap', target: { ocr: { text: 'Go', within: bad } } }),
      ],
      [
        'cleanup[0].condition.element',
        (c) => c['cleanup'].push({ do: 'waitFor', condition: { element: bad, state: 'gone' } }),
      ],
    ];
    for (const [path, mutate] of cases) {
      const doc = clone(base) as unknown as Record<string, any>;
      mutate(doc);
      assertRejected(DOCUMENT_SCHEMAS.Choreography, doc, path, RULES.onePrimarySelector);
      assertThrowsCode(() => parseChoreography(doc), 'E_CHOREO_INVALID', path);
    }
  });

  test('alvo vazio (nem primário nem type) e type fora de XCUIElement.ElementType são recusados', () => {
    assertRejected(DOCUMENT_SCHEMAS.Target, {}, '', RULES.onePrimarySelector);
    assertRejected(DOCUMENT_SCHEMAS.Target, { app: 'springboard' }, '', RULES.onePrimarySelector);
    assertRejected(DOCUMENT_SCHEMAS.Target, { type: 'buton' }, 'type', RULES.value);
    assertAccepted(DOCUMENT_SCHEMAS.Target, { app: 'springboard', type: 'icon', label: 'Settings' });
  });
});

// ── AC-0.7 ──────────────────────────────────────────────────────────────────────────────────────────

const AC07_YAML = `
schema: contrarregra.choreography/1
app: {bundleId: com.example.target, iconLabel: "Example", expectVersion: "1.0.0 (5)", urlPrefixes: ["example://"]}
device: {language: en, screenPt: {w: 390, h: 844}, textSize: large, appearance: light}
targets:
  focusStage: {label: "Focus", type: button}
prepare: []
scenes:
  - id: s01
    title: "Arrastos"
    line: ["Drag the stage down.", "Then drag the screen."]
    steps:
      - {id: s01.stage, do: drag, from: {ref: focusStage}, to: {ref: focusStage, offset: {dx: 0, dy: 200}}, velocity: 1000}
      - {id: s01.screen, do: drag, from: {nx: 0.5, ny: 0.6}, to: {x: 195, y: 300}, durationMs: 500}
cleanup: []
`;

describe('coreografia: drag com Point e Target (AC-0.7)', () => {
  test('AC-0.7: drag {from: {ref}, to: {ref, offset}, velocity} e drag {from: {nx, ny}, to: {x, y}, durationMs} passam (YAML e JSON)', () => {
    for (const source of [parseYaml(AC07_YAML) as unknown, choreographyFixture()]) {
      const doc = parseChoreography(source);
      const [stage, screen] = doc.scenes[0]!.steps as [DragStep, DragStep];
      assert.equal(stage.do, 'drag');
      assert.deepEqual(stage.from, { ref: 'focusStage' });
      assert.deepEqual(stage.to, { ref: 'focusStage', offset: { dx: 0, dy: 200 } });
      assert.equal(stage.velocity, 1000);
      assert.deepEqual(screen.from, { nx: 0.5, ny: 0.6 });
      assert.deepEqual(screen.to, { x: 195, y: 300 });
      assert.equal(screen.durationMs, 500);
    }
  });

  test('AC-0.7: drag com velocity e durationMs juntos falha', () => {
    const wrapper = readJson(join(PROTOCOL, 'invalid', 'Choreography.drag-velocity-and-duration.json')) as {
      value: unknown;
    };
    assertRejected(DOCUMENT_SCHEMAS.Choreography, wrapper.value, 'scenes[0].steps[0].durationMs', RULES.velocityXorDuration);
    assertThrowsCode(() => parseChoreography(wrapper.value), 'E_CHOREO_INVALID', 'scenes[0].steps[0].durationMs');

    const yaml = parseYaml(AC07_YAML) as Record<string, any>;
    yaml['scenes'][0]['steps'][1]['velocity'] = 600;
    assertRejected(DOCUMENT_SCHEMAS.Choreography, yaml, 'scenes[0].steps[1].durationMs', RULES.velocityXorDuration);
  });

  test('pontos de drag: forma mista, fora de 0–1 e sem coordenada são recusados', () => {
    assertRejected(DOCUMENT_SCHEMAS.Point, { x: 1, ny: 0.5 }, '', RULES.pointForm);
    assertRejected(DOCUMENT_SCHEMAS.Point, { nx: 1.2, ny: 0.5 }, 'nx', RULES.range);
    assertRejected(DOCUMENT_SCHEMAS.Point, {}, '', RULES.pointForm);
    const doc = choreographyFixture() as unknown as Record<string, any>;
    doc['scenes'][0]['steps'][1]['to'] = { x: 195 };
    assertRejected(DOCUMENT_SCHEMAS.Choreography, doc, 'scenes[0].steps[1].to.y', RULES.required);
  });

  test('ponto com erro de digitação ou forma mista: acusa só o campo errado, nunca x/y/nx/ny presentes', () => {
    const at = 'scenes[0].steps[1].to';
    const cases: [Record<string, number>, string, string][] = [
      [{ x: 195, y: 300, z: 1 }, `${at}.z`, RULES.unknownField],
      [{ nx: 0.5, nyy: 0.6 }, `${at}.nyy`, RULES.unknownField],
      [{ x: 1, ny: 0.5 }, at, RULES.pointForm],
    ];
    for (const [point, path, rule] of cases) {
      const doc = choreographyFixture() as unknown as Record<string, any>;
      doc['scenes'][0]['steps'][1]['to'] = point;
      const errors = assertRejected(DOCUMENT_SCHEMAS.Choreography, doc, path, rule);
      for (const key of Object.keys(point).filter((k) => ['x', 'y', 'nx', 'ny'].includes(k))) {
        assert.ok(!hasIssue(errors, `${at}.${key}`), `${key} é campo válido e não deveria ser acusado: ${JSON.stringify(errors)}`);
      }
      assert.ok(
        errors.every((e) => e.path.startsWith(at)),
        `só o ponto deveria ser acusado: ${JSON.stringify(errors)}`,
      );
    }
    const alone = assertRejected(DOCUMENT_SCHEMAS.Point, { x: 195, y: 300, z: 1 }, 'z', RULES.unknownField);
    assert.deepEqual(alone.map((e) => e.path), ['z']);
  });
});

// ── AC-0.4 ──────────────────────────────────────────────────────────────────────────────────────────

/** Todo campo `…Ns`, em qualquer profundidade, com o valor. */
function nsFields(value: unknown, path = ''): [string, unknown][] {
  const out: [string, unknown][] = [];
  if (Array.isArray(value)) value.forEach((v, i) => out.push(...nsFields(v, `${path}[${i}]`)));
  else if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      const p = path ? `${path}.${k}` : k;
      if (k.endsWith('Ns')) out.push([p, v]);
      out.push(...nsFields(v, p));
    }
  }
  return out;
}

describe('events.json (AC-0.4)', () => {
  const takeFile = join(ARTIFACTS, 'EventsJson.take.json');

  test('AC-0.4: o events.json de uma tomada passa em contrarregra.events/1 e todo tempo D/M é string de inteiro', () => {
    const doc = readJson(takeFile);
    const parsed = assertAccepted(EventsJsonSchema, doc) as EventsJson;
    assert.equal(parsed.schema, 'contrarregra.events/1');
    const times = nsFields(parsed);
    assert.ok(times.length >= 20, `a fixture deveria ter tempos D/M em todos os níveis (achei ${times.length})`);
    for (const [path, value] of times) {
      assert.equal(typeof value, 'string', `${path} deveria ser string`);
      assert.match(value as string, /^-?(0|[1-9][0-9]*)$/, `${path} = ${String(value)}`);
    }
  });

  test('AC-0.4: tempo D/M como número, decimal, fora de 64 bits ou num campo aberto (detail, checkpoints) é recusado', () => {
    const base = readJson(takeFile) as Record<string, any>;
    const cases: [string, (d: Record<string, any>) => void][] = [
      ['events[2].tDevStartNs', (d) => (d['events'][2]['tDevStartNs'] = 1234567890123)],
      ['events[2].tMacNs', (d) => (d['events'][2]['tMacNs'] = '1234567890123.5')],
      ['events[2].tDispatchNs', (d) => (d['events'][2]['tDispatchNs'] = '9223372036854775808')],
      ['events[2].detail.waitNs', (d) => (d['events'][2]['detail'] = { waitNs: 5 })],
      ['checkpoints[0].tResolvedNs', (d) => (d['checkpoints'][0]['tResolvedNs'] = 77)],
      ['clock.deviceToMac.aNs', (d) => (d['clock']['deviceToMac']['aNs'] = '-1.5')],
      ['take.toolchain.probeNs', (d) => (d['take']['toolchain']['probeNs'] = 12)],
    ];
    for (const [path, mutate] of cases) {
      const doc = clone(base);
      mutate(doc);
      assertRejected(EventsJsonSchema, doc, path, RULES.int64String);
    }
    const ok = clone(base);
    ok['clock']['deviceToMac']['aNs'] = '-9223372036854775808';
    assertAccepted(EventsJsonSchema, ok);
  });

  test('tempos R/F com mais de 3 casas e kind desconhecido são recusados', () => {
    const base = readJson(takeFile) as Record<string, any>;
    const r = clone(base);
    r['events'][2]['tRecS'] = 31.4521;
    assertRejected(EventsJsonSchema, r, 'events[2].tRecS', RULES.seconds3);
    const f = clone(base);
    f['scenes'][0]['startF'] = 1.23456;
    assertRejected(EventsJsonSchema, f, 'scenes[0].startF', RULES.seconds3);
    const k = clone(base);
    k['events'][0]['kind'] = 'take.begin';
    assertRejected(EventsJsonSchema, k, 'events[0].kind', RULES.value);
  });

  test('AC-7.6 / S7 item 4: evento sem mudança detectada tem tVideoObservedS null e a tomada passa', () => {
    const base = readJson(takeFile) as Record<string, any>;
    const events = base['events'] as Record<string, unknown>[];
    assert.ok(
      events.some((e) => Object.hasOwn(e, 'tVideoObservedS') && e['tVideoObservedS'] === null),
      'a fixture deveria ter um evento com tVideoObservedS: null',
    );
    const doc = clone(base);
    doc['events'][2]['tVideoObservedS'] = null;
    const parsed = assertAccepted(EventsJsonSchema, doc) as EventsJson;
    assert.equal(parsed.events[2]!.tVideoObservedS, null);
    const bad = clone(base);
    bad['events'][2]['tVideoObservedS'] = 'nenhum';
    assertRejected(EventsJsonSchema, bad, 'events[2].tVideoObservedS', RULES.type);
  });

  test('S7 item 6: com < 10 passos detectados o SyncReport tem error null e ok false (events.json e sync.json passam)', () => {
    const short = readJson(join(ARTIFACTS, 'SyncReport.short-take.json')) as Record<string, any>;
    assert.equal(short['error'], null);
    assert.equal(short['ok'], false);
    assertAccepted(DOCUMENT_SCHEMAS.SyncReport, short);
    const doc = clone(readJson(takeFile)) as Record<string, any>;
    doc['clock']['error'] = null;
    doc['clock']['ok'] = false;
    doc['clock']['captureLatency']['method'] = 'calibrated';
    assertAccepted(EventsJsonSchema, doc);
    const notEvaluatedButOk = clone(doc);
    notEvaluatedButOk['clock']['ok'] = true;
    assertRejected(EventsJsonSchema, notEvaluatedButOk, 'clock.ok', RULES.syncNotEvaluated);
  });
});

// ── JCS (RFC 8785) ──────────────────────────────────────────────────────────────────────────────────

function doubleFromBits(hex: string): number {
  const view = new DataView(new ArrayBuffer(8));
  view.setBigUint64(0, BigInt(hex));
  return view.getFloat64(0);
}

describe('JCS (RFC 8785)', () => {
  test('números: os vetores IEEE 754 do Apêndice B da RFC 8785', () => {
    const vectors = readJson(join(PROTOCOL, 'jcs', 'numbers.json')) as { bits: string; expected?: string; error?: true }[];
    assert.ok(vectors.length >= 25);
    for (const v of vectors) {
      const n = doubleFromBits(v.bits);
      if (v.error) assert.throws(() => canonicalize(n), TypeError, v.bits);
      else assert.equal(canonicalize(n), v.expected, v.bits);
    }
  });

  test('os exemplos da RFC 8785 (§3.2.2 e §3.2.3): texto JSON de entrada → JCS', () => {
    const dir = join(PROTOCOL, 'jcs');
    const inputs = jsonFiles(dir).filter((f) => f !== 'numbers.json');
    assert.ok(inputs.length >= 2);
    for (const file of inputs) {
      const expected = readFileSync(join(dir, file.replace(/\.json$/, '.jcs')), 'utf8');
      assert.equal(canonicalize(readJson(join(dir, file))), expected, file);
    }
  });

  test('ordem das chaves por unidades UTF-16, -0, valores aninhados, ausentes e recusas', () => {
    assert.equal(canonicalize({ b: [1, { d: true, c: null }], a: 'x', '': -0 }), '{"":0,"a":"x","b":[1,{"c":null,"d":true}]}');
    assert.equal(canonicalize({ z: 1, y: undefined }), '{"z":1}');
    assert.equal(canonicalize([]), '[]');
    assert.equal(canonicalize({}), '{}');
    assert.equal(canonicalize(' \u0007'), '" \\u0007"');
    assert.throws(() => canonicalize('\ud800'), TypeError);
    assert.throws(() => canonicalize({ k: 1n }), TypeError);
    assert.throws(() => canonicalize([undefined]), TypeError);
    assert.throws(() => canonicalize(new Date(0)), TypeError);
    assert.throws(() => canonicalize(Number.POSITIVE_INFINITY), TypeError);
  });

  test('jcsSha256 = SHA-256 hex minúsculo dos bytes UTF-8 do JCS', () => {
    const value = { é: 1, a: [0.5, 'ü'] };
    const expected = createHash('sha256').update(Buffer.from('{"a":[0.5,"ü"],"é":1}', 'utf8')).digest('hex');
    assert.equal(jcsSha256(value), expected);
  });
});

// ── AC-0.6 (lado TypeScript) ────────────────────────────────────────────────────────────────────────

describe('fixtures do protocolo compartilhadas com o Swift (AC-0.6, lado TypeScript)', () => {
  const files = jsonFiles(PROTOCOL);

  test('toda fixture válida tem o .jcs ao lado (e nenhum .jcs órfão)', () => {
    assert.ok(files.length >= 20, `poucas fixtures: ${files.length}`);
    for (const file of files) assert.ok(existsSync(join(PROTOCOL, file.replace(/\.json$/, '.jcs'))), file);
    for (const jcs of readdirSync(PROTOCOL).filter((f) => f.endsWith('.jcs'))) {
      assert.ok(existsSync(join(PROTOCOL, jcs.replace(/\.jcs$/, '.json'))), jcs);
    }
  });

  for (const file of files) {
    test(`AC-0.6: ${file} decodifica, recodifica, fica semanticamente igual e byte a byte igual ao .jcs`, () => {
      const { type, rest } = splitName(file);
      const original = readJson(join(PROTOCOL, file));
      const decoded = assertAccepted(schemaFor(type, rest), original);
      const reencoded = JSON.parse(JSON.stringify(decoded)) as unknown;
      assert.deepEqual(reencoded, original);
      const expected = readFileSync(join(PROTOCOL, file.replace(/\.json$/, '.jcs')), 'utf8');
      assert.equal(canonicalize(reencoded), expected);
      assert.equal(canonicalize(original), expected);
      assert.ok(!expected.endsWith('\n'));
    });
  }

  test('o compiled.sha256 da coreografia compilada é o SHA-256 do JCS sem sha256 e compiledAt (S0.4)', () => {
    const doc = readJson(join(PROTOCOL, 'CompiledChoreography.ac07.json')) as CompiledChoreography;
    assert.equal(choreographySha256(doc), doc.compiled.sha256);
    const { sha256: _sha, compiledAt: _at, ...compiledRest } = doc.compiled;
    assert.equal(jcsSha256({ ...doc, compiled: compiledRest }), doc.compiled.sha256);
    const later = { ...doc, compiled: { ...doc.compiled, compiledAt: '2030-01-01T00:00:00Z', sha256: '0'.repeat(64) } };
    assert.equal(choreographySha256(later), doc.compiled.sha256);
    const changed = clone(doc);
    changed.scenes[0]!.title = 'Outro título';
    assert.notEqual(choreographySha256(changed), doc.compiled.sha256);
  });

  test('S6 item 3 / S4 item 3: na fixture compilada o startMs conta do início da cena e o holdMs fecha a conta', () => {
    const doc = readJson(join(PROTOCOL, 'CompiledChoreography.ac07.json')) as CompiledChoreography;
    const gap = (readJson(DEFAULTS_PATH) as { guide: { sentenceGapMs: number } }).guide.sentenceGapMs;
    for (const [i, compiledScene] of doc.compiled.scenes.entries()) {
      const scene = doc.scenes[i]!;
      assert.equal(compiledScene.id, scene.id);
      const { padBeforeMs, padAfterMs } = scene.hold as { padBeforeMs: number; padAfterMs: number };
      const sentences = compiledScene.sentences;
      assert.deepEqual(
        sentences.map((s) => s.text),
        scene.line,
      );
      let expectedStart = padBeforeMs;
      for (const sentence of sentences) {
        assert.equal(sentence.startMs, expectedStart, `startMs de "${sentence.text}"`);
        expectedStart += sentence.durMs + gap;
      }
      const speech = sentences.reduce((sum, s) => sum + s.durMs, 0);
      assert.equal(compiledScene.holdMs, padBeforeMs + speech + (sentences.length - 1) * gap + padAfterMs);
    }
    assert.deepEqual(
      doc.compiled.scenes[0]!.sentences.map((s) => s.startMs),
      [1000, 2880],
    );
  });

  test('S0.4: a forma compilada exige os padrões preenchidos (guide, hold da cena, afterMs, timeoutMs, onFail, sim, expectTimeoutMs)', () => {
    const base = readJson(join(PROTOCOL, 'CompiledChoreography.ac07.json')) as Record<string, any>;
    assertAccepted(DOCUMENT_SCHEMAS.CompiledChoreography, base);
    const cases: [string, (d: Record<string, any>) => void][] = [
      ['guide', (d) => delete d['guide']],
      ['scenes[0].hold', (d) => delete d['scenes'][0]['hold']],
      ['scenes[0].hold.padAfterMs', (d) => delete d['scenes'][0]['hold']['padAfterMs']],
      ['scenes[0].steps[0].afterMs', (d) => delete d['scenes'][0]['steps'][0]['afterMs']],
      ['scenes[0].steps[0].timeoutMs', (d) => delete d['scenes'][0]['steps'][0]['timeoutMs']],
      ['scenes[0].steps[1].onFail', (d) => delete d['scenes'][0]['steps'][1]['onFail']],
      ['scenes[0].steps[1].sim', (d) => delete d['scenes'][0]['steps'][1]['sim']],
      [
        'scenes[0].steps[0].expectTimeoutMs',
        (d) => (d['scenes'][0]['steps'][0]['expect'] = { element: { label: 'Focus' }, state: 'changed' }),
      ],
      [
        'prepare[0].steps[0].sim',
        (d) =>
          d['prepare'].push({
            do: 'block',
            afterMs: 300,
            timeoutMs: 3000,
            onFail: 'pause',
            sim: 'run',
            steps: [{ do: 'home', afterMs: 300, timeoutMs: 3000, onFail: 'pause' }],
          }),
      ],
      [
        'cleanup[0].steps[0].afterMs',
        (d) =>
          d['cleanup'].push({
            id: 'cleanup.cp',
            do: 'checkpoint',
            who: 'runner',
            ask: 'Desliga o modo avião.',
            until: { airplane: 'off' },
            timeoutMs: 15000,
            onTimeout: 'abort',
            afterMs: 300,
            onFail: 'pause',
            sim: 'skip',
            steps: [{ do: 'controlCenter', action: 'open', timeoutMs: 3000, onFail: 'pause', sim: 'skip' }],
          }),
      ],
    ];
    for (const [path, mutate] of cases) {
      const doc = clone(base);
      mutate(doc);
      assertRejected(DOCUMENT_SCHEMAS.CompiledChoreography, doc, path, RULES.compiledDefaults);
      assertThrowsCode(() => parseCompiledChoreography(doc), 'E_CHOREO_INVALID', path);
    }
    // A fonte continua sem exigir os padrões.
    assertAccepted(DOCUMENT_SCHEMAS.Choreography, choreographyFixture());
  });
});

describe('condição: changed só vale em expect (S0.3)', () => {
  const changed = { element: { labelPrefix: 'Synced' }, state: 'changed' };

  test('changed passa em expect, inclusive dentro de all/any/not', () => {
    const doc = choreographyFixture() as unknown as Record<string, any>;
    doc['scenes'][0]['steps'][0]['expect'] = changed;
    doc['scenes'][0]['steps'][1]['expect'] = { all: [{ locked: false }, { not: { any: [changed] } }] };
    assertAccepted(DOCUMENT_SCHEMAS.Choreography, doc);
  });

  test('changed fora de expect (waitFor, assert, checkpoint.until, block.when, repeat.until, condição solta) é recusado no state', () => {
    const cases: [string, unknown][] = [
      ['prepare[0].condition.state', { do: 'waitFor', condition: changed }],
      ['prepare[0].condition.all[0].state', { do: 'assert', condition: { all: [changed] } }],
      [
        'prepare[0].until.state',
        { id: 'cp', do: 'checkpoint', who: 'human', ask: 'x', until: changed, timeoutMs: 1000, onTimeout: 'pause' },
      ],
      ['prepare[0].when.not.state', { do: 'block', when: { not: changed }, steps: [] }],
      ['prepare[0].repeat.until.state', { do: 'tap', target: { label: 'Sync' }, repeat: { until: changed, max: 3 } }],
      [
        'prepare[0].steps[0].condition.state',
        { do: 'block', steps: [{ do: 'waitFor', condition: changed, expect: changed }] },
      ],
    ];
    for (const [path, step] of cases) {
      const doc = choreographyFixture() as unknown as Record<string, any>;
      doc['prepare'].push(step);
      assertRejected(DOCUMENT_SCHEMAS.Choreography, doc, path, RULES.changedOnlyInExpect);
      assertThrowsCode(() => parseChoreography(doc), 'E_CHOREO_INVALID', path);
    }
    assertRejected(DOCUMENT_SCHEMAS.Condition, changed, 'state', RULES.changedOnlyInExpect);
  });
});

// ── Válidos e inválidos de cada tipo ────────────────────────────────────────────────────────────────

interface InvalidFixture {
  type: string;
  method?: string;
  expect: { path: string; rule: string; code?: ErrorCode };
  value: unknown;
}

const PROTOCOL_TYPES = [
  'Point', 'Target', 'Condition', 'Step', 'Choreography', 'CompiledChoreography', 'TreeNode', 'Event',
  'RpcRequest', 'RpcResponse', 'RpcNotification', 'RpcError',
];
const ARTIFACT_TYPES = ['Config', 'EventsJson', 'TakeManifest', 'StatusFile', 'VoiceFile', 'PreflightReport', 'SyncReport'];

const CHOREO_PARSERS: Record<string, (v: unknown) => unknown> = {
  Choreography: parseChoreography,
  CompiledChoreography: parseCompiledChoreography,
  Target: parseTarget,
  Point: (v) => parseOrThrow(DOCUMENT_SCHEMAS.Point, v, 'E_CHOREO_INVALID', 'ponto'),
  Condition: (v) => parseOrThrow(DOCUMENT_SCHEMAS.Condition, v, 'E_CHOREO_INVALID', 'condição'),
  Step: (v) => parseOrThrow(DOCUMENT_SCHEMAS.Step, v, 'E_CHOREO_INVALID', 'passo'),
};

describe('casos válidos e inválidos de cada tipo de S0', () => {
  for (const [dir, types] of [
    [PROTOCOL, PROTOCOL_TYPES],
    [ARTIFACTS, ARTIFACT_TYPES],
  ] as const) {
    test(`${dir === PROTOCOL ? 'protocol' : 'artifacts'}: cada tipo tem ao menos uma fixture válida e uma inválida`, () => {
      const valid = new Set(jsonFiles(dir).map((f) => splitName(f).type));
      const invalid = new Set(jsonFiles(join(dir, 'invalid')).map((f) => splitName(f).type));
      for (const type of types) {
        assert.ok(valid.has(type), `sem fixture válida de ${type}`);
        assert.ok(invalid.has(type), `sem fixture inválida de ${type}`);
      }
    });

    for (const file of jsonFiles(join(dir, 'invalid'))) {
      test(`inválida: ${dir === PROTOCOL ? 'protocol' : 'artifacts'}/invalid/${file}`, () => {
        const fixture = readJson(join(dir, 'invalid', file)) as InvalidFixture;
        assert.equal(fixture.type, splitName(file).type);
        const schema = schemaFor(fixture.type, fixture.method ?? '');
        assertRejected(schema, fixture.value, fixture.expect.path, fixture.expect.rule);
        if (fixture.expect.code) {
          const parser = fixture.type === 'Config' ? parseConfig : CHOREO_PARSERS[fixture.type];
          assert.ok(parser, `sem parser com código para ${fixture.type}`);
          assertThrowsCode(() => parser(fixture.value), fixture.expect.code, fixture.expect.path);
        }
      });
    }
  }

  for (const file of jsonFiles(ARTIFACTS)) {
    test(`válida: artifacts/${file} decodifica e recodifica sem perda`, () => {
      const { type } = splitName(file);
      const original = readJson(join(ARTIFACTS, file));
      const decoded = assertAccepted(schemaFor(type, ''), original);
      assert.deepEqual(JSON.parse(JSON.stringify(decoded)), original);
    });
  }
});

describe('configuração (S0.1) no esquema', () => {
  test('config/defaults.json e o carregamento da T-0.1 passam no ConfigSchema', () => {
    assertAccepted(ConfigSchema, readJson(DEFAULTS_PATH));
    const loaded = loadConfig({ configPath: join(FIXTURES, 'nao-existe', 'config.json') });
    assertAccepted(ConfigSchema, loaded);
  });

  test('time diferente de 984PNJZ8B9 e campo desconhecido → E_CONFIG com o caminho', () => {
    const defaults = readJson(DEFAULTS_PATH) as Record<string, any>;
    const team = clone(defaults);
    team['signing']['team'] = 'V4397KJVXZ';
    assertThrowsCode(() => parseConfig(team), 'E_CONFIG', 'signing.team');
    const typo = clone(defaults);
    typo['paths']['ffmpg'] = '/usr/local/bin/ffmpeg';
    assertThrowsCode(() => parseConfig(typo), 'E_CONFIG', 'paths.ffmpg');
    const px = clone(defaults);
    px['runner']['privateAllowed'] = ['PX-7'];
    assertThrowsCode(() => parseConfig(px), 'E_CONFIG', 'runner.privateAllowed[0]');
  });
});

describe('protocolo: envelope e métodos de base (S0.5)', () => {
  test('pedido sem método conhecido valida só o envelope; resposta e notificação idem', () => {
    assertAccepted(rpcRequestSchemaFor('ui.tree'), { jsonrpc: '2.0', id: 'a1', method: 'ui.tree', params: { format: 'json' } });
    assertAccepted(rpcNotificationSchemaFor('log'), { jsonrpc: '2.0', method: 'log', params: { line: 'x' } });
    assertRejected(rpcRequestSchemaFor('health'), { jsonrpc: '2.0', id: 1.5, method: 'health', params: {} }, 'id', RULES.type);
    assertRejected(rpcRequestSchemaFor('health'), { jsonrpc: '2.0', id: 1, method: 'health', params: { x: 1 } }, 'params.x', RULES.unknownField);
    assertRejected(
      rpcRequestSchemaFor('health'),
      { jsonrpc: '2.0', id: 1, method: 'clock.ping', params: {} },
      'method',
      RULES.value,
    );
  });

  test('clock.ping: pad até 64 KB', () => {
    const schema = rpcRequestSchemaFor('clock.ping');
    assertAccepted(schema, { jsonrpc: '2.0', id: 9, method: 'clock.ping', params: { seq: 1, pad: 'x'.repeat(65536) } });
    assertRejected(schema, { jsonrpc: '2.0', id: 9, method: 'clock.ping', params: { seq: 1, pad: 'x'.repeat(65537) } }, 'params.pad', RULES.padMax);
  });

  test('erro: o código tem de ser da tabela de S0.5 (a de errors.ts) ou do JSON-RPC 2.0', () => {
    const failure = DOCUMENT_SCHEMAS.RpcError;
    for (const [name, code] of Object.entries(RPC_ERROR_CODES)) {
      assertAccepted(failure, { jsonrpc: '2.0', id: 3, error: { code, message: name } });
    }
    assertAccepted(failure, { jsonrpc: '2.0', id: null, error: { code: -32601, message: 'Method not found' } });
    assertRejected(failure, { jsonrpc: '2.0', id: 3, error: { code: -32099, message: '?' } }, 'error.code', RULES.value);
  });

  test('envelope genérico (RpcMessage): classifica pedido, notificação, sucesso e erro pela forma', () => {
    const message = DOCUMENT_SCHEMAS.RpcMessage;
    const request = { jsonrpc: '2.0', id: 7, method: 'ui.tree', params: { format: 'json' } };
    const notification = { jsonrpc: '2.0', method: 'event', params: { seq: 1, kind: 'take.start' } };
    const success = { jsonrpc: '2.0', id: 7, result: { treeVersion: 3, nodes: [] } };
    const failure = { jsonrpc: '2.0', id: 'x', error: { code: -32010, message: 'E_TARGET_NOT_FOUND', data: { target: { label: 'Play' } } } };
    const nullIdFailure = { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } };
    for (const valid of [request, notification, success, failure, nullIdFailure]) {
      assert.deepEqual(assertAccepted(message, valid), valid);
    }
    for (const file of jsonFiles(PROTOCOL).filter((f) => f.startsWith('Rpc'))) {
      assertAccepted(message, readJson(join(PROTOCOL, file)));
    }
    const cases: [unknown, string, string][] = [
      [{ jsonrpc: '2.0', id: 7, result: 1, error: { code: -32603, message: 'x' } }, 'result', RULES.unknownField],
      [{ jsonrpc: '2.0', method: 'event', result: 1 }, 'result', RULES.unknownField],
      [{ jsonrpc: '2.0', id: 7, method: 'health', result: {} }, 'result', RULES.unknownField],
      [{ jsonrpc: '2.0', id: 7 }, '', RULES.type],
      [{ jsonrpc: '1.0', id: 7, result: {} }, 'jsonrpc', RULES.value],
      [{ jsonrpc: '2.0', id: 7, method: 'health', params: [1, 2] }, 'params', RULES.type],
      [{ jsonrpc: '2.0', id: 7, error: { code: -32099, message: '?' } }, 'error.code', RULES.value],
      [['não', 'é', 'objeto'], '', RULES.type],
    ];
    for (const [value, path, rule] of cases) assertRejected(message, value, path, rule);
  });
});

// ── Servidor WebSocket de teste ─────────────────────────────────────────────────────────────────────

const servers: WsTestServer[] = [];
after(async () => {
  await Promise.all(servers.map((s) => s.close()));
});

async function server(options: Parameters<typeof startWsServer>[0] = {}): Promise<WsTestServer> {
  const s = await startWsServer(options);
  servers.push(s);
  return s;
}

function openClient(url: string, protocols?: string[]): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, protocols);
    ws.addEventListener('open', () => resolve(ws), { once: true });
    ws.addEventListener('error', () => reject(new Error(`não conectou em ${url}`)), { once: true });
  });
}

function nextClientMessage(ws: WebSocket): Promise<string> {
  return new Promise((resolve) => {
    ws.addEventListener('message', (e) => resolve(String(e.data)), { once: true });
  });
}

function clientClosed(ws: WebSocket): Promise<{ code: number; reason: string; wasClean: boolean }> {
  return new Promise((resolve) => {
    ws.addEventListener('close', (e) => resolve({ code: e.code, reason: e.reason, wasClean: e.wasClean }), { once: true });
  });
}

/** Cliente cru sobre TCP: faz o handshake e devolve o socket com os bytes que sobraram. */
async function rawClient(port: number): Promise<{ socket: Socket; received: () => Buffer }> {
  const socket = connect(port, '127.0.0.1');
  let buffer = Buffer.alloc(0);
  socket.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
  });
  await new Promise<void>((resolve) => socket.once('connect', () => resolve()));
  const key = Buffer.from('0123456789abcdef').toString('base64');
  socket.write(
    `GET / HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
      `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
  );
  await waitFor(() => buffer.includes('\r\n\r\n'));
  const head = buffer.subarray(0, buffer.indexOf('\r\n\r\n') + 4).toString('latin1');
  assert.match(head, /^HTTP\/1\.1 101 /);
  assert.ok(head.includes(`Sec-WebSocket-Accept: ${acceptKey(key)}`));
  buffer = buffer.subarray(buffer.indexOf('\r\n\r\n') + 4);
  return { socket, received: () => buffer };
}

function clientFrame(opcode: number, payload: Buffer, { fin = true, masked = true } = {}): Buffer {
  const mask = Buffer.from([1, 2, 3, 4]);
  const head = [(fin ? 0x80 : 0) | opcode, (masked ? 0x80 : 0) | payload.length];
  const body = masked ? Buffer.from(payload.map((b, i) => b ^ mask[i % 4]!)) : payload;
  return Buffer.concat([Buffer.from(head), masked ? mask : Buffer.alloc(0), body]);
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('tempo esgotado esperando a condição');
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('servidor WebSocket de teste (helpers/ws-server.ts)', () => {
  test('aceita a conexão, ecoa texto (curto, 16 e 64 bits de tamanho) e fecha quando o cliente fecha', async () => {
    const s = await server({ onConnection: (c) => c.onMessage((t) => c.send(t)) });
    const ws = await openClient(s.url);
    const conn = await s.nextConnection();
    for (const text of ['olá', 'x'.repeat(300), 'y'.repeat(70_000)]) {
      const reply = nextClientMessage(ws);
      ws.send(text);
      assert.equal(await reply, text);
    }
    assert.equal(conn.messages.length, 3);
    const closedByClient = clientClosed(ws);
    ws.close(1000, 'fim');
    assert.deepEqual(await conn.closed, { code: 1000, reason: 'fim', clean: true });
    assert.equal((await closedByClient).code, 1000);
    await waitFor(() => s.connections.size === 0);
  });

  test('o servidor fecha a conexão com código e motivo; close() do servidor fecha todas com 1001', async () => {
    const s = await server();
    const a = await openClient(s.url);
    const connA = await s.nextConnection();
    const aClosed = clientClosed(a);
    const info = await connA.close(4000, 'tchau');
    assert.equal(info.clean, true);
    assert.deepEqual(await aClosed, { code: 4000, reason: 'tchau', wasClean: true });

    const b = await openClient(s.url);
    await s.nextConnection();
    const bClosed = clientClosed(b);
    await s.close();
    assert.equal((await bClosed).code, 1001);
    await assert.rejects(openClient(s.url));
  });

  test('motivo de fechamento longo em português é cortado em fronteira de caractere (≤ 123 bytes) e o fechamento fica limpo', async () => {
    const s = await server();
    for (const reason of ['é'.repeat(70), `Encerrando a sessão de ensaio: ${'ação '.repeat(30)}`, `x${'ç'.repeat(80)}`]) {
      const ws = await openClient(s.url);
      const conn = await s.nextConnection();
      const closed = clientClosed(ws);
      const info = await conn.close(4000, reason);
      const seen = await closed;
      assert.equal(seen.code, 4000, `o cliente deveria receber 4000 (veio ${seen.code})`);
      assert.equal(seen.wasClean, true);
      assert.ok(Buffer.byteLength(seen.reason, 'utf8') <= 123, `motivo com ${Buffer.byteLength(seen.reason)} bytes`);
      assert.ok(Buffer.byteLength(seen.reason, 'utf8') >= 121, 'o corte deveria aproveitar até 123 bytes');
      assert.ok(reason.startsWith(seen.reason), 'o motivo recebido é um prefixo do enviado');
      assert.equal(info.clean, true);
      assert.notEqual(info.code, 1007);
    }
  });

  test('terminate() derruba sem quadro de fechamento (1006 no cliente)', async () => {
    const s = await server();
    const ws = await openClient(s.url);
    const conn = await s.nextConnection();
    const closed = clientClosed(ws);
    conn.terminate();
    assert.equal((await closed).code, 1006);
    assert.equal((await conn.closed).clean, false);
  });

  test('JSON-RPC por cima: session.hello com a fixture do protocolo', async () => {
    const response = readJson(join(PROTOCOL, 'RpcResponse.session.hello.json'));
    const s = await server({
      onConnection: (c) =>
        c.onMessage((text) => {
          const req = validate(rpcRequestSchemaFor('session.hello'), JSON.parse(text));
          assert.ok(req.ok);
          c.sendJson(response);
        }),
    });
    const ws = await openClient(s.url);
    const request = readJson(join(PROTOCOL, 'RpcRequest.session.hello.json'));
    const reply = nextClientMessage(ws);
    ws.send(JSON.stringify(request));
    const result = assertAccepted(rpcResponseSchemaFor('session.hello'), JSON.parse(await reply));
    assertAccepted(SessionHelloResultSchema, (result as { result: JsonValue }).result);
    ws.close();
  });

  test('subprotocolo: escolhe o primeiro oferecido que o servidor aceita', async () => {
    const s = await server({ protocols: ['obswebsocket.json'] });
    const ws = await openClient(s.url, ['obswebsocket.msgpack', 'obswebsocket.json']);
    assert.equal(ws.protocol, 'obswebsocket.json');
    assert.equal((await s.nextConnection()).protocol, 'obswebsocket.json');
    ws.close();
  });

  test('handshake: pedido HTTP comum → 426; upgrade sem chave → 400', async () => {
    const s = await server();
    const plain = await fetch(s.url.replace('ws:', 'http:'));
    assert.equal(plain.status, 426);
    await plain.arrayBuffer();
    const { socket, received } = await (async () => {
      const sock = connect(s.port, '127.0.0.1');
      let buf = Buffer.alloc(0);
      sock.on('data', (c: Buffer) => (buf = Buffer.concat([buf, c])));
      await new Promise<void>((r) => sock.once('connect', () => r()));
      sock.write('GET / HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\n\r\n');
      return { socket: sock, received: () => buf };
    })();
    await waitFor(() => received().includes('\r\n'));
    assert.match(received().toString('latin1'), /^HTTP\/1\.1 400 /);
    socket.destroy();
  });

  test('quadros: mensagem fragmentada é remontada; ping recebe pong; quadro sem máscara fecha com 1002', async () => {
    const s = await server();
    const { socket, received } = await rawClient(s.port);
    const conn: WsTestConnection = await s.nextConnection();
    const message = conn.nextMessage();
    socket.write(clientFrame(0x1, Buffer.from('par'), { fin: false }));
    socket.write(clientFrame(0x0, Buffer.from('tes'), { fin: false }));
    socket.write(clientFrame(0x0, Buffer.from(' ok')));
    assert.equal(await message, 'partes ok');

    socket.write(clientFrame(0x9, Buffer.from('p1')));
    await waitFor(() => received().length >= 4);
    assert.equal(received()[0], 0x8a);
    assert.equal(received().subarray(2, 4).toString(), 'p1');

    socket.write(clientFrame(0x1, Buffer.from('sem máscara'), { masked: false }));
    const info = await conn.closed;
    assert.equal(info.code, 1002);
    await waitFor(() => received().length >= 8);
    const close = received().subarray(4);
    assert.equal(close[0], 0x88);
    assert.equal(close.readUInt16BE(2), 1002);
    socket.destroy();
  });
});
