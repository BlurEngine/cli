import chokidar, { type FSWatcher } from "chokidar";
import picomatch from "picomatch";
import {
    BdsServerController,
    captureAllowlistFromBds,
    captureWorldSourceFromBds,
    prefetchBdsArchive,
} from "../bds.js";
import {
    clearMinecraftTargetUpdatePromptSilence,
    isMinecraftTargetUpdatePromptSilenced,
    silenceMinecraftTargetUpdatePrompt,
} from "../cli-state.js";
import { resolvePackFeatureSelection } from "../content.js";
import { loadBlurConfig } from "../config.js";
import { createDebugLogger, resolveDebugEnabled } from "../debug.js";
import { resolveMachineSettings } from "../environment.js";
import {
    applyMinecraftTargetVersion,
    readConfiguredMinecraftTargetVersion,
    writeMinecraftTargetVersion,
} from "../minecraft-config.js";
import {
    resolveMinecraftArtifactStatus,
    resolveMinecraftVersionStatus,
} from "../minecraft-version.js";
import { runPrompt } from "../prompt.js";
import { buildProject, runLocalDeploy } from "../runtime.js";
import type { BlurConfigFile, BlurProject } from "../types.js";
import {
    appendWorldSourceHint,
    assertValidProjectWorldSource,
    resolveSelectedWorld,
} from "../world.js";

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
type DevInteractiveSelectionResult = {
    keepLocalServer: boolean;
    exitMessage?: string;
    exitIsError?: boolean;
    continueMessage?: string;
};
type DevInteractiveHooks = {
    onLocalServerSelected?: () => Promise<DevInteractiveSelectionResult | void>;
    onLocalServerConfirmed?: () => Promise<void>;
};

type TrackedTask<T> = {
    promise: Promise<T>;
    isSettled: () => boolean;
};

