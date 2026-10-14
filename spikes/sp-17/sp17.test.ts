// Testes do driver do SP-17 (T-0.37) sem aparelho: `node --test spikes/sp-17/sp17.test.ts`. O "aparelho" é um
// `devicectl` falso com um contêiner em memória (só aceita o `--domain-identifier` do `.xctrunner`) e uma lista de
// processos; o "runner" é um `Rpc` falso com um Hagah de mentira (frente, capítulo, PID) e um pedido do sistema
// opcional que fica à frente como camada do SpringBoard.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { ContrarregraError } from '../../mac/src/core/errors.ts';
import type { TreeNode } from '../../mac/src/core/types.ts';
import {
  COPY_LIMIT_MS,
  LinkStop,
  RunnerContainer,
  appFragment,
  containerPath,
  frontFromRefusal,
  linkCases,
  miniPlayer,
  readerTitle,
  markdownLinks,
  markdownPulls,
  otherSpikes,
  parseAppPath,
  parseAppPids,
  parseFileList,
  parseRunnerPids,
  probeNdjson,
  pullPhase,
  readPids,
  runnerContainerId,
  seedFromMac,
  seedFromRunner,
  seedPath,
  sha256,
  showsPsalm,
  summarizePulls,
  type Devicectl,
  type DevicectlRun,
  type FsEnv,
  type Json,
  type LinkEnv,
  type PidRead,
  type Rpc,
} from './lib.ts';

const DEVICE = 'B0A1C2D3-0000-4000-8000-00000000AAAA';
const RUNNER_TEST = 'app.kifactory.contrarregra.runner';
const CONTAINER = 'app.kifactory.contrarregra.runner.xctrunner';
const HAGAH = 'app.kifactory.hagah';
const HAGAH_URL = 'file:///private/var/containers/Bundle/Application/1111-HAGAH/Hagah.app/';
const HAGAH_PATH = '/var/containers/Bundle/Application/1111-HAGAH/Hagah.app/';

