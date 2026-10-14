# SP-3 — toques com o app animando (T-0.18)

**Estado:** medido em 2026-10-14, em três estados do aparelho com o áudio tocando. Depois veio uma repetição curta a
partir do Hagah frio (`sp3-heavy`, 07:07–07:15). O critério **não** foi atingido por nenhuma variante. Decisão:
**plano B (d)**, evento sintetizado em todo passo com tempo. As propostas para o AC-1.5 e as outras mudanças de spec
vão no G1 da T-0.39.

Este spike responde a S1 item 5 e ao risco "toques atrasam com a animação contínua" (architecture.md A11). A
hipótese era a espera de ociosidade do XCTest: o leitor do Hagah anima a cada quadro enquanto o áudio toca
(research/xctest.md F21). **No estado da corrida, o custo está na resolução do alvo dentro do toque**: duas
leituras da tela e o snapshot do Hagah. A espera de ociosidade é pequena. Num estado pesado do aparelho (05:21–05:26,
não reproduzido depois), tudo ficou 3–7× mais lento.

## Montagem

- **Aparelho e build.**
  - iPhone 12 (iPhone13,2), iOS 26.7.1 (23H30), cabo `wired`; Xcode 26.6 (17F113).
  - Runner no build `Spike` (instalado com G5), com PX-1, PX-2, PX-3 e PX-5 liberados.
  - O `spike.tapProbe` deu as variantes a, b, c e d disponíveis.
  - A assinatura do bloco de conclusão do PX-3 ficou "não conferida": nenhum protocolo registrado declara
    `synthesizeEvent:completion:`. O método está em `XCTRunnerDaemonSession` e devolve `id` (`@32@0:8@16@?24`).
  - O bloco `void (^)(BOOL, NSError *)`, como o WebDriverAgent usa, concluiu em todos os toques (d).
- **App.** Hagah build 7 do TestFlight, Salmo 23 NIV (dura 0:46). Preparado sozinho pelo driver
  (`spikes/sp-3/prepare.ts`), sem o dono por perto:
  - o link `hagah://bible/ENGNIV/PSA/23` abre sem confirmação do sistema;
  - o driver abre o Now Playing;
  - Repeat estava em "Verse": foi para "Chapter" (∞) e voltou para "Verse" no fim das duas corridas;
  - o áudio fica pausado no fim;
  - 0 refazeres do preparo e 0 reconexões.
  - Um pedido ao dono foi um alarme falso (1ª tentativa da repetição, ver Riscos).
- **Botão medido:** "Forward 15 seconds" (button 46×46 pt, único). O toque não para o áudio.
  - Restaurar: "Back 15 seconds".
  - Efeito: o relógio "m:ss" do tempo decorrido (staticText, ocorrência 0; o restante, "−0:42", usa U+2212).
  - Rótulos do Now Playing no build 7: Sheet Grabber, Close, Previous verse, Back 15 seconds, Play/Pause, Forward
    15 seconds, Next verse, Off, Passage, Verse, Chapter, ⋯ — os mesmos de research/hagah-targets.md F10/F13.
  - O mini-player mostra "Open Now Playing: Psalms 23, NIV" e, com Repeat em verso, "Repeating v. 1".

Variantes (`ios/ContrarregraRunner/Spikes/SP3Taps.swift`, `PrivateXCT/{Quiescence,Synthesize}.swift`):

| id | o quê | API |
|---|---|---|
| `a` | `XCUIElement.tap()` no elemento resolvido | pública |
| `a.coord` | `XCUICoordinate` do SpringBoard no ponto resolvido (o `ui.tap` de hoje) | pública |
| `b` | o toque de `a` dentro de `-[XCUIApplication _performWithInteractionOptions:block:]` (SkipPre\|SkipPost) | PX-2 |
| `c` | o toque de `a` com `-[XCUIApplicationProcess waitForQuiescenceIncludingAnimationsIdle:isPreEvent:]` trocado (pula a espera do app) | PX-2 |
| `d` | `XCSynthesizedEventRecord` + `XCPointerEventPath` (toque de 50 ms) por `-[XCUIDevice eventSynthesizer]` | PX-3 |

