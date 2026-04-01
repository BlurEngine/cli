import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { chmod, copyFile, mkdtemp, rename, writeFile } from "node:fs/promises";
import { createInterface, type Interface } from "node:readline";
import AdmZip from "adm-zip";
import { resolveDirectBedrockDownloadUrl } from "./bedrock-downloads.js";
import {
    resolvePackFeatureSelection,
    type PackFeatureSelectionOverride,
} from "./content.js";
import type { DebugLogger } from "./debug.js";
import { resolveProjectRelativePath } from "./environment.js";
import {
    copyDirectory,
    ensureDirectory,
    ensureParentDirectory,
    exists,
    isDirectory,
    readJson,
    readText,
    removeDirectory,
    removePath,
    writeJson,
    writeText,
} from "./fs.js";
import { ensureStagedBuildArtifacts } from "./runtime.js";
import type {
    BdsPlatform,
    BlurMachineSettings,
    BlurProject,
    PermissionLevel,
} from "./types.js";
import {
    appendWorldSourceHint,
    assertValidProjectWorldSource,
    resolveConfiguredWorldSourcePath,
    resolveProjectWorldSourceDirectory,
} from "./world.js";
import {
    PROJECT_SERVER_STATE_ROOT,
    resolveProjectServerStatePath,
} from "./server-state.js";

type AllowlistEntry = {
    xuid: string;
    name?: string;
    ignoresPlayerLimit?: boolean;
};

type PermissionsEntry = {
    xuid: string;
    permission: PermissionLevel;
};

type BdsApplyMode = "start" | "reload" | "restart";
type BdsExitListener = (code: number | null) => void;
const STATUS_CONTROL_C_EXIT = 3221225786;

export type ResolvedBdsState = {
    channel: BlurProject["minecraft"]["channel"];
    version: string;
    platform: BdsPlatform;
    cacheDirectory: string;
    serverDirectory: string;
    worldName: string;
    worldSourcePath: string;
    worldDirectory: string;
    worldSourceDirectory: string;
    executablePath: string;
    zipPath: string;
    customExecutableSourcePath?: string;
    customExecutableInjected: boolean;
};

export type BdsDownloadProgress = {
    version: string;
    platform: BdsPlatform;
    bytesReceived: number;
    totalBytes?: number;
};

export type BdsProvisionReporter = {
    onDownloadStart?: (progress: {
        version: string;
        platform: BdsPlatform;
        totalBytes?: number;
    }) => void;
    onDownloadProgress?: (progress: BdsDownloadProgress) => void;
    onDownloadComplete?: (progress: BdsDownloadProgress) => void;
    onExtractStart?: (progress: {
        version: string;
        platform: BdsPlatform;
        zipPath: string;
        serverDirectory: string;
    }) => void;
    onExtractComplete?: (progress: {
        version: string;
        platform: BdsPlatform;
        zipPath: string;
        serverDirectory: string;
    }) => void;
};

export type WorldSourceBootstrapResult =
    | "ready"
    | "copied"
    | "waiting-for-runtime";

function resolveBdsPlatform(
    platform: BlurMachineSettings["localServer"]["platform"],
): BdsPlatform {
    if (platform === "win" || platform === "linux") {
        return platform;
    }
    if (process.platform === "win32") return "win";
    if (process.platform === "linux") return "linux";
    throw new Error(
        "Automatic BDS provisioning currently requires Windows or Linux. Use BLR_MACHINE_LOCALSERVER_BDSPLATFORM or --bds-platform to override detection.",
    );
}

export function resolveBdsRuntimeState(
    projectRoot: string,
    config: BlurProject,
    machine: BlurMachineSettings,
    worldName = config.dev.localServer.worldName,
): ResolvedBdsState {
    const version = machine.localServer.bdsVersion;
    const channel = config.minecraft.channel;
    const platform = resolveBdsPlatform(machine.localServer.platform);
    const cacheDirectory = resolveProjectRelativePath(
        projectRoot,
        machine.localServer.cacheDirectory,
    );
    const serverDirectory = resolveProjectRelativePath(
        projectRoot,
        machine.localServer.serverDirectory,
    );
    const worldSourcePath = resolveConfiguredWorldSourcePath(config, worldName);
    const executablePath = path.join(
        serverDirectory,
        platform === "win" ? "bedrock_server.exe" : "bedrock_server",
    );
    return {
        channel,
        version,
        platform,
        cacheDirectory,
        serverDirectory,
        worldName,
        worldSourcePath,
        worldDirectory: path.join(serverDirectory, "worlds", worldName),
        worldSourceDirectory: resolveProjectWorldSourceDirectory(
            projectRoot,
            worldSourcePath,
        ),
        executablePath,
        zipPath: path.join(
            cacheDirectory,
            channel === "preview"
                ? `bedrock-server-preview-${version}-${platform}.zip`
                : `bedrock-server-${version}-${platform}.zip`,
        ),
        customExecutableInjected: false,
    };
}

