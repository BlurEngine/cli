# Contributing

Thanks for helping improve BlurEngine CLI.

## Local Setup

Requirements:

- Node.js 20 or newer
- npm 10 or newer

Setup:

```bash
npm install
npm run check
```

`npm install` also installs the local `pre-commit` hook for fast format and lint checks before each commit.

Useful commands:

- `npm run build`
- `npm run format`
- `npm run lint`
- `npm run test`
- `npm run check`
- `npm run dev:blr`
- `npm run changeset`

## Change Expectations

- Keep changes focused and documented.
- Add or update tests when behavior changes.
- Update docs when user-facing behavior or config changes.
- If schema-relevant config types change, run `npm run build` so the generated schema stays current.
- For publishable `@blurengine/cli` changes, run `npm run changeset` and commit the generated `.changeset/*.md` file.

## Release Flow

- Release intent is tracked with Changesets.
- The release workflow is defined in `.github/workflows/publish.yml`.
- GitHub Actions will open or update a release PR from committed changeset files.
- Merging that PR will publish `@blurengine/cli` through the configured npm trusted publisher workflow.

## Contributions and Licensing

Unless explicitly stated otherwise, contributions submitted to this project are accepted under the Apache License, Version 2.0.
