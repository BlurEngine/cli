import { LevelDB } from "@8crafter/leveldb-zlib";
import {
    loadMcbeLeveldbHelpers,
    type McbeLeveldbHelpers,
} from "../mcbe-leveldb-adapter.js";
import { normalizeChunkDimension } from "../world-image-dimension.js";
import type {
    WorldBlockBounds,
    WorldBlockEntityObservation,
    WorldBlockObservation,
    WorldDimensionId,
    WorldObservationFacade,
    WorldObservationQuery,
    WorldSignBlockEntityObservation,
    WorldSignObservation,
    WorldSignObservationQuery,
} from "../world-processing.js";
import { decodeBedrockBlockEntities } from "./bedrock-block-entities.js";
import { decodeSignOrientation } from "./bedrock-block-entities.js";
import {
    decodeBedrockSubchunk,
    type DecodedBedrockSubchunk,
} from "./bedrock-subchunk.js";

export const DEFAULT_WORLD_OBSERVATION_LIMITS = Object.freeze({
    maxPositionsPerQuery: 1_048_576,
    maxPositionsPerRun: 16_777_216,
    maxSignsPerQuery: 100_000,
    maxSignsPerRun: 1_000_000,
});

export type WorldObservationLimits = {
    readonly maxPositionsPerQuery: number;
    readonly maxPositionsPerRun: number;
    readonly maxSignsPerQuery: number;
    readonly maxSignsPerRun: number;
};

export type BedrockWorldObservationOptions = {
    readonly dbPath: string;
    readonly limits?: Partial<WorldObservationLimits>;
    readonly signal?: AbortSignal;
};

export async function withBedrockWorldObservations<T>(
    options: BedrockWorldObservationOptions,
    operation: (observations: WorldObservationFacade) => Promise<T>,
): Promise<T> {
    const helpers = await loadMcbeLeveldbHelpers();
    const db = new LevelDB(options.dbPath, {
        createIfMissing: false,
        bufferKeys: true,
    });
    await db.open();
    try {
        const observations = new BedrockWorldObservationFacade(
            db,
            helpers,
            normalizeLimits(options.limits),
            options.signal,
        );
        return await operation(observations);
    } finally {
        await db.close();
    }
}

class BedrockWorldObservationFacade implements WorldObservationFacade {
    readonly #subchunks = new Map<
        string,
        Promise<DecodedBedrockSubchunk | undefined>
    >();
    readonly #blockEntities = new Map<
        string,
        Promise<ReadonlyMap<string, WorldBlockEntityObservation>>
    >();
    #allSigns: Promise<readonly WorldSignObservation[]> | undefined;
    #positionsRead = 0;
    #signsRead = 0;

    constructor(
        private readonly db: LevelDB,
        private readonly helpers: McbeLeveldbHelpers,
        private readonly limits: WorldObservationLimits,
        private readonly signal?: AbortSignal,
    ) {}

