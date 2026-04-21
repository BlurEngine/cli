"@blurengine/cli": minor
---

Add Bedrock `level.dat` tooling to `blr world` with new `level-dat dump` and
`level-dat edit` commands. These commands support project-world selection or
explicit paths, Bedrock little-endian NBT parsing, JSON dumps for debugging,
interactive scalar editing, adding and removing compound fields, and backup-safe
saves for `level.dat`.

Expand local-server `watch-allowlist` behavior so runtime server-state capture
now syncs both `allowlist.json` and `permissions.json` back into the project
server state.

Internally, this also introduces a reusable interactive prompt session for
editor-style CLI workflows and adds coverage for the new world, prompt, and BDS
capture flows.
