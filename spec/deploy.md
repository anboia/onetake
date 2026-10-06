# Contrarregra — Instalação e operação

> Ferramenta local de desenvolvimento: não há nuvem, loja nem servidor (NG-7). "Implantar" aqui
> significa preparar o Mac e o iPhone, instalar o runner no aparelho e registrar o servidor MCP no
> Claude Code. Segredos aparecem **só pelo nome**. Os rótulos do iOS estão em inglês, como o iPhone
> fica nas tomadas.

## D0. Antes da implementação — o que só o dono faz (uma vez)

**Decisões** (`requirements.md` §5, ratificadas em 2026-10-06). O que delas cabe ao dono antes da
Fase 0: atualizar o iOS (Q-11, item 7), liberar ~20 GB (Q-14, item 17) e exportar o diário do Hagah
(Q-15, item 13).

**Anote o valor atual de cada ajuste que mudar** (para D5 desfazer).

**No OBS (31.1.2)**
1. Tools › WebSocket Server Settings: marcar **Enable WebSocket server**, porta 4455, **Enable
   Authentication**, gerar ou definir uma senha forte. O servidor escuta em todas as interfaces e a
   senha é a única proteção: desligue-o fora das sessões de gravação.
2. No Terminal, guardar a mesma senha no Chaveiro (o `-w` no fim pede a senha sem ela ir ao histórico
   do shell):

   ```bash
   security add-generic-password -s contrarregra -a OBS_WEBSOCKET_PASSWORD -l 'Contrarregra OBS WebSocket' -U -w
   ```

3. Ajustes do Sistema › Privacidade e Segurança: dar **Câmera** e **Microfone** ao OBS (captura do
   iPhone e do áudio dele). **Microfone** ao Terminal ou ao app do Claude Code (o que rodar
   `paths.ffmpeg -f avfoundation`) e ao Chrome, para o SP-15, o SP-18 e a cabine (✅ Q-6).

**No iPhone (iOS 26.x; ✅ Q-11)**
4. Ligar o cabo USB com o iPhone destravado; aceitar "Trust This Computer" e, no Mac, "Permitir
   acessório". Settings › Privacy & Security › Wired Accessories: **Automatically Allow When
   Unlocked**.
5. Settings › Developer: **Enable UI Automation** ligado (o modo desenvolvedor já está). Se a primeira
   subida do runner mostrar "Untrusted Developer": Settings › General › VPN & Device Management →
   confiar em "Apple Development: Andre Saboia" (pela pesquisa, com time pago provavelmente não
   aparece).
6. Settings › Display & Brightness › Auto-Lock: **Never**. Low Power Mode desligado (ele força 30 s).
7. Settings › General › Software Update: instalar o último iOS 26.x (nunca o 27; ✅ Q-11) e anotar
   versão e build para `toolchain.validated`; depois, Automatic Updates: desligadas até o vídeo ser
   aceito (ADR-16).
8. Settings › Home Screen & App Library › Newly Downloaded Apps: **App Library Only** (o runner e o
   hospedeiro não aparecem na tela de início da cena 1). O ícone "Hagah Bible" fica na **primeira**
   página da tela de início.
9. Settings › General › Keyboard: **Auto-Correction**, **Predictive** e **Smart Punctuation**
   desligados (a nota da cena 6 é digitada). Settings › Notifications › Show Previews: **Never** (as
   capturas de exploração saem do Mac para o modelo).
10. Settings › Wi-Fi: não deixar o Wi-Fi ligado *dentro* do modo avião (o iOS lembra se foi ligado
    lá; a cena 9 precisa ficar sem rede de verdade).
11. Idioma do iPhone em **English** (Settings › General › Language & Region) nas tomadas.
12. Instalar pelo TestFlight o build que vai à revisão (✅ Q-1); ele substitui o build Release de
    desenvolvimento que está no aparelho com o mesmo bundle id. Conferir em Hagah › Settings › About.
13. Dados do Hagah (✅ Q-15): sincronizar ou exportar o diário antes da Fase 0 — o SP-8 e o SP-10
    (T-0.26, T-0.28) entram e excluem conta e apagam o diário local; o preparo das tomadas deixa o
    app deslogado e com o diário vazio.
14. Para a cena 7 (✅ Q-2): em Settings › [nome] › Sign-In & Security › Sign in with Apple, confirmar
    que o Hagah **não** está na lista (assim a folha de primeiro cadastro aparece).

