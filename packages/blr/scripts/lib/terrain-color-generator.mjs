import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { PNG } from "pngjs";

const execFileAsync = promisify(execFile);

export const REQUIRED_BEDROCK_SAMPLE_FILES = [
    "resource_pack/blocks.json",
    "resource_pack/textures/terrain_texture.json",
    "resource_pack/biomes_client.json",
    "metadata/vanilladata_modules/mojang-biomes.json",
    "version.json",
];

const FACE_PRIORITY = [
    "up",
    "top",
    "side",
    "north",
    "south",
    "east",
    "west",
    "down",
];

const GRASS_TINT_BLOCKS = new Set([
    "fern",
    "grass",
    "large_fern",
    "short_grass",
    "tall_grass",
    "tallgrass",
]);

const FOLIAGE_TINT_BLOCKS = new Set([
    "acacia_leaves",
    "birch_leaves",
    "dark_oak_leaves",
    "jungle_leaves",
    "leaves",
    "leaves2",
    "mangrove_leaves",
    "oak_leaves",
    "spruce_leaves",
    "vine",
    "vines",
]);

const WATER_TINT_BLOCKS = new Set(["flowing_water", "water"]);
const TEXTURE_ALIAS_FALLBACKS = {
    fern: ["fern_carried"],
    large_fern: ["large_fern_carried", "fern_carried"],
    tall_grass: ["tall_grass_carried", "tallgrass", "tallgrass_carried"],
    kelp: ["kelp_top", "kelp_a", "kelp_b", "kelp_d"],
    lilac: ["lilac_carried"],
    scaffolding: ["scaffolding_side", "scaffolding_bottom"],
    grindstone: ["grindstone_side", "grindstone_pivot"],
};
const VEGETATION_CANDIDATE_PATTERN =
    /(leaves|leaf|grass|fern|vine|vines|seagrass|kelp|reeds|sapling|bush|azalea)/;
const VEGETATION_CANDIDATE_EXCLUDE_PATTERN =
    /(moss|mossy|flower|crop|petal|dried_kelp|dead_bush|pitcher|torchflower)/;

export async function findBedrockSamplesDirectory({
    repoRoot,
    explicitPath,
    env = process.env,
}) {
    const candidates = [
        explicitPath,
        env.BLR_BEDROCK_SAMPLES_DIR,
        path.resolve(repoRoot, "../forks/bedrock-samples"),
        path.resolve(repoRoot, "../../forks/bedrock-samples"),
    ].filter(Boolean);

    for (const candidate of candidates) {
        const resolved = path.resolve(candidate);
        if (await isBedrockSamplesDirectory(resolved)) {
            return resolved;
        }
    }

    throw new Error(
        [
            "Cannot find bedrock-samples.",
            "Set BLR_BEDROCK_SAMPLES_DIR in your shell or ignored .env.local,",
            "pass --bedrock-samples <path>, or use ../forks/bedrock-samples.",
        ].join(" "),
    );
}

export function parseJsonWithComments(source) {
    return JSON.parse(stripJsonComments(source));
}

export function resolveTerrainTexturePath(
    blocks,
    terrainTexture,
    blockKey,
    options = {},
) {
    const block = blocks[blockKey];
    if (!isObject(block) || (!block.textures && !block.carried_textures)) {
        return fallbackTexture("fallback");
    }

    const textureAliases = chooseTextureAliases(block, blockKey);
    for (let index = 0; index < textureAliases.length; index += 1) {
        const textureAlias = textureAliases[index];
        const textureData = terrainTexture.texture_data?.[textureAlias.alias];
        if (!textureData) {
            continue;
        }

        const resolved = normalizeTextureEntry(
            textureData.textures,
            textureAlias.face,
            options,
        );
        if (
            !options.bedrockSamplesRoot ||
            !resolved.texturePath ||
            texturePathExists(options.bedrockSamplesRoot, resolved.texturePath)
        ) {
            return index === 0
                ? resolved
                : { ...resolved, confidence: "fallback" };
        }
    }

    return fallbackTexture("fallback");
}

