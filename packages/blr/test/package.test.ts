import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import AdmZip from "adm-zip";
import { runPackageCommand } from "../src/commands/package.js";
import { createTempDirectory, writeJsonFile } from "./helpers.js";

function createBehaviorManifest() {
    return {
        format_version: 2,
        header: {
            name: "Game Behavior Pack",
            description: "Game behavior pack",
            uuid: "11111111-1111-1111-1111-111111111111",
            version: [1, 2, 3],
            min_engine_version: [1, 26, 0],
        },
        modules: [
            {
                type: "data",
                uuid: "22222222-2222-2222-2222-222222222222",
                version: [1, 2, 3],
            },
        ],
    };
}

function createResourceManifest() {
    return {
        format_version: 2,
        header: {
            name: "Game Resource Pack",
            description: "Game resource pack",
            uuid: "33333333-3333-3333-3333-333333333333",
            version: [1, 2, 3],
            min_engine_version: [1, 26, 0],
        },
        modules: [
            {
                type: "resources",
                uuid: "44444444-4444-4444-4444-444444444444",
                version: [1, 2, 3],
            },
        ],
    };
}

async function createPackageProject(
    projectRoot: string,
    options: {
        world?: boolean;
        defaultTarget?: string;
    } = {},
): Promise<void> {
    await mkdir(path.join(projectRoot, "behavior_packs", "game"), {
        recursive: true,
    });
    await mkdir(path.join(projectRoot, "resource_packs", "assets"), {
        recursive: true,
    });
    await writeJsonFile(path.join(projectRoot, "package.json"), {
        name: "example-project",
        version: "1.2.3",
        private: true,
    });
    await writeJsonFile(
        path.join(projectRoot, "behavior_packs", "game", "manifest.json"),
        createBehaviorManifest(),
    );
    await writeJsonFile(
        path.join(projectRoot, "resource_packs", "assets", "manifest.json"),
        createResourceManifest(),
    );
    await writeJsonFile(path.join(projectRoot, "blr.config.json"), {
        schemaVersion: 1,
        projectVersion: 1,
        namespace: "bc_df",
        minecraft: {
            targetVersion: "1.26.11.1",
        },
        ...(options.defaultTarget
            ? {
                  package: {
                      defaultTarget: options.defaultTarget,
                  },
              }
            : {}),
    });

    if (options.world ?? true) {
        const worldRoot = path.join(projectRoot, "worlds", "Bedrock level");
        await mkdir(path.join(worldRoot, "db"), { recursive: true });
        await writeFile(path.join(worldRoot, "levelname.txt"), "Bedrock level");
        await writeFile(path.join(worldRoot, "db", "CURRENT"), "");
    }
}

async function runPackageForTest(
    projectRoot: string,
    target?: string,
): Promise<void> {
    const previousCwd = process.cwd();
    const previousLog = console.log;
    process.chdir(projectRoot);
    console.log = () => {};
    try {
        await runPackageCommand(target, {});
    } finally {
        console.log = previousLog;
        process.chdir(previousCwd);
    }
}

function readZipEntryNames(archivePath: string): string[] {
    return new AdmZip(archivePath)
        .getEntries()
        .map((entry) => entry.entryName)
        .sort();
}

test("runPackageCommand defaults to world-template output when target is omitted", async (t) => {
    const projectRoot = await createTempDirectory(t, "blr-package-");
    await createPackageProject(projectRoot);

    await runPackageForTest(projectRoot);

    const outputFile = path.join(
        projectRoot,
        "dist",
        "packages",
        "game.mctemplate",
    );
    const entries = readZipEntryNames(outputFile);
    assert.ok(entries.includes("world_template/manifest.json"));
    assert.ok(entries.includes("world_template/db/CURRENT"));
    assert.ok(
        entries.includes("world_template/behavior_packs/gamebp/manifest.json"),
    );
    assert.ok(
        entries.includes(
            "world_template/resource_packs/assetsrp/manifest.json",
        ),
    );
});

test("runPackageCommand creates mcworld archives from the selected world", async (t) => {
    const projectRoot = await createTempDirectory(t, "blr-package-");
    await createPackageProject(projectRoot);

    await runPackageForTest(projectRoot, "mcworld");

    const outputFile = path.join(
        projectRoot,
        "dist",
        "packages",
        "game.mcworld",
    );
    const entries = readZipEntryNames(outputFile);
    assert.ok(entries.includes("db/CURRENT"));
    assert.ok(entries.includes("levelname.txt"));
    assert.ok(entries.includes("behavior_packs/gamebp/manifest.json"));
    assert.ok(entries.includes("resource_packs/assetsrp/manifest.json"));
    assert.ok(entries.includes("world_behavior_packs.json"));
    assert.ok(entries.includes("world_resource_packs.json"));
    assert.equal(entries.includes("manifest.json"), false);
});

test("runPackageCommand creates mcaddon archives without requiring a world source", async (t) => {
    const projectRoot = await createTempDirectory(t, "blr-package-");
    await createPackageProject(projectRoot, { world: false });

    await runPackageForTest(projectRoot, "mcaddon");

    const outputFile = path.join(
        projectRoot,
        "dist",
        "packages",
        "game.mcaddon",
    );
    const entries = readZipEntryNames(outputFile);
    assert.ok(entries.includes("behavior_packs/gamebp/manifest.json"));
    assert.ok(entries.includes("resource_packs/assetsrp/manifest.json"));
    assert.equal(entries.includes("db/CURRENT"), false);
    assert.equal(entries.includes("world_behavior_packs.json"), false);
    assert.equal(entries.includes("world_resource_packs.json"), false);
});
