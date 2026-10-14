# SP-9 — Central de Controle, modo avião, rede, barra de estado (T-0.27)

**Estado:** preparado em 2026-10-14 — driver, testes e plano; **nada gravado, nenhuma escrita no OBS, iPhone não
usado** (o SP-12 estava nele). Só a sonda de leitura `probe-1` rodou contra o OBS real (só pedidos `Get*`, sem
`GetSourceScreenshot`). A execução espera o G4 abaixo. Driver testado sem aparelho e sem OBS em
`node --test spikes/sp-9/sp9.test.ts` (40 testes: lógica pura; a série inteira contra um runner falso com a fila do
XCTest e os prazos do `XCTestLane.swift`; o `ObsClient` de produção contra um OBS falso; medidas num vídeo de teste do
ffmpeg 8.1.1 com o OCR do Mac de verdade).

**Implementa:** S1 item 7, S0.3, S13 item 7. **ACs:** AC-1.15; AC-5.7 (parcial: abrir, tocar e fechar pelo runner,
sem ponto de controle). Critério e plano B vêm de tasks.md T-0.27; linha de base em `spikes/SP-2.md` (série 2: o runner
alterna o avião pela Central, 10/10) e na troca revisada de `spikes/sp-4/lib.ts`.

## Achado antes de medir (para o G1 da T-0.39)

**O arrasto por coordenada que a T-0.27 descreve não é permitido pela lista permitida — e não é preciso.**

- A T-0.27 pede "arrastar (0,9·0,01 → 0,9·0,2)". No iPhone 12 (390×844 pt) o começo é (351; 8,44) pt, dentro da
  faixa de gesto de cima de 47 pt de A9 (`GestureBands`): `AllowList.checkActionPoint` recusa um `ui.drag` que começa
  ali (`E_FORBIDDEN_APP`, "gesto começando na faixa do sistema"). E no SpringBoard só se **toca** o ícone do app alvo
  e o interruptor do avião (S1 item 11; `checkElementAction`); um `{point}` solto é do app alvo (S0.2).
- O mesmo arrasto existe **dentro** do runner: `device.controlCenter {action: open}` faz
  `ControlCenterGesture.open` = 0,9·0,01 → 0,9·0,2 (S1 item 7, `DeviceMethods.swift`), só sobre a tela de início ou um
  app operável. É por ele que o SP-2 abriu a Central 10/10, e é por ele que o SP-9 abre. A lista permitida não é
  contornada.
- O driver faz **uma** sonda (`probe-drag`, desligável com `--no-probe-drag`): manda o `ui.drag` com a coordenada de
  S1 item 7 e espera a recusa. Recusado = confirmado no aparelho; "executed" = lacuna da lista permitida (achado para
  G1; o driver fecha a Central e segue).
