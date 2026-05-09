---
"@blurengine/cli": minor
---

Expand `blr world level-dat` to work more naturally with explicit `.dat` files
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
