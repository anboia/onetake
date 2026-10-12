# Contrarregra — Tarefas (atômicas, executáveis por agente)

> **Status:** `- [ ]` não começada · `- [~]` em andamento · `- [x]` feita · sufixo `[P]` = pode
> rodar em paralelo com as irmãs (arquivos disjuntos, sem cadeia de dependência e sem disputar o
> iPhone ou o runner).
> **Chaves:** **Files:** caminhos tocados · **AC:** critérios de `spec.md` atendidos (num spike,
> *medidos*; `—` = nenhum; "parcial" diz a parte medida) · **Done:** definição objetiva de pronto ·
> **Deps:** tarefas antes (`—` = nenhuma) · **Implements:** ids da spec/requisitos. Cada tarefa cabe
> em ≲ 1 h de agente (esperas de gravação e de longa duração no aparelho não contam).
>
> Só a **Fase 0** está escrita por inteiro (projeto novo: `spec-intake`, modo de criação do zero). As
> fases seguintes têm só o cabeçalho; a `spec-implement` gera as tarefas delas **depois** da
> ratificação (G1), já com os resultados dos spikes.

## Capacidade

| Item | Valor |
|---|---|
| Quem constrói | sessões do Claude Code, **uma tarefa por sessão** (P-6); ⚠️ ~6 tarefas por dia útil quando encadeadas |
| Quem precisa estar no aparelho | o dono: cabo, Face ID, código, Settings, OBS. ⚠️ Fase 0: ~4 janelas de 2 h em ~8 dias úteis; depois, 2 janelas por semana |
| Aparelhos | um iPhone 12 (iOS 26.3 hoje; ✅ Q-11) e um MacBook Air M4 16 GB; ~8,7–10 GiB livres no disco (✅ Q-14) |
| Calendário | feriados no período: 2026-10-12 e 2026-11-02 (segundas), 2026-11-20 (sexta) |
| Congelamento | sem atualizar iOS, Xcode ou OBS durante a produção (P-1, ADR-16); atualizar = G1 e refazer SP-1…SP-7 |

**Estimativa de três pontos** em dias úteis. **Convenção: D+n = n.º dia útil, contando o dia do G1
como o 1.º.** Datas com o G1 em 2026-10-06, uma terça-feira (se o congelamento for noutro dia,
deslocar):

| Fase | Otimista | Provável | Pessimista | Fim provável |
|---|---|---|---|---|
| 0 — Fundação e spikes | 5 | 8 | 12 | 2026-10-16 (D+8) |
| 1 — Esqueleto ambulante | 2 | 3 | 4 | 2026-10-21 (D+11) |
| 2 — Runner, transporte e exploração | 2 | 3 | 5 | 2026-10-26 (D+14) |
| 3 — Coreografia, execução, pontos de controle, guia | 3 | 4 | 6 | 2026-10-30 (D+18) |
| 4 — Gravação, sincronia e saídas | 3 | 4 | 6 | 2026-11-06 (D+22) |
| 5 — Pré-voo, preparo e **tomada do Hagah** | 2 | 3 | 5 | **2026-11-11 (D+25)** |
| 6 — MCP completo e passo a partir da exploração | 1 | 2 | 3 | 2026-11-13 (D+27) |
| 7 — Ensaio no simulador | 1 | 2 | 3 | 2026-11-17 (D+29) |
| 8 — Cabine de narração (✅ Q-6) | 1 | 2 | 3 | 2026-11-19 (D+31) |
| 9 — Endurecimento | 1 | 2 | 3 | 2026-11-24 (D+33) |

Até a tomada do Hagah: **17 / 25 / 38 dias úteis**. **Sinal de atraso** geral: se a Fase 0 passar de
12 dias, ou um spike bloqueador (SP-1, SP-2) cair no plano B mais caro, refazer a estimativa e levar
ao dono (a revisão do Hagah espera a ferramenta, ✅ Q-10).

## Antes da Fase 0 — o que só o dono faz

Lista completa, com os rótulos em inglês do iOS e os valores anteriores a anotar, em `deploy.md` D0.
Resumo:
- atualizar o iPhone para o último iOS 26.x (✅ Q-11), liberar ~20 GB no Mac (✅ Q-14) e exportar o
  diário do Hagah (✅ Q-15) — são pré-requisito da primeira assinatura e dos spikes;
- ligar o servidor WebSocket do OBS e guardar a senha no Chaveiro;
- ligar o cabo e aceitar os pedidos de confiança/acessório; Settings do iPhone (Enable UI
  Automation, Auto-Lock "Never", Low Power Mode desligado, atualizações automáticas desligadas,
  teclado sem correção automática, notificações sem pré-visualização);
- instalar o build do TestFlight (✅ Q-1);
- **antes do SP-8 e do SP-10** (que entram e excluem conta no Hagah e apagam o diário local; o
  diário já foi exportado antes da Fase 0, D0.13): conferir o Sign in with Apple em Settings
  (D0.14). Todo passo em Settings › [nome] (conta Apple) é feito **pelo dono, à mão** — nunca pelo
  runner nem pelo agente;
- atualizar o Claude Code para ≥ 2.1.283;
- no repositório do Hagah (ou numa sessão do Hagah): corrigir o roteiro pelos rótulos de `spec.md`
  S13 item 2 e, **até o SP-16 (T-0.36)**, gerar o build de simulador (`deploy.md` D3.5).

Se a primeira subida do runner mostrar "Untrusted Developer", confiar no desenvolvedor em Settings ›
General › VPN & Device Management (pela pesquisa, provavelmente não precisa com time pago; o SP-12
confirma).

## Fase 0 — Fundação e spikes

**Objetivo:** o mínimo de código para medir no aparelho, e a resposta (principal ou plano B) para
cada risco que a spec não pôde verificar. · **Seções:** S0, partes de S1, S2, S7, S8, S9 · **Critério
do portão:** todos os spikes (SP-1…SP-18) com `spikes/SP-n.md` preenchido
(medida, critério, decisão principal/B); nenhum bloqueador sem caminho; `architecture.md` A10/A11
atualizados; Q-5 (d, f), Q-8, Q-9, Q-12, Q-13 respondidas; qualquer mudança de comportamento levada
a G1 · **Data-alvo:** D+8 · **Sinal de atraso:** SP-1 ou SP-2 falhando nos dois caminhos.

