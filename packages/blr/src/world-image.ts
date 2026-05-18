import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import {
    copyDirectory,
    isDirectory,
    removeDirectory,
    removePath,
    writeJson,
} from "./fs.js";
import {
    readBedrockWorldHeightmap,
    type WorldHeightmap,
} from "./world-image-bedrock.js";
import {
    normalizeWorldImageDimension,
    type WorldImageDimension,
} from "./world-image-dimension.js";
import { writePngImage, type RgbaImageData } from "./world-image-png.js";
import {
    readBedrockWorldImageData,
    type WorldLoadedColumns,
    type WorldTerrainColumns,
} from "./world-terrain-bedrock.js";
import {
    createTerrainPaletteUsageAudit,
    resolveTerrainColor,
    type TerrainPaletteUsageAudit,
} from "./world-terrain-colors.js";

export {
    readBedrockWorldHeightmap,
    type WorldHeightColumn,
    type WorldHeightmap,
} from "./world-image-bedrock.js";
export {
    normalizeWorldImageDimension,
    type WorldImageDimension,
} from "./world-image-dimension.js";
export { writePngImage, type RgbaImageData } from "./world-image-png.js";

export type RenderWorldHeightmapImageOptions = {
    scale?: number;
    dimension?: WorldImageDimension;
};

export type RenderWorldTerrainFullImageOptions =
    RenderWorldHeightmapImageOptions & {
        shading?: WorldTerrainShadeMap;
    };

export type ExportWorldImageOptions = {
    worldSourceDirectory: string;
    outputPath: string;
    dimension?: WorldImageDimension;
    scale?: number;
    onTimingStage?: (stage: WorldImageTimingStage) => void;
};

export type WorldImageVariant = "loaded-columns" | "terrain" | "shade" | "full";

export type WorldImageTimingStage = {
    name: string;
    ms: number;
};

export type WorldImageTimings = {
    totalMs: number;
    stages: WorldImageTimingStage[];
};

export type ExportedWorldImageFile = {
    variant: WorldImageVariant;
    outputPath: string;
    width: number;
    height: number;
};

export type ExportWorldImageResult = {
    outputPath: string;
    outputs: ExportedWorldImageFile[];
    dimension: WorldImageDimension;
    processedWorld: WorldImageProcessedWorld;
    width: number;
    height: number;
    chunkCount: number;
    columnCount: number;
    minHeight: number;
    maxHeight: number;
    terrainColumnCount: number;
    terrainDiagnostics: WorldTerrainColumns["diagnostics"];
    terrainPaletteAuditPath: string;
    terrainPaletteAudit: WorldTerrainPaletteAudit;
    timings: WorldImageTimings;
};

export type WorldImageProcessedWorld = {
    dimension: WorldImageDimension;
    bounds: WorldTerrainColumns["bounds"];
    width: number;
    height: number;
    scale: number;
    image: {
        width: number;
        height: number;
    };
    topY?: {
        min: number;
        max: number;
    };
};

export type WorldTerrainPaletteAudit = TerrainPaletteUsageAudit & {
    processedWorld: WorldImageProcessedWorld;
};

export type WorldTerrainShadeMap = {
    bounds: WorldTerrainColumns["bounds"];
    width: number;
    height: number;
    shades: Uint8Array;
};

const DEFAULT_WORLD_IMAGE_SCALE = 1;
const MAX_WORLD_IMAGE_SCALE = 16;
const DEFAULT_WORLD_IMAGE_FILE_NAME = "map.png";
const LOADED_COLUMN_COLOR: [number, number, number] = [74, 166, 183];
const TERRAIN_SHADE_NEUTRAL = 128;
const TERRAIN_SHADE_MIN = 83;
const TERRAIN_SHADE_MAX = 151;
const TERRAIN_SHADE_RELIEF_RANGE = 8;
const TERRAIN_HEIGHT_MISSING = -32768;
const RAW_HEIGHT_RANGES: Record<
    WorldImageDimension,
    { minHeight: number; maxHeight: number }
> = {
    overworld: { minHeight: -64, maxHeight: 320 },
    nether: { minHeight: 0, maxHeight: 128 },
    end: { minHeight: 0, maxHeight: 256 },
};

