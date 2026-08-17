import type {
    WorldBlockEntityPolicy,
    WorldBlockLocation,
    WorldBlockObservation,
    WorldBlockPaletteEntry,
    WorldDimensionId,
    WorldMutation,
    WorldObservationFacade,
    WorldPaletteReplacement,
} from "../world-processing.js";
import { canonicalJson } from "./canonical-json.js";

export type WorldMutationClaim = {
    readonly processorId: string;
    readonly opId: string;
};

export type PrimitiveWorldBlockWrite = {
    readonly kind: "block-write";
    readonly dimension: WorldDimensionId;
    readonly location: WorldBlockLocation;
    readonly layer: number;
    readonly expectedPalette: WorldBlockPaletteEntry;
    readonly replacementPalette: WorldBlockPaletteEntry;
    readonly blockEntityPolicy: WorldBlockEntityPolicy;
    readonly claims: readonly WorldMutationClaim[];
};

export type PrimitiveWorldBlockEntityRemoval = {
    readonly kind: "block-entity-remove";
    readonly dimension: WorldDimensionId;
    readonly location: WorldBlockLocation;
    readonly layer?: undefined;
    readonly expectedId: string;
    readonly claims: readonly WorldMutationClaim[];
};

export type PrimitiveWorldMutation =
    | PrimitiveWorldBlockWrite
    | PrimitiveWorldBlockEntityRemoval;

export type WorldProcessorMutationPlan = {
    readonly processorId: string;
    readonly mutations: readonly WorldMutation[];
};

