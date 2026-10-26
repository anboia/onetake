# Migration: Contrarregra → OneTake

[← Installation](installation.md) · [Usage](usage.md) · [Development](development.md) · [Repository MCP configuration](../.mcp.json)

**OneTake** is the public name of the former Contrarregra project; the rename does not automatically migrate local files, keys, protocols, or certificates. Distribution remains source-based under [MIT](../LICENSE), with `package.json` marked `private: true` to prevent accidental publication to npm. Changing the checkout name or its GitHub visibility does not change your machine's configuration.

## What remains compatible

| Before | Now / status |
| --- | --- |
| `contrarregra` / `contrarregra-mcp` | Legacy entry points remain; prefer `./bin/onetake` / `./bin/onetake-mcp` for new workflows. The launchers use the same TypeScript code. |
| `~/.config/contrarregra/config.json` | Still read **only if** `~/.config/onetake/config.json` does not exist. |
| Keychain service `contrarregra`, account `OBS_WEBSOCKET_PASSWORD` | These remain unchanged: do not rename the item merely because the product is now called OneTake. |
| `ContrarregraKit`, `ContrarregraHost`, `ContrarregraRunner`, `Contrarregra.xcodeproj` | Internal Swift/Xcode names remain; `runner build` generates the `.xcodeproj` project. |
| `schema: contrarregra.choreography/1` and other `contrarregra.*/1` | Format/protocol identifiers remain valid; **do not** change the YAML to `onetake.choreography/1`. The current take record uses `contrarregra.demo-take/1`. |
| `CONTRARREGRA_*` in the runner session environment | These are still internal protocol names. `ONETAKE_*` variables are injected only by the build into XcodeGen; do not rename the runner variables. |
| Old cache/takes | They remain at the paths specified by your configuration; nothing moves or rewrites them. Keep historical files for reference without publishing them. |

Error messages and internal hints may still say `contrarregra`. This does not mean there is a separate new CLI. The [CLI reference](cli.md) lists only implemented commands; the MCP entry already exists in [`.mcp.json`](../.mcp.json). Agent-specific instructions are still pending approval.

## Choose whether to keep or migrate the local file

**Continue without changes:** if you already have `~/.config/contrarregra/config.json` and `~/.config/onetake/config.json` does not exist, the loader uses the old file. The signing baseline for future builds stays **beside that file**, at `~/.config/contrarregra/signing-baseline.json`. You do not need to rename the Keychain item or redo signing because of the public name. Before operating, check that `signing`, bundle IDs, and paths still match your machine.

**Migrate deliberately:** before creating `~/.config/onetake/config.json`, inspect the old configuration, the `paths.cache`/`paths.takes` directories, and the signing baseline **yourself, without sharing them**. Do not copy someone else's configuration. Back up `config.json` **and**, if present, `signing-baseline.json` outside the repository. Create the new directory and manually copy the old JSON into it **without overwriting an existing modern file**; do not replace your old file with `config/example.json` or use `mv` blindly. If you prefer to start from the example, follow [installation](installation.md) and enter your own details, recognizing that this is a new installation.

The loader selects **one file only**: if the modern file exists, it takes precedence and the legacy file is ignored, not merged with it. Each is merged separately with `config/defaults.json` (objects by key, arrays replaced). The CLI **does not offer `--config`** to select another file. An incomplete modern `config.json` can therefore silently change the team, paths, and device configured in the legacy file. Review `device.udid`, `device.coreDeviceId`, `device.name`, `signing.team`, `signing.identity`, `bundle.host`, `bundle.runnerTest`, `app.explore`, `apps.allowed`, `urls.allowedPrefixes`, `runner.privateAllowed`, `paths`, and `obs` **before any build or take**.

### Preserve the signing baseline

`runner build` uses `configDir` from the selected file to read/create **`signing-baseline.json` beside `config.json`**. Migrating only the JSON causes the build to look for `~/.config/onetake/signing-baseline.json` instead of the old baseline. After checking the files, **manually copy** the old baseline into the new directory beside the JSON, without overwriting anything; **keep the old copy** as a backup. Do not edit or generate a baseline by hand. If you change teams, certificates, or identities, investigate the discrepancy and obtain the responsible person's approval before deciding to replace anything; do not delete the baseline to “make it pass.”

There is a separate historical fallback: when the baseline is missing from the selected directory, `runner build` looks for a copy at **`paths.cache/signing-baseline.json`**; if found, it copies it into the configuration directory and leaves the old copy in the cache. But `paths.cache` may differ between the legacy and new installations: **do not rely on this fallback as a migration strategy**. A cache that macOS may clear is not a safe backup either. Preserve and check the copy beside the legacy file first.

If the baseline differs from Keychain or the certificate that signed the build, the operation fails closed (`reason: signing-baseline`). The build checks identities before and after Xcode and verifies the XCTRunner signature; `runner up` requires a verified build. Explicitly authorize signing changes without bypassing this check. The baseline file's schema is still `contrarregra.signing-baseline/1`.

## Paths, OBS, and versions when starting again

- `config/example.json` is a **template for new machines**, not a migration script: it suggests `~/Movies/onetake`, `~/Library/Caches/onetake`, and the OBS profile/collection/scene `OneTake`; without an override, the legacy defaults still point to `contrarregra`/`Contrarregra` paths and names. If you change `paths.cache`, builds, sessions, and the historical cache copy will not appear in the new location. If you change `paths.takes`, your old videos remain in the previous location. Retain/back up files manually; do not delete old material impulsively.
- `obs setup` creates/reconciles the profile and collection specified in the **selected file**; switching from `Contrarregra` to `OneTake` may create a separate OBS configuration. Check the active profile/collection and iPhone name before allowing changes. The `OBS_WEBSOCKET_PASSWORD` account remains under Keychain service **`contrarregra`**, regardless of the profile name.
- The Xcode project is generated from `ios/project.yml` with `ONETAKE_SIGNING_TEAM`, `ONETAKE_HOST_BUNDLE_ID`, and `ONETAKE_RUNNER_TEST_BUNDLE_ID` injected by `runner build`, derived from `signing.team`, `bundle.host`, and `bundle.runnerTest`. If you change bundle IDs or teams, confirm your own identity/provisioning before building; do not try to reuse artifacts from another team.
- OBS **31.1.2**, obs-websocket **5.6.2**, and ffmpeg/ffprobe **8.1.1** are the versions validated in the default configuration and checked during the respective operations. `brew upgrade` does not guarantee compatibility. Node must be **22.x ≥22.18**; see [installation](installation.md) for the full macOS, Xcode, XcodeGen, and iOS 26 requirements.

First run the **hardware-free** validation (`./bin/onetake take validate examples/first-take.choreo.yaml --json`) and the [development](development.md) checks. `npm test` uses local ffmpeg/ffprobe in some media tests but does not require a real iPhone or OBS. Only with the responsible person's consent, after reviewing paths, identity, device, and OBS profile, proceed to the [usage guide](usage.md). `take run --dry` is **not** a simulation: it still interacts with the iPhone.
