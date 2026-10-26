# Installing OneTake

[← README](../README.md) · [First demo](usage.md) · [Development](development.md) · [Repository MCP configuration](../.mcp.json)

Installation is **from source** on macOS. `package.json` sets `private: true`: there is no public npm package for this project; the code is licensed under [MIT](../LICENSE). The operational setup was prepared for Apple Silicon with Homebrew in `/opt/homebrew`. You do not need an iPhone, code signing, or OBS to validate a choreography.

## 1. Requirements for operating a physical iPhone

- A Mac with **Xcode 26 and the iOS 26 SDK**, command-line tools pointing to that Xcode, an Apple developer account configured in Xcode, and an **Apple Development** identity installed in Keychain. The reference toolchain in `config/defaults.json` records Xcode **26.6 (17F113)** and macOS **26.5.x**; other versions require your own verification and are not guaranteed to be compatible.
- **XcodeGen ≥ 2.45.4**, as specified in `ios/project.yml`, at the path used by the runner: `/opt/homebrew/bin/xcodegen`. Do not generate the project manually without supplying the signing variables; use `runner build`.
- A **physical iPhone running iOS 26.x**, with Developer Mode enabled, trusting this Mac, unlocked, and connected by **USB cable**; you must install the target app yourself. A simulator is not a substitute for physical capture.
- **Node 22.x ≥ 22.18** (Node 23+ is not accepted), npm, and preferably nvm. `./bin/onetake` selects a compatible Node from nvm or the `PATH` and rejects other major versions.
- **OBS Studio 31.1.2** with **obs-websocket 5.6.2** and **ffmpeg + ffprobe 8.1.1** are the versions recorded in `toolchain.validated`. The OBS client checks the exact versions and WebSocket capabilities; the media module checks the exact versions of both binaries. These are compatibility reference versions, **not** a promise that the latest available versions will work.

Install Xcode and the iOS SDK through Apple's distribution channels; select the correct Xcode in the Command Line Tools preferences. For XcodeGen and ffmpeg, you can use Homebrew, for example with `brew install xcodegen ffmpeg`; for OBS, use `brew install --cask obs`. **These commands install the versions currently distributed, not pinned versions 2.45.4, 8.1.1, or 31.1.2**. Check the resulting versions before operating; if they differ, obtain compatible releases from their distributors and validate them on your machine. Do not change `toolchain.validated` to hide an incompatibility. If you install binaries elsewhere (including on Intel), adjust the absolute `paths.ffmpeg` and `paths.ffprobe` paths in your configuration; the runner's XcodeGen path is fixed at `/opt/homebrew/bin/xcodegen`. The media test suite uses the ffmpeg/ffprobe defaults in `/opt/homebrew/opt/ffmpeg/bin` directly and asserts that path: changing only your local configuration does not make `npm test` portable to another layout.

Manual tool checks that do not start a build, OBS, or a device:

```sh
node --version
xcodebuild -version
xcrun --sdk iphoneos --show-sdk-version
/opt/homebrew/bin/xcodegen --version
/opt/homebrew/opt/ffmpeg/bin/ffmpeg -version
/opt/homebrew/opt/ffmpeg/bin/ffprobe -version
```

Check the OBS and obs-websocket versions in the OBS interface; do not assume Homebrew retained a particular version. The commands using Homebrew paths above apply only if those binaries were installed there.

## 2. Install dependencies and validate without hardware

