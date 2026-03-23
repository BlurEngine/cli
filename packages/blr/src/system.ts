import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadBlurConfig } from "./config.js";
import { BLR_CONFIG_FILE, CURRENT_PROJECT_VERSION } from "./constants.js";
import type { DebugLogger } from "./debug.js";
import { resolveMachineSettings } from "./environment.js";
import { exists, isDirectory, readJson } from "./fs.js";
import { resolveMinecraftVersionStatus } from "./minecraft-version.js";
import { describeMinecraftDevelopmentRootResolution } from "./runtime.js";
import { resolveProjectServerStatePath } from "./server-state.js";
import type {
    BlurMachineSettings,
    BlurProject,
    MinecraftProduct,
    PackageManager,
} from "./types.js";
import type { FetchImplementation } from "./bedrock-downloads.js";
import {
    getCliPackageVersion,
    inferPackageManager,
    resolvePmExecutable,
} from "./utils.js";
import { describeWorldStatus, type WorldStatus } from "./world-backend.js";
import {
    resolveConfiguredWorldSourcePath,
    resolveProjectWorldSourceDirectory,
} from "./world.js";

export type SystemOutputFormat = "text" | "json" | "markdown";

export type SystemInfoOptions = {
    includePaths?: boolean;
    includeRemote?: boolean;
    debug?: DebugLogger;
    fetchImplementation?: FetchImplementation;
};

export type DoctorCheckStatus = "pass" | "warn" | "fail";

export type DoctorCheck = {
    id: string;
    status: DoctorCheckStatus;
    summary: string;
    detail?: string;
};

export type SystemDoctorReport = {
    ok: boolean;
    checks: DoctorCheck[];
};

type RawProjectSummary = {
    schemaVersion?: number;
    projectVersion?: number;
    namespace?: string;
    minecraft?: {
        channel?: string;
        targetVersion?: string;
    };
    world?: {
        backend?: string;
    };
    dev?: {
        localServer?: {
            worldName?: string;
            worldSourcePath?: string;
        };
    };
    packageJson?: {
        name?: string;
        version?: string;
        packageManager?: PackageManager;
    };
};

type LoadedProjectInspection = {
    projectRoot: string;
    config: BlurProject;
    machine: BlurMachineSettings;
    worldStatus: WorldStatus;
    remoteStatusError?: string;
    localDeployResolution: Awaited<
        ReturnType<typeof describeMinecraftDevelopmentRootResolution>
    >;
    serverState: {
        allowlistExists: boolean;
        permissionsExists: boolean;
    };
};

type ProjectInspection =
    | {
          detected: false;
          hasConfigFile: boolean;
          hasPackageJson: boolean;
      }
    | {
          detected: true;
          hasConfigFile: boolean;
          hasPackageJson: boolean;
          valid: false;
          loadError: string;
          raw?: RawProjectSummary;
      }
    | {
          detected: true;
          hasConfigFile: boolean;
          hasPackageJson: boolean;
          valid: true;
          raw?: RawProjectSummary;
          loaded: LoadedProjectInspection;
      };

export type SystemInfo = {
    cli: {
        packageName: "@blurengine/cli";
        version: string;
        installSource: "workspace" | "node_modules" | "custom";
        packageRoot?: string;
    };
    environment: {
        platform: NodeJS.Platform;
        release: string;
        arch: string;
        nodeVersion: string;
        packageManager?: PackageManager;
        packageManagerVersion?: string;
        cwd?: string;
    };
    project: {
        detected: boolean;
        hasConfigFile: boolean;
        hasPackageJson: boolean;
        valid?: boolean;
        loadError?: string;
        schemaVersion?: number;
        projectVersion?: number;
        projectVersionStatus?: "current" | "outdated" | "future" | "unknown";
        namespace?: string;
        name?: string;
        packageName?: string;
        version?: string;
        packageManager?: PackageManager;
        minecraft?: {
            channel?: string;
            targetVersion?: string;
            minEngineVersion?: string;
        };
        features?: {
            behaviorPack: boolean;
            resourcePack: boolean;
            scripting: boolean;
        };
        runtime?: {
            entry: string;
            outFile: string;
            target: string;
            scriptingEnabled: boolean;
        };
        packs?: {
            behavior?: string;
            resource?: string;
        };
        world?: {
            name?: string;
            backend?: string;
            sourcePath?: string;
            localExists?: boolean;
            localValid?: boolean;
            remoteObjectExists?: boolean;
            lockPresent?: boolean;
            remote?: {
                bucket: string;
                region: string;
                endpoint?: string;
                keyPrefix: string;
                objectKey: string;
                lockKey: string;
            };
            remoteError?: string;
        };
        serverState?: {
            allowlistExists: boolean;
            permissionsExists: boolean;
        };
        root?: string;
        configPath?: string;
        packageJsonPath?: string;
    };
    machine?: {
        localDeploy: {
            minecraftProduct: MinecraftProduct | "auto";
            resolved: boolean;
            resolvedDevelopmentRoot?: string;
            attemptedProducts?: string[];
            resolutionError?: string;
        };
        localServer: {
            bdsVersion: string;
            platform: string;
            cacheDirectory?: string;
            serverDirectory?: string;
        };
    };
};

