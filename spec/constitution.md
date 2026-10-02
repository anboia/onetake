# Contrarregra — Constituição (invariantes do projeto)

**Status:** PROPOSED

> Leia uma vez por sessão, antes de qualquer tarefa. São regras de projeto que valem para toda
> tarefa e dizem COMO a ferramenta é construída; o comportamento continua em `spec.md`. Se uma
> tarefa violar um invariante, PARE e levante o problema. Enquanto este arquivo está PROPOSED, ele
> muda direto na ratificação; depois de RATIFIED, mudá-lo é mudança classe G1. As razões das
> decisões de arquitetura estão em `architecture.md` A6–A7.

## P-1 — Plataforma

- O vídeo entregue sai de um **iPhone físico com iOS 26.x**, ligado ao Mac por **cabo USB**. O
  simulador é só ensaio (HC-1, HC-4).
- Lado do aparelho: **Swift**, um app hospedeiro mínimo + um **bundle de UI test (XCUITest)** que
  fica vivo e obedece a comandos — o mesmo princípio do WebDriverAgent. É o único caminho sancionado
  pela Apple para tocar noutro app num iPhone real.
- Lado do Mac: **TypeScript em Node 22.x (≥ 22.18), rodando `.ts` direto, sem etapa de build**,
  entregue como uma CLI (`contrarregra`; nome ❓ Q-3) e um servidor MCP (stdio) para o Claude Code, sobre o mesmo
  núcleo; CLI e MCP não têm lógica própria. Node de outra versão maior (há um Node 26 do Homebrew
  instalado) é recusado.
- Toolchain **congelado na produção**: Xcode 26.6 (17F113), iOS 26.x validado (hoje 26.3 23D127;
  ❓ Q-11), macOS 26.5.x, OBS 31.1.2 (obs-websocket 5.6.2; ❓ Q-8), ffmpeg/ffprobe 8.1.1 chamados
  pelo caminho absoluto (o do PATH é o 4.4.7). O pré-voo recusa tomada fora desse conjunto; mudar
  qualquer item é G1 e obriga a refazer os spikes SP-1…SP-7.

## P-2 — Stack (sem trocas silenciosas)

- **XCTest/XCUIAutomation público** é a base de toda ação no aparelho. Nada de Appium, WDA ou
  go-ios em tempo de execução; técnicas do WebDriverAgent (BSD-3) podem ser copiadas com o aviso de
  licença no arquivo que as usa.
- **Gravação = OBS** controlado por **obs-websocket v5**; capítulos por `CreateRecordChapter` em
  **MP4 híbrido**. **QuickTime manual** é o plano B documentado, não um segundo caminho automatizado.
- **Faixa-guia = `say` do macOS.** TTS pago só com o sim do dono (❓ Q-7) e gate G5.
- **Pós = ffmpeg**, chamado como processo; nenhuma biblioteca de edição de vídeo.
- Dependências mínimas: cada pacote ou ferramenta nova (npm, SwiftPM, Homebrew) passa pelo gate G2.
  Preferir a biblioteca padrão do Node 22 e os frameworks da Apple. Previstas na v1 (G2 na Fase 0):
  `@modelcontextprotocol/server` 2.3.0 fixado (traz `zod` 4), `yaml`, e **XcodeGen 2.45.4** (já
  instalado) como ferramenta de build; dev: `typescript`, `@types/node`,
  `@modelcontextprotocol/client`. Nada de go-ios, pymobiledevice3, Appium, `ws` ou
  `obs-websocket-js` em tempo de execução; servidores WebSocket de teste são escritos à mão.

## P-3 — Segurança e privacidade

- **Time fixo `984PNJZ8B9`** e certificado `Apple Development: Andre Saboia (6NKUX5CX7G)`, escritos
  explicitamente em todo build (`DEVELOPMENT_TEAM`), assinatura automática pela conta já logada no
  Xcode (`-allowProvisioningUpdates`). **Nunca** usar os certificados de outros times que existem no
  chaveiro (`59CB45686C`, `V4397KJVXZ`, a "Apple Distribution" de outra empresa). Se uma assinatura
  criar uma identidade nova no chaveiro, parar (G5).