**Fundação**
- [x] **T-0.1** Esqueleto do repositório do Mac: `package.json` (`"type": "module"`, `engines.node
  ">=22.18 <23"`, scripts `test` e `typecheck`), `tsconfig.json` (`noEmit`, `allowImportingTsExtensions`,
  `erasableSyntaxOnly`, `verbatimModuleSyntax`, `module: nodenext`, `target: esnext`), `.gitignore`
  (`ios/*.xcodeproj`, `.build/`, `node_modules/`, `*.mp4`, `*.mov`, `*.wav`, `*.aiff`, `*.aif`,
  `*.m4a`, `*.caf`, `*.png`, `*.jpg`, `*.jpeg`, `*.heic`, `*.xcresult`, `*.xctestrun`, `*.log`,
  `*.ndjson`, `*.p8`, `*.p12`, `*.mobileprovision`, `*.cer`, `spikes/sp-*/out/`), shims
  `bin/contrarregra` e `bin/contrarregra-mcp` (Node 22.x ≥ 22.18; preferem o nvm, recusam o
  Homebrew 26), `config/defaults.json` (nada do Hagah), `mac/src/core/{config,errors}.ts`. Files: os
  listados + `mac/test/core.config.test.ts`. AC: AC-0.5. Done: `node --test` verde; o shim sai em
  ≤ 1 s com Node fora de 22.x ≥ 22.18 (E-8.1); um `config.json` com outro time sai com `E_CONFIG`
  (o `typecheck` só fica verde na T-0.2, depois do G2 do `typescript`). Deps: —. Implements: S0.1, S8
  item 7, P-1, P-3, ✅ Q-4.
- [x] **T-0.2** Gate G2 da primeira leva de dependências: `@modelcontextprotocol/server@2.3.0`
  (traz `@modelcontextprotocol/core` e `zod` 4), `yaml`, XcodeGen 2.45.4 (Homebrew, já instalado,
  fixado por `minimumXcodeGenVersion`); dev: `typescript`, `@types/node`, `@modelcontextprotocol/client`.
  Files: `package.json`, `package-lock.json`. AC: —. Done: G2 emitido e respondido; lockfile gerado
  só com o aprovado; `npm run typecheck` verde. Deps: T-0.1. Implements: P-2, A1.
- [x] **T-0.3** Esquemas de S0 em zod (config, Point, Target com a regra de seletor primário,
  Condition, Choreography fonte e compilada, envelope e métodos de base do RPC, Event, `events.json`,
  TakeManifest, relatórios), serialização JCS (RFC 8785), fixtures compartilhadas em
  `mac/test/fixtures/protocol/` e o servidor WebSocket de teste escrito à mão (sem dependência).
  Files: `mac/src/core/{schema,types,jcs}.ts`, `mac/test/schema.test.ts`, `mac/test/fixtures/**`,
  `mac/test/helpers/ws-server.ts`. AC: AC-0.1, AC-0.3, AC-0.4, AC-0.6 (lado TypeScript), AC-0.7. Done:
  testes verdes com casos válidos e inválidos de cada tipo; o servidor de teste aceita e fecha
  conexões. Deps: T-0.2. Implements: S0.
- [x] **T-0.4** Projeto iOS: `ios/project.yml` (XcodeGen; `DEVELOPMENT_TEAM 984PNJZ8B9`; assinatura
  automática; alvos `ContrarregraHost` e `ContrarregraRunner`; configuração `Spike` que compila
  `ios/ContrarregraRunner/Spikes/` e os métodos `spike.*` só nela), pacote `ios/ContrarregraKit`
  (modelos de S0, codec JSON-RPC, JCS, código do relógio de S0.10, testes `swift test` lendo
  `mac/test/fixtures/protocol/`), hospedeiro com a tela do relógio de calibração. **Q-3 respondida
  antes; G5 na primeira assinatura** (`-allowProvisioningUpdates` cria App IDs e perfis no time).
  Files: `ios/project.yml`, `ios/ContrarregraHost/**`, `ios/ContrarregraKit/**`,
  `ios/ContrarregraRunner/RunnerTests.swift`. AC: AC-0.6 (lado Swift), AC-0.8 (parte: o Kit codifica
  e desenha o código), AC-1.14. Done: `xcodegen generate` + `xcodebuild build-for-testing
  -destination 'generic/platform=iOS'` com exit 0; um único `*.xctestrun`; `xcodebuild
  -showBuildSettings` de cada alvo: todo `PRODUCT_BUNDLE_IDENTIFIER` começa com
  `app.kifactory.contrarregra` e nenhum é `app.kifactory.hagah`; `codesign -dvv` do hospedeiro e do
  `.xctrunner` com `TeamIdentifier=984PNJZ8B9` e `Authority=Apple Development: Andre Saboia
  (6NKUX5CX7G)`; `security find-identity -v -p codesigning` igual antes e depois; `swift test`
  verde. Deps: T-0.2, T-0.3. Implements: S1 item 1, S0.10, A2, A5, P-3, ✅ Q-3.
- [x] **T-0.5** Núcleo do runner: no Kit, roteador, autenticação por token, controlador único e
  agenda das duas filas (testáveis com `swift test`); no runner, `testServe` (faz `press(.home)` e
  só então abre o servidor), `NWListener` WebSocket no loopback na porta da configuração (no build
  `Spike`, `CONTRARREGRA_BIND=loopback|endpoint`), `session.hello`, `health`, `clock.ping` na
  conexão `sync` (fora da main thread; `pad` até 64 KB), `runner.capabilities` (sondagem de
  PX-1…PX-6 só lendo símbolos, mais `CONTRARREGRA_PRIVATE`), prazos por comando. Files:
  `ios/ContrarregraRunner/RunnerTests.swift`, `ios/ContrarregraRunner/{Server,Log}/**`,
  `ios/ContrarregraRunner/PrivateXCT/Probe.swift`, `ios/ContrarregraKit/**`. AC: — (as do aparelho
  passam na T-0.11). Done: `xcodebuild build-for-testing` exit 0; `swift test` cobre roteador,
  autenticação, controlador único e a agenda das filas com um cliente em processo. Deps: T-0.4.
  Implements: S1 itens 2, 3, 9; S2 item 3.
- [ ] **T-0.6** Superfície do runner para os spikes (1/3) — **leitura e lista permitida**:
  `screen.shot`, `ui.tree`, `ui.find` (resolução de `Target` de S0.2, inclusive `within`, `below`,
  `above`, `index` e `fallback`), `ui.ocr` (Vision) e o seletor `ocr`; a lista permitida de S1 item 11
  (com `app.explore`, ações × leituras, regras do SpringBoard, da tela travada e da folha `authkit`),
  usada também pelas T-0.7 e T-0.8. Caminho público. Files:
  `ios/ContrarregraRunner/{Driver,OCR,Server}/**`, `ios/ContrarregraKit/**`. AC: — (medidas nos
  spikes). Done: `xcodebuild build-for-testing` exit 0; testes unitários (sem tela) da resolução de
  alvos sobre árvores de fixture e da lista permitida. Deps: T-0.5. Implements: S0.2, S0.6, S1 itens
  4 (leitura), 6, 11.
- [ ] **T-0.7** Superfície do runner para os spikes (2/3) — **ações**: `ui.tap`, `ui.doubleTap`,
  `ui.longPress`, `ui.drag`, `ui.scrollTo`, `ui.type` (com as recusas de credencial), pelo caminho
  público; os privados (PX-2, PX-3) ficam para o SP-3, atrás de `CONTRARREGRA_PRIVATE` e só em
  `PrivateXCT`. Files: `ios/ContrarregraRunner/{Driver,Server}/**`, `ios/ContrarregraKit/**`. AC: —
  (medidas nos spikes). Done: `xcodebuild build-for-testing` exit 0; testes unitários das recusas de
  `ui.type` (campo seguro, texto com cara de credencial, tela de autenticação) e da validação de
  `ui.drag`. Deps: T-0.6. Implements: S1 itens 4 (ações), 5.