**No Mac**
15. Atualizar o Claude Code para ≥ 2.1.283 (mantém o progresso de chamadas MCP em segundo plano).
16. Não atualizar Xcode (26.6), OBS (31.1.2) nem macOS durante a produção (ADR-16); a atualização do
    OBS para 32.x é ⏳ Q-8.
17. Espaço em disco (✅ Q-14): liberar ~20 GB antes da Fase 0 e guardar só a última tomada completa
    (`takes prune`, G4 em lote). Hoje há ~8,7–10 GiB livres; cada tomada guardada ocupa ~3,6 GB (S9,
    HC-11) e os spikes de gravação precisam de folga. O `hagah/plans/mobile/STATE.md` aponta 14 GB em
    `~/.cache/huggingface` e 6,6 GB de simuladores.

**No repositório do Hagah (fora do Contrarregra; o dono ou uma sessão do Hagah aberta por ele)**
18. Corrigir o roteiro `plans/mobile/notes/v8.5-roteiro-video.md` pelos rótulos reais de `spec.md` S13
    item 2 (textos da PWA, build 4 → 5, prova do modo avião sem a barra de estado, gravação pelo OBS
    em vez do Control Center).
19. Gerar o build Release de simulador do Hagah (D3.5) quando a Fase 0 chegar ao SP-16.

## D1. Ambientes

| Ambiente | O quê | Quem mexe |
|---|---|---|
| Mac do dono | MacBook Air M4 16 GB, macOS 26.5.2, Xcode 26.6 (17F113), OBS 31.1.2 (obs-websocket 5.6.2), Node 22.19 (nvm) e 26.0 (Homebrew; recusado pelo shim), ffmpeg 8.1.1 em `/opt/homebrew/opt/ffmpeg/bin` (o do PATH é o 4.4.7), XcodeGen 2.45.4, BlackHole 2ch | dono; a ferramenta só escreve no perfil "Contrarregra" do OBS (criá-lo ou reconciliá-lo com `obs setup` é G5; pedidos de gravação e ajustes de spike nesse perfil não são) |
| iPhone 12 "VIVO_00G7" | iOS 26.x — o último, instalado antes da Fase 0 (✅ Q-11; era 26.3 23D127 em 2026-10-02; versão e build anotados em D0.7), UDID `00008101-001E79203A68001E`, CoreDevice `DC77A78E-5E8D-5825-B2EE-C297FBC14ABD`, modo desenvolvedor ligado | dono; a ferramenta instala só o runner e o hospedeiro (G5) e só opera os apps permitidos |
| Simulador "Contrarregra iPhone 12" | runtime iOS 26.5 (instalado), mesma geometria do iPhone 12 | ferramenta (`rehearse`) |

## D2. Segredos (só nomes)

| Nome | Onde mora | Quem cria | Uso |
|---|---|---|---|
| `OBS_WEBSOCKET_PASSWORD` | Chaveiro do macOS, serviço `contrarregra`, conta com o mesmo nome | dono (D0.2) | autenticar no obs-websocket; lido em memória a cada conexão |
| `CONTRARREGRA_TOKEN` | gerado a cada `runner up`; só na memória e no `.xctestrun` da sessão (0600, apagado no `runner down` e na próxima subida se sobrar) | ferramenta | autenticar o Mac no runner (exceção registrada em P-3) |
| `ASC_KEY_ID`, `ASC_ISSUER_ID` | Chaveiro, serviço `contrarregra` | dono, se quiser o plano B | assinar sem a sessão do Xcode (`-authenticationKeyID`, `-authenticationKeyIssuerID`) |
| caminho da `.p8` | `config.json` → `signing.ascKeyPath` (só o caminho em `~/.appstoreconnect/private_keys/`) | dono | `-authenticationKeyPath`; **o conteúdo nunca é lido nem impresso** pela ferramenta |
| `EXPO_PUBLIC_YVP_APP_KEY` | `.env` do repositório do Hagah (fora deste repositório) | dono | build de simulador do ensaio (D3.5); o Contrarregra nunca lê, copia nem registra |
| `GEMINI_API_KEY` | Chaveiro, serviço `contrarregra` | dono, só se pedir o Gemini (G5; ✅ Q-7: na v1 só `say`) | faixa-guia pelo Gemini TTS |