Todo toque passa pelo mesmo começo do `ui.tap` (`ReadSession.resolveForAction`):
1. leitura da tela;
2. snapshot do app;
3. resolução;
4. **releitura da tela antes de agir** (`checkForAction`, `ReadMethods.swift:275`).

## Procedimento

1. Orquestrador: build `Spike` e instalação (G5); `runner up --spike`.
2. `node spikes/sp-3/sp3.ts probe --label <l>`.
3. Dono: só deixa o iPhone no cabo, destravado e com a tela acesa.
4. **Corrida principal** (`sp3-run1`, 05:42–06:35):
   `node spikes/sp-3/sp3.ts run --label sp3-run1 --n 50 --restore-states paused --restore-variant d`.
   - O driver prepara tudo, registra os alvos e faz 50 toques medidos por variante, primeiro com o áudio tocando e
     depois pausado.
   - Tocando, não há toque de restaurar: o Repeat "Chapter" dá a volta no capítulo de 46 s e o layout não muda.
   - Pausado, o driver volta ao começo (4× "Back 15 seconds") e cada toque medido é seguido de um "Back 15
     seconds" pela variante (d).
5. **Repetição curta** (`sp3-heavy`, 07:07–07:15): `node spikes/sp-3/sp3.ts heavy --label sp3-heavy`.
   - Preparo normal, depois `app.terminate` do Hagah e reabertura pelo link.
   - O driver abre o Now Playing, dá play e logo em seguida mede: `ui.tree` cronometrado, 20 × (d), 5 ×
     `a.coord` e `ui.tree` de novo.
   - Depois, o mesmo com o áudio pausado. O Repeat volta no fim.
6. O driver só para e pede o dono (`OWNER_ACTION`) com a tela travada, o Hagah fora da frente, login no Hagah ou
   caminho não achado.

**Ajustes feitos no aparelho:**
- O `ui.tree` tem prazo fixo de 5 s. **Estourou no estado pesado** (05:19–05:21). Mediu ≈ 2,4 s no piloto e
  ≈ 0,9 s estimado na corrida; na repetição, 0,77–1,03 s.
- Tocando, o driver lê a árvore com o áudio pausado e usa `health` e `ui.find`.
- O prazo da fila do `spike.tap` foi alargado pelos parâmetros `gapMs` e `completionTimeoutMs`, que num toque único
  não pausam nada.

Saídas brutas em `spikes/sp-3/out/` (fora do git): `sp3-run1*`, `sp3-heavy*` (`sp3-heavy-try1*` é a 1ª tentativa,
parada no preparo), `sp3-pilot*`, e os trechos do `xcodebuild.log` de cada variante (`<label>-<estado>-<variante>.log`).
Sem vídeo; nada em `~/Movies/contrarregra/spikes/SP-3/`.

## O que foi medido

- **`tDevEndNs − tDevStartNs`** por toque (a medida do AC-1.5), separado em duas partes:
  - **resolução** = `tDispatchNs − tDevStartNs`;
  - **envio** = `tDevEndNs − tDispatchNs`; na variante (d), também envio → conclusão do testmanagerd.
- **Chamada → efeito na tela**, medido no próprio aparelho: o relógio lido depois do envio. Cada leitura é um
  snapshot (≈ 0,2–1,4 s), então é um limite de cima.
  - O efeito é decidido **no Mac** (`readEffect`, `spikes/sp-3/lib.ts`), pelas mudanças do relógio registradas.
  - Vale a 1ª mudança consistente com o toque: salto de ±15 s ou salto para o fim do capítulo (0:46).
  - Tocando, se a linha de base (+1 s de resolução do rótulo) mais o tempo passado já alcançaria o fim natural do
    capítulo, a mudança é **ambígua**.
  - O critério do runner (`clockJump`, `minJumpS` 10) só decide quando parar de ler. Ele ignorava o salto para
    0:46 e parava na volta do Repeat.
