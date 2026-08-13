import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { LevelDB } from "@8crafter/leveldb-zlib";
import { loadMcbeLeveldbHelpers } from "../src/mcbe-leveldb-adapter.js";
import { withBedrockWorldObservations } from "../src/world-processing/observation-facade.js";
import {
    createBedrockTerrainDb,
    type TestSubchunkBlock,
} from "./world-image-helpers.js";
import { createTempDirectory } from "./helpers.js";

test("the bounded facade yields deeply frozen observations in dimension/x/y/z/layer order", async (t) => {
    const root = await createTempDirectory(t, "blr-observations-");
    const dbPath = path.join(root, "db");
    const blocks: TestSubchunkBlock[] = [
        {
            chunkX: -1,
            chunkZ: 0,
            subChunkY: 5,
            blockName: "minecraft:spruce_standing_sign",
            states: { ground_sign_direction: 12 },
            version: 18_488_832,
            localX: 15,
            localY: 0,
            localZ: 1,
        },
        {
            chunkX: 0,
            chunkZ: 0,
            subChunkY: 5,
            blockName: "minecraft:stone",
            localX: 0,
            localY: 1,
            localZ: 0,
        },
    ];
    await createBedrockTerrainDb(dbPath, blocks);
    await addSignBlockEntity(dbPath, {
        x: -1,
        y: 80,
        z: 1,
        front: "~\n@object\nlamppost\n\n",
        back: "id.back\n@custom\na\nb",
    });

    await withBedrockWorldObservations({ dbPath }, async (observations) => {
        const result = await collect(
            observations.blocks({
                dimension: "overworld",
                bounds: {
                    min: { x: -1, y: 80, z: 0 },
                    max: { x: 0, y: 81, z: 1 },
                },
            }),
        );
        assert.deepEqual(
            result.map((entry) => [
                entry.location.x,
                entry.location.y,
                entry.location.z,
                entry.layer,
                entry.palette.typeId,
            ]),
            [
                [-1, 80, 1, 0, "minecraft:spruce_standing_sign"],
                [0, 81, 0, 0, "minecraft:stone"],
            ],
        );
        const sign = result[0]!;
        assert.deepEqual(sign.signOrientation, {
            kind: "standing",
            groundSignDirection: 12,
            yawDegrees: -90,
        });
        assert.deepEqual(sign.blockEntity?.signFaces?.[0]?.lines, [
            "~",
            "@object",
            "lamppost",
            "",
        ]);
        assert.ok(Object.isFrozen(sign));
        assert.ok(Object.isFrozen(sign.location));
        assert.ok(Object.isFrozen(sign.palette));
        assert.ok(Object.isFrozen(sign.palette.states));
        assert.ok(Object.isFrozen(sign.blockEntity));
        assert.ok(Object.isFrozen(sign.blockEntity?.signFaces));
        assert.ok(Object.isFrozen(sign.blockEntity?.signFaces?.[0]?.lines));
    });
});

test("the bounded facade applies negative floor division, type filters, and exact query/run limits", async (t) => {
    const root = await createTempDirectory(t, "blr-observation-limits-");
    const dbPath = path.join(root, "db");
    await createBedrockTerrainDb(dbPath, [
        {
            chunkX: -1,
            chunkZ: -1,
            subChunkY: -1,
            blockName: "minecraft:gold_block",
            localX: 15,
            localY: 15,
            localZ: 15,
        },
    ]);

    await withBedrockWorldObservations(
        {
            dbPath,
            limits: { maxPositionsPerQuery: 1, maxPositionsPerRun: 2 },
        },
        async (observations) => {
            const first = await collect(
                observations.blocks({
                    dimension: "overworld",
                    bounds: {
                        min: { x: -1, y: -1, z: -1 },
                        max: { x: -1, y: -1, z: -1 },
                    },
                    typeIds: ["minecraft:gold_block"],
                }),
            );
            assert.equal(first.length, 1);
            assert.deepEqual(first[0]?.location, { x: -1, y: -1, z: -1 });

            const filtered = await collect(
                observations.blocks({
                    dimension: "overworld",
                    bounds: {
                        min: { x: -1, y: -1, z: -1 },
                        max: { x: -1, y: -1, z: -1 },
                    },
                    typeIds: ["minecraft:diamond_block"],
                }),
            );
            assert.deepEqual(filtered, []);

            await assert.rejects(
                async () =>
                    collect(
                        observations.blocks({
                            dimension: "overworld",
                            bounds: {
                                min: { x: -1, y: -1, z: -1 },
                                max: { x: 0, y: -1, z: -1 },
                            },
                        }),
                    ),
                /query covers 2 positions.*limit is 1/i,
            );
            await assert.rejects(
                async () =>
                    collect(
                        observations.blocks({
                            dimension: "overworld",
                            bounds: {
                                min: { x: -1, y: -1, z: -1 },
                                max: { x: -1, y: -1, z: -1 },
                            },
                        }),
                    ),
                /run would cover 3 positions.*limit is 2/i,
            );
        },
    );
});

