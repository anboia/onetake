// Testes da T-0.10: cliente JSON-RPC e `contrarregra runner build|up|down|status|sever` (S2 itens 1, 3,
// 6–8; S1 item 9; P-3; AC-0.5). Tudo falso: o usbmuxd de `helpers/usbmuxd.ts` (socket Unix curto via
// `usbmux.socketPath`), o servidor WebSocket de `helpers/ws-server.ts` no papel do runner, e scripts
// `xcodebuild`, `xcodegen`, `caffeinate`, `xcrun`, `codesign`, `PlistBuddy` e `security` num diretório temporário
// que registram como foram chamados (argumentos, se a entrada/saída é pipe ou arquivo, grupo de processo). Nunca
// roda o `xcodebuild` de verdade, nunca assina (o `codesign` falso só marca o .app), nunca lê o chaveiro, nunca
// fala com o iPhone; nenhum `.xctestrun` fica no repositório.

import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

import { main } from '../src/cli/main.ts';
import { loadConfig, type Config } from '../src/core/config.ts';
import { ContrarregraError, isContrarregraError } from '../src/core/errors.ts';
import { parseDevicectlList } from '../src/device/devicectl.ts';
import { openRunner, withRunner, type RunnerConnection } from '../src/runner/client.ts';
import {
  buildRunner,
  downRunner,
  percentile,
  recordVerifiedBuild,
  runnerStatus,
  severRunner,
  SIGNING_BASELINE_FILE,
  upRunner,
  type UpOptions,
} from '../src/runner/lifecycle.ts';
import { backoffDelays, installSeverHandler, RunnerLink, type LinkState } from '../src/runner/link.ts';
import { REPO_ROOT, runnerPaths } from '../src/runner/paths.ts';
import { RpcConnection, RpcProtocolError } from '../src/runner/rpc.ts';
import { DEFAULT_TOOLS, type RunnerTools } from '../src/runner/xcodebuild.ts';
import { findBuiltXctestrun, makeSessionXctestrun, parseXctestrun, runnerTarget, xctestrunConfiguration } from '../src/runner/xctestrun.ts';
import { decodePlist, isPlistDict, type PlistDict } from '../src/usbmux/plist.ts';
import { shortTempDir, startFakeUsbmuxd, type FakeEntry, type FakeUsbmuxd } from './helpers/usbmuxd.ts';
import { startWsServer, type WsTestConnection, type WsTestServer } from './helpers/ws-server.ts';

// ── Fixtures ────────────────────────────────────────────────────────────────────────────────────────

const UDID = '00008101-001E79203A68001E';
const CORE_DEVICE_ID = 'DC77A78E-5E8D-5825-B2EE-C297FBC14ABD';
const RUNNER_PORT = 8700;
const USB_ENTRY: FakeEntry = { deviceId: 3, connectionType: 'USB', serial: UDID };
const XCTESTRUN_NAME = 'ContrarregraRunner_iphoneos26.5-arm64.xctestrun';
const NO_USB_BOUND_MS = 1000;
const TAKE_ID = '20261012-101500-s02';

// Assinatura (P-3; S2 item 1): a identidade e o time esperados, um certificado folha falso (o SHA-1 dele é a
// "identidade" no chaveiro falso) e os entitlements que o Xcode falso "usou". Hashes falsos, nunca os reais.
const TEAM = '984PNJZ8B9';
const IDENTITY = 'Apple Development: Andre Saboia (6NKUX5CX7G)';
const LEAF_CERT = 'certificado folha falso 6NKUX5CX7G';
const LEAF_SHA1 = createHash('sha1').update(LEAF_CERT).digest('hex').toUpperCase();
const OTHER_SHA1 = '1111111111111111111111111111111111111111';
const NEW_SHA1 = '2222222222222222222222222222222222222222';
function identitiesListing(entries: readonly [string, string][]): string {
  const lines = entries.map(([sha1, name], i) => `  ${i + 1}) ${sha1} "${name}"`);
  return `${lines.join('\n')}\n     ${entries.length} valid identities found\n`;
}
const IDENTITIES = identitiesListing([
  [OTHER_SHA1, 'Apple Development: outra pessoa (9RLNRB8QXR)'],
  [LEAF_SHA1, IDENTITY],
]);
function codesignDisplay(authority = IDENTITY, team = TEAM, identifier = 'app.kifactory.contrarregra.runner.xctrunner'): string {
  return [
    `Identifier=${identifier}`,
    'Format=app bundle with Mach-O universal (arm64)',
    `Authority=${authority}`,
    'Authority=Apple Worldwide Developer Relations Certification Authority',
    'Authority=Apple Root CA',
    `TeamIdentifier=${team}`,
    '',
  ].join('\n');
}
function entitlementsXml(appId = `${TEAM}.app.kifactory.contrarregra.runner.xctrunner`): string {
  return `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "https://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>application-identifier</key><string>${appId}</string><key>com.apple.developer.team-identifier</key><string>${TEAM}</string><key>get-task-allow</key><true/><key>keychain-access-groups</key><array><string>${appId}</string></array></dict></plist>`;
}
/** O Info.plist que o Xcode copia do modelo do XCTRunner (sem `UILaunchScreen`). */
const RUNNER_INFO_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleIdentifier</key>
	<string>app.kifactory.contrarregra.runner.xctrunner</string>
</dict>
</plist>
`;

const FIXTURES = new URL('./fixtures/protocol/', import.meta.url);
const HELLO_RESULT = (JSON.parse(readFileSync(new URL('RpcResponse.session.hello.json', FIXTURES), 'utf8')) as { result: unknown }).result;
const HEALTH_RESULT = (JSON.parse(readFileSync(new URL('RpcResponse.health.json', FIXTURES), 'utf8')) as { result: unknown }).result;

/** O `.xctestrun` que o `build-for-testing` gera (formato 1, a forma do Xcode 26.6 para este esquema). */
function generatedXctestrun(configuration: string, marker = 'gerado'): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>ContrarregraRunner</key>
	<dict>
		<key>BlueprintName</key>
		<string>ContrarregraRunner</string>
		<key>DefaultTestExecutionTimeAllowance</key>
		<integer>600</integer>
		<key>DependentProductPaths</key>
		<array>
			<string>__TESTROOT__/${configuration}-iphoneos/ContrarregraHost.app</string>
			<string>__TESTROOT__/${configuration}-iphoneos/ContrarregraRunner-Runner.app</string>
		</array>
		<key>EnvironmentVariables</key>
		<dict>
			<key>OS_ACTIVITY_DT_MODE</key>
			<string>YES</string>
			<key>SDK_MARKER</key>
			<string>${marker}</string>
			<key>TERM</key>
			<string>dumb</string>
		</dict>
		<key>IsUITestBundle</key>
		<true/>
		<key>PreferredScreenCaptureFormat</key>
		<string>screenRecording</string>
		<key>SystemAttachmentLifetime</key>
		<string>keepNever</string>
		<key>TestBundlePath</key>
		<string>__TESTHOST__/PlugIns/ContrarregraRunner.xctest</string>
		<key>TestHostBundleIdentifier</key>
		<string>app.kifactory.contrarregra.runner.xctrunner</string>
		<key>TestHostPath</key>
		<string>__TESTROOT__/${configuration}-iphoneos/ContrarregraRunner-Runner.app</string>
		<key>TestLanguage</key>
		<string></string>
		<key>TestTimeoutsEnabled</key>
		<false/>
		<key>UITargetAppPath</key>
		<string>__TESTROOT__/${configuration}-iphoneos/ContrarregraHost.app</string>
		<key>UserAttachmentLifetime</key>
		<string>deleteOnSuccess</string>
	</dict>
	<key>__xctestrun_metadata__</key>
	<dict>
		<key>ContainerInfo</key>
		<dict>
			<key>ContainerName</key>
			<string>Contrarregra</string>
			<key>SchemeName</key>
			<string>ContrarregraRunner</string>
		</dict>
		<key>FormatVersion</key>
		<integer>1</integer>
	</dict>
</dict>
</plist>
`;
}

// ── Ferramentas falsas ──────────────────────────────────────────────────────────────────────────────

/** Bloco de shell que registra pid, grupo, entrada/saída (pipe, arquivo, dispositivo) e argumentos. */
const RECORD = `dir=$(cd "$(dirname "$0")" && pwd)
tool=$(basename "$0")
rec="$dir/calls/$tool.$$"
{
  echo "pid=$$"
  echo "pgid=$(ps -o pgid= -p $$ | tr -d ' ')"
  if [ -p /dev/fd/0 ]; then echo stdin=pipe; elif [ -c /dev/fd/0 ]; then echo stdin=chardev; else echo stdin=other; fi
  if [ -p /dev/fd/1 ]; then echo stdout=pipe; elif [ -f /dev/fd/1 ]; then echo stdout=file; else echo stdout=other; fi
  if [ -p /dev/fd/2 ]; then echo stderr=pipe; elif [ -f /dev/fd/2 ]; then echo stderr=file; else echo stderr=other; fi
  echo "env_ONETAKE_HOST_BUNDLE_ID=\${ONETAKE_HOST_BUNDLE_ID-}"
  echo "env_ONETAKE_RUNNER_TEST_BUNDLE_ID=\${ONETAKE_RUNNER_TEST_BUNDLE_ID-}"
  echo "env_ONETAKE_SIGNING_TEAM=\${ONETAKE_SIGNING_TEAM-}"
  for a in "$@"; do echo "arg=$a"; done
} > "$rec.tmp" && mv "$rec.tmp" "$rec"
`;

const FAKE_XCODEBUILD = `#!/bin/sh
# xcodebuild falso (T-0.10)
${RECORD}
echo "xcodebuild falso: $1"
case "$1" in
  build-for-testing)
    dd=""; cfg=Debug; prev=""
    for a in "$@"; do
      case "$prev" in -derivedDataPath) dd="$a";; -configuration) cfg="$a";; esac
      prev="$a"
    done
    mkdir -p "$dd/Build/Products"
    sed "s/@CONFIG@/$cfg/g" "$dir/template.xctestrun" > "$dd/Build/Products/${XCTESTRUN_NAME}"
    # os dois .app "assinados pelo Xcode"; o Info.plist do XCTRunner só é copiado do modelo quando falta
    # (build incremental: o Xcode não o recopia) e o .xcent é o que o Xcode usou na assinatura
    app="$dd/Build/Products/$cfg-iphoneos/ContrarregraRunner-Runner.app"
    mkdir -p "$app" "$dd/Build/Products/$cfg-iphoneos/ContrarregraHost.app"
    [ -f "$app/Info.plist" ] || cp "$dir/runner-info.plist" "$app/Info.plist"
    [ -f "$app/ContrarregraRunner-Runner" ] || echo "binário do runner" > "$app/ContrarregraRunner-Runner"
    host="$dd/Build/Products/$cfg-iphoneos/ContrarregraHost.app"
    [ -f "$host/Info.plist" ] || echo "plist do hospedeiro" > "$host/Info.plist"
    [ -f "$host/ContrarregraHost" ] || echo "binário do hospedeiro" > "$host/ContrarregraHost"
    # o "Xcode" cria uma identidade nova no chaveiro durante o build (P-3: o runner build tem de parar)
    [ -f "$dir/xcodebuild.adds-identity" ] && touch "$dir/keychain.changed"
    xcent="$dd/Build/Intermediates.noindex/Contrarregra.build/$cfg-iphoneos/ContrarregraRunner.build"
    mkdir -p "$xcent"
    cp "$dir/xcent.xml" "$xcent/ContrarregraRunner.xctest.xcent"
    exit "$(cat "$dir/build.exit" 2>/dev/null || echo 0)"
    ;;
  test-without-building)
    if [ "$(cat "$dir/serve.mode" 2>/dev/null)" = exit ]; then exit 3; fi
    while :; do sleep 1; done
    ;;
esac
exit 64
`;

const FAKE_XCODEGEN = `#!/bin/sh
# xcodegen falso (T-0.10)
${RECORD}
exit "$(cat "$dir/xcodegen.exit" 2>/dev/null || echo 0)"
`;

const FAKE_CAFFEINATE = `#!/bin/sh
# caffeinate falso (T-0.10): vive enquanto o pid de -w viver
${RECORD}
w=""; prev=""
for a in "$@"; do [ "$prev" = -w ] && w="$a"; prev="$a"; done
while kill -0 "$w" 2>/dev/null; do sleep 0.1; done
`;

const FAKE_XCRUN = `#!/bin/sh
# xcrun falso (T-0.10): só devicectl list devices --json-output <arquivo>
${RECORD}
out=""; prev=""
for a in "$@"; do [ "$prev" = --json-output ] && out="$a"; prev="$a"; done
if [ "$1" = devicectl ] && [ -n "$out" ]; then cp "$dir/devicectl.json" "$out"; exit 0; fi
exit 1
`;

const FAKE_CODESIGN = `#!/bin/sh
# codesign falso (T-0.11): nunca assina de verdade. O .app é sempre o último argumento; depois da "reassinatura"
# (--force) o .app ganha a marca .resigned e, se existirem, valem as versões *.after das respostas.
${RECORD}
last=""; for a in "$@"; do last="$a"; done
pick() { if [ -f "$last/.resigned" ] && [ -f "$dir/$1.after" ]; then cat "$dir/$1.after"; else cat "$dir/$1"; fi; }
case "$1" in
  -d)
    case "$2" in
      --verbose=2) echo "Executable=$last/bin" >&2; pick codesign.display >&2; exit 0 ;;
      --extract-certificates=*) prefix="\${2#--extract-certificates=}"; pick leaf.cer > "\${prefix}0"; echo raiz > "\${prefix}1"; exit 0 ;;
      --entitlements) echo "Executable=$last/bin" >&2; pick entitlements.xml; exit 0 ;;
    esac ;;
  --force)
    cp "$last/Info.plist" "$dir/plist-at-sign"
    echo "reassinado" >> "$last/$(basename "$last" .app)"
    touch "$last/.resigned" "$dir/signed"
    exit "$(cat "$dir/sign.exit" 2>/dev/null || echo 0)" ;;
  --verify) exit "$(cat "$dir/verify.exit" 2>/dev/null || echo 0)" ;;
esac
exit 64
`;

