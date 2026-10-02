# mac_stack: Mac-side stack for Contrarregra: TypeScript/Node 22 CLI + MCP server for Claude Code, native usbmuxd transport, runner protocol, Keychain, device-project generation, tests, alerts, disk checks

## SUMMARY
Build the MCP server on the MCP TypeScript SDK v2, not v1. The package is @modelcontextprotocol/server 2.3.0, published 2026-10-02; v2 has been the stable line since 2026-07-27. It is Apache-2.0 and pulls in only @modelcontextprotocol/core and zod 4. Its serveStdio(factory) serves both older (2025) clients and current (2026-07-28) clients from the same code, and the installed Claude Code (2.1.280) already speaks both.

Claude Code imposes several limits:
- **Text:** tool descriptions and server instructions are cut at 2,048 characters, and MCP tools are hidden until searched for (tool search).
- **Long text results:** results over about 50,000 characters are saved to a file, unless the tool sets _meta["anthropic/maxResultSizeChars"] (maximum 500,000).
- **Images:** they still count toward MAX_MCP_OUTPUT_TOKENS (25,000), are shrunk to at most 2,000 px per side, and the original bytes are also saved to disk. Screenshots should be JPEGs at point resolution: 390x844 on the iPhone 12, so the image coordinates are the same numbers XCUITest uses.
- **Long calls:** a call still running after 2 minutes is moved to the background, and a stdio call with no progress for 30 minutes is aborted. MCP "tasks" are deprecated in SDK v2.

So a 10-minute take should use take_start/take_wait/take_status/take_abort, backed by a detached supervisor process that writes to a run directory.

I checked the usbmuxd protocol in libusbmuxd, go-ios and appium-ios-device, and ran a ListDevices query on this Mac. It took 4.9 ms and came back as an XML plist with an empty DeviceList while the iPhone was on Wi-Fi only. So, as of today, usbmuxd on macOS 26.5.2 does not list the Wi-Fi-only phone as "Network". Contrarregra must still accept only ConnectionType "USB". No maintained npm library fits: appium-ios-device has no Listen command (no plug/unplug events) and depends on @appium/support, which has 24 dependencies. A native TypeScript client of about 250 lines is the right size.

For the Mac-to-runner protocol, WebSocket with JSON-RPC 2.0 beats HTTP because the runner needs to push events (checkpoint reached, step done):
- **iPhone side:** NWListener with NWProtocolWebSocket, bound to loopback. PeerTalk listens on 127.0.0.1 on the device and is reached through usbmuxd, so there is precedent. Apple's TN3179 says listening for TCP needs no Local Network permission, while Bonjour does, so no Bonjour.
- **Mac side:** Node's built-in WebSocket client (stable since 22.4) cannot use an already-open socket, and Node has no WebSocket server. The Mac needs a small in-process forwarder on 127.0.0.1.

Node 22.19 runs .ts files directly: type stripping is on by default since 22.18, and I confirmed it here. So the whole stack can run with no build step and almost no dependencies: node:test, util.parseArgs, fs.statfs, the built-in WebSocket, and the security/say/afplay/osascript commands.

On the iPhone side, SwiftPM cannot define UI-test bundles; I confirmed this in Xcode 26.6's PackageDescription. XcodeGen 2.45.4 is installed and supports bundle.ui-testing and synced folders. Xcode names the runner app after the test target's bundle id plus ".xctrunner".

I found these problems on this machine:
- Only 11.1 GB of disk is free.
- There are two Node installs: nvm 22.19 and Homebrew 26.0.0.
- BlackHole, Multi-Output and Aggregate audio devices exist, so alert sounds could leak into the recording.
- osascript notifications are reported as not showing on macOS Tahoe.
- Claude Code 2.1.280 is missing the 2.1.283 fixes for MCP images and progress.
- The Keychain item contrarregra/OBS_WEBSOCKET_PASSWORD does not exist yet (security exits with 44).

## RISKS
- [high] The runner's loopback-bound NWListener (WebSocket) is not reachable through usbmux Connect on iOS 26.3, or the tunnel drops when airplane mode is toggled mid-take (scene 9).
  why: The evidence is PeerTalk (pre-iOS 17) and Appium's legacy usbmux forwarder; nobody documents a loopback-only Network.framework listener behind usbmux on iOS 26, nor usbmux behaviour across airplane-mode toggles.
  spike: Minimal runner (UI-test method holding a run loop) with NWListener + NWProtocolWebSocket on port P under three bindings: requiredInterfaceType=.loopback, requiredLocalEndpoint=127.0.0.1:P, and any-interface. From Node: usbmux ListDevices (USB entry) -> Connect(DeviceID, htons(P)) -> in-process forwarder -> global WebSocket -> JSON-RPC ping at 10 Hz for 10 min while toggling airplane mode on/off 5 times from Control Center. Log RTT and gaps.
  success: Handshake succeeds for the loopback binding; 0 disconnects over 10 min and 5 airplane toggles; p99 RTT <= 20 ms; max gap between pongs <= 250 ms.
  planB: Bind any interface but reject non-loopback remote endpoints in newConnectionHandler, and never set listener.service. If usbmux fails entirely, use the CoreDevice tunnel (devicectl / RSD) over the cable, then iproxy/go-ios forward as an external binary; Wi-Fi only as a last resort with the take moved away from scene 9.
- [high] Not enough disk for recordings plus Claude Code tool-result and MCP-log copies of screenshots (11.1 GB free today, 95% used).
  why: The owner has already run out of space three times. OBS at native 1170x2532 H.264 for a 10+ minute take is likely 1.5-3 GB, retakes multiply that, and every inline screenshot is stored again in ~/.claude/projects and in the MCP logs.
  spike: Record 60 s in OBS with the chosen settings and measure bytes/min. Take 100 screenshots through the MCP tool and measure the growth of ~/.claude/projects/*/tool-results and ~/Library/Caches/claude-cli-nodejs/*/mcp-logs-contrarregra.
  success: Preflight (fs.promises.statfs on ~/Movies/contrarregra, bavail*bsize) refuses to start when free < max(minFreeGB, 2 x bytesPerMin x plannedMinutes). A full 10-scene take fits with >= 5 GB left. 100 screenshots add < 50 MB.
  planB: Record to an external SSD path from config. Lower the bitrate or fps. Return screenshots as file paths (resource_link/text) instead of inline images when Claude doesn't need to see them. Run a cleanup command that prunes old runs.
- [medium] Screenshot tool results are too big, get resized inconsistently, or break coordinate mapping in Claude Code.
  why: Images still count toward MAX_MCP_OUTPUT_TOKENS (25k) even with maxResultSizeChars. Claude Code caps images at 2000 px per side, and once a request has more than 20 images the API rejects any over 2000 px. The full iPhone 12 screenshot is 1170x2532.
  spike: Return the same screen at 390x844 JPEG q0.8 and at 1170x2532 PNG. Ask Claude to give tap coordinates for five known elements, compare with the XCUI frames, and check payload size and warnings.
  success: At 390x844 the mean coordinate error is <= 10 pt and every target is tapped correctly. Payload is <= 150 KB per screenshot. No output-limit warnings across a 40-screenshot session.
  planB: Pair every screenshot with the compact accessibility tree (labels + frames in points) so Claude chooses by label. Provide a `zoom` tool that crops a region at native scale. Fall back to Vision OCR on the device.
