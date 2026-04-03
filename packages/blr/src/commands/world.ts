import path from "node:path";
import { captureWorldSourceFromBds, resolveBdsRuntimeState } from "../bds.js";
import { loadBlurConfig } from "../config.js";
import { DEFAULT_PROJECT_WORLDS_ROOT } from "../constants.js";
import { createDebugLogger, resolveDebugEnabled } from "../debug.js";
import { resolveMachineSettings } from "../environment.js";
import {
    ensureDirectory,
    exists,
    isDirectoryEmptyExcept,
    listDirectories,
    readJson,
    writeJson,
    writeText,
} from "../fs.js";
import { readTrackedProjectWorldState } from "../project-world-state.js";
import { isPromptCancelledError, runPrompt } from "../prompt.js";
import type { BlurProject } from "../types.js";
import {
    readActiveLocalServerSession,
    writeRuntimeWorldSeedState,
} from "../world-internal-state.js";
import { computeProjectWorldSourceIdentity } from "../world-source-identity.js";
import {
    acquireRemoteWorldLock,
    describeWorldStatus,
    listRemoteWorldVersionsFromS3,
    listRemoteWorldsFromS3,
    pullWorldFromS3,
    pushWorldToS3,
    releaseRemoteWorldLock,
    type ListedRemoteWorld,
    type RemoteWorldVersionEntry,
    WorldPushRemoteConflictError,
} from "../world-backend.js";
import {
    assertValidWorldName,
    defaultProjectWorldSourcePath,
    resolveProjectWorldSourceDirectory,
    usesDefaultWorldSourcePath,
} from "../world.js";

type WorldSharedOptions = {
    debug?: boolean;
    reason?: string;
};

type WorldRuntimeOptions = WorldSharedOptions & {
    bdsVersion?: string;
    bdsPlatform?: string;
    bdsCacheDir?: string;
    bdsServerDir?: string;
};

type PullWorldCommandOptions = WorldSharedOptions & {
    lock?: boolean;
    forceLock?: boolean;
    versionId?: string;
};

type PushWorldCommandOptions = WorldSharedOptions & {
    unlock?: boolean;
    forceLock?: boolean;
};

type LockWorldCommandOptions = WorldSharedOptions & {
    force?: boolean;
    ttlSeconds?: string | number;
};

type UnlockWorldCommandOptions = WorldSharedOptions & {
    force?: boolean;
};

type CaptureWorldCommandOptions = WorldRuntimeOptions & {
    force?: boolean;
};

type WorldCommandOptions = WorldSharedOptions;
type UseWorldCommandOptions = WorldCommandOptions;
type ListWorldCommandOptions = WorldCommandOptions & {
    json?: boolean;
};
type WorldVersionsCommandOptions = ListWorldCommandOptions;

type WorldPushConflictChoice = "cancel" | "push-anyway";
type WorldVersionSelectionCandidate = {
    name: string;
    local: boolean;
    tracked: boolean;
};

function formatRemoteWorldVersion(version: RemoteWorldVersionEntry): string {
    const latest = version.isLatest ? " latest" : "";
    const versionId =
        version.versionId === "null"
            ? "null (pre-versioning object)"
            : (version.versionId ?? "(none)");
    const timestamp = version.lastModified ? ` ${version.lastModified}` : "";
    const pushedBy = version.pushedBy ? ` by ${version.pushedBy}` : "";
    const pushReason = version.pushReason ? ` (${version.pushReason})` : "";
    return `- ${versionId}${latest}${timestamp}${pushedBy}${pushReason}`;
}

function formatListedRemoteWorld(world: ListedRemoteWorld): string {
    if (!world.versioning.available || !world.latestObject?.versionId) {
        return `- ${world.worldName} (version unavailable)`;
    }
    const timestamp = world.latestObject.lastModified
        ? ` @ ${world.latestObject.lastModified}`
        : "";
    const pushedBy = world.latestObject.pushedBy
        ? ` by ${world.latestObject.pushedBy}`
        : "";
    return `- ${world.worldName} (${world.latestObject.versionId}${timestamp}${pushedBy})`;
}