export function normalizeWorldImageScale(
    value: string | number | undefined,
    source = "scale",
): number {
    const parsed =
        typeof value === "undefined" || value === ""
            ? DEFAULT_WORLD_IMAGE_SCALE
            : Number(value);
    if (
        !Number.isInteger(parsed) ||
        parsed < 1 ||
        parsed > MAX_WORLD_IMAGE_SCALE
    ) {
        throw new Error(
            `${source} must be an integer from 1 to ${MAX_WORLD_IMAGE_SCALE}. Received "${value}".`,
        );
    }
    return parsed;
}

export function normalizeWorldImageFileName(
    value: string | undefined,
    source = "fileName",
): string {
    const fileName = (value ?? DEFAULT_WORLD_IMAGE_FILE_NAME).trim();
    if (
        fileName.length === 0 ||
        fileName === "." ||
        fileName === ".." ||
        path.basename(fileName) !== fileName ||
        /[<>:"/\\|?*\x00-\x1F]/.test(fileName)
    ) {
        throw new Error(
            `${source} must be a safe file name such as ${DEFAULT_WORLD_IMAGE_FILE_NAME}.`,
        );
    }
    if (path.extname(fileName).toLowerCase() !== ".png") {
        throw new Error(`${source} must end with .png.`);
    }
    return fileName;
}

function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}

function colorForNormalizedHeight(
    normalized: number,
): [number, number, number] {
    const shade = Math.round(clamp(normalized, 0, 1) * 255);
    return [shade, shade, shade];
}

function normalizeHeight(height: number, minHeight: number, maxHeight: number) {
    if (maxHeight <= minHeight) {
        return 0.5;
    }
    return clamp((height - minHeight) / (maxHeight - minHeight), 0, 1);
}

function resolveHeightRange(options: RenderWorldHeightmapImageOptions): {
    minHeight: number;
    maxHeight: number;
} {
    return RAW_HEIGHT_RANGES[
        normalizeWorldImageDimension(options.dimension, "dimension")
    ];
}

function setPixel(
    data: Uint8Array,
    width: number,
    x: number,
    y: number,
    color: [number, number, number],
): void {
    const offset = (y * width + x) * 4;
    data[offset] = color[0];
    data[offset + 1] = color[1];
    data[offset + 2] = color[2];
    data[offset + 3] = 255;
}

function setPixelRgba(
    data: Uint8Array,
    width: number,
    x: number,
    y: number,
    color: [number, number, number, number],
): void {
    const offset = (y * width + x) * 4;
    data[offset] = color[0];
    data[offset + 1] = color[1];
    data[offset + 2] = color[2];
    data[offset + 3] = color[3];
}

function renderWorldImageColumns(
    heightmap: WorldHeightmap,
    scale: number,
    colorForColumn: (height: number) => [number, number, number],
): RgbaImageData {
    const blockWidth = heightmap.bounds.maxX - heightmap.bounds.minX + 1;
    const blockHeight = heightmap.bounds.maxZ - heightmap.bounds.minZ + 1;
    const width = blockWidth * scale;
    const height = blockHeight * scale;
    const data = new Uint8Array(width * height * 4);

    for (const column of heightmap.columns) {
        const baseX = (column.x - heightmap.bounds.minX) * scale;
        const baseY = (column.z - heightmap.bounds.minZ) * scale;
        const color = colorForColumn(column.height);

        for (let offsetX = 0; offsetX < scale; offsetX += 1) {
            for (let offsetY = 0; offsetY < scale; offsetY += 1) {
                setPixel(data, width, baseX + offsetX, baseY + offsetY, color);
            }
        }
    }

    return {
        width,
        height,
        data,
    };
}

export function renderWorldLoadedColumnsImage(
    heightmap: WorldHeightmap,
    options: RenderWorldHeightmapImageOptions = {},
): RgbaImageData {
    return renderWorldImageColumns(
        heightmap,
        normalizeWorldImageScale(options.scale),
        () => LOADED_COLUMN_COLOR,
    );
}