- **Proposta de texto (G1, não editado aqui):** T-0.27 e S1 item 7 dizem "abrir pela `device.controlCenter {action:
  open}` (o arrasto 0,9·0,01 → 0,9·0,2 é feito pelo runner; um `ui.drag` com essa coordenada é recusado pela faixa de
  gesto de A9)"; o plano B da T-0.27 ("o runner não toca a Central por coordenada") fica coerente com isso.

## Montagem

- MacBook Air M4, macOS 26.5.x; iPhone 12 (iPhone13,2) "VIVO_00G7", iOS 26.7.1 (23H30), no cabo; Node 22.19;
  ffmpeg/ffprobe 8.1.1 só por `/opt/homebrew/opt/ffmpeg/bin/` (`openFfmpeg`, P-7); OCR do Mac pela T-0.14
  (`mac/tools/ocr.swift`, `xcrun swift`).
- Runner: um build já aprovado (Debug ou Spike; nenhum método `spike.*` é usado), subido pelo orquestrador com
  `bin/contrarregra runner up` — o driver nunca instala, sobe nem derruba o runner. Um controlador por vez: o SP-12 tem
  de ter saído.
- OBS 31.1.2 / obs-websocket 5.6.2 no perfil e na coleção **"Contrarregra"** (T-0.13). O driver só escreve
  `SetRecordDirectory` (devolvida no fim), o chute da fonte (S9 item 3: `SetInputSettings {device}` com o mesmo
  valor) e `StartRecord`/`StopRecord`; toda escrita passa pela guarda do `ObsClient`. Nenhuma é G5 (P-6: "pedidos de
  gravação, o chute da fonte … e ajustes de spike neles não são G5").
- Por baixo da Central: o **Hagah** (`app.explore`, como na cena 9; `--base home` usa a tela de início). O hospedeiro
  não serve: o relógio de calibração esconde a barra de estado (`prefersStatusBarHidden`).

**Estado lido pela sonda `probe-1` (2026-10-14 11:35 UTC, só `Get*`):**

| item | valor |
|---|---|
| versões | OBS 31.1.2 · obs-websocket 5.6.2 · rpc 1 |
| perfil / coleção | Contrarregra / Contrarregra |
| gravando | não |
| pasta de gravação | `/Users/noah/Movies` (o driver aponta para a do rótulo e devolve no fim) |
| fonte "iPhone" | `macos-avcapture`, **0×0 (morta)** — o "chute" de S9 item 3 é necessário no começo, como no SP-5 |
| `device` pelo `itemName` | "VIVO_00G7" → `EE35C40D-…` (6 dispositivos na lista) |
| disco | `statfs` 20,38 GiB livres; `GetStats.availableDiskSpace` 22.014 MiB |
| sessão do runner | `20261014-082801-a29e4a` (Spike, viva: era o SP-12; não foi tocada) |

## Driver (`spikes/sp-9/`)

`lib.ts` (lógica pura: alvo, arrasto × faixa de gesto, disco, PNG, regiões, medidas de imagem, relógio, veredicto,
tabelas, argumentos) · `driver.ts` (a série sobre um ambiente injetado) · `obs.ts` (instantâneo, chute, gravação com
HC-11 e teto, devolução) · `media.ts` (recortes PNG pelo ffmpeg fixado, OCR, medidas) · `capture.ts` (a gravação em
volta de cada troca; apaga a gravação logo depois de medida; limpeza do livro) · `sp9.ts` (comandos) · `sp9.test.ts`.

```
node spikes/sp-9/sp9.ts probe   --label <l> [--runner]       (só leitura; --runner: health, devicectl, Acesso Pessoal)
node spikes/sp-9/sp9.ts run     --label <l> [--cycles 10] [--base hagah|home] [--record both|on|none]
                                [--max-record-s 300] [--hold-s 2] [--min-phase-s 20] [--no-probe-drag]
                                [--no-probe-label] [--keep-crops]
