import type { VersionTuple } from "./types.js";

export const BLR_CONFIG_FILE = "blr.config.json";
export const BLR_CONFIG_SCHEMA_PATH =
    "./node_modules/@blurengine/cli/schema/blr.config.schema.json";
export const CURRENT_PROJECT_VERSION = 1;

export const DEFAULT_PACK_VERSION: VersionTuple = [1, 0, 0];
export const DEFAULT_MINECRAFT_CHANNEL = "stable" as const;
export const DEFAULT_MINECRAFT_TARGET_VERSION = "1.26.0.2";
export const DEFAULT_MIN_ENGINE_VERSION: VersionTuple = [1, 26, 0];

export const DEFAULT_RUNTIME_ENTRY_CANDIDATES = [
    "src/main.ts",
    "src/main.js",
] as const;
export const DEFAULT_RUNTIME_OUTFILE = "dist/scripts/main.js";
export const DEFAULT_RUNTIME_TARGET = "es2022";
export const DEFAULT_DIST_STAGE_ROOT = "dist/stage";
export const DEFAULT_DIST_PACKAGES_ROOT = "dist/packages";

export const DEFAULT_EXTERNAL_MODULES = [
    "@minecraft/server",
    "@minecraft/server-ui",
    "@minecraft/server-admin",
    "@minecraft/server-net",
];

export const DEFAULT_PROJECT_WORLDS_ROOT = "worlds";

export const DEFAULT_WATCH_PATHS = [
    "src/**/*",
    "behavior_packs/**/*",
    "resource_packs/**/*",
    BLR_CONFIG_FILE,
    "package.json",
];

export const BASELINE_DEPENDENCIES = {
    "@minecraft/server": "^2.3.0",
    "@minecraft/server-ui": "^2.0.0",
    "@minecraft/server-admin": "^1.0.0-beta",
    "@minecraft/server-net": "^1.0.0-beta",
    "@minecraft/vanilla-data": "^1.21.111",
} as const;

export const BASELINE_BEBE_DEPENDENCIES = {
    "@blurengine/bebe": "^0.2.0",
} as const;

export const BASELINE_DEV_DEPENDENCIES = {} as const;

export const BASELINE_TYPESCRIPT_DEPENDENCIES = {
    "@types/node": "^22.13.10",
    typescript: "^5.9.3",
} as const;

export const PACKAGE_MANAGER_VERSION_HINTS: Record<string, string> = {
    npm: "npm@10",
    pnpm: "pnpm@10",
    yarn: "yarn@4",
    bun: "bun@1",
};

export const DEFAULT_MINECRAFT_PRODUCT = "auto" as const;
export const DEFAULT_BDS_VERSION = DEFAULT_MINECRAFT_TARGET_VERSION;
export const DEFAULT_BDS_CACHE_DIRECTORY = ".blr/cache/bds";
export const DEFAULT_BDS_SERVER_ROOT = ".blr/bds";
export const DEFAULT_BDS_WORLD_NAME = "Bedrock level";
export const DEFAULT_WORLD_BACKEND = "local" as const;
export const DEFAULT_WORLD_S3_LOCK_TTL_SECONDS = 4 * 60 * 60;

export const BLR_ENV_MINECRAFT_PRODUCT =
    "BLR_MACHINE_LOCALDEPLOY_MINECRAFTPRODUCT";
export const BLR_ENV_MINECRAFT_DEVELOPMENT_PATH =
    "BLR_MACHINE_LOCALDEPLOY_MINECRAFTDEVELOPMENTPATH";
export const BLR_ENV_BDS_VERSION = "BLR_MACHINE_LOCALSERVER_BDSVERSION";
export const BLR_ENV_BDS_PLATFORM = "BLR_MACHINE_LOCALSERVER_BDSPLATFORM";
export const BLR_ENV_BDS_CACHE_DIRECTORY =
    "BLR_MACHINE_LOCALSERVER_BDSCACHEDIRECTORY";
export const BLR_ENV_BDS_SERVER_DIRECTORY =
    "BLR_MACHINE_LOCALSERVER_BDSSERVERDIRECTORY";
export const BLR_ENV_DEBUG = "BLR_MACHINE_DEBUG";
export const BLR_ENV_WORLD_ACTOR = "BLR_WORLD_ACTOR";
