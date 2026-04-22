---
"@blurengine/cli": minor
---

Allow projects to provide `server/server.properties` for local-server runs.

`blr` now overlays project-owned `server/server.properties` onto the runtime
BDS `server.properties` file while still forcing the managed settings needed
for `blr dev`, such as the active world name, permission level, gamemode, and
content-log settings. Documentation and tests now cover the new project
server-state surface.
