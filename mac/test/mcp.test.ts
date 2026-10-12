// Testes da T-0.15: servidor MCP mínimo (S8 itens 1–4, 6 e 7; AC-8.1 parcial; P-3; AC-0.5). Um cliente MCP
// de teste (`@modelcontextprotocol/client`, `InMemoryTransport`, no mesmo processo) lista e chama as 5
// ferramentas contra um runner falso: o usbmuxd de `helpers/usbmuxd.ts` + o servidor WebSocket de
// `helpers/ws-server.ts` respondendo `session.hello`, `health`, `device.state`, `screen.shot`, `ui.tree` e
// `ui.tap` nas formas de S0.5/S1, e uma sessão do runner escrita à mão (`.xctestrun` 0600 com o token e um
// processo vivo no papel do `xcodebuild`). Nada real: nem iPhone, nem `xcodebuild`, nem o usbmuxd do
// sistema; o `xcrun` do `doctor` é um script falso. As capturas vão para `paths.cache/explore/` num
// diretório temporário; o JPEG sai do `/usr/bin/sips` de verdade (ferramenta da Apple, só converte).

import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateSync } from 'node:zlib';

import {
  Client,
  InMemoryTransport,
  isJSONRPCNotification,
  isJSONRPCResultResponse,
  LATEST_PROTOCOL_VERSION,
  parseJSONRPCMessage,
  type JSONRPCMessage,
} from '@modelcontextprotocol/client';

import { BUSY_RETRY_MS } from '../src/commands/explore.ts';
import { EXPLORE_KEEP, JPEG_QUALITY } from '../src/commands/screenshot.ts';
import { loadConfig } from '../src/core/config.ts';
import { createContrarregraServer, INSTRUCTIONS, STARRED_TOOLS } from '../src/mcp/server.ts';
import { openRunner } from '../src/runner/client.ts';
import { shortTempDir, startFakeUsbmuxd, type FakeEntry, type FakeUsbmuxd } from './helpers/usbmuxd.ts';
import { startWsServer, type WsTestConnection, type WsTestServer } from './helpers/ws-server.ts';

// ── Fixtures ────────────────────────────────────────────────────────────────────────────────────────

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const UDID = '00008101-001E79203A68001E';
const CORE_DEVICE_ID = 'DC77A78E-5E8D-5825-B2EE-C297FBC14ABD';
const RUNNER_PORT = 8700;
const USB_ENTRY: FakeEntry = { deviceId: 3, connectionType: 'USB', serial: UDID };
const LIMIT = 2048;
const TAKE_ID = '20261012-101500-s02';

const FIXTURES = new URL('./fixtures/protocol/', import.meta.url);
const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(name, FIXTURES), 'utf8'));
const HELLO_RESULT = (fixture('RpcResponse.session.hello.json') as { result: unknown }).result;
const HEALTH_RESULT = (fixture('RpcResponse.health.json') as { result: unknown }).result;
const TAP_RESULT = (fixture('RpcResponse.ui.tap.json') as { result: unknown }).result;
const TREE_ROOT = fixture('TreeNode.screen.json');

/** `device.state` de S1 item 4 (S1 item 10). */
const DEVICE_STATE = {
  locked: false,
  network: 'online',
  foregroundApp: 'com.example.target',
  language: 'en',
  screenPt: { w: 390, h: 844 },
  textSize: 'large',
  appearance: 'light',
};

/** `ui.tree {format: compact}`: uma linha por nó visível (S0.6), como o runner da T-0.6 escreve. */
const TREE_LINES = [
  '@e1 application "Example" (0,0 390x844)',
  '@e2 tabBar (0,761 390x83)',
  '@e3 button "Journal" (195,761 97.5x49) id="tab-journal" value="1" selected',
  '@e12 button "Open settings" (342,52 40x40)',
];
const TREE_VERSION = 17;

const NATIVE = { widthPx: 1170, heightPx: 2532, scale: 3 };