export async function averageTextureColor(
    bedrockSamplesRoot,
    texturePath,
    overlayColor,
) {
    const image = await readTextureImage(bedrockSamplesRoot, texturePath);
    const firstFrameHeight = Math.min(image.height, image.width);
    let totalAlpha = 0;
    let r = 0;
    let g = 0;
    let b = 0;

    for (let y = 0; y < firstFrameHeight; y += 1) {
        for (let x = 0; x < image.width; x += 1) {
            const offset = (y * image.width + x) * 4;
            const alpha = image.data[offset + 3] / 255;
            if (alpha <= 0) continue;
            totalAlpha += alpha;
            r += image.data[offset] * alpha;
            g += image.data[offset + 1] * alpha;
            b += image.data[offset + 2] * alpha;
        }
    }

    if (totalAlpha === 0) {
        return [255, 0, 255];
    }

    let color = [
        Math.round(r / totalAlpha),
        Math.round(g / totalAlpha),
        Math.round(b / totalAlpha),
    ];
    if (overlayColor) {
        color = multiplyColor(color, parseHexColor(overlayColor));
    }
    return color;
}

export async function loadDotEnvLocal(repoRoot) {
    const envPath = path.join(repoRoot, ".env.local");
    if (!existsSync(envPath)) return {};
    const result = {};
    for (const line of (await readFile(envPath, "utf8")).split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const equalsIndex = trimmed.indexOf("=");
        if (equalsIndex <= 0) continue;
        result[trimmed.slice(0, equalsIndex)] = trimmed.slice(equalsIndex + 1);
    }
    return result;
}

export async function createTerrainColorArtifacts({ bedrockSamplesRoot }) {
    const blocks = await readBedrockJson(
        bedrockSamplesRoot,
        "resource_pack/blocks.json",
    );
    const terrainTexture = await readBedrockJson(
        bedrockSamplesRoot,
        "resource_pack/textures/terrain_texture.json",
    );
    const version = await readBedrockJson(bedrockSamplesRoot, "version.json");
    const terrainColors = await buildTerrainColors(
        bedrockSamplesRoot,
        blocks,
        terrainTexture,
    );
    const biomeTints = await buildBiomeTints(bedrockSamplesRoot);
    const inputHash = await hashRelevantInputs(
        bedrockSamplesRoot,
        terrainColors.texturePaths,
    );
    const source = {
        bedrockSamplesVersion: version.latest?.version ?? "unknown",
        bedrockSamplesCommit: await getGitCommit(bedrockSamplesRoot),
        generatedAt: "deterministic",
        inputHash,
    };

    return {
        terrainColors: renderTerrainColorsTs(source, terrainColors.records),
        biomeTints: renderBiomeTintsTs(source, biomeTints),
        paletteAudit: renderPaletteAuditTs(
            source,
            buildPaletteAudit(terrainColors.records),
        ),
    };
}

async function isBedrockSamplesDirectory(directory) {
    for (const relativePath of REQUIRED_BEDROCK_SAMPLE_FILES) {
        if (!existsSync(path.join(directory, relativePath))) {
            return false;
        }
    }
    return true;
}

function stripJsonComments(source) {
    let output = "";
    let inString = false;
    let stringQuote = "";
    let escaped = false;

    for (let index = 0; index < source.length; index += 1) {
        const char = source[index];
        const next = source[index + 1];

        if (inString) {
            output += char;
            if (escaped) {
                escaped = false;
            } else if (char === "\\") {
                escaped = true;
            } else if (char === stringQuote) {
                inString = false;
                stringQuote = "";
            }
            continue;
        }

        if (char === '"' || char === "'") {
            inString = true;
            stringQuote = char;
            output += char;
            continue;
        }

        if (char === "/" && next === "/") {
            while (index < source.length && !/\r|\n/.test(source[index])) {
                index += 1;
            }
            output += source[index] ?? "";
            continue;
        }

        if (char === "/" && next === "*") {
            output += " ";
            index += 2;
            while (
                index < source.length &&
                !(source[index] === "*" && source[index + 1] === "/")
            ) {
                if (source[index] === "\r" || source[index] === "\n") {
                    output += source[index];
                }
                index += 1;
            }
            index += 1;
            continue;
        }

        output += char;
    }

    return output;
}

