import path from "node:path";
import { captureWorldSourceFromBds, resolveBdsRuntimeState } from "../bds.js";
import { loadBlurConfig } from "../config.js";
import { createDebugLogger, resolveDebugEnabled } from "../debug.js";
import { resolveMachineSettings } from "../environment.js";
import {
    ensureDirectory,
    exists,
    isDirectoryEmptyExcept,
    readJson,
    writeJson,
    writeText,
} from "../fs.js";
import {
    acquireRemoteWorldLock,
    describeWorldStatus,
    pullWorldFromS3,
    pushWorldToS3,
    releaseRemoteWorldLock,
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
    const context = await pullWorldFromS3(projectRoot, config, worldName, {
        lock: options.lock,
        forceLock: options.forceLock,
        reason: options.reason,
        debug,
    });
    console.log(
        `[world] Pulled "${worldName}" from s3://${context.bucket}/${context.objectKey} into ${context.worldSourcePath}`,
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
    const context = await pushWorldToS3(projectRoot, config, worldName, {
        unlock: options.unlock,
        forceLock: options.forceLock,
        reason: options.reason,
        debug,
    });
    console.log(
        `[world] Pushed "${worldName}" from ${context.worldSourcePath} to s3://${context.bucket}/${context.objectKey}`,
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
