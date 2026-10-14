// `runner build|up|down|status|sever` (S2 itens 1, 3, 7 e 8; deploy.md D3.3).
//
// - build: `xcodegen generate` + `xcodebuild build-for-testing` (time fixo, assinatura automática), saída
//   em arquivo; depois acrescenta `UILaunchScreen` ao Info.plist do `ContrarregraRunner-Runner.app` e reassina
//   só esse `.app` com a identidade e o `.xcent` que o Xcode usou, conferindo a assinatura, os entitlements e
//   que nenhuma identidade nova apareceu no chaveiro (S2 item 1; P-3); devolve o `.xctestrun` gerado da
//   configuração (`Debug` ou `Spike`). O chaveiro é comparado com uma linha de base persistida
//   (`~/.config/contrarregra/signing-baseline.json`, ao lado do `config.json` e fora do cache, que o macOS apaga:
//   identidades no primeiro build, certificado folha no primeiro build conferido) antes do xcodebuild e em toda
//   saída depois dele; divergência → falha com instrução de G5. Só um build
//   conferido ganha a marca `verified-build-<configuração>.json` (impressão digital do `.xctestrun` e dos dois
//   `.app`), apagada no começo de todo build; o `up` só aceita build com a marca válida.
// - up: recusa durante tomada (`E_BUSY`), exige o cabo (`E_NO_USB` em ≤ 1 s), para a sessão viva que
//   houver, apaga `.xctestrun` de sessões velhas, escreve o da sessão (0600, com as variáveis de S1 e as
//   capturas do XCTest desligadas), sobe o `xcodebuild test-without-building` destacado com saída em
//   arquivo e `caffeinate -dimsu -w <pid>`, e espera o runner responder `session.hello` (⚠️ 120 s, E-2.4).
// - down: recusa durante tomada; `runner.shutdown` se o runner responder, senão SIGTERM/SIGKILL no
//   `xcodebuild`; apaga o `.xctestrun` e o estado da sessão (AC-2.9).
// - status: `{state: down|starting|up, pid, sessionId, transport, rttMs, uptimeS, controlHeldBy?}`.
// - sever: acha o dono de `control` (o supervisor pela trava, ou este processo fora de tomada) e lhe
//   pede o corte por `sever.json {forS}` + `SIGUSR1`.

import { createHash } from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { isDeepStrictEqual } from 'node:util';

import type { Config } from '../core/config.ts';
import { ContrarregraError, isContrarregraError } from '../core/errors.ts';
import type { HealthResult } from '../core/types.ts';
import { readDeviceTransport } from '../device/devicectl.ts';
import { findUsbDevice } from '../usbmux/client.ts';
import { decodePlist, encodePlist, isPlistDict, type PlistDict, type PlistValue } from '../usbmux/plist.ts';
import { openRunner, withRunner, type RunnerConnection } from './client.ts';
import { severLocalLinks, SEVER_FILE } from './link.ts';
import { REPO_ROOT, runnerPaths, type RunnerPaths } from './paths.ts';
import {
  assertNoTake,
  currentSession,
  deleteSessionFiles,
  deleteSessionFilesFor,
  ensureSessionsDir,
  logRunner,
  markSessionDown,
  newSessionId,
  newSessionToken,
  processAlive,
  readSessionStates,
  readTakeLock,
  RUNNER_UP_HINT,
  sessionAlive,
  sessionXctestrunPath,
  sweepSessionFiles,
  writePrivateFile,
  writeSessionState,
  SESSION_SCHEMA,
  type SessionState,
} from './session.ts';
import {
  buildForTestingArgs,
  caffeinateArgs,
  codesignDisplayArgs,
  codesignEntitlementsArgs,
  codesignExtractCertificatesArgs,
  codesignResignArgs,
  codesignVerifyArgs,
  findIdentityArgs,
  LAUNCH_SCREEN_KEY,
  parseCodesignDisplay,
  parseIdentities,
  plistAddLaunchScreenArgs,
  plistPrintLaunchScreenArgs,
  resolveTools,
  runCapture,
  runToFile,
  spawnDetached,
  testWithoutBuildingArgs,
  xcodegenArgs,
  xctrunnerXcentPath,
  type CaptureResult,
  type CodeSignature,
  type RunResult,
  type RunnerTools,
  type SigningIdentity,
} from './xcodebuild.ts';
import {
  BIND_ENV_KEY,
  DEFAULT_CONFIGURATION,
  findBuiltXctestrun,
  makeSessionXctestrun,
  runnerTarget,
  SPIKE_CONFIGURATION,
  TESTROOT,
  type BindMode,
  type BuiltXctestrun,
} from './xctestrun.ts';

/** Espera do `session.hello` na subida (E-2.4: ⚠️ 120 s, o dono pode ter de digitar o código). */
export const READY_TIMEOUT_MS = 120_000;
export const READY_POLL_MS = 500;
/** Depois disso em `starting`, avisa no Mac sobre o código da automação (E-2.4). */
export const STARTING_NOTICE_MS = 5_000;
/** Depois do `runner.shutdown`, quanto esperar o `xcodebuild` sair sozinho. */
export const SHUTDOWN_GRACE_MS = 8_000;
/** Depois do SIGTERM, quanto esperar antes do SIGKILL. */
export const TERM_GRACE_MS = 5_000;
/** Amostras de ida e volta no `runner status`. */
export const STATUS_SAMPLES = 10;

export const CONFIGURATIONS = [DEFAULT_CONFIGURATION, SPIKE_CONFIGURATION] as const;