function ensureRecord(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return {};
    }
    return value as Record<string, unknown>;
}

function ensureString(value: unknown): string | undefined {
    return typeof value === "string" && value.trim().length > 0
        ? value
        : undefined;
}

function normalizeForComparison(value: string): string {
    return process.platform === "win32" ? value.toLowerCase() : value;
}

function redactHomePath(targetPath: string): string {
    const resolved = path.resolve(targetPath);
    const home = os.homedir();
    if (!home) {
        return resolved;
    }

    const normalizedResolved = normalizeForComparison(resolved);
    const normalizedHome = normalizeForComparison(home);
    if (normalizedResolved === normalizedHome) {
        return "<home>";
    }
    if (normalizedResolved.startsWith(`${normalizedHome}${path.sep}`)) {
        return `<home>${resolved.slice(home.length)}`;
    }
    return resolved;
}

function resolveInstallSource(
    packageRoot: string,
): "workspace" | "node_modules" | "custom" {
    const normalized = packageRoot.replace(/\\/g, "/");
    if (normalized.includes("/node_modules/")) {
        return "node_modules";
    }
    if (normalized.endsWith("/packages/blr")) {
        return "workspace";
    }
    return "custom";
}

function resolveCliPackageRoot(): string {
    const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
    return path.resolve(moduleDirectory, "..");
}

function resolveCommandVersion(command: PackageManager): string | undefined {
    const userAgent = process.env.npm_config_user_agent;
    if (userAgent) {
        const [firstToken] = userAgent.split(" ");
        const [name, version] = firstToken.split("/");
        if (name === command && version) {
            return version;
        }
    }

    const executable = resolvePmExecutable(command);
    const result =
        process.platform === "win32"
            ? spawnSync(
                  "cmd.exe",
                  ["/d", "/s", "/c", executable, "--version"],
                  {
                      encoding: "utf8",
                  },
              )
            : spawnSync(executable, ["--version"], {
                  encoding: "utf8",
              });

    if (result.status !== 0 || result.error) {
        return undefined;
    }
    return result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
}

function summarizeRawProject(
    configInput: unknown,
    packageInput: unknown,
): RawProjectSummary {
    const config = ensureRecord(configInput);
    const minecraft = ensureRecord(config.minecraft);
    const world = ensureRecord(config.world);
    const dev = ensureRecord(config.dev);
    const localServer = ensureRecord(dev.localServer);
    const packageJson = ensureRecord(packageInput);

    return {
        schemaVersion:
            typeof config.schemaVersion === "number"
                ? config.schemaVersion
                : undefined,
        projectVersion:
            typeof config.projectVersion === "number"
                ? config.projectVersion
                : undefined,
        namespace: ensureString(config.namespace),
        minecraft: {
            channel: ensureString(minecraft.channel),
            targetVersion: ensureString(minecraft.targetVersion),
        },
        world: {
            backend: ensureString(world.backend),
        },
        dev: {
            localServer: {
                worldName: ensureString(localServer.worldName),
                worldSourcePath: ensureString(localServer.worldSourcePath),
            },
        },
        packageJson: {
            name: ensureString(packageJson.name),
            version: ensureString(packageJson.version),
            packageManager: inferPackageManager(
                ensureString(packageJson.packageManager),
            ),
        },
    };
}

