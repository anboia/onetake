# SP-4 — canal usbmux → WebSocket no loopback (T-0.19)

**Estado:** medido em 2026-10-14 (09:34–09:58 UTC), as duas formas, sem o dono ao lado do iPhone. **Principal
(ADR-9 confirmado); plano B (⏳ Q-13) dispensado.** O próprio runner ligou e desligou o avião e pôs o Hagah à frente,
como o `auto` do SP-2; nenhum `OWNER_ACTION`. A revisão mostrou que a parte "com capturas simultâneas" tinha coberto
só o eco de 64 B e o NTP, sem nenhum eco cruzando uma captura em trânsito; a fase suplementar `concurrent2` (loopback,
sem avião; 10:19–10:21 UTC) cobriu o resto e **passou**. Driver testado sem aparelho em
`node --test spikes/sp-4/sp4.test.ts` (42 testes).

Responde a S2 item 2 e ao ADR-9: o Mac chega ao runner pelo `Connect` do usbmuxd até o loopback do aparelho, sem
escutar em mais nada (P-3, P-7). Mede as duas formas de prender o `NWListener` do build `Spike`, o RTT de ecos numa
conexão persistente, o custo de uma conexão nova, a captura, a sincronia de relógio (S7 item 2), tudo de novo com o
modo avião ligado e com capturas simultâneas na outra conexão, e a reconexão depois de um corte. Critério e plano B
vêm de tasks.md T-0.19; ACs: AC-2.1, AC-2.6 (só a reconexão, sem `events.fetch`). Linha de base: research/transport.md
F12–F14 e S0-RTT; a sonda da T-0.11 já achou o loopback alcançável (`Connect` 22,5 ms).

## Montagem

- iPhone 12 (iPhone13,2), iOS 26.7.1 (23H30), cabo; Xcode 26.6 (17F113); Node 22.19 (o do `bin/contrarregra`).
- Runner: build `Spike`, `runner up --spike --bind <forma>` (`CONTRARREGRA_BIND`, T-0.5). Formas
  (`ios/ContrarregraRunner/Server/WebSocketServer.swift`), as duas em IPv4 127.0.0.1, porta `runner.port` (8700):

  | forma | `NWParameters` | é o padrão de produção? |
  |---|---|---|
  | `loopback` | `requiredInterfaceType = .loopback`, `NWListener(using:on: port)` | sim |
  | `endpoint` | `requiredLocalEndpoint = 127.0.0.1:8700`, `NWListener(using:)` | não (só `Spike`) |

- Mac: as peças de produção de `mac/src` — `usbmux/client.ts` (ListDevices, `Connect`), `usbmux/forwarder.ts`
  (repassador em 127.0.0.1:efêmera, um túnel por conexão), `runner/rpc.ts` (WebSocket nativo do Node 22),
  `runner/client.ts` (`openRunner`), `runner/link.ts` (`RunnerLink`, reconexão), `runner/lifecycle.ts`
  (`severRunner`), `clock/ntp.ts` (`fitClock`). Nenhum método novo no runner: só `session.hello`, `clock.ping` com
  `pad`, `health`, `screen.shot` e, entre as fases, `device.controlCenter`, `wait.for {airplane|network}`, `ui.tap`
  no interruptor `airplane-mode-button` e `app.activate`.
- O dono não fica ao lado do iPhone: no cabo, destravado, tela acesa, Acesso Pessoal desligado (o SP-2 viu que ele
  derruba a sessão ao sair do modo avião). O próprio runner põe o Hagah à frente (`app.activate` com o
  `app.explore` = `app.kifactory.hagah`, build do TestFlight; S1 item 11) e liga/desliga o modo avião.
- `SerialNumber` cru do usbmuxd: **`00008101-001E79203A68001E`** — o UDID com o hífen depois dos 8 primeiros dígitos
  hexadecimais, em maiúsculas; normalizado (S2 item 2) = `00008101001E79203A68001E`, igual ao `device.udid` normalizado.
  O `ListDevices` deu **uma** entrada só, `ConnectionType = "USB"` (`DeviceID` 263), nenhuma `Network`, nas duas formas.
- Hagah: o build do TestFlight à frente, **pausado** (sem áudio, como ficou no fim do SP-3; com áudio o `ui.tree`
  estoura — o SP-4 não lê a árvore).
- Estrutura e rótulos registrados aqui têm nome e e-mail da conta Apple trocados por `<redacted>`.

## O que entra em cada medida

Relógio do Mac: `process.hrtime.bigint()` (S7 item 1); percentis pelo posto mais próximo (valor de posto ⌈p·n⌉).

