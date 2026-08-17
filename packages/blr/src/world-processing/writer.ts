import { createHash } from "node:crypto";
import { LevelDB } from "@8crafter/leveldb-zlib";
import NBT from "prismarine-nbt";
import {
    loadMcbeLeveldbHelpers,
    type McbeLeveldbHelpers,
} from "../mcbe-leveldb-adapter.js";
import type {
    WorldBlockEntityPolicy,
    WorldBlockLocation,
    WorldBlockPaletteEntry,
    WorldDimensionId,
} from "../world-processing.js";
import { canonicalJson } from "./canonical-json.js";
import {
    decodeBedrockSubchunk,
    type DecodedBedrockSubchunk,
    type DecodedBedrockSubchunkLayer,
} from "./bedrock-subchunk.js";
import type {
    PrimitiveWorldBlockWrite,
    PrimitiveWorldMutation,
} from "./mutations.js";
import { withBedrockWorldObservations } from "./observation-facade.js";

const DIMENSION_HEIGHTS: Readonly<
    Record<WorldDimensionId, { readonly minY: number; readonly maxY: number }>
> = Object.freeze({
    overworld: { minY: -64, maxY: 319 },
    nether: { minY: 0, maxY: 127 },
    the_end: { minY: 0, maxY: 255 },
});
const SUPPORTED_BITS_PER_BLOCK = [1, 2, 3, 4, 5, 6, 8] as const;

type RawOperation =
    | { readonly type: "put"; readonly key: Buffer; readonly value: Buffer }
    | { readonly type: "del"; readonly key: Buffer };

export type BedrockWorldWriterHooks = {
    readonly beforeBatch?: () => void | Promise<void>;
    readonly afterBatchBeforeVerify?: () => void | Promise<void>;
};

export type ApplyBedrockWorldMutationsOptions = {
    /** A disposable staged-world DB. The authored source must never be passed. */
    readonly dbPath: string;
    readonly mutations: readonly PrimitiveWorldMutation[];
    readonly hooks?: BedrockWorldWriterHooks;
};

export type AppliedBedrockWorldMutations = {
    readonly verified: true;
    readonly mutatedKeyCount: number;
};

type MutableLayer = {
    storageHeader: number;
    bitsPerBlock: number;
    palette: WorldBlockPaletteEntry[];
    paletteEntryBytes: Buffer[];
    indices: Uint16Array;
    rawBytes: Buffer;
    modified: boolean;
};

type MutableSubchunk = {
    readonly key: Buffer;
    readonly dimension: WorldDimensionId;
    readonly chunkX: number;
    readonly chunkZ: number;
    readonly subChunkY: number;
    readonly decoded: DecodedBedrockSubchunk;
    readonly layers: MutableLayer[];
};

type ChunkCoordinate = {
    readonly dimension: WorldDimensionId;
    readonly chunkX: number;
    readonly chunkZ: number;
};

type BlockEntityCompound = Record<string, unknown>;

/**
 * Applies a fully normalised mutation plan to a disposable Bedrock LevelDB.
 * All preconditions are checked before one synchronous raw-key batch. The DB
 * is then closed, reopened, and independently verified before it can be used.
 */
export async function applyBedrockWorldMutations(
    options: ApplyBedrockWorldMutationsOptions,
): Promise<AppliedBedrockWorldMutations> {
    const helpers = await loadMcbeLeveldbHelpers();
    const db = new LevelDB(options.dbPath, {
        createIfMissing: false,
        bufferKeys: true,
    });
    const operations = new Map<string, RawOperation>();
    const modifiedSubchunks = new Map<string, MutableSubchunk>();
    const changedLayerZeroColumns = new Map<string, Set<number>>();
    await db.open();
    try {
        await planSubchunkWrites(
            db,
            helpers,
            options.mutations,
            operations,
            modifiedSubchunks,
            changedLayerZeroColumns,
        );
        await planBlockEntityWrites(db, helpers, options.mutations, operations);
        await planHeightmapWrites(
            db,
            helpers,
            changedLayerZeroColumns,
            modifiedSubchunks,
            operations,
        );

        const touchedKeys = new Set(operations.keys());
        const untouchedBefore = await digestUntouchedEntries(db, touchedKeys);
        await options.hooks?.beforeBatch?.();
        if (operations.size > 0) {
            await db.batch([...operations.values()], { sync: true });
        }
        await db.close();
        await options.hooks?.afterBatchBeforeVerify?.();
        await verifyAppliedMutations({
            dbPath: options.dbPath,
            mutations: options.mutations,
            operations,
            untouchedBefore,
            modifiedSubchunks,
            changedLayerZeroColumns,
        });
        return Object.freeze({
            verified: true,
            mutatedKeyCount: operations.size,
        });
    } finally {
        if (db.isOpen()) await db.close();
    }
}

