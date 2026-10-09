// Testes da T-0.1: configuração (S0.1, AC-0.5), shims do Node (S8 item 7, E-8.1) e esqueleto do
// repositório (A5). Só biblioteca padrão do Node 22.

import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { subscribe, unsubscribe } from 'node:diagnostics_channel';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { DEFAULTS_PATH, loadConfig, mergeConfig, REQUIRED_TEAM } from '../src/core/config.ts';
import { isContrarregraError } from '../src/core/errors.ts';

const ROOT = realpathSync(fileURLToPath(new URL('../..', import.meta.url)));

const tmpDirs: string[] = [];
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'contrarregra-test-'));
  tmpDirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

function writeJson(path: string, value: unknown): string {
  writeFileSync(path, JSON.stringify(value));
  return path;
}

describe('configuração (S0.1)', () => {
  test('AC-0.5: signing.team ≠ 984PNJZ8B9 → E_CONFIG citando signing.team, sem processo filho nem conexão', () => {
    const configPath = writeJson(join(tmp(), 'config.json'), { signing: { team: 'V4397KJVXZ' } });
    const seen: string[] = [];
    const onChild = (): void => {
      seen.push('child_process');
    };
    const onSocket = (): void => {
      seen.push('net.client.socket');
    };
    subscribe('child_process', onChild);
    subscribe('net.client.socket', onSocket);
    try {
      assert.throws(
        () => loadConfig({ configPath }),
        (err: unknown) => {
          assert.ok(isContrarregraError(err, 'E_CONFIG'), `esperava E_CONFIG, veio ${String(err)}`);
          assert.match(err.message, /signing\.team/);
          assert.equal(err.data?.['field'], 'signing.team');
          assert.equal(err.data?.['value'], 'V4397KJVXZ');
          assert.equal(err.data?.['path'], configPath);
          return true;
        },
      );
    } finally {
      unsubscribe('child_process', onChild);
      unsubscribe('net.client.socket', onSocket);
    }
    assert.deepEqual(seen, []);
  });

  test('AC-0.5: o processo que carrega ~/.config/contrarregra/config.json com outro time sai com código ≠ 0 e E_CONFIG, sem poder criar processo filho', () => {
    const home = tmp();
    mkdirSync(join(home, '.config', 'contrarregra'), { recursive: true });
    writeJson(join(home, '.config', 'contrarregra', 'config.json'), { signing: { team: '59CB45686C' } });
    const moduleUrl = pathToFileURL(join(ROOT, 'mac', 'src', 'core', 'config.ts')).href;
    // O modelo de permissões do Node nega qualquer processo filho: se o carregamento tentasse criar
    // um, o erro seria ERR_ACCESS_DENIED, não E_CONFIG.
    const result = spawnSync(
      process.execPath,
      [
        '--permission',
        '--allow-fs-read=*',
        '--input-type=module',
        '-e',
        `import { loadConfig } from ${JSON.stringify(moduleUrl)}; loadConfig();`,
      ],
      { env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', HOME: home }, encoding: 'utf8', timeout: 10_000 },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /E_CONFIG/);
    assert.match(result.stderr, /signing\.team/);
    assert.doesNotMatch(result.stderr, /ERR_ACCESS_DENIED/);
  });

  test('config.json com o time fixo é mesclado sobre config/defaults.json: objetos chave a chave, listas e valores simples substituem', () => {
    const configPath = writeJson(join(tmp(), 'config.json'), {
      signing: { team: REQUIRED_TEAM },
      runner: { privateAllowed: ['PX-1', 'PX-2', 'PX-3', 'PX-5'] },
      bundle: { displayNames: ['Outro'] },
      app: { explore: 'com.example.app' },
      record: { fps: 30 },
    });
    const config = loadConfig({ configPath });
    assert.equal(config.signing.team, REQUIRED_TEAM);
    assert.equal(config.signing.identity, 'Apple Development: Andre Saboia (6NKUX5CX7G)');
    assert.deepEqual(config.runner, { port: 8700, privateAllowed: ['PX-1', 'PX-2', 'PX-3', 'PX-5'] });
    assert.deepEqual(config.bundle.displayNames, ['Outro']);
    assert.equal(config.bundle.host, 'app.kifactory.contrarregra');
    assert.equal(config.app.explore, 'com.example.app');
    assert.deepEqual(config.record, { fps: 30, bitrateKbps: 16000 });
  });

  test('mergeConfig: recursivo em objetos; listas, valores simples e tipos diferentes substituem; "__proto__" não polui o protótipo', () => {
    const merged = mergeConfig(
      { a: { b: 1, c: [1, 2], d: { e: 'x' } }, f: 'y', g: { h: 1 } },
      JSON.parse('{"a": {"c": [3], "d": {"z": true}}, "f": null, "g": 5, "__proto__": {"polluted": true}}'),
    ) as Record<string, unknown>;
    assert.deepEqual(merged['a'], { b: 1, c: [3], d: { e: 'x', z: true } });
    assert.equal(merged['f'], null);
    assert.equal(merged['g'], 5);
    assert.equal(Object.getPrototypeOf(merged), Object.prototype);
    assert.equal(merged['polluted'], undefined);
    assert.equal((({}) as Record<string, unknown>)['polluted'], undefined);
  });

  test('sem config.json na máquina, valem só os padrões de config/defaults.json', () => {
    const config = loadConfig({ configPath: join(tmp(), 'nao-existe.json') });
    assert.deepEqual(config, JSON.parse(readFileSync(DEFAULTS_PATH, 'utf8')));
  });

  test('config.json ilegível → E_CONFIG citando o caminho (JSON inválido, raiz que não é objeto)', () => {
    const dir = tmp();
    const broken = join(dir, 'broken.json');
    writeFileSync(broken, '{"signing": ');
    const notObject = writeJson(join(dir, 'array.json'), ['signing']);
    for (const configPath of [broken, notObject]) {
      assert.throws(
        () => loadConfig({ configPath }),
        (err: unknown) => {
          assert.ok(isContrarregraError(err, 'E_CONFIG'), `esperava E_CONFIG, veio ${String(err)}`);
          assert.ok(err.message.includes(configPath), err.message);
          return true;
        },
      );
    }
  });

  test('config/defaults.json traz os campos e padrões de S0.1 e nada do Hagah (✅ Q-4, US-17)', () => {
    const raw = readFileSync(DEFAULTS_PATH, 'utf8');
    assert.doesNotMatch(raw, /hagah/i);
    const defaults = JSON.parse(raw);
    assert.deepEqual(Object.keys(defaults).sort(), [
      'alerts', 'app', 'apps', 'bundle', 'device', 'disk', 'guide', 'obs', 'paths', 'record', 'runner',
      'secrets', 'signing', 'sync', 'toolchain', 'urls', 'usbmux',
    ]);
    assert.equal(defaults.signing.team, REQUIRED_TEAM);
    assert.equal(defaults.signing.ascKeyPath, undefined);
    assert.equal(defaults.app.explore, undefined);
    assert.equal(defaults.sync.captureLatencyMs, undefined);
    assert.deepEqual(defaults.runner, { port: 8700, privateAllowed: [] });
    assert.deepEqual(defaults.apps.allowed, []);
    assert.deepEqual(defaults.urls.allowedPrefixes, []);
    assert.equal(defaults.secrets.obsPassword, 'OBS_WEBSOCKET_PASSWORD');
    assert.equal(defaults.paths.ffmpeg, '/opt/homebrew/opt/ffmpeg/bin/ffmpeg');
    assert.equal(defaults.paths.ffprobe, '/opt/homebrew/opt/ffmpeg/bin/ffprobe');
    assert.equal(defaults.obs.url, 'ws://127.0.0.1:4455');
  });
});

describe('shims bin/contrarregra e bin/contrarregra-mcp (S8 item 7, E-8.1)', () => {
  const SHIMS = ['contrarregra', 'contrarregra-mcp'] as const;
  const ENTRY = {
    'contrarregra': join(ROOT, 'mac', 'src', 'cli', 'main.ts'),
    'contrarregra-mcp': join(ROOT, 'mac', 'src', 'mcp', 'main.ts'),
  } as const;

  // Node falso: responde --version e, rodado, imprime a etiqueta e os argumentos recebidos.
  function fakeNode(dir: string, version: string, tag: string): string {
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'node');
    writeFileSync(
      path,
      [
        '#!/bin/sh',
        `if [ "$1" = --version ]; then echo ${version}; exit 0; fi`,
        `printf 'RAN ${tag}'`,
        `for a in "$@"; do printf ' [%s]' "$a"; done`,
        'echo',
        '',
      ].join('\n'),
    );
    chmodSync(path, 0o755);
    return dir;
  }

  function runShim(shimPath: string, env: Record<string, string>, args: string[] = []) {
    const started = performance.now();
    const result = spawnSync(shimPath, args, { env, encoding: 'utf8', timeout: 5_000 });
    return { ...result, ms: performance.now() - started };
  }

  const homebrewNode = '/opt/homebrew/bin/node';
  const homebrewVersion = existsSync(homebrewNode)
    ? spawnSync(homebrewNode, ['--version'], { encoding: 'utf8' }).stdout.trim()
    : '';

  test(
    `E-8.1: com só o Node do Homebrew (${homebrewVersion || 'ausente'}) disponível, os dois shims saem em ≤ 1 s com a mensagem de versão`,
    { skip: homebrewVersion.startsWith('v26.') ? false : 'precisa do Node 26 do Homebrew em /opt/homebrew/bin/node' },
    () => {
      const home = tmp();
      const env = { PATH: '/opt/homebrew/bin:/usr/bin:/bin', HOME: home, NVM_DIR: join(home, 'nvm') };
      for (const shim of SHIMS) {
        const result = runShim(join(ROOT, 'bin', shim), env, ['--json']);
        assert.notEqual(result.status, 0, `${shim}: ${result.stdout}${result.stderr}`);
        assert.ok(result.ms <= 1_000, `${shim} levou ${result.ms.toFixed(0)} ms`);
        assert.ok(result.stderr.includes(homebrewVersion), result.stderr);
        assert.ok(result.stderr.includes(homebrewNode), result.stderr);
        assert.match(result.stderr, /22\.18/);
        assert.equal(result.stdout, '');
      }
    },
  );

  test('E-8.1: recusa em ≤ 1 s qualquer Node fora de 22.x ≥ 22.18 (v26.0.0, v23.0.0, v22.17.0, v20.19.0)', () => {
    for (const version of ['v26.0.0', 'v23.0.0', 'v22.17.0', 'v20.19.0']) {
      const home = tmp();
      const bin = fakeNode(join(home, 'bin'), version, 'path');
      const env = { PATH: `${bin}:/usr/bin:/bin`, HOME: home, NVM_DIR: join(home, 'nvm') };
      for (const shim of SHIMS) {
        const result = runShim(join(ROOT, 'bin', shim), env);
        assert.notEqual(result.status, 0, `${shim} aceitou ${version}`);
        assert.ok(result.ms <= 1_000, `${shim} levou ${result.ms.toFixed(0)} ms com ${version}`);
        assert.ok(result.stderr.includes(version), result.stderr);
        assert.equal(result.stdout, '', `${shim} rodou algo com ${version}`);
      }
    }
  });

  test('E-8.1: Node do nvm fora da faixa (só v22.17.0) e nada no PATH → a mensagem nomeia a versão recusada, em ≤ 1 s', () => {
    const home = tmp();
    const nvm = join(home, 'nvm');
    const bin = fakeNode(join(nvm, 'versions', 'node', 'v22.17.0', 'bin'), 'v22.17.0', 'nvm-v22.17.0');
    const env = { PATH: '/usr/bin:/bin', HOME: home, NVM_DIR: nvm };
    for (const shim of SHIMS) {
      const result = runShim(join(ROOT, 'bin', shim), env);
      assert.equal(result.status, 1, `${shim}: ${result.stdout}${result.stderr}`);
      assert.ok(result.ms <= 1_000, `${shim} levou ${result.ms.toFixed(0)} ms`);
      assert.ok(result.stderr.includes('v22.17.0'), result.stderr);
      assert.ok(result.stderr.includes(join(bin, 'node')), result.stderr);
      assert.doesNotMatch(result.stderr, /nenhum Node/);
      assert.equal(result.stdout, '');
    }
  });

  test('sem Node nenhum no nvm nem no PATH, sai com a mensagem de versão exigida', () => {
    const home = tmp();
    const result = runShim(join(ROOT, 'bin', 'contrarregra'), { PATH: '/usr/bin:/bin', HOME: home, NVM_DIR: join(home, 'nvm') });
    assert.notEqual(result.status, 0);
    assert.ok(result.ms <= 1_000);
    assert.match(result.stderr, /22\.18/);
    assert.equal(result.stdout, '');
  });

  test('prefere o maior Node 22.x ≥ 22.18 do nvm ao do PATH; contrarregra roda a CLI e contrarregra-mcp roda mac/src/mcp/main.ts', () => {
    const home = tmp();
    const nvm = join(home, 'nvm');
    for (const version of ['v22.17.0', 'v22.18.0', 'v22.19.0', 'v20.19.0', 'v26.0.0']) {
      fakeNode(join(nvm, 'versions', 'node', version, 'bin'), version, `nvm-${version}`);
    }
    const pathBin = fakeNode(join(home, 'bin'), 'v22.20.0', 'path');
    const env = { PATH: `${pathBin}:/usr/bin:/bin`, HOME: home, NVM_DIR: nvm };
    for (const shim of SHIMS) {
      const result = runShim(join(ROOT, 'bin', shim), env, ['--json', 'a b']);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, `RAN nvm-v22.19.0 [${ENTRY[shim]}] [--json] [a b]\n`);
      assert.equal(result.stderr, '');
    }
  });

  test('sem Node válido no nvm, usa o primeiro Node 22.x ≥ 22.18 do PATH, pulando o 26', () => {
    const home = tmp();
    const nvm = join(home, 'nvm');
    fakeNode(join(nvm, 'versions', 'node', 'v22.17.0', 'bin'), 'v22.17.0', 'nvm-v22.17.0');
    const bin26 = fakeNode(join(home, 'bin26'), 'v26.0.0', 'path-26');
    const bin22 = fakeNode(join(home, 'bin22'), 'v22.18.0', 'path-22.18');
    const env = { PATH: `${bin26}:${bin22}:/usr/bin:/bin`, HOME: home, NVM_DIR: nvm };
    const result = runShim(join(ROOT, 'bin', 'contrarregra'), env, ['doctor']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `RAN path-22.18 [${ENTRY['contrarregra']}] [doctor]\n`);
  });

  test('chamado por um link simbólico de fora do repositório, ainda acha a raiz e o ponto de entrada', () => {
    const home = tmp();
    const nvm = join(home, 'nvm');
    fakeNode(join(nvm, 'versions', 'node', 'v22.19.0', 'bin'), 'v22.19.0', 'nvm-v22.19.0');
    const links = join(home, 'links');
    mkdirSync(links);
    symlinkSync(join(ROOT, 'bin', 'contrarregra-mcp'), join(links, 'contrarregra-mcp'));
    symlinkSync(join(ROOT, 'bin', 'contrarregra'), join(links, 'contrarregra'));
    const env = { PATH: '/usr/bin:/bin', HOME: home, NVM_DIR: nvm };
    for (const shim of SHIMS) {
      const result = runShim(join(links, shim), env);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, `RAN nvm-v22.19.0 [${ENTRY[shim]}]\n`);
    }
  });

  test('chamado como `sh <shim>` de dentro de bin/ ($0 sem barra), ainda chega ao ponto de entrada', () => {
    const home = tmp();
    const nvm = join(home, 'nvm');
    fakeNode(join(nvm, 'versions', 'node', 'v22.19.0', 'bin'), 'v22.19.0', 'nvm-v22.19.0');
    const env = { PATH: '/usr/bin:/bin', HOME: home, NVM_DIR: nvm };
    for (const shim of SHIMS) {
      const result = spawnSync('/bin/sh', [shim, '--json'], { cwd: join(ROOT, 'bin'), env, encoding: 'utf8', timeout: 5_000 });
      assert.equal(result.status, 0, `${shim}: ${result.stderr}`);
      assert.equal(result.stdout, `RAN nvm-v22.19.0 [${ENTRY[shim]}] [--json]\n`);
    }
  });
});

