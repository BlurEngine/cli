# Command Reference

## Invocation

- Scaffold: `npx @blurengine/cli@latest create`
- Generated projects run the installed binary through package-manager scripts, for example `npm run dev`, `pnpm run dev`, `yarn run dev`, or `bun run dev`
- Generated projects also expose a `system` package script for support diagnostics
- Generated projects also expose a `world` package script for world backend operations

Windows PowerShell note:

- prefer `npm.cmd`, `npx.cmd`, `pnpm.cmd`, and similar package-manager shims when passing extra CLI flags, so the flags are forwarded to `blr` correctly

## Boolean Flag Behavior

Boolean flags accept these forms:

- `--flag` -> `true`
- `--flag true`
- `--flag false`
- omit the flag -> command default or config fallback

## `blr create`

Scaffolds a new BlurEngine project.

Syntax:

```text
blr create [projectName]
```

Flags:

- `--namespace <namespace>`: required project namespace
- `--package-manager <packageManager>`: `npm | pnpm | yarn | bun`
- `--behavior-pack [enabled]`: generate or skip the behavior pack scaffold
- `--resource-pack [enabled]`: generate or skip the resource pack scaffold
- `--scripts [enabled]`: generate or skip scripting source and behavior-pack script setup
- `--bebe [enabled]`: generate or skip `@blurengine/bebe` scaffolding when scripting is enabled
- `--language <language>`: `ts | js`
- `--yes`: skip prompts and require flags/arguments
- `--force`: replace an existing non-empty target directory
- `--install`: install dependencies after scaffolding
- `--no-install`: skip dependency installation
- `--local-deps`: opt into local `file:` dependencies for `@blurengine/cli` and `@blurengine/bebe` when generating inside a compatible BlurEngine workspace

Prompt behavior:

- if a required value is not passed and `--yes` is not set, `create` prompts for it
- the default path stays minimal: project name, namespace, feature checklist, optional scripting language, package manager, install
- the feature checklist selects:
  - `Behavior pack`
  - `Resource pack`
  - `Advanced setup`
- at least one content pack must be selected
- if advanced setup is selected and a behavior pack is present, `create` asks a follow-up checklist for scripting
- if scripting is enabled, `create` asks whether to scaffold `@blurengine/bebe`
- if scripting is enabled and no explicit `--bebe` value is provided, the scaffold includes `@blurengine/bebe`
- the language prompt only appears when scripting is enabled explicitly
- prompts map directly to CLI flags so the command stays scriptable
- generated `blr.config.json` uses the latest stable Bedrock dedicated-server version available from the Bedrock download service at scaffold time
- if that lookup fails, `create` falls back to the built-in default targetVersion and still scaffolds successfully

## `blr dev`

Runs the development workflow.

Workflow:

1. stage canonical build output into `dist/stage`
2. optionally local-deploy to the Minecraft development root
3. optionally provision/sync/start BDS from staged output
4. optionally watch source files and capture selected runtime state back into the project

When watch mode is active:

- `blr` prints `[dev] Watching for changes...` once any enabled watcher is ready
- `watch-scripts` uses the configured project-relative glob-style watch paths
- runtime source changes trigger a rebuild and local-server `reload`
- `.test.*` files do not trigger rebuilds or reloads
- behavior-pack and resource-pack changes are not watched by default; if explicitly watched, they trigger a rebuild and resync without sending `reload`
- `blr.config.json` and `package.json` are not watched by default; if you add them to `dev.watch.paths`, `blr` tells you to restart `dev` instead of reloading
- `watch-allowlist` watches runtime BDS server-state files and copies them back into project state:
  `allowlist.json` -> `server/allowlist.json`
  `permissions.json` -> `server/permissions.json`
- `watch-world` watches the project world source for restart/reset triggers and captures the runtime BDS world back into that project world source on shutdown
- `watch-world` starts only after startup world reconciliation is complete
- `watch-world` requires the project world source to contain a valid Bedrock world (`db/` directory)

When `world.backend` is `s3` and `local-server` is selected:

- `blr` treats `worlds/worlds.json` as the project pin for the active remote world version
- `projectWorldMode` controls how `dev` handles remote project-world updates:
  - `prompt`: prompt for newer remote versions in interactive terminals
  - `auto`: pull automatically
  - `manual`: keep the current project world unless you pull manually
