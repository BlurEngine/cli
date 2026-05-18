import {
    BEDROCK_BIOME_TINTS,
    type GeneratedBiomeTint,
} from "./generated/bedrock-biome-tints.js";
import {
    BEDROCK_TERRAIN_COLORS,
    type GeneratedTerrainColor,
} from "./generated/bedrock-terrain-colors.js";

export type RgbColor = [number, number, number];

export type ResolveTerrainColorOptions = {
    blockName: string;
    biomeName?: string;
};

export type ResolveTerrainColorResult = {
    color: RgbColor;
    diagnostic?: "unknown-block" | "fallback" | "variant-defaulted";
};

export type TerrainPaletteUsageColumn = {
    blockName: string;
    biomeName?: string;
};

export type TerrainPaletteUsageAudit = {
    schemaVersion: 1;
    columns: number;
    blockCounts: Record<string, number>;
    tintRoleCounts: Record<"none" | "grass" | "foliage" | "water", number>;
    diagnosticCounts: Record<
        "unknown-block" | "fallback" | "variant-defaulted",
        number
    >;
    unknownBlocks: Record<string, number>;
    fallbackBlocks: Record<string, number>;
    variantDefaultedBlocks: Record<string, number>;
    tintableBlocksWithoutBiome: Record<string, number>;
    untintedVegetationCandidates: Record<string, number>;
};

const UNKNOWN_BLOCK_COLOR: RgbColor = [255, 0, 255];
const TERRAIN_COLORS: Record<string, GeneratedTerrainColor> =
    BEDROCK_TERRAIN_COLORS;
const BIOME_TINTS: Record<string, GeneratedBiomeTint> = BEDROCK_BIOME_TINTS;
const BLOCK_NAME_ALIASES: Record<string, string> = {
    "minecraft:grass_block": "minecraft:grass",
    "minecraft:iron_chain": "minecraft:chain",
    "minecraft:sea_lantern": "minecraft:seaLantern",
};
const VEGETATION_CANDIDATE_PATTERN =
    /(leaves|leaf|grass|fern|vine|vines|seagrass|kelp|reeds|sapling|bush|azalea)/;
const VEGETATION_CANDIDATE_EXCLUDE_PATTERN =
    /(moss|mossy|flower|crop|petal|dried_kelp|dead_bush|pitcher|torchflower)/;

export function applyBiomeTint(
    baseColor: readonly [number, number, number],
    tint: readonly [number, number, number] | undefined,
    tintRole: GeneratedTerrainColor["tintRole"],
): RgbColor {
    if (!tint || !tintRole) return [...baseColor] as RgbColor;
    if (tintRole === "water") return [...tint] as RgbColor;
    return [
        Math.round((baseColor[0] * tint[0]) / 255),
        Math.round((baseColor[1] * tint[1]) / 255),
        Math.round((baseColor[2] * tint[2]) / 255),
    ];
}

export function resolveTerrainColor(
    options: ResolveTerrainColorOptions,
): ResolveTerrainColorResult {
    const entry = TERRAIN_COLORS[normalizeBlockName(options.blockName)];
    if (!entry) {
        return {
            color: [...UNKNOWN_BLOCK_COLOR] as RgbColor,
            diagnostic: "unknown-block",
        };
    }

    const biomeTint = options.biomeName
        ? (BIOME_TINTS[normalizeBiomeName(options.biomeName)] ??
          BIOME_TINTS.default)
        : BIOME_TINTS.default;
    const tint = resolveTint(entry, biomeTint);
    const diagnostic = resolveDiagnostic(entry);

    return {
        color: applyBiomeTint(entry.baseColor, tint, entry.tintRole),
        ...(diagnostic ? { diagnostic } : {}),
    };
}

