Você vai fazer o **Contrarregra gravar sozinho** o vídeo de demonstração do Hagah Bible para a App
Review e entregar o MP4 final. Este prompt é um mapa, não o território: onde ele discordar dos
arquivos ou do git, os arquivos vencem. Responda ao dono sempre em português, curto, e explique
opções em linguagem simples antes de pedir uma decisão.

<mission>
O Contrarregra grava, no iPhone real e sem ninguém tocar na tela (fora os pontos que só uma pessoa
pode fazer), as 10 cenas do roteiro do Hagah Bible build **1.0.0 (7)**, e sai daqui um MP4 pronto
para a App Review. Decisões do dono em 2026-10-14: (1) quem grava é o Contrarregra, não a Gravação de
Tela à mão — isso substitui a nota "gravação à mão" do roteiro; (2) o Contrarregra não vai ser
comercializado agora, então só se faz o que **esta tomada** precisa ("trilha do demo"). O resto da
Fase 0 e as Fases 1–9 ficam adiadas. Trabalhe no checkout principal `/Users/noah/project/contrarregra`,
branch `main` (sem remoto; não fazer push).
</mission>

<definition_of_done>
1. G1 da mudança de plano aprovado pelo dono e registrado em `spec/tasks.md` (seção curta "Trilha do
   demo", com os marcos M1–M6 abaixo e a lista do que fica adiado).
2. Go/no-go (M1) registrado: o aviso "Automation Running" não aparece na captura do OBS (ou o dono
   escolheu o plano B), e o toque humano funciona com o runner vivo.
3. `bin/contrarregra take run <coreografia> [--dry]` executa um subconjunto de S0.4 passo a passo
   pelo runner, controla o OBS e para nos pontos de controle humanos; `choreographies/hagah/
   v8.5-review.choreo.yaml` cobre as 10 cenas com os rótulos reais do build 7; um ensaio sem gravar
   passa de ponta a ponta.
4. Uma tomada boa gravada, conferida (`ffprobe`: começa na tela de início, 1168×2532, duração ~6–9
   min) e aprovada pelo dono depois de assistir; narração resolvida como o dono escolher; MP4 final
   ≤ ~200 MB sem mudar a resolução da tela, em `~/Movies/contrarregra/hagah/`.
5. `npm test` e `npx tsc -p tsconfig.json` verdes (e `swift test` do Kit, se mexer nele);
   `grep -ri hagah mac/src ios/ --exclude-dir=Spikes` vazio; um commit por marco; `git status` limpo.
6. Publicar (R2 + App Store Connect + reenviar) só com o sim do dono a cada passo — nesta sessão, se
   houver tempo, ou numa sessão no repositório do Hagah.
</definition_of_done>

<current_state>
Verificado em 2026-10-14 ~11:40 (confirme no ritual):
- `main` em `f88b625`, árvore limpa (só `.claude/` não rastreado). Feitas na Fase 0: T-0.1…T-0.15,
  T-0.17, T-0.18, T-0.19, T-0.22, T-0.34, T-0.37. Drivers prontos sem medição: SP-5 (`spikes/sp-5/`),
  SP-9 (`spikes/sp-9/`); SP-12 parcial. Itens para o G1 da Fase 0: `.claude/handoffs/t039-g1-items.md`
  (não é desta sessão).
- iPhone 12 "VIVO_00G7", iOS 26.7.1 (23H30), UDID `00008101-001E79203A68001E`, no cabo (`wired`).
  Instalado o build **Spike** do runner (G5 aprovado; tem `ui.*`, `device.*`, `app.*`, `wait.for`,
  `screen.shot`, `spike.tap`): suba com `bin/contrarregra runner up --spike`, desça com `runner down`.
  Runner parado agora. Acesso Pessoal desligado; Bloqueio Automático "Nunca".
- Hagah Bible build 7 (TestFlight) no iPhone: no Salmo 23, áudio pausado, Repeat em "Verse". O Salmo
  1 foi aberto pelo link várias vezes pelos testes, sem tocar em nada — confira se o cartão do nome
  ("The name Hagah") ainda aparece.
- `~/.config/contrarregra/config.json`: `app.explore` = Hagah, `runner.privateAllowed` PX-1/2/3/5,
  `urls.allowedPrefixes` `hagah://`, iOS validado. A linha de base da assinatura migra para
  `~/.config/contrarregra/` no próximo `runner build` (evite builds novos: cada instalação é G5).
- OBS 31.1.2 aberto no perfil e coleção "Contrarregra" (1168×2532@60, recorte de 1 px por lado, H.264
  por hardware 16 Mbps, MP4 híbrido), WebSocket ligado. A fonte "iPhone" está **0×0** desde que o OBS
  foi reaberto — precisa do "chute" (reescolher o aparelho pelo `itemName`; código pronto em
  `spikes/sp-5/obs.ts`).
- Medido hoje (detalhes em `spikes/SP-*.md`): a sessão do runner sobrevive ao modo avião no cabo e o
  runner liga/desliga o avião sozinho pela Central de Controle (SP-2); canal rápido (SP-4); o link
  `hagah://bible/ENGNIV/PSA/<n>` abre o capítulo sem pedir confirmação (SP-17); cada toque leva
  ~2–2,5 s por causa das leituras de segurança da tela (SP-3) — aceitável para um demo.
- NÃO medido e decisivo: se o aviso "Automation Running" aparece na captura (SP-1); se o toque humano
  (Face ID/código) funciona com o runner vivo; a defasagem áudio/vídeo do OBS (SP-5).
</current_state>

<roteiro>
Fonte: `/Users/noah/project/bible/hagah/plans/mobile/notes/v8.5-roteiro-video.md` (commit `7c41953`;
leia inteiro). Respostas prontas à Apple: `.../v8.5-rejeicao-2.1.md` (§4 Notes e resposta, §6 "AI",
§7 ordem). Por cena, quem faz:
- Runner: cena 1 (tela de início → abrir o Hagah; tocar no ícone exige `app.iconLabel` na
  coreografia — senão `app.activate`), 2, 4, 5, 6 (a nota "Meditate on this tonight" por `ui.type`),
  8, 9 (Settings › Downloads do **app**; avião pela Central), 10 (desligar o avião, About, rolar devagar).
- Pessoa (ponto de controle com aviso por voz e espera): cena 3 (o runner trava com `device.lock`
  (PX-1) e acende; **o dono desbloqueia**); cena 7 (a folha do Sign in with Apple, a reautorização da
  Apple na exclusão e o novo login são **do dono**; o runner toca só os botões do Hagah, inclusive
  "Delete account" e "Permanently delete account").
- Antes da tomada (dono, em Ajustes do iOS): iPhone em inglês, Reduzir Movimento desligado, Não
  Perturbe ligado, Apple ID de teste pronto, Hagah fora da lista de Sign in with Apple. O runner
  prepara o que é dentro do Hagah (deslogar, capítulo baixado, voltar à tela de início).
- A cena 7 cria e apaga uma conta Hagah: use o Apple ID de teste; nos ensaios, pare antes da folha
  da Apple.
</roteiro>

<plan>
Marcos em ordem (cada um termina com evidência e commit):
- **M0 — abertura (você, ~10 min).** Ritual; um lote de perguntas ao dono (abaixo); o G1 da mudança
  de plano no formato de `~/.claude/skills/spec-implement/references/gates.md`; aplicar em `tasks.md`.
- **M1 — go/no-go (~20 min; dono 2 min).** Chute da fonte do OBS; `runner up --spike`; gravar ~2 min
  (tela de início, Hagah tocando, uma troca de avião pelo runner); extrair quadros a 2 fps com o
  ffmpeg fixado e procurar "Automation Running"/"volume buttons" com o OCR do Mac (`mac/tools/ocr.swift`);
  o dono trava e destrava o iPhone uma vez com o runner vivo e toca algo no Hagah. G4 antes (apagar
  só as gravações de teste em `~/Movies/contrarregra/spikes/SP-1/`). Registre em `spikes/SP-1.md`. Se
  o aviso aparecer na captura: pare e leve ao dono as saídas (o plano B do SP-1, a Gravação de Tela do
  iOS, ou gravar à mão) — G1.
- **M2 — mapa do build 7 (~45 min; sem o dono).** Percorra as 10 cenas no Hagah pelo runner (sem
  gravar; ferramentas MCP `ui_tree`/`screenshot`/`tap` ou `ui.find`), anote o alvo real de cada passo
  (rótulo, identificador, tipo) e escreva a coreografia. Nada irreversível: não entre nem apague conta.
  Relate ao dono a diferença entre o roteiro e a tela.
- **M3 — `take` mínimo (~1–2 h).** Em `mac/src/commands/` + `mac/src/take/` (genérico, sem Hagah),
  usando os esquemas de S0 que já existem (`mac/src/core/schema.ts`) num **subconjunto** de S0.4:
  abrir app/ícone, `tap` (alvos de S0.2), `type` (nunca credencial), `scrollTo`/`drag`, `wait.for`
  (subconjunto de S0.3), `hold <s>`, `openURL`, `device.lock|wake|home`, Central de Controle + avião
  (com a semântica do SP-2: `E_TIMEOUT` "rodando" = a ação ainda vai acontecer, até ~2 min; nunca
  retocar às cegas; confirmar por `wait.for`), `checkpoint who: human` (fala com `say` e espera uma
  condição, com prazo), marcador de capítulo no OBS; gravação: chute, disco (HC-11), Start/Stop do
  OBS. O Mac manda um passo por vez — o executor com prazos absolutos no aparelho (Fase 3) e o
  alinhamento em três elos (Fase 4) ficam adiados; anote como simplificação. Reaproveite copiando o
  que já foi provado em `spikes/sp-2`, `sp-4` (avião), `sp-3/prepare.ts` (Hagah), `sp-5` (OBS),
  `sp-17` (link + `wait.for` da página). Testes com falsos (`mac/test/helpers/`). Uma revisão
  independente do diff de `mac/src` (só correção e segurança).
- **M4 — ensaio (`--dry`, sem gravar; dono nos pontos de controle).** Ponta a ponta; corrigir;
  repetir até passar. Antes de cada ensaio e tomada, confira a velocidade de leitura da tela (o SP-3
  viu o aparelho "pesado", leituras de ~5 s): se o p95 de 5 leituras passar de ~1,5 s, espere ou
  reinicie o Hagah.
- **M5 — tomada (dono ~10 min nos pontos de controle).** Dono faz o checklist do iOS; o runner
  prepara o Hagah; disco ≥ max(4 GiB, 3 × ~1 GB + 2 GiB); G4 para apagar tomadas ruins
  (`~/Movies/contrarregra/hagah/`); 1–3 tomadas.
- **M6 — pós e entrega.** Cortar começo e fim; narração conforme a escolha do dono; recomprimir se
  passar de ~200 MB (`/opt/homebrew/opt/ffmpeg/bin/ffmpeg -c:v libx264 -crf 23 -preset slow -c:a aac
  -b:a 128k -movflags +faststart`, sem mudar a resolução); `ffprobe`; o dono assiste e aprova. Depois,
  com o sim dele a cada passo que publica: "Publicar" do roteiro (R2 com `wrangler` rodado de **fora**
  da raiz do repositório do Hagah, conferir com `curl -sI`) e §7 da rejeição (Notes, build 7, resposta,
  reenviar) — ou entregue o arquivo e o link a uma sessão no repositório do Hagah.
</plan>

<owner_questions>
No M0, num lote só, cada uma explicada em português simples com a sua recomendação:
1. Aprovar a "trilha do demo" (G1): pular o resto da Fase 0 e fazer só o mínimo para esta tomada.
2. Narração. (a) **Recomendada:** voz sintética em inglês (`say`, a voz `guide.voice` = "Samantha"
   da configuração) lendo as falas do roteiro, posta por cena na pós-produção — sai sozinho e igual
   em toda tomada. (b) O dono grava a narração depois, assistindo ao vídeo. (c) Sem narração. A cena
   6 precisa *dizer* que não há conteúdo público (resposta ao pedido de denúncia/bloqueio): sem
   narração, use legenda.
3. Cena 7: qual Apple ID de teste; confirmar que a conta e o diário dela podem ser apagados.
4. Quanto tempo o dono tem hoje com o iPhone e em que horários pode estar nos pontos de controle.
</owner_questions>

<process>
Leve, porque o objetivo é o vídeo: subagentes para M2 e M3 (prompts autocontidos, um iPhone por
vez, um controlador por vez); você integra e decide. Uma revisão independente só para o diff de
`mac/src`/`ios`. Os drivers e a coreografia ganham testes onde for barato. Sem revisor + cético em
cada passo. Não rode os spikes adiados. Faça commit a cada marco, com
`Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Se o contexto encher, faça commit e
escreva a passagem em `.claude/handoffs/`.
</process>

<constraints>
- Nunca: digitar ou ler credenciais, código do iPhone ou senha do Apple ID; pedir senha ao dono; ler
  a `.p8` ou o `config.json` do obs-websocket; usar outro time ou certificado que não `984PNJZ8B9` /
  `Apple Development: Andre Saboia (6NKUX5CX7G)`; o runner operar Ajustes, Telefone, Mensagens, Mail,
  Wallet ou lojas; escutar fora do loopback; afrouxar a lista permitida fail-closed sem o dono (o
  iPhone é pessoal); escrever no perfil "Untitled" do OBS ou chamar `SetCurrentProfile`; usar o
  ffmpeg do PATH (só `/opt/homebrew/opt/ffmpeg/bin/{ffmpeg,ffprobe}` 8.1.1); pôr vídeo ou segredo
  no git; código do Hagah fora de `choreographies/` e `spikes/`; instalar pacote sem G2.
- Ajustes do iOS e a conta Apple são sempre do dono, à mão. Anuncie antes cada ação no iPhone.
- G4 antes de apagar gravações; G5 antes de instalar um build novo no iPhone (evite: o build Spike já
  tem tudo) ou de editar fora do combinado; G1 para mudança de comportamento da spec.
- Subir ao R2, mudar a App Store Connect, colar a resposta e reenviar: sim do dono a cada um.
- Erro ou resultado inesperado: relate com a saída real; nunca diga que passou sem evidência.
</constraints>

<gotchas>
- `devicectl list devices --json-output` em arquivo temporário (o stdout vem com texto extra).
- `runner up` depois de um tempo parado: o iPhone pede o código para "Enable UI Automation" e o
  xcodebuild desiste em 60 s — avise o dono antes, iPhone destravado na mão.
- `device.state` enfileira 1,6–10 s na fila do XCTest: não use durante as cenas; `wait.for` e
  `health.xctestQueueDepth` são mais baratos.
- Com a Central de Controle aberta, leituras e toques passam de 10 s; a Central pode fechar sozinha;
  fechar pode deixar a tela de início em vez do Hagah — volte ao app.
- O Acesso Pessoal pelo cabo derruba a sessão (pare se `ifconfig` mostrar `inet 172.20.10.`).
- Com o Hagah tocando, o `ui.tree` pode estourar 5 s no estado "pesado".
- macOS não tem `timeout`. Cada sessão do runner deixa um `.xcresult` (~0,5 MB) no DerivedData.
- Máquina de 16 GB e disco apertado (~18–21 GiB livres): um xcodebuild por vez, 2–4 subagentes no máximo.
</gotchas>

<startup_ritual>
1. `pwd`; `git -C /Users/noah/project/contrarregra status`; `git log --oneline -8`; compare com
   <current_state> e relate divergências.
2. Leia o roteiro inteiro, a `v8.5-rejeicao-2.1.md` §1, §4, §6, §7, e em `spec/`: `constitution.md`
   (uma vez), S0.2–S0.4 e S1 itens 5, 7, 9, 11 de `spec.md`, A9 e A13 de `architecture.md`.
3. Confira sem mudar nada: `df -h ~`, o transporte do iPhone (`wired`), `bin/contrarregra runner
   status`, o OBS (perfil, fonte "iPhone"), processos órfãos.
4. Faça as perguntas de <owner_questions> num lote só; então siga <plan>.
</startup_ritual>
