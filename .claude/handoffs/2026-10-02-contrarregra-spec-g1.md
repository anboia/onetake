You are continuing work handed off from a previous session whose context filled up.
This prompt is a map, not the territory: where it disagrees with the filesystem or
git, the filesystem wins. Follow <startup_ritual> before doing anything else, then
operate per <orchestration_playbook>.

<mission>
Fechar a especificação (DRAFT) do **Contrarregra** — ferramenta tipo WebDriverAgent para o Claude
Code operar um iPhone físico e gravar sozinho um vídeo de demonstração de app (primeiro uso: o vídeo
que a App Review pediu ao Hagah Bible, guideline 2.1). A spec já existe e foi commitada; faltam
corrigir os últimos achados do *analyze gate*, verificar de novo e levá-la ao dono para a ratificação
(G1). **Não implementar nada**: a implementação é outra sessão, com a skill `spec-implement`.
O pedido original está em `/Users/noah/project/bible/hagah/plans/mobile/notes/v8.5-prompt-contrarregra.md`
(fora deste repositório; leitura só se precisar).
</mission>

<definition_of_done>
- Todos os itens de T1 resolvidos (ou recusados com razão registrada na resposta ao dono).
- A verificação mecânica de <verification> passa (0 AC duplicada/indefinida, toda AC coberta por
  tarefa ou portão de fase, 0 Q/T/SP/PF indefinido, 0 ciclo de Deps).
- Uma rodada final de revisão adversarial (T2) sem blocker nem major em aberto.
- Commit só de `spec/` com mensagem clara.
- T3 feito só se o dono estiver na conversa: perguntas de ratificação em lote, respostas aplicadas no
  DRAFT; `spec.md` vira FROZEN e a constituição RATIFIED **só com um "sim" explícito do dono**.
- Resposta final ao dono em português, curta.
</definition_of_done>

<current_state>
- Repositório `~/project/contrarregra`, branch `main`, árvore limpa, um commit:
  `22627a7 spec: especificação DRAFT do Contrarregra (operador de iPhone para gravar demos)`.
  Sem remoto.
- `spec/` = os seis arquivos do contrato + `spec/research/` (8 notas brutas da pesquisa, em inglês,
  com `README.md`). `spec.md` com título "— DRAFT"; `constitution.md` com "**Status:** PROPOSED".
- Contagens no commit: 127 ACs (AC-0.1…AC-13.10), 16 decisões do dono (Q-1…Q-16), 17 checagens de
  pré-voo (PF-01…PF-17), 30 tarefas da Fase 0 (T-0.1…T-0.30; spikes SP-1…SP-18 = T-0.12…T-0.29),
  6 APIs privadas registradas (PX-1…PX-6), ADR-1…ADR-16.
- Já corrigidos depois da 3.ª revisão e incluídos no commit: `CONTRARREGRA_EXPLORE` na lista de
  variáveis de S1 (R24, parcial — falta S2 item 1); P-3 cita o simulador pelo loopback do Mac (R77;
  a linha 66 da constituição ficou longa, reembrulhar); D0.13 com o backup do diário antes do SP-8/SP-10
  (R65).
- Os relatórios das três rodadas de revisão ficaram num scratchpad temporário que não existe mais: os
  achados ainda abertos estão transcritos em T1 abaixo.
</current_state>

<completed_work>
- Pesquisa obrigatória em 8 frentes (WDA, transporte/runner no iOS 26, XCTest no Xcode 26.6, captura
  CoreMediaIO/OBS, obs-websocket 5.6.2, relógio e pós, mapa de alvos do Hagah, stack do Mac) →
  `spec/research/*.md`, fontes em `spec/architecture.md` A12.
- Os seis arquivos escritos e revisados em 3 rodadas (207 + 82 + 28 achados; a 3.ª rodada confirmou
  72/82 da 2.ª resolvidos e nenhum blocker/major antigo aberto) → commit `22627a7`.
- Um arquivo estranho (`mo312.b64`, cópia GPL do OBS deixada por um agente de pesquisa) foi tirado da
  raiz antes do commit.
</completed_work>

