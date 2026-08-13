import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { chmod, copyFile, mkdtemp, rename, writeFile } from "node:fs/promises";
import { createInterface, type Interface } from "node:readline";
import AdmZip from "adm-zip";
import type { IDisposable, IPty } from "node-pty";
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
import type { ResolvedWorldInput } from "./world-input.js";
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
type BdsWorldApplyMode = "sync-if-missing" | "preserve" | "replace";
type BdsExitListener = (code: number | null) => void;
export type BdsOutputRelayMode = "inherit" | "pipe" | "pty";

type NodePtyModule = typeof import("node-pty");

let nodePtyModule: NodePtyModule | undefined;

async function loadNodePtyModule(): Promise<NodePtyModule | undefined> {
    if (nodePtyModule) {
        return nodePtyModule;
    }

    try {
        nodePtyModule = await import("node-pty");
        return nodePtyModule;
    } catch {
        return undefined;
    }
}

export function resolveBdsOutputRelayMode(input: {
    compactScriptingLogs: boolean;
    stdoutIsTTY: boolean;
    stderrIsTTY: boolean;
    ptyAvailable: boolean;
}): BdsOutputRelayMode {
    if (!input.compactScriptingLogs) {
        return "inherit";
    }

    if (input.stdoutIsTTY && input.stderrIsTTY && input.ptyAvailable) {
        return "pty";
    }

    return "pipe";
}

function isBdsScriptingLogLine(line: string): boolean {
    return line.includes("] [Scripting]");
}

function stripAnsiSequences(value: string): string {
    return value
        .replace(/\u001B\]0;[^\u0007]*(?:\u0007|\u001B\\)/g, "")
        .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "");
}

