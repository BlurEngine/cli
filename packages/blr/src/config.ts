import path from "node:path";
import { applyBlurConfigEnvironmentOverrides } from "./config-env.js";
import {
    BLR_CONFIG_FILE,
    CURRENT_PROJECT_VERSION,
    DEFAULT_BDS_WORLD_NAME,
    DEFAULT_LINK_SERVER_HOST,
    DEFAULT_LINK_SERVER_PORT,
    DEFAULT_MINECRAFT_CHANNEL,
    DEFAULT_MINECRAFT_TARGET_VERSION,
    DEFAULT_EXTERNAL_MODULES,
    DEFAULT_MIN_ENGINE_VERSION,
    DEFAULT_PACK_VERSION,
    DEFAULT_RUNTIME_ENTRY_CANDIDATES,
    DEFAULT_RUNTIME_OUTFILE,
    DEFAULT_RUNTIME_TARGET,
    DEFAULT_WATCH_PATHS,
    DEFAULT_WORLD_BACKEND,
    DEFAULT_WORLD_S3_LOCK_TTL_SECONDS,
} from "./constants.js";
import { loadClosestDotEnvLocal } from "./env-file.js";
import { exists, listDirectories, readJson } from "./fs.js";
import { normalizePackageTarget } from "./package-targets.js";
import { assertProjectRelativePath } from "./project-paths.js";
import type {
    BebeDiagnosticPipeline,
    BebeDiagnosticSeverity,
    BlurConfigFile,
    BlurProject,
    Language,
    MinecraftChannel,
    PackFeatureSelection,
    PackageTarget,
    PackManifestConfig,
    PermissionLevel,
    VersionTuple,
    WorldImageDimension,
    WorldPackageLayout,
    WorldPackageFormat,
    WorldBackend,
    WorldSyncProjectMode,
    WorldSyncRuntimeMode,
} from "./types.js";
import {
    dedupeStrings,
    inferPackageManager,
    parseMinecraftVersion,
} from "./utils.js";
import {
    assertValidWorldName,
    defaultProjectWorldSourcePath,
} from "./world.js";
import {
    DEFAULT_WORLD_PACKAGE_FORMAT,
    isWorldPackageFormat,
} from "./world-package-formats.js";

type LoadedBlurConfig = {
    projectRoot: string;
    configPath: string;
    config: BlurProject;
};

type LoadBlurConfigOptions = {
    allowProjectVersionMismatch?: boolean;
};

type PackageJsonShape = {
    name?: string;
    version?: string;
    description?: string;
    packageManager?: string;
};

type ManifestShape = {
    header?: {
        name?: string;
        description?: string;
        uuid?: string;
        version?: unknown;
        min_engine_version?: unknown;
    };
    modules?: Array<{
        type?: string;
        uuid?: string;
        version?: unknown;
    }>;
};
type BebeZoneEditorPolicy = {
    dev: boolean;
    package: boolean;
};

const DEFAULT_BEBE_MISSING_REFERENCE_DIAGNOSTICS: Record<
    BebeDiagnosticPipeline,
    BebeDiagnosticSeverity
> = {
    dev: "warn",
    build: "error",
    package: "error",
    check: "error",
};
const DEFAULT_BEBE_ZONE_EDITOR: BebeZoneEditorPolicy = {
    dev: true,
    package: false,
};

function ensureVersionTuple(
    value: unknown,
    fallback: VersionTuple,
): VersionTuple {
    if (!Array.isArray(value) || value.length !== 3) return fallback;
    const parsed = value.map((entry) => Number(entry));
    if (parsed.some((entry) => !Number.isFinite(entry))) return fallback;
    return [parsed[0], parsed[1], parsed[2]];
}

function ensureString(value: unknown, fallback: string): string {
    return typeof value === "string" ? value : fallback;
}

function ensureBoolean(value: unknown, fallback: boolean): boolean {
    return typeof value === "boolean" ? value : fallback;
}

function ensurePort(value: unknown, fallback: number): number {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
        return fallback;
    }
    return parsed;
}

function ensureStringArray(value: unknown, fallback: string[]): string[] {
    if (!Array.isArray(value)) return fallback;
    const entries = value.filter(
        (item): item is string => typeof item === "string",
    );
    return entries.length > 0 ? entries : fallback;
}

function ensurePermissionLevel(
    value: unknown,
    fallback: PermissionLevel,
): PermissionLevel {
    if (
        value === "visitor" ||
        value === "member" ||
        value === "operator" ||
        value === "custom"
    ) {
        return value;
    }
    return fallback;
}