- **Linhas de espera:** "Wait for … to idle" na janela de cada variante no `xcodebuild.log`.
- **Tempos de cada atividade e snapshot** do XCTest (por processo: SpringBoard × Hagah), pelos carimbos `t = …s`
  do registro entre as marcas `SP-3 tap … begin` (`snapshotTimes`).

## Números

### Três estados com o áudio tocando (mesmo aparelho, mesma sessão do Hagah, 05:21–06:20)

| estado tocando | quando | toque (ms) | 1ª leitura da tela (ms, p50 / p95) | árvore do Hagah (ms, p50 / p95) | snapshot do SpringBoard (ms, p50 / p95) | envio (d) (ms) |
|---|---|---|---|---|---|---|
| **pesado** | 05:21–05:26 (12 toques avulsos) | (d) 15 531 / 15 346 / 6 602; 14 819–19 192 nos 7 primeiros de todas as variantes, 5 063–8 824 depois | 4 980 / 7 630 | 1 480 / 2 050 | 480 / 820 | 319 (1 de 3, sem registro bruto) |
| **piloto** | 05:29–05:32 (3 por variante) | (d) 3 721–3 860 | 1 570 / 1 590 | 460 / 490 | 180 / 390 | 310 / 294 / 315 (2 de 3 > 300) |
| **corrida** `sp3-run1` | 05:42–06:20 | ver a tabela abaixo | 770 / 920 | 240 / 290 | 130 / 340 | 282 / 293 / 295 (p50 / p95 / p99) |

A "árvore do Hagah" vai de "Find the Application 'app.kifactory.hagah'" até a leitura seguinte (o snapshot e o que o
runner faz com ele).

No estado pesado, dentro dos 12 toques (05:22:23–05:26:56, `snapshotTimes`):
- as consultas do XCTest ao Hagah ficaram ≈ 6× mais lentas (p50 820 × 140 ms);
- as ao SpringBoard ≈ 3,7× (p50 / p95 480 / 820 × 130 / 340 ms).

O aparelho estava carregado, não só o Hagah. O 319 ms do envio (d) é 1 de 3 amostras desse estado e não está em
nenhum `.ndjson`: o `xcodebuild.log` só tem as marcas begin/end, e os outros dois (d) estouraram o prazo antes da
resposta.

O estado pesado começou ≈ 30 s depois do play do primeiro preparo (play 05:19:10, 1º `ui.tree` estourado ≈ 05:19:40) e
foi sumindo até ≈ 05:28. O piloto, às 05:29, ainda tinha ≈ 2× a resolução da corrida.

### Corrida `sp3-run1` (no estado da corrida)

`tDevEndNs − tDevStartNs`, resolução, envio e chamada→efeito em ms; n = 50 por linha, todos OK.

| áudio | variante | total p50 / p95 / p99 | resolução p50 / p95 | envio p50 / p95 / p99 | efeito, do início p50 / p95 (causais + ambíguos) | efeito causal | "Wait for … to idle" do Hagah |
|---|---|---|---|---|---|---|---|
| tocando | a | 3446 / 4101 / 4207 | 1529 / 1627 | 1890 / 2607 / 2697 | 3650 / 4316 | 34 (+16 ambíguos) | 100 (2 por toque) |
| tocando | a.coord | 2502 / 2973 / 3028 | 1722 / 2171 | 771 / 841 / 1273 | 2714 / 3211 | 50 | 50 (1 por toque) |
| tocando | b | 2523 / 2870 / 2913 | 1852 / 2152 | 685 / 752 / 771 | 2762 / 3086 | 49 (+1) | 0 |
| tocando | c | 2450 / 3331 / 4425 | 1796 / 2324 | 661 / 811 / 1865 | 2689 / 3585 | 47 (+3) | 0 |
| tocando | d | **2108 / 2304 / 2579** | 1822 / 2020 | **282 / 293 / 295** | 2332 / 2551 | 50 | 0 |
| pausado | a | 2872 / 2967 / 3370 | 1588 / 1641 | 1286 / 1345 / 1798 | 3090 / 3189 | 50 | 100 |
| pausado | a.coord | 2327 / 2529 / 2916 | 1586 / 1660 | 746 / 796 / 1285 | 2522 / 2722 | 50 | 50 |
| pausado | b | 2152 / 2369 / 2502 | 1580 / 1744 | 577 / 625 / 696 | 2361 / 2590 | 50 | 0 |
| pausado | c | 2155 / 2612 / 3695 | 1581 / 1662 | 571 / 1051 / 2130 | 2360 / 2812 | 50 | 0 |
| pausado | d | 1850 / 1907 / 1914 | 1569 / 1629 | 280 / 283 / 284 | 2048 / 2106 | 50 | 0 |

