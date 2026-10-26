# Instalação do OneTake

[← README](../README.md) · [Primeira demonstração](usage.md) · [Desenvolvimento](development.md) · [Configuração MCP do repositório](../.mcp.json)

A instalação é **pelo código-fonte** em macOS. `package.json` tem `private: true`: não há pacote npm público deste projeto; a licença do código é [MIT](../LICENSE). O caminho de operação foi preparado para Apple Silicon com Homebrew em `/opt/homebrew`. Até a validação de uma coreografia, você não precisa de iPhone, assinatura ou OBS.

## 1. Requisitos para operar um iPhone real

- Mac com **Xcode 26 e SDK iOS 26**, ferramentas de linha de comando apontando para esse Xcode, conta Apple de desenvolvimento configurada no Xcode e identidade **Apple Development** instalada no Chaveiro. O conjunto de referência em `config/defaults.json` registra Xcode **26.6 (17F113)** e macOS **26.5.x**; versões diferentes exigem verificação própria, não são garantia de compatibilidade.
- **XcodeGen ≥ 2.45.4**, conforme `ios/project.yml`, no caminho usado pelo runner: `/opt/homebrew/bin/xcodegen`. Não gere o projeto manualmente sem passar as variáveis de assinatura; use `runner build`.
- **iPhone físico com iOS 26.x**, Modo de Desenvolvedor ativo, confiando neste Mac, destravado e conectado por **cabo USB**; o app alvo precisa estar instalado por você. Simulador não substitui a captura física.
- **Node 22.x ≥ 22.18** (Node 23+ não é aceito), npm e nvm recomendado. `./bin/onetake` escolhe um Node compatível do nvm ou do `PATH` e recusa outros majors.
- **OBS Studio 31.1.2** com **obs-websocket 5.6.2** e **ffmpeg + ffprobe 8.1.1** são as versões registradas em `toolchain.validated`. O cliente OBS confere as versões exatas e os recursos do WebSocket; o módulo de mídia confere as versões exatas dos dois binários. São versões de referência de compatibilidade, **não** uma promessa de que a última versão disponível funcionará.

Instale Xcode e o SDK iOS pelo canal da Apple; selecione o Xcode correto nas preferências de Command Line Tools. Para XcodeGen e ffmpeg, Homebrew pode ser usado, por exemplo, com `brew install xcodegen ffmpeg`; para OBS, `brew install --cask obs`. **Esses comandos instalam versões atualmente distribuídas, não fixam 2.45.4, 8.1.1 ou 31.1.2**. Confira o resultado antes de operar; se as versões não coincidirem, obtenha releases compatíveis dos distribuidores e valide em sua máquina, sem alterar `toolchain.validated` para mascarar uma incompatibilidade. Se instalar em outros caminhos (inclusive Intel), ajuste os caminhos absolutos de `paths.ffmpeg` e `paths.ffprobe` na sua configuração; o binário XcodeGen do runner é fixo em `/opt/homebrew/bin/xcodegen`. A suíte de testes de mídia usa diretamente os defaults de ffmpeg/ffprobe em `/opt/homebrew/opt/ffmpeg/bin` e afirma esse caminho: ajustar apenas seu arquivo local não torna `npm test` portável para outro layout.

Verificações manuais de ferramentas, sem iniciar build, OBS ou aparelho:

```sh
node --version
xcodebuild -version
xcrun --sdk iphoneos --show-sdk-version
/opt/homebrew/bin/xcodegen --version
/opt/homebrew/opt/ffmpeg/bin/ffmpeg -version
/opt/homebrew/opt/ffmpeg/bin/ffprobe -version
```

Confira a versão OBS e obs-websocket na interface do OBS; não presuma que o Homebrew manteve uma versão. Os comandos com caminhos Homebrew acima só valem quando esses binários foram instalados ali.

## 2. Instale as dependências e valide sem hardware

