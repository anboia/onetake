# Development and architecture

[← Contributing](../CONTRIBUTING.md)

## Mental model

OneTake has two main processes: TypeScript tools on the Mac and an XCTest runner on the iPhone. OBS is a third process, controlled over WebSocket. The CLI and MCP are entry-point adapters; the operations live in shared modules.

| Path | Responsibility |
| --- | --- |
| `bin/` | Compatible Node selection and CLI/MCP entry points |
| `mac/src/cli/`, `mac/src/mcp/` | Argument parsing, registered tools, and output formatting |
| `mac/src/commands/` | Shared operations and argument/context validation |
| `mac/src/core/` | Types, schemas, errors, canonical JSON, and secrets |
| `mac/src/runner/`, `mac/src/usbmux/` | Sessions, builds, signing, USB transport, and reconnection |
| `mac/src/take/` | YAML validation, execution, checkpoints, locks, and manifest |
| `mac/src/obs/` | obs-websocket client and isolated profile/collection setup |
| `mac/src/media/`, `clock/`, `align/` | ffmpeg, OCR, clocks, and alignment primitives |
| `ios/ContrarregraKit/` | Foundation models and protocol, testable without a device |
| `ios/ContrarregraRunner/` | XCTest implementation, reads/actions, and device server |
| `ios/ContrarregraHost/` | Minimal host and calibration screen |
| `mac/test/fixtures/` | Protocol/artifact fixtures, some also consumed by Swift |

`ContrarregraKit`, the Xcode targets, and older schemas were not renamed for cosmetic reasons: an internal migration must account for installations, sessions, and fixtures. See [migration](migration.md).

## Environment

```sh
nvm install
nvm use
npm ci
```

Node 22.x ≥22.18 runs TypeScript through type stripping. No transpilation or bundling is required, and there is no `npm run build`. `tsconfig.json` uses `noEmit`, `strict`, `erasableSyntaxOnly`, ESM NodeNext, and `.ts` imports. Do not use syntax that requires JavaScript emission.

## Tests and checks

```sh
npm run typecheck
npm test
npm run docs:check
swift test --package-path ios/ContrarregraKit
git diff --check
```

- `npm test`: `node:test` with runner, usbmuxd, OBS, and Keychain fakes; not an end-to-end iPhone test.
- `typecheck`: checks TypeScript contracts without generating files.
- `docs:check`: checks relative links in public documentation, YAML examples, and public configuration; it does not check every external link or review historical content for privacy.
- `swift test`: tests the models and runner core on macOS; it does not validate real taps or signing.

To run a specific test:

```sh
node --test mac/test/take.choreo.test.ts
node --test mac/test/mcp.test.ts
```

Transport tests open local sockets, and media tests use ffmpeg/ffprobe **8.1.1** at the paths specified in `config/defaults.json`. Run them on a Mac with the supported runtime and those binaries installed; `npm ci` does not install them. CI installs ffmpeg through Homebrew and runs TypeScript/documentation checks and Swift checks in separate jobs. If Homebrew changes the version, the strict check will fail until compatibility is deliberately updated. Remote CI execution is only confirmed after an authorized push.

## Evolving a contract

1. Find the actual public registries: `cli/main.ts` and `mcp/server.ts`.
2. Reproduce the behavior with a failing test.
3. Change the core, avoiding duplicated CLI/MCP logic.
4. For JSON or protocol changes, update Zod, types, the Swift model, and shared fixtures.
5. Preserve nanosecond timestamps as decimal strings and the canonicalization used for hashes.
6. Update help, examples, `docs/cli.md`, and `docs/agents.md` where applicable. Public and collaboration documentation must be in English; leave historical notes in `spec/` and `spikes/` in their original language unless separately authorized. `docs/agents.md` is currently absent because its write was blocked; do not bypass that protection.
7. Run the tests; report anything that requires separate confirmation on physical hardware.

## Security and legacy code

Never bypass allowlists, secure-field blocking, human checkpoints, locks, or signing-identity checks to make a test pass. `PrivateXCT/` is the boundary for private APIs. Configuration must reject invalid inputs before opening a hardware connection or process.

`spec/constitution.md` contains the original decision model; the OneTake amendment distinguishes public rules from earlier personal choices. `spec/spec.md` includes planned features and **does not** override the implemented behavior when documenting usage. Keep architectural changes explicit, small, and reviewable.
