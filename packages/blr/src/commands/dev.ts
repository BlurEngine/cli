import chokidar, { type FSWatcher } from "chokidar";
import { stat } from "node:fs/promises";
import picomatch from "picomatch";
import {
    BdsServerController,
    backupRuntimeWorldForBdsStartup,
    bootstrapProjectWorldSourceFromBds,
    captureAllowlistFromBds,
    capturePermissionsFromBds,
    captureWorldSourceFromBds,
    prefetchBdsArchive,
    replaceRuntimeWorldFromProjectSource,
    resolveBdsRuntimeState,
    type BdsProvisionReporter,
} from "../bds.js";
import {
    clearMinecraftTargetUpdatePromptSilence,
    isMinecraftTargetUpdatePromptSilenced,
    isRemoteWorldUpdatePromptSilenced,
    silenceMinecraftTargetUpdatePrompt,
    silenceRemoteWorldUpdatePrompt,
} from "../cli-state.js";
import { resolvePackFeatureSelection } from "../content.js";
import { loadBlurConfig } from "../config.js";
import { createDebugLogger, resolveDebugEnabled } from "../debug.js";
import { resolveMachineSettings } from "../environment.js";
import { BLR_CONFIG_FILE, BLR_ENV_BDS_VERSION } from "../constants.js";
import {
    applyMinecraftTargetVersion,
    resolveConfiguredMinecraftTargetVersionSource,
    writeMinecraftTargetVersion,
} from "../minecraft-config.js";
import {
    resolveMinecraftArtifactStatus,
    resolveMinecraftVersionStatus,
} from "../minecraft-version.js";
import { buildTrackedProjectWorldFingerprint } from "../project-world-state.js";
import { runPrompt } from "../prompt.js";
import { buildProject, runLocalDeploy } from "../runtime.js";
import type { BlurProject } from "../types.js";
import {
    clearLocalServerSession,
    clearRuntimeWorldSeedState,
    readRuntimeWorldSeedState,
    writeLocalServerSession,
    writeRuntimeWorldSeedState,
} from "../world-internal-state.js";
import { computeProjectWorldSourceIdentity } from "../world-source-identity.js";
import {
    describeWorldStatus,
    pullWorldFromS3,
    type WorldStatus,
} from "../world-backend.js";
import { resolveSelectedWorld } from "../world.js";

type DevCommandOptions = {
    localDeploy?: boolean;
    localDeployBehaviorPack?: boolean;
    localDeployResourcePack?: boolean;
    localServer?: boolean;
    localServerBehaviorPack?: boolean;
    localServerResourcePack?: boolean;
    attachBehaviorPack?: boolean;
    attachResourcePack?: boolean;
    interactive?: boolean;
    watch?: boolean;
    watchScripts?: boolean;
    watchWorld?: boolean;
    watchAllowlist?: boolean;
    production?: boolean;
    minecraftProduct?: string;
    minecraftDevelopmentPath?: string;
    bdsVersion?: string;
    bdsPlatform?: string;
    bdsCacheDir?: string;
    bdsServerDir?: string;
    world?: string;
    restartOnWorldChange?: boolean;
    debug?: boolean;
};

type DevResolvedOptions = {
    localDeploy: boolean;
    localDeployBehaviorPack: boolean;
    localDeployResourcePack: boolean;
    localServer: boolean;
    localServerBehaviorPack: boolean;
    localServerResourcePack: boolean;
    attachBehaviorPack: boolean;
    attachResourcePack: boolean;
    interactive: boolean;
    selectedAnyAction: boolean;
    watch: boolean;
    watchScripts: boolean;
    watchWorld: boolean;
    watchAllowlist: boolean;
    production: boolean;
    minecraftProduct?: string;
    minecraftDevelopmentPath?: string;
    bdsVersion?: string;
    bdsPlatform?: string;
    bdsCacheDir?: string;
    bdsServerDir?: string;
    restartOnWorldChange?: boolean;
    exitMessage?: string;
    exitIsError?: boolean;
    abortBeforeStart?: boolean;
};

type DevDefaultSelections = {
    localDeploy: boolean;
    localDeployBehaviorPack: boolean;
    localDeployResourcePack: boolean;
    localServer: boolean;
    localServerBehaviorPack: boolean;
    localServerResourcePack: boolean;
    attachBehaviorPack: boolean;
    attachResourcePack: boolean;
    watchScripts: boolean;
    watchWorld: boolean;
    watchAllowlist: boolean;
};

type MinecraftTargetUpdateChoice = "update" | "continue" | "silence";
export type DevLocalServerVersionSource =
    | "cli-bds-version"
    | "machine-env-bds-version"
    | "config-env-target-version"
    | "config-file-target-version"
    | "default-target-version";
type DevInteractiveSelectionResult = {
    keepLocalServer: boolean;
    exitMessage?: string;
    exitIsError?: boolean;
    continueMessage?: string;
    abortDev?: boolean;
};
type DevInteractiveHooks = {
    onLocalServerSelected?: () => Promise<DevInteractiveSelectionResult | void>;
    onLocalServerConfirmed?: () => Promise<void>;
};

type TrackedTask<T> = {
    promise: Promise<T>;
    isSettled: () => boolean;
};

type WaitOptions = {
    animate?: boolean;
};

type PipelineMode = "start" | "reload" | "restart";
type ProjectWatchChangeAction =
    | {
          kind: "ignore";
          message: string;
      }
    | {
          kind: "sync";
          pipelineMode: "start";
      }
    | {
          kind: "reload";
          pipelineMode: "reload";
      };
type WatchPlan = {
    patterns: string[];
    roots: string[];
    matches: (targetPath: string) => boolean;
};

const GLOB_SEGMENT_PATTERN = /[*?[\]{}()!+@]/;

function normalizeWatchPath(targetPath: string): string {
    const normalized = targetPath.split("\\").join("/");
    return normalized.startsWith("./") ? normalized.slice(2) : normalized;
}

export function mergePipelineModes(
    currentMode: PipelineMode | undefined,
    nextMode: PipelineMode,
): PipelineMode {
    if (currentMode === "restart" || nextMode === "restart") {
        return "restart";
    }

    if (currentMode === "reload" || nextMode === "reload") {
        return "reload";
    }

    return "start";
}

export function resolveProjectWatchChangeAction(
    targetPath: string,
): ProjectWatchChangeAction {
    const normalizedPath = normalizeWatchPath(targetPath).replace(/\/+$/, "");

    if (normalizedPath === BLR_CONFIG_FILE) {
        return {
            kind: "ignore",
            message: `[dev] change ignored: ${BLR_CONFIG_FILE}. Restart dev to apply it.`,
        };
    }

    if (normalizedPath === "package.json") {
        return {
            kind: "ignore",
            message:
                "[dev] change ignored: package.json. Restart dev to apply it.",
        };
    }

    if (
        normalizedPath === "behavior_packs" ||
        normalizedPath.startsWith("behavior_packs/") ||
        normalizedPath === "resource_packs" ||
        normalizedPath.startsWith("resource_packs/")
    ) {
        return {
            kind: "sync",
            pipelineMode: "start",
        };
    }

    return {
        kind: "reload",
        pipelineMode: "reload",
    };
}

function deriveWatchRoot(pattern: string): string {
    const normalized = normalizeWatchPath(pattern).replace(/\/+$/, "");
    if (normalized.length === 0) {
        return ".";
    }

    const segments = normalized
        .split("/")
        .filter((segment) => segment.length > 0);
    const literalSegments: string[] = [];
    for (const segment of segments) {
        if (GLOB_SEGMENT_PATTERN.test(segment)) {
            break;
        }
        literalSegments.push(segment);
    }

    if (literalSegments.length === 0) {
        return ".";
    }

    return literalSegments.join("/");
}

function createWatchPlan(patterns: string[]): WatchPlan {
    const normalizedPatterns = patterns.map((pattern) =>
        normalizeWatchPath(pattern),
    );
    const matchers = normalizedPatterns.map((pattern) =>
        picomatch(pattern, { dot: true }),
    );
    const roots = Array.from(
        new Set(normalizedPatterns.map((pattern) => deriveWatchRoot(pattern))),
    );

    return {
        patterns: normalizedPatterns,
        roots,
        matches(targetPath: string) {
            const normalizedTarget = normalizeWatchPath(targetPath);
            return matchers.some((matcher) => matcher(normalizedTarget));
        },
    };
}

function resolveFlag(
    explicit: boolean | undefined,
    fallback: boolean,
): boolean {
    if (typeof explicit === "boolean") return explicit;
    return fallback;
}

export function shouldUseInteractiveDevConfiguration(
    options: Pick<DevCommandOptions, "interactive">,
): boolean {
    return options.interactive ?? false;
}

export async function resolveDevLocalServerVersionSource(
    configPath: string,
    options: Pick<DevCommandOptions, "bdsVersion">,
): Promise<DevLocalServerVersionSource> {
    const explicitBdsVersion =
        typeof options.bdsVersion === "string" ? options.bdsVersion.trim() : "";
    if (explicitBdsVersion.length > 0) {
        return "cli-bds-version";
    }

    const machineEnvBdsVersion = process.env[BLR_ENV_BDS_VERSION]?.trim();
    if (machineEnvBdsVersion && machineEnvBdsVersion.length > 0) {
        return "machine-env-bds-version";
    }

    const configuredTargetVersionSource =
        await resolveConfiguredMinecraftTargetVersionSource(configPath);
    switch (configuredTargetVersionSource) {
        case "config-env":
            return "config-env-target-version";
        case "config-file":
            return "config-file-target-version";
        default:
            return "default-target-version";
    }
}