function ensurePackageTarget(value: unknown): PackageTarget | undefined {
    return normalizePackageTarget(value);
}

function ensurePackageTargets(value: unknown): PackageTarget[] | undefined {
    if (!Array.isArray(value)) {
        return undefined;
    }

    const targets = value
        .map((entry) => normalizePackageTarget(entry))
        .filter((entry): entry is PackageTarget => Boolean(entry));
    return targets.length > 0
        ? (dedupeStrings(targets) as PackageTarget[])
        : undefined;
}

function ensureWorldPackageFormat(
    value: unknown,
    fallback: WorldPackageFormat,
): WorldPackageFormat {
    return isWorldPackageFormat(value) ? value : fallback;
}

function ensureWorldPackageLayout(
    value: unknown,
    fallback: WorldPackageLayout,
): WorldPackageLayout {
    return value === "bedrock-root" || value === "com" ? value : fallback;
}

function ensureWorldImageDimension(
    value: unknown,
    fallback: WorldImageDimension,
): WorldImageDimension {
    return value === "overworld" || value === "nether" || value === "end"
        ? value
        : fallback;
}

function ensureWorldImageScale(value: unknown, fallback: number): number {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 16) {
        return fallback;
    }
    return parsed;
}

function ensureMinecraftChannel(
    value: unknown,
    fallback: MinecraftChannel,
): MinecraftChannel {
    return value === "preview" || value === "stable" ? value : fallback;
}

function ensureWorldBackend(
    value: unknown,
    fallback: WorldBackend,
): WorldBackend {
    return value === "local" || value === "s3" ? value : fallback;
}

function ensureWorldSyncProjectMode(
    value: unknown,
    fallback: WorldSyncProjectMode,
): WorldSyncProjectMode {
    return value === "prompt" || value === "auto" || value === "manual"
        ? value
        : fallback;
}

function ensureWorldSyncRuntimeMode(
    value: unknown,
    fallback: WorldSyncRuntimeMode,
): WorldSyncRuntimeMode {
    return value === "prompt" ||
        value === "preserve" ||
        value === "replace" ||
        value === "backup"
        ? value
        : fallback;
}

function ensureBebeDiagnosticSeverity(
    value: unknown,
    fallback: BebeDiagnosticSeverity,
): BebeDiagnosticSeverity {
    return value === "ignore" || value === "warn" || value === "error"
        ? value
        : fallback;
}

function resolveBebeDiagnosticPolicy(
    value: unknown,
    fallback: Record<BebeDiagnosticPipeline, BebeDiagnosticSeverity>,
): Record<BebeDiagnosticPipeline, BebeDiagnosticSeverity> {
    const record =
        value && typeof value === "object" && !Array.isArray(value)
            ? (value as Record<string, unknown>)
            : {};
    return {
        dev: ensureBebeDiagnosticSeverity(record.dev, fallback.dev),
        build: ensureBebeDiagnosticSeverity(record.build, fallback.build),
        package: ensureBebeDiagnosticSeverity(record.package, fallback.package),
        check: ensureBebeDiagnosticSeverity(record.check, fallback.check),
    };
}

function resolveBebeZoneEditorPolicy(
    input: unknown,
    fallback: BebeZoneEditorPolicy,
): BebeZoneEditorPolicy {
    const record =
        input && typeof input === "object" && !Array.isArray(input)
            ? (input as Record<string, unknown>)
            : {};
    return {
        dev: ensureBoolean(record.dev, fallback.dev),
        package: ensureBoolean(record.package, fallback.package),
    };
}

function resolvePackFeatureSelection(
    value: unknown,
    fallback: PackFeatureSelection,
): PackFeatureSelection {
    const record =
        value && typeof value === "object" && !Array.isArray(value)
            ? (value as Record<string, unknown>)
            : {};
    return {
        behaviorPack: ensureBoolean(record.behaviorPack, fallback.behaviorPack),
        resourcePack: ensureBoolean(record.resourcePack, fallback.resourcePack),
    };
}

