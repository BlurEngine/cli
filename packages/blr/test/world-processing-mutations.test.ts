import assert from "node:assert/strict";
import test from "node:test";
import type {
    WorldBlockObservation,
    WorldBlockPaletteEntry,
    WorldMutation,
    WorldObservationFacade,
} from "../src/world-processing.js";
import { normalizeWorldMutationPlans } from "../src/world-processing/mutations.js";

const air = palette("minecraft:air");
const signPalette = palette(
    "minecraft:spruce_standing_sign",
    { ground_sign_direction: 12 },
    18_488_832,
);
const barrier = palette("minecraft:barrier", {}, 18_488_832);

test("normalizeWorldMutationPlans resolves observed palettes and emits canonical primitive block writes", async () => {
    const observations = facade([
        block({ x: 0, y: 80, z: 0 }, 0, signPalette),
        block({ x: 1, y: 80, z: 0 }, 0, air),
    ]);
    const mutations: WorldMutation[] = [
        {
            kind: "set-block",
            opId: "replace-sign",
            dimension: "overworld",
            location: { x: 0, y: 80, z: 0 },
            layer: 0,
            expectedPalette: signPalette,
            replacement: {
                kind: "observed",
                dimension: "overworld",
                location: { x: 1, y: 80, z: 0 },
                layer: 0,
            },
            blockEntityPolicy: "remove",
        },
    ];

    const result = await normalizeWorldMutationPlans(
        [{ processorId: "locations", mutations }],
        observations,
    );
    assert.deepEqual(result, [
        {
            kind: "block-write",
            dimension: "overworld",
            location: { x: 0, y: 80, z: 0 },
            layer: 0,
            expectedPalette: signPalette,
            replacementPalette: air,
            blockEntityPolicy: "remove",
            claims: [{ processorId: "locations", opId: "replace-sign" }],
        },
    ]);
});

test("consume-sign expands to an atomic layer-zero write and block-entity removal while leaving fluid layers unclaimed", async () => {
    const sign = block({ x: -1, y: 80, z: 1 }, 0, signPalette, {
        id: "Sign",
        signFaces: [],
    });
    const water = block(
        { x: -1, y: 80, z: 1 },
        1,
        palette("minecraft:water", { liquid_depth: 0 }),
    );
    const sourceAir = block({ x: 0, y: 80, z: 1 }, 0, air);
    const result = await normalizeWorldMutationPlans(
        [
            {
                processorId: "locations",
                mutations: [
                    {
                        kind: "consume-sign",
                        opId: "consume-lamp-marker",
                        dimension: "overworld",
                        location: { x: -1, y: 80, z: 1 },
                        expectedPalette: signPalette,
                        expectedBlockEntityId: "Sign",
                        replacement: {
                            kind: "observed",
                            dimension: "overworld",
                            location: sourceAir.location,
                            layer: 0,
                        },
                        otherLayerPolicy: "preserve",
                    },
                ],
            },
        ],
        facade([sign, water, sourceAir]),
    );
    assert.equal(result.length, 2);
    assert.deepEqual(
        result.map((entry) => [entry.kind, entry.layer ?? null]),
        [
            ["block-write", 0],
            ["block-entity-remove", null],
        ],
    );
    assert.equal(
        result.some(
            (entry) => entry.kind === "block-write" && entry.layer === 1,
        ),
        false,
    );
});

test("bounded replacement expands only exact matches in canonical coordinate order", async () => {
    const stone = palette("minecraft:stone", {}, 18_488_832);
    const observations = facade([
        block({ x: 1, y: 2, z: 1 }, 0, stone),
        block({ x: -1, y: 2, z: 1 }, 0, stone),
        block({ x: 0, y: 2, z: 1 }, 0, barrier),
    ]);
    const result = await normalizeWorldMutationPlans(
        [
            {
                processorId: "decor",
                mutations: [
                    {
                        kind: "replace-blocks",
                        opId: "stone-to-barrier",
                        dimension: "overworld",
                        bounds: {
                            min: { x: -1, y: 2, z: 1 },
                            max: { x: 1, y: 2, z: 1 },
                        },
                        layer: 0,
                        matchPalette: stone,
                        replacement: { kind: "literal", palette: barrier },
                        blockEntityPolicy: "require-absent",
                    },
                ],
            },
        ],
        observations,
    );
    assert.deepEqual(
        result.map((entry) => entry.location.x),
        [-1, 1],
    );
});

