import { LevelDB } from "@8crafter/leveldb-zlib";
import NBT from "prismarine-nbt";
import {
    loadMcbeLeveldbHelpers,
    type BiomePalette,
    type McbeLeveldbHelpers,
} from "./mcbe-leveldb-adapter.js";
import {
    normalizeChunkDimension,
    normalizeWorldImageDimension,
    toBedrockDimension,
    type WorldImageDimension,
} from "./world-image-dimension.js";
import { readRawBedrockData3dHeightMap } from "./world-image-bedrock.js";

export type WorldTerrainColumn = {
    x: number;
    z: number;
    y: number;
    blockName: string;
    biomeName?: string;
};

export type WorldTerrainColumns = {
    chunkCount: number;
    bounds: {
        minX: number;
        maxX: number;
        minZ: number;
        maxZ: number;
    };
    columns: WorldTerrainColumn[];
    diagnostics: {
        parseErrors: number;
        biomeParseErrors?: number;
        emptyColumns: number;
    };
};

export type WorldLoadedColumns = {
    chunkCount: number;
    columnCount: number;
    bounds: {
        minX: number;
        maxX: number;
        minZ: number;
        maxZ: number;
    };
    minHeight: number;
    maxHeight: number;
    chunks: Array<{ chunkX: number; chunkZ: number }>;
};

export type BedrockWorldImageData = {
    loadedColumns: WorldLoadedColumns;
    terrain: WorldTerrainColumns;
};

export type ReadBedrockTerrainColumnsOptions = {
    dbPath: string;
    dimension?: WorldImageDimension;
};

const DIMENSION_HEIGHT_RANGES: Record<
    WorldImageDimension,
    { minY: number; maxY: number }
> = {
    overworld: { minY: -64, maxY: 319 },
    nether: { minY: 0, maxY: 127 },
    end: { minY: 0, maxY: 255 },
};

export function createSubchunkBlockIndex(
    localX: number,
    localY: number,
    localZ: number,
): number {
    return (localX << 8) | (localZ << 4) | localY;
}

export async function readBedrockTerrainColumns(
    options: ReadBedrockTerrainColumnsOptions,
): Promise<WorldTerrainColumns> {
    return (
        await readBedrockWorldData(options, { includeLoadedColumns: false })
    ).terrain;
}

export async function readBedrockWorldImageData(
    options: ReadBedrockTerrainColumnsOptions,
): Promise<BedrockWorldImageData> {
    const result = await readBedrockWorldData(options, {
        includeLoadedColumns: true,
    });
    if (!result.loadedColumns || result.loadedColumns.columnCount === 0) {
        throw new Error(
            `Cannot export a world image because no Data3D heightmap chunks were found for ${options.dimension ?? "overworld"}.`,
        );
    }
    return {
        loadedColumns: result.loadedColumns,
        terrain: result.terrain,
    };
}