function canPromptForDevWorldSync(): boolean {
    return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

function buildRemoteWorldVersioningUnavailableMessage(options: {
    worldName: string;
    detail?: string;
}): string {
    const detail =
        options.detail?.trim() ||
        `Remote world versioning is unavailable for "${options.worldName}".`;
    return `[dev] ${detail}`;
}

function buildRemoteWorldTrackingDriftMessage(options: {
    worldName: string;
    trackedVersionId: string;
}): string {
    return `[dev] "${options.worldName}" tracks version ${options.trackedVersionId}, but that pin belongs to a different remote. Run "blr world pull ${options.worldName}" to establish tracking for the current remote.`;
}

function buildOptionalRemoteWorldUpdateMessage(options: {
    worldName: string;
    currentVersionId: string;
    latestVersionId: string;
}): string {
    return `[dev] Newer remote world available for "${options.worldName}". Current: ${options.currentVersionId}. Latest: ${options.latestVersionId}.`;
}

function buildRequiredProjectWorldMissingMessage(options: {
    worldName: string;
    versionLabel: string;
}): string {
    return `[dev] Project world "${options.worldName}" is missing and must be pulled (${options.versionLabel}).`;
}

function buildRemoteWorldSyncErrorDetail(options: {
    worldName: string;
    error: unknown;
}): string {
    const rawMessage =
        options.error instanceof Error
            ? options.error.message.trim()
            : String(options.error).trim();

    if (
        rawMessage.length === 0 ||
        rawMessage === "UnknownError" ||
        rawMessage === "Error: UnknownError"
    ) {
        return `blr could not synchronize remote world "${options.worldName}" because the S3 backend returned an unknown error. Check the S3 backend compatibility and permissions, or run "blr world status ${options.worldName}" for more detail.`;
    }

    return `blr could not synchronize remote world "${options.worldName}". ${rawMessage}`;
}

export function buildRemoteWorldSyncFailureMessage(options: {
    worldName: string;
    error: unknown;
    continuing?: boolean;
}): string {
    const detail = buildRemoteWorldSyncErrorDetail(options);
    return options.continuing === false
        ? `[dev] ${detail}`
        : `[dev] ${detail} Continuing without remote world sync.`;
}

function resolveCurrentRemoteWorldFingerprint(
    status: NonNullable<WorldStatus["s3"]>,
): string {
    return buildTrackedProjectWorldFingerprint({
        backend: "s3",
        bucket: status.bucket,
        endpoint: status.endpoint,
        objectKey: status.objectKey,
    });
}

async function pullRemoteWorldForDev(options: {
    projectRoot: string;
    config: BlurProject;
    worldName: string;
    versionId: string;
    debug: ReturnType<typeof createDebugLogger>;
}): Promise<void> {
    try {
        await pullWorldFromS3(
            options.projectRoot,
            options.config,
            options.worldName,
            {
                lock: false,
                versionId: options.versionId,
                debug: options.debug,
            },
        );
    } catch (error) {
        throw new Error(
            buildRemoteWorldSyncErrorDetail({
                worldName: options.worldName,
                error,
            }),
        );
    }
}

async function promptForOptionalRemoteWorldUpdate(options: {
    projectRoot: string;
    worldName: string;
    currentVersionId: string;
    latestVersionId: string;
    remoteFingerprint: string;
}): Promise<"pull-latest" | "keep-current" | "silence"> {
    if (
        await isRemoteWorldUpdatePromptSilenced(options.projectRoot, {
            worldName: options.worldName,
            remoteFingerprint: options.remoteFingerprint,
            latestVersionId: options.latestVersionId,
        })
    ) {
        return "keep-current";
    }

    const result = await runPrompt({
        type: "select",
        name: "remoteWorldUpdateChoice",
        message: [
            "Newer remote world found",
            `Current: ${options.currentVersionId}`,
            `Latest: ${options.latestVersionId}`,
            "Choose an action:",
        ].join("\n"),
        choices: [
            {
                title: "Pull latest remote world",
                value: "pull-latest",
            },
            {
                title: "Keep current world",
                value: "keep-current",
            },
            {
                title: "Silence 24h",
                value: "silence",
            },
        ],
        initial: 0,
        hint: "- Use arrow keys. Enter to confirm.",
        instructions: false,
    });
    const choice = result.remoteWorldUpdateChoice as
        | "pull-latest"
        | "keep-current"
        | "silence";
    if (choice === "silence") {
        await silenceRemoteWorldUpdatePrompt(options.projectRoot, {
            worldName: options.worldName,
            remoteFingerprint: options.remoteFingerprint,
            latestVersionId: options.latestVersionId,
        });
    }
    return choice;
}

async function promptForRequiredProjectWorldPull(options: {
    worldName: string;
    versionId: string;
    latest: boolean;
}): Promise<boolean> {
    const result = await runPrompt({
        type: "select",
        name: "requiredRemoteWorldChoice",
        message: [
            "Project world missing",
            `${options.latest ? "Latest" : "Pinned"}: ${options.versionId}`,
            "Choose an action:",
        ].join("\n"),
        choices: [
            {
                title: options.latest
                    ? "Pull latest remote world"
                    : "Pull pinned world",
                value: "pull",
            },
            {
                title: "Exit",
                value: "exit",
            },
        ],
        initial: 0,
        hint: "- Use arrow keys. Enter to confirm.",
        instructions: false,
    });
    return (result.requiredRemoteWorldChoice as string | undefined) === "pull";
}

async function syncRemoteWorldForDev(options: {
    projectRoot: string;
    config: BlurProject;
    worldName: string;
    debug: ReturnType<typeof createDebugLogger>;
}): Promise<void> {
    const status = await describeWorldStatus(
        options.projectRoot,
        options.config,
        options.worldName,
        options.debug,
    );
    if (
        status.backend !== "s3" ||
        !status.s3 ||
        !status.s3.remoteObjectExists
    ) {
        return;
    }

    const currentRemoteFingerprint = resolveCurrentRemoteWorldFingerprint(
        status.s3,
    );
    const trackedVersionId = status.s3.tracked?.versionId;
    const trackedMatchesCurrentRemote =
        status.s3.tracked?.matchesCurrentRemote ?? false;
    const latestVersionId = status.s3.latestObject?.versionId;
    const projectWorldMode =
        options.config.dev.localServer.worldSync.projectWorldMode;
    const canPrompt = canPromptForDevWorldSync();

    if (!status.s3.versioning.available) {
        const message = buildRemoteWorldVersioningUnavailableMessage({
            worldName: options.worldName,
            detail: status.s3.versioning.detail,
        });
        if (
            trackedVersionId &&
            trackedMatchesCurrentRemote &&
            !status.local.valid
        ) {
            throw new Error(
                `${message} blr cannot pull the pinned world without remote versioning.`,
            );
        }
        console.log(message);
        return;
    }

    if (
        trackedVersionId &&
        trackedMatchesCurrentRemote &&
        !status.local.valid
    ) {
        if (projectWorldMode === "manual") {
            throw new Error(
                `${buildRequiredProjectWorldMissingMessage({
                    worldName: options.worldName,
                    versionLabel: `pinned ${trackedVersionId}`,
                })} Run "blr world pull ${options.worldName}" first, or change dev.localServer.worldSync.projectWorldMode.`,
            );
        }

        if (projectWorldMode === "prompt") {
            if (!canPrompt) {
                throw new Error(
                    `${buildRequiredProjectWorldMissingMessage({
                        worldName: options.worldName,
                        versionLabel: `pinned ${trackedVersionId}`,
                    })} Re-run in an interactive terminal or change dev.localServer.worldSync.projectWorldMode.`,
                );
            }
            const shouldPull = await promptForRequiredProjectWorldPull({
                worldName: options.worldName,
                versionId: trackedVersionId,
                latest: false,
            });
            if (!shouldPull) {
                throw new Error(
                    buildRequiredProjectWorldMissingMessage({
                        worldName: options.worldName,
                        versionLabel: `pinned ${trackedVersionId}`,
                    }),
                );
            }
        }

        await pullRemoteWorldForDev({
            projectRoot: options.projectRoot,
            config: options.config,
            worldName: options.worldName,
            versionId: trackedVersionId,
            debug: options.debug,
        });
        console.log(`[dev] Pulled pinned world for "${options.worldName}".`);
        return;
    }

    if (trackedVersionId && !trackedMatchesCurrentRemote) {
        if (!status.local.valid) {
            if (!latestVersionId) {
                throw new Error(
                    `[dev] Project world "${options.worldName}" is missing and the current remote has no latest version to pull.`,
                );
            }

            if (projectWorldMode === "manual") {
                throw new Error(
                    `${buildRequiredProjectWorldMissingMessage({
                        worldName: options.worldName,
                        versionLabel: `latest ${latestVersionId}`,
                    })} The tracked pin belongs to a different remote, so blr cannot recover the project world automatically.`,
                );
            }

            if (projectWorldMode === "prompt") {
                if (!canPrompt) {
                    throw new Error(
                        `${buildRequiredProjectWorldMissingMessage({
                            worldName: options.worldName,
                            versionLabel: `latest ${latestVersionId}`,
                        })} Re-run in an interactive terminal or change dev.localServer.worldSync.projectWorldMode.`,
                    );
                }
                const shouldPull = await promptForRequiredProjectWorldPull({
                    worldName: options.worldName,
                    versionId: latestVersionId,
                    latest: true,
                });
                if (!shouldPull) {
                    throw new Error(
                        buildRequiredProjectWorldMissingMessage({
                            worldName: options.worldName,
                            versionLabel: `latest ${latestVersionId}`,
                        }),
                    );
                }
            }

            await pullRemoteWorldForDev({
                projectRoot: options.projectRoot,
                config: options.config,
                worldName: options.worldName,
                versionId: latestVersionId,
                debug: options.debug,
            });
            console.log(
                `[dev] Pulled latest remote world for "${options.worldName}".`,
            );
            return;
        }

        console.log(
            buildRemoteWorldTrackingDriftMessage({
                worldName: options.worldName,
                trackedVersionId,
            }),
        );
        return;
    }

    if (
        !trackedVersionId ||
        !latestVersionId ||
        trackedVersionId === latestVersionId
    ) {
        return;
    }

    switch (projectWorldMode) {
        case "auto":
            await pullRemoteWorldForDev({
                projectRoot: options.projectRoot,
                config: options.config,
                worldName: options.worldName,
                versionId: latestVersionId,
                debug: options.debug,
            });
            console.log(
                `[dev] Pulled latest remote world for "${options.worldName}".`,
            );
            return;
        case "manual":
            console.log(
                buildOptionalRemoteWorldUpdateMessage({
                    worldName: options.worldName,
                    currentVersionId: trackedVersionId,
                    latestVersionId,
                }),
            );
            return;
        case "prompt":
        default:
            if (!canPrompt) {
                console.log(
                    buildOptionalRemoteWorldUpdateMessage({
                        worldName: options.worldName,
                        currentVersionId: trackedVersionId,
                        latestVersionId,
                    }),
                );
                return;
            }

            switch (
                await promptForOptionalRemoteWorldUpdate({
                    projectRoot: options.projectRoot,
                    worldName: options.worldName,
                    currentVersionId: trackedVersionId,
                    latestVersionId,
                    remoteFingerprint: currentRemoteFingerprint,
                })
            ) {
                case "pull-latest":
                    await pullRemoteWorldForDev({
                        projectRoot: options.projectRoot,
                        config: options.config,
                        worldName: options.worldName,
                        versionId: latestVersionId,
                        debug: options.debug,
                    });
                    console.log(
                        `[dev] Pulled latest remote world for "${options.worldName}".`,
                    );
                    return;
                case "silence":
                case "keep-current":
                default:
                    return;
            }
    }
}

type RuntimeWorldDecision =
    | {
          action: "none";
          sourceIdentity?: string;
          note?: string;
      }
    | {
          action:
              | "copy-missing"
              | "replace"
              | "backup-and-replace"
              | "preserve";
          sourceIdentity: string;
          note?: string;
      };

async function promptForRuntimeWorldAction(): Promise<
    "replace" | "keep" | "backup"
> {
    const result = await runPrompt({
        type: "select",
        name: "runtimeWorldChoice",
        message: ["Replace local-server world?", "Choose an action:"].join(
            "\n",
        ),
        choices: [
            {
                title: "Replace local-server world",
                value: "replace",
            },
            {
                title: "Keep local-server world",
                value: "keep",
            },
            {
                title: "Backup and replace",
                value: "backup",
            },
        ],
        initial: 0,
        hint: "- Use arrow keys. Enter to confirm.",
        instructions: false,
    });
    return result.runtimeWorldChoice as "replace" | "keep" | "backup";
}

async function resolveRuntimeWorldDecision(options: {
    projectRoot: string;
    config: BlurProject;
    runtimeState: ReturnType<typeof resolveBdsRuntimeState>;
}): Promise<RuntimeWorldDecision> {
    const runtimeExists = await stat(options.runtimeState.worldDirectory)
        .then((entry) => entry.isDirectory())
        .catch(() => false);
    const sourceIdentity = await computeProjectWorldSourceIdentity(
        options.runtimeState.worldSourceDirectory,
    );

    if (!sourceIdentity) {
        if (!runtimeExists) {
            await clearRuntimeWorldSeedState(
                options.projectRoot,
                options.runtimeState.worldName,
            );
        }
        return {
            action: "none",
        };
    }

    if (!runtimeExists) {
        return {
            action: "copy-missing",
            sourceIdentity,
        };
    }

    const lastRuntimeSeed = await readRuntimeWorldSeedState(
        options.projectRoot,
        options.runtimeState.worldName,
    );
    if (lastRuntimeSeed?.sourceIdentity === sourceIdentity) {
        return {
            action: "preserve",
            sourceIdentity,
        };
    }

    const runtimeWorldMode =
        options.config.dev.localServer.worldSync.runtimeWorldMode;
    switch (runtimeWorldMode) {
        case "preserve":
            return {
                action: "preserve",
                sourceIdentity,
                note: `[dev] Kept existing local-server world for "${options.runtimeState.worldName}".`,
            };
        case "replace":
            return {
                action: "replace",
                sourceIdentity,
            };
        case "backup":
            return {
                action: "backup-and-replace",
                sourceIdentity,
            };
        case "prompt":
        default:
            if (!canPromptForDevWorldSync()) {
                return {
                    action: "preserve",
                    sourceIdentity,
                    note: `[dev] Project world changed, but local-server world was kept because this run is non-interactive.`,
                };
            }

            switch (await promptForRuntimeWorldAction()) {
                case "replace":
                    return {
                        action: "replace",
                        sourceIdentity,
                    };
                case "backup":
                    return {
                        action: "backup-and-replace",
                        sourceIdentity,
                    };
                case "keep":
                default:
                    return {
                        action: "preserve",
                        sourceIdentity,
                        note: `[dev] Kept existing local-server world for "${options.runtimeState.worldName}".`,
                    };
            }
    }
}

async function applyRuntimeWorldDecision(options: {
    projectRoot: string;
    config: BlurProject;
    runtimeState: ReturnType<typeof resolveBdsRuntimeState>;
    decision: RuntimeWorldDecision;
    debug: ReturnType<typeof createDebugLogger>;
}): Promise<void> {
    if (options.decision.note) {
        console.log(options.decision.note);
    }

    switch (options.decision.action) {
        case "copy-missing":
            await replaceRuntimeWorldFromProjectSource(
                options.projectRoot,
                options.config,
                options.runtimeState,
                {
                    requireWorldSource: true,
                },
                options.debug,
            );
            await writeRuntimeWorldSeedState(options.projectRoot, {
                worldName: options.runtimeState.worldName,
                sourceIdentity: options.decision.sourceIdentity,
            });
            console.log(
                `[dev] Copied project world into local-server for "${options.runtimeState.worldName}".`,
            );
            return;
        case "replace":
            await replaceRuntimeWorldFromProjectSource(
                options.projectRoot,
                options.config,
                options.runtimeState,
                {
                    requireWorldSource: true,
                },
                options.debug,
            );
            await writeRuntimeWorldSeedState(options.projectRoot, {
                worldName: options.runtimeState.worldName,
                sourceIdentity: options.decision.sourceIdentity,
            });
            console.log(
                `[dev] Replaced local-server world for "${options.runtimeState.worldName}".`,
            );
            return;
        case "backup-and-replace": {
            const backupPath = await backupRuntimeWorldForBdsStartup(
                options.runtimeState,
                options.debug,
            );
            await replaceRuntimeWorldFromProjectSource(
                options.projectRoot,
                options.config,
                options.runtimeState,
                {
                    requireWorldSource: true,
                },
                options.debug,
            );
            await writeRuntimeWorldSeedState(options.projectRoot, {
                worldName: options.runtimeState.worldName,
                sourceIdentity: options.decision.sourceIdentity,
            });
            console.log(
                backupPath
                    ? `[dev] Backed up and replaced local-server world for "${options.runtimeState.worldName}".`
                    : `[dev] Replaced local-server world for "${options.runtimeState.worldName}".`,
            );
            return;
        }
        case "preserve":
        case "none":
        default:
            return;
    }
}

function buildUnavailableLocalServerVersionPromptMessage(options: {
    effectiveBdsVersion: string;
    channel: BlurProject["minecraft"]["channel"];
    latestVersion: string;
    looksLikeChannelMismatch: boolean;
    oppositeChannel?: string;
    canPromptForUpgrade: boolean;
}): string {
    const channelLabel = options.channel === "preview" ? "preview" : "stable";
    return [
        `Current: ${options.effectiveBdsVersion}`,
        options.looksLikeChannelMismatch
            ? `Status: looks like ${options.oppositeChannel}, not ${options.channel}`
            : `Status: not available on ${options.channel}`,
        `Latest ${channelLabel}: ${options.latestVersion}`,
        !options.canPromptForUpgrade
            ? "Change it in config, env, or flags if needed."
            : undefined,
        "Choose an action:",
    ]
        .filter((line): line is string => typeof line === "string")
        .join("\n");
}

function buildOutdatedLocalServerVersionPromptMessage(options: {
    effectiveBdsVersion: string;
    channel: BlurProject["minecraft"]["channel"];
    latestVersion: string;
}): string {
    const channelLabel = options.channel === "preview" ? "preview" : "stable";
    return [
        `Current: ${options.effectiveBdsVersion}`,
        `Latest ${channelLabel}: ${options.latestVersion}`,
        "Choose an action:",
    ].join("\n");
}

function logDevExit(message: string, isError = false): void {
    if (isError) {
        if (process.stderr.isTTY) {
            console.error(`\x1b[31m[dev] Error:\x1b[0m ${message}`);
            return;
        }
        console.error(`[dev] Error: ${message}`);
        return;
    }

    console.log(`[dev] ${message}`);
}

function trackTask<T>(promise: Promise<T>): TrackedTask<T> {
    let settled = false;
    return {
        promise: promise.finally(() => {
            settled = true;
        }),
        isSettled: () => settled,
    };
}

async function waitForTrackedTask<T>(
    task: TrackedTask<T>,
    message: string,
    options: WaitOptions = {},
): Promise<T> {
    if (task.isSettled()) {
        return task.promise;
    }

    const animate = options.animate ?? process.stdout.isTTY;
    if (!process.stdout.isTTY || !animate) {
        console.log(`[dev] ${message}`);
        return task.promise;
    }

    const frames = ["|", "/", "-", "\\"];
    let frameIndex = 0;
    const render = () => {
        process.stdout.write(`\r[dev] ${message} ${frames[frameIndex]}`);
    };

    render();
    const interval = setInterval(() => {
        frameIndex = (frameIndex + 1) % frames.length;
        render();
    }, 100);

    try {
        const result = await task.promise;
        clearInterval(interval);
        process.stdout.write("\r");
        process.stdout.clearLine?.(0);
        process.stdout.cursorTo?.(0);
        return result;
    } catch (error) {
        clearInterval(interval);
        process.stdout.write("\r");
        process.stdout.clearLine?.(0);
        process.stdout.cursorTo?.(0);
        throw error;
    }
}

async function waitForPromiseIfSlow<T>(
    promise: Promise<T>,
    message: string,
    delayMs = 250,
    options: WaitOptions = {},
): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const trackedPromise = promise.finally(() => {
        if (timer) {
            clearTimeout(timer);
            timer = undefined;
        }
    });

    const raceResult = await Promise.race([
        trackedPromise.then(() => "done" as const),
        new Promise<"slow">((resolve) => {
            timer = setTimeout(() => resolve("slow"), delayMs);
        }),
    ]);

    if (raceResult === "done") {
        return trackedPromise;
    }

    return waitForTrackedTask(trackTask(trackedPromise), message, options);
}

