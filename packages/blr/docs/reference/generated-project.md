# Generated Project Reference

## Purpose

This describes the files and directories that `blr create` emits by default, plus optional files that `blr` understands later.

## Default Layout

`blr create` currently defaults to a combined behavior-pack and resource-pack project. Pack folders are omitted when the corresponding feature is not selected.

```text
my-project/
  behavior_packs/
    my-project/
      manifest.json
  resource_packs/
    my-project/
      manifest.json
  .env.local       # optional, user-created, ignored
  src/             # only when scripting is enabled
    main.ts | main.js
  .gitignore
  AGENTS.md
  AGENTS.project.md
  blr.config.json
  package.json
  README.md
  tsconfig.json      # TypeScript scripting projects only
```

## Core Files

### `package.json`

Holds:

- package identity
- dependency versions
- generated package scripts
- package manager hint

Generated scripts:

- `dev`
- `build`
- `package`
- `minecraft`
- `system`
- `world`
- `clean`
- `upgrade`

Feature note:

- the generated dependency set depends on project features
- `scripting` adds Bedrock script dependencies
- `bebe` adds `@blurengine/bebe` only when that scaffold option is enabled
- data-only pack projects keep `package.json` leaner

### `blr.config.json`

Holds project-level `blr` state.

Default generated content:

- `$schema`
- `schemaVersion`
- `projectVersion`
- `namespace`
- `minecraft.channel`
- `minecraft.targetVersion`

Optional later additions may include:

- `package.defaultTarget` when the project wants bare `blr package` to resolve to a specific target
- `world` backend configuration when the project wants remote world storage

### `AGENTS.md`

Managed bootstrap file written by `blr`.

Purpose:

- acts as the root agent entrypoint for generated projects
- contains the managed BlurEngine instructions compiled into one file
- tells agents to read `AGENTS.project.md` after this file when it exists

`blr upgrade` refreshes this file.

### `AGENTS.project.md`

Committed project-specific agent instructions.

Purpose:

- holds user-owned project rules
- is read after `AGENTS.md`
- is not overwritten by `blr upgrade`

### `src/main.ts` or `src/main.js`

Minimal script entrypoint.

Notes:

- generated when scripting is enabled
- projects without scripting can add `src/main.ts` or `src/main.js` later and `blr` will detect it automatically
- scripting is only offered when a behavior pack is present
- when `bebe` is enabled, the generated entrypoint imports and initializes `@blurengine/bebe`
- when `bebe` is disabled, the generated entrypoint stays minimal and does not depend on `@blurengine/bebe`

Build note:

- `blr build` stages canonical output into `dist/stage/`
- when a runtime entry exists, the bundled runtime still writes to `runtime.outFile` first and is then synced into `dist/stage/behavior_packs/<packName>/scripts/`
- `blr dev`, `blr build --local-deploy`, and `blr package` all consume the staged output
- `blr` does not rewrite `behavior_packs/<packName>/scripts/main.js` inside the project by default

### `behavior_packs/<packName>/manifest.json`

Behavior pack manifest generated with:

- header UUID
- data module UUID
- default pack version
- default min engine version
- script module UUID when scripting is enabled
- Bedrock script module dependencies when scripting is enabled

Generated only when the project includes the behavior-pack feature.

### `resource_packs/<packName>/manifest.json`

Resource pack manifest generated with:

- header UUID
- resource module UUID
- default pack version
- default min engine version

Generated only when the project includes the resource-pack feature.

## State Files

### `worlds/<worldName>/`

Project-owned raw Bedrock world source.

Usage:

- used as the project-owned source world for BDS bootstrap/reset
- generated projects ignore `worlds/` by default so local world materialization does not get committed accidentally
- this nudges teams toward `blr world pull`, `blr world capture`, and `blr world push` instead of treating raw world state as normal source-controlled content
- projects that intentionally keep world sources in git can remove or narrow that ignore rule
- if `watch-world` and `restartOnWorldChange` are enabled, changes here trigger a BDS restart/reset
- if `watch-world` is enabled, `blr dev` captures the runtime BDS world back into this folder on shutdown
- `blr world capture` can seed or refresh this folder from the current runtime BDS world
- `blr world use <worldName>` can switch the active configured world and create the matching local folder when needed
- `blr package world-template` uses this as the source world payload
- `blr world pull` can materialize this folder from a remote S3-compatible backend
- `blr world push` can publish this folder back to the configured remote backend
- `blr create` does not generate this folder by default because an empty folder looks like a valid world when it is not
- world-aware commands require a real Bedrock world with a `db/` directory

### `server/allowlist.json`

Optional project state file.

If present, `blr` applies it to BDS allowlist state.

If `watch-allowlist` is enabled, runtime BDS allowlist changes are copied back into this file during `blr dev`.

### `server/permissions.json`

Optional project state file.

If present, `blr` applies it to BDS permissions state.

### `server/bedrock_server.exe`

Optional project state file for Windows local-server runs.

If present, `blr` copies it into the resolved runtime BDS server directory and uses it as the local-server executable override.

Notes:

- this overrides the provisioned `bedrock_server.exe` in the runtime BDS folder
- if the runtime BDS server is already provisioned, `blr` reuses that server and applies the override without re-downloading the stock archive
- `blr dev` prints a notice when the override is active

## Generated Support Files

### `.gitignore`

Generated defaults:

- managed `blr` ignore block with:
  - `node_modules/`
  - `dist/`
  - `.blr/`
  - `worlds/`
  - `.env.local`
  - `.DS_Store`

`.blr/` is where the CLI keeps project-local runtime workspace such as cached/provisioned BDS state by default.

User note:

- `blr` manages its own ignore block inside this file
- user-owned ignore entries can live outside that block

### `.env.local`

Optional machine-local environment file.

Purpose:

- stores secrets and machine-local overrides that should not live in `blr.config.json`
- common examples:
  - AWS credentials for `blr world pull` / `blr world push`
  - `BLR_MACHINE_LOCALSERVER_BDSVERSION`
  - `BLR_MACHINE_LOCALDEPLOY_MINECRAFTPRODUCT`
  - `BLR_WORLD_ACTOR`

Behavior:

- `blr` loads the closest `.env.local` automatically for project-aware commands
- values from the shell or CI environment still win because `.env.local` does not override existing variables

### `README.md`

Project-local quickstart and usage summary.

Generated README content is intentionally concise:

- actual generated directory structure for the selected project features
- the commands most likely to be used in day-to-day workflow
- a small notes section for config, `.env.local`, and optional world state

### `tsconfig.json`

Generated only for TypeScript scripting projects.

## Runtime Workspace

### `.blr/`

This is not created by `create` as committed source, but it is the default runtime workspace used by `blr`.

Typical contents may include:

- BDS zip cache
- provisioned BDS server files
- cached remote world archives and extracted world sources under `.blr/cache/worlds/`
- CLI-owned transient state under `.blr/state/`, such as prompt-silence state in `.blr/state/cli.json`
- other CLI-owned runtime state

This belongs to the CLI runtime, not to `blr.config.json`.

During `local-server` runs, `blr` may also manage runtime world hook files such as:

- `world_behavior_packs.json`
- `world_resource_packs.json`

Those files are only written when the corresponding pack automation is enabled for the current project and current run.

## Build Output

### `dist/stage/`

Canonical staged build output.

Typical contents:

- `behavior_packs/<packName>/`
- `resource_packs/<packName>/`

This is the source that `local-deploy`, `local-server`, and packaging targets consume.

### `dist/packages/`

Packaged distributable artifacts.

Current target:

- `<packName>.mctemplate` from `blr package`
