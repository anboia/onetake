# SP-1 — aviso "Automation Running" e toques humanos (versão reduzida, M1 da trilha do demo)

**Data:** 2026-10-16 · **Decisão:** **GO** — o aviso não entra na captura do OBS e o toque humano funciona com
o runner vivo. Medição reduzida (a T-0.16 completa, com o QuickTime e a folha do Sign in with Apple, fica adiada
com o resto da Fase 0).

## Montagem
- iPhone 12 "VIVO_00G7", iOS 26.7.1 (23H30), no cabo; runner **Spike** (`runner up --spike`, sessão
  `20261016-150213-90645c`, de pé em 21 s, sem pedir o código).
- OBS 31.1.2 / obs-websocket 5.6.2, perfil e coleção "Contrarregra"; a fonte "iPhone" abriu em 0×0 e ficou viva em
  1170×2532 com **um chute** (`SetInputSettings {device}` com o valor achado pelo `itemName`).
- Driver: `spikes/sp-1/sp1.ts` (`live`, `record`, `call`, `analyze`). Quadros extraídos com o ffmpeg 8.1.1 fixado e
  lidos pelo OCR do Mac (`mac/tools/ocr.swift`) atrás de "Automation Running", "volume buttons" e "Hold both".

## Resultados
| Gravação | Duração | O que aconteceu na tela | Quadros (fps) | Com o aviso |
|---|---|---|---|---|
| `2026-10-16 15-03-08.mp4` | 200 s | Hagah, play pelo runner, tela de início, volta ao Hagah, avião desligado e religado pelo runner na Central de Controle (2 trocas, ~30 s) | 401 (2) | **0** |
| `2026-10-16 16-06-53.mp4` | 120 s | Hagah; o dono pausou e despausou o áudio | 240 (2) | **0** |
| `2026-10-16 16-11-36.mp4` | 75 s | `device.lock` (PX-1, `path: private`) → tela travada com os controles de mídia → `device.wake` → o dono destrava (tela "Enter Passcode" visível ~2 s) → Hagah | 303 (4) | **0** |

- O dono **viu o aviso no aparelho** enquanto o runner estava vivo; 0 de 944 quadros o têm. O OCR lê a tela normalmente
  nos mesmos quadros (texto do Salmo 23, ícones da tela de início, tela travada) — não é cegueira do OCR.
- Toques humanos com o runner vivo: pausa/play no mini-player e o desbloqueio funcionaram (o dono confirmou; o
  `wait.for {locked: false}` e `{appState: foreground}` confirmaram).
- A captura USB mostra a barra de status "limpa" (09:41, data "Tue 9 Jan" na tela travada) — bom para o vídeo.

## Observações para a tomada
- `wait.for {locked: true}` **não confirmou** o travamento logo depois do `device.lock` (E_TIMEOUT "running" em 6 s) e
  não viu os travamentos manuais anteriores em 90–120 s; `{locked: false}` funciona. Na coreografia, confiar no
  `device.lock` e seguir com espera fixa; confirmar só o destravamento.
- Na tela travada aparece "iPhone → System Capture" no controle de mídia (a rota de áudio da captura do Mac): é do
  iOS, não da ferramenta; fica no vídeo.
- Destravar olhando para o iPhone antes de arrastar, para o Face ID passar direto sem mostrar "Enter Passcode".
- O modo avião estava ligado **com o Wi-Fi ligado dentro dele** (sobra de spikes anteriores): antes da tomada o dono
  desliga o Wi-Fi com o avião ligado (D0 item 10), senão a cena 9 fica com rede.
- A tela de início do dono aparece na cena 1 (ícones pessoais na página do Hagah).