    async *blocks(
        query: WorldObservationQuery,
    ): AsyncIterable<WorldBlockObservation> {
        throwIfAborted(this.signal);
        validateBounds(query.bounds);
        const positionCount = countPositions(query.bounds);
        if (positionCount > this.limits.maxPositionsPerQuery) {
            throw new Error(
                `World observation query covers ${positionCount} positions, but the per-query limit is ${this.limits.maxPositionsPerQuery}.`,
            );
        }
        const nextTotal = this.#positionsRead + positionCount;
        if (nextTotal > this.limits.maxPositionsPerRun) {
            throw new Error(
                `World observation run would cover ${nextTotal} positions, but the run limit is ${this.limits.maxPositionsPerRun}.`,
            );
        }
        this.#positionsRead = nextTotal;

        const typeIds = query.typeIds ? new Set(query.typeIds) : undefined;
        for (
            let worldX = query.bounds.min.x;
            worldX <= query.bounds.max.x;
            worldX += 1
        ) {
            const chunkX = floorDiv(worldX, 16);
            const localX = floorMod(worldX, 16);
            for (
                let worldY = query.bounds.min.y;
                worldY <= query.bounds.max.y;
                worldY += 1
            ) {
                const subChunkY = floorDiv(worldY, 16);
                const localY = floorMod(worldY, 16);
                for (
                    let worldZ = query.bounds.min.z;
                    worldZ <= query.bounds.max.z;
                    worldZ += 1
                ) {
                    throwIfAborted(this.signal);
                    const chunkZ = floorDiv(worldZ, 16);
                    const localZ = floorMod(worldZ, 16);
                    const subchunk = await this.#readSubchunk(
                        query.dimension,
                        chunkX,
                        chunkZ,
                        subChunkY,
                    );
                    if (!subchunk) continue;
                    const blockIndex = (localX << 8) | (localZ << 4) | localY;
                    const blockEntity = await this.#readBlockEntity(
                        query.dimension,
                        chunkX,
                        chunkZ,
                        worldX,
                        worldY,
                        worldZ,
                    );
                    for (
                        let layerIndex = 0;
                        layerIndex < subchunk.layers.length;
                        layerIndex += 1
                    ) {
                        const layer = subchunk.layers[layerIndex]!;
                        const paletteIndex = layer.indices[blockIndex] ?? 0;
                        const palette = layer.palette[paletteIndex];
                        if (!palette) continue;
                        if (
                            !query.includeAir &&
                            palette.typeId === "minecraft:air"
                        ) {
                            continue;
                        }
                        if (typeIds && !typeIds.has(palette.typeId)) continue;
                        const location = Object.freeze({
                            x: worldX,
                            y: worldY,
                            z: worldZ,
                        });
                        const signOrientation = decodeSignOrientation(palette);
                        yield Object.freeze({
                            dimension: query.dimension,
                            location,
                            layer: layerIndex,
                            palette,
                            ...(layerIndex === 0 && blockEntity
                                ? { blockEntity }
                                : {}),
                            ...(signOrientation ? { signOrientation } : {}),
                        });
                    }
                }
            }
        }
    }

    async *signs(
        query: WorldSignObservationQuery = {},
    ): AsyncIterable<WorldSignObservation> {
        throwIfAborted(this.signal);
        if (query.bounds) validateBounds(query.bounds);
        this.#allSigns ??= this.#loadAllSigns();
        const signs = (await this.#allSigns).filter(
            (sign) =>
                (query.dimension === undefined ||
                    sign.dimension === query.dimension) &&
                (query.bounds === undefined ||
                    containsLocation(query.bounds, sign.location)),
        );
        if (signs.length > this.limits.maxSignsPerQuery) {
            throw new Error(
                `World sign query found ${signs.length} signs, but the per-query limit is ${this.limits.maxSignsPerQuery}.`,
            );
        }
        const nextTotal = this.#signsRead + signs.length;
        if (nextTotal > this.limits.maxSignsPerRun) {
            throw new Error(
                `World sign run would return ${nextTotal} signs, but the run limit is ${this.limits.maxSignsPerRun}.`,
            );
        }
        this.#signsRead = nextTotal;
        for (const sign of signs) {
            throwIfAborted(this.signal);
            yield sign;
        }
    }

    async #loadAllSigns(): Promise<readonly WorldSignObservation[]> {
        const pending: Array<{
            readonly dimension: WorldDimensionId;
            readonly entity: WorldSignBlockEntityObservation;
        }> = [];
        const seen = new Set<string>();
        for await (const [rawKey, rawValue] of this.db.getIterator({
            keys: true,
            values: true,
            keyAsBuffer: true,
            valueAsBuffer: true,
        })) {
            throwIfAborted(this.signal);
            if (!Buffer.isBuffer(rawKey) || !rawValue) continue;
            if (
                this.helpers.getContentTypeFromDBKey(rawKey) !== "BlockEntity"
            ) {
                continue;
            }
            const indices = this.helpers.getChunkKeyIndices(rawKey);
            const dimension = normalizeChunkDimension(indices.dimension);
            if (!dimension) continue;
            const entities = await decodeBedrockBlockEntities(
                Buffer.isBuffer(rawValue) ? rawValue : Buffer.from(rawValue),
            );
            for (const entity of entities) {
                if (entity.id !== "Sign") continue;
                if (
                    floorDiv(entity.location.x, 16) !== indices.x ||
                    floorDiv(entity.location.z, 16) !== indices.z
                ) {
                    throw new Error(
                        `Sign block entity at ${formatLocation(entity.location)} is stored under the wrong ${dimension} chunk key ${indices.x},${indices.z}.`,
                    );
                }
                const identity = `${dimension}:${formatLocation(entity.location)}`;
                if (seen.has(identity)) {
                    throw new Error(
                        `World contains duplicate sign block entities at ${identity}.`,
                    );
                }
                seen.add(identity);
                pending.push({
                    dimension,
                    entity: Object.freeze({
                        ...entity,
                        id: "Sign",
                        signFaces: entity.signFaces ?? Object.freeze([]),
                    }),
                });
            }
        }

        const signs: WorldSignObservation[] = [];
        for (const entry of pending) {
            throwIfAborted(this.signal);
            signs.push(await this.#resolveSign(entry.dimension, entry.entity));
        }
        signs.sort(compareSigns);
        return Object.freeze(signs);
    }

    async #resolveSign(
        dimension: WorldDimensionId,
        blockEntity: WorldSignBlockEntityObservation,
    ): Promise<WorldSignObservation> {
        const { x, y, z } = blockEntity.location;
        const subchunk = await this.#readSubchunk(
            dimension,
            floorDiv(x, 16),
            floorDiv(z, 16),
            floorDiv(y, 16),
        );
        if (!subchunk) {
            throw new Error(
                `Sign block entity at ${dimension} ${formatLocation(blockEntity.location)} has no containing subchunk.`,
            );
        }
        const blockIndex =
            (floorMod(x, 16) << 8) | (floorMod(z, 16) << 4) | floorMod(y, 16);
        const layer = subchunk.layers[0];
        const palette = layer?.palette[layer.indices[blockIndex] ?? 0];
        if (!palette) {
            throw new Error(
                `Sign block entity at ${dimension} ${formatLocation(blockEntity.location)} has no layer-zero block.`,
            );
        }
        const signOrientation = decodeSignOrientation(palette);
        if (!signOrientation) {
            throw new Error(
                `Sign block entity at ${dimension} ${formatLocation(blockEntity.location)} belongs to non-sign block ${palette.typeId}.`,
            );
        }
        return Object.freeze({
            dimension,
            location: blockEntity.location,
            layer: 0,
            palette,
            blockEntity,
            signOrientation,
        });
    }

    async #readSubchunk(
        dimension: WorldDimensionId,
        chunkX: number,
        chunkZ: number,
        subChunkY: number,
    ): Promise<DecodedBedrockSubchunk | undefined> {
        const cacheKey = `${dimension}:${chunkX}:${chunkZ}:${subChunkY}`;
        let pending = this.#subchunks.get(cacheKey);
        if (!pending) {
            pending = this.#loadSubchunk(dimension, chunkX, chunkZ, subChunkY);
            this.#subchunks.set(cacheKey, pending);
        }
        return pending;
    }

    async #loadSubchunk(
        dimension: WorldDimensionId,
        chunkX: number,
        chunkZ: number,
        subChunkY: number,
    ): Promise<DecodedBedrockSubchunk | undefined> {
        const raw = await this.db.get(
            this.helpers.generateChunkKeyFromIndices(
                {
                    x: chunkX,
                    z: chunkZ,
                    dimension,
                    subChunkIndex: subChunkY,
                },
                "SubChunkPrefix",
            ),
        );
        if (!raw) return undefined;
        return decodeBedrockSubchunk(raw);
    }

    async #readBlockEntity(
        dimension: WorldDimensionId,
        chunkX: number,
        chunkZ: number,
        worldX: number,
        worldY: number,
        worldZ: number,
    ): Promise<WorldBlockEntityObservation | undefined> {
        const cacheKey = `${dimension}:${chunkX}:${chunkZ}`;
        let pending = this.#blockEntities.get(cacheKey);
        if (!pending) {
            pending = this.#loadBlockEntities(dimension, chunkX, chunkZ);
            this.#blockEntities.set(cacheKey, pending);
        }
        const entities = await pending;
        return entities.get(`${worldX}:${worldY}:${worldZ}`);
    }

    async #loadBlockEntities(
        dimension: WorldDimensionId,
        chunkX: number,
        chunkZ: number,
    ): Promise<ReadonlyMap<string, WorldBlockEntityObservation>> {
        const raw = await this.db.get(
            this.helpers.generateChunkKeyFromIndices(
                { x: chunkX, z: chunkZ, dimension },
                "BlockEntity",
            ),
        );
        if (!raw) return new Map();
        const result = new Map<string, WorldBlockEntityObservation>();
        for (const entity of await decodeBedrockBlockEntities(raw)) {
            const key = `${entity.location.x}:${entity.location.y}:${entity.location.z}`;
            if (result.has(key)) {
                throw new Error(
                    `Chunk ${dimension} ${chunkX},${chunkZ} contains duplicate block entities at ${key}.`,
                );
            }
            result.set(key, entity);
        }
        return result;
    }
}

