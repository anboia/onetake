// Servidor MCP `contrarregra` (S8 itens 1–4 e 6): só adapta argumentos e saída (architecture.md A2) — a
// lógica está em `mac/src/commands`, a mesma que a CLI chama. A configuração é carregada a cada chamada,
// antes de qualquer processo filho ou conexão (AC-0.5). Erros viram resultado `isError` com
// `{error: {code, message, data}}`, o mesmo objeto da CLI em `--json`; segredo nenhum passa por aqui (P-3).
// Inclusive os de argumento: o SDK confere o `inputSchema` antes do handler e, se falhar, responde só o
// texto dele ("Input validation error: …"); por isso o `inputSchema` aqui só anuncia a forma (o JSON Schema
// dos esquemas de `commands`, para o modelo ver) e aceita qualquer objeto, e a conferência estrita é a do
// comando (`E_CHOREO_INVALID` com `data.errors`).
// Fase 0 (T-0.15): as 5 ★ `doctor`, `device_status`, `screenshot`, `ui_tree` e `tap`; `take_wait` (a 6ª ★)
// e as demais ferramentas de S8 item 2 entram com as tarefas delas.

import { readFileSync } from 'node:fs';

import { fromJsonSchema, McpServer, type CallToolResult, type JsonSchemaType, type JsonSchemaValidator, type jsonSchemaValidator } from '@modelcontextprotocol/server';
import { z } from 'zod';

import { errorObject, loadContext, NoArgsSchema, parseArgs, type ContextOptions } from '../commands/context.ts';
import { deviceStatus } from '../commands/device.ts';
import { doctor } from '../commands/doctor.ts';
import { screenshot } from '../commands/screenshot.ts';
import { parseTapArgs, parseTreeArgs, tap, TapArgsSchema, TreeArgsSchema, uiTree } from '../commands/ui.ts';

export const SERVER_NAME = 'contrarregra';
const PACKAGE = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')) as { version: string };

/** As ★ de S8 item 2 presentes nesta fase: `_meta['anthropic/alwaysLoad'] = true` (AC-8.1). */
export const STARRED_TOOLS = ['doctor', 'device_status', 'screenshot', 'ui_tree', 'tap'] as const;

/** Instruções do servidor (S8 item 6: ≤ 2.048 caracteres, regra principal primeiro). */
export const INSTRUCTIONS = `Contrarregra: opere o iPhone físico (cabo USB, via XCUITest) para gravar demos do app alvo; mesmas operações da CLI \`contrarregra\`.
1. Olhe antes de agir: \`screenshot\` (JPEG 390×844; coordenadas da imagem = pontos do XCUITest) e \`ui_tree\` (uma linha por nó visível, ex.: \`@e12 button "Open settings" (342,52 40x40)\`).
2. Prefira alvos \`{ref: "@eN"}\` da árvore atual e rótulos (\`label\`, \`labelPrefix\`, \`labelContains\`, \`identifier\`) a coordenadas; \`{point: {x, y}}\` só quando não há elemento. Um \`@eN\` vale até a tela mudar: depois de \`E_TARGET_NOT_FOUND\`, leia a árvore de novo.
3. Nunca digite credenciais (Apple ID, senha, código do iPhone) nem peça senha ao dono: login, Face ID e código são pontos de controle humanos.
4. Não capture nem opere fora do app alvo e dos apps permitidos; Ajustes, Telefone, Mensagens, Mail, Wallet e lojas estão fora de alcance (\`E_FORBIDDEN_APP\`).
5. Tomada (gravação) = \`take_start\` + \`take_wait\` (ainda não disponíveis nesta fase).
Erros vêm como \`{error: {code, message, data}}\`. \`E_RUNNER_DOWN\`: rode \`contrarregra runner up\`. \`E_NO_USB\`: peça ao dono para ligar o cabo. \`E_BUSY\` com \`takeId\`: há uma tomada em curso. Na dúvida, \`doctor\`.`;

const DESCRIPTIONS = {
  doctor:
    'Diagnóstico do ambiente, sem mudar nada: versão do Node, configuração, cabo USB (PF-02), túnel do devicectl (PF-03) e runner respondendo (PF-04). Devolve {ok, node, checks: [{id, ok, detail, code?}]}. Use quando outra ferramenta falhar.',
  device_status:
    'Estado do iPhone lido pelo runner (device.state): tela travada, rede (online/offline), app em primeiro plano, idioma, tamanho da tela em pontos, tamanho do texto e aparência.',
  screenshot:
    'Captura a tela do iPhone: JPEG 390×844 em pontos (coordenadas da imagem = pontos de tap {point}) mais uma linha com a escala e o caminho do PNG nativo salvo no cache. Só funciona com o app alvo ou um app permitido em primeiro plano (senão E_FORBIDDEN_APP, e nada é capturado).',
  ui_tree:
    'Árvore de acessibilidade do app em primeiro plano, só nós visíveis. format "compact" (padrão): treeVersion e uma linha por nó — `@e12 button "Open settings" (342,52 40x40)`, mais id=, value= e estados fora do padrão (disabled, selected). format "json": {treeVersion, nodes} com os nós completos. app: "target" (padrão: o app alvo) ou o bundle id de um app permitido; a árvore só sai do app alvo ou de um app permitido à frente (senão E_FORBIDDEN_APP). Os @eN valem até a tela mudar.',
  tap:
    'Toca um alvo no iPhone. target com exatamente um seletor primário: {ref: "@e12"} da árvore atual, {label}, {labelPrefix}, {labelContains}, {identifier}, {ocr: {text}} ou {point: {x, y}} em pontos da tela; modificadores opcionais type, app, within, below, above, index, offset, fallback. Devolve {point, nodeRef?, tDevStartNs, tDispatchNs, tDevEndNs, path}.',
} as const satisfies Record<(typeof STARRED_TOOLS)[number], string>;

