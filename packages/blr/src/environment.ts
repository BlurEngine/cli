import path from "node:path";
import {
    BLR_ENV_BDS_CACHE_DIRECTORY,
    BLR_ENV_BDS_PLATFORM,
    BLR_ENV_BDS_SERVER_DIRECTORY,
    BLR_ENV_BDS_VERSION,
    BLR_ENV_MINECRAFT_DEVELOPMENT_PATH,
    BLR_ENV_MINECRAFT_PRODUCT,
    DEFAULT_BDS_CACHE_DIRECTORY,
    DEFAULT_BDS_SERVER_ROOT,
    DEFAULT_BDS_VERSION,
    DEFAULT_MINECRAFT_PRODUCT,
} from "./constants.js";
import type {
    BdsPlatform,
    BlurMachineOverrides,
    BlurMachineSettings,
    MinecraftChannel,
    MinecraftProduct,
} from "./types.js";

function resolveEnvString(name: string): string | undefined {
    const value = process.env[name]?.trim();
    return value && value.length > 0 ? value : undefined;
}

function resolveMinecraftProduct(
    value: string | undefined,
    fallback: MinecraftProduct | "auto",
): MinecraftProduct | "auto" {
    if (
        value === "BedrockGDK" ||
        value === "PreviewGDK" ||
        value === "BedrockUWP" ||
        value === "PreviewUWP" ||
        value === "Custom" ||
        value === "auto"
    ) {
        return value;
    }
    return fallback;
}

function resolveBdsPlatform(
    value: string | undefined,
    fallback: BdsPlatform | "auto",
): BdsPlatform | "auto" {
    if (value === "win" || value === "linux" || value === "auto") {
        return value;
    }
    return fallback;
}

export function resolveMachineSettings(
    projectRoot: string,
    overrides: BlurMachineOverrides = {},
    defaults: {
        bdsVersion?: string;
        minecraftChannel?: MinecraftChannel;
    } = {},
): BlurMachineSettings {
    const minecraftProduct = resolveMinecraftProduct(
        overrides.minecraftProduct ??
            resolveEnvString(BLR_ENV_MINECRAFT_PRODUCT),
        DEFAULT_MINECRAFT_PRODUCT,
    );
    const minecraftDevelopmentPath =
        overrides.minecraftDevelopmentPath ??
        resolveEnvString(BLR_ENV_MINECRAFT_DEVELOPMENT_PATH) ??
        "";

    const bdsVersion =
        overrides.bdsVersion ??
        resolveEnvString(BLR_ENV_BDS_VERSION) ??
        defaults.bdsVersion ??
        DEFAULT_BDS_VERSION;
    const bdsPlatform = resolveBdsPlatform(
        overrides.bdsPlatform ?? resolveEnvString(BLR_ENV_BDS_PLATFORM),
        "auto",
    );
    const bdsCacheDirectory =
        overrides.bdsCacheDirectory ??
        resolveEnvString(BLR_ENV_BDS_CACHE_DIRECTORY) ??
        DEFAULT_BDS_CACHE_DIRECTORY;
    const defaultServerDirectoryTemplate =
        defaults.minecraftChannel === "preview"
            ? path.posix.join(
                  DEFAULT_BDS_SERVER_ROOT,
                  "preview",
                  "{version}",
                  "server",
              )
            : path.posix.join(DEFAULT_BDS_SERVER_ROOT, "{version}", "server");
    const bdsServerDirectoryTemplate =
        overrides.bdsServerDirectory ??
        resolveEnvString(BLR_ENV_BDS_SERVER_DIRECTORY) ??
        defaultServerDirectoryTemplate;

    return {
        localDeploy: {
            minecraftProduct,
            minecraftDevelopmentPath,
        },
        localServer: {
            bdsVersion,
            platform: bdsPlatform,
            cacheDirectory: bdsCacheDirectory,
            serverDirectory: bdsServerDirectoryTemplate.replaceAll(
                "{version}",
                bdsVersion,
            ),
        },
    };
}

export function resolveProjectRelativePath(
    projectRoot: string,
    targetPath: string,
): string {
    return path.isAbsolute(targetPath)
        ? targetPath
        : path.resolve(projectRoot, targetPath);
}
