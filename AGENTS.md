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