<pending_tasks>
### T1. Corrigir os achados restantes do analyze gate  (size: M)
- Objective: deixar a spec sem contradições internas antes de levar ao dono. Editar o DRAFT direto
  (P-6: enquanto DRAFT, edição livre). Cada item abaixo é "problema → correção sugerida"; aplicar a
  correção sugerida ou uma equivalente melhor.
- Key files: `spec/spec.md`, `spec/tasks.md`, `spec/requirements.md`, `spec/constitution.md`,
  `spec/architecture.md`, `spec/deploy.md`.
- Itens:
  1. **[major] prepare/cleanup sem executor** (`spec.md` S4 API e item 1, S12 itens 2–4;
     `architecture.md` A3): o protocolo só tem `choreo.load` + `choreo.run {startAtD?}`; nada diz
     quem executa `prepare`/`cleanup`, e A3 roda `prepare` antes de compilar/carregar. → Em S4 API,
     `choreo.run {section: prepare|scenes|cleanup, startAtD?}` e `section` em `choreo.status`; regras
     de tomada (volume/launch/openURL) só em `scenes`. Reescrever S4 item 1 e A3: pré-voo →
     `choreo compile` → `choreo.load` → `choreo.run {section: prepare}` → PF-15 → rajada pré →
     gravação/pré-rolo → `scenes` → pós-rolo → StopRecord → `cleanup` → … AC-1.8: trocar
     "`choreo.status = done` (limpeza)" por "`choreo.status.section = cleanup`". Conferir S1 item 9
     ("de `choreo.run` até `take.end` (só durante `scenes`)") com a nova forma.
  2. **Portões de fase pedindo ACs de fases seguintes** (`tasks.md`): AC-1.23 (precisa de ponto de
     controle, S5/Fase 3) sai do portão da Fase 2 para o da Fase 3; AC-2.4, AC-2.10, AC-9.3 e AC-7.4
     (precisam do pré-voo/coreografia completa) vão para o portão da Fase 5. Portão da Fase 2: "AC-1.1…
     AC-1.23, exceto AC-1.5 se Q-5b/c = não, AC-1.9 se Q-5a = não, AC-1.23 (Fase 3); AC-1.10 e AC-1.18
     sempre".
  3. **AC-1.23 na T-0.18** (SP-7): o arrasto de destravar só é legal dentro de ponto de controle `who:
     runner`, que não existe na Fase 0. → T-0.18: "AC-1.23 (parcial: `ui.drag` na tela travada com
     `locked: true` → `E_FORBIDDEN_APP`)"; o arrasto do spike vira `spike.unlockDrag` (só configuração
     `Spike`, recusado com `locked: true`) ou o dono arrasta.
  4. **Leituras no SpringBoard/tela travada** (`spec.md` S1 item 11 × PF-12, AC-12.3, AC-1.21): a lista
     permitida parece proibir também leituras. → Acrescentar: "a lista restringe ações (toque, arrasto,
     digitação, abrir app/link); leituras (`ui.find`, condições) são permitidas no SpringBoard só para os
     ícones da página do app alvo (PF-12) e para os controles de mídia da tela travada; nunca `ui.tree`
     completo nem `screen.shot` com a tela travada; na folha `authkit`, só `ui.find`/`ui.tap` de
     botões". Espelhar a distinção ação×leitura no item da lista em P-3 (`constitution.md`).
  5. **Q-12/Q-13 travam a Fase 0** (`requirements.md` §5 "Quando se decide"): T-0.7(b)/T-0.15 param
     antes de outro spike, mas o G1 só sai na T-0.30, que depende de todos. → "…exceto quando o
     resultado bloqueia os spikes seguintes (Q-13 após a sonda de T-0.7/T-0.15; Q-12 se o plano B do
     SP-2 falhar): aí o G1 é emitido na hora. Para Q-12 e Q-13 a proposta padrão não vale antes do G1."
  6. **Base de tempo do erro SM-2** (`spec.md` S0.7 exemplo, S7 itens 4–6): `tVideoObservedS` está em
     F e o ajuste V̂ em R. → Declarar "`tVideoObservedS` em F" em S0.7 e definir o erro como
     |`tVideoObservedS`ᵢ − (V̂₋ᵢ − `trim.startR`)| (ajuste sobre observado em R = F + `trim.startR`).
  7. **PF-17 com textos do Hagah** (`spec.md` S12) contra S3 item 3/US-17. → PF-17 genérico ("a tomada
     anterior terminou com `cleanupPending: false` e todas as `assert` da `cleanup` passaram;
     confirmações humanas declaradas pela coreografia"); levar "Account deleted"/"Delete without
     confirming with Apple?" e a conferência do Sign in with Apple para `assert`s da `cleanup` do Hagah
     (S13).
  8. **Deps e Files da Fase 0** (`tasks.md`): T-0.23 Deps += T-0.9; T-0.27 Deps += T-0.7 (mantém
     `[P]`); T-0.21 pré-condição "D0.13 e D0.14 feitos" e Deps += T-0.19; T-0.22 Files +=
     `choreographies/hagah/v8.5-review.choreo.yaml` e Deps += T-0.21; T-0.9 Files += `mac/src/cli/**`;
     T-0.17 Files: trocar `mac/src/media/**` por só os arquivos que cria (ex.
     `mac/src/media/{ffmpeg,frames}.ts`) para não sobrepor `mac/src/media/ocr.ts` da T-0.10 `[P]`.
  9. **Tarefas grandes demais para ≲ 1 h** (R81): dividir T-0.6 em (a) árvore/find/captura/OCR, (b)
     toques/arrastos/digitação, (c) device/app/lista permitida/wait.for; T-0.7 em (a) usbmux +
     repassador, (b) cliente RPC + comandos contra o usbmuxd falso, (c) etapa no aparelho com a sonda de
     alcance; T-0.17 em (a) núcleo relógio/alinhamento com testes, (b) experimentos (a)+(b), (c)
     experimento (c). Renumerar com cuidado: requirements Q-5/Q-6/Q-12/Q-13 e o resto citam T-0.x
     (hoje: SP-2 = T-0.13, SP-3 = T-0.14, SP-4 = T-0.15, SP-7 = T-0.18, SP-12 = T-0.23, SP-18 = T-0.29,
     consolidação = T-0.30). Alternativa aceitável se a renumeração custar caro: subtarefas
     T-0.6a/b/c etc. — mas a gramática do contrato é `T-<fase>.<n>`; preferir renumerar e ajustar todas
     as citações.
  10. **Pequenos**:
      - S2 item 1: `runner up` escreve `CONTRARREGRA_EXPLORE` no `.xctestrun` da sessão (R24);
      - T-0.13 plano B: "G5 antes de re-assinar (só `Apple Development: Andre Saboia (6NKUX5CX7G)`) e
        antes de instalar o `.xctrunner` modificado; `codesign -dvv` confere `TeamIdentifier=984PNJZ8B9`;
        `security find-identity -v -p codesigning` igual antes e depois" (R76);
      - T-0.26 (SP-15) e T-0.29 (SP-18): dizer como a leitura do dono é capturada (gravador qualquer
        com WAVs em `~/Movies/contrarregra/spikes/SP-15/`, ou `paths.ffmpeg -f avfoundation`); D0:
        "Microfone ao Terminal/app do Claude Code, só para SP-15/SP-18 ou se Q-6 = sim" (R79);
      - T-0.23 (SP-12): nomear a fonte do alerta de um botão (ex.: o alerta "Account deleted" do próprio
        Hagah durante o SP-8, com um toque num elemento coberto; ou "o primeiro que aparecer em 4 h;
        sem nenhum, a variante PX-5 passa ao SP-10 e a T-0.30 registra") (R80);
      - `architecture.md` A4 linha dos spikes: "cada gravação apagada logo depois de medida (um G4 por
        spike, com o dono)" (R40);
      - T-0.4 Done: "`xcodebuild -showBuildSettings` de cada alvo: todo `PRODUCT_BUNDLE_IDENTIFIER`
        começa com `app.kifactory.contrarregra` e nenhum é `app.kifactory.hagah`" (R71);
      - `.gitignore` da T-0.1 += `*.aiff`, `*.aif`, `*.m4a`, `*.caf`, `*.xctestrun`, `*.log`,
        `*.ndjson`; o comentário de A5 com exatamente a mesma lista (R82);
      - T-0.17 Done: a linha que começa com ">" vira blockquote no Markdown — reescrever "0 detecções
        mais de 100 ms antes da ação";
      - S0.4: declarar `press {button: home|volumeUp|volumeDown}` (a regra de tomada recusa volume),
        para AC-3.2 citar a regra de tomada e não um erro de enum;
      - S12 e S11 API: acrescentar `[--detach]` a `take run` e a `rehearse` (a tabela MCP↔CLI de S8 os
        usa);
      - `constitution.md` linha ~66: reembrulhar em ≤ 100 colunas.
- Acceptance criteria: cada item tratado (ou recusado com razão); a verificação mecânica passa; um
  commit só de `spec/`.
- Depends on: independent.

### T2. Rodada final de revisão adversarial  (size: S)
- Objective: confirmar que T1 não abriu contradições novas (é isso que aconteceu nas rodadas 2 e 3).
- Key files: `spec/*.md`; contrato em `~/.claude/skills/spec-implement/references/spec-folder-contract.md`.
- Como: 2 subagentes em paralelo, só leitura, saída estruturada (problema citando o texto atual +
  correção + severidade): (a) confere cada item de T1 contra os arquivos atuais; (b) passe novo de
  analyze gate (US→S→AC→T, ACs testáveis, valores iguais entre arquivos, Deps/Files da Fase 0,
  conflitos com a constituição). Corrigir o que vier; repetir só se sobrar blocker/major.
- Acceptance criteria: 0 blocker/major aberto; verificação mecânica passa; commit.
- Depends on: T1.

### T3. Ratificação com o dono (G1)  (size: S; só com o dono na conversa)
- Objective: seguir o modo de ratificação da skill `spec-intake`: perguntas em **um** lote (≤ ~5 por
  rodada, no máximo duas rodadas, com a proposta padrão de cada uma pronta para ele só confirmar), via
  AskUserQuestion. Decidem-se na ratificação: Q-1, Q-2, Q-3, Q-4, Q-5 (a, b, c, e), Q-6, Q-7, Q-10,
  Q-11, Q-14, Q-15, Q-16 (`spec/requirements.md` §5). Ficam para o G1 pós-spike (T-0.30): Q-5 (d, f),
  Q-8, Q-9, Q-12, Q-13. Aplicar as respostas no DRAFT; ler para ele os invariantes P-1…P-7 como lista;
  perguntar explicitamente "Congelar a spec agora?". Só com "sim": `spec.md` → "— FROZEN <data>",
  `constitution.md` → "**Status:** RATIFIED <data>", commit.
- Acceptance criteria: respostas registradas nos pontos ❓ correspondentes; congelamento só com sim
  explícito; se ele não estiver, parar no fim de T2 e dizer o que falta.
- Depends on: T2.
</pending_tasks>

<decisions>
Registradas na spec com a razão (`spec/architecture.md` A6–A7, `spec/constitution.md`). Não reabrir:
- ADR-1…ADR-8 vieram do pedido (aparelho físico; toque via XCUITest com app alvo intocado; exploração +
  tomada executada no aparelho; OBS + obs-websocket com capítulos e MP4 híbrido, QuickTime manual como
  plano B; saídas para narração; ritmo vem da fala; pontos de controle humanos; tomada contínua).
- Transporte: usbmuxd próprio em TypeScript + WebSocket preso ao loopback do iPhone, token por sessão,
  um controlador por vez (ADR-9) — USB por construção, sem root, sem expor nada no Wi-Fi.
- Runner sobe com `xcodebuild test-without-building` destacado + `caffeinate`, túnel `wired` exigido
  (ADR-10) — o lançamento por `devicectl` é frágil no iOS 26.5/Xcode 27.
- Mac em Node 22.x rodando `.ts` direto, MCP SDK v2 (`@modelcontextprotocol/server` 2.3.0), tomada por
  supervisor destacado com vigia (ADR-11) — o Claude Code põe chamadas longas em segundo plano.
- Coreografia em YAML compilada para JSON canônico com hash JCS (ADR-12); XcodeGen (ADR-13); OBS com
  perfil próprio e guarda de perfil antes de toda escrita (ADR-14); sincronia em três elos com erro
  "deixa um de fora" (ADR-15); toolchain congelado (ADR-16).
- API privada do XCTest só no módulo `PrivateXCT`, uso a uso com o sim do dono (Q-5).
- Hagah: rótulos reais do app nativo (o roteiro cita a PWA; tabela em S13 item 2); linha do tempo do
  áudio decidida em S13 item 4.
</decisions>

<key_files>
- `spec/constitution.md` — invariantes P-1…P-7 (ler primeiro).
- `spec/requirements.md` — HC/US/NG/SM e §5 "Decisões do dono" (Q-1…Q-16, com regra de quando cada uma
  se decide).
- `spec/spec.md` — S0 (formatos) + S1…S13; "Itens em aberto" no fim.
- `spec/architecture.md` — A1–A12 (ADRs, registro PX-n, riscos×spikes, fontes).
- `spec/tasks.md` — §Capacidade, Fase 0 completa, cabeçalhos das Fases 1–9 com portões.
- `spec/deploy.md` — D0 (o que só o dono faz), segredos só por nome, procedimentos, desfazer.
- `spec/research/README.md` — índice das notas da pesquisa (evidência, não spec).
- Contrato do /spec: `~/.claude/skills/spec-implement/references/spec-folder-contract.md`; gates:
  `~/.claude/skills/spec-implement/references/gates.md`.
</key_files>

<gotchas>
- Toda correção numa seção mexe em referências cruzadas (S13 item N, T-0.x, AC-x.y, PF-nn, Q-n): as
  rodadas 2 e 3 acharam exatamente isso. Depois de editar, rodar a verificação mecânica e procurar as
  citações do que mudou (`grep -n "T-0\.1[3-9]\|S13 item" spec/*.md`).
- Edições longas com o Edit/Write funcionaram melhor como substituições exatas checadas (contar que o
  texto antigo aparece 1 vez antes de trocar).
- No zsh, `grep --include=*.tsx` falha por glob: usar aspas (`--include='*.tsx'`).
- O ffmpeg do PATH é o 4.4.7; o fixado na spec é `/opt/homebrew/opt/ffmpeg/bin/ffmpeg` 8.1.1 (sem
  `drawtext`). Só relevante se for medir algo — esta sessão não deve rodar nada no aparelho.
- O iPhone (VIVO_00G7, UDID `00008101-001E79203A68001E`) hoje aparece no `devicectl` como
  `localNetwork` (sem cabo). Isso é estado do mundo, não erro da spec.
- A contagem de `accessibilityLabel` do Hagah dá 132 ou 136 conforme o grep; a spec usa 136 (número do
  pedido). Não reabrir.
</gotchas>

<verification>
BASELINE (rodar na raiz do repositório; deve imprimir listas vazias e "ACs not covered []"):

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
for a in re.findall(r'AC-(\d+)\.\*',tk): cov|={k for k in d if k.startswith(f'AC-{a}.')}
print('ACs not covered',sorted(set(d)-cov))
T=set(re.findall(r'\*\*(T-\d+\.\d+)\*\*',tk)); print('T undefined',sorted({x for s in t.values() for x in re.findall(r'T-\d+\.\d+',s)}-T))
Q=set(re.findall(r'\*\*(Q-\d+) —',t['requirements.md'])); print('Q undefined',sorted({'Q-'+x for s in t.values() for x in re.findall(r'Q-(\d+)',s)}-Q))
SP=set(re.findall(r'\*\*(SP-\d+)',tk)); print('SP undefined',sorted({x for s in t.values() for x in re.findall(r'SP-\d+',s)}-SP))
PF=set(re.findall(r'\| (PF-\d+) \|',t['spec.md'])); print('PF undefined',sorted({x for s in t.values() for x in re.findall(r'PF-\d+',s)}-PF))
EOF
```

Também: `git status` limpo depois de cada commit; título de `spec.md` com "— DRAFT" (ou FROZEN só após
o sim do dono) e `constitution.md` com o status correspondente. No commit `22627a7` a BASELINE passa.
</verification>

<constraints>
- Mexer só em `spec/` (e em `.claude/handoffs/` se precisar escrever outro handoff). Nada de código de
  produto, nada de instalar, nada de assinar, nada no iPhone, nada no OBS (P-6/P-7 da própria spec).
- Commits só de `spec/`, terminando com `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
  Não há remoto: não fazer push.
- Não ler, copiar nem imprimir segredos (senha do obs-websocket no Chaveiro, `.p8` em
  `~/.appstoreconnect/private_keys/`) — a spec os cita só pelo nome.
- Documentos em português; identificadores, comandos e nomes de arquivo em inglês.
- Congelar/ratificar é ato do dono: nunca inferir de silêncio.
- Parar no G1: a implementação é outra sessão, com `spec-implement`.
</constraints>

<startup_ritual>
Before planning anything:
1. Run `pwd`, `git status`, `git log --oneline -10`. Compare with <current_state>;
   note and report any drift — the handoff may be stale.
2. Read the key files named above (skim, don't deep-read yet).
3. Run the BASELINE verification command from <verification> to confirm the ground
   you're building on. If the baseline fails in a way the handoff doesn't predict,
   diagnosing that comes first.
4. Only then write your plan: task order, what you delegate vs. do yourself, and
   how many subagents each task warrants.
</startup_ritual>

<orchestration_playbook>
You are the ORCHESTRATOR. Your context window is your scarcest resource — protect
it. Subagents do the heavy reading, searching, and bulk execution; you plan,
delegate, integrate, and verify.

Delegation contract — every subagent prompt is self-contained (subagents see none
of this conversation) and carries four parts: objective, output format, tool/source
guidance, and task boundaries (what NOT to touch). Include the relevant file paths
and conventions in the delegation text itself.

Effort scaling — match agent count to task size, never the reverse:
- trivial lookup: do it yourself (one grep beats a subagent);
- S task: one subagent, or yourself if it needs context you already hold;
- M task: 1–3 subagents with divided, non-overlapping responsibilities;
- L task: decompose first, then delegate the pieces; 3–5 parallel subagents is a
  lot — justify more before spawning them.

Parallel vs sequential — launch independent read-only work (exploration, research,
review) in parallel, in a single message. Serialize anything that shares files or
feeds the next step. Never let two subagents edit the same files concurrently; if
parallel edits are unavoidable, isolate them in worktrees.

Damping rule — delegate work that is parallel, isolated, or context-heavy to read;
do directly work that is simple, sequential, single-file, or depends on context you
already hold. Splitting context-dependent sequential steps across agents loses
information at every hop.

Returns — instruct subagents to return summaries, not dumps ("report only failing
tests with error messages", "return the list of changed files and one line each").
Their verbose exploration must not refill your window.

Verification — a task is done only with evidence: test output, exit codes, a
before/after check, not "looks correct". For substantive changes, spawn a fresh
reviewer subagent that sees only the diff plus the acceptance criteria, told to
report only gaps affecting correctness (style nitpicks invite over-engineering).

State — after each completed task, commit with a clear message and tick it off. If
your own context nears exhaustion with tasks remaining, stop starting new work,
commit what stands, and write the next handoff (a file in .claude/handoffs/, or
this session's handoff skill if available) instead of stranding work mid-task.

Escalation — stop and ask the user when: a requirement is ambiguous in a way that
changes the design, evidence contradicts a recorded decision, or an action is
destructive or outward-facing (pushes, deploys, deletions, publishing).
</orchestration_playbook>

Nota de execução: T1 mexe em arquivos compartilhados — faça as edições você mesmo (ou com um único
subagente por arquivo, nunca dois no mesmo arquivo); use subagentes paralelos só para a revisão de T2.

Begin with the startup ritual now.
