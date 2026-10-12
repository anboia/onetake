// Operações `tree` e `tap` (S8: CLI `tree`, `tap`; MCP `ui_tree`, `tap`). A árvore vem do runner já no
// formato pedido — `compact` (padrão, S0.6: uma linha por nó visível) ou `json` (nós de S0.6) —; o toque
// manda o `Target` de S0.2 a `ui.tap` e devolve a resposta de ação de S0.5. Cada uma abre `control` só para
// si (S2 item 3). A árvore nunca é pedida do SpringBoard nem da folha `authkit` (S1 item 11, P-3).

import { z } from 'zod';

import { ContrarregraError } from '../core/errors.ts';
import { parseTarget, TargetSchema, TreeNodeSchema, UiActionResultSchema } from '../core/schema.ts';
import type { Target, TreeNode, UiActionResult } from '../core/types.ts';
import { parseArgs, type CommandContext } from './context.ts';
import { checked, withControl } from './explore.ts';

export { TargetSchema };
export type { Target, TreeNode, UiActionResult };

export const TREE_FORMATS = ['compact', 'json'] as const;
export type TreeFormat = (typeof TREE_FORMATS)[number];

export interface TreeArgs {
  /** S0.2 `app`: `target` (padrão: o app alvo) ou um bundle id de `apps.allowed`. */
  app?: string;
  /** Padrão: `compact`. */
  format?: TreeFormat;
}

/** Forma dos argumentos de `ui_tree` (S8 item 2: `{app?, format?}`). */
export const TreeArgsSchema = z.strictObject({
  app: z.string().min(1).optional().describe('"target" (padrão: o app alvo) ou o bundle id de um app de apps.allowed'),
  format: z.enum(TREE_FORMATS).optional().describe('compact (padrão) ou json'),
});

/** Forma dos argumentos de `tap` (S8 item 2: `{target}`, o `Target` de S0.2). */
export const TapArgsSchema = z.strictObject({ target: TargetSchema.describe('Target de S0.2: exatamente um seletor primário') });

export function parseTreeArgs(value: unknown): TreeArgs {
  return parseArgs(TreeArgsSchema, value, 'ui_tree');
}

export function parseTapArgs(value: unknown): { target: Target } {
  return parseArgs(TapArgsSchema, value, 'tap');
}

/**
 * `app` cuja árvore nunca sai do aparelho (S1 item 11, P-3): o SpringBoard (`springboard`, `controlcenter`,
 * `com.apple.springboard`) e a folha do Sign in with Apple (`authkit`, `com.apple.AuthKitUIService`), que
 * mostra nome e e-mail da conta Apple. O runner também recusa; aqui a recusa vem antes de abrir conexão.
 */
const TREE_FORBIDDEN_APPS = new Set(['springboard', 'controlcenter', 'com.apple.springboard', 'authkit', 'com.apple.authkituiservice']);

function assertTreeAllowed(app: string | undefined): void {
  if (app === undefined || !TREE_FORBIDDEN_APPS.has(app.toLowerCase())) return;
  throw new ContrarregraError(
    'E_FORBIDDEN_APP',
    `ui.tree de ${app} recusado: a árvore só sai do app alvo ou de um app permitido, nunca do SpringBoard nem da folha do Sign in with Apple (S1 item 11)`,
    { app },
  );
}

export type TreeResult = { treeVersion: number; format: 'compact'; nodes: string[] } | { treeVersion: number; format: 'json'; nodes: TreeNode[] };

const TreeVersion = z.number().int().min(0);
const CompactTreeSchema = z.strictObject({ treeVersion: TreeVersion, nodes: z.array(z.string()) });
const JsonTreeSchema = z.strictObject({ treeVersion: TreeVersion, nodes: z.array(TreeNodeSchema) });

/** `tree`: só nós visíveis (S8 item 4). */
export async function uiTree(ctx: CommandContext, args: TreeArgs = {}): Promise<TreeResult> {
  assertTreeAllowed(args.app);
  const format = args.format ?? 'compact';
  const params: Record<string, unknown> = { format, visibleOnly: true };
  if (args.app !== undefined) params['app'] = args.app;
  return withControl(ctx, async (connection) => {
    const result: unknown = await connection.call('ui.tree', params);
    if (format === 'json') return { format, ...checked('ui.tree', JsonTreeSchema, result) };
    return { format, ...checked('ui.tree', CompactTreeSchema, result) };
  });
}

/** `tap {target}`: o alvo é conferido (um seletor primário, AC-0.3) antes de falar com o runner. */
export function tap(ctx: CommandContext, args: { target: unknown }): Promise<UiActionResult> {
  const target = parseTarget(args.target);
  return withControl(ctx, async (connection) => checked('ui.tap', UiActionResultSchema, await connection.call('ui.tap', { target })));
}
