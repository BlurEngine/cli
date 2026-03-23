# Bedrock Project Structure

## Purpose

This standard defines the expected layout and ownership boundaries for BlurEngine-generated Bedrock projects.

## Top-Level Layout

- `behavior_packs/` when the project includes a behavior pack
- `resource_packs/` when the project includes a resource pack
- `src/` when the project includes script runtime
- `worlds/` when the project keeps raw world sources in-repo
- `dist/`
- `.blr/`

## Ownership

### `behavior_packs/`

Contains authored behavior-pack assets such as:

- entities
- items
- blocks
- texts
- recipes
- loot

Do not treat pack `scripts/` as authored source.

### `resource_packs/`

Contains authored resource-pack assets such as:

- textures
- models
- animations
- render controllers
- attachables
- client entity files
- texts

### `src/`

Contains all authored TypeScript or JavaScript runtime logic.

Recommended layout:

- `src/<feature>/`
- `src/<feature>/events/`
- `src/<feature>/logic/`
- `src/<feature>/ids.ts`

### `dist/`

Generated output only.

- when the project includes script runtime, `dist/scripts/main.js` is the authoritative runtime script artifact.

### `worlds/`

Committed project-owned raw Bedrock world sources when the project chooses to keep them in-repo.

These are inputs to:

- local server reset/bootstrap flows
- world-template packaging

Do not confuse this with runtime BDS world state in `.blr/`.

### `.blr/`

CLI-managed runtime workspace.

Examples:

- BDS cache
- provisioned BDS server files
- local runtime artifacts

Do not commit this directory.

## AGENTS Files

Generated projects should use:

- `AGENTS.md`: managed BlurEngine base instructions
- `AGENTS.project.md`: user-owned committed project rules

`AGENTS.md` should instruct agents to read `AGENTS.project.md` after the managed base instructions.

Instruction precedence inside generated projects should be treated as:

1. direct user instructions
2. `AGENTS.project.md`
3. the managed instructions in `AGENTS.md`

## Generator and Upgrade Expectations

- `blr create` writes the initial managed `AGENTS.md` and `AGENTS.project.md`.
- `blr upgrade` refreshes `AGENTS.md`.
- `blr upgrade` must preserve `AGENTS.project.md`.
- `blr upgrade` must not create requirements that depend on the tooling repo being present in the workspace.
