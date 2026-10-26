# Security and privacy

OneTake controls a physical device and may capture personal content. Use only devices, apps and accounts you are authorized to access. Review scripts and code changes before running them.

## Reporting a vulnerability

**Do not open a public issue containing exploitable details, personal data or secrets.** If the repository offers **Security → Report a vulnerability**, use that private GitHub channel. It is available only if the maintainer has enabled it.

Until that channel is available, open an issue without sensitive technical details asking the maintainer to provide a private contact channel. Do not publish the reproduction before a private channel is available. No dedicated security email address or response SLA is currently provided.

Include privately: the version/commit, affected component, impact, a minimal reproduction using synthetic data and a suggested mitigation. Never include passwords, real tokens, certificates, provisioning profiles, personal videos or device dumps.

## Scope and support

This is an experimental project. Fixes are evaluated against current development; older release lines have no guaranteed support. No independent audit or security certification is implied.

## Security boundaries

- The runner uses an ephemeral token and per-session access control. Do not expose its ports to the network.
- Do not enable experimental binding modes or private APIs without assessing the risks.
- Apps and URLs must be on the allowlist; do not remove protections to work around a failing test.
- Login, Face ID, passwords and verification codes are human tasks.
- `tap` cannot tell whether a button purchases, deletes or sends something. A tap may have irreversible effects; the MCP annotation is not a substitute for authorization.
- `take run --dry` still performs real actions; only `take validate` is offline validation.
- The OBS password belongs in Keychain, not JSON, shared environment variables, process arguments or the repository. The legacy Keychain service is `contrarregra`.
- obs-websocket may listen on network interfaces beyond loopback. Use strong authentication and a firewall/trusted network, and disable it outside sessions.
- Keep Mac audio out of the recorded track and manually disable notifications before recording.

## Before sharing files

Review screenshots, video, transcripts, logs and `take.json`. Remove device identifiers, personal names, private URLs, user data and app content. `.gitignore` does not protect tracked files or history.

A secret that has entered Git must be **revoked/rotated**. Deleting the file or making it private does not invalidate the secret. Rewriting history requires coordination and the owner's authorization. See the [publication checklist](docs/publishing.md).