async function readBedrockWorldData(
    options: ReadBedrockTerrainColumnsOptions,
    readOptions: { includeLoadedColumns: boolean },
): Promise<{
    loadedColumns?: WorldLoadedColumns;
    terrain: WorldTerrainColumns;
}> {
    const dimension = normalizeWorldImageDimension(options.dimension);
    const targetDimension = toBedrockDimension(dimension);
    const helpers = await loadMcbeLeveldbHelpers();
    const db = new LevelDB(options.dbPath, {
        createIfMissing: false,
        bufferKeys: true,
    });
    const builder = createTerrainColumnsBuilder();
    const loadedBuilder = readOptions.includeLoadedColumns
        ? createLoadedColumnsBuilder()
        : undefined;
    let currentChunk: TerrainChunkAccumulator | undefined;
    let currentChunkKey: string | undefined;
    let parseErrors = 0;
    let biomeParseErrors = 0;

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
            const contentType = helpers.getContentTypeFromDBKey(rawKey);
            if (contentType !== "SubChunkPrefix" && contentType !== "Data3D") {
                continue;
            }

            const indices = helpers.getChunkKeyIndices(rawKey);
            if (
                normalizeChunkDimension(indices.dimension) !== targetDimension
            ) {
                continue;
            }
            const chunkKey = createTerrainChunkKey(indices.x, indices.z);
            if (currentChunkKey !== chunkKey) {
                if (currentChunk) {
                    parseErrors += await finalizeTerrainChunk(
                        builder,
                        currentChunk,
                        dimension,
                        helpers,
                    );
                }
                currentChunkKey = chunkKey;
                currentChunk = createTerrainChunk(indices.x, indices.z);
            }
            const chunk = currentChunk;
            if (!chunk) {
                continue;
            }

            if (contentType === "Data3D") {
                const value = Buffer.isBuffer(rawValue)
                    ? rawValue
                    : Buffer.from(rawValue);
                let parsed:
                    | ReturnType<McbeLeveldbHelpers["readData3dValue"]>
                    | undefined;
                try {
                    parsed = helpers.readData3dValue(value);
                    if (parsed) {
                        chunk.biomes = parsed.biomes;
                    }
                } catch {
                    biomeParseErrors += 1;
                }
                if (loadedBuilder) {
                    mergeLoadedChunkIntoBuilder(
                        loadedBuilder,
                        indices.x,
                        indices.z,
                        parsed?.heightMap ??
                            readRawBedrockData3dHeightMap(value),
                    );
                }
                continue;
            }

            chunk.subchunks.push({
                subChunkY: indices.subChunkIndex ?? 0,
                rawValue: Buffer.isBuffer(rawValue)
                    ? Buffer.from(rawValue)
                    : Buffer.from(rawValue),
            });
        }
        if (currentChunk) {
            parseErrors += await finalizeTerrainChunk(
                builder,
                currentChunk,
                dimension,
                helpers,
            );
        }
    } finally {
        await db.close();
    }

    return {
        loadedColumns: loadedBuilder
            ? buildLoadedColumns(loadedBuilder, dimension)
            : undefined,
        terrain: buildTerrainColumns(
            builder,
            dimension,
            parseErrors,
            biomeParseErrors,
        ),
    };
}

type TerrainChunkAccumulator = {
    chunkX: number;
    chunkZ: number;
    columns: Array<{ y: number; blockName: string } | undefined>;
    subchunks: Array<{ subChunkY: number; rawValue: Buffer }>;
    biomes?: BiomePalette[];
    hasTerrain: boolean;
    coveredColumns: number;
};

type SubChunkLayer = {
    palette?: {
        value?: Record<
            string,
            {
                value?: {
                    name?: {
                        value?: unknown;
                    };
                };
            }
        >;
    };
    block_indices?: {
        value?: {
            value?: number[];
        };
    };
    packed?: {
        data: Buffer;
        blockDataOffset: number;
        bitsPerBlock: number;
        blocksPerWord: number;
        blockNames: string[];
        hasNonAir: boolean;
    };
};

type NbtParseResult = {
    parsed: unknown;
    metadata: {
        size: number;
    };
};

async function parseSubchunkLayers(
    rawValue: Buffer,
    helpers: McbeLeveldbHelpers,
): Promise<SubChunkLayer[] | undefined> {
    try {
        return await parsePackedSubchunkLayers(rawValue);
    } catch (error) {
        if (!isUnsupportedPackedSubchunkVersionError(error)) {
            throw error;
        }
    }

    try {
        const parsed =
            await helpers.entryContentTypeToFormatMap.SubChunkPrefix.parse(
                rawValue,
            );
        return getLayers(parsed);
    } catch (error) {
        if (!isUnsupportedPackedStorageVersionError(error)) {
            throw error;
        }
        return parsePackedSubchunkLayers(rawValue);
    }
}

function isUnsupportedPackedStorageVersionError(error: unknown): boolean {
    return (
        error instanceof Error &&
        /^Unknown storage version: (10|12)$/.test(error.message)
    );
}

function isUnsupportedPackedSubchunkVersionError(error: unknown): boolean {
    return (
        error instanceof Error &&
        /^Unsupported packed SubChunkPrefix version: /.test(error.message)
    );
}