- [ ] **T-0.8** Superfície do runner para os spikes (3/3) — **aparelho, apps e espera**:
  `device.state` (bloqueio, rede, app em primeiro plano, geometria, texto, aparência),
  `device.home`, `device.press {home}`, `device.wake`, `device.controlCenter`, `device.lock` (PX-1,
  em `PrivateXCT`), `app.activate|terminate|state|openURL`, `wait.for` (avaliação das condições de
  S0.3). Files: `ios/ContrarregraRunner/{Driver,Server,Choreo}/**`,
  `ios/ContrarregraRunner/PrivateXCT/Lock.swift`, `ios/ContrarregraKit/**`. AC: — (medidas nos
  spikes). Done: `xcodebuild build-for-testing` exit 0; testes unitários da avaliação de condições e
  dos prefixos de link. Deps: T-0.7. Implements: S0.3, S1 itens 4, 7, 8, 10.
- [x] **T-0.9** Mac: cliente usbmuxd (`ListDevices`, `Listen`, `Connect`, só `USB`, serial
  normalizado; fixtures com e sem hífen) e repassador em `127.0.0.1:<efêmera>`, testados com um
  usbmuxd falso (socket Unix num diretório temporário, via `usbmux.socketPath`). Files:
  `mac/src/usbmux/**`, `mac/test/usbmux.test.ts`. AC: —. Done: testes verdes: entrada `Network`
  recusada (E-2.2), serial com e sem hífen, `Connect` recusado → `E_RUNNER_DOWN` (E-2.3), aparelho
  ausente → `E_NO_USB` em ≤ 1 s (E-2.1). Deps: T-0.1, T-0.3. Implements: S2 item 2. [P]
- [x] **T-0.10** Mac: cliente JSON-RPC sobre o WebSocket do Node e `contrarregra runner build
  [--configuration Spike]|up [--spike]|down|status|sever` (`.xctestrun` da sessão 0600 com as
  variáveis de S1, sessões velhas apagadas, `xcodebuild` destacado com saída em arquivo,
  `caffeinate`), testados contra o usbmuxd falso, o servidor WebSocket de teste e um `xcodebuild`
  falso. Files: `mac/src/{device,runner,commands,cli}/**`, `mac/test/runner.test.ts`,
  `mac/test/helpers/usbmuxd.ts` e `mac/test/usbmux.test.ts` (só para extrair o usbmuxd falso que a T-0.9 deixou
  nele e importá-lo do helper). AC: —. Done:
  testes verdes: o `.xctestrun` da sessão tem permissão 0600, as variáveis de S1 e as capturas do
  XCTest desligadas (`SystemAttachmentLifetime`/`UserAttachmentLifetime = keepNever`,
  `PreferredScreenCaptureFormat = screenshots`; `-collect-test-diagnostics never` no `xcodebuild`,
  S1 item 9), sessões velhas são apagadas, `runner down` o apaga, o `xcodebuild` nunca recebe pipes.
  Deps: T-0.4, T-0.9. Implements: S2 itens 1, 3, 6–8.
- [ ] **T-0.11** Transporte no aparelho: **G5 antes da primeira instalação do runner e do
  hospedeiro**; o primeiro passo é uma sonda de alcance (`runner up`, um `Connect` e
  `session.hello`): se o `Connect` for recusado com o runner vivo, repetir com o build `Spike` nas duas
  formas de `CONTRARREGRA_BIND` (G5 para instalá-lo); recusado nas duas, a tarefa para e vale o plano B
  do SP-4 (⏳ Q-13 → G1 imediato, `requirements.md` §5) antes de qualquer outro spike no aparelho;
  senão, mede as ACs abaixo.
  Files: `mac/src/{usbmux,device,runner}/**` (só correções que o aparelho mostrar). AC: AC-1.1,
  AC-1.2, AC-1.12, AC-1.13, AC-2.3 (parte: `runner up`/`runner status` sem cabo), AC-2.5, AC-2.7,
  AC-2.9. Done: a sonda passa; `runner up` → `status: up` e as ACs passam; `runner down` apaga o
  `.xctestrun`. Deps: T-0.8, T-0.10. Implements: S2.
- [x] **T-0.12** Mac: cliente obs-websocket próprio (Hello/Identify, autenticação, prazo por pedido,
  rejeitar pendentes ao fechar, guarda do perfil antes de escrever, `GetVersion`, `GetRecordStatus`,
  `StartRecord`/`StopRecord`, `CreateRecordChapter`, `GetStats`, `GetOutputStatus`,
  `GetInputPropertiesListPropertyItems`, lote `SerialFrame`) e `core/secret.ts` (Chaveiro, tipo
  `Secret`). Files: `mac/src/obs/{ws,client}.ts`, `mac/src/core/secret.ts`, `mac/test/obs.test.ts`.
  AC: AC-8.5 (parte do segredo), AC-9.9 (parcial: a guarda do cliente com um OBS falso). Done: teste
  com vetores de autenticação calculados localmente (o exemplo da documentação não é vetor válido);
  busca literal da senha em logs = 0. Deps: T-0.1, T-0.3. Implements: S9 item 2, P-3. [P]
- [ ] **T-0.13** `contrarregra obs setup` idempotente: cria/reconcilia o perfil e a coleção
  "Contrarregra" (S9 item 1) com o dono presente (**G5**), sem tocar no "Untitled"; inclui o
  procedimento de reabrir o OBS no perfil. Files: `mac/src/obs/setup.ts`, `mac/src/commands/obs.ts`,
  `mac/src/cli/**`, `mac/test/obs.setup.test.ts`. AC: AC-9.8, AC-9.10. Done: no OBS real, o perfil
  existe com os parâmetros de S9 e o `basic.ini` do "Untitled" está byte a byte igual. Deps: T-0.10,
  T-0.12. Implements: S9 item 1, P-6.
- [x] **T-0.14** Ajudante de OCR no Mac: `mac/tools/ocr.swift` (Vision e CoreText, frameworks da
  Apple, sem G2), rodado com `xcrun swift`; lê quadros PNG e devolve caixas em JSON; um modo
  `--render-text` gera a imagem de teste (o ffmpeg 8.1.1 fixado não tem `drawtext`). Files:
  `mac/tools/ocr.swift`, `mac/src/media/ocr.ts`, `mac/test/ocr.test.ts`. AC: —. Done: acha "Hagah
  Bible" numa imagem de teste gerada pelo `--render-text` num diretório temporário (nunca no
  repositório). Deps: T-0.1. Implements: A1, A2 (`media`), AC-13.7. [P]