function resolveProjectVersionStatus(
    projectVersion: number | undefined,
): "current" | "outdated" | "future" | "unknown" {
    if (typeof projectVersion !== "number") {
        return "unknown";
    }
    if (projectVersion < CURRENT_PROJECT_VERSION) {
        return "outdated";
    }
    if (projectVersion > CURRENT_PROJECT_VERSION) {
        return "future";
    }
    return "current";
}

async function resolveLocalWorldStatus(
    projectRoot: string,
    config: BlurProject,
): Promise<WorldStatus> {
    const worldName = config.dev.localServer.worldName;
    const worldSourcePath = resolveConfiguredWorldSourcePath(config, worldName);
    const worldSourceDirectory = resolveProjectWorldSourceDirectory(
        projectRoot,
        worldSourcePath,
    );
    const dbDirectory = path.join(worldSourceDirectory, "db");
    const localExists = await isDirectory(worldSourceDirectory);
    const localValid = localExists && (await isDirectory(dbDirectory));

    return {
        backend: "local",
        worldName,
        worldSourcePath,
        worldSourceDirectory,
        local: {
            exists: localExists,
            valid: localValid,
            dbDirectory,
        },
    };
}
async function inspectProject(
    cwd: string,
    options: Pick<SystemInfoOptions, "includeRemote" | "debug">,
): Promise<ProjectInspection> {
    const configPath = path.resolve(cwd, BLR_CONFIG_FILE);
    const packageJsonPath = path.resolve(cwd, "package.json");
    const [hasConfigFile, hasPackageJson] = await Promise.all([
        exists(configPath),
        exists(packageJsonPath),
    ]);

    if (!hasConfigFile && !hasPackageJson) {
        return {
            detected: false,
            hasConfigFile,
            hasPackageJson,
        };
    }

    let rawSummary: RawProjectSummary | undefined;
    try {
        const rawConfig = hasConfigFile
            ? await readJson<unknown>(configPath)
            : {};
        const rawPackageJson = hasPackageJson
            ? await readJson<unknown>(packageJsonPath)
            : {};
        rawSummary = summarizeRawProject(rawConfig, rawPackageJson);
    } catch {
        rawSummary = undefined;
    }

    try {
        const { projectRoot, config } = await loadBlurConfig(cwd, {
            allowProjectVersionMismatch: true,
        });
        const machine = resolveMachineSettings(
            projectRoot,
            {},
            {
                minecraftChannel: config.minecraft.channel,
                bdsVersion: config.minecraft.targetVersion,
            },
        );
        const localDeployResolution =
            await describeMinecraftDevelopmentRootResolution(
                projectRoot,
                config,
                machine,
            );
        let worldStatus: WorldStatus;
        let remoteStatusError: string | undefined;

        if (config.world.backend === "s3" && options.includeRemote) {
            try {
                worldStatus = await describeWorldStatus(
                    projectRoot,
                    config,
                    config.dev.localServer.worldName,
                    options.debug,
                );
            } catch (error) {
                remoteStatusError =
                    error instanceof Error ? error.message : String(error);
                worldStatus = await resolveLocalWorldStatus(
                    projectRoot,
                    config,
                );
            }
        } else {
            worldStatus =
                config.world.backend === "s3"
                    ? await resolveLocalWorldStatus(projectRoot, config)
                    : await describeWorldStatus(
                          projectRoot,
                          config,
                          config.dev.localServer.worldName,
                          options.debug,
                      );
        }

        const [allowlistExists, permissionsExists] = await Promise.all([
            exists(
                resolveProjectServerStatePath(projectRoot, "allowlist.json"),
            ),
            exists(
                resolveProjectServerStatePath(projectRoot, "permissions.json"),
            ),
        ]);

        return {
            detected: true,
            hasConfigFile,
            hasPackageJson,
            valid: true,
            raw: rawSummary,
            loaded: {
                projectRoot,
                config,
                machine,
                worldStatus,
                remoteStatusError,
                localDeployResolution,
                serverState: {
                    allowlistExists,
                    permissionsExists,
                },
            },
        };
    } catch (error) {
        return {
            detected: true,
            hasConfigFile,
            hasPackageJson,
            valid: false,
            loadError: error instanceof Error ? error.message : String(error),
            raw: rawSummary,
        };
    }
}

