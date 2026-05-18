import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PNG } from "pngjs";
import {
    averageTextureColor,
    createTerrainColorArtifacts,
    findBedrockSamplesDirectory,
    parseJsonWithComments,
    resolveTerrainTexturePath,
} from "./terrain-color-generator.mjs";

async function tempDir(prefix) {
    return mkdtemp(path.join(os.tmpdir(), prefix));
}

async function createBedrockSamplesMarker(directory) {
    await mkdir(path.join(directory, "resource_pack", "textures"), {
        recursive: true,
    });
    await mkdir(path.join(directory, "metadata", "vanilladata_modules"), {
        recursive: true,
    });
    await writeFile(path.join(directory, "resource_pack", "blocks.json"), "{}");
    await writeFile(
        path.join(
            directory,
            "resource_pack",
            "textures",
            "terrain_texture.json",
        ),
        "{}",
    );
    await writeFile(
        path.join(directory, "resource_pack", "biomes_client.json"),
        "{}",
    );
    await writeFile(
        path.join(
            directory,
            "metadata",
            "vanilladata_modules",
            "mojang-biomes.json",
        ),
        "{}",
    );
    await writeFile(path.join(directory, "version.json"), "{}");
}

test("findBedrockSamplesDirectory prefers explicit option, env, then conventional paths", async () => {
    const root = await tempDir("blr-terrain-root-");
    const explicit = path.join(root, "explicit");
    const envDir = path.join(root, "env");
    const conventional = path.resolve(root, "..", "forks", "bedrock-samples");

    for (const dir of [explicit, envDir, conventional]) {
        await createBedrockSamplesMarker(dir);
    }

    assert.equal(
        await findBedrockSamplesDirectory({
            repoRoot: root,
            explicitPath: explicit,
            env: { BLR_BEDROCK_SAMPLES_DIR: envDir },
        }),
        explicit,
    );
    assert.equal(
        await findBedrockSamplesDirectory({
            repoRoot: root,
            env: { BLR_BEDROCK_SAMPLES_DIR: envDir },
        }),
        envDir,
    );
    assert.equal(
        await findBedrockSamplesDirectory({ repoRoot: root, env: {} }),
        conventional,
    );
});

test("parseJsonWithComments accepts bedrock-samples style comments", () => {
    assert.deepEqual(
        parseJsonWithComments(`// reference only\n{ "a": 1, "b": "http://x" }`),
        { a: 1, b: "http://x" },
    );
    assert.deepEqual(parseJsonWithComments(`{ "a": /* note */ 1 }`), { a: 1 });
    assert.throws(() => parseJsonWithComments(`{ "a": 1/* note */2 }`));
});

test("resolveTerrainTexturePath chooses top face and first variant", () => {
    const blocks = {
        grass: {
            textures: {
                down: "grass_bottom",
                side: "grass_side",
                up: "grass_top",
            },
        },
        stone: {
            textures: "stone",
        },
    };
    const terrain = {
        texture_data: {
            grass_top: { textures: "textures/blocks/grass_top" },
            stone: {
                textures: [
                    "textures/blocks/stone",
                    "textures/blocks/stone_granite",
                ],
            },
        },
    };

    assert.deepEqual(resolveTerrainTexturePath(blocks, terrain, "grass"), {
        texturePath: "textures/blocks/grass_top",
        face: "up",
        confidence: "resolved",
        overlayColor: undefined,
    });
    assert.deepEqual(resolveTerrainTexturePath(blocks, terrain, "stone"), {
        texturePath: "textures/blocks/stone",
        face: "up",
        confidence: "variant-defaulted",
        overlayColor: undefined,
    });
});

test("resolveTerrainTexturePath can skip missing first PNG variants", async () => {
    const root = await tempDir("blr-terrain-variant-");
    const texturePath = path.join(root, "resource_pack", "textures", "blocks");
    await mkdir(texturePath, { recursive: true });
    const png = new PNG({ width: 1, height: 1 });
    png.data.set([1, 2, 3, 255]);
    await writeFile(path.join(texturePath, "present.png"), PNG.sync.write(png));

    assert.deepEqual(
        resolveTerrainTexturePath(
            { leaves: { textures: "leaves" } },
            {
                texture_data: {
                    leaves: {
                        textures: [
                            "textures/blocks/missing",
                            "textures/blocks/present",
                        ],
                    },
                },
            },
            "leaves",
            { bedrockSamplesRoot: root },
        ),
        {
            texturePath: "textures/blocks/present",
            face: "up",
            confidence: "variant-defaulted",
            overlayColor: undefined,
        },
    );
});

