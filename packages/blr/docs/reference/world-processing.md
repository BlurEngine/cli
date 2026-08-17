# World Processing

## Purpose

World processors turn a selected authored Bedrock world into deterministic build inputs without opening or modifying that authored world. A project can use several processors for independent jobs such as extracting sign-authored locations, compiling zones or paths, auditing a build, and preparing a processed world for development or publication.

`blr` owns the unsafe and repetitive infrastructure:

- resolving the selected and, when configured, remotely pinned world
- taking a verified immutable snapshot before opening LevelDB
- decoding blocks, block states, all subchunk layers, block entities, and both sign faces
- bounding and ordering observation queries
- loading trusted TypeScript processor modules
- tracking logical inputs and invalidating cached work
- publishing content-addressed artifact sets and typed runtime pointers
- checking declarative world mutations for conflicts and preconditions
- applying mutations only to a disposable staged copy
- reopening and verifying the processed copy before it becomes usable
- keeping authored and processed remote publication lineages separate

The project or reusable package owns meaning. `blr` does not decide what `@name`, `@object`, a location, a zone, furniture, or a train means.

## Processor contract

Processors import the supported SDK from `@blurengine/cli/world-processing` and are created with `defineWorldProcessor`.

```ts
import { defineWorldProcessor } from "@blurengine/cli/world-processing";

export const createLocationsProcessor = defineWorldProcessor(() => ({
  implementationRevision: "locations-v1",
  logicalInputs: [
    { id: "definition", kind: "file", path: "locations.source.json" },
  ],
  async run(input) {
    return {
      logicalInputs: input.logicalInputs,
      artifacts: [],
      diagnostics: [],
      mutations: [],
    };
  },
}));
```

Processor modules are trusted local build code, not a sandbox. They receive no LevelDB handle or output path from `blr`, and cancellation is cooperative. Publication tokens prevent a superseded run from publishing stale results.

Pipeline intent and check/bake mode select when BLR invokes a processor and how
it publishes the result; they are not processor inputs. A processor therefore
returns the same semantic artifacts, diagnostics, and mutation plan for the
same immutable inputs across `dev`, `build`, `package`, and world workflows.
This keeps one declared output path content-addressed and stable across commands.

A processor may return optional canonical JSON in `audit`. When its config declares `auditOutputPath`, `blr world build --audit` writes that value beside the processor identity, revision, logical-input hash, and diagnostics. Audit data is excluded from runtime artifact sets and generated pointers unless the processor also chooses to publish it as an artifact.

Capabilities are explicit:

- `observer`: diagnostics only
- `artifact`: immutable JSON payloads and a generated runtime pointer
- `transform`: a declarative mutation plan for a staged world

All selected processors observe the same immutable base snapshot. They do not read one another's mutations. Dependencies can consume preceding processor results, while conflicting mutation claims fail instead of using last-writer-wins ordering.

## Sign observations

Sign observations are data, not a directive standard. For each supported sign, the SDK preserves:

- its integer block location and complete palette state
- front and back faces independently
- exact raw text
- newline-normalised text
- every row, including empty rows and rows beyond four
- a discriminated orientation

Standing signs expose all 16 `ground_sign_direction` states. Wall signs expose the four horizontal `facing_direction` states. Hanging signs retain their states for consumers that support them. Processors decide which face syntax is valid and which observations become artifacts.

Use `input.observations.signs()` for location-style processors. It walks the world's block-entity records once, resolves each coherent sign's exact layer-zero block and orientation, and yields canonical dimension/X/Y/Z order. This cost scales with block entities instead of the volume between distant signs. An optional dimension and inclusive bounds filter the results; independent per-query and per-run sign limits protect builds without charging the ordinary block-position budget. Use `blocks(...)` for spatial block evidence such as routes, terrain, and bounded assemblies.

For example, a project may treat line 1 as an explicit id or `~`, line 2 as any `@directive`, and all later lines as opaque consumer data. That grammar and any automatic id allocation belong to the processor or feature package, not to `blr`.

## Artifacts

An artifact processor declares its output root, payload filenames, and optional runtime pointer path in `blr.config.json`. `blr` canonicalises JSON, hashes payload bytes, writes an immutable set under `<outputRoot>/sets/<artifactSetId>/`, and replaces the stable pointer only after the complete set is valid. A detached manifest lists payload members and never hashes itself.

Runtime pointers may be canonical `.json` data with payload values embedded, or generated `.ts` modules that statically import the immutable payloads. World-derived data should normally use a project-level world sidecar such as `world-data/<world>/generated/`; placing it under an authored `src/` tree is a consumer choice, not a BLR requirement.

Processors that bind one payload to another can call
`canonicalizeWorldDerivedJson(value)` or `hashWorldDerivedJson(value)` from
`@blurengine/cli/world-processing`. These are the exact canonical byte and
lowercase SHA-256 contracts used by BLR publication, including lexical object
keys, finite-number validation, `-0` normalisation, two-space indentation, and
one terminal newline. Pair the embedded hash with an artifact `hashReferences`
entry so BLR independently verifies the binding before publication.

`blr world build --check` recomputes and compares the contract without writing project files or caches. It is suitable for CI and the generated `assets:check` package script.

When no processor applies to the selected world, the check is a successful read-only no-op and does not require a world directory. This keeps the managed script safe for ordinary projects before they add processors.

## World mutations

Transform processors return typed, declarative operations rather than editing LevelDB:

- set one block with an exact observed/literal palette entry
- replace matching blocks in a bounded volume
- remove an expected block entity
- consume a sign as one block-and-block-entity operation

Every operation has a stable id, exact dimension/location/layer, and explicit preconditions. Palette entries include type id, complete states, and Bedrock palette version. The writer preserves untouched layers and block entities, updates affected height data, applies the raw key changes atomically to the staged database, then reopens and verifies the result. Initial support intentionally edits only existing chunks and subchunks.

Authored marker signs are retained by default. A consumer must explicitly emit a mutation if its processed world should remove or replace one.

## Commands and workflow

Use these commands from a configured project:

```text
blr world build
blr world build --check
blr world build --dry-run --json
blr world build --processor locations --audit
blr world build --output dist/world-preview
```

`build` and `package` run the processors enabled for those intents. Packages that include a world consume the verified processed world; pack-only targets do not materialise unnecessary world transforms.

In `dev`, artifact processors may trigger a script/content reload. A world transform causes a stopped-server rebuild and reseed. Processed-world development cannot be combined with `watch-world`: capturing a derived runtime world back over the marker-bearing authored source is rejected. Use two explicit modes:

- author mode: raw world with capture enabled
- play/verification mode: processed world with capture disabled

## Remote publication

Set `world.pushPolicy` to `processed` to make ordinary `blr world push` require a current verified `blr world build`. The processed world is uploaded to a separate remote channel from the authored source. A push acquires the world lock before checking and uploading the exact current build.

`--channel authored|processed` overrides the configured policy for an explicit invocation. Pulling continues to operate on the authored channel; processed output is a publication artifact and is never materialised over the project source.

## Source safety

No processor run opens the authored LevelDB. `blr` inventories source contents, copies them to a unique temporary snapshot, inventories source and snapshot again, and proceeds only when they agree. Failed, aborted, conflicting, or stale runs leave the source and previous published artifacts untouched.