After installing [nvm](https://github.com/nvm-sh/nvm#installing-and-updating), run from the checkout root:

```sh
git clone https://github.com/anboia/onetake.git
cd onetake
nvm install
nvm use
npm ci
./bin/onetake --help
./bin/onetake take validate examples/first-take.choreo.yaml --json
```

If you have already cloned the repository, go to its root and start with `nvm install`. Cloning may require permission while the repository is not public. `.nvmrc` requests Node 22 and `package.json` requires `>=22.18 <23`. The CLI runs `.ts` files directly, without `npm run build`. `take validate` only validates the example YAML; the `com.example.demo` app is not included in the project.

For contributors, device-free tests also include ffmpeg media tests; they **require ffmpeg/ffprobe 8.1.1 at the configured paths**, even without an iPhone, code signing, or OBS:

```sh
npm run typecheck
npm test
npm run docs:check
swift test --package-path ios/ContrarregraKit
```

`npm test` includes `mac/test/align.test.ts`, which creates temporary synthetic videos with ffmpeg. See [development](development.md) for the scope of these checks.

## 3. Configure your machine (without committing personal data)

Create a new file **without overwriting** an existing configuration:

```sh
mkdir -p "$HOME/.config/onetake"
cp -n config/example.json "$HOME/.config/onetake/config.json"
```

**Before copying**, if `~/.config/contrarregra/config.json` already exists, read [migration](migration.md): creating the new file causes the old one to stop being used. Edit `~/.config/onetake/config.json` outside the repository; do not put real data in `config/defaults.json` or `config/example.json`. Objects in the local configuration are merged with `config/defaults.json`; arrays replace the default arrays. Fill in your own values for:

- `device.udid`: the iPhone's UDID; `device.coreDeviceId`: the identifier shown by CoreDevice; `device.name`: **the iPhone source name shown in OBS**. You can look up the device manually in Xcode → Devices and Simulators or with `xcrun devicectl list devices`; do not copy someone else's identifiers.
- `signing.team`: a **10-character A–Z/0–9** Apple Team ID; `signing.identity`: the **exact** name of an installed identity belonging to the chosen team, in the format `Apple Development: Name (IDENTIFIER)`. Do not infer the identifier in parentheses from the Team ID: copy the full name of the existing identity. Its owner can check it manually in Xcode/Keychain or with `security find-identity -v -p codesigning` (this lists local identities; do not share the output). Do not put a password, private key, or certificate in the JSON.
- `bundle.host` and `bundle.runnerTest`: your own valid, **distinct** DNS identifiers for the host and test bundle; replace both `com.example.*` values. The app to be demonstrated is **a separate app**: set `app.explore` to the bundle ID of your installed app, and adapt the choreography YAML.
- `apps.allowed` and `urls.allowedPrefixes`: only additional apps and URL prefixes authorized for your session. Leave `runner.privateAllowed` empty unless you understand and authorize a private capability. Also review `paths.takes`, `paths.cache`, both absolute ffmpeg/ffprobe paths, and `obs.profile`, `obs.collection`, `obs.scene` to avoid using someone else's destinations.

`loadConfig` accepts empty fields for local inspection, but `runner build` **rejects** invalid team, identity, and bundle IDs before calling XcodeGen. The build injects `ONETAKE_SIGNING_TEAM`, `ONETAKE_HOST_BUNDLE_ID`, and `ONETAKE_RUNNER_TEST_BUNDLE_ID` from your configuration into `ios/project.yml`; you do not need to export them in the terminal. The public CLI **does not offer `--config`**: its default path is `~/.config/onetake/config.json`, with a fallback to `~/.config/contrarregra/config.json` only when the first file does not exist.

## 4. Set up the OBS password in Keychain yourself

In OBS, open **Tools → WebSocket Server Settings**; enable the server and authentication, choose a strong password, and keep the port consistent with `obs.url` (default `ws://127.0.0.1:4455`). In the macOS **Keychain Access** app, create an application/generic password item with **service/name `contrarregra`**, **account `OBS_WEBSOCKET_PASSWORD`**, and the **same password**. Check the item's attributes in the interface before closing it. The account name can be changed via `secrets.obsPassword`, but the legacy service remains `contrarregra` in the code.

Never pass the password as a command argument or put it in JSON, `.env`, an issue, a prompt, or a log. OneTake retrieves it from Keychain when connecting; if it is missing, it returns `E_SECRET_MISSING`. Disable the WebSocket server when you are not recording, and consider the network reach configured in OBS as well as the password.

## 5. First operation — only with the owner's consent

With the iPhone prepared and your configuration reviewed, `runner build` runs XcodeGen and Xcode, may generate provisioning, and rechecks code signing; `runner up` installs/starts the runner on the device. **Do not run these commands just to test the documentation.** The signing baseline is stored beside the selected `config.json`; if you had a previous installation, read [migration](migration.md) before building.

```sh
./bin/onetake runner build
./bin/onetake runner up
./bin/onetake runner status --json
```

To record, `./bin/onetake obs setup` creates or reconciles the configured profile/collection and may open OBS or indicate that a restart is needed: approve these changes in your environment first. `device.name` must match the name OBS shows for the iPhone. **`take run --dry` still operates the real device**; only `take validate` is an offline check. Continue with the [first demo](usage.md) and [CLI reference](cli.md). For the existing MCP entry, see [`.mcp.json`](../.mcp.json) and [development](development.md); agent-specific instructions are pending approval and are not provided here. Never share your local configuration, videos, UDIDs, or signing material in a PR.
