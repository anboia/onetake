# Migração: Contrarregra → OneTake

[← Instalação](installation.md) · [Uso](usage.md) · [Desenvolvimento](development.md) · [Configuração MCP do repositório](../.mcp.json)

**OneTake** é o nome público do antigo projeto Contrarregra; não é uma migração automática de arquivos locais, chaves, protocolos ou certificados. A distribuição continua pelo código-fonte sob [MIT](../LICENSE), com `package.json` marcado `private: true` para impedir publicação acidental no npm. Mudança do nome do checkout ou da visibilidade no GitHub não altera a configuração da sua máquina.

## O que permanece compatível

| Antes | Agora / situação |
| --- | --- |
| `contrarregra` / `contrarregra-mcp` | Entradas legadas preservadas; prefira `./bin/onetake` / `./bin/onetake-mcp` para novos fluxos. Os launchers usam o mesmo código TypeScript. |
| `~/.config/contrarregra/config.json` | Continua sendo lido **somente se** `~/.config/onetake/config.json` não existir. |
| Serviço `contrarregra` no Chaveiro, conta `OBS_WEBSOCKET_PASSWORD` | Permanece assim: não renomeie o item só porque o produto agora é OneTake. |
| `ContrarregraKit`, `ContrarregraHost`, `ContrarregraRunner`, `Contrarregra.xcodeproj` | Nomes internos do Swift/Xcode preservados; o projeto `.xcodeproj` é gerado por `runner build`. |
| `schema: contrarregra.choreography/1` e outros `contrarregra.*/1` | Identificadores de formato/protocolo permanecem válidos; **não** altere o YAML para `onetake.choreography/1`. A trilha atual de tomada usa `contrarregra.demo-take/1`. |
| `CONTRARREGRA_*` no ambiente da sessão do runner | Ainda são nomes internos de protocolo. `ONETAKE_*` só são injetadas pelo build no XcodeGen; não renomeie as variáveis do runner. |
| Cache/tomadas antigos | Permanecem nos caminhos que sua configuração definir; nada os move ou reescreve. Preserve arquivos históricos para consulta, sem publicá-los. |

Mensagens de erro e dicas internas ainda podem dizer `contrarregra`. Isso não significa que existe uma nova CLI separada. A [referência da CLI](cli.md) lista só comandos implementados; a entrada MCP já está em [`.mcp.json`](../.mcp.json). Instruções próprias para agentes ainda dependem de aprovação.

## Escolha entre continuar e migrar o arquivo local

**Continuar sem mudança:** se você já tem `~/.config/contrarregra/config.json` e não existe `~/.config/onetake/config.json`, o carregador usa o arquivo antigo. A linha de base da assinatura de builds futuros permanece **ao lado desse arquivo**, em `~/.config/contrarregra/signing-baseline.json`. Não precisa renomear o item do Chaveiro ou refazer a assinatura por causa do nome público. Revise se `signing`, bundle IDs e caminhos ainda correspondem à sua máquina antes de operar.

**Migrar conscientemente:** antes de criar `~/.config/onetake/config.json`, inspecione **pessoalmente e sem compartilhar** a configuração antiga, os diretórios de `paths.cache`/`paths.takes` e a linha de base de assinatura. Não copie uma configuração de outra pessoa. Faça cópias de segurança fora do repositório de `config.json` **e** `signing-baseline.json` se presente. Crie a pasta nova, copie manualmente o JSON antigo para ela **sem sobrescrever um arquivo moderno existente**; não substitua seu arquivo antigo por `config/example.json` nem use `mv` às cegas. Se preferir começar com o exemplo, siga [instalação](installation.md) e preencha seus dados, ciente de que isso é uma instalação nova.

O carregador seleciona **um único arquivo**: se o moderno existe, ele tem precedência e o legado é ignorado, não mesclado com ele. Cada um é mesclado separadamente com `config/defaults.json` (objetos por chave, arrays substituídos). A CLI **não oferece `--config`** para escolher outro arquivo. Portanto, um `config.json` moderno incompleto pode trocar silenciosamente o time, os caminhos e o aparelho que o legado configurava. Reveja `device.udid`, `device.coreDeviceId`, `device.name`, `signing.team`, `signing.identity`, `bundle.host`, `bundle.runnerTest`, `app.explore`, `apps.allowed`, `urls.allowedPrefixes`, `runner.privateAllowed`, `paths` e `obs` **antes de qualquer build ou tomada**.

