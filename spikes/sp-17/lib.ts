// Lógica do driver do SP-17 (T-0.37; S4 item 4, S12 item 2) que não depende do aparelho:
// - argumentos do `devicectl` presos ao contêiner do `.xctrunner` do Contrarregra (nenhum outro contêiner é lido);
// - conteúdo de prova determinístico no formato de `events.ndjson`, cópia do contêiner e conferência por SHA-256;
// - PIDs do runner e do Hagah pela lista de processos: o `--filter` do `devicectl` (`CONTAINS` sobre `executable`) falhou
//   no aparelho, então a lista vem inteira num arquivo temporário, é lida e descartada, e só os PIDs ficam;
// - os casos do link `hagah://bible/ENGNIV/PSA/1` pelo runner (`app.openURL` → `XCUIDevice.shared.system.open`).
// Código de spike, descartável (architecture.md A5); testado em `sp17.test.ts` (`node --test spikes/sp-17/sp17.test.ts`).

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { isContrarregraError } from '../../mac/src/core/errors.ts';
import type { TreeNode } from '../../mac/src/core/types.ts';

export type Json = Record<string, unknown>;

export interface Rpc {
  call<T = unknown>(method: string, params?: Record<string, unknown>, options?: { timeoutMs?: number }): Promise<T>;
}

/** O link do spike (research/hagah-targets.md F51) e o de volta ao Salmo 23 (o lugar em que o SP-3 deixou o Hagah). */
export const LINK_PSA1 = 'hagah://bible/ENGNIV/PSA/1';
export const LINK_PSA23 = 'hagah://bible/ENGNIV/PSA/23';
/** Done da T-0.37: arquivo idêntico em ≤ 5 s. */
export const COPY_LIMIT_MS = 5_000;
/** research/hagah-targets.md ("comes to the foreground on Psalm 1 NIV within 3 s with no prompt"). */
export const LINK_LIMIT_MS = 3_000;
/** 64 KiB e 1 MiB: uma tomada curta e uma longa (≈ 4 mil eventos de ~250 B). */
export const DEFAULT_SIZES = [65_536, 1_048_576] as const;
/** O executável do `.xctrunner` (o mesmo do SP-2). */
export const RUNNER_EXE = 'ContrarregraRunner-Runner';

export function errCode(error: unknown): string {
  if (isContrarregraError(error)) return `${error.code}: ${error.message.slice(0, 240)}`;
  if (error instanceof Error) return error.message.slice(0, 240);
  return String(error).slice(0, 240);
}

// ---------------------------------------------------------------------------------------------------------
// devicectl, preso ao contêiner do runner

export interface DevicectlRun {
  ok: boolean;
  json: unknown;
  dtMs: number;
  err?: string;
}

/** Roda `xcrun devicectl <args> --json-output <arquivo>` e devolve o JSON lido (o `sp17.ts` liga ao processo). */
export type Devicectl = (args: string[], timeoutMs: number) => Promise<DevicectlRun>;

/** O bundle do `.xctrunner` (`bundle.runnerTest` + `.xctrunner`, como em `runner/lifecycle.ts`). */
export function runnerContainerId(runnerTest: string): string {
  if (!/^[A-Za-z0-9.-]+$/.test(runnerTest) || runnerTest.endsWith('.xctrunner')) throw new Error(`bundle.runnerTest inválido: ${runnerTest}`);
  return `${runnerTest}.xctrunner`;
}

/** Caminho dentro do contêiner: relativo, sem `..`, sem barra no começo (nada fora do contêiner do runner). */
export function containerPath(path: string): string {
  if (path === '' || path.startsWith('/') || path.split('/').some((part) => part === '..' || part === '')) {
    throw new Error(`caminho de contêiner recusado: ${path}`);
  }
  return path;
}

/**
 * O contêiner de dados do `.xctrunner` do Contrarregra pelo `devicectl`. O `--domain-identifier` é fixado aqui, na
 * construção, a partir de `bundle.runnerTest`: nenhum método aceita outro bundle (só esse contêiner é lido ou escrito).
 */
export class RunnerContainer {
  readonly id: string;
  readonly #dc: Devicectl;
  readonly #device: string;

  constructor(dc: Devicectl, device: string, runnerTest: string) {
    this.#dc = dc;
    this.#device = device;
    this.id = runnerContainerId(runnerTest);
  }

  #domain(): string[] {
    return ['--device', this.#device, '--domain-type', 'appDataContainer', '--domain-identifier', this.id];
  }