async function planSubchunkWrites(
    db: LevelDB,
    helpers: McbeLeveldbHelpers,
    mutations: readonly PrimitiveWorldMutation[],
    operations: Map<string, RawOperation>,
    subchunks: Map<string, MutableSubchunk>,
    changedLayerZeroColumns: Map<string, Set<number>>,
): Promise<void> {
    const writes = mutations.filter(
        (mutation): mutation is PrimitiveWorldBlockWrite =>
            mutation.kind === "block-write",
    );
    const bySubchunk = new Map<string, PrimitiveWorldBlockWrite[]>();
    for (const write of writes) {
        const coordinates = blockCoordinates(write.location);
        const key = subchunkMapKey(
            write.dimension,
            coordinates.chunkX,
            coordinates.chunkZ,
            coordinates.subChunkY,
        );
        bySubchunk.set(key, [...(bySubchunk.get(key) ?? []), write]);
    }

    for (const [mapKey, group] of [...bySubchunk].sort(([left], [right]) =>
        left.localeCompare(right),
    )) {
        const first = group[0]!;
        const coordinates = blockCoordinates(first.location);
        const rawKey = helpers.generateChunkKeyFromIndices(
            {
                x: coordinates.chunkX,
                z: coordinates.chunkZ,
                dimension: first.dimension,
                subChunkIndex: coordinates.subChunkY,
            },
            "SubChunkPrefix",
        );
        const raw = await db.get(rawKey);
        if (!raw) {
            throw new Error(
                `World mutation requires an existing subchunk at ${formatLocation(first.location)}.`,
            );
        }
        const decoded = await decodeBedrockSubchunk(raw);
        if (decoded.subChunkY !== coordinates.subChunkY) {
            throw new Error(
                `Subchunk key Y ${coordinates.subChunkY} does not match embedded Y ${decoded.subChunkY}.`,
            );
        }
        const mutable: MutableSubchunk = {
            key: rawKey,
            dimension: first.dimension,
            chunkX: coordinates.chunkX,
            chunkZ: coordinates.chunkZ,
            subChunkY: coordinates.subChunkY,
            decoded,
            layers: decoded.layers.map(mutableLayer),
        };

        const missingByLayer = new Map<
            number,
            Map<string, WorldBlockPaletteEntry>
        >();
        for (const write of group) {
            const layer = mutable.layers[write.layer];
            if (!layer) {
                throw new Error(
                    `World mutation requires existing storage layer ${write.layer} at ${formatLocation(write.location)}.`,
                );
            }
            const blockIndex = blockCoordinates(write.location).blockIndex;
            const current = layer.palette[layer.indices[blockIndex] ?? 0];
            if (!current || !palettesEqual(current, write.expectedPalette)) {
                throw new Error(
                    `World mutation expected palette ${write.expectedPalette.typeId} at ${formatLocation(write.location)}, but the existing palette does not match.`,
                );
            }
            if (paletteIndex(layer.palette, write.replacementPalette) < 0) {
                const missing = missingByLayer.get(write.layer) ?? new Map();
                missing.set(
                    canonicalJson(write.replacementPalette),
                    write.replacementPalette,
                );
                missingByLayer.set(write.layer, missing);
            }
        }

        for (const [layerIndex, missing] of missingByLayer) {
            const layer = mutable.layers[layerIndex]!;
            for (const [canonical, palette] of [...missing].sort(([a], [b]) =>
                a.localeCompare(b),
            )) {
                if (paletteIndex(layer.palette, palette) >= 0) continue;
                layer.palette.push(freezePalette(palette));
                layer.paletteEntryBytes.push(writePaletteEntry(palette));
                void canonical;
            }
            const requiredBits = requiredBitsPerBlock(layer.palette.length);
            if (requiredBits > layer.bitsPerBlock) {
                layer.bitsPerBlock = requiredBits;
                layer.storageHeader = requiredBits << 1;
            }
        }

        for (const write of group) {
            const layer = mutable.layers[write.layer]!;
            const coordinatesForWrite = blockCoordinates(write.location);
            const replacementIndex = paletteIndex(
                layer.palette,
                write.replacementPalette,
            );
            if (replacementIndex < 0) {
                throw new Error(
                    "Internal error resolving replacement palette.",
                );
            }
            layer.indices[coordinatesForWrite.blockIndex] = replacementIndex;
            layer.modified = true;
            if (write.layer === 0) {
                const chunkKey = chunkMapKey(
                    write.dimension,
                    coordinatesForWrite.chunkX,
                    coordinatesForWrite.chunkZ,
                );
                const columns =
                    changedLayerZeroColumns.get(chunkKey) ?? new Set();
                columns.add(
                    (coordinatesForWrite.localX << 4) |
                        coordinatesForWrite.localZ,
                );
                changedLayerZeroColumns.set(chunkKey, columns);
            }
        }
        subchunks.set(mapKey, mutable);
        setOperation(operations, {
            type: "put",
            key: rawKey,
            value: serializeSubchunk(mutable),
        });
    }
}

