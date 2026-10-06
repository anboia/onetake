# Contrarregra — Arquitetura

> Viva: descreve o COMO planejado e passa a descrever o construído conforme as tarefas terminam.
> Nada aqui existe ainda (2026-10-02). As afirmações técnicas têm fonte em A12 e nas notas de
> `research/`; o que não pôde ser verificado sem o aparelho está ligado a um spike (SP-n, `tasks.md`
> Fase 0).

## A1. Stack (uma linha de razão cada)

**Aparelho (Swift)**
- **XCTest / XCUIAutomation público (Xcode 26.6)** — único caminho sancionado para tocar noutro app
  num iPhone real; desde o Xcode 16.3 a automação de UI mora no framework `XCUIAutomation`, toda
  classe é `@MainActor`.
- **Módulo `PrivateXCT`** (Swift + shims Objective-C) — isola as poucas APIs privadas sem
  alternativa pública (A10), com sondagem na subida, liberação uso a uso (`runner.privateAllowed`) e
  plano B público.
- **Network.framework (`NWListener` + `NWProtocolWebSocket`)** — servidor WebSocket sem
  dependência, preso ao loopback; escutar TCP não pede permissão de rede local, Bonjour pediria.
- **Vision (`RecognizeTextRequest`, nível acurado, caixa por palavra)** — tocar texto que não é
  elemento da árvore.
- **XcodeGen 2.45.4 (`ios/project.yml`)** — o SwiftPM não gera bundle de UI test; um YAML de ~60
  linhas é editável por agente, e o `.xcodeproj` gerado fica fora do git. Já instalado; entra no G2
  da Fase 0 como ferramenta de build.
- **Pacote Swift `ContrarregraKit`** — modelos de S0, JSON-RPC, código do relógio de calibração e
  matemática de relógio, testados com `swift test` no Mac, sem XCTest de UI.

**Mac (TypeScript)**
- **Node 22.x (≥ 22.18) rodando `.ts` direto (type stripping)** — ecossistema do dono, zero etapa de
  build; confirmado no Node 22.19 instalado; o Node 26 do Homebrew é recusado (P-1).
- **`@modelcontextprotocol/server` 2.3.0 (SDK v2, fixado)** — v2 é a linha estável desde
  2026-07-27, traz só `core` + `zod` 4 (a v1 puxa express, hono, jose…). Gate G2 na Fase 0.
- **`yaml` (eemeli, ISC)** — ler a coreografia; o Node não tem YAML nativo. Gate G2; plano B: JSON.
- **Cliente usbmuxd próprio (~250 linhas)** — nenhuma biblioteca npm mantida tem `Listen` sem
  arrastar dezenas de dependências; o protocolo é pequeno e verificado.
- **WebSocket nativo do Node 22** (estável desde 22.4) — para o runner (via repassador local) e para
  o obs-websocket; sem `ws` nem `obs-websocket-js`; o servidor WebSocket dos testes é escrito à mão.
- **`node:test`, `util.parseArgs`, `fs.statfs`, `/usr/bin/security`, `say`, `afplay`** — tudo
  embutido; `typescript`, `@types/node` e `@modelcontextprotocol/client` só como dev.
- **Ajudante de OCR do Mac (`mac/tools/ocr.swift`, Vision)** — o Node não chama o Vision; o
  ajudante, rodado com `xcrun swift`, lê quadros do vídeo para as checagens de S7/S13 e para o plano
  B do OCR no aparelho. Framework da Apple, sem G2.