function chooseTextureAliases(block, blockKey) {
    const primary = chooseTextureAlias(block);
    const fallbacks = TEXTURE_ALIAS_FALLBACKS[blockKey] ?? [];
    return [
        primary,
        ...fallbacks
            .filter((alias) => alias !== primary.alias)
            .map((alias) => ({ alias, face: primary.face })),
    ];
}

function chooseTextureAlias(block) {
    if (typeof block.textures === "string") {
        return { alias: block.textures, face: "up" };
    }
    if (isObject(block.textures)) {
        for (const face of FACE_PRIORITY) {
            if (typeof block.textures[face] === "string") {
                return {
                    alias: block.textures[face],
                    face: normalizeFace(face),
                };
            }
        }
    }
    if (typeof block.carried_textures === "string") {
        return { alias: block.carried_textures, face: "carried" };
    }
    if (isObject(block.carried_textures)) {
        for (const face of FACE_PRIORITY) {
            if (typeof block.carried_textures[face] === "string") {
                return { alias: block.carried_textures[face], face: "carried" };
            }
        }
    }
    return { alias: "missing", face: "fallback" };
}

function normalizeTextureEntry(entry, face, options = {}) {
    if (typeof entry === "string") {
        return {
            texturePath: entry,
            face,
            confidence: "resolved",
            overlayColor: undefined,
        };
    }
    if (Array.isArray(entry)) {
        const first = chooseTextureVariant(entry, options);
        return {
            ...first,
            face,
            confidence: entry.length > 1 ? "variant-defaulted" : "resolved",
        };
    }
    const variant = normalizeTextureVariant(entry);
    return {
        ...variant,
        face,
        confidence: "resolved",
    };
}

function chooseTextureVariant(entries, options) {
    if (!options.bedrockSamplesRoot) {
        return normalizeTextureVariant(entries[0]);
    }
    for (const entry of entries) {
        const variant = normalizeTextureVariant(entry);
        if (
            variant.texturePath &&
            texturePathExists(options.bedrockSamplesRoot, variant.texturePath)
        ) {
            return variant;
        }
    }
    return normalizeTextureVariant(entries[0]);
}

function texturePathExists(bedrockSamplesRoot, texturePath) {
    try {
        return existsSync(
            resolveResourcePackTextureFile(bedrockSamplesRoot, texturePath),
        );
    } catch {
        return false;
    }
}

function normalizeTextureVariant(entry) {
    if (typeof entry === "string") {
        return { texturePath: entry, overlayColor: undefined };
    }
    if (isObject(entry)) {
        return {
            texturePath: entry.path,
            overlayColor: entry.overlay_color,
        };
    }
    return { texturePath: undefined, overlayColor: undefined };
}

function fallbackTexture(face) {
    return {
        texturePath: undefined,
        face,
        confidence: "fallback",
        overlayColor: undefined,
    };
}

function normalizeFace(face) {
    if (face === "top") return "up";
    if (
        face === "north" ||
        face === "south" ||
        face === "east" ||
        face === "west"
    ) {
        return "side";
    }
    return face;
}