| fase | conexão | o quê | n |
|---|---|---|---|
| `echo64` | `sync` persistente | `clock.ping {seq, pad}` com `pad` de 64 bytes ASCII; o runner devolve o `pad` com o mesmo tamanho (S0.5). Pedido ≈ 144 B, resposta ≈ 209 B de JSON (+ cabeçalho WebSocket). RTT = T4 − T1, da chamada à resposta lida; `dly` = RTT − (T3 − T2), o tempo fora do runner | 1.000 |
| `echo64k` | `sync` persistente | o mesmo com `pad` de 65 536 B (o teto do `pad`): ≈ 65,6 KB em cada sentido | 100 |
| `connect` | nova, crua | ListDevices + `Connect` até o `Result 0`, sem WebSocket; o túnel é fechado na hora | 100 |
| `fresh` | `sync` nova | **conexão nova** = ListDevices (a checagem de E-2.1) → repassador → WebSocket por um túnel novo (o repassador faz outro ListDevices e o `Connect`) → `session.hello` → `clock.ping` de 64 B. `total` vai do começo até a resposta do ping; o fechamento é medido à parte (`close`, esperado até 300 ms e
terminado no fundo depois disso — `closeCapped` —, para um runner que não responda ao quadro de fechamento não custar
o prazo de 1 s do cliente por conexão); fica de fora só o que é custo do Mac e acontece uma vez por execução (ler o estado da sessão, o `ps` do `requireLiveSession`, o token do `.xctestrun`). Etapas: `list`, `fwd`, `ws`, `hello`, `ping` | 1.000 |
| `product` | `sync` nova | o mesmo pelo `openRunner` de produção inteiro (com o `ps`), para comparar com `fresh` | 100 |
| `ntp` | `sync` persistente | rajadas de S7 item 2: 32 trocas `clock.ping {seq}` a 10 ms; 12 rajadas, uma a cada 5 s | 384 |
| `shots` | `control` persistente | `screen.shot {}` (o padrão de produção: JPEG em pontos, qualidade 0,8, S1 item 4) com o Hagah à frente; bytes registrados | 100 |
| `concurrent` | as duas | `screen.shot` sem parar na `control` (`shots.bg`) enquanto a `sync` faz `echo64+shots` (1.000 ecos de 64 B) e `ntp+shots` (12 rajadas) | — |
| `concurrent2` (suplementar, só com `--phases concurrent2`) | as duas | `screen.shot` sem parar na `control` (`shots.bg2`, com os instantes de começo e fim) enquanto a `sync` faz ecos de 64 B **espaçados** (um a cada 20–50 ms, sorteado, por 60 s: ~1.700), 100 ecos de 64 KB espaçados (100–400 ms) e 500 conexões novas; cada amostra leva T1/T4 do Mac, e o resumo conta as que **cruzaram uma captura em trânsito** (os últimos `transitMs` = 20 ms antes de a resposta do `screen.shot` chegar). Vale só com a linha `bg` sem parar e com alguma captura | ~1.700 + 100 + 500 |
| `sever` | `RunnerLink` `control` e `sync` | AC-2.6, só a reconexão: `severRunner` fora de tomada (= `runner sever --for 30` deste processo) corta as duas linhas por 30 s; uma chamada em cada uma durante o corte (tem de falhar na hora com `E_RUNNER_DOWN`); mede a volta depois da janela, o `health` depois e duas rajadas por rodada (θ contínuo através dos cortes); 3 rodadas | 3 |

- **Desvio do θ** = resíduo RMS da **reta de referência** θ(t) = a + b·t (Theil-Sen, `fitClock`, a grandeza de S7
  item 2 e do AC-7.1), tirada **só** das rajadas sem carga e sem avião: `ground/ntp` (no começo) e `sever.ntp` (no
  fim, depois de tudo), sobre o quarto de menor atraso de cada rajada. Critério ≤ 1 ms.
- **Viés do θ** com carga ou com o avião: para `ground/ntp+shots`, `air/ntp` e `air/ntp+shots`, a mediana do resíduo
  do quarto de menor atraso **contra a reta de referência**; critério |mediana| ≤ 1 ms. (O resíduo da reta do próprio
  grupo não enxerga um deslocamento constante — um atraso assimétrico com capturas ou com o avião some dentro do `a`
  daquela reta; por isso ele só aparece como informação.) Registrados também `b` (ppm), o maior |mediana| de uma
  rajada, o atraso p50/mínimo e θ no meio das amostras.
- **Com capturas simultâneas** só vale se as capturas de fundo de fato rodaram: a linha `bg` do cenário tem
  `aborted: false` e `ok > 0`; senão as verificações `*+shots` ficam em aberto (e o sucesso também).
- **Sem mudança com avião** (leitura usada pelo driver; o orquestrador a leva ao G1 se preciso): com o avião ligado,
  os mesmos limites absolutos passam, nenhuma chamada do canal falha e nenhuma conexão cai; a diferença para o cenário
  sem avião é registrada na tabela, não julgada.
- **Modo avião pelo runner**, copiado do `auto` do SP-2 (que fechou 10/10): fila do XCTest vazia (`health`; um
  `screen.shot` atrasado da fase `concurrent` também a ocupa) → `device.controlCenter {action: open}` →
  `wait.for {airplane: <antigo>}` (o `value` do interruptor `airplane-mode-button`, prazo de 90 s — um `ui.find` com a
  Central aberta passa dos 10 s do runner) → `ui.tap` no interruptor, só se ainda no antigo → `device.controlCenter
  {action: close}` → `wait.for {network: offline}` (60 s) ou `{network: online}` (90 s), que não lê a tela. Toda ação
  da fila que estoura o prazo do runner é lida pelo `data.phase` do `E_TIMEOUT`: `running` = vai acontecer (até ~2
  min; o driver espera o efeito e **nunca toca de novo às cegas**); `queued` = não aconteceu (tenta de novo, até 3
  vezes). Se o interruptor ligar e a rede não ficar `offline`, o runner desliga e o bloco com avião fica de fora
  (registrado em `skip`). Desligado vale pelo `value` do interruptor: se a rede não voltar, o driver relê o
  interruptor e não exige a rede.
- **Parada com o avião possivelmente ligado** (erro, runner caído, tela travada): o runner esvazia a fila, abre a
  Central, lê o interruptor por `wait.for {airplane: off}` e só toca se ele ainda estiver ligado; se não conseguir,
  `OWNER_ACTION air-off` e saída 4. O mesmo no começo: sem rede na linha de base, o runner lê o interruptor e desliga um
  avião deixado ligado por uma execução anterior.
- **A fila do XCTest fica fora das medidas**: tudo que vai por ela (Central, interruptor, `wait.for`, `app.activate`)
  só acontece entre as fases, uma chamada de cada vez, e cada fase e cada troca do avião só começam com
  `health.xctestQueueDepth = 0` (até 6 min). O `device.state` (1,6–10 s e enfileira, SP-2) não é usado. Cada chamada da
  fila fica registrada (`xop`, com `lanePhase` quando estoura) com o instante, e as fases com o começo e o fim (`phase …
  t`), para conferir.