const FAKE_PLISTBUDDY = `#!/bin/sh
# PlistBuddy falso (T-0.11): só Print/Add :UILaunchScreen num plist XML que termina em </dict></plist>
${RECORD}
case "$2" in
  "Print :UILaunchScreen")
    if grep -q "<key>UILaunchScreen</key>" "$3"; then echo "Dict {"; echo "}"; exit 0; fi
    echo 'Print: Entry, ":UILaunchScreen", Does Not Exist' >&2; exit 1 ;;
  "Add :UILaunchScreen dict")
    [ -f "$dir/add.exit" ] && exit "$(cat "$dir/add.exit")"
    sed '$d' "$3" | sed '$d' > "$3.tmp"
    printf '\t<key>UILaunchScreen</key>\n\t<dict/>\n</dict>\n</plist>\n' >> "$3.tmp"
    mv "$3.tmp" "$3"; exit 0 ;;
esac
exit 64
`;

const FAKE_SECURITY = `#!/bin/sh
# security falso (T-0.11): só find-identity -v -p codesigning; depois da "reassinatura" ou de o "Xcode" criar uma
# identidade (keychain.changed), vale identities.after.txt
${RECORD}
if [ "$1" = find-identity ]; then
  if { [ -f "$dir/signed" ] || [ -f "$dir/keychain.changed" ]; } && [ -f "$dir/identities.after.txt" ]; then cat "$dir/identities.after.txt"; else cat "$dir/identities.txt"; fi
  exit 0
fi
exit 64
`;

function devicectlJson(transportType: string, tunnelState: string): string {
  return JSON.stringify({
    info: { outcome: 'success' },
    result: {
      devices: [
        { identifier: 'AAAAAAAA-0000-0000-0000-000000000000', hardwareProperties: { udid: '00008030-000A1B2C3D4E5F60' }, connectionProperties: { transportType: 'wired', tunnelState: 'connected' } },
        { identifier: CORE_DEVICE_ID, hardwareProperties: { udid: UDID }, connectionProperties: { transportType, tunnelState, tunnelTransportProtocol: 'tcp' } },
      ],
    },
  });
}

interface Call {
  tool: string;
  pid: number;
  pgid: number;
  stdin: string;
  stdout: string;
  stderr: string;
  args: string[];
  environment: Record<string, string>;
  mtimeMs: number;
}

// ── Runner falso ────────────────────────────────────────────────────────────────────────────────────

interface FakeEvent {
  seq: number;
  kind: string;
}

interface FakeRunner {
  readonly port: number;
  readonly url: string;
  readonly server: WsTestServer;
  readonly calls: { method: string; params: Record<string, unknown> | undefined }[];
  readonly hellos: { token: string; role: string }[];
  /** Métodos que ficam sem resposta (runner travado). */
  readonly mute: Set<string>;
  /** Só as próximas N chamadas do método ficam sem resposta (cada uma consome 1). */
  readonly muteNext: Map<string, number>;
  /** Chamado logo antes de responder ao `events.fetch` (ex.: notificar um evento antes da resposta). */
  beforeFetchResponse: (() => void) | undefined;
  /** O que `events.fetch` devolve (`seq >= sinceSeq`). */
  events: FakeEvent[];
  emit(event: FakeEvent): void;
  close(): Promise<void>;
}

/** O token do `.xctestrun` de sessão mais novo, lido à parte (o runner o recebe pelo ambiente). */
function tokenFromSessions(sessionsDir: string): string | undefined {
  let names: string[];
  try {
    names = readdirSync(sessionsDir).filter((name) => name.endsWith('.xctestrun'));
  } catch {
    return undefined;
  }
  const newest = names.map((name) => join(sessionsDir, name)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
  if (newest === undefined) return undefined;
  return /<key>CONTRARREGRA_TOKEN<\/key>\s*<string>([^<]*)<\/string>/.exec(readFileSync(newest, 'utf8'))?.[1];
}

async function startFakeRunner(sessionsDir: string): Promise<FakeRunner> {
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

  const fake: FakeRunner = {
    port: 0,
    url: '',
    server: undefined as unknown as WsTestServer,
    calls: [],
    hellos: [],
    mute: new Set(),
    muteNext: new Map(),
    beforeFetchResponse: undefined,
    events: [],
    emit(event) {
      if (control !== null) send(control, { jsonrpc: '2.0', method: 'event', params: event });
    },
    close: () => server.close(),
  };

  const handle = (conn: WsTestConnection, text: string): void => {
    const message = JSON.parse(text) as { id: unknown; method: string; params?: Record<string, unknown> };
    const { id, method, params } = message;
    fake.calls.push({ method, params });
    if (fake.mute.has(method)) return;
    const muted = fake.muteNext.get(method) ?? 0;
    if (muted > 0) {
      fake.muteNext.set(method, muted - 1);
      return;
    }
    if (method !== 'session.hello' && !roles.has(conn)) return fail(conn, id, -32001, 'E_AUTH: sem session.hello');
    switch (method) {
      case 'session.hello': {
        const token = String(params?.['token']);
        const role = String(params?.['role']);
        fake.hellos.push({ token, role });
        const expected = tokenFromSessions(sessionsDir);
        if (expected === undefined || token !== expected) return fail(conn, id, -32001, 'E_AUTH: token errado');
        if (role === 'control') {
          if (control !== null && control !== conn) return fail(conn, id, -32002, 'E_BUSY: já há um controlador');
          control = conn;
        }
        roles.set(conn, role);
        return send(conn, { jsonrpc: '2.0', id, result: HELLO_RESULT });
      }
      case 'health':
        return send(conn, { jsonrpc: '2.0', id, result: HEALTH_RESULT });
      case 'clock.ping':
        return send(conn, { jsonrpc: '2.0', id, result: { seq: params?.['seq'], t2RawNs: '1000', t3RawNs: '1500', t2UptimeNs: '900' } });
      case 'events.fetch': {
        const since = Number(params?.['sinceSeq']);
        const events = fake.events.filter((event) => event.seq >= since);
        fake.beforeFetchResponse?.();
        return send(conn, { jsonrpc: '2.0', id, result: { events, lastSeq: fake.events.at(-1)?.seq ?? 0 } });
      }
      case 'runner.shutdown':
        return send(conn, { jsonrpc: '2.0', id, result: {} });
      default:
        return fail(conn, id, -32601, `método inexistente: ${method}`);
    }
  };

  const server = await startWsServer({
    onConnection: (conn) => {
      void conn.closed.then(() => {
        if (control === conn) control = null;
        roles.delete(conn);
      });
      conn.onMessage((text) => handle(conn, text));
    },
  });
  return Object.assign(fake, { port: server.port, url: server.url, server });
}

// ── Ambiente de teste ───────────────────────────────────────────────────────────────────────────────

interface Env {
  root: string;
  toolsDir: string;
  tools: RunnerTools;
  configPath: string;
  /** A pasta do `config.json` (temporária): onde o `runner build` grava a linha de base da assinatura. */
  configDir: string;
  config: Config;
  usbmuxd: FakeUsbmuxd;
  /** As portas do "aparelho" no usbmuxd falso (sem a 8700 = runner não escuta: `Connect` → 3). */
  devicePorts: Record<number, 'echo' | number>;
  runner: FakeRunner;
  cache: string;
  sessions: string;
  products: string;
  logs: string;
  lockFile: string;
  takes: string;
}

interface SetupOptions {
  /** Configuração já construída em `products` (como depois de um `runner build`). */
  built?: 'Debug' | 'Spike';
  /** O runner já escuta na porta (padrão: sim). */
  listening?: boolean;
  /** Campos a mais no `config.json`. */
  config?: Record<string, unknown>;
}

const envs: Env[] = [];
const cleanups: (() => Promise<void> | void)[] = [];
/** Prazo de cada limpeza: o `after` nunca pode travar o arquivo de teste. */
const CLEANUP_TIMEOUT_MS = 3_000;

/** Mata todo processo cuja linha de comando cita uma raiz de teste (sessões falsas, supervisores). */
function killUnder(roots: readonly string[]): void {
  if (roots.length === 0) return;
  const ps = spawnSync('/bin/ps', ['-axww', '-o', 'pid=,command='], { encoding: 'utf8' });
  for (const line of (ps.stdout ?? '').split('\n')) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (match === null || Number(match[1]) === process.pid) continue;
    if (!roots.some((root) => match[2]!.includes(root))) continue;
    for (const target of [-Number(match[1]), Number(match[1])]) {
      try {
        process.kill(target, 'SIGKILL');
      } catch {
        // já saiu
      }
    }
  }
}

after(async () => {
  // Pelos registros das ferramentas falsas e, para o que ainda não registrou, pela linha de comando.
  for (const env of envs) killRecorded(env);
  killUnder(envs.map((env) => env.root));
  for (const cleanup of cleanups.reverse()) {
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([Promise.resolve().then(cleanup), new Promise<void>((resolve) => (timer = setTimeout(resolve, CLEANUP_TIMEOUT_MS)))]).catch(() => {});
    clearTimeout(timer);
  }
});
// Última rede: se o arquivo morrer antes do `after`, nada falso fica vivo.
process.on('exit', () => killUnder(envs.map((env) => env.root)));

function writeScript(path: string, text: string): void {
  writeFileSync(path, text);
  chmodSync(path, 0o755);
}

async function setup(options: SetupOptions = {}): Promise<Env> {
  const root = shortTempDir('crr-runner-');
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const toolsDir = join(root, 'tools');
  mkdirSync(join(toolsDir, 'calls'), { recursive: true });
  const tools: RunnerTools = {
    xcodebuild: join(toolsDir, 'xcodebuild'),
    xcodegen: join(toolsDir, 'xcodegen'),
    caffeinate: join(toolsDir, 'caffeinate'),
    xcrun: join(toolsDir, 'xcrun'),
    codesign: join(toolsDir, 'codesign'),
    plistBuddy: join(toolsDir, 'PlistBuddy'),
    security: join(toolsDir, 'security'),
  };
  writeScript(tools.xcodebuild, FAKE_XCODEBUILD);
  writeScript(tools.xcodegen, FAKE_XCODEGEN);
  writeScript(tools.caffeinate, FAKE_CAFFEINATE);
  writeScript(tools.xcrun, FAKE_XCRUN);
  writeScript(tools.codesign, FAKE_CODESIGN);
  writeScript(tools.plistBuddy, FAKE_PLISTBUDDY);
  writeScript(tools.security, FAKE_SECURITY);
  writeFileSync(join(toolsDir, 'runner-info.plist'), RUNNER_INFO_PLIST);
  writeFileSync(join(toolsDir, 'xcent.xml'), entitlementsXml());
  writeFileSync(join(toolsDir, 'entitlements.xml'), entitlementsXml());
  writeFileSync(join(toolsDir, 'leaf.cer'), LEAF_CERT);
  writeFileSync(join(toolsDir, 'codesign.display'), codesignDisplay());
  writeFileSync(join(toolsDir, 'identities.txt'), IDENTITIES);
  writeFileSync(join(toolsDir, 'template.xctestrun'), generatedXctestrun('@CONFIG@'));
  writeFileSync(join(toolsDir, 'devicectl.json'), devicectlJson('wired', 'connected'));

  const cache = join(root, 'cache');
  const sessions = join(cache, 'sessions');
  const products = join(cache, 'DerivedData', 'Build', 'Products');
  const takes = join(root, 'takes');
  const runner = await startFakeRunner(sessions);
  cleanups.push(() => runner.close());
  const devicePorts: Record<number, 'echo' | number> = options.listening === false ? {} : { [RUNNER_PORT]: runner.port };
  const usbmuxd = await startFakeUsbmuxd(root, { devices: [USB_ENTRY], devicePorts });
  cleanups.push(() => usbmuxd.close());

  const configPath = join(root, 'config.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      usbmux: { socketPath: usbmuxd.socketPath },
      paths: { cache, takes },
      runner: { privateAllowed: ['PX-1', 'PX-3'] },
      apps: { allowed: ['com.example.other'] },
      urls: { allowedPrefixes: ['https://example.com/'] },
      app: { explore: 'com.example.target' },
      signing: { team: TEAM, identity: IDENTITY },
      device: { udid: UDID, coreDeviceId: CORE_DEVICE_ID, name: 'Test iPhone' },
      ...options.config,
    }),
  );
  const config = loadConfig({ configPath });
  if (options.built !== undefined) {
    mkdirSync(products, { recursive: true });
    writeFileSync(join(products, XCTESTRUN_NAME), generatedXctestrun(options.built));
    markVerified(config, products, options.built);
  }
  const env: Env = {
    root,
    toolsDir,
    tools,
    configPath,
    configDir: root,
    config,
    usbmuxd,
    devicePorts,
    runner,
    cache,
    sessions,
    products,
    logs: join(cache, 'logs'),
    lockFile: join(cache, 'locks', `${UDID}.lock`),
    takes,
  };
  envs.push(env);
  return env;
}

/** Os dois .app de um build (como o `build-for-testing` deixa) e a marca de "conferido" que o `runner build` grava. */
function markVerified(config: Config, products: string, configuration: string): void {
  const dir = join(products, `${configuration}-iphoneos`);
  for (const [app, exe] of [
    ['ContrarregraRunner-Runner.app', 'ContrarregraRunner-Runner'],
    ['ContrarregraHost.app', 'ContrarregraHost'],
  ] as const) {
    mkdirSync(join(dir, app), { recursive: true });
    writeFileSync(join(dir, app, 'Info.plist'), RUNNER_INFO_PLIST);
    writeFileSync(join(dir, app, exe), `binário ${exe}`);
  }
  const built = findBuiltXctestrun(products, configuration);
  assert.ok(built !== undefined, `há .xctestrun ${configuration}`);
  recordVerifiedBuild(runnerPaths(config), built);
}