**Efeito:**
- 480 de 500 toques foram causais; 20 ambíguos, todos tocando e perto do fim natural do capítulo:
  - (a) seq 3, 6, …, 48 (16 toques);
  - (b) seq 101;
  - (c) seq 152, 155, 179.
- 0 sem efeito.
- 62 toques causais tinham sido cronometrados tarde pelo runner (o salto para 0:46 ignorado). Recalculado pela
  1ª mudança, o p95 do efeito tocando ficou: (d) 3351 → 2551, a.coord 3716 → 3211, (b) 3831 → 3086, (c) 4017 → 3585.
- A revisão contou 19 ambíguos, com 15 em (a); a lista seq 3…48, de 3 em 3, tem 16.

**Linhas de espera:**
- O Hagah não teve nenhuma linha de espera em (b), (c) e (d).
- Houve linhas do SpringBoard: (c) 3 tocando e 6 pausado; (b) 1 pausado.

### Repetição `sp3-heavy` (Hagah frio, play e logo os toques)

O estado pesado **não se repetiu**. Reinício a frio:
- `app.terminate` 1,6 s, `app.openURL` 2,6 s;
- Hagah à frente na hora;
- Now Playing aberto em 7,7 s, play em 8,2 s.

| áudio | (d) total p50 / p95 | (d) resolução p50 / p95 | (d) envio p50 / p95 | a.coord total p50 / p95 (n 5) | a.coord envio p50 / p95 | `ui.tree` (início, fim) | snapshot do SpringBoard p50 / p95 | árvore do Hagah p50 / p95 |
|---|---|---|---|---|---|---|---|---|
| tocando (n 20) | 1795 / 1867 | 1523 / 1594 | 275 / 280 | 2218 / 2313 | 709 / 736 | 773, 921 ms | 130 / 340 | 190 / 210 |
| pausado (n 20) | 2011 / 2051 | 1736 / 1774 | 275 / 279 | 2509 / 2542 | 778 / 799 | 997, 1033 ms | 150 / 190 | 210 / 220 |

Efeito: 20 de 20 e 5 de 5 causais nos dois estados. (d) do envio ao efeito: 469 / 499 ms tocando e 506 / 512 ms
pausado.

### Onde o tempo vai (estado da corrida)

- **Resolução** ≈ 1,5–2,3 s, feita de:
  - duas leituras da tela de ≈ 0,7–0,8 s cada (p50; a 1ª medida, a 2ª = resolução − 1ª − árvore);
  - o snapshot do Hagah, ≈ 0,2 s.
  - Os 0,7–1,5 s por leitura e 0,4 s de snapshot citados antes eram do piloto; no estado pesado foram ≈ 5 s e
    ≈ 1,5 s.
  - **Com o áudio pausado, a resolução é igual entre as variantes** (1569–1588 ms p50). Tocando, ela variou ao
    longo do tempo: (a) 1529 ms, depois 1722–1852 ms nas variantes seguintes.
