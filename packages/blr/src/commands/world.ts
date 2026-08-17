import path from "node:path";
import { captureWorldSourceFromBds, resolveBdsRuntimeState } from "../bds.js";
import { loadBlurConfig } from "../config.js";
import { DEFAULT_PROJECT_WORLDS_ROOT } from "../constants.js";
import { createDebugLogger, resolveDebugEnabled } from "../debug.js";
import { resolveMachineSettings } from "../environment.js";
import {
    ensureDirectory,
    exists,
    isDirectory,
    isDirectoryEmptyExcept,
    listDirectories,
    readJson,
    writeJson,
    writeText,
} from "../fs.js";
import {
    createBedrockLevelDatDiff,
    createBedrockLevelDatDump,
    readBedrockLevelDatFile,
    renderBedrockLevelDatDiff,
    type BedrockLevelDatDumpFormat,
    writeBedrockLevelDatFile,
} from "../level-dat.js";
import { editBedrockLevelDatInteractively } from "../level-dat-editor.js";
import {
    createInteractivePrompt,
    type InteractivePrompt,
} from "../interactive-prompt.js";
import { readTrackedProjectWorldState } from "../project-world-state.js";
import { isPromptCancelledError, runPrompt } from "../prompt.js";
import type { BlurProject, WorldPushPolicy } from "../types.js";
import {
    readActiveLocalServerSession,
    readRuntimeWorldSeedState,
    writeRuntimeWorldSeedState,
} from "../world-internal-state.js";
import { computeProjectWorldSourceIdentity } from "../world-source-identity.js";
import { buildProcessedWorld } from "../world-processing/processor-build.js";
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
    appendWorldSourceHint,
    assertValidProjectWorldSource,
    assertValidWorldName,
    defaultProjectWorldSourcePath,
    resolveProjectWorldSourceDirectory,
    resolveSelectedWorld,
    usesDefaultWorldSourcePath,
} from "../world.js";
import {
    exportWorldImage,
    normalizeWorldImageDimension,
    normalizeWorldImageFileName,
    normalizeWorldImageScale,
    resolveDefaultWorldImageOutputPath,
} from "../world-image.js";

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
    channel?: string;
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
export type WorldBuildCommandOptions = WorldCommandOptions & {
    check?: boolean;
    dryRun?: boolean;
    processor?: string | string[];
    audit?: boolean;
    output?: string;
    json?: boolean;
};

export function assertRuntimeWorldCaptureIsAuthored(
    sourceIdentity: string | undefined,
): void {
    if (sourceIdentity?.startsWith("processed:")) {
        throw new Error(
            "Refusing to capture a processed runtime world into the authored source. Restart dev in author mode before capturing builder changes.",
        );
    }
}
type UseWorldCommandOptions = WorldCommandOptions;
type ListWorldCommandOptions = WorldCommandOptions & {
    json?: boolean;
};
type WorldVersionsCommandOptions = ListWorldCommandOptions;
type WorldLevelDatDumpCommandOptions = WorldCommandOptions & {
    format?: BedrockLevelDatDumpFormat;
    output?: string;
    path?: string;
};
type WorldLevelDatDiffCommandOptions = WorldCommandOptions & {
    against?: string;
    format?: "text" | "json";
    path?: string;
};
type WorldLevelDatEditCommandOptions = WorldCommandOptions & {
    backup?: boolean;
    path?: string;
};
type WorldImageCommandOptions = WorldCommandOptions & {
    output?: string;
    dimension?: string;
    scale?: string | number;
    timings?: boolean;
};

type WorldPushConflictChoice = "cancel" | "push-anyway";
type WorldVersionSelectionCandidate = {
    name: string;
    local: boolean;
    tracked: boolean;
};

type WorldLevelDatEditCommandRuntime = {
    canPrompt?: () => boolean;
    prompt?: InteractivePrompt;
};

