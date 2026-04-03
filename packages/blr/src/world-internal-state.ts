import path from "node:path";
import { ensureDirectory, exists, readJson, writeJson } from "./fs.js";

export type MaterializedProjectWorldRemoteState = {
    remoteFingerprint: string;
    versionId: string;
    materializedAt: string;
};

export type RuntimeWorldSeedState = {
    sourceIdentity: string;
    seededAt: string;
};

export type LocalServerSessionState = {
    processId: number;
    worldName: string;
    watchWorld: boolean;
    startedAt: string;
};

type InternalWorldStateEntry = {
    name: string;
    materializedRemote?: MaterializedProjectWorldRemoteState;
    runtimeSeed?: RuntimeWorldSeedState;
};

type InternalWorldStateFile = {
    schemaVersion: 1;
    worlds: InternalWorldStateEntry[];
    localServerSession?: LocalServerSessionState;
};

const WORLD_INTERNAL_STATE_PATH = path.join(
    ".blr",
    "state",
    "world-state.json",
);

function createEmptyInternalWorldState(): InternalWorldStateFile {
    return {
        schemaVersion: 1,
        worlds: [],
    };
}

function normalizeString(value: unknown): string | undefined {
    if (typeof value !== "string") {
        return undefined;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeMaterializedRemoteState(
    value: unknown,
): MaterializedProjectWorldRemoteState | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return undefined;
    }

    const record = value as Record<string, unknown>;
    const remoteFingerprint = normalizeString(record.remoteFingerprint);
    const versionId = normalizeString(record.versionId);
    const materializedAt = normalizeString(record.materializedAt);
    if (!remoteFingerprint || !versionId || !materializedAt) {
        return undefined;
    }

    return {
        remoteFingerprint,
        versionId,
        materializedAt,
    };
}

function normalizeRuntimeSeedState(
    value: unknown,
): RuntimeWorldSeedState | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return undefined;
    }

    const record = value as Record<string, unknown>;
    const sourceIdentity = normalizeString(record.sourceIdentity);
    const seededAt = normalizeString(record.seededAt);
    if (!sourceIdentity || !seededAt) {
        return undefined;
    }

    return {
        sourceIdentity,
        seededAt,
    };
}

function normalizeInternalWorldStateEntry(
    value: unknown,
): InternalWorldStateEntry | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return undefined;
    }

    const record = value as Record<string, unknown>;
    const name = normalizeString(record.name);
    if (!name) {
        return undefined;
    }

    return {
        name,
        materializedRemote: normalizeMaterializedRemoteState(
            record.materializedRemote,
        ),
        runtimeSeed: normalizeRuntimeSeedState(record.runtimeSeed),
    };
}

function normalizeLocalServerSessionState(
    value: unknown,
): LocalServerSessionState | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return undefined;
    }

    const record = value as Record<string, unknown>;
    const processId = Number(record.processId);
    const worldName = normalizeString(record.worldName);
    const startedAt = normalizeString(record.startedAt);
    if (
        !Number.isInteger(processId) ||
        processId <= 0 ||
        !worldName ||
        typeof record.watchWorld !== "boolean" ||
        !startedAt
    ) {
        return undefined;
    }

    return {
        processId,
        worldName,
        watchWorld: record.watchWorld,
        startedAt,
    };
}

function normalizeInternalWorldState(
    value: unknown,
): InternalWorldStateFile | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return undefined;
    }

    const record = value as Record<string, unknown>;
    if (record.schemaVersion !== 1 || !Array.isArray(record.worlds)) {
        return undefined;
    }

    return {
        schemaVersion: 1,
        worlds: record.worlds
            .map((entry) => normalizeInternalWorldStateEntry(entry))
            .filter(
                (entry): entry is InternalWorldStateEntry =>
                    typeof entry !== "undefined",
            )
            .sort((left, right) => left.name.localeCompare(right.name)),
        localServerSession: normalizeLocalServerSessionState(
            record.localServerSession,
        ),
    };
}

async function readInternalWorldState(
    projectRoot: string,
): Promise<InternalWorldStateFile> {
    const filePath = path.resolve(projectRoot, WORLD_INTERNAL_STATE_PATH);
    if (!(await exists(filePath))) {
        return createEmptyInternalWorldState();
    }

    try {
        const loaded = await readJson<unknown>(filePath);
        return (
            normalizeInternalWorldState(loaded) ??
            createEmptyInternalWorldState()
        );
    } catch {
        return createEmptyInternalWorldState();
    }
}

