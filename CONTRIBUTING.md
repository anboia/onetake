# Contributing to OneTake

Thank you for helping make iPhone demos more reproducible. Documentation, clear bug reports and tests are just as useful as new features.

> Accepted contributions are distributed under the project's [MIT license](LICENSE). Only submit code you have the right to contribute under those terms. There is no CLA or implied transfer of ownership.

## Choose a contribution

- **Documentation:** make an instruction reproducible on a fresh Mac.
- **Bug report:** describe the expected result, the actual result and the smallest possible reproduction.
- **Test:** reproduce a problem with fakes or sanitized fixtures, without using a personal device.
- **Compatibility:** report macOS, Xcode, iOS, Node and OBS versions; do not include a UDID, serial number, tokens or signing identity.
- **Feature:** open an issue before changing the protocol, security, dependencies or architecture.

Use English for documentation, examples and contribution templates. Discussions and reports are welcome in English or Portuguese. Be specific and follow the [code of conduct](CODE_OF_CONDUCT.md). Report security vulnerabilities according to [SECURITY.md](SECURITY.md), not through public issues.

## Set up your environment

Fork the repository once it is public; until then, request access from the owner. Clone your copy, create a descriptively named branch and follow the [installation guide](docs/installation.md):

```sh
nvm install
nvm use
npm ci
git switch -c fix/short-description
npm run typecheck
npm test
swift test --package-path ios/ContrarregraKit
```

TypeScript checking and Swift model tests do not require signing or an iPhone. Operating the product requires macOS and the full setup. Do not run `runner up`, `obs setup` or a take just to validate a documentation change.

## Technical guidelines

1. **One change per PR.** Avoid unrelated file reorganizations and formatting changes.
2. **Test behavior before fixing it.** Show the test failing and then passing; use the existing `node:test` and XCTest frameworks.
3. **Keep the layers separate.** CLI/MCP adapt inputs; shared logic belongs in `mac/src/commands/` and the specialized modules.
4. **Preserve contracts.** JSON fields, `contrarregra.*/1` schemas, error codes and nanosecond integers represented as strings are not cosmetic details.
5. **No silent stack changes.** Justify new dependencies, version changes and private APIs; update the lockfile with npm.
6. **Security is not negotiable.** Preserve allowlists, human checkpoints, secure-field exclusions, ephemeral tokens and OBS profile isolation.
7. **Document what exists.** When changing an option or tool, update help text, examples and guides. An internal function does not imply a public command.

Use ESM imports with the `.ts` extension, `import type` where applicable, single quotes and semicolons in TypeScript. Follow the surrounding file's style in Swift. Write public documentation, identifiers and filenames in English. Historical specifications, research, spike reports and internal handoffs retain their original language. See the [development guide](docs/development.md).

## Using AI

AI-assisted contributions are welcome and carry the same review and testing responsibilities. Read the [development guide](docs/development.md); verify every generated symbol, library and command. Creation of `AGENTS.md`, `CLAUDE.md` and `docs/agents.md` is still pending write approval. Never provide personal data, recordings, secrets or signing files to a model.

In your PR, state where AI helped and which checks **you actually ran**. Do not present fabricated results, proposed tests or automated review as human approval.

## Before opening a pull request

- [ ] The change is small, with its rationale and reproduction described.
- [ ] `npm run typecheck`, `npm test` and `npm run docs:check` pass.
- [ ] `swift test --package-path ios/ContrarregraKit` was run when Swift, the protocol or the iOS project changed.
- [ ] New tests cover the change; outstanding hardware checks are explained.
- [ ] Examples, documentation and behavior agree.
- [ ] `git diff --check` passes; the diff contains no personal data, secrets or media.
- [ ] No local configuration, `.xctestrun`, certificate or build output is included.
- [ ] Breaking changes and risks are explained.

Use the PR template. Describe **what changed, why, how it was tested and what was not tested**. Wait for review and respond to comments with context. There is no guaranteed response time. The maintainer decides whether to merge; a passing check does not authorize publication or recording on someone else's device.