describe('esqueleto do repositório (A5)', () => {
  test('package.json e tsconfig.json com as opções da arquitetura', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    assert.equal(pkg.type, 'module');
    assert.equal(pkg.engines.node, '>=22.18 <23');
    assert.equal(typeof pkg.scripts.test, 'string');
    assert.equal(typeof pkg.scripts.typecheck, 'string');
    const options = JSON.parse(readFileSync(join(ROOT, 'tsconfig.json'), 'utf8')).compilerOptions;
    assert.equal(options.noEmit, true);
    assert.equal(options.allowImportingTsExtensions, true);
    assert.equal(options.erasableSyntaxOnly, true);
    assert.equal(options.verbatimModuleSyntax, true);
    assert.equal(options.module, 'nodenext');
    assert.equal(options.target, 'esnext');
  });

  test('.gitignore deixa fora do git vídeo, áudio, imagem, chaves, perfis, registros e saídas de spike (HC-7, P-3)', () => {
    const ignored = [
      'ios/Contrarregra.xcodeproj', '.build/debug', 'node_modules/yaml/package.json', 'take/recording.mp4',
      'a.mov', 'guide.wav', 'guide.aiff', 'guide.aif', 'voice.m4a', 'alert.caf', 'shot.png', 'shot.jpg',
      'shot.jpeg', 'shot.heic', 'run.xcresult', 'session.xctestrun', 'xcodebuild.log', 'events.ndjson',
      'AuthKey_ABC.p8', 'cert.p12', 'dev.mobileprovision', 'dev.cer', 'spikes/sp-1/out/frame.txt',
    ];
    const tracked = [
      'package.json', 'tsconfig.json', 'config/defaults.json', 'bin/contrarregra', 'bin/contrarregra-mcp',
      'mac/src/core/config.ts', 'ios/project.yml', 'spikes/SP-1.md', 'spec/spec.md',
    ];
    const result = spawnSync('git', ['check-ignore', '--no-index', '--stdin', '--verbose', '--non-matching'], {
      cwd: ROOT,
      input: [...ignored, ...tracked].join('\n') + '\n',
      encoding: 'utf8',
    });
    assert.ok(result.status === 0 || result.status === 1, result.stderr);
    const notIgnored = new Set(
      result.stdout
        .split('\n')
        .filter((line) => line.startsWith('::\t'))
        .map((line) => line.slice(3)),
    );
    for (const path of ignored) assert.ok(!notIgnored.has(path), `${path} deveria ser ignorado`);
    for (const path of tracked) assert.ok(notIgnored.has(path), `${path} não deveria ser ignorado`);
  });
});
