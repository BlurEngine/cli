import { copyFile, readFile, writeFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import * as prismarineNbt from "prismarine-nbt";
import { ensureParentDirectory, exists } from "./fs.js";

const LEVEL_DAT_HEADER_BYTE_LENGTH = 8;
const LEVEL_DAT_STORAGE_VERSION_OFFSET = 0;
const LEVEL_DAT_PAYLOAD_LENGTH_OFFSET = 4;
const BEDROCK_LEVEL_DAT_NBT_FORMAT: prismarineNbt.NBTFormat = "little";

export type BedrockLevelDat = {
    storageVersion: number;
    payloadLength: number;
    data: prismarineNbt.NBT;
};

export type BedrockLevelDatDumpFormat = "simplified" | "typed";

export type BedrockLevelDatTypedDump = {
    fileType: "bedrock-level-dat";
    nbtFormat: prismarineNbt.NBTFormat;
    storageVersion: number;
    payloadLength: number;
    data: prismarineNbt.NBT;
};

export type BedrockLevelDatSimplifiedDump = {
    fileType: "bedrock-level-dat";
    nbtFormat: prismarineNbt.NBTFormat;
    storageVersion: number;
    payloadLength: number;
    rootName: string;
    data: unknown;
};

export type BedrockLevelDatDump =
    | BedrockLevelDatTypedDump
    | BedrockLevelDatSimplifiedDump;

export type BedrockLevelDatDiffValue = {
    type: string;
    value: unknown;
};

export type BedrockLevelDatDiffEntry = {
    kind: "added" | "removed" | "changed";
    path: string;
    left?: BedrockLevelDatDiffValue;
    right?: BedrockLevelDatDiffValue;
};

export type BedrockLevelDatDiff = {
    fileType: "bedrock-level-dat-diff";
    nbtFormat: prismarineNbt.NBTFormat;
    identical: boolean;
    left: {
        storageVersion: number;
        payloadLength: number;
        rootName: string;
    };
    right: {
        storageVersion: number;
        payloadLength: number;
        rootName: string;
    };
    metadata: BedrockLevelDatDiffEntry[];
    data: BedrockLevelDatDiffEntry[];
};

export type WriteBedrockLevelDatFileOptions = {
    backup?: boolean;
    backupPath?: string;
};

export type WriteBedrockLevelDatFileResult = {
    backupPath?: string;
    byteLength: number;
};

type ComparableNbtTag = {
    name?: string;
    type: string;
    value: unknown;
};

function assertValidStorageVersion(value: number): number {
    if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
        throw new Error(
            `Expected a uint32 storageVersion value, received "${value}".`,
        );
    }

    return value;
}

function assertHasBedrockLevelDatHeader(buffer: Buffer): void {
    if (buffer.byteLength < LEVEL_DAT_HEADER_BYTE_LENGTH) {
        throw new Error(
            "Cannot parse level.dat because it is too small to contain the Bedrock header.",
        );
    }
}

export function parseBedrockLevelDat(buffer: Buffer): BedrockLevelDat {
    assertHasBedrockLevelDatHeader(buffer);

    const storageVersion = buffer.readUInt32LE(
        LEVEL_DAT_STORAGE_VERSION_OFFSET,
    );
    const payloadLength = buffer.readUInt32LE(LEVEL_DAT_PAYLOAD_LENGTH_OFFSET);
    const payload = buffer.subarray(LEVEL_DAT_HEADER_BYTE_LENGTH);

    if (payload.byteLength !== payloadLength) {
        throw new Error(
            `Cannot parse level.dat because its Bedrock header declares ${payloadLength} payload bytes but the file contains ${payload.byteLength}.`,
        );
    }

    return {
        storageVersion,
        payloadLength,
        data: prismarineNbt.parseUncompressed(
            payload,
            BEDROCK_LEVEL_DAT_NBT_FORMAT,
        ),
    };
}

export async function readBedrockLevelDatFile(
    targetPath: string,
): Promise<BedrockLevelDat> {
    return parseBedrockLevelDat(await readFile(targetPath));
}

function createBackupSuffix(now: Date): string {
    return now.toISOString().replaceAll(":", "").replaceAll(".", "");
}

