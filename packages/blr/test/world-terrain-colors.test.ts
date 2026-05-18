import assert from "node:assert/strict";
import test from "node:test";
import {
    applyBiomeTint,
    resolveTerrainColor,
} from "../src/world-terrain-colors.js";

test("applyBiomeTint multiplies grass and foliage colors", () => {
    assert.deepEqual(
        applyBiomeTint([128, 128, 128], [64, 255, 128], "grass"),
        [32, 128, 64],
    );
    assert.deepEqual(
        applyBiomeTint([128, 128, 128], [64, 255, 128], "foliage"),
        [32, 128, 64],
    );
});

test("applyBiomeTint replaces water with biome water color", () => {
    assert.deepEqual(
        applyBiomeTint([32, 64, 128], [68, 175, 245], "water"),
        [68, 175, 245],
    );
});

test("resolveTerrainColor returns magenta fallback for unknown blocks", () => {
    const result = resolveTerrainColor({
        blockName: "minecraft:not_real",
        biomeName: "minecraft:plains",
    });

    assert.deepEqual(result.color, [255, 0, 255]);
    assert.equal(result.diagnostic, "unknown-block");
});

test("resolveTerrainColor returns fresh fallback arrays for unknown blocks", () => {
    const first = resolveTerrainColor({ blockName: "minecraft:not_real" });
    first.color[0] = 0;

    assert.deepEqual(
        resolveTerrainColor({ blockName: "minecraft:not_real" }).color,
        [255, 0, 255],
    );
});

test("resolveTerrainColor accepts unqualified vanilla block names", () => {
    assert.deepEqual(
        resolveTerrainColor({ blockName: "stone" }).color,
        [126, 126, 126],
    );
});

test("resolveTerrainColor normalizes Bedrock block aliases", () => {
    assert.notEqual(
        resolveTerrainColor({ blockName: "minecraft:grass_block" }).diagnostic,
        "unknown-block",
    );
    assert.notEqual(
        resolveTerrainColor({ blockName: "minecraft:iron_chain" }).diagnostic,
        "unknown-block",
    );
    assert.notEqual(
        resolveTerrainColor({ blockName: "minecraft:sea_lantern" }).diagnostic,
        "unknown-block",
    );
});

test("resolveTerrainColor applies biome tint for generated tint roles", () => {
    const plainsGrass = resolveTerrainColor({
        blockName: "minecraft:grass",
        biomeName: "minecraft:plains",
    });
    const unknownBiomeGrass = resolveTerrainColor({
        blockName: "minecraft:grass",
        biomeName: "minecraft:not_real",
    });

    assert.notDeepEqual(plainsGrass.color, [147, 147, 147]);
    assert.notDeepEqual(unknownBiomeGrass.color, [147, 147, 147]);
});

test("resolveTerrainColor tints modern oak leaves", () => {
    assert.deepEqual(resolveTerrainColor({ blockName: "minecraft:leaves" }), {
        color: [54, 91, 40],
        diagnostic: "variant-defaulted",
    });
    assert.deepEqual(
        resolveTerrainColor({ blockName: "minecraft:oak_leaves" }),
        {
            color: [54, 91, 40],
            diagnostic: "variant-defaulted",
        },
    );
});

test("resolveTerrainColor applies default tint when no biome is known", () => {
    assert.deepEqual(resolveTerrainColor({ blockName: "minecraft:water" }), {
        color: [68, 175, 245],
    });
});