function resolveProjectCustomExecutablePath(
    projectRoot: string,
    state: ResolvedBdsState,
): string {
    return path.join(
        projectRoot,
        PROJECT_SERVER_STATE_ROOT,
        path.basename(state.executablePath),
    );
}

async function applyCustomExecutableOverride(
    projectRoot: string,
    state: ResolvedBdsState,
    debug?: DebugLogger,
): Promise<void> {
    const customExecutableSourcePath = resolveProjectCustomExecutablePath(
        projectRoot,
        state,
    );
    if (!(await exists(customExecutableSourcePath))) {
        return;
    }

    await ensureParentDirectory(state.executablePath);
    await copyFile(customExecutableSourcePath, state.executablePath);
    if (state.platform === "linux") {
        await chmod(state.executablePath, 0o755);
    }

    state.customExecutableSourcePath = customExecutableSourcePath;
    state.customExecutableInjected = true;
    debug?.log("bds", "applied custom BDS executable override", {
        sourcePath: customExecutableSourcePath,
        executablePath: state.executablePath,
    });
}

function parseContentLength(value: string | null): number | undefined {
    if (!value) {
        return undefined;
    }

    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        return undefined;
    }
    return parsed;
}

async function readArchiveResponse(
    response: Response,
    state: ResolvedBdsState,
    reporter?: BdsProvisionReporter,
): Promise<BdsDownloadProgress & { buffer: Buffer }> {
    const totalBytes = parseContentLength(
        response.headers.get("content-length"),
    );
    reporter?.onDownloadStart?.({
        version: state.version,
        platform: state.platform,
        totalBytes,
    });

    let bytesReceived = 0;
    const emitProgress = () => {
        reporter?.onDownloadProgress?.({
            version: state.version,
            platform: state.platform,
            bytesReceived,
            totalBytes,
        });
    };

    if (!response.body) {
        const buffer = Buffer.from(await response.arrayBuffer());
        bytesReceived = buffer.byteLength;
        emitProgress();
        return {
            version: state.version,
            platform: state.platform,
            bytesReceived,
            totalBytes,
            buffer,
        };
    }

    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    while (true) {
        const { done, value } = await reader.read();
        if (done) {
            break;
        }
        if (!value || value.byteLength === 0) {
            continue;
        }

        const chunk = Buffer.from(
            value.buffer,
            value.byteOffset,
            value.byteLength,
        );
        chunks.push(chunk);
        bytesReceived += chunk.byteLength;
        emitProgress();
    }

    return {
        version: state.version,
        platform: state.platform,
        bytesReceived,
        totalBytes,
        buffer: Buffer.concat(chunks),
    };
}

async function downloadIfMissing(
    state: ResolvedBdsState,
    debug?: DebugLogger,
    reporter?: BdsProvisionReporter,
): Promise<void> {
    if (await exists(state.zipPath)) {
        try {
            const zip = new AdmZip(state.zipPath);
            zip.getEntries();
            debug?.log("bds", "using cached BDS archive", {
                zipPath: state.zipPath,
                version: state.version,
                platform: state.platform,
            });
            return;
        } catch {
            debug?.log("bds", "discarding invalid cached BDS archive", {
                zipPath: state.zipPath,
                version: state.version,
                platform: state.platform,
            });
            await removePath(state.zipPath);
        }
    }

    await ensureDirectory(state.cacheDirectory);
    const url = resolveDirectBedrockDownloadUrl(
        state.channel,
        state.platform,
        state.version,
    );
    debug?.log("bds", "downloading BDS archive", {
        url,
        zipPath: state.zipPath,
    });
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(
            `Failed to download BDS ${state.version} from ${url} (${response.status}).`,
        );
    }

    const download = await readArchiveResponse(response, state, reporter);
    try {
        const zip = new AdmZip(download.buffer);
        zip.getEntries();
    } catch {
        throw new Error(
            `Downloaded BDS ${state.version} from ${url}, but the response was not a valid ZIP archive. Verify minecraft.targetVersion and minecraft.channel.`,
        );
    }
    await writeFile(state.zipPath, download.buffer);
    reporter?.onDownloadComplete?.({
        version: state.version,
        platform: state.platform,
        bytesReceived: download.bytesReceived,
        totalBytes: download.totalBytes,
    });
    debug?.log("bds", "downloaded BDS archive", {
        zipPath: state.zipPath,
        bytes: download.bytesReceived,
    });
}