- **(a) `XCUIElement.tap()`:**
  - espera pré (Hagah) ≈ 0 / 10 ms; espera pós (Hagah) **1340 / 2060 ms** (pausado, 740 / 750 ms);
  - mais "Find the Button", "Check for interrupting elements" e "Synthesize event".
- **(a.coord), o `ui.tap` de hoje** (a coordenada é do SpringBoard):
  - espera do SpringBoard antes ≈ 0 / 10 ms e depois 30 / 40 ms;
  - espera do Hagah só dentro de "Check for interrupting elements", ≈ 10 ms;
  - os ≈ 0,75 s do envio são a checagem de interrupção e a síntese.
- **(b) e (c):**
  - nenhuma linha de espera do Hagah;
  - o envio continua com "Find the Button", "Check for interrupting elements" e "Synthesize event" (≈ 0,57–0,69 s);
  - as esperas do SpringBoard que passaram pela original em (c), até 0,58 s tocando, são a **cauda do p99 do
    envio de (c)**.
- **(d):**
  - nenhuma atividade do XCTest entre a resolução e o fim, e **também nenhuma checagem de interrupção**;
  - envio → conclusão 281 / 292 ms tocando: os 50 ms do toque mais ≈ 230 ms de ida e volta ao testmanagerd;
  - estável entre estados e variantes (275–295 ms p95 na corrida e na repetição); 310–319 ms no piloto e no estado
    pesado.

## Critério

Critério de sucesso da T-0.18: pelo menos uma de (b), (c), (d) com p95 ≤ 150 ms, p99 ≤ 300 ms e 0 linhas de
espera, com o áudio tocando; (a) caracterizada. **Não atingido.**

- 0 linhas de espera do Hagah: atingido por (b), (c) e (d).
- p95/p99 do total: nenhuma variante chega perto. A melhor, (d), tem 2304 / 2579 ms na corrida e 1867 ms na
  repetição, porque a resolução sozinha passa de 1,5 s. No piloto, 3721–3860 ms. No estado pesado, os (d) levaram
  15,5 / 15,3 / 6,6 s (15–19 s nos 7 primeiros toques de todas as variantes).
- Mesmo só o envio de (d) (p95 280–293 ms) passa dos 150 ms. Fica abaixo de 300 ms no p99 na corrida e na
  repetição, mas não no piloto (315 ms).
- (a) caracterizada: o toque público por elemento espera o Hagah depois do evento; o público pela coordenada quase
  não espera.
- **Pausar o áudio não basta para o AC-1.5**: pausado, (d) ainda leva 1850 ms p50.
  - Pausar tira de 0,18 s (a.coord) a 0,57 s (a) do p50; (d) 0,26 s.
  - Na repetição, pausado ficou até mais lento (2011 × 1795 ms).
  - O estado pesado só apareceu tocando: pausar continua uma opção aberta da coreografia (G1).

## Decisão

- **Plano B de T-0.18: (d) para todo passo com tempo.**
  - É o caminho principal de S1 item 5 (PX-3 presente e funcionando no iOS 26.7.1).
  - É o envio mais curto e estável (275–295 ms p95 na corrida e na repetição, máximo 315 ms no piloto) e não deixa
    nenhuma linha de espera.
  - O `Toucher` de produção deve ser o sintetizado (`PrivateXCT/Synthesize.swift`), em tarefa própria.
- **PX-2 (b, c):** tira as linhas e as esperas do Hagah, mas não encurta o envio abaixo de ≈ 0,57 s. Não substitui
  (d) nos toques. Pela coordenada, as esperas já são de ≈ 10–40 ms.
- **O AC-1.5 depende de onde a resolução e a releitura de segurança ficam** (propostas abaixo). A releitura de
  `checkForAction` (`ReadMethods.swift:275`) é a **única** guarda antes do toque sintetizado: confere a lista
  permitida e a tela (o app à frente, nada do sistema por cima). O (d) não faz a checagem de interrupção do XCTest.
  Ela **não pode sair**.