function normalizeLimits(
    input?: Partial<WorldObservationLimits>,
): WorldObservationLimits {
    const limits = {
        maxPositionsPerQuery:
            input?.maxPositionsPerQuery ??
            DEFAULT_WORLD_OBSERVATION_LIMITS.maxPositionsPerQuery,
        maxPositionsPerRun:
            input?.maxPositionsPerRun ??
            DEFAULT_WORLD_OBSERVATION_LIMITS.maxPositionsPerRun,
        maxSignsPerQuery:
            input?.maxSignsPerQuery ??
            DEFAULT_WORLD_OBSERVATION_LIMITS.maxSignsPerQuery,
        maxSignsPerRun:
            input?.maxSignsPerRun ??
            DEFAULT_WORLD_OBSERVATION_LIMITS.maxSignsPerRun,
    };
    for (const [name, value] of Object.entries(limits)) {
        if (!Number.isSafeInteger(value) || value <= 0) {
            throw new Error(
                `World observation ${name} must be a positive integer.`,
            );
        }
    }
    return Object.freeze(limits);
}

function containsLocation(
    bounds: WorldBlockBounds,
    location: { readonly x: number; readonly y: number; readonly z: number },
): boolean {
    return (
        location.x >= bounds.min.x &&
        location.x <= bounds.max.x &&
        location.y >= bounds.min.y &&
        location.y <= bounds.max.y &&
        location.z >= bounds.min.z &&
        location.z <= bounds.max.z
    );
}

