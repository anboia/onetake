// Operação `doctor` (S8: CLI `doctor`, MCP ★`doctor`), versão mínima da Fase 0: diagnóstico que nunca
// lança e não muda nada. Checa o Node (a parte de Node do PF-01), a configuração (S0.1), o cabo (PF-02:
// usbmuxd lista o UDID como `USB`), o túnel do `devicectl` (a parte `transportType = wired` /
// `tunnelState = connected` do PF-03) e o runner (a parte de PF-04: responde ao `session.hello`), tudo
// pelo `runner status`. Uma falha cedo marca as checagens seguintes como puladas. O `doctor` completo
// (cada falha do pré-voo, batimento das tomadas) vem nas Fases 1 e 4.

import { isContrarregraError } from '../core/errors.ts';
import { loadContext, type CommandContext, type ContextOptions } from './context.ts';
import { runnerStatus } from './runner.ts';

export interface DoctorCheck {
  /** `node`, `config` ou o id do pré-voo (S12) de que a checagem é parte. */
  id: string;
  ok: boolean;
  detail: string;
  /** Código de S0.5 quando a checagem falhou por um erro da ferramenta. */
  code?: string;
}

export interface DoctorResult {
  ok: boolean;
  node: { version: string; execPath: string };
  checks: DoctorCheck[];
}

/** Node 22.x ≥ 22.18 (P-1; o shim já recusa outras versões, E-8.1). */
export function supportedNode(version: string): boolean {
  const match = /^v22\.(\d+)\.\d+/.exec(version);
  return match !== null && Number(match[1]) >= 18;
}

function failure(id: string, error: unknown): DoctorCheck {
  const check: DoctorCheck = { id, ok: false, detail: error instanceof Error ? error.message : String(error) };
  if (isContrarregraError(error)) check.code = error.code;
  return check;
}

const skipped = (id: string, why: string): DoctorCheck => ({ id, ok: false, detail: `pulada: ${why}` });

/** `doctor`. Recebe as opções do contexto (e não o contexto pronto) porque a própria configuração é checada. */
export async function doctor(options: ContextOptions = {}): Promise<DoctorResult> {
  const node = { version: process.version, execPath: process.execPath };
  const checks: DoctorCheck[] = [];
  const nodeOk = supportedNode(node.version);
  checks.push({
    id: 'node',
    ok: nodeOk,
    detail: nodeOk ? `Node ${node.version} (22.x ≥ 22.18)` : `Node ${node.version}: a Contrarregra precisa de 22.x ≥ 22.18 (nvm install 22)`,
  });

  let ctx: CommandContext;
  try {
    ctx = loadContext(options);
    checks.push({ id: 'config', ok: true, detail: `configuração carregada (aparelho ${ctx.config.device.name}, ${ctx.config.device.udid})` });
  } catch (error) {
    checks.push(failure('config', error), skipped('PF-02', 'sem configuração'), skipped('PF-03', 'sem configuração'), skipped('PF-04', 'sem configuração'));
    return { ok: false, node, checks };
  }

  try {
    const status = await runnerStatus(ctx);
    checks.push({ id: 'PF-02', ok: true, detail: `usbmuxd lista ${ctx.config.device.udid} como USB` });
    const { wired, tunnelState } = status.transport;
    const transportOk = wired === true && tunnelState === 'connected';
    checks.push({
      id: 'PF-03',
      ok: transportOk,
      detail:
        wired === null
          ? 'o devicectl não informou o transporte do aparelho'
          : `transportType ${wired ? 'wired' : 'não wired'}, tunnelState ${tunnelState ?? '?'}${transportOk ? '' : ' (a tomada exige wired + connected)'}`,
    });
    const held = status.controlHeldBy === undefined ? '' : `; control com ${status.controlHeldBy}`;
    checks.push({
      id: 'PF-04',
      ok: status.state === 'up',
      detail:
        status.state === 'up'
          ? `runner de pé (sessão ${status.sessionId}${status.rttMs === null ? '' : `, RTT p50 ${status.rttMs.p50} ms`}${held})`
          : `runner ${status.state}${status.sessionId === null ? '' : ` (sessão ${status.sessionId})`}: rode \`contrarregra runner up\`${held}`,
    });
  } catch (error) {
    checks.push(failure('PF-02', error), skipped('PF-03', 'sem o aparelho no usbmuxd'), skipped('PF-04', 'sem o aparelho no usbmuxd'));
  }
  return { ok: checks.every((check) => check.ok), node, checks };
}
