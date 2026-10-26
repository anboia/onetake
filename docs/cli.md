# Referência da CLI

[← Uso](usage.md)

Execute a partir da raiz do checkout como `./bin/onetake`, ou adicione `bin/` ao `PATH` para usar `onetake`. O launcher legado `contrarregra` continua sendo um alias.

`--help` mostra a interface realmente implementada. `--json` fornece saída estruturada nos comandos válidos; mensagens de progresso/erro usam stderr. Códigos de saída: **0** sucesso, **1** falha operacional/validação, **2** uso inválido. Erros de argumentos não têm garantia de envelope JSON.

| Comando | Efeito |
| --- | --- |
| `runner build [--configuration Spike]` | Gera o projeto e constrói/verifica a assinatura; o padrão é Debug |
| `runner up [--spike [--bind loopback\|endpoint]]` | Instala/inicia uma sessão XCTest; `--bind` é exclusivo de Spike |
| `runner down` | Encerra a sessão e remove artefatos efêmeros de sessão |
| `runner status` | Consulta o estado da sessão/transporte |
| `runner sever --for <segundos>` | Gancho de teste que interrompe transporte temporariamente; não use em uma tomada importante |
| `obs setup` | Cria/reconcilia o perfil, coleção, cena e fonte do OBS configurados |
| `take validate <choreo.yaml>` | Verificação local, sem iPhone/OBS |
| `take run <choreo.yaml>` | Executa ações reais e grava com o OBS |
| `take control <takeDir> resume\|retry\|skip\|abort` | Envia um controle a uma tomada em andamento |

## Opções de `take run`

| Opção | Significado / cuidado |
| --- | --- |
| `--dry` | Opera o iPhone sem gravação; **não** é offline ou somente leitura |
| `--scenes s01,s02` | Executa somente as cenas selecionadas |
| `--from <stepId\|sceneId>` | Inicia a partir do ponto selecionado, sem reconstruir estado anterior |
| `--until <stepId>` | Encerra o trecho no passo indicado |
| `--voice <voice.json>` | Usa um arquivo de tempos de voz previamente preparado |
| `--pause-recording-at <checkpointId>[,…]` | Pausa o OBS nesses checkpoints; pode violar a necessidade de vídeo contínuo |
| `--no-prepare` | Não executa preparação; o operador assume o estado inicial |
| `--no-cleanup` | Não executa finalização; o operador assume a restauração |
| `--json` | Retorna resumo estruturado; progresso vai para stderr |

Não há `onetake doctor`, `onetake screenshot`, `onetake ui tree`, `onetake take status`, `onetake init`, `onetake sync` ou `onetake post` na CLI atual. Diagnóstico e exploração estão no servidor MCP, cujo [registro de ferramentas](../mac/src/mcp/server.ts) define a interface; o estado detalhado de uma tomada está no arquivo `take.json` retornado pela execução.

## Formatos de saída

`take validate`: `ok`, `file`, `sha256`, `errors`, `warnings`, `scenes`, `steps`.

`take run`: resumo com status, cenas/passos, gravação, `takeJson` e avisos de finalização. Consulte as definições em [`mac/src/take/run.ts`](../mac/src/take/run.ts) e [`mac/src/take/manifest.ts`](../mac/src/take/manifest.ts); não deduza que todo objeto em `spec/` já é emitido pelo executor atual.

Erros operacionais conhecidos: `{ "error": { "code": "E_…", "message": "…", "data": {} } }`. Trate o código como contrato e a mensagem como diagnóstico humano. Um erro de execução pode também ser representado no resumo da tomada, com status de falha.
