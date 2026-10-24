# Trilha do demo do Hagah — retomar o ensaio (pausa pedida pelo dono, 2026-10-16 ~20:30)

O dono precisou do iPhone no meio do M4. Prompt de origem: `.claude/handoffs/2026-10-14-demo-hagah.md` (o git e
os arquivos vencem esta nota). Responder ao dono em português, curto.

## Estado (git `main`, último commit da trilha: a coreografia do M4)
- Feitos e commitados: G1 da trilha (`spec/tasks.md` "Trilha do demo"), M1 (`spikes/SP-1.md`: GO, 0/944 quadros com o
  aviso), M2 (coreografia), M3 (`take validate|run|control`, revisão independente + 11 correções), `--pause-recording-at`
  (gravação pausa no destravamento da cena 3 — decisão do dono: o Face ID dele não funciona e o teclado do código não
  pode aparecer no vídeo), releitura de condição lenta, narração (`spikes/demo/voice.ts`) e pós (`spikes/demo/mix.ts`).
- Narração pronta: `~/Movies/contrarregra/hagah/voice/voice.json` + 51 WAV (voz `en-US-Chirp3-HD-Charon`, escolhida pelo
  dono; chave no Chaveiro: serviço `contrarregra`, conta `GOOGLE_TTS_API_KEY`).
- Ensaio (`--dry`): preparo inteiro ok; cenas 1–2 ok; 4–5–6 encadeadas ok (2×); 7 até `s07-siwa-tap` ok; 8 e 9 ok;
  10 ok sozinha; a rodada encadeada 8–9–10 foi morta (SIGTERM) em `s10-settings-top` quando o dono pediu o iPhone.
  A cena 3 não foi ensaiada com a pausa nova (precisa do dono).
- Runner DESLIGADO (`runner down`); OBS aberto no perfil "Contrarregra", pasta de gravação devolvida a `~/Movies`.
- iPhone deixado com rede (avião desligado; confirmado por `wait.for {network: online}`), Hagah à frente.

## Antes de retomar (conferir)
1. `bin/contrarregra runner up --spike` com o dono destravando o iPhone (pode pedir o código do "Enable UI Automation").
2. Leitura rápida: p95 de 5 `ui.find` ≤ 1,5 s (com áudio tocando o aparelho fica lento: toques de 8–10 s).
3. Estado que o agente pode ter deixado: marcação/nota da cena 6 no diário (o preparo para em `prep-journal-empty`;
   elas são da ferramenta, podem ser apagadas pelo app), dia do Plano baixado (preparo para em `prep-day-not-saved` —
   "Remove from device"), avião (o preparo confere `airplane: off`).
4. Duas gravações de teste da pausa do OBS (2,5 MB) em `~/Movies/contrarregra/spikes/SP-1/` e as pastas `--dry` em
   `~/Movies/contrarregra/hagah/2026*` (só `take.json`) — G4 antes de apagar.

## Próximos passos
1. Ensaio encadeado das cenas 8–10 (`--scenes s08,s09,s10 --no-prepare`, com o estado de entrada da cena 8).
2. Ensaio completo com o dono: `bin/contrarregra take run choreographies/hagah/v8.5-review.choreo.yaml --dry --voice
   ~/Movies/contrarregra/hagah/voice/voice.json --pause-recording-at s03-unlock --until s07-siwa-tap`, depois
   `--scenes s08,s09,s10 --no-prepare`. O dono só destrava na cena 3 (com o código; a gravação pausa só na tomada).
3. Checklist do dono no iOS antes da tomada: Reduzir Movimento desligado, Não Perturbe ligado, Hagah fora de Sign in
   with Apple, teclado em inglês; não tocar nos botões de volume (derrubam a automação: "Not authorized for performing
   UI testing actions").
4. Tomada (M5): sem `--dry`, com `--voice … --pause-recording-at s03-unlock`; disco ≥ 5 GiB (hoje ~10–11 GiB livres).
   Cena 7 inteira: o dono faz as três folhas da Apple (criar conta, autorizar exclusão, entrar de novo) — a conta Hagah
   da conta Apple dele será criada e apagada (ele confirmou que pode).
5. Pós (M6): `node spikes/demo/mix.ts <pasta-da-tomada> --voice ~/Movies/contrarregra/hagah/voice/voice.json --out
   ~/Movies/contrarregra/hagah/hagah-1.0.0-7-review.mp4` (`--plan` mostra o encaixe); conferir com ffprobe
   (1168×2532, começa na tela de início, 6–9 min, ≤ ~200 MB); o dono assiste e aprova; publicar só com o sim dele a
   cada passo.

## Achados para o dono / para o Hagah
- O verbete de "shepherd" na lente Word mostra "Companheiro" (português) — conteúdo do Hagah.
- O cartão do nome ainda aparece no Salmo 1 (entra na cena 1).
- Duração estimada da tomada: ~9 min com as esperas humanas.