Nada disso vai para o git, para logs, para resultados de ferramenta MCP ou para a pasta da tomada. A
ferramenta nunca pede senha: segredo ausente → `E_SECRET_MISSING` com o comando acima.

## D3. Procedimentos

**D3.1 Instalar a ferramenta** (depois do G2 de T-0.2). No `~/.config/contrarregra/config.json` da
máquina, pôr `"app": {"explore": "app.kifactory.hagah"}` (explorar o Hagah fora de tomada),
`"runner": {"privateAllowed": ["PX-1", "PX-2", "PX-3", "PX-5"]}` (✅ Q-5), `"urls":
{"allowedPrefixes": ["hagah://"]}` (links do Hagah fora de tomada, SP-17) e, em
`toolchain.validated`, a versão e o build do iOS anotados em D0.7 (S0.1); os demais campos vêm de
`config/defaults.json`. Depois do primeiro `runner up`, `runner.capabilities` mostra `allowed: true`
nesses quatro PX:

```bash
npm ci
```

```bash
bin/contrarregra doctor
```

**D3.2 Registrar no Claude Code**: o `.mcp.json` do repositório aponta para `bin/contrarregra-mcp`;
aprovar o servidor no primeiro uso. Ferramentas aparecem como `mcp__contrarregra__<nome>`.

**D3.3 Compilar e instalar o runner** (nomes e bundle ids conforme ✅ Q-3; a primeira assinatura cria
App IDs e perfis no time `984PNJZ8B9` e a primeira instalação no iPhone é G5):

```bash
bin/contrarregra runner build
```

```bash
bin/contrarregra runner up
```

Por baixo: `xcodegen generate --spec ios/project.yml`; `xcodebuild build-for-testing -project
ios/Contrarregra.xcodeproj -scheme ContrarregraRunner -destination 'generic/platform=iOS'
-derivedDataPath ~/Library/Caches/contrarregra/DerivedData -allowProvisioningUpdates
DEVELOPMENT_TEAM=984PNJZ8B9 CODE_SIGN_STYLE=Automatic`; depois `xcodebuild test-without-building` como
em S2. Na primeira subida do dia o iPhone pede o código para a automação (ponto de controle de
preparo). Depois, tirar os ícones da ferramenta da tela de início, se aparecerem.

**D3.4 Preparar o OBS** (com o dono presente: G5; idempotente):

```bash
bin/contrarregra obs setup
```

Cria ou reconcilia o perfil e a coleção "Contrarregra" (S9) sem tocar no perfil "Untitled". Para
gravar, o OBS tem de estar **nesse perfil**: se estiver aberto noutro, feche o OBS e reabra assim (o
`--args` só vale quando o OBS não está rodando):

```bash
open -a OBS --args --profile Contrarregra --collection Contrarregra --disable-shutdown-check --disable-missing-files-check
```

**D3.5 App alvo para o simulador** (fora deste repositório; numa sessão do Hagah): build Release de
simulador do commit do build do TestFlight (build 5 = `8a178ec`, ✅ Q-1) com
`EXPO_PUBLIC_STORE_BUILD=1`, `EXPO_PUBLIC_DEV_TOOLS=0` e `EXPO_PUBLIC_YVP_APP_KEY` do `.env`;
`expo prebuild -p ios` reescreve `apps/mobile/tsconfig.json` (reverter); depois `xcodebuild -workspace
apps/mobile/ios/HagahBible.xcworkspace -scheme HagahBible -configuration Release -sdk iphonesimulator`.
Entregar o `.app` com `--app-path`. É a única exceção de build especial (P-4) e nunca vai ao aparelho.

**D3.6 Rodar uma tomada** (roteiro do operador):
1. OBS aberto no perfil "Contrarregra" com o servidor WebSocket ligado; iPhone no cabo, destravado, em
   inglês, Do Not Disturb ligado.
2. `bin/contrarregra runner up` (código da automação, se pedido).
3. `bin/contrarregra take preflight choreographies/hagah/v8.5-review.choreo.yaml` → resolver o que
   falhar → confirmar PF-11 e, sem limpeza pendente, PF-17. Com limpeza pendente, PF-17 falha aqui
   de propósito: o `take run` do passo 4 começa pela limpeza (S12 item 4), repete o pré-voo e pede
   nessa hora a confirmação de PF-17 (o Mac avisa; confirmar com `take preflight <choreo> --confirm
   PF-17`).
