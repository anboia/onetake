// Servidor MCP stdio `contrarregra` para o Claude Code (S8 itens 1 e 7): chamado pelo shim
// `bin/contrarregra-mcp`, que já escolheu o Node 22.x ≥ 22.18 (E-8.1). A saída padrão é o canal do
// protocolo: nada de `console.log`; avisos vão para a saída de erro. O fim da entrada padrão (o Claude Code
// fechou) encerra o servidor.

import { serveStdio } from '@modelcontextprotocol/server/stdio';

import { createContrarregraServer } from './server.ts';

process.stderr.write(`onetake-mcp: Node ${process.version} em ${process.execPath}\n`);

const handle = serveStdio(() => createContrarregraServer(), {
  onerror: (error) => process.stderr.write(`onetake-mcp: ${error.message}\n`),
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void handle.close().finally(() => process.exit(0));
  });
}
