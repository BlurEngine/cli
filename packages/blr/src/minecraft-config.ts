import { readJson, writeJson } from "./fs.js";
import type { BlurConfigFile, BlurProject } from "./types.js";
import { parseMinecraftVersion } from "./utils.js";

function ensureMutableRecord(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return {};
    }
    return value as Record<string, unknown>;
}

export async function writeMinecraftTargetVersion(
    configPath: string,
    nextVersion: string,
): Promise<void> {
    const rawConfig = ensureMutableRecord(await readJson<unknown>(configPath));
    const minecraftConfig = ensureMutableRecord(rawConfig.minecraft);
    rawConfig.minecraft = minecraftConfig;
    minecraftConfig.targetVersion = nextVersion;
    await writeJson(configPath, rawConfig satisfies BlurConfigFile);
}

export async function readConfiguredMinecraftTargetVersion(
    configPath: string,
    fallbackVersion: string,
): Promise<string> {
    const rawConfig = ensureMutableRecord(await readJson<unknown>(configPath));
    const minecraftConfig = ensureMutableRecord(rawConfig.minecraft);
    const configuredTargetVersion =
        typeof minecraftConfig.targetVersion === "string"
            ? minecraftConfig.targetVersion.trim()
            : "";
    const parsed = parseMinecraftVersion(configuredTargetVersion);
    return parsed?.normalized ?? fallbackVersion;
}

export function applyMinecraftTargetVersion(
    config: BlurProject,
    nextVersion: string,
): void {
    const parsed = parseMinecraftVersion(nextVersion);
    if (!parsed) {
        throw new Error(
            `Cannot update minecraft.targetVersion because "${nextVersion}" is not a valid Minecraft version.`,
        );
    }

    config.minecraft.targetVersion = parsed.normalized;
    config.minecraft.minEngineVersion = [...parsed.minEngineVersion];
    if (config.packs.behavior) {
        config.packs.behavior.minEngineVersion = [...parsed.minEngineVersion];
    }
    if (config.packs.resource) {
        config.packs.resource.minEngineVersion = [...parsed.minEngineVersion];
    }
}
