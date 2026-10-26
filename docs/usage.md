# First demo

[← README](../README.md) · [Installation](installation.md) · [CLI reference](cli.md)

## 1. Understand the choreography

A **choreography** is a YAML file describing the app, expected device, reusable targets, and scenes. A **take** is one execution of that choreography. A **checkpoint** is a condition that must be met, possibly with human assistance.

Start with [`examples/first-take.choreo.yaml`](../examples/first-take.choreo.yaml). Replace `com.example.demo`, the icon name, expected version, device characteristics, and `Continue` button with values observed in your app. The example app is not included in the project.

- `targets`: a catalog of reusable selectors, such as a button selected by its label.
- `prepare`: actions before recording.
- `scenes`: scenes with IDs `s01`, `s02`, etc., and lists of steps.
- `cleanup`: actions after recording, when execution can finish normally.

The `contrarregra.choreography/1` identifier is the current compatibility format; **do not** change it to `onetake.choreography/1`.

## 2. Validate without hardware

```sh
./bin/onetake take validate examples/first-take.choreo.yaml --json
```

Expect `ok: true` and an empty `errors` list. This checks the format and the implemented subset of actions, not whether the app or button exists on the iPhone. Read any `warnings`: some fields in the specification do not yet affect execution.

## 3. Prepare the real session

Complete [installation](installation.md) before running these commands. They are **not** a simulation:

```sh
./bin/onetake runner build
./bin/onetake runner up
./bin/onetake runner status --json
```

`runner build` uses Apple code signing and may request provisioning. `runner up` installs/starts the test runner on the device and may change the foreground app. The first installation and every new build require the device owner's consent. Do not run these commands during another take.

Open the target app manually, complete logins yourself, and leave the choreography's starting screen ready. Do not give the runner your password, Apple ID, unlock code, or verification code.

To locate targets, use the MCP server configured in [`.mcp.json`](../.mcp.json): `ui_tree` for labels/identifiers; `screenshot` when you need the image. The tree's `@eN` references are temporary and cannot be saved in choreographies. Use catalog names, such as `{ref: continueButton}`, associated with stable selectors.

## 4. Rehearse without recording

```sh
./bin/onetake take run examples/first-take.choreo.yaml --dry
```

> **`--dry` interacts with the real iPhone.** It runs preparation, scenes, and cleanup; it only skips OBS recording. It can change state, send data, or trigger purchases if the choreography touches those controls. Review every step and use test accounts/data.

The executor requires the runner and an app that is already installed. This command has no built-in simulator.

## 5. Record

Configure OBS as described in the installation guide. `obs setup` changes a dedicated profile/collection: approve that change before running it.

```sh
./bin/onetake obs setup
./bin/onetake take run examples/first-take.choreo.yaml --json
```

Keep the terminal open: the take runs in the foreground, not through a job service. The result includes `status`, step results, the video location when recording occurs, and the path to `take.json`. Use **the returned paths**, not an assumed directory or filename.

When the take ends, watch the entire video, check framing, audio, and personal data, and read `take.json`. `finished` does not mean editorial approval or automatic compliance with App Review requirements. Nothing is published automatically.

## 6. Respond to pauses

When the take reports the directory and reason for a pause, use a second terminal:

```sh
./bin/onetake take control /returned/path/to/take resume
```

The path above is a placeholder: replace it with the actual directory. Available operations are `resume`, `retry`, `skip`, and `abort`. The first three require a pause; `abort` requests termination. `retry` may repeat an action with external effects and `skip` may invalidate the evidence: decide deliberately, and do not retry purchases or submissions blindly.

To end the session after the take:

```sh
./bin/onetake runner down
```

If the take is interrupted, check the `cleanupPending` and `airplaneMaybeOn` warnings; restore the device's state manually when necessary. Do not remove lock files to force access without investigating the process that owns them.

## Select scenes and ranges

```sh
./bin/onetake take run examples/first-take.choreo.yaml --dry --scenes s01
./bin/onetake take run examples/first-take.choreo.yaml --dry --from s01.ready --until s01.hold
```

Use these options for development. Starting partway through does not automatically reconstruct the state of previous scenes. `--no-prepare`, `--no-cleanup`, and recording pauses are advanced options; see the [CLI reference](cli.md).

## Voiceover and post-production

The `--voice` option consumes an existing voice-timing file. It is not a public voiceover generator. Scripts in `spikes/demo/` are experiments tied to the original demonstration, not a stable interface or a general-purpose tutorial. Current capture does not automatically establish audiovisual synchronization within ±100 ms. See [limitations](status.md).