const meta = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({ 'anthropic/alwaysLoad': true, ...extra });

const json = (value: unknown): CallToolResult => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });

/** Aceita qualquer entrada: a conferência é a do comando, que responde `{error: {code, message, data}}`. */
const ACCEPT_ANY: jsonSchemaValidator = {
  getValidator<T>(): JsonSchemaValidator<T> {
    return (input) => ({ valid: true, data: input as T, errorMessage: undefined });
  },
};

/** `inputSchema` que só anuncia a forma de `schema` (JSON Schema 2020-12, como o SDK geraria) e aceita tudo. */
const shapeOf = (schema: z.ZodType) =>
  fromJsonSchema(z.toJSONSchema(schema, { target: 'draft-2020-12', io: 'input' }) as JsonSchemaType, ACCEPT_ANY);

const noArgs = (args: unknown, tool: string): void => void parseArgs(NoArgsSchema, args, tool);

/** Roda o comando; erro → `isError` com `{error: {code, message, data}}`. */
async function run(fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (error) {
    return { isError: true, content: [{ type: 'text', text: JSON.stringify(errorObject(error)) }] };
  }
}

/** Monta o servidor. `options` só nos testes (configuração e ferramentas falsas); padrão: a máquina. */
export function createContrarregraServer(options: ContextOptions = {}): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: PACKAGE.version }, { instructions: INSTRUCTIONS });
  const context = () => loadContext(options);

  server.registerTool(
    'doctor',
    { title: 'Diagnóstico', description: DESCRIPTIONS.doctor, inputSchema: shapeOf(NoArgsSchema), annotations: { readOnlyHint: true }, _meta: meta() },
    (args) =>
      run(async () => {
        noArgs(args, 'doctor');
        return json(await doctor(options));
      }),
  );

  server.registerTool(
    'device_status',
    { title: 'Estado do iPhone', description: DESCRIPTIONS.device_status, inputSchema: shapeOf(NoArgsSchema), annotations: { readOnlyHint: true }, _meta: meta() },
    (args) =>
      run(async () => {
        noArgs(args, 'device_status');
        return json(await deviceStatus(context()));
      }),
  );

  server.registerTool(
    'screenshot',
    { title: 'Captura de tela', description: DESCRIPTIONS.screenshot, inputSchema: shapeOf(NoArgsSchema), annotations: { readOnlyHint: true }, _meta: meta() },
    (args) =>
      run(async () => {
        noArgs(args, 'screenshot');
        const shot = await screenshot(context());
        const { jpeg, png } = shot;
        return {
          content: [
            { type: 'image', data: jpeg.base64, mimeType: 'image/jpeg' },
            {
              type: 'text',
              text: `JPEG ${jpeg.widthPx}×${jpeg.heightPx} px, escala 1 (1 px = 1 ponto do XCUITest); PNG nativo ${png.widthPx}×${png.heightPx} px, escala ${png.scale}: ${png.path}`,
            },
          ],
        };
      }),
  );

  server.registerTool(
    'ui_tree',
    {
      title: 'Árvore de acessibilidade',
      description: DESCRIPTIONS.ui_tree,
      inputSchema: shapeOf(TreeArgsSchema),
      annotations: { readOnlyHint: true },
      _meta: meta({ 'anthropic/maxResultSizeChars': 200_000 }),
    },
    (args) =>
      run(async () => {
        const treeArgs = parseTreeArgs(args);
        const tree = await uiTree(context(), treeArgs);
        if (tree.format === 'json') return json({ treeVersion: tree.treeVersion, nodes: tree.nodes });
        return { content: [{ type: 'text', text: [`treeVersion ${tree.treeVersion}`, ...tree.nodes].join('\n') }] };
      }),
  );

  server.registerTool(
    'tap',
    {
      title: 'Tocar',
      description: DESCRIPTIONS.tap,
      inputSchema: shapeOf(TapArgsSchema),
      annotations: { readOnlyHint: false, destructiveHint: false },
      _meta: meta(),
    },
    (args) =>
      run(async () => {
        const tapArgs = parseTapArgs(args);
        return json(await tap(context(), tapArgs));
      }),
  );

  return server;
}
