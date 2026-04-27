# @blurengine/cli

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