export async function normalizeWorldMutationPlans(
    plans: readonly WorldProcessorMutationPlan[],
    observations: WorldObservationFacade,
): Promise<readonly PrimitiveWorldMutation[]> {
    const claims = new Map<string, PrimitiveWorldMutation>();
    const opIds = new Set<string>();

    for (const plan of [...plans].sort((left, right) =>
        left.processorId.localeCompare(right.processorId),
    )) {
        assertNonEmpty(plan.processorId, "processorId");
        for (const mutation of plan.mutations) {
            const claim = freezeClaim(plan.processorId, mutation.opId);
            const opKey = `${plan.processorId}:${mutation.opId}`;
            if (opIds.has(opKey)) {
                throw new Error(
                    `World processor ${plan.processorId} has duplicate opId ${mutation.opId}.`,
                );
            }
            opIds.add(opKey);
            switch (mutation.kind) {
                case "set-block": {
                    const current = await requireObservation(
                        observations,
                        mutation.dimension,
                        mutation.location,
                        mutation.layer,
                    );
                    const expectedPalette = normalizePalette(
                        mutation.expectedPalette,
                    );
                    assertPaletteMatches(
                        current.palette,
                        expectedPalette,
                        mutation.location,
                    );
                    assertBlockEntityPolicy(
                        current,
                        mutation.blockEntityPolicy,
                        mutation.location,
                    );
                    const replacementPalette = await resolveReplacement(
                        observations,
                        mutation.replacement,
                    );
                    addClaim(
                        claims,
                        freezeBlockWrite({
                            dimension: mutation.dimension,
                            location: mutation.location,
                            layer: mutation.layer,
                            expectedPalette,
                            replacementPalette,
                            blockEntityPolicy: mutation.blockEntityPolicy,
                            claim,
                        }),
                    );
                    break;
                }
                case "remove-block-entity": {
                    const current = await requireObservation(
                        observations,
                        mutation.dimension,
                        mutation.location,
                        0,
                    );
                    if (current.blockEntity?.id !== mutation.expectedId) {
                        throw new Error(
                            `Expected block entity ${mutation.expectedId} at ${formatLocation(
                                mutation.location,
                            )}, found ${current.blockEntity?.id ?? "none"}.`,
                        );
                    }
                    addClaim(
                        claims,
                        freezeBlockEntityRemoval({
                            dimension: mutation.dimension,
                            location: mutation.location,
                            expectedId: mutation.expectedId,
                            claim,
                        }),
                    );
                    break;
                }
                case "consume-sign": {
                    const current = await requireObservation(
                        observations,
                        mutation.dimension,
                        mutation.location,
                        0,
                    );
                    const expectedPalette = normalizePalette(
                        mutation.expectedPalette,
                    );
                    assertPaletteMatches(
                        current.palette,
                        expectedPalette,
                        mutation.location,
                    );
                    if (
                        current.blockEntity?.id !==
                        mutation.expectedBlockEntityId
                    ) {
                        throw new Error(
                            `Expected block entity ${mutation.expectedBlockEntityId} at ${formatLocation(
                                mutation.location,
                            )}, found ${current.blockEntity?.id ?? "none"}.`,
                        );
                    }
                    if (mutation.otherLayerPolicy !== "preserve") {
                        throw new Error(
                            `consume-sign ${mutation.opId} must preserve other storage layers.`,
                        );
                    }
                    const replacementPalette = await resolveReplacement(
                        observations,
                        mutation.replacement,
                    );
                    addClaim(
                        claims,
                        freezeBlockWrite({
                            dimension: mutation.dimension,
                            location: mutation.location,
                            layer: 0,
                            expectedPalette,
                            replacementPalette,
                            blockEntityPolicy: "remove",
                            claim,
                        }),
                    );
                    addClaim(
                        claims,
                        freezeBlockEntityRemoval({
                            dimension: mutation.dimension,
                            location: mutation.location,
                            expectedId: mutation.expectedBlockEntityId,
                            claim,
                        }),
                    );
                    break;
                }
                case "replace-blocks": {
                    validateBounds(mutation.bounds);
                    const expectedPalette = normalizePalette(
                        mutation.matchPalette,
                    );
                    const replacementPalette = await resolveReplacement(
                        observations,
                        mutation.replacement,
                    );
                    for await (const current of observations.blocks({
                        dimension: mutation.dimension,
                        bounds: mutation.bounds,
                        includeAir: true,
                    })) {
                        if (
                            current.layer !== mutation.layer ||
                            !palettesEqual(current.palette, expectedPalette)
                        ) {
                            continue;
                        }
                        assertBlockEntityPolicy(
                            current,
                            mutation.blockEntityPolicy,
                            current.location,
                        );
                        addClaim(
                            claims,
                            freezeBlockWrite({
                                dimension: mutation.dimension,
                                location: current.location,
                                layer: mutation.layer,
                                expectedPalette,
                                replacementPalette,
                                blockEntityPolicy: mutation.blockEntityPolicy,
                                claim,
                            }),
                        );
                    }
                    break;
                }
            }
        }
    }
    return Object.freeze([...claims.values()].sort(comparePrimitiveMutations));
}

async function resolveReplacement(
    observations: WorldObservationFacade,
    replacement: WorldPaletteReplacement,
): Promise<WorldBlockPaletteEntry> {
    if (replacement.kind === "literal") {
        return normalizePalette(replacement.palette);
    }
    return normalizePalette(
        (
            await requireObservation(
                observations,
                replacement.dimension,
                replacement.location,
                replacement.layer,
            )
        ).palette,
    );
}

async function requireObservation(
    observations: WorldObservationFacade,
    dimension: WorldDimensionId,
    location: WorldBlockLocation,
    layer: number,
): Promise<WorldBlockObservation> {
    validateLocation(location);
    if (!Number.isSafeInteger(layer) || layer < 0) {
        throw new Error(`World storage layer must be a non-negative integer.`);
    }
    const matches: WorldBlockObservation[] = [];
    for await (const observation of observations.blocks({
        dimension,
        bounds: { min: location, max: location },
        includeAir: true,
    })) {
        if (observation.layer === layer) matches.push(observation);
    }
    if (matches.length === 0) {
        throw new Error(
            `World mutation requires an existing subchunk at ${formatLocation(
                location,
            )} layer ${layer}.`,
        );
    }
    if (matches.length > 1) {
        throw new Error(
            `World observation returned duplicate blocks at ${formatLocation(
                location,
            )} layer ${layer}.`,
        );
    }
    return matches[0]!;
}

