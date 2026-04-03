import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { BLR_CONFIG_SCHEMA_PATH } from "../src/constants.js";
import { exists } from "../src/fs.js";
import { MANAGED_PACKAGE_SCRIPTS } from "../src/managed-project.js";
import { upgradeProjectScaffold } from "../src/project-upgrade.js";
import { copyFixtureProject, readJsonFile, readTextFile } from "./helpers.js";

type PackageJsonShape = {
    scripts?: Record<string, string>;
};

type BlurConfigShape = {
    $schema?: string;
    projectVersion?: number;
};

test("upgradeProjectScaffold migrates legacy project state and reconciles managed files", async (t) => {
    const projectRoot = await copyFixtureProject(t, "legacy-project-v0");
    const result = await upgradeProjectScaffold(
        projectRoot,
        path.join(projectRoot, "package.json"),
        false,
    );

    assert.equal(result.startingProjectVersion, 0);
    assert.equal(result.targetProjectVersion, 1);
    assert.ok(
        result.migrationChanges.some(
            (change) => change.scope === "projectVersion",
        ),
    );
    assert.ok(
        result.managedFileChanges.some(
            (change) => change.scope === "configSchema",
        ),
    );
    assert.ok(
        result.managedFileChanges.some(
            (change) => change.scope === "gitignore",
        ),
    );
    assert.ok(
        result.managedFileChanges.some(
            (change) => change.scope === "packageScripts",
        ),
    );

    assert.equal(await exists(path.join(projectRoot, "allowlist.json")), false);
    assert.equal(
        await exists(path.join(projectRoot, "permissions.json")),
        false,
    );
    assert.equal(
        await exists(path.join(projectRoot, "server", "allowlist.json")),
        true,
    );
    assert.equal(
        await exists(path.join(projectRoot, "server", "permissions.json")),
        true,
    );

    const config = await readJsonFile<BlurConfigShape>(
        path.join(projectRoot, "blr.config.json"),
    );
    assert.equal(config.projectVersion, 1);
    assert.equal(config.$schema, BLR_CONFIG_SCHEMA_PATH);

    const packageJson = await readJsonFile<PackageJsonShape>(
        path.join(projectRoot, "package.json"),
    );
    assert.deepEqual(packageJson.scripts, { ...MANAGED_PACKAGE_SCRIPTS });

    const gitIgnore = await readTextFile(path.join(projectRoot, ".gitignore"));
    assert.match(gitIgnore, /# BEGIN MANAGED BY @blurengine\/cli/);
    assert.match(gitIgnore, /coverage\//);
    assert.match(gitIgnore, /^worlds\/\*\*$/m);
    assert.match(gitIgnore, /^!worlds\/$/m);
    assert.match(gitIgnore, /^!worlds\/worlds\.json$/m);
});

test("upgradeProjectScaffold stops on conflicting legacy and server state files", async (t) => {
    const projectRoot = await copyFixtureProject(t, "legacy-project-v0");
    await mkdir(path.join(projectRoot, "server"), { recursive: true });
    await writeFile(
        path.join(projectRoot, "server", "allowlist.json"),
        '[{"name":"other"}]\n',
        "utf8",
    );

    await assert.rejects(
        () =>
            upgradeProjectScaffold(
                projectRoot,
                path.join(projectRoot, "package.json"),
                false,
            ),
        /Resolve the conflict manually, keep the server\/ version, and rerun "blr upgrade"\./,
    );
});
