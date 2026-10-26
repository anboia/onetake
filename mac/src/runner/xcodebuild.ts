// Linhas de comando do build e da subida do runner (S2 item 1; deploy.md D3.3) e como os processos são
// criados: o `xcodebuild` **nunca** recebe pipes — entrada de `/dev/null`, saída padrão e de erro num
// arquivo —, e o da sessão roda destacado (sessão de processo própria, sem prender quem o criou) sob
// `caffeinate -dimsu -w <pid>`. As ferramentas vêm por caminho absoluto; os testes trocam por falsos.
//
// A reassinatura do XCTRunner (S2 item 1; P-3): o modelo do XCTRunner do Xcode 26.6 não tem `UILaunchScreen`
// e o Xcode copia o Info.plist dele no pós-processamento, depois de todos os passos do alvo (um passo de
// script forma ciclo). Então, depois do `build-for-testing`, o `PlistBuddy` acrescenta a chave e o `codesign`
// repete a assinatura que o próprio Xcode faz desse `.app` (mesma identidade, mesmo `.xcent`); aqui estão só
// as linhas de comando, as leituras das saídas e quem roda as ferramentas curtas (`codesign`, `PlistBuddy`,
// `security`) com a saída capturada.

import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { RUNNER_TARGET } from './xctestrun.ts';

export interface RunnerTools {
  xcodebuild: string;
  xcodegen: string;
  caffeinate: string;
  /** Para o `devicectl`. */
  xcrun: string;
  /** Reassinatura do XCTRunner (S2 item 1). */
  codesign: string;
  plistBuddy: string;
  /** Só `find-identity -v -p codesigning` (nenhuma identidade nova, P-3). */
  security: string;
}

export const DEFAULT_TOOLS: RunnerTools = {
  xcodebuild: '/usr/bin/xcodebuild',
  xcodegen: '/opt/homebrew/bin/xcodegen',
  caffeinate: '/usr/bin/caffeinate',
  xcrun: '/usr/bin/xcrun',
  codesign: '/usr/bin/codesign',
  plistBuddy: '/usr/libexec/PlistBuddy',
  security: '/usr/bin/security',
};

export function resolveTools(tools: Partial<RunnerTools> = {}): RunnerTools {
  return { ...DEFAULT_TOOLS, ...tools };
}

export const SCHEME = 'ContrarregraRunner';
/** O único teste que a sessão roda (S1 item 2). */
export const SERVE_TEST = `${RUNNER_TARGET}/RunnerTests/testServe`;

/** `xcodegen generate --spec ios/project.yml` (D3.3). */
export function xcodegenArgs(repoRoot: string): string[] {
  return ['generate', '--spec', join(repoRoot, 'ios', 'project.yml')];
}

export interface BuildArgsOptions {
  repoRoot: string;
  derivedData: string;
  /** `signing.team` (fixo, P-3). */
  team: string;
  /** Só a `Spike` vai explícita; sem ela vale a do esquema (Debug), como no D3.3. */
  configuration?: string;
}

/** `xcodebuild build-for-testing` do D3.3 (time explícito, assinatura automática). */
export function buildForTestingArgs(options: BuildArgsOptions): string[] {
  const args = [
    'build-for-testing',
    '-project',
    join(options.repoRoot, 'ios', 'Contrarregra.xcodeproj'),
    '-scheme',
    SCHEME,
    '-destination',
    'generic/platform=iOS',
    '-derivedDataPath',
    options.derivedData,
    '-allowProvisioningUpdates',
  ];
  if (options.configuration !== undefined) args.push('-configuration', options.configuration);
  args.push(`DEVELOPMENT_TEAM=${options.team}`, 'CODE_SIGN_STYLE=Automatic');
  return args;
}

/** `xcodebuild test-without-building` da sessão, exatamente como S2 item 1. */
export function testWithoutBuildingArgs(xctestrun: string, udid: string): string[] {
  return [
    'test-without-building',
    '-xctestrun',
    xctestrun,
    '-destination',
    `id=${udid}`,
    '-only-testing',
    SERVE_TEST,
    '-test-timeouts-enabled',
    'NO',
    '-collect-test-diagnostics',
    'never',
    '-parallel-testing-enabled',
    'NO',
    '-destination-timeout',
    '60',
  ];
}

// ── reassinatura do XCTRunner (S2 item 1; P-3) ───────────────────────────────────────────────────────

/** Nome do projeto em `ios/project.yml` (pasta `<nome>.build` dos intermediários). */
export const PROJECT_NAME = 'Contrarregra';
export const LAUNCH_SCREEN_KEY = 'UILaunchScreen';

/** O `.xcent` com que o Xcode assinou o `.app` do XCTRunner (o do alvo de UI test). */
export function xctrunnerXcentPath(derivedData: string, configuration: string): string {
  return join(
    derivedData,
    'Build',
    'Intermediates.noindex',
    `${PROJECT_NAME}.build`,
    `${configuration}-iphoneos`,
    `${RUNNER_TARGET}.build`,
    `${RUNNER_TARGET}.xctest.xcent`,
  );
}

export function plistPrintLaunchScreenArgs(plist: string): string[] {
  return ['-c', `Print :${LAUNCH_SCREEN_KEY}`, plist];
}

export function plistAddLaunchScreenArgs(plist: string): string[] {
  return ['-c', `Add :${LAUNCH_SCREEN_KEY} dict`, plist];
}