async function planBlockEntityWrites(
    db: LevelDB,
    helpers: McbeLeveldbHelpers,
    mutations: readonly PrimitiveWorldMutation[],
    operations: Map<string, RawOperation>,
): Promise<void> {
    const byChunk = new Map<string, PrimitiveWorldMutation[]>();
    for (const mutation of mutations) {
        const coordinates = blockCoordinates(mutation.location);
        const key = chunkMapKey(
            mutation.dimension,
            coordinates.chunkX,
            coordinates.chunkZ,
        );
        byChunk.set(key, [...(byChunk.get(key) ?? []), mutation]);
    }

    for (const [key, chunkMutations] of byChunk) {
        const chunk = parseChunkMapKey(key);
        const rawKey = helpers.generateChunkKeyFromIndices(
            chunk,
            "BlockEntity",
        );
        const raw = await db.get(rawKey);
        const parsed = raw
            ? await helpers.entryContentTypeToFormatMap.BlockEntity.parse(raw)
            : undefined;
        const entities = parsed
            ? [...parsed.value.blockEntities.value.value]
            : [];
        const entityIndex = indexBlockEntities(entities, chunk);
        const removals = new Set<number>();

        for (const mutation of chunkMutations) {
            const locationKey = locationMapKey(mutation.location);
            const existingIndex = entityIndex.get(locationKey);
            const existing =
                existingIndex === undefined
                    ? undefined
                    : entities[existingIndex];
            if (mutation.kind === "block-entity-remove") {
                if (
                    !existing ||
                    blockEntityId(existing) !== mutation.expectedId
                ) {
                    throw new Error(
                        `Expected block entity ${mutation.expectedId} at ${formatLocation(mutation.location)}, found ${existing ? blockEntityId(existing) : "none"}.`,
                    );
                }
                removals.add(existingIndex!);
                continue;
            }
            validateBlockEntityPolicy(
                mutation,
                existing,
                existingIndex,
                removals,
            );
        }

        if (removals.size === 0) continue;
        const retained = entities.filter(
            (_entity, index) => !removals.has(index),
        );
        if (!parsed) {
            throw new Error("Internal block-entity removal without a record.");
        }
        if (retained.length === 0) {
            setOperation(operations, { type: "del", key: rawKey });
        } else {
            const updated = {
                ...parsed,
                value: {
                    ...parsed.value,
                    blockEntities: {
                        ...parsed.value.blockEntities,
                        value: {
                            ...parsed.value.blockEntities.value,
                            value: retained,
                        },
                    },
                },
            };
            setOperation(operations, {
                type: "put",
                key: rawKey,
                value: helpers.entryContentTypeToFormatMap.BlockEntity.serialize(
                    updated,
                ),
            });
        }
    }
}