- [x] **T-0.15** Servidor MCP mínimo + `.mcp.json`: `doctor`, `device_status`, `screenshot` (JPEG
  390×844 + caminho do PNG), `ui_tree`, `tap`, com `alwaysLoad` nos ★ e instruções do servidor. Files:
  `.mcp.json`, `mac/src/mcp/**`, `mac/src/commands/**`, `mac/test/mcp.test.ts`. AC: AC-8.1 (parcial:
  os 5 ★ presentes têm `alwaysLoad`; `take_wait` entra na Fase 1). Done: um cliente MCP de teste
  lista e chama as 5 ferramentas contra um runner falso. Deps: T-0.2, T-0.10. Implements: S8.

**Spikes, numerados em ordem de risco** (a ordem de execução segue os `Deps`: o SP-2 roda antes do
SP-1, e o SP-14 antes do SP-6). Cada um escreve `spikes/SP-n.md` com: o que foi medido, números,
critério atingido ou não, decisão (principal ou plano B) e o que muda na spec (se mudar → G1).
Regras comuns:
- código de spike que roda no aparelho fica em `ios/ContrarregraRunner/Spikes/` e nos métodos
  `spike.*` (configuração `Spike`; cada build novo instalado é G5, P-6); chamadas a API privada ficam
  **só** em `ios/ContrarregraRunner/PrivateXCT/`, atrás de `CONTRARREGRA_PRIVATE`, e só rodam com o sim
  do dono para aquele uso (✅ Q-5); o driver do Mac de cada spike fica em `spikes/sp-n/` e usa o
  cliente JSON-RPC de `mac/src/runner` (T-0.10); nada disso vai para produção sem tarefa própria;
- capturas, quadros e gravações de spike vão para `~/Movies/contrarregra/spikes/SP-n/`, nunca para o
  repositório; antes de cada gravação, conferir livre ≥ `max(4 GiB, 3 × estimativa + 2 GiB)` (HC-11)
  e não gravar abaixo; no começo de cada spike que grava, **um** G4 autoriza apagar os arquivos que o
  próprio spike criar nessa pasta, e cada gravação é apagada logo depois de medida, com o nome
  registrado no `SP-n.md`;
- spikes que ligam o modo avião com o runner vivo só rodam com `transportType = wired` pelo
  procedimento do SP-2 (por isso dependem da T-0.17);
- `SP-n.md` registra estrutura e rótulos com nome e e-mail da conta Apple trocados por `<redacted>`;
- todo ffmpeg/ffprobe de spike usa `/opt/homebrew/opt/ffmpeg/bin/{ffmpeg,ffprobe}` 8.1.1, nunca o do
  PATH; o OBS de spike roda no perfil "Contrarregra" (T-0.13);
- um spike no aparelho por vez (um runner, um controlador).

- [ ] **T-0.16** **SP-1 (bloqueador) — aviso "Automation Running" e toques humanos.** Com o runner
  vivo e o OBS (perfil "Contrarregra") capturando o iPhone pelo cabo: gravar 3 min ocioso (telas clara
  e escura); a pessoa abre a Central de Controle e toca o avião, trava e destrava (Face ID + arrasto),
  abre a folha do Sign in with Apple e cancela; repetir com o QuickTime manual. Extrair quadros a 2 fps
  e procurar "Automation Running"/"volume buttons" com o OCR do Mac (T-0.14). Files: `spikes/SP-1.md`,
  `spikes/sp-1/**`. AC: AC-13.8 (parte do aviso). Done: **sucesso** = 0 quadros com o aviso
  em ~360 amostras enquanto ele está visível no aparelho, **e** 100 % dos toques humanos fazem efeito;
  **plano B** = (1) pontos de controle `who: runner` com `steps` em tudo que não é credencial (avião,
  arrasto de destravar); (2) comparar com a Gravação de Tela do iOS; (3) levar ⏳ Q-9 ao dono com os
  quadros. Deps: T-0.11, T-0.13, T-0.14, T-0.17. Implements: HC-6, S1 item 9, S5 item 6.
- [ ] **T-0.17** **SP-2 (bloqueador) — sessão do XCTest × modo avião; forçar o cabo.** Ligar o cabo
  e sondar `devicectl list devices --json-output <arquivo temporário>` a cada 1 s, lendo
  `transportType`/`tunnelState`; se seguir `localNetwork`, o dono, à mão, desliga o Wi-Fi do iPhone
  em Settings por 10 s e religar; medir até `wired` e se continua `wired` por 30 min. Depois: runner
  subido, `health` a 10 Hz, modo avião 60 s ligado/desligado ×10; registrar PID (`devicectl device
  info processes`), vida do `xcodebuild`, maior intervalo, linhas "Exiting due to IDE
  disconnection"; uma vez de propósito em `localNetwork` (controle negativo). Files:
  `spikes/SP-2.md`, `spikes/sp-2/**`. AC: AC-2.2, AC-2.4 (parcial: a leitura do `devicectl` em
  `localNetwork` no controle negativo, sem pré-voo). Done: **sucesso** = `wired` em ≤ 30 s por um
  procedimento documentado e estável por 30 min; 10/10 com o mesmo PID e intervalo ≤ 2 s; o controle
  em Wi-Fi reproduz a morte. **Plano B** = re-assinar o `.xctrunner` sem `Frameworks/XC*`, lançá-lo
  por `devicectl device process launch` e repetir — G5 antes de re-assinar (só com `Apple
  Development: Andre Saboia (6NKUX5CX7G)`) e antes de instalar o `.xctrunner` modificado; `codesign
  -dvv` confere `TeamIdentifier=984PNJZ8B9` e `security find-identity -v -p codesigning` fica igual
  antes e depois; se falhar também, levar ⏳ Q-12 ao dono num G1 imediato (`requirements.md` §5; nada
  que ponha o runner na tela durante a tomada entra antes dele). Deps: T-0.11. Implements: HC-4, S2,
  ADR-10.
- [ ] **T-0.18** **SP-3 (alto) — toques com o app animando.** Pré-condição: PX-2 e PX-3 em
  `runner.privateAllowed` (✅ Q-5b/c). No leitor do Hagah com o Salmo 23 tocando: escolher e registrar
  um botão cujo toque não para o áudio (ex.: "Forward 15 seconds" no Now Playing) e fazer 50 toques
  nele em quatro variantes — (a) `XCUIElement.tap()` público; (b) dentro de
  `_performWithInteractionOptions:` com pular pré/pós; (c) troca do método de quiescência; (d)
  `XCSynthesizedEventRecord` por `eventSynthesizer` — medindo `tDevEndNs − tDevStartNs` e chamada→efeito
  na tela, e procurando "Wait for … to idle" no `xcodebuild.log`. Repetir com o áudio pausado como base.
  Files: `spikes/SP-3.md`, `spikes/sp-3/**`, `ios/ContrarregraRunner/PrivateXCT/{Quiescence,Synthesize}.swift`,
  `ios/ContrarregraRunner/Spikes/**`. AC: AC-1.5, AC-1.18. Done: **sucesso** = pelo menos uma de (b),
  (c), (d) com p95 ≤ 150 ms, p99 ≤ 300 ms e 0 linhas de espera; (a) caracterizada. **Plano B** = (d)
  para todo passo com tempo; se nada servir, pausar o áudio antes dos toques que não precisam dele (G1
  na coreografia do Hagah). Deps: T-0.11. Implements: S1 item 5, A10 PX-2/PX-3, ✅ Q-5b/c.
