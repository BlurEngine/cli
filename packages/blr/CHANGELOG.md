# @blurengine/cli

## 0.12.0

### Minor Changes

- [`b12c350`](https://github.com/BlurEngine/cli/commit/b12c35072653a3161081cc782cb887adbae13fbf) Thanks [@SupaHam](https://github.com/SupaHam)! - Add Bebe render-anchor asset baking, generated pack artifact staging, and bootstrap injection.

## 0.11.0

### Minor Changes

- [`014023f`](https://github.com/BlurEngine/cli/commit/014023fd3632ce99766bd90c4e53a72cdbdd29ce) Thanks [@SupaHam](https://github.com/SupaHam)! - Add Bebe zone asset baking, draft save handling, and configurable zone editor injection for development and package pipelines.

- [`1b5f636`](https://github.com/BlurEngine/cli/commit/1b5f636ffd41990395369d5bed85968064f0fdb0) Thanks [@SupaHam](https://github.com/SupaHam)! - Add local-server Link support, BDS-aware behavior-pack packaging, and dashboard/API configuration.

## 0.10.0

### Minor Changes

- [`8464a69`](https://github.com/BlurEngine/cli/commit/8464a69933f7299ab47aa4eb51776921e335180a) Thanks [@SupaHam](https://github.com/SupaHam)! - Add Bedrock world image exports for loaded-column, terrain, shade, and full PNG outputs, plus terrain audit metadata and assets package manifest entries.

- [`aa615a4`](https://github.com/BlurEngine/cli/commit/aa615a4b286e45bc82684179354bb9ae8ba44582) Thanks [@SupaHam](https://github.com/SupaHam)! - Add configurable raw world package layouts, including the `com` layout that writes world files under `worlds/world/` while keeping `bedrock-root` as the default.

## 0.9.1

### Patch Changes

- [`53ca359`](https://github.com/BlurEngine/cli/commit/53ca359bd70cfa312714f2eddadadf86058860c5) Thanks [@SupaHam](https://github.com/SupaHam)! - Retry local-server BDS directory replacement when Windows reports a transient permission error while promoting the extracted server folder.

## 0.9.0

### Minor Changes

- [`5f88d49`](https://github.com/BlurEngine/cli/commit/5f88d4913d31e8ed4e34babcc4533e1f2f9e7597) Thanks [@SupaHam](https://github.com/SupaHam)! - Add a configurable raw world package target that exports project worlds as tar.gz, zip, or mcworld archives.

### Patch Changes

- [`7b1e432`](https://github.com/BlurEngine/cli/commit/7b1e4328cfead0ebdc002792a788ba0e54891d7f) Thanks [@SupaHam](https://github.com/SupaHam)! - Limit the default `blr dev` hotreload watcher to `src/**/*` and ignore `.test.*` files. Behavior-pack and resource-pack paths can still be explicitly watched, but they resync without sending a local-server reload.

- [`5cf869f`](https://github.com/BlurEngine/cli/commit/5cf869faa2bb62a4dae971ee7a49e6410dcc4b1b) Thanks [@SupaHam](https://github.com/SupaHam)! - Add standalone behavior-pack and resource-pack package targets, plus configurable multi-target defaults for `blr package`.

## 0.8.0

### Minor Changes

- [`6dbd086`](https://github.com/BlurEngine/cli/commit/6dbd0860332d4d0edf908b1f0c64d6ecaae5c908) Thanks [@SupaHam](https://github.com/SupaHam)! - Compact noisy BDS scripting logs during `blr dev` by default, with config, environment, and CLI overrides. The local-server output relay now preserves interactive terminal colors while removing extra blank lines and terminal control noise from scripting log output.

## 0.7.0

### Minor Changes

- [`c7771cf`](https://github.com/BlurEngine/cli/commit/c7771cf03cca21a4a2ff80d3aa8d45b2ec9c5bd1) Thanks [@SupaHam](https://github.com/SupaHam)! - Expand `blr world level-dat` to work more naturally with explicit `.dat` files
  and add a new diff workflow for debugging.

  `blr world level-dat dump` and `edit` can now run outside a BlurEngine project
  when you provide an explicit world directory or `.dat` file path, including
  copied files such as `level (1).dat`. `blr world level-dat diff` now compares
  two world directories or `.dat` files directly, while still supporting
  `--against`, and prints either a text diff or JSON diff output for debugging
  changes in Bedrock `level.dat` data.

  `blr dev` now labels stale local-server runtime worlds more clearly when the
  project world source differs from the last runtime seed, including preserve and
  non-interactive keep paths.

  `dev.localServer.worldSync.runtimeWorldMode=replace` now force-refreshes the
  local-server runtime world from the project world before startup, even when the
  runtime seed state says the same project world was copied previously.

## 0.6.0

### Minor Changes

- [`d5ce5bd`](https://github.com/BlurEngine/cli/commit/d5ce5bd41f8bd779a5045e2568dfff317433d6f9) Thanks [@SupaHam](https://github.com/SupaHam)! - Add package targets for `.mctemplate`, `.mcworld`, and `.mcaddon` artifacts.

  Breaking change: the old `world-template` package target has been removed. Use `mctemplate` instead; bare `blr package` now defaults to `mctemplate`.

## 0.5.1

### Patch Changes

- [`6a6048a`](https://github.com/BlurEngine/cli/commit/6a6048a510d2643a9d34c83e6f0b089a4e9c3c48) Thanks [@SupaHam](https://github.com/SupaHam)! - Fix `blr world level-dat dump` and `edit` when they receive explicit relative
  paths through `npm run` from a nested project directory.

  `blr` now resolves those explicit `level.dat` paths from the original shell
  working directory when npm provides it, while still ignoring unrelated
  `INIT_CWD` values that point outside the current project. Tests now cover both
  the nested invocation case and the outside-project fallback behavior.

## 0.5.0

### Minor Changes

- [`36b6831`](https://github.com/BlurEngine/cli/commit/36b6831e6fd574d6148000be77c3922d4e083257) Thanks [@SupaHam](https://github.com/SupaHam)! - Allow projects to provide `server/server.properties` for local-server runs.

  `blr` now overlays project-owned `server/server.properties` onto the runtime
  BDS `server.properties` file while still forcing the managed settings needed
  for `blr dev`, such as the active world name, permission level, gamemode, and
  content-log settings. Documentation and tests now cover the new project
  server-state surface.

## 0.4.0

### Minor Changes

- [`2a2e373`](https://github.com/BlurEngine/cli/commit/2a2e3733a3c714ad4f4b159284febbc6aeae73f3) Thanks [@SupaHam](https://github.com/SupaHam)! - Add Bedrock `level.dat` tooling to `blr world` with new `level-dat dump` and
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

## 0.3.2

### Patch Changes

- [`7d7922d`](https://github.com/BlurEngine/cli/commit/7d7922d3a4c420be5fe015ad46884e00f44e72df) Thanks [@SupaHam](https://github.com/SupaHam)! - improve local-server reload logic and invalid targetVersion

## 0.3.1

### Patch Changes

- [`0ecfea1`](https://github.com/BlurEngine/cli/commit/0ecfea1c1713dc647b0c95d4c71f87abec42b8ef) Thanks [@SupaHam](https://github.com/SupaHam)! - cleanup publish workflow

## 0.3.0

### Minor Changes

- [`28297d3`](https://github.com/BlurEngine/cli/commit/28297d380413d40c9fbe3fcb8aa0fc8b3e281e55) Thanks [@SupaHam](https://github.com/SupaHam)! - Add version-aware world sync and safer local-server world handling.

  `blr world` now supports listing remote worlds, browsing versioned S3 world history, and pulling specific world versions into the project. Projects can track their selected remote world version in `worlds/worlds.json`.

  `blr dev` now separates project world sync from local-server runtime world replacement. It supports configurable `worldSync` modes, prompts more safely around remote updates and runtime replacement, avoids changing a running BDS world, and coordinates better with `watch-world`.

  This also simplifies internal world cache/state handling and updates generated project `.gitignore` behavior so `worlds/worlds.json` can be committed without tracking raw world contents.

## 0.2.1

### Patch Changes

- [`02d99f7`](https://github.com/BlurEngine/cli/commit/02d99f7d7966bc01d2d71dafddede09b4520f171) Thanks [@SupaHam](https://github.com/SupaHam)! - enable @blurengine/bebe by default

- [`817809a`](https://github.com/BlurEngine/cli/commit/817809abdfd7831bf492f02b2f9b71ca5c11d38a) Thanks [@SupaHam](https://github.com/SupaHam)! - add local-deps flag, prefetch bds download

## 0.2.0

### Minor Changes

- [`7cbf6c5`](https://github.com/BlurEngine/cli/commit/7cbf6c501871475a858756d86787d83c6df756de) Thanks [@SupaHam](https://github.com/SupaHam)! - Add custom bds binary and more hygiene around local-server