function parseHexColor(hex) {
    const normalized = String(hex).replace(/^#/, "");
    if (!/^[0-9a-fA-F]{6}$/.test(normalized)) {
        return [255, 0, 255];
    }
    return [
        Number.parseInt(normalized.slice(0, 2), 16),
        Number.parseInt(normalized.slice(2, 4), 16),
        Number.parseInt(normalized.slice(4, 6), 16),
    ];
}

function multiplyColor(base, tint) {
    return base.map((channel, index) =>
        Math.round((channel * tint[index]) / 255),
    );
}

async function readBedrockJson(bedrockSamplesRoot, relativePath) {
    return parseJsonWithComments(
        await readFile(path.join(bedrockSamplesRoot, relativePath), "utf8"),
    );
}

async function readTextureImage(bedrockSamplesRoot, texturePath) {
    const imagePath = resolveResourcePackTextureFile(
        bedrockSamplesRoot,
        texturePath,
    );
    const data = await readFile(imagePath);
    if (imagePath.endsWith(".tga")) {
        return readTgaImage(data);
    }
    return PNG.sync.read(data);
}

async function buildTerrainColors(bedrockSamplesRoot, blocks, terrainTexture) {
    const records = {};
    const texturePaths = new Set();
    for (const blockKey of Object.keys(blocks).sort()) {
        const block = blocks[blockKey];
        if (!isObject(block) || (!block.textures && !block.carried_textures)) {
            continue;
        }

        const blockName = normalizeBlockName(blockKey);
        const resolved = resolveTerrainTexturePath(
            blocks,
            terrainTexture,
            blockKey,
            { bedrockSamplesRoot },
        );
        const record = {
            blockName,
            baseColor: [255, 0, 255],
            face: resolved.face,
            tintRole: inferTintRole(blockKey, resolved.texturePath),
            alphaMode: inferAlphaMode(blockKey, resolved.texturePath),
            source: "fallback",
            confidence: resolved.confidence,
        };

        if (resolved.texturePath) {
            record.texturePath = resolved.texturePath;
            texturePaths.add(resolved.texturePath);
            try {
                record.baseColor = await averageTextureColor(
                    bedrockSamplesRoot,
                    resolved.texturePath,
                    resolved.overlayColor,
                );
                record.source = resolved.overlayColor
                    ? "texture-average-overlay"
                    : "texture-average";
            } catch {
                record.confidence = "fallback";
            }
        }

        records[blockName] = stripUndefined(record);
    }
    return { records, texturePaths };
}

function normalizeBlockName(blockKey) {
    return blockKey.includes(":") ? blockKey : `minecraft:${blockKey}`;
}

function inferTintRole(blockKey, texturePath) {
    if (WATER_TINT_BLOCKS.has(blockKey)) return "water";
    if (GRASS_TINT_BLOCKS.has(blockKey)) return "grass";
    if (FOLIAGE_TINT_BLOCKS.has(blockKey)) return "foliage";
    if (texturePath?.includes("water_")) return "water";
    return undefined;
}

function buildPaletteAudit(records) {
    const audit = {
        blockCount: 0,
        tintRoleCounts: { none: 0, grass: 0, foliage: 0, water: 0 },
        tintedBlocks: { grass: [], foliage: [], water: [] },
        fallbackBlocks: [],
        variantDefaultedBlocks: [],
        untintedVegetationCandidates: [],
    };
    for (const [blockName, record] of Object.entries(records).sort(([a], [b]) =>
        a.localeCompare(b),
    )) {
        audit.blockCount += 1;
        const role = record.tintRole ?? "none";
        audit.tintRoleCounts[role] += 1;
        if (record.tintRole) {
            audit.tintedBlocks[record.tintRole].push(blockName);
        } else if (isUntintedVegetationCandidate(blockName)) {
            audit.untintedVegetationCandidates.push(blockName);
        }
        if (record.confidence === "fallback") {
            audit.fallbackBlocks.push(blockName);
        } else if (record.confidence === "variant-defaulted") {
            audit.variantDefaultedBlocks.push(blockName);
        }
    }
    return audit;
}

function isUntintedVegetationCandidate(blockName) {
    return (
        VEGETATION_CANDIDATE_PATTERN.test(blockName) &&
        !VEGETATION_CANDIDATE_EXCLUDE_PATTERN.test(blockName)
    );
}

function inferAlphaMode(blockKey, texturePath) {
    if (WATER_TINT_BLOCKS.has(blockKey)) return "blend";
    if (
        blockKey.includes("leaves") ||
        blockKey.includes("sapling") ||
        texturePath?.includes("glass")
    ) {
        return "cutout";
    }
    return "opaque";
}

async function buildBiomeTints(bedrockSamplesRoot) {
    const legacy = await readBedrockJson(
        bedrockSamplesRoot,
        "resource_pack/biomes_client.json",
    );
    const biomeData = await readBedrockJson(
        bedrockSamplesRoot,
        "metadata/vanilladata_modules/mojang-biomes.json",
    );
    const defaultGrass = await averageColorMap(bedrockSamplesRoot, "grass");
    const defaultFoliage = await averageColorMap(bedrockSamplesRoot, "foliage");
    const defaultWater = parseHexColor(
        legacy.biomes?.default?.water_surface_color ?? "#44AFF5",
    );
    const biomeIds = {};
    const biomeTints = {
        default: {
            biomeName: "default",
            grass: defaultGrass,
            foliage: defaultFoliage,
            water: defaultWater,
            source: "default-colormap",
        },
    };
    const currentBiomes = await readClientBiomeFiles(bedrockSamplesRoot);

    for (const item of biomeData.data_items ?? []) {
        if (!Number.isInteger(item.id) || typeof item.name !== "string") {
            continue;
        }
        biomeIds[item.id] = item.name;
        biomeTints[item.name] = stripUndefined({
            biomeName: item.name,
            ...(await resolveBiomeTint(
                item.name,
                currentBiomes.get(item.name),
                legacy.biomes?.[item.name],
                {
                    defaultGrass,
                    defaultFoliage,
                    defaultWater,
                    bedrockSamplesRoot,
                },
            )),
        });
    }

    return { biomeIds, biomeTints };
}

async function readClientBiomeFiles(bedrockSamplesRoot) {
    const biomeRoot = path.join(bedrockSamplesRoot, "resource_pack", "biomes");
    const result = new Map();
    if (!existsSync(biomeRoot)) return result;
    for (const filePath of await listFiles(biomeRoot)) {
        if (!filePath.endsWith(".json")) continue;
        const json = parseJsonWithComments(await readFile(filePath, "utf8"));
        const clientBiome = json["minecraft:client_biome"];
        const identifier = clientBiome?.description?.identifier;
        if (typeof identifier === "string") {
            result.set(identifier, clientBiome);
        }
    }
    return result;
}

async function resolveBiomeTint(
    biomeName,
    clientBiome,
    legacyBiome,
    { defaultGrass, defaultFoliage, defaultWater, bedrockSamplesRoot },
) {
    const components = clientBiome?.components ?? {};
    const grass = await resolveBiomeColor(
        components["minecraft:grass_appearance"]?.color,
        bedrockSamplesRoot,
    );
    const foliage = await resolveBiomeColor(
        components["minecraft:foliage_appearance"]?.color,
        bedrockSamplesRoot,
    );
    const water = components["minecraft:water_appearance"]?.surface_color
        ? parseHexColor(components["minecraft:water_appearance"].surface_color)
        : legacyBiome?.water_surface_color
          ? parseHexColor(legacyBiome.water_surface_color)
          : defaultWater;

    return {
        grass: grass ?? defaultGrass,
        foliage: foliage ?? defaultFoliage,
        water,
        source: clientBiome
            ? "client-biome"
            : legacyBiome
              ? "legacy-biomes-client"
              : "default-colormap",
    };
}

async function resolveBiomeColor(colorValue, bedrockSamplesRoot) {
    if (typeof colorValue === "string") {
        return parseHexColor(colorValue);
    }
    if (isObject(colorValue) && typeof colorValue.color_map === "string") {
        return averageColorMap(bedrockSamplesRoot, colorValue.color_map);
    }
    return undefined;
}

async function averageColorMap(bedrockSamplesRoot, colorMapName) {
    let colorMapPath;
    try {
        colorMapPath = resolveResourcePackFile(
            bedrockSamplesRoot,
            path.join("textures", "colormap", `${colorMapName}.png`),
        );
    } catch {
        return [255, 255, 255];
    }
    if (!existsSync(colorMapPath)) return [255, 255, 255];
    const image = PNG.sync.read(await readFile(colorMapPath));
    let totalAlpha = 0;
    let r = 0;
    let g = 0;
    let b = 0;
    for (let offset = 0; offset < image.data.length; offset += 4) {
        const alpha = image.data[offset + 3] / 255;
        if (alpha <= 0) continue;
        totalAlpha += alpha;
        r += image.data[offset] * alpha;
        g += image.data[offset + 1] * alpha;
        b += image.data[offset + 2] * alpha;
    }
    if (totalAlpha === 0) return [255, 255, 255];
    return [
        Math.round(r / totalAlpha),
        Math.round(g / totalAlpha),
        Math.round(b / totalAlpha),
    ];
}

async function hashRelevantInputs(bedrockSamplesRoot, texturePaths) {
    const relativePaths = new Set(REQUIRED_BEDROCK_SAMPLE_FILES);
    for (const texturePath of texturePaths) {
        relativePaths.add(
            path.relative(
                bedrockSamplesRoot,
                resolveResourcePackTextureFile(bedrockSamplesRoot, texturePath),
            ),
        );
    }
    for (const filePath of await listFiles(
        path.join(bedrockSamplesRoot, "resource_pack", "biomes"),
    )) {
        relativePaths.add(path.relative(bedrockSamplesRoot, filePath));
    }
    for (const filePath of await listFiles(
        path.join(bedrockSamplesRoot, "resource_pack", "textures", "colormap"),
    )) {
        relativePaths.add(path.relative(bedrockSamplesRoot, filePath));
    }

    const hash = crypto.createHash("sha256");
    for (const relativePath of [...relativePaths].sort()) {
        const absolutePath = path.join(bedrockSamplesRoot, relativePath);
        if (!existsSync(absolutePath)) continue;
        hash.update(relativePath.replaceAll("\\", "/"));
        hash.update("\0");
        hash.update(await readFile(absolutePath));
        hash.update("\0");
    }
    return hash.digest("hex");
}

function resolveResourcePackFile(bedrockSamplesRoot, resourcePackRelativePath) {
    const resourcePackRoot = path.resolve(bedrockSamplesRoot, "resource_pack");
    const targetPath = path.resolve(resourcePackRoot, resourcePackRelativePath);
    const relativePath = path.relative(resourcePackRoot, targetPath);
    if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
        throw new Error(
            `Bedrock resource path must stay inside resource_pack: ${resourcePackRelativePath}`,
        );
    }
    return targetPath;
}

