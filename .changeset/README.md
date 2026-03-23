# Changesets

Use Changesets to record publishable changes for `@blurengine/cli`.

## Add a changeset

```bash
npm run changeset
```

Then:

1. Select `@blurengine/cli`
2. Choose the release type
3. Write a short summary
4. Commit the generated `.changeset/*.md` file

## Version and publish

These commands are mainly for the release workflow:

- `npm run version-packages`
- `npm run release`
