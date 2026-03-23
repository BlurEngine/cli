# BlurEngine CLI

Workspace for the main BlurEngine command-line package.

## Package

- `@blurengine/cli`: project generator + lifecycle CLI
- `npx @blurengine/cli@latest create`
- `blr dev|build|clean|upgrade`

## Docs

- [Docs Index](./packages/blr/docs/README.md)
- [Command Reference](./packages/blr/docs/reference/commands.md)
- [Config Reference](./packages/blr/docs/reference/config.md)
- [Generated Project Reference](./packages/blr/docs/reference/generated-project.md)
- [Standards](./packages/blr/docs/standards/bedrock-typescript.md)

## Local (No Publish)

From repository root, run directly via local package spec:

- `npx @blurengine/cli@file:./packages/blr create ./my-project --namespace my_namespace --yes --no-install`

Windows PowerShell:

- `npx.cmd @blurengine/cli@file:./packages/blr create ./my-project --namespace my_namespace --yes --no-install`

## License

Licensed under the Apache License, Version 2.0. See [LICENSE](./LICENSE).

## Open Source

- [Contributing Guide](./CONTRIBUTING.md)
- [Security Policy](./SECURITY.md)