export async function collectSystemInfo(
    cwd = process.cwd(),
    options: SystemInfoOptions = {},
): Promise<SystemInfo> {
    const packageRoot = resolveCliPackageRoot();
    const packageVersion = await getCliPackageVersion();
    const projectInspection = await inspectProject(cwd, options);

    const packageManager =
        projectInspection.detected && projectInspection.valid
            ? projectInspection.loaded.config.project.packageManager
            : "npm";
    const packageManagerVersion = resolveCommandVersion(packageManager);

    const info: SystemInfo = {
        cli: {
            packageName: "@blurengine/cli",
            version: packageVersion,
            installSource: resolveInstallSource(packageRoot),
            packageRoot: options.includePaths
                ? redactHomePath(packageRoot)
                : undefined,
        },
        environment: {
            platform: process.platform,
            release: os.release(),
            arch: process.arch,
            nodeVersion: process.version,
            packageManager,
            packageManagerVersion,
            cwd: options.includePaths ? redactHomePath(cwd) : undefined,
        },
        project: {
            detected: projectInspection.detected,
            hasConfigFile: projectInspection.hasConfigFile,
            hasPackageJson: projectInspection.hasPackageJson,
        },
    };

    if (!projectInspection.detected) {
        return info;
    }

    if (!projectInspection.valid) {
        info.project.valid = false;
        info.project.loadError = projectInspection.loadError;
        info.project.schemaVersion = projectInspection.raw?.schemaVersion;
        info.project.projectVersion = projectInspection.raw?.projectVersion;
        info.project.projectVersionStatus = resolveProjectVersionStatus(
            projectInspection.raw?.projectVersion,
        );
        info.project.namespace = projectInspection.raw?.namespace;
        info.project.name = projectInspection.raw?.packageJson?.name;
        info.project.version = projectInspection.raw?.packageJson?.version;
        info.project.packageManager =
            projectInspection.raw?.packageJson?.packageManager;
        info.project.minecraft = {
            channel: projectInspection.raw?.minecraft?.channel,
            targetVersion: projectInspection.raw?.minecraft?.targetVersion,
        };
        info.project.world = {
            name: projectInspection.raw?.dev?.localServer?.worldName,
            backend: projectInspection.raw?.world?.backend,
            sourcePath:
                projectInspection.raw?.dev?.localServer?.worldSourcePath,
        };
        return info;
    }

    const {
        projectRoot,
        config,
        machine,
        worldStatus,
        localDeployResolution,
        serverState,
        remoteStatusError,
    } = projectInspection.loaded;

    info.project.valid = true;
    info.project.schemaVersion = config.schemaVersion;
    info.project.projectVersion = config.projectVersion;
    info.project.projectVersionStatus = resolveProjectVersionStatus(
        config.projectVersion,
    );
    info.project.namespace = config.namespace;
    info.project.name = config.project.name;
    info.project.packageName = config.project.packageName;
    info.project.version = config.project.version;
    info.project.packageManager = config.project.packageManager;
    info.project.minecraft = {
        channel: config.minecraft.channel,
        targetVersion: config.minecraft.targetVersion,
        minEngineVersion: config.minecraft.minEngineVersion.join("."),
    };
    info.project.features = { ...config.features };
    info.project.runtime = {
        entry: config.runtime.entry,
        outFile: config.runtime.outFile,
        target: config.runtime.target,
        scriptingEnabled: config.features.scripting,
    };
    info.project.packs = {
        behavior: config.packs.behavior?.directory,
        resource: config.packs.resource?.directory,
    };
    info.project.world = {
        name: config.dev.localServer.worldName,
        backend: config.world.backend,
        sourcePath: worldStatus.worldSourcePath,
        localExists: worldStatus.local.exists,
        localValid: worldStatus.local.valid,
        remoteObjectExists: worldStatus.s3?.remoteObjectExists,
        lockPresent: Boolean(worldStatus.s3?.lock),
        remote:
            options.includeRemote && worldStatus.s3
                ? {
                      bucket: worldStatus.s3.bucket,
                      region: worldStatus.s3.region,
                      endpoint: worldStatus.s3.endpoint || undefined,
                      keyPrefix: worldStatus.s3.keyPrefix,
                      objectKey: worldStatus.s3.objectKey,
                      lockKey: worldStatus.s3.lockKey,
                  }
                : undefined,
        remoteError: remoteStatusError,
    };
    info.project.serverState = serverState;
    if (options.includePaths) {
        info.project.root = redactHomePath(projectRoot);
        info.project.configPath = redactHomePath(config.configPath);
        info.project.packageJsonPath = redactHomePath(config.packageJsonPath);
    }

    info.machine = {
        localDeploy: {
            minecraftProduct: machine.localDeploy.minecraftProduct,
            resolved: Boolean(localDeployResolution.resolvedRoot),
            resolvedDevelopmentRoot:
                options.includePaths && localDeployResolution.resolvedRoot
                    ? redactHomePath(localDeployResolution.resolvedRoot)
                    : undefined,
            attemptedProducts: localDeployResolution.attemptedRoots.map(
                (attempt) => attempt.product,
            ),
            resolutionError: localDeployResolution.resolvedRoot
                ? undefined
                : "Unable to resolve the Minecraft development root with the current settings.",
        },
        localServer: {
            bdsVersion: machine.localServer.bdsVersion,
            platform: machine.localServer.platform,
            cacheDirectory: options.includePaths
                ? redactHomePath(
                      path.resolve(
                          projectRoot,
                          machine.localServer.cacheDirectory,
                      ),
                  )
                : undefined,
            serverDirectory: options.includePaths
                ? redactHomePath(
                      path.resolve(
                          projectRoot,
                          machine.localServer.serverDirectory,
                      ),
                  )
                : undefined,
        },
    };

    return info;
}

