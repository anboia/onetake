# SP-2 — Sessão do XCTest × modo avião; forçar o cabo (T-0.17)

**Data:** 2026-10-14 (05:01–08:16 UTC; hora local = UTC−3). **Implementa:** HC-4, S2, ADR-10.
**ACs:** AC-2.2; AC-2.4 (parcial: a leitura do `devicectl` em `localNetwork`, sem pré-voo).

**Resultado:** critério de sucesso **atingido**, com uma condição nova: Acesso Pessoal desligado (§3).
- Quem prova as 10 rodadas (AC-2.2) é a **série 2** (§6), em que o **próprio runner** liga e desliga o modo avião pela
  Central de Controle.
- A série 1 (§4), feita à mão pelo dono, **não** sustenta "10/10": o dono pulou rodadas, e só 4 ciclos com os rádios
  apagados estão confirmados.

**Decisão:** caminho principal (`xcodebuild test-without-building` + túnel `wired`). O plano B (`devicectl process
launch`) não foi acionado e ⏳ Q-12 não precisa de G1 imediato.

## Ambiente e método

- **iPhone:** iPhone 12 (iPhone13,2) "VIVO_00G7", iOS 26.7.1 (23H30), UDID `00008101-001E79203A68001E`, CoreDevice
  `DC77A78E-5E8D-5825-B2EE-C297FBC14ABD`. Ficou no cabo e destravado o tempo todo.
- **Mac:** MacBook Air, macOS 26.5.2 (25F84), Xcode 26.6 (17F113), `devicectl` 518.33, Node 22.19.0. O OBS 31.1.2
  estava aberto no perfil "Contrarregra" (sem gravar). Nenhuma captura nem gravação foi feita, então não houve G4 e
  nada foi para `~/Movies/contrarregra/spikes/`.
- **Runner:**
  - §1–§5: o build Debug já conferido (`verified-build-Debug.json`), em 3 sessões: `20261014-020300-db05e0`,
    `-021331-4f69f4` e `-025029-293383`.
  - §6: o build **Spike** já conferido (`verified-build-Spike.json`; G5 aprovado pelo dono), por
    `bin/contrarregra runner up --spike` (bind loopback), sessão `20261014-033710-bb2a73`: `xcodebuild` 6466,
    runner PID 32524, de pé em 8,7 s.
  - Cada sessão deixou um `.xcresult` de ~0,5 MB no DerivedData padrão.
- **Driver:** `spikes/sp-2/sp2.ts`. Usa `RunnerLink`/`openRunner` de `mac/src/runner`, `parseDevicectlList` de
  `mac/src/device` e `findUsbDevice` de `mac/src/usbmux`.
  - `transport`: `devicectl list devices --json-output <tmp>` + usbmuxd `ListDevices` a 1 Hz.
  - `airplane` (série 1, avião ligado e desligado pelo dono, guiado pela voz): tudo do `transport`, mais:
    - `health` a 10 Hz (prazo de 1 s);
    - `device.state`;
    - PIDs por `devicectl device info processes` a cada 10 s e 3 s antes de cada anúncio;
    - vida do `xcodebuild` a 1 Hz;
    - anúncios por `say -v Luciana`.
  - `auto` (série 2): as mesmas medidas, com o runner trocando o avião (§6).
  - Saída bruta em `spikes/sp-2/out/` (ignorado pelo git): `<rótulo>.ndjson` e `<rótulo>-summary.json`.
- **Log do aparelho:** `log collect --device-udid` exige root ("Must be root to collect logs from attached device").
  O log veio do app Console, aberto e lido pelo dono (P-3: não se pede senha).
- **Maior intervalo sem resposta ao `health`**, em duas definições (as bordas da janela contam; `E_TIMEOUT` = sem
  resposta):
  - **(a) chegada → chegada:** entre respostas boas consecutivas, pelo instante de chegada;
  - **(b) envio → chegada (estrita):** do envio do último batimento respondido até a chegada da resposta seguinte
    (inclui o período de 100 ms e o RTT).

  O AC-2.2 pede ≤ 2 s. As duas aparecem em todo lugar.

## 1. Forçar o cabo (`transportType`)

