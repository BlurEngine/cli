import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

export type BedrockDimension = "overworld" | "nether" | "the_end";

export type DimensionVectorXZ = {
    x: number;
    z: number;
    dimension: BedrockDimension | number;
};

export type SubChunkIndexDimensionVectorXZ = DimensionVectorXZ & {
    subChunkIndex?: number;
};

export type BiomePalette = {
    values: number[] | null;
    palette: number[];
};

export type McbeLeveldbHelpers = {
    readData3dValue(rawvalue: Uint8Array | null): {
        heightMap: number[][];
        biomes: BiomePalette[];
    } | null;
    writeData3DValue(heightMap: number[][], biomes: BiomePalette[]): Buffer;
    getChunkKeyIndices(key: Buffer): SubChunkIndexDimensionVectorXZ;
    generateChunkKeyFromIndices(
        indices: SubChunkIndexDimensionVectorXZ,
        chunkKeyType: "Data3D" | "SubChunkPrefix" | "BlockEntity",
    ): Buffer;
    getContentTypeFromDBKey(key: Buffer): string;
    getBiomeTypeFromID(id: number): string | undefined;
    entryContentTypeToFormatMap: {
        SubChunkPrefix: {
            parse(data: Buffer): Promise<unknown>;
            serialize(data: unknown): Buffer;
        };
        BlockEntity: {
            parse(data: Buffer): Promise<{
                type: "compound";
                value: {
                    blockEntities: {
                        type: "list";
                        value: {
                            type: "compound";
                            value: Record<string, unknown>[];
                        };
                    };
                };
            }>;
            serialize(data: unknown): Buffer;
        };
    };
};

let loadedHelpers: Promise<McbeLeveldbHelpers> | undefined;

function assertFunction(
    moduleName: string,
    moduleValue: Record<string, unknown>,
    exportName: keyof McbeLeveldbHelpers,
): void {
    if (typeof moduleValue[exportName] !== "function") {
        throw new Error(
            `${moduleName} did not provide the expected ${String(exportName)} export.`,
        );
    }
}

function assertSubChunkPrefixFormat(
    moduleName: string,
    moduleValue: Record<string, unknown>,
): void {
    const formats = moduleValue.entryContentTypeToFormatMap;
    if (!formats || typeof formats !== "object") {
        throw new Error(
            `${moduleName} did not provide the expected entryContentTypeToFormatMap export.`,
        );
    }
    const subChunkPrefix = (
        formats as Record<string, Record<string, unknown> | undefined>
    ).SubChunkPrefix;
    if (
        !subChunkPrefix ||
        typeof subChunkPrefix.parse !== "function" ||
        typeof subChunkPrefix.serialize !== "function"
    ) {
        throw new Error(
            `${moduleName} did not provide the expected SubChunkPrefix parse and serialize helpers.`,
        );
    }
}

function assertBlockEntityFormat(
    moduleName: string,
    moduleValue: Record<string, unknown>,
): void {
    const formats = moduleValue.entryContentTypeToFormatMap;
    const blockEntity =
        formats && typeof formats === "object"
            ? (formats as Record<string, Record<string, unknown> | undefined>)
                  .BlockEntity
            : undefined;
    if (
        !blockEntity ||
        typeof blockEntity.parse !== "function" ||
        typeof blockEntity.serialize !== "function"
    ) {
        throw new Error(
            `${moduleName} did not provide the expected BlockEntity parse and serialize helpers.`,
        );
    }
}

async function loadHelpers(): Promise<McbeLeveldbHelpers> {
    const require = createRequire(import.meta.url);
    const modulePath = require.resolve("mcbe-leveldb");
    const moduleValue = (await import(
        pathToFileURL(modulePath).href
    )) as Record<string, unknown>;
    const moduleName = "mcbe-leveldb";

    assertFunction(moduleName, moduleValue, "readData3dValue");
    assertFunction(moduleName, moduleValue, "writeData3DValue");
    assertFunction(moduleName, moduleValue, "getChunkKeyIndices");
    assertFunction(moduleName, moduleValue, "generateChunkKeyFromIndices");
    assertFunction(moduleName, moduleValue, "getContentTypeFromDBKey");
    assertFunction(moduleName, moduleValue, "getBiomeTypeFromID");
    assertSubChunkPrefixFormat(moduleName, moduleValue);
    assertBlockEntityFormat(moduleName, moduleValue);

    const helpers = moduleValue as McbeLeveldbHelpers;
    return Object.freeze({
        readData3dValue: helpers.readData3dValue,
        writeData3DValue: helpers.writeData3DValue,
        getChunkKeyIndices: helpers.getChunkKeyIndices,
        generateChunkKeyFromIndices(
            indices: Parameters<
                McbeLeveldbHelpers["generateChunkKeyFromIndices"]
            >[0],
            chunkKeyType: Parameters<
                McbeLeveldbHelpers["generateChunkKeyFromIndices"]
            >[1],
        ) {
            return helpers.generateChunkKeyFromIndices(
                { ...indices },
                chunkKeyType,
            );
        },
        getContentTypeFromDBKey: helpers.getContentTypeFromDBKey,
        getBiomeTypeFromID: helpers.getBiomeTypeFromID,
        entryContentTypeToFormatMap: helpers.entryContentTypeToFormatMap,
    });
}

export function loadMcbeLeveldbHelpers(): Promise<McbeLeveldbHelpers> {
    loadedHelpers ??= loadHelpers();
    return loadedHelpers;
}
