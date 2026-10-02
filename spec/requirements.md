# Contrarregra — Requisitos

> Projeto novo (greenfield), sem código. Marcas de decisão, não de evidência em código:
> ✅ decidido (com origem) · ⚠️ padrão proposto, vale se o dono não mudar · ❓ decisão do dono
> (todas reunidas em §5). Fonte principal: `hagah/plans/mobile/notes/v8.5-prompt-contrarregra.md`
> (2026-10-02), daqui em diante "o pedido".

**Uma frase:** "Eu digo ao Claude Code qual vídeo gravar; o Contrarregra opera o iPhone de verdade,
grava a tomada inteira no Mac e me entrega o vídeo com as falas cronometradas para eu narrar por
cima."

**Plataforma:** Mac do dono (macOS 26, Apple Silicon) + iPhone físico (iOS 26) pelo cabo USB;
simulador do Xcode só para ensaio. **Primeiro uso:** o vídeo pedido pela App Review do Hagah Bible
(guideline 2.1, `hagah/plans/mobile/notes/v8.5-rejeicao-2.1.md` §1). **Janela-alvo:** ⚠️ tomada final
do Hagah ao fim da Fase 5: 17 / 25 / 38 dias úteis contando o dia do G1, otimista / provável /
pessimista, com o dono disponível no aparelho como em `tasks.md` §Capacidade; a App Review espera
desde 2026-09-16 (❓ Q-10).

## 1. Restrições duras

- **HC-1** O vídeo final é gravado num **iPhone físico com iOS 26.x** (hoje: iPhone 12 "VIVO_00G7",
  iOS 26.3). O simulador serve só para ensaio e nunca produz o vídeo entregue. A Apple pede "the
  latest iOS"; qual versão vai ao vídeo é ❓ Q-11. ✅ (pedido §3.1)
- **HC-2** Toolchain do Mac fixo: **Xcode 26.6** e macOS 26.5.x; lado do aparelho em Swift sobre
  XCTest; lado do Mac em TypeScript sobre **Node 22.x (≥ 22.18)**. ✅ (pedido §4, §5.5)
- **HC-3** O **app alvo fica intocado**: no aparelho é o build distribuído pelo TestFlight, sem
  ganchos de depuração, sem `testID` novo, sem build especial. A ferramenta o opera só pela árvore
  de acessibilidade, pela imagem da tela (OCR) e por coordenadas. ✅ (pedido §3.2)
- **HC-4** O transporte Mac ↔ iPhone durante a tomada é o **cabo USB** e tem de sobreviver ao
  **modo avião** e à **tela bloqueada**. Wi-Fi não é transporte de tomada: o canal de comandos só
  aceita a entrada `USB` do usbmuxd e o túnel do Xcode tem de estar `wired` no `devicectl` (hoje está
  `localNetwork`); se o loopback não for alcançável pelo usbmux, ❓ Q-13. ✅ (pedido §5.2)
- **HC-5** A ferramenta **nunca pede, digita, lê, grava ou imprime credenciais** (Apple ID, senhas,
  código do aparelho, chaves). Face ID, senha e código são sempre ponto de controle humano. ✅
  (pedido §4)
- **HC-6** **Nada da ferramenta aparece no vídeo entregue**: nem sobreposição, nem o app hospedeiro
  ou o runner à vista, nem som do Mac na trilha gravada. As marcas de calibração do OBS ficam só no
  pré/pós-rolo do arquivo bruto e são aparadas (❓ Q-16). Se o iOS mostrar algum indicador de
  automação, ele é documentado e tratado (`spec.md` S1; ❓ Q-9). ✅ (pedido §5.1)
- **HC-7** Arquivos de vídeo, áudio, capturas e as saídas de cada tomada ficam **fora do git**, em
  `~/Movies/contrarregra/` (e caches em `~/Library/Caches/contrarregra/`). O repositório guarda
  código, coreografias e a spec. ✅ (pedido §5.6)
- **HC-8** Assinatura **só com o time `984PNJZ8B9`** e o certificado
  `Apple Development: Andre Saboia (6NKUX5CX7G)` (OU=984PNJZ8B9, conferido no chaveiro em
  2026-10-02). Nenhum outro time ou certificado do chaveiro. ✅ (pedido §4)
