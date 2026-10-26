# Checklist do mantenedor: publicação no GitHub

[← README](../README.md)

Preparar arquivos não equivale a publicar. Este trabalho não autoriza commit, push, mudança de visibilidade, upload de vídeo ou reescrita de histórico.

## Bloqueios antes de abrir a visibilidade

- [x] **Licença:** MIT escolhida pelo titular, em `LICENSE`, manifesto e guias de contribuição. Preserve atribuições de terceiros.
- [ ] **Privacidade do histórico:** revise todo o histórico, incluindo `.claude/handoffs/`, `spec/`, `spikes/` e a coreografia do app original. Há contexto pessoal/de operação que não deve ser publicado automaticamente.
- [ ] **Triagem do scanner:** Gitleaks 8.30.1 foi executado sobre 61 commits (`--all`, valores redigidos) e apontou 9 ocorrências `generic-api-key`, em testes/fixtures. Elas ainda exigem triagem: estar em teste não prova que um valor é fictício. Se houver segredo real, revogue/rotacione primeiro. O scan não substitui revisão de dados pessoais nem garante ausência de segredos desconhecidos.
- [ ] **Material demonstrativo:** obtenha autorização antes de reutilizar nome de app, vídeo, áudio, telas, dados de terceiros ou links de entrega. Não publique a gravação existente só porque há uma URL acessível.
- [ ] **Instruções de agentes protegidas:** `AGENTS.md`, `CLAUDE.md` e `docs/agents.md` tiveram a gravação bloqueada por expiração da aprovação de segurança, mesmo após o titular autorizar nova tentativa. Permanecem ausentes; não prometa descoberta automática desses arquivos nem contorne a proteção por outro mecanismo.
- [ ] **Revisão da migração:** confira defaults sem identificadores pessoais, configuração explícita do usuário e compatibilidade de instalações antigas.

`.gitignore` não remove arquivos já rastreados. Decida com o titular se o repositório existente terá histórico revisado ou se haverá um repositório público inicial separado. Não use `git filter-repo`, force-push ou exclusão de arquivos/histórico sem autorização explícita.

## Validação local

```sh
nvm use
npm ci
npm run typecheck
npm test
npm run docs:check
swift test --package-path ios/ContrarregraKit
npm audit
git diff --check
git status --short
```

Faça também uma instalação a partir de checkout limpo e um teste no aparelho autorizado, verificando assinatura, transporte, OBS e vídeo. Testes com fakes não comprovam essa etapa. Não gere certificado automaticamente para contornar uma falha.

## Configuração no GitHub — aplicar apenas com autorização

- **Nome:** `onetake`; título de produto **OneTake**.
- **Descrição sugerida:** `Repeatable iPhone demos with XCUITest, YAML and OBS. CLI + MCP for macOS.`
- **Topics sugeridos:** `ios`, `iphone`, `xcuitest`, `obs-studio`, `mcp`, `automation`, `developer-tools`, `demo`.
- Habilite Issues; use os formulários e o template de PR versionados.
- Habilite **private vulnerability reporting**, Dependabot alerts e secret scanning/push protection onde disponíveis.
- Configure proteção/ruleset da branch principal: checks `TypeScript and docs` e `Swift models`, revisão antes do merge, bloqueio de force-push e deleção. Confirme os nomes após o primeiro run real.
- Revise permissões do GitHub Actions; os workflows versionados usam `contents: read` e não acessam segredos de produção.
- Confira **Insights → Community Standards** e a detecção da licença MIT após o push.
- Só depois do push autorizado confirme a execução remota da CI e a renderização dos READMEs/links.

## Apresentação pública

A primeira tela deve explicar problema, benefício, público e limites; o README atual faz isso sem depender de vídeo privado. Depois de aprovar material demonstrativo, adicione um clipe curto com legenda, dados de teste e link claro. Não fabrique screenshots nem badges de CI, downloads ou popularidade.

Mantenha o caminho rápido **validar sem hardware → configurar conscientemente → executar**. Atualize português e inglês juntos. Use docs relativas para que forks e outras branches continuem navegáveis.

## Primeiro release

Não há promessa de pacote npm ou binário distribuído. `private: true` fica no manifesto enquanto a instalação for pelo código-fonte. Antes de um release, escolha versão, escreva notas com funcionalidades reais e limites, execute a matriz de checks e publique somente com aprovação do titular. Uma tag não torna recursos planejados em `spec/` disponíveis.