function validateBlockEntityPolicy(
    mutation: PrimitiveWorldBlockWrite,
    existing: BlockEntityCompound | undefined,
    existingIndex: number | undefined,
    removals: Set<number>,
): void {
    const policy: WorldBlockEntityPolicy = mutation.blockEntityPolicy;
    if (policy === "require-absent") {
        if (existing) {
            throw new Error(
                `World mutation requires no block entity at ${formatLocation(mutation.location)}, found ${blockEntityId(existing)}.`,
            );
        }
        return;
    }
    if (policy === "remove") {
        if (existingIndex !== undefined) removals.add(existingIndex);
        return;
    }
    if (
        existing &&
        mutation.expectedPalette.typeId !== mutation.replacementPalette.typeId
    ) {
        throw new Error(
            `Cannot preserve block entity ${blockEntityId(existing)} while changing ${mutation.expectedPalette.typeId} to ${mutation.replacementPalette.typeId} at ${formatLocation(mutation.location)}.`,
        );
    }
}

async function planHeightmapWrites(
    db: LevelDB,
    helpers: McbeLeveldbHelpers,
    changedColumns: Map<string, Set<number>>,
    modifiedSubchunks: Map<string, MutableSubchunk>,
    operations: Map<string, RawOperation>,
): Promise<void> {
    const readCache = new Map<string, DecodedBedrockSubchunk | undefined>();
    for (const [key, columns] of changedColumns) {
        const chunk = parseChunkMapKey(key);
        const dataKey = helpers.generateChunkKeyFromIndices(chunk, "Data3D");
        const raw = await db.get(dataKey);
        if (!raw) {
            throw new Error(
                `World mutation requires existing Data3D for ${chunk.dimension} chunk ${chunk.x},${chunk.z}.`,
            );
        }
        const parsed = helpers.readData3dValue(raw);
        if (!parsed) {
            throw new Error(
                `Could not decode Data3D for ${chunk.dimension} chunk ${chunk.x},${chunk.z}.`,
            );
        }
        const heightMap = parsed.heightMap.map((row) => [...row]);
        for (const column of columns) {
            const localX = column >> 4;
            const localZ = column & 15;
            heightMap[localX]![localZ] = await calculateColumnHeight(
                db,
                helpers,
                chunk.dimension,
                chunk.x,
                chunk.z,
                localX,
                localZ,
                modifiedSubchunks,
                readCache,
            );
        }
        setOperation(operations, {
            type: "put",
            key: dataKey,
            value: helpers.writeData3DValue(heightMap, parsed.biomes),
        });
    }
}

async function calculateColumnHeight(
    db: LevelDB,
    helpers: McbeLeveldbHelpers,
    dimension: WorldDimensionId,
    chunkX: number,
    chunkZ: number,
    localX: number,
    localZ: number,
    modifiedSubchunks: Map<string, MutableSubchunk>,
    readCache: Map<string, DecodedBedrockSubchunk | undefined>,
): Promise<number> {
    const range = DIMENSION_HEIGHTS[dimension];
    const minSubchunk = Math.floor(range.minY / 16);
    const maxSubchunk = Math.floor(range.maxY / 16);
    for (
        let subChunkY = maxSubchunk;
        subChunkY >= minSubchunk;
        subChunkY -= 1
    ) {
        const key = subchunkMapKey(dimension, chunkX, chunkZ, subChunkY);
        const modified = modifiedSubchunks.get(key);
        let decoded: DecodedBedrockSubchunk | undefined = modified?.decoded;
        let layer: MutableLayer | DecodedBedrockSubchunkLayer | undefined =
            modified?.layers[0];
        if (!modified) {
            if (!readCache.has(key)) {
                const raw = await db.get(
                    helpers.generateChunkKeyFromIndices(
                        {
                            x: chunkX,
                            z: chunkZ,
                            dimension,
                            subChunkIndex: subChunkY,
                        },
                        "SubChunkPrefix",
                    ),
                );
                readCache.set(
                    key,
                    raw ? await decodeBedrockSubchunk(raw) : undefined,
                );
            }
            decoded = readCache.get(key);
            layer = decoded?.layers[0];
        }
        if (!layer) continue;
        for (let localY = 15; localY >= 0; localY -= 1) {
            const worldY = subChunkY * 16 + localY;
            if (worldY > range.maxY || worldY < range.minY) continue;
            const blockIndex = (localX << 8) | (localZ << 4) | localY;
            const palette = layer.palette[layer.indices[blockIndex] ?? 0];
            if (palette && palette.typeId !== "minecraft:air")
                return worldY + 1;
        }
    }
    return range.minY;
}