function addClaim(
    claims: Map<string, PrimitiveWorldMutation>,
    candidate: PrimitiveWorldMutation,
): void {
    const key = mutationKey(candidate);
    const existing = claims.get(key);
    if (!existing) {
        claims.set(key, candidate);
        return;
    }
    const existingShape = withoutClaims(existing);
    const candidateShape = withoutClaims(candidate);
    if (canonicalJson(existingShape) !== canonicalJson(candidateShape)) {
        const noun =
            candidate.kind === "block-write" ? "block" : "block-entity";
        throw new Error(
            `Conflicting ${noun} claims at ${candidate.dimension} ${formatLocation(
                candidate.location,
            )}${candidate.kind === "block-write" ? ` layer ${candidate.layer}` : ""}.`,
        );
    }
    const mergedClaims = [...existing.claims, ...candidate.claims].sort(
        compareClaims,
    );
    claims.set(
        key,
        Object.freeze({ ...existing, claims: Object.freeze(mergedClaims) }),
    );
}

function freezeBlockWrite(input: {
    dimension: WorldDimensionId;
    location: WorldBlockLocation;
    layer: number;
    expectedPalette: WorldBlockPaletteEntry;
    replacementPalette: WorldBlockPaletteEntry;
    blockEntityPolicy: WorldBlockEntityPolicy;
    claim: WorldMutationClaim;
}): PrimitiveWorldBlockWrite {
    validateLocation(input.location);
    return Object.freeze({
        kind: "block-write",
        dimension: input.dimension,
        location: freezeLocation(input.location),
        layer: input.layer,
        expectedPalette: input.expectedPalette,
        replacementPalette: input.replacementPalette,
        blockEntityPolicy: input.blockEntityPolicy,
        claims: Object.freeze([input.claim]),
    });
}

function freezeBlockEntityRemoval(input: {
    dimension: WorldDimensionId;
    location: WorldBlockLocation;
    expectedId: string;
    claim: WorldMutationClaim;
}): PrimitiveWorldBlockEntityRemoval {
    validateLocation(input.location);
    assertNonEmpty(input.expectedId, "expectedId");
    return Object.freeze({
        kind: "block-entity-remove",
        dimension: input.dimension,
        location: freezeLocation(input.location),
        expectedId: input.expectedId,
        claims: Object.freeze([input.claim]),
    });
}

function normalizePalette(
    input: WorldBlockPaletteEntry,
): WorldBlockPaletteEntry {
    assertNonEmpty(input.typeId, "palette.typeId");
    if (!Number.isSafeInteger(input.version) || input.version < 0) {
        throw new Error(`palette.version must be a non-negative integer.`);
    }
    const states: Record<string, boolean | number | string> = {};
    for (const key of Object.keys(input.states).sort()) {
        const value = input.states[key];
        if (
            typeof value !== "string" &&
            typeof value !== "boolean" &&
            (typeof value !== "number" || !Number.isFinite(value))
        ) {
            throw new Error(`palette state ${key} is not a finite primitive.`);
        }
        states[key] = Object.is(value, -0) ? 0 : value;
    }
    return Object.freeze({
        typeId: input.typeId,
        states: Object.freeze(states),
        version: input.version,
    });
}

function assertPaletteMatches(
    actual: WorldBlockPaletteEntry,
    expected: WorldBlockPaletteEntry,
    location: WorldBlockLocation,
): void {
    if (!palettesEqual(actual, expected)) {
        throw new Error(
            `World mutation expected palette ${expected.typeId} at ${formatLocation(
                location,
            )}, but the observation does not match.`,
        );
    }
}

