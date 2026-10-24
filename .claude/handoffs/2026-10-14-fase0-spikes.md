Você está continuando um trabalho passado de uma sessão anterior cujo contexto encheu.
Este prompt é um mapa, não o território: onde ele discordar do sistema de arquivos ou do
git, o sistema de arquivos vence. Siga <startup_ritual> antes de qualquer coisa e depois
opere conforme <orchestration_playbook>. Responda ao dono sempre em português, curto, e
explique opções em linguagem simples antes de pedir uma decisão.

IMPORTANTE — onde trabalhar: o trabalho é no checkout principal `/Users/noah/project/contrarregra`,
branch `main` (sem remoto; não fazer push). Se esta sessão abriu numa worktree própria, NÃO trabalhe
nela: use caminhos absolutos do checkout principal (o estado do aparelho, os caches em
`~/Library/Caches/contrarregra` e a linha de base da assinatura dependem dele).

<mission>
Concluir a **Fase 0 (Fundação e spikes)** do Contrarregra até o critério do portão da Fase 0 (cabeçalho
"Fase 0" de `spec/tasks.md`): todos os spikes SP-1…SP-18 (T-0.16…T-0.38) com `spikes/SP-n.md` preenchido
(medida, critério, decisão principal × plano B); nenhum bloqueador sem caminho; `spec/architecture.md`
A10/A11 atualizados; ⏳ Q-5 (d, f), Q-8, Q-9, Q-12 e Q-13 decididas pelo dono no G1 da T-0.39; toda mudança
de comportamento levada a G1. **Não começar a Fase 1.** A fundação de código (T-0.1…T-0.15, T-0.22) já está
pronta e provada no iPhone real; o que falta são as medições no aparelho/OBS e a consolidação.
A spec é a única fonte da verdade: `spec/spec.md` FROZEN, `spec/constitution.md` RATIFIED (mudar = G1).
</mission>

<definition_of_done>
- T-0.16…T-0.39 marcadas `[x]` em `spec/tasks.md`, cada spike com `spikes/SP-n.md` (medida, números,
  critério atingido ou não, decisão principal/plano B, o que muda na spec → G1) e, em `tasks.md`, uma linha
  *Resultado* sob a tarefa (como já feito na T-0.11 e T-0.13).
- `spec/architecture.md` A10/A11 atualizados com o caminho escolhido por spike; o drift acumulado
  (lista em <decisions>/<gotchas>) registrado em A2/A5 ou levado a G1.
- G1 da T-0.39 respondido pelo dono: Q-5 (d, f), Q-8, Q-9, Q-12, Q-13 (esta já com evidência de que é
  dispensável) e cada mudança de comportamento; aplicado só o aprovado.
- A verificação de <verification> passa; `git status` limpo depois de cada commit; um commit por tarefa.
</definition_of_done>

<current_state>
Verificado em 2026-10-14 contra o git:
- Checkout `/Users/noah/project/contrarregra`, branch `main`, HEAD `7e01bdb` (T-0.13). Árvore limpa
  (só `.claude/` não rastreado, de propósito). Sem worktrees extras.
- Feitas (16): T-0.1, T-0.2, T-0.3, T-0.4, T-0.5, T-0.6, T-0.7, T-0.8, T-0.9, T-0.10, T-0.11, T-0.12, T-0.13,
  T-0.14, T-0.15, T-0.22. Abertas (23): T-0.16…T-0.21, T-0.23…T-0.39.
- iPhone 12 "VIVO_00G7" (iPhone13,2), UDID `00008101-001E79203A68001E`, **iOS 26.7.1 (23H30)** (o dono
  atualizou do 26.3; vale como `toolchain.validated`; nenhum spike tinha rodado). Fica no cabo quando o dono
  está presente (`devicectl` transportType=wired). Runner e hospedeiro **instalados** (build final limpo,
  diagnóstico desligado), runner parado.
- OBS 31.1.2 com perfil/coleção "Contrarregra" configurados pela T-0.13 (vídeo 1168×2532@60, iPhone sem
  escala com recorte 1 px por lado, MP4 híbrido, Apple VT H.264 ABR 16000, keyint 1 s, high). Perfil do dono
  "Untitled" intacto (sha256 do `basic.ini` = `17b8c52904d78683f17bb1c3c82f4ad18e46c5fa8c15565fc30efa5a1785e79b`).
  Item `OBS_WEBSOCKET_PASSWORD` existe no Chaveiro (serviço `contrarregra`). Pedi ao dono para **trocar a
  senha** (ele a colou no chat da sessão anterior) e **desligar o WebSocket** fora de uso — confirme com ele.