function compareSigns(
    left: WorldSignObservation,
    right: WorldSignObservation,
): number {
    const dimensionOrder = { overworld: 0, nether: 1, the_end: 2 } as const;
    return (
        dimensionOrder[left.dimension] - dimensionOrder[right.dimension] ||
        left.location.x - right.location.x ||
        left.location.y - right.location.y ||
        left.location.z - right.location.z
    );
}

function formatLocation(location: {
    readonly x: number;
    readonly y: number;
    readonly z: number;
}): string {
    return `${location.x},${location.y},${location.z}`;
}

function validateBounds(bounds: WorldBlockBounds): void {
    for (const axis of ["x", "y", "z"] as const) {
        const min = bounds.min[axis];
        const max = bounds.max[axis];
        if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max)) {
            throw new Error(
                `World observation ${axis} bounds must be integers.`,
            );
        }
        if (min > max) {
            throw new Error(
                `World observation ${axis} minimum must not exceed its maximum.`,
            );
        }
    }
}

function countPositions(bounds: WorldBlockBounds): number {
    const count =
        (bounds.max.x - bounds.min.x + 1) *
        (bounds.max.y - bounds.min.y + 1) *
        (bounds.max.z - bounds.min.z + 1);
    if (!Number.isSafeInteger(count)) {
        throw new Error("World observation bounds cover too many positions.");
    }
    return count;
}

export function floorDiv(value: number, divisor: number): number {
    return Math.floor(value / divisor);
}

function floorMod(value: number, divisor: number): number {
    return ((value % divisor) + divisor) % divisor;
}

function throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) {
        throw signal.reason instanceof Error
            ? signal.reason
            : new DOMException("World observation was aborted.", "AbortError");
    }
}
