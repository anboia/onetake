# Contrarregra — Especificação funcional — DRAFT

> Projeto novo, sem código, escrito em 2026-10-02 a partir de
> `hagah/plans/mobile/notes/v8.5-prompt-contrarregra.md` e de uma pesquisa com fontes
> (`architecture.md` A12; notas em `research/`). Marcas de **status de decisão** (não de evidência
> em código): ✅ decidido · ⚠️ padrão proposto, vale salvo objeção na ratificação · ⏳ decisão do dono
> agendada para depois de um spike (lista única em `requirements.md` §5; as da ratificação foram
> tomadas em 2026-10-06). O que só o aparelho pode provar virou **spike** (SP-n,
> `tasks.md` Fase 0): a spec diz o comportamento exigido; o spike diz se o caminho principal ou o
> plano B o entrega. Vira FROZEN na ratificação (G1); depois disso só o G1 a muda.

**Glossário.** *Tomada*: uma gravação contínua de uma coreografia. *Coreografia*: arquivo
declarativo com cenas e passos. *Runner*: o bundle de UI test que roda no iPhone e obedece a
comandos. *Hospedeiro*: o app mínimo que acompanha o runner. *App alvo*: o app gravado (primeiro:
Hagah Bible, `app.kifactory.hagah`). *Ponto de controle*: pausa em que uma pessoa age no aparelho.
*Tempos*: **D** = relógio do aparelho (`CLOCK_MONOTONIC_RAW`, ns); **M** = relógio do Mac
(`process.hrtime.bigint()`, ns); **R** = tempo do arquivo gravado pelo OBS (s); **F** = tempo do
vídeo entregue, depois de aparar o pré-rolo (s).

---

## S0. Modelos de dados centrais (transversal: US-5, US-11, US-15, US-17)

Uma fonte da verdade para os formatos. O lado do Mac (TypeScript) e o do aparelho (Swift) espelham
estes tipos; nenhum dos dois inventa campo fora daqui. Todo arquivo JSON gerado leva um campo
`schema` com nome e versão (`contrarregra.<tipo>/<n>`).

### S0.1 Configuração (`Config`)

Arquivo por máquina `~/.config/contrarregra/config.json` (fora do repositório, **sem segredos**),
mesclado sobre `config/defaults.json` do repositório. Campos:

| Campo | Tipo | Padrão | Nota |
|---|---|---|---|
| `device.udid` | string | `00008101-001E79203A68001E` | iPhone 12 "VIVO_00G7" |
| `device.coreDeviceId` | string | `DC77A78E-5E8D-5825-B2EE-C297FBC14ABD` | |
| `device.name` | string | `VIVO_00G7` | nome do aparelho; também o `itemName` do dispositivo de captura na lista do OBS |
| `signing.team` | string | `984PNJZ8B9` | fixo (P-3); outro valor → `E_CONFIG` |
| `signing.identity` | string | `Apple Development: Andre Saboia (6NKUX5CX7G)` | conferida no `codesign` (HC-8) |
| `signing.ascKeyPath` | string? | vazio | só o **caminho** da `.p8` para o plano B de assinatura; nunca lida pela ferramenta |
| `bundle.host` | string | `app.kifactory.contrarregra` | ✅ Q-3 |
| `bundle.runnerTest` | string | `app.kifactory.contrarregra.runner` | o app instalado é `<isto>.xctrunner` (✅ Q-3) |
| `bundle.displayNames` | string[] | `["Contrarregra", "ContrarregraRunner-Runner"]` ⚠️ | nomes que o hospedeiro e o runner mostram no aparelho (✅ Q-3; o SP-12 confirma o do runner); usados em PF-12 e AC-13.7 |
| `runner.port` | int | `8700` ⚠️ | porta do runner no loopback do aparelho |
| `runner.privateAllowed` | string[] | `[]` | ids PX-n liberados pelo dono (✅ Q-5: `["PX-1", "PX-2", "PX-3", "PX-5"]` no `config.json` desta máquina; PX-4 e PX-6 ⏳); o `runner up` os passa em `CONTRARREGRA_PRIVATE`; vazio = só caminhos públicos |
| `usbmux.socketPath` | string | `/var/run/usbmuxd` | trocado nos testes por um usbmuxd falso |
| `app.explore` | string? | vazio | bundle id do app alvo fora de tomada (exploração e spikes); fica no `config.json` da máquina (ex.: `app.kifactory.hagah`), nunca em `config/defaults.json` (US-17); `{app: target}` resolve para ele quando não há coreografia carregada |
| `apps.allowed` | string[] | `[]` | bundle ids que o runner pode operar além do app alvo (da coreografia carregada ou `app.explore`) e do hospedeiro |
| `urls.allowedPrefixes` | string[] | `[]` | links que `app.openURL` aceita além de `app.urlPrefixes` da coreografia carregada |
| `paths.takes` | string | `~/Movies/contrarregra` | fora do git (HC-7) |
| `paths.cache` | string | `~/Library/Caches/contrarregra` | DerivedData, sessões, capturas de exploração, registros |
| `paths.ffmpeg`, `paths.ffprobe` | string | `/opt/homebrew/opt/ffmpeg/bin/{ffmpeg,ffprobe}` | 8.1.1; o do PATH é 4.4.7 |
| `obs.url` | string | `ws://127.0.0.1:4455` | |
| `obs.profile`, `obs.collection`, `obs.scene` | string | `Contrarregra` | perfil e cenas próprios (P-6) |
| `obs.source`, `obs.flashSource` | string | `iPhone`, `Sync Flash` | nomes das fontes no OBS |
| `secrets.obsPassword` | string | `OBS_WEBSOCKET_PASSWORD` | **nome** do item no Chaveiro (serviço `contrarregra`) |
| `alerts.sayDevice`, `alerts.voice` | string | `MacBook Air Speakers`, `Luciana` | saída de som do Mac para avisos |
| `guide.voice`, `guide.targetWpm` | string, int | `Samantha`, `150` ⚠️ | |
| `guide.sentenceGapMs`, `guide.padBeforeMs`, `guide.padAfterMs` | int | `400`, `1000`, `1500` ⚠️ | |
| `disk.minFreeGiB`, `disk.criticalGiB` | number | `4`, `2` ⚠️ | HC-11 |
| `record.fps`, `record.bitrateKbps` | int | `60`, `16000` ⚠️ | ≈ 122 MB/min |
| `sync.captureLatencyMs` | number? | vazio | latência de captura mediana (ms), copiada pelo dono do `SP-6.md` ou do relatório do último `sync calibrate`; usada quando a tomada tem menos de 2 passos visuais detectados (S7 item 6) |
| `toolchain.validated` | objeto | Xcode `26.6 (17F113)`, iOS: o último 26.x instalado antes da Fase 0 (✅ Q-11; era `26.3 (23D127)` em 2026-10-02), macOS `26.5.x`, OBS `31.1.2` (⏳ Q-8), obs-websocket `5.6.2`, ffmpeg `8.1.1`, Node `22.x >=22.18` | o conjunto em que os spikes passaram |

### S0.2 Ponto (`Point`) e Alvo (`Target`)

`Point` = `{x, y}` em pontos da tela ou `{nx, ny}` normalizado (0–1). Velocidades sempre em
**pontos por segundo**.

Um `Target` diz *em que* agir. **Seletores primários** (exatamente um): `ref`, `label`,
`labelPrefix`, `labelContains`, `identifier`, `ocr`, `point`. `type` é filtro; vale sozinho só
quando não há primário (ex.: `{type: tabBar}`). **Modificadores**: `app`, `within`, `below`,
`above`, `index`, `offset`, `fallback`.

| Campo | Tipo | Sentido |
|---|---|---|
| `ref` | string | nome de um alvo do catálogo `targets:` da coreografia; fora de coreografia (exploração), também um `@e<n>` da árvore atual (S0.6; de outro `treeVersion` → `E_TARGET_NOT_FOUND`), que `choreo validate` recusa |
| `app` | string | `target` (padrão: o app alvo), `springboard`, `controlcenter` (= SpringBoard), `authkit` (= `com.apple.AuthKitUIService`), ou um bundle id de `apps.allowed` |
| `label` / `labelPrefix` / `labelContains` | string | rótulo de acessibilidade exato / começo / trecho |
| `identifier` | string | identificador de acessibilidade |
| `type` | string | tipo `XCUIElement.ElementType` em minúsculas (`button`, `switch`, `staticText`, `alert`, `tabBar`, `textView`, `secureTextField`, `scrollView`, `cell`, `icon`, `other`, `any`) |
| `within` | Target | restringe a busca aos descendentes deste alvo |
| `below` / `above` | Target | só candidatos cujo `frame.minY` está abaixo/acima do alvo dado |
| `index` | int | desempate pela ordem de leitura (topo→base, esquerda→direita), começando em 0 |
| `ocr` | `{text, within?, region?, occurrence?}` | texto visível achado pelo Vision na captura; `within` (Target) ou `region` (retângulo em pontos) limita a busca |
| `point` | Point | coordenada absoluta da tela |
| `offset` | `{dx, dy}` em pontos | deslocamento a partir do centro do alvo resolvido |
| `fallback` | [Target] | alternativas tentadas em ordem se o seletor primário não resolver |

Regras: um alvo **resolve** para um único ponto da tela e, quando veio da árvore, para um nó (S0.6).
Zero candidatos = `E_TARGET_NOT_FOUND`; mais de um sem `index` = `E_TARGET_AMBIGUOUS` (com a lista).
Visível = `frame` ∩ tela com área > 0. A resolução nunca usa `launch()`.

### S0.3 Condição (`Condition`)

Usada em `expect`, `waitFor`, `assert`, `block.when`, `repeat.until` e pontos de controle. Avaliada
por sondagem a cada 100 ms ⚠️ até o prazo (no app alvo, substitui a espera de ociosidade do XCTest
quando PX-2 está liberado; ver S1).

| Forma | Verdadeira quando |
|---|---|
| `{element: Target, state: exists\|gone\|hittable\|selected\|value\|changed, equals?}` | o alvo existe / some / é tocável / está selecionado / tem o `value` dado / em alguma sondagem depois da ação, deixou de resolver ou teve rótulo/valor diferente do lido antes da ação (`changed` só vale em `expect`) |
| `{text: {ocr: ..., state: visible\|gone}}` | o texto aparece / some na captura (OCR) |
| `{appState: {app, state: foreground\|background\|notRunning}}` | `XCUIApplication.state` |
| `{locked: true\|false}` | estado de bloqueio da tela (notificação `com.apple.springboard.lockstate`) |
| `{airplane: on\|off}` | `value` do interruptor `airplane-mode-button`; só é avaliável com a Central de Controle aberta |
| `{network: online\|offline}` | há / não há rota satisfeita por Wi-Fi ou celular (`NWPathMonitor`), ignorando cabo e loopback |
| `{all: [Condition]}`, `{any: [Condition]}`, `{not: Condition}` | composição |

### S0.4 Coreografia (`Choreography`)

**Fonte** em YAML (`choreographies/<app>/<nome>.choreo.yaml`; ADR-12 em `architecture.md` A7),
**compilada** pelo Mac para JSON canônico, que é o que vai ao runner. Campos da fonte:

```yaml
schema: contrarregra.choreography/1
app: {bundleId: app.kifactory.hagah, iconLabel: "Hagah Bible", expectVersion: "1.0.0 (5)",  # ✅ Q-1
     urlPrefixes: ["hagah://"]}                    # links que o preparo/limpeza podem abrir
device: {language: en, screenPt: {w: 390, h: 844}, textSize: large, appearance: light}
guide: {voice: Samantha, targetWpm: 150}          # opcional; senão vem de Config
confirm: ["…"]                                    # opcional: o que o dono confirma no pré-voo (PF-17)
targets: {<nome>: Target}                         # catálogo reutilizável
prepare: [Step]      # roda antes de gravar (não aparece no vídeo)
scenes:
  - id: s01                     # ^s\d{2}$, único
    title: "Abertura"           # vira título de capítulo
    line: ["frase 1", "frase 2"] # fala em inglês, uma frase por item
    hold: {padBeforeMs: 1000, padAfterMs: 1500}  # opcional
    steps: [Step]
cleanup: [Step]      # roda depois de parar a gravação
```

**Passo (`Step`)**: `{id?, do, target?, <args da ação>, cue?, afterMs?, timeoutMs?, expect?,
expectTimeoutMs?, repeat?, onFail?, optional?, caption?, visual?, sim?}`.

- `do` ∈ `tap`, `doubleTap`, `longPress {durationMs}`,
  `drag {from, to, via?, pressMs?, velocity?|durationMs?, holdMs?}` (`from`/`to`/`via` são `Point`
  ou `Target`; `velocity` e `durationMs` são excludentes; `via` = pontos intermediários, só com PX-3),
  `scrollTo {target, within?, direction: down|up, maxSwipes}`, `type {text}`,
  `press {button: home|volumeUp|volumeDown}` (volume só fora de `scenes`, S3 item 1),
  `lock`, `wake`, `home`, `controlCenter {open|close}`, `app {action: activate|terminate|launch}`,
  `openURL {url}`, `wait {ms}`, `waitFor {condition}`, `assert {condition}`, `checkpoint {…}` (S5),
  `block {when?, steps}`, `mark {label}` (só registra), `hold` (segura até a permanência mínima).
- **Espera do alvo**: antes de agir, o executor sonda a resolução do `target` a cada 100 ms até
  `timeoutMs` (padrão ⚠️ 3000); só então responde `E_TARGET_NOT_FOUND`, ou registra
  `status: "skipped"` se `optional: true`. Para `waitFor`/`assert`, `timeoutMs` é o prazo da
  condição (em `assert`, padrão 0 = avalia uma vez).
- `expect` — Condição que tem de ficar verdadeira depois da ação, dentro de `expectTimeoutMs`
  (padrão ⚠️ 3000), contado depois da ação.
- `scrollTo` — sem `within`, usa o frame do ancestral rolável mais próximo do alvo na árvore
  (`scrollView`, `table`, `collectionView`); sem ancestral, `E_TARGET_NOT_FOUND`. Cada passe arrasta no
  centro horizontal desse frame, de 70 % a 30 % da altura (`down`) ou o inverso (`up`), `dx = 0`,
  `pressMs` 50, ⚠️ 600 pt/s, até o alvo ficar tocável ou acabar `maxSwipes`.
- `block` — `when` é avaliada uma vez; falsa, o bloco inteiro (pontos de controle inclusive) é
  registrado `skipped`. `repeat: {until, max}` repete o passo até a condição valer ou chegar a `max`
  (então `onFail`).
- `cue: n` — o passo não começa antes do início da frase *n* (0-based) da fala, na faixa-guia (S6).
- `afterMs` — pausa mínima depois do passo anterior (padrão ⚠️ 300 ms).
- `onFail` ∈ `pause` (padrão ⚠️) · `abort` · `continue`; `optional: true` = o passo pode não se
  aplicar (ex.: botão que só aparece numa variante da folha) e não conta como falha.
- `caption` — o que está acontecendo, em português, **≤ 34 caracteres** (cabe na linha 1 da
  legenda, S10), para legenda e registro.
- `visual: true` — o passo tem efeito visual imediato e entra na calibração de sincronia (S7).
- `sim` ∈ `run` (padrão) · `skip` · `simulate` — comportamento no simulador (S11).

**Forma compilada** (JSON): a fonte validada + `compiled: {sha256, compiledAt, guide: {voice, wpm,
factor}, scenes: [{id, sentences: [{text, startMs, durMs}], holdMs}]}`, com todos os `ref`
expandidos e padrões preenchidos. `compiled.sha256` = SHA-256 (hex minúsculo) da serialização JCS
(RFC 8785) do documento compilado **sem** `compiled.sha256` e `compiled.compiledAt`.

### S0.5 Protocolo Mac ↔ runner

JSON-RPC 2.0 em mensagens de texto WebSocket (uma mensagem = um objeto). Pedidos com `id`;
notificações do runner sem `id` (`event`, `log`). Formas das respostas dos métodos de base (os
demais estão em S1):

| Método | Pedido → resposta |
|---|---|
| `session.hello` | `{token, role: control\|sync, client}` → `{runnerVersion, capabilities, device: {model, os, screenPt, scale, language, textSize, appearance}, clock: {nowRawNs, nowUptimeNs}}` |
| `health` | `{}` → `{ok, uptimeS, xctestQueueDepth, treeVersion, foregroundApp, locked}` |
| `clock.ping` | `{seq, pad?}` → `{seq, t2RawNs, t3RawNs, t2UptimeNs}` (`pad` ≤ 64 KB, ecoado só no tamanho) |
| `events.fetch` | `{takeId, sinceSeq}` → `{events: [Event], lastSeq}` |
| `runner.capabilities` | `{}` → `{"PX-1": {present, allowed}, …, "PX-6": {…}}` |
| `ui.*` (ações) | → `{point, nodeRef?, tDevStartNs, tDispatchNs, tDevEndNs, path: "private"\|"public"}` |

Erros da aplicação em `-32000…-32099`:

| Código | Nome | Quando |
|---|---|---|
| -32001 | `E_AUTH` | sem `session.hello` válido ou token errado |
| -32002 | `E_BUSY` | já há um controlador, ou uma tomada em curso proíbe o comando |
| -32003 | `E_FORBIDDEN_APP` | app, link ou elemento de sistema fora da lista permitida |
| -32010 | `E_TARGET_NOT_FOUND` | alvo não resolveu no prazo |
| -32011 | `E_TARGET_AMBIGUOUS` | vários candidatos sem `index` (lista no `data`) |
| -32012 | `E_TARGET_NOT_HITTABLE` | existe, mas fora da tela ou coberto |
| -32013 | `E_OCR_NOT_FOUND` | texto não achado na região |
| -32020 | `E_TIMEOUT` | condição/espera/comando estourou o prazo |
| -32021 | `E_SECURE_FIELD` | pedido de digitar credencial: campo seguro, texto com cara de credencial ou tela de autenticação do sistema (sempre recusado) |
| -32022 | `E_NO_FOCUS` | `type` sem campo com foco |
| -32030 | `E_CAPABILITY_MISSING` | API privada ausente ou não liberada (S1, A10) |
| -32031 | `E_FORBIDDEN_IN_TAKE` | ação proibida durante a tomada (`launch`, `openURL`, botões de volume) |
| -32040 | `E_CHOREO_INVALID` | coreografia não passa na validação do runner |
| -32041 | `E_CHOREO_STATE` | `run` sem `load`, `resume` sem pausa etc. |
| -32050 | `E_APP_STATE` | app não instalado / não responde |
| -32060 | `E_XCTEST` | falha do XCTest capturada (detalhe no `data`) |

Erros do lado do Mac (não vêm do runner): `E_CONFIG`, `E_CHOREO_INVALID` (também emitido por `choreo validate`/`choreo compile`), `E_NO_USB`, `E_NOT_WIRED`, `E_RUNNER_DOWN`,
`E_TOOLCHAIN_MISMATCH`, `E_OBS_UNREACHABLE`, `E_OBS_AUTH`, `E_OBS_CONFIG`, `E_OBS_SOURCE`,
`E_DISK_LOW`, `E_SECRET_MISSING`, `E_SYNC_QUALITY`, `E_PREFLIGHT`.

### S0.6 Nó da árvore (`TreeNode`)

`{ref, type, label?, identifier?, value?, frame: {x, y, w, h}, enabled, selected, visible, depth,
children?}`, em pontos. `ref` tem a forma `@e<n>` e vale até a próxima mudança de tela
(`treeVersion` muda quando o runner detecta outra árvore). Formato compacto para o Claude Code: uma
linha por nó visível — `@e12 button "Open settings" (342,52 40x40)`, só estados fora do padrão.

### S0.7 Evento e `events.json`

Evento (uma linha de `events.ndjson`, no aparelho e no Mac; reunidos em `events.json` no fim):

```json
{"seq": 41, "kind": "step.end", "sceneId": "s02", "stepId": "s02.play", "action": "tap",
 "target": {"label": "Play"}, "caption": "Toca play no mini-player",
 "tDevStartNs": "…", "tDispatchNs": "…", "tDevEndNs": "…", "tDevUptimeNs": "…",
 "tMacNs": "…", "tPredRawS": 31.391, "tRecS": 31.452, "tFinalS": 24.452, "tVideoObservedS": 24.467,
 "detectScore": 21.8, "status": "ok", "lateMs": 3, "path": "private", "detail": {}}
```

`kind` ∈ `take.start`, `preroll.marker`, `scene.start`, `step.start`, `step.end`, `step.fail`,
`checkpoint.wait`, `checkpoint.alert`, `checkpoint.resolved`, `checkpoint.timeout`, `scene.hold`,
`scene.end` (com `overrunMs`), `device.state` (bloqueio, sono, rede e **toda troca do app em
primeiro plano**), `runner.reconnect`, `sync.burst`, `obs.state`, `obs.chapter`, `intervention`,
`take.pause`, `take.resume`, `take.end`, `take.abort`. Tempos D/M como string decimal (inteiros de
64 bits); R/F em segundos com 3 casas. `tPredRawS` e `tRecS` estão em R; `tFinalS` e
`tVideoObservedS`, em F (F = R − `trim.startR`; S7 itens 4–6). Eventos de `prepare`/`cleanup` levam
`sceneId: "prepare"` ou `"cleanup"` e ficam fora de `events.json.scenes`; `take.start` e `take.end`
delimitam a seção `scenes` (S4).

`events.json` = `{schema: "contrarregra.events/1", take: TakeManifest, clock: SyncReport,
trim: {startR, endR, leadInS}, scenes: [{id, title, startF, endF, guideS, holdS, checkpointsS,
overrunMs}], checkpoints: [...], events: [Event]}`.

### S0.8 Tomada (`TakeManifest`) e pasta da tomada

`takeId = YYYYMMDD-HHMMSS-<coreografia>`; pasta `~/Movies/contrarregra/<app>/<takeId>/`:

| Arquivo | Conteúdo |
|---|---|
| `take.json` | `{schema, takeId, mode: take\|rehearsal\|dry, status: preparing\|recording\|finished\|aborted\|failed, scenesResult?: finished\|aborted, cause?, choreography: {path, sha256}, app: {bundleId, version}, device: {udid, os, transport}, toolchain: {...}, startedAt, endedAt, interventions, syncOk, cleanupPending, obsStats: {renderSkipped, outputSkipped}, airplaneLeftOn}` |
| `choreo.json` | a coreografia compilada usada |
| `preflight.json` | relatório do pré-voo (S12) |
| `status.json`, `events.ndjson` | estado vivo (`{schema: "contrarregra.status/1", …}`, com batimento do supervisor) e eventos durante a tomada |
| `sever.json`, `command.json` | pedidos ao supervisor (S2 item 8; S8 item 5), apagados depois de lidos |
| `recording.mp4` | o arquivo do OBS, intocado |
| `rehearsal.mov` | o vídeo do ensaio no simulador (S11), no lugar de `recording.mp4` |
| `events.json`, `sync.json` | eventos finais e relatório de sincronia (S7) |
| `subtitles.srt`, `subtitles.vtt`, `chapters.ffmeta`, `timings.md`, `timings.csv` | saídas para narração (S10) |
| `guide/`, `guide.aligned.wav` | falas sintetizadas e a faixa-guia alinhada |
| `review.mp4` | vídeo aparado, com capítulos, sem narração |
| `voice.wav`, `voice.json` | voz do dono e `{schema: "contrarregra.voice/1", offsetMs, calibrationMs}` (cabine ou gravação externa) |
| `stems/` | só com `mix --debug-stems`: `app.ducked.wav` e `voice.limited.wav` (48 kHz, antes do `amix`) |
| `final.mp4` | depois da mixagem com a voz do dono |
| `runner.log`, `xcodebuild.log` | registros |

### S0.9 Relatórios

`PreflightReport = {schema, at, checks: [{id: "PF-nn", title, status: pass|fail|warn|human, detail,
fix?}], ok}`. `SyncReport = {schema, deviceToMac: {aNs, bPpm, residualMs, samples, bursts},
macToRecording: {t0MacNs, t0StdErrMs, fps, markers, maxMarkerDevMs}, captureLatency: {alphaMs, beta,
method, eventsUsed}, error: {method: "leave-one-out", medianMs, maxMs, rawMedianMs, rawMaxMs}, ok}`.

### S0.10 Código do relógio de calibração

O hospedeiro desenha, a cada quadro (`CADisplayLink`, 60 Hz), o valor de D em milissegundos
(`floor(rawNs / 1e6) mod 2^40`) em dígitos grandes e num código de blocos: 5 linhas × 8 colunas de
células de 44×44 pt, bit mais significativo na célula de cima à esquerda, ordem por linhas, branco =
1, preto = 0; uma 6.ª linha com a paridade par de cada coluna; fundo cinza médio. O Mac decodifica
por amostragem do centro de cada célula.

**Acceptance Criteria (Given/When/Then)**
- **AC-0.1** Given uma coreografia com um campo desconhecido, when ela é validada, then a validação
  falha apontando o caminho do campo (ex.: `scenes[1].steps[3].tagret`).
- **AC-0.2** Given a mesma fonte YAML e a mesma faixa-guia, when ela é compilada duas vezes, then os
  dois `compiled.sha256` são iguais e batem com o SHA-256 da serialização JCS definida em S0.4.
- **AC-0.3** Given os alvos `{label, point}` e `{ref, identifier}`, when validados, then são
  rejeitados com `E_CHOREO_INVALID`; Given `{label, type}` e `{type: tabBar}`, then passam.
- **AC-0.4** Given um `events.json` produzido por qualquer tomada, when validado contra o esquema
  `contrarregra.events/1`, then passa, e todo tempo D/M é string de inteiro.
- **AC-0.5** Given `config.json` com `signing.team` diferente de `984PNJZ8B9`, when qualquer comando
  carrega a configuração, then sai com código ≠ 0 e `E_CONFIG` citando `signing.team`, sem criar
  processo filho (`xcodebuild`, `devicectl`) nem conexão.
- **AC-0.6** Given as fixtures de `mac/test/fixtures/protocol/*.json` (as mesmas lidas pelo
  `swift test`), when cada lado decodifica e recodifica, then o JSON é semanticamente igual nos dois
  lados e byte a byte igual sob JCS.
- **AC-0.7** Given uma coreografia com `targets: {focusStage: {label: "Focus", type: button}}` e os
  passos `drag {from: {ref: focusStage}, to: {ref: focusStage, offset: {dx: 0, dy: 200}}, velocity:
  1000}` e `drag {from: {nx: 0.5, ny: 0.6}, to: {x: 195, y: 300}, durationMs: 500}`, when validados,
  then passam; Given `drag` com `velocity` e `durationMs` juntos, then falha.
- **AC-0.8** Given 1.000 valores aleatórios de D, when codificados no código de S0.10 e decodificados
  de uma imagem renderizada a 1170×2532, then todos voltam iguais e a paridade detecta 1 bit trocado.

---

## S1. Runner no iPhone (US-1, US-2, US-3, US-6, US-15)

**Behavior**

1. **Forma.** Um bundle de UI test (`ContrarregraRunner`, `bundle.runnerTest`), que o Xcode
   instala como `…runner.xctrunner`, mais o app hospedeiro mínimo ✅ (ADR-2). O hospedeiro tem uma
   tela só, o relógio de calibração (S0.10), usado **só** em execuções de calibração (S7 item 7) e
   lançado por `devicectl` fora de tomada. O projeto **não tem** nenhum alvo ou produto com o bundle
   id do app alvo (senão `init(bundleIdentifier:)` o reinstalaria).
2. **Ciclo de vida.** Um único método de teste (`testServe`) que nunca retorna: faz `press(.home)`
   para sair da frente, **só então** abre o servidor (S2) e gira o run loop principal até
   `runner.shutdown`. Tempo limite de teste desligado (`-test-timeouts-enabled NO`). Falhas do XCTest
   não derrubam o teste: `continueAfterFailure = true`, `record(_:)` só registra, e todo alvo é
   resolvido antes de agir (S0.2); PX-4 só com ⏳ Q-5d. Se mesmo assim o método terminar, o runner
   cai e nada o religa sozinho (S2 item 7).
3. **Duas filas.** *Fila de controle* (fora da main thread): `session.hello`, `health`,
   `clock.ping`, `choreo.status`, `choreo.abort`, `events.fetch` — nunca espera o XCTest. *Fila do
   XCTest* (main thread, serial): tudo que toca a UI. Prazo padrão ⚠️ 10 s por comando (`ui.tree`
   5 s, `screen.shot` 3 s, `wait.for` = `timeoutMs` + 1 s); o estouro responde `E_TIMEOUT` sem travar
   a fila de controle.
4. **Operações** (métodos JSON-RPC; todo tempo em D; respostas de ação conforme S0.5):
   - `screen.shot {format: jpeg|png, scale: points|native, quality?}` → imagem base64 + tamanho em
     px e escala. Usa `XCUIScreen.main.screenshot()` (público; a tela inteira, só com o app à frente
     dentro da lista do item 11) e recodifica em JPEG; padrão JPEG em pontos (390×844 no iPhone 12).
     Plano B se o AC-1.4 falhar: PX-6 (⏳ Q-5f).
   - `ui.tree {app?, visibleOnly?: true, maxDepth?, format: compact|json}` → `{treeVersion,
     nodes}` (S0.6). `app` padrão = o app em primeiro plano.
   - `ui.find {target}` → candidatos com `ref`, `frame`, `visible`, `hittable`.
   - `ui.tap`, `ui.doubleTap`, `ui.longPress {target, durationMs}`,
     `ui.drag {from, to, via?, pressMs, velocity|durationMs, holdMs}` (velocidade em pt/s; o caminho
     público converte para `XCUIGestureVelocity` multiplicando pela escala da tela; `via` só com
     PX-3, senão `E_CAPABILITY_MISSING`), `ui.scrollTo {target, within?, direction, maxSwipes}`.
   - `ui.type {target?, text}` — só texto **não secreto**: recusa com `E_SECURE_FIELD` se o campo é
     seguro, se o texto parece credencial (contém e-mail/Apple ID, regex de e-mail) ou se o app em
     primeiro plano é uma tela de autenticação do sistema (`authkit`, código do SpringBoard).
   - `ui.ocr {region?, text?}` → caixas `{text, frame, confidence}` em pontos (Vision, nível
     acurado, caixa por palavra).
   - `device.press {button: home|volumeUp|volumeDown}`, `device.home`, `device.lock`, `device.wake`,
     `device.controlCenter {open|close}`, `device.state` → `{locked, network, foregroundApp,
     language, screenPt, textSize, appearance}`.
   - `app.activate|launch|terminate|state {bundleId}`, `app.openURL {url}`.
   - `wait.for {condition, timeoutMs}`.
   - `choreo.load {choreography, takeId, mode}`, `choreo.run {section, startAtD?}`, `choreo.pause`,
     `choreo.resume`, `choreo.abort`, `choreo.status`, `events.fetch {takeId, sinceSeq}` (S4).
   - `runner.capabilities` (S0.5); `runner.shutdown`.
5. **Tocar.** Todo toque e arrasto vai a uma coordenada absoluta da tela (o alvo resolvido dá o
   ponto). Caminho principal (✅ Q-5c), só com PX-3 liberado em `runner.privateAllowed` e confirmado
   pela sondagem: evento sintetizado num único registro, sem esperar a ociosidade do app. Caminho
   público (plano B): `XCUICoordinate` do SpringBoard com
   `press(forDuration:thenDragTo:withVelocity:thenHoldForDuration:)`. A espera de ociosidade do
   XCTest fica desligada para o app alvo só com PX-2 liberado e presente (✅ Q-5b), substituída por
   `expect` com sondagem; sem ele, o toque público espera a ociosidade, e essa espera fica em
   `tDispatchNs − tDevStartNs` do `step.end` (e em `overrunMs`, se passar do `hold`).
   Cada ação registra `tDevStartNs` (início da resolução), `tDispatchNs` (envio do evento),
   `tDevEndNs` (fim) e `path` (`private`/`public`).
6. **OCR.** Quando o texto não é um elemento da árvore (ex.: a palavra *shepherd* dentro de um
   versículo), o runner tira a captura, roda o Vision só na região (`within`/`region`), escolhe a
   ocorrência pedida e toca o centro da caixa da palavra convertida de px para pontos.
7. **Tela de início, ícone, Central de Controle.** Ícones pelo SpringBoard
   (`icons["<iconLabel>"]`); `device.home` = `XCUIDevice.shared.press(.home)` (sem desligar a
   ociosidade do SpringBoard); Central de Controle por arrasto do canto superior direito
   (0,9 · 0,01 → 0,9 · 0,2); modo avião pelo interruptor `airplane-mode-button` do SpringBoard.