  listArgs(subdirectory?: string): string[] {
    return ['device', 'info', 'files', ...this.#domain(), ...(subdirectory === undefined ? [] : ['--subdirectory', containerPath(subdirectory)])];
  }

  pullArgs(source: string, destination: string): string[] {
    return ['device', 'copy', 'from', ...this.#domain(), '--source', containerPath(source), '--destination', destination];
  }

  pushArgs(source: string, destination: string): string[] {
    return ['device', 'copy', 'to', ...this.#domain(), '--source', source, '--destination', containerPath(destination)];
  }

  list(subdirectory?: string, timeoutMs = 30_000): Promise<DevicectlRun> {
    return this.#dc(this.listArgs(subdirectory), timeoutMs);
  }

  pull(source: string, destination: string, timeoutMs = 30_000): Promise<DevicectlRun> {
    return this.#dc(this.pullArgs(source, destination), timeoutMs);
  }

  push(source: string, destination: string, timeoutMs = 30_000): Promise<DevicectlRun> {
    return this.#dc(this.pushArgs(source, destination), timeoutMs);
  }
}

/**
 * As entradas de `devicectl device info files --json-output` (devicectl 518.33, visto no aparelho:
 * `result.files[].{relativePath, metadata.size, resources.isDirectory}`); o tamanho só vale para arquivo.
 */
export function parseFileList(json: unknown): { path: string; size: number | null; dir: boolean }[] {
  const files = ((json as Json | undefined)?.['result'] as Json | undefined)?.['files'];
  if (!Array.isArray(files)) return [];
  const out: { path: string; size: number | null; dir: boolean }[] = [];
  for (const f of files as Json[]) {
    const path = f['relativePath'];
    if (typeof path !== 'string') continue;
    const dir = (f['resources'] as Json | undefined)?.['isDirectory'] === true;
    const size = (f['metadata'] as Json | undefined)?.['size'];
    out.push({ path, size: !dir && typeof size === 'number' ? size : null, dir });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------
// Processos (PIDs) e apps

function stripFileUrl(url: string): string {
  let path = url.startsWith('file://') ? decodeURIComponent(url.slice('file://'.length)) : url;
  if (path.startsWith('/private/')) path = path.slice('/private'.length);
  return path;
}

/** O caminho do `.app` de `bundleId` no JSON de `devicectl device info apps --bundle-id` (sem `/private`, com `/` no fim). */
export function parseAppPath(json: unknown, bundleId: string): string | undefined {
  const apps = ((json as Json | undefined)?.['result'] as Json | undefined)?.['apps'];
  if (!Array.isArray(apps)) return undefined;
  const app = (apps as Json[]).find((a) => a['bundleIdentifier'] === bundleId);
  const url = app?.['url'];
  if (typeof url !== 'string') return undefined;
  const path = stripFileUrl(url);
  return path.endsWith('/') ? path : `${path}/`;
}

/** O pedaço do caminho que identifica o app num filtro do `devicectl` (`<UUID do contêiner>/<Nome>.app/`). */
export function appFragment(appPath: string): string {
  const parts = appPath.split('/').filter((p) => p !== '');
  const app = parts.findIndex((p) => p.endsWith('.app'));
  if (app < 1) throw new Error(`caminho de app inesperado: ${appPath}`);
  return `${parts[app - 1]}/${parts[app]}/`;
}

/**
 * PIDs do executável principal do app em `appPath` (sem extensões em `PlugIns/`), no JSON de `devicectl device info
 * processes` (`result.runningProcesses[].{executable, processIdentifier}`, como no SP-2). Só esses voltam.
 */
export function parseAppPids(json: unknown, appPath: string): number[] {
  const procs = ((json as Json | undefined)?.['result'] as Json | undefined)?.['runningProcesses'];
  if (!Array.isArray(procs)) return [];
  const pids: number[] = [];
  for (const p of procs as Json[]) {
    const exe = typeof p['executable'] === 'string' ? stripFileUrl(p['executable']) : '';
    const pid = p['processIdentifier'];
    if (typeof pid !== 'number' || !exe.startsWith(appPath)) continue;
    if (exe.slice(appPath.length).includes('/')) continue; // extensão (PlugIns/…), não o app
    pids.push(pid);
  }
  return pids.sort((a, b) => a - b);
}

/** PIDs do `.xctrunner` (executável `ContrarregraRunner-Runner`). */
export function parseRunnerPids(json: unknown): number[] {
  const procs = ((json as Json | undefined)?.['result'] as Json | undefined)?.['runningProcesses'];
  if (!Array.isArray(procs)) return [];
  return (procs as Json[])
    .filter((p) => typeof p['executable'] === 'string' && stripFileUrl(p['executable'] as string).endsWith(`/${RUNNER_EXE}`))
    .map((p) => p['processIdentifier'])
    .filter((pid): pid is number => typeof pid === 'number')
    .sort((a, b) => a - b);
}

export interface PidRead {
  ok: boolean;
  pids: number[];
  dtMs: number;
  /** O filtro do `devicectl` funcionou (senão a lista veio inteira e foi filtrada só aqui, sem ser guardada). */
  filtered: boolean;
  err?: string;
}

/**
 * Lê PIDs com `devicectl device info processes --filter "executable CONTAINS '<fragmento>'"`; se o filtro falhar,
 * repete sem ele e filtra em memória (o JSON fica só no arquivo temporário que o `sp17.ts` apaga na hora).
 */
export async function readPids(dc: Devicectl, device: string, fragment: string, pick: (json: unknown) => number[]): Promise<PidRead> {
  if (fragment.includes("'")) throw new Error(`fragmento com aspa: ${fragment}`);
  const base = ['device', 'info', 'processes', '--device', device];
  const filtered = await dc([...base, '--filter', `executable CONTAINS '${fragment}'`], 15_000);
  if (filtered.ok) return { ok: true, pids: pick(filtered.json), dtMs: filtered.dtMs, filtered: true };
  const all = await dc(base, 15_000);
  if (all.ok) return { ok: true, pids: pick(all.json), dtMs: filtered.dtMs + all.dtMs, filtered: false, err: `filtro: ${filtered.err ?? '?'}` };
  return { ok: false, pids: [], dtMs: filtered.dtMs + all.dtMs, filtered: false, err: all.err ?? filtered.err ?? 'devicectl falhou' };
}

// ---------------------------------------------------------------------------------------------------------
// Conteúdo de prova e hash

export function sha256(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * `bytes` bytes de NDJSON no formato de evento de S0.7 (`contrarregra.events/1`), determinístico por `seed`: cada
 * linha `{"seq":n,"type":"step.end",…,"pad":"…"}` + `\n`; a última é ajustada para fechar o tamanho exato.
 */
export function probeNdjson(bytes: number, seed: string): Buffer {
  if (!Number.isInteger(bytes) || bytes < 1024) throw new Error(`tamanho de prova inválido: ${bytes} (mínimo 1024)`);
  if (!/^[A-Za-z0-9-]+$/.test(seed)) throw new Error(`semente inválida: ${seed}`);
  const lines: string[] = [];
  let total = 0;
  for (let seq = 0; ; seq++) {
    const head = `{"schema":"contrarregra.events/1","takeId":"sp17-${seed}","seq":${seq},"type":"step.end","tDevNs":"${1_000_000_000 + seq * 1_234_567}","pad":"`;
    const tail = '"}\n';
    const fixed = head.length + tail.length;
    const want = 200 + (seq % 7) * 13;
    const rest = bytes - total;
    if (rest < 2 * (fixed + want)) {
      // última linha: fecha o tamanho exato (sobra ≥ fixed + 200 pela condição da volta anterior)
      lines.push(head + pad(seed, seq, rest - fixed) + tail);
      break;
    }
    lines.push(head + pad(seed, seq, want) + tail);
    total += fixed + want;
  }
  const out = Buffer.from(lines.join(''), 'utf8');
  if (out.length !== bytes) throw new Error(`prova com ${out.length} B, esperado ${bytes}`);
  return out;
}

function pad(seed: string, seq: number, n: number): string {
  const unit = createHash('sha256').update(`${seed}:${seq}`).digest('hex');
  return unit.repeat(Math.ceil(n / unit.length) + 1).slice(0, n);
}

/** O nome da pasta de prova no contêiner (`Documents/contrarregra/sp17-<rótulo>-<tamanho>/events.ndjson`). */
export function seedPath(label: string, bytes: number): string {
  if (!/^[a-z0-9-]{1,40}$/.test(label)) throw new Error(`rótulo inválido para o contêiner: ${label} (use a-z, 0-9, -)`);
  return `Documents/contrarregra/sp17-${label}-${bytes}/events.ndjson`;
}

// ---------------------------------------------------------------------------------------------------------
// Semear e puxar

export interface Seeded {
  /** `mac` = escrito no contêiner pelo `devicectl device copy to`; `runner` = escrito pelo runner (`spike.logWrite`). */
  source: 'mac' | 'runner';
  path: string;
  bytes: number;
  sha256: string;
  at: string;
  dtMs?: number;
}

export interface FsEnv {
  /** Pasta temporária nova e vazia (apagada por quem chama). */
  tmpDir(): string;
  write(k: string, data?: Json): void;
  now(): number;
}

/** Escreve as provas no contêiner pelo Mac (`copy to`) e devolve o que se espera ler de volta. */
export async function seedFromMac(container: RunnerContainer, env: FsEnv, label: string, sizes: readonly number[]): Promise<Seeded[]> {
  const out: Seeded[] = [];
  for (const bytes of sizes) {
    const data = probeNdjson(bytes, `${label}-${bytes}`);
    const dir = env.tmpDir();
    try {
      const local = join(dir, 'events.ndjson');
      writeFileSync(local, data);
      const path = seedPath(label, bytes);
      const run = await container.push(local, path);
      env.write('seed', { source: 'mac', path, bytes, ok: run.ok, dt: run.dtMs, ...(run.err === undefined ? {} : { err: run.err }) });
      if (!run.ok) throw new Error(`copy to ${path} falhou: ${run.err ?? '?'}`);
      out.push({ source: 'mac', path, bytes, sha256: sha256(data), at: new Date(env.now()).toISOString(), dtMs: run.dtMs });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  return out;
}

/** Resposta de `spike.logWrite` (proposto em `spikes/sp-17/proposed/SP17Log.swift`, G5 pendente). */
export interface LogWriteResult {
  path: string;
  bytes: number;
  sha256: string;
}

/** O runner escreve as provas no próprio contêiner e diz o hash (só no build `Spike` com `spike.logWrite`). */
export async function seedFromRunner(rpc: Rpc, env: FsEnv, label: string, sizes: readonly number[]): Promise<Seeded[]> {
  const out: Seeded[] = [];
  for (const bytes of sizes) {
    const dir = seedPath(label, bytes).split('/')[2] as string;
    const t0 = env.now();
    let result: LogWriteResult;
    try {
      result = await rpc.call<LogWriteResult>('spike.logWrite', { dir, bytes }, { timeoutMs: 30_000 });
    } catch (error) {
      env.write('seed', { source: 'runner', dir, bytes, ok: false, err: errCode(error) });
      throw new Error(`spike.logWrite falhou (${errCode(error)}): o build Spike instalado não tem o método do SP-17 `
        + '(G5 pendente: spikes/sp-17/proposed/SP17Log.swift em ios/ContrarregraRunner/Spikes/, build Spike novo e instalação)');
    }
    const path = containerPath(result.path);
    if (path !== seedPath(label, bytes)) throw new Error(`spike.logWrite escreveu em ${path}, esperado ${seedPath(label, bytes)}`);
    if (!/^[0-9a-f]{64}$/.test(result.sha256)) throw new Error(`spike.logWrite devolveu um hash inválido: ${result.sha256}`);
    env.write('seed', { source: 'runner', path, bytes: result.bytes, sha256: result.sha256, ok: true, dt: Math.round(env.now() - t0) });
    out.push({ source: 'runner', path, bytes: result.bytes, sha256: result.sha256, at: new Date(env.now()).toISOString(), dtMs: Math.round(env.now() - t0) });
  }
  return out;
}

export type RunnerState = 'live' | 'stopped' | 'reup';

export interface PullSample {
  state: RunnerState;
  source: Seeded['source'];
  path: string;
  bytes: number;
  i: number;
  ok: boolean;
  /** Tempo de parede do processo `devicectl device copy from` (do spawn à saída). */
  dtMs: number;
  same: boolean;
  gotBytes?: number;
  gotSha256?: string;
  err?: string;
}

/** O arquivo copiado: `destination` se for arquivo; se o `devicectl` criou uma pasta, o único arquivo dentro dela. */
export function pulledFile(destination: string): string | undefined {
  if (!existsSync(destination)) return undefined;
  if (statSync(destination).isFile()) return destination;
  const stack = [destination];
  const files: string[] = [];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) stack.push(p);
      else files.push(p);
    }
  }
  return files.length === 1 ? files[0] : undefined;
}

/** `n` cópias de cada prova, cada uma num lugar novo; confere tamanho e SHA-256 com o que se semeou. */
export async function pullPhase(container: RunnerContainer, env: FsEnv, seeded: readonly Seeded[], state: RunnerState, n: number): Promise<PullSample[]> {
  const samples: PullSample[] = [];
  for (let i = 0; i < n; i++) {
    for (const seed of seeded) {
      const dir = env.tmpDir();
      try {
        const destination = join(dir, 'events.ndjson');
        const run = await container.pull(seed.path, destination);
        const file = run.ok ? pulledFile(destination) : undefined;
        const data = file === undefined ? undefined : readFileSync(file);
        const got = data === undefined ? undefined : sha256(data);
        const sample: PullSample = {
          state, source: seed.source, path: seed.path, bytes: seed.bytes, i, ok: run.ok && data !== undefined, dtMs: run.dtMs,
          same: got === seed.sha256 && data?.length === seed.bytes,
          ...(data === undefined ? {} : { gotBytes: data.length, gotSha256: got as string }),
          ...(run.err !== undefined ? { err: run.err } : run.ok && data === undefined ? { err: 'copy from sem arquivo no destino' } : {}),
        };
        env.write('pull', { ...sample });
        samples.push(sample);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  }
  return samples;
}

export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[idx] as number;
}

export interface PullSummary {
  state: RunnerState;
  source: string;
  bytes: number;
  n: number;
  ok: number;
  same: number;
  p50Ms: number | null;
  maxMs: number | null;
  /** Todas as cópias deram certo, idênticas e em ≤ 5 s. */
  pass: boolean;
}

export function summarizePulls(samples: readonly PullSample[]): PullSummary[] {
  const groups = new Map<string, PullSample[]>();
  for (const s of samples) {
    const key = `${s.state}|${s.source}|${s.bytes}`;
    groups.set(key, [...(groups.get(key) ?? []), s]);
  }
  const out: PullSummary[] = [];
  for (const group of groups.values()) {
    const first = group[0] as PullSample;
    const times = group.filter((s) => s.ok).map((s) => s.dtMs);
    const maxMs = times.length === 0 ? null : Math.max(...times);
    const ok = group.filter((s) => s.ok).length;
    const same = group.filter((s) => s.same).length;
    out.push({
      state: first.state, source: first.source, bytes: first.bytes, n: group.length, ok, same,
      p50Ms: percentile(times, 0.5), maxMs,
      pass: group.length > 0 && same === group.length && maxMs !== null && maxMs <= COPY_LIMIT_MS,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------
// Link pelo runner

/** Os nós em pré-ordem. */
export function flatten(roots: TreeNode[]): TreeNode[] {
  const out: TreeNode[] = [];
  const walk = (node: TreeNode): void => {
    out.push(node);
    for (const child of node.children ?? []) walk(child);
  };
  for (const root of roots) walk(root);
  return out;
}

/**
 * O leitor do Hagah mostra o capítulo `n` dos Salmos: o título no alto ("Psalms 1, go down" no build 7, botão com
 * y < 350; F3). Só o título conta: o mini-player ("Open Now Playing: Psalms 23, NIV") diz o áudio carregado, não a
 * página. "Psalms 10"/"Psalms 1:2" não contam.
 */
export function showsPsalm(nodes: TreeNode[], n: number): boolean {
  const title = new RegExp(`^Psalms? ${n}(?![\\d:])`);
  return nodes.some((node) => node.visible && node.type === 'button' && node.frame.y < 350 && title.test(node.label ?? ''));
}

/** O título visível do leitor (para o registro), se houver ("Psalms 1, go down", "Genesis 3"). */
export function readerTitle(nodes: TreeNode[]): string | undefined {
  return nodes.find((n) => n.type === 'button' && n.visible && n.frame.y < 350 && !/^Verse /.test(n.label ?? '')
    && /^([1-3] )?\p{Lu}[\p{L} ]* \d+(, go (down|up))?[^\p{L}\d]*$/u.test(n.label ?? ''))?.label;
}

/** O áudio carregado no mini-player (para o registro), se houver. */
export function miniPlayer(nodes: TreeNode[]): string | undefined {
  return nodes.find((n) => n.type === 'button' && n.visible && /^Open Now Playing: /.test(n.label ?? ''))?.label;
}

/** O que está à frente, pelo `ui.tree` do app alvo ou pelo texto da recusa (`E_FORBIDDEN_APP`, AllowList `Front`). */
export type FrontKind = 'hagah' | 'home' | 'layer' | 'locked' | 'controlCenter' | 'other';

export function frontFromRefusal(message: string): FrontKind {
  if (/a tela de início/.test(message)) return 'home';
  if (/uma camada do SpringBoard/.test(message)) return 'layer';
  if (/a tela travada/.test(message)) return 'locked';
  if (/a Central de Controle/.test(message)) return 'controlCenter';
  return 'other';
}

export interface FrontRead {
  kind: FrontKind;
  nodes: TreeNode[];
  at: number;
  msg?: string;
}

export interface LinkEnv {
  rpc: Rpc;
  bundleId: string;
  hagahPids(): Promise<PidRead>;
  write(k: string, data?: Json): void;
  now(): number;
  sleep(ms: number): Promise<void>;
}

/** Lê a frente pelo `ui.tree {app: target}`: nós se o Hagah está à frente; senão, a classe da recusa. */
export async function readFront(env: LinkEnv): Promise<FrontRead> {
  try {
    const r = await env.rpc.call<{ nodes: TreeNode[] }>('ui.tree', { app: 'target', format: 'json', visibleOnly: true }, { timeoutMs: 15_000 });
    return { kind: 'hagah', nodes: flatten(r.nodes), at: env.now() };
  } catch (error) {
    if (isContrarregraError(error, 'E_FORBIDDEN_APP')) return { kind: frontFromRefusal(error.message), nodes: [], at: env.now(), msg: error.message.slice(0, 240) };
    throw error;
  }
}

/** Repete `readFront` até `ok` ou o prazo; devolve a última leitura, se valeu e as classes vistas (em ordem, sem repetir). */
export async function frontUntil(env: LinkEnv, ok: (f: FrontRead) => boolean, timeoutMs: number, everyMs = 400): Promise<{ last: FrontRead; ok: boolean; seen: FrontKind[] }> {
  const deadline = env.now() + timeoutMs;
  const seen: FrontKind[] = [];
  for (;;) {
    const f = await readFront(env);
    if (seen[seen.length - 1] !== f.kind) seen.push(f.kind);
    if (ok(f)) return { last: f, ok: true, seen };
    if (env.now() >= deadline) return { last: f, ok: false, seen };
    await env.sleep(everyMs);
  }
}

export type LinkCase = 'front' | 'background' | 'cold';
export const LINK_CASES: readonly LinkCase[] = ['front', 'background', 'cold'];

export interface ActionTimes {
  tDevStartNs?: string | number;
  tDispatchNs?: string | number;
  tDevEndNs?: string | number;
}

export interface LinkResult {
  kind: LinkCase;
  /** `app.state` do Hagah logo antes do link. */
  stateBefore: string;
  pidsBefore: number[];
  pidsAfter: number[];
  /** Mesmo processo: um PID antes e o mesmo depois; `null` quando não havia processo antes (frio) ou a leitura falhou. */
  samePid: boolean | null;
  /** Ida e volta do `app.openURL` no Mac (ms) e os tempos D da resposta. */
  openMs: number | null;
  openTimes?: ActionTimes;
  /** Do início do `app.openURL` até a primeira leitura com o Salmo 1 à frente (limite superior; inclui a leitura). */
  arrivedMs: number | null;
  arrived: boolean;
  /** Classes de frente vistas depois do link (ex.: `home → hagah`; `layer` = camada do SpringBoard, possível pedido). */
  fronts: FrontKind[];
  /** `none` = chegou sem nada no caminho; `suspected` = uma camada do SpringBoard apareceu ou ficou; `unknown` = não chegou sem camada. */
  prompt: 'none' | 'suspected' | 'unknown';
  title?: string;
  /** O mini-player na leitura de chegada (o áudio carregado). */
  player?: string;
  err?: string;
}

export class LinkStop extends Error {
  readonly step: string;
  constructor(step: string, message: string) {
    super(message);
    this.step = step;
  }
}

async function appState(env: LinkEnv): Promise<string> {
  const r = await env.rpc.call<{ state: string }>('app.state', { bundleId: env.bundleId }, { timeoutMs: 15_000 });
  return r.state;
}

/**
 * Espera a fila do XCTest esvaziar (`health`): um comando que estourou o prazo continua rodando no aparelho e segura
 * a fila (SP-2, SP-3).
 */
export async function drainQueue(env: LinkEnv, maxMs = 90_000): Promise<void> {
  const deadline = env.now() + maxMs;
  for (;;) {
    try {
      const h = await env.rpc.call<{ xctestQueueDepth: number }>('health', {}, { timeoutMs: 3_000 });
      if (h.xctestQueueDepth === 0) return;
      env.write('drain', { depth: h.xctestQueueDepth });
    } catch (error) {
      env.write('drain', { err: errCode(error) });
    }
    if (env.now() > deadline) throw new LinkStop('drain', `a fila do XCTest não esvaziou em ${Math.round(maxMs / 1000)} s`);
    await env.sleep(1_000);
  }
}

async function open(env: LinkEnv, url: string): Promise<{ ms: number; times?: ActionTimes; err?: string }> {
  const t0 = env.now();
  try {
    const r = await env.rpc.call<ActionTimes>('app.openURL', { url }, { timeoutMs: 20_000 });
    return { ms: Math.round(env.now() - t0), times: { tDevStartNs: r.tDevStartNs, tDispatchNs: r.tDispatchNs, tDevEndNs: r.tDevEndNs } };
  } catch (error) {
    const ms = Math.round(env.now() - t0);
    // E_TIMEOUT "rodando": o link pode ter sido aberto (e um pedido do sistema pode estar segurando a chamada).
    if (isContrarregraError(error, 'E_TIMEOUT')) await drainQueue(env);
    return { ms, err: errCode(error) };
  }
}

/** Leva o Hagah à frente no Salmo 23 (o ponto de partida de todo caso: o Salmo 1 só aparece pelo link medido). */
export async function toPsalm23(env: LinkEnv): Promise<void> {
  // uma troca de app em curso (ou nada provado à frente por um instante) não é motivo para parar: espera até 6 s
  const settled = await frontUntil(env, (x) => x.kind === 'hagah' || x.kind === 'home', 6_000, 500);
  let f = settled.last;
  if (f.kind === 'locked') throw new LinkStop('reset', 'a tela está travada: destrave o iPhone e deixe a tela acesa');
  if (f.kind === 'layer' || f.kind === 'other' || f.kind === 'controlCenter') {
    throw new LinkStop('reset', `algo está à frente do Hagah (${f.msg ?? f.kind}); pode ser um alerta ou notificação`);
  }
  if (f.kind === 'hagah' && showsPsalm(f.nodes, 23)) return;
  const r = await open(env, LINK_PSA23);
  env.write('reset', { url: LINK_PSA23, ms: r.ms, ...(r.err === undefined ? {} : { err: r.err }) });
  if (r.err !== undefined) throw new LinkStop('reset', `app.openURL ${LINK_PSA23} falhou: ${r.err}`);
  const w = await frontUntil(env, (x) => x.kind === 'hagah' && showsPsalm(x.nodes, 23), 15_000);
  f = w.last;
  if (!w.ok) throw new LinkStop('reset', `o Hagah não chegou ao Salmo 23 (vi ${w.seen.join(' → ')}; título ${readerTitle(f.nodes) ?? '-'})`);
}

/** Põe o Hagah no estado do caso: à frente, em segundo plano (tela de início) ou encerrado. */
export async function arrange(env: LinkEnv, kind: LinkCase): Promise<void> {
  await toPsalm23(env);
  if (kind === 'front') return;
  if (kind === 'background') {
    await env.rpc.call('device.home', {}, { timeoutMs: 15_000 });
  } else {
    await env.rpc.call('app.terminate', { bundleId: env.bundleId }, { timeoutMs: 20_000 });
  }
  const w = await frontUntil(env, (x) => x.kind === 'home', 10_000);
  if (!w.ok) throw new LinkStop('arrange', `a tela de início não ficou limpa à frente (vi ${w.seen.join(' → ')})`);
  if (kind === 'cold') {
    const deadline = env.now() + 10_000;
    while ((await appState(env)) !== 'notRunning') {
      if (env.now() > deadline) throw new LinkStop('arrange', 'o Hagah não encerrou em 10 s');
      await env.sleep(500);
    }
  }
}

/** Um caso: arruma, lê PIDs, abre o Salmo 1 pelo runner, espera o Hagah à frente nele, lê PIDs de novo. */
export async function linkCase(env: LinkEnv, kind: LinkCase, arriveTimeoutMs = 15_000): Promise<LinkResult> {
  await arrange(env, kind);
  const stateBefore = await appState(env);
  const before = await env.hagahPids();
  env.write('link-before', { kind, stateBefore, pids: before.pids, ok: before.ok, filtered: before.filtered, dt: before.dtMs, ...(before.err === undefined ? {} : { err: before.err }) });
  const t0 = env.now();
  const r = await open(env, LINK_PSA1);
  env.write('link-open', { kind, ms: r.ms, ...(r.times === undefined ? {} : { times: r.times }), ...(r.err === undefined ? {} : { err: r.err }) });
  let arrivedAt: number | null = null;
  let fronts: FrontKind[] = [];
  let title: string | undefined;
  let player: string | undefined;
  if (r.err === undefined) {
    const w = await frontUntil(env, (x) => x.kind === 'hagah' && showsPsalm(x.nodes, 1), arriveTimeoutMs, 300);
    fronts = w.seen;
    title = readerTitle(w.last.nodes);
    player = miniPlayer(w.last.nodes);
    if (w.ok) arrivedAt = w.last.at;
  }
  const after = await env.hagahPids();
  env.write('link-after', { kind, pids: after.pids, ok: after.ok, filtered: after.filtered, dt: after.dtMs, ...(after.err === undefined ? {} : { err: after.err }) });
  const arrived = arrivedAt !== null;
  const samePid = !before.ok || !after.ok || before.pids.length !== 1 ? null
    : after.pids.length === 1 && after.pids[0] === before.pids[0];
  const prompt: LinkResult['prompt'] = fronts.includes('layer') ? 'suspected' : arrived ? 'none' : 'unknown';
  const result: LinkResult = {
    kind, stateBefore, pidsBefore: before.pids, pidsAfter: after.pids, samePid,
    openMs: r.err === undefined ? r.ms : null, ...(r.times === undefined ? {} : { openTimes: r.times }),
    arrivedMs: arrivedAt === null ? null : Math.round(arrivedAt - t0), arrived, fronts, prompt,
    ...(title === undefined ? {} : { title }), ...(player === undefined ? {} : { player }), ...(r.err === undefined ? {} : { err: r.err }),
  };
  env.write('link-case', { ...result });
  return result;
}

/** Os casos em ordem; para no primeiro `LinkStop` (algo que só o dono resolve) ou camada que ficou na frente. */
export async function linkCases(env: LinkEnv, kinds: readonly LinkCase[]): Promise<{ results: LinkResult[]; stop?: LinkStop }> {
  const results: LinkResult[] = [];
  for (const kind of kinds) {
    try {
      const result = await linkCase(env, kind);
      results.push(result);
      if (!result.arrived && result.fronts[result.fronts.length - 1] === 'layer') {
        return { results, stop: new LinkStop(kind, 'uma camada do SpringBoard ficou à frente depois do link (possível pedido de confirmação): o runner não toca nela') };
      }
    } catch (error) {
      if (error instanceof LinkStop) return { results, stop: error };
      throw error;
    }
  }
  return { results };
}

// ---------------------------------------------------------------------------------------------------------
// Relatório

export function markdownPulls(rows: readonly PullSummary[]): string {
  const lines = ['| estado do runner | origem | tamanho | cópias ok | idênticas | p50 | máx | ≤ 5 s e idêntico |', '|---|---|---|---|---|---|---|---|'];
  for (const r of rows) {
    lines.push(`| ${r.state} | ${r.source} | ${r.bytes} B | ${r.ok}/${r.n} | ${r.same}/${r.n} | ${r.p50Ms ?? '-'} ms | ${r.maxMs ?? '-'} ms | ${r.pass ? 'sim' : 'não'} |`);
  }
  return lines.join('\n');
}

export function markdownLinks(rows: readonly LinkResult[]): string {
  const lines = ['| caso | estado antes | PID antes | PID depois | mesmo PID | `app.openURL` | à frente no Salmo 1 | frentes vistas | pedido? |', '|---|---|---|---|---|---|---|---|---|'];
  for (const r of rows) {
    lines.push(`| ${r.kind} | ${r.stateBefore} | ${r.pidsBefore.join(',') || '—'} | ${r.pidsAfter.join(',') || '—'} | ${r.samePid === null ? '—' : r.samePid ? 'sim' : 'não'} | ${r.openMs ?? (r.err ?? '-')} ms | ${r.arrived ? `${r.arrivedMs} ms` : 'não'} | ${r.fronts.join(' → ')} | ${r.prompt} |`);
  }
  return lines.join('\n');
}

/** Outros drivers de spike rodando (um spike no aparelho por vez); `psOutput` = `ps -axo pid=,command=`. */
export function otherSpikes(psOutput: string, selfPid: number): string[] {
  const out: string[] = [];
  for (const line of psOutput.split('\n')) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (m === null) continue;
    const pid = Number(m[1]);
    const cmd = m[2] as string;
    if (pid === selfPid) continue;
    const spike = /spikes\/sp-(\d+)\//.exec(cmd);
    if (spike === null || spike[1] === '17') continue;
    if (/\b(pgrep|grep|ps)\b/.test(cmd.split(' ')[0] ?? '')) continue;
    out.push(`${pid} ${cmd.slice(0, 160)}`);
  }
  return out;
}

/** Garante a pasta e devolve o caminho (para o `sp17.ts`). */
export function ensureDir(path: string): string {
  mkdirSync(path, { recursive: true });
  return path;
}