async function updateServerProperties(
    serverDirectory: string,
    worldName: string,
    permissionLevel: PermissionLevel,
    gamemode: string,
): Promise<void> {
    const propertiesPath = path.join(serverDirectory, "server.properties");
    if (!(await exists(propertiesPath))) {
        return;
    }

    let text = await readText(propertiesPath);
    const setProperty = (key: string, value: string) => {
        const pattern = new RegExp(`^${key}=.*$`, "m");
        if (pattern.test(text)) {
            text = text.replace(pattern, `${key}=${value}`);
            return;
        }
        if (!text.endsWith("\n")) {
            text += "\n";
        }
        text += `${key}=${value}\n`;
    };

    setProperty("allow-cheats", "true");
    setProperty("allow-list", "true");
    setProperty("level-name", worldName);
    setProperty("default-player-permission-level", permissionLevel);
    setProperty("gamemode", gamemode);
    setProperty("content-log-file-enabled", "true");
    setProperty("content-log-console-output-enabled", "true");
    await writeText(propertiesPath, text);
}

async function readProjectAllowlist(
    projectRoot: string,
    config: BlurProject,
): Promise<AllowlistEntry[]> {
    const allowlistPath = resolveProjectServerStatePath(
        projectRoot,
        "allowlist.json",
    );
    if (await exists(allowlistPath)) {
        const entries = await readJson<AllowlistEntry[]>(allowlistPath);
        return entries
            .map((entry) => ({
                xuid: String(entry?.xuid ?? "").trim(),
                name: typeof entry?.name === "string" ? entry.name : "",
                ignoresPlayerLimit: Boolean(entry?.ignoresPlayerLimit),
            }))
            .filter((entry) => entry.xuid.length > 0);
    }

    return config.dev.localServer.allowlist.map((xuid) => ({
        xuid,
        name: "",
        ignoresPlayerLimit: false,
    }));
}

async function readProjectPermissions(
    projectRoot: string,
    config: BlurProject,
): Promise<PermissionsEntry[]> {
    const permissionsPath = resolveProjectServerStatePath(
        projectRoot,
        "permissions.json",
    );
    if (await exists(permissionsPath)) {
        const entries = await readJson<PermissionsEntry[]>(permissionsPath);
        return entries
            .map((entry) => ({
                xuid: String(entry?.xuid ?? "").trim(),
                permission:
                    entry?.permission === "visitor" ||
                    entry?.permission === "member" ||
                    entry?.permission === "operator" ||
                    entry?.permission === "custom"
                        ? entry.permission
                        : "operator",
            }))
            .filter((entry) => entry.xuid.length > 0);
    }

    return config.dev.localServer.operators.map((xuid) => ({
        xuid,
        permission: "operator",
    }));
}

async function upsertAllowlist(
    serverDirectory: string,
    incoming: AllowlistEntry[],
): Promise<void> {
    if (incoming.length === 0) {
        return;
    }

    const targetPath = path.join(serverDirectory, "allowlist.json");
    const existing = (await exists(targetPath))
        ? await readJson<AllowlistEntry[]>(targetPath)
        : [];
    const merged = new Map<string, AllowlistEntry>();

    for (const entry of existing) {
        merged.set(entry.xuid, entry);
    }

    for (const entry of incoming) {
        merged.set(entry.xuid, entry);
    }

    await writeJson(targetPath, Array.from(merged.values()));
}