- A chave `.p8` em `~/.appstoreconnect/private_keys/` só pode ser **citada pelo caminho**, como
  alternativa de assinatura sem a sessão do Xcode (`-authenticationKeyPath`); o Key ID e o Issuer
  ID vêm do dono. **Nunca ler, copiar ou imprimir o conteúdo.**
- Segredos só pelo **nome** (ex.: `OBS_WEBSOCKET_PASSWORD`), guardados no **Chaveiro do macOS** e
  lidos em memória na hora do uso; nunca em arquivo do repositório, log, saída de ferramenta MCP ou
  `events.json`. Nada de certificado, perfil, `.p8` ou senha no git. Única exceção: o token de
  sessão do runner, efêmero, vive no `.xctestrun` da sessão (permissão 0600, fora do repositório,
  apagado no `runner down` e na próxima subida se sobrar).
- **A ferramenta e o agente nunca pedem senha ao dono** (na CLI, no MCP ou na conversa): segredo
  ausente → `E_SECRET_MISSING` com o comando que o próprio dono roda.
- O runner **nunca digita** Apple ID, senha, código do aparelho ou qualquer credencial: recusa
  digitar em campo seguro, texto com cara de credencial (e-mail/Apple ID) e qualquer coisa numa tela
  de autenticação do sistema. Esses passos são sempre ponto de controle humano.
- O servidor de comandos do runner escuta **só em loopback no aparelho**, exige o **token de
  sessão** gerado a cada subida, aceita um controlador por vez e não anuncia Bonjour; o Mac só o
  alcança pelo usbmuxd no aparelho (entrada `USB`; se o SP-4 provar o loopback inalcançável,
  ❓ Q-13) e, no simulador (S11), pelo loopback do próprio Mac. Exceção registrada fora do nosso
  controle: o obs-websocket 5.6.2 escuta em todas as interfaces do Mac sem opção de loopback — senha
  forte obrigatória e servidor desligado no OBS fora das sessões de gravação (passo do dono).
- O runner e o MCP só operam os apps e links permitidos (o app alvo, `apps.allowed`, os prefixos de
  link permitidos; no SpringBoard, só o ícone do app alvo, a Central de Controle e o botão do modo
  avião; na tela travada, só o arrasto de destravar dentro de um ponto de controle, depois do Face
  ID — no build `Spike`, também o `spike.unlockDrag` do SP-7, só com `{locked: false}`; na folha do
  Sign in with Apple, só tocar botões, sem ler a árvore nem capturar a tela). Essa lista vale para
  ações; leituras no SpringBoard só acham esses elementos, os ícones da página do app alvo e os
  controles de mídia da tela travada — nunca a árvore inteira do SpringBoard, e nada é capturado com
  a tela travada. O iPhone é pessoal: Ajustes, Telefone, Mensagens, Mail, carteira e lojas estão
  fora de alcance — no aparelho físico o runner os recusa mesmo que a coreografia ou a configuração
  os peça (S1 item 11).
- O que é gravado fica fora do repositório e nunca entra no git (HC-7): tomadas em
  `~/Movies/contrarregra/`; capturas de exploração, caches e registros da ferramenta em
  `~/Library/Caches/contrarregra/`; saídas de spike em `~/Movies/contrarregra/spikes/`.

## P-4 — Conformidade e segurança do produto

- **App alvo intocado** (HC-3): no aparelho e no vídeo, o build do TestFlight/App Store, operado só
  por acessibilidade, imagem da tela e coordenadas. Nada de `testID`, ganchos, launch arguments ou
  builds especiais. Exceção: o ensaio no simulador (S11) usa um build Release de simulador do mesmo
  commit, com as variáveis de loja e sem ganchos, produzido no repositório do app alvo.
- **API privada do XCTest** só quando não existe alternativa pública, **isolada no módulo
  `PrivateXCT`**, registrada em `architecture.md` A10 com risco e plano B, desligável por
  configuração (`runner.privateAllowed`), e com o sim do dono para aquele uso (❓ Q-5). Inclui o
  código de spike que a usa.
- **Nada da ferramenta aparece no vídeo entregue** (`review.mp4`, `final.mp4`; HC-6): sem
  sobreposição, sem o hospedeiro/runner em primeiro plano entre o início e o fim da gravação, sem
  som do Mac na trilha gravada. Única exceção, só no arquivo bruto `recording.mp4`: as marcas "Sync
  Flash" do OBS no pré-rolo e no pós-rolo de calibração, que são aparadas (❓ Q-16).
