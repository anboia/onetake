// Configuração: `~/.config/onetake/config.json` da máquina (com fallback legado), sem segredos, mesclado
// sobre `config/defaults.json` do repositório. Só lê arquivos: nenhum processo filho, nenhuma conexão.

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ContrarregraError } from './errors.ts';

/** Identificador de equipe Apple: dez caracteres alfanuméricos maiúsculos. */
export const APPLE_TEAM = /^[A-Z0-9]{10}$/;
export const APPLE_DEVELOPMENT_IDENTITY = /^Apple Development: .+ \([A-Z0-9]{10}\)$/;

export const DEFAULTS_PATH = fileURLToPath(new URL('../../../config/defaults.json', import.meta.url));

export function defaultConfigPath(): string {
  const modern = join(homedir(), '.config', 'onetake', 'config.json');
  const legacy = join(homedir(), '.config', 'contrarregra', 'config.json');
  return existsSync(modern) || !existsSync(legacy) ? modern : legacy;
}

/** Campos de S0.1. Os opcionais (`?`) ficam vazios nos padrões e só existem no `config.json` da máquina. */
export interface Config {
  device: { udid: string; coreDeviceId: string; name: string };
  signing: { team: string; identity: string; ascKeyPath?: string };
  bundle: { host: string; runnerTest: string; displayNames: string[] };
  runner: { port: number; privateAllowed: string[] };
  usbmux: { socketPath: string };
  app: { explore?: string };
  apps: { allowed: string[] };
  urls: { allowedPrefixes: string[] };
  paths: { takes: string; cache: string; ffmpeg: string; ffprobe: string };
  obs: { url: string; profile: string; collection: string; scene: string; source: string; flashSource: string };
  /** Só **nomes** de itens do Chaveiro (serviço `contrarregra`), nunca o segredo. */
  secrets: { obsPassword: string };
  alerts: { sayDevice: string; voice: string };
  guide: { voice: string; targetWpm: number; sentenceGapMs: number; padBeforeMs: number; padAfterMs: number };
  disk: { minFreeGiB: number; criticalGiB: number };
  record: { fps: number; bitrateKbps: number };
  sync: { captureLatencyMs?: number };
  /** O conjunto de ferramentas em que os spikes passaram; o iOS validado vem do `config.json` da máquina. */
  toolchain: { validated: Record<string, string> };
}

export interface LoadConfigOptions {
  /** Padrão: `~/.config/onetake/config.json`; se ausente, arquivo legado `contrarregra`. */
  configPath?: string;
  /** Padrão: `config/defaults.json` do repositório. */
  defaultsPath?: string;
}

type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Mescla recursiva de S0.1: objetos chave a chave; listas e valores simples de `override` substituem
 * os de `base`. Monta objetos novos por `Object.fromEntries`, então uma chave `"__proto__"` vinda do
 * JSON vira propriedade comum e não troca o protótipo.
 */
export function mergeConfig(base: unknown, override: unknown): unknown {
  if (!isJsonObject(base) || !isJsonObject(override)) return override;
  const merged = new Map<string, unknown>(Object.entries(base));
  for (const [key, value] of Object.entries(override)) {
    merged.set(key, merged.has(key) ? mergeConfig(merged.get(key), value) : value);
  }
  return Object.fromEntries(merged);
}

function readJsonObject(path: string, required: boolean): JsonObject | undefined {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' && !required) return undefined;
    throw new ContrarregraError('E_CONFIG', `não consegui ler ${path} (${code ?? String(error)})`, { path }, { cause: error });
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new ContrarregraError('E_CONFIG', `JSON inválido em ${path}: ${(error as Error).message}`, { path }, { cause: error });
  }
  if (!isJsonObject(value)) {
    throw new ContrarregraError('E_CONFIG', `${path} precisa conter um objeto JSON`, { path });
  }
  return value;
}

/**
 * Carrega a configuração mesclada. Sem `config.json` na máquina, valem só os padrões.
 * Valores parciais/ausentes permitem inspeção local; buildRunner valida os requisitos de assinatura.
 */
export function loadConfig(options: LoadConfigOptions = {}): Config {
  const defaultsPath = options.defaultsPath ?? DEFAULTS_PATH;
  const configPath = options.configPath ?? defaultConfigPath();
  const defaults = readJsonObject(defaultsPath, true) ?? {};
  const machine = readJsonObject(configPath, false) ?? {};
  const merged = mergeConfig(defaults, machine) as JsonObject;

  const signing = merged['signing'];
  const team = isJsonObject(signing) ? signing['team'] : undefined;
  if (typeof team !== 'string' || (team !== '' && !APPLE_TEAM.test(team))) {
    const source = 'signing' in machine ? configPath : defaultsPath;
    throw new ContrarregraError(
      'E_CONFIG',
      `signing.team = ${JSON.stringify(team ?? null)} em ${source}: use um Apple Team ID de dez caracteres A-Z/0-9`,
      { field: 'signing.team', value: team ?? null, path: source },
    );
  }
  return merged as unknown as Config;
}
