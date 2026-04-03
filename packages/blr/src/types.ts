export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

export type Language = "ts" | "js";

export type VersionTuple = [number, number, number];
export type WorldBackend = "local" | "s3";
export type MinecraftChannel = "stable" | "preview";
export type WorldSyncProjectMode = "prompt" | "auto" | "manual";
export type WorldSyncRuntimeMode = "prompt" | "preserve" | "replace" | "backup";

export type MinecraftProduct =
    | "BedrockGDK"
    | "PreviewGDK"
    | "BedrockUWP"
    | "PreviewUWP"
    | "Custom";

export type BdsPlatform = "win" | "linux";

export type PermissionLevel = "visitor" | "member" | "operator" | "custom";
export type PackageTarget = "world-template";

/**
 * Per-pack feature toggles for behavior-pack and resource-pack automation.
 */
export interface BlurConfigPackFeatureSelectionFile {
    /**
     * Whether the behavior pack is enabled in this automation context.
     */
    behaviorPack?: boolean;
    /**
     * Whether the resource pack is enabled in this automation context.
     */
    resourcePack?: boolean;
}

/**
 * Project-level Minecraft targeting defaults.
 */
export interface BlurConfigMinecraftFile {
    /**
     * Default Bedrock release channel used by local-server, local-deploy preference order, and version checks.
     */
    channel?: MinecraftChannel;
    /**
     * Target Minecraft version, for example `1.26.0.2`.
     */
    targetVersion?: string;
}

/**
 * Project-level defaults for `blr upgrade`.
 */
export interface BlurConfigUpgradeFile {
    /**
     * Refresh managed `AGENTS.md` content by default.
     */
    refreshAgents?: boolean;
    /**
     * Refresh dependency baselines in `package.json` by default.
     */
    refreshDependencies?: boolean;
}

/**
 * S3-compatible backend coordinates. Credentials should stay in environment variables, not here.
 */
export interface BlurConfigWorldS3File {
    /**
     * Bucket name used for remote world storage.
     */
    bucket?: string;
    /**
     * AWS region for the S3 client.
     */
    region?: string;
    /**
     * Optional custom S3-compatible endpoint.
     */
    endpoint?: string;
    /**
     * Static prefix prepended to remote world objects.
     */
    keyPrefix?: string;
    /**
     * Whether to include the project name in remote world object keys.
     */
    projectPrefix?: boolean;
    /**
     * Enable path-style S3 addressing for providers that require it.
     */
    forcePathStyle?: boolean;
    /**
     * Default remote world lock TTL in seconds.
     */
    lockTtlSeconds?: number;
}

/**
 * Optional remote world backend configuration.
 */
export interface BlurConfigWorldFile {
    /**
     * World source backend. Use `s3` to enable `blr world pull/push` against an S3-compatible store.
     */
    backend?: WorldBackend;
    /**
     * S3-compatible world backend coordinates.
     */
    s3?: BlurConfigWorldS3File;
}

/**
 * World-template packaging defaults.
 */
export interface BlurConfigPackageWorldTemplateFile {
    /**
     * Pack inclusion defaults for world-template packaging.
     */
    include?: BlurConfigPackFeatureSelectionFile;
}

/**
 * Packaging defaults for `blr package`.
 */
export interface BlurConfigPackageFile {
    /**
     * Default package target used when `blr package` is run without an explicit target.
     */
    defaultTarget?: PackageTarget;
    /**
     * World-template packaging defaults.
     */
    worldTemplate?: BlurConfigPackageWorldTemplateFile;
}

/**
 * Optional script build overrides.
 */
export interface BlurConfigRuntimeFile {
    /**
     * Project-relative runtime entry file. If omitted, blr infers `src/main.ts` or `src/main.js`.
     */
    entry?: string;
    /**
     * Project-relative bundled runtime output path before it is synced into staged pack output.
     */
    outFile?: string;
    /**
     * esbuild target for runtime bundling.
     */
    target?: string;
    /**
     * Whether runtime bundling should emit sourcemaps.
     */
    sourcemap?: boolean;
    /**
     * Bedrock modules that should stay external during runtime bundling.
     */
    externalModules?: string[];
}