export function renderWorldLoadedChunksImage(
    loadedColumns: WorldLoadedColumns,
    options: RenderWorldHeightmapImageOptions = {},
): RgbaImageData {
    const scale = normalizeWorldImageScale(options.scale);
    const blockWidth =
        loadedColumns.bounds.maxX - loadedColumns.bounds.minX + 1;
    const blockHeight =
        loadedColumns.bounds.maxZ - loadedColumns.bounds.minZ + 1;
    const width = blockWidth * scale;
    const height = blockHeight * scale;
    const data = new Uint8Array(width * height * 4);

    for (const chunk of loadedColumns.chunks) {
        const chunkMinX = chunk.chunkX * 16;
        const chunkMinZ = chunk.chunkZ * 16;
        for (let localX = 0; localX < 16; localX += 1) {
            for (let localZ = 0; localZ < 16; localZ += 1) {
                const baseX =
                    (chunkMinX + localX - loadedColumns.bounds.minX) * scale;
                const baseY =
                    (chunkMinZ + localZ - loadedColumns.bounds.minZ) * scale;
                for (let offsetX = 0; offsetX < scale; offsetX += 1) {
                    for (let offsetY = 0; offsetY < scale; offsetY += 1) {
                        setPixel(
                            data,
                            width,
                            baseX + offsetX,
                            baseY + offsetY,
                            LOADED_COLUMN_COLOR,
                        );
                    }
                }
            }
        }
    }

    return { width, height, data };
}

export function renderWorldHeightmapImage(
    heightmap: WorldHeightmap,
    options: RenderWorldHeightmapImageOptions = {},
): RgbaImageData {
    const range = resolveHeightRange(options);
    return renderWorldImageColumns(
        heightmap,
        normalizeWorldImageScale(options.scale),
        (height) =>
            colorForNormalizedHeight(
                normalizeHeight(height, range.minHeight, range.maxHeight),
            ),
    );
}

export function renderWorldTerrainImage(
    terrain: WorldTerrainColumns,
    options: RenderWorldHeightmapImageOptions = {},
): RgbaImageData {
    const scale = normalizeWorldImageScale(options.scale);
    const blockWidth = terrain.bounds.maxX - terrain.bounds.minX + 1;
    const blockHeight = terrain.bounds.maxZ - terrain.bounds.minZ + 1;
    const width = blockWidth * scale;
    const height = blockHeight * scale;
    const data = new Uint8Array(width * height * 4);

    for (const column of terrain.columns) {
        const color = resolveTerrainColor({
            blockName: column.blockName,
            biomeName: column.biomeName,
        }).color;
        const blockX = column.x - terrain.bounds.minX;
        const blockY = column.z - terrain.bounds.minZ;
        const baseX = blockX * scale;
        const baseY = blockY * scale;

        for (let offsetX = 0; offsetX < scale; offsetX += 1) {
            for (let offsetY = 0; offsetY < scale; offsetY += 1) {
                setPixel(data, width, baseX + offsetX, baseY + offsetY, color);
            }
        }
    }

    return {
        width,
        height,
        data,
    };
}

export function createWorldTerrainShadeMap(
    terrain: WorldTerrainColumns,
): WorldTerrainShadeMap {
    const width = terrain.bounds.maxX - terrain.bounds.minX + 1;
    const height = terrain.bounds.maxZ - terrain.bounds.minZ + 1;
    const heights = new Int16Array(width * height);
    heights.fill(TERRAIN_HEIGHT_MISSING);
    const shades = new Uint8Array(width * height);

    for (const column of terrain.columns) {
        const x = column.x - terrain.bounds.minX;
        const z = column.z - terrain.bounds.minZ;
        heights[z * width + x] = column.y;
    }

    for (const column of terrain.columns) {
        const x = column.x - terrain.bounds.minX;
        const z = column.z - terrain.bounds.minZ;
        const current = column.y;
        const west = readTerrainHeightOrCurrent(
            heights,
            width,
            height,
            x - 1,
            z,
            current,
        );
        const east = readTerrainHeightOrCurrent(
            heights,
            width,
            height,
            x + 1,
            z,
            current,
        );
        const north = readTerrainHeightOrCurrent(
            heights,
            width,
            height,
            x,
            z - 1,
            current,
        );
        const south = readTerrainHeightOrCurrent(
            heights,
            width,
            height,
            x,
            z + 1,
            current,
        );
        shades[z * width + x] = computeTerrainShadeByte(
            west,
            east,
            north,
            south,
        );
    }

    return {
        bounds: terrain.bounds,
        width,
        height,
        shades,
    };
}

function readTerrainHeightOrCurrent(
    heights: Int16Array,
    width: number,
    height: number,
    x: number,
    z: number,
    current: number,
): number {
    if (x < 0 || z < 0 || x >= width || z >= height) {
        return current;
    }
    const value = heights[z * width + x];
    return value === TERRAIN_HEIGHT_MISSING ? current : value;
}

