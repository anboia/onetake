# Contrarregra — pausa da Fase 0 (2026-10-14)

> **Atualização (mesmo dia):** o dono decidiu que o Contrarregra grava o demo do Hagah sozinho, numa
> "trilha do demo" mínima — ver `.claude/handoffs/2026-10-14-demo-hagah.md`. Esta nota vale para o
> resto da Fase 0, que continua adiado.

O dono pausou o Contrarregra em 2026-10-14: o vídeo do Hagah é gravado à mão (roteiro do Hagah,
commit `7c41953`) e não há plano de comercializar a ferramenta agora. Para retomar, use o prompt
completo `.claude/handoffs/2026-10-14-fase0-spikes.md` como base e corrija o estado com o abaixo
(o git vence este arquivo).

## Estado em `f88b625` (main, árvore limpa)
- Fechadas com revisão independente: T-0.17 (SP-2, `86bdbca`), T-0.18 (SP-3, `53681bf`), T-0.19
  (SP-4, `d3cb541`), T-0.34 (SP-14, `e571d26`), T-0.37 (SP-17, `f915363`); linha de base da
  assinatura em `~/.config/contrarregra/` (`a724323`, `eba1680`); drift em architecture.md A13
  (`7d6faa3`). `~/.config/contrarregra/config.json` criado (app.explore Hagah, PX-1/2/3/5, hagah://,
  iOS 26.7.1 23H30).
- Prontos, sem medição (drivers em `f88b625`, testes verdes, sem revisão): SP-5 parte 1 (T-0.20) e
  SP-9 (T-0.27), cada um aguardando o **G4** do dono; SP-12 parte 1 (T-0.30) interrompido em 2 h 55 min
  (parcial no SP-12.md; refazer as 4 h).
- Portões com o dono: G5 do `spike.logWrite` do SP-17 (recomendado DENY); G4 do SP-5 (+ escolha do
  alto-falante mic/human/skip e a fase do cabo); G4 do SP-9.
- Abertas: T-0.16, T-0.20, T-0.21, T-0.23…T-0.33, T-0.35, T-0.36, T-0.38, T-0.39.
- No iPhone: build **Spike** instalado (G5 aprovado); runner parado. Para voltar ao Debug: `runner
  build` (Debug) + `runner up` (G5).
- Itens acumulados para o G1 da T-0.39 (AC-1.5 do SP-3, pré-voo do Acesso Pessoal, E_TIMEOUT
  "rodando", eco de 64 KB, screen.shot ≈ 1,5 s → PX-6, bug do `mac/src/align/region.ts` com o
  recorte de 1 px, etc.): `.claude/handoffs/t039-g1-items.md`.

## Lições de processo (por que demorou)
- Cada spike levou 1–3 h: preparo → medição no iPhone (um por vez) → revisor → cético → correções
  → às vezes nova medição. Hoje: 5 spikes em ~9 h; faltavam 13 + consolidação, e o vídeo só
  sairia na Fase 5 (D+~25).
- Imprevistos que custaram repetição: rodadas manuais de avião puladas, Acesso Pessoal pelo cabo,
  estado "pesado" do aparelho no SP-3.
- Ao retomar: escopo mínimo primeiro (o que a próxima tomada precisa), spikes autônomos, revisão
  mais leve nos de risco baixo.