function formatByteCount(bytes: number): string {
    if (bytes < 1024) {
        return `${bytes} B`;
    }

    const units = ["KB", "MB", "GB", "TB"];
    let value = bytes / 1024;
    let unitIndex = 0;
    while (value >= 1024 && unitIndex < units.length - 1) {
        value /= 1024;
        unitIndex += 1;
    }

    const decimals = value >= 10 ? 0 : 1;
    return `${value.toFixed(decimals)} ${units[unitIndex]}`;
}

function createLocalServerProgressReporter(): BdsProvisionReporter {
    let lastLoggedPercent = -10;
    let lastLoggedBytes = 0;
    let lastLoggedAt = 0;

    return {
        onDownloadStart(progress) {
            const total =
                typeof progress.totalBytes === "number"
                    ? ` (${formatByteCount(progress.totalBytes)})`
                    : "";
            console.log(
                `[dev] local-server downloading Bedrock ${progress.version}${total}...`,
            );
            lastLoggedPercent = -10;
            lastLoggedBytes = 0;
            lastLoggedAt = Date.now();
        },
        onDownloadProgress(progress) {
            const now = Date.now();
            if (
                typeof progress.totalBytes === "number" &&
                progress.totalBytes > 0
            ) {
                const percent = Math.floor(
                    (progress.bytesReceived / progress.totalBytes) * 100,
                );
                if (
                    percent < 100 &&
                    percent < lastLoggedPercent + 10 &&
                    now - lastLoggedAt < 4000
                ) {
                    return;
                }

                lastLoggedPercent = percent;
                lastLoggedAt = now;
                console.log(
                    `[dev] local-server download ${Math.min(percent, 99)}% (${formatByteCount(progress.bytesReceived)} / ${formatByteCount(progress.totalBytes)})`,
                );
                return;
            }

            if (
                progress.bytesReceived - lastLoggedBytes < 8 * 1024 * 1024 &&
                now - lastLoggedAt < 4000
            ) {
                return;
            }

            lastLoggedBytes = progress.bytesReceived;
            lastLoggedAt = now;
            console.log(
                `[dev] local-server downloaded ${formatByteCount(progress.bytesReceived)}...`,
            );
        },
        onDownloadComplete(progress) {
            console.log(
                `[dev] local-server downloaded Bedrock ${progress.version} (${formatByteCount(progress.bytesReceived)}).`,
            );
        },
        onExtractStart(progress) {
            console.log(
                `[dev] local-server extracting Bedrock ${progress.version}...`,
            );
        },
        onExtractComplete(progress) {
            console.log(
                `[dev] local-server prepared Bedrock ${progress.version}.`,
            );
        },
    };
}