## O que muda na spec (G1, levado na T-0.39)

1. **AC-1.5** — como está escrito, inatingível: p95(`tDevEndNs − tDevStartNs`) ≤ 150 ms com a resolução e a
   releitura dentro do toque. Propostas, com os dados dos quatro estados (pesado, piloto, corrida, repetição):
   - **(i) resolver o alvo no `hold` anterior; a releitura de segurança fica logo antes do `tDispatchNs`, fora do
     número do AC, mas medida e relatada à parte.**
     - O AC passa a medir o envio: p95(`tDevEndNs − tDispatchNs`) ≤ 350 ms e p99 ≤ 400 ms, com 0 linhas de espera,
       pelo PX-3.
     - Medido: p95 279–293 ms e p99 279–295 ms (corrida e repetição, tocando e pausado).
     - A folga 350 / 400 parte do piloto (310 / 294 / 315 ms, máximo 315). O 319 ms do estado pesado é 1 de 3, sem
       registro bruto.
     - **Só a (i) vale nos quatro estados**: o envio fica em 275–319 ms mesmo onde a resolução passou de 15 s.
     - A releitura ganha um carimbo próprio (ex.: `tCheckNs`, fim da conferência) e **um limite próprio**, senão um
       atraso dela passa verde (o AC mede só o envio, quase constante).
       - Limite da releitura: p95 ≤ 1,1 s, o mesmo do pré-voo.
       - Ou do atraso do envio, `tDispatchNs − hora agendada`: o valor sai da tarefa do executor; não há dado aqui.
       - Custo medido da releitura: ≈ 0,67–0,81 s p50 na corrida e na repetição (1ª leitura p95 920 ms tocando;
         700–830 ms na repetição); ≈ 1,4–1,6 s no piloto; ≈ 2,5–7,9 s no estado pesado.
     - O agendador começa a releitura antes da hora do passo, para o envio cair na hora.
     - O instante do evento continua `tDispatchNs`.
     - Variante (i′): a releitura **dentro** da janela do AC, com p95 ≤ 1,5 s.
       - Cobre a corrida (≈ 0,79 + 0,28 ≈ 1,07 s p50 tocando; p95 ≈ 1,2 s) e a repetição.
       - **Falha 3 de 3 no piloto**: releitura + envio de (d) 1,74 / 1,83 / 1,87 s.
       - Falha também no estado pesado: 2,8 / 7,0 / 8,2 s.
   - **(ii) manter `tDevStartNs` (resolução e releitura na janela) e afrouxar.**
     - p95 ≤ 2,5 s e p99 ≤ 3,0 s com o PX-3: medido 2304 / 2579 ms tocando (corrida), 1867 ms (repetição),
       1907 / 1914 ms pausado.
     - O instante do evento é `tDispatchNs`.
     - Cobre a corrida e a repetição. **Falha 3 de 3 no piloto** (3721 / 3824 / 3860 ms, acima de p95 ≤ 2,5 e
       p99 ≤ 3,0 s) e no estado pesado ((d) 15,5 / 15,3 / 6,6 s).
   - Nas duas, "0 linhas de espera" continua (atingido por (d)), e o botão do AC é "Forward 15 seconds".
   - Recomendação: (i). O que importa para a sincronia (SM-2) é `tDispatchNs`, e o envio é o único trecho estável.
   - Pede um **item de pré-voo**: ler a tela algumas vezes antes da tomada e exigir um p95 da leitura que depende da
     opção. Senão, esperar ou parar.
     - Para (i′)/(ii), a leitura precisa ficar ≲ 1,0–1,1 s. Com 1,4–1,5 s (piloto), (i′) dá ≈ 1,7–1,8 s e (ii)
       ≈ 3,7 s, acima dos limites.
     - Medido: p95 920 ms na corrida e 700–830 ms na repetição.
     - Para (i), o mesmo limite vale para a releitura de cada passo (acima).