- Cada execução começa com a sonda: sessão `Spike` com o bind pedido; linha `CONTRARREGRA_READY port=… bind=…` no
  registro do `xcodebuild` (A13) — se ela existir e não bater com a porta e a forma da sessão, veredito `session`
  (saída 1), nunca "inalcançável"; `ListDevices` inteiro com o `SerialNumber` cru de cada entrada; até 5 `Connect`
  crus; `session.hello`. Recusado com o runner pronto → "forma X inalcançável; rodar a outra" (saída 3); o plano B só
  sai do `compare`, com as duas formas inalcançáveis.

## Procedimento

Orquestrador (o driver nunca instala, sobe nem derruba o runner):

1. Pré-condições: T-0.17 feita (nenhum outro spike no aparelho junto: um por vez); build `Spike` instalado (G5,
   junto com o SP-3); iPhone no cabo, destravado, tela acesa; `devicectl` com `transportType = wired`; **Acesso
   Pessoal desligado** — o driver confere no começo (`ifconfig` com `inet 172.20.10.`) e, se estiver ligado, para com
   `OWNER_ACTION hotspot` antes de mexer no avião (sair do avião com ele ligado derruba a sessão, SP-2).
2. `bin/contrarregra runner up --spike --bind loopback`
3. Em segundo plano (SIGKILL não se trata; parar só com `kill -INT <pid>`, que pede `air-off` ao dono se o avião
   estiver possivelmente ligado e sai com 4):
   `node spikes/sp-4/sp4.ts run --label loopback-1 --bind loopback > spikes/sp-4/out/loopback-1.stdout 2>&1`
   (≈ 10–11 min; acompanhar o `.stdout`).
4. `bin/contrarregra runner down` e `bin/contrarregra runner up --spike --bind endpoint`
5. Do mesmo jeito: `node spikes/sp-4/sp4.ts run --label endpoint-1 --bind endpoint > spikes/sp-4/out/endpoint-1.stdout 2>&1`
6. `node spikes/sp-4/sp4.ts compare --labels loopback-1,endpoint-1` e colar as tabelas abaixo;
   `analyze --label <l>` refaz o resumo de uma execução.
7. `bin/contrarregra runner down` (ou voltar ao build de produção).
8. Suplementar (revisão; ~5 min de iPhone): `bin/contrarregra runner up --spike --bind loopback`;
   `node spikes/sp-4/sp4.ts run --label loopback-c2 --bind loopback --phases concurrent2 --no-airplane > spikes/sp-4/out/loopback-c2.stdout 2>&1`
   (em segundo plano); `bin/contrarregra runner down`. Nessa execução só vale o veredito "concurrent2" do resumo (as
   verificações da execução principal ficam em aberto de propósito).

Códigos de saída do `run`/`probe`: 0 = mediu; 3 = **esta forma** é inalcançável (rodar a outra; o plano B — ⏳ Q-13 num
G1 imediato, nenhuma escuta fora do loopback — só sai do `compare`, com as duas inalcançáveis); 4 = parou com
`OWNER_ACTION` (repassar ao dono e rodar de novo com outro `--label`; também num SIGINT/SIGTERM com o avião
possivelmente ligado); 5 = `transportType` não é `wired` (o SP-2 viu que religar o cabo volta para `wired` em ≤ 2 s;
rodar de novo); 1 = outro erro (inclui a sonda com a sessão errada ou com o `CONTRARREGRA_READY` de outro runner).

Dono: nada, a não ser que o driver pare com `OWNER_ACTION {...}` (a voz do Mac, `say -v Luciana`, repete o pedido; no
resto ela só avisa o que o runner vai fazer). Os únicos pedidos possíveis:

- `unlock` — o iPhone travou: destravar com o código ou o Face ID e deixar a tela acesa.
- `screen` — algo cobre a tela e o runner não consegue pôr o Hagah na frente (alerta do sistema, notificação, outro
  app): fechar. O runner já tentou o `app.activate` duas vezes e fechar a Central de Controle.
- `air-off` — o driver parou com o modo avião possivelmente ligado e o runner não conseguiu desligá-lo (ex.: o runner
  caiu), ou o driver recebeu SIGINT/SIGTERM com o avião possivelmente ligado: desligar o modo avião pela Central de
  Controle.
- `hotspot` — o Mac está na rede do Acesso Pessoal do iPhone: desligar o Acesso Pessoal (antes de qualquer troca do
  avião).

Opções do `run`: `--phases` (subconjunto de `echo64,echo64k,connect,fresh,product,ntp,shots,concurrent,sever`),
`--no-airplane`, `--n64`, `--n64k`, `--n-connect`, `--n-fresh`, `--n-product`, `--n-shots`, `--bursts`,
`--burst-every-s`, `--sever-rounds`, `--sever-s`; para a suplementar, `--phases concurrent2` com `--c2-seconds` (60),
`--c2-n64k` (100), `--c2-fresh` (500) e `--transit-ms` (20).

Saídas brutas em `spikes/sp-4/out/` (fora do git): `<l>.ndjson` (uma linha por amostra, com as linhas `probe`,
`run`, `phase`, `xop`, `toggle`, `net`, `air`, `recover`, `app`, `drain`, `bg`, `transport`, `health`, `drop`,
`sever`, `state`, `abort`), `<l>-summary.json`,
`compare-<l1>+<l2>.json`. Sem vídeo nem captura em disco: nada vai para `~/Movies/contrarregra/spikes/SP-4/`, então não
há G4 de apagar gravação.

## Números

Duas execuções, uma por forma, cada uma de ~11,4 min: `loopback-1` (09:34:48–09:46:08 UTC) e `endpoint-1`
(09:46:34–09:58:04 UTC). 0 falhas do canal, 0 quedas de conexão e o runner nunca religado (`uptimeS` só cresce) nas
duas; o registro do `xcodebuild` sem `WARN`/`ERROR` nem "IDE disconnection" (2.207 `session.hello` da `sync`).