- **HC-9** Gravação no Mac pelo **OBS 31.1.2** (congelado; ❓ Q-8) controlado por **obs-websocket
  v5**; QuickTime manual é o plano B. ✅ (pedido §3.4)
- **HC-10** **Uma tomada contínua, sem cortes dentro das cenas.** Pós-produção mínima: aparar o
  pré/pós-rolo de calibração (❓ Q-16), mixar a voz do dono com o áudio do app e exportar H.264. ✅
  (pedido §3.8)
- **HC-11** Antes de gravar, a ferramenta **confere o espaço livre em disco** e aborta abaixo do
  limite. ⚠️ Limite padrão: livre ≥ 3 × (tamanho estimado da gravação) + 2 GiB — gravação,
  `review.mp4` e `final.mp4` —, e nunca menos de 4 GiB; durante a tomada, abaixo de 2 GiB a gravação
  para e é finalizada. O Mac tinha ~8,7–10 GiB livres em 2026-10-02 e já ficou sem espaço três vezes
  no projeto Hagah; uma tomada de 10 min a 16 Mbps ≈ 1,2 GB (espaço e retenção: ❓ Q-14).

## 2. Histórias de usuário

Papéis: **dono** (Andre, quem grava e narra), **Claude Code** (o agente que opera pela CLI/MCP),
**time** (outros apps do mesmo time no futuro).

**Exploração interativa**
- **US-1** Como Claude Code, quero pedir a captura da tela do iPhone e a árvore de acessibilidade do
  app em primeiro plano, para descobrir onde tocar sem adivinhar.
- **US-2** Como Claude Code, quero tocar, tocar-e-segurar, arrastar, digitar texto não secreto,
  apertar botões do aparelho, abrir/ativar/encerrar apps e esperar por elementos, para validar cada
  passo de uma cena no aparelho.
- **US-3** Como Claude Code, quero tocar num texto visível que não existe na árvore de
  acessibilidade (OCR), para alcançar, por exemplo, uma palavra dentro de um versículo.
- **US-4** Como Claude Code, quero transformar o que acabei de explorar num passo de coreografia
  pronto (alvo, ação, expectativa), para não reescrever à mão o que já validei.

**Tomada**
- **US-5** Como dono, quero descrever o vídeo num arquivo declarativo (cenas, falas, passos, pontos
  de controle), para revisar e versionar o roteiro executável.
- **US-6** Como dono, quero que a tomada rode **no próprio aparelho**, com tempos precisos e sem
  depender da rede no meio, para gravar uma sequência contínua mesmo com o modo avião ligado.
- **US-7** Como dono, quero ser chamado só onde uma pessoa é indispensável (Face ID, senha,
  desbloqueio, modo avião), com aviso no Mac, e que a tomada continue sozinha quando eu terminar.
- **US-8** Como dono, quero que cada cena segure a tela pelo tempo da sua fala, medido por uma
  faixa-guia sintetizada, para narrar depois sem correr.
- **US-9** Como dono, quero que a gravação comece, marque um capítulo por cena e pare sozinha no OBS,
  para não operar o OBS à mão.
- **US-10** Como dono, quero que a ferramenta confira tudo antes de gravar (disco, OBS, aparelho,
  runner, idioma, estado do app) e aborte com uma mensagem clara, para não perder uma tomada por
  um detalhe.

**Narração e pós**
- **US-11** Como dono, quero `events.json`, legendas `.srt`/`.vtt`, capítulos e a tabela de tempos
  por cena alinhados ao vídeo, para narrar em cima no lugar certo.
- **US-12** Como dono, quero uma receita de mixagem que abaixa o áudio do app sob a minha voz e
  exporta H.264, para entregar o vídeo final.
- **US-13** Como dono, quero (opcional, ❓ Q-6) uma cabine de narração local que toca o vídeo com as
  falas rolando e grava meu microfone já sincronizado.

**Ensaio e operação**
- **US-14** Como dono ou Claude Code, quero ensaiar a mesma coreografia no simulador, com gravação,
  pulando ou simulando o que só existe no aparelho, para corrigir passos sem ocupar o iPhone.
- **US-15** Como dono, quero subir o runner no iPhone com um comando (compilar, assinar, instalar,
  iniciar) e que ele fique vivo por horas e se reconecte, sem o Xcode aberto.
- **US-16** Como dono, quero repetir uma tomada inteira — repor o estado, gravar, exportar — em
  poucos minutos, para refazer quando algo der errado.