function resolveResourcePackTextureFile(bedrockSamplesRoot, texturePath) {
    for (const extension of [".png", ".tga"]) {
        const filePath = resolveResourcePackFile(
            bedrockSamplesRoot,
            `${texturePath}${extension}`,
        );
        if (existsSync(filePath)) return filePath;
    }
    return resolveResourcePackFile(bedrockSamplesRoot, `${texturePath}.png`);
}

function readTgaImage(data) {
    if (data.length < 18) {
        throw new Error("TGA texture is too short.");
    }
    const idLength = data[0];
    const colorMapType = data[1];
    const imageType = data[2];
    const width = data.readUInt16LE(12);
    const height = data.readUInt16LE(14);
    const pixelDepth = data[16];
    const offset = 18 + idLength;
    const isRle = imageType === 10 || imageType === 11;
    const isTrueColor = imageType === 2 || imageType === 10;
    const isGrayscale = imageType === 3 || imageType === 11;
    if (colorMapType !== 0 || (!isTrueColor && !isGrayscale)) {
        throw new Error("Unsupported TGA texture format.");
    }
    if (width <= 0 || height <= 0) {
        throw new Error("TGA texture has empty dimensions.");
    }
    const bytesPerPixel = pixelDepth / 8;
    if (
        !Number.isInteger(bytesPerPixel) ||
        ![1, 3, 4].includes(bytesPerPixel)
    ) {
        throw new Error(`Unsupported TGA pixel depth: ${pixelDepth}.`);
    }
    if (!isRle && data.length < offset + width * height * bytesPerPixel) {
        throw new Error("TGA texture pixel data is truncated.");
    }

    const pixels = new Uint8Array(width * height * 4);
    const writePixel = (inputOffset, outputPixel) => {
        if (inputOffset + bytesPerPixel > data.length) {
            throw new Error("TGA texture pixel data is truncated.");
        }
        const outputOffset = outputPixel * 4;
        if (bytesPerPixel === 1) {
            const value = data[inputOffset];
            pixels[outputOffset] = value;
            pixels[outputOffset + 1] = value;
            pixels[outputOffset + 2] = value;
            pixels[outputOffset + 3] = 255;
            return;
        }
        pixels[outputOffset] = data[inputOffset + 2];
        pixels[outputOffset + 1] = data[inputOffset + 1];
        pixels[outputOffset + 2] = data[inputOffset];
        pixels[outputOffset + 3] =
            bytesPerPixel === 4 ? data[inputOffset + 3] : 255;
    };

    if (!isRle) {
        for (let index = 0; index < width * height; index += 1) {
            writePixel(offset + index * bytesPerPixel, index);
        }
        return { width, height, data: pixels };
    }

    let inputOffset = offset;
    let outputPixel = 0;
    while (outputPixel < width * height) {
        if (inputOffset >= data.length) {
            throw new Error("TGA texture RLE data is truncated.");
        }
        const packet = data[inputOffset++];
        const count = (packet & 0x7f) + 1;
        if (packet & 0x80) {
            const sourceOffset = inputOffset;
            inputOffset += bytesPerPixel;
            for (let index = 0; index < count; index += 1) {
                writePixel(sourceOffset, outputPixel++);
            }
        } else {
            for (let index = 0; index < count; index += 1) {
                writePixel(inputOffset, outputPixel++);
                inputOffset += bytesPerPixel;
            }
        }
    }

    return { width, height, data: pixels };
}

