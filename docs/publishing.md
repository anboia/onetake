# Maintainer checklist: publishing on GitHub

[← README](../README.md)

File preparation does not itself authorize a commit, push, visibility change, video upload, or history rewrite. Obtain explicit authorization for each publication action.

## Blockers before making the repository public

- [x] **License:** The owner chose MIT, recorded in `LICENSE`, the manifest, and contribution guides. Preserve third-party attributions.
- [ ] **History privacy:** Review the entire history, including `.claude/handoffs/`, `spec/`, `spikes/`, and the original app's choreography. It contains personal and operational context that must not be published automatically.
- [ ] **Scanner triage:** Gitleaks 8.30.1 was run over 61 commits (`--all`, values redacted) and flagged 9 `generic-api-key` occurrences in tests/fixtures. They still need triage: being in a test does not prove a value is fake. Revoke or rotate any real secret first. The scan does not replace a personal-data review or guarantee that unknown secrets are absent.
- [ ] **Demo material:** Obtain permission before reusing an app name, video, audio, screens, third-party data, or delivery links. Do not publish the existing recording just because a URL is accessible.
- [ ] **Protected agent instructions:** Writes to `AGENTS.md`, `CLAUDE.md`, and `docs/agents.md` were blocked when security approval expired, even after the owner authorized another attempt. These files remain absent; do not promise automatic discovery of them or bypass the protection by other means.
- [ ] **Migration review:** Check for defaults free of personal identifiers, explicit user configuration, and compatibility with older installations.

`.gitignore` does not remove files already tracked by Git. Decide with the owner whether to review the existing repository history or create a separate initial public repository. Do not use `git filter-repo`, force-push, or delete files/history without explicit authorization.

## Local validation

```sh
nvm use
npm ci
npm run typecheck
npm test
npm run docs:check
swift test --package-path ios/ContrarregraKit
npm audit
git diff --check
git status --short
```

Also install from a clean checkout and test on an authorized device, checking signing, transport, OBS, and video. Tests with fakes do not establish this. Do not automatically generate a certificate to work around a failure.

## GitHub setup — apply only with authorization

- **Name:** `onetake`; product name **OneTake**.
- **Suggested description:** `Repeatable iPhone demos with XCUITest, YAML and OBS. CLI + MCP for macOS.`
- **Suggested topics:** `ios`, `iphone`, `xcuitest`, `obs-studio`, `mcp`, `automation`, `developer-tools`, `demo`.
- Enable Issues; use the checked-in issue forms and PR template.
- Enable **private vulnerability reporting**, Dependabot alerts, and secret scanning/push protection where available.
- Configure main-branch protection/rulesets: checks `TypeScript and docs` and `Swift models`, review before merge, and blocks on force-push and deletion. Confirm the check names after the first actual run.
- Review GitHub Actions permissions; the checked-in workflows use `contents: read` and do not access production secrets.
- Check **Insights → Community Standards** and MIT license detection after a push.
- Only after an authorized push, confirm remote CI execution and README/link rendering.

## Public presentation

The first screen should explain the problem, benefit, audience, and limitations; the current README does this without relying on private video. After demo material is approved, add a short captioned clip with test data and a clear link. Do not fabricate screenshots or CI, download, or popularity badges.

Keep the quick path **validate without hardware → configure deliberately → run**. Maintain public and collaboration documentation in English; preserve historical notes in `spec/` and `spikes/` in their original language pending a separate scope decision. Use relative documentation links so forks and other branches remain navigable.

## First release

There is no promise of a published npm package or distributed binary. `private: true` remains in the manifest while installation is from source. Before a release, choose a version, write notes about actual features and limitations, run the check matrix, and publish only with the owner's approval. A tag does not make planned features in `spec/` available.