async function parsePackedSubchunkLayers(
    data: Buffer,
): Promise<SubChunkLayer[]> {
    let currentOffset = 0;
    const version = data[currentOffset++];
    if (version !== 0x01 && version !== 0x08 && version !== 0x09) {
        throw new Error(
            `Unsupported packed SubChunkPrefix version: ${String(version)}`,
        );
    }

    const layerCount = version === 0x01 ? 1 : data[currentOffset++];
    if (version >= 0x09) {
        currentOffset += 1;
    }
    if (typeof layerCount !== "number") {
        throw new Error("SubChunkPrefix is missing a storage layer count.");
    }

    const layers: SubChunkLayer[] = [];
    for (let layerIndex = 0; layerIndex < layerCount; layerIndex += 1) {
        const storageVersion = data[currentOffset++];
        if (typeof storageVersion !== "number") {
            throw new Error("SubChunkPrefix is missing a storage version.");
        }
        const bitsPerBlock = storageVersion >> 1;
        if (bitsPerBlock <= 0 || bitsPerBlock > 16) {
            throw new Error(
                `Unsupported packed SubChunkPrefix bits per block: ${bitsPerBlock}.`,
            );
        }

        const blocksPerWord = Math.floor(32 / bitsPerBlock);
        const wordCount = Math.ceil(4096 / blocksPerWord);
        const blockDataOffset = currentOffset;
        currentOffset += wordCount * 4;
        if (currentOffset + 4 > data.length) {
            throw new Error("SubChunkPrefix block data is truncated.");
        }

        const paletteSize = data.readInt32LE(currentOffset);
        currentOffset += 4;
        if (paletteSize < 0) {
            throw new Error(
                `SubChunkPrefix palette size is invalid: ${paletteSize}.`,
            );
        }

        const blockNames: string[] = [];

        for (
            let paletteIndex = 0;
            paletteIndex < paletteSize;
            paletteIndex += 1
        ) {
            const fastEntry = readBedrockPaletteEntryBlockName(
                data,
                currentOffset,
            );
            if (fastEntry) {
                currentOffset += fastEntry.size;
                blockNames[paletteIndex] = fastEntry.blockName;
            } else {
                const result = (await NBT.parse(
                    data.subarray(currentOffset),
                    "little",
                )) as NbtParseResult;
                if (result.metadata.size <= 0) {
                    throw new Error("SubChunkPrefix palette entry is invalid.");
                }
                currentOffset += result.metadata.size;
                blockNames[paletteIndex] = getPaletteBlockName(result.parsed);
            }
        }

        layers.push({
            packed: {
                data,
                blockDataOffset,
                bitsPerBlock,
                blocksPerWord,
                blockNames,
                hasNonAir: blockNames.some(
                    (blockName) => blockName !== "minecraft:air",
                ),
            },
        });
    }

    return layers;
}

type TerrainColumnsBuilder = {
    chunkCount: number;
    columns: WorldTerrainColumn[];
    emptyColumns: number;
    minX: number;
    maxX: number;
    minZ: number;
    maxZ: number;
};

type LoadedColumnsBuilder = {
    seenChunks: Set<string>;
    chunkCount: number;
    columnCount: number;
    minX: number;
    maxX: number;
    minZ: number;
    maxZ: number;
    minHeight: number;
    maxHeight: number;
    chunks: Array<{ chunkX: number; chunkZ: number }>;
};

function createTerrainColumnsBuilder(): TerrainColumnsBuilder {
    return {
        chunkCount: 0,
        columns: [],
        emptyColumns: 0,
        minX: Number.POSITIVE_INFINITY,
        maxX: Number.NEGATIVE_INFINITY,
        minZ: Number.POSITIVE_INFINITY,
        maxZ: Number.NEGATIVE_INFINITY,
    };
}

function createLoadedColumnsBuilder(): LoadedColumnsBuilder {
    return {
        seenChunks: new Set<string>(),
        chunkCount: 0,
        columnCount: 0,
        minX: Number.POSITIVE_INFINITY,
        maxX: Number.NEGATIVE_INFINITY,
        minZ: Number.POSITIVE_INFINITY,
        maxZ: Number.NEGATIVE_INFINITY,
        minHeight: Number.POSITIVE_INFINITY,
        maxHeight: Number.NEGATIVE_INFINITY,
        chunks: [],
    };
}