- [medium] Driving a 10+ minute take through MCP fails: idle-timeout aborts, auto-backgrounding loses progress, or the MCP process restarts mid-take and orphans the OBS recording.
  why: Stdio idle window is 30 min. Calls are auto-backgrounded after 2 min. Progress retention for backgrounded calls arrived only in 2.1.283 (2.1.280 is installed). /mcp reconnect or session end kills the stdio child.
  spike: Implement take_start (spawns a detached supervisor writing runs/<id>/status.json and events.ndjson) + take_wait (long-poll <= 55 s). Dry-run 15 minutes on the simulator with 3 simulated checkpoints, and kill the MCP server once mid-run.
  success: No timeout errors. Claude sees every checkpoint within <= 2 s of its emission. After an MCP restart take_status reattaches to the same run, and the recording is stopped exactly once.
  planB: Run takes from the CLI via Bash in the background (`contrarregra take run --detach`) and have MCP only read the status files. Set CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS=0 only for interactive debugging.
- [medium] Claude Code launches the MCP server with the wrong Node (Homebrew v26.0.0 instead of nvm v22.19) or none at all, depending on how Claude Code was started.
  why: Two Node installs. An .mcp.json 'command': 'node' depends on the PATH Claude Code inherited, and GUI apps don't load nvm.
  spike: At server startup log process.execPath and process.version to stderr and expose them in a `doctor` tool. Start the server from the terminal CLI and from the desktop app, then check `claude mcp get contrarregra`.
  success: The server connects in both launch modes and reports Node >= 22.18. A server started on an unsupported version exits within 1 s with a clear stderr message.
  planB: Use 'command': '${CONTRARREGRA_NODE:-node}', or a committed POSIX shim bin/contrarregra-mcp that resolves Node (nvm alias or /opt/homebrew/bin/node) and execs it. Support Node 22.18+ and 26.
- [medium] Mac alert sounds leak into the recorded audio, or the owner never sees or hears the checkpoint alert.
  why: BlackHole 2ch, Multi-Output and Aggregate devices exist. afplay plays to the default output and can't pick a device. osascript notifications are reported as not showing on Tahoe.
  spike: Start an OBS test recording with the planned audio sources. Trigger afplay Glass, `say -a 'MacBook Air Speakers' -v Luciana ...` and an osascript notification. Measure the recorded audio level during each alert and note what the owner perceived.
  success: The recorded track stays below -60 dBFS (noise floor) during the alerts. The owner hears the alert within 1 s, and the notification is visible or at least the sound plays.
  planB: Use only `say -a <speakers>` during takes. Configure OBS to capture only the iPhone capture device's audio. Add an osascript `display dialog ... giving up after N` for blocking acknowledgements, and surface checkpoints in the take_wait results.
- [medium] The Keychain read blocks on a GUI consent prompt or a locked keychain while the MCP server runs headless.
  why: `security` is trusted only for items it created. An item made in Keychain Access, or a locked login keychain after sleep or reboot, can pop a dialog and hang the call.
  spike: Owner runs `security add-generic-password -s contrarregra -a OBS_WEBSOCKET_PASSWORD -U -w`. Then read it from Node via execFile with a 5 s timeout, after a fresh boot and after sleep.
  success: The read returns exit 0 in < 500 ms with no GUI prompt. A missing item maps to exit 44 and a message naming the add command. The secret never appears in logs or tool results (grep the logs for it).
  planB: On timeout, abort with instructions to unlock the keychain (`security unlock-keychain`) or recreate the item with the CLI. Never fall back to env vars or files (constitution).
- [medium] Automatic signing of the UI-test runner selects the wrong team or fails to create the .xctrunner App ID/profile.
  why: The keychain holds certificates from other teams (59CB45686C, V4397KJVXZ, a third-party Apple Distribution). The .xctrunner id is derived, and an API key needs a role allowed to manage certificates and profiles.
  spike: `xcodegen generate` then `xcodebuild build-for-testing ... -destination 'generic/platform=iOS' -allowProvisioningUpdates DEVELOPMENT_TEAM=984PNJZ8B9 CODE_SIGN_STYLE=Automatic`. Inspect `codesign -dv --verbose=4` on ContrarregraRunner-Runner.app and the embedded profile.
  success: Exit 0. Exactly one *.xctestrun is produced. TeamIdentifier=984PNJZ8B9 and CFBundleIdentifier=app.kifactory.contrarregra.runner.xctrunner. The profile includes UDID 00008101-001E79203A68001E.
  planB: Add -authenticationKeyPath/-authenticationKeyID/-authenticationKeyIssuerID (key from the owner, referenced by path only). If that fails, use manual signing with an explicit development profile for app.kifactory.contrarregra.runner.xctrunner.
- [low] usbmuxd lists the iPhone twice (USB + Network) or reports a SerialNumber format different from the configured UDID, so the tool picks the wrong transport.
  why: libusbmuxd normalizes 24-char serials by inserting a hyphen, and macOS may expose Wi-Fi-synced devices as 'Network'. Today the Wi-Fi-only device was not listed at all.
  spike: With the cable plugged in and Wi-Fi on, run ListDevices and Listen. Unplug and replug, enable and disable Finder Wi-Fi sync, and record every entry's ConnectionType and SerialNumber.
  success: Exactly one entry with ConnectionType 'USB' matches the normalized UDID. Detached/Attached events arrive within 2 s of unplugging and replugging. The tool refuses to run when only a Network entry exists.
  planB: Match on the normalized SerialNumber plus ConnectionType 'USB' plus ProductID. Cross-check with devicectl's transportType ('wired') before starting a take.
- [low] MCP SDK v2 churn: a breaking change, or a mismatch with the protocol era Claude Code negotiates over stdio.
  why: v2.0.0 is two months old with a release every few days (2.1.0, 2.2.0, 2.3.0 within 10 days). Claude Code moved to its v2 MCP client and 2026-07-28 negotiation for HTTP servers in 2.1.274.
  spike: Pin @modelcontextprotocol/server@2.3.0 exactly. Run an integration test with InMemoryTransport plus a real `claude -p` call that lists tools and calls `doctor`.
  success: tools/list and tools/call work from Claude Code 2.1.280+. Image and structuredContent results render. The test passes in CI or locally before any SDK bump.
  planB: Fall back to @modelcontextprotocol/sdk 1.32.x (supported at least 6 months after 2026-07-27), or hand-roll the small 2025-era stdio JSON-RPC subset (initialize, tools/list, tools/call, notifications/progress).