- Não existe `~/.config/contrarregra/config.json` ainda (vale `config/defaults.json`, que já tem `device.*`,
  `obs.*`, `runner.port` 8700). D3.1 pede ao dono pôr `app.explore`, `runner.privateAllowed`
  (PX-1, PX-2, PX-3, PX-5), `urls.allowedPrefixes ["hagah://"]` e o iOS em `toolchain.validated` — necessário
  antes dos spikes que usam o Hagah ou API privada (SP-3, SP-7, SP-10, SP-17…).
- Disco: ~22 GiB livres (oscila muito: swap de até 8 GB e temporários de outras sessões do dono). Os spikes
  que gravam exigem livre ≥ max(4 GiB, 3 × estimativa + 2 GiB) (HC-11); o SP-5 parte 2 grava ~19 GB no total.
- Claude Code do dono: 2.1.280 (D0 pede ≥ 2.1.283; importa para o SP-13).
- Correções de memória x realidade: o handoff anterior (`.claude/handoffs/2026-10-12-fase0.md`) listava
  T-0.11/T-0.13 como pendentes — ambas estão feitas (`d713bfc`, `7e01bdb`).
</current_state>

<completed_work>
Cada tarefa passou por revisão independente (3 lentes + céticos que tentam refutar cada achado) e teve os
achados corrigidos antes do commit. Evidência por commit:
- T-0.1 `764bdae` (+ `1f8f9d0` teste do shim estável) · T-0.2 `3d76472` (G2 aprovado 2026-10-09) ·
  T-0.3 `8486ba5` · T-0.4 `ddddadc` (G5 primeira assinatura) · T-0.5 `79b5843` · T-0.6 `baf6bca`
  (5 rodadas de revisão de segurança da lista permitida) · T-0.7 `2b26485` · T-0.8 `29b6806` · T-0.9 `2ed7c01` ·
  T-0.10 `2ba3398` (+ `681b444`) · T-0.11 `d713bfc` (resultado registrado em tasks.md) · T-0.12 `662d4ea` ·
  T-0.13 `7e01bdb` (resultado registrado em tasks.md) · T-0.14 `85d2bd0`, `eac8f44`, `7abb671` ·
  T-0.15 `0b2b695` (+ `8bdfc4f`) · T-0.22 `bd713e0`.
- G1 aplicados (todos aprovados pelo dono): `95237f7` (nomes das respostas de screen.shot/ui.find/ui.ocr),
  `3070d7c` (obs setup escreve recordEncoder.json), `5161b4e` (runner build reassina o XCTRunner com
  UILaunchScreen — S2 item 1 e P-3), `2dbd2a8` (vídeo 1168×2532 com recorte 1 px; device do OBS ≠ UDID).
- Resultados no iPhone (T-0.11): loopback alcançável pelo usbmuxd (Connect 22,5 ms) → **⏳ Q-13 dispensável**;
  AC-1.1 (390×844 @3), AC-1.2, AC-1.12 (30/30, health p95 ≤ 1,84 ms, nas duas páginas da tela de início),
  AC-1.13, AC-2.3 (parte), AC-2.5, AC-2.7 (6,7–23,6 s), AC-2.9 OK. SerialNumber cru do usbmuxd com hífen.
- Resultado no OBS (T-0.13): AC-9.8 OK; `device` do iPhone no OBS = `EE35C40D-6B59-489B-8BA2-BF347E8D712C`.
</completed_work>

<pending_tasks>
As especificações completas (Files, AC, Done, Deps, plano B) estão em `spec/tasks.md`, Fase 0, e nas
"Regras comuns" dos spikes logo acima da T-0.16 — leia-as por tarefa; não as reescreva aqui. Ordem pelos
`Deps` (um spike no aparelho por vez: um runner, um controlador). Quase todos precisam do dono presente.