async function upsertPermissions(
    serverDirectory: string,
    incoming: PermissionsEntry[],
): Promise<void> {
    if (incoming.length === 0) {
        return;
    }

    const targetPath = path.join(serverDirectory, "permissions.json");
    const existing = (await exists(targetPath))
        ? await readJson<PermissionsEntry[]>(targetPath)
        : [];
    const merged = new Map<string, PermissionsEntry>();

    for (const entry of existing) {
        merged.set(entry.xuid, entry);
    }

    for (const entry of incoming) {
        merged.set(entry.xuid, entry);
    }

    await writeJson(targetPath, Array.from(merged.values()));
}

async function ensureModulePermissions(serverDirectory: string): Promise<void> {
    const targetPath = path.join(
        serverDirectory,
        "config",
        "default",
        "permissions.json",
    );
    const current = (await exists(targetPath))
        ? await readJson<{ allowed_modules?: string[] }>(targetPath)
        : { allowed_modules: [] };
    const merged = new Set(current.allowed_modules ?? []);
    merged.add("@minecraft/server-net");
    await writeJson(targetPath, {
        allowed_modules: Array.from(merged.values()),
    });
}

async function extractIfMissing(
    projectRoot: string,
    config: BlurProject,
    state: ResolvedBdsState,
    debug?: DebugLogger,
    reporter?: BdsProvisionReporter,
): Promise<void> {
    if (await exists(state.executablePath)) {
        debug?.log("bds", "reusing provisioned BDS server", {
            serverDirectory: state.serverDirectory,
            executablePath: state.executablePath,
        });
        await updateServerProperties(
            state.serverDirectory,
            state.worldName,
            config.dev.localServer.defaultPermissionLevel,
            config.dev.localServer.gamemode,
        );
        await upsertAllowlist(
            state.serverDirectory,
            await readProjectAllowlist(projectRoot, config),
        );
        await upsertPermissions(
            state.serverDirectory,
            await readProjectPermissions(projectRoot, config),
        );
        await ensureModulePermissions(state.serverDirectory);
        await applyCustomExecutableOverride(projectRoot, state, debug);
        return;
    }

    await downloadIfMissing(state, debug, reporter);
    const serverRootDirectory = path.dirname(state.serverDirectory);
    const createdServerRootDirectory = !(await exists(serverRootDirectory));
    if (createdServerRootDirectory) {
        await ensureDirectory(serverRootDirectory);
    }
    reporter?.onExtractStart?.({
        version: state.version,
        platform: state.platform,
        zipPath: state.zipPath,
        serverDirectory: state.serverDirectory,
    });
    const stagingDirectory = await mkdtemp(
        path.join(
            path.dirname(state.serverDirectory),
            `${path.basename(state.serverDirectory)}.tmp-`,
        ),
    );
    let extracted = false;
    try {
        const zip = new AdmZip(state.zipPath);
        zip.extractAllTo(stagingDirectory, true);
        if (
            !(await exists(
                path.join(
                    stagingDirectory,
                    path.basename(state.executablePath),
                ),
            ))
        ) {
            await removePath(state.zipPath);
            throw new Error(
                `Downloaded BDS ${state.version} did not contain ${path.basename(state.executablePath)}. Verify minecraft.targetVersion and minecraft.channel.`,
            );
        }

        await removeDirectory(state.serverDirectory);
        await rename(stagingDirectory, state.serverDirectory);
        extracted = true;
    } finally {
        if (!extracted) {
            await removeDirectory(stagingDirectory);
            if (createdServerRootDirectory) {
                await removeDirectory(serverRootDirectory);
            }
        }
    }
    debug?.log("bds", "extracted BDS server", {
        zipPath: state.zipPath,
        serverDirectory: state.serverDirectory,
    });
    reporter?.onExtractComplete?.({
        version: state.version,
        platform: state.platform,
        zipPath: state.zipPath,
        serverDirectory: state.serverDirectory,
    });
    await updateServerProperties(
        state.serverDirectory,
        state.worldName,
        config.dev.localServer.defaultPermissionLevel,
        config.dev.localServer.gamemode,
    );
    await upsertAllowlist(
        state.serverDirectory,
        await readProjectAllowlist(projectRoot, config),
    );
    await upsertPermissions(
        state.serverDirectory,
        await readProjectPermissions(projectRoot, config),
    );
    await ensureModulePermissions(state.serverDirectory);
    await applyCustomExecutableOverride(projectRoot, state, debug);
}