### Preserve a linha de base de assinatura

`runner build` usa `configDir` do arquivo selecionado para ler/criar **`signing-baseline.json` ao lado de `config.json`**. Migrar só o JSON faz o build consultar `~/.config/onetake/signing-baseline.json` em vez do antigo. Depois de conferir os arquivos, **copie manualmente**, sem sobrescrever, a linha de base antiga para a pasta nova junto do JSON; **mantenha a cópia antiga** como backup. Não edite nem gere uma linha de base à mão. Ao trocar de time, certificado ou identidade, investigue a divergência e peça aprovação do responsável antes de qualquer decisão de substituição; não apague a linha de base para “fazer passar”.

Há um fallback histórico diferente: quando a linha de base na pasta selecionada está ausente, `runner build` procura uma cópia em **`paths.cache/signing-baseline.json`**; se a encontra, copia-a para a pasta da configuração e deixa a antiga no cache. Mas `paths.cache` pode mudar entre a instalação legada e a nova: **não confie nesse fallback como estratégia de migração**. Um cache apagado pelo macOS também não é backup seguro. Preserve e confira primeiro a cópia adjacente ao arquivo legado.

Se a linha de base divergir do Chaveiro ou do certificado que assinou o build, a operação falha fechada (`reason: signing-baseline`). O build verifica identidades antes/depois do Xcode e a assinatura do XCTRunner; `runner up` exige um build verificado. Autorize mudanças de assinatura explicitamente, sem contornar a conferência. O esquema do arquivo de baseline ainda é `contrarregra.signing-baseline/1`.

## Caminhos, OBS e versões ao recomeçar

- `config/example.json` é um **modelo para novas máquinas**, não um script de migração: sugere `~/Movies/onetake`, `~/Library/Caches/onetake` e perfil/coleção/cena OBS `OneTake`; os defaults legados ainda apontam para caminhos e nomes `contrarregra`/`Contrarregra` quando não houver override. Se mudar `paths.cache`, builds, sessões e a cópia histórica no cache não aparecem no novo local. Se mudar `paths.takes`, seus vídeos antigos continuam no local anterior. Faça retenção/backup manual, não apague o material anterior por impulso.
- `obs setup` cria/reconcilia o perfil e a coleção definidos no **arquivo selecionado**; mudar de `Contrarregra` para `OneTake` pode criar outra configuração OBS. Confira o perfil/coleção ativos e o nome do iPhone antes de permitir alterações. A conta `OBS_WEBSOCKET_PASSWORD` continua no serviço do Chaveiro **`contrarregra`**, independentemente do nome do perfil.
- O projeto Xcode é gerado a partir de `ios/project.yml` com `ONETAKE_SIGNING_TEAM`, `ONETAKE_HOST_BUNDLE_ID` e `ONETAKE_RUNNER_TEST_BUNDLE_ID` injetadas por `runner build`, derivadas de `signing.team`, `bundle.host` e `bundle.runnerTest`. Se alterar os bundle IDs ou time, confirme identidade/provisionamento próprios antes de construir; não tente reaproveitar artefatos de outro time.
- OBS **31.1.2**, obs-websocket **5.6.2** e ffmpeg/ffprobe **8.1.1** são versões validadas na configuração padrão e verificadas nas respectivas operações. `brew upgrade` não garante compatibilidade. Node precisa ser **22.x ≥22.18**; veja [instalação](installation.md) para o conjunto de requisitos de macOS, Xcode, XcodeGen e iOS 26.

Faça primeiro a validação **sem hardware** (`./bin/onetake take validate examples/first-take.choreo.yaml --json`) e os checks de [desenvolvimento](development.md). `npm test` usa ffmpeg/ffprobe locais em alguns testes de mídia, mas não precisa de iPhone/OBS reais. Só com consentimento do responsável, depois da revisão dos caminhos, identidade, aparelho e perfil OBS, avance ao [guia de uso](usage.md). `take run --dry` **não** é simulação: ainda toca no iPhone.