### P0. Pendências do orquestrador antes dos spikes (size: S)
- Objective: (a) registrar em `spec/architecture.md` (A2/A5 e contratos) o drift acumulado listado em
  <decisions>/<gotchas> que não muda comportamento; (b) combinar com o dono o `~/.config/contrarregra/config.json`
  de D3.1 (é ação/aprovação do dono: arquivo de configuração da máquina, sem segredos); (c) decidir com o dono se
  a linha de base da assinatura sai de `~/Library/Caches/contrarregra/` (o macOS apagou esse cache inteiro uma vez
  com disco baixo) para `~/.config/contrarregra/`; (d) lembrar o dono: trocar a senha do OBS, desligar o
  WebSocket fora de uso, esvaziar a Lixeira (2 .xcresult com identificador de ícone), Claude Code ≥ 2.1.283,
  instalar o build 5 do TestFlight do Hagah (D0.12; hoje há o build 4 de desenvolvedor), exportar o diário (D0.13)
  e conferir o Sign in with Apple (D0.14) antes do SP-8/SP-10.
- Key files: `spec/architecture.md`, `spec/deploy.md` (D0, D3.1), `config/defaults.json`.
- Acceptance criteria: commit "docs: …" com o drift registrado; config.json combinado e conferido (sem segredos).
- Depends on: —.

### P1. T-0.17 — SP-2 (bloqueador): sessão do XCTest × modo avião; forçar o cabo (size: L)
- Dono liga/desliga o modo avião 10× (60 s cada) e, se preciso, o Wi-Fi do iPhone por 10 s; `devicectl` 1 Hz;
  `health` 10 Hz; controle negativo em `localNetwork`. Plano B (re-assinar o `.xctrunner` sem `Frameworks/XC*`
  e lançar por `devicectl`) exige G5; se falhar também → **G1 imediato de ⏳ Q-12** e nenhum outro spike no
  aparelho antes da resposta. Depends on: T-0.11 (feita).

### P2. Spikes seguintes, na ordem dos Deps (cada um: size M–L)
T-0.19 SP-4 (deps T-0.17; loopback já provado, falta medir latência/reconexão/avião) · T-0.18 SP-3 (PX-2/PX-3;
precisa config.json com privateAllowed e o Hagah tocando o Salmo 23; decide o caminho do toque → resolve o
G1 pendente do carimbo tDispatchNs) · T-0.20 e T-0.21 SP-5 (OBS; um G4 por spike que grava; disco) ·
T-0.34 SP-14 · T-0.23 e T-0.24 SP-6 · T-0.16 SP-1 · T-0.25 SP-7 · T-0.26 SP-8 (pré-cond. D0.13/D0.14) ·
T-0.27 SP-9 · T-0.28 SP-10 (build 5 do TestFlight) · T-0.29 SP-11 · T-0.30/T-0.31/T-0.32 SP-12 (4 h no cabo) ·
T-0.33 SP-13 · T-0.35 SP-15 (dono lê em voz alta; independente) · T-0.36 SP-16 (simulador; build de
simulador do Hagah, D3.5) · T-0.37 SP-17 · T-0.38 SP-18 (independente). Paralelizar só os `[P]` sem
dependência mútua e sem disputar o aparelho.

### P3. T-0.39 — consolidação (size: M)
Atualizar A10/A11 e estimativas; G1 com Q-5 (d, f), Q-8, Q-9, Q-12, Q-13 e cada mudança de comportamento;
aplicar só o aprovado; rodar <verification>; commit. Então dizer ao dono que a Fase 0 terminou e PARAR.
</pending_tasks>