- [ ] **T-0.19** **SP-4 (alto) — canal usbmux → WebSocket no loopback.** Duas formas de prender o
  listener (`requiredInterfaceType = .loopback`; `requiredLocalEndpoint 127.0.0.1:P`), no build
  `Spike`. 1.000 ecos de 64 bytes e 100 de 64 KB numa conexão persistente e 1.000 com conexão nova;
  100 capturas (com o Hagah em primeiro plano, S1 item 11); rajadas NTP; tudo de novo com o modo
  avião ligado e com capturas simultâneas na outra conexão; registrar o `SerialNumber` cru do
  usbmuxd. Files: `spikes/SP-4.md`, `spikes/sp-4/**`. AC: AC-2.1, AC-2.6 (só a reconexão, sem
  `events.fetch`). Done: **sucesso** = o loopback é alcançável; p50 ≤ 5 ms, p95 ≤ 20 ms; conexão
  nova p95 ≤ 50 ms; desvio do θ ≤ 1 ms; sem mudança com avião.
  **Plano B** = se o loopback não for alcançável por usbmux, parar e levar ao dono ⏳ Q-13 num G1
  imediato (emenda de P-3/P-7 e HC-4); nenhuma escuta fora do loopback antes desse G1. Deps: T-0.11,
  T-0.17. Implements: S2, ADR-9.
- [ ] **T-0.20** **SP-5 (alto) — OBS, parte 1: fonte, áudio e gravação longa.** Quatro configurações
  da fonte (preset High; formato manual 60 fps; "Capture Card"; preset 4K); áudio do iPhone com o
  Salmo 23 tocando (picos, silêncio no alto-falante, sincronia áudio/vídeo); 10 min a 1170×2532@60 com
  H.264 por hardware ABR 16 Mbps (quadros pulados, `ffprobe`, tamanho); OBS aberto antes do cabo e
  "chute"; resolver o `device` pelo `itemName`. Files: `spikes/SP-5.md`, `spikes/sp-5/**`. AC:
  AC-9.3 (parcial: o chute sem pré-voo), AC-9.7. Done: **sucesso** = 1170×2532 sem cor lavada
  (diferença ≤ 3/255 em áreas lisas), picos entre −20 e −3 dBFS, defasagem A/V ≤ ±45 ms, 0 quadros
  pulados, fonte recuperada pelo chute em ≤ 15 s. **Plano B** = HEVC; 30 fps; QuickTime manual. Deps:
  T-0.12, T-0.13. Implements: S9 itens 1, 3 e 6, ADR-4, ADR-14, ⏳ Q-8.
- [ ] **T-0.21** **SP-5 (alto) — OBS, parte 2: capítulos e finalização.** 3 capítulos com títulos
  UTF-8; 30 paradas (10 × 1 min, 10 × 5 min, 10 × 10 min ≈ 19 GB no total, cada arquivo apagado logo
  depois de medido, pela regra comum). Files: `spikes/SP-5.md`, `spikes/sp-5/**`. AC: AC-9.2,
  AC-9.6. Done: **sucesso** = os 3 títulos idênticos no `ffprobe -show_chapters` (mais no máximo o
  capítulo automático em 0, AC-9.2) e 0 falsos prontos (AC-9.6). **Plano B** = QuickTime manual com
  capítulos do FFMETADATA. Deps: T-0.20. Implements: S9 item 5, ADR-4, ⏳ Q-8.
- [x] **T-0.22** Núcleo de relógio e alinhamento para o SP-6 (sem aparelho): NTP com ajuste
  Theil-Sen (S7 item 2), T0 pelas marcas (item 3), detecção por região e ajuste V = α + (1+β)·P com
  o erro deixando um de fora (itens 4–6), decodificador do código de S0.10, e o invólucro do
  ffmpeg/ffprobe fixados (`paths.*`) com extração de quadros. Files: `mac/src/{clock,align}/**`,
  `mac/src/media/{ffmpeg,frames}.ts`, `mac/test/{clock,align}.test.ts`. AC: AC-0.8 (parte: o
  decodificador do Mac); o resto é medido nas T-0.23 e T-0.24). Done: `node --test` verde com dados
  sintéticos: rajadas com deslocamento e deriva plantados e recuperados, vídeos de teste gerados por
  `ffmpeg -f lavfi` num diretório temporário (marcas, mudança de região, código de S0.10 desenhado
  com `drawbox`). Deps: T-0.3. Implements: S0.10, S7 itens 2–6, ADR-15. [P]
- [ ] **T-0.23** **SP-6 (alto) — sincronia ponta a ponta, parte 1: marcas e latência de captura.**
  Com o núcleo da T-0.22, mede: (a) 8 marcas `SerialFrame` no pré-rolo achadas por `signalstats`;
  (b) 10 min do relógio do hospedeiro (S0.10) na tela, decodificado por quadro, com e sem "Use
  Buffering", alternando movimento e 30 s parados → distribuição da latência de captura. Files:
  `spikes/SP-6.md`, `spikes/sp-6/**`. AC: AC-7.2, AC-7.7. Done: **sucesso** = |T0ᵢ − T0| ≤ 17 ms e
  erro padrão de T0 ≤ 3 ms; latência estável ±10 ms com espalhamento p95−p5 ≤ 33 ms; o dono copia a
  mediana da medida sem "Use Buffering" (a fonte de S9 item 1) para `sync.captureLatencyMs` no
  `config.json` (S0.1, D3.1). **Plano B** = desligar buffering; QuickTime. Deps: T-0.11, T-0.12,
  T-0.19, T-0.20, T-0.22, T-0.34. Implements: S7 itens 3, 4 e 7, ADR-15.
- [ ] **T-0.24** **SP-6 (alto) — sincronia ponta a ponta, parte 2: toques reais.** 30 toques reais
  nas cenas 2 e 5, com detecção por região e erro deixando um de fora (S7 item 6), usando o T0 e a
  latência medidos na T-0.23. Files: `spikes/SP-6.md`, `spikes/sp-6/**`. AC: AC-7.3 (método). Done:
  **sucesso** = ≥ 90 % dos toques detectados no quadro certo (±1) e nenhuma detecção mais de 100 ms
  antes da ação; os toques usam o caminho escolhido no SP-3 (`path` registrado em cada um). **Plano
  B** = só alinhamento visual por tomada. Deps: T-0.18, T-0.23. Implements: S7, SM-2.
