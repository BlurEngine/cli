import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { LevelDB } from "@8crafter/leveldb-zlib";
import { loadMcbeLeveldbHelpers } from "../src/mcbe-leveldb-adapter.js";
import {
    createSubchunkBlockIndex,
    readBedrockTerrainColumns,
} from "../src/world-terrain-bedrock.js";
import { createTempDirectory } from "./helpers.js";
import {
    createBedrockHeightmapDb,
    createBedrockTerrainDb,
} from "./world-image-helpers.js";

test("createSubchunkBlockIndex uses Bedrock x-z-y block ordering", () => {
    assert.equal(createSubchunkBlockIndex(1, 2, 3), 0x132);
});

test("readBedrockTerrainColumns scans top visible blocks from subchunks", async (t) => {
    const root = await createTempDirectory(t, "blr-terrain-db-");
    const dbPath = path.join(root, "db");
    await createBedrockTerrainDb(dbPath, [
        {
            chunkX: 0,
            chunkZ: 0,
            subChunkY: 4,
            blockName: "minecraft:stone",
            localX: 2,
            localY: 0,
            localZ: 3,
        },
        {
            chunkX: 0,
            chunkZ: 0,
            subChunkY: 4,
            blockName: "minecraft:dirt",
            localX: 2,
            localY: 1,
            localZ: 3,
        },
    ]);

    const terrain = await readBedrockTerrainColumns({ dbPath });
    const column = terrain.columns.find(
        (candidate) => candidate.x === 2 && candidate.z === 3,
    );

    assert.equal(column?.blockName, "minecraft:dirt");
    assert.equal(column?.y, 65);
    assert.deepEqual(terrain.bounds, {
        minX: 0,
        maxX: 15,
        minZ: 0,
        maxZ: 15,
    });
    assert.equal(terrain.chunkCount, 1);
    assert.equal(terrain.diagnostics.parseErrors, 0);
    assert.equal(terrain.diagnostics.emptyColumns, 255);
});

test("readBedrockTerrainColumns uses x-z-y subchunk block index ordering", async (t) => {
    const root = await createTempDirectory(t, "blr-terrain-ordering-db-");
    const dbPath = path.join(root, "db");
    await createBedrockTerrainDb(dbPath, [
        {
            chunkX: 0,
            chunkZ: 0,
            subChunkY: 4,
            blockName: "minecraft:gold_block",
            localX: 1,
            localY: 2,
            localZ: 3,
        },
    ]);

    const terrain = await readBedrockTerrainColumns({ dbPath });

    assert.deepEqual(terrain.columns, [
        {
            x: 1,
            z: 3,
            y: 66,
            blockName: "minecraft:gold_block",
        },
    ]);
});

test("readBedrockTerrainColumns reads the Data3D biome at the selected block y", async (t) => {
    const root = await createTempDirectory(t, "blr-terrain-biome-db-");
    const dbPath = path.join(root, "db");
    await createBedrockHeightmapDb(dbPath, [
        {
            chunkX: 0,
            chunkZ: 0,
            baseHeight: 64,
            biomes: [
                {
                    biomeSubchunkIndex: 8,
                    biomeId: 1,
                    fill: true,
                },
                {
                    biomeSubchunkIndex: 9,
                    biomeId: 4,
                    fill: true,
                },
            ],
        },
    ]);
    await createBedrockTerrainDb(dbPath, [
        {
            chunkX: 0,
            chunkZ: 0,
            subChunkY: 5,
            blockName: "minecraft:oak_leaves",
            localX: 2,
            localY: 0,
            localZ: 3,
        },
    ]);

    const terrain = await readBedrockTerrainColumns({ dbPath });

    assert.deepEqual(
        terrain.columns.find((column) => column.x === 2 && column.z === 3),
        {
            x: 2,
            z: 3,
            y: 80,
            blockName: "minecraft:oak_leaves",
            biomeName: "minecraft:forest",
        },
    );
});

test("readBedrockTerrainColumns keeps terrain when Data3D biome data is corrupt", async (t) => {
    const root = await createTempDirectory(t, "blr-terrain-corrupt-biome-db-");
    const dbPath = path.join(root, "db");
    await mkdir(dbPath, { recursive: true });
    const db = new LevelDB(dbPath, { createIfMissing: true });
    const helpers = await loadMcbeLeveldbHelpers();
    await db.open();
    try {
        await db.put(
            helpers.generateChunkKeyFromIndices(
                {
                    x: 0,
                    z: 0,
                    dimension: "overworld",
                },
                "Data3D",
            ),
            Buffer.concat([Buffer.alloc(512), Buffer.from([2])]),
        );
    } finally {
        await db.close();
    }
    await createBedrockTerrainDb(dbPath, [
        {
            chunkX: 0,
            chunkZ: 0,
            subChunkY: 5,
            blockName: "minecraft:oak_leaves",
            localX: 2,
            localY: 0,
            localZ: 3,
        },
    ]);

    const terrain = await readBedrockTerrainColumns({ dbPath });

    assert.deepEqual(
        terrain.columns.find((column) => column.x === 2 && column.z === 3),
        {
            x: 2,
            z: 3,
            y: 80,
            blockName: "minecraft:oak_leaves",
        },
    );
    assert.equal(terrain.diagnostics.biomeParseErrors, 1);
});