function mergeLoadedChunkIntoBuilder(
    builder: LoadedColumnsBuilder,
    chunkX: number,
    chunkZ: number,
    heightMap: number[][],
): void {
    const key = createTerrainChunkKey(chunkX, chunkZ);
    if (builder.seenChunks.has(key)) {
        return;
    }
    builder.seenChunks.add(key);
    builder.chunkCount += 1;
    builder.columnCount += 256;
    builder.chunks.push({ chunkX, chunkZ });
    const chunkMinX = chunkX * 16;
    const chunkMinZ = chunkZ * 16;
    builder.minX = Math.min(builder.minX, chunkMinX);
    builder.maxX = Math.max(builder.maxX, chunkMinX + 15);
    builder.minZ = Math.min(builder.minZ, chunkMinZ);
    builder.maxZ = Math.max(builder.maxZ, chunkMinZ + 15);

    for (let localX = 0; localX < 16; localX += 1) {
        for (let localZ = 0; localZ < 16; localZ += 1) {
            const height = heightMap[localX]?.[localZ];
            if (typeof height !== "number") continue;
            builder.minHeight = Math.min(builder.minHeight, height);
            builder.maxHeight = Math.max(builder.maxHeight, height);
        }
    }
}

function buildLoadedColumns(
    builder: LoadedColumnsBuilder,
    dimension: WorldImageDimension,
): WorldLoadedColumns {
    if (builder.columnCount === 0) {
        return {
            chunkCount: 0,
            columnCount: 0,
            bounds: {
                minX: 0,
                maxX: -1,
                minZ: 0,
                maxZ: -1,
            },
            minHeight: DIMENSION_HEIGHT_RANGES[dimension].minY,
            maxHeight: DIMENSION_HEIGHT_RANGES[dimension].maxY,
            chunks: [],
        };
    }
    return {
        chunkCount: builder.chunkCount,
        columnCount: builder.columnCount,
        bounds: {
            minX: builder.minX,
            maxX: builder.maxX,
            minZ: builder.minZ,
            maxZ: builder.maxZ,
        },
        minHeight: builder.minHeight,
        maxHeight: builder.maxHeight,
        chunks: builder.chunks,
    };
}

function createTerrainChunkKey(chunkX: number, chunkZ: number): string {
    return `${chunkX},${chunkZ}`;
}

function createTerrainChunk(
    chunkX: number,
    chunkZ: number,
): TerrainChunkAccumulator {
    return {
        chunkX,
        chunkZ,
        columns: Array.from({ length: 256 }),
        subchunks: [],
        hasTerrain: false,
        coveredColumns: 0,
    };
}

async function finalizeTerrainChunk(
    builder: TerrainColumnsBuilder,
    chunk: TerrainChunkAccumulator,
    dimension: WorldImageDimension,
    helpers: McbeLeveldbHelpers,
): Promise<number> {
    let parseErrors = 0;
    const range = DIMENSION_HEIGHT_RANGES[dimension];
    const subchunks = chunk.subchunks.sort(
        (left, right) => right.subChunkY - left.subChunkY,
    );
    for (const subchunk of subchunks) {
        if (chunk.coveredColumns === 256) {
            break;
        }
        const minY = subchunk.subChunkY * 16;
        const maxY = minY + 15;
        if (maxY < range.minY || minY > range.maxY) {
            continue;
        }
        try {
            const layers = await parseSubchunkLayers(
                subchunk.rawValue,
                helpers,
            );
            if (!layers) {
                parseErrors += 1;
                continue;
            }
            mergeSubchunkIntoTerrainChunk(chunk, layers, subchunk.subChunkY);
        } catch {
            parseErrors += 1;
        }
    }
    appendTerrainChunk(builder, chunk, dimension, helpers);
    return parseErrors;
}

