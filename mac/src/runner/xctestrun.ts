// O `.xctestrun` da sessão (S2 item 1; S1 itens 2 e 9; P-3): cópia do gerado pelo `build-for-testing`
// com as variáveis de ambiente do runner (S1, "API / Interface") e as capturas automáticas do XCTest
// desligadas (`SystemAttachmentLifetime`/`UserAttachmentLifetime = keepNever`,
// `PreferredScreenCaptureFormat = screenshots`). A cópia mora fora da pasta dos produtos, então o
// `__TESTROOT__` (a pasta do próprio `.xctestrun` para o `xcodebuild`) vira o caminho absoluto dos
// produtos. Aceita o formato 1 (alvos no topo, o que o Xcode 26.6 gera para este esquema) e o 2
// (`TestConfigurations[].TestTargets[]`).

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { decodePlist, isPlistDict, type PlistDict, type PlistValue } from '../usbmux/plist.ts';

/** Nome do alvo de UI test no esquema (`ios/project.yml`). */
export const RUNNER_TARGET = 'ContrarregraRunner';
/** Configuração do build de produção e a dos spikes (S1, S2 item 1). */
export const DEFAULT_CONFIGURATION = 'Debug';
export const SPIKE_CONFIGURATION = 'Spike';
export const TESTROOT = '__TESTROOT__';
const METADATA_KEY = '__xctestrun_metadata__';

/** As variáveis que todo `.xctestrun` de sessão leva (S1 "API / Interface"). */
export const SESSION_ENV_KEYS = [
  'CONTRARREGRA_PORT',
  'CONTRARREGRA_TOKEN',
  'CONTRARREGRA_SESSION',
  'CONTRARREGRA_PRIVATE',
  'CONTRARREGRA_ALLOWED',
  'CONTRARREGRA_EXPLORE',
] as const;
/** Só na configuração `Spike` (`runner up --spike`). */
export const BIND_ENV_KEY = 'CONTRARREGRA_BIND';
export const BIND_VALUES = ['loopback', 'endpoint'] as const;
export type BindMode = (typeof BIND_VALUES)[number];

/** Capturas automáticas do XCTest desligadas pelos meios documentados (S1 item 9). */
export const CAPTURE_SETTINGS = {
  SystemAttachmentLifetime: 'keepNever',
  UserAttachmentLifetime: 'keepNever',
  PreferredScreenCaptureFormat: 'screenshots',
} as const;

export class XctestrunError extends Error {
  override readonly name = 'XctestrunError';
}

/** Os alvos de teste do documento, nos formatos 1 e 2. */
function testTargets(doc: PlistDict): PlistDict[] {
  const configurations = doc['TestConfigurations'];
  if (Array.isArray(configurations)) {
    return configurations.flatMap((configuration) => {
      const targets = isPlistDict(configuration) ? configuration['TestTargets'] : undefined;
      return Array.isArray(targets) ? targets.filter(isPlistDict) : [];
    });
  }
  return Object.entries(doc)
    .filter(([key, value]) => key !== METADATA_KEY && isPlistDict(value))
    .map(([, value]) => value as PlistDict);
}

/** O alvo do runner: o de `BlueprintName = ContrarregraRunner` ou, sem nome, o único alvo. */
export function runnerTarget(doc: PlistDict): PlistDict {
  const targets = testTargets(doc);
  const named = targets.filter((target) => target['BlueprintName'] === RUNNER_TARGET);
  if (named.length === 1) return named[0]!;
  if (named.length === 0 && targets.length === 1) return targets[0]!;
  throw new XctestrunError(`esperava um alvo ${RUNNER_TARGET} no .xctestrun, achei ${named.length} (de ${targets.length} alvos)`);
}

/** A configuração de build (`Debug`, `Spike`…) pela pasta do `TestHostPath` (`…/<Config>-iphoneos/…`). */
export function xctestrunConfiguration(doc: PlistDict): string | undefined {
  const hostPath = runnerTarget(doc)['TestHostPath'];
  if (typeof hostPath !== 'string') return undefined;
  return /(?:^|\/)([^/]+)-iphoneos\/[^/]+$/.exec(hostPath)?.[1];
}

export function parseXctestrun(text: string): PlistDict {
  const doc = decodePlist(text);
  if (!isPlistDict(doc)) throw new XctestrunError('o .xctestrun não é um dicionário plist');
  return doc;
}

/** Troca `__TESTROOT__` em toda string do documento (cópia profunda; nada é alterado no original). */
function resolveTestRoot(value: PlistValue, testRoot: string): PlistValue {
  if (typeof value === 'string') return value.split(TESTROOT).join(testRoot);
  if (Array.isArray(value)) return value.map((item) => resolveTestRoot(item, testRoot));
  if (isPlistDict(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveTestRoot(item, testRoot)]));
  return value;
}

export interface SessionXctestrunOptions {
  /** Pasta onde o `.xctestrun` gerado estava (vira o `__TESTROOT__`). */
  testRoot: string;
  /** `SESSION_ENV_KEYS` (e `CONTRARREGRA_BIND` no `Spike`), já como texto. */
  env: Readonly<Record<string, string>>;
}

/** O documento da sessão: cópia do gerado + variáveis do runner + capturas desligadas. */
export function makeSessionXctestrun(source: PlistDict, options: SessionXctestrunOptions): PlistDict {
  const doc = resolveTestRoot(source, options.testRoot) as PlistDict;
  const target = runnerTarget(doc);
  const current = target['EnvironmentVariables'];
  target['EnvironmentVariables'] = { ...(isPlistDict(current) ? current : {}), ...options.env };
  Object.assign(target, CAPTURE_SETTINGS);
  return doc;
}

/** As variáveis de ambiente do runner num `.xctestrun` (só as de texto). */
export function xctestrunEnv(doc: PlistDict): Record<string, string> {
  const env = runnerTarget(doc)['EnvironmentVariables'];
  if (!isPlistDict(env)) return {};
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
}

export interface BuiltXctestrun {
  path: string;
  configuration: string;
  doc: PlistDict;
  mtimeMs: number;
}

/** Os `.xctestrun` que o `build-for-testing` deixou em `products`, com a configuração de cada um. */
export function listBuiltXctestruns(products: string): BuiltXctestrun[] {
  let names: string[];
  try {
    names = readdirSync(products).filter((name) => name.endsWith('.xctestrun'));
  } catch {
    return [];
  }
  const found: BuiltXctestrun[] = [];
  for (const name of names.sort()) {
    const path = join(products, name);
    try {
      const doc = parseXctestrun(readFileSync(path, 'utf8'));
      const configuration = xctestrunConfiguration(doc);
      if (configuration !== undefined) found.push({ path, configuration, doc, mtimeMs: statSync(path).mtimeMs });
    } catch {
      // um .xctestrun ilegível não é candidato
    }
  }
  return found;
}

/**
 * O `.xctestrun` gerado da configuração pedida; `undefined` só se não houver nenhum. O nome leva a versão
 * do SDK (`…_iphoneos26.5-arm64.xctestrun`) e o `build-for-testing` não apaga os de outros SDKs: entre
 * vários, vale o mais novo (pela data de modificação; empate → o maior nome), o do último build.
 */
export function findBuiltXctestrun(products: string, configuration: string): BuiltXctestrun | undefined {
  const matches = listBuiltXctestruns(products).filter((built) => built.configuration === configuration);
  matches.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.path < b.path ? 1 : a.path > b.path ? -1 : 0));
  return matches[0];
}
