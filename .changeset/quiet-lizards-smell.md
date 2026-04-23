---
"@blurengine/cli": patch
---

Fix `blr world level-dat dump` and `edit` when they receive explicit relative
paths through `npm run` from a nested project directory.

`blr` now resolves those explicit `level.dat` paths from the original shell
working directory when npm provides it, while still ignoring unrelated
`INIT_CWD` values that point outside the current project. Tests now cover both
the nested invocation case and the outside-project fallback behavior.
