import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import NBT from "prismarine-nbt";
import {
    decodeBedrockSubchunk,
    type DecodedBedrockSubchunk,
} from "../src/world-processing/bedrock-subchunk.js";

const OBSERVED_STORAGE_HEADERS = [2, 4, 6, 8, 10, 12, 16] as const;

test("decodeBedrockSubchunk decodes every observed v9 packed storage header", async () => {
    for (const storageHeader of OBSERVED_STORAGE_HEADERS) {
        const raw = createV9Subchunk({
            subChunkY: -2,
            layers: [
                {
                    storageHeader,
                    palette: [
                        palette("minecraft:air", {}, 18_488_832),
                        palette(
                            "minecraft:smooth_stone_slab",
                            { "minecraft:vertical_half": "bottom" },
                            18_488_832,
                        ),
                    ],
                    indices: new Map([
                        [blockIndex(0, 0, 0), 1],
                        [blockIndex(15, 15, 15), 1],
                    ]),
                },
            ],
        });

        const decoded = await decodeBedrockSubchunk(raw);
        assert.equal(decoded.formatVersion, 9);
        assert.equal(decoded.subChunkY, -2);
        assert.equal(decoded.layers.length, 1);
        const layer = decoded.layers[0]!;
        assert.equal(layer.storageHeader, storageHeader);
        assert.equal(layer.bitsPerBlock, storageHeader >> 1);
        assert.deepEqual(layer.palette[1], {
            typeId: "minecraft:smooth_stone_slab",
            states: { "minecraft:vertical_half": "bottom" },
            version: 18_488_832,
        });
        assert.equal(layer.indices[blockIndex(0, 0, 0)], 1);
        assert.equal(layer.indices[blockIndex(15, 15, 15)], 1);
    }
});

test("decodeBedrockSubchunk preserves every storage layer and canonical block index order", async () => {
    const raw = createV9Subchunk({
        subChunkY: 5,
        layers: [
            {
                storageHeader: 2,
                palette: [
                    palette("minecraft:air"),
                    palette("minecraft:water", { liquid_depth: 0 }),
                ],
                indices: new Map([[blockIndex(3, 4, 5), 1]]),
            },
            {
                storageHeader: 4,
                palette: [
                    palette("minecraft:air"),
                    palette("bc_test:overlay", { active: true }),
                ],
                indices: new Map([[blockIndex(3, 4, 5), 1]]),
            },
        ],
    });

    const decoded = await decodeBedrockSubchunk(raw);
    assert.equal(decoded.layers.length, 2);
    assert.equal(decoded.layers[0]!.indices[blockIndex(3, 4, 5)], 1);
    assert.equal(decoded.layers[1]!.indices[blockIndex(3, 4, 5)], 1);
    assert.equal(decoded.layers[1]!.palette[1]!.states.active, true);
});

test("decodeBedrockSubchunk rejects unsupported formats, storage headers, palette references, and trailing bytes", async () => {
    const valid = createV9Subchunk({
        subChunkY: 0,
        layers: [
            {
                storageHeader: 2,
                palette: [palette("minecraft:air")],
                indices: new Map(),
            },
        ],
    });

    const wrongFormat = Buffer.from(valid);
    wrongFormat[0] = 10;
    await assert.rejects(
        () => decodeBedrockSubchunk(wrongFormat),
        /unsupported subchunk format 10/i,
    );

    const oddHeader = Buffer.from(valid);
    oddHeader[3] = 3;
    await assert.rejects(
        () => decodeBedrockSubchunk(oddHeader),
        /unsupported packed storage header 3/i,
    );

    const invalidReference = createV9Subchunk({
        subChunkY: 0,
        layers: [
            {
                storageHeader: 2,
                palette: [palette("minecraft:air")],
                indices: new Map([[blockIndex(1, 2, 3), 1]]),
            },
        ],
    });
    await assert.rejects(
        () => decodeBedrockSubchunk(invalidReference),
        /palette index 1.*palette size is 1/i,
    );

    await assert.rejects(
        () => decodeBedrockSubchunk(Buffer.concat([valid, Buffer.from([0])])),
        /trailing byte/i,
    );
});

test("decodeBedrockSubchunk can admit legacy formats only at an explicit compatibility edge", async () => {
    const rawV8 = createV8Subchunk({
        layers: [
            {
                storageHeader: 2,
                palette: [palette("minecraft:air")],
                indices: new Map(),
            },
        ],
    });

    await assert.rejects(
        () => decodeBedrockSubchunk(rawV8),
        /unsupported subchunk format 8/i,
    );
    const decoded = await decodeBedrockSubchunk(rawV8, {
        allowedFormatVersions: [8],
        subChunkY: -4,
    });
    assert.equal(decoded.formatVersion, 8);
    assert.equal(decoded.subChunkY, -4);
});

