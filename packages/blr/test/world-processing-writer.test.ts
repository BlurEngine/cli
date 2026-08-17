import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { LevelDB } from "@8crafter/leveldb-zlib";
import { loadMcbeLeveldbHelpers } from "../src/mcbe-leveldb-adapter.js";
import { withBedrockWorldObservations } from "../src/world-processing/observation-facade.js";
import { decodeBedrockSubchunk } from "../src/world-processing/bedrock-subchunk.js";
import type { PrimitiveWorldMutation } from "../src/world-processing/mutations.js";
import type { WorldBlockObservation } from "../src/world-processing.js";
import { applyBedrockWorldMutations } from "../src/world-processing/writer.js";
import {
    createBedrockHeightmapDb,
    createBedrockTerrainDb,
} from "./world-image-helpers.js";
import { createTempDirectory } from "./helpers.js";

const version = 18_488_832;
const existingAir = {
    typeId: "minecraft:air",
    states: {},
    version: 0,
} as const;
const air = { typeId: "minecraft:air", states: {}, version } as const;
const sign = {
    typeId: "minecraft:spruce_standing_sign",
    states: { ground_sign_direction: 12 },
    version,
} as const;
const water = {
    typeId: "minecraft:water",
    states: { liquid_depth: 0 },
    version,
} as const;

test("applyBedrockWorldMutations atomically consumes a waterlogged sign, preserves unrelated data, and fixes height", async (t) => {
    const root = await createTempDirectory(t, "blr-writer-sign-");
    const dbPath = path.join(root, "db");
    await createBedrockHeightmapDb(dbPath, [
        { chunkX: 0, chunkZ: 0, baseHeight: 1 },
    ]);
    await createBedrockTerrainDb(dbPath, [
        {
            chunkX: 0,
            chunkZ: 0,
            subChunkY: -1,
            blockName: "minecraft:dirt",
            version,
            localX: 0,
            localY: 15,
            localZ: 0,
        },
        {
            chunkX: 0,
            chunkZ: 0,
            subChunkY: 0,
            layer: 0,
            blockName: sign.typeId,
            states: sign.states,
            version,
            localX: 0,
            localY: 0,
            localZ: 0,
        },
        {
            chunkX: 0,
            chunkZ: 0,
            subChunkY: 0,
            layer: 1,
            blockName: water.typeId,
            states: water.states,
            version,
            localX: 0,
            localY: 0,
            localZ: 0,
        },
        {
            chunkX: 0,
            chunkZ: 0,
            subChunkY: 0,
            blockName: "minecraft:stone",
            version,
            localX: 2,
            localY: 0,
            localZ: 0,
        },
    ]);
    await addBlockEntities(dbPath);
    const unrelatedKey = Buffer.from("unrelated-key");
    const unrelatedValue = Buffer.from("unrelated-value");
    await putRaw(dbPath, unrelatedKey, unrelatedValue);

    const mutations: PrimitiveWorldMutation[] = [
        {
            kind: "block-write",
            dimension: "overworld",
            location: { x: 0, y: 0, z: 0 },
            layer: 0,
            expectedPalette: sign,
            replacementPalette: air,
            blockEntityPolicy: "remove",
            claims: [{ processorId: "locations", opId: "consume-sign" }],
        },
        {
            kind: "block-entity-remove",
            dimension: "overworld",
            location: { x: 0, y: 0, z: 0 },
            expectedId: "Sign",
            claims: [{ processorId: "locations", opId: "consume-sign" }],
        },
    ];
    const result = await applyBedrockWorldMutations({ dbPath, mutations });
    assert.equal(result.verified, true);
    assert.ok(result.mutatedKeyCount >= 2);

    await withBedrockWorldObservations({ dbPath }, async (observations) => {
        const entries = [];
        for await (const entry of observations.blocks({
            dimension: "overworld",
            bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 2, y: 0, z: 0 } },
            includeAir: true,
        })) {
            entries.push(entry);
        }
        const markerLayers = entries.filter(
            (entry) => entry.location.x === 0 && entry.location.z === 0,
        );
        assert.deepEqual(
            markerLayers.map((entry) => [entry.layer, entry.palette]),
            [
                [0, air],
                [1, water],
            ],
        );
        assert.equal(markerLayers[0]?.blockEntity, undefined);
        const stone = entries.find((entry) => entry.location.x === 2);
        assert.equal(stone?.palette.typeId, "minecraft:stone");
        assert.equal(stone?.blockEntity?.id, "Chest");
    });
    assert.deepEqual(await getRaw(dbPath, unrelatedKey), unrelatedValue);
    assert.equal(await readHeight(dbPath, 0, 0, 0, 0), 0);
});

