import path from "node:path";
import { ensureDirectory, exists, readJson, writeJson } from "./fs.js";
import type { MinecraftChannel } from "./types.js";

type CliPromptState = {
    silencedUntil?: string;
    silencedVersion?: string;
    silencedChannel?: MinecraftChannel;
};

type CliStateFile = {
    prompts?: {
        minecraftTargetUpdate?: CliPromptState;
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
