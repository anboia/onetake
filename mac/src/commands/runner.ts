// Operações `runner build|up|down|status|sever` (S2; S8: CLI `runner …`, MCP `runner_up`, `runner_down`,
// `runner_status`). Uma função por operação; a lógica está em `mac/src/runner`.

import {
  buildRunner,
  downRunner,
  runnerStatus as readRunnerStatus,
  severRunner,
  upRunner,
  type BuildResult,
  type DownResult,
  type LifecycleOptions,
  type RunnerStatus,
  type SeverResult,
  type UpResult,
} from '../runner/lifecycle.ts';
import { BIND_VALUES, DEFAULT_CONFIGURATION, SPIKE_CONFIGURATION, type BindMode } from '../runner/xctestrun.ts';
import type { CommandContext } from './context.ts';

export type { BuildResult, DownResult, RunnerStatus, SeverResult, UpResult } from '../runner/lifecycle.ts';
export type { BindMode } from '../runner/xctestrun.ts';
export const RUNNER_CONFIGURATIONS = [DEFAULT_CONFIGURATION, SPIKE_CONFIGURATION] as const;
export const RUNNER_BIND_MODES = BIND_VALUES;

function lifecycle(ctx: CommandContext): LifecycleOptions {
  const options: LifecycleOptions = {};
  if (ctx.tools !== undefined) options.tools = ctx.tools;
  if (ctx.onProgress !== undefined) options.onProgress = ctx.onProgress;
  return options;
}

/** `runner build [--configuration Spike]`. */
export function runnerBuild(ctx: CommandContext, args: { configuration?: string } = {}): Promise<BuildResult> {
  return buildRunner(ctx.config, { ...lifecycle(ctx), ...(args.configuration === undefined ? {} : { configuration: args.configuration }) });
}

/** `runner up [--spike [--bind loopback|endpoint]]`. */
export function runnerUp(ctx: CommandContext, args: { spike?: boolean; bind?: BindMode } = {}): Promise<UpResult> {
  return upRunner(ctx.config, {
    ...lifecycle(ctx),
    ...(args.spike === undefined ? {} : { spike: args.spike }),
    ...(args.bind === undefined ? {} : { bind: args.bind }),
  });
}

/** `runner down`. */
export function runnerDown(ctx: CommandContext): Promise<DownResult> {
  return downRunner(ctx.config, lifecycle(ctx));
}

/** `runner status`. */
export function runnerStatus(ctx: CommandContext): Promise<RunnerStatus> {
  return readRunnerStatus(ctx.config, lifecycle(ctx));
}

/** `runner sever --for <s>` (S2 item 8; gancho de teste). */
export function runnerSever(ctx: CommandContext, args: { forS: number }): SeverResult {
  return severRunner(ctx.config, args);
}
