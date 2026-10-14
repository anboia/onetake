// Onde o runner guarda o que é dele (architecture.md A4): quase tudo em `paths.cache`, fora do repositório —
// DerivedData, `sessions/*.xctestrun` (0600, com o token; apagados no `runner down` e na próxima subida),
// o estado de cada sessão, `locks/<udid>.lock` e os registros. A exceção é a linha de base da assinatura
// (A9), que mora ao lado do `config.json` da máquina: o macOS apaga o cache inteiro com disco baixo, e ela
// não pode sumir junto (o `runner build` seguinte a recriaria em silêncio).

import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defaultConfigPath, type Config } from '../core/config.ts';

/** Raiz do repositório (onde estão `ios/project.yml` e o projeto gerado). */
export const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/** `~` e `~/…` → pasta do usuário (os caminhos de S0.1 vêm assim). */
export function expandHome(path: string): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return join(homedir(), path.slice(2));
  return path;
}

export interface RunnerPaths {
  cache: string;
  /** `-derivedDataPath` do build (D3.3). */
  derivedData: string;
  /** Onde o `xcodebuild build-for-testing` deixa o `.xctestrun` gerado e os produtos. */
  products: string;
  /** `.xctestrun` e estado das sessões (pasta 0700). */
  sessions: string;
  locks: string;
  /** Trava do aparelho: existe enquanto um supervisor de tomada segura `control` (S2 item 3). */
  lockFile: string;
  logs: string;
  /** `paths.takes`: pastas das tomadas (`<app>/<takeId>/`, S0.8). */
  takes: string;
  /** A pasta do `config.json` da máquina (`~/.config/contrarregra/`): onde mora a linha de base da assinatura (A9). */
  configDir: string;
}

/** A pasta do `config.json` da máquina (`~/.config/contrarregra/`). */
export function defaultConfigDir(): string {
  return dirname(defaultConfigPath());
}

/** `configDir`: a pasta da configuração da máquina (padrão: a de `defaultConfigPath()`; os testes passam uma temporária). */
export function runnerPaths(config: Config, configDir: string = defaultConfigDir()): RunnerPaths {
  const cache = expandHome(config.paths.cache);
  const derivedData = join(cache, 'DerivedData');
  const locks = join(cache, 'locks');
  return {
    cache,
    derivedData,
    products: join(derivedData, 'Build', 'Products'),
    sessions: join(cache, 'sessions'),
    locks,
    lockFile: join(locks, `${config.device.udid}.lock`),
    logs: join(cache, 'logs'),
    takes: expandHome(config.paths.takes),
    configDir,
  };
}
