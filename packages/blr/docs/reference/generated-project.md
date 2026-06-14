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
  zones.json       # optional, user-created zone definitions
  render-anchors.json # optional, user-created distant entity visual definitions
  audio/           # optional, user-created BAUD audio sources
    cues/
      reward.baud
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
- `bebe` adds `@blurengine/bebe` for the default scripting scaffold, unless that option is disabled explicitly
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

Default version note:

- generated projects default `minecraft.channel` to `stable`
- `minecraft.targetVersion` is resolved from the latest stable Bedrock dedicated-server version available during `blr create`
- if that lookup fails, `blr create` falls back to its built-in default targetVersion instead of aborting scaffold generation

Optional later additions may include:

- `package.defaultTarget` when the project wants bare `blr package` to resolve to a specific target
- `world` backend configuration when the project wants remote world storage
- `bebe.diagnostics.missingReferences` when the project wants to choose whether missing soft references are warnings, errors, or ignored per pipeline
- `bebe.zoneEditor` when the project wants to disable the in-game Bebe zone editor during `blr dev` or intentionally include it during `blr package`

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
- when `bebe` uses its default scripting scaffold, the generated entrypoint imports and initializes `@blurengine/bebe`
- when `bebe` is disabled, the generated entrypoint stays minimal and does not depend on `@blurengine/bebe`

Build note:

- `blr build` stages canonical output into `dist/stage/`
- when a runtime entry exists, the bundled runtime still writes to `runtime.outFile` first and is then synced into `dist/stage/behavior_packs/<packName>/scripts/`
- when `zones.json` exists, `blr` asks the project-installed `@blurengine/bebe/tooling/node` compiler to bake it, then injects a `Zones.load(...)` bootstrap ahead of the authored runtime entry
- when `render-anchors.json` exists, `blr` asks the project-installed `@blurengine/bebe/tooling/node` compiler to bake it, stages generated behavior/resource pack JSON, then injects a `RenderAnchors.load(...)` and `RenderAnchors.start(...)` bootstrap ahead of the authored runtime entry
- when `audio/**/*.baud` exists, `blr` asks the project-installed `@blurengine/bebe/tooling/node` compiler to bake it into `dist/generated/bebe/audio.json`, copies the pack to staged scripts, and injects `Audio.load(...)` ahead of the authored runtime entry
- `blr dev`, `blr build --local-deploy`, and `blr package` all consume the staged output
- `blr` does not rewrite `behavior_packs/<packName>/scripts/main.js` inside the project by default

### `zones.json`

Optional authored Bebe zone pack.

Purpose:

- stores committed zone definitions that creators and tooling can edit
- keeps zone source separate from runtime code while still loading through `@blurengine/bebe`
- acts as the source file that future in-game editing tools can update after an explicit save

Shape:

```json
{
  "zones": [
    {
      "id": "spawn",
      "dimension": "minecraft:overworld",
      "extent": {
        "kind": "polygon",
        "points": [
          [0, 0],
          [40, 0],
          [40, 40],
          [0, 40]
        ],
        "y": { "min": 60, "max": 90 }
      }
    }
  ]
}
```

Behaviour:

- omitted by `blr create`; projects add it only when they need authored zones
- requires scripting and a project-installed `@blurengine/bebe` version that exposes `@blurengine/bebe/tooling/node`
- supports `block`, `box`, simple vertical `polygon`, and `infinite` extents
- Bebe validates duplicate zone ids per dimension during build
- writes the normalised and compiled pack to `dist/generated/bebe/zones.json`
- copies the baked pack to staged script output at `scripts/generated/bebe/zones.json`
- bundles a generated bootstrap so `Zones.load(...)` runs before the authored runtime entry
- `blr dev` watches this file automatically when `watch-scripts` is enabled and reloads the local server after rebaking it
- during `blr dev --local-server`, Bebe's zone draft save event writes this file through the same project-installed tooling surface and skips the write when the source content is unchanged

### `render-anchors.json`

Optional authored Bebe render-anchor pack.

Purpose:

- stores committed distant entity visual declarations
- keeps render-distance configuration separate from gameplay source
- lets Bebe and `blr` generate the carrier entities and always-render client animation contract

Shape:

```json
{
  "anchors": [
    {
      "id": "harbour.crane",
      "entity": "demo:crane",
      "location": [320, 80, -48]
    }
  ]
}
```

Behaviour:

- omitted by `blr create`; projects add it only when they need distant entity-like visuals
- requires scripting, a behavior pack, a resource pack, and a project-installed `@blurengine/bebe` version that exposes `@blurengine/bebe/tooling/node`
- writes the compiled runtime pack to `dist/generated/bebe/render-anchors.json`
- stages generated behavior/resource pack files without mutating authored Minecraft JSON
- bundles generated bootstrap so `RenderAnchors.load(...)` and `RenderAnchors.start(...)` run before the authored runtime entry
- `blr dev` watches this file automatically when `watch-scripts` is enabled and reloads the local server after rebaking it

### `audio/`

Optional authored Bebe BAUD audio source folder.

Purpose:

- stores committed hand-written BAUD audio cues
- keeps audio source separate from runtime code while still loading through `@blurengine/bebe`
- lets projects split compact audio cues across nested folders
- can receive editable BAUD output from `blr audio convert <input.mid>`

Example:

```text
audio/
  cues/
    reward.baud
  areas/
    meadow.baud
```

Behaviour:

- omitted by `blr create`; projects add it only when they need authored BAUD audio
- requires scripting and a project-installed `@blurengine/bebe` version that exposes `@blurengine/bebe/tooling/node`
- compiles `audio/**/*.baud` into the compact runtime pack at `dist/generated/bebe/audio.json`
- copies the baked pack to staged script output at `scripts/generated/bebe/audio.json`
- during `blr dev`, can also write the dev-only visual sidecar at `dist/generated/bebe/audio.visuals.json` and stage it under `scripts/generated/bebe/audio.visuals.json` for the internal audio command
- bundles generated bootstrap so `Audio.load(...)` runs before the authored runtime entry
- rejects a root-level `audio.baud`; BAUD project sources must live under `audio/`
- `blr audio convert <input.mid>` can create a `.baud` file under this folder by asking the project-installed Bebe tooling surface to convert Standard MIDI into editable BAUD text; supported General MIDI parts are mapped to curated Bedrock sounds, and unsupported parts are reported when they are dropped
- `blr dev` watches BAUD sources automatically when `watch-scripts` is enabled and reloads the local server after rebaking them
- when the installed Bebe package supports the internal dev command, `blr dev` injects `/<namespace>:audio`, `/<namespace>:audio list`, `/<namespace>:audio <cueId>`, and `/<namespace>:audio text "<baud>"` for auditioning BAUD cues in-game; the no-argument command opens a cue picker, and command playback uses action bar visualisation when supported by Bebe

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
- generated projects ignore raw world directories by default while allowing the project pin at `worlds/worlds.json` to be committed
- this nudges teams toward `blr world pull`, `blr world capture`, and `blr world push` instead of treating raw world state as normal source-controlled content
- projects that intentionally keep world sources in git can remove or narrow that ignore rule
- if `watch-world` and `restartOnWorldChange` are enabled, changes here trigger a BDS restart/reset
- if `watch-world` is enabled, `blr dev` captures the runtime BDS world back into this folder on shutdown
- `blr world capture` can seed or refresh this folder from the current runtime BDS world
- `blr world use <worldName>` can switch the active configured world and create the matching local folder when needed
- `blr package mctemplate` and `blr package mcworld` use this as the source world payload
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

If `watch-allowlist` is enabled, runtime BDS permissions changes are copied back into this file during `blr dev`.

### `server/server.properties`

Optional project state file.

If present, `blr` overlays its authored properties onto the runtime BDS `server.properties` file before startup.

`blr` still forces its managed local-server keys after the overlay:

- `allow-cheats`
- `allow-list`
- `level-name`
- `default-player-permission-level`
- `gamemode`
- `content-log-file-enabled`
- `content-log-console-output-enabled`

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
  - `worlds/**`
  - `!worlds/`
  - `!worlds/worlds.json`
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
- `bds_behavior_packs/<packName>/`
- `resource_packs/<packName>/`

The `behavior_packs` variant is used for offline/local Minecraft deployment. The `bds_behavior_packs` variant is used for local-server and standalone behavior-pack packaging. Resource packs remain shared.

When `zones.json` exists, both behavior-pack script variants include
`scripts/generated/bebe/zones.json`, and both bundled scripts load that baked pack
through `Zones` before running authored code.

When `render-anchors.json` exists, staged packs include the generated behavior-pack carrier entities, resource-pack client entity variants, and render-anchor animations. Both bundled scripts load `scripts/generated/bebe/render-anchors.json` and start `RenderAnchors` before running authored code.

