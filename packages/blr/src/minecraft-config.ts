import {
    applyBlurConfigEnvironmentOverrides,
    configPathToEnvName,
} from "./config-env.js";
import { readJson, writeJson } from "./fs.js";
import type { BlurConfigFile, BlurProject } from "./types.js";
import { parseMinecraftVersion } from "./utils.js";

export type ConfiguredMinecraftTargetVersionSource =
    | "config-file"
    | "config-env"
    | "default";

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
    const overriddenConfig = ensureMutableRecord(
        applyBlurConfigEnvironmentOverrides(rawConfig),
    );
    const minecraftConfig = ensureMutableRecord(overriddenConfig.minecraft);
    const configuredTargetVersion =
        typeof minecraftConfig.targetVersion === "string"
            ? minecraftConfig.targetVersion.trim()
            : "";
    const parsed = parseMinecraftVersion(configuredTargetVersion);
    return parsed?.normalized ?? fallbackVersion;
}

export async function resolveConfiguredMinecraftTargetVersionSource(
    configPath: string,
): Promise<ConfiguredMinecraftTargetVersionSource> {
    const envName = configPathToEnvName(["minecraft", "targetVersion"]);
    const envValue = process.env[envName]?.trim();
    if (envValue && envValue.length > 0) {
        return "config-env";
    }

    const rawConfig = ensureMutableRecord(await readJson<unknown>(configPath));
    const minecraftConfig = ensureMutableRecord(rawConfig.minecraft);
    const configuredTargetVersion =
        typeof minecraftConfig.targetVersion === "string"
            ? minecraftConfig.targetVersion.trim()
            : "";
    return configuredTargetVersion.length > 0 ? "config-file" : "default";
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
}