- **US-17** Como time, quero usar a ferramenta para outro app nosso trocando só a coreografia e o
  bundle id, sem mudar código.

## 3. Não-objetivos

- **NG-1** Android, iPad como alvo de vídeo, Mac Catalyst. ✅
- **NG-2** Farms de aparelhos na nuvem ou vários aparelhos ao mesmo tempo. ✅
- **NG-3** Framework de testes genérico: sem relatórios de QA, sem CI, sem compatibilidade W3C
  WebDriver/Appium, sem asserções além das que a tomada precisa para seguir. ✅
- **NG-4** Contornar Face ID, código ou qualquer autenticação do iPhone físico; digitar credenciais
  (a simulação de biometria do Simulador, no ensaio, não conta). ✅
- **NG-5** Edição de vídeo além da mixagem: sem cortes dentro das cenas, zoom, anotações,
  transições, legendas queimadas; o único corte é o do pré/pós-rolo de calibração (❓ Q-16). ✅
- **NG-6** Narração final sintetizada. A voz final é a do dono; a síntese é só faixa-guia. ✅
- **NG-7** Distribuir a ferramenta na App Store ou no TestFlight. ✅
- **NG-8** Alterar o app alvo para facilitar a automação (ver HC-3). ✅
- **NG-9** Gravar pela Gravação de Tela do próprio iOS (Central de Controle) ou por ReplayKit — o
  caminho é o OBS no Mac (HC-9). ✅
- **NG-10** Publicar o vídeo (R2, YouTube) ou responder à Apple: fica com o dono/projeto Hagah. ✅
- **NG-11** Operar outros apps do iPhone pessoal do dono (Ajustes, mensagens, lojas, carteira):
  a ferramenta só alcança o app alvo e o mínimo de sistema da coreografia. ✅

## 4. Métricas de sucesso

- **SM-1** Uma tomada **completa das 10 cenas** do roteiro do Hagah no iPhone termina com
  `take.json` `status = "finished"` sem nenhuma intervenção além dos pontos de controle declarados
  na coreografia (contagem de eventos `intervention` no `events.json` = 0). ✅ (pedido §6)
- **SM-2** **Erro de sincronia evento × vídeo ≤ ±100 ms**, medido pelo procedimento de `spec.md` S7
  (validação deixando um de fora) sobre os passos com efeito visual imediato detectados numa
  tomada (no mínimo 10): **máximo ≤ 100 ms** e mediana ≤ 50 ms ⚠️. ✅ (pedido §6)
- **SM-3** **Repetir uma tomada inteira em ≤ 15 min**, do comando de reposição de estado até as
  saídas exportadas (sem contar a narração do dono), com os pontos de controle humanos resolvidos
  sem demora (≤ 15 s cada) e espaço em disco para a tomada (❓ Q-14). ✅ (pedido §6)
- **SM-4** O Claude Code, só pelo MCP, **explora uma tela que nenhuma coreografia cobre e gera um
  passo** que, inserido na coreografia, executa sem erro na primeira tentativa em ≥ 4 de 5 telas
  de teste. ✅ (pedido §6; o 4/5 é ⚠️)
- **SM-5** O runner fica **vivo ≥ 4 h** com o aparelho no cabo, atendendo comandos, sem reinício
  manual. ⚠️ (pedido §5.1 diz "por horas")
- **SM-6** **Zero quadros com a ferramenta à vista** no vídeo entregue: nenhum evento de primeiro
  plano do app hospedeiro/runner entre o início e o fim da gravação, e a revisão dos inícios de
  capítulo não acha sobreposição, ícone ou HUD da ferramenta (o aviso do próprio iOS segue ❓ Q-9).
  ✅ (HC-6)
- **SM-7** O pré-voo (`spec.md` S12) detecta 100 % das falhas plantadas da sua lista (OBS fechado,
  websocket desligado, disco abaixo do limite, cabo solto, runner morto, app alvo ausente, idioma
  errado, modo avião ligado) antes de iniciar a gravação. ⚠️

## 5. Decisões do dono