- if the project world is missing and a matching pinned version is required, `dev` treats that as required reconciliation:
  - `prompt`: ask before pulling
  - `auto`: pull automatically
  - `manual`: fail clearly
- optional newer-remote prompts use:
  - `Pull latest remote world`
  - `Keep current world`
  - `Silence 24h`
- if the project pin belongs to a different remote world configuration than the current `blr.config.json`, `dev` ignores that stale pin until a new remote action refreshes it
- if bucket versioning is unavailable, version-aware remote world sync is unavailable and `dev` falls back to the local/manual world workflow
- if `dev` needs a remote pull because of the selected mode and that pull fails, startup stops instead of continuing silently

When `local-server` is live:

- terminal input is forwarded to BDS line-by-line
- type a server command and press Enter
- press `Ctrl+C` once to shut down the full `dev` session
- if the managed server exits, `dev` shuts down its watch session too

Pack automation defaults:

- by default, pack deployment/sync/attachment follows the project feature shape
- if a behavior pack is present, behavior-pack automation is enabled by default
- if a resource pack is present, resource-pack automation is enabled by default
- CLI flags, env vars, and `blr.config.json` can narrow that behavior per context

Interactive behavior:

- `dev` now uses `blr.config.json` plus built-in CLI defaults to resolve the run automatically by default
- use `-i` or `--interactive true` to force the interactive checklist
- the first interactive page selects `local-deploy` and `local-server`
- if `local-server` is enabled and the effective BDS version for the run came from `blr.config.json`, `dev` can prompt before the watch page when it finds a newer dedicated-server version for the configured `minecraft.channel`
- that prompt can:
  - update `blr.config.json -> minecraft.targetVersion` immediately
  - continue without changing the project
  - continue without local server when the selected BDS version is not available on the configured channel
  - silence the prompt for 24 hours for that specific newer version
- if the active local-server version came from CLI or environment overrides, `dev` does not show upgrade prompts for `minecraft.targetVersion`
- when interactive mode is disabled and the configured local-server version is unavailable on the selected channel, `dev` exits immediately instead of prompting
- the second interactive page selects watch/capture items
- `watch-world` and `watch-allowlist` are only offered on the second page when `local-server` is selected
- the third interactive page selects pack automation for this run when local deploy or local server are active
- explicit CLI flags still override the config-driven defaults for that run, and `-i` can still force the checklist when those flags are present
- pressing `Ctrl+C` during an interactive prompt aborts the command immediately
- confirming with no selected items exits cleanly without doing any work
- if no active dev targets are enabled, `dev` performs the initial build and exits even when `watch` would otherwise be `true`

Runtime world safety:

- `runtimeWorldMode` controls how `dev` seeds the BDS runtime world from the project world
- if the runtime world is missing, `dev` copies the current project world into BDS automatically
- if the runtime world exists:
  - `replace`: replace it automatically from the project world before startup
  - `backup`: move it into `worlds_backups/` and then replace it before startup
- with `prompt` and `preserve`, `dev` compares the project world source against the last runtime seed:
  - `prompt`: ask before replacing it
  - `preserve`: keep it
- runtime backup and replacement only happen before BDS starts

Flags:

- `-i, --interactive [enabled]`: force or disable the checklist
- `--local-deploy [enabled]`: enable or disable local deploy
- `--local-deploy-behavior-pack [enabled]`: enable or disable behavior-pack deployment for this run
- `--local-deploy-resource-pack [enabled]`: enable or disable resource-pack deployment for this run
- `--local-server [enabled]`: enable or disable local server
- `--local-server-behavior-pack [enabled]`: enable or disable behavior-pack sync into the local server for this run
- `--local-server-resource-pack [enabled]`: enable or disable resource-pack sync into the local server for this run
- `--attach-behavior-pack [enabled]`: enable or disable behavior-pack attachment in local-server world pack hooks for this run
- `--attach-resource-pack [enabled]`: enable or disable resource-pack attachment in local-server world pack hooks for this run
- `--watch [enabled]`: enable or disable watch mode
- `--watch-scripts [enabled]`: enable or disable source/packs watch and rebuild-reload behavior
- `--watch-world [enabled]`: enable or disable runtime world capture back into the project world source
- `--watch-allowlist [enabled]`: enable or disable runtime server-state capture back into project state
- `--production [enabled]`: enable or disable production bundling
- `--minecraft-product <product>`: override local deploy target
- `--minecraft-development-path <path>`: override local deploy root
- `--bds-version <version>`: override BDS version
- `--bds-platform <platform>`: `win | linux | auto`
- `--bds-cache-dir <path>`: override BDS cache directory
- `--bds-server-dir <path>`: override BDS server directory
- `--world <worldName>`: override the active world for this run
- `--restart-on-world-change [enabled]`: enable or disable full server restart when the project world source changes
- `--compact-scripting-logs [enabled]`: enable or disable compacting extra blank lines after BDS scripting logs
- `--debug [enabled]`: enable or disable debug logs for watch/build/sync/server lifecycle activity

