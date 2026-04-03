# @blurengine/cli

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
