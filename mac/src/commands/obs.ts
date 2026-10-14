// Operações do OBS (S9; S8: CLI `obs setup`, só na CLI). Uma função por operação; a lógica está em
// `mac/src/obs`. Por ora só `obs setup` (T-0.13); `obs status|start|stop|chapter` entram com as tarefas
// deles.

import { join } from 'node:path';

import type { Secret } from '../core/secret.ts';
import { ObsClient, obsClientOptions, type ObsClientOptionsFromConfig } from '../obs/client.ts';
import {
  defaultObsBasicDir,
  obsProcessRunning,
  obsProcessStartedAt,
  openObs,
  setupObs,
  setupTarget,
  type ObsSetupOptions,
  type ObsSetupResult,
} from '../obs/setup.ts';
import { ObsSocket } from '../obs/ws.ts';
import { expandHome } from '../runner/paths.ts';
import type { CommandContext } from './context.ts';

export type { ObsSetupChange, ObsSetupResult } from '../obs/setup.ts';
export { obsLaunchCommand, restartHint } from '../obs/setup.ts';

/** Só para testes: o OBS falso não é um processo, a senha não vem do Chaveiro real e a pasta do OBS é temporária. */
export interface ObsCommandDeps {
  readPassword?: (name: string) => Promise<Secret>;
  isObsRunning?: () => Promise<boolean>;
  /** Início (epoch ms) do processo do OBS em execução; `null` sem processo ou desconhecido. */
  obsStartedAt?: () => Promise<number | null>;
  launchObs?: (args: string[]) => Promise<void>;
  /** Padrão: `~/Library/Application Support/obs-studio/basic`. */
  obsBasicDir?: string;
  launchTimeoutMs?: number;
  launchRetryMs?: number;
  profileSwitchTimeoutMs?: number;
}

/** Onde fica o marcador do reinício pendente do `obs setup`: `<paths.cache>/obs/restart-pending` (A4). */
export function restartMarkerPath(ctx: CommandContext): string {
  return join(expandHome(ctx.config.paths.cache), 'obs', 'restart-pending');
}

/** `obs setup` (S9 item 1; com o dono presente, G5): cria ou reconcilia o perfil e a coleção da ferramenta. */
export function obsSetup(ctx: CommandContext, deps: ObsCommandDeps = {}): Promise<ObsSetupResult> {
  const fromConfig: ObsClientOptionsFromConfig = {};
  if (deps.readPassword !== undefined) fromConfig.readPassword = deps.readPassword;
  if (ctx.onProgress !== undefined) fromConfig.log = ctx.onProgress;
  const options = obsClientOptions(ctx.config, fromConfig);
  const setup: ObsSetupOptions = {
    target: setupTarget(ctx.config),
    connectClient: () => ObsClient.connect(options),
    connectSocket: () => ObsSocket.connect(options),
    isObsRunning: deps.isObsRunning ?? obsProcessRunning,
    obsStartedAt: deps.obsStartedAt ?? obsProcessStartedAt,
    launchObs: deps.launchObs ?? openObs,
    obsBasicDir: deps.obsBasicDir ?? defaultObsBasicDir(),
    restartMarkerPath: restartMarkerPath(ctx),
  };
  if (deps.launchTimeoutMs !== undefined) setup.launchTimeoutMs = deps.launchTimeoutMs;
  if (deps.launchRetryMs !== undefined) setup.launchRetryMs = deps.launchRetryMs;
  if (deps.profileSwitchTimeoutMs !== undefined) setup.profileSwitchTimeoutMs = deps.profileSwitchTimeoutMs;
  if (ctx.onProgress !== undefined) setup.log = ctx.onProgress;
  return setupObs(setup);
}
