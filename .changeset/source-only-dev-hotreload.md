---
"@blurengine/cli": patch
---

Limit the default `blr dev` hotreload watcher to `src/**/*` and ignore `.test.*` files. Behavior-pack and resource-pack paths can still be explicitly watched, but they resync without sending a local-server reload.