type WorldLevelDatCommandContext = {
    projectRoot: string;
    config?: BlurProject;
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

function trimSurroundingQuotes(value: string): string {
    let trimmed = value.trim();
    if (trimmed.startsWith('"') || trimmed.startsWith("'")) {
        trimmed = trimmed.slice(1);
    }
    if (trimmed.endsWith('"') || trimmed.endsWith("'")) {
        trimmed = trimmed.slice(0, -1);
    }
    return trimmed.trim();
}

function isPathWithinDirectory(rootPath: string, targetPath: string): boolean {
    const relative = path.relative(rootPath, targetPath);
    return (
        relative.length === 0 ||
        (!relative.startsWith("..") && !path.isAbsolute(relative))
    );
}

function resolveCommandInvocationCwd(projectRoot: string): string {
    const initCwd = process.env.INIT_CWD?.trim();
    if (!initCwd) {
        return projectRoot;
    }

    const resolvedInitCwd = path.isAbsolute(initCwd)
        ? initCwd
        : path.resolve(projectRoot, initCwd);
    return isPathWithinDirectory(projectRoot, resolvedInitCwd)
        ? resolvedInitCwd
        : projectRoot;
}

function formatExplicitLevelDatSourceDescription(input: {
    requestedPath: string;
    levelDatPath: string;
    isExplicitLevelDatFile: boolean;
}): string {
    const normalizedRequestedPath = trimSurroundingQuotes(input.requestedPath);
    if (path.isAbsolute(normalizedRequestedPath)) {
        return input.levelDatPath.replace(/\\/g, "/");
    }

    return (
        input.isExplicitLevelDatFile
            ? normalizedRequestedPath
            : path.join(normalizedRequestedPath, "level.dat")
    ).replace(/\\/g, "/");
}

function looksLikeExplicitLevelDatFilePath(value: string): boolean {
    return path.extname(trimSurroundingQuotes(value)).toLowerCase() === ".dat";
}

function looksLikeWorldPath(value: string): boolean {
    const normalized = trimSurroundingQuotes(value);
    if (normalized.length === 0) {
        return false;
    }

    return (
        path.isAbsolute(normalized) ||
        normalized.startsWith(".") ||
        normalized.includes("/") ||
        normalized.includes("\\") ||
        normalized.toLowerCase().endsWith(".dat")
    );
}

type ResolvedWorldLevelDatTarget = {
    worldName: string;
    levelDatPath: string;
    sourceDescription: string;
    usesConfiguredWorldSource: boolean;
};

function deriveWorldNameFromExplicitLevelDatPath(
    resolvedLevelDatPath: string,
    fallbackWorldName: string,
): string {
    const baseName = path.basename(resolvedLevelDatPath);
    if (baseName.toLowerCase() === "level.dat") {
        return (
            path.basename(path.normalize(path.dirname(resolvedLevelDatPath))) ||
            fallbackWorldName
        );
    }

    return (
        path.basename(
            resolvedLevelDatPath,
            path.extname(resolvedLevelDatPath),
        ) || fallbackWorldName
    );
}

function resolveWorldLevelDatTargetFromPath(
    invocationCwd: string,
    requestedPath: string,
    fallbackWorldName: string,
): ResolvedWorldLevelDatTarget {
    const normalizedInput = trimSurroundingQuotes(requestedPath);
    const resolvedInput = path.resolve(invocationCwd, normalizedInput);
    const isExplicitLevelDatFile =
        looksLikeExplicitLevelDatFilePath(resolvedInput);
    const levelDatPath = isExplicitLevelDatFile
        ? resolvedInput
        : path.join(resolvedInput, "level.dat");
    const derivedWorldName = isExplicitLevelDatFile
        ? deriveWorldNameFromExplicitLevelDatPath(
              levelDatPath,
              fallbackWorldName,
          )
        : path.basename(path.normalize(resolvedInput)) || fallbackWorldName;

    return {
        worldName: derivedWorldName,
        levelDatPath,
        sourceDescription: formatExplicitLevelDatSourceDescription({
            requestedPath,
            levelDatPath,
            isExplicitLevelDatFile,
        }),
        usesConfiguredWorldSource: false,
    };
}

function resolveWorldLevelDatTarget(
    projectRoot: string,
    config: BlurProject | undefined,
    requestedWorldName: string | undefined,
    requestedPath: string | undefined,
): ResolvedWorldLevelDatTarget {
    const fallbackWorldName = config?.dev.localServer.worldName ?? "level.dat";
    const invocationCwd = resolveCommandInvocationCwd(projectRoot);
    const normalizedRequestedPath =
        typeof requestedPath === "string" &&
        trimSurroundingQuotes(requestedPath).length > 0
            ? requestedPath
            : undefined;

    if (normalizedRequestedPath) {
        return resolveWorldLevelDatTargetFromPath(
            invocationCwd,
            normalizedRequestedPath,
            fallbackWorldName,
        );
    }

    if (
        typeof requestedWorldName === "string" &&
        looksLikeWorldPath(requestedWorldName)
    ) {
        return resolveWorldLevelDatTargetFromPath(
            invocationCwd,
            requestedWorldName,
            fallbackWorldName,
        );
    }

    if (!config) {
        throw new Error(
            "Cannot resolve level.dat without a BlurEngine project unless you provide a world directory or .dat file path.",
        );
    }

    const selection = resolveSelectedWorld(config, requestedWorldName);

    return {
        worldName: selection.worldName,
        levelDatPath: path.join(
            resolveProjectWorldSourceDirectory(
                projectRoot,
                selection.worldSourcePath,
            ),
            "level.dat",
        ),
        sourceDescription: path.posix.join(
            selection.worldSourcePath.replace(/\\/g, "/"),
            "level.dat",
        ),
        usesConfiguredWorldSource: true,
    };
}

function canPromptForWorldCommand(): boolean {
    return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

function canResolveLevelDatWithoutProject(
    requestedWorldName: string | undefined,
    requestedPath: string | undefined,
): boolean {
    if (
        typeof requestedPath === "string" &&
        trimSurroundingQuotes(requestedPath).length > 0
    ) {
        return true;
    }

    return (
        typeof requestedWorldName === "string" &&
        looksLikeWorldPath(requestedWorldName)
    );
}

async function loadWorldLevelDatCommandContext(
    requestedWorldName: string | undefined,
    requestedPath: string | undefined,
): Promise<WorldLevelDatCommandContext> {
    try {
        const { projectRoot, config } = await loadBlurConfig(process.cwd());
        return {
            projectRoot,
            config,
        };
    } catch (error) {
        if (
            !canResolveLevelDatWithoutProject(requestedWorldName, requestedPath)
        ) {
            throw error;
        }

        return {
            projectRoot: process.cwd(),
            config: undefined,
        };
    }
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

async function assertWorldLevelDatEditIsSafe(
    projectRoot: string,
    config: BlurProject | undefined,
    target: ResolvedWorldLevelDatTarget,
): Promise<void> {
    if (!config) {
        return;
    }

    const session = await readActiveLocalServerSession(projectRoot);
    if (!session?.watchWorld) {
        return;
    }

    const watchedWorld = resolveSelectedWorld(config, session.worldName);
    const watchedLevelDatPath = path.resolve(
        resolveProjectWorldSourceDirectory(
            projectRoot,
            watchedWorld.worldSourcePath,
        ),
        "level.dat",
    );

    if (path.resolve(target.levelDatPath) !== watchedLevelDatPath) {
        return;
    }

    throw new Error(
        `Cannot edit "${session.worldName}" level.dat while local-server watch-world is active. Stop "blr dev" first.`,
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

export async function runWorldBuildCommand(
    requestedWorldName: string | undefined,
    options: WorldBuildCommandOptions,
): Promise<void> {
    const { projectRoot, config } = await loadBlurConfig(process.cwd());
    const selection = resolveSelectedWorld(config, requestedWorldName);
    const processorIds = options.processor
        ? Array.isArray(options.processor)
            ? options.processor
            : [options.processor]
        : undefined;
    const check = options.check === true || options.dryRun === true;
    const hasApplicableProcessor = config.worldProcessors.some(
        (processor) =>
            processor.sourceWorld === selection.worldName &&
            processor.applyOn.worldBuild,
    );
    if (!processorIds && !hasApplicableProcessor) {
        const result = Object.freeze({
            status: "current" as const,
            worldName: selection.worldName,
            processorIds: Object.freeze([]),
            diagnostics: Object.freeze([]),
        });
        console.log(
            options.json
                ? JSON.stringify(result, null, 2)
                : `No world processors apply to ${selection.worldName}; world processing is current.`,
        );
        return;
    }
    const sourceWorldDirectory = await assertValidProjectWorldSource(
        projectRoot,
        selection.worldSourcePath,
        `build processed world ${selection.worldName}`,
    );
    const result = await buildProcessedWorld({
        projectRoot,
        worldName: selection.worldName,
        sourceWorldDirectory,
        configs: config.worldProcessors,
        ...(processorIds ? { processorIds } : {}),
        ...(options.output
            ? { outputDirectory: path.resolve(process.cwd(), options.output) }
            : {}),
        audit: options.audit === true,
        mode: check ? "check" : "bake",
        signal: new AbortController().signal,
    });
    if (options.json) {
        console.log(JSON.stringify(result, null, 2));
    } else {
        console.log(
            check
                ? `Processed world ${selection.worldName} is ${result.status} (${result.worldBuildId}).`
                : `Processed world ${selection.worldName} ${result.status} at ${result.worldDirectory}.`,
        );
    }
    if (check && result.status !== "current") {
        throw new Error(
            `Processed world ${selection.worldName} is stale. Run blr world build ${JSON.stringify(selection.worldName)}.`,
        );
    }
}

export async function runWorldLevelDatDumpCommand(
    requestedWorldName: string | undefined,
    options: WorldLevelDatDumpCommandOptions,
): Promise<void> {
    const { projectRoot, config } = await loadWorldLevelDatCommandContext(
        requestedWorldName,
        options.path,
    );
    const debug = createDebugLogger(resolveDebugEnabled(options.debug));
    const target = resolveWorldLevelDatTarget(
        projectRoot,
        config,
        requestedWorldName,
        options.path,
    );

    if (!(await exists(target.levelDatPath))) {
        const message = `Cannot dump level.dat because ${target.sourceDescription} does not exist.`;
        throw new Error(
            target.usesConfiguredWorldSource && config
                ? appendWorldSourceHint(config, target.worldName, message)
                : message,
        );
    }

    if (!(await isDirectory(path.dirname(target.levelDatPath)))) {
        const message = `Cannot dump level.dat because ${target.sourceDescription} does not exist.`;
        throw new Error(
            target.usesConfiguredWorldSource && config
                ? appendWorldSourceHint(config, target.worldName, message)
                : message,
        );
    }

    debug.log("world", "reading level.dat", {
        worldName: target.worldName,
        levelDatPath: target.levelDatPath,
        format: options.format ?? "simplified",
        requestedPath:
            typeof options.path === "string"
                ? trimSurroundingQuotes(options.path)
                : undefined,
    });

    const levelDat = await readBedrockLevelDatFile(target.levelDatPath);
    const dump = createBedrockLevelDatDump(
        levelDat,
        options.format ?? "simplified",
    );

    if (options.output) {
        await writeJson(options.output, dump);
        console.log(
            `[world] Wrote level.dat dump for "${target.worldName}" to ${options.output}.`,
        );
        return;
    }

    console.log(JSON.stringify(dump, null, 2));
}

export async function runWorldLevelDatDiffCommand(
    requestedLeftTarget: string | undefined,
    requestedRightTarget: string | undefined,
    options: WorldLevelDatDiffCommandOptions,
): Promise<void> {
    const { projectRoot, config } = await loadWorldLevelDatCommandContext(
        requestedLeftTarget,
        options.path,
    );
    const debug = createDebugLogger(resolveDebugEnabled(options.debug));
    const target = resolveWorldLevelDatTarget(
        projectRoot,
        config,
        requestedLeftTarget,
        options.path,
    );
    const againstPath = options.against?.trim() || requestedRightTarget?.trim();
    if (options.against?.trim() && requestedRightTarget?.trim()) {
        throw new Error(
            "Cannot diff level.dat with both a second positional target and --against. Provide only one right-side target.",
        );
    }

    if (!againstPath) {
        throw new Error(
            'Cannot diff level.dat without a second target. Provide a second positional target or --against "<target>".',
        );
    }

    const comparisonTarget = resolveWorldLevelDatTarget(
        projectRoot,
        config,
        againstPath,
        undefined,
    );

    if (!(await exists(target.levelDatPath))) {
        const message = `Cannot diff level.dat because ${target.sourceDescription} does not exist.`;
        throw new Error(
            target.usesConfiguredWorldSource && config
                ? appendWorldSourceHint(config, target.worldName, message)
                : message,
        );
    }

    if (!(await exists(comparisonTarget.levelDatPath))) {
        throw new Error(
            `Cannot diff level.dat because ${comparisonTarget.sourceDescription} does not exist.`,
        );
    }

    debug.log("world", "diffing level.dat", {
        worldName: target.worldName,
        leftLevelDatPath: target.levelDatPath,
        rightLevelDatPath: comparisonTarget.levelDatPath,
        format: options.format ?? "text",
        requestedPath:
            typeof options.path === "string"
                ? trimSurroundingQuotes(options.path)
                : undefined,
        againstTarget: trimSurroundingQuotes(againstPath),
    });

    const [leftLevelDat, rightLevelDat] = await Promise.all([
        readBedrockLevelDatFile(target.levelDatPath),
        readBedrockLevelDatFile(comparisonTarget.levelDatPath),
    ]);
    const diff = createBedrockLevelDatDiff(leftLevelDat, rightLevelDat);

    if ((options.format ?? "text") === "json") {
        console.log(
            JSON.stringify(
                {
                    leftSource: target.sourceDescription,
                    rightSource: comparisonTarget.sourceDescription,
                    diff,
                },
                null,
                2,
            ),
        );
        return;
    }

    console.log(
        renderBedrockLevelDatDiff(diff, {
            left: target.sourceDescription,
            right: comparisonTarget.sourceDescription,
        }),
    );
}

export async function runWorldLevelDatEditCommand(
    requestedWorldName: string | undefined,
    options: WorldLevelDatEditCommandOptions,
    runtime: WorldLevelDatEditCommandRuntime = {},
): Promise<void> {
    const { projectRoot, config } = await loadWorldLevelDatCommandContext(
        requestedWorldName,
        options.path,
    );
    const debug = createDebugLogger(resolveDebugEnabled(options.debug));
    const target = resolveWorldLevelDatTarget(
        projectRoot,
        config,
        requestedWorldName,
        options.path,
    );

    if (!(runtime.canPrompt ?? canPromptForWorldCommand)()) {
        throw new Error(
            "Interactive level.dat editing requires an interactive terminal.",
        );
    }

    if (!(await exists(target.levelDatPath))) {
        const message = `Cannot edit level.dat because ${target.sourceDescription} does not exist.`;
        throw new Error(
            target.usesConfiguredWorldSource && config
                ? appendWorldSourceHint(config, target.worldName, message)
                : message,
        );
    }

    await assertWorldLevelDatEditIsSafe(projectRoot, config, target);

    debug.log("world", "editing level.dat", {
        worldName: target.worldName,
        levelDatPath: target.levelDatPath,
        backup: options.backup ?? true,
        requestedPath:
            typeof options.path === "string"
                ? trimSurroundingQuotes(options.path)
                : undefined,
    });

    const levelDat = await readBedrockLevelDatFile(target.levelDatPath);
    const prompt = runtime.prompt ?? createInteractivePrompt();
    let result;
    try {
        result = await editBedrockLevelDatInteractively({
            worldName: target.worldName,
            levelDat,
            prompt,
        });
    } finally {
        prompt.close?.();
    }

    if (!result.saved) {
        console.log(
            result.changed
                ? `[world] Discarded unsaved level.dat changes for "${target.worldName}".`
                : `[world] Closed level.dat editor for "${target.worldName}" without changes.`,
        );
        return;
    }

    if (!result.changed) {
        console.log(
            `[world] No level.dat changes saved for "${target.worldName}".`,
        );
        return;
    }

    const writeResult = await writeBedrockLevelDatFile(
        target.levelDatPath,
        {
            storageVersion: levelDat.storageVersion,
            data: levelDat.data,
        },
        {
            backup: options.backup,
        },
    );
    const backupSuffix = writeResult.backupPath
        ? ` Backup: ${writeResult.backupPath}.`
        : "";
    console.log(
        `[world] Saved ${result.changedPaths.length} level.dat change(s) for "${target.worldName}".${backupSuffix}`,
    );
}

export async function runWorldImageCommand(
    requestedWorldName: string | undefined,
    options: WorldImageCommandOptions,
): Promise<void> {
    const { projectRoot, config } = await loadBlurConfig(process.cwd());
    const debug = createDebugLogger(resolveDebugEnabled(options.debug));
    const selectedWorld = resolveSelectedWorld(config, requestedWorldName);
    const dimension = normalizeWorldImageDimension(
        options.dimension ?? config.package.assets.worldImage.dimension,
        "dimension",
    );
    const scale = normalizeWorldImageScale(
        options.scale ?? config.package.assets.worldImage.scale,
        "scale",
    );
    const fileName = normalizeWorldImageFileName(
        config.package.assets.worldImage.fileName,
        "package.assets.worldImage.fileName",
    );
    const outputPath = path.resolve(
        projectRoot,
        options.output ??
            path.relative(
                projectRoot,
                resolveDefaultWorldImageOutputPath(
                    projectRoot,
                    selectedWorld.worldName,
                    fileName,
                ),
            ),
    );

    let worldSourceDirectory: string;
    try {
        worldSourceDirectory = await assertValidProjectWorldSource(
            projectRoot,
            selectedWorld.worldSourcePath,
            "export a world image",
        );
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(
            appendWorldSourceHint(config, selectedWorld.worldName, message),
        );
    }

    debug.log("world", "exporting 2D world image", {
        worldName: selectedWorld.worldName,
        worldSourcePath: selectedWorld.worldSourcePath,
        dimension,
        scale,
        outputPath,
    });

    if (options.timings) {
        console.log("[world] Image export timings:");
    }
    const exported = await exportWorldImage({
        worldSourceDirectory,
        outputPath,
        dimension,
        scale,
        onTimingStage: options.timings
            ? (stage) => {
                  console.log(`[world]   ${stage.name}: ${stage.ms}ms`);
              }
            : undefined,
    });

    const processedWorld = exported.processedWorld;
    console.log(
        `[world] Wrote ${exported.outputs.length} 2D world image PNGs for "${selectedWorld.worldName}" to ${path.relative(projectRoot, exported.outputPath)} with terrain, shade, and full variants (${exported.width}x${exported.height}, processed world ${processedWorld.width}x${processedWorld.height} blocks, x ${processedWorld.bounds.minX}..${processedWorld.bounds.maxX}, z ${processedWorld.bounds.minZ}..${processedWorld.bounds.maxZ}, ${exported.columnCount} loaded columns, ${exported.terrainColumnCount} terrain columns).`,
    );
    if (options.timings) {
        console.log(`[world]   total: ${exported.timings.totalMs}ms`);
    }
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
    const channel = resolveWorldPushChannel(options.channel, config);
    const pushOnce = (allowRemoteConflict = false) =>
        channel === "processed"
            ? pushCurrentProcessedWorld({
                  projectRoot,
                  config,
                  worldName,
                  options,
                  allowRemoteConflict,
                  debug,
              })
            : pushWorldToS3(projectRoot, config, worldName, {
                  unlock: options.unlock,
                  forceLock: options.forceLock,
                  reason: options.reason,
                  allowRemoteConflict,
                  debug,
              });
    let pushed;
    try {
        pushed = await pushOnce();
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

        pushed = await pushOnce(true);
    }
    const { context, versionId } = pushed;
    const versionSuffix =
        typeof versionId === "string" && versionId.length > 0
            ? ` as version ${versionId}`
            : "";
    console.log(
        `[world] Pushed ${pushed.channel} world "${worldName}" from ${path.relative(projectRoot, pushed.inputDirectory)} to s3://${context.bucket}/${context.objectKey}${versionSuffix}`,
    );
}

function resolveWorldPushChannel(
    value: string | undefined,
    config: BlurProject,
): WorldPushPolicy {
    if (value === undefined || value.trim().length === 0) {
        return config.world.pushPolicy;
    }
    const normalized = value.trim().toLowerCase();
    if (normalized === "authored" || normalized === "processed") {
        return normalized;
    }
    throw new Error(
        `Unknown world push channel "${value}". Expected authored or processed.`,
    );
}

async function pushCurrentProcessedWorld(input: {
    projectRoot: string;
    config: BlurProject;
    worldName: string;
    options: PushWorldCommandOptions;
    allowRemoteConflict: boolean;
    debug: ReturnType<typeof createDebugLogger>;
}) {
    const acquired = await acquireRemoteWorldLock(
        input.projectRoot,
        input.config,
        input.worldName,
        {
            command: "push-processed",
            force: input.options.forceLock,
            reason: input.options.reason,
            debug: input.debug,
        },
    );
    let handedToPublisher = false;
    try {
        const worldSourcePath = resolveSelectedWorld(
            input.config,
            input.worldName,
        ).worldSourcePath;
        const checked = await buildProcessedWorld({
            projectRoot: input.projectRoot,
            worldName: input.worldName,
            sourceWorldDirectory: resolveProjectWorldSourceDirectory(
                input.projectRoot,
                worldSourcePath,
            ),
            configs: input.config.worldProcessors,
            pipeline: "world-build",
            mode: "check",
            signal: new AbortController().signal,
        }).catch((error: unknown) => {
            const detail =
                error instanceof Error ? error.message : String(error);
            throw new Error(
                `Processed push for "${input.worldName}" requires a current verified world build. Run \`blr world build ${input.worldName}\` first. ${detail}`,
            );
        });
        if (checked.status !== "current") {
            throw new Error(
                `Processed push for "${input.worldName}" is stale. Run \`blr world build ${input.worldName}\` and retry.`,
            );
        }
        handedToPublisher = true;
        return await pushWorldToS3(
            input.projectRoot,
            input.config,
            input.worldName,
            {
                channel: "processed",
                worldInputDirectory: checked.worldDirectory,
                worldBuildId: checked.worldBuildId,
                acquiredLock: acquired,
                unlock: input.options.unlock,
                reason: input.options.reason,
                allowRemoteConflict: input.allowRemoteConflict,
                debug: input.debug,
            },
        );
    } catch (error) {
        if (!handedToPublisher && acquired.releaseOnFailure) {
            await releaseRemoteWorldLock(
                input.projectRoot,
                input.config,
                input.worldName,
                { debug: input.debug },
            ).catch(() => undefined);
        }
        throw error;
    }
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
    const runtimeSeed = await readRuntimeWorldSeedState(projectRoot, worldName);
    assertRuntimeWorldCaptureIsAuthored(runtimeSeed?.sourceIdentity);

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
