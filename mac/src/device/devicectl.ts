// `devicectl` (S2 itens 1 e 5; architecture.md A2: saída JSON em arquivo, nunca por pipe). Só lê: o
// transporte do túnel CoreDevice do aparelho configurado, para o `runner status`
// (`transport: {usb, wired, tunnelState}`) e, adiante, para o PF-03. A forma do JSON é a de
// research/transport.md F9: `result.devices[].connectionProperties.{transportType, tunnelState}`, com o
// aparelho achado por `hardwareProperties.udid` (normalizado) ou pelo `identifier` do CoreDevice.

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

/** Onde o `xcrun` do sistema mora (nunca pelo PATH). */
export const XCRUN_PATH = '/usr/bin/xcrun';
/** Prazo do `devicectl list devices` (o CoreDevice pode demorar a responder com o túnel frio). */
export const DEVICECTL_TIMEOUT_MS = 10_000;

export interface DeviceTransport {
  /** `wired` | `localNetwork` | … como o `devicectl` informou; `null` se o campo faltar. */
  transportType: string | null;
  /** `connected` | `disconnected` | `unavailable`; `null` se o campo faltar. */
  tunnelState: string | null;
}

export interface DeviceIds {
  /** `device.udid` da configuração. */
  udid: string;
  /** `device.coreDeviceId` da configuração. */
  coreDeviceId: string;
}

type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalize(id: string): string {
  return id.replace(/-/g, '').toUpperCase();
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** O transporte do aparelho configurado no JSON de `devicectl list devices`; `undefined` se não estiver na lista. */
export function parseDevicectlList(json: unknown, ids: DeviceIds): DeviceTransport | undefined {
  const result = isJsonObject(json) ? json['result'] : undefined;
  const devices = isJsonObject(result) ? result['devices'] : undefined;
  if (!Array.isArray(devices)) return undefined;
  const udid = normalize(ids.udid);
  const coreDeviceId = ids.coreDeviceId.toUpperCase();
  for (const device of devices) {
    if (!isJsonObject(device)) continue;
    const hardware = device['hardwareProperties'];
    const deviceUdid = isJsonObject(hardware) ? hardware['udid'] : undefined;
    const identifier = device['identifier'];
    const mine =
      (typeof deviceUdid === 'string' && normalize(deviceUdid) === udid) ||
      (typeof identifier === 'string' && identifier.toUpperCase() === coreDeviceId);
    if (!mine) continue;
    const connection = device['connectionProperties'];
    return {
      transportType: isJsonObject(connection) ? stringOrNull(connection['transportType']) : null,
      tunnelState: isJsonObject(connection) ? stringOrNull(connection['tunnelState']) : null,
    };
  }
  return undefined;
}

export interface ReadTransportOptions extends DeviceIds {
  /** Pasta onde o JSON é escrito (e apagado depois de lido): `paths.cache`. */
  outDir: string;
  /** Padrão: `XCRUN_PATH`. */
  xcrun?: string;
  timeoutMs?: number;
}

/**
 * Roda `xcrun devicectl list devices --json-output <arquivo>` (saída padrão e de erro descartadas) e lê
 * o transporte do aparelho. `undefined` quando o `devicectl` falha, estoura o prazo ou não lista o
 * aparelho: quem chama mostra o campo como desconhecido, sem falhar o comando.
 */
export async function readDeviceTransport(options: ReadTransportOptions): Promise<DeviceTransport | undefined> {
  const xcrun = options.xcrun ?? XCRUN_PATH;
  const timeoutMs = options.timeoutMs ?? DEVICECTL_TIMEOUT_MS;
  mkdirSync(options.outDir, { recursive: true });
  const out = join(options.outDir, `devicectl-${process.pid}-${randomBytes(4).toString('hex')}.json`);
  try {
    const ok = await new Promise<boolean>((resolve) => {
      const child = spawn(xcrun, ['devicectl', 'list', 'devices', '--json-output', out], { stdio: 'ignore' });
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve(false);
      }, timeoutMs);
      child.once('error', () => {
        clearTimeout(timer);
        resolve(false);
      });
      child.once('exit', (code) => {
        clearTimeout(timer);
        resolve(code === 0);
      });
    });
    if (!ok) return undefined;
    return parseDevicectlList(JSON.parse(readFileSync(out, 'utf8')), options);
  } catch {
    return undefined;
  } finally {
    rmSync(out, { force: true });
  }
}
