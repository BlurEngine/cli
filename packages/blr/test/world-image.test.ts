import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { runWorldImageCommand } from "../src/commands/world.js";
import {
    exportWorldImage,
    readBedrockWorldHeightmap,
    renderWorldLoadedColumnsImage,
    renderWorldTerrainFullImage,
    renderWorldTerrainImage,
    renderWorldTerrainShadeImage,
    writePngImage,
} from "../src/world-image.js";
import { createTempDirectory, writeJsonFile } from "./helpers.js";
import {
    createBedrockHeightmapDb,
    createBedrockTerrainDb,
} from "./world-image-helpers.js";

const PNG_SIGNATURE = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

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

async function createWorldImageProject(projectRoot: string): Promise<void> {
    await mkdir(path.join(projectRoot, "behavior_packs", "game"), {
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
    await writeJsonFile(path.join(projectRoot, "blr.config.json"), {
        schemaVersion: 1,
        projectVersion: 1,
        namespace: "test_pack",
        minecraft: {
            targetVersion: "1.26.11.1",
        },
    });

    const worldRoot = path.join(projectRoot, "worlds", "Bedrock level");
    await mkdir(worldRoot, { recursive: true });
    await writeFile(path.join(worldRoot, "levelname.txt"), "Bedrock level");
    await createBedrockHeightmapDb(path.join(worldRoot, "db"), [
        { chunkX: 0, chunkZ: 0, baseHeight: 64 },
        { chunkX: 2, chunkZ: 0, baseHeight: 96 },
        { chunkX: 0, chunkZ: 0, dimension: "nether", baseHeight: 12 },
    ]);
    await createBedrockTerrainDb(path.join(worldRoot, "db"), [
        {
            chunkX: 0,
            chunkZ: 0,
            subChunkY: 4,
            blockName: "minecraft:stone",
            localX: 0,
            localY: 0,
            localZ: 0,
        },
        {
            chunkX: 2,
            chunkZ: 0,
            subChunkY: 4,
            blockName: "minecraft:grass",
            localX: 0,
            localY: 0,
            localZ: 0,
        },
    ]);
}

test("readBedrockWorldHeightmap reads Data3D columns for the selected dimension", async (t) => {
    const tempRoot = await createTempDirectory(t, "blr-world-image-db-");
    const dbPath = path.join(tempRoot, "db");
    await createBedrockHeightmapDb(dbPath, [
        { chunkX: 0, chunkZ: 0, baseHeight: 64 },
        { chunkX: 1, chunkZ: -1, baseHeight: 80 },
        { chunkX: 0, chunkZ: 0, dimension: "nether", baseHeight: 10 },
    ]);

    const heightmap = await readBedrockWorldHeightmap({
        dbPath,
        dimension: "overworld",
    });

    assert.equal(heightmap.chunkCount, 2);
    assert.equal(heightmap.columns.length, 512);
    assert.deepEqual(heightmap.bounds, {
        minX: 0,
        maxX: 31,
        minZ: -16,
        maxZ: 15,
    });
    assert.equal(heightmap.minHeight, 64);
    assert.equal(heightmap.maxHeight, 110);
    assert.equal(
        heightmap.columns.find((column) => column.x === 31 && column.z === -1)
            ?.height,
        110,
    );
});

test("renderWorldLoadedColumnsImage creates an opaque loaded-column mask", () => {
    const image = renderWorldLoadedColumnsImage(
        {
            chunkCount: 1,
            bounds: {
                minX: 0,
                maxX: 1,
                minZ: 0,
                maxZ: 0,
            },
            minHeight: 64,
            maxHeight: 64,
            columns: [{ x: 1, z: 0, height: 64 }],
        },
        { scale: 2 },
    );

    assert.equal(image.width, 4);
    assert.equal(image.height, 2);
    assert.equal(image.data[3], 0);
    assert.equal(image.data[7], 0);
    assert.equal(image.data[11], 255);
    assert.equal(image.data[15], 255);
});

test("renderWorldTerrainImage creates terrain-colored image data", () => {
    const image = renderWorldTerrainImage(
        {
            chunkCount: 1,
            bounds: {
                minX: 0,
                maxX: 1,
                minZ: 0,
                maxZ: 0,
            },
            columns: [
                {
                    x: 0,
                    z: 0,
                    y: 64,
                    blockName: "minecraft:stone",
                },
                {
                    x: 1,
                    z: 0,
                    y: 64,
                    blockName: "minecraft:not_real",
                },
            ],
            diagnostics: { parseErrors: 0, emptyColumns: 0 },
        },
        { scale: 1 },
    );

    assert.equal(image.width, 2);
    assert.equal(image.height, 1);
    assert.deepEqual([...image.data.subarray(0, 4)], [126, 126, 126, 255]);
    assert.deepEqual([...image.data.subarray(4, 8)], [255, 0, 255, 255]);
});

test("renderWorldTerrainShadeImage creates local height-difference shading", () => {
    const image = renderWorldTerrainShadeImage(
        {
            chunkCount: 1,
            bounds: {
                minX: 0,
                maxX: 2,
                minZ: 0,
                maxZ: 0,
            },
            columns: [
                { x: 0, z: 0, y: 72, blockName: "minecraft:stone" },
                { x: 1, z: 0, y: 64, blockName: "minecraft:stone" },
                { x: 2, z: 0, y: 56, blockName: "minecraft:stone" },
            ],
            diagnostics: { parseErrors: 0, emptyColumns: 0 },
        },
        { scale: 1 },
    );

    assert.equal(image.width, 3);
    assert.equal(image.height, 1);
    assert.deepEqual([...image.data.subarray(4, 8)], [151, 151, 151, 255]);
});

test("renderWorldTerrainFullImage combines terrain color with local shading", () => {
    const image = renderWorldTerrainFullImage(
        {
            chunkCount: 1,
            bounds: {
                minX: 0,
                maxX: 2,
                minZ: 0,
                maxZ: 0,
            },
            columns: [
                { x: 0, z: 0, y: 72, blockName: "minecraft:stone" },
                { x: 1, z: 0, y: 64, blockName: "minecraft:stone" },
                { x: 2, z: 0, y: 56, blockName: "minecraft:stone" },
            ],
            diagnostics: { parseErrors: 0, emptyColumns: 0 },
        },
        { scale: 1 },
    );

    assert.equal(image.width, 3);
    assert.equal(image.height, 1);
    assert.deepEqual([...image.data.subarray(4, 8)], [149, 149, 149, 255]);
});

test("writePngImage writes a PNG file", async (t) => {
    const tempRoot = await createTempDirectory(t, "blr-world-image-png-");
    const outputPath = path.join(tempRoot, "map.png");

    await writePngImage(
        {
            width: 1,
            height: 1,
            data: Uint8Array.from([128, 160, 96, 255]),
        },
        outputPath,
    );

    assert.deepEqual(
        (await readFile(outputPath)).subarray(0, 8),
        PNG_SIGNATURE,
    );
});

test("exportWorldImage writes a terrain audit and reports timing checkpoints", async (t) => {
    const projectRoot = await createTempDirectory(t, "blr-world-image-export-");
    await createWorldImageProject(projectRoot);
    const outputPath = path.join(projectRoot, "preview.png");

    const result = await exportWorldImage({
        worldSourceDirectory: path.join(projectRoot, "worlds", "Bedrock level"),
        outputPath,
        scale: 1,
    });

    const timingNames = result.timings.stages.map((stage) => stage.name);
    assert.deepEqual(timingNames, [
        "copy-db",
        "read-world-image-data",
        "render-loaded-columns",
        "write-loaded-columns",
        "build-terrain-audit",
        "write-terrain-audit",
        "build-shading-map",
        "render-shade",
        "write-shade",
        "render-terrain",
        "write-terrain",
        "render-full",
        "write-full",
        "cleanup",
    ]);
    assert.ok(result.timings.totalMs >= 0);
    for (const stage of result.timings.stages) {
        assert.ok(stage.ms >= 0, `${stage.name} should have a duration`);
    }

    const audit = JSON.parse(
        await readFile(path.join(projectRoot, "preview.terrain.audit.json"), {
            encoding: "utf8",
        }),
    ) as {
        processedWorld: {
            dimension: string;
            bounds: {
                minX: number;
                maxX: number;
                minZ: number;
                maxZ: number;
            };
            width: number;
            height: number;
            scale: number;
            image: {
                width: number;
                height: number;
            };
            topY: {
                min: number;
                max: number;
            };
        };
        columns: number;
        blockCounts: Record<string, number>;
        tintRoleCounts: Record<string, number>;
    };
    assert.deepEqual(audit.processedWorld, {
        dimension: "overworld",
        bounds: { minX: 0, maxX: 47, minZ: 0, maxZ: 15 },
        width: 48,
        height: 16,
        scale: 1,
        image: { width: 48, height: 16 },
        topY: { min: 64, max: 64 },
    });
    assert.equal(audit.columns, 2);
    assert.equal(audit.blockCounts["minecraft:stone"], 1);
    assert.equal(audit.blockCounts["minecraft:grass"], 1);
    assert.equal(audit.tintRoleCounts.grass, 1);
});

test("runWorldImageCommand writes a PNG for the selected project world", async (t) => {
    const projectRoot = await createTempDirectory(
        t,
        "blr-world-image-project-",
    );
    await createWorldImageProject(projectRoot);

    const previousCwd = process.cwd();
    const previousLog = console.log;
    const messages: string[] = [];
    await writeFile(path.join(projectRoot, "preview.height.png"), "stale");
    await writeFile(path.join(projectRoot, "preview.height.raw.png"), "stale");
    process.chdir(projectRoot);
    console.log = (message?: unknown) => {
        messages.push(String(message));
    };
    try {
        await runWorldImageCommand(undefined, {
            output: "preview.png",
            scale: 1,
            timings: true,
        });
    } finally {
        console.log = previousLog;
        process.chdir(previousCwd);
    }

    for (const fileName of [
        "preview.png",
        "preview.terrain.png",
        "preview.shade.png",
        "preview.full.png",
    ]) {
        assert.deepEqual(
            (await readFile(path.join(projectRoot, fileName))).subarray(0, 8),
            PNG_SIGNATURE,
        );
    }
    await assert.rejects(
        readFile(path.join(projectRoot, "preview.height.png")),
    );
    await assert.rejects(
        readFile(path.join(projectRoot, "preview.height.raw.png")),
    );
    assert.match(
        messages.join("\n"),
        /Wrote 4 2D world image PNGs for "Bedrock level"/,
    );
    assert.match(messages.join("\n"), /processed world 48x16 blocks/);
    assert.match(messages.join("\n"), /x 0\.\.47, z 0\.\.15/);
    assert.match(messages.join("\n"), /Image export timings/);
    assert.match(messages.join("\n"), /read-world-image-data/);
});
