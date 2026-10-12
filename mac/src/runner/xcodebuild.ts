// Linhas de comando do build e da subida do runner (S2 item 1; deploy.md D3.3) e como os processos são
// criados: o `xcodebuild` **nunca** recebe pipes — entrada de `/dev/null`, saída padrão e de erro num
// arquivo —, e o da sessão roda destacado (sessão de processo própria, sem prender quem o criou) sob
// `caffeinate -dimsu -w <pid>`. As ferramentas vêm por caminho absoluto; os testes trocam por falsos.

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
}

export const DEFAULT_TOOLS: RunnerTools = {
  xcodebuild: '/usr/bin/xcodebuild',
  xcodegen: '/opt/homebrew/bin/xcodegen',
  caffeinate: '/usr/bin/caffeinate',
  xcrun: '/usr/bin/xcrun',
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
export function runToFile(command: string, args: readonly string[], log: string, options: { cwd?: string } = {}): Promise<RunResult> {
  const fd = openLog(log);
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(command, args, { cwd: options.cwd, stdio: ['ignore', fd, fd] });
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