function mergeSubchunkIntoTerrainChunk(
    chunk: TerrainChunkAccumulator,
    layers: SubChunkLayer[],
    subChunkY: number,
): void {
    if (layers.every(isAirOnlyLayer)) {
        return;
    }
    for (let localX = 0; localX < 16; localX += 1) {
        for (let localZ = 0; localZ < 16; localZ += 1) {
            const candidate = findTopVisibleBlockInSubchunk(
                layers,
                localX,
                localZ,
                subChunkY,
            );
            if (!candidate) continue;
            const columnIndex = createChunkColumnIndex(localX, localZ);
            const current = chunk.columns[columnIndex];
            if (!current) {
                chunk.coveredColumns += 1;
                chunk.columns[columnIndex] = candidate;
                chunk.hasTerrain = true;
            } else if (candidate.y > current.y) {
                chunk.columns[columnIndex] = candidate;
            }
        }
    }
}

function isAirOnlyLayer(layer: SubChunkLayer): boolean {
    if (layer.packed) {
        return !layer.packed.hasNonAir;
    }
    const palette = layer.palette?.value;
    if (!palette) {
        return false;
    }
    return Object.values(palette).every((block) => {
        const name = block?.value?.name?.value;
        return typeof name !== "string" || name === "minecraft:air";
    });
}

function createChunkColumnIndex(localX: number, localZ: number): number {
    return localX * 16 + localZ;
}

function buildTerrainColumns(
    builder: TerrainColumnsBuilder,
    dimension: WorldImageDimension,
    parseErrors: number,
    biomeParseErrors: number,
): WorldTerrainColumns {
    if (builder.chunkCount === 0) {
        if (parseErrors > 0) {
            throw new Error(
                `Cannot read Bedrock terrain because no usable SubChunkPrefix chunks were found for ${dimension} after ${parseErrors} parse errors.`,
            );
        }
        throw new Error(
            `Cannot read Bedrock terrain because no SubChunkPrefix chunks were found for ${dimension}.`,
        );
    }

    return {
        chunkCount: builder.chunkCount,
        bounds: {
            minX: builder.minX,
            maxX: builder.maxX,
            minZ: builder.minZ,
            maxZ: builder.maxZ,
        },
        columns: builder.columns,
        diagnostics: {
            parseErrors,
            ...(biomeParseErrors > 0 ? { biomeParseErrors } : {}),
            emptyColumns: builder.emptyColumns,
        },
    };
}

function appendTerrainChunk(
    builder: TerrainColumnsBuilder,
    chunk: TerrainChunkAccumulator,
    dimension: WorldImageDimension,
    helpers: McbeLeveldbHelpers,
): void {
    if (!chunk.hasTerrain) {
        return;
    }

    const range = DIMENSION_HEIGHT_RANGES[dimension];
    const chunkMinX = chunk.chunkX * 16;
    const chunkMinZ = chunk.chunkZ * 16;
    builder.chunkCount += 1;
    builder.minX = Math.min(builder.minX, chunkMinX);
    builder.maxX = Math.max(builder.maxX, chunkMinX + 15);
    builder.minZ = Math.min(builder.minZ, chunkMinZ);
    builder.maxZ = Math.max(builder.maxZ, chunkMinZ + 15);

    for (let localX = 0; localX < 16; localX += 1) {
        for (let localZ = 0; localZ < 16; localZ += 1) {
            const block = chunk.columns[createChunkColumnIndex(localX, localZ)];
            if (!block) {
                builder.emptyColumns += 1;
                continue;
            }
            if (block.y < range.minY || block.y > range.maxY) {
                builder.emptyColumns += 1;
                continue;
            }

            builder.columns.push({
                x: chunkMinX + localX,
                z: chunkMinZ + localZ,
                y: block.y,
                blockName: block.blockName,
                ...resolveBiomeAtBlock(
                    chunk,
                    dimension,
                    block.y,
                    localX,
                    localZ,
                    helpers,
                ),
            });
        }
    }
}

function resolveBiomeAtBlock(
    chunk: TerrainChunkAccumulator,
    dimension: WorldImageDimension,
    y: number,
    localX: number,
    localZ: number,
    helpers: McbeLeveldbHelpers,
): { biomeName?: string } {
    const biomeId = readBiomeIdAtBlock(
        chunk.biomes,
        dimension,
        y,
        localX,
        localZ,
    );
    if (typeof biomeId !== "number") {
        return {};
    }
    const biomeName = helpers.getBiomeTypeFromID(biomeId);
    if (typeof biomeName !== "string" || biomeName.length === 0) {
        return {};
    }
    return {
        biomeName: biomeName.includes(":")
            ? biomeName
            : `minecraft:${biomeName}`,
    };
}

