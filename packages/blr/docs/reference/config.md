# Config Reference

## Purpose

`blr.config.json` stores project state and project-level behavior.

It does not store machine-local runtime overrides such as:

- BDS version
- BDS cache directory
- BDS server directory
- Minecraft development root
- Minecraft product target

Those belong to CLI flags or environment variables.

Project-aware commands also load the closest `.env.local` automatically before resolving config and environment-based overrides.

Canonical build and package output belongs under `dist/`:

- `dist/stage/` for staged build output consumed by `local-deploy`, `local-server`, and packaging
- `dist/packages/` for packaged distributable artifacts

CLI runtime/provisioning state belongs under `.blr/`.

Interactive prompt silence and internal world sync state both live under `.blr/state/`.

## Default Minimal File

Generated projects start with:

```json
{
  "$schema": "./node_modules/@blurengine/cli/schema/blr.config.schema.json",
  "schemaVersion": 1,
  "projectVersion": 1,
  "namespace": "my_namespace",
  "minecraft": {
    "channel": "stable",
    "targetVersion": "1.26.0.2"
  }
}
```

## Schema

### `schemaVersion`

- optional in practice but generated as `1`
- if present, must be `1`

### `$schema`

- generated and managed by `blr`
- points editors such as VS Code and Cursor at the packaged JSON Schema for `blr.config.json`

Current generated value:

```json
"$schema": "./node_modules/@blurengine/cli/schema/blr.config.schema.json"
```

Behavior:

- enables completion, hover descriptions, and validation in editors that support JSON Schema
- `blr upgrade` reconciles this field if it is missing or stale
- the schema file shipped in `@blurengine/cli` is generated automatically from TypeScript definitions during the package build and prepack flow

Note:

- this local package path works well for npm/pnpm-style installs where `node_modules/` is present
- once `@blurengine/cli` is published, it becomes easier to switch this to a hosted schema URL if we want editor support that does not depend on `node_modules/`

### `projectVersion`

- generated and managed by `blr`
- tracks the generated-project scaffold contract, not the config schema
- current value: `1`

Behavior:

- normal project commands expect the project to already be on the current `projectVersion`
- if the project is behind, `blr` tells you to run `blr upgrade` first
- `blr upgrade` runs ordered project migrations and then updates this field

Notes:

- `schemaVersion` and `projectVersion` are intentionally separate
- `schemaVersion` is for the shape of `blr.config.json`
- `projectVersion` is for the overall generated-project layout and managed scaffold behavior

### `namespace`

- required
- project namespace used by BlurEngine project logic

### `minecraft`

Optional project-level Minecraft targeting.

Fields:

- `channel`: `stable | preview`
- `targetVersion`: target Minecraft version, for example `1.26.0.2`

Behavior:

- drives the project target version that `blr` uses for:
  - packaged world-template `base_game_version`
  - default BDS version when no CLI or machine-local env override is provided
- drives the project Bedrock release channel across:
  - BDS stable vs preview download resolution
  - interactive `blr dev` update prompting
  - local-deploy auto-detection preference order when the deploy product is still `auto`
- pack manifests keep their authored `header.min_engine_version`; `blr build` and `blr dev` do not rewrite that field during staging
- during interactive `blr dev` runs that select `local-server`, `blr` can prompt to update this field when the active local-server version came from `blr.config.json`
- CLI- or environment-sourced version overrides do not trigger `dev` upgrade prompts for `minecraft.targetVersion`
- `blr minecraft check` and `blr minecraft update` provide the same version workflow without starting `dev`
- must be a valid `major.minor.patch` or `major.minor.patch.build` Minecraft version

Defaults if omitted:

- `channel`: `stable`
- `targetVersion`: `1.26.0.2`

Notes:

- this does not currently auto-resolve the correct `@minecraft/*` npm dependency matrix for arbitrary versions
- dependency alignment remains governed by the CLI baseline and `blr upgrade`

### `upgrade`

Optional project-level upgrade behavior.

Fields:

- `refreshAgents`: whether `blr upgrade` should refresh managed `AGENTS.md` content by default
- `refreshDependencies`: whether `blr upgrade` should refresh dependency baselines in `package.json` by default

Defaults if omitted:

- `refreshAgents`: `true`
- `refreshDependencies`: `true`

Behavior:

- `blr upgrade` always runs project scaffold migrations up to the current `projectVersion`
- `refreshDependencies` only controls dependency baseline alignment
- `refreshAgents` only controls managed `AGENTS.md` refresh
- `blr upgrade` also reconciles managed package scripts and the managed `.gitignore` block

### `world`

Optional world source backend configuration.

Fields:

- `backend`: `local | s3`
- `s3.bucket`: bucket name for remote world storage
- `s3.region`: region for the S3 client
- `s3.endpoint`: optional custom S3-compatible endpoint
- `s3.keyPrefix`: optional static prefix prepended to all world objects
- `s3.projectPrefix`: whether to include the project name in object keys
- `s3.forcePathStyle`: path-style addressing for S3-compatible providers that require it
- `s3.lockTtlSeconds`: default remote lock TTL

Defaults if omitted:

- `backend`: `local`
- `s3.bucket`: empty
- `s3.region`: empty in config, then resolved from `AWS_REGION` / `AWS_DEFAULT_REGION`, then `us-east-1`
- `s3.endpoint`: empty
- `s3.keyPrefix`: `worlds`
- `s3.projectPrefix`: `false`
- `s3.forcePathStyle`: `false`
- `s3.lockTtlSeconds`: `14400`

Notes:

- `blr.config.json` stores backend coordinates, not credentials
- credentials should come from the AWS SDK default credential chain, such as:
  - `AWS_ACCESS_KEY_ID`
  - `AWS_SECRET_ACCESS_KEY`
  - `AWS_SESSION_TOKEN`
  - `AWS_PROFILE`
- `s3.endpoint` and `s3.forcePathStyle` allow S3-compatible backends such as MinIO, R2, and similar services
- object keys are readable and stable:
  - `<keyPrefix>/<worldName>.zip`
  - `<keyPrefix>/<worldName>.lock.json`
- if `projectPrefix` is enabled, the layout becomes:
  - `<keyPrefix>/<projectName>/<worldName>.zip`
  - `<keyPrefix>/<projectName>/<worldName>.lock.json`
- bucket versioning is required for versioned remote world workflows:
  - `blr world pull`
  - `blr world versions`
  - `blr world pull --version-id`
  - `blr world push`
  - remote world sync behavior in `blr dev`
- `blr world list` and `blr world status` still work when bucket versioning is unavailable
- the lock object is the concurrency boundary; world naming is no longer overloaded with hashes
- `blr dev` and `blr package` consume the local project world source
- successful versioned remote world pull and push operations create or refresh `worlds/worlds.json`
- `worlds/worlds.json` only appears after `blr world` establishes remote version state; generated projects do not create it up front
- tracked world entries store:
  - `name`
  - `remoteFingerprint`
  - `versionId`
- `blr world push` also writes BlurEngine provenance onto the uploaded object by using standard S3 user metadata through the SDK `Metadata` field
- that provenance can include who pushed the world and the optional push reason
- this is not AWS-only naming; S3-compatible providers that preserve object metadata can expose the same information
- if a provider strips or does not return that metadata, `blr` treats push provenance as unavailable and says so in command output
- `remoteFingerprint` lets `blr` detect when the current `blr.config.json` points at a different remote world lineage than the stored project pin
- if that fingerprint drifts, `blr` ignores the stale pin until the next successful remote world action refreshes it
- internal runtime bookkeeping lives in `.blr/state/world-state.json`
- that internal state tracks:
  - the last remote version materialized into the project world
  - the last project-world source seeded into the local-server runtime world
  - the active local-server watch-world session, when present
- `.blr/cache/worlds/` now keeps only downloaded zip archives:
  - `.blr/cache/worlds/<bucket>/<worldName>/<encodedVersionId>.zip`
- temporary extracted world copies and cache `metadata.json` are not kept after a pull
- version-aware world sync is not supported without bucket versioning:
  - `blr world pull`
  - `blr world versions`
  - `blr world push`
  - `blr dev` project-world remote sync
- `blr dev` stays lenient about local world edits and uses `worlds/worlds.json` as the project truth instead of trying to infer remote freshness from local files alone

### `package`

Optional project-level packaging defaults.

Fields:

- `defaultTarget`: default package target used when `blr package` is run without a target
- `worldTemplate.include.behaviorPack`: include the behavior pack in `world-template` packaging by default
- `worldTemplate.include.resourcePack`: include the resource pack in `world-template` packaging by default

Supported values:

- `world-template`

Behavior:

- if `blr package <target>` is passed explicitly, that wins
- if the target is omitted, `blr` uses `package.defaultTarget` when present
- if the target is omitted and there is only one supported packaging target, `blr` uses that target automatically
- if the target is omitted and packaging targets become ambiguous in the future, `blr` requires an explicit target or `package.defaultTarget`
- `worldTemplate.include.*` defaults follow project feature presence:
  - behavior pack present -> behavior pack included by default
  - resource pack present -> resource pack included by default
- these defaults can be narrowed per run with:
  - `--include-behavior-pack`
  - `--include-resource-pack`

### `runtime`

Optional overrides for the script build.

Fields:

- `entry`: override script entry file
- `outFile`: override the bundled script output path before it is synced into `dist/stage`
- `target`: override esbuild target
- `sourcemap`: override sourcemap behavior
- `externalModules`: override external Bedrock module list

Defaults if omitted:

- `entry`: inferred from `src/main.ts`, then `src/main.js`; left empty when neither exists
- `outFile`: `dist/scripts/main.js`
- `target`: `es2022`
- `sourcemap`: `true`
- `externalModules`:
  - `@minecraft/server`
  - `@minecraft/server-ui`
  - `@minecraft/server-admin`
  - `@minecraft/server-net`

Notes:

- projects without a runtime entry still build and stage pack content normally
- script bundling is skipped until a runtime entry exists
- runtime scripting requires a behavior pack to be present in the project

### `dev.watch`

Optional project watch configuration.

Fields:

- `paths`: project-relative glob-style path patterns watched by `blr dev`
- `debounceMs`: watcher debounce
- `scriptsEnabledByDefault`: default selection for `watch-scripts`
- `worldEnabledByDefault`: default selection for `watch-world`
- `allowlistEnabledByDefault`: default selection for `watch-allowlist`

Defaults if omitted:

- `src/**/*`
- `behavior_packs/**/*`
- `resource_packs/**/*`
- `scriptsEnabledByDefault`: `true`
- `worldEnabledByDefault`: `false`
- `allowlistEnabledByDefault`: `true`

Notes:

- `watch-scripts` treats runtime source changes as rebuild-and-reload changes
- behavior-pack and resource-pack changes are rebuilt and resynced without sending `reload` to local-server
- `blr.config.json` and `package.json` are not watched by default because those changes usually need a fresh `dev` run rather than a live reload
- if you explicitly add `blr.config.json` or `package.json` to `dev.watch.paths`, `blr` prints a restart notice and skips the reload

### `dev.localDeploy`

Project-level local deploy behavior.

Fields:

- `enabledByDefault`: whether `local-deploy` starts selected by default
- `copy.behaviorPack`: deploy the behavior pack during `local-deploy`
- `copy.resourcePack`: deploy the resource pack during `local-deploy`

Defaults if omitted:

- `enabledByDefault`: `false`
- `copy.behaviorPack`: follows project feature presence
- `copy.resourcePack`: follows project feature presence

Notes:

- `blr dev` uses these values directly during its default config-driven mode
- these settings control pack deployment only
- they do not affect whether the `local-deploy` action itself is selected
- per-run CLI overrides:
  - `--local-deploy-behavior-pack`
  - `--local-deploy-resource-pack`

### `dev.localServer`

Project-level local server behavior.

Fields:

- `enabledByDefault`: whether `local-server` starts selected by default
- `worldName`: active BDS world name
- `worldSourcePath`: project-owned raw world source path
- `restartOnWorldChange`: restart/reset server world when the project world source changes
- `copy.behaviorPack`: sync the behavior pack into the provisioned local server
- `copy.resourcePack`: sync the resource pack into the provisioned local server
- `attach.behaviorPack`: attach the behavior pack in `world_behavior_packs.json`
- `attach.resourcePack`: attach the resource pack in `world_resource_packs.json`
- `allowlist`: optional XUID list when no `server/allowlist.json` file exists
- `operators`: optional XUID list when no `server/permissions.json` file exists
- `defaultPermissionLevel`: server default permission level
- `gamemode`: server default gamemode
- `worldSync.projectWorldMode`: `prompt | auto | manual`
- `worldSync.runtimeWorldMode`: `prompt | preserve | replace | backup`

Defaults if omitted:

- `enabledByDefault`: `true`
- `worldName`: `Bedrock level`
- `worldSourcePath`: `worlds/<worldName>`
- `restartOnWorldChange`: `true`
- `copy.behaviorPack`: follows project feature presence
- `copy.resourcePack`: follows project feature presence
- `attach.behaviorPack`: follows project feature presence
- `attach.resourcePack`: follows project feature presence
- `defaultPermissionLevel`: `operator`
- `gamemode`: `creative`
- `worldSync.projectWorldMode`: `prompt`
- `worldSync.runtimeWorldMode`: `prompt`

Notes:

- `blr dev` uses these values directly during its default config-driven mode
- `blr create` does not generate an empty world placeholder
- world-aware commands such as `watch-world` and `package world-template` require that path to contain a real Bedrock world with a `db/` directory
- `blr dev --world <worldName>` and `blr package --world <worldName>` can override the configured active world for a single run
- `blr world use <worldName>` updates the configured active world and keeps the default `worlds/<worldName>` source-path convention unless the project has an explicit custom `worldSourcePath`
- `copy.*` controls whether the current project pack types are copied into the runtime server
- `attach.*` controls whether the current project pack ids are written into world hook files
- if a pack type is disabled for copy or attach, `blr` removes only this project's corresponding staged/runtime output and preserves unrelated existing world pack entries
- `worldSync.projectWorldMode` controls how `blr dev` handles remote project-world updates for versioned S3 worlds:
  - `prompt`: prompt when a newer remote world exists, and prompt or fail when a required pull is needed
  - `auto`: pull automatically when reconciliation is needed
  - `manual`: never pull automatically
- `worldSync.runtimeWorldMode` controls how `blr dev` handles replacing the runtime BDS world from the project world:
  - `prompt`: ask before replacing an existing runtime world
  - `preserve`: keep the existing runtime world
  - `replace`: replace the runtime world automatically before startup
  - `backup`: move the existing runtime world into `worlds_backups/` and then replace it
- runtime-world replacement and backup only happen before BDS starts; `blr` does not modify a running server world
- `watch-world` starts after startup reconciliation and captures runtime world state back into the project source
- `watch-allowlist` captures both retained runtime server-state files:
  - `allowlist.json`
  - `permissions.json`
- optional newer-remote prompts can be silenced for 24 hours on a per-world basis
- per-run CLI overrides:
  - `--local-server-behavior-pack`
  - `--local-server-resource-pack`
  - `--attach-behavior-pack`
  - `--attach-resource-pack`

## Inferred State

`blr` intentionally infers the rest from the project:

- project features
  - `behavior_packs/*/manifest.json` -> behavior-pack feature enabled
  - `resource_packs/*/manifest.json` -> resource-pack feature enabled
  - `src/main.ts`, `src/main.js`, or explicit `runtime.entry` -> scripting feature enabled
  - scripting requires a behavior pack
  - a project must contain at least one pack manifest
- `package.json`
  - package name
  - package version
  - package manager
- `behavior_packs/*/manifest.json`
  - pack directory
  - header UUID/version
  - script module UUID
- `resource_packs/*/manifest.json`
  - pack directory
  - header UUID/version
- source conventions
  - entrypoint
  - output path defaults
  - staged build output under `dist/stage`

## Environment Variables

Config-backed overrides:

- supported `blr.config.json` fields can be overridden with `BLR_` environment variables
- naming rule:
  - take the config path
  - uppercase each segment exactly as written
  - join the segments with a single underscore
  - do not split camelCase into separate words
- examples:
  - `namespace` -> `BLR_NAMESPACE`
  - `minecraft.channel` -> `BLR_MINECRAFT_CHANNEL`
  - `minecraft.targetVersion` -> `BLR_MINECRAFT_TARGETVERSION`
  - `dev.localServer.worldName` -> `BLR_DEV_LOCALSERVER_WORLDNAME`
  - `dev.localServer.worldSync.projectWorldMode` -> `BLR_DEV_LOCALSERVER_WORLDSYNC_PROJECTWORLDMODE`
  - `dev.localServer.worldSync.runtimeWorldMode` -> `BLR_DEV_LOCALSERVER_WORLDSYNC_RUNTIMEWORLDMODE`
  - `dev.localDeploy.copy.behaviorPack` -> `BLR_DEV_LOCALDEPLOY_COPY_BEHAVIORPACK`
  - `dev.localServer.attach.resourcePack` -> `BLR_DEV_LOCALSERVER_ATTACH_RESOURCEPACK`
  - `package.worldTemplate.include.behaviorPack` -> `BLR_PACKAGE_WORLDTEMPLATE_INCLUDE_BEHAVIORPACK`
  - `world.s3.keyPrefix` -> `BLR_WORLD_S3_KEYPREFIX`
  - `package.defaultTarget` -> `BLR_PACKAGE_DEFAULTTARGET`