function extractSgrSequences(value: string): string {
    return value.match(/\u001B\[[0-?]*[ -/]*m/g)?.join("") ?? "";
}

export class BdsPtyOutputFilter {
    private pending = "";
    private beforeFirstPrintable = true;

    write(chunk: string): string {
        return this.process(`${this.pending}${chunk}`, false);
    }

    end(): string {
        return this.process(this.pending, true);
    }

    private process(input: string, flush: boolean): string {
        this.pending = "";
        let output = "";
        let index = 0;

        while (index < input.length) {
            const character = input[index];

            if (character === "\u001B") {
                const next = input[index + 1];
                if (typeof next === "undefined") {
                    this.pending = flush ? "" : input.slice(index);
                    break;
                }

                if (next === "]") {
                    const terminator = findOscTerminator(input, index + 2);
                    if (!terminator) {
                        this.pending = flush ? "" : input.slice(index);
                        break;
                    }
                    index = terminator.end;
                    continue;
                }

                if (next === "[") {
                    const sequenceEnd = findCsiSequenceEnd(input, index + 2);
                    if (sequenceEnd < 0) {
                        this.pending = flush ? "" : input.slice(index);
                        break;
                    }

                    const sequence = input.slice(index, sequenceEnd + 1);
                    if (
                        input[sequenceEnd] === "m" &&
                        !(
                            this.beforeFirstPrintable &&
                            isResetSgrSequence(sequence)
                        )
                    ) {
                        output += sequence;
                    }
                    index = sequenceEnd + 1;
                    continue;
                }

                index += 2;
                continue;
            }

            if (isAsciiControl(character)) {
                if (
                    !this.beforeFirstPrintable &&
                    (character === "\r" ||
                        character === "\n" ||
                        character === "\t")
                ) {
                    output += character;
                }
                index += 1;
                continue;
            }

            this.beforeFirstPrintable = false;
            output += character;
            index += 1;
        }

        return output;
    }
}

function findOscTerminator(
    input: string,
    startIndex: number,
): { end: number } | undefined {
    const bellIndex = input.indexOf("\u0007", startIndex);
    const stIndex = input.indexOf("\u001B\\", startIndex);

    if (bellIndex < 0 && stIndex < 0) {
        return undefined;
    }

    if (bellIndex >= 0 && (stIndex < 0 || bellIndex < stIndex)) {
        return { end: bellIndex + 1 };
    }

    return { end: stIndex + 2 };
}

function findCsiSequenceEnd(input: string, startIndex: number): number {
    for (let index = startIndex; index < input.length; index += 1) {
        const code = input.charCodeAt(index);
        if (code >= 0x40 && code <= 0x7e) {
            return index;
        }
    }
    return -1;
}

function isResetSgrSequence(sequence: string): boolean {
    return /^\u001B\[(?:0*)?m$/.test(sequence);
}

function isAsciiControl(character: string): boolean {
    const code = character.charCodeAt(0);
    return code < 0x20 || code === 0x7f;
}

export class BdsScriptingLogCompactor {
    private pending = "";
    private suppressBlankAfterScripting = false;

    write(chunk: string): string {
        this.pending += chunk;
        let output = "";

        for (;;) {
            const lineEnd = this.pending.indexOf("\n");
            if (lineEnd < 0) {
                break;
            }

            const line = this.pending.slice(0, lineEnd + 1);
            this.pending = this.pending.slice(lineEnd + 1);
            output += this.processLine(line);
        }

        return output;
    }

    end(): string {
        if (this.pending.length === 0) {
            return "";
        }

        const output = this.processLine(this.pending);
        this.pending = "";
        return output;
    }

    private processLine(line: string): string {
        const content = line.endsWith("\n")
            ? line.slice(0, -1).replace(/\r$/, "")
            : line;

        if (
            this.suppressBlankAfterScripting &&
            stripAnsiSequences(content).trim().length === 0
        ) {
            return extractSgrSequences(content);
        }

        this.suppressBlankAfterScripting = isBdsScriptingLogLine(content);
        return line;
    }
}
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

type RenameDirectory = (
    sourcePath: string,
    destinationPath: string,
) => Promise<void>;
type RemoveDirectory = (targetPath: string) => Promise<void>;

type ReplaceBdsServerDirectoryOptions = {
    debug?: DebugLogger;
    retryDelaysMs?: readonly number[];
    renameDirectory?: RenameDirectory;
    removeDirectory?: RemoveDirectory;
};

const BDS_SERVER_REPLACE_RETRY_DELAYS_MS = [50, 100, 250, 500] as const;

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function setServerProperty(text: string, key: string, value: string): string {
    const pattern = new RegExp(`^${escapeRegExp(key)}=.*$`, "m");
    if (pattern.test(text)) {
        return text.replace(pattern, `${key}=${value}`);
    }
    if (text.length > 0 && !text.endsWith("\n")) {
        text += "\n";
    }
    return `${text}${key}=${value}\n`;
}

function applyServerPropertiesOverlay(
    text: string,
    overlayText: string,
): string {
    let nextText = text;
    for (const line of overlayText.split(/\r?\n/u)) {
        const trimmed = line.trim();
        if (trimmed.length === 0 || trimmed.startsWith("#")) {
            continue;
        }

        const separatorIndex = line.indexOf("=");
        if (separatorIndex <= 0) {
            continue;
        }

        const key = line.slice(0, separatorIndex).trim();
        if (key.length === 0) {
            continue;
        }

        const value = line.slice(separatorIndex + 1).trim();
        nextText = setServerProperty(nextText, key, value);
    }
    return nextText;
}

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
    projectRoot: string,
    serverDirectory: string,
    worldName: string,
    permissionLevel: PermissionLevel,
    gamemode: string,
    debug?: DebugLogger,
): Promise<void> {
    const propertiesPath = path.join(serverDirectory, "server.properties");
    const projectPropertiesPath = resolveProjectServerStatePath(
        projectRoot,
        "server.properties",
    );
    const [runtimePropertiesExist, projectPropertiesExist] = await Promise.all([
        exists(propertiesPath),
        exists(projectPropertiesPath),
    ]);
    if (!runtimePropertiesExist && !projectPropertiesExist) {
        return;
    }

    const projectPropertiesText = projectPropertiesExist
        ? await readText(projectPropertiesPath)
        : undefined;
    let text = runtimePropertiesExist
        ? await readText(propertiesPath)
        : (projectPropertiesText ?? "");

    if (runtimePropertiesExist && typeof projectPropertiesText === "string") {
        text = applyServerPropertiesOverlay(text, projectPropertiesText);
    }

    text = setServerProperty(text, "allow-cheats", "true");
    text = setServerProperty(text, "allow-list", "true");
    text = setServerProperty(text, "level-name", worldName);
    text = setServerProperty(
        text,
        "default-player-permission-level",
        permissionLevel,
    );
    text = setServerProperty(text, "gamemode", gamemode);
    text = setServerProperty(text, "content-log-file-enabled", "true");
    text = setServerProperty(
        text,
        "content-log-console-output-enabled",
        "true",
    );
    await writeText(propertiesPath, text);
    debug?.log("bds", "updated runtime server.properties", {
        projectPropertiesPath: projectPropertiesExist
            ? projectPropertiesPath
            : undefined,
        runtimePropertiesPath: propertiesPath,
        worldName,
        permissionLevel,
        gamemode,
    });
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

function fileSystemErrorCode(error: unknown): string | undefined {
    if (!error || typeof error !== "object" || !("code" in error)) {
        return undefined;
    }

    const code = (error as { code?: unknown }).code;
    return typeof code === "string" ? code : undefined;
}

function isRetryableBdsServerRenameError(error: unknown): boolean {
    const code = fileSystemErrorCode(error);
    return code === "EPERM" || code === "EACCES" || code === "ENOTEMPTY";
}

async function wait(milliseconds: number): Promise<void> {
    if (milliseconds <= 0) {
        return;
    }
    await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function replaceBdsServerDirectory(
    stagingDirectory: string,
    serverDirectory: string,
    options: ReplaceBdsServerDirectoryOptions = {},
): Promise<void> {
    const renameDirectory = options.renameDirectory ?? rename;
    const removeDirectoryOperation = options.removeDirectory ?? removeDirectory;
    const retryDelaysMs =
        options.retryDelaysMs ?? BDS_SERVER_REPLACE_RETRY_DELAYS_MS;

    await removeDirectoryOperation(serverDirectory);

    for (let attempt = 0; ; attempt += 1) {
        try {
            await renameDirectory(stagingDirectory, serverDirectory);
            return;
        } catch (error) {
            const retryDelayMs = retryDelaysMs[attempt];
            if (
                typeof retryDelayMs !== "number" ||
                !isRetryableBdsServerRenameError(error)
            ) {
                throw error;
            }

            options.debug?.log(
                "bds",
                "retrying BDS server directory replacement",
                {
                    attempt: attempt + 1,
                    retryDelayMs,
                    errorCode: fileSystemErrorCode(error),
                    stagingDirectory,
                    serverDirectory,
                },
            );
            await wait(retryDelayMs);
            await removeDirectoryOperation(serverDirectory);
        }
    }
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
            projectRoot,
            state.serverDirectory,
            state.worldName,
            config.dev.localServer.defaultPermissionLevel,
            config.dev.localServer.gamemode,
            debug,
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

        await replaceBdsServerDirectory(
            stagingDirectory,
            state.serverDirectory,
            { debug },
        );
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
        projectRoot,
        state.serverDirectory,
        state.worldName,
        config.dev.localServer.defaultPermissionLevel,
        config.dev.localServer.gamemode,
        debug,
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
        behaviorSource: artifacts.stageBdsBehaviorPackDirectory,
        behaviorDestination,
        resourceSource: artifacts.stageResourcePackDirectory,
        resourceDestination,
        copySelection,
    });

    if (
        copySelection.behaviorPack &&
        artifacts.stageBdsBehaviorPackDirectory &&
        behaviorDestination
    ) {
        await copyDirectory(
            artifacts.stageBdsBehaviorPackDirectory,
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
    options: {
        worldMode: BdsWorldApplyMode;
        requireWorldSource: boolean;
        worldInput?: ResolvedWorldInput;
    },
    debug?: DebugLogger,
): Promise<void> {
    const inputDirectory =
        options.worldInput?.directory ?? state.worldSourceDirectory;
    if (
        options.worldInput &&
        options.worldInput.worldName !== state.worldName
    ) {
        throw new Error(
            `Resolved world input ${options.worldInput.worldName} cannot seed BDS world ${state.worldName}.`,
        );
    }
    const hasWorldSource = await exists(inputDirectory);
    if (!hasWorldSource) {
        if (options.requireWorldSource && !options.worldInput) {
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
            worldSourceDirectory: inputDirectory,
        });
        return;
    }

    if (options.requireWorldSource && !options.worldInput) {
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

    if (
        options.worldMode === "preserve" ||
        (options.worldMode === "sync-if-missing" &&
            (await exists(state.worldDirectory)))
    ) {
        debug?.log("bds", "preserving existing world", {
            worldDirectory: state.worldDirectory,
            worldMode: options.worldMode,
        });
        return;
    }

    if (
        options.worldInput &&
        !(await exists(path.join(inputDirectory, "db")))
    ) {
        throw new Error(
            `Resolved ${options.worldInput.kind} world input is missing its db directory: ${inputDirectory}.`,
        );
    }
    await copyDirectory(inputDirectory, state.worldDirectory);
    debug?.log("bds", "copied project world source into runtime world", {
        source: inputDirectory,
        inputKind: options.worldInput?.kind ?? "authored",
        destination: state.worldDirectory,
        worldMode: options.worldMode,
    });
}

function formatFileSafeIsoTimestamp(date = new Date()): string {
    return date
        .toISOString()
        .replace(/[-:]/g, "")
        .replace(/\.\d{3}Z$/, "Z");
}

function resolveRuntimeWorldBackupDirectory(state: ResolvedBdsState): string {
    return path.join(state.serverDirectory, "worlds_backups");
}

function resolveRuntimeWorldBackupPath(
    state: ResolvedBdsState,
    timestamp = formatFileSafeIsoTimestamp(),
): string {
    return path.join(
        resolveRuntimeWorldBackupDirectory(state),
        `${state.worldName}.${timestamp}`,
    );
}

export async function backupRuntimeWorldForBdsStartup(
    state: ResolvedBdsState,
    debug?: DebugLogger,
): Promise<string | undefined> {
    if (!(await exists(state.worldDirectory))) {
        debug?.log(
            "bds",
            "skipped runtime world backup because it is missing",
            {
                worldDirectory: state.worldDirectory,
            },
        );
        return undefined;
    }

    await ensureDirectory(resolveRuntimeWorldBackupDirectory(state));
    const baseBackupPath = resolveRuntimeWorldBackupPath(state);
    let backupPath = baseBackupPath;
    let collisionIndex = 1;
    while (await exists(backupPath)) {
        collisionIndex += 1;
        backupPath = `${baseBackupPath}-${collisionIndex}`;
    }

    await rename(state.worldDirectory, backupPath);
    debug?.log("bds", "backed up runtime world before replacement", {
        worldDirectory: state.worldDirectory,
        backupPath,
    });
    return backupPath;
}

export async function replaceRuntimeWorldFromProjectSource(
    projectRoot: string,
    config: BlurProject,
    state: ResolvedBdsState,
    options: {
        requireWorldSource?: boolean;
        worldInput?: ResolvedWorldInput;
    } = {},
    debug?: DebugLogger,
): Promise<void> {
    await syncProjectWorldSource(
        projectRoot,
        config,
        state,
        {
            worldMode: "replace",
            requireWorldSource: options.requireWorldSource ?? true,
            worldInput: options.worldInput,
        },
        debug,
    );
}

export async function captureAllowlistFromBds(
    projectRoot: string,
    serverDirectory: string,
    debug?: DebugLogger,
): Promise<void> {
    await captureProjectServerStateFileFromBds(
        projectRoot,
        serverDirectory,
        "allowlist.json",
        debug,
    );
}

export async function capturePermissionsFromBds(
    projectRoot: string,
    serverDirectory: string,
    debug?: DebugLogger,
): Promise<void> {
    await captureProjectServerStateFileFromBds(
        projectRoot,
        serverDirectory,
        "permissions.json",
        debug,
    );
}

async function captureProjectServerStateFileFromBds(
    projectRoot: string,
    serverDirectory: string,
    fileName: "allowlist.json" | "permissions.json",
    debug?: DebugLogger,
): Promise<void> {
    const sourcePath = path.join(serverDirectory, fileName);
    if (!(await exists(sourcePath))) {
        debug?.log(
            "bds",
            "skipped server state capture because runtime file is missing",
            {
                sourcePath,
                fileName,
            },
        );
        return;
    }

    const targetPath = resolveProjectServerStatePath(projectRoot, fileName);
    await writeText(targetPath, await readText(sourcePath));
    debug?.log("bds", "captured runtime server state into project state", {
        sourcePath,
        targetPath,
        fileName,
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
        worldMode: BdsWorldApplyMode;
        requireWorldSource: boolean;
        copyPacks?: PackFeatureSelectionOverride;
        attachPacks?: PackFeatureSelectionOverride;
        worldInput?: ResolvedWorldInput;
    },
    debug?: DebugLogger,
): Promise<void> {
    debug?.log("bds", "syncing project into BDS", {
        worldMode: options.worldMode,
        serverDirectory: state.serverDirectory,
        worldDirectory: state.worldDirectory,
    });
    await syncProjectWorldSource(
        projectRoot,
        config,
        state,
        {
            worldMode: options.worldMode,
            requireWorldSource: options.requireWorldSource,
            worldInput: options.worldInput,
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
    private terminal: IPty | undefined;
    private terminalExitCode: number | null | undefined;
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
            compactScriptingLogs?: boolean;
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
        return Boolean(
            (this.child && this.child.exitCode === null) ||
            (this.terminal && this.terminalExitCode === null),
        );
    }

    onExit(listener: BdsExitListener): () => void {
        this.exitListeners.add(listener);
        return () => {
            this.exitListeners.delete(listener);
        };
    }

    async apply(
        mode: BdsApplyMode,
        options: {
            worldMode?: BdsWorldApplyMode;
            requireWorldSource?: boolean;
            worldInput?: ResolvedWorldInput;
        } = {},
    ): Promise<void> {
        this.options.debug?.log("bds", "applying mode", {
            mode,
            running: this.isRunning(),
            worldName: this.worldName,
            worldMode: options.worldMode,
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

        const worldMode =
            options.worldMode ??
            (mode === "restart" ? "replace" : "sync-if-missing");
        const requireWorldSource =
            options.requireWorldSource ??
            (mode === "restart" ? worldMode !== "preserve" : false);

        if (mode === "restart") {
            await this.stop({ suppressExitNotification: true });
            await syncProjectToBds(
                this.projectRoot,
                this.config,
                state,
                {
                    worldMode,
                    requireWorldSource,
                    copyPacks: this.options.copyPacks,
                    attachPacks: this.options.attachPacks,
                    worldInput: options.worldInput,
                },
                this.options.debug,
            );
            await this.start(state);
            return;
        }

        await syncProjectToBds(
            this.projectRoot,
            this.config,
            state,
            {
                worldMode,
                requireWorldSource,
                copyPacks: this.options.copyPacks,
                attachPacks: this.options.attachPacks,
                worldInput: options.worldInput,
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
        if (
            !(this.child && this.child.exitCode === null) &&
            !(this.terminal && this.terminalExitCode === null)
        ) {
            this.child = undefined;
            this.terminal = undefined;
            this.terminalExitCode = undefined;
            return;
        }

        this.options.debug?.log("bds", "stopping managed server", {
            suppressExitNotification: Boolean(options.suppressExitNotification),
        });
        this.suppressNextExitNotification = Boolean(
            options.suppressExitNotification,
        );
        if (this.child && this.child.exitCode === null) {
            await this.stopChildProcess();
            return;
        }

        if (this.terminal && this.terminalExitCode === null) {
            await this.stopPtyProcess();
            return;
        }
    }

    private async stopChildProcess(): Promise<void> {
        const child = this.child;
        if (!child) {
            return;
        }

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

    private async stopPtyProcess(): Promise<void> {
        const terminal = this.terminal;
        if (!terminal) {
            return;
        }

        await new Promise<void>((resolve) => {
            let settled = false;
            const finish = () => {
                if (settled) return;
                settled = true;
                this.terminal = undefined;
                this.terminalExitCode = undefined;
                resolve();
            };

            const forceKillHandle = setTimeout(() => {
                try {
                    terminal.kill();
                } catch {}
                finish();
            }, 5000);

            terminal.onExit(() => {
                clearTimeout(forceKillHandle);
                finish();
            });

            try {
                this.sendCommand("stop");
            } catch {
                clearTimeout(forceKillHandle);
                try {
                    terminal.kill();
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

        const compactScriptingLogs =
            this.options.compactScriptingLogs ??
            this.config.dev.localServer.compactScriptingLogs;
        const ptyModule = compactScriptingLogs
            ? await loadNodePtyModule()
            : undefined;
        const outputRelayMode = resolveBdsOutputRelayMode({
            compactScriptingLogs,
            stdoutIsTTY: Boolean(process.stdout.isTTY),
            stderrIsTTY: Boolean(process.stderr.isTTY),
            ptyAvailable: Boolean(ptyModule),
        });
        this.options.debug?.log("bds", "starting managed server", {
            executablePath: state.executablePath,
            cwd: state.serverDirectory,
            worldName: state.worldName,
            compactScriptingLogs,
            outputRelayMode,
        });

        if (outputRelayMode === "pty" && ptyModule) {
            try {
                this.startPty(state, ptyModule);
                return;
            } catch (error) {
                const message =
                    error instanceof Error ? error.message : String(error);
                console.error(
                    `[dev] Warning: local-server PTY output relay failed (${message}). Falling back to piped output.`,
                );
                this.options.debug?.log("bds", "PTY output relay failed", {
                    message,
                });
            }
        }

        this.startChildProcess(state, outputRelayMode);
    }

    private startChildProcess(
        state: ResolvedBdsState,
        outputRelayMode: BdsOutputRelayMode,
    ): void {
        const outputStdio = outputRelayMode === "pipe" ? "pipe" : "inherit";
        const child = spawn(state.executablePath, [], {
            cwd: state.serverDirectory,
            stdio: ["pipe", outputStdio, outputStdio],
        });
        this.child = child;
        if (outputRelayMode === "pipe") {
            this.attachOutputRelay(child);
        }
        this.attachConsoleRelay((listener) => {
            child.once("exit", listener);
        });

        child.on("error", (error) => {
            console.error(`[local-server] ${error.message}`);
        });

        child.on("exit", (code) => {
            this.child = undefined;
            this.notifyExit(code);
        });
    }

    private startPty(state: ResolvedBdsState, ptyModule: NodePtyModule): void {
        const outputFilter = new BdsPtyOutputFilter();
        const compactor = new BdsScriptingLogCompactor();
        const terminal = ptyModule.spawn(state.executablePath, [], {
            name: process.env.TERM || "xterm-256color",
            cols: process.stdout.columns || 80,
            rows: process.stdout.rows || 24,
            cwd: state.serverDirectory,
            env: {
                ...process.env,
                TERM: process.env.TERM || "xterm-256color",
            },
            useConpty: true,
        });
        this.terminal = terminal;
        this.terminalExitCode = null;

        const disposables: IDisposable[] = [];
        const resize = () => {
            try {
                terminal.resize(
                    process.stdout.columns || 80,
                    process.stdout.rows || 24,
                );
            } catch {}
        };

        process.stdout.on("resize", resize);
        disposables.push(
            terminal.onData((data) => {
                const output = compactor.write(outputFilter.write(data));
                if (output.length > 0) {
                    process.stdout.write(output);
                }
            }),
        );
        disposables.push(
            terminal.onExit(({ exitCode }) => {
                process.stdout.off("resize", resize);
                for (const disposable of disposables) {
                    disposable.dispose();
                }

                const output = compactor.end();
                const filteredOutput = outputFilter.end() + output;
                if (filteredOutput.length > 0) {
                    process.stdout.write(filteredOutput);
                }

                this.terminalExitCode = exitCode;
                this.terminal = undefined;
                this.notifyExit(exitCode);
            }),
        );

        this.attachConsoleRelay((listener) => {
            terminal.onExit(() => {
                listener();
            });
        });
    }

    private notifyExit(code: number | null): void {
        const suppressNotification = this.suppressNextExitNotification;
        this.suppressNextExitNotification = false;
        if (suppressNotification) {
            return;
        }

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

    private attachOutputRelay(child: ChildProcess): void {
        const stdoutCompactor = new BdsScriptingLogCompactor();
        const stderrCompactor = new BdsScriptingLogCompactor();

        child.stdout?.setEncoding("utf8");
        child.stdout?.on("data", (chunk: string) => {
            const output = stdoutCompactor.write(chunk);
            if (output.length > 0) {
                process.stdout.write(output);
            }
        });
        child.stdout?.on("end", () => {
            const output = stdoutCompactor.end();
            if (output.length > 0) {
                process.stdout.write(output);
            }
        });

        child.stderr?.setEncoding("utf8");
        child.stderr?.on("data", (chunk: string) => {
            const output = stderrCompactor.write(chunk);
            if (output.length > 0) {
                process.stderr.write(output);
            }
        });
        child.stderr?.on("end", () => {
            const output = stderrCompactor.end();
            if (output.length > 0) {
                process.stderr.write(output);
            }
        });
    }

    private sendCommand(command: string): void {
        const child = this.child;
        if (child && child.exitCode === null) {
            this.options.debug?.log("bds", "sending server command", {
                command,
            });
            child.stdin?.write(`${command}\n`);
            return;
        }

        const terminal = this.terminal;
        if (!terminal || this.terminalExitCode !== null) {
            return;
        }

        this.options.debug?.log("bds", "sending server command", { command });
        terminal.write(`${command}\r`);
    }

    private attachConsoleRelay(
        registerExitListener: (listener: () => void) => void,
    ): void {
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

        registerExitListener(() => {
            if (this.consoleRelay !== relay) {
                return;
            }
            this.consoleRelay = undefined;
            relay.close();
        });

        this.consoleRelay = relay;
    }
}