**Mídia**
- **OBS 31.1.2 + obs-websocket 5.6.2 (rpc 1)** — ADR-4; Hybrid MP4 com capítulos; perfil próprio.
- **Por que o OBS e não o ffmpeg para capturar o iPhone**: a tela do iPhone pelo cabo é um
  dispositivo CoreMediaIO "muxed" (vídeo + áudio) que só aparece no processo que liga
  `kCMIOHardwarePropertyAllowScreenCaptureDevices = 1` (por processo; WWDC14 #508). O ffmpeg nunca
  liga esse opt-in (nem tem opção para isso) e, mesmo com ele, só leria o vídeo — o áudio "muxed" não
  é lido. O OBS 31.1.2 faz o opt-in nos dois plugins `mac-avcapture` e captura vídeo e áudio do
  iPhone. Um eventual plano C em Swift (como o `DeviceVideo.swift` do idb) faz o opt-in uma vez, sem
  alternar, e espera até 15 s pelo aparelho.
- **ffmpeg/ffprobe 8.1.1** em `/opt/homebrew/opt/ffmpeg/bin` — o do PATH é o 4.4.7 (`ffmpeg@4`),
  cujo `ffprobe` não tem `pts_time`; caminhos fixados na configuração e versão conferida (P-1).
- **`say` do macOS** — faixa-guia grátis e local (ADR-6).

## A2. Fronteiras de módulos

**Aparelho** (`ios/`)

| Módulo | Faz | Pode importar | Nunca importa |
|---|---|---|---|
| `ContrarregraKit` | tipos de S0, codec JSON-RPC, roteador, autenticação, controlador único, agenda das duas filas, relógio, código de calibração, validação da coreografia (tudo testável com `swift test`) | Foundation | XCTest, UIKit |
| `Server` | adaptador fino do `NWListener`/conexões sobre o roteador do Kit; despacha para a fila do XCTest | Kit | `PrivateXCT` |
| `Driver` | apps, consultas/árvore, toques públicos, digitação (com recusas), captura, SpringBoard, lista permitida | Kit, XCUIAutomation | símbolos privados |
| `PrivateXCT` | sondagem, travar, quiescência, evento sintetizado, falha à prova, alertas, captura privada | Kit, ObjC runtime | — (é o único com seletores privados) |
| `OCR` | achar texto/palavra numa captura | Kit, Vision | — |
| `Choreo` | executor, agendador, espera de alvo, blocos, condições, pontos de controle | Kit, protocolos do `Driver` | `Server` |
| `Log` | eventos em memória + `events.ndjson` no contêiner | Kit | — |
| `Spikes` | código de medição e métodos `spike.*`, só na configuração `Spike` | Kit, `Driver`, `PrivateXCT` | — |
| `ContrarregraHost` | app mínimo: só a tela de relógio de calibração (S0.10) | UIKit, Kit | runner |

O `Driver` expõe protocolos (`Toucher`, `Locker`…); as implementações privadas de `PrivateXCT`
entram por injeção quando a sondagem confirma e `CONTRARREGRA_PRIVATE` permite.

**Mac** (`mac/src/`)

| Módulo | Faz | Regra |
|---|---|---|
| `core` | config, tipos (espelho de S0), esquemas zod, erros, `Secret`, log | não importa nenhum outro módulo |
| `usbmux`, `device` | protocolo usbmuxd, repassador local; `devicectl` (saída JSON em arquivo) | só `core` |
| `runner` | build/up/down/sever (xcodebuild), sessão `.xctestrun`, cliente JSON-RPC, reconexão | `core`, `usbmux`, `device` |
| `choreo`, `guide` | YAML → validação → compilação (JCS); síntese e medida da guia | `core`, `media` |
| `clock`, `align` | NTP e ajuste; marcas, regiões, ajuste de latência, erro deixando um de fora | `core`, `media` |
| `obs` | cliente obs-websocket, guarda de perfil, setup idempotente, gravação, marcas, finalização | `core` |
| `media` | o único lugar que chama ffmpeg/ffprobe (caminho fixado, versão 8.1.1) e o ajudante de OCR | `core` |
| `outputs`, `mix`, `booth` | saídas de S10, mixagem, cabine | `core`, `media` |
| `take` | supervisor e vigia da tomada, pré-voo, preparo/limpeza, status com batimento | o único que junta `runner` + `obs` + `align` |
| `sim` | `simctl`, ensaio | `core`, `runner` |
| `commands` | uma função por operação; é o que CLI e MCP chamam | todos os acima |
| `cli`, `mcp` | adaptam argumentos e saída; **nenhuma lógica** | só `commands` |

Segredos só passam por `core/secret.ts`; ninguém mais chama `/usr/bin/security`.

## A3. Fluxos de ponta a ponta

**Exploração (US-1…US-4).** Claude Code → ferramenta MCP `tap` → `commands.tap` → `runner/rpc`
(abre `control` só para esse comando) → WebSocket em `127.0.0.1:<efêmera>` → repassador → usbmuxd
`Connect` → loopback do iPhone :8700 → `Server` → fila do XCTest (main) → `Driver` confere a lista
permitida e resolve o alvo (árvore, OCR) → `PrivateXCT.synthesize` ou toque público → resposta com
tempos D. `record_step` lê o último pedido bem-sucedido e a árvore seguinte e devolve o YAML.

**Tomada (US-6…US-10).** `take_start` → `take/supervisor` (processo destacado, `caffeinate`, vigia
filho, batimento em `status.json`) → limpeza pendente (`choreo.load` do `choreo.json` da tomada
anterior + `choreo.run {section: cleanup}`) → pré-voo (S12) → `choreo compile` (com guia) →
`choreo.load` → `choreo.run {section: prepare}` → PF-15 → rajada de sincronia pré pela conexão
`sync` → OBS (com guarda de perfil): `SetRecordDirectory`, `StartRecord`, espera `STARTED`, pré-rolo
com 8 marcas `SerialFrame` → `choreo.run {section: scenes}` → o aparelho executa sozinho; eventos
chegam por notificação e vão para `events.ndjson`; `scene.start` → `CreateRecordChapter`;
`checkpoint.wait` → aviso no Mac → (a pessoa age) → o runner segue → … → `take.end` → pós-rolo →
`StopRecord` → espera finalização → `choreo.run {section: cleanup}` → `events.fetch` (completa
buracos) → rajada pós → `align` (marcas + regiões + ajuste) → `export` (S10) → `status: finished`.
O MCP lê `status.json`/`events.ndjson` e fala com o supervisor só por `command.json` + `SIGUSR2`
(S8 item 5).

**Pós (US-11…US-13).** `review.mp4` + `subtitles.vtt` + `guide.aligned.wav` → o dono narra (cabine
ou outro gravador) → `voice.wav` → `mix` → `final.mp4`.

**Ensaio (US-14).** Igual à tomada, trocando usbmux por loopback do Mac, OBS por `simctl io
recordVideo` e passos `sim: skip|simulate`.

## A4. Armazenamento e formatos (não há banco de dados)

| Onde | O quê | Dono |
|---|---|---|
| repositório | código, `config/defaults.json`, coreografias YAML, spec, notas de spike (`SP-n.md`) | git |
| `~/.config/contrarregra/config.json` | configuração da máquina (S0.1), sem segredos | dono |
| `~/Library/Caches/contrarregra/` | DerivedData do runner, `sessions/*.xctestrun` (0600, apagados no `down`), `locks/<udid>.lock`, `confirmations.json` (confirmações humanas do pré-voo), cache da guia, capturas de exploração (podadas), registros | ferramenta |
| `~/Movies/contrarregra/<app>/<takeId>/` | pasta da tomada (S0.8) | ferramenta; fora do git |
| `~/Movies/contrarregra/spikes/SP-n/` | capturas, quadros e gravações de spike | ferramenta; cada gravação apagada logo depois de medida (um G4 por spike, com o dono) |
| contêiner do `.xctrunner` no iPhone | `Documents/contrarregra/<takeId>/events.ndjson` | runner |
| Chaveiro do macOS, serviço `contrarregra` | `OBS_WEBSOCKET_PASSWORD` (e, opcionais, `ASC_KEY_ID`, `ASC_ISSUER_ID`, `GEMINI_API_KEY`) | dono cria; ferramenta só lê |
| `~/Library/Application Support/obs-studio/basic/{profiles,scenes}/Contrarregra*` | perfil e cenas da ferramenta | OBS (criados por `obs setup`) |

Esquemas versionados: `contrarregra.choreography/1`, `contrarregra.events/1`,
`contrarregra.take/1`, `contrarregra.preflight/1`, `contrarregra.sync/1`, `contrarregra.status/1`,
`contrarregra.voice/1`.

## A5. Árvore de arquivos (planejada)

```
contrarregra/                      # repositório separado em ~/project/contrarregra (✅ Q-4; alternativa: hagah/tools/contrarregra)
├── spec/                          # esta spec + research/ (único conteúdo do primeiro commit)
├── package.json                   # "type": "module", engines node ">=22.18 <23", scripts test/typecheck
├── tsconfig.json                  # noEmit, allowImportingTsExtensions, erasableSyntaxOnly, verbatimModuleSyntax, module nodenext, target esnext
├── .mcp.json                      # servidor "contrarregra" → bin/contrarregra-mcp
├── .gitignore                     # ios/*.xcodeproj, .build/, node_modules/, *.mp4, *.mov, *.wav, *.aiff, *.aif,
│                                  #   *.m4a, *.caf, *.png, *.jpg, *.jpeg, *.heic, *.xcresult, *.xctestrun, *.log,
│                                  #   *.ndjson, *.p8, *.p12, *.mobileprovision, *.cer, spikes/sp-*/out/
├── bin/contrarregra, bin/contrarregra-mcp   # shims POSIX que acham Node 22.x ≥ 22.18
├── config/defaults.json
├── mac/src/{core,usbmux,device,runner,choreo,guide,clock,align,obs,media,outputs,mix,booth,take,sim,commands,cli,mcp}/
├── mac/tools/ocr.swift            # ajudante de OCR (Vision) para quadros de vídeo
├── mac/test/                      # *.test.ts + fixtures (usbmuxd falso, respostas do OBS, protocolo); vídeos de teste gerados no próprio teste com ffmpeg -f lavfi, nunca versionados
├── ios/
│   ├── project.yml                # XcodeGen; DEVELOPMENT_TEAM 984PNJZ8B9; assinatura automática; configuração Spike (bundle ids ✅ Q-3)
│   ├── ContrarregraHost/          # app hospedeiro (tela de relógio de calibração)
│   ├── ContrarregraRunner/        # RunnerTests.swift (testServe) + Server/ Driver/ PrivateXCT/ OCR/ Choreo/ Log/ Spikes/
│   └── ContrarregraKit/           # pacote Swift (Package.swift, Sources/, Tests/)
├── choreographies/
│   ├── hagah/v8.5-review.choreo.yaml   # com o catálogo `targets:` medido no SP-10
│   └── fixtures/                  # s02-s07.choreo.yaml, timing.choreo.yaml, settings.choreo.yaml (US-17)
├── spikes/SP-n.md                 # resultado de cada spike; código do Mac descartável em spikes/sp-n/
└── THIRD_PARTY_NOTICES.md         # só se algum trecho do WDA for portado (BSD-3)
```

## A6. Decisões herdadas (já tomadas antes desta spec)

ADR-1…ADR-8 são as decisões 1–8 do pedido (§3). Formato: contexto → decisão → consequências.
Reabrir exige motivo forte e G1 (P-6).

- **ADR-1 Aparelho físico no vídeo final; simulador só ensaio.** Contexto: a App Review pediu "screen
  recording captured on a physical device" com o iOS mais recente (`v8.5-rejeicao-2.1.md` §1). →
  HC-1 (versão: ✅ Q-11); o simulador usa outro binário do app (o do TestFlight não roda em
  simulador), então serve para a coreografia e o alinhamento, não para o vídeo.
- **ADR-2 Toque via XCUITest; app alvo intocado.** Contexto: em iPhone real, só um bundle de UI test
  pode sintetizar toques noutro app; ganchos no app mudariam o binário que a Apple revisa. → runner +
  hospedeiro; app alvo sem `testID` (o Hagah tem 136 `accessibilityLabel` (número do pedido) e 0
  `testID`), rótulos em inglês; palavras dentro de versículos só por OCR. A pesquisa mostrou que
  o hospedeiro é opcional (o WDA não tem); fica, com uma função: a tela de relógio para calibrar a
  latência de captura.
- **ADR-3 Duas formas de operar: exploração interativa e tomada executada no aparelho.** Contexto: a
  cena 9 liga o modo avião; tempos precisos não podem depender da rede. → executor e registro no
  runner; o Mac só observa e recupera eventos pela sequência.
- **ADR-4 Gravação no Mac pelo OBS via obs-websocket, capítulo por cena, MP4 híbrido; QuickTime manual
  é o plano B.** Contexto: a tomada tem de iniciar, parar e marcar capítulos sem ninguém no Mac e sem
  nada na tela do iPhone; a Gravação de Tela do iOS não tem API nem capítulos e mostra o próprio
  indicador; o OBS 31.1.2 já instalado captura tela e áudio do iPhone pelo cabo e expõe o
  obs-websocket v5. → perfil próprio no OBS; como o OBS 31.1.2 carimba o capítulo no DTS do último
  pacote (alguns quadros antes), os capítulos ao vivo servem de navegação e os finais são regenerados
  de `events.json` (FFMETADATA). Atualizar para o OBS ≥ 32 daria capítulos exatos (⏳ Q-8).
- **ADR-5 Saídas para a narração: `events.json`, `.srt`/`.vtt`, capítulos, tabela de tempos.**
  Contexto: o dono narra depois, em inglês, e precisa saber em que instante do vídeo cada ação
  acontece e que fala cabe em cada janela. → S10.
- **ADR-6 O ritmo vem da fala.** Contexto: o roteiro tem ~745 palavras (~5 min de fala) para 7–8 min
  de vídeo; se o ritmo viesse dos cliques, a tela mudaria antes de a fala terminar e a dublagem não
  caberia. → faixa-guia por frase; `cue` liga passos às frases; como o `-r` do `say` não é confiável,
  o ritmo é ajustado por `atempo` e calibrado na leitura do dono.
- **ADR-7 Pontos de controle humanos que pausam, avisam no Mac e continuam sozinhos.** Contexto: Face
  ID, código, senha e Ajustes não podem nem devem ser automatizados (HC-5, NG-4), e o dono não pode
  operar o Mac no meio da tomada; o runner precisa detectar sozinho que a pessoa terminou. → S5; o
  aviso sai por um dispositivo de som que o OBS não grava; nunca som no iPhone.
- **ADR-8 Uma tomada contínua, sem edição; pós mínima com ffmpeg.** Contexto: a App Review quer ver o
  fluxo real, do início, sem montagem. → cortar só o pré/pós-rolo de calibração (fora das cenas; ✅
  Q-16); mixagem com ducking; vídeo copiado.

## A7. Decisões desta spec

- **ADR-9 Transporte: usbmuxd próprio + WebSocket no loopback do aparelho.** Contexto: o canal tem de
  ser USB, sobreviver ao modo avião e não expor nada no Wi-Fi. Decisão: runner escuta só em
  `127.0.0.1:8700`; o Mac chega por `usbmuxd Connect` (só entradas `USB`) e um repassador local;
  JSON-RPC 2.0 com eventos empurrados; conexão `sync` separada; um controlador por vez. Alternativas
  avaliadas (pesquisa, `research/transport.md`):

  | Opção | Achado | Decisão |
  |---|---|---|
  | usbmux `Connect` (o mesmo que `iproxy`, `ios forward` do go-ios, `usbmux forward` do pymobiledevice3, o forwarder do Appium) | só USB por construção (no macOS 26 o usbmuxd só lista o iPhone com cabo); alcança listener em loopback (devicekit-ios do mobile-mcp); sem root | **escolhido**; SP-4 mede |
  | túnel CoreDevice (IPv6 `fdxx::`) | segue o transporte que o CoreDevice escolheu (hoje Wi-Fi); 4,5 s para re-sondar depois de ocioso; exigiria escutar fora do loopback | só como plano B com `wired` e emenda de P-3/P-7/HC-4 (⏳ Q-13) |
  | Wi-Fi direto | morre com o modo avião e expõe o servidor | rejeitado |
  | túneis de terceiros (go-ios, pymobiledevice3) | quebras no iOS 26.2+/26.5 e briga com o `remoted` | rejeitado em tempo de execução |

- **ADR-10 Subir o runner com `xcodebuild test-without-building`.** Contexto: em todas as ferramentas
  pesquisadas o runner do iOS 17+ vive pela sessão do IDE/testmanagerd — o Appium usa `xcodebuild`
  (ou `devicectl` com WDA pré-instalado), o go-ios e o pymobiledevice3 falam com o testmanagerd pelo
  túnel deles, o mobile-mcp usa o testmanagerd do go-ios + usbmux; o lançamento por `devicectl` é
  frágil — travou no iOS 26.5 (WDA #1147) e falha com código 10300 sob o DDI do Xcode 27 (appium
  #22636) —, e com Xcode 26.6 + iOS 26.3 não está provado. Decisão: `build-for-testing` uma vez;
  `test-without-building -xctestrun` destacado, com saída em arquivo e `caffeinate`; exigir túnel
  `wired` para tomada. Plano B, amarrado ao SP-2: `devicectl device process launch` com o
  `.xctrunner` sem `Frameworks/XC*` (só Xcode 26.x).
- **ADR-11 Node rodando TypeScript direto; MCP SDK v2; tomada por supervisor destacado com vigia.**
  Contexto: o Claude Code põe em segundo plano chamadas MCP com mais de 2 min e aborta chamadas paradas
  por 30 min; "tasks" do MCP foram descontinuadas no SDK v2; um supervisor morto deixaria o OBS
  gravando até encher o disco. Decisão: `take_start` devolve na hora; um processo supervisor roda a
  tomada, escreve arquivos com batimento, recebe pedidos do MCP por `command.json` + `SIGUSR2`, e um
  vigia para a gravação de uma tomada ainda viva se o batimento sumir; `take_wait` faz long-poll
  ≤ 55 s.
- **ADR-12 Coreografia em YAML, compilada para JSON canônico (JCS).** O dono revisa o roteiro
  executável (comentários, frases longas); o runner só lê JSON (`JSONDecoder`, sem dependência no
  aparelho); o hash JCS é o mesmo nos dois lados.
- **ADR-13 XcodeGen com `.xcodeproj` fora do git.** Agentes editam YAML com segurança; pastas
  sincronizadas dispensam mexer no `pbxproj`.
- **ADR-14 OBS com perfil e coleção próprios, saída Avançada, ABR 16 Mbps, guarda de perfil e cliente
  WebSocket próprio.** Tamanho previsível para a guarda de disco (≈ 122 MB/min a 1170×2532@60); toda
  escrita confere o perfil ativo, para nunca cair no "Untitled" do dono; o `obs-websocket-js` deixa
  promessas penduradas ao desconectar e importa msgpack por padrão; um cliente de ~200 linhas com
  prazo por pedido resolve.
- **ADR-15 Sincronia em três elos e verificação visual deixando um de fora.** Aparelho→Mac por NTP com
  ajuste linear (deriva de celulares chega a ~87 ppm = 78 ms em 15 min); Mac→gravação por marcas
  `SerialFrame` (quadro exato); latência de captura medida por região nos passos visuais, com o erro
  avaliado sem o próprio passo para não esconder viés. Os capítulos do OBS 31.1.2 não servem de
  âncora.
- **ADR-16 Ferramentas congeladas na produção.** O conjunto validado (Xcode 26.6 17F113, iOS 26.x
  conforme ✅ Q-11, macOS 26.5.x, OBS 31.1.2 conforme ⏳ Q-8, ffmpeg 8.1.1, Node 22.x) entra no
  pré-voo; qualquer mudança é G1 e exige rodar de novo SP-1…SP-7. O WDA mostra que cada iOS/Xcode novo
  quebra algo privado (travar no iOS 27, cabeçalhos no Xcode 26).

## A8. WebDriverAgent: o que copiar e o que fazer diferente

Lido em `appium/WebDriverAgent` v16.13.6 (`9d1d17d`, 2026-09-30; BSD-3, © Facebook).

**Copiar como técnica** (sem copiar texto; se algum trecho for portado, o arquivo leva o cabeçalho
BSD-3 e `THIRD_PARTY_NOTICES.md` traz a licença completa; nada dos `PrivateHeaders`, que são
despejos do SDK da Apple, nem do `LRUCache` Apache-2.0):
- um único teste que nunca retorna e gira o run loop principal; tempos limite de teste desligados;
- base "à prova de falha": `continueAfterFailure`, `record(_:)` que só registra (e, se preciso, as
  flags privadas de parar, A10 PX-4, ⏳ Q-5d);
- capturas automáticas do XCTest desligadas — nós pelos meios documentados (`-collect-test-diagnostics
  never`, chaves do `.xctestrun`), não pelas `UserDefaults` não documentadas que o WDA usa — e
  tratamento automático de interrupções desligado (PX-5, ✅ Q-5e);
- rotas "standalone" → nossa fila de controle que nunca espera o XCTest;
- snapshot público do app como fonte da árvore; visibilidade = frame ∩ tela;
- captura de tela: o WDA usa um pedido privado ao testmanagerd com JPEG/HEIC; nós usamos o público
  `XCUIScreen.main.screenshot()` (que não mostra o aviso "Automation Running") e só passamos ao
  privado (PX-6, ⏳ Q-5f) se a latência não servir;
- tela de início: o WDA ativa o SpringBoard pelo pid privado do AX; nós usamos o público
  `XCUIDevice.shared.press(.home)` e `XCUIApplication(bundleIdentifier: "com.apple.springboard")` para
  os ícones, sem desligar a ociosidade do SpringBoard (Appium #21427);
- registro de evento sintetizado (`XCSynthesizedEventRecord` + `XCPointerEventPath` via
  `eventSynthesizer`) para toques sem espera de ociosidade;
- `pressLockButton`/evento HID 0x0C/0x30 para travar; `com.apple.springboard.lockstate` para ler.

**Fazer diferente, e por que construir**:
- **Segurança**: o WDA escuta em todas as interfaces (porta 8100 e MJPEG 9100), sem autenticação e
  com CORS `*`; o nosso escuta só no loopback, com token, lista de apps permitidos e sem rotas GET que
  mudam estado.
- **Tempo**: o WDA é pedido/resposta; nós executamos a coreografia inteira no aparelho, com prazos
  absolutos, e registramos cada passo para a narração.
- **Quiescência**: o WDA força até 2 s de espera depois de gestos (`animationCoolOffTimeout`), o que
  um app com animação contínua sempre atingiria; nós desligamos e esperamos por condição.
- **Pontos de controle humanos, OBS e MCP** não existem no WDA.
- **Tamanho**: ~20 mil linhas de Objective-C (W3C, XPath, tvOS, MJPEG) que não usamos.

**O que perdemos**: dez anos de correções de casos de borda; correções rápidas da comunidade a cada
iOS/Xcode novo; seletores prontos e ferramentas (Appium Inspector, mobile-mcp). Mitigação: o código do
WDA serve de referência (leitura) para comparar quando uma API privada quebrar. Instalá-lo no iPhone
exige G2 + G5, nunca durante tomada nem junto com o runner, porque ele escuta em todas as interfaces
sem autenticação (contra P-3).

## A9. Segurança e privacidade

- Superfície: o runner (loopback do iPhone, token por sessão, um controlador por vez, lista de apps e
  links permitidos); o servidor MCP (stdio, sem rede); a cabine (`127.0.0.1`, só durante o uso); o
  obs-websocket do dono escuta em todas as interfaces e só tem a senha como proteção (mantê-la forte e
  desligar o servidor fora das sessões; o 5.6.2 não tem opção de escutar só no localhost).
- Dados que saem do Mac: as capturas de exploração vão ao modelo e ficam em `~/.claude/projects` e nos
  registros do MCP do Claude Code; por isso o runner só captura com um app permitido em primeiro
  plano, e o D0 desliga a pré-visualização de notificações.
- Segredos: só o nome no repositório; `OBS_WEBSOCKET_PASSWORD` no Chaveiro; o token da sessão vive no
  `.xctestrun` da sessão (0600, apagado no `down`); a `.p8` só por caminho (P-3); a ferramenta nunca
  pede senha.
- Credenciais do usuário nunca passam pela ferramenta: Face ID, código e senhas são da pessoa; o
  runner recusa digitar em campo seguro, texto com cara de credencial e em telas de autenticação; a
  captura do iOS esconde campos de senha e o teclado.
- Dados pessoais no iPhone: o preparo não apaga dado do app alvo que nenhuma tomada criou sem a
  confirmação do dono (✅ Q-15).
- Assinatura: `DEVELOPMENT_TEAM=984PNJZ8B9` no `project.yml` e na linha de comando; o build falha se o
  `.xctrunner` não tiver esse `TeamIdentifier` e a identidade `6NKUX5CX7G` (AC-1.14); uma identidade
  nova no chaveiro depois de assinar para tudo (G5).

## A10. Registro de APIs privadas (módulo `PrivateXCT`)

Cada uma: sondagem na subida (`respondsToSelector` / `class_getInstanceMethod` / `dlsym`), mapa em
`runner.capabilities`, liga/desliga por `runner.privateAllowed` → `CONTRARREGRA_PRIVATE`, e só com o
sim do dono (✅ Q-5 para PX-1, PX-2, PX-3 e PX-5; ⏳ para PX-4 e PX-6). Os símbolos de PX-1…PX-5
existem no Xcode 26.6 (verificado por `nm`/`otool` nos binários locais).

| Id | Capacidade | Símbolos | Sem alternativa pública porque | Risco | Plano B | Q-5 |
|---|---|---|---|---|---|---|
| PX-1 | Travar a tela | `-[XCUIDevice pressLockButton]`; `+[XCDeviceEvent deviceEventWithPage:0x0C usage:0x30 duration:0.5]` + `-[XCUIDevice performDeviceEvent:error:]` | `XCUIDevice.Button` só tem home, volume, action, camera | no iOS 27 o `pressLockButton` parou de travar (WDA #1171) | ponto de controle: a pessoa aperta o botão lateral | (a) |
| PX-2 | Pular a espera de ociosidade | `-[XCUIApplication _performWithInteractionOptions:block:]` (SkipPre/SkipPostEventQuiescence); reserva: troca de `-[XCUIApplicationProcess waitForQuiescenceIncludingAnimationsIdle:isPreEvent:]` | não há chave pública; "Reduce Motion" muda o visual e não para o laço de animação do Hagah | some num Xcode novo; sem a espera, transições não são aguardadas (compensado por `expect`) | toque público aceitando a latência medida, e pausar o áudio antes de toques que não precisam dele | (b) |
| PX-3 | Evento sintetizado | `XCSynthesizedEventRecord`, `XCPointerEventPath` (`initForTouchAtPoint:offset:`, `moveToPoint:atOffset:`, `liftUpAtOffset:`), `-[XCUIDevice eventSynthesizer]` `synthesizeEvent:completion:` | toques públicos esperam a ociosidade, não têm tempo explícito e só arrastam em linha reta (sem `via`) | cabeçalhos mudaram no Xcode 26 (WDA #1202) | `XCUICoordinate press(forDuration:thenDragTo:withVelocity:thenHoldForDuration:)`; `via` → `E_CAPABILITY_MISSING` | (c) |
| PX-4 | Não parar o teste em falha | `shouldSetShouldHaltWhenReceivesControl`/`shouldHaltWhenReceivesControl`; troca de `-[XCTIssue shouldInterruptTest]` | só se o SP-12 mostrar que `continueAfterFailure` + `record(_:)` não bastam | baixo | `runner up` de novo (fora de tomada) | (d) |
| PX-5 | XCTest não tocar alertas sozinho | troca de `-[XCUIApplication doesNotHandleUIInterruptions]` → `YES` | monitores públicos só agem quando um alerta bloqueia, e o tratamento padrão pode fechar alertas de um botão | baixo | `expect` explícito para alertas esperados; o fechamento automático fica registrado | (e) |
| PX-6 | Captura de tela privada em JPEG | `_XCT_requestScreenshot:withReply:` com `XCTImageEncoding` | só se `XCUIScreen.main.screenshot()` não cumprir AC-1.4 | médio (interface do testmanagerd) | captura pública + recodificar | (f) |

Não é API privada, mas é não documentado: o nome de notificação `com.apple.springboard.lockstate`
(API pública `notify_register_dispatch`). Plano B: inferir pelas leituras permitidas no SpringBoard (S1
item 11): ícone do app alvo tocável = destravada; controles de mídia da tela travada = travada.
As chaves de `UserDefaults` `DisableScreenshots`/`DisableDiagnosticScreenRecordings` que o WDA usa
**não** são usadas enquanto os meios documentados bastarem (S1 item 9). O SP-12 compara uma subida com
a captura automática ligada × desligada (latência, indicador na captura, atividade de gravação no
registro); se a captura continuar, essas chaves (não documentadas, risco baixo) são o plano B, postas
no `PrivateXCT` e levadas ao dono como uso de Q-5.

## A11. Riscos e onde são resolvidos

| Risco | Severidade | Spike | Se falhar |
|---|---|---|---|
| Aviso "Automation Running" na captura / toques humanos bloqueados | bloqueador | SP-1 | ⏳ Q-9; pontos de controle viram `who: runner` com `steps` onde não for credencial |
| Sessão do XCTest cai no modo avião | bloqueador | SP-2 | `devicectl process launch`; se falhar também, ⏳ Q-12 (emenda de P-4 por G1 antes de qualquer religamento na tela) |
| Toques atrasam com a animação contínua | alto | SP-3 | PX-2/PX-3 (✅ Q-5b/c); pausar o áudio antes de toques |
| Canal usbmux→loopback no iOS 26.3 | alto | SP-4 | ⏳ Q-13: emenda de P-3/P-7/HC-4 por G1 (túnel CoreDevice com `wired`, ou todas as interfaces com filtro de origem); nada fora do loopback antes disso |
| OBS: resolução, áudio, codificador, fonte morta, capítulos, finalização | alto | SP-5 | HEVC / 30 fps / QuickTime manual |
| Orçamento de ±100 ms | alto | SP-6 | latência medida por tomada; desligar buffering |
| Travar/acender/destravar | médio | SP-7 | ponto de controle humano |
| Folha do Sign in with Apple | médio | SP-8 | folha inteira como ponto de controle |
| Central de Controle / rede / barra de estado limpa | médio | SP-9 | pessoa toca o avião; prova pela Central de Controle e pelo app |
| Rótulos reais, gestos e linha do tempo do áudio do Hagah | médio | SP-10 | catálogo de alvos corrigido; roteiro corrigido |
| OCR da palavra | médio | SP-11 | posição estimada no versículo; OCR no Mac |
| Runner de longa duração, alertas, nada visível | médio | SP-12 | religar antes de cada tomada; PX-4/PX-5 (⏳ Q-5d / ✅ Q-5e) |
| Limites do Claude Code no MCP; supervisor morto | médio | SP-13 | tomada pela CLI em segundo plano; vigia |

## A12. Fontes

Pesquisa feita em 2026-10-02 (8 frentes, leitura de código-fonte, documentação atual e binários
locais do Xcode 26.6). As notas completas, com cada achado, fonte e grau de confiança, estão em
`spec/research/` (índice em `research/README.md`); abaixo, as fontes que sustentam a spec.

**WebDriverAgent e runners**
- appium/WebDriverAgent v16.13.6 @9d1d17d — `UITestingUITests.m`, `FBWebServer.m`, `FBTCPSocket.m`,
  `FBConfiguration.m`, `FBFailureProofTestCase.m`, `XCUIApplicationProcess+FBQuiescence.m`,
  `FBW3CActionsSynthesizer.m`, `XCUIDevice+FBHelpers.m`, `FBScreenshot.m`, `LICENSE`:
  https://github.com/appium/WebDriverAgent
- WDA #1202 (cabeçalhos privados para Xcode moderno): https://github.com/appium/WebDriverAgent/pull/1202
- WDA #1171 (travar no iOS 27 por HID): https://github.com/appium/WebDriverAgent/pull/1171
- WDA #1147 (lançamento por devicectl falha no iOS 26): https://github.com/appium/WebDriverAgent/issues/1147
- WDA #1210 (app sem resposta trava o agente, iOS 26.6): https://github.com/appium/WebDriverAgent/issues/1210
- WDA #1233 (prazos de AX/XPC): https://github.com/appium/WebDriverAgent/pull/1233
- appium-xcuitest-driver (bootstrap, prebuilt/preinstalled WDA, usbmux): https://github.com/appium/appium-xcuitest-driver
- appium-xcuitest-driver #2985 (código 10300): https://github.com/appium/appium-xcuitest-driver/issues/2985
- Appium #21779 ("Exiting due to IDE disconnection"): https://github.com/appium/appium/issues/21779
- Appium #15898 (aviso "Automation Running"): https://github.com/appium/appium/issues/15898
- Appium #22636 (WDA pré-instalado falha com o Xcode 27) e #21427 (tela de início com a ociosidade desligada): https://github.com/appium/appium/issues/22636 ; https://github.com/appium/appium/issues/21427
- Appium troubleshooting (código do aparelho, aviso): https://appium.github.io/appium-xcuitest-driver/latest/troubleshooting/
- go-ios @273d3e0 e #772 (túnel no iOS 26.5): https://github.com/danielpaulus/go-ios ; https://github.com/danielpaulus/go-ios/issues/772
- pymobiledevice3 @cd895d17, #1994, #1825: https://github.com/doronz88/pymobiledevice3
- mobile-mcp @65953016 (ferramentas MCP), mobilecli, devicekit-ios (loopback 127.0.0.1): https://github.com/mobile-next/mobile-mcp ; https://github.com/mobile-next/devicekit-ios
- callstack/agent-device (usbmux no iOS 26.5.2, tempos de subida/religamento): https://github.com/callstack/agent-device/blob/main/docs/usbmux-runner-transport-experiment.md
- Patrol `IOSAutomator.swift` (SpringBoard, Central de Controle, `airplane-mode-button`): https://github.com/leancodepl/patrol
- iOS 26.1 `AutomationModeUI.app` (textos do aviso): https://github.com/kishikawakatsumi/applelocalization-tools/blob/main/data/ios/26.1/AutomationModeUI.app_Localizable.loctable_3918.json

**Apple**
- XCUIAutomation (Xcode 16.3+; `XCUIApplication`, `XCUICoordinate`, `XCUIDevice.Button`, `XCUISystem`): https://developer.apple.com/documentation/xcuiautomation
- `executionTimeAllowance`: https://developer.apple.com/documentation/xctest/xctestcase/executiontimeallowance
- Notas do Xcode 15, 16, 16.3, 26.4: https://developer.apple.com/documentation/xcode-release-notes
- WWDC25-344 (automação de UI): https://developer.apple.com/videos/play/wwdc2025/344/
- Fóruns: código uma vez por dia (693273), Sign in with Apple em XCUITest (735049), espera de ociosidade (74466, 747115), túnel `wired` (761291), USB com modo avião (763793), confiar em desenvolvedor (743125)
- TN3158 (conexão de aparelho), TN3179 (privacidade de rede local): https://developer.apple.com/documentation/technotes
- Suporte 108785 (modo avião), 101604 (Modo de Pouca Energia), 102282 (acessórios no Mac)
- Vision `RecognizeTextRequest`, `boundingBox(for:)`, `RecognizeDocumentsRequest`: https://developer.apple.com/documentation/vision
- Network.framework `NWListener`, `NWProtocolWebSocket`: https://developer.apple.com/documentation/network
- QA1970 (`UIScreen.isCaptured`): https://developer.apple.com/library/content/qa/qa1970/_index.html
- WWDC 2014 #508 (opt-in de captura de aparelhos iOS): https://nonstrict.eu/wwdcindex/wwdc2014/508/
- Binários e cabeçalhos locais do Xcode 26.6 (17F113): `XCUIAutomation.framework`, `CMIOHardwareSystem.h`, `man xcodebuild`, `man 5 xcodebuild.xctestrun`, `xcrun devicectl … --help` (518.33)

**Captura e OBS**
- OBS 31.1.2 `plugins/mac-avcapture` (opt-in CMIO, dispositivos "muxed", áudio): https://github.com/obsproject/obs-studio/tree/31.1.2/plugins/mac-avcapture
- OBS #12062 (fonte perde o iPhone): https://github.com/obsproject/obs-studio/issues/12062 ; #3923 (resolução de iOS)
- OBS 31.1.2 `mp4-output.c`/`mp4-mux.c` (capítulos no DTS, finalização): https://github.com/obsproject/obs-studio/blob/31.1.2/plugins/obs-outputs/mp4-output.c
- OBS 32.0.0 (capítulos exatos) e 32.2.0 (correção de reconexão): https://github.com/obsproject/obs-studio/releases
- OBS KB Hybrid MP4: https://obsproject.com/kb/hybrid-mp4
- obs-websocket 5.6.2 protocolo e fontes (`Crypto.cpp`, `RequestHandler_Record.cpp`, `RequestBatchHandler.cpp`): https://github.com/obsproject/obs-websocket/blob/5.6.2/docs/generated/protocol.md
- obs-websocket-js 5.0.8: https://github.com/obs-websocket-community-projects/obs-websocket-js
- FFmpeg `libavdevice/avfoundation.m` (sem opt-in CMIO), `mov.c`/`movenc.c` (capítulos), filtros: https://github.com/FFmpeg/FFmpeg ; https://ffmpeg.org/ffmpeg-filters.html
- quicktime_video_hack (60 fps, resolução nativa, configuração USB oculta): https://github.com/danielpaulus/quicktime_video_hack
- facebook/idb `DeviceVideo.swift` (plano C): https://github.com/facebook/idb
- Barra de estado limpa durante a captura: https://leancrew.com/all-this/2015/02/one-more-thing-about-ios-screenshots/ ; https://dev.classmethod.jp/articles/mirroring-iphone-screen-on-mac-with-quicktime-player/

**Relógio, pós e Mac**
- Libc `clock_gettime.c` (MONOTONIC_RAW = contínuo; UPTIME_RAW para no sono): https://github.com/apple-oss-distributions/Libc
- Swift `Clock.cpp` (ContinuousClock/SuspendingClock), `DispatchGlobalExecutor.cpp` (folga do `Task.sleep`): https://github.com/swiftlang/swift
- libuv 1.51 `darwin.c` (`hrtime` = `mach_continuous_time`): https://github.com/libuv/libuv
- RFC 5905 (NTP): https://www.rfc-editor.org/rfc/rfc5905 ; deriva de celulares (Cristea & Groza 2013)
- W3C WebVTT; guia de legendas da Netflix (42 caracteres, 5/6 s–7 s)
- MDN browser-compat-data (rVFC, `outputLatency`, AudioWorklet); WebKit #173457 (getUserMedia em localhost)
- MCP TypeScript SDK v2: https://github.com/modelcontextprotocol/typescript-sdk ; Claude Code MCP: https://code.claude.com/docs/en/mcp
- libusbmuxd `usbmuxd-proto.h`/`libusbmuxd.c`: https://github.com/libimobiledevice/libusbmuxd
- Node 22: WebSocket global, TypeScript, `node:test`, `parseArgs`, `statfs`: https://nodejs.org/docs/latest-v22.x/api/
- XcodeGen: https://github.com/yonaskolb/XcodeGen
- Código do Hagah (alvos, estado, flags de build): `hagah/apps/mobile/src/**`, `packages/core/src/i18n/messages/en/**`, `apps/mobile/app.json`, `apps/mobile/eas.json`, `plans/mobile/STATE.md`
