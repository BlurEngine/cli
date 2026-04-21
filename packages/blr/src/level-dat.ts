import { copyFile, readFile, writeFile } from "node:fs/promises";
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

export type WriteBedrockLevelDatFileOptions = {
    backup?: boolean;
    backupPath?: string;
};

export type WriteBedrockLevelDatFileResult = {
    backupPath?: string;
    byteLength: number;
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
