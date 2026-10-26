# CLI reference

[← Usage](usage.md)

Run `./bin/onetake` from the checkout root, or add `bin/` to your `PATH` to use `onetake`. The legacy `contrarregra` launcher remains an alias.

`--help` shows the interface that is actually implemented. `--json` provides structured output for valid commands; progress and error messages use stderr. Exit codes: **0** success, **1** operational or validation failure, **2** invalid usage. Argument errors are not guaranteed to have a JSON envelope.

| Command | Effect |
| --- | --- |
| `runner build [--configuration Spike]` | Generates the project, builds it, and checks signing; defaults to Debug |
| `runner up [--spike [--bind loopback\|endpoint]]` | Installs and starts an XCTest session; `--bind` is only for Spike |
| `runner down` | Ends the session and removes ephemeral session artifacts |
| `runner status` | Queries session and transport state |
| `runner sever --for <seconds>` | Test hook that temporarily interrupts transport; do not use during an important take |
| `obs setup` | Creates or reconciles the configured OBS profile, collection, scene, and source |
| `take validate <choreo.yaml>` | Local validation, without iPhone or OBS |
| `take run <choreo.yaml>` | Performs real actions and records with OBS |
| `take control <takeDir> resume\|retry\|skip\|abort` | Sends a control command to an in-progress take |

## `take run` options

| Option | Meaning / caveat |
| --- | --- |
| `--dry` | Operates the iPhone without recording; **not** offline or read-only |
| `--scenes s01,s02` | Runs only the selected scenes |
| `--from <stepId\|sceneId>` | Starts at the selected point without reconstructing prior state |
| `--until <stepId>` | Ends the selected segment at the indicated step |
| `--voice <voice.json>` | Uses a previously prepared voice-timing file |
| `--pause-recording-at <checkpointId>[,…]` | Pauses OBS at these checkpoints; may conflict with a requirement for continuous video |
| `--no-prepare` | Skips preparation; the operator is responsible for the initial state |
| `--no-cleanup` | Skips cleanup; the operator is responsible for restoring the state |
| `--json` | Returns a structured summary; progress goes to stderr |

The current CLI has no `onetake doctor`, `onetake screenshot`, `onetake ui tree`, `onetake take status`, `onetake init`, `onetake sync`, or `onetake post`. Diagnostics and exploration are available through the MCP server; its [tool registry](../mac/src/mcp/server.ts) defines that interface. Detailed take state is in the `take.json` file returned by the run.

## Output formats

`take validate`: `ok`, `file`, `sha256`, `errors`, `warnings`, `scenes`, `steps`.

`take run`: a summary containing status, scenes and steps, recording, `takeJson`, and cleanup warnings. See the definitions in [`mac/src/take/run.ts`](../mac/src/take/run.ts) and [`mac/src/take/manifest.ts`](../mac/src/take/manifest.ts); do not assume that the current executor emits every object described in `spec/`.

Known operational errors: `{ "error": { "code": "E_…", "message": "…", "data": {} } }`. Treat the code as the contract and the message as a human-readable diagnostic. A run error may also appear in the take summary with a failure status.
