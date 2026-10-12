// Repassador local (S2 item 2; P-3): escuta só em `127.0.0.1`, numa porta efêmera, e liga cada conexão
// local (o cliente WebSocket nativo do Node) a um túnel usbmux novo até a porta do runner no aparelho.
// O túnel é aberto por conexão — a alça `DeviceID` muda quando o cabo é religado.

import { createServer, type AddressInfo, type Socket } from 'node:net';

import { ContrarregraError, isContrarregraError } from '../core/errors.ts';
import { openTunnel, type UsbmuxOptions } from './client.ts';
import { htons } from './protocol.ts';

/** O único endereço em que o repassador escuta (P-3, P-7). */
export const LOOPBACK = '127.0.0.1';

export interface ForwarderOptions extends UsbmuxOptions {
  /** `device.udid` da configuração. */
  udid: string;
  /** Porta do runner no loopback do aparelho (`runner.port`). */
  port: number;
  /** Falha ao abrir o túnel de uma conexão local (`E_NO_USB`, `E_RUNNER_DOWN`); a conexão local é fechada. */
  onTunnelError?: (error: ContrarregraError) => void;
}

export interface Forwarder {
  /** O endereço em que o servidor ficou de fato ligado (`server.address()`): `127.0.0.1`. */
  readonly host: string;
  /** A porta efêmera que o sistema escolheu. */
  readonly port: number;
  /** `server.address()` logo depois do `listen`, para conferência (P-3). */
  readonly address: AddressInfo;
  /** Para de escutar e fecha toda conexão aberta (local e túnel). Idempotente. */
  close(): Promise<void>;
}

export async function startForwarder(options: ForwarderOptions): Promise<Forwarder> {
  htons(options.port); // porta inválida falha aqui, não a cada conexão
  const sockets = new Set<Socket>();
  let closing = false;
  const track = (socket: Socket): void => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  };

  // `allowHalfOpen` nos dois lados (o túnel já vem assim do `connectDevice`): o FIN de um sentido vira
  // `end()` no par pelo `pipe`, que só manda o FIN depois de esvaziar o que falta escrever; cada socket
  // fecha sozinho quando os dois sentidos terminaram. Só um erro derruba o par de uma vez.
  const server = createServer({ pauseOnConnect: true, allowHalfOpen: true }, (local) => {
    track(local);
    local.on('error', () => local.destroy());
    openTunnel(options).then(
      ({ socket: tunnel }) => {
        track(tunnel);
        const teardown = (): void => {
          local.destroy();
          tunnel.destroy();
        };
        tunnel.on('error', teardown);
        if (closing || local.destroyed) {
          teardown();
          return;
        }
        local.on('error', teardown);
        local.pipe(tunnel);
        tunnel.pipe(local);
      },
      (error: unknown) => {
        local.destroy();
        options.onTunnelError?.(
          isContrarregraError(error)
            ? error
            : new ContrarregraError('E_NO_USB', `falha ao abrir o túnel usbmux: ${String(error)}`, { reason: 'usbmuxd-protocol' }, { cause: error }),
        );
      },
    );
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: LOOPBACK, port: 0, exclusive: true }, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = { ...(server.address() as AddressInfo) };

  let closed: Promise<void> | undefined;
  return {
    host: address.address,
    port: address.port,
    address,
    close(): Promise<void> {
      closed ??= new Promise<void>((resolve) => {
        closing = true;
        server.close(() => resolve());
        for (const socket of sockets) socket.destroy();
      });
      return closed;
    },
  };
}