/** PNG RGB 8 bits sem dependência: faixas e degradê (comprime bem e vira um JPEG pequeno). */
function makePng(width: number, height: number): Buffer {
  const stride = 1 + width * 3;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const row = y * stride;
    const band = Math.floor(y / 211) % 4;
    for (let x = 0; x < width; x++) {
      const p = row + 1 + x * 3;
      raw[p] = 40 + band * 50;
      raw[p + 1] = Math.floor((x * 255) / width);
      raw[p + 2] = 160;
    }
  }
  const chunk = (type: string, data: Buffer): Buffer => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'ascii');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
    return Buffer.concat([head, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bits por canal
  ihdr[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const NATIVE_PNG = makePng(NATIVE.widthPx, NATIVE.heightPx);

/** Largura e altura do quadro de um JPEG (marcador SOFn), lidas à mão. */
function jpegSize(jpeg: Buffer): { width: number; height: number } {
  assert.equal(jpeg.readUInt16BE(0), 0xffd8, 'JPEG começa com SOI');
  let i = 2;
  while (i + 4 <= jpeg.length) {
    assert.equal(jpeg[i], 0xff, `marcador JPEG em ${i}`);
    const marker = jpeg[i + 1]!;
    if (marker === 0xff) {
      i += 1;
      continue;
    }
    const length = jpeg.readUInt16BE(i + 2);
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) return { height: jpeg.readUInt16BE(i + 5), width: jpeg.readUInt16BE(i + 7) };
    i += 2 + length;
  }
  throw new Error('JPEG sem SOF');
}

const DEVICECTL_JSON = JSON.stringify({
  info: { outcome: 'success' },
  result: {
    devices: [{ identifier: CORE_DEVICE_ID, hardwareProperties: { udid: UDID }, connectionProperties: { transportType: 'wired', tunnelState: 'connected' } }],
  },
});

const FAKE_XCRUN = `#!/bin/sh
# xcrun falso (T-0.15): só devicectl list devices --json-output <arquivo>
dir=$(cd "$(dirname "$0")" && pwd)
out=""; prev=""
for a in "$@"; do [ "$prev" = --json-output ] && out="$a"; prev="$a"; done
if [ "$1" = devicectl ] && [ -n "$out" ]; then cp "$dir/devicectl.json" "$out"; exit 0; fi
exit 1
`;

// ── Runner falso ────────────────────────────────────────────────────────────────────────────────────

interface RunnerCall {
  method: string;
  params: Record<string, unknown> | undefined;
  role: string | undefined;
}

interface FakeRunner {
  readonly server: WsTestServer;
  readonly calls: RunnerCall[];
  /** Erro de S0.5 por método (`{code, message, data?}`) no lugar da resposta. */
  readonly failWith: Map<string, { code: number; message: string; data?: unknown }>;
  /** Resposta trocada por método (ex.: um `screen.shot` fora de S1). */
  readonly override: Map<string, unknown>;
  /** Quantas vezes um segundo `control` levou `E_BUSY`. */
  busy: number;
}

function screenShotResult(params: Record<string, unknown> | undefined): unknown {
  if (params?.['format'] === 'png' && params['scale'] === 'native') {
    return { image: NATIVE_PNG.toString('base64'), format: 'png', ...NATIVE };
  }
  throw new Error(`screen.shot inesperado: ${JSON.stringify(params)}`);
}

async function startFakeRunner(token: string): Promise<FakeRunner> {
  let control: WsTestConnection | null = null;
  const roles = new Map<WsTestConnection, string>();
  const send = (conn: WsTestConnection, message: unknown): void => {
    try {
      conn.sendJson(message);
    } catch {
      // conexão fechando
    }
  };
  const fail = (conn: WsTestConnection, id: unknown, code: number, message: string, data?: unknown): void =>
    send(conn, { jsonrpc: '2.0', id, error: data === undefined ? { code, message } : { code, message, data } });

  const fake = { calls: [], failWith: new Map(), override: new Map(), busy: 0 } as unknown as FakeRunner & { server: WsTestServer };

  const handle = (conn: WsTestConnection, text: string): void => {
    const { id, method, params } = JSON.parse(text) as { id: unknown; method: string; params?: Record<string, unknown> };
    fake.calls.push({ method, params, role: roles.get(conn) });
    if (method === 'session.hello') {
      if (params?.['token'] !== token) return fail(conn, id, -32001, 'E_AUTH: token errado');
      const role = String(params['role']);
      if (role === 'control') {
        if (control !== null && control !== conn) {
          fake.busy++;
          return fail(conn, id, -32002, 'E_BUSY: já há um controlador conectado (um control por vez)');
        }
        control = conn;
      }
      roles.set(conn, role);
      return send(conn, { jsonrpc: '2.0', id, result: HELLO_RESULT });
    }
    if (!roles.has(conn)) return fail(conn, id, -32001, 'E_AUTH: sem session.hello');
    const failure = fake.failWith.get(method);
    if (failure !== undefined) return fail(conn, id, failure.code, failure.message, failure.data);
    if (fake.override.has(method)) return send(conn, { jsonrpc: '2.0', id, result: fake.override.get(method) });
    switch (method) {
      case 'health':
        return send(conn, { jsonrpc: '2.0', id, result: HEALTH_RESULT });
      case 'clock.ping':
        return send(conn, { jsonrpc: '2.0', id, result: { seq: params?.['seq'], t2RawNs: '1000', t3RawNs: '1500', t2UptimeNs: '900' } });
      case 'device.state':
        return send(conn, { jsonrpc: '2.0', id, result: DEVICE_STATE });
      case 'screen.shot':
        return send(conn, { jsonrpc: '2.0', id, result: screenShotResult(params) });
      case 'ui.tree':
        return send(conn, {
          jsonrpc: '2.0',
          id,
          result: { treeVersion: TREE_VERSION, nodes: params?.['format'] === 'json' ? [TREE_ROOT] : TREE_LINES },
        });
      case 'ui.tap':
        return send(conn, { jsonrpc: '2.0', id, result: TAP_RESULT });
      default:
        return fail(conn, id, -32601, `método inexistente: ${method}`);
    }
  };

  fake.server = await startWsServer({
    onConnection: (conn) => {
      void conn.closed.then(() => {
        if (control === conn) control = null;
        roles.delete(conn);
      });
      conn.onMessage((text) => handle(conn, text));
    },
  });
  return fake;
}

// ── Ambiente de teste ───────────────────────────────────────────────────────────────────────────────

interface Env {
  root: string;
  cache: string;
  explore: string;
  configPath: string;
  xcrun: string;
  token: string;
  usbmuxd: FakeUsbmuxd;
  runner: FakeRunner;
}

const cleanups: (() => Promise<void> | void)[] = [];
const keepers: ChildProcess[] = [];
/** Todo texto devolvido por uma ferramenta nestes testes (P-3: o token nunca aparece). */
const allResultText: string[] = [];
/** Os tokens de sessão de todos os ambientes criados. */
const allTokens = new Set<string>();

after(async () => {
  for (const keeper of keepers) keeper.kill('SIGKILL');
  for (const cleanup of cleanups.reverse()) {
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([Promise.resolve().then(cleanup), new Promise<void>((resolve) => (timer = setTimeout(resolve, 3_000)))]).catch(() => {});
    clearTimeout(timer);
  }
});
process.on('exit', () => {
  for (const keeper of keepers) keeper.kill('SIGKILL');
});

/** Sessão do runner como o `runner up` deixa: `.xctestrun` 0600 com o token + estado + um "xcodebuild" vivo. */
function writeSession(cache: string, token: string): void {
  const sessions = join(cache, 'sessions');
  mkdirSync(sessions, { recursive: true, mode: 0o700 });
  const sessionId = '20261012-120000-abc123';
  const xctestrun = join(sessions, `${sessionId}.xctestrun`);
  writeFileSync(
    xctestrun,
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>ContrarregraRunner</key>
	<dict>
		<key>BlueprintName</key>
		<string>ContrarregraRunner</string>
		<key>EnvironmentVariables</key>
		<dict>
			<key>CONTRARREGRA_PORT</key>
			<string>${RUNNER_PORT}</string>
			<key>CONTRARREGRA_TOKEN</key>
			<string>${token}</string>
		</dict>
	</dict>
</dict>
</plist>
`,
    { mode: 0o600 },
  );
  // O "xcodebuild" da sessão: vivo e com o caminho do `.xctestrun` na linha de comando (S2 item 7).
  const keeper = spawn('/bin/sh', ['-c', 'while :; do sleep 1; done', 'xcodebuild', xctestrun], { stdio: 'ignore' });
  keepers.push(keeper);
  const state = {
    schema: 'contrarregra.session/1',
    sessionId,
    udid: UDID,
    port: RUNNER_PORT,
    configuration: 'Debug',
    spike: false,
    xctestrun,
    log: '/dev/null',
    xcodebuildPid: keeper.pid,
    startedAt: '2026-10-12T12:00:00.000Z',
  };
  writeFileSync(join(sessions, `${sessionId}.json`), JSON.stringify(state), { mode: 0o600 });
}

async function setup(options: { session?: boolean; config?: Record<string, unknown> } = {}): Promise<Env> {
  const root = shortTempDir('crr-mcp-');
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const token = randomBytes(32).toString('base64url');
  allTokens.add(token);
  const runner = await startFakeRunner(token);
  cleanups.push(() => runner.server.close());
  const usbmuxd = await startFakeUsbmuxd(root, { devices: [USB_ENTRY], devicePorts: { [RUNNER_PORT]: runner.server.port } });
  cleanups.push(() => usbmuxd.close());

  const toolsDir = join(root, 'tools');
  mkdirSync(toolsDir, { recursive: true });
  const xcrun = join(toolsDir, 'xcrun');
  writeFileSync(xcrun, FAKE_XCRUN);
  chmodSync(xcrun, 0o755);
  writeFileSync(join(toolsDir, 'devicectl.json'), DEVICECTL_JSON);

  const cache = join(root, 'cache');
  if (options.session !== false) writeSession(cache, token);
  const configPath = join(root, 'config.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      usbmux: { socketPath: usbmuxd.socketPath },
      paths: { cache, takes: join(root, 'takes') },
      app: { explore: 'com.example.target' },
      ...options.config,
    }),
  );
  return { root, cache, explore: join(cache, 'explore'), configPath, xcrun, token, usbmuxd, runner };
}

/** Cliente MCP de teste ligado ao servidor no mesmo processo (`InMemoryTransport`). */
async function connect(env: Pick<Env, 'configPath' | 'xcrun'>): Promise<Client> {
  const server = createContrarregraServer({ config: { configPath: env.configPath }, tools: { xcrun: env.xcrun } });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'contrarregra-mcp-test', version: '0.0.0' });
  await client.connect(clientTransport);
  cleanups.push(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

interface ToolResult {
  isError?: boolean;
  content: { type: string; text?: string; data?: string; mimeType?: string }[];
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
  const result = (await client.callTool({ name, arguments: args })) as ToolResult;
  for (const block of result.content) if (block.type === 'text') allResultText.push(block.text ?? '');
  allResultText.push(JSON.stringify(result));
  return result;
}

function textOf(result: ToolResult): string {
  return result.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('\n');
}

function jsonOf(result: ToolResult): Record<string, unknown> {
  assert.notEqual(result.isError, true, `a ferramenta falhou: ${textOf(result)}`);
  return JSON.parse(textOf(result)) as Record<string, unknown>;
}

function errorOf(result: ToolResult): { code: string | null; message: string; data: Record<string, unknown> } {
  assert.equal(result.isError, true, `esperava erro, veio: ${textOf(result)}`);
  const parsed = JSON.parse(textOf(result)) as { error: { code: string | null; message: string; data: Record<string, unknown> } };
  assert.equal(typeof parsed.error.message, 'string');
  assert.equal(typeof parsed.error.data, 'object');
  return parsed.error;
}

function pngsIn(dir: string): string[] {
  try {
    return readdirSync(dir).filter((name) => name.endsWith('.png'));
  } catch {
    return [];
  }
}

const methods = (env: Env): string[] => env.runner.calls.map((c) => c.method);

// ── Testes ──────────────────────────────────────────────────────────────────────────────────────────

describe('servidor MCP mínimo (T-0.15, S8)', () => {
  test('AC-8.1 (parcial): exatamente as 5 ferramentas da Fase 0, todas ★ com alwaysLoad; descrições e instruções ≤ 2.048 caracteres', async () => {
    const env = await setup();
    const client = await connect(env);
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, ['device_status', 'doctor', 'screenshot', 'tap', 'ui_tree']);
    assert.deepEqual([...STARRED_TOOLS].sort(), names, 'as ★ desta fase são as 5 presentes (take_wait entra na Fase 1)');
    for (const tool of tools) {
      assert.equal(tool._meta?.['anthropic/alwaysLoad'], true, `${tool.name} tem _meta['anthropic/alwaysLoad'] = true`);
      assert.ok(tool.description !== undefined && tool.description.length > 0, `${tool.name} tem descrição`);
      assert.ok(tool.description.length <= LIMIT, `${tool.name}: descrição com ${tool.description.length} caracteres`);
      assert.equal(tool.inputSchema.type, 'object');
    }
    const instructions = client.getInstructions();
    assert.equal(instructions, INSTRUCTIONS);
    assert.ok(instructions !== undefined && instructions.length > 0 && instructions.length <= LIMIT, `instruções com ${instructions?.length} caracteres`);
    // S8 item 4: a árvore declara o limite de resultado.
    assert.equal(tools.find((tool) => tool.name === 'ui_tree')?._meta?.['anthropic/maxResultSizeChars'], 200_000);
  });

  test('S8 item 6: instruções com a regra principal primeiro — iPhone físico para gravar demos; @eN e rótulos antes de coordenadas; nunca credenciais nem senha; não capturar fora do app alvo; tomada = take_start + take_wait', () => {
    const at = (needle: string): number => {
      const index = INSTRUCTIONS.indexOf(needle);
      assert.ok(index >= 0, `as instruções citam ${JSON.stringify(needle)}`);
      return index;
    };
    const firstLine = INSTRUCTIONS.split('\n')[0]!;
    assert.match(firstLine, /iPhone físico/);
    assert.match(firstLine, /demos/);
    const order = [at('iPhone físico'), at('@eN'), at('credenciais'), at('senha'), at('Não capture'), at('take_start'), at('take_wait')];
    assert.match(INSTRUCTIONS, /Não capture[^\n]*app alvo/);
    assert.deepEqual([...order].sort((a, b) => a - b), order, 'as regras aparecem na ordem de S8 item 6');
    assert.ok(INSTRUCTIONS.length <= LIMIT);
  });

  test('S8 item 7: .mcp.json versionado registra o servidor "contrarregra" (stdio) apontando para bin/contrarregra-mcp, sem env nem segredo', () => {
    const raw = readFileSync(join(ROOT, '.mcp.json'), 'utf8');
    const doc = JSON.parse(raw) as { mcpServers: Record<string, { type?: string; command: string; args?: string[]; env?: unknown }> };
    assert.deepEqual(Object.keys(doc.mcpServers), ['contrarregra']);
    const entry = doc.mcpServers['contrarregra']!;
    assert.equal(entry.type, 'stdio');
    assert.match(entry.command, /(^|\/)bin\/contrarregra-mcp$/);
    assert.deepEqual(entry.args ?? [], []);
    assert.equal(entry.env, undefined, 'nenhuma variável de ambiente (segredos ficam no Chaveiro, S8 item 8)');
    assert.doesNotMatch(raw, /password|secret|token|OBS_WEBSOCKET/i);
    assert.ok((statSync(join(ROOT, 'bin', 'contrarregra-mcp')).mode & 0o111) !== 0, 'o shim é executável');
  });

  test('Done T-0.15: o cliente MCP de teste lista e chama as 5 ferramentas contra o runner falso', async () => {
    const env = await setup();
    const client = await connect(env);
    const { tools } = await client.listTools();
    assert.equal(tools.length, 5);

    const doctor = jsonOf(await call(client, 'doctor'));
    assert.equal(doctor['ok'], true, JSON.stringify(doctor));

    assert.deepEqual(jsonOf(await call(client, 'device_status')), DEVICE_STATE);

    const shot = await call(client, 'screenshot');
    assert.notEqual(shot.isError, true, textOf(shot));
    const image = shot.content.find((block) => block.type === 'image');
    assert.equal(image?.mimeType, 'image/jpeg');
    assert.deepEqual(jpegSize(Buffer.from(image!.data!, 'base64')), { width: 390, height: 844 });

    const tree = await call(client, 'ui_tree');
    assert.notEqual(tree.isError, true, textOf(tree));
    assert.match(textOf(tree), /@e12 button "Open settings" \(342,52 40x40\)/);

    assert.deepEqual(jsonOf(await call(client, 'tap', { target: { ref: '@e12' } })), TAP_RESULT);

    // Toda conversa de exploração foi pela conexão `control`, aberta por comando (S2 item 3).
    const explore = env.runner.calls.filter((c) => ['device.state', 'screen.shot', 'ui.tree', 'ui.tap'].includes(c.method));
    assert.deepEqual(explore.map((c) => c.method), ['device.state', 'screen.shot', 'ui.tree', 'ui.tap']);
    assert.ok(explore.every((c) => c.role === 'control'));
  });

  test('screenshot (S8 item 3): um screen.shot {png, native}; JPEG 390×844 em pontos (≤ 150 KB) na resposta; PNG nativo intacto em paths.cache/explore/ (0600), citado com a escala', async () => {
    const env = await setup();
    const client = await connect(env);
    const result = await call(client, 'screenshot');
    assert.notEqual(result.isError, true, textOf(result));

    const shots = env.runner.calls.filter((c) => c.method === 'screen.shot');
    assert.deepEqual(shots.map((c) => c.params), [{ format: 'png', scale: 'native' }], 'uma captura só, PNG nativo');

    assert.equal(result.content.length, 2);
    const [image, line] = result.content;
    assert.equal(image!.type, 'image');
    assert.equal(image!.mimeType, 'image/jpeg');
    const jpeg = Buffer.from(image!.data!, 'base64');
    assert.deepEqual(jpegSize(jpeg), { width: 390, height: 844 }, 'coordenadas da imagem = pontos do XCUITest');
    assert.ok(jpeg.length <= 150 * 1024, `JPEG com ${jpeg.length} bytes`);
    assert.equal(JPEG_QUALITY, 0.8);

    assert.equal(line!.type, 'text');
    const pngs = pngsIn(env.explore);
    assert.equal(pngs.length, 1);
    const pngPath = join(env.explore, pngs[0]!);
    assert.ok(line!.text!.includes(pngPath), `a linha cita o caminho do PNG: ${line!.text}`);
    assert.match(line!.text!, /escala 1\b/);
    assert.match(line!.text!, /escala 3\b/);
    assert.match(line!.text!, /390×844/);
    assert.match(line!.text!, /1170×2532/);
    assert.ok(readFileSync(pngPath).equals(NATIVE_PNG), 'o PNG salvo é o que o runner mandou');
    assert.equal(statSync(pngPath).mode & 0o777, 0o600);
    assert.equal(statSync(env.explore).mode & 0o777, 0o700);
    assert.deepEqual(readdirSync(env.explore).filter((name) => !name.endsWith('.png')), [], 'nenhuma sobra (o JPEG temporário foi apagado)');
  });

  test(`screenshot: poda paths.cache/explore/ para as ${EXPLORE_KEEP} capturas mais recentes`, async () => {
    assert.equal(EXPLORE_KEEP, 200);
    const env = await setup();
    mkdirSync(env.explore, { recursive: true });
    const base = Date.now() / 1000 - 10_000;
    const old: string[] = [];
    for (let i = 0; i < EXPLORE_KEEP + 5; i++) {
      const name = `old-${String(i).padStart(3, '0')}.png`;
      const path = join(env.explore, name);
      writeFileSync(path, 'x');
      utimesSync(path, base + i, base + i);
      old.push(name);
    }
    const client = await connect(env);
    const result = await call(client, 'screenshot');
    assert.notEqual(result.isError, true, textOf(result));
    const left = pngsIn(env.explore).sort();
    assert.equal(left.length, EXPLORE_KEEP);
    // Sobram as 199 antigas mais novas e a captura nova; as 6 mais velhas saíram.
    for (const name of old.slice(0, 6)) assert.ok(!left.includes(name), `${name} foi podada`);
    for (const name of old.slice(6)) assert.ok(left.includes(name), `${name} ficou`);
    assert.equal(left.filter((name) => !name.startsWith('old-')).length, 1);
  });

  test('screenshot: runner recusa a captura (E_FORBIDDEN_APP, S1 item 11) → isError {error: {code, message, data}}; nada salvo', async () => {
    const env = await setup();
    env.runner.failWith.set('screen.shot', { code: -32003, message: 'E_FORBIDDEN_APP: SpringBoard à frente', data: { foregroundApp: 'com.apple.springboard' } });
    const client = await connect(env);
    const error = errorOf(await call(client, 'screenshot'));
    assert.equal(error.code, 'E_FORBIDDEN_APP');
    assert.equal(error.data['foregroundApp'], 'com.apple.springboard');
    assert.deepEqual(pngsIn(env.explore), []);
  });

  test('screenshot: resposta do screen.shot fora de S1 (sem widthPx) → E_RUNNER_DOWN protocol-mismatch; nada salvo', async () => {
    const env = await setup();
    env.runner.override.set('screen.shot', { image: NATIVE_PNG.toString('base64'), format: 'png', heightPx: 2532, scale: 3 });
    const client = await connect(env);
    const error = errorOf(await call(client, 'screenshot'));
    assert.equal(error.code, 'E_RUNNER_DOWN');
    assert.equal(error.data['reason'], 'protocol-mismatch');
    assert.deepEqual(pngsIn(env.explore), []);
  });

  test('ui_tree (S8 item 4): pede ao runner {format: compact, visibleOnly: true} e devolve treeVersion + uma linha por nó; json devolve os nós de S0.6; app repassado', async () => {
    const env = await setup();
    const client = await connect(env);

    const compact = await call(client, 'ui_tree');
    assert.notEqual(compact.isError, true, textOf(compact));
    assert.equal(textOf(compact), [`treeVersion ${TREE_VERSION}`, ...TREE_LINES].join('\n'));

    const json = jsonOf(await call(client, 'ui_tree', { format: 'json', app: 'com.example.target' }));
    assert.deepEqual(json, { treeVersion: TREE_VERSION, nodes: [TREE_ROOT] });

    const trees = env.runner.calls.filter((c) => c.method === 'ui.tree').map((c) => c.params);
    assert.deepEqual(trees, [
      { format: 'compact', visibleOnly: true },
      { format: 'json', visibleOnly: true, app: 'com.example.target' },
    ]);

    const bad = errorOf(await call(client, 'ui_tree', { format: 'xml' }));
    assert.equal(bad.code, 'E_CHOREO_INVALID', 'formato fora de compact|json é recusado antes do runner');
    assert.equal(env.runner.calls.filter((c) => c.method === 'ui.tree').length, 2);
  });

  test('tap: repassa o alvo de S0.2 a ui.tap e devolve a resposta de S0.5; alvo com dois seletores primários é recusado sem falar com o runner', async () => {
    const env = await setup();
    const client = await connect(env);
    const target = { label: 'Open settings', type: 'button' };
    assert.deepEqual(jsonOf(await call(client, 'tap', { target })), TAP_RESULT);
    assert.deepEqual(jsonOf(await call(client, 'tap', { target: { point: { x: 362, y: 72 } } })), TAP_RESULT);
    const taps = env.runner.calls.filter((c) => c.method === 'ui.tap').map((c) => c.params);
    assert.deepEqual(taps, [{ target }, { target: { point: { x: 362, y: 72 } } }]);

    const before = env.runner.calls.length;
    const bad = errorOf(await call(client, 'tap', { target: { label: 'Open settings', ref: '@e12' } }));
    assert.equal(bad.code, 'E_CHOREO_INVALID');
    assert.match(bad.message, /seletores primários/);
    assert.equal(env.runner.calls.length, before, 'o runner não foi chamado');

    env.runner.failWith.set('ui.tap', { code: -32010, message: 'E_TARGET_NOT_FOUND: nada com esse rótulo', data: { target } });
    assert.equal(errorOf(await call(client, 'tap', { target })).code, 'E_TARGET_NOT_FOUND');
  });

  test('argumentos fora da forma (S0.2, AC-0.3) → isError com {error: {code: E_CHOREO_INVALID, message, data}}, nunca o texto do SDK; sem falar com o runner; tools/list ainda anuncia a forma', async () => {
    const env = await setup();
    const client = await connect(env);
    const cases: [string, Record<string, unknown>, RegExp][] = [
      ['tap', { target: { label: 'a', ref: '@e1' } }, /seletores primários/],
      ['tap', {}, /target/],
      ['tap', { target: 'Open settings' }, /target/],
      ['tap', { target: { ref: '@e1' }, force: true }, /force/],
      ['ui_tree', { format: 'xml' }, /format/],
      ['ui_tree', { app: '' }, /app/],
      ['ui_tree', { app: 7 }, /app/],
      ['ui_tree', { visibleOnly: false }, /visibleOnly/],
      ['screenshot', { scale: 2 }, /scale/],
      ['device_status', { verbose: true }, /verbose/],
      ['doctor', { fix: true }, /fix/],
    ];
    for (const [name, args, mentions] of cases) {
      const result = await call(client, name, args);
      const label = `${name} ${JSON.stringify(args)}`;
      assert.doesNotMatch(textOf(result), /Input validation error/, label);
      const error = errorOf(result);
      assert.equal(error.code, 'E_CHOREO_INVALID', label);
      assert.match(error.message, mentions, label);
      assert.ok(Array.isArray(error.data['errors']) && (error.data['errors'] as unknown[]).length > 0, `${label}: data.errors`);
    }
    assert.deepEqual(env.runner.calls, [], 'nenhum argumento inválido chegou ao runner');

    // O modelo continua vendo a forma (o JSON Schema dos esquemas do núcleo).
    const { tools } = await client.listTools();
    const schemaOf = (name: string) => tools.find((tool) => tool.name === name)!.inputSchema as { properties?: Record<string, { enum?: string[] }>; required?: string[] };
    const tapSchema = schemaOf('tap');
    assert.deepEqual(tapSchema.required, ['target']);
    const target = JSON.stringify(tapSchema.properties?.['target']);
    for (const key of ['ref', 'label', 'labelPrefix', 'labelContains', 'identifier', 'ocr', 'point']) assert.ok(target.includes(`"${key}"`), `target anuncia ${key}`);
    assert.deepEqual(schemaOf('ui_tree').properties?.['format']?.enum, ['compact', 'json']);
    assert.deepEqual(Object.keys(schemaOf('ui_tree').properties ?? {}).sort(), ['app', 'format']);
    for (const name of ['doctor', 'device_status', 'screenshot']) assert.deepEqual(schemaOf(name).properties, {}, name);
  });

  test('S1 item 11, P-3: ui_tree não oferece a folha authkit nem o SpringBoard e os recusa no Mac com E_FORBIDDEN_APP, sem falar com o runner', async () => {
    const env = await setup();
    const client = await connect(env);
    const { tools } = await client.listTools();
    const tree = tools.find((tool) => tool.name === 'ui_tree')!;
    assert.doesNotMatch(`${tree.description}\n${JSON.stringify(tree.inputSchema)}`, /authkit|springboard|controlcenter/i);
    assert.doesNotMatch(INSTRUCTIONS, /authkit|springboard|controlcenter/i);

    for (const app of ['authkit', 'springboard', 'controlcenter', 'com.apple.AuthKitUIService', 'com.apple.springboard', 'COM.APPLE.AUTHKITUISERVICE']) {
      for (const format of ['compact', 'json']) {
        const error = errorOf(await call(client, 'ui_tree', { app, format }));
        assert.equal(error.code, 'E_FORBIDDEN_APP', `${app} ${format}`);
        assert.equal(error.data['app'], app);
      }
    }
    assert.deepEqual(env.runner.calls, []);
  });

  test('device_status: devolve o device.state do runner (S1 item 4), pela conexão control', async () => {
    const env = await setup();
    const client = await connect(env);
    assert.deepEqual(jsonOf(await call(client, 'device_status')), DEVICE_STATE);
    const states = env.runner.calls.filter((c) => c.method === 'device.state');
    assert.equal(states.length, 1);
    assert.equal(states[0]!.role, 'control');
    assert.deepEqual(states[0]!.params, {});
  });

  test('doctor: com o runner falso de pé, Node, configuração, PF-02, PF-03 e PF-04 passam', async () => {
    const env = await setup();
    const client = await connect(env);
    const result = jsonOf(await call(client, 'doctor'));
    assert.equal(result['ok'], true);
    assert.deepEqual(result['node'], { version: process.version, execPath: process.execPath });
    const checks = result['checks'] as { id: string; ok: boolean; detail: string }[];
    assert.deepEqual(checks.map((c) => c.id), ['node', 'config', 'PF-02', 'PF-03', 'PF-04']);
    for (const check of checks) {
      assert.equal(check.ok, true, `${check.id}: ${check.detail}`);
      assert.equal(typeof check.detail, 'string');
    }
    assert.ok(methods(env).includes('health'), 'PF-04 falou com o runner');
  });

  test('doctor: sem o usbmuxd (cabo fora) não lança — PF-02 falha com E_NO_USB e PF-03/PF-04 ficam pulados', async () => {
    const env = await setup({ config: { usbmux: { socketPath: '/tmp/crr-mcp-nao-existe/usbmuxd' } } });
    const client = await connect(env);
    const result = await call(client, 'doctor');
    const doc = jsonOf(result);
    assert.equal(doc['ok'], false);
    const checks = doc['checks'] as { id: string; ok: boolean; detail: string; code?: string }[];
    const byId = new Map(checks.map((c) => [c.id, c]));
    assert.equal(byId.get('config')?.ok, true);
    assert.equal(byId.get('PF-02')?.ok, false);
    assert.equal(byId.get('PF-02')?.code, 'E_NO_USB');
    assert.equal(byId.get('PF-03')?.ok, false);
    assert.equal(byId.get('PF-04')?.ok, false);
    assert.deepEqual(env.runner.calls, []);
  });

  test('doctor: configuração inválida (signing.team) não lança — config falha com E_CONFIG e o resto fica pulado', async () => {
    const env = await setup({ config: { signing: { team: 'V4397KJVXZ' } } });
    const client = await connect(env);
    const doc = jsonOf(await call(client, 'doctor'));
    assert.equal(doc['ok'], false);
    const checks = doc['checks'] as { id: string; ok: boolean; code?: string }[];
    assert.deepEqual(checks.map((c) => c.id), ['node', 'config', 'PF-02', 'PF-03', 'PF-04']);
    assert.equal(checks[0]!.ok, true);
    assert.equal(checks[1]!.code, 'E_CONFIG');
    assert.ok(checks.slice(1).every((c) => !c.ok));
    assert.equal(env.usbmuxd.requests.length, 0);
  });

  test('AC-0.5: configuração inválida → E_CONFIG antes de qualquer conexão (o usbmuxd falso não recebe nada)', async () => {
    const env = await setup({ config: { signing: { team: 'V4397KJVXZ' } } });
    const client = await connect(env);
    for (const [name, args] of [
      ['device_status', {}],
      ['screenshot', {}],
      ['ui_tree', {}],
      ['tap', { target: { ref: '@e12' } }],
    ] as const) {
      const error = errorOf(await call(client, name, args));
      assert.equal(error.code, 'E_CONFIG', name);
      assert.equal(error.data['field'], 'signing.team');
    }
    assert.equal(env.usbmuxd.requests.length, 0);
    assert.deepEqual(env.runner.calls, []);
  });

  test('S2 item 7: sem sessão do runner → E_RUNNER_DOWN com a dica `contrarregra runner up`', async () => {
    const env = await setup({ session: false });
    const client = await connect(env);
    const error = errorOf(await call(client, 'device_status'));
    assert.equal(error.code, 'E_RUNNER_DOWN');
    assert.equal(error.data['hint'], 'contrarregra runner up');
  });

  test('S2 item 3: chamadas simultâneas e em sequência do mesmo servidor não esbarram no controlador único do runner', async () => {
    const env = await setup();
    const client = await connect(env);
    const results = await Promise.all([
      call(client, 'screenshot'),
      call(client, 'ui_tree'),
      call(client, 'device_status'),
      call(client, 'tap', { target: { ref: '@e12' } }),
    ]);
    for (const result of results) assert.notEqual(result.isError, true, textOf(result));
    for (let i = 0; i < 5; i++) {
      assert.notEqual((await call(client, 'device_status')).isError, true);
      assert.notEqual((await call(client, 'tap', { target: { ref: '@e12' } })).isError, true);
    }
    const hellos = env.runner.calls.filter((c) => c.method === 'session.hello');
    assert.ok(hellos.length >= 14, 'um control por comando');
  });

  test('S2 item 3: vaga de control ocupada por outro controlador — espera a vaga por até BUSY_RETRY_MS e depois devolve E_BUSY', async () => {
    const env = await setup();
    const client = await connect(env);
    const config = loadConfig({ configPath: env.configPath });

    // O outro controlador solta a vaga logo: a chamada passa depois de levar E_BUSY.
    const brief = await openRunner(config, { role: 'control' });
    const releasing = new Promise<void>((resolve) => setTimeout(() => void brief.close().then(resolve), 300));
    const ok = await call(client, 'device_status');
    await releasing;
    assert.deepEqual(jsonOf(ok), DEVICE_STATE);
    assert.ok(env.runner.busy >= 1, 'o runner recusou o session.hello ao menos uma vez');

    // O outro controlador não solta: E_BUSY do runner (sem takeId) depois do prazo.
    const holder = await openRunner(config, { role: 'control' });
    try {
      const t0 = performance.now();
      const error = errorOf(await call(client, 'device_status'));
      const elapsed = performance.now() - t0;
      assert.equal(error.code, 'E_BUSY');
      assert.equal(error.data['takeId'], undefined);
      assert.ok(elapsed >= BUSY_RETRY_MS - 100 && elapsed < BUSY_RETRY_MS + 2_000, `E_BUSY em ${elapsed.toFixed(0)} ms`);
    } finally {
      await holder.close();
    }
  });

  test('AC-2.10: com uma tomada segurando o aparelho (trava com o takeId), a exploração recebe E_BUSY com o takeId na hora, sem falar com o runner', async () => {
    const env = await setup();
    const client = await connect(env);
    mkdirSync(join(env.cache, 'locks'), { recursive: true });
    writeFileSync(join(env.cache, 'locks', `${UDID}.lock`), JSON.stringify({ takeId: TAKE_ID }));
    for (const [name, args] of [
      ['device_status', {}],
      ['screenshot', {}],
      ['ui_tree', {}],
      ['tap', { target: { ref: '@e12' } }],
    ] as const) {
      const t0 = performance.now();
      const error = errorOf(await call(client, name, args));
      assert.equal(error.code, 'E_BUSY', name);
      assert.equal(error.data['takeId'], TAKE_ID, name);
      assert.ok(performance.now() - t0 < 1_000, `${name}: E_BUSY sem esperar`);
    }
    assert.deepEqual(env.runner.calls, []);
  });

  test('P-3: o token da sessão nunca aparece num resultado de ferramenta (inclusive nos erros)', async () => {
    const env = await setup();
    const client = await connect(env);
    env.runner.failWith.set('ui.tap', { code: -32002, message: 'E_BUSY: tomada em curso' });
    await call(client, 'tap', { target: { ref: '@e1' } });
    await call(client, 'doctor');
    await call(client, 'device_status');
    assert.ok(allResultText.length > 20);
    assert.ok(allTokens.has(env.token));
    // Os tokens de todos os ambientes (cada um com a própria sessão) contra todos os resultados até aqui.
    for (const text of allResultText) for (const token of allTokens) assert.ok(!text.includes(token), 'token num resultado');
    for (const text of allResultText) assert.doesNotMatch(text, /CONTRARREGRA_TOKEN/);
  });

  test('stdio: bin/contrarregra-mcp sobe mac/src/mcp/main.ts com o Node 22; a saída padrão crua só tem mensagens JSON-RPC 2.0 do protocolo (nenhuma linha a mais); lista as 5 ferramentas e as instruções', async () => {
    const child = spawn(join(ROOT, 'bin', 'contrarregra-mcp'), [], { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'] });
    keepers.push(child);
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
    const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
    const send = (message: unknown): void => void child.stdin.write(`${JSON.stringify(message)}\n`);
    const answered = async (id: number): Promise<void> => {
      const deadline = Date.now() + 20_000;
      while (!stdout.split('\n').some((line) => line.includes(`"id":${id}`) && line.includes('"jsonrpc"'))) {
        assert.ok(Date.now() < deadline, `sem resposta ao pedido ${id}; saída: ${stdout}; erro: ${stderr}`);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    };

    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'contrarregra-mcp-stdio-test', version: '0.0.0' } },
    });
    await answered(1);
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    await answered(2);
    child.stdin.end();
    assert.equal(await exited, 0, 'o fim da entrada padrão encerra o servidor');

    // Toda linha da saída padrão é uma mensagem JSON-RPC 2.0 do protocolo: as respostas aos pedidos 1 e 2 e,
    // no máximo, notificações do MCP. Nenhum banner, nenhum JSON solto.
    assert.ok(stdout.endsWith('\n'), 'a saída termina com fim de linha');
    const messages = stdout
      .slice(0, -1)
      .split('\n')
      .map((line) => {
        let message: JSONRPCMessage;
        try {
          message = parseJSONRPCMessage(JSON.parse(line));
        } catch (error) {
          assert.fail(`linha fora do protocolo na saída padrão: ${JSON.stringify(line)} (${(error as Error).message})`);
        }
        assert.ok(isJSONRPCResultResponse(message) || (isJSONRPCNotification(message) && message.method.startsWith('notifications/')), `mensagem fora do esperado: ${line}`);
        return message;
      });
    const responses = messages.filter(isJSONRPCResultResponse);
    assert.deepEqual(responses.map((message) => message.id), [1, 2]);

    const init = responses[0]!.result as { instructions?: string; serverInfo: { name: string } };
    assert.equal(init.serverInfo.name, 'contrarregra');
    assert.equal(init.instructions, INSTRUCTIONS);
    const { tools } = responses[1]!.result as { tools: { name: string; _meta?: Record<string, unknown> }[] };
    assert.deepEqual(tools.map((tool) => tool.name).sort(), ['device_status', 'doctor', 'screenshot', 'tap', 'ui_tree']);
    assert.ok(tools.every((tool) => tool._meta?.['anthropic/alwaysLoad'] === true));
    assert.match(stderr, /contrarregra-mcp: Node v22\.\d+\.\d+/);
  });
});
