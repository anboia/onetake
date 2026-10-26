# Desenvolvimento e arquitetura

[← Contribuir](../CONTRIBUTING.md)

## Modelo mental

OneTake tem dois processos principais: ferramentas TypeScript no Mac e um runner XCTest no iPhone. O OBS é um terceiro processo, controlado por WebSocket. A CLI e o MCP são adaptadores de entrada; as operações vivem em módulos compartilhados.

| Caminho | Responsabilidade |
| --- | --- |
| `bin/` | Escolha de Node compatível e pontos de entrada CLI/MCP |
| `mac/src/cli/`, `mac/src/mcp/` | Parsing, ferramentas registradas e formato da saída |
| `mac/src/commands/` | Operações compartilhadas e validação de argumentos/contexto |
| `mac/src/core/` | Tipos, schemas, erros, JSON canônico e segredos |
| `mac/src/runner/`, `mac/src/usbmux/` | Sessões, builds, assinatura, transporte USB e reconexão |
| `mac/src/take/` | Validação YAML, execução, checkpoints, locks e manifesto |
| `mac/src/obs/` | Cliente obs-websocket e configuração isolada de perfil/coleção |
| `mac/src/media/`, `clock/`, `align/` | ffmpeg, OCR, relógios e primitivas de alinhamento |
| `ios/ContrarregraKit/` | Modelos e protocolo Foundation, testáveis sem aparelho |
| `ios/ContrarregraRunner/` | Implementação XCTest, leitura/ações e servidor do dispositivo |
| `ios/ContrarregraHost/` | Hospedeiro mínimo e tela de calibração |
| `mac/test/fixtures/` | Fixtures de protocolo/artifacts; parte também consumida por Swift |

`ContrarregraKit`, os targets Xcode e schemas antigos não foram renomeados por estética: uma migração interna deve considerar instalações, sessões e fixtures. Veja [migração](migration.md).

## Ambiente

```sh
nvm install
nvm use
npm ci
```

Node 22.x ≥22.18 executa TypeScript por type stripping. Não há transpile/bundle obrigatório nem `npm run build`. `tsconfig.json` usa `noEmit`, `strict`, `erasableSyntaxOnly`, ESM NodeNext e imports `.ts`. Não use sintaxe que exija emissão de JavaScript.

## Testes e checks

```sh
npm run typecheck
npm test
npm run docs:check
swift test --package-path ios/ContrarregraKit
git diff --check
```

- `npm test`: `node:test`, fakes de runner, usbmuxd, OBS e Chaveiro; não é teste end-to-end no iPhone.
- `typecheck`: contratos TypeScript, sem gerar arquivos.
- `docs:check`: links relativos do material público, exemplos YAML e configurações públicas; não verifica disponibilidade de todos os links externos nem revisa privacidade do histórico.
- `swift test`: XCTest dos modelos/runner core em macOS; não valida toque real ou assinatura.

Para um teste específico:

```sh
node --test mac/test/take.choreo.test.ts
node --test mac/test/mcp.test.ts
```

Os testes de transporte abrem sockets locais e os de mídia usam ffmpeg/ffprobe **8.1.1**, nos caminhos de `config/defaults.json`. Execute no Mac com o runtime suportado e esses binários instalados; `npm ci` não os instala. A CI instala ffmpeg pelo Homebrew e executa os checks TypeScript/documentação e Swift em jobs separados. Se o Homebrew mudar de versão, o check estrito falhará até uma atualização de compatibilidade deliberada. A execução remota só estará comprovada depois de um push autorizado.

## Evoluir um contrato

1. Descubra o registro público real: `cli/main.ts` e `mcp/server.ts`.
2. Reproduza o comportamento com teste que falha.
3. Altere o núcleo, evitando lógica duplicada em CLI/MCP.
4. Se mexer em JSON/protocolo, atualize Zod, tipos, modelo Swift e fixtures compartilhadas.
5. Preserve timestamp em nanossegundos como string decimal e a canonização usada pelos hashes.
6. Atualize ajuda, exemplo, `docs/cli.md` e `docs/agents.md` conforme aplicável.
7. Execute os testes; relate o que exige confirmação física separada.

## Segurança e código legado

Nunca contorne allowlists, bloqueio de campos seguros, checkpoints humanos, locks ou verificação da identidade de assinatura para fazer um teste passar. `PrivateXCT/` é o limite para APIs privadas. Configuração deve rejeitar entradas inválidas antes de abrir conexão ou processo de hardware.

`spec/constitution.md` contém o modelo original de decisões; a emenda OneTake distingue regras públicas de antigas escolhas pessoais. `spec/spec.md` inclui funcionalidades planejadas e **não** prevalece sobre o estado implementado para fins de documentação de uso. Mantenha mudanças de arquitetura explícitas, pequenas e revisáveis.
