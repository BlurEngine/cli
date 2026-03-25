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
- `@blurengine/bebe` is off by default right now
- the language prompt only appears when scripting is enabled explicitly
- prompts map directly to CLI flags so the command stays scriptable

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
- `watch-allowlist` watches runtime BDS `allowlist.json` and copies it back into `server/allowlist.json`
- `watch-world` watches the project world source for restart/reset triggers and captures the runtime BDS world back into that project world source on shutdown
- `watch-world` requires the project world source to contain a valid Bedrock world (`db/` directory)

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

- `dev` is interactive by default
- the first interactive page selects `local-deploy` and `local-server`
- if `local-server` is selected and `minecraft.targetVersion` is behind the latest Bedrock dedicated-server version for the configured `minecraft.channel`, `dev` prompts before the watch page
- that update prompt can:
  - update `blr.config.json -> minecraft.targetVersion` immediately
  - continue without changing the project
  - silence the prompt for 24 hours for that specific newer version
- the second interactive page selects watch/capture items
- `watch-world` and `watch-allowlist` are only offered on the second page when `local-server` is selected
- the third interactive page selects pack automation for this run when local deploy or local server are active
- if any of `--local-deploy`, `--local-server`, pack automation flags, `--watch-scripts`, `--watch-world`, or `--watch-allowlist` is passed explicitly, interactive mode is skipped unless `--interactive true` is also passed
- pressing `Ctrl+C` during an interactive prompt aborts the command immediately
- confirming with no selected items exits cleanly without doing any work
- if no active dev targets are enabled, `dev` performs the initial build and exits even when `watch` would otherwise be `true`

Flags:

- `--interactive [enabled]`: enable or disable the checklist
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
- `--watch-allowlist [enabled]`: enable or disable runtime allowlist capture back into project state
- `--production [enabled]`: enable or disable production bundling
- `--minecraft-product <product>`: override local deploy target
- `--minecraft-development-path <path>`: override local deploy root
- `--bds-version <version>`: override BDS version
- `--bds-platform <platform>`: `win | linux | auto`
- `--bds-cache-dir <path>`: override BDS cache directory
- `--bds-server-dir <path>`: override BDS server directory
- `--world <worldName>`: override the active world for this run
- `--restart-on-world-change [enabled]`: enable or disable full server restart when the project world source changes
- `--debug [enabled]`: enable or disable debug logs for watch/build/sync/server lifecycle activity

Examples:

```text
blr dev
blr dev --interactive false --watch false
blr dev --interactive false --watch-scripts true --local-server false
blr dev --interactive false --local-server true --watch-world true
blr dev --interactive false --local-server true --watch-allowlist true
blr dev --interactive false --local-server true --bds-version 1.26.0.2
blr dev --interactive false --local-server true --world "Creative Sandbox"
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
blr package [target]
```

Currently supported targets:

- `world-template`

`world-template` behavior:

- runs `build` first
- reads the selected project world source
- copies only the staged packs that are present into a world-template package workspace
- writes `dist/packages/<packName>.mctemplate` for the configured default world
- writes `dist/packages/<packName>-<worldName>.mctemplate` when packaging a different world with `--world`
- requires the project world source to contain a valid Bedrock world (`db/` directory)
- if `world.backend` is `s3`, pull the world first with `blr world pull`
- if `<target>` is omitted, `blr` resolves the target from `blr.config.json -> package.defaultTarget`
- if `<target>` is omitted and no config default exists, `blr` uses the single supported target when unambiguous

Flags:

- `--production [enabled]`: enable or disable production bundling before packaging
- `--world <worldName>`: override the active world for this packaging run
- `--include-behavior-pack [enabled]`: enable or disable behavior-pack inclusion for this run
- `--include-resource-pack [enabled]`: enable or disable resource-pack inclusion for this run
- `--debug [enabled]`: enable or disable debug logs for packaging activity

Examples:

```text
blr package
blr package world-template
blr package --world "Creative Sandbox"
blr package world-template --production
blr package world-template --debug
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
- prompts for confirmation by default
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
- generated projects ignore `worlds/` by default so local world state stays out of normal source control unless a project intentionally opts in
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
- `blr dev` and `blr package` still operate on the local project world source; they do not auto-pull or auto-push remote worlds

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

Flags:

- `--debug [enabled]`: enable or disable debug logs for world backend activity

### `blr world pull`

Pulls a remote world into the local project world source.

Syntax:

```text
blr world pull [worldName]
```

Behavior:

- by default, acquires the remote world lock first
- downloads `<worldName>.zip` into `.blr/cache/worlds/...`
- extracts it and copies the result into `worlds/<worldName>/`
- if the remote object is missing, the command fails without reporting success

Flags:

- `--lock [enabled]`: acquire or skip the remote lock before pulling
- `--force-lock [enabled]`: steal the remote lock when necessary
- `--reason <reason>`: lock reason recorded in the remote lock object
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
- acquires the remote world lock before uploading
- archives the local world into `.blr/cache/worlds/.../world.zip`
- uploads the archive to the resolved remote object key
- unlocks after a successful push by default

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
blr world status
blr world capture
blr world capture --force true
blr world pull
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
