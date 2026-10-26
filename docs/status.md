# Product status and limitations

[← README](../README.md)

OneTake is under development, with manifest version `0.0.0`. The original demo informed some of the implementation; that does not make its app-specific workflow a generally validated installation for every device.

## Implemented

- CLI: `runner build/up/down/status/sever`, `obs setup`, `take validate/run/control`.
- MCP stdio: `doctor`, `device_status`, `screenshot`, `ui_tree`, `tap`.
- XCUITest runner, USB transport, authenticated session, and concurrency control.
- Execution of a validated subset of choreographies, conditions, and checkpoints.
- OBS recording and `take.json` manifest; disk checks and cleanup warnings.
- Local tests with fakes and shared TypeScript/Swift fixtures.

## Not available as a stable public workflow

- Android, Windows/Linux operation, or simulator recording as a substitute for a physical device.
- Installation via a public npm package, a dedicated Homebrew formula, or a distributed macOS app.
- MCP commands for recording, post-production, or full runner administration.
- `choreo compile`, `take status`, `sync calibrate`, `post`, and other commands described in older specifications but not registered in the CLI.
- An automatic guarantee of ±100 ms audiovisual alignment or App Review approval.
- Unrestricted compatibility with screen sizes, future XCTest versions, or all Intel Macs. The MCP screenshot response still uses the fixed size 390×844; check its suitability before using coordinates on another device.
- Built-in voice-track generation by `take run --voice`: that option consumes existing timing data.

## Important constraints

`--dry` is a real rehearsal without OBS. The app and its data may change. Use `take validate` for side-effect-free validation.

The executor rejects specification actions it does not implement; `repeat`, `press`, and `app launch` are not part of the supported take subset. `openURL` is allowed only during preparation or cleanup. Top-level `device`, `guide`, and `confirm` fields may trigger limitation warnings; they do not replace human checks.

Private XCTest APIs are isolated but fragile. Enabling them requires explicit review and approval. Keeping `runner.privateAllowed` empty is the conservative default; do not promise that every script will work that way.

## Contribution priorities

1. Reproducible installation on another Mac/device, with a report free of personal identifiers.
2. Small examples independent of the original app, with tests for the documented workflows.
3. Clearer configuration and compatibility diagnostics.
4. Expansion of the MCP interface and post-production, subject to design and testing.

This is a suggested order for discussion, not a schedule commitment.

## Historical documents

`spec/`, `spikes/`, `.claude/handoffs/`, and `choreographies/hagah/` preserve earlier context. They may contain old names, operational data, and author-specific decisions. They are not the public tutorial and need the privacy review described in [publishing](publishing.md). No historical record has been automatically removed or rewritten to conceal this outstanding review.