test("the sign facade streams all coherent signs without charging world-volume limits", async (t) => {
    const root = await createTempDirectory(t, "blr-sign-observations-");
    const dbPath = path.join(root, "db");
    await createBedrockTerrainDb(dbPath, [
        {
            chunkX: -1,
            chunkZ: 0,
            subChunkY: 5,
            blockName: "minecraft:spruce_standing_sign",
            states: { ground_sign_direction: 12 },
            version: 18_488_832,
            localX: 15,
            localY: 0,
            localZ: 1,
        },
        {
            chunkX: 62_500,
            chunkZ: -62_500,
            subChunkY: 4,
            blockName: "minecraft:spruce_wall_sign",
            states: { facing_direction: 5 },
            version: 18_488_832,
            localX: 0,
            localY: 0,
            localZ: 0,
        },
    ]);
    await addSignBlockEntity(dbPath, {
        x: -1,
        y: 80,
        z: 1,
        front: "near\n@name\nnear\n",
        back: "\n\n\n",
    });
    await addSignBlockEntity(dbPath, {
        x: 1_000_000,
        y: 64,
        z: -1_000_000,
        front: "far\n@name\nfar\n",
        back: "\n\n\n",
    });

    await withBedrockWorldObservations(
        {
            dbPath,
            limits: {
                maxPositionsPerQuery: 1,
                maxPositionsPerRun: 1,
                maxSignsPerQuery: 2,
                maxSignsPerRun: 3,
            },
        },
        async (observations) => {
            const all = await collect(observations.signs());
            assert.deepEqual(
                all.map((entry) => [
                    entry.location.x,
                    entry.location.y,
                    entry.location.z,
                    entry.palette.typeId,
                    entry.signOrientation,
                ]),
                [
                    [
                        -1,
                        80,
                        1,
                        "minecraft:spruce_standing_sign",
                        {
                            kind: "standing",
                            groundSignDirection: 12,
                            yawDegrees: -90,
                        },
                    ],
                    [
                        1_000_000,
                        64,
                        -1_000_000,
                        "minecraft:spruce_wall_sign",
                        {
                            kind: "wall",
                            facingDirection: 5,
                            yawDegrees: -90,
                        },
                    ],
                ],
            );
            assert.ok(Object.isFrozen(all[0]));
            assert.equal(all[0]?.blockEntity.id, "Sign");

            const bounded = await collect(
                observations.signs({
                    dimension: "overworld",
                    bounds: {
                        min: { x: 999_999, y: 0, z: -1_000_001 },
                        max: { x: 1_000_001, y: 100, z: -999_999 },
                    },
                }),
            );
            assert.deepEqual(
                bounded.map((entry) => entry.location),
                [{ x: 1_000_000, y: 64, z: -1_000_000 }],
            );
        },
    );
});

test("the sign facade enforces independent result limits", async (t) => {
    const root = await createTempDirectory(t, "blr-sign-observation-limits-");
    const dbPath = path.join(root, "db");
    await createBedrockTerrainDb(dbPath, [
        {
            chunkX: 0,
            chunkZ: 0,
            subChunkY: 4,
            blockName: "minecraft:standing_sign",
            states: { ground_sign_direction: 0 },
            localX: 0,
            localY: 0,
            localZ: 0,
        },
        {
            chunkX: 1,
            chunkZ: 0,
            subChunkY: 4,
            blockName: "minecraft:standing_sign",
            states: { ground_sign_direction: 0 },
            localX: 0,
            localY: 0,
            localZ: 0,
        },
    ]);
    await addSignBlockEntity(dbPath, {
        x: 0,
        y: 64,
        z: 0,
        front: "one\n@x\n\n",
        back: "\n\n\n",
    });
    await addSignBlockEntity(dbPath, {
        x: 16,
        y: 64,
        z: 0,
        front: "two\n@x\n\n",
        back: "\n\n\n",
    });

    await withBedrockWorldObservations(
        { dbPath, limits: { maxSignsPerQuery: 1, maxSignsPerRun: 1 } },
        async (observations) => {
            await assert.rejects(
                async () => collect(observations.signs()),
                /sign query found 2 signs.*limit is 1/i,
            );
            const one = await collect(
                observations.signs({
                    bounds: {
                        min: { x: 0, y: 64, z: 0 },
                        max: { x: 0, y: 64, z: 0 },
                    },
                }),
            );
            assert.equal(one.length, 1);
            await assert.rejects(
                async () =>
                    collect(
                        observations.signs({
                            bounds: {
                                min: { x: 16, y: 64, z: 0 },
                                max: { x: 16, y: 64, z: 0 },
                            },
                        }),
                    ),
                /sign run would return 2 signs.*limit is 1/i,
            );
        },
    );
});

async function addSignBlockEntity(
    dbPath: string,
    input: { x: number; y: number; z: number; front: string; back: string },
): Promise<void> {
    await mkdir(dbPath, { recursive: true });
    const helpers = await loadMcbeLeveldbHelpers();
    const db = new LevelDB(dbPath, { createIfMissing: false });
    const chunkX = Math.floor(input.x / 16);
    const chunkZ = Math.floor(input.z / 16);
    await db.open();
    try {
        await db.put(
            helpers.generateChunkKeyFromIndices(
                { x: chunkX, z: chunkZ, dimension: "overworld" },
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
                                {
                                    id: { type: "string", value: "Sign" },
                                    x: { type: "int", value: input.x },
                                    y: { type: "int", value: input.y },
                                    z: { type: "int", value: input.z },
                                    FrontText: signText(input.front),
                                    BackText: signText(input.back),
                                    IsWaxed: { type: "byte", value: 0 },
                                },
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

function signText(text: string): {
    type: "compound";
    value: Record<string, unknown>;
} {
    return {
        type: "compound",
        value: {
            Text: { type: "string", value: text },
            IgnoreLighting: { type: "byte", value: 0 },
            SignTextColor: { type: "int", value: -16_777_216 },
        },
    };
}

async function collect<T>(input: AsyncIterable<T>): Promise<T[]> {
    const result: T[] = [];
    for await (const value of input) result.push(value);
    return result;
}