<decisions>
- **Modo de trabalho (dono):** orquestrador que não escreve código; uma tarefa por subagente
  (`general-purpose`) que carrega a skill `spec-implement` em modo Build; o subagente devolve
  `STATUS: DONE | GATE_PENDING | OWNER_ACTION`; o orquestrador mostra o bloco do portão sem alterar, explica em
  português simples, espera APPROVE/DENY e retoma o MESMO subagente (SendMessage). Revisão independente antes de
  cada commit; correções pelo mesmo subagente; um commit por tarefa com `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Lista permitida fail-closed (T-0.6, 5 rodadas de segurança):** o que não se prova à frente é desconhecido e
  é recusado; modelo de `front` com bloqueio em três estados, camadas do SpringBoard, tela de início limpa
  provada só por geometria (`HomeScreenProbe`, sem identificador na consulta do XCTest — o XCTest escreve a
  descrição da consulta no registro), Central de Controle, folha authkit só com rótulos exatos conhecidos.
  Não afrouxar sem G1/aprovação do dono — o iPhone é pessoal.
- **Reassinatura (G1 5161b4e):** o XCTRunner do Xcode 26.6 não tem `UILaunchScreen` (modo de compatibilidade,
  320×480); o `runner build` acrescenta a chave e reassina só esse .app com a mesma identidade, contra uma linha
  de base persistida (`signing-baseline.json`); o `runner up` só instala build com `verified-build-<cfg>.json`.
- **Vídeo 1168×2532 com recorte 1 px por lado (G1 2dbd2a8):** o OBS 31.1.2 exige largura múltipla de 4;
  recortar evita reamostragem (pixels idênticos).
- **R = pts − start_time do formato** em todo o `media` (T-0.22); `-copyts -start_at_zero` sempre.
- **Q-13 dispensável** (loopback alcançável) — registrar no G1 da T-0.39.
- **Simulador:** o dono perguntou se dá para testar tudo no iPhone; o plano já testa tudo no iPhone e o
  simulador só aparece no SP-16 e na Fase 7 (ensaio). Recomendação dada: decidir no G1 da T-0.39 se tira o
  simulador (G1 em US-14/S11/ACs).
- **G1 pendente para a T-0.39 (ligado ao SP-3):** S1 item 5/AC-1.18 mandam a espera de ociosidade do toque
  público ficar em `tDispatchNs − tDevStartNs`, mas no caminho público ela ocorre dentro da chamada do XCTest
  (hoje cai em `tDevEndNs − tDispatchNs`).
- **Lacunas de spec (spec-silent pequenos) a levar ao G1 da T-0.39:** nome do campo de `controlCenter`
  (usado `action`); `captureLatency.method` sem nome para o caso ajustado (núcleo usa `basis: 'fit'`); padrões
  de `pressMs/holdMs/velocity|durationMs` do passo drag (S0.4); `state: value` sem `equals`; `changed` com alvo
  ausente antes; sem `app.iconLabel` fora de coreografia nenhum ícone do SpringBoard é lido/tocado.
- **Drift a registrar em architecture.md (sem mudar comportamento):** entrada da CLI `mac/src/cli/main.ts`;
  `errors.ts` com a tabela de S0.5; `defaults.json` com `toolchain.validated` por item; nomes das respostas de
  device.*/app.*/wait.for/app.state (T-0.8); geometria do relógio de calibração (grade 8×6 de 44 pt centrada,
  origem (19,290) pt no iPhone 12; D previsto para `targetTimestamp`); estrutura do Kit; `CONTRARREGRA_PRIVATE`
  e `ALLOWED` com vírgula/espaço; linhas `CONTRARREGRA_READY` no log; supervisor futuro precisa do `takeId` na
  linha de comando e regravar `status.json` a cada 1 s (runner sever); regras provisórias da T-0.6 (faixa de
  notificação bloqueia tudo; alerta do SpringBoard vira ponto de controle; nomes de app pessoal só en/pt-BR;
  `value` do SpringBoard só do modo avião; `apple.co` entre lojas; prefixo `https://` sem host não vale no
  aparelho; userinfo recusado também no simulador; ui.tree/ui.find não leem app em 2º plano; faixas de gesto
  47/34 pt; ícone de app ≤ 100×120 pt); drift da T-0.13 (áudio do Mac desligado como fonte muda; Sync Flash
  acima do iPhone em 0,0; prazo de 30 s para o OBS reaberto; marcador de reinício em texto puro em
  `paths.cache`; ChannelSetup do dono lido do `basic.ini` em disco; nunca `SetCurrentProfile`).
</decisions>

<key_files>
- `spec/tasks.md` (Fase 0 e "Regras comuns" dos spikes) — a especificação de cada tarefa; marque `[x]` e
  acrescente a linha *Resultado* (exemplos: T-0.11 e T-0.13).
- `spec/constitution.md` (ler uma vez: P-1…P-7), `spec/spec.md` (só as seções que cada tarefa cita),
  `spec/architecture.md` (A10 PX-1…PX-6; A11), `spec/deploy.md` (D0, D3.1, D5), `spec/research/*.md`.
