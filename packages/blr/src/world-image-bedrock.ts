import { LevelDB } from "@8crafter/leveldb-zlib";
import {
    loadMcbeLeveldbHelpers,
    type McbeLeveldbHelpers,
} from "./mcbe-leveldb-adapter.js";
import {
    normalizeChunkDimension,
    toBedrockDimension,
    type WorldImageDimension,
} from "./world-image-dimension.js";

export { type WorldImageDimension } from "./world-image-dimension.js";

export type WorldHeightColumn = {
    x: number;
    z: number;
    height: number;
};

export type WorldHeightmap = {
    chunkCount: number;
    bounds: {
        minX: number;
        maxX: number;
        minZ: number;
        maxZ: number;
    };
    minHeight: number;
    maxHeight: number;
    columns: WorldHeightColumn[];
};

export type ReadBedrockWorldHeightmapOptions = {
    dbPath: string;
    dimension?: WorldImageDimension;
};

export function readRawBedrockData3dHeightMap(
    rawValue: Uint8Array,
): number[][] {
    if (rawValue.length < 512) {
        throw new Error(
            `Data3D value is too short to contain a heightmap: ${rawValue.length} bytes.`,
        );
    }

    const heightMap = Array.from({ length: 16 }, () =>
        Array.from({ length: 16 }, () => 0),
    );
    const buffer = Buffer.from(rawValue);
    for (let index = 0; index < 256; index += 1) {
        const x = index % 16;
        const z = Math.floor(index / 16);
        heightMap[x]![z] = buffer.readInt16LE(index * 2);
    }
    return heightMap;
}

function readHeightMap(
    helpers: McbeLeveldbHelpers,
    rawValue: Uint8Array,
): number[][] {
    try {
        const parsed = helpers.readData3dValue(rawValue);
        if (parsed) {
            return parsed.heightMap;
        }
    } catch (error) {
        if (rawValue.length < 512) {
            throw error;
        }
    }

    return readRawBedrockData3dHeightMap(rawValue);
}

export async function readBedrockWorldHeightmap(
    options: ReadBedrockWorldHeightmapOptions,
): Promise<WorldHeightmap> {
    const db = new LevelDB(options.dbPath, {
        createIfMissing: false,
        bufferKeys: true,
    });
    const helpers = await loadMcbeLeveldbHelpers();
    const targetDimension = toBedrockDimension(options.dimension);
    const columns: WorldHeightColumn[] = [];
    const seenChunks = new Set<string>();
    let minX = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let minZ = Number.POSITIVE_INFINITY;
    let maxZ = Number.NEGATIVE_INFINITY;
    let minHeight = Number.POSITIVE_INFINITY;
    let maxHeight = Number.NEGATIVE_INFINITY;

    await db.open();
    try {
        for await (const [rawKey, rawValue] of db.getIterator({
            keys: true,
            values: true,
            keyAsBuffer: true,
            valueAsBuffer: true,
        })) {
            if (!Buffer.isBuffer(rawKey) || !rawValue) {
                continue;
            }
            if (helpers.getContentTypeFromDBKey(rawKey) !== "Data3D") {
                continue;
            }

            const indices = helpers.getChunkKeyIndices(rawKey);
            if (
                normalizeChunkDimension(indices.dimension) !== targetDimension
            ) {
                continue;
            }

            const heightMap = readHeightMap(
                helpers,
                Buffer.isBuffer(rawValue) ? rawValue : Buffer.from(rawValue),
            );
            seenChunks.add(`${indices.x},${indices.z}`);

            for (let localX = 0; localX < 16; localX += 1) {
                for (let localZ = 0; localZ < 16; localZ += 1) {
                    const x = indices.x * 16 + localX;
                    const z = indices.z * 16 + localZ;
                    const height = heightMap[localX]?.[localZ];
                    if (typeof height !== "number") {
                        continue;
                    }
                    columns.push({ x, z, height });
                    minX = Math.min(minX, x);
                    maxX = Math.max(maxX, x);
                    minZ = Math.min(minZ, z);
                    maxZ = Math.max(maxZ, z);
                    minHeight = Math.min(minHeight, height);
                    maxHeight = Math.max(maxHeight, height);
                }
            }
        }
    } finally {
        await db.close();
    }

    if (columns.length === 0) {
        throw new Error(
            `Cannot export a world image because no Data3D heightmap chunks were found for ${options.dimension ?? "overworld"}.`,
        );
    }

    return {
        chunkCount: seenChunks.size,
        bounds: { minX, maxX, minZ, maxZ },
        minHeight,
        maxHeight,
        columns,
    };
}