async function verifyAppliedMutations(input: {
    readonly dbPath: string;
    readonly mutations: readonly PrimitiveWorldMutation[];
    readonly operations: ReadonlyMap<string, RawOperation>;
    readonly untouchedBefore: EntryDigest;
    readonly modifiedSubchunks: ReadonlyMap<string, MutableSubchunk>;
    readonly changedLayerZeroColumns: ReadonlyMap<string, ReadonlySet<number>>;
}): Promise<void> {
    const db = new LevelDB(input.dbPath, {
        createIfMissing: false,
        bufferKeys: true,
    });
    await db.open();
    try {
        const untouchedAfter = await digestUntouchedEntries(
            db,
            new Set(input.operations.keys()),
        );
        if (
            untouchedAfter.count !== input.untouchedBefore.count ||
            untouchedAfter.hash !== input.untouchedBefore.hash
        ) {
            throw new Error("World mutation changed an untouched LevelDB key.");
        }
        for (const subchunk of input.modifiedSubchunks.values()) {
            const raw = await db.get(subchunk.key);
            if (!raw) throw new Error("A written subchunk is missing.");
            await decodeBedrockSubchunk(raw);
        }
        const helpers = await loadMcbeLeveldbHelpers();
        for (const [key, columns] of input.changedLayerZeroColumns) {
            const chunk = parseChunkMapKey(key);
            const raw = await db.get(
                helpers.generateChunkKeyFromIndices(chunk, "Data3D"),
            );
            const parsed = raw ? helpers.readData3dValue(raw) : null;
            if (!parsed) throw new Error("A written Data3D record is invalid.");
            for (const column of columns) {
                const x = column >> 4;
                const z = column & 15;
                if (!Number.isInteger(parsed.heightMap[x]?.[z])) {
                    throw new Error("A written heightmap value is invalid.");
                }
            }
        }
    } finally {
        await db.close();
    }

    await withBedrockWorldObservations(
        { dbPath: input.dbPath },
        async (facade) => {
            for (const mutation of input.mutations) {
                let found = false;
                for await (const observation of facade.blocks({
                    dimension: mutation.dimension,
                    bounds: { min: mutation.location, max: mutation.location },
                    includeAir: true,
                })) {
                    if (mutation.kind === "block-write") {
                        if (observation.layer !== mutation.layer) continue;
                        found = true;
                        if (
                            !palettesEqual(
                                observation.palette,
                                mutation.replacementPalette,
                            )
                        ) {
                            throw new Error(
                                `Verification failed for block at ${formatLocation(mutation.location)}.`,
                            );
                        }
                        if (
                            mutation.blockEntityPolicy === "remove" &&
                            observation.blockEntity
                        ) {
                            throw new Error(
                                `Verification found a removed block entity at ${formatLocation(mutation.location)}.`,
                            );
                        }
                    } else if (observation.layer === 0) {
                        found = true;
                        if (observation.blockEntity) {
                            throw new Error(
                                `Verification found block entity ${observation.blockEntity.id} at ${formatLocation(mutation.location)}.`,
                            );
                        }
                    }
                }
                if (!found) {
                    throw new Error(
                        `Verification could not observe ${formatLocation(mutation.location)}.`,
                    );
                }
            }
        },
    );
}