function hasActiveDevTargets(options: DevResolvedOptions): boolean {
    return options.localDeploy || options.localServer || options.watchScripts;
}

function filterScriptWatchPatterns(
    patterns: string[],
    worldSourcePath: string,
): string[] {
    const worldPrefix = normalizeWatchPath(worldSourcePath).replace(/\/+$/, "");
    if (worldPrefix.length === 0) {
        return patterns;
    }

    return patterns.filter((pattern) => {
        const normalizedPattern = normalizeWatchPath(pattern).replace(
            /\/+$/,
            "",
        );
        return (
            normalizedPattern !== worldPrefix &&
            !normalizedPattern.startsWith(`${worldPrefix}/`)
        );
    });
}

function resolveNonInteractiveOptions(
    options: DevCommandOptions,
    defaults: DevDefaultSelections,
): DevResolvedOptions {
    const watchWorldRequested = resolveFlag(
        options.watchWorld,
        defaults.watchWorld,
    );
    const watchAllowlistRequested = resolveFlag(
        options.watchAllowlist,
        defaults.watchAllowlist,
    );
    const localServerExplicit = typeof options.localServer === "boolean";
    const localServer = localServerExplicit
        ? Boolean(options.localServer)
        : resolveFlag(options.localServer, defaults.localServer) ||
          watchWorldRequested ||
          watchAllowlistRequested;
    const watchScripts = resolveFlag(
        options.watchScripts,
        defaults.watchScripts,
    );
    const watchWorld = localServer && watchWorldRequested;
    const watchAllowlist = localServer && watchAllowlistRequested;
    const localDeploy = resolveFlag(options.localDeploy, defaults.localDeploy);
    const localDeployBehaviorPack = localDeploy
        ? resolveFlag(
              options.localDeployBehaviorPack,
              defaults.localDeployBehaviorPack,
          )
        : false;
    const localDeployResourcePack = localDeploy
        ? resolveFlag(
              options.localDeployResourcePack,
              defaults.localDeployResourcePack,
          )
        : false;
    const localServerBehaviorPack = localServer
        ? resolveFlag(
              options.localServerBehaviorPack,
              defaults.localServerBehaviorPack,
          )
        : false;
    const localServerResourcePack = localServer
        ? resolveFlag(
              options.localServerResourcePack,
              defaults.localServerResourcePack,
          )
        : false;
    const attachBehaviorPack = localServer
        ? resolveFlag(options.attachBehaviorPack, defaults.attachBehaviorPack)
        : false;
    const attachResourcePack = localServer
        ? resolveFlag(options.attachResourcePack, defaults.attachResourcePack)
        : false;

    return {
        localDeploy,
        localDeployBehaviorPack,
        localDeployResourcePack,
        localServer,
        localServerBehaviorPack,
        localServerResourcePack,
        attachBehaviorPack,
        attachResourcePack,
        interactive: false,
        selectedAnyAction: localDeploy || localServer || watchScripts,
        watch: options.watch ?? true,
        watchScripts,
        watchWorld,
        watchAllowlist,
        production: options.production ?? false,
        minecraftProduct: options.minecraftProduct,
        minecraftDevelopmentPath: options.minecraftDevelopmentPath,
        bdsVersion: options.bdsVersion,
        bdsPlatform: options.bdsPlatform,
        bdsCacheDir: options.bdsCacheDir,
        bdsServerDir: options.bdsServerDir,
        restartOnWorldChange: options.restartOnWorldChange,
    };
}