Com o cabo ligado, a leitura já era `wired`, com o túnel parado (`disconnected`). Em nenhum momento o
`localNetwork` sobreviveu ao cabo ligado.

| Observação | Rótulo | Resultado |
|---|---|---|
| Cabo tirado com o túnel em uso | `neg-setup` | `localNetwork/connected` na amostra seguinte (≤ 1 s) |
| Cabo religado com o túnel `localNetwork` em uso | `neg-setup` | USB às 05:02:20.461 → **`wired/connected` às 05:02:21.442 (0,98 s)** |
| Cabo religado depois do controle negativo (túnel parado) | `neg` | USB às 05:06:27.826 → `wired/connecting` 28.790 → **`connected` 29.809 (1,98 s)** |
| Túnel frio no cabo; primeiro pedido do túnel | sonda seca (**sem arquivo**: a saída foi apagada) | `disconnected` → `connected` em 2,1 s |

- O Apple DTS (research/transport.md F9) previa que o túnel ficaria no Wi-Fi depois de ligar o cabo. Nesta combinação
  (iOS 26.7.1 + Xcode 26.6) o CoreDevice passou para `wired` em < 1 s.
- O procedimento de S2 item 5 (Wi-Fi do iPhone desligado em Ajustes por 10 s e religado) **não foi necessário e não
  foi exercitado**.
- **Procedimento documentado e medido:** iPhone destravado no cabo; se o `devicectl` mostrar `localNetwork`, tirar e
  religar o cabo; o primeiro uso do túnel sobe `wired`/`connected` em **≤ 2 s**. São 2 medidas com registro (0,98 s e
  1,98 s) e 1 sem arquivo (2,1 s).
- **AC-2.4 (parcial):** a leitura em `localNetwork` está em `out/neg-setup-devicectl-localNetwork.json`:
  `transportType: "localNetwork"`, `tunnelState: "connected"`, `tunnelTransportProtocol: "tcp"`,
  `tunnelIPAddress: "fd24:e296:caab::1"`, e `localHostnames` (no lugar de `potentialHostnames`). O
  `parseDevicectlList` lê os dois campos que o PF-03 usa.

## 2. Controle negativo (`localNetwork` + modo avião): a morte se reproduz ✔

Não foi possível ter `localNetwork` com o cabo ligado (§1), e o `runner up` exige a entrada USB (AC-2.3). O arranjo foi:

1. Runner subido no cabo, em 18,0 s.
2. Às 05:03:38 o dono tirou o cabo, e a sessão migrou sozinha para `localNetwork/connected`.
3. O runner sobreviveu à migração: PID 31493 visto 9 vezes pelo `devicectl` via Wi-Fi e `xcodebuild` 77613 vivo por
   ~95 s.

| Instante (UTC) | Evento |
|---|---|
| 05:05:03.67 | anúncio "ligue o modo avião" |
| 05:05:07.78 | túnel `localNetwork/connecting` (o Wi-Fi caiu) |
| 05:05:13.71 | `xcodebuild` morto (10,0 s depois do anúncio). Registro: `IDELaunchReport … Finished with error: An error occurred while communicating with a remote process.` / `CoreDeviceError 3` / `The connection was invalidated.` (`com.apple.Mercury.error 1001`) / `** TEST EXECUTE FAILED **` |
| 05:05:20 → 05:06:19 | túnel `unavailable` |
| 05:06:29.81 | cabo religado → `wired/connected`; runner ausente da lista de processos (17 de 17 amostras até 05:09:03) |