test("normalization fails closed on stale expectations, absent subchunks, duplicate op ids, and conflicting claims", async () => {
    const target = block({ x: 0, y: 0, z: 0 }, 0, air);
    const stale: WorldMutation = {
        kind: "set-block",
        opId: "stale",
        dimension: "overworld",
        location: target.location,
        layer: 0,
        expectedPalette: barrier,
        replacement: { kind: "literal", palette: air },
        blockEntityPolicy: "require-absent",
    };
    await assert.rejects(
        () =>
            normalizeWorldMutationPlans(
                [{ processorId: "one", mutations: [stale] }],
                facade([target]),
            ),
        /expected palette.*does not match/i,
    );
    await assert.rejects(
        () =>
            normalizeWorldMutationPlans(
                [
                    {
                        processorId: "one",
                        mutations: [
                            {
                                ...stale,
                                expectedPalette: air,
                                location: { x: 20, y: 0, z: 20 },
                            },
                        ],
                    },
                ],
                facade([target]),
            ),
        /existing subchunk.*20,0,20/i,
    );
    await assert.rejects(
        () =>
            normalizeWorldMutationPlans(
                [
                    {
                        processorId: "one",
                        mutations: [
                            { ...stale, expectedPalette: air },
                            { ...stale, expectedPalette: air },
                        ],
                    },
                ],
                facade([target]),
            ),
        /duplicate opId stale/i,
    );

    const one: WorldMutation = {
        ...stale,
        expectedPalette: air,
        replacement: { kind: "literal", palette: barrier },
    };
    const two: WorldMutation = {
        ...one,
        opId: "other",
        replacement: {
            kind: "literal",
            palette: palette("minecraft:gold_block", {}, 18_488_832),
        },
    };
    await assert.rejects(
        () =>
            normalizeWorldMutationPlans(
                [
                    { processorId: "one", mutations: [one] },
                    { processorId: "two", mutations: [two] },
                ],
                facade([target]),
            ),
        /conflicting block claims.*overworld.*0,0,0.*layer 0/i,
    );
});

test("byte-identical claims coalesce and retain every claimant", async () => {
    const target = block({ x: 0, y: 0, z: 0 }, 0, air);
    const mutation: WorldMutation = {
        kind: "set-block",
        opId: "place",
        dimension: "overworld",
        location: target.location,
        layer: 0,
        expectedPalette: air,
        replacement: { kind: "literal", palette: barrier },
        blockEntityPolicy: "require-absent",
    };
    const result = await normalizeWorldMutationPlans(
        [
            { processorId: "a", mutations: [mutation] },
            {
                processorId: "b",
                mutations: [{ ...mutation, opId: "also-place" }],
            },
        ],
        facade([target]),
    );
    assert.equal(result.length, 1);
    assert.deepEqual(result[0]?.claims, [
        { processorId: "a", opId: "place" },
        { processorId: "b", opId: "also-place" },
    ]);
});

function palette(
    typeId: string,
    states: Record<string, boolean | number | string> = {},
    version = 0,
): WorldBlockPaletteEntry {
    return { typeId, states, version };
}

function block(
    location: { x: number; y: number; z: number },
    layer: number,
    blockPalette: WorldBlockPaletteEntry,
    blockEntity?: { id: string; signFaces?: readonly [] },
): WorldBlockObservation {
    return {
        dimension: "overworld",
        location,
        layer,
        palette: blockPalette,
        ...(blockEntity
            ? {
                  blockEntity: {
                      id: blockEntity.id,
                      location,
                      value: {},
                      ...(blockEntity.signFaces
                          ? { signFaces: blockEntity.signFaces }
                          : {}),
                  },
              }
            : {}),
    };
}

function facade(
    entries: readonly WorldBlockObservation[],
): WorldObservationFacade {
    return {
        async *blocks(query) {
            for (const entry of entries) {
                if (entry.dimension !== query.dimension) continue;
                if (
                    entry.location.x < query.bounds.min.x ||
                    entry.location.x > query.bounds.max.x ||
                    entry.location.y < query.bounds.min.y ||
                    entry.location.y > query.bounds.max.y ||
                    entry.location.z < query.bounds.min.z ||
                    entry.location.z > query.bounds.max.z
                ) {
                    continue;
                }
                if (
                    query.typeIds &&
                    !query.typeIds.includes(entry.palette.typeId)
                ) {
                    continue;
                }
                if (
                    !query.includeAir &&
                    entry.palette.typeId === "minecraft:air"
                ) {
                    continue;
                }
                yield entry;
            }
        },
        async *signs() {},
    };
}