function coerceBlurConfigFile(
    value: unknown,
    configFileName: string,
): BlurConfigFile {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`${configFileName} must contain a JSON object.`);
    }

    const raw = value as Record<string, unknown>;
    const minecraft = (raw.minecraft ?? {}) as Record<string, unknown>;
    const runtime = (raw.runtime ?? {}) as Record<string, unknown>;
    const bebe = (raw.bebe ?? {}) as Record<string, unknown>;
    const bebeDiagnostics = (bebe.diagnostics ?? {}) as Record<string, unknown>;
    const bebeZoneEditor = (bebe.zoneEditor ?? {}) as Record<string, unknown>;
    const dev = (raw.dev ?? {}) as Record<string, unknown>;
    const upgrade = (raw.upgrade ?? {}) as Record<string, unknown>;
    const world = (raw.world ?? {}) as Record<string, unknown>;
    const worldS3 = (world.s3 ?? {}) as Record<string, unknown>;
    const packageConfig = (raw.package ?? {}) as Record<string, unknown>;
    const packageWorld = (packageConfig.world ?? {}) as Record<string, unknown>;
    const packageAssets = (packageConfig.assets ?? {}) as Record<
        string,
        unknown
    >;
    const packageAssetsWorldImage = (packageAssets.worldImage ?? {}) as Record<
        string,
        unknown
    >;
    const packageWorldTemplate = (packageConfig.worldTemplate ?? {}) as Record<
        string,
        unknown
    >;
    const watch = (dev.watch ?? {}) as Record<string, unknown>;
    const localDeploy = (dev.localDeploy ?? {}) as Record<string, unknown>;
    const localServer = (dev.localServer ?? {}) as Record<string, unknown>;
    const localServerLink = (localServer.link ?? {}) as Record<string, unknown>;
    const localServerLinkDashboard = (localServerLink.dashboard ??
        {}) as Record<string, unknown>;
    const localServerWorldSync = (localServer.worldSync ?? {}) as Record<
        string,
        unknown
    >;
    const localDeployCopy = (localDeploy.copy ?? {}) as Record<string, unknown>;
    const localServerCopy = (localServer.copy ?? {}) as Record<string, unknown>;
    const localServerAttach = (localServer.attach ?? {}) as Record<
        string,
        unknown
    >;
    const packageWorldTemplateInclude = (packageWorldTemplate.include ??
        {}) as Record<string, unknown>;
    const namespace = ensureString(raw.namespace, "").trim();

    if (!namespace) {
        throw new Error(`${configFileName} must define namespace.`);
    }

    const schemaVersion = raw.schemaVersion;
    if (typeof schemaVersion !== "undefined" && schemaVersion !== 1) {
        throw new Error(
            `${configFileName} schemaVersion must be 1 when present.`,
        );
    }

    const projectVersion = raw.projectVersion;
    if (
        typeof projectVersion !== "undefined" &&
        (!Number.isInteger(projectVersion) || Number(projectVersion) < 1)
    ) {
        throw new Error(
            `${configFileName} projectVersion must be a positive integer when present.`,
        );
    }

    return {
        schemaVersion: 1,
        projectVersion:
            typeof projectVersion === "number" ? projectVersion : undefined,
        namespace,
        minecraft: {
            channel: ensureMinecraftChannel(
                minecraft.channel,
                DEFAULT_MINECRAFT_CHANNEL,
            ),
            targetVersion: ensureString(minecraft.targetVersion, ""),
        },
        upgrade: {
            refreshAgents:
                typeof upgrade.refreshAgents === "boolean"
                    ? upgrade.refreshAgents
                    : undefined,
            refreshDependencies:
                typeof upgrade.refreshDependencies === "boolean"
                    ? upgrade.refreshDependencies
                    : undefined,
        },
        world: {
            backend: ensureWorldBackend(world.backend, DEFAULT_WORLD_BACKEND),
            s3: {
                bucket: ensureString(worldS3.bucket, ""),
                region: ensureString(worldS3.region, ""),
                endpoint: ensureString(worldS3.endpoint, ""),
                keyPrefix: ensureString(worldS3.keyPrefix, "worlds"),
                projectPrefix:
                    typeof worldS3.projectPrefix === "boolean"
                        ? worldS3.projectPrefix
                        : undefined,
                forcePathStyle:
                    typeof worldS3.forcePathStyle === "boolean"
                        ? worldS3.forcePathStyle
                        : undefined,
                lockTtlSeconds:
                    Number(worldS3.lockTtlSeconds ?? 0) || undefined,
            },
        },
        package: {
            defaultTarget: ensurePackageTarget(packageConfig.defaultTarget),
            defaultTargets: ensurePackageTargets(packageConfig.defaultTargets),
            worldTemplate: {
                include: {
                    behaviorPack:
                        typeof packageWorldTemplateInclude.behaviorPack ===
                        "boolean"
                            ? packageWorldTemplateInclude.behaviorPack
                            : undefined,
                    resourcePack:
                        typeof packageWorldTemplateInclude.resourcePack ===
                        "boolean"
                            ? packageWorldTemplateInclude.resourcePack
                            : undefined,
                },
            },
            world: {
                format: ensureWorldPackageFormat(
                    packageWorld.format,
                    DEFAULT_WORLD_PACKAGE_FORMAT,
                ),
                layout: ensureWorldPackageLayout(
                    packageWorld.layout,
                    "bedrock-root",
                ),
            },
            assets: {
                worldImage: {
                    enabled:
                        typeof packageAssetsWorldImage.enabled === "boolean"
                            ? packageAssetsWorldImage.enabled
                            : undefined,
                    dimension: ensureWorldImageDimension(
                        packageAssetsWorldImage.dimension,
                        "overworld",
                    ),
                    scale:
                        typeof packageAssetsWorldImage.scale !== "undefined"
                            ? ensureWorldImageScale(
                                  packageAssetsWorldImage.scale,
                                  1,
                              )
                            : undefined,
                    fileName: ensureString(
                        packageAssetsWorldImage.fileName,
                        "",
                    ),
                },
            },
        },
        runtime: {
            entry: ensureString(runtime.entry, ""),
            outFile: ensureString(runtime.outFile, ""),
            target: ensureString(runtime.target, ""),
            sourcemap:
                typeof runtime.sourcemap === "boolean"
                    ? runtime.sourcemap
                    : undefined,
            externalModules: ensureStringArray(runtime.externalModules, []),
        },
        bebe: {
            diagnostics: {
                missingReferences: resolveBebeDiagnosticPolicy(
                    bebeDiagnostics.missingReferences,
                    DEFAULT_BEBE_MISSING_REFERENCE_DIAGNOSTICS,
                ),
            },
            zoneEditor: resolveBebeZoneEditorPolicy(
                bebeZoneEditor,
                DEFAULT_BEBE_ZONE_EDITOR,
            ),
        },
        dev: {
            watch: {
                paths: ensureStringArray(watch.paths, []),
                debounceMs: Number(watch.debounceMs ?? 0) || undefined,
                scriptsEnabledByDefault:
                    typeof watch.scriptsEnabledByDefault === "boolean"
                        ? watch.scriptsEnabledByDefault
                        : undefined,
                worldEnabledByDefault:
                    typeof watch.worldEnabledByDefault === "boolean"
                        ? watch.worldEnabledByDefault
                        : undefined,
                allowlistEnabledByDefault:
                    typeof watch.allowlistEnabledByDefault === "boolean"
                        ? watch.allowlistEnabledByDefault
                        : undefined,
            },
            localDeploy: {
                enabledByDefault:
                    typeof localDeploy.enabledByDefault === "boolean"
                        ? localDeploy.enabledByDefault
                        : undefined,
                copy: {
                    behaviorPack:
                        typeof localDeployCopy.behaviorPack === "boolean"
                            ? localDeployCopy.behaviorPack
                            : undefined,
                    resourcePack:
                        typeof localDeployCopy.resourcePack === "boolean"
                            ? localDeployCopy.resourcePack
                            : undefined,
                },
            },
            localServer: {
                enabledByDefault:
                    typeof localServer.enabledByDefault === "boolean"
                        ? localServer.enabledByDefault
                        : undefined,
                worldName: ensureString(localServer.worldName, ""),
                worldSourcePath: ensureString(localServer.worldSourcePath, ""),
                restartOnWorldChange:
                    typeof localServer.restartOnWorldChange === "boolean"
                        ? localServer.restartOnWorldChange
                        : undefined,
                compactScriptingLogs:
                    typeof localServer.compactScriptingLogs === "boolean"
                        ? localServer.compactScriptingLogs
                        : undefined,
                copy: {
                    behaviorPack:
                        typeof localServerCopy.behaviorPack === "boolean"
                            ? localServerCopy.behaviorPack
                            : undefined,
                    resourcePack:
                        typeof localServerCopy.resourcePack === "boolean"
                            ? localServerCopy.resourcePack
                            : undefined,
                },
                attach: {
                    behaviorPack:
                        typeof localServerAttach.behaviorPack === "boolean"
                            ? localServerAttach.behaviorPack
                            : undefined,
                    resourcePack:
                        typeof localServerAttach.resourcePack === "boolean"
                            ? localServerAttach.resourcePack
                            : undefined,
                },
                allowlist: ensureStringArray(localServer.allowlist, []),
                operators: ensureStringArray(localServer.operators, []),
                defaultPermissionLevel: ensurePermissionLevel(
                    localServer.defaultPermissionLevel,
                    "operator",
                ),
                gamemode: ensureString(localServer.gamemode, ""),
                link: {
                    enabled:
                        typeof localServerLink.enabled === "boolean"
                            ? localServerLink.enabled
                            : undefined,
                    host: ensureString(localServerLink.host, ""),
                    port:
                        typeof localServerLink.port !== "undefined"
                            ? ensurePort(
                                  localServerLink.port,
                                  DEFAULT_LINK_SERVER_PORT,
                              )
                            : undefined,
                    dashboard: {
                        enabled:
                            typeof localServerLinkDashboard.enabled ===
                            "boolean"
                                ? localServerLinkDashboard.enabled
                                : undefined,
                    },
                },
                worldSync: {
                    projectWorldMode: ensureWorldSyncProjectMode(
                        localServerWorldSync.projectWorldMode,
                        "prompt",
                    ),
                    runtimeWorldMode: ensureWorldSyncRuntimeMode(
                        localServerWorldSync.runtimeWorldMode,
                        "prompt",
                    ),
                },
            },
        },
    };
}