test("writer grows packed palette width deterministically and rejects stale or absent targets before batch", async (t) => {
    const root = await createTempDirectory(t, "blr-writer-palette-");
    const dbPath = path.join(root, "db");
    await createBedrockHeightmapDb(dbPath, [
        { chunkX: 0, chunkZ: 0, baseHeight: 1 },
    ]);
    await createBedrockTerrainDb(dbPath, [
        {
            chunkX: 0,
            chunkZ: 0,
            subChunkY: 0,
            blockName: "minecraft:stone",
            version,
            localX: 0,
            localY: 0,
            localZ: 0,
        },
    ]);
    const barrier = {
        typeId: "minecraft:barrier",
        states: {},
        version,
    } as const;
    const mutation: PrimitiveWorldMutation = {
        kind: "block-write",
        dimension: "overworld",
        location: { x: 1, y: 0, z: 0 },
        layer: 0,
        expectedPalette: existingAir,
        replacementPalette: barrier,
        blockEntityPolicy: "require-absent",
        claims: [{ processorId: "decor", opId: "barrier" }],
    };
    await applyBedrockWorldMutations({ dbPath, mutations: [mutation] });
    const decoded = await readSubchunk(dbPath, 0, 0, 0);
    assert.equal(decoded.layers[0]?.storageHeader, 4);
    assert.deepEqual(
        decoded.layers[0]?.palette.map((entry) => entry.typeId),
        ["minecraft:air", "minecraft:stone", "minecraft:barrier"],
    );

    await assert.rejects(
        () =>
            applyBedrockWorldMutations({
                dbPath,
                mutations: [
                    {
                        ...mutation,
                        location: { x: 2, y: 0, z: 0 },
                        expectedPalette: sign,
                    },
                ],
            }),
        /expected palette.*does not match/i,
    );
    await assert.rejects(
        () =>
            applyBedrockWorldMutations({
                dbPath,
                mutations: [{ ...mutation, location: { x: 32, y: 0, z: 0 } }],
            }),
        /existing subchunk/i,
    );
});

test("injected pre-batch and post-batch verification failures are reported and never hide partial staging", async (t) => {
    const root = await createTempDirectory(t, "blr-writer-failure-");
    const dbPath = path.join(root, "db");
    await createBedrockHeightmapDb(dbPath, [
        { chunkX: 0, chunkZ: 0, baseHeight: 1 },
    ]);
    await createBedrockTerrainDb(dbPath, [
        {
            chunkX: 0,
            chunkZ: 0,
            subChunkY: 0,
            blockName: "minecraft:stone",
            version,
            localX: 0,
            localY: 0,
            localZ: 0,
        },
    ]);
    const mutation: PrimitiveWorldMutation = {
        kind: "block-write",
        dimension: "overworld",
        location: { x: 1, y: 0, z: 0 },
        layer: 0,
        expectedPalette: existingAir,
        replacementPalette: {
            typeId: "minecraft:barrier",
            states: {},
            version,
        },
        blockEntityPolicy: "require-absent",
        claims: [{ processorId: "decor", opId: "barrier" }],
    };
    await assert.rejects(
        () =>
            applyBedrockWorldMutations({
                dbPath,
                mutations: [mutation],
                hooks: {
                    beforeBatch: () => {
                        throw new Error("before batch");
                    },
                },
            }),
        /before batch/i,
    );
    assert.equal(
        (await readBlock(dbPath, 1, 0, 0, 0)).palette.typeId,
        "minecraft:air",
    );
    await assert.rejects(
        () =>
            applyBedrockWorldMutations({
                dbPath,
                mutations: [mutation],
                hooks: {
                    afterBatchBeforeVerify: () => {
                        throw new Error("verification interrupted");
                    },
                },
            }),
        /verification interrupted/i,
    );
    assert.equal(
        (await readBlock(dbPath, 1, 0, 0, 0)).palette.typeId,
        "minecraft:barrier",
    );
});