function palettesEqual(
    left: WorldBlockPaletteEntry,
    right: WorldBlockPaletteEntry,
): boolean {
    return canonicalJson(left) === canonicalJson(right);
}

function assertBlockEntityPolicy(
    observation: WorldBlockObservation,
    policy: WorldBlockEntityPolicy,
    location: WorldBlockLocation,
): void {
    if (policy === "require-absent" && observation.blockEntity) {
        throw new Error(
            `World mutation requires no block entity at ${formatLocation(
                location,
            )}, found ${observation.blockEntity.id}.`,
        );
    }
}

function mutationKey(mutation: PrimitiveWorldMutation): string {
    return `${mutation.kind}:${mutation.dimension}:${mutation.location.x}:${
        mutation.location.y
    }:${mutation.location.z}:${mutation.kind === "block-write" ? mutation.layer : "entity"}`;
}

function withoutClaims(
    mutation: PrimitiveWorldMutation,
): Omit<PrimitiveWorldMutation, "claims"> {
    const { claims: _claims, ...rest } = mutation;
    return rest;
}

function comparePrimitiveMutations(
    left: PrimitiveWorldMutation,
    right: PrimitiveWorldMutation,
): number {
    const dimensionOrder = { overworld: 0, nether: 1, the_end: 2 } as const;
    return (
        dimensionOrder[left.dimension] - dimensionOrder[right.dimension] ||
        Math.floor(left.location.x / 16) - Math.floor(right.location.x / 16) ||
        Math.floor(left.location.z / 16) - Math.floor(right.location.z / 16) ||
        Math.floor(left.location.y / 16) - Math.floor(right.location.y / 16) ||
        (left.kind === "block-write" ? 0 : 1) -
            (right.kind === "block-write" ? 0 : 1) ||
        (left.kind === "block-write" ? left.layer : -1) -
            (right.kind === "block-write" ? right.layer : -1) ||
        (((left.location.x % 16) + 16) % 16) -
            (((right.location.x % 16) + 16) % 16) ||
        (((left.location.z % 16) + 16) % 16) -
            (((right.location.z % 16) + 16) % 16) ||
        (((left.location.y % 16) + 16) % 16) -
            (((right.location.y % 16) + 16) % 16) ||
        left.kind.localeCompare(right.kind)
    );
}

function compareClaims(
    left: WorldMutationClaim,
    right: WorldMutationClaim,
): number {
    return (
        left.processorId.localeCompare(right.processorId) ||
        left.opId.localeCompare(right.opId)
    );
}

function freezeClaim(processorId: string, opId: string): WorldMutationClaim {
    assertNonEmpty(processorId, "processorId");
    assertNonEmpty(opId, "opId");
    return Object.freeze({ processorId, opId });
}

function freezeLocation(location: WorldBlockLocation): WorldBlockLocation {
    return Object.freeze({ x: location.x, y: location.y, z: location.z });
}

function validateLocation(location: WorldBlockLocation): void {
    for (const axis of ["x", "y", "z"] as const) {
        if (!Number.isSafeInteger(location[axis])) {
            throw new Error(
                `World mutation ${axis} coordinate must be an integer.`,
            );
        }
    }
}

function validateBounds(bounds: {
    min: WorldBlockLocation;
    max: WorldBlockLocation;
}): void {
    validateLocation(bounds.min);
    validateLocation(bounds.max);
    for (const axis of ["x", "y", "z"] as const) {
        if (bounds.min[axis] > bounds.max[axis]) {
            throw new Error(`World mutation bounds are inverted on ${axis}.`);
        }
    }
}

function formatLocation(location: WorldBlockLocation): string {
    return `${location.x},${location.y},${location.z}`;
}

function assertNonEmpty(value: string, source: string): void {
    if (typeof value !== "string" || value.length === 0) {
        throw new Error(`${source} must be a non-empty string.`);
    }
}
