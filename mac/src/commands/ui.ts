// Operações `tree` e `tap` (S8: CLI `tree`, `tap`; MCP `ui_tree`, `tap`). A árvore vem do runner já no
// formato pedido — `compact` (padrão, S0.6: uma linha por nó visível) ou `json` (nós de S0.6) —; o toque
// manda o `Target` de S0.2 a `ui.tap` e devolve a resposta de ação de S0.5. Cada uma abre `control` só para
// si (S2 item 3).

import { z } from 'zod';

import { parseTarget, TargetSchema, TreeNodeSchema, UiActionResultSchema } from '../core/schema.ts';
import type { Target, TreeNode, UiActionResult } from '../core/types.ts';
import type { CommandContext } from './context.ts';
import { checked, withControl } from './explore.ts';

export { TargetSchema };
export type { Target, TreeNode, UiActionResult };

export const TREE_FORMATS = ['compact', 'json'] as const;
export type TreeFormat = (typeof TREE_FORMATS)[number];

export interface TreeArgs {
  /** S0.2 `app` (`target`, `springboard`, …, ou um bundle id de `apps.allowed`); padrão: o app em primeiro plano. */
  app?: string;
  /** Padrão: `compact`. */
  format?: TreeFormat;
}

export type TreeResult = { treeVersion: number; format: 'compact'; nodes: string[] } | { treeVersion: number; format: 'json'; nodes: TreeNode[] };

const TreeVersion = z.number().int().min(0);
const CompactTreeSchema = z.strictObject({ treeVersion: TreeVersion, nodes: z.array(z.string()) });
const JsonTreeSchema = z.strictObject({ treeVersion: TreeVersion, nodes: z.array(TreeNodeSchema) });

/** `tree`: só nós visíveis (S8 item 4). */
export function uiTree(ctx: CommandContext, args: TreeArgs = {}): Promise<TreeResult> {
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
