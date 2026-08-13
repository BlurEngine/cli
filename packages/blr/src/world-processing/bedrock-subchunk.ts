import NBT from "prismarine-nbt";
import type { WorldBlockPaletteEntry } from "../world-processing.js";

const SUPPORTED_STORAGE_HEADERS = new Set([2, 4, 6, 8, 10, 12, 16]);

export type DecodedBedrockSubchunkLayer = {
    readonly storageHeader: number;
    readonly bitsPerBlock: number;
    readonly blocksPerWord: number;
    readonly palette: readonly WorldBlockPaletteEntry[];
    /** Exact little-endian NBT bytes for each palette entry. */
    readonly paletteEntryBytes: readonly Buffer[];
    /** Exact source bytes for this entire storage layer. */
    readonly rawBytes: Buffer;
    readonly indices: Uint16Array;
};

export type DecodedBedrockSubchunk = {
    readonly formatVersion: 1 | 8 | 9;
    readonly subChunkY: number | undefined;
    readonly layers: readonly DecodedBedrockSubchunkLayer[];
};

export type DecodeBedrockSubchunkOptions = {
    readonly allowedFormatVersions?: readonly (1 | 8 | 9)[];
    /** Required for formats before v9 because Y is stored only in the DB key. */
    readonly subChunkY?: number;
};

/**
 * Strictly decodes the packed Bedrock SubChunkPrefix representation used by
 * world processors. The default observation contract accepts v9 only;
 * compatibility callers must opt into older formats explicitly.
 */
export async function decodeBedrockSubchunk(
    input: Uint8Array,
    options: DecodeBedrockSubchunkOptions = {},
): Promise<DecodedBedrockSubchunk> {
    const data = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
    let offset = 0;
    const formatVersion = readByte(data, offset, "subchunk format");
    offset += 1;
    const allowed = options.allowedFormatVersions ?? [9];
    if (
        (formatVersion !== 1 && formatVersion !== 8 && formatVersion !== 9) ||
        !allowed.includes(formatVersion)
    ) {
        throw new Error(`Unsupported subchunk format ${formatVersion}.`);
    }

    let layerCount = 1;
    if (formatVersion >= 8) {
        layerCount = readByte(data, offset, "storage layer count");
        offset += 1;
        if (layerCount < 1) {
            throw new Error("Subchunk storage layer count must be positive.");
        }
    }

    let subChunkY = options.subChunkY;
    if (formatVersion >= 9) {
        ensureAvailable(data, offset, 1, "embedded subchunk Y");
        subChunkY = data.readInt8(offset);
        offset += 1;
    } else if (!Number.isInteger(subChunkY)) {
        throw new Error(
            `Subchunk format ${formatVersion} requires subChunkY from its DB key.`,
        );
    }

    const layers: DecodedBedrockSubchunkLayer[] = [];
    for (let layerIndex = 0; layerIndex < layerCount; layerIndex += 1) {
        const result = await decodeLayer(data, offset, layerIndex);
        offset = result.offset;
        layers.push(result.layer);
    }
    if (offset !== data.length) {
        throw new Error(
            `Subchunk has ${data.length - offset} unexpected trailing byte(s).`,
        );
    }

    return Object.freeze({
        formatVersion,
        subChunkY,
        layers: Object.freeze(layers),
    });
}