async function copyBuiltArtifacts(
    projectRoot: string,
    config: BlurProject,
    serverDirectory: string,
    copyOverride: PackFeatureSelectionOverride = {},
    debug?: DebugLogger,
): Promise<void> {
    const artifacts = await ensureStagedBuildArtifacts(projectRoot, config);
    const copySelection = resolvePackFeatureSelection(
        config.automation.localServer.copy,
        copyOverride,
    );

    const behaviorDestination = artifacts.behaviorPackName
        ? path.join(
              serverDirectory,
              "development_behavior_packs",
              artifacts.behaviorPackName,
          )
        : undefined;
    const resourceDestination = artifacts.resourcePackName
        ? path.join(
              serverDirectory,
              "development_resource_packs",
              artifacts.resourcePackName,
          )
        : undefined;

    debug?.log("bds", "copying project artifacts into BDS", {
        behaviorSource: artifacts.stageBehaviorPackDirectory,
        behaviorDestination,
        resourceSource: artifacts.stageResourcePackDirectory,
        resourceDestination,
        copySelection,
    });

    if (
        copySelection.behaviorPack &&
        artifacts.stageBehaviorPackDirectory &&
        behaviorDestination
    ) {
        await copyDirectory(
            artifacts.stageBehaviorPackDirectory,
            behaviorDestination,
        );
    } else if (behaviorDestination) {
        await removeDirectory(behaviorDestination);
    }
    if (
        copySelection.resourcePack &&
        artifacts.stageResourcePackDirectory &&
        resourceDestination
    ) {
        await copyDirectory(
            artifacts.stageResourcePackDirectory,
            resourceDestination,
        );
    } else if (resourceDestination) {
        await removeDirectory(resourceDestination);
    }
}

async function attachPacks(
    config: BlurProject,
    worldDirectory: string,
    attachOverride: PackFeatureSelectionOverride = {},
    debug?: DebugLogger,
): Promise<void> {
    await ensureDirectory(worldDirectory);
    const attachSelection = resolvePackFeatureSelection(
        config.automation.localServer.attach,
        attachOverride,
    );

    const behaviorPath = path.join(worldDirectory, "world_behavior_packs.json");
    const resourcePath = path.join(worldDirectory, "world_resource_packs.json");
    const syncPackReferenceFile = async (
        filePath: string,
        packId: string,
        nextEntry?: Record<string, unknown>,
    ) => {
        const existing = (await exists(filePath))
            ? await readJson<Array<Record<string, unknown>>>(filePath)
            : [];
        const filtered = existing.filter((entry) => entry.pack_id !== packId);
        const nextEntries = nextEntry ? [nextEntry, ...filtered] : filtered;
        if (nextEntries.length === 0) {
            await removeDirectory(filePath);
            return;
        }
        await writeJson(filePath, nextEntries);
    };

    if (attachSelection.behaviorPack && config.packs.behavior) {
        const behaviorEntry = {
            pack_id: config.packs.behavior.headerUuid,
            version: config.packs.behavior.version,
            priority: 1,
        };
        await syncPackReferenceFile(
            behaviorPath,
            config.packs.behavior.headerUuid,
            behaviorEntry,
        );
    } else if (config.packs.behavior) {
        await syncPackReferenceFile(
            behaviorPath,
            config.packs.behavior.headerUuid,
        );
    }

    if (attachSelection.resourcePack && config.packs.resource) {
        const resourceEntry = {
            pack_id: config.packs.resource.headerUuid,
            version: config.packs.resource.version,
            priority: 1,
        };
        await syncPackReferenceFile(
            resourcePath,
            config.packs.resource.headerUuid,
            resourceEntry,
        );
    } else if (config.packs.resource) {
        await syncPackReferenceFile(
            resourcePath,
            config.packs.resource.headerUuid,
        );
    }
    debug?.log("bds", "attached packs to world", {
        worldDirectory,
        behaviorPackId: config.packs.behavior?.headerUuid,
        resourcePackId: config.packs.resource?.headerUuid,
        attachSelection,
    });
}