function computeTerrainShadeByte(
    west: number,
    east: number,
    north: number,
    south: number,
): number {
    const relief = (west + north - east - south) / 2;
    const signal = clamp(relief / TERRAIN_SHADE_RELIEF_RANGE, -1, 1);
    if (signal >= 0) {
        return Math.round(
            TERRAIN_SHADE_NEUTRAL +
                signal * (TERRAIN_SHADE_MAX - TERRAIN_SHADE_NEUTRAL),
        );
    }
    return Math.round(
        TERRAIN_SHADE_NEUTRAL +
            signal * (TERRAIN_SHADE_NEUTRAL - TERRAIN_SHADE_MIN),
    );
}

export function renderWorldTerrainShadeMapImage(
    shadeMap: WorldTerrainShadeMap,
    options: RenderWorldHeightmapImageOptions = {},
): RgbaImageData {
    const scale = normalizeWorldImageScale(options.scale);
    const width = shadeMap.width * scale;
    const height = shadeMap.height * scale;
    const data = new Uint8Array(width * height * 4);

    for (let z = 0; z < shadeMap.height; z += 1) {
        for (let x = 0; x < shadeMap.width; x += 1) {
            const shade = shadeMap.shades[z * shadeMap.width + x];
            if (shade === 0) {
                continue;
            }
            const baseX = x * scale;
            const baseY = z * scale;
            for (let offsetX = 0; offsetX < scale; offsetX += 1) {
                for (let offsetY = 0; offsetY < scale; offsetY += 1) {
                    setPixel(data, width, baseX + offsetX, baseY + offsetY, [
                        shade,
                        shade,
                        shade,
                    ]);
                }
            }
        }
    }

    return { width, height, data };
}

export function renderWorldTerrainShadeImage(
    terrain: WorldTerrainColumns,
    options: RenderWorldHeightmapImageOptions = {},
): RgbaImageData {
    return renderWorldTerrainShadeMapImage(
        createWorldTerrainShadeMap(terrain),
        options,
    );
}

export function renderWorldTerrainFullImage(
    terrain: WorldTerrainColumns,
    options: RenderWorldTerrainFullImageOptions = {},
): RgbaImageData {
    const scale = normalizeWorldImageScale(options.scale);
    const shadeMap = options.shading ?? createWorldTerrainShadeMap(terrain);
    const blockWidth = terrain.bounds.maxX - terrain.bounds.minX + 1;
    const blockHeight = terrain.bounds.maxZ - terrain.bounds.minZ + 1;
    const width = blockWidth * scale;
    const height = blockHeight * scale;
    const data = new Uint8Array(width * height * 4);

    for (const column of terrain.columns) {
        const terrainColor = resolveTerrainColor({
            blockName: column.blockName,
            biomeName: column.biomeName,
        }).color;
        const blockX = column.x - terrain.bounds.minX;
        const blockY = column.z - terrain.bounds.minZ;
        const shade = shadeMap.shades[blockY * shadeMap.width + blockX] || 0;
        const color =
            shade > 0
                ? shadeTerrainColor(terrainColor, shade)
                : ([...terrainColor, 255] as [number, number, number, number]);
        const baseX = blockX * scale;
        const baseY = blockY * scale;

        for (let offsetX = 0; offsetX < scale; offsetX += 1) {
            for (let offsetY = 0; offsetY < scale; offsetY += 1) {
                setPixelRgba(
                    data,
                    width,
                    baseX + offsetX,
                    baseY + offsetY,
                    color,
                );
            }
        }
    }

    return { width, height, data };
}

function shadeTerrainColor(
    color: [number, number, number],
    shade: number,
): [number, number, number, number] {
    const factor = shade / TERRAIN_SHADE_NEUTRAL;
    return [
        clampColorByte(color[0] * factor),
        clampColorByte(color[1] * factor),
        clampColorByte(color[2] * factor),
        255,
    ];
}

function clampColorByte(value: number): number {
    return Math.round(clamp(value, 0, 255));
}

export function resolveDefaultWorldImageOutputPath(
    projectRoot: string,
    worldName: string,
    fileName = DEFAULT_WORLD_IMAGE_FILE_NAME,
): string {
    return path.resolve(
        projectRoot,
        "dist",
        "assets",
        "worlds",
        worldName,
        fileName,
    );
}

export function resolveWorldImageOutputPaths(
    outputPath: string,
): Record<WorldImageVariant, string> {
    const extension = path.extname(outputPath) || ".png";
    const stem = outputPath.slice(
        0,
        outputPath.length - path.extname(outputPath).length,
    );
    return {
        "loaded-columns": outputPath,
        terrain: `${stem}.terrain${extension}`,
        shade: `${stem}.shade${extension}`,
        full: `${stem}.full${extension}`,
    };
}