async function resolveDevOptions(
    options: DevCommandOptions,
    defaults: DevDefaultSelections,
    features: BlurProject["features"],
    hooks?: DevInteractiveHooks,
): Promise<DevResolvedOptions> {
    const interactive = shouldUseInteractiveDevConfiguration(options);
    if (!interactive) {
        const resolved = resolveNonInteractiveOptions(options, defaults);
        if (!resolved.localServer) {
            return resolved;
        }

        const localServerSelection = await hooks?.onLocalServerSelected?.();
        if (localServerSelection?.keepLocalServer === false) {
            if (localServerSelection.abortDev) {
                return {
                    ...resolved,
                    localServer: false,
                    localServerBehaviorPack: false,
                    localServerResourcePack: false,
                    attachBehaviorPack: false,
                    attachResourcePack: false,
                    watchScripts: false,
                    watchWorld: false,
                    watchAllowlist: false,
                    selectedAnyAction: false,
                    exitMessage: localServerSelection.exitMessage,
                    exitIsError: localServerSelection.exitIsError ?? false,
                    abortBeforeStart: true,
                };
            }

            const selectedAnyAction =
                resolved.localDeploy || resolved.watchScripts;
            if (localServerSelection.continueMessage && selectedAnyAction) {
                logDevExit(localServerSelection.continueMessage);
            }

            return {
                ...resolved,
                localServer: false,
                localServerBehaviorPack: false,
                localServerResourcePack: false,
                attachBehaviorPack: false,
                attachResourcePack: false,
                watchWorld: false,
                watchAllowlist: false,
                selectedAnyAction,
                exitMessage: localServerSelection.exitMessage,
                exitIsError: localServerSelection.exitIsError ?? false,
            };
        }

        await hooks?.onLocalServerConfirmed?.();
        return resolved;
    }

    const actionAnswers = await runPrompt({
        type: "multiselect",
        name: "checks",
        message: "Choose dev actions",
        choices: [
            {
                title: "Local deploy",
                value: "localDeploy",
                selected: defaults.localDeploy,
            },
            {
                title: "Local server",
                value: "localServer",
                selected: defaults.localServer,
            },
        ],
        hint: "- Space to select. Enter to confirm.",
        instructions: false,
    });

    const selectedActions = new Set<string>(actionAnswers.checks ?? []);
    const localDeploy = selectedActions.has("localDeploy");
    let localServer = selectedActions.has("localServer");
    const watchOverallEnabled = options.watch ?? true;
    let exitMessage: string | undefined;
    let exitIsError = false;
    let continueMessage: string | undefined;

    if (localServer) {
        const localServerSelection = await hooks?.onLocalServerSelected?.();
        if (localServerSelection?.keepLocalServer === false) {
            localServer = false;
            exitMessage = localServerSelection.exitMessage;
            exitIsError = localServerSelection.exitIsError ?? false;
            continueMessage = localServerSelection.continueMessage;
        } else {
            await hooks?.onLocalServerConfirmed?.();
        }
    }

    if (!localDeploy && !localServer) {
        return {
            localDeploy,
            localDeployBehaviorPack: false,
            localDeployResourcePack: false,
            localServer,
            localServerBehaviorPack: false,
            localServerResourcePack: false,
            attachBehaviorPack: false,
            attachResourcePack: false,
            interactive: true,
            selectedAnyAction: false,
            watch: watchOverallEnabled,
            watchScripts: false,
            watchWorld: false,
            watchAllowlist: false,
            production: options.production ?? false,
            minecraftProduct: options.minecraftProduct,
            minecraftDevelopmentPath: options.minecraftDevelopmentPath,
            bdsVersion: options.bdsVersion,
            bdsPlatform: options.bdsPlatform,
            bdsCacheDir: options.bdsCacheDir,
            bdsServerDir: options.bdsServerDir,
            restartOnWorldChange: options.restartOnWorldChange,
            exitMessage,
            exitIsError,
        };
    }

    if (continueMessage) {
        logDevExit(continueMessage);
    }

    let watchScripts = false;
    let watchWorld = false;
    let watchAllowlist = false;
    let localDeployBehaviorPack =
        localDeploy && defaults.localDeployBehaviorPack;
    let localDeployResourcePack =
        localDeploy && defaults.localDeployResourcePack;
    let localServerBehaviorPack =
        localServer && defaults.localServerBehaviorPack;
    let localServerResourcePack =
        localServer && defaults.localServerResourcePack;
    let attachBehaviorPack = localServer && defaults.attachBehaviorPack;
    let attachResourcePack = localServer && defaults.attachResourcePack;

    if (watchOverallEnabled) {
        const watchChoices: Array<{
            title: string;
            value: string;
            selected: boolean;
        }> = [
            {
                title: "Watch scripts",
                value: "watchScripts",
                selected: defaults.watchScripts,
            },
        ];

        if (localServer) {
            watchChoices.push(
                {
                    title: "Watch world",
                    value: "watchWorld",
                    selected: defaults.watchWorld,
                },
                {
                    title: "Watch allowlist",
                    value: "watchAllowlist",
                    selected: defaults.watchAllowlist,
                },
            );
        }

        const watchAnswers = await runPrompt({
            type: "multiselect",
            name: "checks",
            message: "Choose watch items",
            choices: watchChoices,
            hint: "- Space to select. Enter to confirm.",
            instructions: false,
        });

        const selectedWatchers = new Set<string>(watchAnswers.checks ?? []);
        watchScripts = selectedWatchers.has("watchScripts");
        watchWorld = localServer && selectedWatchers.has("watchWorld");
        watchAllowlist = localServer && selectedWatchers.has("watchAllowlist");
    }

    const packChoices: Array<{
        title: string;
        value: string;
        selected: boolean;
    }> = [];
    if (localDeploy && features.behaviorPack) {
        packChoices.push({
            title: "Deploy behavior pack",
            value: "localDeployBehaviorPack",
            selected: localDeployBehaviorPack,
        });
    }
    if (localDeploy && features.resourcePack) {
        packChoices.push({
            title: "Deploy resource pack",
            value: "localDeployResourcePack",
            selected: localDeployResourcePack,
        });
    }
    if (localServer && features.behaviorPack) {
        packChoices.push(
            {
                title: "Sync behavior pack to local server",
                value: "localServerBehaviorPack",
                selected: localServerBehaviorPack,
            },
            {
                title: "Attach behavior pack in world hooks",
                value: "attachBehaviorPack",
                selected: attachBehaviorPack,
            },
        );
    }
    if (localServer && features.resourcePack) {
        packChoices.push(
            {
                title: "Sync resource pack to local server",
                value: "localServerResourcePack",
                selected: localServerResourcePack,
            },
            {
                title: "Attach resource pack in world hooks",
                value: "attachResourcePack",
                selected: attachResourcePack,
            },
        );
    }

    if (packChoices.length > 0) {
        const packAnswers = await runPrompt({
            type: "multiselect",
            name: "checks",
            message: "Choose pack actions",
            choices: packChoices,
            hint: "- Space to select. Enter to confirm.",
            instructions: false,
        });
        const selectedPacks = new Set<string>(packAnswers.checks ?? []);
        localDeployBehaviorPack =
            localDeploy &&
            features.behaviorPack &&
            selectedPacks.has("localDeployBehaviorPack");
        localDeployResourcePack =
            localDeploy &&
            features.resourcePack &&
            selectedPacks.has("localDeployResourcePack");
        localServerBehaviorPack =
            localServer &&
            features.behaviorPack &&
            selectedPacks.has("localServerBehaviorPack");
        localServerResourcePack =
            localServer &&
            features.resourcePack &&
            selectedPacks.has("localServerResourcePack");
        attachBehaviorPack =
            localServer &&
            features.behaviorPack &&
            selectedPacks.has("attachBehaviorPack");
        attachResourcePack =
            localServer &&
            features.resourcePack &&
            selectedPacks.has("attachResourcePack");
    }

    return {
        localDeploy,
        localDeployBehaviorPack,
        localDeployResourcePack,
        localServer,
        localServerBehaviorPack,
        localServerResourcePack,
        attachBehaviorPack,
        attachResourcePack,
        interactive: true,
        selectedAnyAction: localDeploy || localServer || watchScripts,
        watch: options.watch ?? true,
        watchScripts,
        watchWorld: localServer && watchWorld,
        watchAllowlist: localServer && watchAllowlist,
        production: options.production ?? false,
        minecraftProduct: options.minecraftProduct,
        minecraftDevelopmentPath: options.minecraftDevelopmentPath,
        bdsVersion: options.bdsVersion,
        bdsPlatform: options.bdsPlatform,
        bdsCacheDir: options.bdsCacheDir,
        bdsServerDir: options.bdsServerDir,
        restartOnWorldChange: options.restartOnWorldChange,
        exitMessage,
        exitIsError,
    };
}