async function syncProjectWorldSource(
    projectRoot: string,
    config: BlurProject,
    state: ResolvedBdsState,
    options: { forceReset: boolean; requireWorldSource: boolean },
    debug?: DebugLogger,
): Promise<void> {
    const hasWorldSource = await exists(state.worldSourceDirectory);
    if (!hasWorldSource) {
        if (options.requireWorldSource) {
            try {
                await assertValidProjectWorldSource(
                    projectRoot,
                    state.worldSourcePath,
                    "reset the local server world",
                );
            } catch (error) {
                const message =
                    error instanceof Error ? error.message : String(error);
                throw new Error(
                    appendWorldSourceHint(config, state.worldName, message),
                );
            }
        }
        debug?.log("bds", "no project world source present", {
            worldSourceDirectory: state.worldSourceDirectory,
        });
        return;
    }

    if (options.requireWorldSource) {
        try {
            await assertValidProjectWorldSource(
                projectRoot,
                state.worldSourcePath,
                "reset the local server world",
            );
        } catch (error) {
            const message =
                error instanceof Error ? error.message : String(error);
            throw new Error(
                appendWorldSourceHint(config, state.worldName, message),
            );
        }
    }

    if (!options.forceReset && (await exists(state.worldDirectory))) {
        debug?.log("bds", "preserving existing world", {
            worldDirectory: state.worldDirectory,
            forceReset: options.forceReset,
        });
        return;
    }

    await copyDirectory(state.worldSourceDirectory, state.worldDirectory);
    debug?.log("bds", "copied project world source into runtime world", {
        source: state.worldSourceDirectory,
        destination: state.worldDirectory,
        forceReset: options.forceReset,
    });
}

export async function captureAllowlistFromBds(
    projectRoot: string,
    serverDirectory: string,
    debug?: DebugLogger,
): Promise<void> {
    const sourcePath = path.join(serverDirectory, "allowlist.json");
    if (!(await exists(sourcePath))) {
        debug?.log(
            "bds",
            "skipped allowlist capture because runtime file is missing",
            {
                sourcePath,
            },
        );
        return;
    }

    const targetPath = resolveProjectServerStatePath(
        projectRoot,
        "allowlist.json",
    );
    await writeText(targetPath, await readText(sourcePath));
    debug?.log("bds", "captured runtime allowlist into project state", {
        sourcePath,
        targetPath,
    });
}

export async function captureWorldSourceFromBds(
    state: ResolvedBdsState,
    debug?: DebugLogger,
): Promise<void> {
    if (!(await exists(state.worldDirectory))) {
        debug?.log(
            "bds",
            "skipped world capture because runtime world is missing",
            {
                worldDirectory: state.worldDirectory,
            },
        );
        return;
    }

    await copyDirectory(state.worldDirectory, state.worldSourceDirectory);
    debug?.log("bds", "captured runtime world into project world source", {
        source: state.worldDirectory,
        destination: state.worldSourceDirectory,
    });
}

export async function bootstrapProjectWorldSourceFromBds(
    state: ResolvedBdsState,
    debug?: DebugLogger,
): Promise<WorldSourceBootstrapResult> {
    const sourceDbDirectory = path.join(state.worldSourceDirectory, "db");
    if (
        (await isDirectory(state.worldSourceDirectory)) &&
        (await isDirectory(sourceDbDirectory))
    ) {
        debug?.log("bds", "project world source already present", {
            worldSourceDirectory: state.worldSourceDirectory,
        });
        return "ready";
    }

    const runtimeDbDirectory = path.join(state.worldDirectory, "db");
    if (
        !(await isDirectory(state.worldDirectory)) ||
        !(await isDirectory(runtimeDbDirectory))
    ) {
        debug?.log(
            "bds",
            "runtime world not available for initial source sync",
            {
                worldDirectory: state.worldDirectory,
                worldSourceDirectory: state.worldSourceDirectory,
            },
        );
        return "waiting-for-runtime";
    }

    await captureWorldSourceFromBds(state, debug);
    return "copied";
}