export async function collectSystemDoctorReport(
    cwd = process.cwd(),
    options: SystemInfoOptions = {},
): Promise<SystemDoctorReport> {
    const projectInspection = await inspectProject(cwd, {
        includeRemote: options.includeRemote,
        debug: options.debug,
    });
    const checks: DoctorCheck[] = [];

    if (!projectInspection.detected) {
        checks.push({
            id: "project.context",
            status: "fail",
            summary: `No ${BLR_CONFIG_FILE} project was detected in the current directory.`,
            detail: "Run this command from a generated BlurEngine project when you want project-specific diagnostics.",
        });
        return {
            ok: false,
            checks,
        };
    }

    if (!projectInspection.valid) {
        checks.push({
            id: "project.load",
            status: "fail",
            summary: "BlurEngine project configuration could not be loaded.",
            detail: projectInspection.loadError,
        });
        return {
            ok: false,
            checks,
        };
    }

    const {
        config,
        machine,
        worldStatus,
        localDeployResolution,
        remoteStatusError,
    } = projectInspection.loaded;
    const projectVersionStatus = resolveProjectVersionStatus(
        config.projectVersion,
    );
    if (projectVersionStatus === "current") {
        checks.push({
            id: "project.version",
            status: "pass",
            summary: `Project scaffold version ${config.projectVersion} matches the current CLI scaffold version.`,
        });
    } else if (projectVersionStatus === "outdated") {
        checks.push({
            id: "project.version",
            status: "fail",
            summary: `Project scaffold version ${config.projectVersion} is older than the current CLI scaffold version ${CURRENT_PROJECT_VERSION}.`,
            detail: 'Run "blr upgrade" before using the project normally.',
        });
    } else {
        checks.push({
            id: "project.version",
            status: "fail",
            summary: `Project scaffold version ${config.projectVersion} is newer than this CLI supports.`,
            detail: "Upgrade @blurengine/cli before using the project.",
        });
    }

    try {
        const minecraftStatus = await resolveMinecraftVersionStatus(
            config.minecraft.channel,
            config.minecraft.targetVersion,
            options.debug,
            options.fetchImplementation,
        );
        if (minecraftStatus.looksLikeChannelMismatch) {
            checks.push({
                id: "minecraft.targetVersion",
                status: "fail",
                summary: `${config.minecraft.targetVersion} appears to belong to the ${minecraftStatus.oppositeChannel} channel, not ${config.minecraft.channel}.`,
                detail: "Align minecraft.channel and minecraft.targetVersion, or run `blr minecraft update`.",
            });
        } else if (!minecraftStatus.artifactAvailable) {
            checks.push({
                id: "minecraft.targetVersion",
                status: "fail",
                summary: `${config.minecraft.targetVersion} does not currently resolve on the ${config.minecraft.channel} dedicated-server channel.`,
                detail: 'Run "blr minecraft check" or "blr minecraft update" to align the project version.',
            });
        } else if (minecraftStatus.outdated) {
            checks.push({
                id: "minecraft.targetVersion",
                status: "warn",
                summary: `A newer ${config.minecraft.channel} Bedrock dedicated-server version is available (${minecraftStatus.latestVersion}).`,
                detail: "The project can still run, but `blr minecraft update` is recommended.",
            });
        } else {
            checks.push({
                id: "minecraft.targetVersion",
                status: "pass",
                summary: `minecraft.targetVersion resolves correctly on the ${config.minecraft.channel} channel.`,
            });
        }
    } catch (error) {
        checks.push({
            id: "minecraft.targetVersion",
            status: "warn",
            summary:
                "Unable to check the latest Bedrock dedicated-server version.",
            detail: error instanceof Error ? error.message : String(error),
        });
    }

    if (config.features.scripting) {
        checks.push({
            id: "runtime.entry",
            status: "pass",
            summary: `Scripting is enabled with runtime entry ${config.runtime.entry}.`,
        });
    } else {
        checks.push({
            id: "runtime.entry",
            status: "pass",
            summary: "Scripting is disabled for this project.",
        });
    }

    if (worldStatus.local.valid) {
        checks.push({
            id: "world.source",
            status: "pass",
            summary: `The active world source "${worldStatus.worldName}" is present and valid.`,
        });
    } else {
        checks.push({
            id: "world.source",
            status: "warn",
            summary: `The active world source "${worldStatus.worldName}" is missing or does not contain a valid Bedrock world.`,
            detail:
                config.world.backend === "s3"
                    ? 'Run "blr world pull" before using watch-world or world-template packaging.'
                    : "watch-world and world-template packaging will stay unavailable until a valid world source exists.",
        });
    }

    if (config.world.backend === "s3") {
        if (remoteStatusError) {
            checks.push({
                id: "world.remote",
                status: "warn",
                summary:
                    "Remote world status could not be resolved from the configured S3 backend.",
                detail: remoteStatusError,
            });
        } else if (worldStatus.s3?.remoteObjectExists === false) {
            checks.push({
                id: "world.remote",
                status: "warn",
                summary: `No remote archive exists yet for "${worldStatus.worldName}".`,
                detail: 'Run "blr world push" after you have a valid local world source.',
            });
        } else {
            checks.push({
                id: "world.remote",
                status: "pass",
                summary: `Remote world status resolved successfully for "${worldStatus.worldName}".`,
            });
        }
    }

    if (localDeployResolution.resolvedRoot) {
        checks.push({
            id: "localDeploy.root",
            status: "pass",
            summary: `Local deploy root resolved for ${machine.localDeploy.minecraftProduct}.`,
        });
    } else {
        checks.push({
            id: "localDeploy.root",
            status: "warn",
            summary: "Local deploy root could not be resolved automatically.",
            detail: "Local deploy is optional, but you may need BLR_MACHINE_LOCALDEPLOY_MINECRAFTPRODUCT or BLR_MACHINE_LOCALDEPLOY_MINECRAFTDEVELOPMENTPATH.",
        });
    }

    if (
        config.package.defaultTarget === "world-template" &&
        !worldStatus.local.valid
    ) {
        checks.push({
            id: "package.defaultTarget",
            status: "warn",
            summary:
                "The configured default packaging target requires a valid local world source.",
            detail: "Packaging will fail until the active world source contains a Bedrock world with a db/ directory.",
        });
    }

    return {
        ok: checks.every((check) => check.status !== "fail"),
        checks,
    };
}

