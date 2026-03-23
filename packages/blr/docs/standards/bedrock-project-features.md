# Bedrock Project Features

## Purpose

This standard defines the feature model that BlurEngine uses for Bedrock projects.

## Current Project Features

BlurEngine currently treats these as the core project features:

1. `behaviorPack`
2. `resourcePack`
3. `scripting`

## Feature Rules

- A project must contain at least one content pack:
  - `behaviorPack`
  - `resourcePack`
- `scripting` is optional.
- `scripting` requires `behaviorPack`.
- `resourcePack` does not imply `behaviorPack`.
- `behaviorPack` does not imply `resourcePack`.

## Default Inference

Unless a later command-specific override says otherwise, `blr` should infer project features from source presence:

- `behavior_packs/*/manifest.json` -> `behaviorPack`
- `resource_packs/*/manifest.json` -> `resourcePack`
- `src/main.ts`, `src/main.js`, or explicit `runtime.entry` -> `scripting`

This means the project shape itself is the default source of truth.

## Context Behavior

### `blr create`

- generates pack folders only for the selected content features
- only offers scripting when `behaviorPack` is selected
- should keep the default scaffold minimal and avoid empty placeholder folders

### `blr build`

- stages only the packs that are present in the project
- only bundles and syncs scripts when `scripting` is enabled

### `blr dev`

- `local-deploy` should only deploy packs that are present
- `local-server` should only sync and attach packs that are present
- world hook files such as `world_behavior_packs.json` and `world_resource_packs.json` should only be written for the corresponding present pack types
- `watch-scripts` should remain specifically about script-change reaction behavior, not as a generic proxy for all content automation

### `blr package`

- includes only the content types that are present for the selected package target

## Override Rule

Default automation should always follow project feature presence first.

Only after that default is clear should `blr` expose refined controls through:

1. `blr.config.json`
2. `BLR_*` environment variables
3. CLI flags

These overrides should narrow or disable feature-driven automation per context, for example:

- local deploy pack copying
- local server pack copying
- local server world attachment
- package target inclusion

This keeps the default experience convenient without making advanced workflows impossible.

## Extensibility Rule

Future content features should follow the same structure:

1. define the feature clearly
2. define how it is inferred by default
3. define which contexts consume it
4. only add overrides after the default inferred behavior is clear

This keeps the CLI predictable and prevents feature flags from becoming ad hoc.