**Resumo por forma** (ms; "sem avião / com avião"):

| | loopback (`requiredInterfaceType = .loopback`) | endpoint (`requiredLocalEndpoint 127.0.0.1:8700`) |
|---|---|---|
| `SerialNumber` cru | `00008101-001E79203A68001E` | `00008101-001E79203A68001E` |
| alcance; `Connect` cru p50 | alcançável; 0,82 / 0,82 | alcançável; 1,27 / 0,90 |
| eco 64 B p50 / p95 (AC-2.1) | 0,63 / 1,36 — 0,78 / 1,45 | 0,79 / 1,44 — 0,67 / 0,83 |
| eco 64 KB p50 / p95 | 10,3 / 19,8 — 10,6 / 13,9 | 10,2 / 12,2 — 9,38 / 12,0 |
| conexão nova p50 / p95 | 6,04 / 10,3 — 6,00 / 9,44 | 7,13 / 10,1 — 5,68 / 9,34 |
| `openRunner` de produção p95 | 12,8 — 10,8 | 10,3 — 13,7 |
| eco 64 B com capturas p95 | 0,71 — 0,87 | 0,71 — 0,53 |
| desvio do θ (reta de referência) | 0,06 | 0,07 |
| viés do θ: capturas / avião / avião + capturas | 0,02 / 0,05 / 0,04 | 0,08 / 0,05 / 0,09 |
| deriva b da referência | 9,54 ppm | 8,40 ppm |
| captura (`screen.shot` JPEG 390×844, ~47 KB) p50 / p95 | 1474 / 1591 — 1475 / 1551 | 1559 / 1618 — 1583 / 1608 |
| reconexão (3 cortes de 30 s): volta depois da janela | 3/3; p50 28,3, máx 30,4 | 3/3; p50 24,1, máx 28,2 |
| avião pelo runner: ligar / desligar (troca inteira) | 11,3 s / 12,0 s | 10,4 s / 9,7 s |

Etapas da conexão nova (medianas, sem avião, loopback / endpoint): ListDevices 0,31 / 0,52; repassador 0,06 / 0,07;
WebSocket por túnel novo (ListDevices + `Connect` + upgrade) 3,53 / 3,93; `session.hello` 1,16 / 1,43; o ping 0,84 /
1,10; o fechamento 1,23 / 1,24 (nenhum passou do teto de 300 ms). O eco de 64 B passa ~0,04 ms no runner (`dev`); o
resto é o caminho Mac → usbmux → aparelho.

### loopback-1 (tabelas do `analyze`)

| cenário | fase | n | erros | p50 | p95 | p99 | máx | medianas das partes |
|---|---|---|---|---|---|---|---|---|
| ground | echo64 | 1000 | 0 | 0.63 | 1.36 | 2.32 | 5.53 | dly 0.58, dev 0.04 |
| ground | echo64k | 100 | 0 | 10.3 | 19.8 | 26.4 | 27.3 | dly 8.22, dev 2.26 |
| ground | connect | 100 | 0 | 0.82 | 1.64 | 2.36 | 2.56 | list 0.25, connect 0.54 |
| ground | fresh | 1000 | 0 | 6.04 | 10.3 | 18.9 | 59.7 | open 5.14, ping 0.84, close 1.23, list 0.31, fwd 0.06, ws 3.53, hello 1.16 |
| ground | product | 100 | 0 | 8.33 | 12.8 | 16.2 | 20.1 | open 7.44, ping 0.86, close 1.20 |
| ground | shots | 100 | 0 | 1474 | 1591 | 1707 | 1784 | bytes 47318 |
| ground | echo64+shots | 1000 | 0 | 0.41 | 0.71 | 1.02 | 4.07 | dly 0.40, dev 0.01 |
| ground | shots.bg | 36 | 0 | 1553 | 1674 | 1706 | 1706 | bytes 47363 |
| air | echo64 | 1000 | 0 | 0.78 | 1.45 | 2.15 | 14.7 | dly 0.74, dev 0.04 |
| air | echo64k | 100 | 0 | 10.6 | 13.9 | 17.5 | 19.6 | dly 8.50, dev 2.19 |
| air | connect | 100 | 0 | 0.82 | 1.78 | 5.15 | 10.8 | list 0.28, connect 0.52 |
| air | fresh | 1000 | 0 | 6.00 | 9.44 | 14.3 | 37.6 | open 5.16, ping 0.80, close 1.27, list 0.32, fwd 0.06, ws 3.58, hello 1.09 |
| air | product | 100 | 0 | 8.26 | 10.8 | 17.4 | 20.7 | open 7.49, ping 0.75, close 1.20 |
| air | shots | 100 | 0 | 1475 | 1551 | 1590 | 1642 | bytes 47078 |
| air | echo64+shots | 1000 | 0 | 0.40 | 0.87 | 1.30 | 5.25 | dly 0.39, dev 0.01 |
| air | shots.bg | 37 | 0 | 1556 | 1688 | 1843 | 1843 | bytes 47080 |

| cenário | rajadas | trocas | erros | resíduo θ (ms) | b (ppm) | RMS das rajadas (ms) | atraso p50 / mín (ms) |
|---|---|---|---|---|---|---|---|
| ground/ntp | 12 | 384 | 0 | 0.06 | 9.11 | 0.02 | 1.58 / 0.76 |
| ground/ntp+shots | 12 | 384 | 0 | 0.06 | 9.54 | 0.03 | 1.28 / 0.46 |
| air/ntp | 12 | 384 | 0 | 0.09 | 8.78 | 0.05 | 2.03 / 0.86 |
| air/ntp+shots | 12 | 384 | 0 | 0.05 | 9.91 | 0.02 | 1.19 / 0.40 |
| ground/sever.ntp | 8 | 256 | 0 | 0.06 | 8.99 | 0.04 | 1.73 / 0.66 |

