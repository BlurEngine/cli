---
"@blurengine/cli": minor
---

Add version-aware world sync and safer local-server world handling.

`blr world` now supports listing remote worlds, browsing versioned S3 world history, and pulling specific world versions into the project. Projects can track their selected remote world version in `worlds/worlds.json`.

`blr dev` now separates project world sync from local-server runtime world replacement. It supports configurable `worldSync` modes, prompts more safely around remote updates and runtime replacement, avoids changing a running BDS world, and coordinates better with `watch-world`.

This also simplifies internal world cache/state handling and updates generated project `.gitignore` behavior so `worlds/worlds.json` can be committed without tracking raw world contents.