- [ ] **T-0.25** **SP-7 (médio) — travar, acender e destravar (cena 3).** Com PX-1 liberado (✅
  Q-5a); se a sondagem o der ausente, medir só o ponto de controle humano (botão lateral).
  `pressLockButton` ×10 com leitura de `com.apple.springboard.lockstate` e captura do OBS (nunca
  `screen.shot` com a tela travada); áudio segue tocando; `device.wake` (um `press(.home)` com a
  tela travada, ninguém olhando) mostra os controles da tela travada sem destravar; a pessoa
  destrava com Face ID; medir quando o `lockstate` vira 0 e quando a tela travada sai de fato (vídeo
  alinhado pelo núcleo da T-0.22 com o T0 e a latência da T-0.23); se preciso, o arrasto para cima é
  do `spike.unlockDrag` (só na configuração `Spike`, recusado com `locked: true`) ou do dono; runner
  e captura atravessam travas de 10 s, 60 s e 5 min. Files: `spikes/SP-7.md`, `spikes/sp-7/**`,
  `ios/ContrarregraRunner/PrivateXCT/Lock.swift`, `ios/ContrarregraRunner/Spikes/**`. AC: AC-1.9,
  AC-1.21, AC-1.23 (parcial: `ui.drag` na tela travada com `locked: true` → `E_FORBIDDEN_APP`),
  AC-5.6 (parcial: `lockstate` → 0 × primeiro quadro sem a tela travada, sem ponto de controle).
  Done: **sucesso** = 10/10 travas em ≤ 2 s; `wake` não destrava; destrave detectado em ≤ 1 s depois
  de a tela travada sair; runner e captura sem queda. **Plano B** = evento HID 0x0C/0x30; ou ponto
  de controle humano (botão lateral). Deps: T-0.11, T-0.13, T-0.23. Implements: S1 itens 8 e 11, S5,
  PX-1, ✅ Q-5a.
- [ ] **T-0.26** **SP-8 (médio) — Sign in with Apple no aparelho.** Pré-condições: o dono já fez o
  backup do diário (D0.13) e confere a lista do Sign in with Apple **à mão** (D0.14); nenhum passo em
  Settings da conta Apple é feito pelo runner ou pelo agente. Sem gravar, com a conta do aparelho
  (✅ Q-2): tocar o botão do Hagah e registrar qual processo expõe a folha
  (`com.apple.AuthKitUIService`? SpringBoard?), os rótulos dos botões ("Continue"…) só por
  `ui.find`, quanto tempo a folha leva para aparecer, a variante de primeiro cadastro × conta já
  vinculada, e a sequência da exclusão (alerta → folha de revogação → "Account deleted" → "OK"). Files:
  `spikes/SP-8.md`, `spikes/sp-8/**`. AC: AC-5.1 (parcial: tempo do fim do Face ID à condição pelos
  relógios do aparelho, sem vídeo). Done: **sucesso** = "Continue" achado em ≤ 2 s; o fim de cada
  Face ID detectado pelo lado do Hagah em ≤ 1 s; regra que identifica a variante da folha; procedimento
  de limpeza que devolve a variante de primeiro cadastro. **Plano B** = o dono toca o "Continue" num
  ponto de controle; ou a folha inteira como ponto de controle. Deps: T-0.11. Implements: S5, S13 item
  6, AC-13.6.
- [ ] **T-0.27** **SP-9 (médio) — Central de Controle, modo avião, rede, barra de estado.** 10
  ciclos: arrastar (0,9·0,01 → 0,9·0,2), achar `airplane-mode-button` em ≤ 2 s, ler `value`, tocar,
  conferir a troca, fechar; ler `{network}` com o cabo ligado (deve ir a `offline` com o avião,
  mesmo com o túnel no cabo); com o OBS gravando, ver se a barra de estado mostra 9:41 e se o ícone
  de avião aparece. Files: `spikes/SP-9.md`, `spikes/sp-9/**`. AC: AC-1.15, AC-5.7 (parcial: abrir,
  tocar e fechar pelo runner, sem ponto de controle). Done: **sucesso** = 10/10; `network` correto;
  a prova visual do avião definida. **Plano B** = rótulo "Airplane Mode"; a pessoa toca (o runner
  não toca a Central de Controle por coordenada nem a captura, S1 item 11). Deps: T-0.11, T-0.13,
  T-0.17. Implements: S1 item 7, S0.3, S13 item 7.
- [ ] **T-0.28** **SP-10 (médio) — mapa de alvos e linha do tempo do Hagah no build do TestFlight.**
  Pré-condições: D0.13 e D0.14 feitos. Snapshot de cada tela do roteiro (leitor, seletores,
  Now Playing nas duas alturas, barra de seleção, nota, Diário deslogado e logado, Ajustes, Downloads,
  About, Plano, playlist): rótulo, tipo, frame, `isHittable` dos ~30 alvos (com nome e e-mail
  redigidos); latência de `ui.tree` e `screen.shot` (50×); contagem de "Play"/"Pause"/"Close"; os
  gestos com os limiares do app (inclusive o toque duplo no versículo); duração do Salmo 23 NIV (−m:ss
  do Now Playing) e a linha do tempo do áudio de S13 item 4, seguindo as cenas 2–9 passo a passo pelos
  métodos das T-0.6…T-0.8 (driver em `spikes/sp-10/`) e lendo o rótulo do mini-player e o título da
  folha a cada passo; quanto tempo "Syncing…" fica na árvore numa sincronia por puxar (sondagem de
  100 ms); a nota da cena 6 digitada (`value` idêntico, caracteres por segundo); o dia atual do plano
  por OCR de "CURRENT DAY"; o rótulo da mensagem de capítulo indisponível offline (Habakkuk 3 só aberto
  em modo avião); se o `devicectl device info apps` diz a origem do app (TestFlight × desenvolvedor).
  O catálogo vai direto para `targets:` da coreografia. Files: `spikes/SP-10.md`, `spikes/sp-10/**`,
  `choreographies/hagah/v8.5-review.choreo.yaml`. AC: AC-1.3, AC-1.4. Done: **sucesso** = ≥ 95 % dos
  alvos batem com S13 por `label`/`labelPrefix`; regra de desempate para cada ambíguo; 10/10 por gesto
  e 0 trocas de capítulo; o player nunca mostra o Salmo 24 na sequência das cenas 2–9; se "Syncing…"
  durar menos de 200 ms, a prova da sincronia muda (G1 na coreografia). **Plano B** = âncoras +
  deslocamento; OCR. Deps: T-0.11, T-0.17, T-0.26. Implements: S13.
- [ ] **T-0.29** **SP-11 (médio) — OCR da palavra.** Lente "Word", Salmo 23 NIV pausado, paralelo NVI:
  20 ciclos de OCR na região do versículo 1 + toque em "shepherd", com `RecognizeTextRequest` acurado e
  `RecognizeDocumentsRequest.words`, fechando o painel entre ciclos. Files: `spikes/SP-11.md`,
  `spikes/sp-11/**`, `ios/ContrarregraRunner/Spikes/**`,
  `choreographies/hagah/v8.5-review.choreo.yaml`. AC: AC-1.6. Done: **sucesso** = ≥ 19/20 abrem o
  painel certo, ≤ 700 ms por ciclo, erro de centro ≤ 6 pt; condição do painel registrada no catálogo.
  **Plano B** = posição estimada pelo frame do versículo; OCR no Mac sobre a captura (T-0.14). Deps:
  T-0.11, T-0.28. Implements: S1 item 6.