function renderBoolean(value: boolean | undefined): string {
    return value === undefined ? "unknown" : value ? "yes" : "no";
}

function createSection(title: string, lines: string[]): string[] {
    return [title, ...lines.map((line) => `- ${line}`), ""];
}

function renderProjectInfoLines(info: SystemInfo): string[] {
    const project = info.project;
    if (!project.detected) {
        return ["- detected: no", ""];
    }

    const lines = [
        `detected: yes`,
        `valid: ${renderBoolean(project.valid)}`,
        `has config file: ${renderBoolean(project.hasConfigFile)}`,
        `has package.json: ${renderBoolean(project.hasPackageJson)}`,
        ...(project.loadError ? [`load error: ${project.loadError}`] : []),
        ...(project.schemaVersion !== undefined
            ? [`schema version: ${project.schemaVersion}`]
            : []),
        ...(project.projectVersion !== undefined
            ? [
                  `project version: ${project.projectVersion} (${project.projectVersionStatus ?? "unknown"})`,
              ]
            : []),
        ...(project.namespace ? [`namespace: ${project.namespace}`] : []),
        ...(project.name ? [`project name: ${project.name}`] : []),
        ...(project.packageName
            ? [`package name: ${project.packageName}`]
            : []),
        ...(project.version ? [`package version: ${project.version}`] : []),
        ...(project.packageManager
            ? [`package manager: ${project.packageManager}`]
            : []),
        ...(project.minecraft?.channel
            ? [`minecraft channel: ${project.minecraft.channel}`]
            : []),
        ...(project.minecraft?.targetVersion
            ? [`minecraft targetVersion: ${project.minecraft.targetVersion}`]
            : []),
        ...(project.features
            ? [
                  `features: behavior=${project.features.behaviorPack}, resource=${project.features.resourcePack}, scripting=${project.features.scripting}`,
              ]
            : []),
        ...(project.runtime
            ? [
                  `runtime: entry=${project.runtime.entry || "(none)"}, outFile=${project.runtime.outFile}`,
              ]
            : []),
        ...(project.world?.name
            ? [
                  `world: ${project.world.name} (${project.world.backend ?? "unknown"})`,
              ]
            : []),
        ...(project.world?.sourcePath
            ? [`world source: ${project.world.sourcePath}`]
            : []),
        ...(project.world?.localExists !== undefined
            ? [
                  `world source exists: ${renderBoolean(project.world.localExists)}`,
              ]
            : []),
        ...(project.world?.localValid !== undefined
            ? [`world source valid: ${renderBoolean(project.world.localValid)}`]
            : []),
        ...(project.serverState
            ? [
                  `server state: allowlist=${project.serverState.allowlistExists}, permissions=${project.serverState.permissionsExists}`,
              ]
            : []),
        ...(project.root ? [`project root: ${project.root}`] : []),
        ...(project.configPath ? [`config path: ${project.configPath}`] : []),
        ...(project.packageJsonPath
            ? [`package.json path: ${project.packageJsonPath}`]
            : []),
    ];
    return lines.map((line) => `- ${line}`).concat([""]);
}
export function renderSystemInfo(
    info: SystemInfo,
    format: SystemOutputFormat,
): string {
    if (format === "json") {
        return `${JSON.stringify(info, null, 2)}\n`;
    }

    if (format === "markdown") {
        const lines = [
            "# BLR System Info",
            "",
            ...createSection("## CLI", [
                `package: ${info.cli.packageName}`,
                `version: ${info.cli.version}`,
                `install source: ${info.cli.installSource}`,
                ...(info.cli.packageRoot
                    ? [`package root: ${info.cli.packageRoot}`]
                    : []),
            ]),
            ...createSection("## Environment", [
                `platform: ${info.environment.platform}`,
                `release: ${info.environment.release}`,
                `arch: ${info.environment.arch}`,
                `node: ${info.environment.nodeVersion}`,
                ...(info.environment.packageManager
                    ? [`package manager: ${info.environment.packageManager}`]
                    : []),
                ...(info.environment.packageManagerVersion
                    ? [
                          `package manager version: ${info.environment.packageManagerVersion}`,
                      ]
                    : []),
                ...(info.environment.cwd
                    ? [`cwd: ${info.environment.cwd}`]
                    : []),
            ]),
            "## Project",
            "",
            ...renderProjectInfoLines(info),
            ...(info.machine
                ? [
                      ...createSection("## Machine", [
                          `local deploy product: ${info.machine.localDeploy.minecraftProduct}`,
                          `local deploy resolved: ${renderBoolean(info.machine.localDeploy.resolved)}`,
                          ...(info.machine.localDeploy.resolvedDevelopmentRoot
                              ? [
                                    `local deploy root: ${info.machine.localDeploy.resolvedDevelopmentRoot}`,
                                ]
                              : []),
                          ...(info.machine.localDeploy.attemptedProducts?.length
                              ? [
                                    `local deploy attempts: ${info.machine.localDeploy.attemptedProducts.join(", ")}`,
                                ]
                              : []),
                          ...(info.machine.localDeploy.resolutionError
                              ? [
                                    `local deploy note: ${info.machine.localDeploy.resolutionError}`,
                                ]
                              : []),
                          `bds version: ${info.machine.localServer.bdsVersion}`,
                          `bds platform: ${info.machine.localServer.platform}`,
                          ...(info.machine.localServer.cacheDirectory
                              ? [
                                    `bds cache: ${info.machine.localServer.cacheDirectory}`,
                                ]
                              : []),
                          ...(info.machine.localServer.serverDirectory
                              ? [
                                    `bds server dir: ${info.machine.localServer.serverDirectory}`,
                                ]
                              : []),
                      ]),
                  ]
                : []),
        ];
        return `${lines.join("\n").trimEnd()}\n`;
    }

    const lines = [
        "BLR System Info",
        "",
        "CLI",
        `- package: ${info.cli.packageName}`,
        `- version: ${info.cli.version}`,
        `- install source: ${info.cli.installSource}`,
        ...(info.cli.packageRoot
            ? [`- package root: ${info.cli.packageRoot}`]
            : []),
        "",
        "Environment",
        `- platform: ${info.environment.platform}`,
        `- release: ${info.environment.release}`,
        `- arch: ${info.environment.arch}`,
        `- node: ${info.environment.nodeVersion}`,
        ...(info.environment.packageManager
            ? [`- package manager: ${info.environment.packageManager}`]
            : []),
        ...(info.environment.packageManagerVersion
            ? [
                  `- package manager version: ${info.environment.packageManagerVersion}`,
              ]
            : []),
        ...(info.environment.cwd ? [`- cwd: ${info.environment.cwd}`] : []),
        "",
        "Project",
        ...renderProjectInfoLines(info),
    ];

    if (info.machine) {
        lines.push(
            "Machine",
            `- local deploy product: ${info.machine.localDeploy.minecraftProduct}`,
            `- local deploy resolved: ${renderBoolean(info.machine.localDeploy.resolved)}`,
            ...(info.machine.localDeploy.resolvedDevelopmentRoot
                ? [
                      `- local deploy root: ${info.machine.localDeploy.resolvedDevelopmentRoot}`,
                  ]
                : []),
            ...(info.machine.localDeploy.attemptedProducts?.length
                ? [
                      `- local deploy attempts: ${info.machine.localDeploy.attemptedProducts.join(", ")}`,
                  ]
                : []),
            ...(info.machine.localDeploy.resolutionError
                ? [
                      `- local deploy note: ${info.machine.localDeploy.resolutionError}`,
                  ]
                : []),
            `- bds version: ${info.machine.localServer.bdsVersion}`,
            `- bds platform: ${info.machine.localServer.platform}`,
            ...(info.machine.localServer.cacheDirectory
                ? [`- bds cache: ${info.machine.localServer.cacheDirectory}`]
                : []),
            ...(info.machine.localServer.serverDirectory
                ? [
                      `- bds server dir: ${info.machine.localServer.serverDirectory}`,
                  ]
                : []),
            "",
        );
    }

    return `${lines.join("\n").trimEnd()}\n`;
}