Reta de referência do θ (ground/ntp + sever.ntp, sem carga e sem avião): 20 rajadas, 160 amostras, resíduo RMS 0.06 ms, b 9.54 ppm.

| grupo | rajadas | amostras | viés contra a referência: mediana (ms) | maior |mediana| de uma rajada (ms) |
|---|---|---|---|---|
| ground/ntp+shots | 12 | 96 | 0.02 | 0.09 |
| air/ntp | 12 | 96 | 0.05 | 0.15 |
| air/ntp+shots | 12 | 96 | 0.04 | 0.06 |

Reconexão (AC-2.6, só a reconexão): 3/3 rodadas; volta depois da janela p50 28.3 ms, máx 30.4 ms; chamada durante o corte falha em p50 0.08 ms.

### endpoint-1 (tabelas do `analyze`)

| cenário | fase | n | erros | p50 | p95 | p99 | máx | medianas das partes |
|---|---|---|---|---|---|---|---|---|
| ground | echo64 | 1000 | 0 | 0.79 | 1.44 | 1.79 | 2.92 | dly 0.76, dev 0.03 |
| ground | echo64k | 100 | 0 | 10.2 | 12.2 | 15.3 | 22.5 | dly 8.16, dev 1.80 |
| ground | connect | 100 | 0 | 1.27 | 2.52 | 3.53 | 3.74 | list 0.42, connect 0.89 |
| ground | fresh | 1000 | 0 | 7.13 | 10.1 | 11.2 | 13.4 | open 6.03, ping 1.10, close 1.24, list 0.52, fwd 0.07, ws 3.93, hello 1.43 |
| ground | product | 100 | 0 | 8.64 | 10.3 | 12.1 | 12.2 | open 7.63, ping 0.98, close 1.06 |
| ground | shots | 100 | 0 | 1559 | 1618 | 1633 | 1637 | bytes 47373 |
| ground | echo64+shots | 1000 | 0 | 0.45 | 0.71 | 0.88 | 1.02 | dly 0.43, dev 0.02 |
| ground | shots.bg | 31 | 2 | 1574 | 2147 | 2419 | 2419 | bytes 47371 |
| air | echo64 | 1000 | 0 | 0.67 | 0.83 | 1.01 | 3.21 | dly 0.62, dev 0.04 |
| air | echo64k | 100 | 0 | 9.38 | 12.0 | 12.3 | 12.4 | dly 7.59, dev 1.79 |
| air | connect | 100 | 0 | 0.90 | 1.19 | 1.30 | 1.86 | list 0.32, connect 0.58 |
| air | fresh | 1000 | 0 | 5.68 | 9.34 | 10.5 | 27.4 | open 4.81, ping 0.89, close 1.07, list 0.42, fwd 0.06, ws 3.21, hello 1.10 |
| air | product | 100 | 0 | 11.8 | 13.7 | 14.3 | 15.1 | open 10.4, ping 1.40, close 1.67 |
| air | shots | 100 | 0 | 1583 | 1608 | 1617 | 1628 | bytes 47065 |
| air | echo64+shots | 1000 | 0 | 0.31 | 0.53 | 0.69 | 0.99 | dly 0.30, dev 0.01 |
| air | shots.bg | 41 | 0 | 1279 | 1608 | 1614 | 1614 | bytes 69454 |

| cenário | rajadas | trocas | erros | resíduo θ (ms) | b (ppm) | RMS das rajadas (ms) | atraso p50 / mín (ms) |
|---|---|---|---|---|---|---|---|
| ground/ntp | 12 | 384 | 0 | 0.07 | 8.94 | 0.04 | 1.74 / 0.99 |
| ground/ntp+shots | 12 | 384 | 0 | 0.05 | 9.91 | 0.02 | 1.20 / 0.49 |
| air/ntp | 12 | 384 | 0 | 0.06 | 7.39 | 0.04 | 1.70 / 1.18 |
| air/ntp+shots | 12 | 384 | 0 | 0.04 | 8.13 | 0.01 | 1.16 / 0.29 |
| ground/sever.ntp | 8 | 256 | 0 | 0.05 | 7.40 | 0.03 | 1.58 / 0.84 |

Reta de referência do θ (ground/ntp + sever.ntp, sem carga e sem avião): 20 rajadas, 160 amostras, resíduo RMS 0.07 ms, b 8.40 ppm.

| grupo | rajadas | amostras | viés contra a referência: mediana (ms) | maior |mediana| de uma rajada (ms) |
|---|---|---|---|---|
| ground/ntp+shots | 12 | 96 | 0.08 | 0.16 |
| air/ntp | 12 | 96 | 0.05 | 0.18 |
| air/ntp+shots | 12 | 96 | 0.09 | 0.11 |

Reconexão (AC-2.6, só a reconexão): 3/3 rodadas; volta depois da janela p50 24.1 ms, máx 28.2 ms; chamada durante o corte falha em p50 0.03 ms.

### Fase suplementar `concurrent2` (`loopback-c2`, loopback, sem avião)

Capturas de fundo na `control` o tempo todo: **60 ok, 0 erros, sem parar** (p50 1461 / p95 1590 ms, ~47 KB cada);
ecos de 64 B espaçados de 20,3 a 51,0 ms (mediana 35 ms) por 60,0 s; "em trânsito" = os últimos 20 ms de cada captura.
Fase inteira 87,5 s; 0 falhas do canal, 0 quedas; registro do `xcodebuild` sem `WARN`/`ERROR`.

| grupo | n | erros | p50 | p95 | p99 | máx | cruzaram captura em trânsito | p50 / p95 / máx dos que cruzaram |
|---|---|---|---|---|---|---|---|---|
| eco 64 B espaçado (`echo64+shots2`) | 1701 | 0 | 1,54 | 2,26 | 2,67 | 7,51 | 26 | 1,58 / 2,04 / 2,27 |
| eco 64 KB espaçado (`echo64k+shots2`) | 100 | 0 | 9,20 | 14,7 | 17,3 | 19,4 | 3 | 9,20 / 10,2 / 10,2 |
| conexão nova (`fresh+shots2`) | 500 | 0 | 2,89 | 4,09 | 5,30 | 15,0 | 6 | 2,44 / 3,52 / 3,52 |

