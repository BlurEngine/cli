import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { gunzipSync } from "node:zlib";
import AdmZip from "adm-zip";
import { runPackageCommand } from "../src/commands/package.js";
import { createTempDirectory, writeJsonFile } from "./helpers.js";
import {
    createBedrockHeightmapDb,
    createBedrockTerrainDb,
} from "./world-image-helpers.js";

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
        packageConfig?: Record<string, unknown>;
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
        ...(options.packageConfig
            ? {
                  package: options.packageConfig,
              }
            : options.defaultTarget
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
    target?: string | string[],
    options: Parameters<typeof runPackageCommand>[1] = {},
): Promise<void> {
    const previousCwd = process.cwd();
    const previousLog = console.log;
    process.chdir(projectRoot);
    console.log = () => {};
    try {
        await runPackageCommand(target, options);
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

async function readTarGzEntryNames(archivePath: string): Promise<string[]> {
    const buffer = gunzipSync(await readFile(archivePath));
    const entries: string[] = [];
    let offset = 0;

    while (offset + 512 <= buffer.length) {
        const nameBytes = buffer.subarray(offset, offset + 100);
        const nameEnd = nameBytes.indexOf(0);
        const name = nameBytes
            .subarray(0, nameEnd === -1 ? undefined : nameEnd)
            .toString("utf8");
        if (name.length === 0) {
            break;
        }

        const sizeRaw = buffer
            .subarray(offset + 124, offset + 136)
            .toString("ascii")
            .replace(/\0.*$/, "")
            .trim();
        const size = Number.parseInt(sizeRaw || "0", 8);
        entries.push(name);
        offset += 512 + Math.ceil(size / 512) * 512;
    }

    return entries.sort();
}

test("runPackageCommand defaults to mctemplate output when target is omitted", async (t) => {
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

test("runPackageCommand rejects the legacy world-template target", async (t) => {
    const projectRoot = await createTempDirectory(t, "blr-package-");
    await createPackageProject(projectRoot);

    await assert.rejects(
        () => runPackageForTest(projectRoot, "world-template"),
        /Unsupported package target "world-template"\. Supported targets: mctemplate, mcworld, mcaddon, behavior-pack, resource-pack, world, assets\./,
    );
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

test("runPackageCommand creates configured standalone pack outputs when target is omitted", async (t) => {
    const projectRoot = await createTempDirectory(t, "blr-package-");
    await createPackageProject(projectRoot, {
        world: false,
        packageConfig: {
            defaultTargets: ["behavior-pack", "resource-pack"],
        },
    });

    await runPackageForTest(projectRoot);

    const behaviorOutputFile = path.join(
        projectRoot,
        "dist",
        "packages",
        "game-behavior.mcpack",
    );
    const resourceOutputFile = path.join(
        projectRoot,
        "dist",
        "packages",
        "assets-resource.mcpack",
    );
    const behaviorEntries = readZipEntryNames(behaviorOutputFile);
    const resourceEntries = readZipEntryNames(resourceOutputFile);
    assert.ok(behaviorEntries.includes("manifest.json"));
    assert.ok(resourceEntries.includes("manifest.json"));
    assert.equal(
        behaviorEntries.includes("behavior_packs/game/manifest.json"),
        false,
    );
    assert.equal(
        resourceEntries.includes("resource_packs/assets/manifest.json"),
        false,
    );
});

test("runPackageCommand accepts multiple explicit package targets", async (t) => {
    const projectRoot = await createTempDirectory(t, "blr-package-");
    await createPackageProject(projectRoot, { world: false });

    await runPackageForTest(projectRoot, ["behavior-pack", "resource-pack"]);

    assert.deepEqual(
        readZipEntryNames(
            path.join(projectRoot, "dist", "packages", "game-behavior.mcpack"),
        ),
        ["manifest.json"],
    );
    assert.deepEqual(
        readZipEntryNames(
            path.join(
                projectRoot,
                "dist",
                "packages",
                "assets-resource.mcpack",
            ),
        ),
        ["manifest.json"],
    );
});

test("runPackageCommand creates tar.gz raw world archives by default", async (t) => {
    const projectRoot = await createTempDirectory(t, "blr-package-");
    await createPackageProject(projectRoot, {
        packageConfig: {
            defaultTargets: ["world"],
        },
    });
    const worldRoot = path.join(projectRoot, "worlds", "Bedrock level");
    await writeFile(path.join(worldRoot, ".gitkeep"), "");
    await writeFile(path.join(worldRoot, "level.dat.blr-backup-20260516"), "");
    await writeFile(path.join(worldRoot, "db", "CURRENT.bak"), "");

    await runPackageForTest(projectRoot);

    const entries = await readTarGzEntryNames(
        path.join(
            projectRoot,
            "dist",
            "packages",
            "Bedrock level-world.tar.gz",
        ),
    );
    assert.ok(entries.includes("db/"));
    assert.ok(entries.includes("db/CURRENT"));
    assert.ok(entries.includes("levelname.txt"));
    assert.equal(entries.includes(".gitkeep"), false);
    assert.equal(entries.includes("level.dat.blr-backup-20260516"), false);
    assert.equal(entries.includes("db/CURRENT.bak"), false);
    assert.equal(
        entries.includes("behavior_packs/gamebp/manifest.json"),
        false,
    );
    assert.equal(entries.includes("world_behavior_packs.json"), false);
});

test("runPackageCommand excludes world backup directories from raw world archives", async (t) => {
    const projectRoot = await createTempDirectory(t, "blr-package-");
    await createPackageProject(projectRoot);
    const worldRoot = path.join(projectRoot, "worlds", "Bedrock level");
    await mkdir(
        path.join(
            worldRoot,
            ".world_backups",
            "world_backup_001_20260331_053706",
        ),
        { recursive: true },
    );
    await writeFile(
        path.join(worldRoot, ".world_backups", "world_backup_metadata.json"),
        "{}",
    );
    await writeFile(
        path.join(
            worldRoot,
            ".world_backups",
            "world_backup_001_20260331_053706.zip",
        ),
        "backup zip",
    );
    await mkdir(
        path.join(
            worldRoot,
            "worlds_backups",
            "Bedrock level.20260516T143000Z",
            "db",
        ),
        { recursive: true },
    );
    await mkdir(path.join(worldRoot, "Bedrock level.20260516T143000Z", "db"), {
        recursive: true,
    });
    await writeFile(
        path.join(
            worldRoot,
            "worlds_backups",
            "Bedrock level.20260516T143000Z",
            "levelname.txt",
        ),
        "Runtime backup world",
    );
    await writeFile(
        path.join(worldRoot, "Bedrock level.20260516T143000Z", "levelname.txt"),
        "Timestamped backup world",
    );

    await runPackageForTest(projectRoot, "world");

    const entries = await readTarGzEntryNames(
        path.join(
            projectRoot,
            "dist",
            "packages",
            "Bedrock level-world.tar.gz",
        ),
    );
    assert.ok(entries.includes("db/CURRENT"));
    assert.equal(entries.includes(".world_backups/"), false);
    assert.equal(
        entries.includes(".world_backups/world_backup_metadata.json"),
        false,
    );
    assert.equal(
        entries.includes(".world_backups/world_backup_001_20260331_053706.zip"),
        false,
    );
    assert.equal(entries.includes("worlds_backups/"), false);
    assert.equal(
        entries.includes(
            "worlds_backups/Bedrock level.20260516T143000Z/levelname.txt",
        ),
        false,
    );
    assert.equal(entries.includes("Bedrock level.20260516T143000Z/"), false);
    assert.equal(
        entries.includes("Bedrock level.20260516T143000Z/levelname.txt"),
        false,
    );
});

test("runPackageCommand creates configured zip raw world archives", async (t) => {
    const projectRoot = await createTempDirectory(t, "blr-package-");
    await createPackageProject(projectRoot, {
        packageConfig: {
            world: {
                format: "zip",
            },
        },
    });

    await runPackageForTest(projectRoot, "world");

    const entries = readZipEntryNames(
        path.join(projectRoot, "dist", "packages", "Bedrock level-world.zip"),
    );
    assert.ok(entries.includes("db/CURRENT"));
    assert.ok(entries.includes("levelname.txt"));
    assert.equal(
        entries.includes("behavior_packs/gamebp/manifest.json"),
        false,
    );
    assert.equal(entries.includes("world_behavior_packs.json"), false);
});

test("runPackageCommand creates com layout raw world archives", async (t) => {
    const projectRoot = await createTempDirectory(t, "blr-package-");
    await createPackageProject(projectRoot, {
        packageConfig: {
            world: {
                format: "zip",
                layout: "com",
            },
        },
    });
    const worldRoot = path.join(projectRoot, "worlds", "Bedrock level");
    await writeFile(path.join(worldRoot, ".gitkeep"), "");
    await writeFile(path.join(worldRoot, "db", "CURRENT.bak"), "");

    await runPackageForTest(projectRoot, "world");

    const entries = readZipEntryNames(
        path.join(projectRoot, "dist", "packages", "Bedrock level-world.zip"),
    );
    assert.ok(entries.includes("worlds/world/db/CURRENT"));
    assert.ok(entries.includes("worlds/world/levelname.txt"));
    assert.equal(entries.includes("db/CURRENT"), false);
    assert.equal(entries.includes("levelname.txt"), false);
    assert.equal(entries.includes("worlds/world/.gitkeep"), false);
    assert.equal(entries.includes("worlds/world/db/CURRENT.bak"), false);
});

test("runPackageCommand creates assets archives with a world image", async (t) => {
    const projectRoot = await createTempDirectory(t, "blr-package-");
    await createPackageProject(projectRoot);
    await createBedrockHeightmapDb(
        path.join(projectRoot, "worlds", "Bedrock level", "db"),
        [{ chunkX: 0, chunkZ: 0, baseHeight: 64 }],
    );
    await createBedrockTerrainDb(
        path.join(projectRoot, "worlds", "Bedrock level", "db"),
        [
            {
                chunkX: 0,
                chunkZ: 0,
                subChunkY: 4,
                blockName: "minecraft:stone",
                localX: 0,
                localY: 0,
                localZ: 0,
            },
        ],
    );

    await runPackageForTest(projectRoot, "assets");

    const outputFile = path.join(projectRoot, "dist", "packages", "assets.zip");
    const archive = new AdmZip(outputFile);
    const entries = archive
        .getEntries()
        .map((entry) => entry.entryName)
        .sort();
    const imageEntry = archive.getEntry("worlds/Bedrock level/map.png");

    assert.ok(entries.includes("assets.json"));
    assert.ok(entries.includes("worlds/Bedrock level/map.png"));
    assert.ok(entries.includes("worlds/Bedrock level/map.terrain.png"));
    assert.ok(entries.includes("worlds/Bedrock level/map.shade.png"));
    assert.ok(entries.includes("worlds/Bedrock level/map.full.png"));
    assert.ok(entries.includes("worlds/Bedrock level/map.terrain.audit.json"));
    assert.deepEqual(
        imageEntry?.getData().subarray(0, 8),
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    const manifest = JSON.parse(
        archive.getEntry("assets.json")?.getData().toString("utf8") ?? "{}",
    );
    assert.deepEqual(
        manifest.assets.map(
            (asset: { variant: string; path: string }) =>
                `${asset.variant}:${asset.path}`,
        ),
        [
            "loaded-columns:worlds/Bedrock level/map.png",
            "shade:worlds/Bedrock level/map.shade.png",
            "terrain:worlds/Bedrock level/map.terrain.png",
            "full:worlds/Bedrock level/map.full.png",
        ],
    );
    const terrainAsset = manifest.assets.find(
        (asset: { variant: string }) => asset.variant === "terrain",
    );
    assert.deepEqual(terrainAsset?.processedWorld, {
        dimension: "overworld",
        bounds: { minX: 0, maxX: 15, minZ: 0, maxZ: 15 },
        width: 16,
        height: 16,
        scale: 1,
        image: { width: 16, height: 16 },
        topY: { min: 64, max: 64 },
    });
    assert.equal(terrainAsset?.terrainColumnCount, 1);
    assert.deepEqual(terrainAsset?.terrainDiagnostics, {
        parseErrors: 0,
        emptyColumns: 255,
    });
});

test("runPackageCommand creates assets archives without requiring a world when world image is disabled", async (t) => {
    const projectRoot = await createTempDirectory(t, "blr-package-");
    await createPackageProject(projectRoot, {
        world: false,
        packageConfig: {
            assets: {
                worldImage: {
                    enabled: false,
                },
            },
        },
    });

    await runPackageForTest(projectRoot, "assets");

    assert.deepEqual(
        readZipEntryNames(
            path.join(projectRoot, "dist", "packages", "assets.zip"),
        ),
        ["assets.json"],
    );
});

test("runPackageCommand lets CLI world format override config", async (t) => {
    const projectRoot = await createTempDirectory(t, "blr-package-");
    await createPackageProject(projectRoot, {
        packageConfig: {
            world: {
                format: "zip",
            },
        },
    });

    await runPackageForTest(projectRoot, "world", { worldFormat: "mcworld" });

    const entries = readZipEntryNames(
        path.join(
            projectRoot,
            "dist",
            "packages",
            "Bedrock level-world.mcworld",
        ),
    );
    assert.ok(entries.includes("db/CURRENT"));
    assert.ok(entries.includes("levelname.txt"));
});