const roots: string[] = [];
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sp17-'));
  roots.push(dir);
  return dir;
}
after(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

function fsEnv(log: Json[] = []): FsEnv {
  const base = tmp();
  let i = 0;
  return {
    tmpDir: () => {
      const dir = join(base, `t${i++}`);
      mkdirSync(dir);
      return dir;
    },
    write: (k, data) => log.push({ k, ...data }),
    now: () => 1_760_000_000_000,
  };
}

function opt(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i < 0 ? undefined : argv[i + 1];
}

/** `devicectl` falso: contêiner em memória (`copy to`/`copy from`/`info files`) e processos; recusa outro contêiner. */
class FakeDevicectl {
  readonly files = new Map<string, Buffer>();
  readonly calls: string[][] = [];
  processes: Json[] = [];
  /** Tempo de cada cópia (ms), por chamada. */
  copyMs = 1_200;
  /** Estraga o próximo `copy from` (um byte trocado). */
  corruptNext = false;
  filterWorks = true;

  readonly run: Devicectl = async (args: string[]): Promise<DevicectlRun> => {
    this.calls.push(args);
    const [, group, verb] = args;
    if (opt(args, '--domain-type') !== undefined) {
      assert.equal(opt(args, '--domain-type'), 'appDataContainer');
      assert.equal(opt(args, '--domain-identifier'), CONTAINER, 'só o contêiner do .xctrunner do Contrarregra');
    }
    if (group === 'copy' && verb === 'to') {
      this.files.set(opt(args, '--destination') as string, readFileSync(opt(args, '--source') as string));
      return { ok: true, json: { result: {} }, dtMs: this.copyMs };
    }
    if (group === 'copy' && verb === 'from') {
      const data = this.files.get(opt(args, '--source') as string);
      if (data === undefined) return { ok: false, json: undefined, dtMs: 300, err: 'exit 1 file not found' };
      const copy = Buffer.from(data);
      if (this.corruptNext) {
        copy[10] = (copy[10] as number) ^ 0xff;
        this.corruptNext = false;
      }
      writeFileSync(opt(args, '--destination') as string, copy);
      return { ok: true, json: { result: {} }, dtMs: this.copyMs };
    }
    if (group === 'info' && verb === 'files') {
      return { ok: true, json: { result: { files: [...this.files].map(([p, d]) => ({ relativePath: p, metadata: { size: d.length }, resources: { isDirectory: false } })) } }, dtMs: 800 };
    }
    if (group === 'info' && verb === 'processes') {
      const filter = opt(args, '--filter');
      if (filter !== undefined && !this.filterWorks) return { ok: false, json: undefined, dtMs: 200, err: 'exit 1 predicate' };
      const fragment = filter === undefined ? undefined : /CONTAINS '(.*)'/.exec(filter)?.[1];
      const procs = fragment === undefined ? this.processes : this.processes.filter((p) => String(p['executable']).includes(fragment));
      return { ok: true, json: { result: { runningProcesses: procs } }, dtMs: 900 };
    }
    throw new Error(`devicectl falso: ${args.join(' ')}`);
  };
}

describe('contêiner do runner', () => {
  it('o bundle do .xctrunner vem de bundle.runnerTest e nada mais', () => {
    assert.equal(runnerContainerId(RUNNER_TEST), CONTAINER);
    assert.throws(() => runnerContainerId('app.kifactory.hagah; rm'), /inválido/);
    assert.throws(() => runnerContainerId(CONTAINER), /inválido/);
  });

  it('argumentos do devicectl presos ao contêiner; caminhos relativos e sem ..', () => {
    const c = new RunnerContainer(async () => ({ ok: true, json: {}, dtMs: 0 }), DEVICE, RUNNER_TEST);
    assert.deepEqual(c.pullArgs('Documents/contrarregra/x/events.ndjson', '/tmp/a'), [
      'device', 'copy', 'from', '--device', DEVICE, '--domain-type', 'appDataContainer', '--domain-identifier', CONTAINER,
      '--source', 'Documents/contrarregra/x/events.ndjson', '--destination', '/tmp/a',
    ]);
    assert.equal(opt(c.pushArgs('/tmp/a', 'Documents/a'), '--domain-identifier'), CONTAINER);
    assert.equal(opt(c.listArgs(), '--domain-identifier'), CONTAINER);
    for (const bad of ['/etc/passwd', '../x', 'Documents/../../x', 'Documents//x', '']) {
      assert.throws(() => containerPath(bad), /recusado/, bad);
      assert.throws(() => c.pullArgs(bad, '/tmp/a'), /recusado/, bad);
    }
  });

  it('seedPath segue Documents/contrarregra/<pasta>/events.ndjson e recusa rótulos estranhos', () => {
    assert.equal(seedPath('r1', 65536), 'Documents/contrarregra/sp17-r1-65536/events.ndjson');
    assert.throws(() => seedPath('../x', 1024), /inválido/);
    assert.throws(() => seedPath('A B', 1024), /inválido/);
  });

  it('listagem: caminhos e tamanhos na forma do devicectl 518.33', () => {
    const files = parseFileList({ result: { files: [
      { relativePath: 'Documents/a', metadata: { size: 3 }, resources: { isDirectory: false } },
      { relativePath: 'Library', metadata: { size: 192 }, resources: { isDirectory: true } },
    ] } });
    assert.deepEqual(files, [{ path: 'Documents/a', size: 3, dir: false }, { path: 'Library', size: null, dir: true }]);
    assert.deepEqual(parseFileList(undefined), []);
  });
});

describe('prova em NDJSON', () => {
  it('tamanho exato, determinística, linhas de evento com seq contínuo', () => {
    for (const bytes of [1024, 4099, 65_536, 1_048_576]) {
      const a = probeNdjson(bytes, `r1-${bytes}`);
      assert.equal(a.length, bytes);
      assert.equal(sha256(a), sha256(probeNdjson(bytes, `r1-${bytes}`)));
      const lines = a.toString('utf8').split('\n');
      assert.equal(lines.pop(), '', 'termina em \\n');
      lines.forEach((line, i) => {
        const e = JSON.parse(line) as { schema: string; seq: number };
        assert.equal(e.schema, 'contrarregra.events/1');
        assert.equal(e.seq, i);
      });
    }
    assert.notEqual(sha256(probeNdjson(4096, 'a')), sha256(probeNdjson(4096, 'b')));
    assert.throws(() => probeNdjson(100, 'a'), /mínimo/);
  });
});

describe('processos', () => {
  const procs: Json[] = [
    { executable: `${HAGAH_URL}Hagah`, processIdentifier: 812 },
    { executable: `${HAGAH_URL}PlugIns/Widget.appex/Widget`, processIdentifier: 813 },
    { executable: 'file:///private/var/containers/Bundle/Application/2222/Other.app/Other', processIdentifier: 900 },
    { executable: 'file:///private/var/containers/Bundle/Application/3333/ContrarregraRunner-Runner.app/ContrarregraRunner-Runner', processIdentifier: 777 },
  ];

  it('caminho e fragmento do Hagah; só o executável principal conta', () => {
    const json = { result: { apps: [{ bundleIdentifier: HAGAH, url: HAGAH_URL }, { bundleIdentifier: 'x', url: 'file:///a/X.app/' }] } };
    assert.equal(parseAppPath(json, HAGAH), HAGAH_PATH);
    assert.equal(parseAppPath(json, 'nope'), undefined);
    assert.equal(appFragment(HAGAH_PATH), '1111-HAGAH/Hagah.app/');
    assert.deepEqual(parseAppPids({ result: { runningProcesses: procs } }, HAGAH_PATH), [812]);
    assert.deepEqual(parseRunnerPids({ result: { runningProcesses: procs } }), [777]);
  });

  it('filtro do devicectl; se falhar, lista inteira filtrada só em memória', async () => {
    const dc = new FakeDevicectl();
    dc.processes = procs;
    const a = await readPids(dc.run, DEVICE, appFragment(HAGAH_PATH), (j) => parseAppPids(j, HAGAH_PATH));
    assert.deepEqual([a.ok, a.filtered, a.pids], [true, true, [812]]);
    dc.filterWorks = false;
    const b = await readPids(dc.run, DEVICE, appFragment(HAGAH_PATH), (j) => parseAppPids(j, HAGAH_PATH));
    assert.deepEqual([b.ok, b.filtered, b.pids], [true, false, [812]]);
    await assert.rejects(readPids(dc.run, DEVICE, "x' OR 1", () => []), /aspa/);
  });
});

describe('semear e puxar', () => {
  it('Mac escreve, puxa idêntico nos estados; byte trocado e arquivo sumido aparecem', async () => {
    const dc = new FakeDevicectl();
    const c = new RunnerContainer(dc.run, DEVICE, RUNNER_TEST);
    const log: Json[] = [];
    const env = fsEnv(log);
    const seeded = await seedFromMac(c, env, 'r1', [4096, 65_536]);
    assert.deepEqual(seeded.map((s) => s.path), [seedPath('r1', 4096), seedPath('r1', 65_536)]);
    assert.equal(sha256(dc.files.get(seedPath('r1', 4096)) as Buffer), seeded[0]?.sha256);

    const live = await pullPhase(c, env, seeded, 'live', 3);
    assert.equal(live.length, 6);
    assert.ok(live.every((s) => s.ok && s.same && s.gotBytes === s.bytes));

    dc.corruptNext = true;
    const stopped = await pullPhase(c, env, seeded, 'stopped', 1);
    assert.deepEqual(stopped.map((s) => s.same), [false, true]);

    dc.files.delete(seedPath('r1', 65_536));
    const reup = await pullPhase(c, env, seeded, 'reup', 1);
    assert.deepEqual(reup.map((s) => [s.ok, s.same]), [[true, true], [false, false]]);

    const summary = summarizePulls([...live, ...stopped, ...reup]);
    const row = (state: string, bytes: number) => summary.find((r) => r.state === state && r.bytes === bytes);
    assert.equal(row('live', 4096)?.pass, true);
    assert.equal(row('live', 65_536)?.p50Ms, 1_200);
    assert.equal(row('stopped', 4096)?.pass, false);
    assert.equal(row('reup', 65_536)?.pass, false);
    assert.match(markdownPulls(summary), /\| live \| mac \| 4096 B \| 3\/3 \| 3\/3 \| 1200 ms \| 1200 ms \| sim \|/);
  });

  it('acima de 5 s não passa, mesmo idêntico', async () => {
    const dc = new FakeDevicectl();
    const c = new RunnerContainer(dc.run, DEVICE, RUNNER_TEST);
    const env = fsEnv();
    const seeded = await seedFromMac(c, env, 'slow', [4096]);
    dc.copyMs = COPY_LIMIT_MS + 1;
    const [row] = summarizePulls(await pullPhase(c, env, seeded, 'live', 2));
    assert.deepEqual([row?.same, row?.pass], [2, false]);
  });

  it('runner escreve e diz o hash; sem o método, o erro aponta o G5', async () => {
    const ok: Rpc = {
      call: async <T>(method: string, params?: Record<string, unknown>): Promise<T> => {
        assert.equal(method, 'spike.logWrite');
        const bytes = params?.['bytes'] as number;
        const data = probeNdjson(bytes, 'x');
        return { path: `Documents/contrarregra/${params?.['dir'] as string}/events.ndjson`, bytes, sha256: sha256(data) } as T;
      },
    };
    const seeded = await seedFromRunner(ok, fsEnv(), 'r2', [2048]);
    assert.deepEqual([seeded[0]?.source, seeded[0]?.path, seeded[0]?.bytes], ['runner', seedPath('r2', 2048), 2048]);
    const absent: Rpc = { call: async () => { throw new Error('spike.logWrite: method not found (JSON-RPC -32601)'); } };
    await assert.rejects(seedFromRunner(absent, fsEnv(), 'r2', [2048]), /G5 pendente/);
  });
});

describe('link pelo runner', () => {
  it('frente pela recusa do ui.tree', () => {
    assert.equal(frontFromRefusal('ui.tree de app.kifactory.hagah recusado com a tela de início à frente (S1 item 11)'), 'home');
    assert.equal(frontFromRefusal('ui.tree de app.kifactory.hagah recusado com uma camada do SpringBoard (notificações, alternador, Spotlight, alerta ou não identificada) à frente'), 'layer');
    assert.equal(frontFromRefusal('… com a tela travada à frente'), 'locked');
    assert.equal(frontFromRefusal('… algo que o runner não provou …'), 'other');
  });

  it('Salmo 1 só pelo título do leitor; mini-player, 10 e 1:2 não contam', () => {
    const node = (label: string, y = 120): TreeNode => ({ ref: '@e1', type: 'button', label, frame: { x: 0, y, w: 100, h: 30 }, enabled: true, selected: false, visible: true, depth: 1 });
    assert.ok(showsPsalm([node('Psalms 1')], 1));
    assert.ok(showsPsalm([node('Psalms 1, go down')], 1), 'rótulo do build 7');
    assert.equal(readerTitle([node('Psalms 1, go down')]), 'Psalms 1, go down');
    assert.equal(miniPlayer([node('Open Now Playing: Psalms 23, NIV', 705)]), 'Open Now Playing: Psalms 23, NIV');
    assert.ok(!showsPsalm([node('Open Now Playing: Psalms 1, NIV', 705)], 1), 'o mini-player diz o áudio, não a página');
    assert.ok(!showsPsalm([node('Psalms 10')], 1));
    assert.ok(!showsPsalm([node('Psalms 1:2')], 1));
    assert.ok(!showsPsalm([node('Psalms 1', 600)], 1), 'título fora do alto');
    assert.ok(showsPsalm([node('Psalms 23')], 23));
  });

  /** Hagah falso atrás do runner falso. */
  function fakeWorld(opts: { prompt?: 'none' | 'stays'; relaunchOnOpen?: boolean; locked?: boolean } = {}) {
    const w = {
      t: 0,
      running: true,
      pid: 500,
      nextPid: 600,
      chapter: 7,
      front: 'hagah' as 'hagah' | 'home' | 'layer',
      locked: opts.locked ?? false,
      calls: [] as string[],
    };
    const refuse = (what: string): never => {
      throw new ContrarregraError('E_FORBIDDEN_APP', `ui.tree de ${HAGAH} recusado com ${what} à frente (S1 item 11)`);
    };
    const rpc: Rpc = {
      call: async <T>(method: string, params?: Record<string, unknown>): Promise<T> => {
        w.t += 150;
        w.calls.push(method === 'app.openURL' ? `${method} ${params?.['url'] as string}` : method);
        switch (method) {
          case 'ui.tree': {
            if (w.locked) refuse('a tela travada');
            if (w.front === 'home') refuse('a tela de início');
            if (w.front === 'layer') refuse('uma camada do SpringBoard (notificações, alternador, Spotlight, alerta ou não identificada)');
            const title: TreeNode = { ref: '@e1', type: 'button', label: `Psalms ${w.chapter}, go down`, frame: { x: 120, y: 100, w: 150, h: 30 }, enabled: true, selected: false, visible: true, depth: 2 };
            return { nodes: [{ ref: '@e0', type: 'application', label: 'Hagah', frame: { x: 0, y: 0, w: 390, h: 844 }, enabled: true, selected: false, visible: true, depth: 0, children: [title] }] } as T;
          }
          case 'app.openURL': {
            const m = /PSA\/(\d+)$/.exec(params?.['url'] as string);
            assert.ok(m !== null);
            if (opts.prompt === 'stays' && Number(m[1]) === 1) {
              w.front = 'layer';
              return { tDevStartNs: '1', tDispatchNs: '2', tDevEndNs: '3' } as T;
            }
            w.t += 2_000;
            if (!w.running || opts.relaunchOnOpen) {
              w.running = true;
              w.pid = w.nextPid++;
            }
            w.front = 'hagah';
            w.chapter = Number(m[1]);
            return { tDevStartNs: '1', tDispatchNs: '2', tDevEndNs: '3' } as T;
          }
          case 'device.home':
            w.front = 'home';
            return {} as T;
          case 'app.terminate':
            w.running = false;
            w.front = 'home';
            return {} as T;
          case 'app.state':
            return { state: !w.running ? 'notRunning' : w.front === 'hagah' ? 'foreground' : 'background' } as T;
          case 'health':
            return { xctestQueueDepth: 0 } as T;
          default:
            throw new Error(`runner falso: ${method}`);
        }
      },
    };
    const env: LinkEnv = {
      rpc,
      bundleId: HAGAH,
      hagahPids: async (): Promise<PidRead> => ({ ok: true, pids: w.running ? [w.pid] : [], dtMs: 900, filtered: true }),
      write: () => undefined,
      now: () => w.t,
      sleep: async (ms) => {
        w.t += ms;
      },
    };
    return { w, env };
  }

  it('sem pedido: mesmo PID à frente e em segundo plano, PID novo a frio, Salmo 1 à frente', async () => {
    const { w, env } = fakeWorld();
    const { results, stop } = await linkCases(env, ['front', 'background', 'cold']);
    assert.equal(stop, undefined);
    assert.deepEqual(results.map((r) => [r.kind, r.stateBefore, r.samePid, r.arrived, r.prompt]), [
      ['front', 'foreground', true, true, 'none'],
      ['background', 'background', true, true, 'none'],
      ['cold', 'notRunning', null, true, 'none'],
    ]);
    assert.deepEqual(results[2]?.pidsBefore, []);
    assert.deepEqual(results[2]?.pidsAfter, [600]);
    assert.deepEqual(results[1]?.fronts, ['hagah']);
    assert.ok((results[0]?.arrivedMs ?? 0) >= 2_000);
    // cada caso parte do Salmo 23 (o Salmo 1 só aparece pelo link medido)
    const opened = w.calls.filter((c) => c.startsWith('app.openURL')).map((c) => c.slice(-6));
    assert.deepEqual(opened, ['PSA/23', '/PSA/1', 'PSA/23', '/PSA/1', 'PSA/23', '/PSA/1']);
    assert.match(markdownLinks(results), /\| cold \| notRunning \| — \| 600 \| — \|/);
  });

  it('link que relança o Hagah: PID muda', async () => {
    const { env } = fakeWorld({ relaunchOnOpen: true });
    const { results } = await linkCases(env, ['front']);
    assert.equal(results[0]?.samePid, false);
  });

  it('pedido do sistema que fica: camada vista, para e não toca nela', async () => {
    const { w, env } = fakeWorld({ prompt: 'stays' });
    const { results, stop } = await linkCases(env, ['front', 'cold']);
    assert.ok(stop instanceof LinkStop);
    assert.equal(results.length, 1);
    assert.deepEqual([results[0]?.arrived, results[0]?.prompt, results[0]?.fronts], [false, 'suspected', ['layer']]);
    assert.ok(!w.calls.includes('ui.tap'));
  });

  it('tela travada: para antes de abrir qualquer link', async () => {
    const { w, env } = fakeWorld({ locked: true });
    const { results, stop } = await linkCases(env, ['front']);
    assert.equal(results.length, 0);
    assert.equal(stop?.step, 'reset');
    assert.ok(!w.calls.some((c) => c.startsWith('app.openURL')));
  });
});

describe('um spike por vez', () => {
  it('acha outro driver de spike; ignora o próprio SP-17 e a si mesmo', () => {
    const ps = [
      '  101 /Users/x/.nvm/versions/node/v22.19.0/bin/node spikes/sp-14/sp14.ts run --label a',
      '  102 node /Users/x/project/contrarregra/spikes/sp-17/sp17.ts pull --label b',
      '  103 /bin/zsh -c cd /x && node spikes/sp-3/sp3.ts heavy',
      '  104 /usr/bin/vim notes.md',
      '  105 node spikes/sp-17/sp17.ts link',
    ].join('\n');
    const others = otherSpikes(ps, 105);
    assert.equal(others.length, 2);
    assert.match(others[0] as string, /^101 /);
    assert.match(others[1] as string, /^103 /);
  });
});