function mutableLayer(layer: DecodedBedrockSubchunkLayer): MutableLayer {
    return {
        storageHeader: layer.storageHeader,
        bitsPerBlock: layer.bitsPerBlock,
        palette: [...layer.palette],
        paletteEntryBytes: layer.paletteEntryBytes.map((entry) =>
            Buffer.from(entry),
        ),
        indices: new Uint16Array(layer.indices),
        rawBytes: Buffer.from(layer.rawBytes),
        modified: false,
    };
}

function serializeSubchunk(subchunk: MutableSubchunk): Buffer {
    const header = Buffer.alloc(3);
    header.writeUInt8(9, 0);
    header.writeUInt8(subchunk.layers.length, 1);
    header.writeInt8(subchunk.subChunkY, 2);
    return Buffer.concat([
        header,
        ...subchunk.layers.map((layer) =>
            layer.modified ? serializeLayer(layer) : layer.rawBytes,
        ),
    ]);
}

function serializeLayer(layer: MutableLayer): Buffer {
    const blocksPerWord = Math.floor(32 / layer.bitsPerBlock);
    const wordCount = Math.ceil(4096 / blocksPerWord);
    const words = Buffer.alloc(wordCount * 4);
    for (let blockIndex = 0; blockIndex < 4096; blockIndex += 1) {
        const wordIndex = Math.floor(blockIndex / blocksPerWord);
        const shift = (blockIndex % blocksPerWord) * layer.bitsPerBlock;
        const current = words.readUInt32LE(wordIndex * 4);
        const paletteIndex = layer.indices[blockIndex] ?? 0;
        words.writeUInt32LE(
            (current | (paletteIndex << shift)) >>> 0,
            wordIndex * 4,
        );
    }
    const paletteSize = Buffer.alloc(4);
    paletteSize.writeInt32LE(layer.palette.length, 0);
    return Buffer.concat([
        Buffer.from([layer.storageHeader]),
        words,
        paletteSize,
        ...layer.paletteEntryBytes,
    ]);
}

