// Conexão `control` dos comandos de exploração (S2 item 3: a CLI e o MCP abrem `control` por comando —
// hello → chamada → fecha). Dentro de um processo os comandos vão em fila: o runner aceita um controlador
// por vez, e o Claude Code pode chamar várias ferramentas ao mesmo tempo. Como o aparelho só solta a vaga
// quando vê o fechamento da conexão anterior (o que pode chegar depois do nosso `close()`), um `E_BUSY` do
// próprio runner no `session.hello` (sem `takeId`: não é a trava de uma tomada) é tentado de novo por até
// `BUSY_RETRY_MS`. A trava de tomada (`E_BUSY` com `takeId`) nunca é tentada de novo.

import type { z } from 'zod';

import { ContrarregraError, isContrarregraError } from '../core/errors.ts';
import { validate } from '../core/schema.ts';
import { openRunner, type RunnerConnection } from '../runner/client.ts';
import type { CommandContext } from './context.ts';

/** Por quanto tempo um `E_BUSY` do runner no `session.hello` é tentado de novo. */
export const BUSY_RETRY_MS = 1_500;
const BUSY_POLL_MS = 50;

let queue: Promise<unknown> = Promise.resolve();

function busyAtHello(error: unknown): boolean {
  return isContrarregraError(error, 'E_BUSY') && error.data?.['takeId'] === undefined;
}

async function openControl(ctx: CommandContext): Promise<RunnerConnection> {
  const deadline = Date.now() + BUSY_RETRY_MS;
  for (;;) {
    try {
      return await openRunner(ctx.config, { role: 'control' });
    } catch (error) {
      if (!busyAtHello(error) || Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, BUSY_POLL_MS));
    }
  }
}

/** Abre `control`, roda `fn` e fecha sempre; um comando por vez neste processo. */
export function withControl<T>(ctx: CommandContext, fn: (connection: RunnerConnection) => Promise<T>): Promise<T> {
  const run = queue.then(async () => {
    const connection = await openControl(ctx);
    try {
      return await fn(connection);
    } finally {
      await connection.close();
    }
  });
  queue = run.catch(() => undefined);
  return run;
}

/** A resposta do runner conferida contra a forma de S0.5/S1; fora dela → `E_RUNNER_DOWN` (runner de outra versão). */
export function checked<T>(method: string, schema: z.ZodType<T>, value: unknown): T {
  const result = validate(schema, value);
  if (result.ok) return result.value;
  throw new ContrarregraError('E_RUNNER_DOWN', `a resposta do ${method} não segue S0.5/S1: o runner instalado é de outra versão?`, {
    reason: 'protocol-mismatch',
    method,
    errors: result.errors,
    hint: 'contrarregra runner build && contrarregra runner up',
  });
}
