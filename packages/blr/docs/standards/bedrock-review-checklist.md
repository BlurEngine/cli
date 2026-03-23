# Bedrock Review Checklist

Use this checklist when reviewing Bedrock scripting and addon changes.

## Architecture

1. Is this feature placed in the right layer?
2. Is script being used only where data-driven content is insufficient?
3. Are source ownership boundaries respected between `src/`, BP, RP, `dist/`, and `.blr/`?

## TypeScript

1. Is the code `strict`-compatible without `any`?
2. Are identifiers and domain constants centralized?
3. Are helpers named and typed clearly?

## Bedrock API

1. Is the scripting API used before any command fallback?
2. Are component lookups and entity assumptions guarded?
3. Are inventory/equipment mutations handled defensively?

## State

1. Is state ownership clear?
2. Is persistent state stored in one intentional place?
3. Does the change avoid duplicating the same concept across multiple systems?

## Dev Workflow

1. Will this behave correctly under repeated `blr dev` rebuild/reload cycles?
2. Is the initialization flow resilient to reload?
3. Are file/layout assumptions compatible with generator conventions?

## Generated Projects

1. If generator behavior changed, were generated-project docs updated?
2. If shared instructions changed, were managed standards or bootstrap files updated?