export async function createBedrockLevelDatBackupPath(
    targetPath: string,
    now = new Date(),
): Promise<string> {
    const suffix = createBackupSuffix(now);
    let candidate = `${targetPath}.blr-backup-${suffix}`;
    let counter = 1;

    while (await exists(candidate)) {
        candidate = `${targetPath}.blr-backup-${suffix}-${counter}`;
        counter += 1;
    }

    return candidate;
}

export function serializeBedrockLevelDat(input: {
    storageVersion: number;
    data: prismarineNbt.NBT;
}): Buffer {
    const storageVersion = assertValidStorageVersion(input.storageVersion);
    const payload = prismarineNbt.writeUncompressed(
        input.data,
        BEDROCK_LEVEL_DAT_NBT_FORMAT,
    );
    const result = Buffer.alloc(LEVEL_DAT_HEADER_BYTE_LENGTH + payload.length);

    result.writeUInt32LE(storageVersion, LEVEL_DAT_STORAGE_VERSION_OFFSET);
    result.writeUInt32LE(payload.length, LEVEL_DAT_PAYLOAD_LENGTH_OFFSET);
    payload.copy(result, LEVEL_DAT_HEADER_BYTE_LENGTH);

    return result;
}

export function createBedrockLevelDatDump(
    levelDat: BedrockLevelDat,
    format: BedrockLevelDatDumpFormat,
): BedrockLevelDatDump {
    const shared = {
        fileType: "bedrock-level-dat" as const,
        nbtFormat: BEDROCK_LEVEL_DAT_NBT_FORMAT,
        storageVersion: levelDat.storageVersion,
        payloadLength: levelDat.payloadLength,
    };

    if (format === "typed") {
        return {
            ...shared,
            data: levelDat.data,
        };
    }

    return {
        ...shared,
        rootName: levelDat.data.name,
        data: prismarineNbt.simplify(levelDat.data),
    };
}

function trySimplifyNbtTag(tag: ComparableNbtTag): unknown {
    try {
        return prismarineNbt.simplify(tag as prismarineNbt.NBT);
    } catch {
        return tag.value;
    }
}

function summarizeNbtTag(tag: ComparableNbtTag): BedrockLevelDatDiffValue {
    return {
        type: tag.type,
        value: trySimplifyNbtTag(tag),
    };
}

function isCompoundTag(
    tag: ComparableNbtTag | undefined,
): tag is ComparableNbtTag & { value: Record<string, ComparableNbtTag> } {
    return (
        tag?.type === "compound" &&
        Boolean(tag.value) &&
        typeof tag.value === "object" &&
        !Array.isArray(tag.value)
    );
}

function collectNbtDiffEntries(
    left: ComparableNbtTag | undefined,
    right: ComparableNbtTag | undefined,
    currentPath: string,
): BedrockLevelDatDiffEntry[] {
    if (!left && !right) {
        return [];
    }

    if (!left && right) {
        return [
            {
                kind: "added",
                path: currentPath,
                right: summarizeNbtTag(right),
            },
        ];
    }

    if (left && !right) {
        return [
            {
                kind: "removed",
                path: currentPath,
                left: summarizeNbtTag(left),
            },
        ];
    }

    if (!left || !right) {
        return [];
    }

    if (left.type !== right.type) {
        return [
            {
                kind: "changed",
                path: currentPath,
                left: summarizeNbtTag(left),
                right: summarizeNbtTag(right),
            },
        ];
    }

    if (isCompoundTag(left) && isCompoundTag(right)) {
        const entries: BedrockLevelDatDiffEntry[] = [];
        const fieldNames = Array.from(
            new Set([...Object.keys(left.value), ...Object.keys(right.value)]),
        ).sort((leftField, rightField) => leftField.localeCompare(rightField));

        for (const fieldName of fieldNames) {
            entries.push(
                ...collectNbtDiffEntries(
                    left.value[fieldName],
                    right.value[fieldName],
                    currentPath ? `${currentPath}.${fieldName}` : fieldName,
                ),
            );
        }

        return entries;
    }

    if (isDeepStrictEqual(left.value, right.value)) {
        return [];
    }

    return [
        {
            kind: "changed",
            path: currentPath,
            left: summarizeNbtTag(left),
            right: summarizeNbtTag(right),
        },
    ];
}

