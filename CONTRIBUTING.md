# Contribuindo com o OneTake

Obrigado por ajudar a tornar demonstrações de iPhone mais reproduzíveis. Documentação, relatos claros de problemas e testes são tão úteis quanto funcionalidades.

> As contribuições incorporadas são distribuídas sob a [licença MIT](LICENSE) do projeto. Envie apenas código que você tem direito de contribuir sob esses termos. Não há CLA nem transferência de direitos presumida.

## Escolha uma contribuição

- **Documentação:** torne uma instrução reproduzível em um Mac novo.
- **Bug:** apresente o resultado esperado, o observado e a menor reprodução possível.
- **Teste:** reproduza um problema com fakes ou fixtures sanitizadas, sem aparelho pessoal.
- **Compatibilidade:** informe versões do macOS, Xcode, iOS, Node e OBS; não inclua UDID, serial, tokens ou identidade de assinatura.
- **Funcionalidade:** abra uma issue antes de alterar protocolo, segurança, dependências ou arquitetura.

Use português ou inglês. Seja objetivo e respeite o [código de conduta](CODE_OF_CONDUCT.md). Falhas de segurança seguem [SECURITY.md](SECURITY.md), não issues públicas.

## Prepare o ambiente

Faça um fork quando o repositório estiver público; até lá, solicite acesso ao titular. Clone sua cópia, crie uma branch descritiva e siga a [instalação](docs/installation.md):

```sh
nvm install
nvm use
npm ci
git switch -c fix/descricao-curta
npm run typecheck
npm test
swift test --package-path ios/ContrarregraKit
```

A validação TypeScript e os testes Swift de modelos não exigem assinatura nem um iPhone. A operação do produto exige macOS e o setup completo. Não execute `runner up`, `obs setup` ou uma tomada apenas para validar uma alteração na documentação.

## Regras técnicas

1. **Uma mudança por PR.** Evite reorganizar arquivos ou formatar código sem relação com o problema.
2. **Teste o comportamento antes de corrigi-lo.** Mostre o teste falhando e passando; use `node:test` e XCTest já existentes.
3. **Mantenha as camadas.** CLI/MCP adaptam entradas; a lógica compartilhada fica em `mac/src/commands/` e nos módulos especializados.
4. **Preserve os contratos.** Campos JSON, schemas `contrarregra.*/1`, códigos de erro e inteiros em nanossegundos representados como strings não são detalhes cosméticos.
5. **Sem troca de stack silenciosa.** Justifique nova dependência, alteração de versão ou API privada; atualize o lockfile com npm.
6. **Segurança não é negociável.** Preserve allowlists, checkpoints humanos, exclusão de campos seguros, tokens efêmeros e isolamento dos perfis OBS.
7. **Documente o que existe.** Ao alterar uma opção ou ferramenta, atualize a ajuda, exemplos e guias. Uma função interna não implica um comando público.

Use imports ESM com extensão `.ts`, `import type` quando aplicável, aspas simples e ponto e vírgula no TypeScript. No Swift, acompanhe o estilo do arquivo. Os documentos são em português; identificadores e nomes de arquivos, em inglês. Consulte [desenvolvimento](docs/development.md).

## Uso de IA

Contribuições assistidas por IA são bem-vindas, sob a mesma responsabilidade de revisão e testes. Leia o [guia de desenvolvimento](docs/development.md); verifique todos os símbolos, bibliotecas e comandos gerados. `AGENTS.md`, `CLAUDE.md` e `docs/agents.md` ainda dependem de autorização de escrita. Nunca forneça dados pessoais, gravações, segredos ou arquivos de assinatura a um modelo.

No PR, declare onde a IA ajudou e quais verificações **você realmente executou**. Não apresente resultados inventados, testes apenas propostos ou uma revisão automática como aprovação humana.

## Antes de abrir o pull request

- [ ] Mudança pequena, com motivo e reprodução descritos.
- [ ] `npm run typecheck`, `npm test` e `npm run docs:check` passaram.
- [ ] `swift test --package-path ios/ContrarregraKit` executado quando Swift, protocolo ou projeto iOS mudou.
- [ ] Testes novos cobrem a mudança; explique verificações de hardware ainda pendentes.
- [ ] Exemplos, documentação e comportamento concordam.
- [ ] `git diff --check` passou; o diff não contém dados pessoais, segredos ou mídias.
- [ ] Nenhuma configuração local, `.xctestrun`, certificado ou saída de build foi incluída.
- [ ] Mudanças incompatíveis e riscos foram explicados.

Use o template do PR. Descreva **o que mudou, por quê, como foi testado e o que não foi testado**. Aguarde revisão; responda aos comentários com contexto. Não há prazo de resposta garantido. O mantenedor decide o merge; um check verde não autoriza publicação nem uma gravação no aparelho de outra pessoa.