Depois de instalar [nvm](https://github.com/nvm-sh/nvm#installing-and-updating), na raiz do checkout:

```sh
git clone https://github.com/anboia/onetake.git
cd onetake
nvm install
nvm use
npm ci
./bin/onetake --help
./bin/onetake take validate examples/first-take.choreo.yaml --json
```

Se já clonou o repositório, entre na raiz e comece em `nvm install`. O clone pode exigir permissão enquanto o repositório não for público. `.nvmrc` pede Node 22 e `package.json` exige `>=22.18 <23`. A CLI executa `.ts` diretamente, sem `npm run build`. `take validate` apenas valida o YAML de exemplo; o app `com.example.demo` não acompanha o projeto.

Para contribuir, testes sem aparelho incluem também a mídia ffmpeg; eles **exigem ffmpeg/ffprobe 8.1.1 nos caminhos configurados**, mesmo sem iPhone, assinatura ou OBS:

```sh
npm run typecheck
npm test
npm run docs:check
swift test --package-path ios/ContrarregraKit
```

`npm test` inclui `mac/test/align.test.ts`, que cria vídeos sintéticos temporários via ffmpeg. Consulte [desenvolvimento](development.md) para escopo dos checks.

## 3. Configure sua máquina (sem enviar dados ao git)

Crie um arquivo novo **sem sobrescrever** uma configuração existente:

```sh
mkdir -p "$HOME/.config/onetake"
cp -n config/example.json "$HOME/.config/onetake/config.json"
```

**Antes de copiar**, se já houver `~/.config/contrarregra/config.json`, leia [migração](migration.md): criar o arquivo novo faz o antigo deixar de ser usado. Edite `~/.config/onetake/config.json` fora do repositório; não preencha `config/defaults.json` ou `config/example.json` com dados reais. Os objetos da configuração local são mesclados com `config/defaults.json`; listas substituem as listas padrão. Preencha, com seus próprios valores:

- `device.udid`: UDID do iPhone; `device.coreDeviceId`: identificador mostrado pelo CoreDevice; `device.name`: **nome da fonte do iPhone mostrado no OBS**. Você pode consultar manualmente o aparelho em Xcode → Devices and Simulators ou em `xcrun devicectl list devices`; não copie identificadores de outra pessoa.
- `signing.team`: Apple Team ID de **10 caracteres A–Z/0–9**; `signing.identity`: nome **exato** no formato `Apple Development: Nome (IDENTIFICADOR)` da identidade já instalada, pertencente ao time escolhido. O identificador entre parênteses não deve ser inferido a partir do Team ID: copie o nome completo da identidade existente. O titular pode conferi-la manualmente no Xcode/Chaveiro ou com `security find-identity -v -p codesigning` (isso lista identidades locais; não compartilhe a saída). Não coloque senha, chave privada ou certificado no JSON.
- `bundle.host` e `bundle.runnerTest`: identificadores DNS seus, válidos e **distintos** para o hospedeiro e o bundle de testes; substitua ambos os `com.example.*`. O app que será demonstrado é **outro**: configure `app.explore` com o bundle ID do seu app instalado, e adapte o YAML do roteiro.
- `apps.allowed` e `urls.allowedPrefixes`: apenas apps adicionais e prefixos URL autorizados para a sua sessão. `runner.privateAllowed` fica vazio a menos que você entenda e autorize uma capacidade privada. Revise também `paths.takes`, `paths.cache`, os dois caminhos absolutos de ffmpeg/ffprobe e `obs.profile`, `obs.collection`, `obs.scene` para não usar destinos de terceiros.

`loadConfig` aceita campos vazios para inspeção local, mas `runner build` **recusa** team, identity e bundle IDs inválidos antes de chamar XcodeGen. O build injeta `ONETAKE_SIGNING_TEAM`, `ONETAKE_HOST_BUNDLE_ID` e `ONETAKE_RUNNER_TEST_BUNDLE_ID` a partir da sua configuração em `ios/project.yml`; não é necessário exportá-los no terminal. A CLI pública **não oferece `--config`**: o caminho padrão é `~/.config/onetake/config.json`, com fallback para `~/.config/contrarregra/config.json` apenas quando o primeiro não existe.

## 4. Configure a senha do OBS no Chaveiro, pessoalmente

No OBS, abra **Ferramentas → Configurações do servidor WebSocket**; ative o servidor e a autenticação, escolha uma senha forte e mantenha a porta coerente com `obs.url` (padrão `ws://127.0.0.1:4455`). Na aplicação **Acesso às Chaves** do macOS, crie um item de senha de aplicativo/genérica com **serviço/nome `contrarregra`**, **conta `OBS_WEBSOCKET_PASSWORD`** e a **mesma senha**. Verifique os atributos do item na interface antes de fechar. O nome pode ser alterado em `secrets.obsPassword`, mas o serviço legado continua `contrarregra` no código.

Nunca passe a senha como argumento de comando, ponha-a em JSON, `.env`, issue, prompt ou log. O OneTake a busca no Chaveiro na conexão; se faltar, devolve `E_SECRET_MISSING`. Desative o servidor WebSocket quando não estiver gravando e considere o alcance de rede configurado pelo OBS, além da senha.

## 5. Primeira operação — somente com consentimento do dono

Com o iPhone preparado e suas configurações revisadas, `runner build` executa XcodeGen e Xcode, pode gerar provisionamento e reavalia a assinatura; `runner up` instala/inicia o runner no aparelho. **Não execute esses comandos só para testar a documentação.** A linha de base de assinatura fica ao lado do `config.json` escolhido; se já existia uma instalação, veja [migração](migration.md) antes do build.

```sh
./bin/onetake runner build
./bin/onetake runner up
./bin/onetake runner status --json
```

Para gravar, `./bin/onetake obs setup` cria ou reconcilia o perfil/coleção configurados e pode abrir o OBS ou indicar reinício necessário: confirme essas mudanças no seu ambiente antes. O `device.name` deve corresponder ao nome exibido pelo OBS para o iPhone. **`take run --dry` ainda opera o aparelho de verdade**; somente `take validate` é verificação offline. Continue em [primeira demonstração](usage.md) e [CLI](cli.md). Para a entrada MCP existente, confira [`.mcp.json`](../.mcp.json) e [desenvolvimento](development.md); instruções específicas de agentes dependem de aprovação e não são fornecidas aqui. Nunca compartilhe a configuração local, vídeos, UDIDs ou material de assinatura num PR.