function createMetadataDiffEntries(
    left: BedrockLevelDat,
    right: BedrockLevelDat,
): BedrockLevelDatDiffEntry[] {
    const entries: BedrockLevelDatDiffEntry[] = [];

    if (left.storageVersion !== right.storageVersion) {
        entries.push({
            kind: "changed",
            path: "$storageVersion",
            left: {
                type: "uint32",
                value: left.storageVersion,
            },
            right: {
                type: "uint32",
                value: right.storageVersion,
            },
        });
    }

    if (left.payloadLength !== right.payloadLength) {
        entries.push({
            kind: "changed",
            path: "$payloadLength",
            left: {
                type: "uint32",
                value: left.payloadLength,
            },
            right: {
                type: "uint32",
                value: right.payloadLength,
            },
        });
    }

    if (left.data.name !== right.data.name) {
        entries.push({
            kind: "changed",
            path: "$rootName",
            left: {
                type: "string",
                value: left.data.name,
            },
            right: {
                type: "string",
                value: right.data.name,
            },
        });
    }

    return entries;
}

export function createBedrockLevelDatDiff(
    left: BedrockLevelDat,
    right: BedrockLevelDat,
): BedrockLevelDatDiff {
    const metadata = createMetadataDiffEntries(left, right);
    const data = collectNbtDiffEntries(left.data, right.data, "");

    return {
        fileType: "bedrock-level-dat-diff",
        nbtFormat: BEDROCK_LEVEL_DAT_NBT_FORMAT,
        identical: metadata.length === 0 && data.length === 0,
        left: {
            storageVersion: left.storageVersion,
            payloadLength: left.payloadLength,
            rootName: left.data.name,
        },
        right: {
            storageVersion: right.storageVersion,
            payloadLength: right.payloadLength,
            rootName: right.data.name,
        },
        metadata,
        data,
    };
}

function formatDiffValue(value: BedrockLevelDatDiffValue | undefined): string {
    if (!value) {
        return "(unknown)";
    }

    const rendered =
        typeof value.value === "string"
            ? JSON.stringify(value.value)
            : (JSON.stringify(value.value) ?? String(value.value));
    return `(${value.type}) ${rendered}`;
}

function renderDiffSection(
    heading: string,
    entries: BedrockLevelDatDiffEntry[],
): string[] {
    if (entries.length === 0) {
        return [];
    }

    const lines = [heading];
    for (const entry of entries) {
        if (entry.kind === "added") {
            lines.push(`+ ${entry.path} ${formatDiffValue(entry.right)}`);
            continue;
        }

        if (entry.kind === "removed") {
            lines.push(`- ${entry.path} ${formatDiffValue(entry.left)}`);
            continue;
        }

        lines.push(`~ ${entry.path}`);
        lines.push(`  - ${formatDiffValue(entry.left)}`);
        lines.push(`  + ${formatDiffValue(entry.right)}`);
    }

    return lines;
}

export function renderBedrockLevelDatDiff(
    diff: BedrockLevelDatDiff,
    labels?: {
        left: string;
        right: string;
    },
): string {
    const lines: string[] = [];

    if (labels) {
        lines.push(`--- ${labels.left}`);
        lines.push(`+++ ${labels.right}`);
    }

    if (diff.identical) {
        lines.push("No level.dat differences found.");
        return lines.join("\n");
    }

    const metadataLines = renderDiffSection("@@ metadata @@", diff.metadata);
    const dataLines = renderDiffSection("@@ data @@", diff.data);

    if (metadataLines.length > 0) {
        lines.push(...metadataLines);
    }

    if (metadataLines.length > 0 && dataLines.length > 0) {
        lines.push("");
    }

    if (dataLines.length > 0) {
        lines.push(...dataLines);
    }

    return lines.join("\n");
}

export async function writeBedrockLevelDatFile(
    targetPath: string,
    input: {
        storageVersion: number;
        data: prismarineNbt.NBT;
    },
    options: WriteBedrockLevelDatFileOptions = {},
): Promise<WriteBedrockLevelDatFileResult> {
    await ensureParentDirectory(targetPath);
    const payload = serializeBedrockLevelDat(input);
    const shouldBackup = options.backup ?? true;
    let backupPath = options.backupPath;

    if (shouldBackup) {
        backupPath =
            backupPath ?? (await createBedrockLevelDatBackupPath(targetPath));
        await copyFile(targetPath, backupPath);
    }

    await writeFile(targetPath, payload);

    return {
        backupPath,
        byteLength: payload.byteLength,
    };
}
