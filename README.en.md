# OneTake

### Repeatable demos. Real iPhone. Your script.

**Describe a flow in YAML, run it on a physical iPhone and record it with OBS.** OneTake combines XCUITest automation, recording and human checkpoints. Its CLI runs demo scripts; its MCP server lets AI agents inspect the interface and help prepare them.

[Português](README.md) · [Installation](docs/installation.md) · [Usage](docs/usage.md) · [Contributing](CONTRIBUTING.md)

> **Experimental, source-only installation, licensed under [MIT](LICENSE).** This is a developer tool for macOS, not an App Store application. Setup requires Xcode and your own Apple development signing identity. No public npm package is maintained by this project. Detailed guides are currently in Portuguese; commands and identifiers are language-neutral.

## Why OneTake?

- Reuse scenes, selectors and checks instead of manually repeating every tap.
- Capture real-device demonstrations and inspect step results in `take.json`.
- Use AI through MCP to read the accessibility tree, inspect screenshots and test targets.
- Keep authentication, Face ID and sensitive decisions under human control.

The demonstrated app does not need a OneTake SDK. Its installed build stays separate from the XCTest runner and host app.

## Try without a phone

Install [nvm](https://github.com/nvm-sh/nvm#installing-and-updating), then:

```sh
git clone https://github.com/anboia/onetake.git
cd onetake
nvm install
nvm use
npm ci
./bin/onetake --help
./bin/onetake take validate examples/first-take.choreo.yaml --json
```

The example is a template, not a bundled demo app. Validation is offline and does not open OBS or control a device. Cloning the repository requires owner-granted access while it remains private.

**`take run --dry` is NOT a simulation:** it performs real iPhone actions without recording. Use `take validate` for a side-effect-free file check.

## Current capabilities

| Interface | Available |
| --- | --- |
| CLI | Runner lifecycle, OBS setup, choreography validation, take execution and pause control |
| MCP | `doctor`, `device_status`, `screenshot`, `ui_tree`, `tap` |
| Recording | OBS WebSocket v5, local recording and execution records |
| Testing | TypeScript and Swift tests using fakes/shared fixtures |

Recording requires a Mac, Node **22.x >=22.18**, Xcode with iOS 26 SDK, XcodeGen, your own signing configuration, a trusted USB-connected iPhone running iOS 26.x, OBS and ffmpeg. Initial operation targets Apple Silicon/Homebrew paths; read the [full requirements](docs/installation.md).

MCP cannot start recordings today. There is no supported Android/Windows/Linux operation or one-command public post-production pipeline. Historical specifications contain planned work, not shipped-feature guarantees. Read [status and limitations](docs/status.md).

## AI-ready context

The [MCP configuration](.mcp.json) connects the stdio launcher. [`llms.txt`](llms.txt) is a short documentation index. Repository-wide `AGENTS.md`, the Claude Code adapter and the detailed agent guide are pending authorized creation; use the [development guide](docs/development.md) in the meantime.

## Contribute safely

Read [CONTRIBUTING.md](CONTRIBUTING.md), [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) and [SECURITY.md](SECURITY.md). Documentation fixes, generic examples, regression tests and sanitized compatibility reports are useful starting points. Contributions must be compatible with the MIT license.

Never include personal recordings, credentials, certificates, real device identifiers or machine configuration in a PR. Small changes, real test results and clear limitations make review easier.

OneTake was previously named Contrarregra. Legacy launchers, Swift module names, protocol identifiers and the Keychain service remain where needed for compatibility. See [migration](docs/migration.md) and the [publication checklist](docs/publishing.md).
