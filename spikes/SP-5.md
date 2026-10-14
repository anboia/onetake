# SP-5 — OBS, parte 1: fonte, áudio e gravação longa (T-0.20)

**Estado:** preparado em 2026-10-14 — driver, testes e plano; **nada gravado, nenhuma escrita no OBS, iPhone não
usado**. Só a sonda de leitura `probe-1` rodou contra o OBS real (só pedidos `Get*`). A execução espera o G4 abaixo
(e as respostas do dono da seção "O que o dono faz"). Driver testado sem aparelho e sem OBS em
`node --test spikes/sp-5/sp5.test.ts` (35 testes: lógica pura, `ObsClient` de produção contra um OBS falso, medidas
em vídeos de teste do ffmpeg 8.1.1, preparo do Hagah com um runner falso).

Responde a S9 itens 1, 3 e 6, ao ADR-4 e ao ADR-14: a fonte do iPhone no OBS 31.1.2 entra nativa (1170×2532 → quadro
1168×2532) e sem cor lavada? o áudio do iPhone chega no nível certo, sem tocar no alto-falante e em sincronia? 10 min
a 1168×2532@60 com H.264 por hardware ABR 16 Mbps saem sem quadros pulados e no tamanho previsto? a fonte morta (bug
#12062) volta pelo "chute" em ≤ 15 s? Dá números para ⏳ Q-8 (ficar no 31.1.2 ou ir para o 32.2.x). ACs: AC-9.3
(parcial: o chute sem pré-voo), AC-9.7. Critério e plano B vêm de tasks.md T-0.20; linha de base em
research/capture.md (riscos "não nativo / cor lavada", "áudio", "fonte não sobe", "disco", "VT H.264 a 2532 px").

## Montagem

- MacBook Air M4 16 GB, macOS 26.5.x; iPhone 12 (iPhone13,2), iOS 26.7.1 (23H30), no cabo; Node 22.19 (o do
  `bin/contrarregra`); ffmpeg/ffprobe 8.1.1 só por `/opt/homebrew/opt/ffmpeg/bin/` (`openFfmpeg`, P-7).
- OBS 31.1.2, obs-websocket 5.6.2, rpc 1, no perfil e na coleção **"Contrarregra"** (T-0.13). O "Untitled" do dono
  nunca é tocado: o spike não troca de perfil, e toda escrita passa pela guarda do `ObsClient` (relê perfil e coleção
  antes de cada uma; fora do "Contrarregra" → `E_OBS_CONFIG` e nada é escrito).
- Runner: um build já aprovado (o Debug basta; nada do `Spike`), subido pelo orquestrador com `contrarregra runner up`
  — o driver nunca instala, sobe nem derruba o runner. O runner opera só o Hagah (`app.explore`, build do TestFlight)
  e o hospedeiro (relógio de calibração, S0.10; fora de tomada, S1 item 11).
- Gravações em `~/Movies/contrarregra/spikes/SP-5/` (a pasta não existe ainda; o driver cria só ela), apagadas logo
  depois de medidas (G4).

**Estado lido pela sonda `probe-1` (2026-10-14, só leitura):**

| item | valor |
|---|---|
| versões | OBS 31.1.2 · obs-websocket 5.6.2 · rpc 1 |
| perfil / coleção / cena | Contrarregra / Contrarregra / Contrarregra |
| vídeo | base 1168×2532, saída 1168×2532, 60/1 |
| saída | `Output.Mode=Advanced`, `AdvOut.RecFormat2=hybrid_mp4`, `AdvOut.RecEncoder=com.apple.videotoolbox.videoencoder.ave.avc`, `RecTracks=1`, `RecType=Standard`, `Audio.SampleRate=48000`, nome `%CCYY-%MM-%DD %hh-%mm-%ss` |
| fonte "iPhone" | `macos-avcapture`; `{buffering: false, device: "EE35C40D-…", device_name: "VIVO_00G7", preset: "AVCaptureSessionPresetHigh", use_preset: true}`; item 1, sem escala, recorte 1 px à esquerda e à direita; áudio só na faixa 1, volume 0 dB, defasagem 0 ms, sem monitoração |
| `device` pelo `itemName` | "VIVO_00G7" → `EE35C40D-6B59-489B-8BA2-BF347E8D712C` (6 dispositivos na lista; **não** é o UDID) |
| **fonte viva?** | **não**: `sourceWidth = sourceHeight = 0`. O registro do OBS desta sessão (aberto 2026-10-13 23:10:50) tem `iPhone: Unable to initialize device with unique ID 'EE35C40D-…'` na abertura e nenhum "Selected device" depois: o bug #12062 aparece ao **reabrir o OBS com o cabo ligado** (o iPhone surge depois da inicialização da fonte) |
| listas da fonte | `preset`: 10 (3840x2160 … High, Medium, Low); `supported_format`: **0 itens** (com a fonte morta); `input_format`, `color_space`, `video_range`: "Unable to find a property by that name" (no modo preset o OBS 31.1.2 não expõe esses ajustes) |
| padrões | `macos-avcapture` `{device: "", enable_audio: true, preset: High, use_preset: true}`; `macos-avcapture-fast` `{device: "", enable_audio: true, use_preset: false}` |
| pasta de gravação | `/Users/noah/Movies` (devolvida no fim de cada fase) |
| disco | 21,15 GiB livres (`statfs` de `~/Movies`); `GetStats.availableDiskSpace` 22.002 MiB |

## Driver (`spikes/sp-5/`)

`lib.ts` (lógica pura) · `obs.ts` (instantâneo, fonte viva e chute, configurações, gravação com HC-11, devolução,
processo e registro do OBS) · `media.ts` (ffprobe, quadros RGB e cinza, PCM, microfone) · `hagah.ts` (preparo do
Salmo 23 copiado e enxugado de `spikes/sp-3/`) · `sp5.ts` (comandos) · `sp5.test.ts`.

```
node spikes/sp-5/sp5.ts probe   --label <l>                       (só leitura)
node spikes/sp-5/sp5.ts configs --label <l> [--configs high,format60,capturecard,preset4k] [--seconds 8] [--frames 30]
node spikes/sp-5/sp5.ts audio   --label <l> [--play-s 45] [--toggles 16] [--speaker human|mic|skip] [--mic-s 20]
node spikes/sp-5/sp5.ts long    --label <l> [--minutes 10] [--screen host|hagah] [--no-audio] [--no-decode-clock]
node spikes/sp-5/sp5.ts kick    --label <l> [--mode restart|cable|replug] [--trials 5] [--observe-s 5]
node spikes/sp-5/sp5.ts restore --label <l>                       (devolve pelo instantâneo de <l>)
node spikes/sp-5/sp5.ts report  --labels <l1,l2,…>                (tabelas para este arquivo)
```

Saída bruta em `spikes/sp-5/out/` (fora do git): `<label>.ndjson`, `<label>-snapshot.json` (gravado **antes** da
primeira escrita), `<label>-files.ndjson` (cada gravação criada e apagada), `<label>-restore.json`,
`<label>-summary.json`. Códigos de saída: 0 medido (o veredicto está no resumo) · 1 erro · 2 disco abaixo do HC-11
(nada gravado) · 4 `OWNER_ACTION` · 5 OBS fora do "Contrarregra" ou fora do conjunto validado · 6 a devolução não
fechou (conferir o OBS antes de qualquer outra coisa; `restore --label <l>` refaz).

**O que o driver escreve no OBS** (só no perfil/coleção "Contrarregra"; tudo devolvido no fim de cada fase e no
SIGINT, a partir do instantâneo): os ajustes da fonte "iPhone" (`SetInputSettings`; a devolução repõe o objeto do
instantâneo com `overlay: false` e confere igualdade), a pasta de gravação (`SetRecordDirectory`), a fonte temporária
"SP-5 Capture Card" (`CreateInput`/`SetSceneItemTransform`/`RemoveInput`), `StartRecord`/`StopRecord` e o chute.
Nunca `SetProfileParameter`, `SetVideoSettings`, `SetCurrentProfile`, nem nada no `recordEncoder.json`. A fase `kick`
fecha o OBS com SIGINT (o 31.1.2 trata como fechar a janela, `ProcessSigInt`) e o reabre com
`open -a OBS --args --profile Contrarregra --collection Contrarregra --disable-shutdown-check
--disable-missing-files-check` só sem processo do OBS (S9 item 2); nunca SIGKILL; se o OBS cair, o driver o reabre
no perfil no fim.

## Procedimento (ordem; um spike no aparelho por vez)

0. `probe --label probe-2` (só leitura) logo antes, para conferir perfil, gravação parada e disco.
1. `configs --label sp5-configs` — hospedeiro à frente (relógio de calibração); captura `png` nativa do próprio
   iPhone (`screen.shot`, só na memória) como referência; para cada configuração: devolve a fonte ao instantâneo,
   aplica, espera 2,5 s, espera quadros (≤ 15 s; senão chute + 15 s), lê o tamanho da fonte, mede a cor numa captura
   nativa da fonte (`GetSourceScreenshot`, só na memória), grava 8 s, mede a cor em 30 quadros do arquivo e o
   `ffprobe` (tamanho, fps, `pix_fmt`, faixa, matriz, primárias, transferência, perfil, nível), apaga. As 4 da T-0.20:
   `high` (preset High = S9 item 1 hoje), `format60` (`use_preset: false`, formato listado — o que tiver
   1170×2532 no nome, senão o primeiro —, 60/1), `capturecard` (`macos-avcapture-fast`, preset High, numa fonte
   temporária com o mesmo enquadramento, a "iPhone" solta o aparelho com `device: ""` enquanto isso), `preset4k`
   (`AVCaptureSessionPreset3840x2160`). Variantes de cor só se a cor falhar: `format60-partial`, `format60-full`
   (`video_range` 1/2, só existem no modo de formato).
2. `audio --label sp5-audio [--speaker mic|human|skip]` — preparo do Hagah pelo runner (Salmo 23 NIV pelo link,
   Now Playing, Repeat "Chapter" — devolvido no fim —, Play/Pause do transporte lido com o áudio pausado, depois play);
   grava: 45 s de fala contínua (picos; alto-falante) e então 16 × (Pause, 2,5 s, Play, 3,5 s) pelo `ui.tap` público
   (A/V); mede e apaga; pausa o Hagah.
3. `long --label sp5-long` — o mesmo preparo (Salmo 23 tocando, para haver áudio), o hospedeiro à frente (o Hagah segue
   tocando em segundo plano: o resumo mostra se o áudio chegou), 10 min; durante, `GetOutputStatus` a 1 s, `GetStats`
   a 5 s (abaixo de `disk.criticalGiB` para) e `health` do runner a 30 s (só a fila de controle); mede (AC-9.7, código
   do relógio por quadro) e apaga; pausa o Hagah. `--screen hagah` deixa o Now Playing na tela (conteúdo mais leve).
4. `kick --label sp5-kick --mode restart` — 5 × (SIGINT no OBS → reabre no perfil → espera o iPhone na lista do OBS →
   observa 5 s se a fonte vem sozinha → chute pelo `itemName` → fonte viva ≤ 15 s; se não, `device: ""` e o valor de
   novo + 15 s). Sem dono e sem runner.
5. `kick --label sp5-cable --mode cable` — **com o dono**: 5 × (voz "tire o cabo" → o iPhone some da lista do OBS →
   reinicia o OBS com o cabo fora → voz "ligue o cabo" → o iPhone volta à lista → observa 5 s → chute). É o
   "Given o OBS aberto antes de ligar o cabo" literal do AC-9.3 e o caso do travamento ao reconectar (⏳ Q-8). O runner
   fica derrubado nesta fase (tirar o cabo derruba a sessão do XCTest, SP-2).
6. (opcional) `kick --label sp5-replug --mode replug --trials 2` — o cabo sai e volta com o OBS aberto (sem reiniciar):
   a fonte volta sozinha? o OBS cai?

## O que se mede e como (definições deste spike)

| item da T-0.20 | medida | critério |
|---|---|---|
| **1168×2532 sem cor lavada** | Tela do relógio de calibração do hospedeiro (A13): fundo cinza 0,5 (128), células brancas (255) e pretas (0). Áreas lisas: duas faixas de cinza (30,60 → 330×100 pt e 30,590 → 330×190 pt, longe dos dígitos, da grade e das bordas) e o interior de cada célula (8 pt de margem), classificada por quadro (> 170 branca, < 85 preta). No arquivo: 30 quadros a partir de R = 3 s, YUV → RGB pelo ffmpeg seguindo as marcas do próprio fluxo (como um tocador), com arredondamento exato (erro da medida: 0 num arquivo ideal); x no quadro = x nativo − 1 (recorte). Na fonte: a captura nativa do OBS. Referência: a captura `png` nativa do próprio iPhone (`screen.shot`) — o que o app desenhou —; sem ela, a paleta. "Lavado" = preto ≥ 12 e branco ≤ 243 (faixa parcial lida como cheia). | fonte 1170×2532 e arquivo 1168×2532, e no arquivo **max\|Δ\| ≤ 3** por canal em cinza, branco e preto contra a referência do aparelho |
| **picos** | No arquivo (faixa 1 = o iPhone), PCM mono 48 kHz, janelas de 1 s nos 45 s de fala contínua; "com fala" = RMS ≥ −45 dBFS | fala em ≥ 50 % das janelas, **pico máximo ≤ −3 dBFS** e **mediana dos picos ≥ −20 dBFS** |
| **silêncio no alto-falante** | (a) `--speaker mic` (só com o sim do dono): 20 s do microfone embutido do Mac pelo ffmpeg fixado, **só na memória**, durante a fala; controle positivo = uma frase do `say` no alto-falante do Mac (o OBS não grava o áudio do Mac) nos últimos 3 s; correlação do envelope (10 ms) do microfone com o do áudio capturado, atraso buscado em ±3 s. (b) `--speaker human`: o dono, perto do iPhone, ouve ~10 s da fase de áudio e responde no chat. | (a) controle ≥ 6 dB acima do fundo e **correlação < 0,15** = silêncio; ≥ 0,3 = audível; entre, ou microfone mudo (sem permissão) = inconclusivo → (b). (b) o dono não ouve nada |
| **defasagem A/V** | 16 pausas e 16 retomadas pelo Play/Pause do Now Playing. Áudio: a borda de parada (começo de ≥ 1 s abaixo de −60 dBFS — mais que as pausas naturais da leitura) e a de retomada, no PCM em R. Vídeo: o primeiro quadro em que a caixa do botão já se parece mais com o ícone de depois do que com o de antes (e segue assim 2 quadros; o realce do toque escurece o ícone mas não muda a forma). Janela por toque: `GetRecordStatus.outputDuration` antes e depois do `ui.tap` (−0,3 s / +1,5 s). Defasagem = áudio − vídeo (positivo = som atrasado). Válida só se o corte caiu no meio da fala (≥ −40 dBFS nos 30 ms antes da parada). No Hagah, `pause()` chama o `player.pause()` e vira o estado na mesma volta do JS (`audioTransport.ts`), então a pausa é o par mais limpo; a retomada inclui a partida do AVPlayer e só se registra. | **\|mediana\| ≤ 45 ms** nas pausas, com **≥ 10 válidas** (menos = inconclusivo) |
| **10 min a 1168×2532@60** (AC-9.7) | `GetOutputStatus.outputSkippedFrames` no fim; deltas de `GetStats.renderSkippedFrames`/`outputSkippedFrames`; linhas "skipped frames due to encoding lag"/"lagged frames due to rendering lag" do registro do OBS; `ffprobe -count_packets` (tamanho, `r_frame_rate`, quadros contados); tamanho do arquivo. Mais (fora do critério): o código do relógio decodificado por quadro (repetidos = a captura não trouxe quadro novo; saltos ≥ 1,5 quadro) e se o áudio do Hagah em segundo plano chegou. | **0 pulados** em todas as contagens, 1168×2532, 60/1, quadros contados = duração × 60 ± 2, tamanho a **±25 % de 1,2 GB** × duração/600 s |
| **OBS aberto antes do cabo e chute** (AC-9.3 parcial) | Por tentativa: a fonte estava morta antes do chute (`GetSceneItemTransform` ≠ 1170×2532 ou captura preta), a linha "Unable to initialize device" no registro novo, chute → fonte viva (1170×2532 e não preta, sondado a 4 Hz), o `device` resolvido pelo `itemName`, OBS caiu? | **5/5** tentativas com a fonte morta antes do chute voltam em **≤ 15 s**; nenhuma queda do OBS |
| **disco** (HC-11) | Antes de cada gravação: o menor entre `statfs` da pasta e `GetStats.availableDiskSpace`; estimativa de S9 item 4 (bitrate × duração × 1,25) | livre ≥ max(4 GiB, 3 × estimativa + 2 GiB), senão nada é gravado (código 2) |

Estimativas e limites do HC-11 (16 Mbps; livre hoje 21,15 GiB):

| gravação | duração | estimativa (S9 item 4) | livre exigido | real esperado (≈ 2,0 MB/s) |
|---|---|---|---|---|
| `configs` (cada; 4, até 6) | 8 s | 0,02 GiB | 4 GiB | ≈ 16 MB |
| `audio` | ≈ 45 s + 16 × 12 s ≈ 4 min | 0,55 GiB | 4 GiB | ≈ 0,48 GB |
| `long` | 10 min | 1,40 GiB | 6,19 GiB | ≈ 1,2 GB |

No disco ao mesmo tempo: no máximo uma gravação (≤ 1,5 GB). Escrito ao todo ≈ 1,8 GB, tudo apagado. O microfone não
gera arquivo.

## Gravações criadas e apagadas (G4)

(a preencher com `out/*-files.ndjson`: nome, bytes, apagado em)

| fase | arquivo | bytes | apagado |
|---|---|---|---|

## Números

(a preencher com `node spikes/sp-5/sp5.ts report --labels sp5-configs,sp5-audio,sp5-long,sp5-kick,sp5-cable`)

### Configurações da fonte
### Áudio e A/V
### 10 min (AC-9.7)
### Chute (restart e cabo)

## Critério (T-0.20)

| critério | medido | ok |
|---|---|---|
| 1168×2532 sem cor lavada (Δ ≤ 3/255 em áreas lisas) em ao menos uma configuração (qual) | | |
| picos entre −20 e −3 dBFS | | |
| silêncio no alto-falante | | |
| defasagem A/V ≤ ±45 ms | | |
| 0 quadros pulados em 10 min a 1168×2532@60 (AC-9.7, com tamanho ±25 % de 1,2 GB) | | |
| fonte recuperada pelo chute em ≤ 15 s (5/5; AC-9.3 parcial) | | |

## Decisão (regras fixadas antes de medir)

- **Principal** (S9 como está): `high` passa tamanho e cor, 0 pulados a 60 fps em H.264, picos e A/V passam, chute
  5/5 sem queda → S9 itens 1, 3 e 6 confirmados; ⏳ Q-8 segue no 31.1.2.
- Outra configuração passa e `high` não → G1 em S9 item 1 (a fonte de produção passa a ser a que passou).
- Nenhuma configuração nativa, ou cor lavada em todas → variantes `format60-partial`/`format60-full`; sem saída →
  **plano B: QuickTime manual** (ADR-4, S9 item 7) e ⏳ Q-8 com esse dado.
- Quadros pulados > 0 (ou arquivo fora de 1168×2532@60) → **plano B: HEVC** (`com.apple.videotoolbox.videoencoder.ave.hevc`,
  troca de codificador = `obs setup` com o dono, G5) e, se ainda pular, **30 fps** (`record.fps`, G1 no S9 item 1/AC-9.1/
  AC-9.7); tamanho fora de ±25 % com 0 pulados → G1 na estimativa (S9 item 4/ADR-14), não plano B.
- A/V fora de ±45 ms → `SetInputAudioSyncOffset` com a mediana medida (pesquisa capture, plano B do risco de áudio) e
  nova medida; inconclusivo (< 10 válidas) → mais toques; se o desvio parecer do app e não da captura → medir o mesmo
  em **QuickTime manual** (referência da Apple) e comparar.
- Picos fora → conferir o volume da fonte no OBS (0 dB hoje) e o volume de mídia do iPhone (o dono; o runner não
  aperta botões de volume, P-7); alto-falante audível → registrar e levar ao G1 (a narração do dono não pode ter o som do
  iPhone por cima).
- Chute < 5/5 → variante `reset` (`device: ""` e o valor); queda do OBS ao reconectar → evidência para ⏳ Q-8
  (32.2.0 corrigiu "crash when a video device reconnects on macOS") e decisão do dono no G1 da T-0.39.

## O que muda na spec (propostas; nada editado aqui)

- **S9 item 3 / AC-9.3** (a confirmar na medida): o bug #12062 aparece também ao **reabrir o OBS com o cabo ligado**
  (o `probe-1` achou a fonte morta desde a abertura, com o cabo ligado) — o chute do pré-voo não é exceção, é o caminho
  normal de toda sessão do OBS. Medido também o caso literal do AC-9.3 (cabo depois do OBS).
- **A13** (sem mudar comportamento): no OBS 31.1.2, com `use_preset: true` a fonte não expõe `input_format`,
  `color_space` nem `video_range`; `supported_format` vem vazio com a fonte morta.
- (deriva vista, fora deste spike) `mac/src/align/region.ts` ainda diz "canvas 1170×2532" e converte pt → px sem o
  recorte de 1 px do G1 de 2026-10-13 (x no quadro = 3·x_pt − 1): erro de 1 px nas regiões de S7 item 4.
- O resto sai dos números (S9 item 1 se outra configuração vencer; S9 item 4/ADR-14 se o tamanho não bater; ⏳ Q-8).

## O que o dono faz

1. Responder ao **G4** (apagar as gravações do próprio SP-5) e escolher o alto-falante: **`mic`** (autoriza 2 × 20 s
   do microfone do Mac, só na memória; se o macOS pedir a permissão de Microfone para o app do Claude, aceitar) ou
   **`human`** (ficar perto do iPhone ~1 min na fase de áudio e dizer se ouviu algo) ou `skip`.
2. **Fase do cabo** (`kick --mode cable`), ≈ 7 min, junto do Mac e do iPhone: 5 vezes, a voz do Mac pede "tire o
   cabo" e depois "ligue o cabo" (iPhone destravado). Opcional a `replug` (≈ 3 min, 2 vezes).
3. Só se pedido por `OWNER_ACTION`: destravar o iPhone (código/Face ID), tirar alerta/notificação da frente, ajustar o
   volume de mídia do iPhone, fechar o OBS com ⌘Q se o SIGINT não o fechar.

## Minutos de aparelho (estimativa)

`probe` 0,2 · `configs` ≈ 4–5 · `audio` ≈ 8–10 (preparo 2–3, gravação ≈ 4, medida e fim 2) · `long` ≈ 15 (preparo 2,
gravação 10, medida ≈ 2, fim 1) · `kick restart` ≈ 4 (o iPhone só precisa estar ligado) · `kick cable` ≈ 7 (com o
dono). **≈ 38–41 min de iPhone; ≈ 7–10 min do dono** (+ ~1 min com `--speaker human`).

## Riscos registrados antes da medição

- **A/V pelo app**: a defasagem medida no Play/Pause inclui o que o Hagah faz entre o ícone e o som (mesma volta do
  JS na pausa; a retomada tem a partida do AVPlayer). É o que a App Review vê, mas não isola a captura; se ficar perto
  do limite, comparar com o QuickTime manual. A borda do áudio passa pelo AAC (quadros de ~21 ms): espera-se viés de
  alguns ms.
- **Formato manual**: `supported_format` pode seguir vazio com a fonte viva (pesquisa capture F9, formato 0×0) — a
  configuração sai "não aplicável", o que já responde à pergunta.
- **Preset 4K / Capture Card**: podem não dar 1170×2532; a cor só se mede com a fonte nativa. O "Capture Card" solta
  o iPhone da fonte "iPhone" (`device: ""`) durante o teste; a devolução repõe e chuta.
- **Hagah em segundo plano** na fase longa: se o áudio parar ao trazer o hospedeiro à frente, a gravação longa fica
  sem áudio (AC-9.7 é só vídeo; o resumo registra).
- **Reinícios do OBS** (5 na `restart`, mais 5 na `cable`): cada abertura cria um registro novo e o próprio OBS apaga os
  seus registros mais antigos além do limite dele (hoje há 6 na pasta `logs/`, o mais antigo de 2025-09-23; com 10
  aberturas, os mais antigos podem sumir — efeito do OBS, não do driver). Nada mais no OBS do dono é tocado; o OBS
  precisa estar sem gravação e sem nada mais usando-o.
- O runner pode ver `E_TIMEOUT` com o Hagah tocando (SP-2/SP-3): o preparo esvazia a fila e tenta de novo; um toque
  com `E_TIMEOUT` "rodando" vira evento A/V sem par (inválido).