async function resolveEntry(
    projectRoot: string,
    explicitEntry: string,
): Promise<string> {
    if (explicitEntry.trim().length > 0) {
        return explicitEntry;
    }

    for (const candidate of DEFAULT_RUNTIME_ENTRY_CANDIDATES) {
        if (await exists(path.resolve(projectRoot, candidate))) {
            return candidate;
        }
    }

    return "";
}

function inferLanguage(entry: string): Language {
    return entry.endsWith(".js") ? "js" : "ts";
}

async function resolvePackDirectory(
    projectRoot: string,
    parentDirectory: "behavior_packs" | "resource_packs",
): Promise<string | undefined> {
    const root = path.resolve(projectRoot, parentDirectory);
    const entries = await listDirectories(root);
    const matches: string[] = [];

    for (const entry of entries) {
        const manifestPath = path.join(root, entry, "manifest.json");
        if (await exists(manifestPath)) {
            matches.push(path.posix.join(parentDirectory, entry));
        }
    }

    if (matches.length === 0) {
        return undefined;
    }

    if (matches.length > 1) {
        throw new Error(
            `Cannot infer ${parentDirectory} directory because multiple pack manifests were found: ${matches.join(", ")}.`,
        );
    }

    return matches[0];
}

async function loadPackManifest(
    projectRoot: string,
    directory: string,
    expectedModuleType: "script" | "resources",
): Promise<PackManifestConfig> {
    const manifestPath = path.resolve(projectRoot, directory, "manifest.json");
    const manifest = await readJson<ManifestShape>(manifestPath);
    const header = manifest.header ?? {};
    const modules = Array.isArray(manifest.modules) ? manifest.modules : [];
    const module =
        modules.find((entry) => entry.type === expectedModuleType) ??
        modules[0] ??
        {};

    return {
        directory,
        manifestPath: path.posix.join(directory, "manifest.json"),
        displayName: ensureString(header.name, path.posix.basename(directory)),
        description: ensureString(header.description, ""),
        headerUuid: ensureString(header.uuid, ""),
        moduleUuid: ensureString(module.uuid, ""),
        version: ensureVersionTuple(header.version, DEFAULT_PACK_VERSION),
        minEngineVersion: ensureVersionTuple(
            header.min_engine_version,
            DEFAULT_MIN_ENGINE_VERSION,
        ),
    };
}

