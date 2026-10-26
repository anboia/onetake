# Primeira demonstração

[← README](../README.md) · [Instalação](installation.md) · [Referência da CLI](cli.md)

## 1. Entenda o roteiro

Uma **coreografia** é um arquivo YAML que descreve o app, o dispositivo esperado, alvos reutilizáveis e cenas. Uma **tomada** é uma execução desse roteiro. Um **checkpoint** é uma condição que precisa ser satisfeita, eventualmente com ajuda humana.

Comece por [`examples/first-take.choreo.yaml`](../examples/first-take.choreo.yaml). Troque `com.example.demo`, o nome do ícone, a versão esperada, as características do dispositivo e o botão `Continue` por valores observados no seu app. Esse app de exemplo não é fornecido pelo projeto.

- `targets`: catálogo de seletores reutilizáveis, como um botão pelo rótulo.
- `prepare`: ações anteriores à gravação.
- `scenes`: cenas com IDs `s01`, `s02` etc. e listas de passos.
- `cleanup`: ações posteriores à gravação, quando a execução permite finalizar normalmente.

O identificador `contrarregra.choreography/1` é o formato de compatibilidade atual; **não** o troque por `onetake.choreography/1`.

## 2. Valide sem hardware

```sh
./bin/onetake take validate examples/first-take.choreo.yaml --json
```

Espere `ok: true` e uma lista `errors` vazia. Isso verifica o formato e o subconjunto de ações implementado, não a existência do app ou do botão no iPhone. `warnings` devem ser lidos: determinados campos da especificação ainda não têm efeito no executor.

## 3. Prepare a sessão real

Complete a [instalação](installation.md) antes destes comandos. Eles **não** são uma simulação:

```sh
./bin/onetake runner build
./bin/onetake runner up
./bin/onetake runner status --json
```

`runner build` usa assinatura Apple e pode solicitar provisionamento. `runner up` instala/inicia o runner de testes no aparelho e pode mudar o app em primeiro plano. A primeira instalação e cada build novo precisam de consentimento do responsável pelo dispositivo. Não execute durante outra tomada.

Abra o app alvo manualmente, conclua logins por conta própria e deixe a tela inicial do roteiro pronta. O runner não deve receber sua senha, Apple ID, código de desbloqueio ou código de verificação.

Para localizar alvos, use o servidor MCP configurado em [`.mcp.json`](../.mcp.json): `ui_tree` para rótulos/identificadores; `screenshot` quando a imagem for necessária. Os `@eN` da árvore são temporários e não podem ser salvos em coreografias. Use nomes do catálogo, como `{ref: continueButton}`, associados a seletores estáveis.

## 4. Ensaie sem gravação

```sh
./bin/onetake take run examples/first-take.choreo.yaml --dry
```

> **`--dry` toca no iPhone de verdade.** Ele executa preparação, cenas e finalização; apenas dispensa a gravação OBS. Pode alterar estado, enviar dados ou acionar compras se o roteiro tocar nesses controles. Revise cada passo e use contas/dados de teste.

O executor precisa do runner e de um app já instalado. Não há um simulador embutido nesse comando.

## 5. Grave

Configure o OBS conforme o guia de instalação. `obs setup` altera um perfil/coleção próprios: aprove essa mudança antes de executar.

```sh
./bin/onetake obs setup
./bin/onetake take run examples/first-take.choreo.yaml --json
```

Mantenha o terminal aberto: a tomada é executada em primeiro plano, não por um serviço de jobs. O retorno inclui `status`, resultados dos passos, localização do vídeo quando há gravação e o caminho de `take.json`. Use **os caminhos retornados**, não uma pasta ou um nome de arquivo presumido.

Ao terminar, assista ao vídeo completo, confira enquadramento, áudio e dados pessoais e leia `take.json`. `finished` não significa aprovação editorial nem conformidade automática com requisitos da App Review. Não há publicação automática.

## 6. Responda às pausas

Quando a tomada informar o diretório e o motivo da pausa, use um segundo terminal:

```sh
./bin/onetake take control /caminho/retornado/da/tomada resume
```

O caminho acima é um marcador: substitua pelo diretório real. As operações disponíveis são `resume`, `retry`, `skip` e `abort`. As três primeiras exigem uma pausa; `abort` pede encerramento. `retry` pode repetir uma ação com efeito externo e `skip` pode invalidar a evidência: decida conscientemente, não use retries cegos em compras ou envios.

Para encerrar a sessão depois da tomada:

```sh
./bin/onetake runner down
```

Se houver interrupção, confira os avisos `cleanupPending` e `airplaneMaybeOn`; restaure manualmente o estado do aparelho quando necessário. Não remova arquivos de trava para forçar acesso sem investigar o processo proprietário.

## Selecionar cenas e trechos

```sh
./bin/onetake take run examples/first-take.choreo.yaml --dry --scenes s01
./bin/onetake take run examples/first-take.choreo.yaml --dry --from s01.ready --until s01.hold
```

Use isso para desenvolvimento. Começar no meio não reconstrói automaticamente o estado de cenas anteriores. `--no-prepare`, `--no-cleanup` e pausas da gravação são opções avançadas; consulte a [referência](cli.md).

## Narração e pós-produção

A opção `--voice` consome um arquivo de tempos de voz existente. Não é um gerador público de narração. Scripts em `spikes/demo/` são experimentos ligados à demonstração original, não uma interface estável ou um tutorial genérico. A captura atual não comprova automaticamente sincronismo audiovisual de ±100 ms. Veja [limitações](status.md).