- **"Exiting due to IDE disconnection": 0 linhas.** O dono observou o Console do aparelho (filtro "IDE
  disconnection", streaming ligado durante o controle negativo). O registro do `xcodebuild` também tem 0 linhas.
- A assinatura da morte do lado do Mac é a saída do `xcodebuild` com "The connection was invalidated" e "TEST
  EXECUTE FAILED".

## 3. Acesso Pessoal pelo cabo derruba a sessão ✘ (tentativa `air`/`stab`, sessão `-021331-4f69f4`)

- Aquecimento de 120 s: 100 % `wired/connected`; maior intervalo do `health` (a) 339 ms.
- Rodada 1 (avião pelo dono), fase ligada (05:16:09–05:17:09): nada caiu. Maior intervalo (a) 175 ms, PID 31624,
  `xcodebuild` vivo.
- Às **05:17:52.3** (43 s depois do anúncio "desligue") o usbmuxd perdeu o iPhone por ~5 s:
  1. O túnel foi para `localNetwork`, depois `wired/connecting`.
  2. Às 05:18:02 o `xcodebuild` falhou com o mesmo "The connection was invalidated", e saiu às 05:18:03.5.
  3. O runner órfão continuou respondendo `health` pelo usbmux até 05:18:23 (~20 s depois) e sumiu.
- **Causa:** no mesmo milissegundo o `configd` do Mac registra `en5 link INACTIVE` / `DHCP en5: removing 172.20.10.2`.
  - O `en5` é a porta **"iPhone USB"** (`networksetup -listallhardwareports`; MAC `92:81:58:…`, do iPhone). O
    endereço 172.20.10.x é a sub-rede do **Acesso Pessoal**: o Mac estava ligado à internet do iPhone pelo cabo.
  - O `en5` apareceu às 05:06:27, quando o cabo foi religado após o controle negativo, e recebeu DHCP às 05:06:31.
  - Quando o celular volta ou cai, o iPhone reconfigura a interface de compartilhamento e o aparelho USB inteiro some
    e volta.
  - Em 8,7 min houve 5 sumiços do USB e 8 saídas de `wired`, todos casados com eventos `en5 link` (05:17:52, 05:19:52,
    05:20:05, 05:20:29, 05:20:39, 05:21:04).
- O dono desligou Ajustes > Acesso Pessoal > "Permitir Que Outros Acessem" e não disse se estava ligado antes; o DHCP
  172.20.10.2 no `en5` mostra que estava. Desde então nenhuma interface do Mac tem 172.20.10.x (a interface do iPhone
  que restou, `en8`, só tem link-local 169.254.x), e não houve mais nenhuma queda de USB (§4–§6).

## 4. Série 1: o dono liga e desliga o avião, guiado pela voz (Acesso Pessoal desligado). Não prova 10/10

Rótulos `air2` e `stab2`, sessão `-025029-293383` (`xcodebuild` 87294, runner 32188). As 10 rodadas foram anunciadas de
05:53:18.7 a 06:13:18.7. **O dono disse depois que pulou alguma(s) rodada(s) e não sabe quais.**

| Medida (05:50:53–06:20:51) | Valor |
|---|---|
| PID do runner | 32188 em 201 de 201 amostras; `uptimeS` sem recomeço |
| `xcodebuild` 87294 | vivo do começo ao fim; 0 linhas "IDE disconnection" / "TEST EXECUTE FAILED" |
| conexão `control` | 0 quedas |
| `health` | 17.775 enviados, 22 `E_TIMEOUT` em 2 rajadas (06:02:42 e 06:03:35); RTT p50 3,0 ms, p95 12,7 ms, máx 994 ms |
| maior intervalo | (a) **1.546 ms** · (b) **2.126 ms** (> 2 s), ambos nas rajadas, com a fila do `device.state` cheia |
| transporte | 100 % `wired/connected` |

**Ciclos com rádios apagados confirmados** (`device.state.network = offline`, agrupado pelo instante da resposta). São
**4 ciclos de 10 anunciados**:

1. fase "desligado" da rodada 2 + fase "ligado" da 3, um único episódio: 05:56:29.9–05:58:28.3;
2. rodada 4: 05:59:36.9–06:00:23.5;
3. rodada 5: offline desde 06:01:27.99;
4. rodada 9: offline desde 06:09:47.86.

Nas rodadas 1, 7 e 8 a rede ficou online. Nas 6 e 10 o `device.state` estava ilegível (fila).

- A latência alta do `device.state` (7–10 s) nas rodadas 5–8 **não** prova que o dono mexeu na Central. Os mesmos
  7,3–9,5 s aparecem sem ação do dono (06:05:55–06:08:20 e 06:15:43–06:19:19); é a fila acumulada.
- Uma primeira versão deste relatório explicava as rodadas online pelo "iOS manter o Wi-Fi ligado no avião". Essa
  hipótese **não tem suporte**: o dono pulou rodadas. Na série 2, todas as vezes que o runner ligou o avião, a rede
  ficou `offline` (§6).
- A série 1 mostra que a sessão sobreviveu a 4 ciclos de rádios apagados e a 30 min de cabo. Não sustenta 10/10.

## 5. Estabilidade de 30 min em `wired` ✔ (rótulo `stab2`, processo próprio, sem pedir túnel)

- Janela: t0 05:50:22.98 → 06:22:02.98 (**1.900 s = 31,7 min**), 1.899 amostras, maior intervalo entre amostras 1,12 s.
- `transportType = wired` em **1.899 de 1.899** amostras, **0 trocas**. USB no usbmuxd em 100 %.
- `tunnelState = connected` em 1.891: as 8 primeiras (8,1 s) eram `disconnected`, antes de o `runner up` pedir o túnel.

**Sobreposição com a série 1** (decidida pelo orquestrador; o dono achou sem sentido esperar 30 min parado):

- A janela foi medida inteira por um processo próprio.
- Sobrepor só a torna mais exigente: ciclos de rádio, Central de Controle, `health` a 10 Hz, dois `devicectl list` por
  segundo.
- O risco que ela procura (voltar para `localNetwork`) só existe com o Wi-Fi disponível. Pelo calendário, o avião
  ficou desligado ~1.300 de 1.900 s (~68 %), incluindo os últimos 9,7 min (06:12:18–06:22:03).
- **Confirmado pelo `device.state`:** de 06:12:23 a 06:15:33 tudo deu `E_TIMEOUT`, e o primeiro "online" depois do
  último anúncio é de 06:15:52.6. Portanto há **≥ 6,2 min contínuos confirmados com Wi-Fi** no fim (9,7 pelo
  calendário), mais os trechos entre as rodadas.
- Como o dono pulou rodadas, o Wi-Fi pode ter ficado disponível mais tempo do que o calendário diz. Isso não diminui
  a exigência da medida.
- A série 2 (§6) acrescenta mais ~78 min de transporte 100 % `wired/connected`.

## 6. Série 2: o runner liga e desliga o avião pela Central de Controle ✔ (prova do AC-2.2)

**Como.** O dono não agiu; a voz só avisou ("SP-2: o runner vai ligar o modo avião, rodada n"). Para cada troca, em
série na fila do XCTest:

1. `device.controlCenter {action: open}`;
2. leitura do interruptor `airplane-mode-button` por `wait.for {airplane: <estado atual>}`, que é a confirmação pelo
   `value` da troca **anterior**, já com o estado parado;
3. espera até ≥ 60 s depois da confirmação pela rede da troca anterior (o que se espera é o *pedido* do toque; o
   toque real veio 8–128 s depois do pedido, ver a tabela);
4. `ui.tap` no interruptor;
5. `device.controlCenter {action: close}`;
6. confirmação pela rede, por `wait.for {network: offline|online}`, que não lê a tela.

Não houve `device.state` periódico (era ele que enchia a fila na série 1). A fila foi medida pelo `xctestQueueDepth`
do `health`. A lista permitida liberou só o interruptor com a Central aberta (`AllowList.swift`, `isSpringBoardActionable`).

**Tentativas que pararam antes** (rótulos `auto` a `auto5`, mesma sessão; o runner sobreviveu a todas):

| Rótulo (UTC) | O que aconteceu |
|---|---|
| sonda 06:37:32–06:37:46 | abrir a Central, `ui.find` 4,4 s (`value` "0"), fechar 4,2 s, `device.state` 1,2 s: o caminho funciona |
| `auto` 06:37:52–06:40:02 | rodada 1: ligado confirmado (`value` 0→1, rede `offline`); o toque de desligar estourou os 10 s do runner (`E_TIMEOUT` "rodando") e o driver parou. O toque aconteceu: às 06:41:39 `value` "0" e rede online |
| `auto2` 06:42:23–06:44:28 | rodada 1: toque de ligar ok (9,9 s); 6 leituras `ui.find` estouraram 10 s (a leitura da tela com a Central aberta passou de 10 s); o driver parou com o avião **ligado**, que ficou assim até 06:48:55 (~5,7 min, confirmado por `wait.for {airplane: on}` às 06:48:44) |
| `auto3` 06:48:36–06:53:37 | normalização (ligado→desligado), rodada 1 completa (rede `offline` +9,7 s, `online` +11,3 s); rodada 2: o toque de ligar aconteceu, as leituras (`wait.for`, 41 s) estouraram; avião **ligado** do toque real às 06:52:50.0 até o toque de desligar às 06:56:14.3 (~3,4 min; confirmado por `wait.for {airplane: on}` às 06:55:56) |
| `auto4` 06:55:37–06:58:21 | normalização (ligado→desligado, online +28,7 s); a leitura antes da rodada 1 estourou duas vezes (31 s) e o driver parou (avião desligado) |
| `auto5` 07:02:59–07:28:38 | rodadas 1–5 completas e a 6 ligada; parou porque **a Central fechou sozinha** durante a espera antes do toque de desligar da 6 (`E_TARGET_NOT_FOUND`), não pela fila; avião **ligado** do toque real às 07:27:18.4 até o toque de normalização da `auto6` às 07:35:10.9 (~7,9 min), com o runner vivo (às 07:34:29: `uptimeS` 3.430 s, rede `offline`) |

Nas tentativas, o PID 32524 ficou constante, o `xcodebuild` vivo, 0 falhas de `health` e o transporte 100 %
`wired/connected`. O maior intervalo (a)/(b) por tentativa: `auto` 224/232 ms · `auto2` 145/147 · `auto3` 481/483 ·
`auto4` 395/398 · `auto5` 723/731 ms.

**Série que prova o critério: `auto6`** (07:34:53–08:15:40 UTC; o driver reabre a Central se ela fechar sozinha).

Os instantes reais dos toques vêm do registro do `xcodebuild` da sessão (`xcodebuild-20261014-033710-bb2a73.log`):
linhas "Tap Application 'com.apple.springboard' … (78.7, 191.7)" seguidas de "Synthesize event", com t0 = "Start Test"
às 06:37:17.844 UTC. As horas do driver (pedido, resposta, estouro) estão em `out/auto6.ndjson`.

| Rodada | ligar: pedido → toque real | `value` | rede `offline` (após o toque) | desligar: pedido → toque real | `value` | rede `online` (após o toque) | avião ligado (toque→toque) | maior intervalo (a)/(b) | fila máx |
|---|---|---|---|---|---|---|---|---|---|
| 1 | 07:36:18 → 07:36:26 (+8,4 s) | 0→1 | +6,3 s | 07:37:33 → 07:37:41 (+8,5 s) ¹ | 1→0 | +7,4 s | 74,8 s | 316/318 ms | 2 |
| 2 | 07:38:48 → 07:38:57 (+8,4 s) | 0→1 | +22,1 s | 07:40:19 → 07:41:22 (+63,2 s) ¹ | 1→0 | +16,8 s | 145,3 s | 523/526 ms | 5 |
| 3 | 07:43:06 → 07:45:14 (+127,5 s) ¹ | 0→1 | +11,6 s | 07:46:35 → 07:47:41 (+65,9 s) ¹ | 1→0 | +13,2 s | 147,5 s | 608/616 ms | 6 |
| 4 | 07:49:10 → 07:50:30 (+80,5 s) ¹ | 0→1 | +8,4 s | 07:51:40 → 07:52:50 (+69,2 s) ¹ | 1→0 | +21,8 s | 139,5 s | 560/564 ms | 5 |
| 5 | 07:54:19 → 07:55:29 (+69,5 s) ¹ | 0→1 | +11,1 s | 07:56:42 → 07:57:14 (+31,4 s) ¹ | 1→0 | +19,4 s | 105,0 s | 938/979 ms | 5 |
| 6 | 07:58:33 → 07:59:38 (+64,9 s) ¹ | 0→1 | +5,3 s | 08:00:43 → 08:00:52 (+8,2 s) ¹ | 1→0 | +7,6 s | 73,5 s | 534/540 ms | 5 |
| 7 | 08:01:59 → 08:02:30 (+30,4 s) ¹ | 0→1 | +40,9 s | 08:04:11 → 08:04:19 (+8,3 s) | 1→0 | +13,9 s | 109,2 s | 425/428 ms | 4 |
| 8 | 08:05:33 → 08:05:50 (+17,5 s) ¹ | 0→1 | +26,7 s | 08:07:17 → 08:07:28 (+10,7 s) ¹ | 1→0 | +17,4 s | 97,4 s | 451/476 ms | 3 |
| 9 | 08:08:45 → 08:09:11 (+25,7 s) ¹ | 0→1 | +23,3 s | 08:10:34 → 08:10:42 (+8,1 s) | 1→0 | +15,0 s | 91,4 s | 356/371 ms | 3 |
| 10 | 08:11:57 → 08:12:42 (+44,2 s) ¹ | 0→1 | +7,3 s | 08:13:49 → 08:13:57 (+8,3 s) | 1→0 | +13,9 s | 75,6 s | 431/440 ms | 5 |

¹ O `ui.tap` estourou os 10 s do runner **rodando** (`E_TIMEOUT`, 15 de 20 toques).
- Em 13 desses 15, **o toque aconteceu DEPOIS do erro**, de 0,7 a 117,5 s depois. Exemplo da rodada 3 (ligar): pedido
  às 07:43:06.8, `E_TIMEOUT` às 07:43:16.8, toque às 07:45:14.3: a fila do XCTest ficou presa até o toque, 117,5 s
  depois do erro.
- Só no "desligar" das rodadas 1 e 6 o toque veio antes do erro (1,5 e 1,9 s antes).
- Os toques que responderam a tempo vieram 8,1–8,4 s depois do pedido.

- **Leitura do `value`.** O "0→1" de cada "ligar" foi lido na abertura seguinte, antes do "desligar". O "1→0" de cada
  "desligar" foi lido antes do "ligar" seguinte; o da rodada 10, na conferência final (08:14:30, "0").
- **Rede.** É o tempo do toque real até o `wait.for {network}` responder: 5,3–40,9 s para `offline` e 7,4–21,8 s para
  `online`. Inclui a fila do XCTest (o "fechar" e o `wait.for` esperam o toque terminar).
- **Duração das fases, de toque real a toque real.**
  - Avião **ligado**: 73,5–147,5 s.
  - Avião **desligado**, entre rodadas: 75,8–231,7 s (r1→r2 75,8 · r2→r3 231,7 · r3→r4 168,9 · r4→r5 159,1 ·
    r5→r6 144,3 · r6→r7 98,1 · r7→r8 91,5 · r8→r9 103,2 · r9→r10 119,2).
  - O mínimo ≥ 60 s se manteve: o menor foi 73,5 s.
  - O driver mediu "60 s" da confirmação pela rede até o *pedido* seguinte (60–87,4 s). O toque real veio depois,
    porque a fila do XCTest atrasou.
  - Do primeiro toque (07:36:26.7) ao último (08:13:57.7) a série levou **37,5 min**.

| Medida (auto6, 07:34:53–08:15:40, 2.447 s) | Valor |
|---|---|
| PID do runner | **32524 em 246 de 246 amostras**; `uptimeS` 3.455 → 5.902 s, **0 recomeços** (a sessão é a mesma desde 06:37:19) |
| `xcodebuild` 6466 | **vivo do começo ao fim**; 0 linhas "IDE disconnection", "Exiting due to", "TEST EXECUTE FAILED" |
| conexão `control` | 0 quedas, 0 reconexões |
| `health` a 10 Hz | **24.115 enviados, 24.115 respondidos, 0 `E_TIMEOUT`**; RTT p50 2,6 ms, p95 12,8 ms, p99 76 ms, máx 877 ms |
| **maior intervalo sem resposta** | **(a) 938 ms · (b) 979 ms** (07:55:32.9, rodada 5; ≤ 2 s pelas duas definições) |
| fila do XCTest (`xctestQueueDepth`) | máx 6 |
| transporte | **2.445 de 2.445 amostras `wired/connected`**, USB em 100 % |
| antes da rodada 1 | normalização: o avião estava ligado (deixado pela `auto5`) e o runner o desligou (rede online às 07:35:18) |

**Contando todas as tentativas da série 2:** a mesma sessão (PID 32524, `xcodebuild` 6466) sobreviveu a 20 períodos de
avião ligado pelo runner, todos confirmados pelo `value` do interruptor (18 deles também pela rede `offline`). Três
foram longos, de toque real a toque real:
- `auto2` r1: 06:43:10.3 → 06:48:53.4, ~5,7 min;
- `auto3` r2: 06:52:50.0 → 06:56:14.3, ~3,4 min;
- `auto5` r6: 07:27:18.4 → 07:35:10.9, ~7,9 min.

Nenhuma queda.

## Critério de sucesso (T-0.17)

| Critério | Resultado |
|---|---|
| `wired` em ≤ 30 s por procedimento documentado | ✔ ≤ 2 s (0,98 s e 1,98 s com registro; 2,1 s sem arquivo): cabo ligado, iPhone destravado, primeiro uso do túnel |
| estável por 30 min | ✔ 31,7 min, 0 trocas, com o Acesso Pessoal desligado (✘ com ele ligado: 8 saídas de `wired` em 8,7 min) |
| 10/10 mesmo PID e intervalo ≤ 2 s (AC-2.2) | ✔ **série 2 (runner)**: 10/10 rodadas com `value` 0→1→0 e rede `offline`/`online` confirmados; PID 32524 constante (246/246), `xcodebuild` vivo, maior intervalo (a) 938 ms / (b) 979 ms, 0 `E_TIMEOUT`; de toque real a toque real, fases ligadas de 73,5–147,5 s e desligadas de 75,8–231,7 s (≥ 60 s). A série 1 (dono) teve só 4 ciclos confirmados e não conta |
| controle em Wi-Fi reproduz a morte | ✔ `xcodebuild` morto 10,0 s depois do anúncio; runner ausente depois |

**Decisão:** fica o principal: ADR-10 como está, mais o túnel `wired`, mais o Acesso Pessoal desligado. O plano B não
foi preciso, então não houve G5 de reassinatura. ⏳ Q-12 segue para a consolidação (T-0.39) sem G1 imediato.

## O que muda na spec (propostas para o G1 da T-0.39; nada foi editado aqui)

1. **Novo item de pré-voo + HC-4: Acesso Pessoal desligado.**
   - Com ele ligado, cada mudança do celular (ligar ou desligar o avião, cena 9) faz o iPhone sumir do USB por 1–5 s,
     o túnel cai para o Wi-Fi ou some, e a sessão morre (§3).
   - Detectável no Mac: uma porta "iPhone USB" (`networksetup -listallhardwareports`) com endereço 172.20.10.0/28 por
     DHCP (`ifconfig`). Procurar pela porta e pela sub-rede, não por um nome `enN` fixo: o número muda a cada
     reenumeração.
   - Proposta: PF-03 (ou um PF novo) falha com a instrução "Ajustes > Acesso Pessoal > Permitir Que Outros Acessem:
     desligado" (passo do dono, P-3). O AC-2.2 ganha essa pré-condição. Também cabe uma linha em A11.
2. **S2 item 5 / PF-03 / AC-2.4: forçar o cabo.**
   - O PF-03 ensina primeiro "tire e religue o cabo com o iPhone destravado" (≤ 2 s medido); o Wi-Fi em Ajustes fica
     como reserva não verificada.
   - A frase "hoje está `localNetwork`" (HC-4) está velha.
3. **S2 itens 4 e 7 / E-2.6 / A11 / research: a assinatura da morte.**
   - Do lado do Mac: `xcodebuild` sai com "An error occurred while communicating with a remote process … The
     connection was invalidated" (`CoreDeviceError 3` / `Mercury 1001`) e "TEST EXECUTE FAILED".
   - "Exiting due to IDE disconnection" não apareceu nem no Console nem no registro.
   - O runner sem sessão seguiu respondendo pelo usbmux por ~20 s (§3). Logo, `health` respondendo não prova sessão
     viva; a detecção certa é a saída do `xcodebuild` (S2 item 7).
4. **S2 item 4 (registro):** a sessão sobrevive à migração `wired` → `localNetwork` quando o cabo sai. Morre quando o
   túnel `localNetwork` cai (avião) e quando o USB some e volta (Acesso Pessoal). Isso não muda a tomada (HC-4 já exige
   `wired`).
5. **O runner consegue ligar e desligar o modo avião pela Central de Controle** (abrir, `ui.tap` no
   `airplane-mode-button`, fechar), e ler o `value` (`ui.find`, `wait.for {airplane}`). Isso serve ao SP-9, à cena 9 e
   ao ponto de controle do avião (`who: runner` com `steps`, plano B do SP-1). Mas com três ressalvas que pesam em S1
   item 3 e S0.3 (→ T-0.8 / SP-9):
   - **Prazo de 10 s da fila do XCTest.** Com a Central aberta e o avião mudando, a leitura da tela do SpringBoard
     percorre as janelas 0…6 (~0,7–5 s por consulta de acessibilidade). Cada varredura levou p50 ~10 s, p90 25–30 s e
     até ~60–64 s, conforme o recorte: 201 varreduras da sessão inteira medidas aqui (p50 10,1 / p90 25,3 / máx 59,7 s)
     e 100 do revisor (p50 11 / p90 30 / máx 64 s). Por isso `ui.find`, `ui.tap` e `device.controlCenter` estouram os
     10 s.
     - `E_TIMEOUT` **"rodando na fila" = a ação VAI acontecer** (ou já aconteceu), com atraso de até ~2 min. O toque
       veio 8–128 s depois do pedido, e em 13 de 15 estouros veio depois do erro.
     - Até lá a fila do XCTest fica presa: o "fechar" e as leituras seguintes esperam.
     - "Ainda na fila" = não aconteceu. Na `auto6` houve 14 Home apertados = 4 "fechar" a tempo + 10 "rodando"; os
       30 estouros "na fila" não apertaram nada.
     - A tomada e o supervisor **não podem tomar o estado como mudado antes de confirmar** (`wait.for {airplane}` ou
       `wait.for {network}`), nem repetir o toque às cegas (um segundo toque desfaria o primeiro quando este
       acontecesse).
   - **`wait.for {airplane}`** é a única leitura do interruptor com prazo maior (`timeoutMs` + 1 s).
     `wait.for {network}` não lê a tela e confirma barato.
   - **A Central pode fechar sozinha** com o tempo (rodada 6 da `auto5`).
6. **AC-2.2 / medida:** declarar a definição do "maior intervalo sem resposta". Pela estrita (b), a série 1 deu
   2.126 ms (> 2 s), mas isso foi com a fila do `device.state` cheia.

## Observações para outras tarefas (não mudam a spec agora)

- **`device.state` é lento e enfileira** (série 1): ~1,6 s ocioso e 4–10 s com a Central aberta. Com prazo curto no
  cliente, as chamadas se acumulam no runner (a fila levou até ~5 min para esvaziar). Enquanto isso o RTT do `health`
  (fila de controle) subiu até ~1 s, com 22 `E_TIMEOUT`. Pesa em S0.3 (`wait.for`, `{network}`) e nos SP-6/SP-9/SP-12.
- Com o runner ligando o avião, a rede foi para `offline` todas as vezes. No estado atual deste iPhone, o Wi-Fi apaga
  junto com o avião.

## Linha do tempo das execuções (UTC) e arquivos brutos (`spikes/sp-2/out/`, fora do git)

| Rótulo | Janela | O quê |
|---|---|---|
| `neg-setup` | 05:01:49–05:02:50 | cabo tirado e religado com o túnel em uso; `neg-setup-devicectl-localNetwork.json` (AC-2.4) |
| `neg` | 05:03:28–05:09:03 | controle negativo (sessão `-020300-db05e0`) |
| `air`, `stab` | 05:13:25–05:22:05 | Acesso Pessoal ligado: queda (sessão `-021331-4f69f4`) |
| `air2`, `stab2` | 05:50:22–06:22:03 | série 1 (dono) + janela de 30 min (sessão `-025029-293383`) |
| `auto` … `auto5` | 06:37:52–07:28:38 | série 2, tentativas interrompidas (sessão Spike `-033710-bb2a73`) |
| `auto6` | 07:34:53–08:15:40 UTC | série 2, a que prova o critério |

Os registros do `xcodebuild` ficam em `~/Library/Caches/contrarregra/logs/xcodebuild-<sessão>.log`. Nenhuma conta
Apple aparece nas saídas (nada a trocar por `<redacted>`).