- `~/.claude/skills/spec-implement/references/gates.md` — formato dos portões G1–G5 e do SPEC-SILENT.
- Mac: `mac/src/{core,usbmux,runner,obs,clock,align,media,mcp,commands,cli}/`, testes em `mac/test/`
  (falsos reutilizáveis: `mac/test/helpers/{ws-server,usbmuxd}.ts`). CLI: `bin/contrarregra runner build|up|down|status|sever`,
  `bin/contrarregra obs setup`. MCP: `.mcp.json` → `bin/contrarregra-mcp`.
- iPhone: `ios/project.yml` (XcodeGen; configuração `Spike` compila `ios/ContrarregraRunner/Spikes/` com a
  condição `SPIKE`), `ios/ContrarregraKit/` (lógica testável com `swift test`), `ios/ContrarregraRunner/`
  (`Server/RunnerMethods.swift` registra os métodos; `PrivateXCT/` é o único lugar de API privada;
  `RunnerTests.swift` só muda com G5).
- Código de spike: `ios/ContrarregraRunner/Spikes/`, métodos `spike.*`, `PrivateXCT/`; driver do Mac em
  `spikes/sp-n/`; relatório em `spikes/SP-n.md`; saídas em `~/Movies/contrarregra/spikes/SP-n/` (nunca no git).
- Histórico: `.claude/handoffs/2026-10-08-fase0.md` (prompt original) e `2026-10-12-fase0.md` (passagem
  anterior) — não rastreados; podem não existir numa worktree nova.
</key_files>

<gotchas>
- **Máquina:** MacBook Air M4 16 GB. Muitos agentes em paralelo levaram a carga a ~107 e o swap a 8 GB (que
  ocupa disco); o disco chegou a zero uma vez. Limite o paralelismo (2–4 subagentes), um xcodebuild por vez, e
  limpe rascunhos dos subagentes (pastas paradas há > 15 min no scratchpad, sem processo usando). Temporários de
  outras sessões do dono (`/private/tmp/claude-501/-Users-noah-project-bible-hagah`, ~3–4 GB) não são nossos.
- O macOS apagou `~/Library/Caches/contrarregra` inteiro com disco baixo (registros e a linha de base podem sumir).
- Revisores às vezes editaram arquivos do repositório "temporariamente" e deixaram processos de teste órfãos:
  instrua sempre "não edite o repositório, nem temporariamente; copie para um diretório temporário; apague a cópia
  e mate seus processos antes de responder"; procure órfãos com `ps` antes de começar.
- `runner up` depois de um tempo parado: o iPhone pede o **código** para "Enable UI Automation"; se ninguém
  responder em 60 s, o xcodebuild sai (`Timed out while enabling automation mode`). Avise o dono antes e peça
  o iPhone destravado, na tela de início, na mão.
- O build `Spike` e o Debug geram `.xctestrun` com o mesmo nome; agora o `runner up` recusa build não conferido
  (`unverified-build`) — rode `runner build` da configuração certa antes.
- OBS: o WebSocket só liga ao clicar **Apply/OK** com "Enable WebSocket server" marcado; conferir pelo registro
  do OBS (`[WebSocketServer::Start] Server started`) e `nc -z 127.0.0.1 4455`. Nunca ler o `config.json` do
  obs-websocket. A fonte do iPhone apareceu 0×0 depois da reabertura (S9 item 3, "chute" — SP-5).
- `health.foregroundApp` pode vir `""` enquanto `device.state` diz `com.apple.springboard` (cache só atualizado
  pela fila do XCTest).
- Cada sessão do runner deixa um `.xcresult` (~0,5 MB) no DerivedData padrão do Xcode.
- macOS não tem `timeout`; use alternativas.
- A suíte de OCR (T-0.14) compila Swift a cada chamada: com CPU disputada fica lenta (prazo-base 300 s).
</gotchas>