Veredito `concurrent2`: **passa** (bg sem parar e com capturas; 64 B p50 1,54 ≤ 5 e p95 2,26 ≤ 20; 26 ecos cruzaram uma
captura em trânsito; conexão nova p95 4,09 ≤ 50; 0 erros). Os 26 ecos que cruzaram uma transferência ficaram iguais aos
outros (p50 1,58 × 1,54 ms) — a captura em trânsito na `control` não atrasa a `sync`. O eco de 64 B **espaçado** tem p50
maior que o em sequência (1,54 × 0,63 ms): com 20–50 ms de folga entre pedidos, cada eco paga o acordar do caminho USB/
aparelho; continua com folga de 3× no p50 e 9× no p95. Na leitura literal, o 64 KB segue reprovando no p50 (9,20 ms).

### Comparação (`compare --labels loopback-1,endpoint-1`)

| | loopback-1 | endpoint-1 |
|---|---|---|
| bind | loopback | endpoint |
| SerialNumber cru | `00008101-001E79203A68001E` | `00008101-001E79203A68001E` |
| alcance | reachable | reachable |
| eco 64 B p50 / p95 (sem avião) | 0.63 / 1.36 | 0.79 / 1.44 |
| eco 64 B p50 / p95 (avião) | 0.78 / 1.45 | 0.67 / 0.83 |
| eco 64 B com capturas p95 (sem avião / avião) | 0.71 / 0.87 | 0.71 / 0.53 |
| conexão nova p95 (sem avião / avião) | 10.3 / 9.44 | 10.1 / 9.34 |
| desvio do θ da referência | 0.06 | 0.07 |
| viés do θ: capturas / avião / avião + capturas | 0.02 / 0.05 / 0.04 | 0.08 / 0.05 / 0.09 |
| captura p95 (sem avião / avião) | 1591 ✗ / 1551 ✗ | 1618 ✗ / 1608 ✗ |
| quedas com avião | 0 | 0 |
| reconexão (AC-2.6) | 3/3 | 3/3 |
| sucesso T-0.19 | sim | sim |

(✗ na captura = acima da referência de 400 ms de research/transport.md; não é critério da T-0.19.) Decisão do
`compare`: "PRINCIPAL — ADR-9 confirmado: o loopback é alcançável e o critério da T-0.19 passa com bind=loopback,
endpoint. Fica o padrão de produção (`requiredInterfaceType = .loopback`)."

Observações:

- **Escopo das capturas simultâneas (revisão):** na `concurrent`, os 1.000 ecos de 64 B rodaram em 0,34–0,49 s, todos
  dentro da 1ª captura de fundo (que leva ~1,5 s) e antes de a resposta dela (~63 KB) entrar no fio — **nenhum** dos
  4.000 ecos cruzou uma captura em trânsito; o eco de 64 KB e as conexões novas (`fresh`/`connect`/`product`) nunca
  rodaram com capturas. Só as rajadas `ntp+shots` (55 s) cruzaram transferências: 27 de 1.536 trocas na janela dos
  últimos 20 ms de uma captura, todas com RTT ≤ 2,5 ms. O p50 menor do eco com capturas (0,31–0,45 × 0,63–0,79 ms
  sozinho) é do aparelho ocupado (sem estados de economia), não prova de isolamento. A fase `concurrent2` cobriu isso:
  26 ecos de 64 B, 3 de 64 KB e 6 conexões novas cruzaram uma captura em trânsito, sem diferença dos outros.
- **Com o avião, por forma:** na endpoint o avião não piorou nada (64 B p50/p95 0,79/1,44 → 0,67/0,83; 64 KB p50
  10,2 → 9,38). Na **loopback piorou um pouco**, dentro dos limites: 64 B p50/p95 0,63/1,36 → 0,78/1,45 e máximo 5,53 →
  14,7; 64 KB p50 10,3 → 10,6; atraso NTP p50 1,58 → 2,03; `Connect` cru p99 2,36 → 5,15. "Sem mudança com avião" foi
  lido como "os mesmos limites absolutos passam, sem falhas nem quedas" — não como "nenhuma diferença". O túnel
  CoreDevice ficou `wired/connected` o tempo todo, com e sem avião.
- O `screen.shot` levou ~1,5 s (p99 ≤ 1,71 s sozinho) e, com a `sync` ocupada ao mesmo tempo, 2 das 33 capturas de
  fundo da forma endpoint estouraram o prazo de 3 s do runner (`E_TIMEOUT`, 3,05 e 3,09 s). Não é critério da T-0.19
  (não é o canal: o eco no mesmo instante ficou em 0,71 ms de p95), mas é sinal forte para o AC-1.4 (p95 ≤ 500 ms; T-0.28).
- O `health.foregroundApp` começou vazio e só mostrou o Hagah depois do segundo `app.activate` (12,5 s nas duas
  formas); nas fases seguintes, 1 ativação (~0,9 s) depois de fechar a Central (que vai para a tela de início).
- Na endpoint com avião, as capturas de fundo saltam de 47 KB para 69 KB a partir da 18ª (`i` = 17): o mesmo processo do
  Hagah (a captura só sai com ele à frente), outra tela — as imagens não são guardadas, então qual tela fica sem prova.

## Critério

Sucesso (T-0.19): o loopback é alcançável; eco de 64 B na `sync` persistente com p50 ≤ 5 ms e p95 ≤ 20 ms (AC-2.1);
conexão nova com p95 ≤ 50 ms; desvio do θ ≤ 1 ms (resíduo da reta de referência) e viés do θ com capturas e com o
avião |mediana| ≤ 1 ms contra ela; tudo isso também com capturas simultâneas na `control` (com as capturas de fundo de
fato rodando) e sem mudança com o modo avião ligado. A captura não tem limite na tarefa: o p95 fica ao lado da referência de 400 ms de
research/transport.md (S0-RTT). AC-2.6 (só a reconexão): as três rodadas voltam nas duas linhas.