export async function runDevCommand(options: DevCommandOptions): Promise<void> {
    const { projectRoot, config, configPath } = await loadBlurConfig(
        process.cwd(),
    );
    const debug = createDebugLogger(resolveDebugEnabled(options.debug));
    const selectedWorld = resolveSelectedWorld(config, options.world);
    const resolveCurrentMachine = () =>
        resolveMachineSettings(
            projectRoot,
            {
                minecraftProduct: options.minecraftProduct as any,
                minecraftDevelopmentPath: options.minecraftDevelopmentPath,
                bdsVersion: options.bdsVersion,
                bdsPlatform: options.bdsPlatform as any,
                bdsCacheDirectory: options.bdsCacheDir,
                bdsServerDirectory: options.bdsServerDir,
            },
            {
                minecraftChannel: config.minecraft.channel,
                bdsVersion: config.minecraft.targetVersion,
            },
        );
    let machine: ReturnType<typeof resolveMachineSettings> | undefined;
    let localServerPrefetchTask: TrackedTask<unknown> | undefined;
    const localServerProgressReporter = createLocalServerProgressReporter();
    const localDeployDefaults = resolvePackFeatureSelection(
        config.automation.localDeploy.copy,
    );
    const localServerCopyDefaults = resolvePackFeatureSelection(
        config.automation.localServer.copy,
    );
    const localServerAttachDefaults = resolvePackFeatureSelection(
        config.automation.localServer.attach,
    );
    const resolved = await resolveDevOptions(
        options,
        {
            localDeploy: config.dev.localDeploy.enabledByDefault,
            localDeployBehaviorPack: localDeployDefaults.behaviorPack,
            localDeployResourcePack: localDeployDefaults.resourcePack,
            localServer: config.dev.localServer.enabledByDefault,
            localServerBehaviorPack: localServerCopyDefaults.behaviorPack,
            localServerResourcePack: localServerCopyDefaults.resourcePack,
            attachBehaviorPack: localServerAttachDefaults.behaviorPack,
            attachResourcePack: localServerAttachDefaults.resourcePack,
            watchScripts: config.dev.watch.scriptsEnabledByDefault,
            watchWorld: config.dev.watch.worldEnabledByDefault,
            watchAllowlist: config.dev.watch.allowlistEnabledByDefault,
        },
        config.features,
        {
            onLocalServerSelected: async () => {
                machine ??= resolveCurrentMachine();
                const effectiveBdsVersion = machine.localServer.bdsVersion;
                const interactiveDevConfiguration =
                    shouldUseInteractiveDevConfiguration(options);
                const versionSource = await resolveDevLocalServerVersionSource(
                    configPath,
                    options,
                );
                const canPromptForUpgrade =
                    versionSource === "config-file-target-version";
                let status: Awaited<
                    ReturnType<typeof resolveMinecraftVersionStatus>
                >;
                let artifactStatus: Awaited<
                    ReturnType<typeof resolveMinecraftArtifactStatus>
                >;

                try {
                    console.log(
                        "[dev] Checking local-server Bedrock version...",
                    );
                    artifactStatus = await resolveMinecraftArtifactStatus(
                        config.minecraft.channel,
                        effectiveBdsVersion,
                        debug,
                    );
                    if (!artifactStatus.artifactAvailable) {
                        if (artifactStatus.looksLikeChannelMismatch) {
                            console.log(
                                `[dev] Warning: minecraft.channel is ${config.minecraft.channel}, but local-server BDS version ${effectiveBdsVersion} only appears to resolve on ${artifactStatus.oppositeChannel}.`,
                            );
                        } else {
                            console.log(
                                `[dev] Warning: local-server BDS version ${effectiveBdsVersion} could not be resolved on the ${config.minecraft.channel} Bedrock dedicated-server channel.`,
                            );
                        }
                    }

                    status = await resolveMinecraftVersionStatus(
                        config.minecraft.channel,
                        effectiveBdsVersion,
                        debug,
                        fetch,
                        artifactStatus,
                    );
                } catch (error) {
                    const message =
                        error instanceof Error ? error.message : String(error);
                    debug.log(
                        "bedrock-downloads",
                        "continuing after target-version lookup failure",
                        {
                            message,
                        },
                    );
                    console.log(
                        `[dev] Warning: could not verify the local-server BDS version before starting local server (${message}). Continuing with the selected version.`,
                    );
                    return { keepLocalServer: true };
                }

                if (!status.artifactAvailable) {
                    if (!interactiveDevConfiguration) {
                        return {
                            keepLocalServer: false,
                            exitMessage: `Local server was disabled because BDS version ${effectiveBdsVersion} is not available on the ${config.minecraft.channel} channel.`,
                            exitIsError: true,
                            abortDev: true,
                        };
                    }

                    const silenced =
                        await isMinecraftTargetUpdatePromptSilenced(
                            projectRoot,
                            config.minecraft.channel,
                            status.latestVersion,
                        );
                    if (silenced) {
                        debug.log(
                            "bedrock-downloads",
                            "invalid target-version prompt is currently silenced",
                            {
                                channel: config.minecraft.channel,
                                configuredVersion: effectiveBdsVersion,
                                latestChannelVersion: status.latestVersion,
                            },
                        );
                        return {
                            keepLocalServer: false,
                            exitMessage: `Local server was disabled because BDS version ${effectiveBdsVersion} is not available on the ${config.minecraft.channel} channel.`,
                            exitIsError: true,
                            continueMessage: `Continuing without local server because BDS version ${effectiveBdsVersion} is not available on the ${config.minecraft.channel} channel.`,
                        };
                    }

                    const promptMessage =
                        buildUnavailableLocalServerVersionPromptMessage({
                            effectiveBdsVersion,
                            channel: config.minecraft.channel,
                            latestVersion: status.latestVersion,
                            looksLikeChannelMismatch:
                                status.looksLikeChannelMismatch,
                            oppositeChannel: status.oppositeChannel,
                            canPromptForUpgrade,
                        });

                    const choices = canPromptForUpgrade
                        ? [
                              {
                                  title: `Update to ${status.latestVersion} + local server`,
                                  value: "update",
                              },
                              {
                                  title: "Keep current + no local server",
                                  value: "continue",
                              },
                              {
                                  title: "Silence 24h + no local server",
                                  value: "silence",
                              },
                          ]
                        : [
                              {
                                  title: "Keep current + no local server",
                                  value: "continue",
                              },
                              {
                                  title: "Silence 24h + no local server",
                                  value: "silence",
                              },
                          ];
                    const promptResult = await runPrompt({
                        type: "select",
                        name: "minecraftTargetUpdateChoice",
                        message: promptMessage,
                        choices,
                        initial: 1,
                        hint: "- Use arrow keys. Enter to confirm.",
                        instructions: false,
                    });

                    const choice = promptResult.minecraftTargetUpdateChoice as
                        | MinecraftTargetUpdateChoice
                        | undefined;

                    if (choice === "update" && canPromptForUpgrade) {
                        await writeMinecraftTargetVersion(
                            configPath,
                            status.latestVersion,
                        );
                        applyMinecraftTargetVersion(
                            config,
                            status.latestVersion,
                        );
                        await clearMinecraftTargetUpdatePromptSilence(
                            projectRoot,
                        );
                        console.log(
                            `[dev] Updated minecraft.targetVersion to ${status.latestVersion}.`,
                        );
                        return { keepLocalServer: true };
                    }

                    if (choice === "silence") {
                        await silenceMinecraftTargetUpdatePrompt(
                            projectRoot,
                            config.minecraft.channel,
                            status.latestVersion,
                        );
                        console.log(
                            `[dev] Silenced Minecraft target-version update prompts for 24 hours.`,
                        );
                    }

                    return {
                        keepLocalServer: false,
                        exitMessage: `Local server was disabled because BDS version ${effectiveBdsVersion} is not available on the ${config.minecraft.channel} channel.`,
                        exitIsError: true,
                        continueMessage: `Continuing without local server because BDS version ${effectiveBdsVersion} is not available on the ${config.minecraft.channel} channel.`,
                    };
                }

                if (!status.outdated) {
                    await clearMinecraftTargetUpdatePromptSilence(projectRoot);
                    return { keepLocalServer: true };
                }

                if (!canPromptForUpgrade) {
                    debug.log(
                        "bedrock-downloads",
                        "skipping target-version upgrade prompt due to non-config-file source",
                        {
                            versionSource,
                            effectiveBdsVersion,
                            latestChannelVersion: status.latestVersion,
                        },
                    );
                    return { keepLocalServer: true };
                }

                if (
                    await isMinecraftTargetUpdatePromptSilenced(
                        projectRoot,
                        config.minecraft.channel,
                        status.latestVersion,
                    )
                ) {
                    debug.log(
                        "bedrock-downloads",
                        "target-version prompt is currently silenced",
                        {
                            channel: config.minecraft.channel,
                            configuredVersion: effectiveBdsVersion,
                            latestChannelVersion: status.latestVersion,
                        },
                    );
                    return { keepLocalServer: true };
                }

                const promptMessage =
                    buildOutdatedLocalServerVersionPromptMessage({
                        effectiveBdsVersion,
                        channel: config.minecraft.channel,
                        latestVersion: status.latestVersion,
                    });

                const promptResult = await runPrompt({
                    type: "select",
                    name: "minecraftTargetUpdateChoice",
                    message: promptMessage,
                    choices: [
                        {
                            title: `Update to ${status.latestVersion}`,
                            value: "update",
                        },
                        {
                            title: "Keep current",
                            value: "continue",
                        },
                        {
                            title: "Silence 24h",
                            value: "silence",
                        },
                    ],
                    initial: 1,
                    hint: "- Use arrow keys. Enter to confirm.",
                    instructions: false,
                });

                const choice = promptResult.minecraftTargetUpdateChoice as
                    | MinecraftTargetUpdateChoice
                    | undefined;

                if (choice === "update") {
                    await writeMinecraftTargetVersion(
                        configPath,
                        status.latestVersion,
                    );
                    applyMinecraftTargetVersion(config, status.latestVersion);
                    await clearMinecraftTargetUpdatePromptSilence(projectRoot);
                    console.log(
                        `[dev] Updated minecraft.targetVersion to ${status.latestVersion}.`,
                    );
                    return { keepLocalServer: true };
                }

                if (choice === "silence") {
                    await silenceMinecraftTargetUpdatePrompt(
                        projectRoot,
                        config.minecraft.channel,
                        status.latestVersion,
                    );
                    console.log(
                        `[dev] Silenced Minecraft target-version update prompts for 24 hours.`,
                    );
                }

                return { keepLocalServer: true };
            },
            onLocalServerConfirmed: async () => {
                machine ??= resolveCurrentMachine();
                localServerPrefetchTask ??= trackTask(
                    prefetchBdsArchive(projectRoot, config, machine, {
                        worldName: selectedWorld.worldName,
                        debug,
                        reporter: localServerProgressReporter,
                    }),
                );
            },
        },
    );
    const machineSettings = machine ?? resolveCurrentMachine();
    machine = machineSettings;
    const scriptWatchPatterns = filterScriptWatchPatterns(
        config.dev.watch.paths,
        selectedWorld.worldSourcePath,
    );
    const scriptWatchPlan = createWatchPlan(scriptWatchPatterns);
    const normalizedWorldSourcePath = normalizeWatchPath(
        selectedWorld.worldSourcePath,
    ).replace(/\/+$/, "");
    const worldSourceWatchPlan =
        normalizedWorldSourcePath.length > 0
            ? createWatchPlan([`${normalizedWorldSourcePath}/**/*`])
            : createWatchPlan([]);
    debug.log("dev", "resolved dev command", {
        projectRoot,
        selectedWorld,
        watchPaths: scriptWatchPlan.patterns,
        watchRoots: scriptWatchPlan.roots,
        watchDebounceMs: config.dev.watch.debounceMs,
        resolved,
    });

    if (resolved.abortBeforeStart || !resolved.selectedAnyAction) {
        logDevExit(
            resolved.exitMessage ?? "No dev actions selected. Exiting.",
            resolved.exitIsError,
        );
        return;
    }

    if (resolved.localServer && config.world.backend === "s3") {
        await syncRemoteWorldForDev({
            projectRoot,
            config,
            worldName: selectedWorld.worldName,
            debug,
        });
    }

    console.log("[dev] Configuration:");
    console.log(
        JSON.stringify(
            {
                localDeploy: resolved.localDeploy,
                localServer: resolved.localServer,
                watch: resolved.watch,
                watchScripts: resolved.watchScripts,
                watchWorld: resolved.watchWorld,
                watchAllowlist: resolved.watchAllowlist,
                production: resolved.production,
                minecraftChannel: config.minecraft.channel,
                worldName: selectedWorld.worldName,
                worldSourcePath: selectedWorld.worldSourcePath,
                minecraftProduct: machineSettings.localDeploy.minecraftProduct,
                minecraftDevelopmentPath:
                    machineSettings.localDeploy.minecraftDevelopmentPath
                        .length > 0
                        ? machineSettings.localDeploy.minecraftDevelopmentPath
                        : "(auto)",
                bdsVersion: machineSettings.localServer.bdsVersion,
                bdsPlatform: machineSettings.localServer.platform,
                bdsCacheDir: machineSettings.localServer.cacheDirectory,
                bdsServerDir: machineSettings.localServer.serverDirectory,
                restartOnWorldChange:
                    resolved.restartOnWorldChange ??
                    config.dev.localServer.restartOnWorldChange,
                projectWorldMode:
                    config.dev.localServer.worldSync.projectWorldMode,
                runtimeWorldMode:
                    config.dev.localServer.worldSync.runtimeWorldMode,
                localDeployBehaviorPack: resolved.localDeployBehaviorPack,
                localDeployResourcePack: resolved.localDeployResourcePack,
                localServerBehaviorPack: resolved.localServerBehaviorPack,
                localServerResourcePack: resolved.localServerResourcePack,
                attachBehaviorPack: resolved.attachBehaviorPack,
                attachResourcePack: resolved.attachResourcePack,
            },
            null,
            2,
        ),
    );

    const localServer = resolved.localServer
        ? new BdsServerController(projectRoot, config, machineSettings, {
              worldName: selectedWorld.worldName,
              restartOnWorldChange: resolved.restartOnWorldChange,
              copyPacks: {
                  behaviorPack: resolved.localServerBehaviorPack,
                  resourcePack: resolved.localServerResourcePack,
              },
              attachPacks: {
                  behaviorPack: resolved.attachBehaviorPack,
                  resourcePack: resolved.attachResourcePack,
              },
              debug,
              reporter: localServerProgressReporter,
          })
        : undefined;
    const runtimeState = resolved.localServer
        ? resolveBdsRuntimeState(
              projectRoot,
              config,
              machineSettings,
              selectedWorld.worldName,
          )
        : undefined;

    if (runtimeState && resolved.watchWorld) {
        const bootstrapResult = await bootstrapProjectWorldSourceFromBds(
            runtimeState,
            debug,
        );
        if (bootstrapResult === "copied") {
            console.log(
                `[dev] local-server copied the existing runtime world into ${selectedWorld.worldSourcePath}.`,
            );
            const sourceIdentity = await computeProjectWorldSourceIdentity(
                runtimeState.worldSourceDirectory,
            );
            if (sourceIdentity) {
                await writeRuntimeWorldSeedState(projectRoot, {
                    worldName: runtimeState.worldName,
                    sourceIdentity,
                });
            }
        } else if (bootstrapResult === "waiting-for-runtime") {
            console.log(
                `[dev] local-server has no existing runtime world to copy yet. ${selectedWorld.worldSourcePath} will sync after the runtime world is created.`,
            );
        }
    }

    if (runtimeState) {
        const runtimeDecision = await resolveRuntimeWorldDecision({
            projectRoot,
            config,
            runtimeState,
        });
        await applyRuntimeWorldDecision({
            projectRoot,
            config,
            runtimeState,
            decision: runtimeDecision,
            debug,
        });
    }

    if (resolved.localServer && resolved.watchWorld) {
        await writeLocalServerSession(projectRoot, {
            processId: process.pid,
            worldName: selectedWorld.worldName,
            watchWorld: true,
            startedAt: new Date().toISOString(),
        });
    } else {
        await clearLocalServerSession(projectRoot);
    }

    const watchers = new Set<FSWatcher>();
    let debounceHandle: NodeJS.Timeout | undefined;
    let shuttingDown = false;
    let shutdownPromise: Promise<void> | undefined;
    let detachLocalServerExit: (() => void) | undefined;
    let pendingMode: PipelineMode | undefined;
    let running = false;
    let runtimeWorldDirty = false;
    let allowlistCapturePending = false;
    let allowlistCaptureInFlight = false;
    let watchingAnnounced = false;

    const announceWatching = () => {
        if (watchingAnnounced) {
            return;
        }
        watchingAnnounced = true;
        console.log("[dev] Watching for changes...");
    };

    const captureRuntimeServerState = async () => {
        const state = localServer?.resolvedState;
        if (!state) {
            return;
        }

        await Promise.all([
            captureAllowlistFromBds(projectRoot, state.serverDirectory, debug),
            capturePermissionsFromBds(
                projectRoot,
                state.serverDirectory,
                debug,
            ),
        ]);
    };

    const enqueueAllowlistCapture = () => {
        if (shuttingDown || !resolved.watchAllowlist || !localServer) {
            return;
        }
        if (allowlistCaptureInFlight) {
            allowlistCapturePending = true;
            return;
        }

        allowlistCaptureInFlight = true;
        void (async () => {
            do {
                allowlistCapturePending = false;
                try {
                    await captureRuntimeServerState();
                } catch (error) {
                    const message =
                        error instanceof Error ? error.message : String(error);
                    console.error(
                        `[dev] failed to capture runtime server state: ${message}`,
                    );
                }
            } while (allowlistCapturePending && !shuttingDown);
        })().finally(() => {
            allowlistCaptureInFlight = false;
        });
    };

    const flushRuntimeState = async () => {
        const state = localServer?.resolvedState;
        if (!state) {
            return;
        }

        if (resolved.watchAllowlist) {
            await captureRuntimeServerState();
        }

        if (
            resolved.watchWorld &&
            (runtimeWorldDirty || !localServer?.isRunning())
        ) {
            await captureWorldSourceFromBds(state, debug);
            const sourceIdentity = await computeProjectWorldSourceIdentity(
                state.worldSourceDirectory,
            );
            if (sourceIdentity) {
                await writeRuntimeWorldSeedState(projectRoot, {
                    worldName: state.worldName,
                    sourceIdentity,
                });
            }
            runtimeWorldDirty = false;
        }
    };

    const onSigint = () => {
        void shutdown("SIGINT").finally(() => process.exit(0));
    };
    const onSigterm = () => {
        void shutdown("SIGTERM").finally(() => process.exit(0));
    };
    const removeProcessListeners = () => {
        process.off("SIGINT", onSigint);
        process.off("SIGTERM", onSigterm);
    };
    const shutdown = (
        signal: string,
        options: {
            stopServer?: boolean;
        } = {},
    ) => {
        if (shutdownPromise) {
            return shutdownPromise;
        }

        shuttingDown = true;
        shutdownPromise = (async () => {
            debug.log("dev", "begin shutdown", {
                signal,
                stopServer: options.stopServer !== false,
            });
            pendingMode = undefined;

            if (debounceHandle) {
                clearTimeout(debounceHandle);
                debounceHandle = undefined;
            }

            removeProcessListeners();
            detachLocalServerExit?.();
            detachLocalServerExit = undefined;

            if (options.stopServer !== false && localServer) {
                await localServer.stop({ suppressExitNotification: true });
            }

            await flushRuntimeState();
            await clearLocalServerSession(projectRoot);

            for (const watcher of watchers) {
                await watcher.close();
            }
            watchers.clear();
            debug.log("watch", "closed watcher set", { signal });
        })().catch((error) => {
            const message =
                error instanceof Error ? error.message : String(error);
            console.error(`[dev] shutdown failed (${signal}): ${message}`);
        });

        return shutdownPromise;
    };

    if (localServer) {
        detachLocalServerExit = localServer.onExit(() => {
            void shutdown("local-server-exit", { stopServer: false });
        });
    }

    const runPipeline = async (mode: PipelineMode) => {
        if (shuttingDown) {
            return;
        }

        debug.log("dev", "running pipeline", { mode });

        await buildProject(projectRoot, config, {
            production: resolved.production,
            debug,
        });
        console.log("[dev] build completed.");

        if (shuttingDown) {
            return;
        }

        if (resolved.localDeploy) {
            await runLocalDeploy(
                projectRoot,
                config,
                machineSettings,
                {
                    copy: {
                        behaviorPack: resolved.localDeployBehaviorPack,
                        resourcePack: resolved.localDeployResourcePack,
                    },
                },
                debug,
            );
            console.log("[dev] local-deploy completed.");
        }

        if (shuttingDown) {
            return;
        }

        if (localServer) {
            if (localServerPrefetchTask) {
                await waitForTrackedTask(
                    localServerPrefetchTask,
                    "Waiting for local-server Bedrock download...",
                    { animate: false },
                );
            }

            let localServerApplyMode: PipelineMode = mode;
            let localServerWorldMode: "preserve" | "replace" = "preserve";
            let nextRuntimeSeedIdentity: string | undefined;
            if (mode === "restart" && runtimeState) {
                const runtimeDecision = await resolveRuntimeWorldDecision({
                    projectRoot,
                    config,
                    runtimeState,
                });

                if (runtimeDecision.note) {
                    console.log(runtimeDecision.note);
                }

                switch (runtimeDecision.action) {
                    case "copy-missing":
                    case "replace":
                        localServerWorldMode = "replace";
                        nextRuntimeSeedIdentity =
                            runtimeDecision.sourceIdentity;
                        break;
                    case "backup-and-replace":
                        await localServer.stop({
                            suppressExitNotification: true,
                        });
                        await backupRuntimeWorldForBdsStartup(
                            runtimeState,
                            debug,
                        );
                        await replaceRuntimeWorldFromProjectSource(
                            projectRoot,
                            config,
                            runtimeState,
                            {
                                requireWorldSource: true,
                            },
                            debug,
                        );
                        await writeRuntimeWorldSeedState(projectRoot, {
                            worldName: runtimeState.worldName,
                            sourceIdentity: runtimeDecision.sourceIdentity,
                        });
                        localServerApplyMode = "start";
                        localServerWorldMode = "preserve";
                        console.log(
                            `[dev] Backed up and replaced local-server world for "${runtimeState.worldName}".`,
                        );
                        break;
                    case "preserve":
                    case "none":
                    default:
                        localServerWorldMode = "preserve";
                        break;
                }
            }

            await waitForPromiseIfSlow(
                localServer.apply(localServerApplyMode, {
                    worldMode: localServerWorldMode,
                    requireWorldSource: localServerWorldMode === "replace",
                }),
                "Preparing local server...",
                250,
                { animate: false },
            );
            if (nextRuntimeSeedIdentity && runtimeState) {
                await writeRuntimeWorldSeedState(projectRoot, {
                    worldName: runtimeState.worldName,
                    sourceIdentity: nextRuntimeSeedIdentity,
                });
            }
            console.log(
                `[dev] local-server ${localServerApplyMode === "reload" ? "reloaded" : "synchronized"}.`,
            );
        }
    };

    const enqueue = async (mode: PipelineMode) => {
        if (shuttingDown) {
            return;
        }

        if (running) {
            pendingMode = mergePipelineModes(pendingMode, mode);
            debug.log("watch", "queued follow-up pipeline mode", {
                requestedMode: mode,
                pendingMode,
            });
            return;
        }

        running = true;
        let nextMode: PipelineMode | undefined = mode;

        while (nextMode && !shuttingDown) {
            pendingMode = undefined;
            try {
                await runPipeline(nextMode);
            } catch (error) {
                if (shuttingDown) {
                    break;
                }
                const message =
                    error instanceof Error ? error.message : String(error);
                console.error(`[dev] ${message}`);
            }
            nextMode = shuttingDown ? undefined : pendingMode;
        }

        running = false;
    };

    await enqueue("start");

    if (shuttingDown) {
        return;
    }

    if (!resolved.watch) {
        return;
    }

    if (!hasActiveDevTargets(resolved)) {
        return;
    }

    const debounceMs = Math.max(25, config.dev.watch.debounceMs);
    let scheduledMode: PipelineMode | undefined;

    const schedule = (mode: PipelineMode) => {
        if (shuttingDown) {
            return;
        }

        scheduledMode = mergePipelineModes(scheduledMode, mode);
        debug.log("watch", "scheduled pipeline mode", {
            requestedMode: mode,
            scheduledMode,
            debounceMs,
        });
        if (debounceHandle) {
            clearTimeout(debounceHandle);
        }
        debounceHandle = setTimeout(() => {
            const modeToRun = scheduledMode ?? "start";
            scheduledMode = undefined;
            void enqueue(modeToRun);
        }, debounceMs);
    };

    if (resolved.watchScripts && scriptWatchPlan.roots.length > 0) {
        const projectWatcher = chokidar.watch(scriptWatchPlan.roots, {
            cwd: projectRoot,
            ignoreInitial: true,
            atomic: true,
        });
        watchers.add(projectWatcher);
        debug.log("watch", "armed project watcher", {
            cwd: projectRoot,
            paths: scriptWatchPlan.patterns,
            roots: scriptWatchPlan.roots,
            debounceMs,
        });

        projectWatcher.once("ready", () => {
            announceWatching();
            debug.log("watch", "project watcher ready");
        });

        projectWatcher.on("error", (error: unknown) => {
            const message =
                error instanceof Error ? error.message : String(error);
            console.error(`[dev] watcher error: ${message}`);
        });

        projectWatcher.on(
            "raw",
            (
                eventName: string,
                targetPath: string | null,
                details: unknown,
            ) => {
                debug.log("watch", "raw watcher event", {
                    eventName,
                    targetPath,
                    details,
                });
            },
        );

        projectWatcher.on("all", (eventName: string, targetPath: string) => {
            if (shuttingDown) {
                return;
            }

            const normalizedPath = normalizeWatchPath(targetPath);
            if (!scriptWatchPlan.matches(normalizedPath)) {
                debug.log(
                    "watch",
                    "ignored file event outside configured patterns",
                    {
                        eventName,
                        targetPath,
                        normalizedPath,
                    },
                );
                return;
            }

            const watchAction = resolveProjectWatchChangeAction(normalizedPath);
            if (watchAction.kind === "ignore") {
                debug.log("watch", "ignored project file event", {
                    eventName,
                    targetPath,
                    normalizedPath,
                });
                console.log(watchAction.message);
                return;
            }

            console.log(
                `[dev] change detected: ${eventName} ${normalizedPath}`,
            );
            debug.log("watch", "received project file event", {
                eventName,
                targetPath,
                normalizedPath,
                nextMode: watchAction.pipelineMode,
            });
            schedule(watchAction.pipelineMode);
        });
    }

    const state = localServer?.resolvedState;
    if (
        localServer &&
        resolved.watchWorld &&
        worldSourceWatchPlan.roots.length > 0
    ) {
        const worldSourceWatcher = chokidar.watch(worldSourceWatchPlan.roots, {
            cwd: projectRoot,
            ignoreInitial: true,
            atomic: true,
        });
        watchers.add(worldSourceWatcher);
        debug.log("watch", "armed project world-source watcher", {
            cwd: projectRoot,
            paths: worldSourceWatchPlan.patterns,
            roots: worldSourceWatchPlan.roots,
        });

        worldSourceWatcher.once("ready", () => {
            announceWatching();
            debug.log("watch", "project world-source watcher ready");
        });

        worldSourceWatcher.on("error", (error: unknown) => {
            const message =
                error instanceof Error ? error.message : String(error);
            console.error(`[dev] watcher error: ${message}`);
        });

        worldSourceWatcher.on(
            "all",
            (eventName: string, targetPath: string) => {
                if (shuttingDown) {
                    return;
                }

                const normalizedPath = normalizeWatchPath(targetPath);
                if (!worldSourceWatchPlan.matches(normalizedPath)) {
                    return;
                }

                console.log(
                    `[dev] change detected: ${eventName} ${normalizedPath}`,
                );
                debug.log("watch", "received world-source file event", {
                    eventName,
                    targetPath,
                    normalizedPath,
                    restartOnWorldChange: localServer.restartOnWorldChange,
                });
                if (localServer.restartOnWorldChange) {
                    schedule("restart");
                }
            },
        );
    }

    if (localServer && state && resolved.watchAllowlist) {
        const allowlistWatcher = chokidar.watch(state.serverDirectory, {
            ignoreInitial: true,
            atomic: true,
            awaitWriteFinish: {
                stabilityThreshold: 250,
                pollInterval: 100,
            },
        });
        watchers.add(allowlistWatcher);
        debug.log("watch", "armed runtime allowlist watcher", {
            serverDirectory: state.serverDirectory,
        });

        allowlistWatcher.once("ready", () => {
            announceWatching();
            debug.log("watch", "runtime allowlist watcher ready");
        });

        allowlistWatcher.on("error", (error: unknown) => {
            const message =
                error instanceof Error ? error.message : String(error);
            console.error(`[dev] watcher error: ${message}`);
        });

        allowlistWatcher.on("all", (eventName: string, targetPath: string) => {
            if (shuttingDown) {
                return;
            }

            const normalizedPath = normalizeWatchPath(targetPath);
            if (
                !normalizedPath.endsWith("/allowlist.json") &&
                normalizedPath !== "allowlist.json" &&
                !normalizedPath.endsWith("/permissions.json") &&
                normalizedPath !== "permissions.json"
            ) {
                return;
            }

            debug.log("watch", "received runtime server state event", {
                eventName,
                targetPath,
            });
            enqueueAllowlistCapture();
        });
    }

    if (localServer && state && resolved.watchWorld) {
        const worldWatcher = chokidar.watch(state.worldDirectory, {
            ignoreInitial: true,
            atomic: true,
            awaitWriteFinish: {
                stabilityThreshold: 500,
                pollInterval: 150,
            },
        });
        watchers.add(worldWatcher);
        debug.log("watch", "armed runtime world watcher", {
            worldDirectory: state.worldDirectory,
        });

        worldWatcher.once("ready", () => {
            announceWatching();
            debug.log("watch", "runtime world watcher ready");
        });

        worldWatcher.on("error", (error: unknown) => {
            const message =
                error instanceof Error ? error.message : String(error);
            console.error(`[dev] watcher error: ${message}`);
        });

        worldWatcher.on("all", (eventName: string, targetPath: string) => {
            if (shuttingDown) {
                return;
            }

            runtimeWorldDirty = true;
            debug.log("watch", "received runtime world event", {
                eventName,
                targetPath,
                runtimeWorldDirty,
            });
        });
    }

    if (watchers.size === 0) {
        return;
    }

    process.on("SIGINT", onSigint);
    process.on("SIGTERM", onSigterm);
}