<verification>
Na raiz do checkout principal:
- BASELINE (deve imprimir listas vazias nas 4 primeiras linhas):
  ```bash
  python3 - <<'EOF'
  import re,glob,collections
  t={f.split('/')[-1]:open(f).read() for f in glob.glob('spec/*.md')}
  d=collections.Counter(re.findall(r'\*\*(AC-\d+\.\d+)\*\*',t['spec.md']))
  print('dup AC',[k for k,v in d.items() if v>1])
  refs={f'AC-{a}.{b}' for s in t.values() for a,b in re.findall(r'AC-(\d+)\.(\d+)',s)}
  print('undefined AC',sorted(refs-set(d)))
  cov=set();tk=t['tasks.md']
  for a,b,e in re.findall(r'AC-(\d+)\.(\d+)(?:…AC-\d+\.(\d+))?',tk):
      cov|={f'AC-{a}.{x}' for x in range(int(b),int(e or b)+1)}
  print('ACs not covered',sorted(set(d)-cov))
  T=set(re.findall(r'\*\*(T-\d+\.\d+)\*\*',tk)); print('T undefined',sorted({x for s in t.values() for x in re.findall(r'T-\d+\.\d+',s)}-T))
  print('Fase 0 abertas',[x for x in re.findall(r'- \[ \] \*\*(T-0\.\d+)\*\*',tk)])
  EOF
  ```
  Em 2026-10-14: as 4 listas vazias; 23 abertas (T-0.16…T-0.21, T-0.23…T-0.39).
- `npm test` → 374/374 (2026-10-14). `npx tsc -p tsconfig.json` → ok.
- `(cd ios/ContrarregraKit && swift test)` → 250/250.
- `grep -ri hagah mac/src ios/ --exclude-dir=Spikes` → vazio (AC-3.7, US-17).
- Build do runner: `bin/contrarregra runner build` (assina, reassina e confere contra a linha de base).
</verification>

<constraints>
- Nunca: digitar ou ler credenciais; pedir senha ao dono; ler/copiar/imprimir a `.p8` ou o `config.json` do
  obs-websocket; usar outro time ou certificado que não `984PNJZ8B9` / `Apple Development: Andre Saboia
  (6NKUX5CX7G)`; o runner operar Ajustes, Telefone, Mensagens, Mail, Wallet ou lojas; escutar fora do loopback;
  escrever no perfil "Untitled" do OBS; usar o ffmpeg do PATH (só `/opt/homebrew/opt/ffmpeg/bin/{ffmpeg,ffprobe}`
  8.1.1); pôr vídeo, captura, segredo ou perfil de provisionamento no git; instalar qualquer pacote sem G2.
- Passos em Settings do iPhone e na conta Apple são sempre do dono, à mão. Toda ação no iPhone é anunciada antes.
- G5 antes de: cada build novo instalado no iPhone (inclusive `Spike`), re-assinar no plano B do SP-2, escrever
  na configuração do OBS do dono, desinstalar; editar arquivo fora dos `Files:` da tarefa.
- Spikes: um G4 por spike que grava (autoriza apagar o que o próprio spike criar em
  `~/Movies/contrarregra/spikes/SP-n/`), cada gravação apagada logo depois de medida e o nome registrado no
  `SP-n.md`; conferir o disco antes de gravar; OBS no perfil "Contrarregra"; nome e e-mail da conta Apple como
  `<redacted>` nos relatórios; API privada só com o sim do dono para aquele uso (✅ PX-1, PX-2, PX-3, PX-5;
  ⏳ PX-4, PX-6).
- Decisões no caminho: plano B do SP-2 falhando → G1 imediato de Q-12; Q-5 (d, f), Q-8 e Q-9 ficam para o G1
  da T-0.39; qualquer resultado que mude comportamento → G1 (nunca edição silenciosa de spec.md, requirements.md,
  constitution.md); `tasks.md` e `architecture.md` podem ser atualizados conforme as tarefas terminam (P-6).
- Erro ou resultado inesperado: relatar com a saída real; nunca dizer que passou sem evidência.
- Sem remoto: não fazer push. Não começar a Fase 1.
</constraints>

<startup_ritual>
Antes de planejar qualquer coisa:
1. Rode `pwd`, `git -C /Users/noah/project/contrarregra status`, `git -C /Users/noah/project/contrarregra log --oneline -10`.
   Compare com <current_state>; anote e relate qualquer divergência — a passagem pode estar velha.
2. Leia os arquivos-chave citados acima (passe os olhos, sem ler a fundo ainda): `spec/constitution.md` uma vez,
   a Fase 0 e as "Regras comuns" de `spec/tasks.md`, `spec/deploy.md` D0/D3.1.
3. Rode a verificação BASELINE de <verification> para confirmar o terreno. Se ela falhar de um jeito que a
   passagem não prevê, diagnosticar isso vem primeiro.