- [ ] **T-0.30** **SP-12 (médio) — runner de longa duração, parte 1: 4 h e falhas.** 4 h no cabo com
  comandos periódicos (SM-5); 10 falhas induzidas; registrar todo pedido de código de automação e o
  "Untrusted Developer", se aparecer. Files: `spikes/SP-12.md`, `spikes/sp-12/**`. AC: AC-1.11, AC-2.8.
  Done: **sucesso** = 0 religamentos em 4 h; RSS cresce < 100 MB; 1 pedido de código só na subida.
  **Plano B** = subir um runner novo antes de cada tomada; PX-4 só com o sim do dono (⏳ Q-5d, decidido
  na T-0.39). Deps: T-0.11. Implements: S1 item 2, SM-5.
- [ ] **T-0.31** **SP-12 (médio) — parte 2: alertas.** Um alerta de um botão sobre o Hagah com um
  toque num elemento coberto, com e sem PX-5 (PX-5 liberado, ✅ Q-5e), registrando se o XCTest o fecha
  sozinho. Fonte: o alerta "Account deleted" do próprio Hagah, provocado com o dono presente
  repetindo o login e a exclusão do SP-8 (dois Face ID; pré-condições D0.13 e D0.14); se ele não
  servir, o primeiro alerta de um botão que aparecer durante a T-0.30; sem nenhum, a T-0.39 registra
  a variante como não medida. Files: `spikes/SP-12.md`, `spikes/sp-12/**`,
  `ios/ContrarregraRunner/PrivateXCT/Interruptions.swift`, `ios/ContrarregraRunner/Spikes/**`. AC:
  —. Done: **sucesso** = comportamento de alertas documentado com e sem PX-5. **Plano B** = todo
  alerta esperado com `expect` explícito (E-1.4). Deps: T-0.26, T-0.30. Implements: E-1.4, A10 PX-5,
  ✅ Q-5e.
- [ ] **T-0.32** **SP-12 (médio) — parte 3: nada visível.** Ícones do hospedeiro e do runner tirados
  da tela de início e o runner ainda sobe, com os nomes exibidos de verdade (para
  `bundle.displayNames`); uma subida com a captura automática do XCTest ligada × as configurações de
  S1 item 9 (latência p50 de 50 `ui.tap`, indicador na captura do OBS, atividade de gravação no
  registro); tempo até o runner sair da frente. Files: `spikes/SP-12.md`, `spikes/sp-12/**`,
  `ios/ContrarregraRunner/Spikes/**`. AC: AC-1.13, AC-1.20, AC-12.3 (medição). Done: **sucesso** =
  runner fora da frente em ≤ 5 s; nenhum ícone na página do Hagah; sem diferença com a captura
  desligada. **Plano B** = chaves não documentadas de captura (A10), só com o sim do dono no G1 da
  T-0.39. Deps: T-0.11, T-0.13. Implements: S1 item 9, SM-6.
- [ ] **T-0.33** **SP-13 (médio) — limites do Claude Code no MCP.** Protótipo de `take_start` +
  `take_wait` com supervisor destacado e vigia (tomada simulada de 15 min, sem simulador nem
  aparelho, 3 pontos de controle, MCP morto no meio, supervisor morto no meio); capturas JPEG
  390×844 × 40 (tamanho, avisos, acerto em 5 alvos); servidor iniciado pelo app de desktop e pelo
  terminal (qual Node); leitura do Chaveiro depois de dormir; três avisos sonoros com o OBS gravando
  e o iPhone em silêncio. Files: `spikes/SP-13.md`, `spikes/sp-13/**`. AC: AC-8.2, AC-8.3, AC-8.4
  (parcial: protótipo sem simulador), AC-8.9 (parcial: OBS real e runner falso), AC-5.3 (medição).
  Done: **sucesso** = todos os números das ACs. **Plano B** = tomada pela CLI em segundo plano e MCP
  só lendo arquivos. Deps: T-0.11, T-0.13, T-0.15, T-0.22. Implements: S8, ADR-11.
- [ ] **T-0.34** **SP-14 (baixo) — deriva do relógio.** Rajadas de 32 trocas a cada 10 s por 20 min
  (como S7); ajuste linear; comparar só-pré, pré+pós e completo. Files: `spikes/SP-14.md`,
  `spikes/sp-14/**`. AC: AC-7.1. Done: resíduo RMS ≤ 1 ms; erro de pré+pós no meio ≤ 2 ms. **Plano B**
  = rajadas durante a tomada obrigatórias. Deps: T-0.19, T-0.22. Implements: S7.
- [ ] **T-0.35** **SP-15 (baixo) — ritmo da guia.** O dono lê as falas das cenas 1, 4 e 8 (calibração)
  e 2, 6 e 10 (verificação), gravando num gravador qualquer, com os WAVs em
  `~/Movies/contrarregra/spikes/SP-15/`, ou com `paths.ffmpeg -f avfoundation` (Microfone liberado,
  `deploy.md` D0.3); sintetizar as mesmas com Samantha, Daniel e Reed; aplicar `atempo =
  targetWpm/wpmMedido` e comparar. Files: `spikes/SP-15.md`, `spikes/sp-15/**`. AC: AC-6.1, AC-6.2.
  Done: erro previsto × lido ≤ 10 % nas três cenas de verificação. **Plano B** = permanência =
  palavras ÷ wpm do dono. Deps: T-0.1. Implements: S6. [P]
- [ ] **T-0.36** **SP-16 (baixo) — simulador.** Build do runner para simulador (`build-for-testing
  -destination 'generic/platform=iOS Simulator'`) e transporte pelo loopback do Mac; build Release de
  simulador do Hagah (D3.5, entregue pelo dono ou por uma sessão do Hagah); `simctl io recordVideo`
  (quadros variáveis? áudio?); mesmos rótulos que no aparelho. Files: `spikes/SP-16.md`,
  `spikes/sp-16/**`. AC: AC-11.3 (método). Done: erro de mapeamento ≤ 17 ms em `pts_time`; diferenças
  de rótulo listadas. **Plano B** = ensaiar no aparelho sem gravar (`--mode dry`, quando existir).
  Deps: T-0.22, T-0.28. Implements: S11.
- [ ] **T-0.37** **SP-17 (baixo) — puxar o registro e abrir link.** `devicectl device copy from
  --domain-type appDataContainer --domain-identifier <runner>.xctrunner` com o runner vivo e parado;
  `XCUIDevice.shared.system.open(hagah://bible/ENGNIV/PSA/1)` pelo runner (mesmo PID do Hagah? pede
  confirmação?). Files: `spikes/SP-17.md`, `spikes/sp-17/**`. AC: —. Done: arquivo idêntico em ≤ 5 s nos
  dois estados; comportamento do link documentado. **Plano B** = `events.fetch` pelo canal; preparo só
  pela UI. Deps: T-0.11. Implements: S4 item 4, S12 item 2.