2. **S1 item 5 e AC-1.18** — no toque público, a espera de ociosidade acontece **dentro** da chamada do XCTest,
   depois do `tDispatchNs`. Fica em `tDevEndNs − tDispatchNs`, não em `tDispatchNs − tDevStartNs` (ver o comentário
   em `ActionMethods.dispatch`).
   - No caminho público de produção (coordenada do SpringBoard), ela é: SpringBoard antes e depois (0–40 ms) e o
     Hagah só na checagem de interrupção (≈ 10 ms).
   - O AC-1.18 deve dizer "a espera fica em `tDevEndNs − tDispatchNs`". A frase de S1 item 5 "a espera de ociosidade
     … fica desligada para o app alvo só com PX-2" não se aplica ao toque pela coordenada.
3. **S1 item 3 / S0.5:**
   - O `ui.tree` (5 s) estourou no estado pesado. Leva ≈ 2,4 s no piloto e 0,8–1,0 s na corrida e na repetição.
   - Cada leitura da tela (a do `device.state` e a do começo e do fim da resolução de toda ação) leva 0,7–0,8 s fora
     do estado pesado e ≈ 5 s nele.
   - Os prazos da fila precisam contar com o estado pesado. Isso se junta ao G1 do SP-2 sobre os prazos.
4. **A10, PX-3:**
   - `synthesizeEvent:completion:` devolve `id` (`@32@0:8@16@?24`), e o bloco não está em protocolo registrado.
   - Funcionou em todos os toques (d); risco "conferido por uso, não por metadados".
   - PX-2 fica sem uso em toques.
5. **Coreografia do Hagah:** pausar o áudio antes de toques não é necessário para os números da corrida, mas fica
   como opção aberta no G1 por causa do estado pesado, que só apareceu tocando.

## Riscos e observações

- **Estado pesado.**
  - Começou ≈ 30 s depois do play do primeiro preparo (05:19:40) e foi sumindo até ≈ 05:28.
  - Dentro dos toques, as consultas ao SpringBoard ficaram ≈ 3,7× mais lentas e as ao Hagah ≈ 6×. Os (d) levaram
    15,5 / 15,3 / 6,6 s.
  - Às 05:29 já estava mais leve (resolução 3,2–3,7 s); na corrida (desde 05:42) não voltou.
  - A repetição a frio mediu 0–5 min depois do play numa sessão nova do XCTest (registro aberto às 07:07:05), e o
    estado não voltou. Então nem "sessão do XCTest recém-aberta" nem "Hagah recém-aberto e tocando" o explicam.
  - Ressalva: a repetição não exclui a "1ª carga do capítulo", porque o app reabriu com o Salmo 23 já carregado.
  - A causa não foi isolada; o aparelho todo estava lento.
- Os seletores privados existem no iOS 26.7.1 com os tipos esperados; nenhuma variante foi recusada.
- O link `hagah://` aberto pelo runner (`XCUIDevice.shared.system.open`) não pediu confirmação.
- **Alarme falso de "caminho":** na 1ª tentativa da repetição, o preparo parou com `OWNER_ACTION`.
  - O Hagah estava no Salmo 23 com o cabeçalho rolado para fora (o título rola junto com os versículos).
  - Corrigido: o mini-player "Open Now Playing: Psalms 23, NIV" também prova o capítulo. Teste novo em
    `sp3.test.ts`.
- Um `E_TIMEOUT` "rodando" é ação feita com a resposta perdida (como no SP-2). O driver nunca repete um toque que
  estourou o prazo e espera a fila esvaziar (`health.xctestQueueDepth = 0`) antes de cada fase.
- **O efeito medido pela árvore é um limite de cima.** Para o instante exato do quadro na tela, só o vídeo (SP de
  sincronia).
  - O critério do runner foi mantido no build instalado (para de ler no `clockJump`).
  - A decisão do efeito é a do Mac (`readEffect`, testada): aceita o salto para o fim do capítulo e marca o fim
    natural como ambíguo.