export async function loadBlurConfig(
    projectRoot = process.cwd(),
    options: LoadBlurConfigOptions = {},
): Promise<LoadedBlurConfig> {
    await loadClosestDotEnvLocal(projectRoot);

    const configPath = path.resolve(projectRoot, BLR_CONFIG_FILE);
    const packageJsonPath = path.resolve(projectRoot, "package.json");

    if (!(await exists(configPath))) {
        throw new Error(
            `Cannot find ${BLR_CONFIG_FILE} in ${projectRoot}. Run this command from a generated BlurEngine project.`,
        );
    }

    if (!(await exists(packageJsonPath))) {
        throw new Error(`Cannot find package.json in ${projectRoot}.`);
    }

    const configFileName = path.basename(configPath);
    const configInput = await readJson<unknown>(configPath);
    const configObject: Record<string, unknown> | undefined =
        configInput &&
        typeof configInput === "object" &&
        !Array.isArray(configInput)
            ? (configInput as Record<string, unknown>)
            : undefined;
    const configFile = coerceBlurConfigFile(
        configObject
            ? applyBlurConfigEnvironmentOverrides(configObject)
            : configInput,
        configFileName,
    );
    const packageJson = await readJson<PackageJsonShape>(packageJsonPath);

    const entry = await resolveEntry(
        projectRoot,
        ensureString(configFile.runtime?.entry, ""),
    );
    const behaviorDirectory = await resolvePackDirectory(
        projectRoot,
        "behavior_packs",
    );
    const resourceDirectory = await resolvePackDirectory(
        projectRoot,
        "resource_packs",
    );
    if (!behaviorDirectory && !resourceDirectory) {
        throw new Error(
            "Cannot infer project content. Expected at least one pack manifest under behavior_packs/*/manifest.json or resource_packs/*/manifest.json.",
        );
    }
    const behavior = behaviorDirectory
        ? await loadPackManifest(projectRoot, behaviorDirectory, "script")
        : undefined;
    const resource = resourceDirectory
        ? await loadPackManifest(projectRoot, resourceDirectory, "resources")
        : undefined;
    const directoryName = path.basename(projectRoot);
    const packageName = ensureString(packageJson.name, directoryName);
    const projectName =
        directoryName.length > 0
            ? directoryName
            : packageName.replace(/^@[^/]+\//, "");
    const hasBehaviorPack = Boolean(behavior);
    const hasResourcePack = Boolean(resource);
    const hasScripting = entry.trim().length > 0;
    const availablePacks: PackFeatureSelection = {
        behaviorPack: hasBehaviorPack,
        resourcePack: hasResourcePack,
    };

    if (hasScripting && !hasBehaviorPack) {
        throw new Error(
            "Runtime scripts require a behavior pack. Add behavior_packs/<packName>/manifest.json or remove the runtime entrypoint.",
        );
    }

    const configuredMinecraftTargetVersion = ensureString(
        configFile.minecraft?.targetVersion,
        "",
    );
    const minecraftVersion =
        configuredMinecraftTargetVersion.length > 0
            ? parseMinecraftVersion(configuredMinecraftTargetVersion)
            : parseMinecraftVersion(DEFAULT_MINECRAFT_TARGET_VERSION);
    if (!minecraftVersion) {
        throw new Error(
            configuredMinecraftTargetVersion.length > 0
                ? `${configFileName} minecraft.targetVersion must be a valid Minecraft version such as 1.26.0.2.`
                : "Invalid default Minecraft target version configuration.",
        );
    }

    const config: BlurProject = {
        schemaVersion: 1,
        projectVersion:
            typeof configFile.projectVersion === "number"
                ? configFile.projectVersion
                : 0,
        configPath,
        packageJsonPath,
        namespace: configFile.namespace ?? "",
        minecraft: {
            channel: ensureMinecraftChannel(
                configFile.minecraft?.channel,
                DEFAULT_MINECRAFT_CHANNEL,
            ),
            targetVersion: minecraftVersion.normalized,
            minEngineVersion: minecraftVersion.minEngineVersion,
        },
        features: {
            behaviorPack: hasBehaviorPack,
            resourcePack: hasResourcePack,
            scripting: hasScripting,
        },
        automation: {
            localDeploy: {
                copy: resolvePackFeatureSelection(
                    configFile.dev?.localDeploy?.copy,
                    availablePacks,
                ),
            },
            localServer: {
                copy: resolvePackFeatureSelection(
                    configFile.dev?.localServer?.copy,
                    availablePacks,
                ),
                attach: resolvePackFeatureSelection(
                    configFile.dev?.localServer?.attach,
                    availablePacks,
                ),
            },
            package: {
                worldTemplate: {
                    include: resolvePackFeatureSelection(
                        configFile.package?.worldTemplate?.include,
                        availablePacks,
                    ),
                },
            },
        },
        project: {
            name: projectName,
            packageName,
            version: ensureString(packageJson.version, "0.1.0"),
            description: ensureString(
                packageJson.description,
                `${projectName} BlurEngine project`,
            ),
            packageManager: inferPackageManager(packageJson.packageManager),
            language: inferLanguage(entry),
            packName: path.posix.basename(
                behaviorDirectory ?? resourceDirectory ?? projectName,
            ),
        },
        runtime: {
            entry,
            outFile:
                ensureString(
                    configFile.runtime?.outFile,
                    DEFAULT_RUNTIME_OUTFILE,
                ) || DEFAULT_RUNTIME_OUTFILE,
            target:
                ensureString(
                    configFile.runtime?.target,
                    DEFAULT_RUNTIME_TARGET,
                ) || DEFAULT_RUNTIME_TARGET,
            sourcemap: ensureBoolean(configFile.runtime?.sourcemap, true),
            externalModules: dedupeStrings(
                ensureStringArray(
                    configFile.runtime?.externalModules,
                    DEFAULT_EXTERNAL_MODULES,
                ),
            ),
        },
        bebe: {
            zoneEditor: resolveBebeZoneEditorPolicy(
                configFile.bebe?.zoneEditor,
                DEFAULT_BEBE_ZONE_EDITOR,
            ),
            diagnostics: {
                missingReferences: resolveBebeDiagnosticPolicy(
                    configFile.bebe?.diagnostics?.missingReferences,
                    DEFAULT_BEBE_MISSING_REFERENCE_DIAGNOSTICS,
                ),
            },
        },
        packs: {
            behavior: behavior
                ? {
                      ...behavior,
                  }
                : undefined,
            resource: resource
                ? {
                      ...resource,
                  }
                : undefined,
        },
        dev: {
            watch: {
                paths: dedupeStrings(
                    ensureStringArray(
                        configFile.dev?.watch?.paths,
                        DEFAULT_WATCH_PATHS,
                    ),
                ),
                debounceMs: Math.max(
                    25,
                    Number(configFile.dev?.watch?.debounceMs ?? 150) || 150,
                ),
                scriptsEnabledByDefault: ensureBoolean(
                    configFile.dev?.watch?.scriptsEnabledByDefault,
                    true,
                ),
                worldEnabledByDefault: ensureBoolean(
                    configFile.dev?.watch?.worldEnabledByDefault,
                    false,
                ),
                allowlistEnabledByDefault: ensureBoolean(
                    configFile.dev?.watch?.allowlistEnabledByDefault,
                    true,
                ),
            },
            localDeploy: {
                enabledByDefault: ensureBoolean(
                    configFile.dev?.localDeploy?.enabledByDefault,
                    false,
                ),
            },
            localServer: {
                enabledByDefault: ensureBoolean(
                    configFile.dev?.localServer?.enabledByDefault,
                    true,
                ),
                worldName:
                    ensureString(configFile.dev?.localServer?.worldName, "") ||
                    DEFAULT_BDS_WORLD_NAME,
                worldSourcePath:
                    ensureString(
                        configFile.dev?.localServer?.worldSourcePath,
                        "",
                    ) ||
                    defaultProjectWorldSourcePath(
                        ensureString(
                            configFile.dev?.localServer?.worldName,
                            "",
                        ) || DEFAULT_BDS_WORLD_NAME,
                    ),
                restartOnWorldChange: ensureBoolean(
                    configFile.dev?.localServer?.restartOnWorldChange,
                    true,
                ),
                compactScriptingLogs: ensureBoolean(
                    configFile.dev?.localServer?.compactScriptingLogs,
                    true,
                ),
                allowlist: ensureStringArray(
                    configFile.dev?.localServer?.allowlist,
                    [],
                ),
                operators: ensureStringArray(
                    configFile.dev?.localServer?.operators,
                    [],
                ),
                defaultPermissionLevel: ensurePermissionLevel(
                    configFile.dev?.localServer?.defaultPermissionLevel,
                    "operator",
                ),
                gamemode:
                    ensureString(configFile.dev?.localServer?.gamemode, "") ||
                    "creative",
                link: {
                    enabled: ensureBoolean(
                        configFile.dev?.localServer?.link?.enabled,
                        true,
                    ),
                    host:
                        ensureString(
                            configFile.dev?.localServer?.link?.host,
                            "",
                        ) || DEFAULT_LINK_SERVER_HOST,
                    port: ensurePort(
                        configFile.dev?.localServer?.link?.port,
                        DEFAULT_LINK_SERVER_PORT,
                    ),
                    dashboard: {
                        enabled: ensureBoolean(
                            configFile.dev?.localServer?.link?.dashboard
                                ?.enabled,
                            true,
                        ),
                    },
                },
                worldSync: {
                    projectWorldMode: ensureWorldSyncProjectMode(
                        configFile.dev?.localServer?.worldSync
                            ?.projectWorldMode,
                        "prompt",
                    ),
                    runtimeWorldMode: ensureWorldSyncRuntimeMode(
                        configFile.dev?.localServer?.worldSync
                            ?.runtimeWorldMode,
                        "prompt",
                    ),
                },
            },
        },
        upgrade: {
            refreshAgents: ensureBoolean(
                configFile.upgrade?.refreshAgents,
                true,
            ),
            refreshDependencies: ensureBoolean(
                configFile.upgrade?.refreshDependencies,
                true,
            ),
        },
        world: {
            backend: ensureWorldBackend(
                configFile.world?.backend,
                DEFAULT_WORLD_BACKEND,
            ),
            s3: {
                bucket: ensureString(configFile.world?.s3?.bucket, ""),
                region: ensureString(configFile.world?.s3?.region, ""),
                endpoint: ensureString(configFile.world?.s3?.endpoint, ""),
                keyPrefix: ensureString(
                    configFile.world?.s3?.keyPrefix,
                    "worlds",
                ),
                projectPrefix: ensureBoolean(
                    configFile.world?.s3?.projectPrefix,
                    false,
                ),
                forcePathStyle: ensureBoolean(
                    configFile.world?.s3?.forcePathStyle,
                    false,
                ),
                lockTtlSeconds: Math.max(
                    60,
                    Number(
                        configFile.world?.s3?.lockTtlSeconds ??
                            DEFAULT_WORLD_S3_LOCK_TTL_SECONDS,
                    ) || DEFAULT_WORLD_S3_LOCK_TTL_SECONDS,
                ),
            },
        },
        package: {
            defaultTarget: ensurePackageTarget(
                configFile.package?.defaultTarget,
            ),
            defaultTargets: ensurePackageTargets(
                configFile.package?.defaultTargets,
            ),
            world: {
                format: ensureWorldPackageFormat(
                    configFile.package?.world?.format,
                    DEFAULT_WORLD_PACKAGE_FORMAT,
                ),
                layout: ensureWorldPackageLayout(
                    configFile.package?.world?.layout,
                    "bedrock-root",
                ),
            },
            assets: {
                worldImage: {
                    enabled: ensureBoolean(
                        configFile.package?.assets?.worldImage?.enabled,
                        true,
                    ),
                    dimension: ensureWorldImageDimension(
                        configFile.package?.assets?.worldImage?.dimension,
                        "overworld",
                    ),
                    scale: ensureWorldImageScale(
                        configFile.package?.assets?.worldImage?.scale,
                        1,
                    ),
                    fileName:
                        ensureString(
                            configFile.package?.assets?.worldImage?.fileName,
                            "",
                        ) || "map.png",
                },
            },
        },
    };

    config.dev.localServer.worldName = assertValidWorldName(
        config.dev.localServer.worldName,
        "dev.localServer.worldName",
    );
    config.runtime.entry = assertProjectRelativePath(
        projectRoot,
        config.runtime.entry,
        "runtime.entry",
        { allowEmpty: true },
    );
    config.runtime.outFile = assertProjectRelativePath(
        projectRoot,
        config.runtime.outFile,
        "runtime.outFile",
    );
    config.dev.localServer.worldSourcePath = assertProjectRelativePath(
        projectRoot,
        config.dev.localServer.worldSourcePath,
        "dev.localServer.worldSourcePath",
    );
    config.dev.watch.paths = config.dev.watch.paths.map((watchPath, index) =>
        assertProjectRelativePath(
            projectRoot,
            watchPath,
            `dev.watch.paths[${index}]`,
            {
                allowGlob: true,
            },
        ),
    );

    if (!options.allowProjectVersionMismatch) {
        if (config.projectVersion === 0) {
            throw new Error(
                `Project version is not set in ${configFileName}. Run "blr upgrade" to align this project with the current scaffold contract.`,
            );
        }
        if (config.projectVersion < CURRENT_PROJECT_VERSION) {
            throw new Error(
                `Project version ${config.projectVersion} is older than the current scaffold version ${CURRENT_PROJECT_VERSION}. Run "blr upgrade" before using this command.`,
            );
        }
        if (config.projectVersion > CURRENT_PROJECT_VERSION) {
            throw new Error(
                `Project version ${config.projectVersion} is newer than this CLI supports (${CURRENT_PROJECT_VERSION}). Upgrade @blurengine/cli before using this command.`,
            );
        }
    }

    return {
        projectRoot,
        configPath,
        config,
    };
}