**Como os limites foram aplicados:** p50 ≤ 5 ms e p95 ≤ 20 ms valeram **só para o eco de 64 B** (a leitura do AC-2.1);
o eco de 64 KB foi registrado sem limite. Numa leitura literal da T-0.19 e de research/transport.md S0-RTT
("persistent echo p50 ≤ 5 ms, p95 ≤ 20 ms", os dois tamanhos), **o eco de 64 KB reprova no p50**: ≈ 10 ms nos quatro
blocos (10,3 / 10,6 loopback; 10,2 / 9,38 endpoint, sem / com avião) e na `concurrent2` (9,20 com capturas); o p95
passa raspando na loopback sem avião (19,8 ms; p99 26,4). Questão para o G1 (proposta abaixo). "Sem mudança com avião" foi lido como "os mesmos limites
absolutos passam, sem falhas nem quedas"; a diferença medida está registrada (na loopback o avião piorou um pouco,
dentro dos limites).

**Atingido nas duas formas, na leitura do AC-2.1 e com a ressalva do escopo das capturas.** Pior caso entre as duas:
eco de 64 B p50 0,79 ms (limite 5) e p95 1,45 ms (limite 20); conexão nova p95 10,3 ms (limite 50); desvio do θ 0,07 ms
e maior viés 0,09 ms (limite 1); com o avião, os mesmos limites, 0 falhas e 0 quedas. **Com capturas simultâneas:**
na `concurrent` passaram o eco de 64 B e o NTP (sem nenhum eco cruzando uma captura em trânsito); a `concurrent2`
(loopback) completou — eco de 64 B espaçado p50/p95 1,54/2,26 ms com 26 ecos cruzando uma captura em trânsito (p95
2,04 ms), eco de 64 KB p50/p95 9,20/14,7 ms e conexão nova p95 4,09 ms, todos com capturas sem parar na `control` e 0
erros. A endpoint não repetiu a `concurrent2` (a forma de produção é a loopback).
**AC-2.1 passa** nas duas (1.000 `clock.ping` de 64 B pela `sync`: p50 0,63/0,79 ms, p95 1,36/1,44 ms). **AC-2.6
(só a reconexão) passa**: 6/6 cortes de 30 s, `control` e `sync` de volta 22–30 ms depois da janela, chamada durante
o corte falhando na hora com `E_RUNNER_DOWN` (p50 0,08 ms, máx 1,2 ms), θ contínuo através dos cortes (resíduo 0,05–0,06 ms).

## Decisão

- **Principal: ADR-9 confirmado** no iOS 26.7.1 — usbmuxd `Connect` até o loopback do aparelho, repassador local e
  WebSocket, com folga de uma ordem de grandeza em todos os limites, com e sem avião. **Plano B não se aplica**: ⏳ Q-13
  fica dispensado (o loopback é alcançável nas duas formas; nenhuma escuta fora do loopback, P-3/P-7 intactos).
- Forma de prender o listener: **fica a de produção, `requiredInterfaceType = .loopback`** (o padrão de
  `WebSocketServer.swift`). A `endpoint` também funciona, sem diferença que importe (eco p95 1,44 × 1,36 ms; conexão
  nova p95 10,1 × 10,3 ms; `Connect` cru p50 1,27 × 0,82 ms) — nenhuma mudança de código.

## O que muda na spec (G1 se mudar)

Nada do comportamento muda. Propostas de G1, só de texto (o orquestrador decide se e quando):

- **S2 item 2** (G1, texto): trocar "(o formato cru é registrado no SP-4)" pelo formato medido — "o usbmuxd do macOS
  26 manda o `SerialNumber` com hífen (`00008101-001E79203A68001E`) e só a entrada `USB` com o cabo". A regra de
  normalização fica como está.
- **requirements.md ⏳ Q-13** (G1): fechar como dispensada — o SP-4 mediu o loopback alcançável nas duas formas;
  nenhuma emenda de P-3/P-7/HC-4.
- **Critério do eco na T-0.19** (G1, questão): os limites p50 ≤ 5 / p95 ≤ 20 ms valem só para o eco de 64 B (como o
  AC-2.1 diz) ou também para o de 64 KB (como a letra da T-0.19 e research S0-RTT permitem ler)? Com 64 KB, o p50 é
  ≈ 10 ms em todos os blocos (o tamanho: ~131 KB ida e volta pelo USB); se valer, o critério precisa de um limite
  próprio para 64 KB — nada na produção manda 64 KB pela `sync` (só `clock.ping` sem `pad`).
- **AC-2.1, S2 item 3 e S7 item 2**: sem mudança proposta (com folga; viés do θ ≤ 0,09 ms com carga e com avião). S2
  item 3 conferido com capturas em trânsito pela `concurrent2`: a `sync` não sente a captura da `control`.
- Fora da T-0.19, para quem for dono: o `screen.shot` de ~1,5 s (p95 1,55–1,62 s, com estouros do prazo de 3 s
  sob carga) aponta que o **AC-1.4** (p95 ≤ 500 ms) deve falhar na T-0.28 (SP-10) e que o plano B dele, PX-6
  (⏳ Q-5f), vai ser preciso; e o prazo de 3 s do `screen.shot` (S1 item 3) fica perto demais do p99 com a fila
  ocupada. Não há G1 a partir do SP-4 para isso — a medida própria é a do SP-10.
- Documentação sem G1 (P-6, quando as tarefas terminam): `architecture.md` A11 — risco "Canal usbmux→loopback no iOS
  26.x validado" resolvido pelo SP-4; ADR-9 com os números; research/transport.md S0-RTT com os números do iOS 26.7.1.

