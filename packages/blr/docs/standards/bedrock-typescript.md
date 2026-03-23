# Bedrock TypeScript Standard

## Purpose

This standard defines how BlurEngine projects should author Minecraft Bedrock script logic in TypeScript.

## Core Rules

1. When a project includes script runtime, author that logic in `src/` only.
2. When a project includes script runtime, treat `dist/scripts/main.js` as the only runtime script artifact.
3. Do not hand-author or maintain pack `scripts/*.js` as source.
4. Prefer Bedrock API calls over command strings.
5. Use command fallbacks only when the API cannot express the behavior cleanly or reliably.
6. Keep event subscriptions thin and route into feature-focused functions.
7. Prefer data-driven BP/RP content first; use script when JSON/components/events are insufficient.

## Source Ownership

- `behavior_packs/`: data-driven behavior content
- `resource_packs/`: client/resource content
- `src/`: authored TypeScript runtime logic
- `dist/`: generated build output
- `.blr/`: CLI-managed runtime workspace

## Event Handling

- Subscribe to Bedrock events in small files.
- Move branching and mutation logic into named helpers or feature modules.
- Avoid large anonymous inline callbacks.
- Do not mix unrelated behaviors into one event file.

Recommended pattern:

- `src/<feature>/events/...`
- `src/<feature>/logic/...`
- `src/<feature>/ids.ts`

## API Boundaries

- Centralize Bedrock component and inventory helpers.
- Narrow component access with typed helper functions where useful.
- Always guard for missing components and invalid runtime state.
- Avoid scattering raw `getComponent`, inventory mutation, and `runCommand` calls across unrelated files.

## Commands

- API-first is the default.
- If commands are required, isolate them behind a helper and mark them as fallback behavior.
- Do not spread raw command strings across event handlers.

## State

- In-memory state is for transient runtime behavior only.
- Persisted gameplay state should have one clear owner.
- Avoid representing the same concept in multiple places such as tags, scoreboards, and dynamic properties at once.
- Choose the simplest persistent primitive that actually fits the feature.

## TypeScript

- Keep `strict` mode enabled.
- Do not use `any`.
- Prefer small typed constants for identifiers and known domains.
- Centralize:
  - item ids
  - entity ids
  - tags
  - dynamic property keys
  - script event ids

## Hot Reload

- Assume `blr dev` will rebuild and reload repeatedly during development.
- Avoid brittle singleton patterns that do not tolerate reload.
- Keep initialization idempotent where practical.

## Review Questions

Before merging Bedrock TypeScript code, check:

1. Could this be data-driven instead of scripted?
2. Are ids centralized?
3. Is the API used before command fallback?
4. Is state ownership clear?
5. Is the code resilient to reload/dev workflows?
6. Is the feature organized by domain instead of by accident?