- array fields accept comma-separated or newline-separated values
- invalid boolean or numeric env values fail fast instead of silently falling back

Machine-local overrides:

- `BLR_MACHINE_LOCALSERVER_BDSVERSION`
- `BLR_MACHINE_LOCALSERVER_BDSPLATFORM`
- `BLR_MACHINE_LOCALSERVER_BDSCACHEDIRECTORY`
- `BLR_MACHINE_LOCALSERVER_BDSSERVERDIRECTORY`
- `BLR_MACHINE_LOCALDEPLOY_MINECRAFTPRODUCT`
- `BLR_MACHINE_LOCALDEPLOY_MINECRAFTDEVELOPMENTPATH`
- `BLR_MACHINE_DEBUG`
- `BLR_WORLD_ACTOR`

S3 credential and SDK variables commonly used in `.env.local`:

- `AWS_ACCESS_KEY_ID`
- `AWS_SECRET_ACCESS_KEY`
- `AWS_SESSION_TOKEN`
- `AWS_REGION`
- `AWS_DEFAULT_REGION`
- `AWS_PROFILE`

Security notes:

- keep secrets in `.env.local`, not in `blr.config.json`
- generated projects ignore `.env.local` by default
- `blr` loads `.env.local` without overriding environment variables that are already set by the shell or CI
- world names from config, env, and CLI are validated before they are used as local world-source paths or BDS world names
- `runtime.entry`, `runtime.outFile`, `dev.localServer.worldSourcePath`, and `dev.watch.paths` are validated to stay within the project-owned path surface

## Built-In Machine Defaults

If neither CLI flags nor environment variables override them, `blr` uses:

- Minecraft product: `auto`
- Minecraft development path: auto-detected by deploy logic when possible
  - on Windows, `auto` currently checks:
    - for `minecraft.channel = stable`:
      - `%APPDATA%/Minecraft Bedrock/Users/Shared/games/com.mojang`
      - `%LOCALAPPDATA%/Packages/Microsoft.MinecraftUWP_8wekyb3d8bbwe/LocalState/games/com.mojang`
      - `%APPDATA%/Minecraft Bedrock Preview/Users/Shared/games/com.mojang`
      - `%LOCALAPPDATA%/Packages/Microsoft.MinecraftWindowsBeta_8wekyb3d8bbwe/LocalState/games/com.mojang`
    - for `minecraft.channel = preview`:
      - `%APPDATA%/Minecraft Bedrock Preview/Users/Shared/games/com.mojang`
      - `%LOCALAPPDATA%/Packages/Microsoft.MinecraftWindowsBeta_8wekyb3d8bbwe/LocalState/games/com.mojang`
      - `%APPDATA%/Minecraft Bedrock/Users/Shared/games/com.mojang`
      - `%LOCALAPPDATA%/Packages/Microsoft.MinecraftUWP_8wekyb3d8bbwe/LocalState/games/com.mojang`
- BDS version: `1.26.0.2`
- when `minecraft.targetVersion` is set, that becomes the default BDS version before machine-local overrides are considered
- BDS platform: `auto`
- BDS cache directory: `.blr/cache/bds`
- BDS server directory template: `.blr/bds/{version}/server`
- Debug logging: disabled
- World lock actor label: system username, or `BLR_WORLD_ACTOR` when set

## Override Precedence

For config-backed project values:

1. explicit CLI flags or command arguments
2. `BLR_` environment variables
3. `blr.config.json`
4. built-in defaults

For machine-local runtime values:

1. CLI flags
2. machine-local `BLR_*` environment variables
3. built-in defaults

`blr.config.json` is not part of that precedence chain for machine-local overrides.

For `blr upgrade` managed AGENTS refresh:

1. CLI `--refresh-agents`
2. `blr.config.json -> upgrade.refreshAgents`
3. built-in default `true`

For `blr upgrade` dependency baseline refresh:

1. CLI `--refresh-dependencies`
2. `blr.config.json -> upgrade.refreshDependencies`
3. built-in default `true`