export function createTerrainPaletteUsageAudit(
    columns: Iterable<TerrainPaletteUsageColumn>,
): TerrainPaletteUsageAudit {
    const audit: TerrainPaletteUsageAudit = {
        schemaVersion: 1,
        columns: 0,
        blockCounts: {},
        tintRoleCounts: { none: 0, grass: 0, foliage: 0, water: 0 },
        diagnosticCounts: {
            "unknown-block": 0,
            fallback: 0,
            "variant-defaulted": 0,
        },
        unknownBlocks: {},
        fallbackBlocks: {},
        variantDefaultedBlocks: {},
        tintableBlocksWithoutBiome: {},
        untintedVegetationCandidates: {},
    };

    for (const column of columns) {
        const blockName = normalizeBlockName(column.blockName);
        const entry = TERRAIN_COLORS[blockName];
        const resolved = resolveTerrainColor(column);
        audit.columns += 1;
        increment(audit.blockCounts, blockName);

        if (!entry) {
            audit.diagnosticCounts["unknown-block"] += 1;
            increment(audit.unknownBlocks, blockName);
            continue;
        }

        audit.tintRoleCounts[entry.tintRole ?? "none"] += 1;
        if (entry.tintRole && !column.biomeName) {
            increment(audit.tintableBlocksWithoutBiome, blockName);
        }
        if (!entry.tintRole && isUntintedVegetationCandidate(blockName)) {
            increment(audit.untintedVegetationCandidates, blockName);
        }
        if (resolved.diagnostic === "fallback") {
            audit.diagnosticCounts.fallback += 1;
            increment(audit.fallbackBlocks, blockName);
        } else if (resolved.diagnostic === "variant-defaulted") {
            audit.diagnosticCounts["variant-defaulted"] += 1;
            increment(audit.variantDefaultedBlocks, blockName);
        }
    }

    return {
        ...audit,
        blockCounts: sortRecord(audit.blockCounts),
        unknownBlocks: sortRecord(audit.unknownBlocks),
        fallbackBlocks: sortRecord(audit.fallbackBlocks),
        variantDefaultedBlocks: sortRecord(audit.variantDefaultedBlocks),
        tintableBlocksWithoutBiome: sortRecord(
            audit.tintableBlocksWithoutBiome,
        ),
        untintedVegetationCandidates: sortRecord(
            audit.untintedVegetationCandidates,
        ),
    };
}

function resolveTint(
    entry: GeneratedTerrainColor,
    biomeTint: GeneratedBiomeTint | undefined,
): readonly [number, number, number] | undefined {
    if (entry.tintRole === "grass") return biomeTint?.grass;
    if (entry.tintRole === "foliage") return biomeTint?.foliage;
    if (entry.tintRole === "water") return biomeTint?.water;
    return undefined;
}

function resolveDiagnostic(
    entry: GeneratedTerrainColor,
): ResolveTerrainColorResult["diagnostic"] {
    if (entry.confidence === "fallback") return "fallback";
    if (entry.confidence === "variant-defaulted") return "variant-defaulted";
    return undefined;
}

function normalizeBlockName(blockName: string): string {
    const namespaced = blockName.includes(":")
        ? blockName
        : `minecraft:${blockName}`;
    return BLOCK_NAME_ALIASES[namespaced] ?? namespaced;
}

function normalizeBiomeName(biomeName: string): string {
    return biomeName.includes(":") ? biomeName : `minecraft:${biomeName}`;
}

function isUntintedVegetationCandidate(blockName: string): boolean {
    return (
        VEGETATION_CANDIDATE_PATTERN.test(blockName) &&
        !VEGETATION_CANDIDATE_EXCLUDE_PATTERN.test(blockName)
    );
}

function increment(record: Record<string, number>, key: string): void {
    record[key] = (record[key] ?? 0) + 1;
}

function sortRecord(record: Record<string, number>): Record<string, number> {
    return Object.fromEntries(
        Object.entries(record).sort(([left], [right]) =>
            left.localeCompare(right),
        ),
    );
}