Examples:

```text
blr dev
blr dev -i
blr dev --watch false
blr dev --watch-scripts true --local-server false
blr dev --local-server true --watch-world true
blr dev --local-server true --watch-allowlist true
blr dev --local-server true --bds-version 1.26.0.2
blr dev --local-server true --world "Creative Sandbox"
blr dev --local-server true --compact-scripting-logs false
blr dev --local-deploy true --minecraft-product Custom --minecraft-development-path D:/com.mojang
blr dev --debug
```

## `blr build`

Runs one-shot build tasks.

Build output:

- `blr build` stages canonical output into `dist/stage`
- behavior pack source is copied to `dist/stage/behavior_packs/<packName>` when the project includes a behavior pack
- resource pack source is copied to `dist/stage/resource_packs/<packName>` when the project includes a resource pack
- when the project has a runtime entry, the bundled script output is copied into the staged behavior pack `scripts/` directory
- `local-deploy` and `local-server` both consume this staged output instead of reading source packs directly

Flags:

- `--production [enabled]`: enable or disable production bundling
- `--local-deploy [enabled]`: enable or disable local deployment after build
- `--local-deploy-behavior-pack [enabled]`: enable or disable behavior-pack deployment for this run
- `--local-deploy-resource-pack [enabled]`: enable or disable resource-pack deployment for this run
- `--minecraft-product <product>`: override local deploy target
- `--minecraft-development-path <path>`: override local deploy root
- `--debug [enabled]`: enable or disable debug logs for build/deploy activity

Examples:

```text
blr build
blr build --production
blr build --local-deploy true --minecraft-product BedrockUWP
blr build --debug
```

## `blr package`

Produces distributable project artifacts from the staged build output.

Syntax:

```text
blr package [targets...]
```

Currently supported targets:

- `mctemplate`
- `mcworld`
- `mcaddon`
- `behavior-pack`
- `resource-pack`
- `world`
- `assets`

`mctemplate` behavior:

- runs `build` first
- reads the selected project world source
- copies only the staged packs that are present into a template package workspace
- writes `dist/packages/<packName>.mctemplate` for the configured default world
- writes `dist/packages/<packName>-<worldName>.mctemplate` when packaging a different world with `--world`
- requires the project world source to contain a valid Bedrock world (`db/` directory)
- if `world.backend` is `s3`, pull the world first with `blr world pull`

`mcworld` behavior:

- runs `build` first
- reads the selected project world source
- copies only the staged packs that are present into a world package workspace
- updates the packaged world's pack reference files for included staged packs
- writes `dist/packages/<packName>.mcworld` for the configured default world
- writes `dist/packages/<packName>-<worldName>.mcworld` when packaging a different world with `--world`
- requires the project world source to contain a valid Bedrock world (`db/` directory)
- if `world.backend` is `s3`, pull the world first with `blr world pull`

`mcaddon` behavior:

- runs `build` first
- copies only the staged packs that are present into an addon package workspace
- writes `dist/packages/<packName>.mcaddon`
- does not require a project world source

`behavior-pack` behavior:

- runs `build` first
- copies the staged behavior pack into a package workspace
- writes `dist/packages/<behaviorPackName>-behavior.mcpack`
- does not require a project world source
- fails if the project has no staged behavior pack

`resource-pack` behavior:

- runs `build` first
- copies the staged resource pack into a package workspace
- writes `dist/packages/<resourcePackName>-resource.mcpack`
- does not require a project world source
- fails if the project has no staged resource pack

`world` behavior:

- runs `build` first
- reads the selected project world source
- copies the raw world contents into a package workspace without staged packs
- skips backup and noise files such as `.gitkeep`, `.DS_Store`, `Thumbs.db`, `.world_backups`, `worlds_backups`, `*.blr-backup-*`, `*.bak`, `*.tmp`, and timestamped world backup directories
- writes `dist/packages/<worldName>-world.tar.gz` by default
- supports `tar.gz`, `zip`, and `mcworld` world package formats
- uses the same archive structure for every format, with the Bedrock world files at the archive root
- requires the project world source to contain a valid Bedrock world (`db/` directory)
- if `world.backend` is `s3`, pull the world first with `blr world pull`

`assets` behavior:

- runs `build` first
- writes `dist/packages/assets.zip`
- writes an `assets.json` manifest at the archive root
- includes `worlds/<worldName>/map.png`, `map.terrain.png`, `map.shade.png`, `map.full.png`, and `map.terrain.audit.json` by default when `package.assets.worldImage.enabled` is `true`
- renders generated world images from Bedrock LevelDB `Data3D` loaded-column and biome records plus `SubChunkPrefix` block records in the selected project world source
- copies the world `db/` directory to a temporary location before reading it
- requires the project world source to contain a valid Bedrock world (`db/` directory) when world image generation is enabled
- if `world.backend` is `s3`, pull the world first with `blr world pull`

Target resolution:

- if one or more `<targets>` are passed, `blr` packages those targets in order
- if `<targets>` are omitted, `blr` resolves targets from `blr.config.json -> package.defaultTargets`
- if `<targets>` are omitted and `package.defaultTargets` is not set, `blr` resolves a single target from `package.defaultTarget`
- if `<targets>` are omitted and no config default exists, `blr` uses `mctemplate`

Flags:

- `--production [enabled]`: enable or disable production bundling before packaging
- `--world <worldName>`: override the active world for this packaging run
- `--world-format <format>`: override the raw world package format for this run (`tar.gz`, `zip`, or `mcworld`)
- `--include-behavior-pack [enabled]`: enable or disable behavior-pack inclusion for package targets that embed staged packs
- `--include-resource-pack [enabled]`: enable or disable resource-pack inclusion for package targets that embed staged packs
- `--debug [enabled]`: enable or disable debug logs for packaging activity

Examples:

```text
blr package
blr package mctemplate
blr package mcworld
blr package mcaddon
blr package behavior-pack resource-pack
blr package world
blr package assets
blr package world --world-format zip
blr package --world "Creative Sandbox"
blr package mctemplate --production
blr package mcworld --debug
```

## `blr minecraft`

Manages project Minecraft target-version checks and updates.

### `blr minecraft check`

Checks the configured `minecraft.targetVersion` against the latest Bedrock dedicated-server version for the configured `minecraft.channel`.

Behavior:

- reports the configured channel and targetVersion
- reports the latest dedicated-server version for that channel
- warns if the configured version no longer resolves on that channel
- warns if the configured version appears to belong to the opposite channel

Flags:

- `--debug [enabled]`: enable or disable debug logs for Minecraft version checks

### `blr minecraft update`

Updates `blr.config.json -> minecraft.targetVersion` to the latest Bedrock dedicated-server version for the configured channel.

Behavior:

- shows the same status summary as `minecraft check`
- prompts for confirmation by default, naming the current configured version before the target version it plans to apply
- can update even when the configured version is not outdated but no longer resolves on the configured channel

Flags:

- `--yes`: apply the update without confirmation
- `--debug [enabled]`: enable or disable debug logs for Minecraft version checks

Examples:

```text
blr minecraft check
blr minecraft update
blr minecraft update --yes
```

## `blr system`

Prints safe support diagnostics about the current CLI environment and project.

### `blr system info`

Prints environment and project context in a support-friendly format.

Behavior:

- works both inside and outside a generated BlurEngine project
- redacts home-directory paths when path output is enabled
- does not print environment variables or secrets
- can include project-relative world/runtime state and machine resolution details
- can emit `text`, `json`, or `markdown`

Flags:

- `--format <format>`: `text | json | markdown`
- `--include-paths [enabled]`: include redacted filesystem paths
- `--include-remote [enabled]`: include remote world backend coordinates when available
- `--debug [enabled]`: enable or disable debug logs for system diagnostics

