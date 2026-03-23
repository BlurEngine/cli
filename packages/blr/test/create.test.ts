import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { exists, listDirectories } from "../src/fs.js";
import {
    assertDefined,
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
    };
};

test("built cli create scaffolds a scripting project with bebe disabled by default", async (t) => {
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
    const mainFile = await readTextFile(
        path.join(projectRoot, "src", "main.ts"),
    );

    assert.equal(packageJson.dependencies?.["@blurengine/bebe"], undefined);
    assert.ok(packageJson.devDependencies?.["@blurengine/cli"]);
    assert.equal(mainFile, "export {};\n");
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
    assert.doesNotMatch(readme, /behavior_packs\//);
    assert.match(readme, /resource_packs\//);
});