test("readBedrockTerrainColumns reads 5-bit and 6-bit palette-packed subchunks", async (t) => {
    const root = await createTempDirectory(t, "blr-terrain-packed-db-");
    const dbPath = path.join(root, "db");
    const fiveBitBlocks = Array.from({ length: 17 }, (_value, index) => ({
        chunkX: 0,
        chunkZ: 0,
        subChunkY: 5,
        blockName: `minecraft:packed_five_${index}`,
        localX: index % 16,
        localY: 3,
        localZ: Math.floor(index / 16),
    }));
    const sixBitBlocks = Array.from({ length: 33 }, (_value, index) => ({
        chunkX: 1,
        chunkZ: 0,
        subChunkY: 6,
        blockName: `minecraft:packed_six_${index}`,
        localX: index % 16,
        localY: 4,
        localZ: Math.floor(index / 16),
    }));
    await createBedrockTerrainDb(dbPath, [...fiveBitBlocks, ...sixBitBlocks]);

    const terrain = await readBedrockTerrainColumns({ dbPath });

    assert.deepEqual(
        terrain.columns.find((column) => column.x === 0 && column.z === 1),
        {
            x: 0,
            z: 1,
            y: 83,
            blockName: "minecraft:packed_five_16",
        },
    );
    assert.deepEqual(
        terrain.columns.find((column) => column.x === 16 && column.z === 2),
        {
            x: 16,
            z: 2,
            y: 100,
            blockName: "minecraft:packed_six_32",
        },
    );
    assert.equal(terrain.diagnostics.parseErrors, 0);
});

test("readBedrockTerrainColumns keeps highest block across subchunks", async (t) => {
    const root = await createTempDirectory(t, "blr-terrain-height-db-");
    const dbPath = path.join(root, "db");
    await createBedrockTerrainDb(dbPath, [
        {
            chunkX: 0,
            chunkZ: 0,
            subChunkY: 0,
            blockName: "minecraft:stone",
            localX: 4,
            localY: 15,
            localZ: 5,
        },
        {
            chunkX: 0,
            chunkZ: 0,
            subChunkY: 5,
            blockName: "minecraft:emerald_block",
            localX: 4,
            localY: 0,
            localZ: 5,
        },
    ]);

    const terrain = await readBedrockTerrainColumns({ dbPath });

    assert.deepEqual(
        terrain.columns.find((column) => column.x === 4 && column.z === 5),
        {
            x: 4,
            z: 5,
            y: 80,
            blockName: "minecraft:emerald_block",
        },
    );
});

test("readBedrockTerrainColumns keeps a lower block when higher subchunks are air in that column", async (t) => {
    const root = await createTempDirectory(t, "blr-terrain-lower-column-db-");
    const dbPath = path.join(root, "db");
    await createBedrockTerrainDb(dbPath, [
        {
            chunkX: 0,
            chunkZ: 0,
            subChunkY: 5,
            blockName: "minecraft:oak_leaves",
            localX: 4,
            localY: 8,
            localZ: 5,
        },
        {
            chunkX: 0,
            chunkZ: 0,
            subChunkY: 8,
            blockName: "minecraft:stone",
            localX: 9,
            localY: 0,
            localZ: 9,
        },
    ]);

    const terrain = await readBedrockTerrainColumns({ dbPath });

    assert.deepEqual(
        terrain.columns.find((column) => column.x === 4 && column.z === 5),
        {
            x: 4,
            z: 5,
            y: 88,
            blockName: "minecraft:oak_leaves",
        },
    );
});