/**
 * Watch-mode defaults for `blr dev`.
 */
export interface BlurConfigWatchFile {
    /**
     * Project-relative watch path patterns.
     */
    paths?: string[];
    /**
     * Watcher debounce time in milliseconds.
     */
    debounceMs?: number;
    /**
     * Default interactive selection for `watch-scripts`.
     */
    scriptsEnabledByDefault?: boolean;
    /**
     * Default interactive selection for `watch-world`.
     */
    worldEnabledByDefault?: boolean;
    /**
     * Default interactive selection for `watch-allowlist`.
     */
    allowlistEnabledByDefault?: boolean;
}

/**
 * Project-level defaults for `local-deploy`.
 */
export interface BlurConfigLocalDeployFile {
    /**
     * Whether `local-deploy` starts selected by default.
     */
    enabledByDefault?: boolean;
    /**
     * Pack copy defaults for this automation context.
     */
    copy?: BlurConfigPackFeatureSelectionFile;
}

/**
 * Project-level defaults for `local-server`.
 */
export interface BlurConfigLocalServerWorldSyncFile {
    /**
     * How `blr dev` should reconcile the project world against the remote pinned version.
     */
    projectWorldMode?: WorldSyncProjectMode;
    /**
     * How `blr dev` should seed the local-server runtime world from the project world.
     */
    runtimeWorldMode?: WorldSyncRuntimeMode;
}

/**
 * Project-level defaults for `local-server`.
 */
export interface BlurConfigLocalServerFile {
    /**
     * Whether `local-server` starts selected by default.
     */
    enabledByDefault?: boolean;
    /**
     * Active BDS world name.
     */
    worldName?: string;
    /**
     * Project-relative raw world source path, usually `worlds/<worldName>`.
     */
    worldSourcePath?: string;
    /**
     * Restart and reset the local server when the project world source changes.
     */
    restartOnWorldChange?: boolean;
    /**
     * Pack copy defaults for local-server staging.
     */
    copy?: BlurConfigPackFeatureSelectionFile;
    /**
     * Pack attachment defaults for local-server world hooks.
     */
    attach?: BlurConfigPackFeatureSelectionFile;
    /**
     * Fallback allowlist XUIDs when `server/allowlist.json` does not exist.
     */
    allowlist?: string[];
    /**
     * Fallback operator XUIDs when `server/permissions.json` does not exist.
     */
    operators?: string[];
    /**
     * Default BDS player permission level.
     */
    defaultPermissionLevel?: PermissionLevel;
    /**
     * Default BDS gamemode.
     */
    gamemode?: string;
    /**
     * World sync defaults for `blr dev`.
     */
    worldSync?: BlurConfigLocalServerWorldSyncFile;
}

/**
 * Project-level defaults for `blr dev`.
 */
export interface BlurConfigDevFile {
    /**
     * Watch-mode defaults.
     */
    watch?: BlurConfigWatchFile;
    /**
     * `local-deploy` defaults.
     */
    localDeploy?: BlurConfigLocalDeployFile;
    /**
     * `local-server` defaults.
     */
    localServer?: BlurConfigLocalServerFile;
}

/**
 * Project-level configuration for a BlurEngine Bedrock project.
 */