## Minutos de aparelho

**Medido:** 24 min de iPhone ao todo (06:34:19 `runner up` loopback → 06:58:10 `runner down` no horário do Mac):
sonda 0,1 min; `loopback-1` 11,3 min; troca de forma (`runner down`/`up`) 0,4 min; `endpoint-1` 11,5 min. Dono: 0 min.
Suplementar `concurrent2`: ≈ 2,2 min de iPhone (07:18:59 `runner up` → 07:21:10 `runner down`, horário do Mac; a fase
em si 87,5 s).

Estimativa antes da medição — por forma: sonda ≈ 0,2 min; linha de base (rede por `wait.for` + Hagah à frente + fila vazia) ≈ 0,3 min; sem avião
≈ 3,5–4 min (o grosso: 1.000 conexões novas ≈ 1 min, 12 rajadas ≈ 1 min, as mesmas 12 com capturas ≈ 1 min, 100
capturas ≈ 0,5 min); ligar o avião pelo runner e confirmar ≈ 0,5–2 min (no SP-2 uma leitura do SpringBoard com a
Central aberta chegou a 20–35 s); com avião ≈ 3,5–4 min; desligar e confirmar ≈ 0,5–2 min; reconexão ≈ 2 min (3 × 30 s
de corte). ≈ 11–14 min por forma, ≈ 22–28 min nas duas, mais ≈ 1–2 min de `runner down`/`up` entre elas. Dono: 0 min,
salvo uma parada com `OWNER_ACTION`. Sem a parte com avião na segunda forma (`--no-airplane`), ≈ 17–20 min.

## Riscos registrados antes da medição

- A forma `endpoint` pode nem subir (o `NWListener` falha e o runner para): o `runner up --spike --bind endpoint`
  não chega ao `session.hello` e o registro do `xcodebuild` mostra a falha do listener. Registrar como "forma
  inviável"; não é o plano B (a outra forma decide).
- O repassador do Mac (`usbmux/forwarder.ts`) não liga `noDelay` nos sockets locais: se o eco de 64 KB ou a conexão
  nova mostrarem caudas em degraus (dezenas de ms), suspeitar de Nagle × ACK atrasado no loopback do Mac antes de
  culpar o usbmux. Correção é código de produção (tarefa própria), não do SP.
- O `Connect` cru (fase `connect` e a sonda) fecha o túnel sem o upgrade do WebSocket: o runner vê uma conexão que
  some antes de falar (`NWConnection` → `.failed` → `finish()`, sem registro, em `WebSocketServer.swift`). Se algo
  diferente aparecer no registro do `xcodebuild`, tirar a fase com `--phases`.
- 1.000 conexões novas seguidas deixam portas em TIME_WAIT dos dois lados; folga grande (faixa efêmera de ~16 mil),
  mas um `E_NO_USB`/`E_RUNNER_DOWN` em série no fim da fase `fresh` aponta para isso.
- A fila do XCTest pode ficar cheia (SP-2): o driver espera ela esvaziar antes de cada fase e de cada troca do avião;
  se passar de 6 min, para com erro (código 1; com o avião possivelmente ligado, antes tenta desligá-lo pelo
  interruptor) em vez de medir contaminado.
- Uma ação da fila que estoura os 10 s do runner rodando ainda acontece: o driver não repete o toque, espera o efeito
  pelo `wait.for` (prazo do runner = `timeoutMs` + 1 s) e só toca de novo depois de ler o interruptor no estado antigo.
- SIGKILL (`kill -9`) não se trata: com o avião ligado, ele fica ligado; a próxima execução o desliga no começo (lê o
  interruptor), ou o dono desliga.
- Fechar a Central de Controle é `press(.home)` (o SP-9 confere para onde volta): se cair na tela de início, o
  runner põe o Hagah à frente de novo antes da próxima fase de captura (`app` com `activations` no registro).
- O `value` do interruptor é lido como `1`/`0` (o que o SP-2 lê; `on`/`off` também valem); outro valor → o
  driver não toca às cegas e para.
- Com o avião ligado o iOS pode manter o Wi-Fi aceso (se ele foi religado num avião anterior): o `wait.for {network:
  offline}` não vale, o runner desliga o avião e o bloco com avião fica de fora (registrado em `skip`); aí o dono teria
  de apagar o Wi-Fi uma vez com o avião ligado — decisão do orquestrador.
- O Hagah pode sair da frente (Auto-Lock, notificação): o runner o reativa antes de cada fase de captura; tela
  travada ou algo que ele não tira → `OWNER_ACTION` e parada. Capturas recusadas no meio de uma fase
  (`E_FORBIDDEN_APP`, S1 item 11) não contam como falha do canal.
- Parada com o avião possivelmente ligado (erro, runner caído, tela travada): o runner esvazia a fila, lê o
  interruptor e só toca se ele estiver ligado; se não conseguir, `OWNER_ACTION air-off` e saída 4.

O que aconteceu com eles na medição: a forma `endpoint` subiu normalmente (8,2 s até o `session.hello`); nenhuma
cauda em degraus que apontasse Nagle (64 KB p99 ≤ 26,4 ms, conexão nova p99 ≤ 18,9 ms; máximo isolado de 59,7 ms numa
conexão nova em 4.000); os `Connect` crus não deixaram linha no registro do runner; nenhum `E_NO_USB`/`E_RUNNER_DOWN`
nas 4.000 conexões novas; a fila do XCTest estava vazia no começo de toda fase (nenhuma espera registrada); nenhum
`E_TIMEOUT` nas trocas do avião (todas `tap: ok`, `value` lido antes de tocar); o Wi-Fi apagou com o avião
(`offline` na primeira tentativa); o runner pôs o Hagah de volta à frente (`app.activate`) depois de cada fechamento da Central; nenhum
`OWNER_ACTION`, nenhuma parada.