export async function ensureBds(
    projectRoot: string,
    config: BlurProject,
    machine: BlurMachineSettings,
    options: {
        worldName?: string;
        debug?: DebugLogger;
        reporter?: BdsProvisionReporter;
    } = {},
): Promise<ResolvedBdsState> {
    const state = resolveBdsRuntimeState(
        projectRoot,
        config,
        machine,
        options.worldName,
    );
    options.debug?.log("bds", "resolved BDS state", state);
    await ensureDirectory(state.cacheDirectory);
    await extractIfMissing(
        projectRoot,
        config,
        state,
        options.debug,
        options.reporter,
    );
    return state;
}

export async function prefetchBdsArchive(
    projectRoot: string,
    config: BlurProject,
    machine: BlurMachineSettings,
    options: {
        worldName?: string;
        debug?: DebugLogger;
        reporter?: BdsProvisionReporter;
    } = {},
): Promise<ResolvedBdsState> {
    const state = resolveBdsRuntimeState(
        projectRoot,
        config,
        machine,
        options.worldName,
    );
    options.debug?.log("bds", "resolved BDS state for prefetch", state);
    await ensureDirectory(state.cacheDirectory);

    if (await exists(state.executablePath)) {
        options.debug?.log("bds", "skipping BDS archive prefetch", {
            reason: "server already provisioned",
            executablePath: state.executablePath,
        });
        return state;
    }

    await downloadIfMissing(state, options.debug, options.reporter);
    return state;
}

export async function syncProjectToBds(
    projectRoot: string,
    config: BlurProject,
    state: ResolvedBdsState,
    options: {
        resetWorld: boolean;
        requireWorldSource: boolean;
        copyPacks?: PackFeatureSelectionOverride;
        attachPacks?: PackFeatureSelectionOverride;
    },
    debug?: DebugLogger,
): Promise<void> {
    debug?.log("bds", "syncing project into BDS", {
        mode: options.resetWorld ? "reset-world" : "sync",
        serverDirectory: state.serverDirectory,
        worldDirectory: state.worldDirectory,
    });
    await syncProjectWorldSource(
        projectRoot,
        config,
        state,
        {
            forceReset: options.resetWorld,
            requireWorldSource: options.requireWorldSource,
        },
        debug,
    );
    await copyBuiltArtifacts(
        projectRoot,
        config,
        state.serverDirectory,
        options.copyPacks,
        debug,
    );
    await attachPacks(config, state.worldDirectory, options.attachPacks, debug);
}

export class BdsServerController {
    private child: ChildProcess | undefined;
    private state: ResolvedBdsState | undefined;
    private consoleRelay: Interface | undefined;
    private suppressNextExitNotification = false;
    private readonly exitListeners = new Set<BdsExitListener>();

    constructor(
        private readonly projectRoot: string,
        private readonly config: BlurProject,
        private readonly machine: BlurMachineSettings,
        private readonly options: {
            worldName?: string;
            restartOnWorldChange?: boolean;
            copyPacks?: PackFeatureSelectionOverride;
            attachPacks?: PackFeatureSelectionOverride;
            debug?: DebugLogger;
            reporter?: BdsProvisionReporter;
        } = {},
    ) {}

    get restartOnWorldChange(): boolean {
        return (
            this.options.restartOnWorldChange ??
            this.config.dev.localServer.restartOnWorldChange
        );
    }

    get worldName(): string {
        return this.options.worldName ?? this.config.dev.localServer.worldName;
    }

    get worldSourcePath(): string {
        return resolveConfiguredWorldSourcePath(this.config, this.worldName);
    }

    get resolvedState(): ResolvedBdsState | undefined {
        return this.state;
    }

    isRunning(): boolean {
        return Boolean(this.child && this.child.exitCode === null);
    }

    onExit(listener: BdsExitListener): () => void {
        this.exitListeners.add(listener);
        return () => {
            this.exitListeners.delete(listener);
        };
    }