async function addBlockEntities(dbPath: string): Promise<void> {
    const helpers = await loadMcbeLeveldbHelpers();
    const db = new LevelDB(dbPath, { createIfMissing: false });
    await db.open();
    try {
        await db.put(
            helpers.generateChunkKeyFromIndices(
                { x: 0, z: 0, dimension: "overworld" },
                "BlockEntity",
            ),
            helpers.entryContentTypeToFormatMap.BlockEntity.serialize({
                type: "compound",
                value: {
                    blockEntities: {
                        type: "list",
                        value: {
                            type: "compound",
                            value: [
                                blockEntity("Sign", 0, 0, 0),
                                blockEntity("Chest", 2, 0, 0),
                            ],
                        },
                    },
                },
            }),
        );
    } finally {
        await db.close();
    }
}

function blockEntity(id: string, x: number, y: number, z: number) {
    return {
        id: { type: "string", value: id },
        x: { type: "int", value: x },
        y: { type: "int", value: y },
        z: { type: "int", value: z },
    };
}

async function putRaw(
    dbPath: string,
    key: Buffer,
    value: Buffer,
): Promise<void> {
    const db = new LevelDB(dbPath, { createIfMissing: false });
    await db.open();
    try {
        await db.put(key, value);
    } finally {
        await db.close();
    }
}

async function getRaw(dbPath: string, key: Buffer): Promise<Buffer | null> {
    const db = new LevelDB(dbPath, { createIfMissing: false });
    await db.open();
    try {
        return await db.get(key);
    } finally {
        await db.close();
    }
}

async function readSubchunk(
    dbPath: string,
    chunkX: number,
    chunkZ: number,
    subChunkY: number,
) {
    const helpers = await loadMcbeLeveldbHelpers();
    const raw = await getRaw(
        dbPath,
        helpers.generateChunkKeyFromIndices(
            {
                x: chunkX,
                z: chunkZ,
                dimension: "overworld",
                subChunkIndex: subChunkY,
            },
            "SubChunkPrefix",
        ),
    );
    assert.ok(raw);
    return decodeBedrockSubchunk(raw);
}

async function readBlock(
    dbPath: string,
    x: number,
    y: number,
    z: number,
    layer: number,
) {
    return withBedrockWorldObservations({ dbPath }, async (observations) => {
        let found: WorldBlockObservation | undefined;
        for await (const entry of observations.blocks({
            dimension: "overworld",
            bounds: { min: { x, y, z }, max: { x, y, z } },
            includeAir: true,
        })) {
            if (entry.layer === layer) found = entry;
        }
        assert.ok(found);
        return found;
    });
}

async function readHeight(
    dbPath: string,
    chunkX: number,
    chunkZ: number,
    localX: number,
    localZ: number,
): Promise<number> {
    const helpers = await loadMcbeLeveldbHelpers();
    const raw = await getRaw(
        dbPath,
        helpers.generateChunkKeyFromIndices(
            { x: chunkX, z: chunkZ, dimension: "overworld" },
            "Data3D",
        ),
    );
    assert.ok(raw);
    const parsed = helpers.readData3dValue(raw);
    assert.ok(parsed);
    return parsed.heightMap[localX]![localZ]!;
}