Cada item tem uma proposta padrão, a lista "Onde pesa" e um `❓ Q-n` nos pontos principais dos outros
arquivos que mudam conforme a resposta.
**Quando se decide:** Q-1…Q-4, Q-5 (a, b, c, e), Q-6, Q-7, Q-10, Q-11, Q-14, Q-15 e Q-16 na
ratificação (G1). Q-5 (d, f), Q-8, Q-9, Q-12 e Q-13 dependem de um spike: decidem-se no G1 que a
tarefa de consolidação da Fase 0 (T-0.30) emite; até lá vale a proposta padrão. Nada aqui bloqueia a
estrutura da spec.

- **Q-1 — Qual build aparece no vídeo.** O roteiro diz 1.0.0 (4); o `hagah/plans/mobile/STATE.md`
  registra o **1.0.0 (5)** no TestFlight desde 2026-09-23 e a troca do 4 pelo 5 antes de reenviar.
  O vídeo tem de mostrar o build que vai à revisão. *Proposta:* **build 5**, instalado pelo
  TestFlight (o que também substitui o build Release de desenvolvimento hoje no iPhone, que tem o
  mesmo bundle id); o About do app mostra "Version 1.0.0 (5)". Onde pesa: `spec.md` S0.4
  (`app.expectVersion`), S12 (PF-05), S13; `deploy.md` D0 e D3.5.
- **Q-2 — Qual Apple ID aparece na cena 7.** No aparelho, o Sign in with Apple usa a conta logada no
  iPhone; não há como escolher um "Apple ID de teste" na folha. *Opções:* (a) a conta do dono — o
  nome dele aparece no vídeo e no cartão "Signed in with Apple · <nome>", e cada tomada (e cada
  limpeza) cria e revoga o vínculo do Hagah nessa conta; (b) deslogar o iPhone e logar numa conta de
  teste antes da tomada (mexe em iCloud, Buscar, chaves e pagamentos do aparelho pessoal).
  *Proposta:* **(a)**, com o dono confirmando antes que o Hagah não está em Settings › [nome] ›
  Sign-In & Security › Sign in with Apple (a Apple só manda o nome no primeiro cadastro). Onde pesa:
  `spec.md` S5 item 6, S12 item 3 e PF-17, S13; `deploy.md` D0.
- **Q-3 — Nome e bundle ids da ferramenta.** *Proposta:* nome **Contrarregra** (CLI `contrarregra`,
  perfil do OBS "Contrarregra"); hospedeiro `app.kifactory.contrarregra`; bundle de UI test
  `app.kifactory.contrarregra.runner`, cujo app executor o Xcode gera como
  `app.kifactory.contrarregra.runner.xctrunner`; nomes exibidos no aparelho "Contrarregra" (hospedeiro)
  e o que o Xcode gerar para o runner (⚠️ "ContrarregraRunner-Runner"; `bundle.displayNames`). A primeira
  assinatura (T-0.4) cria esses App IDs no time — decidir antes dela. Onde pesa: `constitution.md`
  P-1/P-6, `spec.md` S0.1, `architecture.md` A5, `tasks.md` T-0.4, `deploy.md` D3/D5.
- **Q-4 — Onde mora o código.** *Proposta:* **repositório separado** em `~/project/contrarregra`
  (este), sem depender do monorepo do Hagah; a coreografia do Hagah mora aqui em
  `choreographies/hagah/`. Alternativa: pasta `tools/contrarregra` dentro do Hagah. Onde pesa:
  `architecture.md` A5, `spec.md` S3 item 3, `tasks.md` T-0.1.
- **Q-5 — API privada do XCTest.** A constituição (P-4) só admite API privada sem alternativa
  pública, isolada no módulo `PrivateXCT`, com risco, sondagem e plano B (`architecture.md` A10), e
  liberada uso a uso em `runner.privateAllowed`. Usos: (a) **travar a tela** (cena 3; PX-1) — plano
  B: o dono aperta o botão lateral num ponto de controle; (b) **pular a espera de ociosidade** do
  XCTest no app alvo (PX-2) — sem ela, cada toque com o áudio tocando pode esperar segundos (SP-3);
  plano B: aceitar o atraso medido e pausar o áudio antes de toques que não precisam dele; (c)
  **evento de toque sintetizado** (PX-3) — toque com tempo preciso, sem espera, e arrasto com vários
  pontos; plano B: toque público por coordenada, arrasto reto; (d) **não parar o teste em falha**
  (PX-4) — só se o SP-12 mostrar que o caminho público não basta; (e) **o XCTest não tocar alertas
  sozinho** (PX-5) — sem ele, o XCTest pode fechar sozinho um alerta de um botão que bloqueie um
  toque; plano B: tratar todo alerta esperado com `expect`; (f) **captura de tela privada em JPEG**
  (PX-6) — só se a captura pública não cumprir AC-1.4. *Proposta:* aceitar **(a), (b), (c) e (e)**
  na ratificação; (d) e (f) só se o spike pedir (T-0.30). Onde pesa: `spec.md` S0.1, S1 itens 4, 5,
  8 e E-1.4, AC-1.5/AC-1.9/AC-1.18; `architecture.md` A10; `tasks.md` T-0.14, T-0.18, T-0.23.