export function resolveWorldTerrainAuditOutputPath(
    terrainOutputPath: string,
): string {
    const extension = path.extname(terrainOutputPath);
    const stem = terrainOutputPath.slice(
        0,
        terrainOutputPath.length - extension.length,
    );
    return `${stem}.audit.json`;
}

function resolveLegacyWorldImageOutputPaths(outputPath: string): string[] {
    const extension = path.extname(outputPath) || ".png";
    const stem = outputPath.slice(
        0,
        outputPath.length - path.extname(outputPath).length,
    );
    return [`${stem}.height${extension}`, `${stem}.height.raw${extension}`];
}

export async function exportWorldImage(
    options: ExportWorldImageOptions,
): Promise<ExportWorldImageResult> {
    const dimension = normalizeWorldImageDimension(options.dimension);
    const scale = normalizeWorldImageScale(options.scale);
    const dbSourcePath = path.join(options.worldSourceDirectory, "db");
    if (!(await isDirectory(dbSourcePath))) {
        throw new Error(
            `Cannot export a world image because ${dbSourcePath} does not exist as a Bedrock LevelDB directory.`,
        );
    }

    const timer = createWorldImageTimer(options.onTimingStage);
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "blr-world-image-"));
    const tempDbPath = path.join(tempRoot, "db");
    let result: Omit<ExportWorldImageResult, "timings"> | undefined;
    try {
        await timer.measure("copy-db", () =>
            copyDirectory(dbSourcePath, tempDbPath),
        );
        const worldData = await timer.measure("read-world-image-data", () =>
            readBedrockWorldImageData({
                dbPath: tempDbPath,
                dimension,
            }),
        );
        const loadedColumns = worldData.loadedColumns;
        let terrain: WorldTerrainColumns | undefined = worldData.terrain;
        const loadedStats = {
            chunkCount: loadedColumns.chunkCount,
            columnCount: loadedColumns.columnCount,
            minHeight: loadedColumns.minHeight,
            maxHeight: loadedColumns.maxHeight,
        };
        const terrainStats = {
            columnCount: terrain.columns.length,
            diagnostics: terrain.diagnostics,
        };
        const processedWorld = createWorldImageProcessedWorld(
            terrain,
            dimension,
            scale,
        );
        const outputPaths = resolveWorldImageOutputPaths(options.outputPath);
        const outputs: ExportedWorldImageFile[] = [];

        {
            const image = timer.measureSync("render-loaded-columns", () =>
                renderWorldLoadedChunksImage(loadedColumns, { scale }),
            );
            await timer.measure("write-loaded-columns", () =>
                writePngImage(image, outputPaths["loaded-columns"]),
            );
            outputs.push({
                variant: "loaded-columns",
                outputPath: outputPaths["loaded-columns"],
                width: image.width,
                height: image.height,
            });
        }
        loadedColumns.chunks.length = 0;
        const primaryOutput = outputs[0];
        if (!primaryOutput) {
            throw new Error("Cannot export a world image without outputs.");
        }
        const terrainPaletteAudit: WorldTerrainPaletteAudit = timer.measureSync(
            "build-terrain-audit",
            () =>
                createWorldTerrainPaletteAudit(
                    terrain!.columns,
                    processedWorld,
                ),
        );
        const terrainPaletteAuditPath = resolveWorldTerrainAuditOutputPath(
            outputPaths.terrain,
        );
        await timer.measure("write-terrain-audit", () =>
            writeJson(terrainPaletteAuditPath, terrainPaletteAudit),
        );
        const shading = timer.measureSync("build-shading-map", () =>
            createWorldTerrainShadeMap(terrain!),
        );
        {
            const image = timer.measureSync("render-shade", () =>
                renderWorldTerrainShadeMapImage(shading, { scale }),
            );
            await timer.measure("write-shade", () =>
                writePngImage(image, outputPaths.shade),
            );
            outputs.push({
                variant: "shade",
                outputPath: outputPaths.shade,
                width: image.width,
                height: image.height,
            });
        }
        {
            const image = timer.measureSync("render-terrain", () =>
                renderWorldTerrainImage(terrain!, {
                    scale,
                    dimension,
                }),
            );
            await timer.measure("write-terrain", () =>
                writePngImage(image, outputPaths.terrain),
            );
            outputs.push({
                variant: "terrain",
                outputPath: outputPaths.terrain,
                width: image.width,
                height: image.height,
            });
        }
        {
            const image = timer.measureSync("render-full", () =>
                renderWorldTerrainFullImage(terrain!, {
                    scale,
                    dimension,
                    shading,
                }),
            );
            await timer.measure("write-full", () =>
                writePngImage(image, outputPaths.full),
            );
            outputs.push({
                variant: "full",
                outputPath: outputPaths.full,
                width: image.width,
                height: image.height,
            });
        }
        terrain.columns.length = 0;
        terrain = undefined;

        for (const legacyOutputPath of resolveLegacyWorldImageOutputPaths(
            options.outputPath,
        )) {
            await removePath(legacyOutputPath);
        }
        result = {
            outputPath: options.outputPath,
            outputs,
            dimension,
            processedWorld,
            width: primaryOutput.width,
            height: primaryOutput.height,
            chunkCount: loadedStats.chunkCount,
            columnCount: loadedStats.columnCount,
            minHeight: loadedStats.minHeight,
            maxHeight: loadedStats.maxHeight,
            terrainColumnCount: terrainStats.columnCount,
            terrainDiagnostics: terrainStats.diagnostics,
            terrainPaletteAuditPath,
            terrainPaletteAudit,
        };
    } finally {
        await timer.measure("cleanup", () => removeDirectory(tempRoot));
    }
    if (!result) {
        throw new Error("Cannot export a world image without a result.");
    }
    return {
        ...result,
        timings: timer.finish(),
    };
}