test("readBedrockTerrainColumns skips lower subchunks after a chunk is fully covered", async (t) => {
    const root = await createTempDirectory(t, "blr-terrain-covered-db-");
    const dbPath = path.join(root, "db");
    const fullTopLayer = Array.from({ length: 256 }, (_value, index) => ({
        chunkX: 0,
        chunkZ: 0,
        subChunkY: 5,
        blockName: "minecraft:grass",
        localX: Math.floor(index / 16),
        localY: 0,
        localZ: index % 16,
    }));
    await createBedrockTerrainDb(dbPath, fullTopLayer);

    const db = new LevelDB(dbPath, { createIfMissing: true });
    const helpers = await loadMcbeLeveldbHelpers();
    await db.open();
    try {
        await db.put(
            helpers.generateChunkKeyFromIndices(
                {
                    x: 0,
                    z: 0,
                    dimension: "overworld",
                    subChunkIndex: 4,
                },
                "SubChunkPrefix",
            ),
            Buffer.from([0xff]),
        );
    } finally {
        await db.close();
    }

    const terrain = await readBedrockTerrainColumns({ dbPath });

    assert.equal(terrain.columns.length, 256);
    assert.equal(terrain.diagnostics.parseErrors, 0);
    assert.equal(terrain.diagnostics.emptyColumns, 0);
    assert.equal(
        terrain.columns.every(
            (column) =>
                column.y === 80 && column.blockName === "minecraft:grass",
        ),
        true,
    );
});

test("readBedrockTerrainColumns handles negative chunk and subchunk coordinates", async (t) => {
    const root = await createTempDirectory(t, "blr-terrain-negative-db-");
    const dbPath = path.join(root, "db");
    await createBedrockTerrainDb(dbPath, [
        {
            chunkX: -2,
            chunkZ: -3,
            subChunkY: -1,
            blockName: "minecraft:deepslate",
            localX: 15,
            localY: 14,
            localZ: 1,
        },
    ]);

    const terrain = await readBedrockTerrainColumns({ dbPath });

    assert.deepEqual(terrain.columns, [
        {
            x: -17,
            z: -47,
            y: -2,
            blockName: "minecraft:deepslate",
        },
    ]);
    assert.deepEqual(terrain.bounds, {
        minX: -32,
        maxX: -17,
        minZ: -48,
        maxZ: -33,
    });
});

test("readBedrockTerrainColumns filters subchunks by dimension", async (t) => {
    const root = await createTempDirectory(t, "blr-terrain-dimension-db-");
    const dbPath = path.join(root, "db");
    await createBedrockTerrainDb(dbPath, [
        {
            chunkX: 0,
            chunkZ: 0,
            subChunkY: 4,
            blockName: "minecraft:stone",
            localX: 1,
            localY: 1,
            localZ: 1,
        },
        {
            chunkX: 2,
            chunkZ: 3,
            subChunkY: 1,
            blockName: "minecraft:netherrack",
            localX: 4,
            localY: 5,
            localZ: 6,
            dimension: "nether",
        },
    ]);

    const terrain = await readBedrockTerrainColumns({
        dbPath,
        dimension: "nether",
    });

    assert.deepEqual(terrain.columns, [
        {
            x: 36,
            z: 54,
            y: 21,
            blockName: "minecraft:netherrack",
        },
    ]);
});

test("readBedrockTerrainColumns rejects parseable subchunks without terrain layers", async (t) => {
    const root = await createTempDirectory(t, "blr-terrain-legacy-db-");
    const dbPath = path.join(root, "db");
    await mkdir(dbPath, { recursive: true });
    const db = new LevelDB(dbPath, { createIfMissing: true });
    const helpers = await loadMcbeLeveldbHelpers();
    const legacySubchunk = Buffer.alloc(1 + 4096 + 2048);
    legacySubchunk[0] = 0x00;

    await db.open();
    try {
        await db.put(
            helpers.generateChunkKeyFromIndices(
                {
                    x: 0,
                    z: 0,
                    dimension: "overworld",
                    subChunkIndex: 0,
                },
                "SubChunkPrefix",
            ),
            legacySubchunk,
        );
    } finally {
        await db.close();
    }

    await assert.rejects(
        readBedrockTerrainColumns({ dbPath }),
        /no usable SubChunkPrefix chunks were found/,
    );
});

test("readBedrockTerrainColumns rejects when only corrupt subchunks match", async (t) => {
    const root = await createTempDirectory(t, "blr-terrain-corrupt-db-");
    const dbPath = path.join(root, "db");
    await mkdir(dbPath, { recursive: true });
    const db = new LevelDB(dbPath, { createIfMissing: true });
    const helpers = await loadMcbeLeveldbHelpers();
    await db.open();
    try {
        await db.put(
            helpers.generateChunkKeyFromIndices(
                {
                    x: 0,
                    z: 0,
                    dimension: "overworld",
                    subChunkIndex: 4,
                },
                "SubChunkPrefix",
            ),
            Buffer.from([0xff]),
        );
    } finally {
        await db.close();
    }

    await assert.rejects(
        readBedrockTerrainColumns({ dbPath }),
        /no usable SubChunkPrefix chunks were found/,
    );
});
