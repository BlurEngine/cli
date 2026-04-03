import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
    BASELINE_BEBE_DEPENDENCIES,
    DEFAULT_MINECRAFT_TARGET_VERSION,
} from "../src/constants.js";
import { resolveLatestCreateMinecraftTargetVersion } from "../src/commands/create.js";
import { exists, listDirectories } from "../src/fs.js";
import {
    assertDefined,
    createJsonResponse,
    createTempDirectory,
    readJsonFile,
    readTextFile,
    runBuiltCli,
} from "./helpers.js";

type PackageJsonShape = {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
};

type BlurConfigShape = {
    $schema?: string;
    projectVersion?: number;
    minecraft?: {
        channel?: string;
        targetVersion?: string;
    };
};

test("built cli create scaffolds a scripting project with bebe enabled by default", async (t) => {
    const workspace = await createTempDirectory(t, "blr-create-");
    const result = runBuiltCli(
        [
            "create",
            "sample-project",
            "--namespace",
            "bc_df",
            "--package-manager",
            "npm",
            "--behavior-pack",
            "true",
            "--resource-pack",
            "true",
            "--scripts",
            "true",
            "--language",
            "ts",
            "--yes",
            "--no-install",
        ],
        workspace,
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);

    const projectRoot = path.join(workspace, "sample-project");
    const packageJson = await readJsonFile<PackageJsonShape>(
        path.join(projectRoot, "package.json"),
    );
    const config = await readJsonFile<BlurConfigShape>(
        path.join(projectRoot, "blr.config.json"),
    );
    const readme = await readTextFile(path.join(projectRoot, "README.md"));
    const gitIgnore = await readTextFile(path.join(projectRoot, ".gitignore"));
    const mainFile = await readTextFile(
        path.join(projectRoot, "src", "main.ts"),
    );

    assert.equal(
        packageJson.dependencies?.["@blurengine/bebe"],
        BASELINE_BEBE_DEPENDENCIES["@blurengine/bebe"],
    );
    assert.ok(packageJson.devDependencies?.["@blurengine/cli"]);
    assert.match(mainFile, /import \{ Context \} from "@blurengine\/bebe";/);
    assert.match(mainFile, /const ctx = new Context\(\);/);
    assert.equal(
        config.$schema,
        "./node_modules/@blurengine/cli/schema/blr.config.schema.json",
    );
    assert.equal(config.projectVersion, 1);
    assert.equal(config.minecraft?.channel, "stable");
    assert.equal(await exists(path.join(projectRoot, "worlds")), false);
    assert.equal(await exists(path.join(projectRoot, "AGENTS.md")), true);
    assert.equal(
        await exists(path.join(projectRoot, "AGENTS.project.md")),
        true,
    );
    assert.match(gitIgnore, /^worlds\/\*\*$/m);
    assert.match(gitIgnore, /^!worlds\/$/m);
    assert.match(gitIgnore, /^!worlds\/worlds\.json$/m);

    const behaviorPackDirectories = await listDirectories(
        path.join(projectRoot, "behavior_packs"),
    );
    const resourcePackDirectories = await listDirectories(
        path.join(projectRoot, "resource_packs"),
    );
    assert.equal(behaviorPackDirectories.length, 1);
    assert.equal(resourcePackDirectories.length, 1);
    assert.match(readme, /^# sample-project/m);
    assert.match(readme, /npm run dev/);
    assert.match(readme, /npm run system/);
    assert.match(readme, /behavior_packs\//);
    assert.match(readme, /resource_packs\//);
});

test("built cli create can explicitly disable bebe while keeping scripting enabled", async (t) => {
    const workspace = await createTempDirectory(t, "blr-create-");
    const result = runBuiltCli(
        [
            "create",
            "sample-project-no-bebe",
            "--namespace",
            "bc_df",
            "--package-manager",
            "npm",
            "--behavior-pack",
            "true",
            "--resource-pack",
            "true",
            "--scripts",
            "true",
            "--bebe",
            "false",
            "--language",
            "ts",
            "--yes",
            "--no-install",
        ],
        workspace,
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);

    const projectRoot = path.join(workspace, "sample-project-no-bebe");
    const packageJson = await readJsonFile<PackageJsonShape>(
        path.join(projectRoot, "package.json"),
    );
    const mainFile = await readTextFile(
        path.join(projectRoot, "src", "main.ts"),
    );

    assert.equal(packageJson.dependencies?.["@blurengine/bebe"], undefined);
    assert.equal(mainFile, "export {};\n");
});

test("built cli create keeps a resource-only scaffold minimal", async (t) => {
    const workspace = await createTempDirectory(t, "blr-create-");
    const result = runBuiltCli(
        [
            "create",
            "resource-only",
            "--namespace",
            "bc_df",
            "--package-manager",
            "pnpm",
            "--behavior-pack",
            "false",
            "--resource-pack",
            "true",
            "--scripts",
            "false",
            "--yes",
            "--no-install",
        ],
        workspace,
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);

    const projectRoot = path.join(workspace, "resource-only");
    const readme = await readTextFile(path.join(projectRoot, "README.md"));
    const gitIgnore = await readTextFile(path.join(projectRoot, ".gitignore"));
    const resourcePackDirectories = await listDirectories(
        path.join(projectRoot, "resource_packs"),
    );
    const resourcePackDirectory = assertDefined(
        resourcePackDirectories[0],
        "expected a generated resource pack directory",
    );

    assert.equal(await exists(path.join(projectRoot, "behavior_packs")), false);
    assert.equal(await exists(path.join(projectRoot, "src")), false);
    assert.equal(await exists(path.join(projectRoot, "tsconfig.json")), false);
    assert.equal(await exists(path.join(projectRoot, "worlds")), false);
    assert.equal(
        await exists(
            path.join(
                projectRoot,
                "resource_packs",
                resourcePackDirectory,
                "manifest.json",
            ),
        ),
        true,
    );
    assert.match(readme, /^# resource-only/m);
    assert.match(readme, /pnpm run build/);
    assert.match(readme, /pnpm run system/);
    assert.match(gitIgnore, /^worlds\/\*\*$/m);
    assert.match(gitIgnore, /^!worlds\/$/m);
    assert.match(gitIgnore, /^!worlds\/worlds\.json$/m);
    assert.doesNotMatch(readme, /behavior_packs\//);
    assert.match(readme, /resource_packs\//);
});

test("built cli create uses published semver by default inside the workspace and only switches to file deps with --local-deps", async (t) => {
    const workspace = await createTempDirectory(t, "blr-create-local-");
    await mkdir(path.join(workspace, "bebe"), { recursive: true });
    await mkdir(path.join(workspace, "cli", "packages", "blr"), {
        recursive: true,
    });

    const defaultResult = runBuiltCli(
        [
            "create",
            "workspace-default",
            "--namespace",
            "bc_df",
            "--package-manager",
            "npm",
            "--behavior-pack",
            "true",
            "--resource-pack",
            "true",
            "--scripts",
            "true",
            "--language",
            "ts",
            "--yes",
            "--no-install",
        ],
        workspace,
    );
    assert.equal(
        defaultResult.status,
        0,
        defaultResult.stderr || defaultResult.stdout,
    );

    const defaultPackageJson = await readJsonFile<PackageJsonShape>(
        path.join(workspace, "workspace-default", "package.json"),
    );
    assert.match(
        String(defaultPackageJson.devDependencies?.["@blurengine/cli"]),
        /^\^/,
    );
    assert.doesNotMatch(
        String(defaultPackageJson.devDependencies?.["@blurengine/cli"]),
        /^file:/,
    );
    assert.equal(
        defaultPackageJson.dependencies?.["@blurengine/bebe"],
        BASELINE_BEBE_DEPENDENCIES["@blurengine/bebe"],
    );

    const localDepsResult = runBuiltCli(
        [
            "create",
            "workspace-local",
            "--namespace",
            "bc_df",
            "--package-manager",
            "npm",
            "--behavior-pack",
            "true",
            "--resource-pack",
            "true",
            "--scripts",
            "true",
            "--language",
            "ts",
            "--local-deps",
            "--yes",
            "--no-install",
        ],
        workspace,
    );
    assert.equal(
        localDepsResult.status,
        0,
        localDepsResult.stderr || localDepsResult.stdout,
    );

    const localPackageJson = await readJsonFile<PackageJsonShape>(
        path.join(workspace, "workspace-local", "package.json"),
    );
    assert.match(
        String(localPackageJson.devDependencies?.["@blurengine/cli"]),
        /^file:/,
    );
    assert.match(
        String(localPackageJson.dependencies?.["@blurengine/bebe"]),
        /^file:/,
    );
});

test("resolveLatestCreateMinecraftTargetVersion reads the latest stable Bedrock version from the download service", async () => {
    const targetVersion = await resolveLatestCreateMinecraftTargetVersion(
        (async (input) => {
            const url =
                typeof input === "string"
                    ? input
                    : input instanceof URL
                      ? input.href
                      : input.url;
            assert.match(url, /download\/links$/);
            return createJsonResponse({
                result: {
                    links: [
                        {
                            downloadType: "serverBedrockWindows",
                            downloadUrl:
                                "https://www.minecraft.net/bedrockdedicatedserver/bin-win/bedrock-server-1.26.3.1.zip",
                        },
                        {
                            downloadType: "serverBedrockLinux",
                            downloadUrl:
                                "https://www.minecraft.net/bedrockdedicatedserver/bin-linux/bedrock-server-1.26.3.1.zip",
                        },
                    ],
                },
            });
        }) as typeof fetch,
    );

    assert.equal(targetVersion, "1.26.3.1");
});

test("built cli create falls back to the static Minecraft targetVersion when remote lookup is disabled for test execution", async (t) => {
    const workspace = await createTempDirectory(t, "blr-create-");
    const result = runBuiltCli(
        [
            "create",
            "fallback-version",
            "--namespace",
            "bc_df",
            "--package-manager",
            "npm",
            "--behavior-pack",
            "true",
            "--resource-pack",
            "true",
            "--scripts",
            "false",
            "--yes",
            "--no-install",
        ],
        workspace,
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);

    const config = await readJsonFile<BlurConfigShape>(
        path.join(workspace, "fallback-version", "blr.config.json"),
    );
    assert.equal(
        config.minecraft?.targetVersion,
        DEFAULT_MINECRAFT_TARGET_VERSION,
    );
});