async function decodeLayer(
    data: Buffer,
    initialOffset: number,
    layerIndex: number,
): Promise<{
    readonly layer: DecodedBedrockSubchunkLayer;
    readonly offset: number;
}> {
    let offset = initialOffset;
    const storageHeader = readByte(
        data,
        offset,
        `storage header for layer ${layerIndex}`,
    );
    offset += 1;
    if (!SUPPORTED_STORAGE_HEADERS.has(storageHeader)) {
        throw new Error(
            `Unsupported packed storage header ${storageHeader} in layer ${layerIndex}.`,
        );
    }

    const bitsPerBlock = storageHeader >> 1;
    const blocksPerWord = Math.floor(32 / bitsPerBlock);
    const wordCount = Math.ceil(4096 / blocksPerWord);
    const blockDataOffset = offset;
    const blockDataLength = wordCount * 4;
    ensureAvailable(
        data,
        blockDataOffset,
        blockDataLength,
        `block indices for layer ${layerIndex}`,
    );
    offset += blockDataLength;

    ensureAvailable(data, offset, 4, `palette size for layer ${layerIndex}`);
    const paletteSize = data.readInt32LE(offset);
    offset += 4;
    if (paletteSize < 1 || paletteSize > 1 << bitsPerBlock) {
        throw new Error(
            `Palette size ${paletteSize} is invalid for ${bitsPerBlock}-bit layer ${layerIndex}.`,
        );
    }

    const palette: WorldBlockPaletteEntry[] = [];
    const paletteEntryBytes: Buffer[] = [];
    for (let paletteIndex = 0; paletteIndex < paletteSize; paletteIndex += 1) {
        const entryOffset = offset;
        const result = (await NBT.parse(
            data.subarray(offset),
            "little",
        )) as NbtParseResult;
        const size = result.metadata?.size;
        if (typeof size !== "number" || !Number.isInteger(size) || size <= 0) {
            throw new Error(
                `Palette entry ${paletteIndex} in layer ${layerIndex} is invalid.`,
            );
        }
        offset += size;
        paletteEntryBytes.push(Buffer.from(data.subarray(entryOffset, offset)));
        palette.push(
            normalizePaletteEntry(
                result.parsed,
                `layer ${layerIndex} palette ${paletteIndex}`,
            ),
        );
    }

    const indices = new Uint16Array(4096);
    const paletteMask = (1 << bitsPerBlock) - 1;
    for (let blockIndex = 0; blockIndex < 4096; blockIndex += 1) {
        const wordOffset =
            blockDataOffset + Math.floor(blockIndex / blocksPerWord) * 4;
        const shift = (blockIndex % blocksPerWord) * bitsPerBlock;
        const paletteIndex =
            (data.readUInt32LE(wordOffset) >>> shift) & paletteMask;
        if (paletteIndex >= palette.length) {
            throw new Error(
                `Block ${blockIndex} references palette index ${paletteIndex}, but layer ${layerIndex} palette size is ${palette.length}.`,
            );
        }
        indices[blockIndex] = paletteIndex;
    }

    return {
        layer: Object.freeze({
            storageHeader,
            bitsPerBlock,
            blocksPerWord,
            palette: Object.freeze(palette),
            paletteEntryBytes: Object.freeze(paletteEntryBytes),
            rawBytes: Buffer.from(data.subarray(initialOffset, offset)),
            indices,
        }),
        offset,
    };
}

type NbtParseResult = {
    readonly parsed?: unknown;
    readonly metadata?: { readonly size?: number };
};

function normalizePaletteEntry(
    parsed: unknown,
    source: string,
): WorldBlockPaletteEntry {
    const root = getNbtCompoundValue(parsed, source);
    const typeId = getNbtString(root.name, `${source}.name`);
    const version = getNbtNumber(root.version, `${source}.version`);
    const stateTags = getNbtCompoundValue(root.states, `${source}.states`);
    const states: Record<string, boolean | number | string> = {};
    for (const key of Object.keys(stateTags).sort()) {
        const tag = getNbtTag(stateTags[key], `${source}.states.${key}`);
        if (tag.type === "string") {
            if (typeof tag.value !== "string") {
                throw new Error(`${source}.states.${key} is not a string.`);
            }
            states[key] = tag.value;
        } else if (
            tag.type === "byte" &&
            (tag.value === 0 || tag.value === 1)
        ) {
            states[key] = tag.value === 1;
        } else if (
            (tag.type === "byte" ||
                tag.type === "short" ||
                tag.type === "int") &&
            typeof tag.value === "number" &&
            Number.isFinite(tag.value)
        ) {
            states[key] = tag.value;
        } else {
            throw new Error(
                `${source}.states.${key} has unsupported NBT type ${tag.type}.`,
            );
        }
    }
    return Object.freeze({
        typeId,
        states: Object.freeze(states),
        version,
    });
}

function getNbtCompoundValue(
    input: unknown,
    source: string,
): Record<string, unknown> {
    const tag = getNbtTag(input, source);
    if (
        tag.type !== "compound" ||
        !tag.value ||
        typeof tag.value !== "object" ||
        Array.isArray(tag.value)
    ) {
        throw new Error(`${source} is not an NBT compound.`);
    }
    return tag.value as Record<string, unknown>;
}

function getNbtString(input: unknown, source: string): string {
    const tag = getNbtTag(input, source);
    if (tag.type !== "string" || typeof tag.value !== "string") {
        throw new Error(`${source} is not an NBT string.`);
    }
    return tag.value;
}

function getNbtNumber(input: unknown, source: string): number {
    const tag = getNbtTag(input, source);
    if (typeof tag.value !== "number" || !Number.isFinite(tag.value)) {
        throw new Error(`${source} is not a finite NBT number.`);
    }
    return tag.value;
}

function getNbtTag(
    input: unknown,
    source: string,
): { readonly type: string; readonly value: unknown } {
    if (
        !input ||
        typeof input !== "object" ||
        !("type" in input) ||
        !("value" in input) ||
        typeof (input as { type?: unknown }).type !== "string"
    ) {
        throw new Error(`${source} is not a valid NBT tag.`);
    }
    return input as { readonly type: string; readonly value: unknown };
}

function readByte(data: Buffer, offset: number, source: string): number {
    ensureAvailable(data, offset, 1, source);
    return data.readUInt8(offset);
}

function ensureAvailable(
    data: Buffer,
    offset: number,
    count: number,
    source: string,
): void {
    if (offset < 0 || count < 0 || offset + count > data.length) {
        throw new Error(`Subchunk ${source} is truncated.`);
    }
}