## RECOMMENDATIONS
- Stack: TypeScript run directly by Node >= 22.18 (type stripping, no build step), ESM, `engines.node: ">=22.18"`, startup version check. Rationale: owner ecosystem, zero build tooling, verified working on the installed 22.19.
- Runtime deps limited to @modelcontextprotocol/server (pinned exact, 2.3.0), which brings @modelcontextprotocol/core and zod 4. Dev deps: typescript, @types/node, @modelcontextprotocol/client (InMemoryTransport tests), and optionally ws for a test-only WebSocket server. Rationale: v2 has no transitive deps, unlike v1 (express, hono, jose...).
- MCP surface = tools only, mirroring the CLI 1:1 through a shared core module (the CLI uses node:util parseArgs with subcommand dispatch and --json). Rationale: one implementation, two front-ends; Claude can fall back to the CLI via Bash.
- Long takes: take_start returns {runId} immediately and spawns a detached supervisor (process.execPath, unref'd) that writes runs/<id>/status.json and events.ndjson. take_wait long-polls (<= 55 s, cursor) and returns early on checkpoint, step or finish, sending notifications/progress when a progressToken is present. Add take_status and take_abort. Rationale: survives auto-backgrounding, idle timeouts and MCP restarts without depending on the deprecated MCP tasks.
- Screenshot tool returns a JPEG at point resolution (390x844 on the iPhone 12, q ~0.8) plus a text line with the scale and the on-disk path of the full-resolution PNG. Offer a crop/zoom tool for detail. Rationale: coordinates equal XCUI points, stays under the 2000 px and 25k-token limits, and limits disk churn.
- Accessibility-tree tool: compact, visible-only default format (type|label|identifier|frame in points), with _meta {'anthropic/maxResultSizeChars': 200000}. Mark 4-6 core tools 'anthropic/alwaysLoad'. Keep descriptions and server instructions under 2,048 chars with the rules first. Rationale: avoids the undocumented ~50k-char persist-to-file cut and tool-search misses.
- Commit .mcp.json as {"mcpServers":{"contrarregra":{"type":"stdio","command":"node","args":["mac/src/mcp/main.ts"]}}}, or point command at a committed shim bin/contrarregra-mcp that resolves the right Node. No secrets in env; approve once via the prompt or enabledMcpjsonServers in .claude/settings.local.json. Rationale: the cwd is the project dir, and two Node installs exist.
- Write a native TS usbmuxd client (~250 LOC). Use the 16-byte little-endian header (len, version 1, type 8, tag) and a minimal XML plist writer/reader. Implement ListDevices, Listen (EventEmitter) and connect(deviceId, port) using a fresh socket per tunnel, with PortNumber = byte-swapped port. Accept only ConnectionType==='USB' and match the UDID with hyphens stripped. Rationale: verified protocol, nothing on npm fits.
- Mac<->runner: WebSocket + JSON-RPC 2.0 (requests, responses, and id-less notifications for push events), with a 1 Hz app-level ping. The runner's NWListener is bound to loopback (requiredInterfaceType .loopback), with autoReplyPing, a maximumMessageSize of about 16 MB and no Bonjour. The Mac uses an in-process 127.0.0.1:0 forwarder so Node's global WebSocket can be used unchanged. Rationale: push events, built-in framing on both sides, no Local Network prompt, no deps.
- Use one controlling connection per device: the runner accepts a single controller (newConnectionLimit or reject extras) and the Mac holds a lock file during a take. Rationale: stops the MCP server and the CLI/supervisor from issuing conflicting commands mid-take.
- Read secrets with execFile('/usr/bin/security', ['find-generic-password','-s','contrarregra','-a',NAME,'-w']), 5 s timeout, one trailing newline stripped, wrapped in a redacting Secret type; exit 44 -> error naming the add command. The owner creates the item with `security add-generic-password -s contrarregra -a OBS_WEBSOCKET_PASSWORD -l 'Contrarregra OBS WebSocket' -U -w`. Rationale: no deps, no secret in shell history or the repo.
- iPhone project: XcodeGen project.yml (minimumXcodeGenVersion 2.45.4, projectFormat xcode16_0+, syncedFolder sources, DEVELOPMENT_TEAM 984PNJZ8B9, CODE_SIGN_STYLE Automatic) with the generated .xcodeproj gitignored. Put a local Swift package for pure logic next to it, tested with `swift test`. Rationale: SwiftPM can't express UI-test bundles, and agents edit YAML and add files safely.
- Bundle ids: host app.kifactory.contrarregra, UI-test target app.kifactory.contrarregra.runner, installed runner app.kifactory.contrarregra.runner.xctrunner. Rationale: Xcode appends .xctrunner to the test target's id.
- Build-runner command: xcodegen generate, then xcodebuild build-for-testing -destination 'generic/platform=iOS' -derivedDataPath .build/ios -allowProvisioningUpdates DEVELOPMENT_TEAM=984PNJZ8B9 CODE_SIGN_STYLE=Automatic [optional -authenticationKeyPath/-authenticationKeyID/-authenticationKeyIssuerID]; glob exactly one *.xctestrun; run with test-without-building -xctestrun ... -destination id=<UDID>. Inject the port/config through the xctestrun EnvironmentVariables. Rationale: an explicit team avoids the foreign certificates, and the glob avoids SDK-version file names.
- Tests: node:test + node:assert/strict (`node --test`), a fake usbmuxd on a temp Unix socket with recorded XML fixtures, a test-only WebSocket runner stub, and an InMemoryTransport MCP client. Typecheck with `tsc --noEmit` (erasableSyntaxOnly, verbatimModuleSyntax). Rationale: stable built-ins, no vitest/tsx needed.
- Alerts: primary is `say -a '<configured output>' -v Luciana '<pt-BR message>'`, with the device validated against `say -a '?'` and never BlackHole or Multi-Output. Secondary is afplay /System/Library/Sounds/Glass.aiff outside takes. osascript display notification is best-effort only. No sounds during takes except at checkpoints. Rationale: device-targeted audio can't leak into OBS, and Tahoe notifications are unreliable.
- Disk guard: fs.promises.statfs(outputDir) → bavail*bsize. Refuse to start below max(minFreeGB from config, 2 x estimated take bytes); poll every 5 s during a take and stop gracefully below a critical floor (e.g. 3 GB). Recordings live in ~/Movies/contrarregra/. Rationale: 11.1 GB free today and three prior out-of-space incidents.
- Ask the owner to update Claude Code to >= 2.1.283 (installed 2.1.280) before the MCP spikes. Rationale: that release keeps progress for backgrounded MCP calls and saves MCP images to files.

## FINDINGS
### F1 [verified] The official MCP TypeScript SDK is now v2 (split packages); @modelcontextprotocol/server 2.3.0 is latest (published 2026-10-02), v2.0.0 shipped 2026-07-27 as the stable line for the 2026-07-28 MCP spec; v1 (@modelcontextprotocol/sdk 1.32.0, MIT) gets fixes for at least 6 months after v2.
Runtime deps of @modelcontextprotocol/server@2.3.0: only '@modelcontextprotocol/core' 2.3.0 and 'zod' ^4.2.0 (engines node>=20, ESM, Apache-2.0; unpacked ~6.5 MB + core 1.3 MB + zod 6.1 MB, zero transitive deps). v1 @modelcontextprotocol/sdk@1.32.0 pulls express, hono, cors, jose, ajv, eventsource, cross-spawn, etc. For Contrarregra's minimal-deps philosophy v2 is clearly better. Pin the exact version (releases every few days: 2.1.0 09-23, 2.2.0 09-28, 2.3.0 10-02).
SRC: https://registry.npmjs.org/@modelcontextprotocol/server ; https://registry.npmjs.org/@modelcontextprotocol/sdk ; github.com/modelcontextprotocol/typescript-sdk@8aabbdc:README.md:1-12

### F2 [verified] v2 stdio entry point is serveStdio(factory) from '@modelcontextprotocol/server/stdio'; it serves 2025-era clients (initialize handshake) and 2026-07-28 clients from the same factory by default; stdout is the protocol channel, log only to stderr.
import { McpServer } from '@modelcontextprotocol/server'; import { serveStdio } from '@modelcontextprotocol/server/stdio'; const handle = serveStdio(() => { const s = new McpServer({name:'contrarregra',version:'0.1.0'}, {instructions:'...'}); s.registerTool(...); return s; }); handle.close() on SIGINT; stdin EOF tears down automatically; release own timers in server.server.onclose. One console.log on stdout corrupts the JSON-RPC stream. Server instructions option exists: ServerOptions.instructions (packages/server/src/server/server.ts:90-92).
SRC: github.com/modelcontextprotocol/typescript-sdk@8aabbdc:docs/serving/stdio.md ; packages/server/src/stdio.ts:9-11 ; docs/serving/legacy-clients.md

### F3 [verified] Tool definition in v2: server.registerTool(name, {title, description, inputSchema: z.object({...}), outputSchema?, annotations?, _meta?}, handler); results are {content:[...], structuredContent?, isError?}; image blocks are {type:'image', data:<base64>, mimeType:'image/png'|'image/jpeg'}; resource_link and embedded resource blocks also allowed.
Schema arguments that fail validation come back as isError:true tool results before the handler runs. Zod v4 (`import * as z from 'zod/v4'` or 'zod' 4.x); .describe() text becomes the JSON-Schema description the model sees. registerTool accepts `_meta?: Record<string, unknown>` (mcp.ts:1052-1066), so `_meta: {'anthropic/maxResultSizeChars': 200000, 'anthropic/alwaysLoad': true}` can be set per tool. annotations {readOnlyHint, destructiveHint, idempotentHint} let the host auto-approve read-only tools.
SRC: github.com/modelcontextprotocol/typescript-sdk@8aabbdc:docs/servers/tools.md:1-60,97-160,197-233 ; packages/server/src/server/mcp.ts:1052-1095

### F4 [verified] Progress and cancellation in v2: handler ctx.mcpReq._meta.progressToken, send via ctx.mcpReq.notify({method:'notifications/progress', params:{progressToken, progress, total?, message?}}) with strictly increasing progress; ctx.mcpReq.signal is an AbortSignal aborted on notifications/cancelled or disconnect.
Only send progress when the request carried a progressToken. Forward ctx.mcpReq.signal into own I/O (usbmux socket, OBS calls) so cancellation propagates.
SRC: github.com/modelcontextprotocol/typescript-sdk@8aabbdc:docs/servers/logging-progress-cancellation.md:6-72,144-226

### F5 [verified] MCP 'tasks' (2025-11-25 task-augmented tool calls) are deprecated wire vocabulary in SDK v2 and the experimental tasks interception layer was removed; do not design the 10-minute take around MCP tasks.
Task schemas exported only as @deprecated interop types; typed method maps exclude tasks/*; on 2026-era connections only tasks/get and tasks/cancel (Tasks extension) can be served via explicit custom-method handlers. Claude Code docs describe no MCP-tasks support.
SRC: github.com/modelcontextprotocol/typescript-sdk@8aabbdc:docs/migration/support-2026-07-28.md:691-720 ; https://code.claude.com/docs/en/mcp

### F6 [verified] Claude Code long-call behaviour: an MCP call still running after 2 min is automatically moved to a background task (result arrives later as a task notification; v2.1.212+, CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS, 0 disables); an idle call (no response and no progress notification) aborts after 30 min for stdio / 5 min for HTTP (CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT); MCP_TOOL_TIMEOUT default ~28 h; per-server 'timeout' in .mcp.json is a hard wall-clock limit that progress does NOT extend.
Progress notifications are retained/shown for backgrounded calls only from 2.1.283 (installed: 2.1.280, latest 2.1.287). Implication: prefer take_start (returns runId immediately) + take_wait(runId, cursor, timeoutSec<=55, long-poll returning early on checkpoint/step/finish) + take_status + take_abort; do not set a per-server timeout below the longest take.
SRC: https://code.claude.com/docs/en/mcp (lines 420-426 of mcp.md); https://code.claude.com/docs/en/env-vars ; https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md (2.1.212, 2.1.283); local `claude --version` = 2.1.280

### F7 [verified] Claude Code output limits: warning at 10,000 tokens, MAX_MCP_OUTPUT_TOKENS default 25,000; text results over ~50,000 characters are persisted to a file regardless of MAX_MCP_OUTPUT_TOKENS unless the tool declares _meta['anthropic/maxResultSizeChars'] (hard ceiling 500,000); image content is still subject to MAX_MCP_OUTPUT_TOKENS even with that _meta.
Accessibility-tree dumps of a whole screen can exceed 50k chars: declare maxResultSizeChars (e.g. 200000) on tree tools and keep a compact default format (label|id|type|frame, visible-only). The ~50k-char threshold is undocumented (issue #97622, open, 2026-09-27).
SRC: https://code.claude.com/docs/en/mcp (MCP output limits and warnings); https://code.claude.com/docs/en/env-vars (MAX_MCP_OUTPUT_TOKENS row); https://github.com/anthropics/claude-code/issues/97622

### F8 [verified] Images from MCP tools: PNG/JPEG/GIF/WebP are shown inline, possibly scaled/compressed; Claude Code also saves the original bytes to the session tool-results dir under ~/.claude/projects/ and gives Claude the path; Claude Code caps images at 2000 px per side and adds dimension metadata when resizing; images were dropped when both structuredContent and content were returned until 2.1.128 (fixed).
API limits: 8000x8000 max; with >20 images in a request every image must be <=2000 px per side; 10 MB base64 per image; visual tokens = ceil(w/28)*ceil(h/28), high-res tier long edge 2576 px / 4784 tokens. iPhone 12 full screenshot is 1170x2532 (>2000) so it will be downscaled anyway. Recommend runner returns JPEG at point resolution 390x844 (=XCUI coordinate space, ~420 visual tokens, ~60-120 KB) by default, optional scale=2/3 or a file path for full-res. Each inline screenshot also lands on disk twice (tool-results + MCP logs).
SRC: https://code.claude.com/docs/en/mcp (Images in tool results); https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md (2.0.64, 2.1.122, 2.1.128, 2.1.283); https://platform.claude.com/docs/en/build-with-claude/vision

### F9 [verified] Claude Code truncates each MCP tool description and each server's instructions at 2,048 characters (CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH, v2.1.280+); MCP tools are deferred behind tool search by default, so server instructions should say when to search for Contrarregra tools; alwaysLoad:true (server entry) or _meta['anthropic/alwaysLoad']:true (per tool) forces tools into context.
Put the critical usage rule first in instructions (e.g. 'Operate the physical iPhone for Contrarregra: screenshot/tree/tap/... ; never type credentials; takes are start+wait'). Mark 4-6 core tools alwaysLoad, leave the rest deferred.
SRC: https://code.claude.com/docs/en/mcp (For MCP server authors; Exempt a server from deferral); https://code.claude.com/docs/en/env-vars

### F10 [verified] Project registration: .mcp.json at repo root ({"mcpServers":{"contrarregra":{"type":"stdio","command":"node","args":["mac/src/mcp/main.ts"],"env":{...}}}}) or `claude mcp add --scope project contrarregra -- node mac/src/mcp/main.ts`; project servers prompt for approval in interactive sessions (reset: `claude mcp reset-project-choices`; pre-approve via enabledMcpjsonServers in an unchecked settings file).
Working directory for a project .mcp.json stdio server = the project directory; there is no 'cwd' field. Claude Code sets CLAUDE_PROJECT_DIR in the server's env (not in its own), so `${CLAUDE_PROJECT_DIR}` in args needs a default: `${CLAUDE_PROJECT_DIR:-.}`. ${VAR} and ${VAR:-default} expand in command/args/env/url/headers. Claude Code ignores checked-in approvals until the workspace is trusted (v2.1.196+). Tool names become mcp__contrarregra__<tool>; allow rules like `mcp__contrarregra__screenshot` or `mcp__contrarregra__*`.
SRC: https://code.claude.com/docs/en/mcp (mcp.md lines 117-121, 256, 320; Where the helper runs table); https://code.claude.com/docs/en/permissions (lines 197-209, 514-516)

### F11 [verified] Secrets must not go through .mcp.json env; the server should read OBS_WEBSOCKET_PASSWORD from the Keychain itself at runtime. headersHelper exists only for HTTP servers.
.mcp.json is committed; ${VAR} expansion would require the secret in the shell environment. Keep env to non-secret config (e.g. CONTRARREGRA_CONFIG path). headersHelper (shell command printing JSON headers, 10 s timeout) is irrelevant to stdio.
SRC: https://code.claude.com/docs/en/mcp (Use dynamic headers for custom authentication; Environment variable expansion)

### F12 [verified] Claude Code resources: resources are referenced with @server:protocol://path and auto-exposed via list/read tools, but tools are sufficient for Contrarregra.
Return file paths (events.json, .srt, video) as text or resource_link and let Claude read them with Read; resources add no capability needed in v1.
SRC: https://code.claude.com/docs/en/mcp (Use MCP resources, mcp.md lines 1391-1430)

### F13 [verified] usbmuxd wire format: Unix socket /var/run/usbmuxd; 16-byte header of four little-endian uint32: length (header+payload), version (1 = plist protocol), message type (8 = MESSAGE_PLIST), tag (echoed in replies); payload is an XML plist; result codes 0 OK, 1 BADCOMMAND, 2 BADDEV, 3 CONNREFUSED, 6 BADVERSION.
Message types enum: RESULT=1, CONNECT=2, LISTEN=3, DEVICE_ADD=4, DEVICE_REMOVE=5, DEVICE_PAIRED=6, PLIST=8 (binary types 2-6 are protocol 0 legacy; use plist only). libusbmuxd and go-ios send XML plists (plist_to_xml / plist.XMLFormat); responses are parsed as XML. JS: hdr.writeUInt32LE(16+body.length,0); writeUInt32LE(1,4); writeUInt32LE(8,8); writeUInt32LE(tag,12).
SRC: github.com/libimobiledevice/libusbmuxd@93eb168:include/usbmuxd-proto.h:27-67 ; src/libusbmuxd.c:537-580 ; github.com/danielpaulus/go-ios@273d3e0:ios/usbmuxconnection.go:155-190 ; ios/utils.go:79-85 ; github.com/appium/appium-ios-device@c0024af:lib/usbmux/transformer/usbmux-encoder.js:20-34

### F14 [verified] usbmuxd plist messages: ListDevices -> {DeviceList:[{DeviceID, MessageType:'Attached', Properties:{ConnectionType, DeviceID, LocationID, ProductID, SerialNumber, ConnectionSpeed,...}}]}; Listen -> Result{Number:0} then a stream of {MessageType:'Attached', DeviceID, Properties} / {MessageType:'Detached', DeviceID} / {MessageType:'Paired', DeviceID}; Connect {DeviceID, PortNumber} -> Result{Number}, after which that same socket is a raw TCP tunnel to the device port.
Common keys: MessageType, ClientVersionString, ProgName, kLibUSBMuxVersion=3 (BundleID optional). Each Connect needs a fresh usbmuxd socket (it is consumed by the tunnel); Listen needs its own long-lived socket. ConnectionType is 'USB' or 'Network' (Network entries carry NetworkAddress <data> and EscapedFullServiceName), so the plist parser must handle <data>, <integer>, <string>, <dict>, <array>, <true/>, <false/>. That Listen replays currently-attached devices as Attached right after the Result is the observed libimobiledevice behaviour; treat it as likely and also call ListDevices at startup.
SRC: github.com/libimobiledevice/libusbmuxd@93eb168:src/libusbmuxd.c:255-320,383-460,735-800,1005-1030,1540-1575 ; github.com/danielpaulus/go-ios@273d3e0:ios/listdevices.go:12-93 ; ios/connect.go:18-46

### F15 [verified] Connect PortNumber encoding: the plist integer is htons(port), i.e. the 16-bit port byte-swapped and stored as a host integer: port 8100 (0x1FA4) is sent as 0xA41F = 41983.
libusbmuxd: plist_new_uint(htons(port)); go-ios: newConnectMessage(deviceID, Ntohs(port)) where Ntohs = BigEndian.PutUint16 then LittleEndian.Uint16; appium-ios-device: PortNumber: swap16(port) with swap16(v)=((v&0xff)<<8)|((v>>8)&0xff). TS: const portNumber = ((p & 0xff) << 8) | (p >>> 8).
SRC: github.com/libimobiledevice/libusbmuxd@93eb168:src/libusbmuxd.c:771 ; github.com/danielpaulus/go-ios@273d3e0:ios/connect.go:45 , ios/utils.go:101-105 ; github.com/appium/appium-ios-device@c0024af:lib/usbmux/index.js:242,346-348

### F16 [verified] Live check on this Mac (macOS 26.5.2): /var/run/usbmuxd exists (srw-rw-rw- root:daemon); a hand-built XML-plist ListDevices request (header version 1, type 8, tag 1) from Node 22.19 got a version-1/type-8 reply in 4.9 ms with an XML plist containing an empty DeviceList while the iPhone was reachable only over Wi-Fi (devicectl transportType=localNetwork).
Read-only host-side query; nothing was sent to the device. On macOS 26.5.2, at least in the current state, usbmuxd does not expose the Wi-Fi-only iPhone as a 'Network' entry (Wi-Fi discovery now goes through CoreDevice/remoted). Network entries may still appear if Finder Wi-Fi sync is enabled, so Contrarregra must filter ConnectionType==='USB' and refuse otherwise (HC: USB only). Script: scratchpad/research/mac_stack/listdevices.mjs.
SRC: local: node /private/tmp/claude-501/-Users-noah-project-contrarregra/cf1029e2-50df-4154-a084-e62ee5c4aaf5/scratchpad/research/mac_stack/listdevices.mjs (2026-10-02); ls -l /var/run/usbmuxd

### F17 [verified] usbmuxd may report SerialNumber as 24 hex chars without the hyphen for newer devices; libusbmuxd inserts '-' after 8 chars to form the UDID (e.g. 00008101-001E79203A68001E).
Normalize both the configured UDID and SerialNumber (remove '-', uppercase) before matching. If several entries share the UDID (USB + Network), choose ConnectionType 'USB'.
SRC: github.com/libimobiledevice/libusbmuxd@93eb168:src/libusbmuxd.c:232-243

### F18 [verified] No maintained npm library fits a zero-dependency USB transport: appium-ios-device 3.1.24 (Apache-2.0, published 2026-09-25) has Usbmux.listDevices/findDevice/connect/readBUID/readPairRecord/connectLockdown but no Listen (attach/detach events), and depends on @appium/support (24 direct deps), axios, bplist-creator/parser, semver, asyncbox.
Write a native TS client (~250 LOC): header codec, minimal XML plist writer (dict of string/integer) and reader (dict/array/string/integer/data/bool), ListDevices, Listen (EventEmitter attached/detached), connect(deviceId, port) -> net.Socket. Test against a fake usbmuxd (net.createServer on a temp Unix socket) with recorded fixtures. go-ios forward.Forward binds 0.0.0.0, so if you copy the technique, bind 127.0.0.1.
SRC: github.com/appium/appium-ios-device@c0024af:package.json ; lib/usbmux/index.js:76-246 ; https://registry.npmjs.org/@appium/support/latest ; github.com/danielpaulus/go-ios@273d3e0:ios/forward/forward.go:29-48

### F19 [likely] usbmux Connect to an app-owned TCP port on the device is still the baseline forwarding path on iOS 17+/18+: the Appium XCUITest driver keeps a LegacyPortForwarder (usbmux connectPort) and only optionally uses appium-ios-remotexpc on iOS 18+ ('usbmux or tunnel') with fallback to legacy; the CoreDevice/RSD tunnel is required for Apple developer services, not for reaching an app's own listener.
go-ios README: iOS 17+ needs `ios tunnel start` for developer services, but forward.go uses only usbmux Connect. Whether it works for Contrarregra's runner on iOS 26.3 must be confirmed by the transport spike.
SRC: github.com/appium/appium-xcuitest-driver (main):lib/device/device-connections-factory.ts:57-77,246 ; github.com/danielpaulus/go-ios@273d3e0:README.md:12 , ios/forward/forward.go:85-100

### F20 [likely] A device-side listener bound to loopback is reachable through usbmuxd: PeerTalk's iOS example listens on INADDR_LOOPBACK and the macOS side connects via usbmuxd. WDA binds all interfaces by default and supports USE_IP to restrict the binding.
Supports binding the runner to 127.0.0.1 so nothing on Wi-Fi can reach it. This is pre-iOS-17 evidence; confirm on iOS 26.3 in the transport spike.
SRC: github.com/rsms/peertalk:Peertalk iOS Example/PTViewController.m (listenOnPort:... IPv4Address:INADDR_LOOPBACK) ; Peertalk Swift Example/ViewController.swift ; github.com/appium/WebDriverAgent (master):WebDriverAgentLib/Routing/FBWebServer.m:93-126 , WebDriverAgentLib/Utilities/FBConfiguration.m:137-142

### F21 [verified] Network.framework APIs for the runner: NWListener(using: NWParameters, on: NWEndpoint.Port) (iOS 12+); NWProtocolWebSocket.Options (iOS 13+) with autoReplyPing and maximumMessageSize, and setClientRequestHandler(_:handler:) to inspect subprotocols/headers; NWProtocolWebSocket.Metadata(opcode:); NWConnection.receiveMessage(completion:); NWParameters.requiredLocalEndpoint, requiredInterfaceType (.loopback), allowLocalEndpointReuse; NWListener.newConnectionLimit.
Pattern: let p = NWParameters.tcp; let ws = NWProtocolWebSocket.Options(); ws.autoReplyPing = true; ws.maximumMessageSize = 16<<20; p.defaultProtocolStack.applicationProtocols.insert(ws, at: 0); p.requiredInterfaceType = .loopback (or requiredLocalEndpoint = .hostPort(host: .ipv4(.loopback), port: N)); p.allowLocalEndpointReuse = true; send with ContentContext(identifier:, metadata:[NWProtocolWebSocket.Metadata(opcode: .text)]). NWParameters.acceptLocalOnly means 'local link only', NOT loopback, so don't rely on it. iOS 26 also adds NetworkListener<WebSocket>/NetworkConnection, a new async Swift API; NWListener is the mature choice.
SRC: https://developer.apple.com/documentation/network/nwlistener ; https://developer.apple.com/documentation/network/nwprotocolwebsocket/options ; https://developer.apple.com/documentation/network/nwparameters/acceptlocalonly ; https://developer.apple.com/documentation/network/nwparameters/requiredinterfacetype ; https://developer.apple.com/documentation/network/networklistener

### F22 [verified] Listening for and accepting incoming TCP connections does not require Local Network permission on iOS 14+, but registering, browsing or resolving Bonjour does; local network means broadcast-capable interfaces (Wi-Fi/Ethernet), not loopback.
So the runner's listener triggers no visible 'find devices on your local network' alert as long as NWListener.service is NOT set (no Bonjour advertisement) and the runner makes no outgoing connections to LAN addresses. Matters for the hard constraint that nothing of the tool appears on screen.
SRC: https://developer.apple.com/documentation/technotes/tn3179-understanding-local-network-privacy (tables 'Operation | Required')

### F23 [verified] Node 22 has a global browser-compatible WebSocket client: unflagged in v22.0.0, no longer experimental since v22.4.0; verified present in local Node 22.19 (WebSocket.OPEN === 1). Node has no built-in WebSocket server.
The global WebSocket takes a URL, not an existing socket. To ride a usbmux tunnel: open an in-process net.Server on 127.0.0.1:0, and for each accepted connection open a fresh usbmux Connect socket to the device port and pipe both ways (an in-process iproxy), then new WebSocket(`ws://127.0.0.1:${port}`). The same client can talk to obs-websocket (ws://127.0.0.1:4455, subprotocol 'obswebsocket.json'), so no ws/obs-websocket-js dependency. Tests need a WebSocket server: hand-roll one in test helpers or add 'ws' as a dev-only dependency.
SRC: https://nodejs.org/docs/latest-v22.x/api/globals.html#class-websocket ; local `node -e "console.log(typeof WebSocket)"` (v22.19.0)

### F24 [verified] JSON-RPC 2.0 over WebSocket text frames suits Mac<->runner: requests {jsonrpc:'2.0', id, method, params}, responses {jsonrpc, id, result|error{code,message,data}}, notifications have no id (used for runner->Mac push events like step.done, checkpoint.reached, take.finished).
Reserved error codes -32700 parse, -32600 invalid request, -32601 method not found, -32602 invalid params, -32603 internal; app errors in -32000..-32099. One JSON object per WS message; screenshots either base64 in result or a binary frame correlated by id. App-level heartbeat (method 'ping' every 1 s, 3 misses = dead) because the browser WebSocket API exposes no ping control.
SRC: https://www.jsonrpc.org/specification

### F25 [verified] Node 22.18+ runs TypeScript directly (type stripping on by default, no warning; stability 1.2 release candidate); verified locally: `node t.ts` on 22.19.0 ran with interfaces and type annotations and printed nothing extra.
Constraints: no enums, runtime namespaces, parameter properties, import aliases or decorators; relative imports must use explicit .ts extensions; type-only imports need `import type`; tsconfig is not read (no paths), and .ts in node_modules is refused. Recommended tsconfig: target esnext, module nodenext, noEmit, erasableSyntaxOnly, verbatimModuleSyntax, rewriteRelativeImportExtensions/allowImportingTsExtensions. Typecheck with `tsc --noEmit` (typescript latest = 7.0.2, native).
SRC: https://nodejs.org/docs/latest-v22.x/api/typescript.html ; local run of scratchpad/research/mac_stack/t.ts ; https://registry.npmjs.org/typescript

### F26 [verified] node:test is stable since v20.0.0; `node --test` default globs include **/*.test.{cts,mts,ts} and **/test/**/*.ts when type stripping is on; mock.timers is usable in v22; mock.module is stability 1.0 (early development); snapshot testing is experimental in v22 (stable from 23.4). Test files run in separate processes by default (isolation 'process').
The owner's Hagah repo uses vitest ^1.6 + tsx, but for Contrarregra node:test + node:assert/strict gives zero runtime/dev deps beyond typescript and @types/node. For MCP integration tests, use @modelcontextprotocol/client's InMemoryTransport.createLinkedPair() (2025-era) as a devDependency.
SRC: https://nodejs.org/docs/latest-v22.x/api/test.html ; github.com/modelcontextprotocol/typescript-sdk@8aabbdc:docs/testing.md:101-133 ; /Users/noah/project/bible/hagah/package.json

### F27 [verified] util.parseArgs is stable since v20.0.0 (added 18.3.0); options {type:'boolean'|'string', multiple, short, default}, strict (default true), allowPositionals, allowNegative (--no-x, v22.4.0+), tokens.
Subcommand pattern: const [cmd, ...rest] = process.argv.slice(2); then parseArgs({args: rest, options: COMMANDS[cmd].options, allowPositionals: true}). Verified locally on 22.19. Add --json on every command so Claude can also drive the CLI through Bash.
SRC: https://nodejs.org/docs/latest-v22.x/api/util.html#utilparseargsconfig ; local run of t.ts

### F28 [verified] Keychain via the built-in CLI: `security add-generic-password -a <account> -s <service> [-l label] [-U] -w` with -w LAST prompts interactively for the password (man: 'Put at end of command to be prompted (recommended)'); the creating app (/usr/bin/security) is trusted by default; `security find-generic-password -s <service> -a <account> -w` prints only the password; exit code 44 when not found (verified).
Owner command: `security add-generic-password -s contrarregra -a OBS_WEBSOCKET_PASSWORD -l 'Contrarregra OBS WebSocket' -U -w` (keeps the secret out of shell history). Node: execFile('/usr/bin/security', ['find-generic-password','-s','contrarregra','-a','OBS_WEBSOCKET_PASSWORD','-w'], {encoding:'utf8', timeout:5000}), strip one trailing '\n', never log stdout or argv, wrap in a Secret class whose toString/toJSON/[util.inspect.custom] return '[redacted]'. Exit 44 -> actionable error naming the add command. As of today the item does not exist (find exited 44). If the item is created in Keychain Access.app instead, reading via `security` may pop a GUI consent dialog (ACL lists only the creator).
SRC: local `man security` (add-generic-password, find-generic-password sections) on macOS 26.5.2; local `security find-generic-password -s contrarregra -a OBS_WEBSOCKET_PASSWORD` -> exit 44

### F29 [verified] SwiftPM cannot produce a UI-test bundle: Xcode 26.6's PackageDescription Target.TargetType has only regular, executable, test, system, binary, plugin, macro (no UI-testing kind, no iOS app target).
The host app + UI-test runner must live in an Xcode project. A local Swift package can still hold pure logic (JSON-RPC codec, choreography model, clock math) and be unit-tested on macOS with `swift test`.
SRC: local /Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/lib/swift/pm/ManifestAPI/PackageDescription.swiftmodule/arm64-apple-macos.swiftinterface:707-714

### F30 [verified] XcodeGen is installed (/opt/homebrew/bin/xcodegen 2.45.4; latest 2.46.0 released 2026-07-16) and supports target type bundle.ui-testing, TEST_TARGET_NAME for UI tests that target an application, syncedFolder sources (Xcode 16 buildable folders, projectFormat xcode16_0+), minimumXcodeGenVersion and deterministic target ordering (2.46.0). Tuist is not installed and would add a toolchain.
With syncedFolder an agent adds .swift files without editing project.yml or the pbxproj. project.yml is about 60 reviewable lines; the generated .xcodeproj can be gitignored and regenerated by the build script (`xcodegen generate --spec ios/project.yml`).
SRC: https://github.com/yonaskolb/XcodeGen/blob/master/CHANGELOG.md ; https://github.com/yonaskolb/XcodeGen/blob/master/Docs/ProjectSpec.md (lines 121-166, 372-427, 530-557); local `xcodegen --version`

### F31 [verified] The runner app's bundle id is the UI-test TARGET's PRODUCT_BUNDLE_IDENTIFIER + '.xctrunner' (xcodebuild appends it automatically): WebDriverAgentRunner test target com.facebook.WebDriverAgentRunner -> runner com.facebook.WebDriverAgentRunner.xctrunner. It derives from the test bundle id, not the host app's.
Proposed: host app app.kifactory.contrarregra; UI-test target app.kifactory.contrarregra.runner -> installed runner app.kifactory.contrarregra.runner.xctrunner. A manual provisioning profile would have to cover the .xctrunner id, .runner.* or *; automatic signing handles it.
SRC: github.com/appium/appium-xcuitest-driver:docs/getting-started/provisioning-profile/auto-config.md:48-50 ; docs/reference/capabilities.md (usePreinstalledWDA) ; github.com/appium/WebDriverAgent:WebDriverAgent.xcodeproj/project.pbxproj (PRODUCT_BUNDLE_IDENTIFIER = com.facebook.WebDriverAgentRunner)

### F32 [likely] Build/run commands with Xcode 26.6: `xcodebuild build-for-testing -project ios/Contrarregra.xcodeproj -scheme ContrarregraRunner -destination 'generic/platform=iOS' -derivedDataPath .build/ios -allowProvisioningUpdates DEVELOPMENT_TEAM=984PNJZ8B9 CODE_SIGN_STYLE=Automatic` and optional `-authenticationKeyPath <p8> -authenticationKeyID <id> -authenticationKeyIssuerID <issuer>`; run with `xcodebuild test-without-building -xctestrun <file>.xctestrun -destination 'id=<UDID>'`.
From the local man page: -allowProvisioningUpdates lets xcodebuild create/update profiles, App IDs and certificates for automatic signing; -allowProvisioningDeviceRegistration requires it; the three -authenticationKey* flags go together (otherwise the Xcode account session is used); -xctestrun and -testProductsPath cannot be combined with -project/-workspace. The iPhoneOS SDK here is 26.5, so the file is likely named ContrarregraRunner_iphoneos26.5-arm64.xctestrun under .build/ios/Build/Products/; glob *.xctestrun and assert exactly one rather than hard-coding. xctestrun(5) FormatVersion 2 supports EnvironmentVariables/TestingEnvironmentVariables/CommandLineArguments to pass port and config to the runner. Set DEVELOPMENT_TEAM in project.yml too, so builds never pick the other teams' certificates (59CB45686C, V4397KJVXZ).
SRC: local `man xcodebuild` (lines 186-214, 305-320) and `man 5 xcodebuild.xctestrun` (lines 47-48, 109-134, 249-252, 332-335), Xcode 26.6 (17F113); local `xcrun --sdk iphoneos --show-sdk-version` = 26.5 ; github.com/appium/appium-xcuitest-driver:docs/guides/run-prebuilt-wda.md:11-56

### F33 [verified] fs.statfs / fs.promises.statfs work on Node 22.19 (added v18.15.0/v19.6.0): free bytes = bavail * bsize; locally this gave 11.1 GB free, matching `df -k` (10,817,548 KB available on the shared APFS container, 95% used).
bavail excludes root-reserved blocks and does not count APFS purgeable space (Finder's 'available' does), so it is the conservative figure. Call statfs on the actual output dir (~/Movies/contrarregra; create it first) because statfs needs an existing path. 11.1 GB is already near any sensible abort threshold.
SRC: https://nodejs.org/docs/latest-v22.x/api/fs.html#class-fsstatfs ; local `node -e "require('fs').statfs('/',...)"` and `df -k`

### F34 [verified] Mac alerts without deps: `afplay /System/Library/Sounds/<Name>.aiff` (Basso, Blow, Bottle, Frog, Funk, Glass, Hero, Morse, Ping, Pop, Purr, Sosumi, Submarine, Tink) plays on the default output device and cannot choose a device; `say -a <ID|name-prefix> -v <voice> <text>` can target a specific output device (`say -a '?'` lists them); pt_BR voices installed: Luciana, Eddy, Flo, Grandma, Grandpa.
Local devices: 'BlackHole 2ch' (ID 79), 'MacBook Air Speakers' (ID 100, current default output); 'Multi-Output Device' and 'Aggregate Device' also exist, plus a 'VIVO_00G7 Microphone' input. If OBS records from BlackHole/Multi-Output, afplay/say sounds can end up in the recording. Prefer `say -a 'MacBook Air Speakers' -v Luciana 'Ponto de controle: ...'` with the device name in config, checked at startup against `say -a '?'`.
SRC: local `man say` (-a/--audio-device), `afplay -h`, `ls /System/Library/Sounds`, `say -a '?'`, `say -v '?'`, `system_profiler SPAudioDataType`

### F35 [likely] `osascript -e 'display notification "..." with title "..." sound name "Glass"'` is unreliable on macOS 26 (Tahoe): reports of exit 0 with no notification shown; notifications from osascript are attributed to Script Editor and need its notification permission.
Use it only as a best-effort extra channel after the sound. For a blocking human acknowledgement use `osascript -e 'display dialog "..." giving up after 120'` (the dialog shows on the Mac screen, not in the iPhone recording) or surface the checkpoint through the MCP take_wait result.
SRC: https://developer.apple.com/forums/thread/808496 (Nov 2025, unanswered) ; https://forum.latenightsw.com/t/trying-to-use-terminal-for-display-notification/5068

### F36 [verified] This Mac has two Node installs: /Users/noah/.nvm/versions/node/v22.19.0/bin/node (first on the interactive PATH) and /opt/homebrew/bin/node v26.0.0; pnpm 10.17.0 and npm 10.9.3 are present.
A stdio server declared as command 'node' resolves via Claude Code's PATH, which can differ between the terminal CLI and the desktop app, so the server may run on Node 26 or fail. Node 22 is in maintenance LTS until 2027-04-30; Node 24 is active LTS; Node 26 becomes LTS on 2026-10-28.
SRC: local `which -a node`, `/opt/homebrew/bin/node -v`; https://raw.githubusercontent.com/nodejs/Release/main/schedule.json

### F37 [likely] Claude Code logs MCP JSON-RPC traffic, base64 images included, under ~/Library/Caches/claude-cli-nodejs/<project>/mcp-logs-<server>/ with no rotation reported (one user reached 242 GB); issue closed as inactive, not fixed. Currently 27 MB here; ~/.claude/projects is 2.3 GB.
With 11 GB free, inline full-resolution PNG screenshots are a real disk risk. Small JPEGs plus file paths keep this bounded.
SRC: https://github.com/anthropics/claude-code/issues/69427 ; local `du -sh ~/Library/Caches/claude-cli-nodejs ~/.claude/projects`


## SOURCES
- MCP TypeScript SDK (v2, main) README and docs: https://github.com/modelcontextprotocol/typescript-sdk
- npm @modelcontextprotocol/server: https://www.npmjs.com/package/@modelcontextprotocol/server
- npm @modelcontextprotocol/sdk (v1): https://www.npmjs.com/package/@modelcontextprotocol/sdk
- Claude Code docs: Connect Claude Code to tools via MCP: https://code.claude.com/docs/en/mcp
- Claude Code docs: Environment variables: https://code.claude.com/docs/en/env-vars
- Claude Code docs: Permissions: https://code.claude.com/docs/en/permissions
- Claude Code CHANGELOG: https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md
- Claude Code issue #97622: ~50,000-character persist-to-disk threshold: https://github.com/anthropics/claude-code/issues/97622
- Claude Code issue #69427: MCP logs grow unbounded: https://github.com/anthropics/claude-code/issues/69427
- Claude API Vision: limits and costs: https://platform.claude.com/docs/en/build-with-claude/vision
- libusbmuxd usbmuxd-proto.h: https://github.com/libimobiledevice/libusbmuxd/blob/master/include/usbmuxd-proto.h
- libusbmuxd libusbmuxd.c: https://github.com/libimobiledevice/libusbmuxd/blob/master/src/libusbmuxd.c
- go-ios usbmuxconnection.go: https://github.com/danielpaulus/go-ios/blob/main/ios/usbmuxconnection.go
- go-ios connect.go: https://github.com/danielpaulus/go-ios/blob/main/ios/connect.go
- go-ios forward.go: https://github.com/danielpaulus/go-ios/blob/main/ios/forward/forward.go
- appium-ios-device usbmux: https://github.com/appium/appium-ios-device/blob/master/lib/usbmux/index.js
- appium-xcuitest-driver device-connections-factory.ts: https://github.com/appium/appium-xcuitest-driver/blob/master/lib/device/device-connections-factory.ts
- appium-xcuitest-driver provisioning auto-config (xctrunner suffix): https://github.com/appium/appium-xcuitest-driver/blob/master/docs/getting-started/provisioning-profile/auto-config.md
- appium-xcuitest-driver run prebuilt WDA (build-for-testing / xctestrun): https://github.com/appium/appium-xcuitest-driver/blob/master/docs/guides/run-prebuilt-wda.md
- WebDriverAgent FBWebServer.m: https://github.com/appium/WebDriverAgent/blob/master/WebDriverAgentLib/Routing/FBWebServer.m
- PeerTalk iOS example (loopback listener over usbmuxd): https://github.com/rsms/peertalk
- Apple: NWListener: https://developer.apple.com/documentation/network/nwlistener
- Apple: NWProtocolWebSocket.Options: https://developer.apple.com/documentation/network/nwprotocolwebsocket/options
- Apple: NWParameters.acceptLocalOnly: https://developer.apple.com/documentation/network/nwparameters/acceptlocalonly
- Apple: NWParameters.requiredInterfaceType: https://developer.apple.com/documentation/network/nwparameters/requiredinterfacetype
- Apple: NetworkListener (iOS 26): https://developer.apple.com/documentation/network/networklistener
- Apple TN3179: Understanding local network privacy: https://developer.apple.com/documentation/technotes/tn3179-understanding-local-network-privacy
- Node.js v22 globals: WebSocket: https://nodejs.org/docs/latest-v22.x/api/globals.html#class-websocket
- Node.js v22: Modules - TypeScript: https://nodejs.org/docs/latest-v22.x/api/typescript.html
- Node.js v22: Test runner: https://nodejs.org/docs/latest-v22.x/api/test.html
- Node.js v22: util.parseArgs: https://nodejs.org/docs/latest-v22.x/api/util.html#utilparseargsconfig
- Node.js v22: fs.StatFs: https://nodejs.org/docs/latest-v22.x/api/fs.html#class-fsstatfs
- Node.js release schedule: https://github.com/nodejs/Release/blob/main/schedule.json
- JSON-RPC 2.0 Specification: https://www.jsonrpc.org/specification
- XcodeGen CHANGELOG: https://github.com/yonaskolb/XcodeGen/blob/master/CHANGELOG.md
- XcodeGen ProjectSpec: https://github.com/yonaskolb/XcodeGen/blob/master/Docs/ProjectSpec.md
- Apple Developer Forums: osascript notification stopped working on Tahoe: https://developer.apple.com/forums/thread/808496
- Late Night Software forum: display notification from Terminal: https://forum.latenightsw.com/t/trying-to-use-terminal-for-display-notification/5068