/** `codesign -d --verbose=2`: Identifier, Authority e TeamIdentifier (na saída de erro). */
export function codesignDisplayArgs(app: string): string[] {
  return ['-d', '--verbose=2', app];
}

/** Grava os certificados da assinatura em `<prefixo>0` (a folha), `<prefixo>1`… */
export function codesignExtractCertificatesArgs(app: string, prefix: string): string[] {
  return ['-d', `--extract-certificates=${prefix}`, app];
}

/** Os entitlements da assinatura em XML (na saída padrão). */
export function codesignEntitlementsArgs(app: string): string[] {
  return ['-d', '--entitlements', '-', '--xml', app];
}

/**
 * A mesma linha que o Xcode 26.6 usa para assinar o `.app` do XCTRunner (só ele: sem `--deep`, nada aninhado
 * — frameworks e `.xctest` — é reassinado). `sha1` é o da identidade que o Xcode usou.
 */
export function codesignResignArgs(sha1: string, xcent: string, app: string): string[] {
  return ['--force', '--sign', sha1, '--entitlements', xcent, '--timestamp=none', '--generate-entitlement-der', app];
}

export function codesignVerifyArgs(app: string): string[] {
  return ['--verify', '--deep', '--strict', app];
}

export function findIdentityArgs(): string[] {
  return ['find-identity', '-v', '-p', 'codesigning'];
}

export interface CodeSignature {
  identifier: string | null;
  /** A cadeia, da folha à raiz. */
  authorities: string[];
  teamIdentifier: string | null;
}

/** Lê a saída de `codesign -d --verbose=2`. */
export function parseCodesignDisplay(text: string): CodeSignature {
  const signature: CodeSignature = { identifier: null, authorities: [], teamIdentifier: null };
  for (const line of text.split('\n')) {
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (key === 'Identifier') signature.identifier = value;
    else if (key === 'Authority') signature.authorities.push(value);
    else if (key === 'TeamIdentifier') signature.teamIdentifier = value;
  }
  return signature;
}

export interface SigningIdentity {
  /** SHA-1 do certificado, em maiúsculas. */
  sha1: string;
  name: string;
}

/** Lê a saída de `security find-identity -v -p codesigning` (`  4) <SHA-1> "<nome>"`). */
export function parseIdentities(text: string): SigningIdentity[] {
  const found: SigningIdentity[] = [];
  for (const line of text.split('\n')) {
    const match = /^\s*\d+\)\s+([0-9A-Fa-f]{40})\s+"(.*)"\s*$/.exec(line);
    if (match !== null) found.push({ sha1: match[1]!.toUpperCase(), name: match[2]! });
  }
  return found;
}

export interface CaptureResult extends RunResult {
  stdout: string;
  stderr: string;
}

/** Prazo das ferramentas curtas (codesign, PlistBuddy, security). */
export const SHORT_TOOL_TIMEOUT_MS = 60_000;

/** Roda uma ferramenta curta e captura a saída (nunca o `xcodebuild`, que só escreve em arquivo). */
export function runCapture(command: string, args: readonly string[], timeoutMs = SHORT_TOOL_TIMEOUT_MS): Promise<CaptureResult> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      resolve({ exitCode: null, signal: null, stdout: '', stderr: '' });
      return;
    }
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout?.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => err.push(chunk));
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    const finish = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
      clearTimeout(timer);
      resolve({ exitCode, signal, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') });
    };
    child.once('error', () => finish(null, null));
    child.once('close', finish);
  });
}

/** `caffeinate -dimsu -w <pid>`: o Mac não dorme enquanto o `xcodebuild` viver (S2 item 1). */
export function caffeinateArgs(pid: number): string[] {
  return ['-dimsu', '-w', String(pid)];
}

/** Abre o registro para anexar (0600; a pasta é criada). */
function openLog(path: string): number {
  mkdirSync(dirname(path), { recursive: true });
  return openSync(path, 'a', 0o600);
}

export interface RunResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

/** Roda e espera, com a saída no arquivo `log` (sem pipes). */
export function runToFile(command: string, args: readonly string[], log: string, options: { cwd?: string; env?: Record<string, string> } = {}): Promise<RunResult> {
  const fd = openLog(log);
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(command, args, { cwd: options.cwd, env: options.env === undefined ? undefined : { ...process.env, ...options.env }, stdio: ['ignore', fd, fd] });
    } catch {
      closeSync(fd);
      resolve({ exitCode: null, signal: null });
      return;
    }
    closeSync(fd);
    child.once('error', () => resolve({ exitCode: null, signal: null }));
    child.once('exit', (exitCode, signal) => resolve({ exitCode, signal }));
  });
}

export interface DetachedProcess {
  pid: number;
  child: ChildProcess;
}

/**
 * Cria destacado: sessão de processo própria (`setsid`), entrada de `/dev/null`, saída no arquivo `log`
 * (ou descartada) e sem prender o laço do Node de quem criou. Falha ao criar → lança.
 */
export function spawnDetached(command: string, args: readonly string[], log?: string): DetachedProcess {
  const fd = log === undefined ? undefined : openLog(log);
  try {
    const child = spawn(command, args, { detached: true, stdio: ['ignore', fd ?? 'ignore', fd ?? 'ignore'] });
    if (child.pid === undefined) {
      // o `error` (ENOENT…) chega depois; aqui só sabemos que não nasceu
      child.once('error', () => {});
      throw new Error(`não consegui iniciar ${command}`);
    }
    child.unref();
    return { pid: child.pid, child };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