4. `bin/contrarregra take run choreographies/hagah/v8.5-review.choreo.yaml` (ou `take_start` pelo
   Claude Code). Ficar perto do iPhone, **sem olhar para ele na cena 3 até ser chamado**: o Mac fala
   quando é a vez da pessoa (Face ID, modo avião).
5. Ao fim: `review.mp4`, `subtitles.vtt` e `guide.aligned.wav` na pasta da tomada; narrar (cabine ou
   outro gravador, salvando `voice.wav` na pasta); depois `bin/contrarregra mix <pasta> --voice
   voice.wav` → `final.mp4`.
6. Desligar o servidor WebSocket do OBS. Publicar e responder à Apple é do projeto Hagah (NG-10).

## D4. Monitoramento

- `bin/contrarregra doctor` — toda a lista de PF que não depende de tomada, mais o batimento de um
  supervisor vivo, com a correção de cada falha.
- `bin/contrarregra runner status` / `take status <takeId>` (ou `take_wait` no MCP).
- Registros: `~/Library/Caches/contrarregra/logs/` (CLI/MCP/supervisor), `<takeDir>/runner.log`,
  `<takeDir>/xcodebuild.log`, registro do OBS em `~/Library/Application Support/obs-studio/logs/`.
- Durante a tomada: espaço em disco a cada 5 s; quadros pulados do OBS a 4 Hz; batimento do runner a
  1 Hz; batimento do supervisor a 1 Hz (o vigia para a gravação se ele sumir).

## D5. Desfazer e desinstalar

- Parar o runner:

  ```bash
  bin/contrarregra runner down
  ```

- Tirar o runner e o hospedeiro do iPhone (G4/G5; bundle ids conforme ✅ Q-3):

  ```bash
  xcrun devicectl device uninstall app --device 00008101-001E79203A68001E app.kifactory.contrarregra.runner.xctrunner
  ```

  ```bash
  xcrun devicectl device uninstall app --device 00008101-001E79203A68001E app.kifactory.contrarregra
  ```

- Mac — Ajustes do Sistema › Privacidade e Segurança: tirar o Microfone dado em D0.3 ao Terminal ou
  ao app do Claude Code e ao Chrome e, se não existiam antes, a Câmera e o Microfone do OBS,
  conforme anotado.
- Restaurar o iPhone com os valores anotados em D0: Auto-Lock e idioma; atualizações automáticas
  ligadas depois do aceite do vídeo; Wired Accessories como antes; Enable UI Automation desligado;
  Newly Downloaded Apps como antes; teclado e pré-visualização de notificações como antes.
- OBS: desmarcar **Enable WebSocket server**; voltar ao perfil "Untitled" (Profile › Untitled);
  apagar o perfil e a coleção "Contrarregra" pelo menu do OBS, se quiser.
- Chaveiro (só se for abandonar a ferramenta):

  ```bash
  security delete-generic-password -s contrarregra -a OBS_WEBSOCKET_PASSWORD
  ```

- Caches e tomadas: `~/Library/Caches/contrarregra/` pode ser apagado a qualquer momento; as tomadas
  em `~/Movies/contrarregra/` são do dono (G4 antes de apagar qualquer uma; política em ✅ Q-14).
- Uma tomada ruim não se "desfaz": grava-se outra (`take run`), que começa pela limpeza da anterior.

## D6. Custo

| Item | Valor |
|---|---|
| Dinheiro | zero na v1 (sem serviço pago; Gemini só com ✅ Q-7) |
| Disco por tomada guardada (✅ Q-14) | ~1,2 GB de gravação (10 min a 16 Mbps) + ~1,2 GB `review.mp4` + ~1,2 GB `final.mp4` ≈ 3,6 GB; guia e registros < 50 MB |
| Disco por sessão de exploração | capturas JPEG ~100 KB cada no MCP (o Claude Code guarda cópias em `~/.claude/projects` e nos registros do MCP); PNG nativos podados em `~/Library/Caches/contrarregra/explore/` |
| Disco dos spikes | até ~19 GB passando pelo SP-5, cada gravação apagada logo depois de medida (um G4 por spike, com o dono) |
| Tempo por tomada | ≤ 15 min da limpeza às saídas (SM-3), mais a narração |
| Tokens do Claude Code | ~420 tokens visuais por captura 390×844; tomada longa não consome tokens enquanto roda (supervisor destacado) |