function resolveWorldName(
    explicit: string | undefined,
    fallback: string,
): string {
    return assertValidWorldName(
        explicit?.trim() || fallback,
        explicit ? "worldName" : "dev.localServer.worldName",
    );
}

function parseTtlSeconds(
    value: string | number | undefined,
): number | undefined {
    if (typeof value === "undefined") {
        return undefined;
    }
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(
            `Expected a positive ttlSeconds value, received "${value}".`,
        );
    }
    return Math.floor(parsed);
}

function ensureMutableRecord(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return {};
    }
    return value as Record<string, unknown>;
}

function canPromptForWorldCommand(): boolean {
    return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

async function assertWorldPullIsSafe(
    projectRoot: string,
    worldName: string,
): Promise<void> {
    const session = await readActiveLocalServerSession(projectRoot);
    if (!session?.watchWorld || session.worldName !== worldName) {
        return;
    }

    throw new Error(
        `Cannot pull "${worldName}" while local-server watch-world is active. Stop "blr dev" first.`,
    );
}

function formatWorldVersionSelectionCandidate(
    candidate: WorldVersionSelectionCandidate,
): string {
    const sources: string[] = [];
    if (candidate.local) {
        sources.push("local");
    }
    if (candidate.tracked) {
        sources.push("tracked");
    }
    if (sources.length === 0) {
        return candidate.name;
    }
    return `${candidate.name} (${sources.join(", ")})`;
}

export async function listWorldVersionSelectionCandidates(
    projectRoot: string,
): Promise<WorldVersionSelectionCandidate[]> {
    const [trackedState, localWorldDirectories] = await Promise.all([
        readTrackedProjectWorldState(projectRoot),
        listDirectories(path.resolve(projectRoot, DEFAULT_PROJECT_WORLDS_ROOT)),
    ]);

    const candidates = new Map<string, WorldVersionSelectionCandidate>();
    for (const worldName of localWorldDirectories) {
        const normalized = worldName.trim();
        if (!normalized) {
            continue;
        }
        candidates.set(normalized, {
            name: normalized,
            local: true,
            tracked: false,
        });
    }

    for (const trackedWorld of trackedState?.worlds ?? []) {
        const existing = candidates.get(trackedWorld.name);
        if (existing) {
            existing.tracked = true;
            continue;
        }
        candidates.set(trackedWorld.name, {
            name: trackedWorld.name,
            local: false,
            tracked: true,
        });
    }

    return Array.from(candidates.values()).sort((left, right) =>
        left.name.localeCompare(right.name),
    );
}

export async function resolveWorldVersionsCommandWorldName(input: {
    projectRoot: string;
    config: BlurProject;
    requestedWorldName?: string;
    jsonOutput?: boolean;
    canPrompt?: () => boolean;
    prompt?: typeof runPrompt;
}): Promise<string | undefined> {
    const fallbackWorldName = input.config.dev.localServer.worldName;
    if (input.requestedWorldName) {
        return resolveWorldName(input.requestedWorldName, fallbackWorldName);
    }

    if (input.jsonOutput || !(input.canPrompt ?? canPromptForWorldCommand)()) {
        return resolveWorldName(undefined, fallbackWorldName);
    }

    const candidates = await listWorldVersionSelectionCandidates(
        input.projectRoot,
    );
    if (candidates.length === 0) {
        return resolveWorldName(undefined, fallbackWorldName);
    }
    if (candidates.length === 1) {
        return resolveWorldName(candidates[0]?.name, fallbackWorldName);
    }

    const initialIndex = Math.max(
        0,
        candidates.findIndex(
            (candidate) => candidate.name === fallbackWorldName,
        ),
    );

    try {
        const result = await (input.prompt ?? runPrompt)({
            type: "select",
            name: "worldName",
            message: "Select a world to list remote versions for:",
            choices: candidates.map((candidate) => ({
                title: formatWorldVersionSelectionCandidate(candidate),
                value: candidate.name,
            })),
            initial: initialIndex,
            hint: "- Use arrow keys. Enter to confirm.",
            instructions: false,
        });
        return resolveWorldName(
            result.worldName as string | undefined,
            fallbackWorldName,
        );
    } catch (error) {
        if (isPromptCancelledError(error)) {
            return undefined;
        }
        throw error;
    }
}

function buildWorldPushConflictPromptMessage(
    error: WorldPushRemoteConflictError,
): string {
    switch (error.kind) {
        case "missing-tracked-version":
            return [
                error.message,
                "Pushing now can create a new remote version without any tracked base version in the project.",
                "Choose how to continue:",
            ].join("\n");
        case "remote-fingerprint-drift":
            return [
                error.message,
                "Pushing now will adopt the current remote target from blr.config.json and replace the tracked pin for this world.",
                "Choose how to continue:",
            ].join("\n");
        case "remote-version-mismatch":
        default:
            return [
                error.message,
                "Pushing now can overwrite newer remote work that has not been pulled into this project yet.",
                "Choose how to continue:",
            ].join("\n");
    }
}

async function shouldForceWorldPushAfterConflict(
    error: WorldPushRemoteConflictError,
): Promise<boolean> {
    if (!canPromptForWorldCommand()) {
        return false;
    }

    try {
        const result = await runPrompt({
            type: "select",
            name: "worldPushConflictChoice",
            message: buildWorldPushConflictPromptMessage(error),
            choices: [
                {
                    title: "Cancel and review remote world state",
                    value: "cancel",
                },
                {
                    title: "Push anyway and create a new remote version",
                    value: "push-anyway",
                },
            ],
            initial: 0,
            hint: "- Use arrow keys. Enter to confirm.",
            instructions: false,
        });

        return (
            (result.worldPushConflictChoice as WorldPushConflictChoice) ===
            "push-anyway"
        );
    } catch (error) {
        if (isPromptCancelledError(error)) {
            return false;
        }
        throw error;
    }
}

export async function runWorldStatusCommand(
    requestedWorldName: string | undefined,
    options: WorldCommandOptions,
): Promise<void> {
    const { projectRoot, config } = await loadBlurConfig(process.cwd());
    const debug = createDebugLogger(resolveDebugEnabled(options.debug));
    const worldName = resolveWorldName(
        requestedWorldName,
        config.dev.localServer.worldName,
    );
    const status = await describeWorldStatus(
        projectRoot,
        config,
        worldName,
        debug,
    );
    console.log(JSON.stringify(status, null, 2));
}

export async function runWorldListCommand(
    options: ListWorldCommandOptions,
): Promise<void> {
    const { projectRoot, config } = await loadBlurConfig(process.cwd());
    const worlds = await listRemoteWorldsFromS3(projectRoot, config);

    if (options.json) {
        console.log(JSON.stringify(worlds, null, 2));
        return;
    }

    if (worlds.length === 0) {
        console.log("[world] No remote worlds found.");
        return;
    }

    console.log("[world] Remote worlds:");
    for (const world of worlds) {
        console.log(formatListedRemoteWorld(world));
    }

    const versioningWarning = worlds.find(
        (world) => !world.versioning.available && world.versioning.detail,
    )?.versioning.detail;
    if (versioningWarning) {
        console.warn(`[world] Note: ${versioningWarning}`);
    }
}

export async function runWorldVersionsCommand(
    requestedWorldName: string | undefined,
    options: WorldVersionsCommandOptions,
): Promise<void> {
    const { projectRoot, config } = await loadBlurConfig(process.cwd());
    const worldName = await resolveWorldVersionsCommandWorldName({
        projectRoot,
        config,
        requestedWorldName,
        jsonOutput: options.json,
    });
    if (!worldName) {
        console.log("[world] Version listing cancelled.");
        return;
    }
    const listed = await listRemoteWorldVersionsFromS3(
        projectRoot,
        config,
        worldName,
    );

    if (options.json) {
        console.log(JSON.stringify(listed, null, 2));
        return;
    }

    if (listed.versions.length === 0) {
        console.log(
            `[world] No remote object versions found for "${worldName}".`,
        );
        return;
    }

    console.log(`[world] Remote versions for "${worldName}":`);
    for (const version of listed.versions) {
        console.log(formatRemoteWorldVersion(version));
    }
}

export async function runWorldPullCommand(
    requestedWorldName: string | undefined,
    options: PullWorldCommandOptions,
): Promise<void> {
    const { projectRoot, config } = await loadBlurConfig(process.cwd());
    const debug = createDebugLogger(resolveDebugEnabled(options.debug));
    const worldName = resolveWorldName(
        requestedWorldName,
        config.dev.localServer.worldName,
    );
    await assertWorldPullIsSafe(projectRoot, worldName);
    const pulled = await pullWorldFromS3(projectRoot, config, worldName, {
        lock: options.lock,
        forceLock: options.forceLock,
        reason: options.reason,
        versionId:
            typeof options.versionId === "string"
                ? options.versionId.trim()
                : undefined,
        debug,
    });
    console.log(
        `[world] Pulled "${worldName}" from s3://${pulled.context.bucket}/${pulled.context.objectKey} into ${pulled.context.worldSourcePath} as version ${pulled.versionId}`,
    );
}

export async function runWorldPushCommand(
    requestedWorldName: string | undefined,
    options: PushWorldCommandOptions,
): Promise<void> {
    const { projectRoot, config } = await loadBlurConfig(process.cwd());
    const debug = createDebugLogger(resolveDebugEnabled(options.debug));
    const worldName = resolveWorldName(
        requestedWorldName,
        config.dev.localServer.worldName,
    );
    let pushed;
    try {
        pushed = await pushWorldToS3(projectRoot, config, worldName, {
            unlock: options.unlock,
            forceLock: options.forceLock,
            reason: options.reason,
            debug,
        });
    } catch (error) {
        if (!(error instanceof WorldPushRemoteConflictError)) {
            throw error;
        }

        const confirmed = await shouldForceWorldPushAfterConflict(error);
        if (!confirmed) {
            if (!canPromptForWorldCommand()) {
                throw new Error(
                    `${error.message} Re-run the command in an interactive terminal if you really want to push anyway.`,
                );
            }
            console.log("[world] Push cancelled.");
            return;
        }

        pushed = await pushWorldToS3(projectRoot, config, worldName, {
            unlock: options.unlock,
            forceLock: options.forceLock,
            reason: options.reason,
            allowRemoteConflict: true,
            debug,
        });
    }
    const { context, versionId } = pushed;
    const versionSuffix =
        typeof versionId === "string" && versionId.length > 0
            ? ` as version ${versionId}`
            : "";
    console.log(
        `[world] Pushed "${worldName}" from ${context.worldSourcePath} to s3://${context.bucket}/${context.objectKey}${versionSuffix}`,
    );
}

export async function runWorldLockCommand(
    requestedWorldName: string | undefined,
    options: LockWorldCommandOptions,
): Promise<void> {
    const { projectRoot, config } = await loadBlurConfig(process.cwd());
    const debug = createDebugLogger(resolveDebugEnabled(options.debug));
    const worldName = resolveWorldName(
        requestedWorldName,
        config.dev.localServer.worldName,
    );
    const acquired = await acquireRemoteWorldLock(
        projectRoot,
        config,
        worldName,
        {
            command: "lock",
            force: options.force,
            ttlSeconds: parseTtlSeconds(options.ttlSeconds),
            reason: options.reason,
            debug,
        },
    );
    console.log(
        `[world] Locked "${worldName}" until ${acquired.lock.expiresAt} for ${acquired.lock.actor.userName}@${acquired.lock.actor.hostName}`,
    );
}

export async function runWorldUnlockCommand(
    requestedWorldName: string | undefined,
    options: UnlockWorldCommandOptions,
): Promise<void> {
    const { projectRoot, config } = await loadBlurConfig(process.cwd());
    const debug = createDebugLogger(resolveDebugEnabled(options.debug));
    const worldName = resolveWorldName(
        requestedWorldName,
        config.dev.localServer.worldName,
    );
    await releaseRemoteWorldLock(projectRoot, config, worldName, {
        force: options.force,
        debug,
    });
    console.log(`[world] Unlocked "${worldName}".`);
}

export async function runWorldCaptureCommand(
    requestedWorldName: string | undefined,
    options: CaptureWorldCommandOptions,
): Promise<void> {
    const { projectRoot, config } = await loadBlurConfig(process.cwd());
    const debug = createDebugLogger(resolveDebugEnabled(options.debug));
    const worldName = resolveWorldName(
        requestedWorldName,
        config.dev.localServer.worldName,
    );
    const machine = resolveMachineSettings(
        projectRoot,
        {
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
    const state = resolveBdsRuntimeState(
        projectRoot,
        config,
        machine,
        worldName,
    );

    if (!(await exists(state.worldDirectory))) {
        throw new Error(
            `Cannot capture world "${worldName}" because the runtime world does not exist at ${state.worldDirectory}. Start or provision the local server first.`,
        );
    }

    const destinationAlreadyPopulated = !(await isDirectoryEmptyExcept(
        state.worldSourceDirectory,
        [".gitkeep"],
    ));
    if (destinationAlreadyPopulated && !options.force) {
        throw new Error(
            `Refusing to overwrite ${state.worldSourceDirectory}. Re-run with --force true to replace the current project world source with the runtime world.`,
        );
    }

    await captureWorldSourceFromBds(state, debug);
    const sourceIdentity = await computeProjectWorldSourceIdentity(
        state.worldSourceDirectory,
    );
    if (sourceIdentity) {
        await writeRuntimeWorldSeedState(projectRoot, {
            worldName,
            sourceIdentity,
        });
    }
    console.log(
        `[world] Captured runtime world "${worldName}" from ${state.worldDirectory} into ${state.worldSourceDirectory}`,
    );
}

export async function runWorldUseCommand(
    requestedWorldName: string | undefined,
    options: UseWorldCommandOptions,
): Promise<void> {
    const { projectRoot, config, configPath } = await loadBlurConfig(
        process.cwd(),
    );
    const debug = createDebugLogger(resolveDebugEnabled(options.debug));
    const worldName = resolveWorldName(
        requestedWorldName,
        config.dev.localServer.worldName,
    );
    const rawConfig = ensureMutableRecord(await readJson<unknown>(configPath));
    const devConfig = ensureMutableRecord(rawConfig.dev);
    const localServerConfig = ensureMutableRecord(devConfig.localServer);
    rawConfig.dev = devConfig;
    devConfig.localServer = localServerConfig;

    const previousWorldName =
        (typeof localServerConfig.worldName === "string" &&
            localServerConfig.worldName.trim()) ||
        config.dev.localServer.worldName;
    const configuredWorldSourcePath =
        typeof localServerConfig.worldSourcePath === "string"
            ? localServerConfig.worldSourcePath
            : config.dev.localServer.worldSourcePath;
    const preserveCustomWorldSourcePath =
        configuredWorldSourcePath.trim().length > 0 &&
        !usesDefaultWorldSourcePath(
            previousWorldName,
            configuredWorldSourcePath,
        );

    localServerConfig.worldName = worldName;

    const effectiveWorldSourcePath = preserveCustomWorldSourcePath
        ? configuredWorldSourcePath
        : defaultProjectWorldSourcePath(worldName);

    if (!preserveCustomWorldSourcePath) {
        localServerConfig.worldSourcePath = effectiveWorldSourcePath;
    }

    await writeJson(configPath, rawConfig);

    const worldSourceDirectory = resolveProjectWorldSourceDirectory(
        projectRoot,
        effectiveWorldSourcePath,
    );
    await ensureDirectory(worldSourceDirectory);

    const gitkeepPath = path.join(worldSourceDirectory, ".gitkeep");
    if (!(await exists(gitkeepPath))) {
        await writeText(gitkeepPath, "");
    }

    debug.log("world", "updated active project world", {
        worldName,
        effectiveWorldSourcePath,
        preserveCustomWorldSourcePath,
    });

    if (preserveCustomWorldSourcePath) {
        console.log(
            `[world] Active world set to "${worldName}". Preserved explicit source path ${effectiveWorldSourcePath}.`,
        );
        return;
    }

    console.log(
        `[world] Active world set to "${worldName}" using ${effectiveWorldSourcePath}.`,
    );
}