- [ ] **T-0.38** **SP-18 (baixo; ✅ Q-6) — cabine.** Laço de 10 cliques no Chrome
  (AudioWorklet) e com `ffmpeg -f avfoundation` (caminho fixado), fone com fio e alto-falante
  embutido; Microfone liberado ao Chrome e ao processo que roda o ffmpeg (`deploy.md` D0.3). Files:
  `spikes/SP-18.md`, `spikes/sp-18/**`. AC: AC-10.8. Done: p95 ≤ 20 ms depois de uma calibração.
  **Plano B** = só ffmpeg + palma. Deps: T-0.1. Implements: S10 item 3. [P]
- [ ] **T-0.39** Consolidar a Fase 0: atualizar `architecture.md` A10/A11 com o caminho escolhido
  por spike; levar ao dono, num G1, Q-5 (d, f), Q-8, Q-9 e, se ainda não decididas num G1 imediato
  (`requirements.md` §5), Q-12 e Q-13, com os números; emitir G1 para cada mudança de comportamento
  que os spikes exigirem (ex.: pontos de controle `who: runner`, pausas de áudio na coreografia do
  Hagah, variante da folha em AC-13.6, prova da sincronia); atualizar as estimativas desta página e
  `bundle.displayNames` e, se o SP-12 parte 3 cair no plano B, levar as chaves de captura de A10 ao
  dono (uso novo de Q-5). Files: `spec/architecture.md`, `spec/tasks.md`, `config/defaults.json`,
  `spec/constitution.md`, `spec/spec.md` e `spec/requirements.md` (só via G1). AC: —. Done: todo
  spike aplicável com decisão; G1 respondidos. Deps: T-0.16…T-0.38. Implements: P-6.

## Fase 1 — Esqueleto ambulante
**Objetivo:** a fatia mais fina por todas as camadas: coreografia de uma cena (cena 1 do Hagah: tela
de início → toque no ícone → abertura) compilada, carregada e executada no aparelho; OBS grava com
pré-rolo, marcas e um capítulo; `events.json`, `.srt` e `review.mp4` saem alinhados; acionada pela
CLI e por `take_start`/`take_wait` no MCP, com supervisor e vigia. · **Seções:** fatias de S1, S2,
S3, S4, S6, S7, S8, S9, S10 · **Portão:** AC-0.6; uma tomada de uma cena gera `review.mp4` com
capítulo e legenda, e `sync.json` calculado (método `calibrated` aceito, S7 item 6) · **Data-alvo:**
D+11 · **Sinal de atraso:** integração OBS↔runner > 2 dias.

## Fase 2 — Runner, transporte e exploração
**Objetivo:** todas as operações de S1 e o transporte de S2 completos; ferramentas MCP de
exploração. · **Seções:** S1, S2, S8 (exploração) · **Portão:** AC-1.1…AC-1.24 (AC-1.24 só a parte
do aparelho; a do simulador vai à Fase 7), exceto AC-1.5 se o SP-3 cair no plano B, AC-1.9 e AC-1.21
se o SP-7 cair no plano B, e AC-1.8 e AC-1.23 (Fase 3, que traz as seções da coreografia e os pontos
de controle); AC-1.10 e AC-1.18 sempre; AC-2.1…AC-2.3, AC-2.5…AC-2.9 (AC-2.4 e AC-2.10 dependem do
pré-voo: Fase 5); AC-8.1…AC-8.3 · **Data-alvo:** D+14 · **Sinal de atraso:** APIs privadas exigindo
mais que PX-1…PX-6.

## Fase 3 — Coreografia, execução, pontos de controle e guia
**Objetivo:** formato completo, executor com prazos absolutos, espera de alvo, blocos e repetição,
pausas/retomadas, pontos de controle com aviso, faixa-guia. · **Seções:** S0.4, S3, S4, S5, S6 ·
**Portão:** AC-0.2, AC-0.3, AC-0.7, AC-1.8, AC-1.23, AC-3.1…AC-3.4, AC-3.8, AC-4.1…AC-4.10,
AC-5.1…AC-5.7, AC-6.1…AC-6.4 (AC-6.2 como procedimento com o dono) · **Data-alvo:** D+18 · **Sinal de
atraso:** atraso de prazo p95 > 20 ms.

## Fase 4 — Gravação, sincronia e saídas
**Objetivo:** OBS completo (guarda de perfil, guarda de disco, finalização), alinhamento em três elos
com erro deixando um de fora, legendas, capítulos, tabela, `review.mp4`, mixagem. · **Seções:** S7,
S9, S10 (sem cabine) · **Portão:** AC-0.8, AC-7.1…AC-7.3, AC-7.6, AC-7.7, AC-8.5, AC-9.1, AC-9.2,
AC-9.5…AC-9.10, AC-10.1…AC-10.7 · **Data-alvo:** D+22 · **Sinal de atraso:** SM-2 fora da meta em
duas tomadas seguidas.

## Fase 5 — Pré-voo, preparo e a tomada do Hagah
**Objetivo:** pré-voo, `prepare`/`cleanup`, `takes prune` (✅ Q-14), a coreografia das 10 cenas e a
tomada final entregue ao dono. · **Seções:** S12, S13, S8 item 5 · **Portão:** AC-2.4, AC-2.10,
AC-7.4, AC-8.9, AC-9.3, AC-9.4, AC-12.1…AC-12.9, AC-13.1…AC-13.10 (AC-13.8 como procedimento com o
dono); SM-1, SM-2, SM-3, SM-6, SM-7 medidos numa tomada real · **Data-alvo:** D+25 (2026-11-11 com o
G1 em 2026-10-06) · **Sinal de atraso:** uma cena precisando de intervenção não planejada em duas
tomadas.

## Fase 6 — MCP completo e passo a partir da exploração
**Objetivo:** todas as ferramentas de S8, `record_step`, paridade CLI/MCP. · **Seções:** S8, S3 item
4 · **Portão:** AC-8.6 (exceto `rehearse_start`/`rehearse --detach`: Fase 7), AC-8.7, AC-8.8
(procedimento), AC-3.5, AC-3.6; SM-4 · **Data-alvo:** D+27.

## Fase 7 — Ensaio no simulador
**Objetivo:** a mesma coreografia no simulador, com gravação e saídas. · **Seções:** S11 ·
**Portão:** AC-11.1…AC-11.4, AC-1.24 (parte do simulador), AC-8.6 (parte de `rehearse_start`),
AC-3.7, AC-7.5, AC-8.4 · **Data-alvo:** D+29.

## Fase 8 — Cabine de narração (✅ Q-6)
**Objetivo:** página local que toca o vídeo com as falas e grava o microfone sincronizado. ·
**Seções:** S10 item 3 · **Portão:** AC-10.8, AC-10.9 · **Data-alvo:** D+31.

## Fase 9 — Endurecimento
**Objetivo:** longa duração (SM-5), mensagens de erro acionáveis, `doctor` completo, procedimentos de
`deploy.md` automatizados, limpeza de capturas antigas. · **Seções:** todas ·
**Portão:** AC-2.8; `doctor` cobre cada falha da lista de PF · **Data-alvo:** D+33.
