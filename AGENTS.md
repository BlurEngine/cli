# CLI Agent Scope

This file applies only to agents working in the `cli/` repository.

## Repo Contract

- `cli` is the standalone producer repo for `blr`, its docs, and its generated project contract.
- Generated projects do not read this file directly. When `cli` changes scaffold or upgrade behavior, preserve the generated-project contract from the producer side.

## Maintenance Rules

1. Keep `packages/blr/docs/reference/*` factual and command/config oriented. Keep `packages/blr/docs/standards/*` as the shared engineering standards source of truth.
2. If scaffold shape changes, update `blr create`, `blr upgrade`, tests, and generated-project docs together.
3. If generated-project instruction behavior changes, update generation and refresh behavior together, and preserve the split between managed generated instructions and the user-owned `AGENTS.project.md` overlay.
4. If config shape changes, update config types/JSDoc, keep schema generation correct through the normal build, and update config docs and tests.
5. If release or open-source repo surfaces change, keep root docs, workflows, package metadata, security information, and Changesets config aligned.
6. Changes affecting code, scaffold behavior, upgrade behavior, release flow, or docs that claim behavior must leave the repo passing `npm run check`.

## World Sync Guidance

1. Treat the world surfaces as separate concerns:

- project world source: `worlds/<worldName>`
- project pin: `worlds/worlds.json`
- internal runtime and cache state: `.blr/`

2. `worlds/worlds.json` is project-facing state and should stay minimal. Prefer storing only:

- `name`
- `remoteFingerprint`
- `versionId`

3. `.blr/state` is for internal bookkeeping. `.blr/cache` is disposable. For remote worlds, keep cached zip files only and do not keep extracted cache copies or cache metadata files after pull operations.
4. Keep project-world sync separate from local-server runtime-world replacement. Remote freshness logic and BDS overwrite safety are different decisions and should not be collapsed into one mode.
5. Do not modify or replace the BDS runtime world while the server is running. Replace, preserve, or backup decisions happen before startup only.
6. `watch-world` is a runtime-to-project capture feature. It starts only after startup reconciliation is complete, and remote world pull flows must not race an active `watch-world` session for the same world.
7. Bucket versioning is the feature boundary for version-aware remote world workflows. If versioning is unavailable, do not pretend that pull, push, version history, or version-aware `dev` sync are supported.
8. Favor short prompt labels and choices. Prefer wording like:

- `Pull latest remote world`
- `Keep current world`
- `Silence 24h`
- `Replace local-server world`
- `Keep local-server world`
- `Backup and replace`

9. Treat optional freshness and required reconciliation differently:

- optional newer-remote prompts may offer `Silence 24h`
- required reconcile flows should not quietly continue in the wrong state

10. When world-sync behavior changes, update these surfaces together:

- `packages/blr/src/types.ts`
- config loading and env overrides
- schema generation output
- command/config docs
- scaffold or upgrade behavior when generated files are affected
- tests for config, `dev`, world commands, and helper/state utilities