### `blr system doctor`

Runs actionable diagnostics for the current project.

Behavior:

- fails with exit code `1` when blocking issues are found
- warns about non-blocking issues such as an outdated targetVersion or missing local world source
- checks project scaffold version, Minecraft channel/version alignment, local world readiness, and local deploy root resolution
- can include remote world backend diagnostics for S3-backed projects
- can emit `text`, `json`, or `markdown`

Flags:

- `--format <format>`: `text | json | markdown`
- `--include-paths [enabled]`: include redacted filesystem paths
- `--include-remote [enabled]`: include remote world backend coordinates when available
- `--debug [enabled]`: enable or disable debug logs for system diagnostics

Examples:

```text
blr system info
blr system info --format markdown
blr system doctor
blr system doctor --format json
```

## `blr world`

Manages project world sources and optional remote world backends.

Purpose:

- keeps the project-owned world source under `worlds/<worldName>/`
- generated projects ignore raw world directories by default while allowing the project pin at `worlds/worlds.json` to be committed
- allows explicit pull/push against an S3-compatible backend
- keeps remote locking separate from `dev`, so live development does not silently overwrite shared worlds

Remote object layout for the S3 backend:

- `<keyPrefix>/<worldName>.zip`
- `<keyPrefix>/<worldName>.lock.json`

Notes:

- `keyPrefix` defaults to `worlds`
- `projectPrefix` is disabled by default
- if `projectPrefix` is enabled, the layout becomes `<keyPrefix>/<projectName>/<worldName>.zip` and `<keyPrefix>/<projectName>/<worldName>.lock.json`
- the lock file contains metadata about the owning actor, command, reason, CLI version, and expiry time
- `blr world list` always works from the current object layout
- bucket versioning is required for versioned remote world workflows:
  - `blr world versions`
  - `blr world pull`
  - `blr world pull --version-id`
  - `blr world push`
  - remote world sync behavior in `blr dev`
- `blr world status` and `blr world list` still work when bucket versioning is unavailable
- `blr dev` and `blr package` still operate on the local project world source; they do not auto-push remote worlds
- successful versioned remote pull and push operations create or refresh `worlds/worlds.json`
- `worlds/worlds.json` is a project pin, not a second copy of `blr.config.json`
- each tracked world entry stores:
  - `name`
  - `remoteFingerprint`
  - `versionId`
- internal runtime and materialization bookkeeping lives under `.blr/state/world-state.json`
- generated projects ignore raw world contents by default but still allow `worlds/worlds.json` to be committed
- if the remote fingerprint drifts, `blr` ignores the stale pin until the next successful remote world action refreshes it

### `blr world list`

Lists remote world names from the configured S3 backend namespace.

Syntax:

```text
blr world list
```

Behavior:

- scans the configured S3 namespace for `<worldName>.zip` objects
- ignores lock files and unrelated objects
- works even when bucket versioning is unavailable
- includes latest remote object metadata in JSON output when bucket versioning is enabled
- prints a short note when remote version information cannot be verified for the configured bucket

Flags:

- `--json [enabled]`: print JSON output for scripting
- `--debug [enabled]`: enable or disable debug logs for world backend activity

### `blr world use`

Sets the active project world in `blr.config.json`.

Syntax:

```text
blr world use [worldName]
```

Behavior:

- updates `dev.localServer.worldName`
- updates `dev.localServer.worldSourcePath` when it still uses the default `worlds/<worldName>` convention
- preserves an explicit custom `worldSourcePath` if the project already opted out of the default layout
- creates the selected local world source directory if it does not exist yet

Flags:

- `--debug [enabled]`: enable or disable debug logs for world backend activity

### `blr world status`

Prints the resolved local world source state and, when `world.backend` is `s3`, the resolved remote object and lock state.

Syntax:

```text
blr world status [worldName]
```

Behavior:

- includes local world validity
- includes remote lock and latest object metadata when `world.backend` is `s3`
- includes tracked project pin details from `worlds/worlds.json` when present
- reports whether that tracked pin still matches the current remote world target
- includes the last remote version materialized into the project world when available

Flags:

- `--debug [enabled]`: enable or disable debug logs for world backend activity

### `blr world image`

Exports top-down 2D PNGs from the selected project world source.