function createWorldImageProcessedWorld(
    terrain: WorldTerrainColumns,
    dimension: WorldImageDimension,
    scale: number,
): WorldImageProcessedWorld {
    const width = terrain.bounds.maxX - terrain.bounds.minX + 1;
    const height = terrain.bounds.maxZ - terrain.bounds.minZ + 1;
    const topY = resolveWorldTerrainTopYRange(terrain);
    return {
        dimension,
        bounds: { ...terrain.bounds },
        width,
        height,
        scale,
        image: {
            width: width * scale,
            height: height * scale,
        },
        ...(topY ? { topY } : {}),
    };
}

function createWorldTerrainPaletteAudit(
    columns: Iterable<{ blockName: string; biomeName?: string }>,
    processedWorld: WorldImageProcessedWorld,
): WorldTerrainPaletteAudit {
    const audit = createTerrainPaletteUsageAudit(columns);
    return {
        schemaVersion: audit.schemaVersion,
        processedWorld,
        columns: audit.columns,
        blockCounts: audit.blockCounts,
        tintRoleCounts: audit.tintRoleCounts,
        diagnosticCounts: audit.diagnosticCounts,
        unknownBlocks: audit.unknownBlocks,
        fallbackBlocks: audit.fallbackBlocks,
        variantDefaultedBlocks: audit.variantDefaultedBlocks,
        tintableBlocksWithoutBiome: audit.tintableBlocksWithoutBiome,
        untintedVegetationCandidates: audit.untintedVegetationCandidates,
    };
}

function resolveWorldTerrainTopYRange(
    terrain: WorldTerrainColumns,
): WorldImageProcessedWorld["topY"] | undefined {
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    for (const column of terrain.columns) {
        min = Math.min(min, column.y);
        max = Math.max(max, column.y);
    }
    if (!Number.isFinite(min) || !Number.isFinite(max)) {
        return undefined;
    }
    return { min, max };
}

function createWorldImageTimer(
    onTimingStage?: (stage: WorldImageTimingStage) => void,
): {
    measure<T>(name: string, callback: () => Promise<T>): Promise<T>;
    measureSync<T>(name: string, callback: () => T): T;
    finish(): WorldImageTimings;
} {
    const start = performance.now();
    const stages: WorldImageTimingStage[] = [];
    const pushStage = (name: string, startedAt: number) => {
        const stage = { name, ms: roundMs(performance.now() - startedAt) };
        stages.push(stage);
        onTimingStage?.(stage);
    };

    return {
        async measure(name, callback) {
            const startedAt = performance.now();
            try {
                return await callback();
            } finally {
                pushStage(name, startedAt);
            }
        },
        measureSync(name, callback) {
            const startedAt = performance.now();
            try {
                return callback();
            } finally {
                pushStage(name, startedAt);
            }
        },
        finish() {
            return {
                totalMs: roundMs(performance.now() - start),
                stages: [...stages],
            };
        },
    };
}

function roundMs(value: number): number {
    return Math.round(value * 100) / 100;
}