test("the pinned production inventory covers every storage layer in the selected world", async () => {
    const fixture = JSON.parse(
        await readFile(
            new URL(
                "./fixtures/world-processing/production-v9-inventory.json",
                import.meta.url,
            ),
            "utf8",
        ),
    ) as {
        source: { fingerprint: string };
        subchunks: {
            records: number;
            formatVersions: Record<string, number>;
            layerCounts: Record<string, number>;
            firstLayerHeaders: Record<string, number>;
            allLayerHeaders: Record<string, number>;
        };
        blockEntities: { signs: number; distinctFrontBackPairs: number };
    };

    assert.equal(
        fixture.source.fingerprint,
        "sha256:b271e1224429cd53e2b746ffd69ccf3dcef3683dab5282184d979a458f2e6d12",
    );
    assert.deepEqual(Object.keys(fixture.subchunks.formatVersions), ["9"]);
    assert.deepEqual(
        Object.keys(fixture.subchunks.allLayerHeaders).map(Number),
        [...OBSERVED_STORAGE_HEADERS],
    );
    assert.equal(sum(fixture.subchunks.layerCounts), fixture.subchunks.records);
    assert.equal(
        sum(fixture.subchunks.allLayerHeaders),
        fixture.subchunks.records + fixture.subchunks.layerCounts["2"]!,
    );
    assert.equal(
        fixture.subchunks.allLayerHeaders["2"]! -
            fixture.subchunks.firstLayerHeaders["2"]!,
        fixture.subchunks.layerCounts["2"],
    );
    assert.equal(fixture.blockEntities.signs, 1470);
    assert.equal(fixture.blockEntities.distinctFrontBackPairs, 79);
});

type PaletteEntry = DecodedBedrockSubchunk["layers"][number]["palette"][number];

function palette(
    typeId: string,
    states: Record<string, boolean | number | string> = {},
    version = 0,
): PaletteEntry {
    return { typeId, states, version };
}

type LayerFixture = {
    storageHeader: (typeof OBSERVED_STORAGE_HEADERS)[number];
    palette: readonly PaletteEntry[];
    indices: ReadonlyMap<number, number>;
};

function createV9Subchunk(input: {
    subChunkY: number;
    layers: readonly LayerFixture[];
}): Buffer {
    return Buffer.concat([
        Buffer.from([9, input.layers.length, input.subChunkY & 0xff]),
        ...input.layers.map(createPackedLayer),
    ]);
}

function createV8Subchunk(input: { layers: readonly LayerFixture[] }): Buffer {
    return Buffer.concat([
        Buffer.from([8, input.layers.length]),
        ...input.layers.map(createPackedLayer),
    ]);
}

function createPackedLayer(layer: LayerFixture): Buffer {
    const bitsPerBlock = layer.storageHeader >> 1;
    const blocksPerWord = Math.floor(32 / bitsPerBlock);
    const wordCount = Math.ceil(4096 / blocksPerWord);
    const words = Buffer.alloc(wordCount * 4);
    for (const [index, paletteIndex] of layer.indices) {
        const wordIndex = Math.floor(index / blocksPerWord);
        const shift = (index % blocksPerWord) * bitsPerBlock;
        const current = words.readUInt32LE(wordIndex * 4);
        words.writeUInt32LE(
            (current | (paletteIndex << shift)) >>> 0,
            wordIndex * 4,
        );
    }
    const paletteSize = Buffer.alloc(4);
    paletteSize.writeInt32LE(layer.palette.length);
    return Buffer.concat([
        Buffer.from([layer.storageHeader]),
        words,
        paletteSize,
        ...layer.palette.map(writePaletteEntry),
    ]);
}

function writePaletteEntry(entry: PaletteEntry): Buffer {
    const states = Object.fromEntries(
        Object.entries(entry.states).map(([key, value]) => [
            key,
            typeof value === "boolean"
                ? { type: "byte", value: value ? 1 : 0 }
                : typeof value === "number"
                  ? { type: "int", value }
                  : { type: "string", value },
        ]),
    );
    return NBT.writeUncompressed(
        {
            name: "",
            type: "compound",
            value: {
                name: { type: "string", value: entry.typeId },
                states: { type: "compound", value: states },
                version: { type: "int", value: entry.version },
            },
        } as Parameters<typeof NBT.writeUncompressed>[0],
        "little",
    );
}

function blockIndex(localX: number, localY: number, localZ: number): number {
    return (localX << 8) | (localZ << 4) | localY;
}

function sum(values: Record<string, number>): number {
    return Object.values(values).reduce((total, value) => total + value, 0);
}