test("resolveTerrainTexturePath uses curated fallback aliases for Bedrock block names", async () => {
    const root = await tempDir("blr-terrain-alias-");
    const texturePath = path.join(root, "resource_pack", "textures", "blocks");
    await mkdir(texturePath, { recursive: true });
    const png = new PNG({ width: 1, height: 1 });
    png.data.set([16, 80, 16, 255]);
    await writeFile(
        path.join(texturePath, "fern_carried.png"),
        PNG.sync.write(png),
    );

    assert.deepEqual(
        resolveTerrainTexturePath(
            { fern: { textures: "fern" } },
            {
                texture_data: {
                    fern_carried: {
                        textures: "textures/blocks/fern_carried",
                    },
                },
            },
            "fern",
            { bedrockSamplesRoot: root },
        ),
        {
            texturePath: "textures/blocks/fern_carried",
            face: "up",
            confidence: "fallback",
            overlayColor: undefined,
        },
    );
});

test("averageTextureColor ignores transparent pixels and applies overlay", async () => {
    const root = await tempDir("blr-terrain-png-");
    const texturePath = path.join(root, "resource_pack", "textures", "blocks");
    await mkdir(texturePath, { recursive: true });
    const png = new PNG({ width: 2, height: 2 });
    png.data.set([
        100, 100, 100, 255, 200, 200, 200, 255, 255, 0, 255, 0, 0, 0, 0, 0,
    ]);
    await writeFile(path.join(texturePath, "sample.png"), PNG.sync.write(png));

    assert.deepEqual(
        await averageTextureColor(root, "textures/blocks/sample"),
        [150, 150, 150],
    );
    assert.deepEqual(
        await averageTextureColor(root, "textures/blocks/sample", "#80ff80"),
        [75, 150, 75],
    );
    await assert.rejects(
        () => averageTextureColor(root, "../outside"),
        /resource path must stay inside resource_pack/,
    );
});

test("averageTextureColor can read Bedrock TGA textures", async () => {
    const root = await tempDir("blr-terrain-tga-");
    const texturePath = path.join(root, "resource_pack", "textures", "blocks");
    await mkdir(texturePath, { recursive: true });
    const tga = Buffer.from([
        0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 1, 0, 32, 8, 30, 20, 10, 255,
    ]);
    await writeFile(path.join(texturePath, "sample.tga"), tga);

    assert.deepEqual(
        await averageTextureColor(root, "textures/blocks/sample"),
        [10, 20, 30],
    );
});

test("averageTextureColor can read Bedrock RLE TGA textures", async () => {
    const root = await tempDir("blr-terrain-rle-tga-");
    const texturePath = path.join(root, "resource_pack", "textures", "blocks");
    await mkdir(texturePath, { recursive: true });
    const tga = Buffer.from([
        0, 0, 10, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 1, 0, 32, 8, 0x80, 60, 50,
        40, 255,
    ]);
    await writeFile(path.join(texturePath, "sample.tga"), tga);

    assert.deepEqual(
        await averageTextureColor(root, "textures/blocks/sample"),
        [40, 50, 60],
    );
});