async function listFiles(directory) {
    if (!existsSync(directory)) return [];
    const result = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        const entryPath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
            result.push(...(await listFiles(entryPath)));
        } else if (entry.isFile()) {
            result.push(entryPath);
        }
    }
    return result;
}

async function getGitCommit(directory) {
    try {
        const { stdout } = await execFileAsync(
            "git",
            ["-C", directory, "rev-parse", "--short", "HEAD"],
            { windowsHide: true },
        );
        return stdout.trim() || "unknown";
    } catch {
        return "unknown";
    }
}

function renderTerrainColorsTs(source, records) {
    return `${generatedHeader()}

export type GeneratedTerrainColor = {
    blockName: string;
    baseColor: readonly [number, number, number];
    texturePath?: string;
    face?: "up" | "side" | "down" | "carried" | "fallback";
    tintRole?: "grass" | "foliage" | "water";
    alphaMode?: "opaque" | "cutout" | "blend";
    source: "texture-average" | "texture-average-overlay" | "fallback";
    confidence: "resolved" | "variant-defaulted" | "fallback";
};

export const BEDROCK_TERRAIN_COLOR_SOURCE = ${stableTsValue(source)} as const;

export const BEDROCK_TERRAIN_COLORS = ${stableTsValue(records)} as const satisfies Record<string, GeneratedTerrainColor>;
`;
}