function readBiomeIdAtBlock(
    biomes: BiomePalette[] | undefined,
    dimension: WorldImageDimension,
    y: number,
    localX: number,
    localZ: number,
): number | undefined {
    if (!biomes) return undefined;
    const range = DIMENSION_HEIGHT_RANGES[dimension];
    const relativeY = y - range.minY;
    const biomeSubchunkIndex = Math.floor(relativeY / 16);
    const localY = ((relativeY % 16) + 16) % 16;
    const biome = biomes[biomeSubchunkIndex];
    if (!biome?.values || biome.values.length === 0) {
        return undefined;
    }
    const paletteIndex =
        biome.values[createSubchunkBlockIndex(localX, localY, localZ)];
    if (typeof paletteIndex !== "number") {
        return undefined;
    }
    const biomeId = biome.palette[paletteIndex];
    return typeof biomeId === "number" ? biomeId : undefined;
}

function findTopVisibleBlockInSubchunk(
    layers: SubChunkLayer[],
    localX: number,
    localZ: number,
    subChunkY: number,
): { y: number; blockName: string } | undefined {
    for (let localY = 15; localY >= 0; localY -= 1) {
        const blockName = getBlockNameAt(layers, localX, localY, localZ);
        if (blockName !== "minecraft:air") {
            return { y: subChunkY * 16 + localY, blockName };
        }
    }
    return undefined;
}

function getBlockNameAt(
    layers: SubChunkLayer[],
    localX: number,
    localY: number,
    localZ: number,
): string {
    const blockIndex = createSubchunkBlockIndex(localX, localY, localZ);
    for (const layer of layers) {
        if (layer.packed) {
            const blockName = getPackedLayerBlockName(layer.packed, blockIndex);
            if (blockName !== "minecraft:air") {
                return blockName;
            }
            continue;
        }
        const paletteIndex = layer.block_indices?.value?.value?.[blockIndex];
        if (typeof paletteIndex !== "number") {
            continue;
        }
        const block = layer.palette?.value?.[String(paletteIndex)];
        const name = block?.value?.name?.value;
        if (typeof name === "string" && name !== "minecraft:air") {
            return name;
        }
    }
    return "minecraft:air";
}

function getPackedLayerBlockName(
    layer: NonNullable<SubChunkLayer["packed"]>,
    blockIndex: number,
): string {
    if (!layer.hasNonAir) {
        return "minecraft:air";
    }
    const word = layer.data.readUInt32LE(
        layer.blockDataOffset +
            Math.floor(blockIndex / layer.blocksPerWord) * 4,
    );
    const shift = (blockIndex % layer.blocksPerWord) * layer.bitsPerBlock;
    const paletteIndex = (word >>> shift) & ((1 << layer.bitsPerBlock) - 1);
    return layer.blockNames[paletteIndex] ?? "minecraft:air";
}

const NBT_TAG_END = 0;
const NBT_TAG_BYTE = 1;
const NBT_TAG_SHORT = 2;
const NBT_TAG_INT = 3;
const NBT_TAG_LONG = 4;
const NBT_TAG_FLOAT = 5;
const NBT_TAG_DOUBLE = 6;
const NBT_TAG_BYTE_ARRAY = 7;
const NBT_TAG_STRING = 8;
const NBT_TAG_LIST = 9;
const NBT_TAG_COMPOUND = 10;
const NBT_TAG_INT_ARRAY = 11;
const NBT_TAG_LONG_ARRAY = 12;

type NbtReader = {
    data: Buffer;
    offset: number;
};

function readBedrockPaletteEntryBlockName(
    data: Buffer,
    offset: number,
): { blockName: string; size: number } | undefined {
    const reader: NbtReader = { data, offset };
    try {
        const rootType = readNbtUnsignedByte(reader);
        if (rootType !== NBT_TAG_COMPOUND) {
            return undefined;
        }
        readNbtString(reader);

        let blockName: string | undefined;
        while (true) {
            const tagType = readNbtUnsignedByte(reader);
            if (tagType === NBT_TAG_END) {
                break;
            }
            const tagName = readNbtString(reader);
            if (tagType === NBT_TAG_STRING && tagName === "name") {
                blockName = readNbtString(reader);
            } else {
                skipNbtPayload(reader, tagType);
            }
        }

        const size = reader.offset - offset;
        return size > 0
            ? { blockName: blockName ?? "minecraft:air", size }
            : undefined;
    } catch {
        return undefined;
    }
}