4. Confira, sem mudar nada: `df -h ~`, `xcrun devicectl list devices` (transportType), se há processos órfãos de
   testes, e pergunte ao dono, num lote só, o que ele já fez de P0(d) e quanto tempo tem com o iPhone hoje.
5. Só então escreva o plano: ordem das tarefas, o que delegar e o que fazer você mesmo, quantos subagentes.
</startup_ritual>

<orchestration_playbook>
Você é o ORQUESTRADOR. Sua janela de contexto é o recurso mais escasso — proteja-a. Subagentes fazem a leitura
pesada, a busca e a execução em volume; você planeja, delega, integra e verifica.

Contrato de delegação — todo prompt de subagente é autocontido (subagentes não veem esta conversa) e traz quatro
partes: objetivo, formato de saída, orientação de ferramentas/fontes e limites da tarefa (o que NÃO tocar).
Inclua no próprio texto os caminhos de arquivo e as convenções relevantes. Para as tarefas desta fase, o modelo é:
"Execute a tarefa T-0.x de `spec/tasks.md` no repositório `/Users/noah/project/contrarregra` usando a skill
`spec-implement` em modo Build. Mexa só nos `Files:` da tarefa. Não peça nada ao usuário: portão (G1, G2, G4, G5)
ou spec-silent → PARE antes da ação e devolva o bloco completo no formato de
`~/.claude/skills/spec-implement/references/gates.md` com `STATUS: GATE_PENDING`; ação física do dono →
`STATUS: OWNER_ACTION` com o passo exato; ao terminar → `STATUS: DONE`, arquivos mudados, saída resumida dos
testes/medidas e evidência do Done. Não faça commit."

Escala de esforço — ajuste o número de agentes ao tamanho da tarefa, nunca o contrário:
- consulta trivial: faça você mesmo (um grep vale mais que um subagente);
- tarefa S: um subagente, ou você mesmo se ela depende de contexto que você já tem;
- tarefa M: 1–3 subagentes com responsabilidades divididas e sem sobreposição;
- tarefa L: decomponha primeiro e delegue as partes; 3–5 subagentes em paralelo já é muito — justifique antes de passar disso.

Paralelo × sequencial — dispare em paralelo, numa única mensagem, o trabalho independente e só de leitura
(exploração, pesquisa, revisão). Serialize o que compartilha arquivos ou alimenta o passo seguinte. Nunca deixe
dois subagentes editarem os mesmos arquivos ao mesmo tempo; se a edição paralela for inevitável, isole em
worktrees. Spikes no iPhone: sempre um por vez.

Regra de amortecimento — delegue o trabalho paralelo, isolado ou pesado de ler; faça você mesmo o trabalho
simples, sequencial, de um arquivo só, ou que depende de contexto que você já tem. Partir passos sequenciais
dependentes de contexto entre agentes perde informação a cada passagem.

Retornos — peça aos subagentes resumos, não despejos ("relate só os testes que falham, com a mensagem de erro",
"devolva a lista de arquivos mudados, uma linha cada"). A exploração verbosa deles não pode reencher sua janela.

Verificação — uma tarefa só está pronta com evidência: saída de teste, código de saída, uma checagem
antes/depois, não "parece certo". Para mudanças substanciais, lance um revisor novo que vê só o diff mais os
critérios de aceite, instruído a relatar só lacunas que afetam a correção (implicância de estilo convida
excesso de engenharia). Nesta fase, cada achado do revisor passa por um cético que tenta refutá-lo antes de
virar correção; o revisor nunca edita o repositório.

Estado — depois de cada tarefa concluída, faça commit com mensagem clara e marque-a. Se o seu contexto chegar
perto do fim com tarefas restantes, pare de começar trabalho novo, faça commit do que estiver pronto e escreva a
próxima passagem (um arquivo em `.claude/handoffs/`, ou a skill de handoff desta sessão, se houver) em vez de
deixar trabalho pela metade.

Escalonamento — pare e pergunte ao dono quando: um requisito for ambíguo de um jeito que muda o desenho, a
evidência contradisser uma decisão registrada, ou uma ação for destrutiva ou voltada para fora (push, deploy,
apagar, publicar). Explique as opções em português simples antes de pedir a decisão.
</orchestration_playbook>

Comece agora pelo ritual de início.
