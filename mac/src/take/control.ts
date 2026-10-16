// Comando do dono para a tomada pausada (trilha do demo): `take control <takeDir> resume|retry|skip|abort`
// grava `<takeDir>/control.json {op, at}` (arquivo novo + rename, nunca meio escrito); o executor sonda o
// arquivo enquanto está pausado (e, a cada passo, só o `abort`), apaga-o depois de ler e age. É o
// `command.json` de S8 item 5 sem supervisor destacado: a tomada roda no próprio processo da CLI.

import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** O arquivo do comando na pasta da tomada. */
export const CONTROL_FILE = 'control.json';

/**
 * `resume` = segue como se o passo tivesse dado certo; `retry` = refaz o passo; `skip` = pula o passo
 * (fica `skipped`); `abort` = encerra a tomada (gravação parada e finalizada).
 */
export const CONTROL_OPS = ['resume', 'retry', 'skip', 'abort'] as const;
export type ControlOp = (typeof CONTROL_OPS)[number];

export function isControlOp(value: unknown): value is ControlOp {
  return typeof value === 'string' && (CONTROL_OPS as readonly string[]).includes(value);
}

export function controlPath(dir: string): string {
  return join(dir, CONTROL_FILE);
}

/** Grava o comando (troca o anterior, se houver). */
export function writeControl(dir: string, op: ControlOp, at: Date = new Date()): string {
  const path = controlPath(dir);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ op, at: at.toISOString() })}\n`);
  renameSync(tmp, path);
  return path;
}

/** O comando pendente; arquivo ausente, ilegível ou com `op` desconhecido → `undefined`. */
export function readControl(dir: string): ControlOp | undefined {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(controlPath(dir), 'utf8'));
  } catch {
    return undefined;
  }
  const op = typeof value === 'object' && value !== null ? (value as Record<string, unknown>)['op'] : undefined;
  return isControlOp(op) ? op : undefined;
}

export function clearControl(dir: string): void {
  rmSync(controlPath(dir), { force: true });
}