function readNbtUnsignedByte(reader: NbtReader): number {
    ensureNbtBytes(reader, 1);
    const value = reader.data.readUInt8(reader.offset);
    reader.offset += 1;
    return value;
}

function readNbtInt(reader: NbtReader): number {
    ensureNbtBytes(reader, 4);
    const value = reader.data.readInt32LE(reader.offset);
    reader.offset += 4;
    return value;
}

function readNbtString(reader: NbtReader): string {
    ensureNbtBytes(reader, 2);
    const length = reader.data.readUInt16LE(reader.offset);
    reader.offset += 2;
    ensureNbtBytes(reader, length);
    const value = reader.data.toString(
        "utf8",
        reader.offset,
        reader.offset + length,
    );
    reader.offset += length;
    return value;
}

function skipNbtBytes(reader: NbtReader, count: number): void {
    if (!Number.isInteger(count) || count < 0) {
        throw new Error("NBT payload length is invalid.");
    }
    ensureNbtBytes(reader, count);
    reader.offset += count;
}

function skipNbtPayload(reader: NbtReader, tagType: number): void {
    switch (tagType) {
        case NBT_TAG_BYTE:
            skipNbtBytes(reader, 1);
            return;
        case NBT_TAG_SHORT:
            skipNbtBytes(reader, 2);
            return;
        case NBT_TAG_INT:
        case NBT_TAG_FLOAT:
            skipNbtBytes(reader, 4);
            return;
        case NBT_TAG_LONG:
        case NBT_TAG_DOUBLE:
            skipNbtBytes(reader, 8);
            return;
        case NBT_TAG_BYTE_ARRAY:
            skipNbtBytes(reader, readNbtInt(reader));
            return;
        case NBT_TAG_STRING:
            readNbtString(reader);
            return;
        case NBT_TAG_LIST: {
            const childType = readNbtUnsignedByte(reader);
            const length = readNbtInt(reader);
            for (let index = 0; index < length; index += 1) {
                skipNbtPayload(reader, childType);
            }
            return;
        }
        case NBT_TAG_COMPOUND:
            skipNbtCompoundPayload(reader);
            return;
        case NBT_TAG_INT_ARRAY:
            skipNbtBytes(reader, readNbtInt(reader) * 4);
            return;
        case NBT_TAG_LONG_ARRAY:
            skipNbtBytes(reader, readNbtInt(reader) * 8);
            return;
        default:
            throw new Error(`Unsupported NBT tag type ${String(tagType)}.`);
    }
}

function skipNbtCompoundPayload(reader: NbtReader): void {
    while (true) {
        const tagType = readNbtUnsignedByte(reader);
        if (tagType === NBT_TAG_END) {
            return;
        }
        readNbtString(reader);
        skipNbtPayload(reader, tagType);
    }
}

function ensureNbtBytes(reader: NbtReader, count: number): void {
    if (reader.offset + count > reader.data.length) {
        throw new Error("NBT payload is truncated.");
    }
}

function getPaletteBlockName(parsed: unknown): string {
    const name = (
        parsed as {
            value?: {
                name?: {
                    value?: unknown;
                };
            };
        }
    )?.value?.name?.value;
    return typeof name === "string" ? name : "minecraft:air";
}

function getLayers(parsed: unknown): SubChunkLayer[] | undefined {
    const layers = (parsed as { value?: { layers?: unknown } } | undefined)
        ?.value?.layers;
    if (
        typeof layers !== "object" ||
        !layers ||
        !("value" in layers) ||
        typeof layers.value !== "object" ||
        !layers.value ||
        !("value" in layers.value) ||
        !Array.isArray(layers.value.value)
    ) {
        return undefined;
    }
    return layers.value.value as SubChunkLayer[];
}
