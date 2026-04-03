import { createHash } from "node:crypto";
import path from "node:path";
import { DEFAULT_PROJECT_WORLDS_ROOT } from "./constants.js";
import { exists, readJson, writeJson } from "./fs.js";

export type TrackedProjectWorldEntry = {
    name: string;
    remoteFingerprint: string;
    versionId: string;
};

export type TrackedProjectWorldStateFile = {
    schemaVersion: 1;
    worlds: TrackedProjectWorldEntry[];
};

export type UpsertTrackedProjectWorldInput = {
    name: string;
    remoteFingerprint: string;
    versionId: string;
};

function createEmptyTrackedProjectWorldState(): TrackedProjectWorldStateFile {
    return {
        schemaVersion: 1,
        worlds: [],
    };
}

function resolveTrackedProjectWorldStatePath(projectRoot: string): string {
    return path.resolve(
        projectRoot,
        DEFAULT_PROJECT_WORLDS_ROOT,
        "worlds.json",
    );
}

function normalizeTrackedProjectWorldState(
    value: unknown,
): TrackedProjectWorldStateFile | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return undefined;
    }

    const record = value as Record<string, unknown>;
    if (record.schemaVersion !== 1 || !Array.isArray(record.worlds)) {
        return undefined;
    }

    const worlds = record.worlds
        .map((entry) => normalizeTrackedProjectWorldEntry(entry))
        .filter(
            (entry): entry is TrackedProjectWorldEntry =>
                typeof entry !== "undefined",
        )
        .sort((left, right) => left.name.localeCompare(right.name));

    return {
        schemaVersion: 1,
        worlds,
    };
}

function normalizeTrackedProjectWorldEntry(
    value: unknown,
): TrackedProjectWorldEntry | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return undefined;
    }

    const record = value as Record<string, unknown>;
    if (
        typeof record.name !== "string" ||
        typeof record.remoteFingerprint !== "string" ||
        typeof record.versionId !== "string"
    ) {
        return undefined;
    }

    const name = record.name.trim();
    const remoteFingerprint = record.remoteFingerprint.trim();
    const versionId = record.versionId.trim();
    if (
        name.length === 0 ||
        remoteFingerprint.length === 0 ||
        versionId.length === 0
    ) {
        return undefined;
    }

    return {
        name,
        remoteFingerprint,
        versionId,
    };
}

export function buildTrackedProjectWorldFingerprint(input: {
    backend: "s3";
    bucket: string;
    endpoint?: string;
    objectKey: string;
}): string {
    const serialized = JSON.stringify({
        backend: input.backend,
        bucket: input.bucket.trim(),
        endpoint: input.endpoint?.trim() ?? "",
        objectKey: input.objectKey.trim(),
    });
    const hash = createHash("sha256").update(serialized).digest("hex");
    return `sha256:${hash}`;
}

export async function readTrackedProjectWorldState(
    projectRoot: string,
): Promise<TrackedProjectWorldStateFile | undefined> {
    const filePath = resolveTrackedProjectWorldStatePath(projectRoot);
    if (!(await exists(filePath))) {
        return undefined;
    }

    const loaded = await readJson<unknown>(filePath);
    return normalizeTrackedProjectWorldState(loaded);
}

export async function readTrackedProjectWorld(
    projectRoot: string,
    worldName: string,
): Promise<TrackedProjectWorldEntry | undefined> {
    const state = await readTrackedProjectWorldState(projectRoot);
    return state?.worlds.find((entry) => entry.name === worldName);
}

export async function upsertTrackedProjectWorld(
    projectRoot: string,
    input: UpsertTrackedProjectWorldInput,
): Promise<void> {
    const filePath = resolveTrackedProjectWorldStatePath(projectRoot);
    const state =
        (await readTrackedProjectWorldState(projectRoot)) ??
        createEmptyTrackedProjectWorldState();
    const nextEntry: TrackedProjectWorldEntry = {
        name: input.name.trim(),
        remoteFingerprint: input.remoteFingerprint.trim(),
        versionId: input.versionId.trim(),
    };
    const worlds = state.worlds
        .filter((entry) => entry.name !== nextEntry.name)
        .concat(nextEntry)
        .sort((left, right) => left.name.localeCompare(right.name));

    await writeJson(filePath, {
        schemaVersion: 1,
        worlds,
    } satisfies TrackedProjectWorldStateFile);
}