function renderBiomeTintsTs(source, { biomeIds, biomeTints }) {
    return `${generatedHeader()}

export type GeneratedBiomeTint = {
    biomeName: string;
    grass?: readonly [number, number, number];
    foliage?: readonly [number, number, number];
    water?: readonly [number, number, number];
    source: "client-biome" | "legacy-biomes-client" | "default-colormap";
};

export const BEDROCK_BIOME_TINT_SOURCE = ${stableTsValue(source)} as const;

export const BEDROCK_BIOME_ID_TO_NAME = ${stableTsValue(biomeIds)} as const;

export const BEDROCK_BIOME_TINTS = ${stableTsValue(biomeTints)} as const satisfies Record<string, GeneratedBiomeTint>;
`;
}

function renderPaletteAuditTs(source, audit) {
    return `${generatedHeader()}

export type GeneratedTerrainPaletteAudit = {
    blockCount: number;
    tintRoleCounts: {
        none: number;
        grass: number;
        foliage: number;
        water: number;
    };
    tintedBlocks: {
        grass: readonly string[];
        foliage: readonly string[];
        water: readonly string[];
    };
    fallbackBlocks: readonly string[];
    variantDefaultedBlocks: readonly string[];
    untintedVegetationCandidates: readonly string[];
};

export const BEDROCK_TERRAIN_PALETTE_AUDIT_SOURCE = ${stableTsValue(source)} as const;

export const BEDROCK_TERRAIN_PALETTE_AUDIT = ${stableTsValue(audit)} as const satisfies GeneratedTerrainPaletteAudit;
`;
}

function generatedHeader() {
    return `// Generated by packages/blr/scripts/generate-terrain-colors.mjs.
// Do not edit by hand. Derived metadata only; source assets stay outside this repo.`;
}

function stableTsValue(value) {
    return JSON.stringify(sortValue(value), null, 4);
}

function sortValue(value) {
    if (Array.isArray(value)) {
        return value.map(sortValue);
    }
    if (isObject(value)) {
        return Object.fromEntries(
            Object.entries(value)
                .sort(([left], [right]) => left.localeCompare(right))
                .map(([key, entryValue]) => [key, sortValue(entryValue)]),
        );
    }
    return value;
}

function stripUndefined(value) {
    return Object.fromEntries(
        Object.entries(value).filter(
            ([, entryValue]) => entryValue !== undefined,
        ),
    );
}

function isObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
