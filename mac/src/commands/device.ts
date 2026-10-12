// Operação `device status` (S8: CLI `device status`, MCP `device_status`): o `device.state` do runner
// (S1 itens 4 e 10) pela conexão `control` aberta só para este comando.

import { z } from 'zod';

import type { CommandContext } from './context.ts';
import { checked, withControl } from './explore.ts';

/** `device.state` → `{locked, network, foregroundApp, language, screenPt, textSize, appearance}` (S1 item 4). */
export interface DeviceState {
  locked: boolean;
  /** S0.3 `{network: online|offline}`. */
  network: 'online' | 'offline';
  foregroundApp: string;
  language: string;
  screenPt: { w: number; h: number };
  textSize: string;
  appearance: 'light' | 'dark';
}

// Espelho local enquanto `core/schema.ts` não tem os métodos de S1 item 4 (só os de base de S0.5).
const DeviceStateSchema: z.ZodType<DeviceState> = z.strictObject({
  locked: z.boolean(),
  network: z.enum(['online', 'offline']),
  foregroundApp: z.string(),
  language: z.string(),
  screenPt: z.strictObject({ w: z.number().positive(), h: z.number().positive() }),
  textSize: z.string(),
  appearance: z.enum(['light', 'dark']),
});

/** `device status`. */
export function deviceStatus(ctx: CommandContext): Promise<DeviceState> {
  return withControl(ctx, async (connection) => checked('device.state', DeviceStateSchema, await connection.call('device.state', {})));
}