export interface BlurConfigFile {
    /**
     * JSON Schema reference used by editors such as VS Code and Cursor for completion, hover text, and validation.
     */
    $schema?: string;
    /**
     * Configuration schema version. Keep this at 1.
     */
    schemaVersion?: 1;
    /**
     * Generated-project scaffold version managed by blr. This is upgraded by `blr upgrade`, not by hand.
     */
    projectVersion?: number;
    /**
     * Required project namespace used by BlurEngine project logic.
     */
    namespace?: string;
    /**
     * Project-level Minecraft targeting defaults.
     */
    minecraft?: BlurConfigMinecraftFile;
    /**
     * Project-level defaults for `blr upgrade`.
     */
    upgrade?: BlurConfigUpgradeFile;
    /**
     * Optional remote world backend configuration.
     */
    world?: BlurConfigWorldFile;
    /**
     * Packaging defaults for `blr package`.
     */
    package?: BlurConfigPackageFile;
    /**
     * Optional script build overrides.
     */
    runtime?: BlurConfigRuntimeFile;
    /**
     * Project-level defaults for `blr dev`.
     */
    dev?: BlurConfigDevFile;
}

export interface PackManifestConfig {
    directory: string;
    manifestPath: string;
    displayName: string;
    description: string;
    headerUuid: string;
    moduleUuid: string;
    version: VersionTuple;
    minEngineVersion: VersionTuple;
}

export interface BlurProjectFeatures {
    behaviorPack: boolean;
    resourcePack: boolean;
    scripting: boolean;
}

export interface PackFeatureSelection {
    behaviorPack: boolean;
    resourcePack: boolean;
}

export interface BlurProject {
    schemaVersion: 1;
    projectVersion: number;
    configPath: string;
    packageJsonPath: string;
    namespace: string;
    minecraft: {
        channel: MinecraftChannel;
        targetVersion: string;
        minEngineVersion: VersionTuple;
    };
    features: BlurProjectFeatures;
    automation: {
        localDeploy: {
            copy: PackFeatureSelection;
        };
        localServer: {
            copy: PackFeatureSelection;
            attach: PackFeatureSelection;
        };
        package: {
            worldTemplate: {
                include: PackFeatureSelection;
            };
        };
    };
    project: {
        name: string;
        packageName: string;
        version: string;
        description: string;
        packageManager: PackageManager;
        language: Language;
        packName: string;
    };
    runtime: {
        entry: string;
        outFile: string;
        target: string;
        sourcemap: boolean;
        externalModules: string[];
    };
    packs: {
        behavior?: PackManifestConfig;
        resource?: PackManifestConfig;
    };
    dev: {
        watch: {
            paths: string[];
            debounceMs: number;
            scriptsEnabledByDefault: boolean;
            worldEnabledByDefault: boolean;
            allowlistEnabledByDefault: boolean;
        };
        localDeploy: {
            enabledByDefault: boolean;
        };
        localServer: {
            enabledByDefault: boolean;
            worldName: string;
            worldSourcePath: string;
            restartOnWorldChange: boolean;
            allowlist: string[];
            operators: string[];
            defaultPermissionLevel: PermissionLevel;
            gamemode: string;
            worldSync: {
                projectWorldMode: WorldSyncProjectMode;
                runtimeWorldMode: WorldSyncRuntimeMode;
            };
        };
    };
    upgrade: {
        refreshAgents: boolean;
        refreshDependencies: boolean;
    };
    world: {
        backend: WorldBackend;
        s3: {
            bucket: string;
            region: string;
            endpoint: string;
            keyPrefix: string;
            projectPrefix: boolean;
            forcePathStyle: boolean;
            lockTtlSeconds: number;
        };
    };
    package: {
        defaultTarget?: PackageTarget;
    };
}

export interface BlurMachineSettings {
    localDeploy: {
        minecraftProduct: MinecraftProduct | "auto";
        minecraftDevelopmentPath: string;
    };
    localServer: {
        bdsVersion: string;
        platform: BdsPlatform | "auto";
        cacheDirectory: string;
        serverDirectory: string;
    };
}

export interface BlurMachineOverrides {
    minecraftProduct?: MinecraftProduct | "auto";
    minecraftDevelopmentPath?: string;
    bdsVersion?: string;
    bdsPlatform?: BdsPlatform | "auto";
    bdsCacheDirectory?: string;
    bdsServerDirectory?: string;
}