- **Q-6 — Cabine de narração na v1.** O pedido a trata como opcional. *Proposta:* **sim, como Fase 8**,
  cortável sem afetar as outras; sem ela, o dono narra em qualquer gravador ouvindo a faixa-guia
  alinhada e lendo o `.vtt`. Onde pesa: `spec.md` S10 item 3 (AC-10.8, AC-10.9), `tasks.md` T-0.29 e
  Fase 8.
- **Q-7 — TTS pago para a faixa-guia.** O padrão é o `say` do macOS (grátis, local). O Gemini TTS
  que o Hagah usa tem custo e manda o texto das falas a um serviço externo. *Proposta:* **só `say`**
  na v1; Gemini apenas se o dono pedir, com gate G5 na hora. Onde pesa: `spec.md` S6.
- **Q-8 — Atualizar o OBS para 32.2.x.** O 31.1.2 instalado carimba o capítulo alguns quadros antes
  do pedido e tem um travamento conhecido quando o iPhone reconecta (corrigido no 32.2.0); o 32.x tem
  capítulos exatos e o Hybrid MP4 fora de beta. *Proposta:* **ficar no 31.1.2** na v1 (os capítulos
  finais são regenerados de `events.json`, então a precisão não depende do OBS) e reavaliar se o
  SP-5 achar o travamento. Atualizar = instalar (G5) + mudar o conjunto congelado (G1, P-1) e refazer
  SP-1…SP-7. Onde pesa: `constitution.md` P-1, HC-9, `spec.md` S0.1, S9 item 2, AC-9.1, PF-01,
  `architecture.md` ADR-4/ADR-16, `deploy.md` D0.