Syntax:

```text
blr world image [worldName]
```

Behavior:

- resolves the selected project world source using the same world-selection rules as other `blr world` commands
- reads Bedrock LevelDB `Data3D` heightmap records from `<worldSourcePath>/db`
- reads Bedrock LevelDB `SubChunkPrefix` block records from `<worldSourcePath>/db`
- copies the `db/` directory to a temporary location before opening LevelDB
- renders a loaded-columns PNG plus terrain, shade, and full PNG variants
- defaults to `dist/assets/worlds/<worldName>/map.png`
- writes sibling image variants beside the primary file:
  - `map.terrain.png`: top-down terrain colors from actual Bedrock block data
  - `map.shade.png`: grayscale local-height-difference shading
  - `map.full.png`: terrain colors multiplied by local-height-difference shading
- writes `map.terrain.audit.json` beside the terrain PNG with processed world bounds, block dimensions, image dimensions, actual top-column block counts, tint counts, fallback counts, and unknown-block counts
- the terrain image is block-derived from `SubChunkPrefix` records and does not use the `Data3D` heightmap cache as terrain truth
- biome tinting uses `Data3D` biome palettes at the selected top block's Y slice; legacy `Data2D` stores only XZ biomes and is not the terrain tint source
- supports the `overworld`, `nether`, and `end` dimensions
- if the local world source is missing for an S3-backed project, the error points back to `blr world pull`

Maintainer note:

Terrain colors are generated from an external `bedrock-samples` checkout. Maintainers can run `npm run generate:terrain-colors`. The script uses `../forks/bedrock-samples` by default, or `BLR_BEDROCK_SAMPLES_DIR` from an ignored `.env.local`. Do not commit proprietary texture assets or real local paths.

Flags:

- `--output <path>`: write the primary loaded-columns PNG to a project-relative or absolute output path; terrain, shade, and full variants use the same stem
- `--dimension <dimension>`: `overworld | nether | end`
- `--scale <scale>`: integer pixel scale from `1` to `16`
- `--debug [enabled]`: enable or disable debug logs for world image export activity
- `--timings`: print timing checkpoints for database copy, LevelDB reads, audit writing, rendering, PNG writing, cleanup, and total duration

### `blr world level-dat dump`

Dumps the selected world's Bedrock `level.dat` file as JSON.

Syntax:

```text
blr world level-dat dump [worldName]
```

Behavior:

- resolves the selected project world source using the same world-selection rules as other `blr world` commands
- also accepts a path-like positional argument or `--path` that points to a world directory or an explicit `.dat` file
- can run outside a BlurEngine project when an explicit world directory or `.dat` path is provided
- reads `<worldSourcePath>/level.dat`
- parses the Bedrock `level.dat` 8-byte header and the little-endian NBT payload
- defaults to `simplified` output, which is easier to read but drops NBT type metadata
- supports `typed` output, which preserves tag types and the root tag shape for future round-trip editing work
- prints JSON to stdout by default
- writes JSON to a file when `--output` is provided
- if the local world source is missing for an S3-backed project, the error points back to `blr world pull`

Flags:

- `--path <path>`: read `level.dat` from a world directory or explicit `.dat` path
- `--format <format>`: `simplified | typed`
- `--output <path>`: write the JSON dump to a file instead of stdout
- `--debug [enabled]`: enable or disable debug logs for world `level.dat` activity

### `blr world level-dat edit`

Interactively edits scalar Bedrock `level.dat` fields.

Syntax:

```text
blr world level-dat edit [worldName]
```

Behavior:

- resolves the selected project world source using the same world-selection rules as other `blr world` commands
- also accepts a path-like positional argument or `--path` that points to a world directory or an explicit `.dat` file
- can run outside a BlurEngine project when an explicit world directory or `.dat` path is provided
- opens a searchable interactive editor over the parsed Bedrock `level.dat` compound tree
- supports navigating nested compound tags, editing scalar `byte`, `short`, `int`, `long`, `float`, `double`, and `string` values, adding new scalar or compound fields, and removing existing fields
- currently treats list and array tags as read-only and prints a short note when you try to edit them
- creates a timestamped backup next to `level.dat` before saving by default
- refuses to edit while an active `blr dev` session is running `watch-world` for the same world
- requires an interactive terminal

Flags:

- `--path <path>`: read `level.dat` from a world directory or explicit `.dat` path
- `--backup [enabled]`: create or skip a backup before saving changes
- `--debug [enabled]`: enable or disable debug logs for world `level.dat` activity

### `blr world level-dat diff`

Compares two Bedrock `level.dat` inputs and prints a debug-friendly diff.

Syntax:

```text
blr world level-dat diff [leftTarget] [rightTarget]
```

Behavior:

- resolves the left-side target using the same world-selection rules as `dump` and `edit`
- accepts two positional targets for the left and right sides
- also supports `--path` for the left side and `--against` as an alternate right-side form
- both sides can point to either a world directory or an explicit `.dat` file
- can run outside a BlurEngine project when the left side is provided as an explicit world directory or `.dat` path
- compares both Bedrock header metadata and typed NBT tag data
- defaults to `text` output with a diff-like format
- supports `json` output for scripting or deeper inspection

Flags:

- `--path <path>`: read the left-side `level.dat` from a world directory or explicit `.dat` path
- `--against <path>`: optional alternate way to provide the right-side world name or path
- `--format <format>`: `text | json`
- `--debug [enabled]`: enable or disable debug logs for world `level.dat` activity

### `blr world versions`

Lists remote object versions for the selected world when bucket versioning is enabled.

Syntax:

```text
blr world versions [worldName]
```

Behavior:

- if `worldName` is omitted in an interactive terminal, `blr` offers a world picker built from tracked worlds in `worlds/worlds.json` plus local directories under `worlds/`
- if `worldName` is omitted in non-interactive use or with `--json`, `blr` falls back to `dev.localServer.worldName`
- lists newest-to-oldest remote object versions for `<worldName>.zip`
- shows who pushed each version when that push metadata is recorded on the remote object
- fails with a short friendly message when bucket versioning is not available for the configured backend

Flags:

- `--json [enabled]`: print JSON output for scripting
- `--debug [enabled]`: enable or disable debug logs for world backend activity

### `blr world pull`

Pulls a remote world into the local project world source.

Syntax:

```text
blr world pull [worldName]
```

Behavior:

- requires bucket versioning for the configured S3 backend
- by default, acquires the remote world lock first
- downloads `<worldName>.zip` into `.blr/cache/worlds/<bucket>/<worldName>/<encodedVersionId>.zip`
- extracts it temporarily, copies the result into `worlds/<worldName>/`, and then removes the extracted cache copy
- can pull a specific remote object version when bucket versioning is enabled
- if the remote object is missing, the command fails without reporting success
- writes or refreshes the project pin in `worlds/worlds.json`
- prints the pulled remote version ID on success
- fails if the same world is currently being watched by an active `blr dev` local-server session

Flags:

- `--lock [enabled]`: acquire or skip the remote lock before pulling
- `--force-lock [enabled]`: steal the remote lock when necessary
- `--reason <reason>`: lock reason recorded in the remote lock object
- `--version-id <versionId>`: pull a specific remote object version when bucket versioning is enabled
- `--debug [enabled]`: enable or disable debug logs for world backend activity

### `blr world capture`

Captures the current runtime BDS world into the local project world source.

Syntax:

```text
blr world capture [worldName]
```

Behavior:

- reads the runtime world from the resolved local BDS server directory
- copies it into `worlds/<worldName>/`
- works for first-time world seeding from a generated BDS runtime
- refuses to overwrite an already populated project world source unless `--force` is set

Flags:

- `--force [enabled]`: replace the existing project world source when it is already populated
- `--bds-version <version>`: override the BDS version for this run
- `--bds-platform <platform>`: `win | linux | auto`
- `--bds-cache-dir <path>`: override BDS cache directory for this run
- `--bds-server-dir <path>`: override BDS server directory for this run
- `--debug [enabled]`: enable or disable debug logs for world capture activity

### `blr world push`

Pushes the local project world source to the remote backend.

Syntax:

```text
blr world push [worldName]
```

Behavior:

- validates that the local world source contains a real Bedrock world (`db/`)
- requires bucket versioning for the configured S3 backend
- acquires the remote world lock before uploading
- archives the local world temporarily for upload and does not keep extra extracted cache state
- uploads the archive to the resolved remote object key
- compares the project pin in `worlds/worlds.json` against the latest remote version before uploading
- if the project is missing a tracked base version or the remote has moved ahead, `blr` refuses to push by default
- in an interactive terminal, `blr` lets you confirm a force push explicitly
- in a non-interactive terminal, `blr` exits with a clear error instead of guessing
- unlocks after a successful push by default
- writes the newly pushed remote version back into `worlds/worlds.json`
- writes BlurEngine push metadata onto the uploaded object when the S3-compatible backend preserves custom object metadata

Flags:

- `--unlock [enabled]`: release or keep the remote lock after a successful push
- `--force-lock [enabled]`: steal the remote lock when necessary
- `--reason <reason>`: lock reason recorded in the remote lock object
- `--debug [enabled]`: enable or disable debug logs for world backend activity

### `blr world lock`

Acquires the remote world lock without transferring any world data.

Syntax:

```text
blr world lock [worldName]
```

Flags:

- `--force [enabled]`: force lock acquisition when another actor owns the lock
- `--ttl-seconds <seconds>`: override the lock TTL for this run
- `--reason <reason>`: lock reason recorded in the remote lock object
- `--debug [enabled]`: enable or disable debug logs for world backend activity

### `blr world unlock`

Releases the remote world lock.

Syntax:

```text
blr world unlock [worldName]
```

Flags:

- `--force [enabled]`: force unlock when another actor owns the lock
- `--debug [enabled]`: enable or disable debug logs for world backend activity

Examples:

```text
blr world use "Creative Sandbox"
blr world list
blr world status
blr world image
blr world image --output previews/world-map.png --scale 2
blr world image "Creative Sandbox" --dimension nether
blr world level-dat edit
blr world level-dat edit --path ./worlds/Bedrock level
blr world level-dat edit --path C:/Users/example/Downloads/level (1).dat
blr world level-dat dump
blr world level-dat dump --path ./worlds/Bedrock level
blr world level-dat dump --path C:/Users/example/Downloads/level (1).dat
blr world level-dat dump --format typed --output .tmp/level.dat.json
blr world level-dat diff ./worlds/Bedrock level ./worlds/Creative Sandbox
blr world level-dat diff --against ./worlds/Creative Sandbox
blr world level-dat diff --path ./worlds/Bedrock level --against C:/Users/example/Downloads/level (1).dat
blr world versions
blr world capture
blr world capture --force true
blr world pull
blr world pull --version-id 3Lg7yT5wV5mN6bR6dExample
blr world pull "Bedrock level" --reason "start editing session"
blr world push --unlock false --reason "save progress and keep lock"
blr world lock --ttl-seconds 14400 --reason "long editing session"
blr world unlock
```

## `blr clean`

Removes `dist/`.

Notes:

- `clean` does not remove `.blr/`
- `.blr/` is runtime workspace/cache and is ignored by the generated `.gitignore`

## `blr upgrade`

Aligns the generated-project scaffold with the current CLI contract.

Flags:

- `--dry-run [enabled]`: preview changes without writing
- `--refresh-dependencies [enabled]`: enable or disable dependency baseline refresh for this run
- `--refresh-agents [enabled]`: enable or disable managed `AGENTS.md` refresh for this run

Notes:

- `upgrade` runs ordered project migrations and updates `projectVersion`
- old projects must be upgraded before normal project commands will run
- `upgrade` reconciles the managed package-script set in `package.json`
- `upgrade` reconciles the managed `.gitignore` block
- file-based local dependencies are preserved
- `upgrade` updates dependency baselines by default
- `upgrade` refreshes `AGENTS.md` by default
- `upgrade` preserves `AGENTS.project.md`
- `--refresh-dependencies` and `--refresh-agents` override `blr.config.json` for the current run

## Generated Package Scripts

Generated projects expose these scripts:

- `<packageManager> run dev` -> `blr dev`
- `<packageManager> run build` -> `blr build`
- `<packageManager> run package` -> `blr package`
- `<packageManager> run minecraft -- <subcommand>` -> `blr minecraft <subcommand>`
- `<packageManager> run system -- <subcommand>` -> `blr system <subcommand>`
- `<packageManager> run world -- <subcommand>` -> `blr world <subcommand>`
- `<packageManager> run clean` -> `blr clean`
- `<packageManager> run upgrade` -> `blr upgrade`
