import path from "node:path";
import { ensureDirectory, exists, readJson, writeJson } from "./fs.js";
import type { MinecraftChannel } from "./types.js";

type CliPromptState = {
    silencedUntil?: string;
    silencedVersion?: string;
    silencedChannel?: MinecraftChannel;
};

type RemoteWorldUpdatePromptState = {
    worldName: string;
    remoteFingerprint: string;
    latestVersionId: string;
    silencedUntil: string;
};

type CliStateFile = {
    prompts?: {
        minecraftTargetUpdate?: CliPromptState;
        remoteWorldUpdates?: RemoteWorldUpdatePromptState[];
    };
};

const CLI_STATE_DIRECTORY = path.join(".blr", "state");
const CLI_STATE_FILE = "cli.json";
const MINECRAFT_TARGET_UPDATE_SILENCE_MS = 24 * 60 * 60 * 1000;

function getCliStatePath(projectRoot: string): string {
    return path.join(projectRoot, CLI_STATE_DIRECTORY, CLI_STATE_FILE);
}

async function readCliState(projectRoot: string): Promise<CliStateFile> {
    const statePath = getCliStatePath(projectRoot);
    if (!(await exists(statePath))) {
        return {};
    }

    try {
        const loaded = await readJson<unknown>(statePath);
        if (!loaded || typeof loaded !== "object" || Array.isArray(loaded)) {
            return {};
        }
        return loaded as CliStateFile;
    } catch {
        return {};
    }
}

async function writeCliState(
    projectRoot: string,
    state: CliStateFile,
): Promise<void> {
    const statePath = getCliStatePath(projectRoot);
    await ensureDirectory(path.dirname(statePath));
    await writeJson(statePath, state);
}

export async function isMinecraftTargetUpdatePromptSilenced(
    projectRoot: string,
    channel: MinecraftChannel,
    latestVersion: string,
    now = Date.now(),
): Promise<boolean> {
    const state = await readCliState(projectRoot);
    const prompt = state.prompts?.minecraftTargetUpdate;
    if (!prompt?.silencedUntil) {
        return false;
    }

    const silencedUntil = Date.parse(prompt.silencedUntil);
    if (!Number.isFinite(silencedUntil) || silencedUntil <= now) {
        return false;
    }

    const channelMatches =
        !prompt.silencedChannel || prompt.silencedChannel === channel;
    const versionMatches =
        !prompt.silencedVersion || prompt.silencedVersion === latestVersion;
    return channelMatches && versionMatches;
}

export async function silenceMinecraftTargetUpdatePrompt(
    projectRoot: string,
    channel: MinecraftChannel,
    latestVersion: string,
    now = Date.now(),
): Promise<void> {
    const state = await readCliState(projectRoot);
    state.prompts ??= {};
    state.prompts.minecraftTargetUpdate = {
        silencedUntil: new Date(
            now + MINECRAFT_TARGET_UPDATE_SILENCE_MS,
        ).toISOString(),
        silencedChannel: channel,
        silencedVersion: latestVersion,
    };
    await writeCliState(projectRoot, state);
}

export async function clearMinecraftTargetUpdatePromptSilence(
    projectRoot: string,
): Promise<void> {
    const state = await readCliState(projectRoot);
    if (!state.prompts?.minecraftTargetUpdate) {
        return;
    }

    delete state.prompts.minecraftTargetUpdate;
    if (state.prompts && Object.keys(state.prompts).length === 0) {
        delete state.prompts;
    }
    await writeCliState(projectRoot, state);
}

function isRemoteWorldUpdatePromptStateMatch(
    prompt: RemoteWorldUpdatePromptState,
    input: {
        worldName: string;
        remoteFingerprint: string;
        latestVersionId: string;
    },
): boolean {
    return (
        prompt.worldName === input.worldName &&
        prompt.remoteFingerprint === input.remoteFingerprint &&
        prompt.latestVersionId === input.latestVersionId
    );
}

export async function isRemoteWorldUpdatePromptSilenced(
    projectRoot: string,
    input: {
        worldName: string;
        remoteFingerprint: string;
        latestVersionId: string;
        now?: number;
    },
): Promise<boolean> {
    const now = input.now ?? Date.now();
    const state = await readCliState(projectRoot);
    const prompts = state.prompts?.remoteWorldUpdates ?? [];
    if (prompts.length === 0) {
        return false;
    }

    let changed = false;
    const active = prompts.filter((prompt) => {
        const silencedUntil = Date.parse(prompt.silencedUntil);
        const keep = Number.isFinite(silencedUntil) && silencedUntil > now;
        if (!keep) {
            changed = true;
        }
        return keep;
    });

    if (changed) {
        state.prompts ??= {};
        state.prompts.remoteWorldUpdates = active;
        await writeCliState(projectRoot, state);
    }

    return active.some((prompt) =>
        isRemoteWorldUpdatePromptStateMatch(prompt, input),
    );
}

export async function silenceRemoteWorldUpdatePrompt(
    projectRoot: string,
    input: {
        worldName: string;
        remoteFingerprint: string;
        latestVersionId: string;
        now?: number;
    },
): Promise<void> {
    const now = input.now ?? Date.now();
    const state = await readCliState(projectRoot);
    state.prompts ??= {};
    const prompts = state.prompts.remoteWorldUpdates ?? [];
    const nextPrompt: RemoteWorldUpdatePromptState = {
        worldName: input.worldName,
        remoteFingerprint: input.remoteFingerprint,
        latestVersionId: input.latestVersionId,
        silencedUntil: new Date(
            now + MINECRAFT_TARGET_UPDATE_SILENCE_MS,
        ).toISOString(),
    };
    state.prompts.remoteWorldUpdates = prompts
        .filter((prompt) => !isRemoteWorldUpdatePromptStateMatch(prompt, input))
        .concat(nextPrompt);
    await writeCliState(projectRoot, state);
}