- **Q-9 — Se o aviso do iOS "Automation Running" aparecer na gravação.** O iOS 15+ mostra um aviso
  translúcido e móvel ("Automation Running — Hold both volume buttons to stop") enquanto há sessão de
  automação; ninguém documentou se ele entra na captura USB (OBS/QuickTime) — é o SP-1. Se entrar,
  a ferramenta não tem como escondê-lo (a sessão precisa estar viva durante a tomada). *Opções:*
  (a) aceitar e explicar numa linha da resposta à Apple ("the 'Automation Running' label is iOS's
  indicator of the recording tool"); (b) gravar pela Gravação de Tela do próprio iOS, se ela não
  mostrar o aviso (perde capítulos e controle automático; contraria o ADR-4 e o NG-9); (c) gravar o
  Hagah à mão. *Proposta:* decidir **depois do SP-1**, com os quadros na mão; se aparecer, (a). Onde
  pesa: HC-6, SM-6, `spec.md` S1 item 9, AC-13.7, AC-13.8.
- **Q-10 — Urgência do vídeo do Hagah.** A versão está "Rejected — 2.1 Information Needed" desde
  2026-09-16 e a tomada final pelo Contrarregra fica, no cenário provável, ~25 dias úteis depois do
  G1 (com o dono no aparelho ~4 janelas na Fase 0 e ~2 por semana depois). *Opções:* (a) esperar a
  ferramenta; (b) gravar o vídeo do Hagah agora, à mão, com o roteiro corrigido (`spec.md` S13 lista
  as diferenças de rótulo), e usar o Contrarregra a partir da próxima revisão. *Proposta:* decidir na
  ratificação; se a App Review não puder esperar ~5 semanas, (b). Onde pesa: Janela-alvo acima,
  `tasks.md` §Capacidade.
- **Q-11 — Qual iOS vai ao vídeo.** A Apple pede "a physical iPhone running the latest iOS"; o
  iPhone está no 26.3 e já saíram 26.x posteriores (e o 27.0, que o Xcode 26.6 não opera e que já
  quebrou APIs do XCTest). *Opções:* (a) atualizar para o último 26.x **antes** da Fase 0 e congelar
  nele; (b) ficar no 26.3 e aceitar o risco de a revisão notar. *Proposta:* **(a)**, nunca o 27.
  Onde pesa: HC-1, `constitution.md` P-1/P-4, `spec.md` S0.1 e PF-01, `deploy.md` D0.
- **Q-12 — Se a sessão do XCTest não sobreviver ao modo avião (SP-2).** O plano B mais barato
  (lançar o runner por `devicectl`) pode também falhar. *Opções:* (a) aceitar religar o runner entre
  as cenas 9 e 10, com uma pausa e o runner visível (relaxa HC-6/HC-10 só nesse ponto, emenda de
  P-4 por G1); (b) gravar as cenas 9 e 10 como segunda tomada (contraria o ADR-8); (c) o dono opera à
  mão o resto da tomada a partir de ligar o modo avião (cenas 9 e 10), com a gravação seguindo sem o
  runner — exige mudar S2 item 7/E-2.6 (hoje a tomada aborta quando o `xcodebuild` morre) e marcar à
  mão o início das cenas 9 e 10. *Proposta:* decidir depois do SP-2, com os números; entre as três,
  (c) é a que mantém uma tomada contínua sem a ferramenta à vista. Onde pesa: `spec.md` S2 item 7, A11,
  `tasks.md` T-0.13.
- **Q-13 — Se o loopback do iPhone não for alcançável pelo usbmux (SP-4).** A constituição (P-3,
  P-7) proíbe o runner de escutar fora do loopback. *Opções:* (a) escutar em todas as interfaces
  recusando origem que não seja loopback, com token; (b) escutar só na interface do túnel
  CoreDevice com `wired`; (c) não aceitar e ficar sem transporte de tomada. *Proposta:* decidir
  depois do SP-4; se chegar a isso, (b), com emenda de P-3/P-7 e HC-4 por G1. Onde pesa: `constitution.md`
  P-3/P-7, HC-4, A11, `tasks.md` T-0.15.
- **Q-14 — Espaço em disco e retenção de tomadas.** Com ~8,7–10 GiB livres e ~3,6 GB por tomada
  guardada, a segunda tomada pode ser recusada pelo HC-11, e os spikes de gravação precisam de
  folga. *Opções:* (a) liberar ~20 GB antes da Fase 0 (o `STATE.md` do Hagah aponta 14 GB em
  `~/.cache/huggingface` e 6,6 GB de simuladores); (b) guardar só a última tomada completa e apagar
  `recording.mp4`/`review.mp4` das anteriores (G4 em lote, com o dono); (c) `paths.takes` num disco
  externo. *Proposta:* **(a) + (b)**. Onde pesa: HC-11, SM-3, `spec.md` S9 item 4, PF-08,
  `deploy.md` D0/D5/D6.
- **Q-15 — Dados pessoais do Hagah no iPhone.** O preparo deixa o Hagah deslogado, com o diário vazio,
  preferências padrão e downloads controlados — ou seja, apaga o que o dono tiver ali hoje (um diário
  local não sincronizado se perde de vez). *Opções:* (a) o dono confirma que pode apagar; (b) o dono
  sincroniza/exporta antes; (c) o preparo para num ponto de controle sempre que achar dado que
  nenhuma tomada criou. *Proposta:* **(b) uma vez + (c) sempre**. Onde pesa: `spec.md` S12 item 2,
  S13 item 3, `deploy.md` D0.
- **Q-16 — Aparar o pré-rolo e o pós-rolo de calibração.** A sincronia de ±100 ms usa marcas
  brancas do OBS antes da cena 1 e depois da última; o vídeo entregue começa até 1 s antes da cena 1
  (tela de início parada, no keyframe anterior) e termina no fim da última cena. Não é corte dentro
  de cena, mas é um corte.
  *Opções:* (a) aparar; (b) não aparar e trocar as marcas visuais por um "clap" de áudio numa faixa
  que não vai ao vídeo (precisão ainda não medida). *Proposta:* **(a)**. Onde pesa: HC-6, HC-10,
  NG-5, `constitution.md` P-4, `spec.md` S7 item 3, S10 item 1.