export function renderSystemDoctor(
    report: SystemDoctorReport,
    format: SystemOutputFormat,
): string {
    if (format === "json") {
        return `${JSON.stringify(report, null, 2)}\n`;
    }

    const counts = report.checks.reduce(
        (acc, check) => {
            acc[check.status] += 1;
            return acc;
        },
        { pass: 0, warn: 0, fail: 0 } satisfies Record<
            DoctorCheckStatus,
            number
        >,
    );

    const renderCheck = (check: DoctorCheck): string[] => {
        const status = check.status.toUpperCase();
        return [
            `- ${status} \`${check.id}\`: ${check.summary}`,
            ...(check.detail ? [`- detail: ${check.detail}`] : []),
        ];
    };

    if (format === "markdown") {
        const lines = [
            "# BLR System Doctor",
            "",
            `- overall: ${report.ok ? "pass" : "fail"}`,
            `- pass: ${counts.pass}`,
            `- warn: ${counts.warn}`,
            `- fail: ${counts.fail}`,
            "",
            "## Checks",
            "",
            ...report.checks.flatMap((check) => [...renderCheck(check), ""]),
        ];
        return `${lines.join("\n").trimEnd()}\n`;
    }

    const lines = [
        "BLR System Doctor",
        "",
        `- overall: ${report.ok ? "pass" : "fail"}`,
        `- pass: ${counts.pass}`,
        `- warn: ${counts.warn}`,
        `- fail: ${counts.fail}`,
        "",
        "Checks",
        ...report.checks.flatMap((check) => [...renderCheck(check), ""]),
    ];
    return `${lines.join("\n").trimEnd()}\n`;
}
