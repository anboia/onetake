# Estado e limites do produto

[← README](../README.md)

OneTake está em desenvolvimento, com versão de manifesto `0.0.0`. A demonstração original orientou parte das implementações; isso não torna o fluxo específico daquele app uma instalação genérica validada para todos os dispositivos.

## Implementado

- CLI: `runner build/up/down/status/sever`, `obs setup`, `take validate/run/control`.
- MCP stdio: `doctor`, `device_status`, `screenshot`, `ui_tree`, `tap`.
- Runner XCUITest, transporte USB, sessão autenticada e controle de concorrência.
- Execução de um subconjunto validado de coreografias, condições e checkpoints.
- Gravação OBS e registro `take.json`; controle de disco e avisos de finalização.
- Testes locais com fakes e fixtures compartilhadas TypeScript/Swift.

## Não entregue como fluxo público estável

- Android, operação Windows/Linux ou gravação em simulador como substituta de aparelho físico.
- Instalação via pacote npm público, Homebrew formula própria ou aplicativo macOS distribuído.
- Comandos MCP de gravação, pós-produção ou administração completa do runner.
- `choreo compile`, `take status`, `sync calibrate`, `post` e outros comandos descritos em especificações antigas, mas não registrados na CLI.
- Uma garantia automática de alinhamento audiovisual de ±100 ms ou aprovação de App Review.
- Compatibilidade irrestrita com tamanhos de tela, versões futuras do XCTest e todos os Macs Intel. A resposta de screenshot MCP ainda usa o tamanho fixo 390×844; confira a adequação antes de usar coordenadas em outro dispositivo.
- Geração integrada de faixa de voz por `take run --voice`: essa opção consome tempos existentes.

## Restrições importantes

`--dry` é ensaio real, sem OBS. O app e seus dados podem mudar. Use `take validate` para validar sem efeitos.

O executor recusa ações da especificação que não implementa; `repeat`, `press` e `app launch` não fazem parte do subconjunto de tomada. `openURL` só é permitido em preparação/finalização. Campos `device`, `guide` e `confirm` no topo podem gerar avisos de limitações: não substituem verificações humanas.

APIs privadas de XCTest são isoladas, mas frágeis. Ativá-las exige avaliação e aprovação explícita. Manter `runner.privateAllowed` vazio é o padrão conservador; não prometa que todos os roteiros funcionarão assim.

## Prioridades de contribuição

1. Instalação reproduzível em outro Mac/aparelho, com relatório sem identificadores pessoais.
2. Exemplos pequenos independentes do app original e testes dos fluxos documentados.
3. Diagnósticos de configuração e compatibilidade mais claros.
4. Evolução da superfície MCP e da pós-produção, mediante design e testes.

Isto é uma ordem sugerida para discussão, não um compromisso de prazo.

## Documentos históricos

`spec/`, `spikes/`, `.claude/handoffs/` e `choreographies/hagah/` preservam contexto anterior. Podem conter nomes antigos, dados operacionais e decisões específicas do autor. Não são o tutorial público e precisam passar pela revisão de privacidade de [publicação](publishing.md). Nenhum registro histórico foi removido ou reescrito automaticamente para ocultar essa pendência.