function writePaletteEntry(entry: WorldBlockPaletteEntry): Buffer {
    const states = Object.fromEntries(
        Object.entries(entry.states)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, value]) => [
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

function requiredBitsPerBlock(paletteSize: number): number {
    const minimum = Math.max(1, Math.ceil(Math.log2(paletteSize)));
    const supported = SUPPORTED_BITS_PER_BLOCK.find((bits) => bits >= minimum);
    if (!supported) {
        throw new Error(
            `World mutation palette size ${paletteSize} exceeds the supported 8-bit storage.`,
        );
    }
    return supported;
}

function indexBlockEntities(
    entities: readonly BlockEntityCompound[],
    chunk: ChunkCoordinate,
): Map<string, number> {
    const result = new Map<string, number>();
    entities.forEach((entity, index) => {
        const location = blockEntityLocation(entity);
        const key = locationMapKey(location);
        if (result.has(key)) {
            throw new Error(
                `Chunk ${chunk.dimension} ${chunk.chunkX},${chunk.chunkZ} contains duplicate block entities at ${key}.`,
            );
        }
        result.set(key, index);
    });
    return result;
}

function blockEntityId(entity: BlockEntityCompound): string {
    return nbtPrimitive(entity.id, "block entity id", "string") as string;
}

function blockEntityLocation(entity: BlockEntityCompound): WorldBlockLocation {
    return {
        x: nbtPrimitive(entity.x, "block entity x", "number") as number,
        y: nbtPrimitive(entity.y, "block entity y", "number") as number,
        z: nbtPrimitive(entity.z, "block entity z", "number") as number,
    };
}

function nbtPrimitive(
    input: unknown,
    source: string,
    expectedType: "string" | "number",
): string | number {
    if (
        !input ||
        typeof input !== "object" ||
        !("value" in input) ||
        typeof (input as { value?: unknown }).value !== expectedType
    ) {
        throw new Error(`${source} is invalid.`);
    }
    return (input as { value: string | number }).value;
}

function freezePalette(
    palette: WorldBlockPaletteEntry,
): WorldBlockPaletteEntry {
    return Object.freeze({
        typeId: palette.typeId,
        states: Object.freeze({ ...palette.states }),
        version: palette.version,
    });
}

function paletteIndex(
    palette: readonly WorldBlockPaletteEntry[],
    target: WorldBlockPaletteEntry,
): number {
    return palette.findIndex((candidate) => palettesEqual(candidate, target));
}

function palettesEqual(
    left: WorldBlockPaletteEntry,
    right: WorldBlockPaletteEntry,
): boolean {
    return canonicalJson(left) === canonicalJson(right);
}

type BlockCoordinates = {
    readonly chunkX: number;
    readonly chunkZ: number;
    readonly subChunkY: number;
    readonly localX: number;
    readonly localZ: number;
    readonly blockIndex: number;
};

function blockCoordinates(location: WorldBlockLocation): BlockCoordinates {
    const chunkX = Math.floor(location.x / 16);
    const chunkZ = Math.floor(location.z / 16);
    const subChunkY = Math.floor(location.y / 16);
    const localX = floorMod(location.x, 16);
    const localY = floorMod(location.y, 16);
    const localZ = floorMod(location.z, 16);
    return {
        chunkX,
        chunkZ,
        subChunkY,
        localX,
        localZ,
        blockIndex: (localX << 8) | (localZ << 4) | localY,
    };
}

function floorMod(value: number, divisor: number): number {
    return ((value % divisor) + divisor) % divisor;
}

function subchunkMapKey(
    dimension: WorldDimensionId,
    chunkX: number,
    chunkZ: number,
    subChunkY: number,
): string {
    return `${dimension}:${chunkX}:${chunkZ}:${subChunkY}`;
}

function chunkMapKey(
    dimension: WorldDimensionId,
    chunkX: number,
    chunkZ: number,
): string {
    return `${dimension}:${chunkX}:${chunkZ}`;
}

function parseChunkMapKey(key: string): {
    readonly dimension: WorldDimensionId;
    readonly x: number;
    readonly z: number;
    readonly chunkX: number;
    readonly chunkZ: number;
} {
    const [dimension, xText, zText] = key.split(":");
    const x = Number(xText);
    const z = Number(zText);
    if (
        (dimension !== "overworld" &&
            dimension !== "nether" &&
            dimension !== "the_end") ||
        !Number.isInteger(x) ||
        !Number.isInteger(z)
    ) {
        throw new Error(`Invalid chunk key ${key}.`);
    }
    return { dimension, x, z, chunkX: x, chunkZ: z };
}

function locationMapKey(location: WorldBlockLocation): string {
    return `${location.x}:${location.y}:${location.z}`;
}

function formatLocation(location: WorldBlockLocation): string {
    return `${location.x},${location.y},${location.z}`;
}

function rawKeyId(key: Buffer | string): string {
    return Buffer.isBuffer(key)
        ? key.toString("hex")
        : Buffer.from(key).toString("hex");
}

function setOperation(
    operations: Map<string, RawOperation>,
    operation: RawOperation,
): void {
    const id = rawKeyId(operation.key);
    if (operations.has(id)) {
        throw new Error(`World writer produced duplicate raw key ${id}.`);
    }
    operations.set(id, operation);
}

type EntryDigest = {
    readonly count: number;
    readonly hash: string;
};

async function digestUntouchedEntries(
    db: LevelDB,
    touchedKeys: ReadonlySet<string>,
): Promise<EntryDigest> {
    const hash = createHash("sha256");
    let count = 0;
    const iterator = db.getIterator({
        keys: true,
        values: true,
        keyAsBuffer: true,
        valueAsBuffer: true,
    });
    for await (const pair of iterator) {
        const key = Buffer.from(pair[0] as Uint8Array);
        if (touchedKeys.has(rawKeyId(key))) continue;
        const value = Buffer.from(pair[1] as Uint8Array);
        const lengths = Buffer.alloc(8);
        lengths.writeUInt32LE(key.length, 0);
        lengths.writeUInt32LE(value.length, 4);
        hash.update(lengths).update(key).update(value);
        count += 1;
    }
    return Object.freeze({ count, hash: hash.digest("hex") });
}