function calls(env: Env, tool: string): Call[] {
  const dir = join(env.toolsDir, 'calls');
  return readdirSync(dir)
    .filter((name) => name.startsWith(`${tool}.`) && !name.endsWith('.tmp'))
    .map((name) => {
      const path = join(dir, name);
      const call: Call = { tool, pid: 0, pgid: 0, stdin: '', stdout: '', stderr: '', args: [], environment: {}, mtimeMs: statSync(path).mtimeMs };
      for (const line of readFileSync(path, 'utf8').split('\n')) {
        const eq = line.indexOf('=');
        if (eq < 0) continue;
        const key = line.slice(0, eq);
        const value = line.slice(eq + 1);
        if (key === 'arg') call.args.push(value);
        else if (key === 'pid') call.pid = Number(value);
        else if (key === 'pgid') call.pgid = Number(value);
        else if (key === 'stdin') call.stdin = value;
        else if (key === 'stdout') call.stdout = value;
        else if (key === 'stderr') call.stderr = value;
        else if (key.startsWith('env_')) call.environment[key.slice(4)] = value;
      }
      return call;
    })
    .sort((a, b) => a.mtimeMs - b.mtimeMs || a.pid - b.pid);
}

function serveCalls(env: Env): Call[] {
  return calls(env, 'xcodebuild').filter((call) => call.args[0] === 'test-without-building');
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  // um zumbi ainda responde ao kill 0; o `ps` mostra o estado
  const ps = spawnSync('/bin/ps', ['-p', String(pid), '-o', 'stat='], { encoding: 'utf8' });
  return ps.status === 0 && !ps.stdout.trim().startsWith('Z');
}

function killRecorded(env: Env): void {
  for (const tool of ['xcodebuild', 'caffeinate']) {
    let recorded: Call[] = [];
    try {
      recorded = calls(env, tool);
    } catch {
      continue;
    }
    for (const call of recorded) {
      for (const target of [-call.pid, call.pid]) {
        try {
          process.kill(target, 'SIGKILL');
        } catch {
          // já saiu
        }
      }
    }
  }
}

/** Espera o runner falso ver fechadas as conexões de quem já terminou (o `control` fica livre). */
function idle(env: Env): Promise<void> {
  return waitFor(() => env.runner.server.connections.size === 0, 'conexões com o runner falso fechadas');
}

/** Opções rápidas para os testes (o padrão espera segundos). */
function fast(env: Env, extra: UpOptions = {}): UpOptions {
  return { tools: env.tools, pollMs: 20, readyTimeoutMs: 5_000, shutdownGraceMs: 100, termGraceMs: 2_000, ...extra };
}