test("createTerrainColorArtifacts writes derived data without embedded assets", async () => {
    const root = await tempDir("blr-terrain-artifacts-");
    await mkdir(path.join(root, "resource_pack", "textures", "blocks"), {
        recursive: true,
    });
    await mkdir(path.join(root, "resource_pack", "textures", "colormap"), {
        recursive: true,
    });
    await mkdir(path.join(root, "resource_pack", "biomes"), {
        recursive: true,
    });
    await mkdir(path.join(root, "metadata", "vanilladata_modules"), {
        recursive: true,
    });
    await writeFile(
        path.join(root, "version.json"),
        JSON.stringify({
            latest: { version: "1.26.20.4" },
        }),
    );
    await writeFile(
        path.join(root, "resource_pack", "blocks.json"),
        JSON.stringify({
            fern: { textures: "missing_fern" },
            grass: { textures: { up: "grass_top" } },
            moss_block: { textures: "moss_block" },
            oak_leaves: { textures: "leaves_oak" },
            unknown_plant: { textures: "missing_unknown_plant" },
        }),
    );
    await writeFile(
        path.join(root, "resource_pack", "textures", "terrain_texture.json"),
        JSON.stringify({
            texture_data: {
                grass_top: { textures: "textures/blocks/grass_top" },
                leaves_oak: {
                    textures: "textures/blocks/leaves_oak_opaque",
                },
                moss_block: { textures: "textures/blocks/moss_block" },
            },
        }),
    );
    await writeFile(
        path.join(root, "resource_pack", "biomes_client.json"),
        JSON.stringify({
            biomes: { default: { water_surface_color: "#44aff5" } },
        }),
    );
    await writeFile(
        path.join(root, "resource_pack", "biomes", "plains.client_biome.json"),
        JSON.stringify({
            "minecraft:client_biome": {
                description: { identifier: "minecraft:plains" },
                components: {
                    "minecraft:water_appearance": {
                        surface_color: "#44AFF5",
                    },
                },
            },
        }),
    );
    await writeFile(
        path.join(root, "resource_pack", "biomes", "swamp.client_biome.json"),
        JSON.stringify({
            "minecraft:client_biome": {
                description: { identifier: "minecraft:swamp" },
                components: {
                    "minecraft:grass_appearance": {
                        color: { color_map: "../../../outside" },
                    },
                },
            },
        }),
    );
    await writeFile(
        path.join(
            root,
            "metadata",
            "vanilladata_modules",
            "mojang-biomes.json",
        ),
        JSON.stringify({
            data_items: [
                { id: 1, name: "minecraft:plains" },
                { id: 2, name: "minecraft:swamp" },
            ],
        }),
    );

    const grassTexture = new PNG({ width: 1, height: 1 });
    grassTexture.data.set([80, 160, 80, 255]);
    await writeFile(
        path.join(root, "resource_pack", "textures", "blocks", "grass_top.png"),
        PNG.sync.write(grassTexture),
    );
    const oakLeavesTexture = new PNG({ width: 1, height: 1 });
    oakLeavesTexture.data.set([128, 128, 128, 255]);
    await writeFile(
        path.join(
            root,
            "resource_pack",
            "textures",
            "blocks",
            "leaves_oak_opaque.png",
        ),
        PNG.sync.write(oakLeavesTexture),
    );
    const mossTexture = new PNG({ width: 1, height: 1 });
    mossTexture.data.set([32, 96, 32, 255]);
    await writeFile(
        path.join(
            root,
            "resource_pack",
            "textures",
            "blocks",
            "moss_block.png",
        ),
        PNG.sync.write(mossTexture),
    );
    for (const colorMapName of ["grass", "foliage"]) {
        const colorMap = new PNG({ width: 1, height: 1 });
        colorMap.data.set([255, 255, 255, 255]);
        await writeFile(
            path.join(
                root,
                "resource_pack",
                "textures",
                "colormap",
                `${colorMapName}.png`,
            ),
            PNG.sync.write(colorMap),
        );
    }

    const output = await createTerrainColorArtifacts({
        bedrockSamplesRoot: root,
    });

    assert.match(output.terrainColors, /minecraft:grass/);
    assert.match(output.terrainColors, /minecraft:oak_leaves/);
    assert.match(output.terrainColors, /"tintRole": "foliage"/);
    assert.match(output.terrainColors, /80,\n            160,\n            80/);
    assert.doesNotMatch(output.terrainColors, /base64|PNG|IHDR/);
    assert.match(output.biomeTints, /minecraft:plains/);
    assert.match(output.biomeTints, /68,\n            175,\n            245/);
    assert.doesNotMatch(output.biomeTints, /\.\.[/\\]|outside\.png/);
    assert.match(output.paletteAudit, /BEDROCK_TERRAIN_PALETTE_AUDIT/);
    assert.match(output.paletteAudit, /minecraft:unknown_plant/);
    assert.match(output.paletteAudit, /minecraft:fern/);
    assert.doesNotMatch(
        output.paletteAudit,
        /minecraft:moss_block[\s\S]*untintedVegetationCandidates/,
    );
});