node spikes/sp-9/sp9.ts report  --labels <l1,l2,…>           (tabelas para este arquivo)
node spikes/sp-9/sp9.ts cleanup --label <l>                  (apaga o que o livro de <l> diz criado e não apagado)
```

Saída bruta em `spikes/sp-9/out/` (fora do git): `<label>.ndjson`, `<label>-files.ndjson` (livro do G4: cada arquivo
criado e apagado, com inode), `<label>-obs-snapshot.json` (antes da primeira escrita), `<label>-summary.json`.
Códigos de saída: 0 os ciclos rodaram até o fim (o veredicto está no resumo) · 1 erro · 2 disco abaixo do HC-11 (nada
gravado) · 3 a série parou antes do fim (uma troca falhou; o resumo diz qual) · 4 `OWNER_ACTION` · 5 fora do cabo, OBS
fora do "Contrarregra" ou fora do conjunto validado · 6 a devolução do OBS não fechou. Rodar em segundo plano e parar
só com `kill -INT` (o primeiro termina o passo e desliga o avião; o segundo sai na hora).

## Procedimento (ordem; um spike no aparelho por vez; o dono não precisa estar ao lado)

0. Orquestrador: o SP-12 terminou e o driver dele saiu; `bin/contrarregra runner up` (build aprovado) se a sessão não
   estiver de pé; OBS aberto no "Contrarregra" com o obs-websocket ligado; iPhone destravado, tela acesa, no cabo.
1. `probe --label sp9-probe --runner` — confere perfil, gravação parada, disco, sessão, `wired`, Acesso Pessoal
   desligado, iPhone destravado (só fila de controle; nada na tela).
2. `run --label sp9-run --keep-crops` — sondas (arrasto por coordenada recusado? rótulo "Airplane Mode" resolve?),
   normalização (avião desligado pelo `value`), 10 ciclos × (ligar, desligar), cada troca gravada e medida, gravação
   apagada logo depois. `--keep-crops` deixa os recortes PNG (barra e botão) para conferir a olho antes do passo 4.
3. `report --labels sp9-run` → tabelas abaixo; conferir alguns recortes (Read) contra o veredicto automático.
4. `cleanup --label sp9-run` — apaga os recortes do livro e a pasta vazia do rótulo (G4).

Cada troca (ligar ou desligar), em série na fila do XCTest, cada passo medido com a fila vazia (`health.xctestQueueDepth`):

1. fila vazia; o Hagah à frente (`app.activate`); antes de ligar: `wired` (`devicectl`) e Acesso Pessoal desligado
   (`ifconfig` sem 172.20.10.x), senão para sem tocar no avião;
2. gravação: HC-11 → `StartRecord`; marcas pelo `GetRecordStatus.outputDuration`: barra antes (2 s) e +0,5 s (ruído);
3. **abrir** `device.controlCenter {action: open}` (o arrasto do runner);
4. **achar** `ui.find {target: {app: springboard, identifier: "airplane-mode-button"}}` (AC-1.15) — tempo do pedido à
   resposta com a fila vazia; se estourar os 10 s rodando, o tempo até a fila esvaziar;
5. **`value` antes** pelo `ui.find`; sem ele, `wait.for {airplane: <antigo>}` (prazo 90 s + 1 s);
6. marca; **tocar** `ui.tap` no interruptor (só se ainda no antigo; um estouro "rodando" nunca se repete — o driver
   espera a fila esvaziar, que é o instante do toque real; a Central fechada sozinha → reabre e toca uma vez);
7. **conferir a troca** `wait.for {airplane: <novo>}` com a Central aberta (a fila serial põe a leitura depois do toque);
8. marca; a Central aberta **2 s** com o botão no novo estado (a prova de S13 item 7); marca;
9. **fechar** `device.controlCenter {action: close}` (`press(.home)`) e o que ficou à frente (`health.foregroundApp`);
10. **rede** `wait.for {network: offline|online}` (não lê a tela; 60/90 s), um `device.state`, e o `devicectl` de novo
    (o túnel continua `wired`?); 4 s; marca da barra depois; `StopRecord`;
11. recortes e medidas (abaixo); a gravação é **apagada**; ≥ 20 s até a troca seguinte.

## O que se mede e como (definições fixadas antes de medir)

| item da T-0.27 | medida | critério |
|---|---|---|
| **abrir** | `device.controlCenter {open}`: resultado (`ok`/estourou rodando/na fila), ms no Mac, `tDevEndNs − tDevStartNs`, `path` | abriu (não ficou na fila) |
| **achar em ≤ 2 s** | `ui.find` do interruptor, pedido → resposta com a fila vazia; candidatos, `value`, `frame`, `hittable` | 1 candidato com `value` "0"/"1" em **≤ 2.000 ms** |
| **`value` antes/depois** | antes: `ui.find` (ou `wait.for {airplane}`); depois: `wait.for {airplane: <novo>}` com a Central aberta | antes = antigo, depois = novo |
| **fechar** | `device.controlCenter {close}`; o app à frente depois (`health`) | fechou; registra se voltou ao Hagah ou à tela de início |
| **rede no cabo** | `wait.for {network}` depois do toque (s), `device.state.network`, `devicectl` `transportType`/`tunnelState` depois | `offline` depois de ligar e `online` depois de desligar, com `wired` |
| **barra: 9:41?** | recorte 1168×162 px (0–54 pt) do quadro antes de abrir e do quadro depois da rede confirmada; OCR do Mac (Vision acurado); "9:41" em alguma linha; o "h:mm" lido contra a hora do Mac (± 2 min, 12/24 h) | registro (S13 item 7: "SP-9 confirma no 26.x") |
| **barra: ícone de avião?** | orelha direita (292–384 × 6–46 pt → 875,18 276×120 px): diferença média em cinza antes × depois contra o ruído (dois quadros do antes, 0,5 s) | mudou = Δ > max(6, 3 × ruído) |
| **prova visual do avião** | miolo do frame do botão (do `ui.find`; senão o da troca anterior; senão o centro do toque do SP-2 (78,7; 191,7) ± 20 pt), 20 % para dentro, com a Central aberta: antes do toque e no meio dos 2 s depois; fração de pixels laranja (R ≥ 200, 90 ≤ G ≤ 200, B ≤ 90) e a diferença em cinza | ligado ≥ 0,25; desligado ≤ 0,05; mudou ≥ 12 |
| **sondas** | `ui.drag` com 0,9·0,01 → 0,9·0,2 (espera `E_FORBIDDEN_APP`); `ui.find {app: springboard, label: "Airplane Mode"}` (o plano B resolve? tempo) | registro |

Quadros: o R de cada marca é `outputDuration`/1000 (−0,05 s), extraídos com `-copyts -start_at_zero -ss R` e
`crop`, gravados como PNG na pasta do rótulo; x no quadro = 3·x_pt − 1 (recorte de 1 px do perfil).

## Critério e decisão (regras fixadas antes de medir)

- **Estrito (o texto da T-0.27):** 10/10 ciclos com as duas trocas valendo **e** o `ui.find` em ≤ 2 s em todas.
- **Funcional:** 10/10 ciclos com as duas trocas valendo (Central aberta, `value` antes = antigo e depois = novo,
  Central fechada, rede certa no cabo), sem olhar o tempo do `ui.find`.
- **Rede:** offline depois de ligar e online depois de desligar em todas as 20 trocas, com `wired`.
- **Prova visual:** o botão na Central concorda com o `value` em ≥ 90 % das trocas legíveis (≥ 10) →
  `cc-button-orange`; senão só a mudança de aparência → `cc-button-change`; senão o ícone na barra → `status-bar-icon`;
  senão indefinida. **Barra:** 9:41 em ≥ 90 % dos quadros e a orelha parada ao ligar → `limpa`; relógio de verdade e
  a orelha mudando ao ligar → `real`; o resto → `mista`.

| resultado | decisão |
|---|---|
| estrito ✔ e rede ✔ | **principal**: S1 item 7 / AC-1.15 / AC-5.7 como estão |
| funcional ✔, estrito ✘, rede ✔ | **principal com G1 de tempo**: o prazo de S1 item 3 e o orçamento do passo (`who: runner` da cena 9) com os números medidos; não é plano B |
| funcional ✔, rede ✘ | **G1 em S0.3 `{network}`** (e no `until` da cena 9) |
| funcional ✘ | **plano B**: rótulo "Airplane Mode" e a pessoa toca (ponto de controle `who: human`, ADR-7) |

O SP-2 viu `ui.find` de 4,4 s na sonda e varreduras do SpringBoard com a Central aberta de p50 ~10 s: o estrito
provavelmente falha. A linha "funcional ✔, estrito ✘" foi escrita para isso — **lê "sucesso = 10/10" da T-0.27 como
as trocas, e o "≤ 2 s" como medida que vira G1** — e precisa do acordo do orquestrador antes da execução.

## Disco (HC-11) e arquivos

Cada troca é uma gravação, com a estimativa de S9 item 4 pelo teto `--max-record-s 300` (16 Mbps × 300 s × 1,25 =
0,70 GiB): livre exigido = max(4, 3 × 0,70 + 2) = **4,10 GiB** antes de cada uma (hoje: 20,38 GiB). A gravação para
sozinha no teto e abaixo de `disk.criticalGiB` (2 GiB).

| arquivo | quantos | tamanho | no disco ao mesmo tempo | apagado |
|---|---|---|---|---|
| `SP-9/<rótulo>/<AAAA-MM-DD hh-mm-ss>.mp4` (gravação de uma troca) | até 20 (10 com `--record on`) | ~0,13 GB típico (~65 s a ~2 MB/s), ≤ 0,75 GB | 1 | logo depois de medida |
| `SP-9/<rótulo>/cNN-{on,off}-{band-before,band-before2,band-after,button-before,button-after}.png` | até 100 | ~10 MB no total | todos até o fim | no fim do `run` ou no `cleanup` |
| `SP-9/<rótulo>/` (pasta vazia) | 1 | — | — | `rmdir` (nunca recursivo) |

Escrito ao todo ≈ 2,7 GB típico (≤ 15 GB no pior caso, 20 × 0,75 GB), tudo apagado. A pasta
`~/Movies/contrarregra/spikes/SP-9/` (e as de cima, criadas se não existirem) fica, vazia.

## Gravações e recortes criados e apagados (G4)

(a preencher com `out/sp9-run-files.ndjson`: nome, bytes, apagado em)

| troca | gravação | bytes | apagada | recortes |
|---|---|---|---|---|

## Números

(a preencher com `node spikes/sp-9/sp9.ts report --labels sp9-run`)

### Resumo
### Por troca
### Sondas (arrasto por coordenada; rótulo "Airplane Mode")
### Barra de estado e prova visual

## Critério (T-0.27)

| critério | medido | ok |
|---|---|---|
| 10/10 ciclos (estrito: achar em ≤ 2 s) | | |
| 10/10 ciclos (funcional) | | |
| `network` correto no cabo (offline com o avião, mesmo com o túnel `wired`) | | |
| prova visual do avião definida | | |
| barra de estado: 9:41? ícone de avião? | | |

## O que muda na spec (propostas para o G1 da T-0.39; nada editado aqui)

1. **T-0.27 / S1 item 7:** abrir pela `device.controlCenter {action: open}`; o arrasto por coordenada é do runner e um
   `ui.drag` com ele é recusado (achado acima; a sonda confirma no aparelho).
2. (a preencher) S1 item 3 / AC-1.15 / AC-5.7: prazo e orçamento do achar, se o estrito falhar.
3. (a preencher) S13 item 7: a barra de estado na captura USB do iOS 26.7.1 (limpa ou real) e a prova visual escolhida.
4. (a preencher) `DeviceMethods.controlCenter` diz que "o SP-9 confere que volta ao que estava por baixo": se fechar
   (`press(.home)`) levar à tela de início em vez do Hagah, a cena 9 (Central sobre o Hagah) e o AC-5.7 precisam de um
   passo de volta ao app (G1 em S1 item 7 / S13 item 6).

## O que o dono faz

**Nada**, se as condições do passo 0 valerem. Só se pedido por `OWNER_ACTION` (e o driver para logo depois, com o
avião desligado pelo runner sempre que ele ainda puder): destravar o iPhone; tirar alerta/notificação da frente;
desligar o Acesso Pessoal; desligar o modo avião pela Central (só se o runner caiu com ele ligado).

## Minutos de aparelho (estimativa)

Por troca (SP-2): achar ~4–30 s (o `ui.find` da sonda do SP-2 levou 4,4 s; as varreduras com a Central aberta, p50
~10 s), ler depois ~10–60 s, tocar ~8–128 s do pedido ao toque real, fechar ~4 s, rede ~5–40 s, mais ~9 s de pausas
da gravação e ~10 s de medida; ≥ 20 s entre trocas → ~100 s típico, até ~5 min. `probe` < 1 min;
sondas e normalização ~2–4 min; 20 trocas ≈ 35–80 min. **≈ 40–85 min de iPhone; 0 min do dono.**

## Riscos registrados antes da medição

- **Fila do XCTest com a Central aberta (SP-2):** leituras de 10–60 s e toques que acontecem até ~2 min depois do
  `E_TIMEOUT` "rodando". O driver nunca repete às cegas, esvazia a fila antes de cada passo medido e confere tudo pelo
  `value` e pela rede.
- **A Central fecha sozinha:** cada ocorrência custa até um prazo de leitura (90 s) antes de reabrir; conta em
  `ccReopened`.
- **Fechar por `press(.home)`** pode deixar a tela de início em vez do Hagah; o driver reativa o Hagah antes da troca
  seguinte e registra o que ficou à frente.
- **Barra limpa da captura:** se o iOS trocar a barra na captura USB (9:41), a orelha não muda e a prova é o botão na
  Central — que é o que S13 item 7 já assume.
- **Cor do botão no iOS 26 ("Liquid Glass"):** o laranja pode sair diferente do systemOrange; por isso a regra de
  "mudou de aparência" e os recortes guardados com `--keep-crops` para conferir antes de apagar.
- **Fonte do OBS morta (0×0) ao começar:** o chute de S9 item 3; sem fonte viva em 15 s → `OWNER_ACTION source`.
- **OCR:** a primeira chamada do `xcrun swift` com o cache frio pode passar de 60 s (T-0.14); só atrasa a medida.
- **Bloqueio automático:** o SP-2 rodou ~40 min sozinho sem o iPhone travar; se travar, `OWNER_ACTION unlock` (antes
  de ligar o avião o driver confere `health.locked`).