async function waitFor(predicate: () => boolean, what: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`esperei demais: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function rejectsWith(promise: Promise<unknown>, code: string): Promise<{ message: string; data: Record<string, unknown> }> {
  try {
    await promise;
  } catch (error) {
    assert.ok(isContrarregraError(error), `esperava ContrarregraError, veio ${String(error)}`);
    assert.equal(error.code, code, `esperava ${code}, veio ${error.code}: ${error.message}`);
    return { message: error.message, data: { ...error.data } };
  }
  assert.fail(`esperava ${code}, mas a promessa foi cumprida`);
}

function sessionFiles(env: Env, ext: string): string[] {
  try {
    return readdirSync(env.sessions).filter((name) => name.endsWith(ext));
  } catch {
    return [];
  }
}

function sessionDoc(path: string): PlistDict {
  const doc = decodePlist(readFileSync(path, 'utf8'));
  assert.ok(isPlistDict(doc));
  const target = doc['ContrarregraRunner'];
  assert.ok(isPlistDict(target), 'o alvo ContrarregraRunner continua no topo (formato 1)');
  return target;
}

function sessionVars(target: PlistDict): Record<string, unknown> {
  const env = target['EnvironmentVariables'];
  assert.ok(isPlistDict(env));
  return env;
}

function allLogText(env: Env): string {
  let text = '';
  try {
    for (const name of readdirSync(env.logs)) text += readFileSync(join(env.logs, name), 'utf8');
  } catch {
    // sem registros
  }
  return text;
}

// ── .xctestrun da sessão ────────────────────────────────────────────────────────────────────────────

describe('.xctestrun da sessão (S2 item 1, S1 item 9)', () => {
  test('cópia do gerado com as variáveis do runner, capturas desligadas e __TESTROOT__ resolvido; o original fica intacto', () => {
    const source = parseXctestrun(generatedXctestrun('Debug'));
    const before = JSON.stringify(source);
    const doc = makeSessionXctestrun(source, { testRoot: '/x/Products', env: { CONTRARREGRA_PORT: '8700', CONTRARREGRA_TOKEN: 't' } });
    assert.equal(JSON.stringify(source), before, 'o documento gerado não muda');
    const target = runnerTarget(doc);
    assert.deepEqual(target['EnvironmentVariables'], {
      OS_ACTIVITY_DT_MODE: 'YES',
      SDK_MARKER: 'gerado',
      TERM: 'dumb',
      CONTRARREGRA_PORT: '8700',
      CONTRARREGRA_TOKEN: 't',
    });
    assert.equal(target['SystemAttachmentLifetime'], 'keepNever');
    assert.equal(target['UserAttachmentLifetime'], 'keepNever');
    assert.equal(target['PreferredScreenCaptureFormat'], 'screenshots');
    assert.equal(target['TestHostPath'], '/x/Products/Debug-iphoneos/ContrarregraRunner-Runner.app');
    assert.equal(target['TestBundlePath'], '__TESTHOST__/PlugIns/ContrarregraRunner.xctest', '__TESTHOST__ é do xcodebuild e fica');
    assert.equal(target['TestTimeoutsEnabled'], false);
    assert.ok(!JSON.stringify(doc).includes('__TESTROOT__'));
  });

  test('formato 2 (TestConfigurations[].TestTargets[]) e a configuração pela pasta do TestHostPath', () => {
    const v2 = parseXctestrun(
      generatedXctestrun('Spike').replace(
        /<dict>\n\t<key>ContrarregraRunner<\/key>\n\t<dict>([\s\S]*?)\n\t<\/dict>\n\t<key>__xctestrun_metadata__/,
        '<dict>\n<key>TestConfigurations</key><array><dict><key>Name</key><string>Test Scheme Action</string><key>TestTargets</key><array><dict>$1</dict></array></dict></array>\n\t<key>__xctestrun_metadata__',
      ),
    );
    assert.ok(Array.isArray(v2['TestConfigurations']), 'o documento virou formato 2');
    assert.equal(xctestrunConfiguration(v2), 'Spike');
    const doc = makeSessionXctestrun(v2, { testRoot: '/p', env: { CONTRARREGRA_BIND: 'loopback' } });
    assert.equal((runnerTarget(doc)['EnvironmentVariables'] as PlistDict)['CONTRARREGRA_BIND'], 'loopback');
    assert.equal(xctestrunConfiguration(parseXctestrun(generatedXctestrun('Debug'))), 'Debug');
  });
});

// ── runner build ────────────────────────────────────────────────────────────────────────────────────

describe('runner build (S2 item 1, D3.3)', () => {
  test('sem time configurado falha antes de chaveiro, XcodeGen ou baseline', async () => {
    const env = await setup({ config: { signing: { team: '', identity: '' } } });
    const { data } = await rejectsWith(buildRunner(env.config, { tools: env.tools, configDir: env.configDir }), 'E_CONFIG');
    assert.equal(data['field'], 'signing.team');
    assert.equal(calls(env, 'security').length, 0);
    assert.equal(calls(env, 'xcodegen').length, 0);
    assert.equal(existsSync(join(env.configDir, SIGNING_BASELINE_FILE)), false);
  });

  test('sem identidade Apple Development explícita falha antes do chaveiro', async () => {
    const env = await setup({ config: { signing: { team: TEAM, identity: '' } } });
    const { data } = await rejectsWith(buildRunner(env.config, { tools: env.tools, configDir: env.configDir }), 'E_CONFIG');
    assert.equal(data['field'], 'signing.identity');
    assert.equal(calls(env, 'security').length, 0);
  });

  test('IDs de host e teste iguais falham antes do chaveiro', async () => {
    const env = await setup({ config: { bundle: { host: 'dev.sample.onetake', runnerTest: 'dev.sample.onetake' } } });
    const { data } = await rejectsWith(buildRunner(env.config, { tools: env.tools, configDir: env.configDir }), 'E_CONFIG');
    assert.equal(data['field'], 'bundle.runnerTest');
    assert.equal(calls(env, 'security').length, 0);
  });

  test('encaminha os IDs separados ao XcodeGen e não substitui PRODUCT_BUNDLE_IDENTIFIER globalmente', async () => {
    const env = await setup({ config: { bundle: { host: 'dev.sample.onetake', runnerTest: 'dev.sample.onetake.tests' } } });
    writeFileSync(join(env.toolsDir, 'codesign.display'), codesignDisplay(IDENTITY, TEAM, 'dev.sample.onetake.tests.xctrunner'));
    writeFileSync(join(env.toolsDir, 'xcent.xml'), entitlementsXml(`${TEAM}.dev.sample.onetake.tests.xctrunner`));
    writeFileSync(join(env.toolsDir, 'entitlements.xml'), entitlementsXml(`${TEAM}.dev.sample.onetake.tests.xctrunner`));
    await buildRunner(env.config, { tools: env.tools, configDir: env.configDir });
    const gen = calls(env, 'xcodegen')[0]!;
    assert.equal(gen.environment?.['ONETAKE_HOST_BUNDLE_ID'], 'dev.sample.onetake');
    assert.equal(gen.environment?.['ONETAKE_RUNNER_TEST_BUNDLE_ID'], 'dev.sample.onetake.tests');
    assert.equal(gen.environment?.['ONETAKE_SIGNING_TEAM'], TEAM);
    assert.ok(!calls(env, 'xcodebuild')[0]!.args.some((arg) => arg.startsWith('PRODUCT_BUNDLE_IDENTIFIER=')));
  });

  test('xcodegen generate + xcodebuild build-for-testing com o time fixo e assinatura automática, saída em arquivo', async () => {
    const env = await setup();
    const result = await buildRunner(env.config, { tools: env.tools, configDir: env.configDir });
    const [gen] = calls(env, 'xcodegen');
    assert.deepEqual(gen!.args, ['generate', '--spec', join(REPO_ROOT, 'ios', 'project.yml')]);
    const [build] = calls(env, 'xcodebuild');
    assert.deepEqual(build!.args, [
      'build-for-testing',
      '-project',
      join(REPO_ROOT, 'ios', 'Contrarregra.xcodeproj'),
      '-scheme',
      'ContrarregraRunner',
      '-destination',
      'generic/platform=iOS',
      '-derivedDataPath',
      join(env.cache, 'DerivedData'),
      '-allowProvisioningUpdates',
      'DEVELOPMENT_TEAM=984PNJZ8B9',
      'CODE_SIGN_STYLE=Automatic',
    ]);
    for (const call of [gen!, build!]) {
      assert.deepEqual([call.stdin, call.stdout, call.stderr], ['chardev', 'file', 'file'], `${call.tool} sem pipes`);
    }
    assert.equal(result.configuration, 'Debug');
    assert.equal(result.xctestrun, join(env.products, XCTESTRUN_NAME));
    assert.ok(readFileSync(result.log, 'utf8').includes('xcodebuild falso: build-for-testing'), 'a saída foi para o registro');
  });

  test('--configuration Spike passa -configuration Spike e devolve o .xctestrun do Spike', async () => {
    const env = await setup();
    const result = await buildRunner(env.config, { tools: env.tools, configDir: env.configDir, configuration: 'Spike' });
    const [build] = calls(env, 'xcodebuild');
    const at = build!.args.indexOf('-configuration');
    assert.ok(at > 0 && build!.args[at + 1] === 'Spike');
    assert.equal(result.configuration, 'Spike');
  });

  test('xcodegen falhando para antes do xcodebuild, com o caminho do registro', async () => {
    const env = await setup();
    writeFileSync(join(env.toolsDir, 'xcodegen.exit'), '1');
    const { data } = await rejectsWith(buildRunner(env.config, { tools: env.tools, configDir: env.configDir }), 'E_RUNNER_DOWN');
    assert.equal(data['reason'], 'build-failed');
    assert.equal(data['step'], 'xcodegen generate');
    assert.ok(typeof data['log'] === 'string' && existsSync(data['log']));
    assert.equal(calls(env, 'xcodebuild').length, 0);
  });
});

describe('runner build: UILaunchScreen e reassinatura do XCTRunner (S2 item 1; P-3)', () => {
  function productPaths(env: Env, configuration = 'Debug') {
    const dir = join(env.products, `${configuration}-iphoneos`);
    return {
      app: join(dir, 'ContrarregraRunner-Runner.app'),
      host: join(dir, 'ContrarregraHost.app'),
      xcent: join(env.cache, 'DerivedData', 'Build', 'Intermediates.noindex', 'Contrarregra.build', `${configuration}-iphoneos`, 'ContrarregraRunner.build', 'ContrarregraRunner.xctest.xcent'),
    };
  }
  const signCalls = (env: Env): Call[] => calls(env, 'codesign').filter((call) => call.args[0] === '--force');
  const addCalls = (env: Env): Call[] => calls(env, 'PlistBuddy').filter((call) => call.args[1] === 'Add :UILaunchScreen dict');
  const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');
  const count = (text: string, needle: string): number => text.split(needle).length - 1;

  test('os testes nunca usam as ferramentas de verdade (nenhuma assinatura real, nenhum chaveiro)', async () => {
    const env = await setup();
    for (const key of ['codesign', 'plistBuddy', 'security', 'xcodebuild'] as const) {
      assert.ok(env.tools[key].startsWith(env.toolsDir), `${key} falso`);
      assert.notEqual(env.tools[key], DEFAULT_TOOLS[key]);
    }
    assert.deepEqual([DEFAULT_TOOLS.codesign, DEFAULT_TOOLS.plistBuddy, DEFAULT_TOOLS.security], ['/usr/bin/codesign', '/usr/libexec/PlistBuddy', '/usr/bin/security']);
  });

  test('acrescenta UILaunchScreen e reassina só o .app do XCTRunner, com a identidade e os entitlements que o Xcode usou', async () => {
    const env = await setup();
    const result = await buildRunner(env.config, { tools: env.tools, configDir: env.configDir });
    const { app, host, xcent } = productPaths(env);
    assert.equal(count(readFileSync(join(app, 'Info.plist'), 'utf8'), '<key>UILaunchScreen</key>'), 1);
    assert.ok(readFileSync(join(env.toolsDir, 'plist-at-sign'), 'utf8').includes('<key>UILaunchScreen</key>'), 'a chave entrou antes da assinatura');
    const signs = signCalls(env);
    assert.equal(signs.length, 1, 'uma única reassinatura');
    assert.deepEqual(signs[0]!.args, ['--force', '--sign', LEAF_SHA1, '--entitlements', xcent, '--timestamp=none', '--generate-entitlement-der', app]);
    assert.ok(!signs[0]!.args.includes('--deep'), 'nada aninhado é reassinado (frameworks, .xctest)');
    const verifies = calls(env, 'codesign').filter((call) => call.args[0] === '--verify');
    assert.deepEqual(
      verifies.map((call) => call.args),
      [
        ['--verify', '--deep', '--strict', app],
        ['--verify', '--deep', '--strict', host],
      ],
    );
    assert.equal(calls(env, 'security').length, 2, 'chaveiro lido antes do build e depois da reassinatura');
    for (const call of calls(env, 'security')) assert.deepEqual(call.args, ['find-identity', '-v', '-p', 'codesigning']);
    assert.deepEqual(result.resign, {
      app,
      launchScreen: 'added',
      identity: IDENTITY,
      sha1: LEAF_SHA1,
      team: TEAM,
      identitiesSha256: sha256(IDENTITIES),
    });
    assert.ok(readFileSync(result.log, 'utf8').includes('UILaunchScreen'), 'a etapa aparece no registro do build');
  });

  test('idempotente: com a chave já no plist (build incremental), não a duplica e reassina de novo', async () => {
    const env = await setup();
    await buildRunner(env.config, { tools: env.tools, configDir: env.configDir });
    const second = await buildRunner(env.config, { tools: env.tools, configDir: env.configDir });
    const { app } = productPaths(env);
    assert.equal(count(readFileSync(join(app, 'Info.plist'), 'utf8'), '<key>UILaunchScreen</key>'), 1);
    assert.equal(addCalls(env).length, 1, 'Add só na primeira vez');
    assert.equal(second.resign.launchScreen, 'present');
    assert.equal(signCalls(env).length, 2);
  });

  test('--configuration Spike: o .app, o .xcent e o Info.plist são os do Spike', async () => {
    const env = await setup();
    const result = await buildRunner(env.config, { tools: env.tools, configDir: env.configDir, configuration: 'Spike' });
    const { app, xcent } = productPaths(env, 'Spike');
    assert.equal(result.resign.app, app);
    assert.deepEqual(signCalls(env)[0]!.args, ['--force', '--sign', LEAF_SHA1, '--entitlements', xcent, '--timestamp=none', '--generate-entitlement-der', app]);
    assert.ok(readFileSync(join(app, 'Info.plist'), 'utf8').includes('<key>UILaunchScreen</key>'));
  });

  test('antes de mexer: assinatura do Xcode fora do esperado, certificado fora do chaveiro ou entitlements divergentes → o build falha e nada é reassinado', async () => {
    const cases: [string, (env: Env) => void][] = [
      ['outra identidade', (env) => writeFileSync(join(env.toolsDir, 'codesign.display'), codesignDisplay('Apple Development: outra pessoa (9RLNRB8QXR)'))],
      ['outro time', (env) => writeFileSync(join(env.toolsDir, 'codesign.display'), codesignDisplay(IDENTITY, '59CB45686C'))],
      ['outro bundle id', (env) => writeFileSync(join(env.toolsDir, 'codesign.display'), codesignDisplay(IDENTITY, TEAM, 'app.kifactory.hagah'))],
      ['certificado ausente do chaveiro', (env) => writeFileSync(join(env.toolsDir, 'identities.txt'), identitiesListing([[OTHER_SHA1, IDENTITY]]))],
      ['certificado com outro nome no chaveiro', (env) => writeFileSync(join(env.toolsDir, 'identities.txt'), identitiesListing([[LEAF_SHA1, 'Apple Distribution: outra empresa (V4397KJVXZ)']]))],
      ['.xcent diferente dos entitlements do .app', (env) => writeFileSync(join(env.toolsDir, 'xcent.xml'), entitlementsXml('984PNJZ8B9.outro.app'))],
    ];
    for (const [label, arrange] of cases) {
      const env = await setup();
      arrange(env);
      const { message, data } = await rejectsWith(buildRunner(env.config, { tools: env.tools, configDir: env.configDir }), 'E_RUNNER_DOWN');
      assert.equal(data['reason'], 'resign-failed', label);
      assert.ok(typeof data['log'] === 'string' && existsSync(data['log']), `${label}: com o registro`);
      assert.match(message, /reassinatura do XCTRunner/, label);
      assert.equal(signCalls(env).length, 0, `${label}: nada reassinado`);
      assert.equal(addCalls(env).length, 0, `${label}: o Info.plist não foi tocado`);
    }
  });

  test('depois de reassinar: verify falhando, assinatura ou entitlements mudados, ou identidade nova no chaveiro → o build falha', async () => {
    const cases: [string, (env: Env) => void, RegExp][] = [
      ['codesign --sign falhou', (env) => writeFileSync(join(env.toolsDir, 'sign.exit'), '1'), /codesign/],
      ['verify falhou', (env) => writeFileSync(join(env.toolsDir, 'verify.exit'), '1'), /verify/],
      ['outra identidade depois', (env) => writeFileSync(join(env.toolsDir, 'codesign.display.after'), codesignDisplay('Apple Development: outra pessoa (9RLNRB8QXR)')), /identidade|Authority/],
      ['outro certificado depois', (env) => writeFileSync(join(env.toolsDir, 'leaf.cer.after'), 'outro certificado'), /certificado/],
      ['entitlements mudados', (env) => writeFileSync(join(env.toolsDir, 'entitlements.xml.after'), entitlementsXml('984PNJZ8B9.outro.app')), /entitlements/],
    ];
    for (const [label, arrange, pattern] of cases) {
      const env = await setup();
      arrange(env);
      const { message, data } = await rejectsWith(buildRunner(env.config, { tools: env.tools, configDir: env.configDir }), 'E_RUNNER_DOWN');
      assert.equal(data['reason'], 'resign-failed', label);
      assert.match(message, pattern, label);
    }
  });

  test('PlistBuddy falhando no Add → o build falha antes de assinar', async () => {
    const env = await setup();
    writeFileSync(join(env.toolsDir, 'add.exit'), '1');
    const { data } = await rejectsWith(buildRunner(env.config, { tools: env.tools, configDir: env.configDir }), 'E_RUNNER_DOWN');
    assert.equal(data['reason'], 'resign-failed');
    assert.equal(signCalls(env).length, 0);
  });
});

describe('runner build: linha de base da assinatura (P-3; S2 item 1)', () => {
  // Na pasta da configuração da máquina (aqui, a temporária do `config.json`), nunca no `paths.cache`.
  const baselinePath = (env: Env): string => join(env.configDir, SIGNING_BASELINE_FILE);
  const legacyPath = (env: Env): string => join(env.cache, SIGNING_BASELINE_FILE);
  const readBaseline = (env: Env): Record<string, unknown> => JSON.parse(readFileSync(baselinePath(env), 'utf8')) as Record<string, unknown>;
  const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');
  const withNew = identitiesListing([[OTHER_SHA1, 'Apple Development: outra pessoa (9RLNRB8QXR)'], [LEAF_SHA1, IDENTITY], [NEW_SHA1, IDENTITY]]);

  test('o primeiro build grava a linha de base: o sha das identidades e o SHA-1 do certificado folha', async () => {
    const env = await setup();
    await buildRunner(env.config, { tools: env.tools, configDir: env.configDir });
    const baseline = readBaseline(env);
    assert.equal(baseline['schema'], 'contrarregra.signing-baseline/1');
    assert.equal(baseline['identitiesSha256'], sha256(IDENTITIES));
    assert.equal(baseline['leafSha1'], LEAF_SHA1);
    assert.equal(baseline['identity'], IDENTITY);
    assert.equal(baseline['team'], TEAM);
  });

  test('mora na pasta da configuração (0600; pasta criada com 0700 se faltar), não no cache', async () => {
    const env = await setup();
    const configDir = join(env.root, 'home', '.config', 'contrarregra');
    await buildRunner(env.config, { tools: env.tools, configDir });
    const path = join(configDir, SIGNING_BASELINE_FILE);
    // gravada duas vezes (identidades antes do xcodebuild, certificado folha depois de conferir), sempre 0600
    assert.equal((JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>)['leafSha1'], LEAF_SHA1);
    assert.equal(statSync(path).mode & 0o777, 0o600, 'arquivo 0600');
    assert.equal(statSync(configDir).mode & 0o777, 0o700, 'pasta criada com 0700');
    assert.equal(existsSync(legacyPath(env)), false, 'nada no paths.cache');
  });

  test('pelo CLI, a linha de base vai para a pasta do config.json lido', async () => {
    const env = await setup();
    const out: string[] = [];
    const err: string[] = [];
    const io = { stdout: (t: string) => void out.push(t), stderr: (t: string) => void err.push(t) };
    assert.equal(await main(['runner', 'build', '--json'], { config: { configPath: env.configPath }, tools: env.tools, io }), 0, err.join(''));
    assert.equal(readBaseline(env)['leafSha1'], LEAF_SHA1);
    assert.equal(existsSync(legacyPath(env)), false);
  });

  test('migração única: só a do cache existe → é copiada (a mesma) para a pasta da configuração e a antiga fica', async () => {
    const env = await setup();
    await buildRunner(env.config, { tools: env.tools, configDir: env.configDir });
    const text = readFileSync(baselinePath(env), 'utf8');
    // como estava antes da mudança: só em paths.cache
    writeFileSync(legacyPath(env), text);
    rmSync(baselinePath(env));
    const result = await buildRunner(env.config, { tools: env.tools, configDir: env.configDir });
    assert.equal(readFileSync(baselinePath(env), 'utf8'), text, 'o mesmo conteúdo, sem recriar');
    assert.equal(statSync(baselinePath(env)).mode & 0o777, 0o600);
    assert.equal(readFileSync(legacyPath(env), 'utf8'), text, 'a antiga não é apagada nem mexida');
    assert.match(readFileSync(result.log, 'utf8'), /linha de base da assinatura migrada de .*signing-baseline\.json para .*signing-baseline\.json/);
  });

  test('migração da do cache que diverge do chaveiro → recusa antes do xcodebuild, apontando o caminho novo (e a cópia antiga)', async () => {
    const env = await setup();
    await buildRunner(env.config, { tools: env.tools, configDir: env.configDir });
    writeFileSync(legacyPath(env), readFileSync(baselinePath(env), 'utf8'));
    rmSync(baselinePath(env));
    writeFileSync(join(env.toolsDir, 'identities.txt'), withNew);
    const builds = calls(env, 'xcodebuild').length;
    const { data } = await rejectsWith(buildRunner(env.config, { tools: env.tools, configDir: env.configDir }), 'E_RUNNER_DOWN');
    assert.equal(data['reason'], 'signing-baseline');
    assert.equal(data['baseline'], baselinePath(env));
    assert.equal(data['legacyBaseline'], legacyPath(env));
    const hint = String(data['hint']);
    assert.ok(hint.includes(baselinePath(env)) && hint.includes(legacyPath(env)), 'apagar só a nova faria a antiga voltar pela migração');
    assert.equal(calls(env, 'xcodebuild').length, builds, 'nem chega ao xcodebuild');
    assert.equal(readBaseline(env)['identitiesSha256'], sha256(IDENTITIES), 'migrada, não recriada do chaveiro atual');
  });

  test('as duas existem → vale a da pasta da configuração; a do cache é ignorada (mesmo divergente ou ilegível)', async () => {
    const env = await setup();
    await buildRunner(env.config, { tools: env.tools, configDir: env.configDir });
    const text = readFileSync(baselinePath(env), 'utf8');
    const stale = { ...(JSON.parse(text) as Record<string, unknown>), identitiesSha256: '0'.repeat(64), identities: [], leafSha1: OTHER_SHA1 };
    for (const legacy of [`${JSON.stringify(stale, null, 2)}\n`, '{ilegível']) {
      writeFileSync(legacyPath(env), legacy);
      await buildRunner(env.config, { tools: env.tools, configDir: env.configDir });
      assert.equal(readFileSync(baselinePath(env), 'utf8'), text, 'a nova não muda');
      assert.equal(readFileSync(legacyPath(env), 'utf8'), legacy, 'a antiga não é tocada');
    }
  });

  test('só a do cache, ilegível → recusa (fail-closed) apontando a do cache; nada é criado na pasta da configuração', async () => {
    const env = await setup();
    mkdirSync(env.cache, { recursive: true });
    writeFileSync(legacyPath(env), '{ilegível');
    const { message, data } = await rejectsWith(buildRunner(env.config, { tools: env.tools, configDir: env.configDir }), 'E_RUNNER_DOWN');
    assert.equal(data['reason'], 'signing-baseline');
    assert.equal(data['baseline'], legacyPath(env));
    assert.match(message, /ilegível/);
    assert.equal(existsSync(baselinePath(env)), false);
    assert.equal(calls(env, 'xcodebuild').length, 0);
  });

  test('o build nº 1 falha depois de o Xcode criar uma identidade → falha dizendo isso; o nº 2 recusa antes do xcodebuild', async () => {
    const env = await setup();
    writeFileSync(join(env.toolsDir, 'identities.after.txt'), withNew);
    writeFileSync(join(env.toolsDir, 'xcodebuild.adds-identity'), '');
    writeFileSync(join(env.toolsDir, 'build.exit'), '65');
    const first = await rejectsWith(buildRunner(env.config, { tools: env.tools, configDir: env.configDir }), 'E_RUNNER_DOWN');
    assert.equal(first.data['reason'], 'signing-baseline');
    assert.match(first.message, /identidade nova/);
    assert.match(String(first.data['hint']), /G5/);
    assert.equal(first.data['baseline'], baselinePath(env), 'o erro aponta a linha de base na pasta da configuração');
    assert.ok(String(first.data['hint']).includes(baselinePath(env)), 'a instrução de G5 cita o caminho novo');
    assert.ok(!String(first.data['hint']).includes(env.cache), 'e nada no cache');
    assert.equal(first.data['legacyBaseline'], undefined);
    assert.equal(readBaseline(env)['identitiesSha256'], sha256(IDENTITIES), 'a linha de base é a de antes do build');
    assert.equal(readBaseline(env)['leafSha1'], null);
    assert.equal(calls(env, 'codesign').filter((call) => call.args[0] === '--force').length, 0);

    rmSync(join(env.toolsDir, 'build.exit'));
    const builds = calls(env, 'xcodebuild').length;
    const second = await rejectsWith(buildRunner(env.config, { tools: env.tools, configDir: env.configDir }), 'E_RUNNER_DOWN');
    assert.equal(second.data['reason'], 'signing-baseline');
    assert.equal(calls(env, 'xcodebuild').length, builds, 'o nº 2 nem chega ao xcodebuild');
    assert.equal(calls(env, 'codesign').filter((call) => call.args[0] === '--force').length, 0, 'nada reassinado');
  });

  test('uma falha da reassinatura (certificado fora do chaveiro) com uma identidade nova → vale a divergência do chaveiro', async () => {
    const env = await setup();
    writeFileSync(join(env.toolsDir, 'identities.after.txt'), withNew);
    writeFileSync(join(env.toolsDir, 'xcodebuild.adds-identity'), '');
    writeFileSync(join(env.toolsDir, 'codesign.display'), codesignDisplay('Apple Development: outra pessoa (9RLNRB8QXR)'));
    const { data } = await rejectsWith(buildRunner(env.config, { tools: env.tools, configDir: env.configDir }), 'E_RUNNER_DOWN');
    assert.equal(data['reason'], 'signing-baseline');
    assert.equal(data['buildError'] !== undefined, true, 'leva a falha original junto');
  });

  test('identidade nova depois da reassinatura → falha; nada fica marcado como conferido', async () => {
    const env = await setup();
    writeFileSync(join(env.toolsDir, 'identities.after.txt'), withNew);
    const { message, data } = await rejectsWith(buildRunner(env.config, { tools: env.tools, configDir: env.configDir }), 'E_RUNNER_DOWN');
    assert.equal(data['reason'], 'signing-baseline');
    assert.match(message, /identidade nova/);
    const { data: up } = await rejectsWith(upRunner(env.config, fast(env)), 'E_RUNNER_DOWN');
    assert.equal(up['reason'], 'unverified-build');
  });

  test('com a linha de base: identidade sumida também é divergência; certificado folha diferente do da linha de base → recusa sem reassinar', async () => {
    const env = await setup();
    const LEAF2_CERT = 'outro certificado folha 6NKUX5CX7G';
    const LEAF2_SHA1 = createHash('sha1').update(LEAF2_CERT).digest('hex').toUpperCase();
    const both = identitiesListing([[LEAF_SHA1, IDENTITY], [LEAF2_SHA1, IDENTITY]]);
    writeFileSync(join(env.toolsDir, 'identities.txt'), both);
    await buildRunner(env.config, { tools: env.tools, configDir: env.configDir });
    // o Xcode passa a assinar com o outro certificado do mesmo nome (o chaveiro é o mesmo da linha de base)
    writeFileSync(join(env.toolsDir, 'leaf.cer'), LEAF2_CERT);
    rmSync(join(env.toolsDir, 'signed'), { force: true });
    const signs = calls(env, 'codesign').filter((call) => call.args[0] === '--force').length;
    const leaf = await rejectsWith(buildRunner(env.config, { tools: env.tools, configDir: env.configDir }), 'E_RUNNER_DOWN');
    assert.equal(leaf.data['reason'], 'signing-baseline');
    assert.match(leaf.message, /certificado/);
    assert.equal(calls(env, 'codesign').filter((call) => call.args[0] === '--force').length, signs, 'nada reassinado');
    // uma identidade a menos no chaveiro: recusa antes do xcodebuild
    writeFileSync(join(env.toolsDir, 'identities.txt'), identitiesListing([[LEAF_SHA1, IDENTITY]]));
    const builds = calls(env, 'xcodebuild').length;
    const removed = await rejectsWith(buildRunner(env.config, { tools: env.tools, configDir: env.configDir }), 'E_RUNNER_DOWN');
    assert.equal(removed.data['reason'], 'signing-baseline');
    assert.equal(calls(env, 'xcodebuild').length, builds);
  });
});

describe('runner up só com build conferido (S2 item 1; P-3)', () => {
  test('a reassinatura falhou → runner up recusa (unverified-build) e nada é instalado', async () => {
    const env = await setup();
    writeFileSync(join(env.toolsDir, 'verify.exit'), '1');
    await rejectsWith(buildRunner(env.config, { tools: env.tools, configDir: env.configDir }), 'E_RUNNER_DOWN');
    const { message, data } = await rejectsWith(upRunner(env.config, fast(env)), 'E_RUNNER_DOWN');
    assert.equal(data['reason'], 'unverified-build');
    assert.equal(data['hint'], 'contrarregra runner build');
    assert.match(message, /runner build/);
    assert.equal(serveCalls(env).length, 0, 'nenhum xcodebuild test-without-building');
  });

  test('build conferido → runner up sobe; um build novo que falha, ou um .app mexido depois, invalida a marca', async () => {
    const env = await setup();
    await buildRunner(env.config, { tools: env.tools, configDir: env.configDir });
    await upRunner(env.config, fast(env));
    await downRunner(env.config, fast(env));

    // um .app mexido depois do build
    appendFileSync(join(env.products, 'Debug-iphoneos', 'ContrarregraRunner-Runner.app', 'ContrarregraRunner-Runner'), 'mexido');
    const tampered = await rejectsWith(upRunner(env.config, fast(env)), 'E_RUNNER_DOWN');
    assert.equal(tampered.data['reason'], 'unverified-build');

    // de novo conferido; depois, um build que falha no xcodebuild apaga a marca
    await buildRunner(env.config, { tools: env.tools, configDir: env.configDir });
    writeFileSync(join(env.toolsDir, 'build.exit'), '65');
    await rejectsWith(buildRunner(env.config, { tools: env.tools, configDir: env.configDir }), 'E_RUNNER_DOWN');
    const failed = await rejectsWith(upRunner(env.config, fast(env)), 'E_RUNNER_DOWN');
    assert.equal(failed.data['reason'], 'unverified-build');
  });

  test('um build Spike depois do Debug: o Debug deixa de valer (o Xcode usa o mesmo nome de .xctestrun)', async () => {
    const env = await setup();
    await buildRunner(env.config, { tools: env.tools, configDir: env.configDir });
    await buildRunner(env.config, { tools: env.tools, configDir: env.configDir, configuration: 'Spike' });
    const { data } = await rejectsWith(upRunner(env.config, fast(env)), 'E_RUNNER_DOWN');
    assert.ok(['no-build', 'unverified-build'].includes(String(data['reason'])), String(data['reason']));
    await upRunner(env.config, fast(env, { spike: true }));
  });
});

// ── runner up ───────────────────────────────────────────────────────────────────────────────────────

describe('runner up (S2 item 1; P-3; S1 item 9)', () => {
  test('o .xctestrun da sessão tem 0600, as variáveis de S1 e as capturas desligadas; o xcodebuild roda destacado, sem pipes, com caffeinate', async () => {
    const env = await setup({ built: 'Debug' });
    const generatedBefore = readFileSync(join(env.products, XCTESTRUN_NAME), 'utf8');
    const result = await upRunner(env.config, fast(env));
    assert.equal(result.state, 'up');
    assert.equal(result.configuration, 'Debug');
    assert.equal(result.runnerVersion, '0.0.0');

    // O arquivo: um só, 0600, numa pasta 0700, em paths.cache/sessions.
    assert.deepEqual(sessionFiles(env, '.xctestrun'), [`${result.sessionId}.xctestrun`]);
    const path = join(env.sessions, `${result.sessionId}.xctestrun`);
    assert.equal(result.xctestrun, path);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(statSync(env.sessions).mode & 0o777, 0o700);

    // As variáveis de S1.
    const target = sessionDoc(path);
    const vars = sessionVars(target);
    const token = vars['CONTRARREGRA_TOKEN'];
    assert.ok(typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token), 'token de 256 bits em base64url');
    assert.equal(vars['CONTRARREGRA_PORT'], '8700');
    assert.equal(vars['CONTRARREGRA_SESSION'], result.sessionId);
    assert.equal(vars['CONTRARREGRA_PRIVATE'], 'PX-1,PX-3');
    assert.equal(vars['CONTRARREGRA_ALLOWED'], 'com.example.other,https://example.com/');
    assert.equal(vars['CONTRARREGRA_EXPLORE'], 'com.example.target');
    assert.equal(vars['CONTRARREGRA_BIND'], undefined, 'CONTRARREGRA_BIND só no Spike');
    assert.equal(vars['OS_ACTIVITY_DT_MODE'], 'YES', 'as variáveis do gerado continuam');

    // Capturas do XCTest desligadas (S1 item 9).
    assert.equal(target['SystemAttachmentLifetime'], 'keepNever');
    assert.equal(target['UserAttachmentLifetime'], 'keepNever');
    assert.equal(target['PreferredScreenCaptureFormat'], 'screenshots');
    assert.equal(target['TestHostPath'], join(env.products, 'Debug-iphoneos', 'ContrarregraRunner-Runner.app'));
    assert.ok(!readFileSync(path, 'utf8').includes('__TESTROOT__'));
    assert.equal(readFileSync(join(env.products, XCTESTRUN_NAME), 'utf8'), generatedBefore, 'o .xctestrun gerado não muda');

    // O xcodebuild: argumentos de S2, destacado, sem pipes. (O runner falso já escuta, então a subida
    // pode terminar antes de o script falso gravar o registro.)
    await waitFor(() => serveCalls(env).length > 0, 'xcodebuild registrado');
    const [serve, ...more] = serveCalls(env);
    assert.equal(more.length, 0);
    assert.deepEqual(serve!.args, [
      'test-without-building',
      '-xctestrun',
      path,
      '-destination',
      `id=${UDID}`,
      '-only-testing',
      'ContrarregraRunner/RunnerTests/testServe',
      '-test-timeouts-enabled',
      'NO',
      '-collect-test-diagnostics',
      'never',
      '-parallel-testing-enabled',
      'NO',
      '-destination-timeout',
      '60',
    ]);
    assert.deepEqual([serve!.stdin, serve!.stdout, serve!.stderr], ['chardev', 'file', 'file'], 'o xcodebuild nunca recebe pipes');
    assert.equal(serve!.pgid, serve!.pid, 'destacado: líder do próprio grupo de processo');
    assert.equal(result.pid, serve!.pid);
    assert.ok(alive(serve!.pid));
    assert.ok(readFileSync(result.log, 'utf8').includes('xcodebuild falso: test-without-building'), 'saída no arquivo de registro');

    // caffeinate -dimsu -w <pid>.
    await waitFor(() => calls(env, 'caffeinate').length === 1, 'caffeinate registrado');
    const [caffeinate] = calls(env, 'caffeinate');
    assert.deepEqual(caffeinate!.args, ['-dimsu', '-w', String(serve!.pid)]);
    assert.equal(caffeinate!.pgid, caffeinate!.pid, 'caffeinate destacado também');

    // Pronto = o runner respondeu session.hello com o token do .xctestrun.
    const hello = env.runner.hellos.at(-1)!;
    assert.deepEqual(hello, { token, role: 'control' });

    // O token só existe no .xctestrun: nem no argv, nem no estado, nem nos registros.
    assert.ok(!serve!.args.join(' ').includes(token));
    assert.ok(!caffeinate!.args.join(' ').includes(token));
    assert.ok(!readFileSync(join(env.sessions, `${result.sessionId}.json`), 'utf8').includes(token));
    assert.ok(!allLogText(env).includes(token), 'o token não aparece em nenhum registro');

    await downRunner(env.config, fast(env));
  });

  test('--spike usa o build Spike e leva CONTRARREGRA_BIND (loopback por padrão, endpoint com --bind)', async () => {
    const env = await setup({ built: 'Spike' });
    const loopback = await upRunner(env.config, fast(env, { spike: true }));
    assert.equal(loopback.configuration, 'Spike');
    const target = sessionDoc(loopback.xctestrun);
    assert.equal(sessionVars(target)['CONTRARREGRA_BIND'], 'loopback');
    assert.equal(target['TestHostPath'], join(env.products, 'Spike-iphoneos', 'ContrarregraRunner-Runner.app'));

    const endpoint = await upRunner(env.config, fast(env, { spike: true, bind: 'endpoint' }));
    assert.equal(sessionVars(sessionDoc(endpoint.xctestrun))['CONTRARREGRA_BIND'], 'endpoint');
    await downRunner(env.config, fast(env));

    // Sem --spike, o build Spike não serve (instalar um build Spike é G5, P-6).
    const { data } = await rejectsWith(upRunner(env.config, fast(env)), 'E_RUNNER_DOWN');
    assert.equal(data['reason'], 'no-build');
    assert.equal(data['hint'], 'contrarregra runner build');
    await rejectsWith(upRunner(env.config, fast(env, { bind: 'endpoint' })), 'E_CONFIG');
  });

  test('apaga .xctestrun de sessões velhas (mortas ou sobras antigas) e para a sessão viva anterior antes de subir outra', async () => {
    const env = await setup({ built: 'Debug' });
    mkdirSync(env.sessions, { recursive: true });
    const hourAgo = new Date(Date.now() - 3_600_000);
    // Sessão morta (estado com pid que não existe): apagada, seja qual for a idade.
    writeFileSync(join(env.sessions, 'velha.xctestrun'), 'token velho', { mode: 0o600 });
    writeFileSync(
      join(env.sessions, 'velha.json'),
      JSON.stringify({ schema: 'contrarregra.session/1', sessionId: 'velha', xctestrun: join(env.sessions, 'velha.xctestrun'), xcodebuildPid: 2 ** 22 + 7, port: 8700, startedAt: '2026-01-01T00:00:00.000Z' }),
    );
    // Sobra sem estado e antiga: apagada.
    writeFileSync(join(env.sessions, 'sobra.xctestrun'), 'sem estado', { mode: 0o600 });
    utimesSync(join(env.sessions, 'sobra.xctestrun'), hourAgo, hourAgo);
    // Sem estado e recém-criada: é de um `runner up` concorrente no meio da escrita; fica.
    writeFileSync(join(env.sessions, 'em-criacao.xctestrun'), 'outra subida', { mode: 0o600 });
    const first = await upRunner(env.config, fast(env));
    assert.deepEqual(sessionFiles(env, '.xctestrun').sort(), [`${first.sessionId}.xctestrun`, 'em-criacao.xctestrun'], 'a nova e a recém-criada');
    assert.deepEqual(sessionFiles(env, '.json'), [`${first.sessionId}.json`]);
    rmSync(join(env.sessions, 'em-criacao.xctestrun'));

    await idle(env);
    const second = await upRunner(env.config, fast(env));
    assert.notEqual(second.sessionId, first.sessionId);
    assert.deepEqual(sessionFiles(env, '.xctestrun'), [`${second.sessionId}.xctestrun`], 'o .xctestrun da sessão anterior foi apagado');
    await waitFor(() => !alive(first.pid), 'o xcodebuild da sessão anterior saiu');
    assert.ok(env.runner.calls.some((call) => call.method === 'runner.shutdown'), 'pediu runner.shutdown à sessão anterior');
    assert.ok(alive(second.pid));
    await downRunner(env.config, fast(env));
  });

  test('fica em starting enquanto o runner não escuta e fica pronto quando o session.hello responde', async () => {
    const env = await setup({ built: 'Debug', listening: false });
    const up = upRunner(env.config, fast(env));
    await waitFor(() => sessionFiles(env, '.json').length === 1 && serveCalls(env).length === 1, 'sessão criada');
    const status = await runnerStatus(env.config, { tools: env.tools });
    assert.equal(status.state, 'starting');
    assert.equal(status.pid, serveCalls(env)[0]!.pid);
    await new Promise((resolve) => setTimeout(resolve, 200));
    env.devicePorts[RUNNER_PORT] = env.runner.port; // o runner abriu o servidor
    const result = await up;
    assert.equal(result.state, 'up');
    assert.ok(result.readyMs >= 150, `pronto só depois da porta abrir (${result.readyMs} ms)`);
    assert.ok(env.usbmuxd.messages('Connect').length >= 2, 'tentou de novo enquanto o Connect era recusado');
    await downRunner(env.config, fast(env));
  });

  test('o xcodebuild saindo antes do hello → E_RUNNER_DOWN e nenhum .xctestrun sobra', async () => {
    const env = await setup({ built: 'Debug', listening: false });
    writeFileSync(join(env.toolsDir, 'serve.mode'), 'exit');
    const { data } = await rejectsWith(upRunner(env.config, fast(env)), 'E_RUNNER_DOWN');
    assert.equal(data['reason'], 'xcodebuild-exited');
    assert.equal(data['exitCode'], 3);
    assert.equal(data['hint'], 'contrarregra runner up');
    assert.deepEqual(sessionFiles(env, '.xctestrun'), []);
  });

  test('xcodebuild que nem nasce → E_RUNNER_DOWN e nenhum .xctestrun sobra', async () => {
    const env = await setup({ built: 'Debug' });
    const { data } = await rejectsWith(upRunner(env.config, fast(env, { tools: { ...env.tools, xcodebuild: join(env.toolsDir, 'nao-existe') } })), 'E_RUNNER_DOWN');
    assert.equal(data['reason'], 'spawn-failed');
    assert.deepEqual(sessionFiles(env, '.xctestrun'), []);
    assert.deepEqual(sessionFiles(env, '.json'), []);
  });

  test('sem cabo → E_NO_USB em ≤ 1 s e nenhum xcodebuild (AC-2.3, parte do Mac)', async () => {
    const env = await setup({ built: 'Debug' });
    env.usbmuxd.devices = [];
    const start = performance.now();
    const { data } = await rejectsWith(upRunner(env.config, fast(env)), 'E_NO_USB');
    assert.ok(performance.now() - start <= NO_USB_BOUND_MS);
    assert.equal(data['reason'], 'not-listed');
    assert.equal(calls(env, 'xcodebuild').length, 0);
    assert.deepEqual(sessionFiles(env, '.xctestrun'), []);
  });

  test('com a trava de uma tomada, runner up e runner down recebem E_BUSY com o takeId (S2 item 3)', async () => {
    const env = await setup({ built: 'Debug' });
    mkdirSync(join(env.cache, 'locks'), { recursive: true });
    writeFileSync(env.lockFile, `${TAKE_ID}\n`);
    assert.equal((await rejectsWith(upRunner(env.config, fast(env)), 'E_BUSY')).data['takeId'], TAKE_ID);
    assert.equal((await rejectsWith(downRunner(env.config, fast(env)), 'E_BUSY')).data['takeId'], TAKE_ID);
    // Trava JSON com pid: só vale se o processo vive e a linha de comando dele tem o takeId (senão é sobra).
    const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)', TAKE_ID], { stdio: 'ignore' });
    try {
      writeFileSync(env.lockFile, JSON.stringify({ takeId: TAKE_ID, pid: holder.pid }));
      assert.equal((await rejectsWith(upRunner(env.config, fast(env)), 'E_BUSY')).data['takeId'], TAKE_ID);
    } finally {
      holder.kill();
    }
    assert.equal(calls(env, 'xcodebuild').length, 0);
    assert.equal(env.usbmuxd.requests.length, 0, 'recusou antes de falar com o aparelho');
  });

  test('sem build → E_RUNNER_DOWN com a dica do runner build', async () => {
    const env = await setup();
    assert.equal((await rejectsWith(upRunner(env.config, fast(env)), 'E_RUNNER_DOWN')).data['hint'], 'contrarregra runner build');
    assert.equal((await rejectsWith(upRunner(env.config, fast(env, { spike: true })), 'E_RUNNER_DOWN')).data['hint'], 'contrarregra runner build --configuration Spike');
    assert.equal(calls(env, 'xcodebuild').length, 0);
  });

  test('sem o build pedido ou sem cabo, a sessão viva fica de pé (pré-requisitos antes de derrubar qualquer coisa)', async () => {
    const env = await setup({ built: 'Debug' });
    const up = await upRunner(env.config, fast(env));
    await idle(env);
    await waitFor(() => serveCalls(env).length === 1, 'xcodebuild registrado');
    const files = sessionFiles(env, '.xctestrun');
    const { data } = await rejectsWith(upRunner(env.config, fast(env, { spike: true })), 'E_RUNNER_DOWN');
    assert.equal(data['reason'], 'no-build');
    env.usbmuxd.devices = [];
    await rejectsWith(upRunner(env.config, fast(env)), 'E_NO_USB');
    env.usbmuxd.devices = [USB_ENTRY];
    assert.ok(alive(up.pid), 'o xcodebuild da sessão que funcionava continua vivo');
    assert.deepEqual(sessionFiles(env, '.xctestrun'), files, 'o .xctestrun da sessão viva continua');
    assert.ok(!env.runner.calls.some((call) => call.method === 'runner.shutdown'), 'ninguém pediu runner.shutdown');
    assert.equal(serveCalls(env).length, 1);
    await downRunner(env.config, fast(env));
  });

  test('a falha de uma subida apaga só os arquivos da própria sessão, não os de uma subida concorrente', async () => {
    const env = await setup({ built: 'Debug', listening: false });
    const failing = upRunner(env.config, fast(env, { readyTimeoutMs: 700 }));
    await waitFor(() => sessionFiles(env, '.json').length === 1, 'estado da subida que vai falhar');
    const [mine] = sessionFiles(env, '.json');
    // Outra subida (ex.: runner_up do MCP) escreve a própria sessão enquanto esta espera o hello.
    const otherId = '20991231-235959-0c0c0c';
    const otherXctestrun = join(env.sessions, `${otherId}.xctestrun`);
    writeFileSync(otherXctestrun, generatedXctestrun('Debug', 'outra'), { mode: 0o600 });
    const other = spawn(env.tools.xcodebuild, ['test-without-building', '-xctestrun', otherXctestrun], { detached: true, stdio: 'ignore' });
    other.unref();
    writeFileSync(
      join(env.sessions, `${otherId}.json`),
      JSON.stringify({ schema: 'contrarregra.session/1', sessionId: otherId, udid: UDID, port: 8700, configuration: 'Debug', spike: false, xctestrun: otherXctestrun, log: '/dev/null', xcodebuildPid: other.pid, startedAt: '2099-12-31T23:59:59.000Z' }),
      { mode: 0o600 },
    );
    const { data } = await rejectsWith(failing, 'E_RUNNER_DOWN');
    assert.equal(data['reason'], 'ready-timeout');
    assert.ok(!existsSync(join(env.sessions, mine!)), 'o estado da subida que falhou foi apagado');
    assert.ok(!existsSync(join(env.sessions, mine!.replace(/\.json$/, '.xctestrun'))), 'o .xctestrun dela também');
    assert.ok(existsSync(otherXctestrun), 'o .xctestrun da outra subida continua');
    assert.ok(existsSync(join(env.sessions, `${otherId}.json`)), 'o estado da outra subida continua');
    process.kill(-other.pid!, 'SIGKILL');
  });

  test('com .xctestrun de dois SDKs na pasta dos produtos, usa o mais novo da configuração (build e up)', async () => {
    const env = await setup();
    mkdirSync(env.products, { recursive: true });
    const stale = join(env.products, 'ContrarregraRunner_iphoneos26.4-arm64.xctestrun');
    writeFileSync(stale, generatedXctestrun('Debug', 'sdk-26.4'));
    const hourAgo = new Date(Date.now() - 3_600_000);
    utimesSync(stale, hourAgo, hourAgo);
    writeFileSync(join(env.products, XCTESTRUN_NAME), generatedXctestrun('Debug', 'sdk-26.5'));
    markVerified(env.config, env.products, 'Debug');
    const up = await upRunner(env.config, fast(env));
    assert.equal(sessionVars(sessionDoc(up.xctestrun))['SDK_MARKER'], 'sdk-26.5');
    await downRunner(env.config, fast(env));

    // O build-for-testing não apaga o .xctestrun de outro SDK: o build devolve o que acabou de gerar.
    const built = await buildRunner(env.config, { tools: env.tools, configDir: env.configDir });
    assert.equal(built.xctestrun, join(env.products, XCTESTRUN_NAME));
    assert.ok(existsSync(stale));
  });
});

// ── runner down ─────────────────────────────────────────────────────────────────────────────────────

describe('runner down (S2 item 1; AC-2.9, parte do Mac)', () => {
  test('apaga o .xctestrun e o estado da sessão, pede runner.shutdown e para o xcodebuild e o caffeinate', async () => {
    const env = await setup({ built: 'Debug' });
    const up = await upRunner(env.config, fast(env));
    const token = sessionVars(sessionDoc(up.xctestrun))['CONTRARREGRA_TOKEN'] as string;
    await waitFor(() => calls(env, 'caffeinate').length === 1, 'caffeinate registrado');
    const caffeinatePid = calls(env, 'caffeinate')[0]!.pid;

    await idle(env);
    const down = await downRunner(env.config, fast(env));
    assert.equal(down.state, 'down');
    assert.deepEqual(down.stopped, [{ sessionId: up.sessionId, pid: up.pid, how: 'SIGTERM' }]);
    assert.ok(down.deleted.includes(up.xctestrun));
    assert.ok(down.deleted.includes(join(env.sessions, `${up.sessionId}.json`)));
    assert.ok(!existsSync(up.xctestrun), 'o .xctestrun da sessão foi apagado');
    assert.deepEqual(sessionFiles(env, '.xctestrun'), []);
    assert.ok(env.runner.calls.some((call) => call.method === 'runner.shutdown'));
    assert.ok(!alive(up.pid), 'o xcodebuild saiu');
    await waitFor(() => !alive(caffeinatePid), 'o caffeinate saiu');
    assert.ok(!allLogText(env).includes(token), 'o token não aparece em nenhum registro');
  });

  test('sem sessão: apaga sobras e não falha', async () => {
    const env = await setup();
    mkdirSync(env.sessions, { recursive: true });
    writeFileSync(join(env.sessions, 'sobra.xctestrun'), 'x', { mode: 0o600 });
    const down = await downRunner(env.config, fast(env));
    assert.deepEqual(down.stopped, []);
    assert.deepEqual(down.deleted, [join(env.sessions, 'sobra.xctestrun')]);
  });
});

// ── runner status ───────────────────────────────────────────────────────────────────────────────────

describe('runner status (S2 itens 3 e 7, "API / Interface")', () => {
  test('down sem sessão; up com RTT, uptime e transporte; caído quando o xcodebuild sai (E_RUNNER_DOWN com a dica)', async () => {
    const env = await setup({ built: 'Debug' });
    const none = await runnerStatus(env.config, { tools: env.tools });
    assert.deepEqual(none, {
      state: 'down',
      pid: null,
      sessionId: null,
      transport: { usb: true, wired: true, tunnelState: 'connected' },
      rttMs: null,
      uptimeS: null,
    });
    const [devicectl] = calls(env, 'xcrun');
    assert.deepEqual(devicectl!.args.slice(0, 4), ['devicectl', 'list', 'devices', '--json-output']);
    assert.ok(!existsSync(devicectl!.args[4]!), 'o JSON do devicectl é apagado depois de lido');

    const up = await upRunner(env.config, fast(env));
    writeFileSync(join(env.toolsDir, 'devicectl.json'), devicectlJson('localNetwork', 'connected'));
    const status = await runnerStatus(env.config, { tools: env.tools, samples: 5 });
    assert.equal(status.state, 'up');
    assert.equal(status.pid, up.pid);
    assert.equal(status.sessionId, up.sessionId);
    assert.deepEqual(status.transport, { usb: true, wired: false, tunnelState: 'connected' });
    assert.equal(status.uptimeS, 3605.25);
    assert.ok(status.rttMs !== null && status.rttMs.p50 >= 0 && status.rttMs.p95 >= status.rttMs.p50);
    assert.equal(status.controlHeldBy, undefined);
    assert.equal(env.runner.calls.filter((call) => call.method === 'health').length, 5);

    // O xcodebuild morre: o Mac marca a sessão caída e todo comando recebe E_RUNNER_DOWN com a dica.
    process.kill(-up.pid, 'SIGKILL');
    await waitFor(() => !alive(up.pid), 'xcodebuild morto');
    const down = await runnerStatus(env.config, { tools: env.tools });
    assert.equal(down.state, 'down');
    assert.equal(down.pid, null);
    assert.equal(down.sessionId, up.sessionId);
    assert.match(readFileSync(join(env.logs, 'runner.log'), 'utf8'), /runner caído: o xcodebuild \d+ da sessão/);
    const { data } = await rejectsWith(openRunner(env.config, { role: 'control' }), 'E_RUNNER_DOWN');
    assert.equal(data['reason'], 'xcodebuild-exited');
    assert.equal(data['hint'], 'contrarregra runner up');
    await downRunner(env.config, fast(env));
  });

  test('com control ocupado (outro controlador ou a trava de uma tomada), mede pela conexão sync e diz quem segura', async () => {
    const env = await setup({ built: 'Debug' });
    await upRunner(env.config, fast(env));
    const holder = await openRunner(env.config, { role: 'control' });
    try {
      const busy = await runnerStatus(env.config, { tools: env.tools, samples: 3 });
      assert.equal(busy.state, 'up');
      assert.equal(busy.controlHeldBy, 'unknown');
      assert.equal(busy.uptimeS, null);
      assert.ok(env.runner.hellos.some((hello) => hello.role === 'sync'));
      assert.equal(env.runner.calls.filter((call) => call.method === 'clock.ping').length, 3);

      mkdirSync(join(env.cache, 'locks'), { recursive: true });
      writeFileSync(env.lockFile, TAKE_ID);
      const locked = await runnerStatus(env.config, { tools: env.tools, samples: 2 });
      assert.equal(locked.state, 'up');
      assert.equal(locked.controlHeldBy, TAKE_ID);
      // A exploração durante a tomada recebe E_BUSY com o takeId, sem nem abrir conexão.
      assert.equal((await rejectsWith(openRunner(env.config, { role: 'control' }), 'E_BUSY')).data['takeId'], TAKE_ID);
      rmSync(env.lockFile);
    } finally {
      await holder.close();
    }
    await downRunner(env.config, fast(env));
  });

  test('sem cabo → E_NO_USB em ≤ 1 s', async () => {
    const env = await setup();
    env.usbmuxd.devices = [];
    const start = performance.now();
    await rejectsWith(runnerStatus(env.config, { tools: env.tools }), 'E_NO_USB');
    assert.ok(performance.now() - start <= NO_USB_BOUND_MS);
  });

  test('devicectl: acha o aparelho pelo UDID (com ou sem hífen) ou pelo id do CoreDevice', () => {
    const ids = { udid: UDID, coreDeviceId: CORE_DEVICE_ID };
    assert.deepEqual(parseDevicectlList(JSON.parse(devicectlJson('wired', 'connected')), ids), { transportType: 'wired', tunnelState: 'connected' });
    assert.deepEqual(parseDevicectlList(JSON.parse(devicectlJson('localNetwork', 'disconnected')), { ...ids, udid: UDID.replace(/-/g, '') }), {
      transportType: 'localNetwork',
      tunnelState: 'disconnected',
    });
    const byIdentifier = { result: { devices: [{ identifier: CORE_DEVICE_ID.toLowerCase(), connectionProperties: {} }] } };
    assert.deepEqual(parseDevicectlList(byIdentifier, ids), { transportType: null, tunnelState: null });
    assert.equal(parseDevicectlList({ result: { devices: [] } }, ids), undefined);
    assert.equal(parseDevicectlList('lixo', ids), undefined);
  });

  test('percentis por posição', () => {
    assert.equal(percentile([5, 1, 3, 2, 4], 50), 3);
    assert.equal(percentile([5, 1, 3, 2, 4], 95), 5);
    assert.equal(percentile([1.234567], 95), 1.23);
  });
});

// ── Cliente JSON-RPC ────────────────────────────────────────────────────────────────────────────────

describe('cliente JSON-RPC (S0.5)', () => {
  async function server(onText: (conn: WsTestConnection, message: { id: number; method: string; params?: unknown }) => void): Promise<WsTestServer> {
    const ws = await startWsServer({ onConnection: (conn) => conn.onMessage((text) => onText(conn, JSON.parse(text))) });
    cleanups.push(() => ws.close());
    return ws;
  }

  test('resposta, erros da tabela de S0.5, erros do JSON-RPC, prazo e notificações', async () => {
    const ws = await server((conn, { id, method, params }) => {
      if (method === 'echo') conn.sendJson({ jsonrpc: '2.0', id, result: params });
      else if (method === 'busy') conn.sendJson({ jsonrpc: '2.0', id, error: { code: -32002, message: 'E_BUSY: já há um controlador', data: { takeId: TAKE_ID } } });
      else if (method === 'notify') {
        conn.sendJson({ jsonrpc: '2.0', method: 'log', params: { level: 'info', msg: 'oi' } });
        conn.sendJson({ jsonrpc: '2.0', id, result: {} });
      } else if (method === 'slow') {
        // sem resposta
      } else conn.sendJson({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } });
    });
    const rpc = await RpcConnection.open(ws.url);
    assert.deepEqual(await rpc.call('echo', { a: 1 }), { a: 1 });
    const busy = await rejectsWith(rpc.call('busy'), 'E_BUSY');
    assert.equal(busy.data['takeId'], TAKE_ID);
    await assert.rejects(rpc.call('nada'), (error: unknown) => error instanceof RpcProtocolError && error.code === -32601);
    const timeout = await rejectsWith(rpc.call('slow', {}, { timeoutMs: 50 }), 'E_TIMEOUT');
    assert.equal(timeout.data['method'], 'slow');
    const notes: [string, unknown][] = [];
    rpc.onNotification((method, params) => notes.push([method, params]));
    await rpc.call('notify');
    assert.deepEqual(notes, [['log', { level: 'info', msg: 'oi' }]]);
    await rpc.close();
    assert.equal(rpc.isOpen, false);
    await rejectsWith(rpc.call('echo'), 'E_RUNNER_DOWN');
  });

  test('a conexão caindo rejeita os pendentes na hora com E_RUNNER_DOWN', async () => {
    const ws = await server(() => {});
    const rpc = await RpcConnection.open(ws.url);
    const pending = rpc.call('slow', {}, { timeoutMs: 5_000 });
    const conn = await ws.nextConnection();
    await waitFor(() => conn.messages.length === 1, 'pedido chegou');
    const start = performance.now();
    conn.terminate();
    const { data } = await rejectsWith(pending, 'E_RUNNER_DOWN');
    assert.equal(data['reason'], 'connection-closed');
    assert.ok(performance.now() - start < 1000);
  });

  test('sem sessão de runner → E_RUNNER_DOWN com a dica runner up; sem servidor → E_RUNNER_DOWN', async () => {
    const env = await setup();
    const { data } = await rejectsWith(openRunner(env.config, { role: 'control' }), 'E_RUNNER_DOWN');
    assert.equal(data['reason'], 'no-session');
    assert.equal(data['hint'], 'contrarregra runner up');
    await rejectsWith(RpcConnection.open('ws://127.0.0.1:1/'), 'E_RUNNER_DOWN');
  });

  test('o runner sem escutar (Connect recusado) → E_RUNNER_DOWN; withRunner abre, chama e fecha', async () => {
    const env = await setup({ built: 'Debug' });
    await upRunner(env.config, fast(env));
    const health = await withRunner(env.config, { role: 'control' }, (c) => c.call<{ ok: boolean }>('health'));
    assert.equal(health.ok, true);
    await waitFor(() => env.runner.server.connections.size === 0, 'withRunner fechou a conexão');
    delete env.devicePorts[RUNNER_PORT];
    const { data } = await rejectsWith(openRunner(env.config, { role: 'control' }), 'E_RUNNER_DOWN');
    assert.equal(data['hint'], 'contrarregra runner up');
    env.devicePorts[RUNNER_PORT] = env.runner.port;
    await downRunner(env.config, fast(env));
  });
});

// ── Reconexão ───────────────────────────────────────────────────────────────────────────────────────

describe('reconexão (S2 item 6)', () => {
  test('recuo exponencial até 2 s: a tabela e o laço de reconexão de verdade', async () => {
    assert.deepEqual(backoffDelays(7), [100, 200, 400, 800, 1600, 2000, 2000]);
    assert.deepEqual(backoffDelays(5, 20, 80), [20, 40, 80, 80, 80]);

    // O laço real: as tentativas depois da queda ficam espaçadas pela mesma tabela.
    const env = await setup({ built: 'Debug' });
    await upRunner(env.config, fast(env));
    const attempts: number[] = [];
    let failing = false;
    const link = await RunnerLink.connect(env.config, {
      role: 'control',
      backoffInitialMs: 20,
      backoffMaxMs: 80,
      open: (options) => {
        if (failing) {
          attempts.push(performance.now());
          if (attempts.length <= 5) return Promise.reject(new ContrarregraError('E_RUNNER_DOWN', 'runner falso fora do ar', { reason: 'teste' }));
        }
        return openRunner(env.config, options);
      },
    });
    try {
      failing = true;
      for (const conn of env.runner.server.connections) conn.terminate();
      await waitFor(() => link.reconnects === 1 && link.state === 'up', 'reconectou depois de 5 falhas', 5000);
      assert.equal(attempts.length, 6);
      const gaps = attempts.slice(1).map((t, i) => t - attempts[i]!);
      backoffDelays(5, 20, 80).forEach((expected, i) => {
        assert.ok(gaps[i]! >= expected - 3, `intervalo ${i}: ${gaps[i]!.toFixed(1)} ms < ${expected} ms`);
        assert.ok(gaps[i]! <= expected + 70, `intervalo ${i}: ${gaps[i]!.toFixed(1)} ms ≫ ${expected} ms (teto ignorado?)`);
      });
    } finally {
      await link.close();
    }
    await downRunner(env.config, fast(env));
  });

  test('2 batimentos sem resposta não derrubam; o 3.º derruba', async () => {
    const env = await setup({ built: 'Debug' });
    await upRunner(env.config, fast(env));
    const states: LinkState[] = [];
    let dropped: Error | undefined;
    const link = await RunnerLink.connect(env.config, {
      role: 'control',
      heartbeatMs: 40,
      backoffInitialMs: 20,
      onStateChange: (state, error) => {
        states.push(state);
        if (state === 'down') dropped = error;
      },
    });
    const healthCalls = (): number => env.runner.calls.filter((call) => call.method === 'health').length;
    try {
      const before = healthCalls();
      env.runner.muteNext.set('health', 2);
      await waitFor(() => healthCalls() >= before + 6, '2 batimentos sem resposta e 4 respondidos');
      assert.equal(env.runner.muteNext.get('health'), 0, 'os 2 ficaram sem resposta');
      assert.deepEqual(states, ['up'], '2 faltas não derrubam');
      assert.equal(link.reconnects, 0);

      env.runner.muteNext.set('health', 3);
      await waitFor(() => dropped !== undefined, 'o 3.º derrubou');
      assert.equal(env.runner.muteNext.get('health'), 0, 'derrubou depois de exatamente 3 sem resposta');
      assert.ok(isContrarregraError(dropped, 'E_RUNNER_DOWN'));
      assert.equal(dropped.data?.['reason'], 'heartbeat');
      assert.equal(dropped.data?.['misses'], 3);
      await waitFor(() => link.state === 'up', 'reconectou');
      assert.deepEqual(states, ['up', 'down', 'up']);
    } finally {
      await link.close();
    }
    await downRunner(env.config, fast(env));
  });

  test('nenhum evento se perde na reconexão: os que chegam antes da resposta do events.fetch e durante um onReconnected lento', async () => {
    const env = await setup({ built: 'Debug' });
    await upRunner(env.config, fast(env));
    const received: number[] = [];
    const emit = (seq: number): void => env.runner.emit({ seq, kind: 'step.end' });
    const link = await RunnerLink.connect(env.config, {
      role: 'control',
      takeId: TAKE_ID,
      backoffInitialMs: 20,
      backoffMaxMs: 40,
      onEvent: (event) => received.push(event.seq),
      onReconnected: async () => {
        emit(7); // a rajada de sincronia (S7) demora; o runner segue mandando eventos
        await new Promise((resolve) => setTimeout(resolve, 100));
        emit(8);
        await new Promise((resolve) => setTimeout(resolve, 50));
      },
    });
    try {
      for (const seq of [0, 1, 2]) emit(seq);
      await waitFor(() => received.length === 3, 'eventos por notificação');
      env.runner.events = [0, 1, 2, 3, 4, 5].map((seq) => ({ seq, kind: 'step.end' }));
      env.runner.beforeFetchResponse = () => emit(6); // notificado antes da própria resposta do fetch
      for (const conn of env.runner.server.connections) conn.terminate();
      await waitFor(() => link.reconnects === 1 && link.state === 'up', 'reconectou');
      emit(9);
      await waitFor(() => received.length >= 10, `todos os eventos (veio ${received.join(',')})`);
      assert.deepEqual(received, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 'em ordem de seq, sem buraco nem repetição');
      assert.equal(link.lastSeq, 9);
    } finally {
      await link.close();
    }
    await downRunner(env.config, fast(env));
  });

  test('caiu pelo batimento: reconecta com hello, events.fetch {sinceSeq} do último evento e o gancho de sincronia', async () => {
    const env = await setup({ built: 'Debug' });
    await upRunner(env.config, fast(env));
    const received: number[] = [];
    const states: LinkState[] = [];
    let reconnected = 0;
    const link = await RunnerLink.connect(env.config, {
      role: 'control',
      takeId: TAKE_ID,
      heartbeatMs: 40,
      backoffInitialMs: 20,
      backoffMaxMs: 80,
      onEvent: (event) => received.push(event.seq),
      onReconnected: async (connection: RunnerConnection) => {
        assert.equal(connection.role, 'control');
        reconnected += 1;
      },
      onStateChange: (state) => {
        states.push(state);
        if (state === 'down') env.runner.mute.delete('health');
      },
    });
    try {
      for (const seq of [0, 1, 2]) env.runner.emit({ seq, kind: 'step.end' });
      await waitFor(() => received.length === 3, 'eventos por notificação');
      assert.equal(link.lastSeq, 2);

      env.runner.events = [0, 1, 2, 3, 4, 5].map((seq) => ({ seq, kind: 'step.end' }));
      const hellosBefore = env.runner.hellos.length;
      env.runner.mute.add('health'); // runner deixa de responder ao batimento
      await waitFor(() => link.reconnects === 1 && link.state === 'up', 'reconectou');
      assert.deepEqual(states, ['up', 'down', 'up']);
      assert.ok(env.runner.hellos.length > hellosBefore, 'session.hello de novo');
      const fetches = env.runner.calls.filter((call) => call.method === 'events.fetch');
      assert.deepEqual(fetches.at(-1)!.params, { takeId: TAKE_ID, sinceSeq: 2 });
      assert.deepEqual(received, [0, 1, 2, 3, 4, 5], 'seq contínuo, sem repetir');
      assert.equal(reconnected, 1);
      assert.deepEqual(await link.call('health'), HEALTH_RESULT);
    } finally {
      await link.close();
    }
    await downRunner(env.config, fast(env));
  });

  test('sem cabo, a chamada na linha caída falha na hora com E_NO_USB; o cabo de volta reconecta', async () => {
    const env = await setup({ built: 'Debug' });
    await upRunner(env.config, fast(env));
    const link = await RunnerLink.connect(env.config, { role: 'control', heartbeatMs: 1_000, backoffInitialMs: 20, backoffMaxMs: 60 });
    try {
      env.usbmuxd.devices = [];
      for (const conn of env.runner.server.connections) conn.terminate();
      await waitFor(() => link.state === 'down', 'linha caiu');
      // Depois da primeira tentativa de reconexão (sem cabo), a linha sabe o motivo.
      const deadline = Date.now() + 3000;
      for (;;) {
        const error = await link.call('health').then(
          () => undefined,
          (e: unknown) => e,
        );
        if (isContrarregraError(error, 'E_NO_USB')) break;
        assert.ok(Date.now() < deadline, `esperava E_NO_USB, veio ${String(error)}`);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const start = performance.now();
      await rejectsWith(link.call('health'), 'E_NO_USB');
      assert.ok(performance.now() - start < 50, 'falha na hora');
      env.usbmuxd.devices = [USB_ENTRY];
      await waitFor(() => link.state === 'up', 'reconectou com o cabo de volta');
      assert.equal(link.reconnects, 1);
    } finally {
      await link.close();
    }
    await downRunner(env.config, fast(env));
  });
});

// ── runner sever ────────────────────────────────────────────────────────────────────────────────────

describe('runner sever (S2 item 8)', () => {
  /** A pasta da tomada com um `status.json` cujo batimento (mtime) é de agora, e a trava do aparelho. */
  function takeWithLock(env: Env, pid: number | undefined): string {
    const takeDir = join(env.takes, 'hagah', TAKE_ID);
    mkdirSync(takeDir, { recursive: true });
    writeFileSync(join(takeDir, 'status.json'), JSON.stringify({ schema: 'contrarregra.status/1', pid, watchdogPid: 0 }));
    mkdirSync(join(env.cache, 'locks'), { recursive: true });
    writeFileSync(env.lockFile, TAKE_ID);
    return takeDir;
  }

  /**
   * Um "supervisor" de verdade noutro processo: a linha de comando leva a pasta da tomada (com o takeId),
   * liga o SIGUSR1 por `installSeverHandler` e grava em `out` o forS que recebeu.
   */
  async function startSupervisor(env: Env, takeDir: string): Promise<{ pid: number; out: string }> {
    const script = join(env.root, 'supervisor.mjs');
    const out = join(env.root, 'supervisor.out');
    const linkUrl = new URL('../src/runner/link.ts', import.meta.url).href;
    writeFileSync(
      script,
      `import { writeFileSync } from 'node:fs';
import { installSeverHandler } from ${JSON.stringify(linkUrl)};
const [dir, out] = process.argv.slice(2);
installSeverHandler(dir, () => [{ sever(forS) { writeFileSync(out, JSON.stringify({ forS })); } }]);
writeFileSync(out + '.ready', '');
setInterval(() => {}, 1000);
`,
    );
    const child = spawn(process.execPath, [script, takeDir, out], { stdio: 'ignore' });
    cleanups.push(() => void child.kill('SIGKILL'));
    await waitFor(() => existsSync(`${out}.ready`), 'supervisor pronto', 10_000);
    return { pid: child.pid!, out };
  }

  test('com a trava: sever.json {forS} na pasta da tomada + SIGUSR1 ao supervisor (confirmado pela linha de comando e pelo batimento)', async () => {
    const env = await setup();
    const takeDir = takeWithLock(env, undefined);
    const supervisor = await startSupervisor(env, takeDir);
    takeWithLock(env, supervisor.pid);
    const result = severRunner(env.config, { forS: 2 });
    assert.deepEqual(result, { owner: 'supervisor', pid: supervisor.pid, forS: 2, takeId: TAKE_ID });
    await waitFor(() => existsSync(supervisor.out), 'o supervisor recebeu o pedido');
    assert.deepEqual(JSON.parse(readFileSync(supervisor.out, 'utf8')), { forS: 2 });
    assert.ok(!existsSync(join(takeDir, 'sever.json')), 'o pedido é apagado depois de lido');
    assert.ok(alive(supervisor.pid), 'o SIGUSR1 foi tratado, não matou o supervisor');
  });

  test('o supervisor corta os próprios sockets e só reconecta depois de forS', async () => {
    const env = await setup({ built: 'Debug' });
    await upRunner(env.config, fast(env));
    const takeDir = takeWithLock(env, process.pid);
    // Este processo segura control sob a trava (lockOwner) e trata o SIGUSR1, como o supervisor.
    const link = await RunnerLink.connect(env.config, { role: 'control', lockOwner: TAKE_ID, backoffInitialMs: 20, backoffMaxMs: 40 });
    const uninstall = installSeverHandler(takeDir, () => [link]);
    try {
      const hellos = env.runner.hellos.length;
      writeFileSync(join(takeDir, 'sever.json'), JSON.stringify({ forS: 0.4 }));
      process.kill(process.pid, 'SIGUSR1');
      const severedAt = performance.now();
      await waitFor(() => link.state === 'severed', 'cortou');
      assert.ok(!existsSync(join(takeDir, 'sever.json')), 'o pedido é apagado depois de lido');
      await waitFor(() => env.runner.server.connections.size === 0, 'os sockets usbmux foram fechados');
      await rejectsWith(link.call('health'), 'E_RUNNER_DOWN');
      await waitFor(() => link.state === 'up', 'reconectou depois do prazo', 3000);
      assert.ok(performance.now() - severedAt >= 380, 'não reconectou antes de forS');
      assert.ok(env.runner.hellos.length > hellos);
    } finally {
      uninstall();
      await link.close();
      rmSync(env.lockFile, { force: true });
    }
    await downRunner(env.config, fast(env));
  });

  test('trava velha: pid reaproveitado por outro processo ou batimento parado → erro claro e nenhum sinal', async () => {
    const env = await setup();
    // pid vivo, mas a linha de comando não é a do supervisor da tomada (SIGUSR1 mataria o `sleep`).
    const stranger = spawn('/bin/sleep', ['30'], { stdio: 'ignore' });
    cleanups.push(() => void stranger.kill('SIGKILL'));
    const takeDir = takeWithLock(env, stranger.pid);
    const reused = await rejectsWith(Promise.resolve().then(() => severRunner(env.config, { forS: 5 })), 'E_RUNNER_DOWN');
    assert.equal(reused.data['reason'], 'no-control-owner');
    assert.ok(!existsSync(join(takeDir, 'sever.json')), 'nenhum pedido escrito');
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.ok(alive(stranger.pid!), 'nenhum sinal ao processo estranho');

    // O supervisor certo, mas o status.json parou de bater há mais de 10 s (S8 item 5).
    const supervisor = await startSupervisor(env, takeDir);
    takeWithLock(env, supervisor.pid);
    const minuteAgo = new Date(Date.now() - 60_000);
    utimesSync(join(takeDir, 'status.json'), minuteAgo, minuteAgo);
    const stale = await rejectsWith(Promise.resolve().then(() => severRunner(env.config, { forS: 5 })), 'E_RUNNER_DOWN');
    assert.equal(stale.data['reason'], 'no-control-owner');
    assert.match(stale.message, /batimento/);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.ok(!existsSync(supervisor.out), 'o supervisor não recebeu sinal');

    // Supervisor morto.
    takeWithLock(env, 2 ** 22 + 7);
    assert.equal((await rejectsWith(Promise.resolve().then(() => severRunner(env.config, { forS: 5 })), 'E_RUNNER_DOWN')).data['reason'], 'no-control-owner');
  });

  test('fora de tomada: corta as linhas deste processo', async () => {
    const env = await setup({ built: 'Debug' });
    await upRunner(env.config, fast(env));
    const link = await RunnerLink.connect(env.config, { role: 'sync' });
    try {
      const result = severRunner(env.config, { forS: 30 });
      assert.deepEqual(result, { owner: 'self', pid: process.pid, forS: 30, links: 1 });
      assert.equal(link.state, 'severed');
    } finally {
      await link.close();
    }
    await downRunner(env.config, fast(env));
  });

  test('trava sem pasta da tomada → E_RUNNER_DOWN; --for inválido → E_CONFIG', async () => {
    const env = await setup();
    mkdirSync(join(env.cache, 'locks'), { recursive: true });
    writeFileSync(env.lockFile, TAKE_ID);
    assert.equal((await rejectsWith(Promise.resolve().then(() => severRunner(env.config, { forS: 5 })), 'E_RUNNER_DOWN')).data['reason'], 'no-control-owner');
    await rejectsWith(Promise.resolve().then(() => severRunner(env.config, { forS: 0 })), 'E_CONFIG');
  });
});

// ── CLI ─────────────────────────────────────────────────────────────────────────────────────────────

describe('CLI contrarregra runner (S8 item 1; AC-0.5)', () => {
  function io(): { out: string[]; err: string[]; io: { stdout: (t: string) => void; stderr: (t: string) => void } } {
    const out: string[] = [];
    const err: string[] = [];
    return { out, err, io: { stdout: (t) => void out.push(t), stderr: (t) => void err.push(t) } };
  }

  test('config com time malformado → E_CONFIG antes de qualquer processo ou conexão (AC-0.5)', async () => {
    const env = await setup({ built: 'Debug' });
    writeFileSync(env.configPath, JSON.stringify({ usbmux: { socketPath: env.usbmuxd.socketPath }, paths: { cache: env.cache }, signing: { team: 'INVALID!' } }));
    for (const sub of [['up'], ['build'], ['status'], ['down']]) {
      const cap = io();
      const code = await main(['runner', ...sub, '--json'], { config: { configPath: env.configPath }, tools: env.tools, io: cap.io });
      assert.equal(code, 1);
      assert.equal((JSON.parse(cap.out.join('')) as { error: { code: string } }).error.code, 'E_CONFIG');
    }
    assert.equal(readdirSync(join(env.toolsDir, 'calls')).length, 0, 'nenhuma ferramenta rodou');
    assert.equal(env.usbmuxd.requests.length, 0, 'nenhuma conexão ao usbmuxd');
  });

  test('up → status → down com --json; erros de uso saem com 2', async () => {
    const env = await setup({ built: 'Debug' });
    const deps = { config: { configPath: env.configPath }, tools: env.tools };
    const up = io();
    // O padrão de prontidão do runner up (500 ms) vale aqui: o runner falso responde na primeira tentativa.
    assert.equal(await main(['runner', 'up', '--json'], { ...deps, io: up.io }), 0, up.err.join(''));
    const upResult = JSON.parse(up.out.join('')) as { state: string; sessionId: string };
    assert.equal(upResult.state, 'up');

    const status = io();
    assert.equal(await main(['runner', 'status', '--json'], { ...deps, io: status.io }), 0, status.err.join(''));
    assert.equal((JSON.parse(status.out.join('')) as { state: string }).state, 'up');

    const text = io();
    assert.equal(await main(['runner', 'status'], { ...deps, io: text.io }), 0);
    assert.match(text.out.join(''), /^state: up\n/);

    // o runner down da CLI espera o runner.shutdown (8 s) antes do SIGTERM: o xcodebuild falso não sai sozinho
    for (const conn of env.runner.server.connections) conn.terminate();
    env.runner.mute.add('runner.shutdown');
    delete env.devicePorts[RUNNER_PORT];
    const down = io();
    assert.equal(await main(['runner', 'down', '--json'], { ...deps, io: down.io }), 0, down.err.join(''));
    const downResult = JSON.parse(down.out.join('')) as { state: string; deleted: string[] };
    assert.equal(downResult.state, 'down');
    assert.ok(downResult.deleted.includes(join(env.sessions, `${upResult.sessionId}.xctestrun`)));

    for (const argv of [
      ['runner', 'up', '--bind', 'endpoint'],
      ['runner', 'up', '--spike', '--bind', 'outro'],
      ['runner', 'build', '--configuration', 'Release'],
      ['runner', 'sever'],
      ['runner', 'sever', '--for', '0'],
      ['runner', 'status', '--spike'],
      ['runner', 'logs'],
      ['tap'],
    ]) {
      const cap = io();
      assert.equal(await main(argv, { ...deps, io: cap.io }), 2, argv.join(' '));
      assert.match(cap.err.join(''), /uso:/);
    }
  });
});