When `audio/**/*.baud` exists, both behavior-pack script variants include
`scripts/generated/bebe/audio.json`, and both bundled scripts load that baked
pack through `Audio.load(...)` before running authored code.

During `blr dev`, both behavior-pack script variants can also include
`scripts/generated/bebe/audio.visuals.json` for the internal audio command's
loaded-cue action bar view. The visual sidecar is source-derived development
metadata; gameplay bootstrap still uses `audio.json` for playback.

When a project uses `Link` from `@blurengine/bebe`, direct `Link` calls are stripped from the offline behavior-pack script bundle and kept in the BDS script bundle.
`blr` injects and owns the BDS Link transport in the BDS bundle, so generated projects should use `Link` without manually installing the transport.
Dynamic Link usage such as assigning or destructuring `Link.event` or `Link.snapshot` fails the offline build with a clear error because `blr` cannot safely erase it.
During `blr dev --local-server`, the local Link server also exposes the built-in dashboard at its root URL when `dev.localServer.link.dashboard.enabled` is `true`.
`Link.event(...)`, `Link.snapshot(...)`, and `Link.on(...)` own their availability checks, so authored code should call them directly; response flows should be handled as separate inbound events with `Link.on(...)`.
`Link.snapshot(...)` marks an event as latest-retained state, so the local Link server keeps the newest value separately from the default stream log.
The Link bridge assigns fixed-length base64 UUIDv7 event ids for replay and dedupe and exposes them through `event.meta`.

When `bebe.zoneEditor.dev` is `true`, `blr dev` injects the internal Bebe zone editor runtime into script bundles when the project-installed Bebe package supports it. This is enabled by default for development. The editor command uses the project namespace, for example `/<namespace>:zone`. `bebe.zoneEditor.package` defaults to `false`, so packaged output excludes the editor unless the project explicitly opts in.

During `blr dev`, Bebe's internal audio player command is also injected when the installed Bebe package supports it. Use `/<namespace>:audio` to open a picker for loaded BAUD cue ids, `/<namespace>:audio list` to print them, and `/<namespace>:audio <cueId>` to play one for the command player. Use `/<namespace>:audio text "cue preview t120; @lead note.harp o4 l4 v80; c"` to compile and play one inline BAUD cue, with `;` standing in for BAUD file newlines. If the command player already has command-started audio playing, the picker shows `Clear`, and starting another command cue replaces that player's previous command playback. This is dev-command behavior only; runtime `Audio.play(...)` calls can still overlap. Command playback shows an action bar visualisation when supported by Bebe: inline text and loaded cues with `audio.visuals.json` use source-aware `@voice` layers, while loaded cues without the sidecar fall back to the compact compiled view. Packaged output excludes this dev audio command and the visual sidecar.

### Link Responsibility Boundary

Generated projects own authored Link event names, payloads, and gameplay behavior. For example, a project may choose to emit a project-specific ready event or publish a player list.

Bebe owns the public `Link` API imported from `@blurengine/bebe`, including the `Link.event(...)`, `Link.snapshot(...)`, and `Link.on(...)` contract, the `LinkEvent` shape, safe unavailable behavior, retained inbound registrations, transport status, capabilities, transport-generated metadata, and BDS-owned smoke behavior such as `bebe.link.ready`.

`blr` owns the local Link server, dashboard host, HTTP API, default dashboard send event (`project.message`), Bebe's zone draft save bridge to `zones.json`, BDS transport injection, zone editor runtime injection policy, offline Link stripping, and selection of the correct staged behavior-pack variant for local-deploy, local-server, and packaging.

Generated project code should not import Bebe internal transport paths such as `@blurengine/bebe/internal/link/bds`. Those paths exist for `blr` bootstrap/runtime wiring, not gameplay code.
Generated project code also should not import `@blurengine/bebe/tooling/*`. Tooling subpaths are Node-only build surfaces that `blr` resolves from the project installation when it needs to bake Bebe assets.

### `dist/packages/`

Packaged distributable artifacts.

Current package targets:

- `<packName>.mctemplate` from `blr package`
- `<packName>.mcworld` from `blr package mcworld`
- `<packName>.mcaddon` from `blr package mcaddon`
- `<behaviorPackName>-behavior.mcpack` from `blr package behavior-pack` using the BDS behavior-pack variant
- `<resourcePackName>-resource.mcpack` from `blr package resource-pack`
- `<worldName>-world.<format>` from `blr package world`
- `assets.zip` from `blr package assets`