8. **Travar e acender a tela.** Não há API pública de travar. `device.lock` usa PX-1 (✅ Q-5a); sem
   ele, responde `E_CAPABILITY_MISSING` e a coreografia usa um ponto de controle (o dono aperta o
   botão lateral). `device.wake` acende a tela travada sem destravar (um `press(.home)` com a tela
   travada; o SP-7 confirma; plano B: ponto de controle "aperte o botão lateral sem olhar para o
   iPhone"). Estado de bloqueio pela notificação `com.apple.springboard.lockstate`.
9. **Nada da ferramenta na tela.** Durante a tomada o runner nunca ativa o hospedeiro nem a si
   mesmo; desliga as capturas automáticas do XCTest pelos meios documentados
   (`-collect-test-diagnostics never` e, no `.xctestrun`,
   `SystemAttachmentLifetime`/`UserAttachmentLifetime = keepNever` e `PreferredScreenCaptureFormat =
   screenshots`); não anuncia Bonjour; durante a seção `scenes` (de `choreo.run {section: scenes}`
   até `take.end`; S4) recusa `press volumeUp/volumeDown` (mostram o HUD), `app.launch` e
   `app.openURL` (`E_FORBIDDEN_IN_TAKE`); emite `device.state` a cada troca do app em primeiro
   plano. O aviso do iOS "Automation Running — Hold both volume buttons to stop" aparece enquanto há
   sessão de automação; se ele entra na captura USB é o **SP-1**, e o tratamento é ⏳ Q-9.
10. **Idioma, geometria, texto e aparência** são lidos pelo próprio runner (`Locale`, tela em
    pontos, categoria de tamanho de texto e estilo da interface do seu processo) e expostos em
    `device.state`.
11. **Lista permitida.** O runner só opera o app alvo (da coreografia carregada ou, sem ela,
    `app.explore`), o hospedeiro (fora de tomada) e `apps.allowed`; `app.openURL` só aceita
    `app.urlPrefixes` da coreografia carregada e `urls.allowedPrefixes`. No SpringBoard, só o ícone
    do app alvo (`app.iconLabel`), a Central de Controle e o interruptor do modo avião; na tela
    travada, só o arrasto de destravar, dentro de um ponto de controle `who: runner` e depois de
    `{locked: false}` (no build `Spike`, também o `spike.unlockDrag` do SP-7, com a condição
    `{locked: false}`, fora de ponto de controle). Essas regras restringem **ações** (toque,
    arrasto, digitação, abrir app ou link). **Leituras** (`ui.find` e condições) no SpringBoard só
    alcançam os ícones da página onde está o ícone do app alvo (PF-12), os controles da Central de
    Controle e os controles de mídia da tela travada; nunca `ui.tree` completo do SpringBoard, e
    nunca `screen.shot` nem `ui.ocr` com a tela travada. Na folha do Sign in with Apple (`authkit`),
    só `ui.find`/`ui.tap` de botões (ex.: "Continue") — nunca `ui.type`, `ui.tree`, `ui.ocr` nem
    `screen.shot`, para nome e e-mail da conta Apple não saírem do aparelho. Fora disso,
    `E_FORBIDDEN_APP`; e `ui.*` com o app em primeiro plano fora da lista também é recusado.
    `screen.shot` e toda captura interna (seletor `ocr`, condição `text`) só acontecem com o app
    alvo, o hospedeiro (fora de tomada) ou um app de `apps.allowed` em primeiro plano; com o
    SpringBoard à frente (tela de início, Central de Controle, tela travada) ou a folha `authkit`,
    `E_FORBIDDEN_APP` e nada é capturado. No iPhone físico, Ajustes, Telefone, Mensagens, Mail,
    Wallet e as lojas (`com.apple.Preferences`, `com.apple.mobilephone`, `com.apple.MobileSMS`,
    `com.apple.mobilemail`, `com.apple.Passbook`, `com.apple.AppStore`, `com.apple.MobileStore`)
    nunca entram na lista: como app alvo de `choreo.load`, como `app.explore` ou em `apps.allowed`,
    o runner os recusa com `E_FORBIDDEN_APP` (P-3); só o build de simulador os aceita (AC-3.7).

**API / Interface**
- WebSocket no loopback do aparelho, porta `runner.port`; primeira mensagem obrigatória
  `session.hello` (S0.5).
- Notificações: `event` (S0.7) e `log {level, msg}`.
- Variáveis de ambiente do runner (vêm do `.xctestrun` da sessão, S2): `CONTRARREGRA_PORT`,
  `CONTRARREGRA_TOKEN`, `CONTRARREGRA_SESSION`, `CONTRARREGRA_PRIVATE` (PX-n liberados),
  `CONTRARREGRA_ALLOWED` (bundle ids e prefixos de link), `CONTRARREGRA_EXPLORE` (`app.explore`;
  mudar exige novo `runner up`); só na configuração `Spike`:
  `CONTRARREGRA_BIND=loopback|endpoint` (as duas formas prendem em 127.0.0.1; padrão `loopback`).
- Métodos `spike.*`: existem só no build da configuração `Spike` (S2 item 1), para medições da
  Fase 0; o build de produção os recusa com `-32601`.

**Error & Edge Cases**
- **E-1.1** Alvo some entre a resolução e o toque (lista virtualizada recicla a linha) → uma nova
  resolução; se falhar de novo, `E_TARGET_NOT_FOUND`.
- **E-1.2** Snapshot da árvore lento (app ocupado) → prazo do comando estoura com `E_TIMEOUT`; a fila
  de controle segue respondendo `health`.
- **E-1.3** Uma API privada some depois de atualização do iOS/Xcode → a sondagem do início marca a
  capacidade como ausente; os comandos dela respondem `E_CAPABILITY_MISSING`; a tomada que precisa
  dela é recusada no pré-voo (S12, PF-04).
- **E-1.4** Alerta de sistema inesperado cobre o app → `expect` falha e o passo segue `onFail`. Com
  PX-5 liberado (✅ Q-5e), o XCTest não toca alertas sozinho; sem ele, o tratamento padrão do XCTest
  pode fechar um alerta de um botão que bloqueie um toque, e o evento registra
  `detail.interruptionHandled`. Alertas esperados sempre têm `expect`/`waitFor` explícito.
- **E-1.5** Pedido de digitar credencial (E_SECURE_FIELD, item 4) → recusado mesmo se o texto vier
  vazio, sem enviar tecla.
- **E-1.6** O app alvo cai durante a tomada → `step.fail` com `E_APP_STATE`; o Mac anexa o aviso de
  crash do XCTest ao registro.

**Acceptance Criteria (Given/When/Then)**
- **AC-1.1** Given o runner subido, when o Mac manda `session.hello` com o token certo, then recebe
  `runnerVersion`, `capabilities` e `device.screenPt = {w: 390, h: 844}` no iPhone 12.
- **AC-1.2** Given uma conexão sem `session.hello` ou com token errado, when ela manda qualquer
  outro método, then recebe `E_AUTH` e é fechada.
- **AC-1.3** Given o Hagah em primeiro plano, when `ui.tree {format: compact}` é pedido, then cada
  linha tem `ref`, tipo e frame em pontos, e o rótulo quando o nó tem um; o botão "Open settings" do
  Diário aparece com o mesmo frame que `ui.find` devolve.
- **AC-1.4** Given o runner ocioso, when `screen.shot` é pedido 50 vezes em JPEG/pontos, then o p95
  da resposta é ≤ 500 ms e a imagem tem 390×844 px.
- **AC-1.5** Given PX-2 ou PX-3 liberados (✅ Q-5b/c) e presentes, e o leitor do Hagah com áudio
  tocando e a palavra destacada animando, when 50 `ui.tap` são feitos num botão escolhido no SP-3
  (registrado em `spikes/SP-3.md`) cujo toque não para o áudio (tela restaurada entre toques), then p95(`tDevEndNs − tDevStartNs`)
  ≤ 150 ms, p99 ≤ 300 ms e 0 linhas "Wait for app.kifactory.hagah to idle" em `xcodebuild.log`.
- **AC-1.6** Given o Salmo 23 na lente "Word" com áudio pausado, when `ui.tap {target: {ocr: {text:
  "shepherd", within: <versículo 1 NIV>}}}` roda 20 vezes, fechando o painel entre os ciclos, then a
  condição do painel (definida no SP-11 e gravada no catálogo de alvos) fica verdadeira em ≥ 19/20
  e `tDevEndNs − tDevStartNs` é ≤ 700 ms em 20/20.
- **AC-1.7** Given um campo seguro em foco, when `ui.type` é pedido, then a resposta é
  `E_SECURE_FIELD` e nenhuma tecla é enviada.
- **AC-1.8** Given uma tomada com `choreo.status.section = scenes`, when chega `device.press {button:
  volumeUp}`, `app.launch` do app alvo ou `app.openURL {url: "hagah://…"}`, then a resposta é
  `E_FORBIDDEN_IN_TAKE`; Given `choreo.status.section = cleanup`, when `app.openURL {url:
  "hagah://…"}`, then executa.
- **AC-1.9** Given PX-1 liberado (✅ Q-5a) e presente, when `device.lock` é chamado 10 vezes (com desbloqueio
  humano entre elas), then 10/10 travam em ≤ 2 s confirmados por `device.state.locked = true`.
- **AC-1.10** Given PX-1 ausente ou não liberado, when `device.lock` é chamado, then a resposta é
  `E_CAPABILITY_MISSING` e nada mais acontece.
- **AC-1.11** Given 10 falhas induzidas do XCTest (alvo inexistente, `typeText` sem foco, bundle id
  falso), when cada uma acontece, then o runner continua respondendo `health` em ≤ 200 ms depois de
  cada uma.
- **AC-1.12** Given o runner vivo, when `health` é chamado enquanto um `ui.tree` lento está em curso
  na fila do XCTest, then `health` responde em ≤ 200 ms.
- **AC-1.13** Given `session.hello` respondido há 5 s, when o Mac pede `device.state`, then
  `foregroundApp` não é o hospedeiro nem o runner.
- **AC-1.14** Given o build do runner, when o script de build lista os produtos, then todo produto
  tem bundle id com prefixo `app.kifactory.contrarregra` (em particular nenhum é
  `app.kifactory.hagah`), e o `codesign -dvv` do hospedeiro e do `.xctrunner` mostra
  `TeamIdentifier=984PNJZ8B9` e `Authority=Apple Development: Andre Saboia (6NKUX5CX7G)`.
- **AC-1.15** Given a Central de Controle aberta pelo runner, when `ui.find {target: {app:
  springboard, identifier: "airplane-mode-button"}}`, then o interruptor é achado e seu `value`
  reflete o estado do modo avião.
- **AC-1.16** Given `runner.privateAllowed = []`, when `runner.capabilities` é pedido, then todo PX-n
  aparece com `allowed: false`, `device.lock` responde `E_CAPABILITY_MISSING` e toda ação responde
  `path: "public"`.
- **AC-1.17** Given uma coreografia do Hagah carregada, when chega `app.activate {bundleId:
  "com.apple.Preferences"}`, `app.openURL {url: "tel:123"}` ou `ui.tap {target: {app: springboard,
  label: "Settings", type: icon}}`, then a resposta é `E_FORBIDDEN_APP` e nada muda na tela; Given a
  folha do Sign in with Apple à frente, when `ui.tree` ou `screen.shot`, then `E_FORBIDDEN_APP`;
  Given a tela de início ou a tela travada à frente, when `screen.shot` ou `ui.tap {target: {ocr:
  {text: "Hagah"}}}`, then `E_FORBIDDEN_APP` e nada é capturado.
- **AC-1.18** Given PX-2 e PX-3 não liberados (✅ Q-5b/c), when 50 `ui.tap` são feitos com o áudio
  tocando, then todos respondem `path: "public"` e a espera de cada um fica registrada em
  `tDispatchNs − tDevStartNs`.
- **AC-1.19** Given um campo de texto comum em foco, when `ui.type {text: "someone@icloud.com"}` é
  pedido, then a resposta é `E_SECURE_FIELD` e nenhuma tecla é enviada.
- **AC-1.20** Given o runner observando, when o app em primeiro plano muda (Hagah → SpringBoard), then
  um evento `device.state` com o novo `foregroundApp` é emitido em ≤ 1 s.
- **AC-1.21** Given o áudio do app alvo tocando e a tela travada e apagada, when `device.wake` é chamado com ninguém olhando para o
  iPhone, then a tela acende na tela travada (`locked` continua `true`) e `ui.find` acha os controles
  de mídia da tela travada no SpringBoard.
- **AC-1.22** Given nenhuma coreografia carregada e `app.explore = app.kifactory.hagah`, when
  `ui.tree` é pedido com o Hagah à frente, then responde a árvore (sem `E_FORBIDDEN_APP`).
- **AC-1.23** Given a tela travada com `locked: false` depois do Face ID, when um ponto de controle
  `who: runner` faz o arrasto de destravar, then não há `E_FORBIDDEN_APP`; Given `locked: true`, then
  o mesmo arrasto responde `E_FORBIDDEN_APP`.
- **AC-1.24** Given o runner no iPhone físico, when `choreo.load` recebe uma coreografia com
  `app.bundleId: com.apple.Preferences`, ou chega `ui.tree` com Ajustes à frente e `app.explore =
  com.apple.Preferences`, then a resposta é `E_FORBIDDEN_APP` e nada é operado; Given o runner no
  simulador, when a mesma coreografia é carregada, then é aceita (AC-3.7).

---

## S2. Transporte Mac ↔ iPhone (US-6, US-15)

**Behavior**

1. **Subir o runner** ✅: `contrarregra runner build` gera o projeto (XcodeGen) e roda
   `xcodebuild build-for-testing` com o time `984PNJZ8B9` e assinatura automática;
   `contrarregra runner up` apaga `.xctestrun` de sessões velhas, escreve um da sessão (cópia do
   gerado, com as variáveis de S1 — `CONTRARREGRA_PORT`, `CONTRARREGRA_TOKEN`, `CONTRARREGRA_SESSION`,
   `CONTRARREGRA_PRIVATE`, `CONTRARREGRA_ALLOWED`, `CONTRARREGRA_EXPLORE` e, com `--spike`,
   `CONTRARREGRA_BIND` —, `chmod 600`) em `paths.cache/sessions/` e roda, destacado, com
   stdout/stderr para arquivo (nunca pipes) e sob `caffeinate -dimsu -w <pid>`:
   `xcodebuild test-without-building -xctestrun <sessão> -destination id=<udid>
   -only-testing ContrarregraRunner/RunnerTests/testServe -test-timeouts-enabled NO
   -collect-test-diagnostics never -parallel-testing-enabled NO -destination-timeout 60`.
   Pronto = runner responde `session.hello`. `runner build --configuration Spike` e `runner up
   --spike` usam a configuração `Spike` (métodos `spike.*`, S1); instalar um build novo dela é G5
   (P-6). Plano B (só se o SP-2 falhar): lançar o `.xctrunner`
   com `xcrun devicectl device process launch` (runner sem `Frameworks/XC*`; não verificado no
   Xcode 26.6 + iOS 26.x).
2. **Canal de comandos** ✅: cliente usbmuxd nativo em TypeScript (socket `usbmux.socketPath`,
   cabeçalho de 16 bytes, plist XML). Só aceita a entrada com `ConnectionType = "USB"` cujo
   `SerialNumber`, normalizado (sem hífens, maiúsculas), é igual ao UDID configurado normalizado do
   mesmo jeito (o formato cru é registrado no SP-4). `Connect {DeviceID, PortNumber: htons(port)}`
   vira um túnel TCP cru até o loopback do aparelho. No Mac, um repassador em
   `127.0.0.1:<efêmera>` liga o túnel ao cliente WebSocket nativo do Node.
3. **Duas conexões e um dono**: `control` (comandos e eventos) e `sync` (só `clock.ping`, sem
   capturas para não sofrer bloqueio de fila). O runner aceita **um** `control` por vez; uma segunda
   recebe `E_BUSY`. A CLI e o MCP abrem `control` **por comando** (hello → chamada → fecha); o
   supervisor da tomada segura `control` a tomada inteira, sob um arquivo de trava por aparelho
   (`paths.cache/locks/<udid>.lock`);
   comandos de exploração e `runner up|down` durante a tomada recebem `E_BUSY` com o `takeId`.
4. **Duas linhas de vida independentes**: a sessão do XCTest (túnel CoreDevice do `xcodebuild`)
   mantém o runner vivo; o usbmux carrega os comandos. Se a sessão do XCTest cair, o runner morre;
   se só o usbmux cair, o runner segue e a tomada continua no aparelho.
5. **Exigência de cabo** ✅ (HC-4): para tomada, `devicectl list devices --json-output <arquivo>` tem
   de mostrar `transportType = "wired"` e `tunnelState = "connected"`; com `localNetwork`, o pré-voo
   falha (PF-03, `E_NOT_WIRED`) e ensina o procedimento de forçar o cabo (Wi-Fi do iPhone desligado
   em Settings por 10 s e religado — SP-2).
6. **Reconexão**: batimento a 1 Hz; 3 faltas = caiu. Reconecta com recuo exponencial até 2 s;
   depois de reconectar: `session.hello`, `events.fetch {sinceSeq}` com o último evento recebido, e
   uma rajada de sincronia (S7). Sem cabo, comandos que falam com o aparelho falham rápido com "ligue
   o cabo" (`E_NO_USB`).
7. **Runner caído**: se o `xcodebuild` sai, o Mac registra e marca o runner como caído; `runner
   status` mostra `state: down` e todo comando que fala com o runner responde `E_RUNNER_DOWN` com a
   dica `runner up`. Nada religa sozinho: fora de tomada, quem religa é o dono ou o agente (`runner
   up`); **durante tomada nunca religa** (religar põe o runner na frente da tela, P-4): a tomada
   aborta (E-2.6). O caso "a sessão não sobrevive ao modo avião" é o SP-2 (⏳ Q-12).
8. **Gancho de teste**: `contrarregra runner sever --for <s>` acha o dono da conexão `control` (o
   supervisor, pelo arquivo de trava do aparelho, ou o próprio processo fora de tomada) e lhe pede,
   por um arquivo `sever.json {forS}` na pasta da tomada mais `SIGUSR1`, que feche os próprios
   sockets usbmux `control` e `sync` e não reconecte por `<s>` segundos, com cabo e sessão do XCTest
   intactos.

**API / Interface**
- CLI: `contrarregra runner build|up|down|status|logs|sever`; MCP: `runner_up`, `runner_down`,
  `runner_status` (S8).
- `runner status` → `{state: down|starting|up, pid, sessionId, transport: {usb, wired,
  tunnelState}, rttMs: {p50, p95}, uptimeS, controlHeldBy?}`.

**Error & Edge Cases**
- **E-2.1** usbmuxd não lista o aparelho → `E_NO_USB` em ≤ 1 s, sem novas tentativas cegas.
- **E-2.2** Só existe entrada `Network` para o UDID → recusa (`E_NO_USB`) e explica.
- **E-2.3** `Connect` devolve 3 (recusado) → runner não está escutando: `E_RUNNER_DOWN`.
- **E-2.4** O aparelho pede o código para "Enable UI Automation" ao subir a sessão → o `runner up`
  fica em `starting`, avisa no Mac (ponto de controle de preparo, S5) e espera ⚠️ 120 s.
- **E-2.5** Modo avião ligado durante a tomada → o canal pode piscar; o runner segue a coreografia
  sozinho; ao voltar, o Mac recupera os eventos pela sequência.
- **E-2.6** O `xcodebuild` morre durante a tomada → `take.abort` com causa `runner-lost`; a gravação
  para com o pós-rolo possível (S9).

**Acceptance Criteria (Given/When/Then)**
- **AC-2.1** Given o iPhone no cabo e o runner subido, when 1.000 `clock.ping` de 64 bytes vão pela
  conexão `sync`, then o RTT tem p50 ≤ 5 ms e p95 ≤ 20 ms.
- **AC-2.2** Given o runner subido e `transportType = wired`, when o modo avião é ligado por 60 s e
  desligado, 10 vezes, then o PID do runner é o mesmo, o processo que mantém a sessão (o
  `xcodebuild`, ou o lançado por `devicectl` no plano B do SP-2) continua vivo e o maior intervalo
  sem resposta ao batimento é ≤ 2 s.
- **AC-2.3** Given o cabo desligado, when um comando que fala com o aparelho (`device status`, `tap`,
  `runner up`) é dado, then a resposta é `E_NO_USB` em ≤ 1 s; comandos que não falam com o aparelho
  (`choreo validate`, `align`) seguem funcionando.
- **AC-2.4** Given `transportType = localNetwork`, when o pré-voo de tomada roda, then `PF-03` falha
  com a instrução de forçar o cabo.
- **AC-2.5** Given uma conexão `control` aberta, when uma segunda conexão `control` faz
  `session.hello`, then recebe `E_BUSY`.
- **AC-2.6** Given uma coreografia de 60 s rodando, when `runner sever --for 30` acontece no meio e o
  Mac reconecta, then `events.fetch` devolve todos os eventos com `seq` contínuo de 0 até `take.end`.
- **AC-2.7** Given `runner up` com o aparelho pronto e o túnel quente, when o comando roda, then o
  runner responde `session.hello` em ≤ 60 s.
- **AC-2.8** Given o runner ocioso por 4 h no cabo, when o Mac chama `health` a cada 10 s, then todas
  respondem e o runner não foi religado (SM-5).
- **AC-2.9** Given o `.xctestrun` da sessão, when `runner down` termina, then o arquivo foi apagado e
  o token não aparece em nenhum log.
- **AC-2.10** Given uma exploração MCP que acabou de rodar, when `take_start` é chamado, then o
  supervisor obtém `control` (PF-04 passa); e Given a tomada em curso, when a CLI manda `tap`, then
  recebe `E_BUSY` com o `takeId`.

---

## S3. Coreografia: formato, validação e compilação (US-4, US-5, US-8, US-17)

**Behavior**

1. O dono e o Claude Code escrevem a fonte YAML (S0.4); `contrarregra choreo validate` confere
   esquema, ids únicos, `ref` existentes, `cue` dentro do número de frases, ações permitidas por
   seção, `caption` ≤ 34 caracteres, e as regras de tomada, que valem dentro de `scenes`: sem `press
   volume*`, sem `launch` do app alvo, sem `openURL` (`openURL` só em `prepare`/`cleanup`); e, em
   qualquer seção, sem passo `type` cujo alvo seja `secureTextField` (direto ou via `ref`) ou cujo
   texto pareça credencial.
2. `contrarregra choreo compile` produz o JSON canônico: expande `ref`, aplica padrões, sintetiza a
   faixa-guia por frase (S6), grava os tempos de cada frase e a permanência mínima de cada cena, e
   calcula `compiled.sha256` (S0.4).
3. O mesmo formato serve para qualquer app (US-17): nada no runner ou no Mac conhece o Hagah; tudo
   que é do Hagah mora em `choreographies/hagah/` (✅ Q-4).
4. **Do exploratório ao passo** (US-4): depois de uma ação bem-sucedida pelo MCP/CLI, `record_step`
   devolve o passo YAML equivalente, escolhendo o seletor mais estável na ordem: `identifier` →
   `label` exato + `type` (único) → `labelPrefix` + `type` → `within`/`index` → `ocr` → `point`
   normalizado; inclui um `expect` sugerido a partir da árvore seguinte e o `caption` em branco.

**Exemplo real — cena 2 do roteiro**, com os rótulos do app nativo (o roteiro cita textos da PWA;
ver S13):

```yaml
targets:
  chapterTitle: {labelPrefix: "Psalms", type: button}   # título do capítulo no cabeçalho ("Psalms 1")
  miniPlay:     {label: "Play", type: button}           # único na tela do leitor (SP-10 confirma)
  miniPause:    {label: "Pause", type: button}

scenes:
  - id: s02
    title: "O diferencial: áudio e texto juntos"
    line:
      - "Here's what makes Hagah different."
      - "Most Bible audio is a separate recording you listen to away from the text."
      - "In Hagah the two are one thing: as the narration plays, the verse being read is highlighted — and inside it, the exact word being spoken."
      - "These timings come from our own alignment pipeline, not from a text-to-speech engine; this is a human narration of the New International Version."
      - "The point is meditation: you hear it and you see it at the same time, so the text stays with you."
    steps:
      - {id: s02.picker, do: tap, target: {ref: chapterTitle}, visual: true,
         caption: "Abre o seletor de capítulo",
         expect: {element: {label: "Choose a reading"}, state: exists}}
      # o seletor abre com o livro atual (Salmos, pois o preparo deixa o Salmo 1) já expandido
      - {id: s02.find23, do: scrollTo, target: {label: "23", type: button, below: {label: "Psalms", type: button}},
         direction: down, maxSwipes: 6}
      - {id: s02.ch23, do: tap, target: {label: "23", type: button, below: {label: "Psalms", type: button}},
         visual: true, caption: "Capítulo 23",
         expect: {element: {labelPrefix: "Psalms 23", type: button}, state: exists}, expectTimeoutMs: 5000}
      - {id: s02.play, do: tap, target: {ref: miniPlay}, cue: 1, visual: true,
         caption: "Toca play no mini-player",
         expect: {element: {ref: miniPause}, state: exists}}
      - {id: s02.listen, do: wait, ms: 20000, caption: "Toca 20 s; a palavra acende"}
      - {id: s02.scroll, do: drag, from: {nx: 0.5, ny: 0.62}, to: {nx: 0.5, ny: 0.50},
         pressMs: 40, durationMs: 500, caption: "Rola de leve; a lista para"}
      - {id: s02.follow, do: tap, target: {label: "Follow the narration"}, optional: true, visual: true,
         caption: "Volta a seguir a narração"}
      - {id: s02.np, do: tap, target: {labelPrefix: "Open Now Playing", type: button}, cue: 4,
         visual: true, caption: "Abre o Now Playing",
         expect: {element: {label: "Previous verse", type: button}, state: exists}}
      - {id: s02.end, do: hold}
```

**Exemplo real — cena 7** (cadastro, sincronia, exclusão, novo login). Três pontos de controle de
Face ID; o toque em "Continue" na folha da Apple não é credencial e o runner o faz quando a folha o
expõe (SP-8):

```yaml
targets:
  tabJournal:   {label: "Journal", type: button, within: {type: tabBar}}
  siwaButton:   {label: "Sign in with Apple", type: button}
  siwaContinue: {app: authkit, label: "Continue", type: button}
  journalTop:   {labelPrefix: "Signed in with Apple"}

scenes:
  - id: s07
    title: "Conta: cadastro, login, sincronia e exclusão"
    line:
      - "Signing in is optional; it only syncs highlights, notes and plan progress between devices."
      - "There are two ways in — Sign in with YouVersion, and Sign in with Apple right next to it."
      - "I'll use Sign in with Apple; that creates the account, and the app asks only for my name, never my e-mail."
      - "Now it's synced."
      - "Account deletion is inside the app: Journal, gear icon, Settings, Account, Delete account."
      - "It tells me exactly what happens: the synced journal on our server is erased immediately, sessions on other devices stop working, and the device is signed out."
      - "Apple asks me to confirm so the app can revoke its token with Apple as well."
      - "Done — account deleted."
      - "If I sign in again with the same Apple ID, the journal comes back empty: nothing was kept on the server."
    steps:
      - {id: s07.tab, do: tap, target: {ref: tabJournal}, visual: true, caption: "Aba Diário",
         expect: {element: {ref: siwaButton}, state: hittable}, expectTimeoutMs: 5000}
      - {id: s07.signup, do: tap, target: {ref: siwaButton}, cue: 2, visual: true,
         caption: "Entrar com a Apple: é o cadastro"}
      - {id: s07.signup.continue, do: tap, target: {ref: siwaContinue}, optional: true, timeoutMs: 6000}
      - id: s07.cp.signup
        do: checkpoint
        who: human
        ask: "Face ID do cadastro: olhe para o iPhone."
        until: {element: {ref: journalTop}, state: exists}
        timeoutMs: 90000
        onTimeout: pause
      - {id: s07.sync, do: drag, from: {nx: 0.5, ny: 0.30}, to: {nx: 0.5, ny: 0.62},
         pressMs: 60, velocity: 350, holdMs: 400, cue: 3, caption: "Puxa para sincronizar",
         expect: {element: {labelPrefix: "Synced"}, state: changed}, expectTimeoutMs: 10000}
      - {id: s07.gear, do: tap, target: {label: "Open settings", type: button}, cue: 4, visual: true,
         caption: "Engrenagem → Ajustes"}
      - {id: s07.find, do: scrollTo, target: {label: "Delete account", type: button}, direction: down, maxSwipes: 10}
      - {id: s07.delete, do: tap, target: {label: "Delete account", type: button}, cue: 5, visual: true,
         caption: "Excluir conta", expect: {element: {label: "Delete account?", type: alert}, state: exists}}
      - {id: s07.confirm, do: tap, cue: 6,
         target: {label: "Permanently delete account", within: {label: "Delete account?", type: alert}},
         caption: "Confirma a exclusão definitiva"}
      - {id: s07.revoke.continue, do: tap, target: {ref: siwaContinue}, optional: true, timeoutMs: 6000}
      - id: s07.cp.revoke
        do: checkpoint
        who: human
        ask: "Face ID de novo: a Apple confirma a revogação."
        until: {element: {label: "Account deleted", type: alert}, state: exists}
        timeoutMs: 90000
        onTimeout: pause
      - {id: s07.ok, do: tap, target: {label: "OK", within: {label: "Account deleted", type: alert}}, cue: 8}
      - {id: s07.back, do: tap, target: {label: "Back", type: button, fallback: [{point: {x: 24, y: 64}}]},
         expect: {element: {ref: siwaButton}, state: hittable}, caption: "Volta ao Diário, deslogado"}
      - {id: s07.signin, do: tap, target: {ref: siwaButton}, visual: true, caption: "Entra de novo"}
      - {id: s07.signin.continue, do: tap, target: {ref: siwaContinue}, optional: true, timeoutMs: 6000}
      - id: s07.cp.signin
        do: checkpoint
        who: human
        ask: "Último Face ID da cena 7."
        until: {element: {ref: journalTop}, state: exists}
        timeoutMs: 90000
        onTimeout: pause
      - {id: s07.resync, do: drag, from: {nx: 0.5, ny: 0.30}, to: {nx: 0.5, ny: 0.62},
         pressMs: 60, velocity: 350, holdMs: 400, caption: "Sincroniza com o servidor",
         expect: {element: {labelPrefix: "Synced"}, state: changed}, expectTimeoutMs: 10000}
      - {id: s07.empty, do: assert, condition: {element: {label: "0 entries"}, state: exists},
         caption: "O diário volta vazio"}
      - {id: s07.end, do: hold}
```

**API / Interface**
- CLI `contrarregra choreo validate <arquivo>` → `{ok, errors: [{path, rule, message}]}`;
  `choreo compile <arquivo>` → caminho do JSON compilado e `sha256`; `record-step` → o passo em
  YAML e o `expect` sugerido. MCP `choreo_validate`, `choreo_compile`, `record_step` com as mesmas
  saídas.

**Error & Edge Cases**
- **E-3.1** `ref` inexistente, `cue` ≥ número de frases, id repetido, `caption` com mais de 34
  caracteres → a validação falha com o caminho exato; a compilação não roda.
- **E-3.2** Cena sem `line` → permitido (permanência mínima = `padBeforeMs + padAfterMs`), com aviso.
- **E-3.3** Passo `type` cujo alvo tem `type: secureTextField` (direto ou via `ref`) ou cujo texto
  parece credencial (regex de e-mail) → a validação recusa (P-3).
- **E-3.4** `record_step` sem ação anterior bem-sucedida → erro claro, nada gerado.

**Acceptance Criteria (Given/When/Then)**
- **AC-3.1** Given `choreographies/fixtures/s02-s07.choreo.yaml` (o cabeçalho de S0.4 com `prepare` e
  `cleanup` vazios, os dois catálogos `targets` acima fundidos e as cenas 2 e 7 acima, sem alteração,
  numa única lista `scenes`), when `choreo validate` roda, then sai com 0 erros.
- **AC-3.2** Given uma cena com `press {button: volumeUp}` ou `app {action: launch}` do app alvo,
  when validada, then falha citando a regra de tomada.
- **AC-3.3** Given `openURL` dentro de `scenes`, when validada, then falha; Given o mesmo em
  `prepare`, then passa.
- **AC-3.4** Given um JSON compilado válido, when `choreo.load` o recebe, then o `sha256` recalculado
  pelo runner é igual a `compiled.sha256`; Given o mesmo JSON com um `openURL` inserido em `scenes`,
  then `E_CHOREO_INVALID` citando a regra.
- **AC-3.5** Given um toque exploratório bem-sucedido num botão com rótulo único, when `record_step`
  é chamado, then devolve um passo com `label` + `type` e um `expect` que é verdadeiro na tela
  seguinte.
- **AC-3.6** Given um toque exploratório por OCR, when `record_step` é chamado, then o passo gerado
  usa `ocr` com `within` do elemento que contém o texto.
- **AC-3.7** Given `choreographies/fixtures/settings.choreo.yaml` para `com.apple.Preferences` no
  simulador (abrir, rolar até "General", tocar, voltar), when `rehearse` roda, then todo passo
  termina `status: ok`, e `grep -ri hagah mac/src ios/ --exclude-dir=Spikes` não acha nada (US-17).
- **AC-3.8** Given um passo com `caption` de 35 caracteres ou um `type` com alvo `{type:
  secureTextField}`, when validado, then falha citando E-3.1 ou E-3.3.

---

## S4. Execução da tomada no aparelho (US-6, US-8)

**Behavior**

1. **Fluxo da tomada** (orquestrado pelo supervisor no Mac, S8): limpeza pendente da tomada
   anterior, se houver (S12 item 4) → `choreo compile` (com a guia, S3) → pré-voo PF-01…PF-14,
   PF-16, PF-17 com `choreo.load` assim que PF-04 passa (S12 item 1) → `choreo.run {section:
   prepare}` (sem gravar) → PF-15 → rajada de sincronia pré (S7) → início da gravação e pré-rolo
   (S9) → `choreo.run {section: scenes}` → cenas → pós-rolo → `StopRecord` (S9) → `choreo.run
   {section: cleanup}` → coleta de eventos → rajada pós → alinhamento (S7) → saídas (S10).
2. **No aparelho**: cada `choreo.run` fixa o `T0` (D) da sua seção. O executor agenda por **prazos
   absolutos** a partir de `T0` no `ContinuousClock`, com tolerância de 1 ms; nunca encadeia esperas
   relativas.
3. **Ordem e tempo dos passos**: cada passo tem início agendado `max(fim do anterior + afterMs,
   início da frase cue)`; `lateMs` = início real − início agendado. A cena *i* começa quando a
   anterior termina e termina em `max(fim do último passo, início da cena + holdMs)`, com
   `holdMs = padBefore + Σ(frases) + (n−1)·sentenceGapMs + padAfter` (S6). O que passar de
   `início + holdMs` por causa de passos longos é `overrunMs` no `scene.end`. O tempo de espera de um
   ponto de controle conta como tempo da cena.
4. **Sem rede no meio**: a coreografia inteira está no aparelho; o executor não espera o Mac para
   nada. Cada evento vai para a memória e para `Documents/contrarregra/<takeId>/events.ndjson` no
   contêiner do runner, e é empurrado ao Mac quando há conexão.
5. **Falha de passo**: alvo não resolvido no prazo, `expect` falso no prazo ou erro da ação →
   `step.fail` e `onFail`. `pause`: o executor para, o Mac avisa (S5) e espera `choreo.resume` ou
   `choreo.abort` por até ⚠️ 120 s, depois aborta. Retomar depois de uma pausa por falha gera um
   evento `intervention`; `choreo.resume {skipStep: false}` (padrão) tenta o passo de novo,
   `{skipStep: true}` segue do seguinte.
6. **Abortar** (durante `prepare` ou `scenes`; abortar a `cleanup` segue S12 item 3): o executor
   para no ponto atual; o Mac encerra a gravação com o pós-rolo e marca a tomada `aborted`; as
   saídas de diagnóstico são geradas mesmo assim e, se `scenes` chegou a começar, a `cleanup` segue
   pendente (`cleanupPending: true` desde `take.start`, S12 item 3) para a próxima `take run`. Se a
   tomada abortou com o modo avião ligado (um `checkpoint` de avião ligado sem o de desligar),
   `take.json` registra `airplaneLeftOn: true` e o Mac avisa o dono para desligá-lo.
7. **Modo `dry`**: executa a coreografia no aparelho sem gravar (para ensaiar no iPhone).

**API / Interface**
- `choreo.load {choreography, takeId, mode: take|rehearsal|dry}` → `{sha256, scenes, steps}`.
- `choreo.run {section: prepare|scenes|cleanup, startAtD?}` → `{t0Ns}` imediatamente; o progresso
  chega por eventos. As seções rodam em ordem, cada uma uma vez por `load`: `prepare` → `scenes` →
  `cleanup`; `cleanup` também roda logo depois do `load` (limpeza pendente, S12 item 4); fora disso,
  `E_CHOREO_STATE`. `startAtD` só vale em `scenes`. As regras de tomada (S1 item 9) valem só durante
  `scenes`; `take.start` e `take.end` marcam o começo e o fim de `scenes`, e os eventos de
  `prepare`/`cleanup` levam `sceneId: "prepare"` ou `"cleanup"`.
- `choreo.status` → `{state: idle|loaded|running|paused|checkpoint|done|aborted, section:
  prepare|scenes|cleanup|null, sceneId, stepId, seq, lateMsP95}` (`done` = a seção em `section`
  terminou).
- `choreo.pause`, `choreo.resume {skipStep?: bool}`, `choreo.abort {reason}`.

**Error & Edge Cases**
- **E-4.1** O aparelho trava sozinho no meio (Auto-Lock) → o passo seguinte falha com
  `{locked: true}`; o pré-voo deveria ter impedido (PF-11).
- **E-4.2** A guia não foi compilada → `choreo.load` recusa (`E_CHOREO_INVALID`: falta `compiled`).
- **E-4.3** Um passo atrasa a cena além do `hold` → permitido; o excesso fica em `overrunMs` e aparece
  na tabela de tempos.
- **E-4.4** `choreo.run` com outra coreografia já rodando → `E_CHOREO_STATE`.

**Acceptance Criteria (Given/When/Then)**
- **AC-4.1** Given uma cena com uma única frase de 12,0 s na guia, `padBefore` 1,0 s, `padAfter`
  1,5 s e passos que terminam em 5 s, when a cena roda, then `scene.end − scene.start` está entre
  14,5 s e 14,55 s.
- **AC-4.2** Given a fixture `timing.choreo.yaml` com 200 passos `wait` (50–500 ms) e `hold`, sem
  toque, no aparelho, when roda, then p95(`lateMs`) ≤ 20 ms e o máximo ≤ 50 ms.
- **AC-4.3** Given um passo com `cue: 2`, when a cena roda, then `step.start` desse passo é ≥ o início
  da frase 2 na guia.
- **AC-4.4** Given uma coreografia de fixture com ≥ 90 s e `runner sever --for 60` no início da sua
  2.ª cena, when a coreografia segue, then todos os passos executam e o Mac recupera depois a sequência
  completa de eventos.
- **AC-4.5** Given um passo com `expect` que nunca fica verdadeiro e `onFail: pause`, when o prazo
  estoura, then o executor pausa e emite `step.fail` e `take.pause`; Given `choreo.resume {skipStep:
  true}`, then gera `intervention` e continua do passo seguinte; Given `{skipStep: false}`, then o
  passo que falhou é tentado de novo.
- **AC-4.6** Given `choreo.abort` no meio da cena 5, when chega, then nenhum passo novo começa e a
  tomada termina `aborted` com `events.json` gerado.
- **AC-4.7** Given um passo `optional: true` cujo alvo não aparece dentro de `timeoutMs`, when roda,
  then registra `step.end` com `status: "skipped"` e não pausa.
- **AC-4.8** Given um alvo que aparece 1,5 s depois do início do passo e `timeoutMs: 4000`, when o
  passo roda, then o toque acontece ≤ 200 ms depois de o alvo aparecer.
- **AC-4.9** Given um `block` com `when` falsa contendo um `checkpoint`, when roda, then nenhum ponto
  de controle é aberto e o bloco é registrado `skipped`.
- **AC-4.10** Given um passo com `repeat: {until: <condição que vale na 3.ª vez>, max: 5}`, when roda,
  then executa 3 vezes e segue; Given `max: 2`, then aplica `onFail`.

---

## S5. Pontos de controle humano (US-7)

**Behavior**

1. Um passo `checkpoint` tem `{id, who: human|runner, ask, until: Condition, timeoutMs, onTimeout:
   pause|abort, steps?: [Step], alert?: {sound, say}}`. `who: human` = a pessoa age no aparelho;
   `who: runner` = o runner executa `steps` (ações de sistema que não são credencial, ex.: abrir a
   Central de Controle e tocar o modo avião) e depois espera `until`.
2. Ao chegar num ponto de controle, o runner avalia `until` uma vez: se já é verdadeira, emite só
   `checkpoint.resolved {waitedMs: 0}` (E-5.1); senão emite `checkpoint.wait` e passa a sondar
   `until` a cada 100 ms. O Mac, ao receber um `checkpoint.wait` com `who: human`, **avisa no Mac**:
   som curto (`paths.ffmpeg -f audiotoolbox` no `alerts.sayDevice`) e `say -a <alerts.sayDevice>` em
   português, nunca no iPhone e nunca num dispositivo que o OBS grava (P-4, P-7); repete o aviso a
   cada ⚠️ 20 s. `who: runner` não gera aviso.
3. Quando `until` fica verdadeira, o runner emite `checkpoint.resolved {waitedMs}` e **continua
   sozinho**, sem comando do Mac. Estourou o prazo → `checkpoint.timeout` e `onTimeout`.
4. O runner **nunca** age no lugar da pessoa em credenciais: Face ID, código, senha. Tocar
   "Continue" numa folha de sistema não é credencial; digitar não é permitido.
5. **Pontos de controle de preparo** (antes de gravar, no pré-voo): código do aparelho ao subir a
   automação ("Enable UI Automation"), e a lista que só a pessoa confirma (S12, PF-11).
6. Pontos de controle **da tomada do Hagah** (S13 item 6): Face ID do cadastro, da revogação e do novo
   login (cena 7; conta Apple do aparelho, ✅ Q-2); destravar depois da tela travada (cena 3; acender
   é o passo `wake`, ponto de controle só no plano B do SP-7); modo avião ligar (cena 9) e desligar (cena 10) — `who: human` por padrão ✅ (ADR-7). Se o SP-1
   mostrar que toques humanos são bloqueados durante a automação, a coreografia passa a usar `who:
   runner` com `steps` para o modo avião e para o arrasto de destravar depois do Face ID.

**API / Interface**
- Evento `checkpoint.wait {id, who, ask, timeoutMs}`; `checkpoint.resolved {id, waitedMs}`;
  `checkpoint.timeout {id}`; o Mac registra `checkpoint.alert {id, at}`.
- MCP `take_wait` devolve cedo quando um ponto de controle começa (S8).

**Error & Edge Cases**
- **E-5.1** A condição já é verdadeira ao chegar (ex.: o dono foi rápido) → só `checkpoint.resolved
  {waitedMs: 0}`, sem `checkpoint.wait` nem aviso sonoro (item 2).
- **E-5.2** O Mac está sem conexão com o runner quando o ponto de controle começa → o runner espera
  igual; o Mac avisa assim que reconecta e lê `choreo.status.state = checkpoint`.
- **E-5.3** O Face ID falha e o iOS pede o código → se toques humanos funcionam, a pessoa digita; se o
  SP-1 mostrar que não, o prazo estoura e a tomada pausa (repetir a cena exige nova tomada).
- **E-5.4** Uma folha de sistema inesperada surge no lugar da esperada → `until` não fica
  verdadeira; prazo; `onTimeout`.

**Acceptance Criteria (Given/When/Then)**
- **AC-5.1** Given um ponto de controle `who: human` com `until` = elemento "Signed in with Apple…",
  when a pessoa conclui o Face ID, then, no vídeo alinhado (S7), `checkpoint.resolved.tFinalS` menos o
  tempo F do primeiro quadro em que o elemento é visível é ≤ 1,0 s, e não há pedido do Mac entre
  `checkpoint.resolved` e o `step.start` seguinte.
- **AC-5.2** Given um ponto de controle `who: human` cuja condição é falsa ao chegar, when o Mac
  recebe `checkpoint.wait`, then toca o aviso no `alerts.sayDevice` em ≤ 1 s e registra
  `checkpoint.alert`.
- **AC-5.3** Given uma gravação de teste do OBS com o perfil da ferramenta e o iPhone em silêncio
  (nenhum app tocando), when três avisos de ponto de controle tocam, then `ffmpeg -af astats` na
  faixa 1, nas janelas [`checkpoint.alert` em R, +3 s], dá pico < −60 dBFS.
- **AC-5.4** Given um ponto de controle com `timeoutMs: 5000` que ninguém resolve, when o prazo
  estoura, then `checkpoint.timeout` é emitido e `onTimeout` é aplicado.
- **AC-5.5** Given uma fixture com `checkpoint {who: human, until: {element: {type: secureTextField},
  state: gone}}`, when validada, then passa; Given um passo `type` com `target: {type:
  secureTextField}`, when validado, then falha citando E-3.3.
- **AC-5.6** Given o ponto de controle de destravar (`until: {all: [{locked: false}, {element: <alvo
  do app>, state: hittable}]}`), when a pessoa destrava com Face ID e arrasta para cima, then, no vídeo
  alinhado, o `checkpoint.resolved` fica ≤ 1,0 s depois do primeiro quadro sem a tela travada.
- **AC-5.7** Given um ponto de controle `who: runner` com `steps` (abrir a Central de Controle, tocar
  o modo avião, esperar 2 s, fechar) e `until: {network: offline}`, when roda, then os passos executam
  na ordem e o ponto de controle resolve sem aviso humano.

---

## S6. Faixa-guia e ritmo (US-8)

**Behavior**

1. Para cada frase de `line`, o Mac sintetiza a fala com `say` (voz `guide.voice`, WAV 48 kHz
   16 bits), apara o silêncio inicial e final (`silenceremove`, −50 dB) e mede a duração com o
   `ffprobe` fixado. O `-r` do `say` não é confiável (a Samantha ignora velocidades baixas), então o
   ritmo é ajustado depois: fator de tempo `atempo = targetWpm / wpmMedido` (ex.: 150/178 = 0,84 deixa
   a fala mais lenta; filtros `atempo` encadeados se sair de 0,5–2,0), sem mudar o tom ✅;
   `compiled.guide.factor` guarda esse valor. Palavra = token separado por espaço que contém letra ou
   dígito.
2. **Calibrar o ritmo do dono** (uma vez): o dono lê as falas das cenas 1, 4 e 8; `guide calibrate`
   mede as palavras por minuto dele (do início da primeira ao fim da última fala, por `silencedetect`) e
   grava em `guide.targetWpm`. Sem calibração vale ⚠️ 150 wpm.
3. A cena dura no mínimo `padBefore + Σ(frases) + (n−1)·sentenceGapMs + padAfter`. Cada frase tem
   `startMs` relativo ao início da cena (o que os `cue` usam).
4. Depois da tomada, o Mac monta `guide.aligned.wav`: cada frase posicionada no tempo F em que sua
   cena e seu `cue` realmente aconteceram (`adelay` + `amix` sem normalizar + `apad` até a duração do
   vídeo), para o dono dublar ouvindo a guia.
5. Gemini TTS: só se o dono pedir (✅ Q-7), como outro gerador atrás da mesma interface.

**API / Interface**
- CLI `contrarregra guide build <choreo>`, `guide calibrate`, `guide play <scene>`; MCP
  `guide_build`. Saídas em `paths.cache/guide/<sha>/s07-03.wav` e na pasta da tomada.

**Error & Edge Cases**
- **E-6.1** Voz configurada não instalada → erro com a lista de vozes inglesas presentes.
- **E-6.2** `ffmpeg`/`ffprobe` em `paths.*` diferente de 8.1.1 → `E_TOOLCHAIN_MISMATCH` (o do PATH é
  4.4.7).
- **E-6.3** Frase vazia → ignorada com aviso.

**Acceptance Criteria (Given/When/Then)**
- **AC-6.1** Given a fala da cena 2 do exemplo de S3 (88 palavras pela regra do item 1) e `targetWpm`
  150, when a guia é gerada, then a soma das durações das frases (sem as pausas entre elas) fica em
  88/150 min ± 10 % (35,2 s ± 3,5 s).
- **AC-6.2** Given `guide calibrate` feito com as cenas 1, 4 e 8, when o dono lê as cenas 2, 6 e 10 e
  a duração lida é medida com `silencedetect`, then |previsto − lido| / lido ≤ 10 % em cada uma
  (procedimento com o dono).
- **AC-6.3** Given uma tomada terminada, when `guide.aligned.wav` é gerado, then o início de cada frase
  fica a ≤ 20 ms do tempo F previsto (medido com `silencedetect`).
- **AC-6.4** Given a mesma coreografia sem mudanças, when a guia é gerada de novo, then reaproveita os
  WAVs do cache (mesmo `sha256`).

---

## S7. Relógio, registro e sincronia (US-11)

**Behavior**

1. **Carimbos**: no aparelho, todo evento leva `CLOCK_MONOTONIC_RAW` (= `ContinuousClock`, conta
   durante o sono) e também `CLOCK_UPTIME_RAW` (para detectar sono). No Mac,
   `process.hrtime.bigint()` (= `mach_continuous_time` no Node 22). Proibido usar relógio de parede
   para intervalos.
2. **Aparelho → Mac**: rajadas de 32 trocas de 4 carimbos (estilo NTP: T1 Mac envio, T2 aparelho
   recebe, T3 aparelho responde, T4 Mac recebe) a 10 ms de intervalo pela conexão `sync`; fica o
   quarto de menor atraso; deslocamento θ = ½[(T2−T1)+(T3−T4)]. Rajadas: a pré, logo antes de
   `StartRecord` (S4 item 1; a do PF-14 é outra, no pré-voo), a cada ~20 s durante a tomada (se
   houver conexão) e a pós, depois da `cleanup`. Ajuste robusto θ(t) = a + b·t (Theil-Sen); `b` em
   ppm. Qualidade: resíduo ≤ 2 ms e |b| ≤ 150 ppm, senão `E_SYNC_QUALITY` (aviso).
3. **Mac → gravação**: pré-rolo = 2 s parado → 8 marcas → ≥ 1,5 s de tela de início parada → libera o
   runner; pós-rolo = ≥ 1,5 s parado → 8 marcas → fim. Cada marca é um lote `SerialFrame` do OBS que
   liga a fonte de cor "Sync Flash" por 2 quadros, em intervalos aleatórios de 400–900 ms, anotando
   T1 de cada envio; no arquivo, cada marca é achada pela luminância média (`signalstats` YAVG). T0ᵢ =
   T1ᵢ − kᵢ·Δ + Δ/2; T0 = média dos T0ᵢ; erro padrão = desvio-padrão/√n. Pré + pós dão a deriva. O
   pré e o pós-rolo são aparados no vídeo entregue (✅ Q-16).
4. **Latência de captura (tela do iPhone → quadro no OBS)**: estimada por tomada com os passos
   `visual: true`: para cada um, recorta uma região em volta do alvo (frame em pontos × 3 px/pt) e acha
   o primeiro quadro que muda depois do previsto (`signalstats` YDIF; classificação com `tblend` YMAX
   ≥ 64). `tPredRawS` = `tDispatchNs` levado a M (θ) e a R (T0), sem latência. Ajuste V = α + (1+β)·P,
   com P = `tPredRawS` e V = o quadro observado em R (`tVideoObservedS` + `trim.startR`). Eventos sem
   mudança detectada ficam marcados e fora do ajuste.
5. **Tempo de cada evento no vídeo**: `tRecS` = α + (1+β)·`tPredRawS` (em R; ajuste com todos os
   passos detectados); `tFinalS` = `tRecS` − `trim.startR` (em F). `events.json` guarda `tPredRawS`,
   `tRecS`, `tFinalS`, o observado (`tVideoObservedS`, em F) e `detectScore`. Eventos do runner sem
   `tDispatchNs` (`scene.*`, `checkpoint.*`) usam `tDevStartNs` no lugar dele, com o mesmo ajuste;
   eventos do Mac vão de `tMacNs` a R só por T0, sem latência.
6. **Medida da meta ±100 ms (SM-2)**: erro do passo *i* = |`tVideoObservedS`ᵢ − (V̂₋ᵢ −
   `trim.startR`)|, onde V̂₋ᵢ (em R) vem do ajuste (α, β) feito **sem** o passo *i* (deixa um de
   fora), sobre os passos `visual: true` detectados (mínimo 10); meta: mediana ≤ 50 ms e máximo ≤
   100 ms. `sync.json` também traz o erro sem a correção visual (só θ, T0 e a latência medida no
   SP-6), para expor viés. Tomada fora da meta: `syncOk: false` e não é entregue sem o sim do dono
   (P-5). Com menos de 2 passos detectados, α = `sync.captureLatencyMs`, β = 0 e
   `captureLatency.method: "calibrated"`; com menos de 10, `error` = null e `ok: false` (não
   avaliado), e a tomada não conta para SM-2.
7. **Calibração dedicada** (só manutenção/spike, nunca numa tomada): `contrarregra sync calibrate`
   lança o hospedeiro por `devicectl device process launch`, grava 10 min do relógio (S0.10) no OBS,
   decodifica os quadros e mede a distribuição da latência de captura com e sem "Use Buffering"; ao
   fim, encerra o hospedeiro.

**API / Interface**
- CLI `contrarregra sync measure` (rajadas soltas), `sync calibrate`, `contrarregra align <takeDir>`
  (refaz o alinhamento); MCP `align`.
- `sync.json` (S0.9) e os campos de tempo em `events.json` (S0.7).

**Error & Edge Cases**
- **E-7.1** Sem conexão na rajada pós (cabo solto) → o ajuste usa só o pré e a estimativa visual (que
  também mede inclinação); `sync.json` diz o método.
- **E-7.2** Marca de pré-rolo não achada (fonte de cor ausente) → `E_OBS_CONFIG` antes de gravar;
  depois de gravar, cai para `GetOutputStatus {outputName: "adv_file_output"}` registrado a 4 Hz (mais
  grosseiro) e marca o aviso.
- **E-7.3** Animação contínua perto da região do toque (karaokê) → a detecção usa a região do destino
  esperado, não só a do toque; sem pico claro, evento fora do ajuste.
- **E-7.4** O aparelho dormiu (diferença entre os dois relógios cresceu) → evento `device.state` e
  nova âncora depois do despertar.

**Acceptance Criteria (Given/When/Then)**
- **AC-7.1** Given o aparelho no cabo por 20 min com rajadas de 32 trocas a cada 10 s, when o ajuste
  roda, then o resíduo RMS é ≤ 1 ms e a interpolação no meio usando só pré+pós erra ≤ 2 ms.
- **AC-7.2** Given uma gravação com 8 marcas no pré-rolo, when o alinhamento roda, then as 8 são
  achadas, |T0ᵢ − T0| ≤ 17 ms para toda marca e o erro padrão de T0 é ≤ 3 ms.
- **AC-7.3** Given uma tomada com ≥ 10 passos `visual: true` detectados, when o alinhamento roda, then
  o erro do item 6 (deixa um de fora) tem mediana ≤ 50 ms e máximo ≤ 100 ms (SM-2), e o resultado sai
  em `sync.json`.
- **AC-7.4** Given uma tomada com o modo avião ligado na cena 9, when o alinhamento roda, then a cena 9
  tem ≥ 2 passos visuais detectados e cada um tem erro (item 6) ≤ 100 ms.
- **AC-7.5** Given o ensaio no simulador (relógio do Mac nos dois lados), when o alinhamento roda, then
  o deslocamento aparelho→Mac estimado é |θ| ≤ 1 ms.
- **AC-7.6** Given um evento cujo quadro não muda, when o alinhamento roda, then ele aparece com
  `tVideoObservedS: null` e fica fora do cálculo, sem derrubar a tomada.
- **AC-7.7** Given `sync calibrate` rodando 10 min, when termina, then o relatório traz a mediana e o
  espalhamento p95−p5 da latência de captura, decodificados do código de S0.10, e o hospedeiro foi
  encerrado.

---

## S8. Lado do Mac: CLI e servidor MCP (US-1, US-2, US-3, US-4, US-9, US-10, US-15, US-16)

**Behavior**

1. Um núcleo TypeScript, duas frentes: a CLI `contrarregra` (todo subcomando aceita `--json`) e o
   servidor MCP stdio `contrarregra` para o Claude Code, com as mesmas operações (tabela abaixo).
2. **Ferramentas MCP** (`snake_case`; as 6 marcadas ★ têm `_meta['anthropic/alwaysLoad'] = true`):

| MCP | CLI | MCP | CLI |
|---|---|---|---|
| ★`device_status` | `device status` | `record_step` | `record-step` |
| ★`screenshot {scale?, region?}` | `screenshot [--native]` | `choreo_validate`, `choreo_compile` | `choreo validate\|compile` |
| ★`ui_tree {app?, format?}` | `tree` | `guide_build` | `guide build` |
| `find {target}` | `find` | `take_preflight` | `take preflight` |
| ★`tap`, `double_tap`, `long_press` | `tap`, `double-tap`, `long-press` | `take_start {choreography, mode}` | `take run --detach` |
| `drag`, `scroll_to` | `drag`, `scroll-to` | ★`take_wait {takeId, cursor, timeoutS ≤ 55}` | `take wait` |
| `type_text`, `press_button` | `type`, `press` | `take_status`, `take_resume`, `take_abort` | `take status\|resume\|abort` |
| `go_home`, `control_center` | `home`, `control-center` | `obs_status` | `obs status` |
| `lock_screen`, `wake_screen` | `lock`, `wake` | `record_start`, `record_stop`, `record_chapter` | `obs start\|stop\|chapter` |
| `app {bundleId, action}`, `open_url` | `app`, `open-url` | `align`, `outputs_export`, `mix_render` | `align`, `export`, `mix` |
| `ocr {text?, region?}`, `zoom {region}` | `ocr`, `zoom` | ★`doctor` | `doctor` |
| `wait_for {condition, timeoutMs}` | `wait-for` | `runner_up`, `runner_down`, `runner_status` | `runner up\|down\|status` |
| `batch {steps, stopOnError}` | `batch --file` | `rehearse_start` | `rehearse --detach` |

   `zoom {region}` devolve a captura nativa (PNG em px) só da região dada em pontos, para ler detalhes
   pequenos; `batch {steps, stopOnError}` executa passos no formato de S0.4 (sem `checkpoint`, `cue` e
   `hold`), em ordem, pela conexão de exploração, e devolve um resultado por passo, parando no
   primeiro erro se `stopOnError`.
   Só na CLI: `runner build|logs|sever`, `obs setup`, `guide calibrate|play`, `sync
   measure|calibrate`, `booth`, `takes prune` (✅ Q-14: lista as tomadas de `paths.takes` exceto a
   mais recente com `status: finished` e, com um G4 do dono em lote, apaga delas só `recording.mp4`
   e `review.mp4`; AC-12.9).
3. **Captura para o Claude Code**: JPEG em pontos (390×844, qualidade ⚠️ 0,8, ≤ 150 KB) mais uma
   linha de texto com a escala e o caminho do PNG nativo salvo em `paths.cache/explore/` (podado:
   guarda as ⚠️ 200 últimas). Coordenadas da imagem = pontos do XCUITest. Só com o app em primeiro
   plano dentro da lista permitida (S1 item 11); as capturas saem do Mac para o modelo e ficam nas
   pastas do Claude Code (A9).
4. **Árvore**: formato compacto, só visíveis, com `_meta['anthropic/maxResultSizeChars'] = 200000`.
5. **Tomadas longas**: `take_start` cria um **supervisor destacado** (processo próprio) que roda a
   tomada, segura a conexão `control` e escreve `status.json` (com batimento de 1 Hz: pid e tempo
   monotônico) e `events.ndjson`; o MCP só lê esses arquivos e fala com o supervisor por arquivo:
   `take_resume`/`take_abort` (e `take resume|abort` na CLI) gravam `command.json {op: resume|abort,
   skipStep?, reason?}` na pasta da tomada e mandam `SIGUSR2` ao pid de `status.json`; o supervisor
   repassa ao runner (`choreo.resume`/`choreo.abort`) e apaga o arquivo. Reiniciar o MCP não
   interrompe a tomada; `take_status` reencontra o supervisor pelo `takeId` e confere o batimento.
   Um **vigia** (processo filho do supervisor) e também `take_status`, `take_wait` e `doctor` checam
   o batimento. Só para uma tomada ainda viva — `take.json.status` = `preparing` ou `recording` e o
   arquivo de trava do aparelho com o `takeId` dela —, batimento velho há mais de 10 s → se
   `GetRecordStatus.outputActive = true`, `StopRecord` e espera a finalização; sempre `choreo.abort`
   (se o runner responder) e `take.json` `cause: supervisor-lost`, com `status: failed` se `scenes`
   não terminou, ou `status` = `scenesResult` se já terminou; `cleanupPending` fica como está (S12
   item 3); por fim solta a trava, se ela ainda tiver aquele `takeId`. Só o vigia recupera;
   `take_status`, `take_wait` e `doctor` só recuperam se o pid do vigia sumiu, e sob um marcador
   exclusivo (`recovery.lock`, criado com `O_EXCL`) na pasta da tomada. Ao terminar normalmente, o
   supervisor grava o estado final em `status.json` e `take.json`, solta a trava e encerra o vigia.
6. **Instruções do servidor** (≤ 2.048 caracteres, regra principal primeiro): opere o iPhone físico
   para gravar demos; prefira `@eN` e rótulos a coordenadas; nunca digite credenciais nem peça
   senha; não capture fora do app alvo; tomada = `take_start` + `take_wait`.
7. **Registro no Claude Code**: `.mcp.json` versionado aponta para `bin/contrarregra-mcp`, um shim
   POSIX que acha um Node 22.x ≥ 22.18 (prefere o nvm 22.19; recusa o Homebrew 26) e roda
   `mac/src/mcp/main.ts`; nenhum segredo no `.mcp.json`.
8. **Segredos**: `OBS_WEBSOCKET_PASSWORD` lido do Chaveiro com `/usr/bin/security
   find-generic-password -s contrarregra -a <nome> -w` (prazo 5 s), guardado num tipo que se imprime
   como `[redacted]`; nunca em argv, log, saída MCP ou arquivo.

**API / Interface**
- Seletores na CLI em JSON (`--target '{"label":"Play"}'`) ou atalhos (`--label`, `--ocr`,
  `--point x,y`). Saída `--json`: o mesmo objeto da ferramenta MCP correspondente.

**Error & Edge Cases**
- **E-8.1** Node fora de 22.x ≥ 22.18 → o shim sai em ≤ 1 s com a mensagem de versão.
- **E-8.2** Item do Chaveiro ausente (código 44) → `E_SECRET_MISSING` com o comando exato que o dono
  roda para criá-lo; nunca pede a senha.
- **E-8.3** `take_start` com outra tomada ativa no mesmo aparelho → `E_BUSY` com o `takeId` ativo.
- **E-8.4** Resultado de ferramenta maior que o limite do Claude Code → a árvore é truncada com aviso e
  o caminho do JSON completo em disco.
- **E-8.5** O supervisor morre no meio da tomada → o vigia (item 5) para a gravação e aborta a
  coreografia.

**Acceptance Criteria (Given/When/Then)**
- **AC-8.1** Given o servidor, when um cliente MCP de teste (`@modelcontextprotocol/client`) lista as
  ferramentas, then exatamente as 6 ★ têm `_meta['anthropic/alwaysLoad'] = true`, e toda
  `description` e as instruções do servidor têm ≤ 2.048 caracteres.
- **AC-8.2** Given uma tela do Hagah, when `screenshot` é chamado 40 vezes, then cada imagem tem
  ≤ 150 KB e 390×844 px, e o Claude Code não mostra aviso de limite.
- **AC-8.3** Given 5 elementos achados por `ui.find`, when `tap {point}` é feito no centro do frame
  medido na imagem de `screenshot`, then 5/5 acertam (o `expect` de cada elemento fica verdadeiro).
- **AC-8.4** Given uma tomada de 15 min no simulador com 3 pontos de controle, when o servidor MCP é
  morto e religado no meio, then `take_status` reencontra a tomada, todos os pontos de controle
  apareceram em `take_wait` em ≤ 2 s e a gravação foi parada exatamente uma vez.
- **AC-8.5** Given o item do Chaveiro criado pelo dono, when o MCP conecta ao OBS, then a senha não
  aparece em nenhum log, resultado de ferramenta ou arquivo da pasta da tomada (busca literal).
- **AC-8.6** Given o runner e o OBS falsos dos testes (respostas fixas), when cada ferramenta MCP e o
  comando CLI da tabela do item 2 recebem os mesmos argumentos, then os objetos são iguais depois de
  remover `at`/`tMacNs`.
- **AC-8.7** Given cinco telas do Hagah que nenhuma coreografia cobre, when o Claude Code explora
  cada uma só pelo MCP e chama `record_step`, then ≥ 4 dos 5 passos gerados executam sem erro na
  primeira tentativa dentro de uma coreografia (SM-4).
- **AC-8.8** Given o Claude Code escolhendo coordenadas a olho em 5 capturas (procedimento
  registrado), when toca, then o erro médio ao centro do frame de `ui.find` é ≤ 10 pt.
- **AC-8.9** Given uma gravação em curso durante a seção `scenes`, when o supervisor recebe SIGKILL,
  then em ≤ 15 s a gravação para e é finalizada, a coreografia é abortada e `take.json` diz `failed`
  / `supervisor-lost`; Given o mesmo no pós-rolo (depois de `take.end`), then a gravação para e
  `take.json` diz `status` = `scenesResult` e `cause: supervisor-lost`.

---

## S9. Gravação no OBS (US-9, US-10)

**Behavior**

1. **Perfil e cenas próprios** ✅ (P-6): `contrarregra obs setup` (com o dono presente, G5) é
   idempotente: cria ou reconcilia o perfil e a coleção "Contrarregra" sem tocar no "Untitled" do
   dono, e relata as diferenças que corrigiu. Saída **Avançada** (`Output.Mode = Advanced`),
   gravação Padrão, formato **Hybrid MP4** (`AdvOut.RecFormat2 = hybrid_mp4`), codificador Apple VT
   H.264 por hardware, ABR `record.bitrateKbps` (⚠️ 16.000), keyframe a cada 1 s, perfil high, faixa
   1 (`AdvOut.RecTracks = 1`); tela base = saída = **1170×2532** a `record.fps` (⚠️ 60); áudio 48 kHz,
   mesmas configurações de áudio do perfil do dono (para a troca de perfil não pedir reinício).
   Cena "Contrarregra": fonte "iPhone" (`macos-avcapture`, preset High, sem buffering, áudio do
   iPhone só na faixa 1, enquadramento "bounds inner" em 1170×2532; o `device` é o `itemValue` cujo
   `itemName` é `device.name`, lido com `GetInputPropertiesListPropertyItems {propertyName:
   "device"}` — esperado igual ao UDID; SP-5 confirma) e a fonte de cor "Sync Flash" (branca, tela
   inteira, desligada). Áudio da área de trabalho e microfone do Mac desligados.
2. **Conexão e guarda do perfil**: cliente WebSocket próprio (Node 22, sem dependência), subprotocolo
   `obswebsocket.json`, autenticação `base64(sha256(base64(sha256(senha+salt))+challenge))`,
   assinaturas de evento 323. Confere `obsStudioVersion = 31.1.2` (⏳ Q-8), `obsWebSocketVersion = 5.6.2`,
   `rpcVersion = 1` e que `CreateRecordChapter` existe. Prazo ⚠️ 5 s por pedido (`StopRecord` 10 s);
   fechar a conexão rejeita os pendentes; pedidos dependentes esperam a resposta do anterior (o
   servidor processa fora de ordem). **Antes de qualquer pedido que escreve** (`SetRecordDirectory`,
   `SetInputSettings`, `SetProfileParameter`, `SetVideoSettings`, `CreateInput`, `StartRecord`,
   `CreateRecordChapter` e cada lote `SerialFrame` das marcas, que liga e desliga a fonte "Sync Flash"
   com `SetSceneItemEnabled`), confere `GetProfileList.currentProfileName = obs.profile` e
   `GetSceneCollectionList.currentSceneCollectionName = obs.collection`; se não, `E_OBS_CONFIG` e
   nada é escrito. Se o OBS estiver aberto noutro perfil, o pedido ao dono é fechar o OBS; a
   ferramenta o reabre com `open -a OBS --args --profile Contrarregra --collection Contrarregra
   --disable-shutdown-check --disable-missing-files-check` só quando não há processo do OBS.
3. **Fonte viva**: antes de gravar, `GetSceneItemTransform` tem de dar 1170×2532 e
   `GetSourceScreenshot` não pode ser preta; senão, "chuta" a fonte (`SetInputSettings {device}` com
   o valor resolvido no item 1) e espera até 15 s (contorna o bug #12062 do OBS 31); sem fonte viva
   depois disso, `E_OBS_SOURCE`.
4. **Disco**: antes de gravar, `fs.statfs` na pasta e `GetStats.availableDiskSpace`; exige livre ≥
   `max(disk.minFreeGiB, 3 × estimativa + 2 GiB)` (HC-11; estimativa = bitrate × duração prevista da
   coreografia × 1,25; o 3 cobre a gravação, `review.mp4` e `final.mp4`; ✅ Q-14). Durante, consulta a
   cada 5 s; abaixo de `disk.criticalGiB`, para a gravação (para o arquivo ser finalizado com
   capítulos) e aborta a tomada.
5. **Gravar**: `SetRecordDirectory` (pasta da tomada) → `StartRecord` → espera `RecordStateChanged
   STARTED` (≤ 5 s) → confirma com `GetRecordStatus` → pré-rolo (S7 item 3) → libera o runner. Em
   cada `scene.start`, `CreateRecordChapter {chapterName: "NN — título"}` (navegação; os capítulos
   finais são regenerados, S10). Durante: `GetOutputStatus {outputName: "adv_file_output"}` a 4 Hz
   (quadros totais e pulados). Fim: pós-rolo → `StopRecord` → espera `STOPPED` → espera a
   **finalização**: tamanho estável por 500 ms e `ffprobe -show_chapters` com a contagem esperada
   (nº de `CreateRecordChapter` aceitos + o capítulo automático em 0, se o OBS o criar, "Start" ou
   "Iniciar" conforme o idioma do OBS), ou a linha "MP4 file output complete" do registro do OBS;
   prazo 60 s → renomeia para `recording.mp4`.
6. **Validade**: quadros pulados (render ou saída) > 0 durante a tomada → `take.json` `obsStats`
   registra e a tomada fica marcada para revisão.
7. **Plano B** ✅ (ADR-4): QuickTime manual gravando o iPhone (o dono inicia e para); os capítulos vêm
   depois de `events.json` via FFMETADATA; o alinhamento usa só a latência visual.

**API / Interface**
- CLI `contrarregra obs setup|status|start|stop|chapter <título>`; MCP `obs_status`, `record_start`,
  `record_stop`, `record_chapter`.
- `obs status` → `{connected, versions, profile, collection, outputMode, recFormat, video: {w, h,
  fps}, source: {live, w, h}, recording: {active, durationMs, bytes}, disk: {freeGiB}}`.

**Error & Edge Cases**
- **E-9.1** Servidor WebSocket desligado → `E_OBS_UNREACHABLE` com o caminho no menu do OBS (Tools ›
  WebSocket Server Settings).
- **E-9.2** Senha errada (fecha com 4009) → `E_OBS_AUTH`, sem nova tentativa automática.
- **E-9.3** `AdvOut.RecFormat2 ≠ hybrid_mp4` ou `Output.Mode ≠ Advanced` no perfil ativo →
  `E_OBS_CONFIG` (mudar o formato com a gravação já montada não ativa capítulos: troque de perfil ou
  reabra o OBS).
- **E-9.4** `CreateRecordChapter` devolve 702 → registra e segue (os capítulos finais vêm de S10).
- **E-9.5** Sem `STARTED` em 5 s → `E_OBS_CONFIG` com a dica de olhar o diálogo do OBS; o runner não
  começa.
- **E-9.6** QuickTime aberto → o pré-voo pede para fechar (a captura do iPhone é exclusiva).

**Acceptance Criteria (Given/When/Then)**
- **AC-9.1** Given o OBS aberto com o perfil "Contrarregra", when `obs status` roda, then mostra as
  versões 31.1.2/5.6.2/rpc 1 (⏳ Q-8), `outputMode = Advanced`, `recFormat = hybrid_mp4`, vídeo 1170×2532 a 60
  fps e a fonte viva.
- **AC-9.2** Given uma gravação de teste com 3 `record_chapter` com títulos UTF-8 ("Cena 9 — Modo
  avião"), when finalizada, then o `ffprobe -show_chapters` lista os 3 títulos idênticos, mais no
  máximo um capítulo automático em 0 ("Start" ou "Iniciar").
- **AC-9.3** Given o OBS aberto antes de ligar o cabo, when o pré-voo roda, then a fonte é recuperada
  pelo "chute" em ≤ 15 s em 5 de 5 tentativas.
- **AC-9.4** Given livre abaixo do limite, when `take run` começa, then para no pré-voo com
  `E_DISK_LOW` e nada é gravado.
- **AC-9.5** Given uma gravação em curso e o livre caindo abaixo de `disk.criticalGiB`, when a consulta
  de 5 s detecta, then a gravação para, o arquivo é finalizado com os capítulos até ali e a tomada fica
  `aborted`.
- **AC-9.6** Given 10 gravações de cada duração (1, 5 e 10 min; 30 no total, cada arquivo apagado
  depois de medido), when o Mac declara cada arquivo pronto, then 0 são falsos prontos (o tamanho não
  muda nos 10 s seguintes e o `ffprobe -show_chapters` não falha) e o máximo STOPPED→pronto é ≤ 3 s.
- **AC-9.7** Given uma gravação de 10 min a 1170×2532@60, when termina, then quadros pulados = 0, o
  arquivo tem 1170×2532 a 60 fps, e o tamanho fica a ±25 % de 1,2 GB.
- **AC-9.8** Given o perfil do dono "Untitled", when `obs setup` termina, then o `basic.ini` dele está
  byte a byte igual ao de antes.
- **AC-9.9** Given o OBS no perfil "Untitled", when `record_start` (MCP) ou `obs start` (CLI) é
  chamado, then a resposta é `E_OBS_CONFIG` e o `basic.ini` do Untitled fica byte a byte igual.
- **AC-9.10** Given o perfil "Contrarregra" já existente com um parâmetro trocado à mão, when `obs
  setup` roda de novo, then corrige só esse parâmetro e o relata.

---

## S10. Saídas para narração e pós-produção (US-11, US-12, US-13)

**Behavior**

1. Depois do alinhamento (S7), `contrarregra export <takeDir>` gera:
   - `events.json` (S0.7), com tempos em R e em F.
   - `subtitles.srt` e `subtitles.vtt` em tempo F: cada frase da fala gera uma ou mais deixas (o
     texto da frase partido em k = ⌈caracteres/42⌉ trechos equilibrados em limites de palavra —
     minimizando o maior, cada um ≤ 42 —, que dividem a janela da frase na proporção dos caracteres;
     um trecho que fique com menos de 0,83 s se junta ao vizinho quando o total cabe em 42, senão a
     deixa se estende até 0,83 s sobre a pausa seguinte; os ≥ 2 quadros entre deixas saem do fim de
     cada deixa); linha 1 `[Snn · <caption>]` (o `caption` do último passo **com `caption`**
     começado na cena antes da deixa; sem nenhum, só `[Snn]`), linha 2 o trecho da fala; duração de
     cada deixa entre 0,83 s e 7 s; ≥ 2 quadros entre deixas.
   - `chapters.ffmeta` (`;FFMETADATA1`, `TIMEBASE=1/1000`, um `[CHAPTER]` por cena com o título;
     `=`, `;`, `#`, `\` e quebra de linha escapados).
   - `timings.md` e `timings.csv`: por cena — início/fim em F, duração, duração da guia, folga
     (duração − guia), tempo em pontos de controle, `overrunMs`.
   - `review.mp4` (✅ Q-16): o vídeo aparado com vídeo copiado sem recodificar: começa no último keyframe ≤
     início da cena 1, **sem edit list** (o trecho extra, `trim.leadInS` ≤ 1 s, só mostra a tela de
     início parada do pré-rolo), termina no fim da última cena, com os capítulos de `chapters.ffmeta`, só
     a faixa de áudio 1.
2. **Mixagem** (`contrarregra mix <takeDir> [--voice voice.wav] [--offset-ms N] [--debug-stems]
   [--force]`; `--force` só para tomada `aborted`/`failed`, E-10.2): a
   voz do dono (padrão `voice.wav` da pasta, com `voice.json`) entra com `adelay` (nunca `-itsoffset`
   com filtros); o áudio do app é abaixado sob a voz por `sidechaincompress` alimentado por uma cópia
   limitada da voz (profundidade estável, ⚠️ 8–12 dB, razão 3); `amix` sem normalizar; `loudnorm` em
   duas passadas para −16 LUFS, pico −1,5 dBTP; 48 kHz; AAC 192 kbps; vídeo copiado (H.264 do OBS);
   capítulos mantidos; `+faststart` → `final.mp4`. `--debug-stems` grava também `stems/app.ducked.wav` e
   `stems/voice.limited.wav` (48 kHz, antes do `amix`). Sem cortes, zoom ou legenda queimada (NG-5).
3. **Cabine de narração** (✅ Q-6, opcional): `contrarregra booth <takeDir>` serve uma página em
   `http://127.0.0.1:<porta>` para o Chrome: toca `review.mp4` (áudio do app baixo), mostra a frase
   atual grande e a próxima menor (a partir do `.vtt`), grava o microfone em PCM (AudioWorklet, sem
   cancelamento de eco, supressão de ruído nem ganho automático), mapeia o tempo do vídeo ao do áudio
   (`requestVideoFrameCallback` + `getOutputTimestamp`), desconta a latência medida numa calibração
   de "palma" em laço, exige fone com fio ou alto-falante embutido, e salva `voice.wav` +
   `voice.json {offsetMs, calibrationMs}` na pasta da tomada. Plano B: gravar com
   `ffmpeg -f avfoundation` e alinhar por uma palma (`silencedetect`).

**API / Interface**
- CLI `export`, `mix`, `booth`; MCP `outputs_export`, `mix_render`.
- Todos os comandos ffmpeg usam `paths.ffmpeg` (8.1.1) e mapas explícitos (`-map 0:v:0 -map 0:a:0`),
  nunca `-map 0` (duplicaria a trilha de capítulos).

**Error & Edge Cases**
- **E-10.1** `voice.wav` mais longo que o vídeo → a mixagem corta no fim do vídeo (`duration=first`) e
  avisa.
- **E-10.2** Tomada `aborted` ou `failed` → `export` gera as saídas de diagnóstico, mas `mix` recusa
  sem `--force`.
- **E-10.3** Navegador sem suporte (não é Chrome) na cabine → a página avisa e oferece o plano B.

**Acceptance Criteria (Given/When/Then)**
- **AC-10.1** Given uma tomada alinhada, when `export` roda, then `events.json` valida no esquema, cada
  frase de cada cena gera ≥ 1 deixa em `subtitles.srt`/`.vtt`, as deixas de uma frase, em ordem,
  reproduzem o texto dela sem perda, e toda deixa tem exatamente duas linhas.
- **AC-10.2** Given as legendas geradas, when lidas por um parser de WebVTT, then nenhuma linha passa
  de 42 caracteres e nenhuma deixa dura menos de 0,83 s ou mais de 7 s.
- **AC-10.3** Given `review.mp4`, when inspecionado, then o primeiro quadro decodificado está entre 0 e
  1,0 s antes do início da cena 1, nenhum quadro tem a luminância de uma marca "Sync Flash", não há
  edit list, há exatamente uma faixa de vídeo e uma de áudio, e o `ffprobe -show_chapters` lista uma
  entrada por cena com os títulos da coreografia.
- **AC-10.4** Given `timings.csv`, when somado, then a soma das durações das cenas é igual à duração de
  `review.mp4` − `trim.leadInS` ± 1 quadro.
- **AC-10.5** Given uma faixa de app de teste com ruído rosa constante a −20 dBFS e uma voz de teste
  contínua de 10 s, when `mix --debug-stems` roda, then o RMS de `app.ducked.wav` durante a voz fica
  8–12 dB abaixo do RMS fora dela, o `ebur128` integrado de `final.mp4` é −16 ± 1 LUFS a 48 kHz, e o
  hash do fluxo de vídeo é igual ao de `review.mp4`.
- **AC-10.6** Given `--offset-ms 2500`, when `mix` roda com um clique no início da voz, then o clique
  aparece em F = 2,500 s ± 1 ms.
- **AC-10.7** Given `final.mp4`, when inspecionado, then não tem legenda embutida nem trilha de áudio
  extra e mantém os capítulos.
- **AC-10.8** Given a cabine com 10 cliques tocados em tempos conhecidos e captados em laço, when
  calibrada uma vez, then o p95 de |erro| dos 10 cliques na gravação é ≤ 20 ms. (Fase 8; ✅ Q-6.)
- **AC-10.9** Given o dono gravou na cabine, when `voice.json` é salvo, then `mix` usa o `offsetMs`
  dele sem parâmetro manual. (Fase 8; ✅ Q-6.)

---

## S11. Ensaio no simulador (US-14)

**Behavior**

1. Simulador "Contrarregra iPhone 12" (runtime iOS 26.5, mesma geometria de 390×844 pt) ✅; barra de
   estado fixada em 9:41 (`simctl status_bar override`).
2. O app alvo no simulador **não é** o build do TestFlight (que não roda em simulador): é um build
   Release para simulador do mesmo commit, com as mesmas variáveis de loja e sem ganchos — a exceção
   de P-4 —, produzido fora do Contrarregra e entregue com `--app-path` (`deploy.md` D3.5).
3. O mesmo runner (compilado para simulador) e a mesma coreografia; o transporte é o loopback do
   próprio Mac (sem usbmux); o relógio é o mesmo dos dois lados.
4. Gravação com `xcrun simctl io <udid> recordVideo --codec=h264 --mask=black --force
   <takeDir>/rehearsal.mov`, T0 quando aparece "Recording started", parada com SIGINT (nunca
   SIGKILL). Vídeo de quadros variáveis e provavelmente sem áudio: o alinhamento usa `pts_time`.
5. Passos só de aparelho seguem `sim`: padrão por tipo — `controlCenter`/modo avião → `skip`; `lock`
   e `wake` → `simulate` (se PX-1 funcionar no simulador) ou `skip`; ponto de controle de Face ID →
   `simulate` (`notifyutil` de Face ID do Simulador, permitido no ensaio — P-7) ou a pessoa usa o menu
   do Simulador; Sign in with Apple → ponto de controle humano se houver conta Apple no simulador,
   senão `skip`. Passo pulado registra `status: "skipped-sim"`.
6. O ensaio gera as mesmas saídas (S10), servindo de bancada do alinhamento.

**API / Interface**
- CLI `contrarregra rehearse <choreo> [--app-path <.app>] [--scenes s02,s05] [--detach]`
  (`--app-path` só quando o app alvo não vem instalado no simulador); MCP `rehearse_start` (mesmo
  modelo de `take_start`/`take_wait`).

**Error & Edge Cases**
- **E-11.1** Build do app alvo com ferramentas de desenvolvimento ligadas (rótulos a mais) → aviso no
  pré-voo do ensaio quando a árvore mostra rotas `dev`.
- **E-11.2** `recordVideo` sem a linha "Recording started" em 10 s → aborta o ensaio.

**Acceptance Criteria (Given/When/Then)**
- **AC-11.1** Given o build Release de simulador do Hagah e a coreografia completa, when o ensaio roda
  as cenas 1, 2, 4, 5, 6, 8 e 10, then todos os passos não exclusivos de aparelho passam em 3
  execuções seguidas.
- **AC-11.2** Given passos de modo avião na coreografia, when o ensaio roda, then eles registram
  `skipped-sim` e a cena segue.
- **AC-11.3** Given o vídeo do ensaio, when alinhado, then |observado − previsto| ≤ 17 ms (em
  `pts_time`) para todo passo `visual: true` detectado, depois de subtrair um único deslocamento
  constante.
- **AC-11.4** Given o ensaio parado no meio, when termina, then `rehearsal.mov` está finalizado e
  legível pelo `ffprobe`.

---

## S12. Pré-voo, preparo e repetição de tomada (US-10, US-16)

**Behavior**

1. **Pré-voo** (`take preflight`, e automaticamente no começo de `take run`), checagens com id:

| Id | Checagem | Tipo |
|---|---|---|
| PF-01 | ferramentas: Xcode 26.6 (17F113), macOS 26.5.x, OBS 31.1.2 (⏳ Q-8), ffmpeg/ffprobe 8.1.1 fixados, Node 22.x ≥ 22.18; iOS do aparelho = o validado (✅ Q-11) | auto (diferença → `E_TOOLCHAIN_MISMATCH`) |
| PF-02 | usbmuxd lista o UDID como `USB` | auto |
| PF-03 | `devicectl`: `transportType = wired`, `tunnelState = connected`, `developerModeStatus = enabled`, `ddiServicesAvailable = true` | auto |
| PF-04 | runner responde `session.hello` em ≤ 2 s ao supervisor; capacidades privadas que a coreografia exige liberadas e presentes | auto |
| PF-05 | app alvo instalado, versão (build) = `app.expectVersion` (✅ Q-1), instalado pelo TestFlight/App Store e não pelo desenvolvedor (campo de origem do `devicectl device info apps --json-output`, a confirmar no SP-10; sem esse campo, o dono confirma) | auto / humano |
| PF-06 | aparelho: idioma = `device.language`, tela em pontos = `device.screenPt`, tamanho de texto = `device.textSize`, aparência = `device.appearance` | auto (runner) |
| PF-07 | OBS: conectado, versões, perfil e coleção "Contrarregra" ativos, `Output.Mode = Advanced`, `AdvOut.RecFormat2 = hybrid_mp4`, 1170×2532@fps, fonte viva | auto |
| PF-08 | disco livre ≥ limite (HC-11; ✅ Q-14) | auto |
| PF-09 | segredo do OBS no Chaveiro | auto |
| PF-10 | `alerts.sayDevice` existe e não é BlackHole / Multi-Output / Aggregate; nenhuma fonte de áudio do Mac na cena do OBS | auto |
| PF-11 | Auto-Lock "Never", Low Power Mode desligado, Do Not Disturb/Focus ligado, atualizações automáticas desligadas, teclado com Auto-Correction, Predictive e Smart Punctuation desligados, pré-visualização de notificações "Never" | humano (confirmação registrada) |
| PF-12 | nenhum ícone com nome de `bundle.displayNames` na página da tela de início onde está o ícone do app alvo, e esse ícone está tocável na página visível | auto (runner consulta o SpringBoard) |
| PF-13 | QuickTime Player fechado | auto |
| PF-14 | rajada de sincronia com resíduo ≤ 2 ms | auto |
| PF-15 | portão pós-preparo: `prepare` terminou e suas asserções passaram (avaliado logo antes de `StartRecord`) | auto |
| PF-16 | aparelho com rede: `device.state.network = online` (modo avião desligado) | auto |
| PF-17 | a tomada anterior (S12 item 4) terminou com `cleanupPending: false` (S12 item 3); o dono confirma cada item de `confirm` da coreografia (S0.4; no Hagah, S13 item 6) | auto + humano |

   O pré-voo carrega a coreografia (`choreo.load`, no modo da tomada; no `take preflight` avulso,
   modo `dry`) assim que PF-04 passa, e só então roda PF-06, PF-12 e PF-16, que consultam o runner
   com o app alvo e o `iconLabel` dela. O relatório sai em `preflight.json`; qualquer `fail` impede
   a gravação (`E_PREFLIGHT`, com os ids que falharam); `human` exige a confirmação do dono (`take
   preflight <choreo> --confirm PF-11`; MCP `take_preflight {choreography, confirm: ["PF-11"]}`),
   guardada com a hora em `paths.cache/confirmations.json` (E-12.1); com uma tomada em curso, `take
   preflight --confirm` só grava a confirmação, sem abrir `control`. Na `take run`, uma checagem
   `human` sem confirmação válida não aborta: o Mac avisa como num ponto de controle (S5 item 2) e
   espera até ⚠️ 5 min pela confirmação; sem ela, `E_PREFLIGHT`. 2. **Preparo** (`prepare` da
   coreografia, executado pelo runner com `choreo.run {section: prepare}`, sem gravar): leva o app
   alvo ao estado inicial do vídeo e **verifica** com `assert`. Pode usar `openURL` e `terminate`.
   Antes de apagar dado do app alvo, confere se há dado que nenhuma tomada criou e, se houver, para
   num ponto de controle humano sem apagar nada (✅ Q-15). Termina com o app alvo encerrado e a tela
   de início visível, para a cena 1 mostrar a abertura a frio; então PF-15. 3. **Limpeza**
   (`cleanup`, executada pelo runner com `choreo.run {section: cleanup}` depois de parar a
   gravação): desfaz o que a tomada deixou (no Hagah: excluir a conta de novo com revogação e sair —
   conta Apple do aparelho, ✅ Q-2 —, S13), para a próxima tomada repetir o vídeo. Se `{network:
   offline}`, o primeiro passo é um ponto de controle "desligue o modo avião" até `{network:
   online}`. O `take.json` nasce com `cleanupPending: false`; o supervisor grava `true` em
   `take.start` e, em `take.end`/`take.abort`, `scenesResult: finished|aborted`; só uma `cleanup`
   completa (todas as `assert` passando) volta a `cleanupPending: false`. Uma `cleanup` que falha,
   estoura o prazo ou é abortada não muda o `status` da tomada, que vem de `scenesResult`. 4.
   **Repetir** (US-16, SM-3): `take run` encadeia limpeza da anterior (se pendente) → pré-voo →
   preparo → PF-15 → tomada → saídas, sem passos manuais além dos pontos de controle e das
   confirmações do pré-voo. "A tomada anterior" é a mais recente do mesmo `device.udid` e do mesmo
   app que chegou a `take.start` (tem `scenesResult`); tomadas que terminaram antes disso e ensaios
   no simulador não contam. Se ela tem `cleanupPending: true`, a limpeza roda com o `choreo.json` e
   o `takeId` dela (os eventos vão para o `events.ndjson` dela, com o `seq` seguindo o `lastSeq`
   dela) e, completa com todas as `assert` passando, o supervisor grava `cleanupPending: false` nela
   e em toda tomada anterior do mesmo aparelho e app ainda pendente (PF-17).

**API / Interface**
- CLI `contrarregra take preflight <choreo> [--confirm PF-nn]`, `take run <choreo> [--mode take|dry]
  [--detach]`; MCP `take_preflight {choreography, confirm?}`, `take_start`.

**Error & Edge Cases**
- **E-12.1** Confirmação humana com mais de ⚠️ 12 h → expira e é pedida de novo. As de PF-17 valem
  para uma tomada só: expiram no `take.start` seguinte e em toda `cleanup` completa.
- **E-12.2** `prepare` falha numa asserção → para antes de gravar, com a asserção que falhou e a
  captura de tela.
- **E-12.3** `cleanup` exige ponto de controle (Face ID da revogação) e o dono não está → a tomada fica
  `finished` com `cleanupPending: true`; a próxima `take run` começa pela limpeza.

**Acceptance Criteria (Given/When/Then)**
- **AC-12.1** Given cada falha plantada da lista (OBS fechado, WebSocket desligado, disco abaixo do
  limite, cabo solto, runner morto, app alvo ausente, idioma errado, modo avião ligado), when o
  pré-voo roda, then a checagem correspondente falha e nada é gravado (SM-7).
- **AC-12.2** Given o túnel em `localNetwork`, when o pré-voo roda, then PF-03 falha com o procedimento
  de forçar o cabo.
- **AC-12.3** Given um ícone com um nome de `bundle.displayNames` na mesma página da tela de início que o ícone do app alvo,
  when o pré-voo roda, then PF-12 falha dizendo para tirá-lo da tela de início (fica na Biblioteca de
  Apps).
- **AC-12.4** Given uma tomada completa do Hagah terminada, when `take run` é dado de novo e cada ponto
  de controle humano é resolvido em ≤ 15 s, then a limpeza, o pré-voo, o preparo, a tomada e as saídas
  terminam em ≤ 15 min, sem contar a narração (SM-3); a soma das esperas fica em `timings.md`.
- **AC-12.5** Given PF-11 confirmado há 13 h, when o pré-voo roda, then pede a confirmação de novo.
- **AC-12.6** Given `prepare` concluído, when a cena 1 começa, then o app alvo não está rodando, a tela
  de início está em primeiro plano e `{element: {app: springboard, label: <app.iconLabel>, type:
  icon}, state: hittable}` é verdadeira.
- **AC-12.7** Given uma tomada abortada depois de ligar o modo avião na cena 9, when `take run` é
  dado de novo, then a limpeza começa pelo ponto de controle de desligar o modo avião, PF-16 passa,
  o pré-voo pede a confirmação de PF-17 (S12 item 1) e, confirmada, a tomada segue normalmente.
- **AC-12.8** Given o app alvo com uma entrada de diário que nenhuma tomada criou, when `prepare` roda,
  then para num ponto de controle humano antes de apagar qualquer coisa.
- **AC-12.9** Given três tomadas `finished` e uma `aborted` do mesmo app, when `takes prune` roda e
  o dono aprova o G4, then só o `recording.mp4` e o `review.mp4` das que não são a `finished` mais
  recente são apagados, e `take.json`, `choreo.json`, `events.json`, as legendas e `final.mp4`
  ficam; sem o G4, nada é apagado.

---

## S13. Caso de referência: Hagah Bible (US-5, US-6, US-7, US-17)

**Behavior**

1. A coreografia `choreographies/hagah/v8.5-review.choreo.yaml` executa as 10 cenas de
   `hagah/plans/mobile/notes/v8.5-roteiro-video.md` com o iPhone em inglês, build do TestFlight
   (✅ Q-1), conta Apple do aparelho (✅ Q-2). O catálogo de alvos medido no SP-10 fica no próprio
   arquivo, em `targets:`.
2. **Rótulos e fluxos reais do app nativo** (o roteiro cita vários textos da PWA que o app não tem; a
   coreografia segue o app, e o roteiro deve ser corrigido no repositório do Hagah — `deploy.md` D0):

| Roteiro diz | O app nativo mostra | Onde |
|---|---|---|
| ícone "Hagah" | ícone "Hagah Bible" | cena 1 |
| abra "Repeat" | "Repeat" é um título; a seção fica abaixo da altura 0,5 da folha: rolar a folha | cena 4 |
| modos "Off · Passage · Verse · Chapter · Book" | "Off" · "Passage" (desabilitado sem seleção) · "Verse" · "Chapter" · "⋯" → "Book" | cena 4 |
| "Pause between repeats" | linha "Pause" no Now Playing | cena 4 |
| chip do timer no player | só a linha de estado no Now Playing ("Pauses at the end of the chapter") | cena 4 |
| "Parallel reading" (chip) | chip "Parallel" (o título do seletor é "Parallel reading") | cena 5 |
| "Focus" num versículo | chip "Focus" no cabeçalho | cena 5 |
| "⇄ echo" no player | linha "Bilingual echo" com "NIV → NVI" no Now Playing, também abaixo da altura 0,5 | cena 5 |
| "· Passage actions", "HIGHLIGHT VERSE", "PERSONAL NOTE", "Save note" | "Verse N" → barra de seleção → "Highlight" → "Gold"; "Back to actions" → "Note" → "Save" | cena 6 |
| descrição da exclusão (uma frase) | "Deletes your Hagah account and the synced journal. Your YouVersion account is not affected." | cena 7 |
| "toque em play" no dia do Plano | a linha do dia não tem play: tocar a linha → "Listen" (ou "Resume at m:ss" / "Listen again") | cena 8 |
| "botão de download do dia" | "Download" na tela do dia (o ícone da linha não está na árvore) | cena 8 |
| "Day N · Bible in a Year · 4Ventos" no mini-player | "Day N" / "Bible in a Year · Day N" (o texto com 4Ventos é o da tela travada) | cena 8 |
| "▶ Play" | "Play" | cena 8 |
| "{size} on this device" na tela Downloads | linha de Ajustes "Downloads, {size} on this device" | cena 9 |

3. **Estado inicial** (`prepare`): sem idioma do app gravado (ou "English"); deslogado; diário com 0
   entradas (se houver entrada além da que as tomadas criam — Salmo 23:1 com a nota "Meditate on this
   tonight" —, ponto de controle e nada apagado; ✅ Q-15); "Parallel" desligado; Repeat "Chapter" ·
   "∞", eco "Off", velocidade "1×", timer "Off", predefinições padrão; última posição Salmo 1 NIV (não
   o 23, senão o seletor da cena 2 não muda nada); "Download while listening" **ligado** (`assert` no
   `value` do interruptor = "1"); Salmo 23 NIV com texto, tempos e áudio baixados e Salmo 23 NVI aberto
   uma vez online; o dia atual do plano **não** baixado (se estiver, "Remove from device" na tela do
   dia); uma playlist com passagens; Habakkuk 3 nunca aberto com rede (reservado à prova offline; exploração e
   spikes só o abrem em modo avião); modo avião desligado e rede ok; o ícone "Hagah Bible" na primeira
   página da tela de início; app encerrado.
4. **Linha do tempo do áudio (decidida)**: Repeat "Chapter" · "∞" desde o preparo, para o Salmo 23
   não avançar ao 24 nas cenas 2–3; na cena 4, depois de mostrar "Sleep" e "End of chapter", tocar
   "Off" na linha do timer e "Chapter" na linha Repeat; na cena 5, pausar ("Pause") antes do toque na
   palavra da lente "Word" e tocar ("Play") antes do eco bilíngue; pausar o áudio no fim da cena 6 e no
   fim da cena 8; na cena 9, tocar com toque duplo no versículo (não no mini-player, que guarda o
   episódio da cena 8), com `expect {element: {labelPrefix: "Open Now Playing: Psalms 23"}, state:
   exists}`. No começo das cenas 3 e 4 (o Now Playing está aberto), `assert` no título da folha
   (rótulo exato no SP-10); no começo das cenas 5 e 6, `assert {element: {labelPrefix: "Open Now
   Playing: Psalms 23"}, state: exists}`; todos com `onFail: pause`.
5. **Outras armadilhas que a coreografia evita**: arrasto com mais de 20 pt na horizontal troca de
   capítulo (todo arrasto no leitor é vertical); o cabeçalho rola para fora (voltar ao topo antes de
   usar "Focus"/"Parallel"); rolar dentro da folha do Now Playing usa `within` a folha (ou arrastar a
   alça até a altura cheia antes); tocar uma palavra exige áudio pausado (o seguimento fecha o painel);
   destaque só aparece na lente "Reading"; o dia atual do plano é achado por OCR de "CURRENT DAY" com
   deslocamento medido no SP-10 (o número do dia muda todo dia).
6. **Pontos de controle**: preparo — código para a automação ("Enable UI Automation", S5 item 5);
   cena 3 — `lock` (PX-1, ✅ Q-5a; ou a pessoa aperta o botão lateral), `wait` 5 s, `wake` (com o dono
   **sem olhar** para o iPhone, senão o Face ID destrava), `hold` mostrando os controles da tela
   travada, e o ponto de controle de destravar (`until: {all: [{locked: false}, {element: {label:
   "Previous verse", type: button}, state: hittable}]}`); cena 7 — três Face ID; cena 9 — "Abra a
   Central de Controle, ligue o modo avião, conte 2 s e feche" com `until: {all: [{network: offline},
   {element: {app: controlcenter, identifier: "airplane-mode-button"}, state: gone}]}`; cena 10 — o
   mesmo para desligar, com `{network: online}`; limpeza — Face ID da revogação. A `cleanup` do Hagah
   tem `assert`s de que a revogação chegou ao alerta "Account deleted" e não ao "Delete without
   confirming with Apple?" (exclusão sem revogar o vínculo na Apple), e o cabeçalho `confirm` pede ao
   dono que confira que o Hagah não está em Settings › [nome] › Sign-In & Security › Sign in with
   Apple (PF-17; ✅ Q-2).
7. **Prova do modo avião na cena 9**: durante a captura USB o iOS provavelmente troca a barra de
   estado por uma limpa (9:41, sinal cheio; confirmado até o iOS 17.1, SP-9 confirma no 26.x), então
   não se conta com o ícone de avião. A prova é a Central de Controle aberta ~2 s com o botão de avião
   ligado e, depois do toque duplo que toca o Salmo 23 sem rede, abrir pelo seletor um capítulo nunca
   aberto (⚠️ Habakkuk 3, que só é aberto offline) e mostrar a mensagem de capítulo indisponível
   offline (rótulo exato no SP-10), voltando ao Salmo 23 pelo seletor. Esse `expect` usa `onFail:
   continue`: se o capítulo já estiver em cache, a tomada não pausa, mas fica marcada para revisão.

**API / Interface**
- Nenhuma própria: a coreografia usa S3, S4 e S12.

**Error & Edge Cases**
- **E-13.1** A folha do Sign in with Apple aparece na variante de "conta já vinculada" (sem nome) →
  a tomada segue, mas o vídeo não serve como "cadastro"; PF-17 da próxima tomada pega a causa.
- **E-13.2** O app mostra outra versão ou não veio do TestFlight → PF-05 falha (✅ Q-1).

**Acceptance Criteria (Given/When/Then)**
- **AC-13.1** Given o build do TestFlight em inglês, when a coreografia roda em `--mode dry`, then todo
  alvo de toque/arrasto de passo não `optional` resolve, no momento do passo, para exatamente um nó
  tocável ou uma caixa de OCR (um `Point` ou seletor `point` dentro da tela é aceito sem resolução), e todo alvo de condição atinge o `state` pedido dentro do prazo; o
  relatório lista 0 falhas.
- **AC-13.2** Given o app no estado deixado por uma tomada completa, when `prepare` roda, then termina
  em ≤ 3 min, todas as `assert` passam e o app alvo está `notRunning`.
- **AC-13.3** Given a coreografia completa, when uma tomada roda no iPhone, then `take.json` termina com
  `status: "finished"` e `syncOk: true`, `choreo.status` chega a `done` na seção `scenes`,
  `events.json` tem 0 eventos `intervention`, e os únicos `checkpoint.wait` são os do item 6 (SM-1).
- **AC-13.4** Given uma tomada completa, when `events.json` é lido, then não há `device.state` com
  `foregroundApp` ∈ {hospedeiro, runner} nem comando `device.press volume*` entre o `obs.state` de
  início e o de fim da gravação (SM-6).
- **AC-13.5** Given `final.mp4` de uma tomada completa, when inspecionado, then o primeiro quadro mostra
  a tela de início (OCR acha "Hagah Bible"), e entre o `tVideoObservedS` do toque de s01 e o primeiro
  quadro do leitor os `pts` são contínuos (nenhum quadro ausente na abertura).
- **AC-13.6** Given o fim de uma tomada e a `cleanup` concluída, when a próxima tomada chega à cena 7,
  then o cartão do Diário tem rótulo com prefixo "Signed in with Apple · " seguido de nome não vazio (a
  Apple só envia o nome na primeira autorização); a regra que identifica a variante da folha vem do
  SP-8 e entra aqui por G1.
- **AC-13.7** Given `review.mp4` de uma tomada completa, when amostrado a 2 fps e passado por OCR (Mac),
  then há 0 ocorrências de qualquer nome de `bundle.displayNames` (SM-6).
- **AC-13.8** Given `review.mp4` de uma tomada completa, when o dono revê 1 s depois de cada início de
  capítulo com a lista de verificação (sobreposição, ícone, HUD de volume, aviso do iOS — este segue ⏳
  Q-9), then nenhum item é marcado (procedimento registrado em `tasks.md`).
- **AC-13.9** Given a coreografia completa em `--mode dry`, when roda as cenas 2–9, then o player nunca
  mostra o Salmo 24 e as `assert`/`expect` do item 4 passam.
- **AC-13.10** Given a cena 9 com o modo avião ligado, when ela roda, then o Salmo 23 toca (o mini-player
  mostra "Pause" em ≤ 1 s depois do toque duplo) e a mensagem de capítulo indisponível offline aparece
  para o capítulo nunca aberto.

---

## Itens em aberto

Todas as decisões do dono estão em `requirements.md` §5 (Q-1…Q-16): as da ratificação foram tomadas
em 2026-10-06; Q-5 (d, f), Q-8, Q-9, Q-12 e Q-13 estão agendadas (⏳) para o G1 da tarefa de
consolidação ou para um G1 imediato (§5). Os riscos técnicos sem resposta estão como spikes
ordenados por risco em `tasks.md` Fase 0 (SP-1…SP-18). Eles podem mudar o caminho técnico (principal
ou plano B) e, em sete casos, levar o dono a uma decisão já listada: SP-1 → Q-9; SP-2 → Q-12; SP-4 →
Q-13; SP-5 → Q-8; SP-12 → Q-5 (d); SP-12 parte 3 → as chaves de captura de A10 (uso novo de Q-5); e
AC-1.4 → Q-5 (f). Toda mudança de comportamento que um spike exigir vai ao G1 pela tarefa de
consolidação (T-0.39).