type PipelineMode = "start" | "reload" | "restart";
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
): Promise<T> {
    if (task.isSettled()) {
        return task.promise;
    }

    if (!process.stdout.isTTY) {
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

    return waitForTrackedTask(trackTask(trackedPromise), message);
}

function hasExplicitActionSelection(options: DevCommandOptions): boolean {
    return (
        typeof options.localDeploy === "boolean" ||
        typeof options.localDeployBehaviorPack === "boolean" ||
        typeof options.localDeployResourcePack === "boolean" ||
        typeof options.localServer === "boolean" ||
        typeof options.localServerBehaviorPack === "boolean" ||
        typeof options.localServerResourcePack === "boolean" ||
        typeof options.attachBehaviorPack === "boolean" ||
        typeof options.attachResourcePack === "boolean" ||
        typeof options.watchScripts === "boolean" ||
        typeof options.watchWorld === "boolean" ||
        typeof options.watchAllowlist === "boolean"
    );
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
    const interactive =
        options.interactive ?? !hasExplicitActionSelection(options);
    if (!interactive) {
        return resolveNonInteractiveOptions(options, defaults);
    }

    const actionAnswers = await runPrompt({
        type: "multiselect",
        name: "checks",
        message: "Enable dev actions",
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
            message: "Enable watch and capture items",
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
            message: "Enable pack automation for this run",
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
                const configuredTargetVersion =
                    await readConfiguredMinecraftTargetVersion(
                        configPath,
                        config.minecraft.targetVersion,
                    );
                let status: Awaited<
                    ReturnType<typeof resolveMinecraftVersionStatus>
                >;
                let artifactStatus: Awaited<
                    ReturnType<typeof resolveMinecraftArtifactStatus>
                >;

                try {
                    console.log(
                        "[dev] Checking local-server Bedrock targetVersion...",
                    );
                    artifactStatus = await resolveMinecraftArtifactStatus(
                        config.minecraft.channel,
                        configuredTargetVersion,
                        debug,
                    );
                    if (!artifactStatus.artifactAvailable) {
                        if (artifactStatus.looksLikeChannelMismatch) {
                            console.log(
                                `[dev] Warning: minecraft.channel is ${config.minecraft.channel}, but targetVersion ${configuredTargetVersion} only appears to resolve on ${artifactStatus.oppositeChannel}.`,
                            );
                        } else {
                            console.log(
                                `[dev] Warning: minecraft.targetVersion ${configuredTargetVersion} could not be resolved on the ${config.minecraft.channel} Bedrock dedicated-server channel.`,
                            );
                        }
                    }

                    status = await resolveMinecraftVersionStatus(
                        config.minecraft.channel,
                        configuredTargetVersion,
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
                        `[dev] Warning: could not verify minecraft.targetVersion before starting local server (${message}). Continuing with the configured version.`,
                    );
                    return { keepLocalServer: true };
                }

                if (!status.artifactAvailable) {
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
                                configuredVersion: configuredTargetVersion,
                                latestChannelVersion: status.latestVersion,
                            },
                        );
                        return {
                            keepLocalServer: false,
                            exitMessage: `Local server was disabled because minecraft.targetVersion ${configuredTargetVersion} is not available on the ${config.minecraft.channel} channel.`,
                            exitIsError: true,
                            continueMessage: `Continuing without local server because minecraft.targetVersion ${configuredTargetVersion} is not available on the ${config.minecraft.channel} channel.`,
                        };
                    }

                    const promptMessage = [
                        status.looksLikeChannelMismatch
                            ? `targetVersion ${configuredTargetVersion} appears to belong to the ${status.oppositeChannel} channel, so the local server cannot start on ${config.minecraft.channel}.`
                            : `targetVersion ${configuredTargetVersion} is not available on the ${config.minecraft.channel} channel, so the local server cannot start with this version.`,
                        `The latest ${config.minecraft.channel} version is ${status.latestVersion}.`,
                        "How would you like to continue?",
                    ].join("\n");

                    const promptResult = await runPrompt({
                        type: "select",
                        name: "minecraftTargetUpdateChoice",
                        message: promptMessage,
                        choices: [
                            {
                                title: `Update targetVersion to ${status.latestVersion} and continue with local server`,
                                value: "update",
                            },
                            {
                                title: "Continue without local server",
                                value: "continue",
                            },
                            {
                                title: "Silence this prompt for 24 hours and continue without local server",
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
                        exitMessage: `Local server was disabled because minecraft.targetVersion ${configuredTargetVersion} is not available on the ${config.minecraft.channel} channel.`,
                        exitIsError: true,
                        continueMessage: `Continuing without local server because minecraft.targetVersion ${configuredTargetVersion} is not available on the ${config.minecraft.channel} channel.`,
                    };
                }

                if (!status.outdated) {
                    await clearMinecraftTargetUpdatePromptSilence(projectRoot);
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
                            configuredVersion: configuredTargetVersion,
                            latestChannelVersion: status.latestVersion,
                        },
                    );
                    return { keepLocalServer: true };
                }

                const channelLabel =
                    config.minecraft.channel === "preview"
                        ? "preview"
                        : "stable";
                const promptMessage = [
                    `A newer ${channelLabel} Bedrock dedicated server is available (${status.latestVersion}).`,
                    `The project targetVersion is still ${configuredTargetVersion}.`,
                    "How would you like to continue?",
                ].join("\n");

                const promptResult = await runPrompt({
                    type: "select",
                    name: "minecraftTargetUpdateChoice",
                    message: promptMessage,
                    choices: [
                        {
                            title: `Update targetVersion to ${status.latestVersion} and continue`,
                            value: "update",
                        },
                        {
                            title: "Continue without updating",
                            value: "continue",
                        },
                        {
                            title: "Silence this prompt for 24 hours",
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

    if (resolved.interactive && !resolved.selectedAnyAction) {
        logDevExit(
            resolved.exitMessage ?? "No dev actions selected. Exiting.",
            resolved.exitIsError,
        );
        return;
    }

    if (resolved.localServer && resolved.watchWorld) {
        try {
            await assertValidProjectWorldSource(
                projectRoot,
                selectedWorld.worldSourcePath,
                "watch world changes",
            );
        } catch (error) {
            const message =
                error instanceof Error ? error.message : String(error);
            throw new Error(
                appendWorldSourceHint(config, selectedWorld.worldName, message),
            );
        }
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
          })
        : undefined;

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

    const captureRuntimeAllowlist = async () => {
        const state = localServer?.resolvedState;
        if (!state) {
            return;
        }

        await captureAllowlistFromBds(
            projectRoot,
            state.serverDirectory,
            debug,
        );
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
                    await captureRuntimeAllowlist();
                } catch (error) {
                    const message =
                        error instanceof Error ? error.message : String(error);
                    console.error(
                        `[dev] failed to capture runtime allowlist: ${message}`,
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
            await captureAllowlistFromBds(
                projectRoot,
                state.serverDirectory,
                debug,
            );
        }

        if (
            resolved.watchWorld &&
            (runtimeWorldDirty || !localServer?.isRunning())
        ) {
            await captureWorldSourceFromBds(state, debug);
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
                );
            }
            await waitForPromiseIfSlow(
                localServer.apply(mode),
                "Preparing local server...",
            );
            console.log(
                `[dev] local-server ${mode === "reload" ? "reloaded" : "synchronized"}.`,
            );
        }
    };

    const enqueue = async (mode: PipelineMode) => {
        if (shuttingDown) {
            return;
        }

        if (running) {
            pendingMode =
                mode === "restart" || pendingMode === "restart"
                    ? "restart"
                    : mode === "reload" || pendingMode === "reload"
                      ? "reload"
                      : "start";
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
    let scheduledMode: PipelineMode = "reload";

    const schedule = (mode: PipelineMode) => {
        if (shuttingDown) {
            return;
        }

        scheduledMode =
            scheduledMode === "restart" || mode === "restart"
                ? "restart"
                : mode;
        debug.log("watch", "scheduled pipeline mode", {
            requestedMode: mode,
            scheduledMode,
            debounceMs,
        });
        if (debounceHandle) {
            clearTimeout(debounceHandle);
        }
        debounceHandle = setTimeout(() => {
            const modeToRun = scheduledMode;
            scheduledMode = "reload";
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

            console.log(
                `[dev] change detected: ${eventName} ${normalizedPath}`,
            );
            debug.log("watch", "received project file event", {
                eventName,
                targetPath,
                normalizedPath,
                nextMode: "reload",
            });
            schedule("reload");
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
                normalizedPath !== "allowlist.json"
            ) {
                return;
            }

            debug.log("watch", "received runtime allowlist event", {
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