    async apply(mode: BdsApplyMode): Promise<void> {
        this.options.debug?.log("bds", "applying mode", {
            mode,
            running: this.isRunning(),
            worldName: this.worldName,
        });
        const state = await ensureBds(
            this.projectRoot,
            this.config,
            this.machine,
            {
                worldName: this.worldName,
                debug: this.options.debug,
                reporter: this.options.reporter,
            },
        );
        this.state = state;

        if (mode === "restart") {
            await this.stop({ suppressExitNotification: true });
            await syncProjectToBds(
                this.projectRoot,
                this.config,
                state,
                {
                    resetWorld: true,
                    requireWorldSource: true,
                    copyPacks: this.options.copyPacks,
                    attachPacks: this.options.attachPacks,
                },
                this.options.debug,
            );
            await this.start(state);
            return;
        }

        const shouldBootstrapWorld = !(await exists(state.worldDirectory));
        await syncProjectToBds(
            this.projectRoot,
            this.config,
            state,
            {
                resetWorld: shouldBootstrapWorld,
                requireWorldSource: false,
                copyPacks: this.options.copyPacks,
                attachPacks: this.options.attachPacks,
            },
            this.options.debug,
        );

        if (!this.isRunning()) {
            await this.start(state);
            return;
        }

        if (mode === "reload") {
            this.sendCommand("reload");
        }
    }

    async stop(
        options: { suppressExitNotification?: boolean } = {},
    ): Promise<void> {
        if (!this.child || this.child.exitCode !== null) {
            this.child = undefined;
            return;
        }

        this.options.debug?.log("bds", "stopping managed server", {
            suppressExitNotification: Boolean(options.suppressExitNotification),
        });
        this.suppressNextExitNotification = Boolean(
            options.suppressExitNotification,
        );
        const child = this.child;
        await new Promise<void>((resolve) => {
            let settled = false;
            const finish = () => {
                if (settled) return;
                settled = true;
                this.child = undefined;
                resolve();
            };

            const forceKillHandle = setTimeout(() => {
                try {
                    child.kill("SIGTERM");
                } catch {}
                finish();
            }, 5000);

            child.once("exit", () => {
                clearTimeout(forceKillHandle);
                finish();
            });

            try {
                this.sendCommand("stop");
            } catch {
                clearTimeout(forceKillHandle);
                try {
                    child.kill("SIGTERM");
                } catch {}
                finish();
            }
        });
    }

    private async start(state: ResolvedBdsState): Promise<void> {
        if (this.isRunning()) {
            return;
        }

        if (state.customExecutableInjected) {
            const sourceLabel = state.customExecutableSourcePath
                ? path.relative(
                      this.projectRoot,
                      state.customExecutableSourcePath,
                  )
                : path.join(
                      PROJECT_SERVER_STATE_ROOT,
                      path.basename(state.executablePath),
                  );
            console.log(
                `[dev] Notice: using custom local-server executable override from ${sourceLabel}.`,
            );
        }

        this.options.debug?.log("bds", "starting managed server", {
            executablePath: state.executablePath,
            cwd: state.serverDirectory,
            worldName: state.worldName,
        });
        const child = spawn(state.executablePath, [], {
            cwd: state.serverDirectory,
            stdio: ["pipe", "inherit", "inherit"],
        });
        this.child = child;
        this.attachConsoleRelay(child);

        child.on("error", (error) => {
            console.error(`[local-server] ${error.message}`);
        });

        child.on("exit", (code) => {
            this.child = undefined;
            const suppressNotification = this.suppressNextExitNotification;
            this.suppressNextExitNotification = false;
            if (!suppressNotification) {
                if (code === STATUS_CONTROL_C_EXIT) {
                    console.log("[dev] local-server interrupted.");
                } else {
                    console.log(
                        `[dev] local-server exited with code ${String(code ?? 0)}`,
                    );
                }
                for (const listener of this.exitListeners) {
                    listener(code ?? 0);
                }
            }
        });
    }

    private sendCommand(command: string): void {
        const child = this.child;
        if (!child || child.exitCode !== null) {
            return;
        }
        this.options.debug?.log("bds", "sending server command", { command });
        child.stdin?.write(`${command}\n`);
    }

    private attachConsoleRelay(child: ChildProcess): void {
        if (this.consoleRelay) {
            return;
        }

        const relay = createInterface({
            input: process.stdin,
            output: process.stdout,
            terminal: Boolean(process.stdin.isTTY),
        });

        relay.on("line", (line) => {
            this.sendCommand(line);
        });

        relay.on("SIGINT", () => {
            process.emit("SIGINT");
        });

        child.once("exit", () => {
            if (this.consoleRelay !== relay) {
                return;
            }
            this.consoleRelay = undefined;
            relay.close();
        });

        this.consoleRelay = relay;
    }
}
