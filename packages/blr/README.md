# @blurengine/cli

BlurEngine's project generator and lifecycle CLI for Minecraft Bedrock Edition content.

## Quick Start

```bash
npx @blurengine/cli@latest create my-project
cd my-project
npm install
npm run dev
```

## Commands

- `blr create` scaffolds a new BlurEngine project
- `blr dev` builds and runs local development tasks
- `blr build` stages project output
- `blr package` produces package artifacts
- `blr system` prints support diagnostics
- `blr world` manages project world state
- `blr minecraft` checks and updates the targeted Bedrock version
- `blr upgrade` reconciles a generated project with the current scaffold

## Documentation

- [Docs Index](./docs/README.md)
- [Command Reference](./docs/reference/commands.md)
- [Config Reference](./docs/reference/config.md)
- [Generated Project Reference](./docs/reference/generated-project.md)

## Development

```bash
npm install
npm run check
```

## License

Licensed under the Apache License, Version 2.0. See [LICENSE](./LICENSE).