- O vídeo final cumpre o pedido da App Review: aparelho físico, iOS conforme ❓ Q-11, começa na tela
  de início, uma tomada contínua sem cortes dentro das cenas (HC-10). Aparar o pré-rolo e o pós-rolo
  de calibração (antes da cena 1 e depois da última) não é corte dentro de cena (❓ Q-16).
- Durante uma tomada o runner não chama `launch()` no app alvo, não aperta botões de volume
  (mostram o HUD; os dois juntos encerram a automação), não abre links e nunca é religado (religar
  o põe na frente da tela); o projeto do runner nunca contém alvo com o bundle id do app alvo (o
  XCTest o reinstalaria por cima do build do TestFlight).
- Ferramenta de desenvolvimento, nunca distribuída (NG-7); código copiado do WebDriverAgent leva o
  aviso BSD-3.

## P-5 — Custo e qualidade

- Custo monetário zero por padrão: nenhum serviço pago na v1.
- **Sincronia evento × vídeo ≤ ±100 ms** (SM-2) é requisito, medido em toda tomada final; uma
  tomada fora da meta é marcada e não é entregue sem o sim do dono.
- **Conferir o disco antes de gravar** (inclusive em spike) e abortar abaixo do limite (HC-11).
- Testes: Mac com `node:test`; aparelho com testes unitários XCTest/`swift test` para o que não
  depende de tela (parser de coreografia, relógio, protocolo). Toda AC vira ao menos um teste ou,
  quando só o aparelho real prova, um procedimento de verificação registrado em `tasks.md` com o
  resultado.

## P-6 — Processo

- Depois de ratificado (FROZEN), `spec.md` só muda via G1; enquanto DRAFT, edições diretas são
  livres (contrato). `architecture.md` e `tasks.md` são atualizados conforme as tarefas terminam.
  Uma tarefa por sessão. Critérios de aceite em Given/When/Then → testes. O que estiver no código e
  não na seção da spec é DRIFT — sinalizar.
- Documentos em **português**; identificadores de código, endpoints, comandos, campos de arquivo e
  nomes de arquivo em **inglês**; rótulos da interface do iOS e do app citados em inglês (o iPhone
  grava em inglês).
- Toda ação no iPhone real durante a implementação é anunciada antes e nunca toca em Ajustes de
  segurança, conta Apple ou credenciais. São G5: a primeira instalação do runner/hospedeiro no
  iPhone e a instalação de um build novo deles (um `runner up` de build já aprovado não é);
  desinstalar; e qualquer escrita na configuração do OBS do dono.
- A ferramenta cria e usa **perfil e coleção de cenas próprios no OBS** ("Contrarregra"; ❓ Q-3); nunca
  escreve no perfil/cenas que o dono já tem e confere o perfil ativo antes de cada escrita.
- Decisões já tomadas na análise anterior (ADR-1…ADR-8) só se reabrem com motivo forte registrado e
  G1.

## P-7 — Lista do "não fazer"

Não digitar nem ler credenciais, nem pedir senha ao dono · não contornar Face ID ou código do iPhone
físico (a simulação de biometria do próprio Simulador é permitida no ensaio) · não usar certificado
de outro time · não ler o conteúdo da `.p8` · não pôr segredo, vídeo, captura de tela ou perfil de
provisionamento no git · não instalar nada no app alvo nem pedir build especial dele (salvo o build
Release de simulador do ensaio, P-4) · não deixar o runner escutar fora do loopback (❓ Q-13) nem
anunciar Bonjour · não operar apps ou links fora da lista permitida · não mostrar nada da ferramenta no vídeo
entregue · não apertar botões de volume, chamar `launch()`, abrir links nem religar o runner durante
a tomada · não tocar som no iPhone para avisar o dono (iria para a gravação) · não tocar avisos num
dispositivo de som que o OBS grava (BlackHole, Multi-Output, Aggregate) · não gravar com o disco
abaixo do limite · não escrever no perfil/cenas do OBS do dono nem ler o `config.json` do
obs-websocket (tem a senha) · não usar API privada fora do módulo `PrivateXCT` · não usar o ffmpeg do
PATH · não editar o vídeo além da mixagem e do corte do pré/pós-rolo · não publicar o vídeo.