export interface LifecycleOptions {
  tools?: Partial<RunnerTools>;
  /** Linhas de andamento para o dono (a CLI as manda para a saída de erro). */
  onProgress?: (line: string) => void;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stamp(now = new Date()): string {
  return now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

// ── build ──────────────────────────────────────────────────────────────────────────────────────────

export interface BuildOptions extends LifecycleOptions {
  /** `Debug` (padrão) ou `Spike`. */
  configuration?: string;
  repoRoot?: string;
  /** A pasta da configuração da máquina, onde mora a linha de base da assinatura (padrão: `~/.config/contrarregra/`). */
  configDir?: string;
}

export interface ResignResult {
  /** O `ContrarregraRunner-Runner.app` reassinado. */
  app: string;
  /** `added`: a chave entrou agora; `present`: já estava (build incremental, o Xcode não recopiou o plist). */
  launchScreen: 'added' | 'present';
  /** A identidade (nome e SHA-1 do certificado) que o Xcode usou e que a reassinatura repetiu. */
  identity: string;
  sha1: string;
  team: string;
  /** sha256 da saída de `security find-identity -v -p codesigning`, igual antes e depois. */
  identitiesSha256: string;
}

export interface BuildResult {
  configuration: string;
  /** O `.xctestrun` gerado (sem token: o da sessão é uma cópia feita no `up`). */
  xctestrun: string;
  log: string;
  durationMs: number;
  resign: ResignResult;
}

function buildFailed(step: string, result: RunResult, log: string): ContrarregraError {
  return new ContrarregraError('E_RUNNER_DOWN', `o ${step} falhou (saída ${result.exitCode ?? result.signal ?? 'desconhecida'}); veja ${log}`, {
    reason: 'build-failed',
    step,
    exitCode: result.exitCode,
    signal: result.signal,
    log,
  });
}

export async function buildRunner(config: Config, options: BuildOptions = {}): Promise<BuildResult> {
  const configuration = options.configuration ?? DEFAULT_CONFIGURATION;
  if (!(CONFIGURATIONS as readonly string[]).includes(configuration)) {
    throw new ContrarregraError('E_CONFIG', `configuração de build desconhecida: ${configuration} (use ${CONFIGURATIONS.join(' ou ')})`, { configuration });
  }
  const tools = resolveTools(options.tools);
  const paths = runnerPaths(config, options.configDir);
  const repoRoot = options.repoRoot ?? REPO_ROOT;
  const log = join(paths.logs, `runner-build-${stamp()}-${configuration}.log`);
  const started = performance.now();

  // O chaveiro antes de tudo, contra a linha de base (P-3): no primeiro build ela nasce daqui; nos seguintes,
  // qualquer divergência para antes do xcodebuild.
  const identitiesBefore = await readIdentities(tools, log);
  let baseline = readSigningBaseline(paths, log);
  if (baseline === undefined) {
    baseline = newSigningBaseline(config, identitiesBefore);
    writeSigningBaseline(paths, baseline);
    logLine(log, `linha de base da assinatura criada em ${signingBaselinePath(paths)} (identidades ${identitiesBefore.sha256})`);
  } else {
    const diff = keychainDiff(baseline, identitiesBefore);
    if (diff !== undefined) throw signingBaselineError(paths, log, 'before-build', `o chaveiro mudou desde a linha de base: ${describeDiff(diff)}`, { diff });
  }
  // Um build novo (bom ou ruim) mexe nos produtos: nenhuma marca de "conferido" sobrevive a ele.
  invalidateVerifiedBuilds(paths);

  options.onProgress?.(`runner build: xcodegen generate (registro em ${log})`);
  const generated = await runToFile(tools.xcodegen, xcodegenArgs(repoRoot), log, { cwd: repoRoot });
  if (generated.exitCode !== 0) throw buildFailed('xcodegen generate', generated, log);

  // Do xcodebuild em diante, toda saída (sucesso ou falha) compara o chaveiro com a linha de base.
  let failure: unknown;
  let done: { xctestrun: BuiltXctestrun; resign: Omit<ResignResult, 'identitiesSha256'> } | undefined;
  try {
    options.onProgress?.(`runner build: xcodebuild build-for-testing (${configuration})`);
    const built = await runToFile(
      tools.xcodebuild,
      buildForTestingArgs({
        repoRoot,
        derivedData: paths.derivedData,
        team: config.signing.team,
        ...(configuration === DEFAULT_CONFIGURATION ? {} : { configuration }),
      }),
      log,
      { cwd: repoRoot },
    );
    if (built.exitCode !== 0) throw buildFailed('xcodebuild build-for-testing', built, log);

    const xctestrun = findBuiltXctestrun(paths.products, configuration);
    if (xctestrun === undefined) {
      throw new ContrarregraError('E_RUNNER_DOWN', `o build terminou sem um .xctestrun único da configuração ${configuration} em ${paths.products}`, {
        reason: 'no-build',
        configuration,
        products: paths.products,
        log,
      });
    }
    options.onProgress?.(`runner build: ${LAUNCH_SCREEN_KEY} no XCTRunner e reassinatura com a identidade do Xcode`);
    const resign = await resignXctrunner(config, { tools, paths, built: xctestrun, configuration, log, identitiesBefore, baseline });
    done = { xctestrun, resign };
  } catch (error) {
    failure = error;
  }

  const identitiesAfter = await readIdentities(tools, log);
  const diff = keychainDiff(baseline, identitiesAfter);
  if (diff !== undefined) {
    const buildError = failure === undefined ? undefined : errorSummary(failure);
    throw signingBaselineError(paths, log, 'after-build', `o chaveiro mudou durante o build: ${describeDiff(diff)}`, { diff, buildError });
  }
  if (failure !== undefined || done === undefined) throw failure;

  if (baseline.leafSha1 === null) {
    baseline = { ...baseline, leafSha1: done.resign.sha1, updatedAt: new Date().toISOString() };
    writeSigningBaseline(paths, baseline);
    logLine(log, `linha de base da assinatura: certificado folha ${done.resign.sha1}`);
  }
  recordVerifiedBuild(paths, done.xctestrun);
  logLine(log, `build ${configuration} conferido: marca em ${verifiedBuildPath(paths, configuration)}`);
  return {
    configuration,
    xctestrun: done.xctestrun.path,
    log,
    durationMs: Math.round(performance.now() - started),
    resign: { ...done.resign, identitiesSha256: identitiesAfter.sha256 },
  };
}

// ── linha de base da assinatura (P-3) ───────────────────────────────────────────────────────────────

export const SIGNING_BASELINE_FILE = 'signing-baseline.json';
export const SIGNING_BASELINE_SCHEMA = 'contrarregra.signing-baseline/1';

/**
 * O chaveiro e o certificado aprovados: as identidades de assinatura (`security find-identity -v -p codesigning`)
 * de antes do primeiro `runner build` e o SHA-1 do certificado folha do primeiro build conferido. Os builds
 * seguintes comparam com ela; divergência → falha com instrução de G5 (o dono decide; para aceitar, ele apaga o
 * arquivo — G4 — e roda `runner build`). Sem segredo: só hashes e nomes de identidade.
 */
export interface SigningBaseline {
  schema: typeof SIGNING_BASELINE_SCHEMA;
  identitiesSha256: string;
  identities: SigningIdentity[];
  leafSha1: string | null;
  identity: string;
  team: string;
  createdAt: string;
  updatedAt?: string;
}

/**
 * Na pasta da configuração da máquina (`~/.config/contrarregra/signing-baseline.json`), não em `paths.cache`: o
 * macOS apaga o cache inteiro com disco baixo, e o `runner build` seguinte recriaria a linha de base em silêncio.
 */
export function signingBaselinePath(paths: RunnerPaths): string {
  return join(paths.configDir, SIGNING_BASELINE_FILE);
}

/** Onde a linha de base morava antes (`paths.cache/signing-baseline.json`): só lida, para a migração única. */
export function legacySigningBaselinePath(paths: RunnerPaths): string {
  return join(paths.cache, SIGNING_BASELINE_FILE);
}

function signingBaselineError(
  paths: RunnerPaths,
  log: string,
  when: 'before-build' | 'after-build' | 'certificate',
  message: string,
  extra: { diff?: KeychainDiff; buildError?: Record<string, unknown>; file?: string } = {},
): ContrarregraError {
  const { diff, buildError } = extra;
  const path = extra.file ?? signingBaselinePath(paths);
  // A cópia antiga que a migração deixou no cache voltaria (migrada de novo) se o dono apagasse só a nova.
  const legacy = legacySigningBaselinePath(paths);
  const stale = path !== legacy && existsSync(legacy) ? legacy : undefined;
  const remove = stale === undefined ? 'apagar esse arquivo' : `apagar esse arquivo e a cópia antiga em ${stale}`;
  return new ContrarregraError('E_RUNNER_DOWN', `${message}; nada foi reassinado e o build não serve para \`runner up\` — veja ${log}`, {
    reason: 'signing-baseline',
    when,
    baseline: path,
    ...(stale === undefined ? {} : { legacyBaseline: stale }),
    ...(diff === undefined ? {} : { added: diff.added, removed: diff.removed }),
    ...(buildError === undefined ? {} : { buildError }),
    log,
    hint: `G5: a assinatura divergiu da linha de base (${path}). Mostre ao dono; só com o sim dele: ${remove} (G4) e rodar \`contrarregra runner build\` de novo`,
  });
}

/**
 * A linha de base gravada; ilegível → falha (fail-closed: não se recria uma linha de base por cima de outra).
 * Migração única: sem o arquivo novo e com o antigo em `paths.cache`, o antigo (conferido) é copiado para o
 * lugar novo, e fica onde está; havendo o novo, o antigo é ignorado.
 */
function readSigningBaseline(paths: RunnerPaths, log: string): SigningBaseline | undefined {
  const path = signingBaselinePath(paths);
  if (existsSync(path)) return parseSigningBaseline(paths, path, log);
  const legacy = legacySigningBaselinePath(paths);
  if (!existsSync(legacy)) return undefined;
  const baseline = parseSigningBaseline(paths, legacy, log);
  writeSigningBaseline(paths, baseline);
  logLine(log, `linha de base da assinatura migrada de ${legacy} para ${path} (a cópia antiga fica onde está, sem uso)`);
  return baseline;
}

function parseSigningBaseline(paths: RunnerPaths, file: string, log: string): SigningBaseline {
  try {
    const doc = JSON.parse(readFileSync(file, 'utf8')) as SigningBaseline;
    if (doc.schema === SIGNING_BASELINE_SCHEMA && typeof doc.identitiesSha256 === 'string' && Array.isArray(doc.identities)) return doc;
  } catch {
    // cai no erro abaixo
  }
  throw signingBaselineError(paths, log, 'before-build', `a linha de base da assinatura em ${file} está ilegível`, { file });
}

/** Arquivo da máquina: 0600, numa pasta criada com 0700 se faltar (a do `config.json` existente não é mexida). */
function writeSigningBaseline(paths: RunnerPaths, baseline: SigningBaseline): void {
  const path = signingBaselinePath(paths);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(baseline, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function newSigningBaseline(config: Config, identities: Identities): SigningBaseline {
  return {
    schema: SIGNING_BASELINE_SCHEMA,
    identitiesSha256: identities.sha256,
    identities: identities.list,
    leafSha1: null,
    identity: config.signing.identity,
    team: config.signing.team,
    createdAt: new Date().toISOString(),
  };
}

interface KeychainDiff {
  added: SigningIdentity[];
  removed: SigningIdentity[];
}

/** Identidades a mais ou a menos que a linha de base (`undefined` = igual). */
function keychainDiff(baseline: SigningBaseline, current: Identities): KeychainDiff | undefined {
  const key = (entry: SigningIdentity): string => `${entry.sha1} ${entry.name}`;
  const before = new Set(baseline.identities.map(key));
  const now = new Set(current.list.map(key));
  const added = current.list.filter((entry) => !before.has(key(entry)));
  const removed = baseline.identities.filter((entry) => !now.has(key(entry)));
  if (added.length === 0 && removed.length === 0 && current.sha256 === baseline.identitiesSha256) return undefined;
  return { added, removed };
}

function describeDiff(diff: KeychainDiff): string {
  const parts: string[] = [];
  if (diff.added.length > 0) parts.push(`identidade nova ${diff.added.map((entry) => `${entry.sha1} ${JSON.stringify(entry.name)}`).join(', ')}`);
  if (diff.removed.length > 0) parts.push(`identidade sumida ${diff.removed.map((entry) => `${entry.sha1} ${JSON.stringify(entry.name)}`).join(', ')}`);
  return parts.length > 0 ? parts.join('; ') : 'a lista de identidades mudou';
}

function errorSummary(error: unknown): Record<string, unknown> {
  if (isContrarregraError(error)) return { code: error.code, message: error.message, ...(error.data?.['reason'] === undefined ? {} : { reason: error.data['reason'] }) };
  return { code: null, message: error instanceof Error ? error.message : String(error) };
}

// ── build conferido (S2 item 1; P-3) ────────────────────────────────────────────────────────────────

export const VERIFIED_BUILD_SCHEMA = 'contrarregra.verified-build/1';

export function verifiedBuildPath(paths: RunnerPaths, configuration: string): string {
  return join(paths.cache, `verified-build-${configuration}.json`);
}

function sha256File(path: string): string | null {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex');
  } catch {
    return null;
  }
}

/** Os caminhos dos dois .app no `.xctestrun` gerado (`__TESTROOT__/<Config>-iphoneos/<x>.app`). */
function builtApps(built: BuiltXctestrun, products: string): { runner: string; host: string } | undefined {
  const target = runnerTarget(built.doc);
  const resolve = (key: 'TestHostPath' | 'UITargetAppPath'): string | undefined => {
    const value = target[key];
    return typeof value === 'string' && value.startsWith(`${TESTROOT}/`) ? join(products, value.slice(TESTROOT.length + 1)) : undefined;
  };
  const runner = resolve('TestHostPath');
  const host = resolve('UITargetAppPath');
  return runner === undefined || host === undefined ? undefined : { runner, host };
}

/** A impressão digital de um build: o `.xctestrun` e, de cada .app, o Info.plist e o executável (onde a assinatura mora). */
function buildFingerprint(paths: RunnerPaths, built: BuiltXctestrun): Record<string, string | null> | undefined {
  const apps = builtApps(built, paths.products);
  if (apps === undefined) return undefined;
  const app = (path: string): [string, string] => [join(path, 'Info.plist'), join(path, basename(path, '.app'))];
  const [runnerPlist, runnerExe] = app(apps.runner);
  const [hostPlist, hostExe] = app(apps.host);
  return {
    xctestrun: built.path,
    xctestrunSha256: sha256File(built.path),
    runnerInfoPlistSha256: sha256File(runnerPlist),
    runnerExecutableSha256: sha256File(runnerExe),
    hostInfoPlistSha256: sha256File(hostPlist),
    hostExecutableSha256: sha256File(hostExe),
  };
}

/** Grava a marca de "conferido" do build (só o `runner build` bem-sucedido chama isto). */
export function recordVerifiedBuild(paths: RunnerPaths, built: BuiltXctestrun): void {
  const fingerprint = buildFingerprint(paths, built);
  if (fingerprint === undefined || Object.values(fingerprint).some((value) => value === null)) {
    throw new ContrarregraError('E_RUNNER_DOWN', `não consegui tirar a impressão digital do build ${built.configuration} em ${paths.products}`, {
      reason: 'unverified-build',
      configuration: built.configuration,
    });
  }
  mkdirSync(paths.cache, { recursive: true });
  writeFileSync(
    verifiedBuildPath(paths, built.configuration),
    `${JSON.stringify({ schema: VERIFIED_BUILD_SCHEMA, configuration: built.configuration, recordedAt: new Date().toISOString(), ...fingerprint }, null, 2)}\n`,
  );
}

function invalidateVerifiedBuilds(paths: RunnerPaths): void {
  for (const configuration of CONFIGURATIONS) rmSync(verifiedBuildPath(paths, configuration), { force: true });
}

/** O `up` só instala um build com a marca de "conferido" e a mesma impressão digital (senão `unverified-build`). */
function assertVerifiedBuild(paths: RunnerPaths, built: BuiltXctestrun, hint: string): void {
  const fail = (why: string): ContrarregraError =>
    new ContrarregraError('E_RUNNER_DOWN', `o build ${built.configuration} em ${paths.products} não foi conferido (${why}): rode \`${hint}\``, {
      reason: 'unverified-build',
      configuration: built.configuration,
      hint,
    });
  let marker: Record<string, unknown>;
  try {
    marker = JSON.parse(readFileSync(verifiedBuildPath(paths, built.configuration), 'utf8')) as Record<string, unknown>;
  } catch {
    throw fail('sem a marca de um runner build bem-sucedido');
  }
  const fingerprint = buildFingerprint(paths, built);
  if (marker['schema'] !== VERIFIED_BUILD_SCHEMA || fingerprint === undefined) throw fail('marca inválida');
  for (const [key, value] of Object.entries(fingerprint)) {
    if (value === null || marker[key] !== value) throw fail(`${key} mudou depois do build`);
  }
}

// ── reassinatura do XCTRunner (S2 item 1; P-3) ──────────────────────────────────────────────────────────

function resignFailed(step: string, message: string, log: string, extra: Record<string, unknown> = {}): ContrarregraError {
  return new ContrarregraError(
    'E_RUNNER_DOWN',
    `reassinatura do XCTRunner: ${message}; o build não serve para \`runner up\` — veja ${log}`,
    { reason: 'resign-failed', step, log, ...extra },
  );
}

function logLine(log: string, line: string): void {
  try {
    appendFileSync(log, `[contrarregra] ${line}\n`);
  } catch {
    // o registro é ajuda, não requisito
  }
}

async function tool(tools: RunnerTools, name: keyof RunnerTools, args: string[], log: string, step: string): Promise<CaptureResult> {
  const result = await runCapture(tools[name], args);
  logLine(log, `${step}: ${[name, ...args].join(' ')} → ${result.exitCode ?? result.signal ?? 'não iniciou'}`);
  return result;
}

interface Identities {
  text: string;
  sha256: string;
  list: { sha1: string; name: string }[];
}

async function readIdentities(tools: RunnerTools, log: string): Promise<Identities> {
  const result = await tool(tools, 'security', findIdentityArgs(), log, 'chaveiro');
  if (result.exitCode !== 0) throw resignFailed('identities', `\`security find-identity\` falhou (saída ${result.exitCode ?? result.signal})`, log);
  return { text: result.stdout, sha256: createHash('sha256').update(result.stdout).digest('hex'), list: parseIdentities(result.stdout) };
}

/** O caminho de um produto no `.xctestrun` gerado (`__TESTROOT__/<Config>-iphoneos/<x>.app`). */
function productPath(built: BuiltXctestrun, key: 'TestHostPath' | 'UITargetAppPath', products: string, log: string): string {
  const value = runnerTarget(built.doc)[key];
  if (typeof value !== 'string' || !value.startsWith(`${TESTROOT}/`)) throw resignFailed('products', `o .xctestrun não tem ${key} em ${TESTROOT}`, log);
  return join(products, value.slice(TESTROOT.length + 1));
}

async function readSignature(tools: RunnerTools, app: string, log: string, step: string): Promise<CodeSignature> {
  const result = await tool(tools, 'codesign', codesignDisplayArgs(app), log, step);
  if (result.exitCode !== 0) throw resignFailed(step, `\`codesign -d\` falhou em ${app}`, log);
  return parseCodesignDisplay(`${result.stderr}\n${result.stdout}`);
}

/** SHA-1 do certificado folha da assinatura do `.app` (o `<prefixo>0` de `--extract-certificates`). */
async function leafSha1(tools: RunnerTools, app: string, scratch: string, log: string, step: string): Promise<string> {
  const prefix = join(scratch, `${step}-cert`);
  const result = await tool(tools, 'codesign', codesignExtractCertificatesArgs(app, prefix), log, step);
  const leaf = `${prefix}0`;
  if (result.exitCode !== 0 || !existsSync(leaf)) throw resignFailed(step, `não consegui ler o certificado da assinatura de ${app}`, log);
  return createHash('sha1').update(readFileSync(leaf)).digest('hex').toUpperCase();
}

async function readEntitlements(tools: RunnerTools, app: string, log: string, step: string): Promise<PlistDict> {
  const result = await tool(tools, 'codesign', codesignEntitlementsArgs(app), log, step);
  let doc: PlistValue | undefined;
  try {
    doc = result.exitCode === 0 ? decodePlist(result.stdout) : undefined;
  } catch {
    doc = undefined;
  }
  if (!isPlistDict(doc)) throw resignFailed(step, `não consegui ler os entitlements da assinatura de ${app}`, log);
  return doc;
}

function expectSignature(signature: CodeSignature, want: { identity: string; team: string; identifier: string }, log: string, step: string, app: string): void {
  const authority = signature.authorities[0] ?? null;
  if (authority !== want.identity || signature.teamIdentifier !== want.team || signature.identifier !== want.identifier) {
    throw resignFailed(
      step,
      `a assinatura de ${app} não é a esperada (Authority ${JSON.stringify(authority)}, TeamIdentifier ${JSON.stringify(signature.teamIdentifier)}, Identifier ${JSON.stringify(signature.identifier)}; esperava a identidade ${JSON.stringify(want.identity)}, o time ${want.team} e ${want.identifier})`,
      log,
      { authority, teamIdentifier: signature.teamIdentifier, identifier: signature.identifier },
    );
  }
}

interface ResignContext {
  tools: RunnerTools;
  paths: RunnerPaths;
  built: BuiltXctestrun;
  configuration: string;
  log: string;
  identitiesBefore: Identities;
  baseline: SigningBaseline;
}

/**
 * S2 item 1: acrescenta `UILaunchScreen` ao Info.plist do XCTRunner e reassina só esse `.app` com a identidade
 * e os entitlements que o Xcode usou. Antes de mexer, confere que a assinatura do Xcode é a do time fixo com a
 * identidade da configuração (P-3), que o certificado dela está no chaveiro com esse nome e que o `.xcent` é
 * o que está no `.app`; depois, `codesign --verify --deep --strict` nos dois apps, a mesma assinatura e os
 * mesmos entitlements, e nenhuma identidade nova no chaveiro. Qualquer divergência → o build falha.
 */
async function resignXctrunner(config: Config, ctx: ResignContext): Promise<Omit<ResignResult, 'identitiesSha256'>> {
  const { tools, paths, built, configuration, log, identitiesBefore, baseline } = ctx;
  const app = productPath(built, 'TestHostPath', paths.products, log);
  const host = productPath(built, 'UITargetAppPath', paths.products, log);
  const plist = join(app, 'Info.plist');
  const xcent = xctrunnerXcentPath(paths.derivedData, configuration);
  for (const [what, path] of [['o .app do XCTRunner', app], ['o .app do hospedeiro', host], ['o Info.plist do XCTRunner', plist], ['o .xcent do Xcode', xcent]] as const) {
    if (!existsSync(path)) throw resignFailed('products', `${what} não está em ${path}`, log);
  }
  const want = { identity: config.signing.identity, team: config.signing.team, identifier: `${config.bundle.runnerTest}.xctrunner` };

  mkdirSync(paths.cache, { recursive: true });
  const scratch = mkdtempSync(join(paths.cache, 'resign-'));
  try {
    // 1. A assinatura que o Xcode fez: identidade, time, certificado no chaveiro e entitlements = .xcent.
    expectSignature(await readSignature(tools, app, log, 'xcode-signature'), want, log, 'xcode-signature', app);
    const sha1 = await leafSha1(tools, app, scratch, log, 'xcode-certificate');
    if (baseline.leafSha1 !== null && baseline.leafSha1 !== sha1) {
      throw signingBaselineError(paths, log, 'certificate', `o Xcode assinou com o certificado ${sha1}, não com o da linha de base (${baseline.leafSha1})`);
    }
    const inKeychain = identitiesBefore.list.filter((entry) => entry.sha1 === sha1);
    if (inKeychain.length === 0 || !inKeychain.every((entry) => entry.name === want.identity)) {
      throw resignFailed('keychain', `o certificado ${sha1} da assinatura do Xcode não está no chaveiro como ${JSON.stringify(want.identity)}`, log, { sha1 });
    }
    const entitlements = await readEntitlements(tools, app, log, 'xcode-entitlements');
    let xcentDoc: unknown;
    try {
      xcentDoc = decodePlist(readFileSync(xcent, 'utf8'));
    } catch {
      xcentDoc = undefined;
    }
    if (!isDeepStrictEqual(xcentDoc, entitlements)) {
      throw resignFailed('xcent', `os entitlements de ${xcent} não são os da assinatura do Xcode em ${app}`, log);
    }

    // 2. A chave (idempotente).
    let launchScreen: ResignResult['launchScreen'] = 'present';
    if ((await tool(tools, 'plistBuddy', plistPrintLaunchScreenArgs(plist), log, 'plist')).exitCode !== 0) {
      const added = await tool(tools, 'plistBuddy', plistAddLaunchScreenArgs(plist), log, 'plist');
      const check = added.exitCode === 0 ? await tool(tools, 'plistBuddy', plistPrintLaunchScreenArgs(plist), log, 'plist') : added;
      if (check.exitCode !== 0) throw resignFailed('plist', `não consegui acrescentar ${LAUNCH_SCREEN_KEY} a ${plist}`, log);
      launchScreen = 'added';
    }

    // 3. A reassinatura: a mesma linha do Xcode, só no .app do XCTRunner.
    const signed = await tool(tools, 'codesign', codesignResignArgs(sha1, xcent, app), log, 'resign');
    if (signed.exitCode !== 0) {
      throw resignFailed('resign', `o codesign falhou ao reassinar ${app} (saída ${signed.exitCode ?? signed.signal}): ${signed.stderr.trim().slice(0, 300)}`, log);
    }

    // 4. As conferências.
    for (const target of [app, host]) {
      if ((await tool(tools, 'codesign', codesignVerifyArgs(target), log, 'verify')).exitCode !== 0) {
        throw resignFailed('verify', `\`codesign --verify --deep --strict\` falhou em ${target}`, log);
      }
    }
    expectSignature(await readSignature(tools, app, log, 'resigned-signature'), want, log, 'resigned-signature', app);
    const sha1After = await leafSha1(tools, app, scratch, log, 'resigned-certificate');
    if (sha1After !== sha1) throw resignFailed('resigned-certificate', `o certificado da reassinatura (${sha1After}) não é o do Xcode (${sha1})`, log);
    if (!isDeepStrictEqual(await readEntitlements(tools, app, log, 'resigned-entitlements'), entitlements)) {
      throw resignFailed('resigned-entitlements', `os entitlements de ${app} mudaram na reassinatura`, log);
    }
    logLine(log, `${LAUNCH_SCREEN_KEY} ${launchScreen === 'added' ? 'acrescentada' : 'já presente'}; ${app} reassinado com ${want.identity} (${sha1}), time ${want.team}`);
    return { app, launchScreen, identity: want.identity, sha1, team: want.team };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

// ── parar uma sessão ───────────────────────────────────────────────────────────────────────────────

export type StopOutcome = 'already-exited' | 'shutdown' | 'SIGTERM' | 'SIGKILL';

interface StopOptions {
  /** Tenta `runner.shutdown` antes dos sinais. */
  tryShutdown: boolean;
  shutdownGraceMs?: number;
  termGraceMs?: number;
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal); // o `xcodebuild` é líder da própria sessão de processo (destacado)
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // já saiu
    }
  }
}

async function waitGone(state: SessionState, ms: number): Promise<boolean> {
  const deadline = performance.now() + ms;
  for (;;) {
    if (!sessionAlive(state)) return true;
    if (performance.now() >= deadline) return false;
    await sleep(50);
  }
}

function stopCaffeinate(state: SessionState): void {
  if (state.caffeinatePid !== undefined && processAlive(state.caffeinatePid, 'caffeinate')) signalGroup(state.caffeinatePid, 'SIGTERM');
}

async function stopSession(config: Config, state: SessionState, options: StopOptions): Promise<StopOutcome> {
  try {
    if (!sessionAlive(state)) return 'already-exited';
    if (options.tryShutdown) {
      let sent = false;
      try {
        await withRunner(config, { role: 'control', session: state, helloTimeoutMs: 2_000 }, (c) => c.call('runner.shutdown', {}, { timeoutMs: 2_000 }));
        sent = true;
      } catch {
        // sem cabo, runner travado ou já saindo: segue para os sinais
      }
      if (sent && (await waitGone(state, options.shutdownGraceMs ?? SHUTDOWN_GRACE_MS))) return 'shutdown';
    }
    signalGroup(state.xcodebuildPid, 'SIGTERM');
    if (await waitGone(state, options.termGraceMs ?? TERM_GRACE_MS)) return 'SIGTERM';
    signalGroup(state.xcodebuildPid, 'SIGKILL');
    await waitGone(state, 2_000);
    return 'SIGKILL';
  } finally {
    stopCaffeinate(state);
  }
}

// ── up ─────────────────────────────────────────────────────────────────────────────────────────────

export interface UpOptions extends LifecycleOptions {
  /** `runner up --spike`: configuração `Spike` e `CONTRARREGRA_BIND`. */
  spike?: boolean;
  /** `CONTRARREGRA_BIND` (só com `spike`); padrão `loopback`. */
  bind?: BindMode;
  readyTimeoutMs?: number;
  pollMs?: number;
  /** Para a sessão viva anterior (repassado a `stopSession`). */
  shutdownGraceMs?: number;
  termGraceMs?: number;
}

export interface UpResult {
  state: 'up';
  sessionId: string;
  /** Pid do `xcodebuild` da sessão. */
  pid: number;
  configuration: string;
  port: number;
  readyMs: number;
  runnerVersion: string;
  xctestrun: string;
  log: string;
}

/** As variáveis de S1 que o `.xctestrun` da sessão leva (listas separadas por vírgula; vazio = nenhum). */
export function sessionEnv(config: Config, sessionId: string, token: string, spike: boolean, bind: BindMode): Record<string, string> {
  const env: Record<string, string> = {
    CONTRARREGRA_PORT: String(config.runner.port),
    CONTRARREGRA_TOKEN: token,
    CONTRARREGRA_SESSION: sessionId,
    CONTRARREGRA_PRIVATE: config.runner.privateAllowed.join(','),
    CONTRARREGRA_ALLOWED: [...config.apps.allowed, ...config.urls.allowedPrefixes].join(','),
    CONTRARREGRA_EXPLORE: config.app.explore ?? '',
  };
  if (spike) env[BIND_ENV_KEY] = bind;
  return env;
}

export async function upRunner(config: Config, options: UpOptions = {}): Promise<UpResult> {
  const paths = runnerPaths(config);
  const tools = resolveTools(options.tools);
  const spike = options.spike ?? false;
  if (options.bind !== undefined && !spike) throw new ContrarregraError('E_CONFIG', '`--bind` só vale com `--spike` (CONTRARREGRA_BIND existe só no build Spike)', {});
  const bind: BindMode = options.bind ?? 'loopback';
  const configuration = spike ? SPIKE_CONFIGURATION : DEFAULT_CONFIGURATION;

  // Pré-requisitos antes de derrubar qualquer coisa: sem tomada, com cabo, com o build pedido. Faltando
  // um, a sessão que estiver de pé continua de pé.
  assertNoTake(paths, 'runner up');
  await findUsbDevice({ socketPath: config.usbmux.socketPath, udid: config.device.udid });
  const built = findBuiltXctestrun(paths.products, configuration);
  const buildHint = spike ? 'contrarregra runner build --configuration Spike' : 'contrarregra runner build';
  if (built === undefined) {
    throw new ContrarregraError('E_RUNNER_DOWN', `não há build ${configuration} do runner em ${paths.products}: rode \`${buildHint}\``, {
      reason: 'no-build',
      configuration,
      hint: buildHint,
    });
  }
  // Só um build que o `runner build` conferiu (reassinatura e chaveiro) e que ninguém mexeu depois.
  assertVerifiedBuild(paths, built, buildHint);

  // Uma sessão por vez: a viva anterior para; depois, os arquivos das sessões mortas são apagados (a
  // varredura nunca toca numa sessão viva nem na sobra recém-criada de outra subida em curso).
  for (const old of readSessionStates(paths)) {
    if (sessionAlive(old)) {
      options.onProgress?.(`runner up: parando a sessão anterior ${old.sessionId}`);
      const stopOptions: StopOptions = { tryShutdown: true };
      if (options.shutdownGraceMs !== undefined) stopOptions.shutdownGraceMs = options.shutdownGraceMs;
      if (options.termGraceMs !== undefined) stopOptions.termGraceMs = options.termGraceMs;
      await stopSession(config, old, stopOptions);
    } else {
      stopCaffeinate(old);
    }
  }
  const removed = sweepSessionFiles(paths);
  if (removed.length > 0) logRunner(paths, `runner up: apagados ${removed.length} arquivos de sessões velhas`);

  const sessionId = newSessionId();
  const token = newSessionToken();
  ensureSessionsDir(paths);
  const xctestrun = sessionXctestrunPath(paths, sessionId);
  const doc = makeSessionXctestrun(built.doc, { testRoot: paths.products, env: sessionEnv(config, sessionId, token.reveal(), spike, bind) });
  writePrivateFile(xctestrun, encodePlist(doc));
  const log = join(paths.logs, `xcodebuild-${sessionId}.log`);

  let state: SessionState;
  let exited: RunResult | undefined;
  let spawnedPid: number | undefined;
  let caffeinatePid: number | undefined;
  try {
    const xcodebuild = spawnDetached(tools.xcodebuild, testWithoutBuildingArgs(xctestrun, config.device.udid), log);
    spawnedPid = xcodebuild.pid;
    xcodebuild.child.once('exit', (exitCode, signal) => {
      exited = { exitCode, signal };
    });
    try {
      caffeinatePid = spawnDetached(tools.caffeinate, caffeinateArgs(xcodebuild.pid)).pid;
    } catch {
      logRunner(paths, `runner up: caffeinate não iniciou para a sessão ${sessionId}`);
    }
    state = {
      schema: SESSION_SCHEMA,
      sessionId,
      udid: config.device.udid,
      port: config.runner.port,
      configuration,
      spike,
      ...(spike ? { bind } : {}),
      xctestrun,
      log,
      xcodebuildPid: xcodebuild.pid,
      ...(caffeinatePid === undefined ? {} : { caffeinatePid }),
      startedAt: new Date().toISOString(),
    };
    writeSessionState(paths, state);
  } catch (error) {
    // Nada fica órfão: sem o estado, ninguém acharia esses processos depois.
    for (const pid of [spawnedPid, caffeinatePid]) if (pid !== undefined) signalGroup(pid, 'SIGTERM');
    deleteSessionFilesFor(paths, sessionId);
    throw new ContrarregraError('E_RUNNER_DOWN', `não consegui iniciar a sessão do runner: ${(error as Error).message}`, { reason: 'spawn-failed', log }, { cause: error });
  }
  logRunner(paths, `runner up: sessão ${sessionId} (${configuration}) com xcodebuild ${state.xcodebuildPid}; registro ${log}`);

  const fail = async (error: ContrarregraError): Promise<never> => {
    await stopSession(config, state, { tryShutdown: false, termGraceMs: options.termGraceMs ?? TERM_GRACE_MS });
    deleteSessionFilesFor(paths, sessionId); // só os desta sessão: outra subida pode estar escrevendo a dela
    logRunner(paths, `runner up: sessão ${sessionId} falhou (${error.code}: ${error.message})`);
    throw error;
  };

  const readyTimeoutMs = options.readyTimeoutMs ?? READY_TIMEOUT_MS;
  const pollMs = options.pollMs ?? READY_POLL_MS;
  const started = performance.now();
  let lastError: unknown;
  let noticed = false;
  for (;;) {
    if (exited !== undefined) {
      return fail(
        new ContrarregraError('E_RUNNER_DOWN', `o xcodebuild da sessão saiu antes do runner responder (saída ${exited.exitCode ?? exited.signal}); veja ${log}`, {
          reason: 'xcodebuild-exited',
          exitCode: exited.exitCode,
          signal: exited.signal,
          log,
          hint: RUNNER_UP_HINT,
        }),
      );
    }
    let connection: RunnerConnection | undefined;
    try {
      connection = await openRunner(config, { role: 'control', session: state });
    } catch (error) {
      lastError = error;
      // Sem cabo, ou uma tomada pegou a trava no meio: não adianta esperar. O resto (Connect recusado,
      // runner velho com outro token, xcodebuild ainda no exec) é "ainda subindo".
      if (isContrarregraError(error, 'E_NO_USB')) return fail(error);
      if (isContrarregraError(error, 'E_BUSY') && readTakeLock(paths) !== undefined) return fail(error);
    }
    if (connection !== undefined) {
      const readyMs = Math.round(performance.now() - started);
      const runnerVersion = connection.hello.runnerVersion;
      await connection.close();
      logRunner(paths, `runner up: sessão ${sessionId} pronta em ${readyMs} ms`);
      return { state: 'up', sessionId, pid: state.xcodebuildPid, configuration, port: state.port, readyMs, runnerVersion, xctestrun, log };
    }
    const elapsed = performance.now() - started;
    if (elapsed >= readyTimeoutMs) {
      return fail(
        new ContrarregraError('E_RUNNER_DOWN', `o runner não respondeu session.hello em ${Math.round(readyTimeoutMs / 1000)} s; veja ${log}`, {
          reason: 'ready-timeout',
          waitedMs: Math.round(elapsed),
          lastError: isContrarregraError(lastError) ? lastError.code : lastError instanceof Error ? lastError.message : null,
          log,
          hint: RUNNER_UP_HINT,
        }),
      );
    }
    if (!noticed && elapsed >= STARTING_NOTICE_MS) {
      noticed = true;
      options.onProgress?.(
        `runner up: starting — esperando o session.hello (até ${Math.round(readyTimeoutMs / 1000)} s). Se o iPhone pedir o código para a automação (Enable UI Automation), digite-o no aparelho.`,
      );
    }
    await sleep(pollMs);
  }
}

// ── down ───────────────────────────────────────────────────────────────────────────────────────────

export interface DownOptions extends LifecycleOptions {
  shutdownGraceMs?: number;
  termGraceMs?: number;
}

export interface DownResult {
  state: 'down';
  /** Uma entrada por sessão encontrada. */
  stopped: { sessionId: string; pid: number; how: StopOutcome }[];
  /** `.xctestrun` e estados apagados (AC-2.9). */
  deleted: string[];
}

export async function downRunner(config: Config, options: DownOptions = {}): Promise<DownResult> {
  const paths = runnerPaths(config);
  assertNoTake(paths, 'runner down');
  const stopped: DownResult['stopped'] = [];
  for (const state of readSessionStates(paths)) {
    const stopOptions: StopOptions = { tryShutdown: true };
    if (options.shutdownGraceMs !== undefined) stopOptions.shutdownGraceMs = options.shutdownGraceMs;
    if (options.termGraceMs !== undefined) stopOptions.termGraceMs = options.termGraceMs;
    const how = await stopSession(config, state, stopOptions);
    stopped.push({ sessionId: state.sessionId, pid: state.xcodebuildPid, how });
  }
  const deleted = deleteSessionFiles(paths);
  logRunner(paths, `runner down: ${stopped.map((s) => `${s.sessionId} (${s.how})`).join(', ') || 'nenhuma sessão'}; ${deleted.length} arquivos apagados`);
  return { state: 'down', stopped, deleted };
}

// ── status ─────────────────────────────────────────────────────────────────────────────────────────

export interface RunnerStatus {
  state: 'down' | 'starting' | 'up';
  /** Pid do `xcodebuild` da sessão viva. */
  pid: number | null;
  sessionId: string | null;
  transport: { usb: boolean; wired: boolean | null; tunnelState: string | null };
  rttMs: { p50: number; p95: number } | null;
  uptimeS: number | null;
  /** O `takeId` (ou `unknown`) de quem segura `control`, quando não é este comando. */
  controlHeldBy?: string;
}

export interface StatusOptions extends LifecycleOptions {
  samples?: number;
}

/** Percentil por posição (nearest-rank), arredondado a 0,01 ms. */
export function percentile(samples: readonly number[], p: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Math.round(sorted[index]! * 100) / 100;
}

async function measure(samples: number, round: () => Promise<unknown>): Promise<{ p50: number; p95: number }> {
  const rtts: number[] = [];
  for (let i = 0; i < samples; i++) {
    const t0 = performance.now();
    await round();
    rtts.push(performance.now() - t0);
  }
  return { p50: percentile(rtts, 50), p95: percentile(rtts, 95) };
}

export async function runnerStatus(config: Config, options: StatusOptions = {}): Promise<RunnerStatus> {
  const paths = runnerPaths(config);
  const tools = resolveTools(options.tools);
  const samples = Math.max(1, options.samples ?? STATUS_SAMPLES);
  await findUsbDevice({ socketPath: config.usbmux.socketPath, udid: config.device.udid });
  const device = await readDeviceTransport({
    xcrun: tools.xcrun,
    udid: config.device.udid,
    coreDeviceId: config.device.coreDeviceId,
    outDir: paths.cache,
  });
  const transport = {
    usb: true,
    wired: device?.transportType == null ? null : device.transportType === 'wired',
    tunnelState: device?.tunnelState ?? null,
  };
  const takeId = readTakeLock(paths);
  const held = takeId === undefined ? {} : { controlHeldBy: takeId };

  const state = currentSession(paths);
  if (state === undefined) return { state: 'down', pid: null, sessionId: null, transport, rttMs: null, uptimeS: null, ...held };
  if (!sessionAlive(state)) {
    markSessionDown(paths, state);
    return { state: 'down', pid: null, sessionId: state.sessionId, transport, rttMs: null, uptimeS: null, ...held };
  }
  const starting: RunnerStatus = { state: 'starting', pid: state.xcodebuildPid, sessionId: state.sessionId, transport, rttMs: null, uptimeS: null, ...held };

  const viaSync = async (heldBy: string): Promise<RunnerStatus> => {
    try {
      return await withRunner(config, { role: 'sync', session: state }, async (c) => {
        let seq = 0;
        const rttMs = await measure(samples, () => c.call('clock.ping', { seq: seq++ }, { timeoutMs: 2_000 }));
        return { state: 'up', pid: state.xcodebuildPid, sessionId: state.sessionId, transport, rttMs, uptimeS: null, controlHeldBy: heldBy };
      });
    } catch (error) {
      if (isContrarregraError(error, 'E_NO_USB')) throw error;
      return { ...starting, controlHeldBy: heldBy };
    }
  };

  if (takeId !== undefined) return viaSync(takeId);
  try {
    return await withRunner(config, { role: 'control', session: state }, async (c) => {
      let uptimeS: number | null = null;
      const rttMs = await measure(samples, async () => {
        const health = await c.call<HealthResult>('health', {}, { timeoutMs: 2_000 });
        if (typeof health?.uptimeS === 'number') uptimeS = health.uptimeS;
      });
      return { state: 'up', pid: state.xcodebuildPid, sessionId: state.sessionId, transport, rttMs, uptimeS };
    });
  } catch (error) {
    if (isContrarregraError(error, 'E_NO_USB')) throw error;
    if (isContrarregraError(error, 'E_BUSY')) {
      const heldBy = error.data?.['takeId'];
      return viaSync(typeof heldBy === 'string' ? heldBy : 'unknown');
    }
    return starting;
  }
}

// ── sever ──────────────────────────────────────────────────────────────────────────────────────────

export interface SeverResult {
  /** Quem recebeu o pedido: o supervisor da tomada ou este processo (fora de tomada). */
  owner: 'supervisor' | 'self';
  pid: number;
  forS: number;
  takeId?: string;
  /** Fora de tomada: quantas linhas deste processo foram cortadas. */
  links?: number;
}

function findTakeDir(paths: RunnerPaths, takeId: string): string | undefined {
  let apps: string[];
  try {
    apps = readdirSync(paths.takes, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return undefined;
  }
  for (const app of apps) {
    const dir = join(paths.takes, app, takeId);
    if (existsSync(join(dir, 'status.json'))) return dir;
  }
  return undefined;
}

/** Batimento do supervisor mais velho que isto = supervisor perdido (S8 item 5). */
export const SUPERVISOR_STALE_MS = 10_000;

/**
 * `runner sever --for <s>` (S2 item 8). Com a trava: o supervisor é o `pid` do `status.json` da tomada, e
 * só recebe o sinal se for mesmo ele — vivo, com o `takeId` na linha de comando (o supervisor é lançado com
 * a pasta da tomada nos argumentos) e com batimento recente (o `status.json` é regravado a 1 Hz; mais de
 * 10 s parado = perdido, S8 item 5). Senão, erro claro e nenhum sinal: um pid reaproveitado receberia um
 * `SIGUSR1`, que por padrão termina o processo.
 */
export function severRunner(config: Config, options: { forS: number }, now = Date.now()): SeverResult {
  const { forS } = options;
  if (!Number.isFinite(forS) || forS <= 0) throw new ContrarregraError('E_CONFIG', `--for precisa ser um número de segundos > 0 (veio ${forS})`, { forS });
  const paths = runnerPaths(config);
  const takeId = readTakeLock(paths);
  if (takeId === undefined) {
    return { owner: 'self', pid: process.pid, forS, links: severLocalLinks(forS) };
  }
  const noOwner = (why: string): ContrarregraError =>
    new ContrarregraError('E_RUNNER_DOWN', `a trava do aparelho é da tomada ${takeId}, mas ${why}: confira \`contrarregra take status\``, {
      reason: 'no-control-owner',
      takeId,
    });
  const dir = findTakeDir(paths, takeId);
  if (dir === undefined) throw noOwner(`a pasta da tomada não tem status.json em ${paths.takes}`);
  const statusPath = join(dir, 'status.json');
  let pid: unknown;
  let beatAgeMs: number;
  try {
    beatAgeMs = now - statSync(statusPath).mtimeMs;
    pid = (JSON.parse(readFileSync(statusPath, 'utf8')) as Record<string, unknown>)['pid'];
  } catch {
    throw noOwner('o status.json da tomada não pôde ser lido');
  }
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) throw noOwner('o status.json não tem o pid do supervisor');
  if (beatAgeMs > SUPERVISOR_STALE_MS) throw noOwner(`o batimento do supervisor parou há ${Math.round(beatAgeMs / 1000)} s`);
  if (!processAlive(pid, takeId)) throw noOwner(`o pid ${pid} do status.json não é o supervisor da tomada (morto ou reaproveitado)`);
  writeFileSync(join(dir, SEVER_FILE), `${JSON.stringify({ forS })}\n`);
  process.kill(pid, 'SIGUSR1');
  return { owner: 'supervisor', pid, forS, takeId };
}
