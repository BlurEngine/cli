import { mkdir, rm } from "node:fs/promises";
import { LevelDB } from "@8crafter/leveldb-zlib";
import {
    loadMcbeLeveldbHelpers,
    type BedrockDimension,
} from "../src/mcbe-leveldb-adapter.js";

type HeightMap16 = number[][];
type Biomes = Array<{
    values: number[] | null;
    palette: number[];
}>;
type TestBiomeSubchunk = {
    biomeSubchunkIndex: number;
    biomeId: number;
    localX?: number;
    localY?: number;
    localZ?: number;
    fill?: boolean;
};

export type TestHeightmapChunk = {
    chunkX: number;
    chunkZ: number;
    dimension?: "overworld" | "nether" | "the_end";
    baseHeight: number;
    biomes?: TestBiomeSubchunk[];
};

function createHeightMap(baseHeight: number): HeightMap16 {
    return Array.from({ length: 16 }, (_row, x) =>
        Array.from({ length: 16 }, (_column, z) => baseHeight + x + z),
    ) as HeightMap16;
}

function createBiomeData(biomes?: TestBiomeSubchunk[]): Biomes {
    const result: Biomes = Array.from({ length: 24 }, () => ({
        values: [],
        palette: [],
    }));
    const entries =
        biomes ??
        Array.from({ length: 24 }, (_value, biomeSubchunkIndex) => ({
            biomeSubchunkIndex,
            biomeId: 1,
            fill: true,
        }));
    if (biomes && !entries.some((entry) => entry.biomeSubchunkIndex === 0)) {
        entries.unshift({ biomeSubchunkIndex: 0, biomeId: 1, fill: true });
    }

    for (const entry of entries) {
        const subchunk = result[entry.biomeSubchunkIndex];
        if (!subchunk) continue;
        const values =
            subchunk.values && subchunk.values.length === 4096
                ? subchunk.values
                : Array.from({ length: 4096 }, () => 0);
        subchunk.values = values;
        let paletteIndex = subchunk.palette.indexOf(entry.biomeId);
        if (paletteIndex < 0) {
            paletteIndex = subchunk.palette.length;
            subchunk.palette.push(entry.biomeId);
        }
        if (entry.fill) {
            values.fill(paletteIndex);
        } else {
            values[
                createBedrockSubchunkBlockIndex(
                    entry.localX ?? 0,
                    entry.localY ?? 0,
                    entry.localZ ?? 0,
                )
            ] = paletteIndex;
        }
    }

    return result;
}

export async function createBedrockHeightmapDb(
    dbPath: string,
    chunks: TestHeightmapChunk[],
): Promise<void> {
    await rm(dbPath, { recursive: true, force: true });
    await mkdir(dbPath, { recursive: true });

    const db = new LevelDB(dbPath, { createIfMissing: true });
    const helpers = await loadMcbeLeveldbHelpers();
    await db.open();
    try {
        for (const chunk of chunks) {
            const dimension = chunk.dimension ?? "overworld";
            await db.put(
                helpers.generateChunkKeyFromIndices(
                    {
                        x: chunk.chunkX,
                        z: chunk.chunkZ,
                        dimension,
                    },
                    "Data3D",
                ),
                helpers.writeData3DValue(
                    createHeightMap(chunk.baseHeight),
                    createBiomeData(chunk.biomes),
                ),
            );
        }
    } finally {
        await db.close();
    }
}

export type TestSubchunkBlock = {
    chunkX: number;
    chunkZ: number;
    subChunkY: number;
    blockName: string;
    localX: number;
    localY: number;
    localZ: number;
    dimension?: BedrockDimension;
};

export async function createBedrockTerrainDb(
    dbPath: string,
    blocks: TestSubchunkBlock[],
): Promise<void> {
    await mkdir(dbPath, { recursive: true });

    const db = new LevelDB(dbPath, { createIfMissing: true });
    const helpers = await loadMcbeLeveldbHelpers();
    await db.open();
    try {
        const grouped = new Map<string, TestSubchunkBlock[]>();
        for (const block of blocks) {
            const dimension = block.dimension ?? "overworld";
            const key = [
                block.chunkX,
                block.chunkZ,
                block.subChunkY,
                dimension,
            ].join(",");
            grouped.set(key, [...(grouped.get(key) ?? []), block]);
        }

        for (const group of grouped.values()) {
            const first = group[0]!;
            const paletteBlocks = [
                ...new Set(group.map((block) => block.blockName)),
            ];
            const palette = Object.fromEntries([
                [
                    "0",
                    {
                        type: "compound",
                        value: {
                            name: {
                                type: "string",
                                value: "minecraft:air",
                            },
                            states: { type: "compound", value: {} },
                            version: { type: "int", value: 0 },
                        },
                    },
                ],
                ...paletteBlocks.map((blockName, index) => [
                    String(index + 1),
                    {
                        type: "compound",
                        value: {
                            name: { type: "string", value: blockName },
                            states: { type: "compound", value: {} },
                            version: { type: "int", value: 0 },
                        },
                    },
                ]),
            ]);
            const paletteIndexByBlock = new Map(
                paletteBlocks.map((blockName, index) => [blockName, index + 1]),
            );
            const bitsPerBlock = Math.max(
                1,
                Math.ceil(Math.log2(paletteBlocks.length + 1)),
            );
            const blockIndices = Array.from({ length: 4096 }, () => 0);
            for (const block of group) {
                blockIndices[
                    createBedrockSubchunkBlockIndex(
                        block.localX,
                        block.localY,
                        block.localZ,
                    )
                ] = paletteIndexByBlock.get(block.blockName) ?? 0;
            }

            const raw =
                helpers.entryContentTypeToFormatMap.SubChunkPrefix.serialize({
                    type: "compound",
                    value: {
                        version: { type: "byte", value: 9 },
                        layerCount: { type: "byte", value: 1 },
                        subChunkIndex: {
                            type: "byte",
                            value: first.subChunkY,
                        },
                        layers: {
                            type: "list",
                            value: {
                                type: "compound",
                                value: [
                                    {
                                        storageVersion: {
                                            type: "byte",
                                            value: bitsPerBlock << 1,
                                        },
                                        palette: {
                                            type: "compound",
                                            value: palette,
                                        },
                                        block_indices: {
                                            type: "list",
                                            value: {
                                                type: "int",
                                                value: blockIndices,
                                            },
                                        },
                                    },
                                ],
                            },
                        },
                    },
                });
            await db.put(
                helpers.generateChunkKeyFromIndices(
                    {
                        x: first.chunkX,
                        z: first.chunkZ,
                        dimension: first.dimension ?? "overworld",
                        subChunkIndex: first.subChunkY,
                    },
                    "SubChunkPrefix",
                ),
                raw,
            );
        }
    } finally {
        await db.close();
    }
}

export function createBedrockSubchunkBlockIndex(
    localX: number,
    localY: number,
    localZ: number,
): number {
    return (localX << 8) | (localZ << 4) | localY;
}