async function writeInternalWorldState(
    projectRoot: string,
    state: InternalWorldStateFile,
): Promise<void> {
    const filePath = path.resolve(projectRoot, WORLD_INTERNAL_STATE_PATH);
    await ensureDirectory(path.dirname(filePath));
    await writeJson(filePath, state);
}

async function updateInternalWorldEntry(
    projectRoot: string,
    worldName: string,
    updater: (
        current: InternalWorldStateEntry | undefined,
    ) => InternalWorldStateEntry | undefined,
): Promise<void> {
    const state = await readInternalWorldState(projectRoot);
    const current = state.worlds.find((entry) => entry.name === worldName);
    const next = updater(current);
    const worlds = state.worlds.filter((entry) => entry.name !== worldName);
    if (next) {
        worlds.push(next);
        worlds.sort((left, right) => left.name.localeCompare(right.name));
    }
    await writeInternalWorldState(projectRoot, {
        ...state,
        worlds,
    });
}

export async function readMaterializedProjectWorldRemoteState(
    projectRoot: string,
    worldName: string,
): Promise<MaterializedProjectWorldRemoteState | undefined> {
    const state = await readInternalWorldState(projectRoot);
    return state.worlds.find((entry) => entry.name === worldName)
        ?.materializedRemote;
}

export async function markProjectWorldMaterializedFromRemote(
    projectRoot: string,
    input: {
        worldName: string;
        remoteFingerprint: string;
        versionId: string;
        materializedAt?: string;
    },
): Promise<void> {
    await updateInternalWorldEntry(projectRoot, input.worldName, (current) => ({
        name: input.worldName,
        materializedRemote: {
            remoteFingerprint: input.remoteFingerprint,
            versionId: input.versionId,
            materializedAt: input.materializedAt ?? new Date().toISOString(),
        },
        runtimeSeed: current?.runtimeSeed,
    }));
}

export async function readRuntimeWorldSeedState(
    projectRoot: string,
    worldName: string,
): Promise<RuntimeWorldSeedState | undefined> {
    const state = await readInternalWorldState(projectRoot);
    return state.worlds.find((entry) => entry.name === worldName)?.runtimeSeed;
}

export async function writeRuntimeWorldSeedState(
    projectRoot: string,
    input: {
        worldName: string;
        sourceIdentity: string;
        seededAt?: string;
    },
): Promise<void> {
    await updateInternalWorldEntry(projectRoot, input.worldName, (current) => ({
        name: input.worldName,
        materializedRemote: current?.materializedRemote,
        runtimeSeed: {
            sourceIdentity: input.sourceIdentity,
            seededAt: input.seededAt ?? new Date().toISOString(),
        },
    }));
}

export async function clearRuntimeWorldSeedState(
    projectRoot: string,
    worldName: string,
): Promise<void> {
    await updateInternalWorldEntry(projectRoot, worldName, (current) => {
        if (!current?.materializedRemote) {
            return undefined;
        }
        return {
            name: current.name,
            materializedRemote: current.materializedRemote,
        };
    });
}

function isProbablyLiveProcess(processId: number): boolean {
    try {
        process.kill(processId, 0);
        return true;
    } catch (error) {
        const code =
            typeof error === "object" &&
            error !== null &&
            "code" in error &&
            typeof (error as { code?: unknown }).code === "string"
                ? (error as { code: string }).code
                : undefined;
        return code !== "ESRCH";
    }
}

export async function readActiveLocalServerSession(
    projectRoot: string,
): Promise<LocalServerSessionState | undefined> {
    const state = await readInternalWorldState(projectRoot);
    const session = state.localServerSession;
    if (!session) {
        return undefined;
    }

    if (isProbablyLiveProcess(session.processId)) {
        return session;
    }

    delete state.localServerSession;
    await writeInternalWorldState(projectRoot, state);
    return undefined;
}

export async function writeLocalServerSession(
    projectRoot: string,
    session: LocalServerSessionState,
): Promise<void> {
    const state = await readInternalWorldState(projectRoot);
    state.localServerSession = session;
    await writeInternalWorldState(projectRoot, state);
}

export async function clearLocalServerSession(
    projectRoot: string,
): Promise<void> {
    const state = await readInternalWorldState(projectRoot);
    if (!state.localServerSession) {
        return;
    }

    delete state.localServerSession;
    await writeInternalWorldState(projectRoot, state);
}
