import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
    cp,
    mkdir,
    readFile,
    readdir,
    rename,
    rm,
    stat,
    writeFile,
} from "node:fs/promises";
import path from "node:path";
import { LevelDB } from "@8crafter/leveldb-zlib";
import type {
    ResolvedWorldProcessorConfig,
    WorldProcessorDiagnostic,
    WorldProcessorPipelineIntent,
    WorldSourceIdentity,
} from "../world-processing.js";
import {
    publishWorldProcessorArtifactSet,
    type PublishedWorldProcessorArtifactSet,
} from "./artifact-set.js";
import { canonicalJson, hashCanonicalJson } from "./canonical-json.js";
import {
    normalizeWorldMutationPlans,
    type PrimitiveWorldMutation,
} from "./mutations.js";
import { withBedrockWorldObservations } from "./observation-facade.js";
import {
    runWorldProcessorGraph,
    type WorldProcessorExecutionResult,
} from "./runner.js";
import {
    withVerifiedWorldSnapshot,
    type VerifiedWorldSnapshot,
} from "./world-snapshot.js";
import { applyBedrockWorldMutations } from "./writer.js";

export type BuildProcessedWorldOptions = {
    readonly projectRoot: string;
    readonly worldName: string;
    readonly sourceWorldDirectory: string;
    readonly configs: readonly ResolvedWorldProcessorConfig[];
    readonly pipeline?: WorldProcessorPipelineIntent;
    readonly processorIds?: readonly string[];
    readonly outputDirectory?: string;
    readonly audit?: boolean;
    readonly mode: "check" | "bake";
    readonly signal: AbortSignal;
    readonly isCurrent?: () => boolean;
    readonly verifyMutations?: boolean;
};

export type ProcessedWorldBuildStatus = "current" | "stale" | "built";

export type ProcessedWorldBuildResult = {
    readonly status: ProcessedWorldBuildStatus;
    readonly worldName: string;
    readonly worldBuildId: string;
    readonly sourceIdentity: WorldSourceIdentity;
    readonly worldContentHash: string;
    readonly mutationPlanHash: string;
    readonly processorIds: readonly string[];
    readonly setDirectory: string;
    readonly worldDirectory: string;
    readonly pointerPath: string;
    readonly diagnostics: readonly WorldProcessorDiagnostic[];
};

export type RunWorldProcessorArtifactPipelineOptions = {
    readonly projectRoot: string;
    readonly worldName: string;
    readonly sourceWorldDirectory: string;
    readonly configs: readonly ResolvedWorldProcessorConfig[];
    readonly pipeline: WorldProcessorPipelineIntent;
    readonly mode: "check" | "bake";
    readonly audit?: boolean;
    readonly signal: AbortSignal;
    readonly isCurrent?: () => boolean;
    /** Apply the normalized mutation plan to the disposable snapshot for verification. */
    readonly verifyMutations?: boolean;
};

export type WorldProcessorArtifactPipelineResult = {
    readonly status: "current" | "published" | "stale";
    readonly processorIds: readonly string[];
    readonly diagnostics: readonly WorldProcessorDiagnostic[];
};

type ArtifactBinding = {
    readonly processorId: string;
    readonly artifactSetId: string;
    readonly manifestContentHash: string;
};

type ProcessedWorldLogicalManifest = {
    readonly schemaVersion: 1;
    readonly worldName: string;
    readonly pipeline: WorldProcessorPipelineIntent;
    readonly sourceIdentity: WorldSourceIdentity;
    readonly worldContentHash: string;
    readonly mutationPlanHash: string;
    readonly processors: readonly {
        readonly id: string;
        readonly providerRevision: string;
        readonly logicalInputHash: string;
    }[];
    readonly artifacts: readonly ArtifactBinding[];
};

type WorldFileInventoryEntry = {
    readonly path: string;
    readonly size: number;
    readonly contentHash: string;
};

type ProcessedWorldManifestV1 = ProcessedWorldLogicalManifest & {
    readonly worldBuildId: string;
    readonly worldFiles: readonly WorldFileInventoryEntry[];
};

type PreparedBuild = {
    readonly snapshot: VerifiedWorldSnapshot;
    readonly executions: readonly WorldProcessorExecutionResult[];
    readonly mutations: readonly PrimitiveWorldMutation[];
    readonly mutationPlanHash: string;
    readonly worldContentHash: string;
    readonly logicalManifest: ProcessedWorldLogicalManifest;
    readonly worldBuildId: string;
    readonly artifactChecks: readonly PublishedWorldProcessorArtifactSet[];
    readonly diagnostics: readonly WorldProcessorDiagnostic[];
};

/**
 * Builds or verifies a processed-world lineage from one immutable source
 * snapshot. The authored world is never opened and can never be an output.
 */
export async function buildProcessedWorld(
    options: BuildProcessedWorldOptions,
): Promise<ProcessedWorldBuildResult> {
    throwIfAborted(options.signal);
    assertOutputDoesNotOverlapSource(
        options.sourceWorldDirectory,
        options.outputDirectory,
    );
    const pipeline = options.pipeline ?? "world-build";
    const configs = selectProcessorConfigs(
        options.configs,
        options.worldName,
        options.processorIds,
        pipeline,
    );
    if (configs.length === 0) {
        throw new Error(
            `No world processors apply to ${options.worldName} for world build.`,
        );
    }
    const configById = new Map(configs.map((config) => [config.id, config]));
    const lineageRoot = path.join(
        options.projectRoot,
        ".blr",
        "world-processing",
        "worlds",
        options.worldName,
        pipeline,
    );

    return withVerifiedWorldSnapshot(
        {
            worldName: options.worldName,
            sourceWorldDirectory: options.sourceWorldDirectory,
            signal: options.signal,
        },
        async (snapshot) => {
            const prepared = await prepareProcessedWorld(
                options,
                snapshot,
                configs,
                configById,
                pipeline,
            );
            const setDirectory = path.join(
                lineageRoot,
                "sets",
                prepared.worldBuildId,
            );
            const worldDirectory = path.join(setDirectory, "world");
            const pointerPath = path.join(lineageRoot, "current.json");
            const setCurrent = await processedSetIsCurrent(
                setDirectory,
                prepared.logicalManifest,
                prepared.worldBuildId,
            );
            const expectedPointer = canonicalJson({
                schemaVersion: 1,
                worldName: options.worldName,
                worldBuildId: prepared.worldBuildId,
                manifest: `sets/${prepared.worldBuildId}/manifest.json`,
                world: `sets/${prepared.worldBuildId}/world`,
            });
            const pointerCurrent = await fileEquals(
                pointerPath,
                expectedPointer,
            );
            const artifactsCurrent = prepared.artifactChecks.every(
                (artifact) => artifact.status === "current",
            );

            if (options.mode === "check") {
                return result(
                    setCurrent && pointerCurrent && artifactsCurrent
                        ? "current"
                        : "stale",
                );
            }
            throwIfAborted(options.signal);
            let changed = false;
            if (!setCurrent) {
                if (await exists(setDirectory)) {
                    throw new Error(
                        `Processed world set ${prepared.worldBuildId} exists but does not match its logical manifest or file inventory.`,
                    );
                }
                await publishProcessedSet(
                    snapshot.worldDirectory,
                    setDirectory,
                    prepared.logicalManifest,
                    prepared.worldBuildId,
                    options,
                );
                changed = true;
            }
            for (const execution of prepared.executions) {
                const config = configById.get(execution.processorId)!;
                if (
                    config.capabilities.includes("artifact") &&
                    execution.result.artifacts.length > 0
                ) {
                    const published = await publishWorldProcessorArtifactSet({
                        projectRoot: options.projectRoot,
                        config,
                        execution,
                        mode: "bake",
                        isCurrent: options.isCurrent,
                    });
                    if (published.status === "stale") {
                        return result("stale");
                    }
                    if (published.status === "published") changed = true;
                }
                if (options.isCurrent && !options.isCurrent()) {
                    return result("stale");
                }
                if (options.audit && config.auditOutputPath) {
                    await writeAudit(options.projectRoot, config, execution);
                    changed = true;
                }
            }
            if (options.isCurrent && !options.isCurrent()) {
                return result("stale");
            }
            if (!pointerCurrent) {
                await replaceFileAtomically(pointerPath, expectedPointer);
                changed = true;
            }
            if (options.outputDirectory) {
                await copyExplicitOutput(
                    worldDirectory,
                    options.outputDirectory,
                );
                changed = true;
            }
            return result(changed ? "built" : "current");

            function result(
                status: ProcessedWorldBuildStatus,
            ): ProcessedWorldBuildResult {
                return Object.freeze({
                    status,
                    worldName: options.worldName,
                    worldBuildId: prepared.worldBuildId,
                    sourceIdentity: prepared.snapshot.sourceIdentity,
                    worldContentHash: prepared.worldContentHash,
                    mutationPlanHash: prepared.mutationPlanHash,
                    processorIds: Object.freeze(
                        prepared.executions.map(
                            (execution) => execution.processorId,
                        ),
                    ),
                    setDirectory,
                    worldDirectory,
                    pointerPath,
                    diagnostics: prepared.diagnostics,
                });
            }
        },
    );
}

/**
 * Runs the same processor graph and mutation verification used by world build,
 * but publishes only runtime artifacts. This is the build-stage hook: world
 * mutations are proven on a disposable snapshot and never materialised.
 */
export async function runWorldProcessorArtifactPipeline(
    options: RunWorldProcessorArtifactPipelineOptions,
): Promise<WorldProcessorArtifactPipelineResult> {
    const configs = selectProcessorConfigs(
        options.configs,
        options.worldName,
        undefined,
        options.pipeline,
    );
    if (configs.length === 0) {
        return Object.freeze({
            status: "current",
            processorIds: Object.freeze([]),
            diagnostics: Object.freeze([]),
        });
    }
    const configById = new Map(configs.map((config) => [config.id, config]));
    return withVerifiedWorldSnapshot(
        {
            worldName: options.worldName,
            sourceWorldDirectory: options.sourceWorldDirectory,
            signal: options.signal,
        },
        async (snapshot) => {
            const prepared = await prepareProcessedWorld(
                options,
                snapshot,
                configs,
                configById,
                options.pipeline,
            );
            let published = false;
            for (const execution of prepared.executions) {
                const config = configById.get(execution.processorId)!;
                if (
                    !config.capabilities.includes("artifact") ||
                    execution.result.artifacts.length === 0
                ) {
                    continue;
                }
                const artifact = await publishWorldProcessorArtifactSet({
                    projectRoot: options.projectRoot,
                    config,
                    execution,
                    mode: options.mode,
                    isCurrent: options.isCurrent,
                });
                if (artifact.status === "stale") {
                    return output("stale");
                }
                if (artifact.status === "published") published = true;
                if (
                    options.mode === "bake" &&
                    options.audit &&
                    config.auditOutputPath
                ) {
                    await writeAudit(options.projectRoot, config, execution);
                    published = true;
                }
            }
            return output(published ? "published" : "current");

            function output(
                status: WorldProcessorArtifactPipelineResult["status"],
            ): WorldProcessorArtifactPipelineResult {
                return Object.freeze({
                    status,
                    processorIds: Object.freeze(
                        prepared.executions.map(
                            (execution) => execution.processorId,
                        ),
                    ),
                    diagnostics: prepared.diagnostics,
                });
            }
        },
    );
}

async function prepareProcessedWorld(
    options: BuildProcessedWorldOptions,
    snapshot: VerifiedWorldSnapshot,
    configs: readonly ResolvedWorldProcessorConfig[],
    configById: ReadonlyMap<string, ResolvedWorldProcessorConfig>,
    pipeline: WorldProcessorPipelineIntent,
): Promise<PreparedBuild> {
    let executions: readonly WorldProcessorExecutionResult[] = [];
    let mutations: readonly PrimitiveWorldMutation[] = [];
    await withBedrockWorldObservations(
        { dbPath: snapshot.dbPath, signal: options.signal },
        async (observations) => {
            executions = await runWorldProcessorGraph({
                projectRoot: options.projectRoot,
                configs,
                sourceIdentity: snapshot.sourceIdentity,
                observations,
                pipeline,
                mode: options.mode,
                signal: options.signal,
                cacheRoot: path.join(options.projectRoot, ".blr", "cache"),
            });
            validateCapabilities(executions, configById);
            mutations = await normalizeWorldMutationPlans(
                executions
                    .filter((execution) =>
                        configById
                            .get(execution.processorId)!
                            .capabilities.includes("transform"),
                    )
                    .map((execution) => ({
                        processorId: execution.processorId,
                        mutations: execution.result.mutations,
                    })),
                observations,
            );
        },
    );
    const diagnostics = Object.freeze(
        executions.flatMap((execution) => execution.result.diagnostics),
    );
    const errors = diagnostics.filter(
        (diagnostic) => diagnostic.severity === "error",
    );
    if (errors.length > 0) {
        throw new Error(
            `World processors reported ${errors.length} error diagnostic(s): ${errors
                .map((diagnostic) => diagnostic.message)
                .join("; ")}`,
        );
    }
    const mutationPlanHash = hashCanonicalJson({
        schemaVersion: 1,
        mutations,
    });
    if (mutations.length > 0 && options.verifyMutations !== false) {
        await applyBedrockWorldMutations({
            dbPath: snapshot.dbPath,
            mutations,
        });
    }
    const worldContentHash = await hashLogicalWorld(snapshot.worldDirectory);
    const artifactChecks: PublishedWorldProcessorArtifactSet[] = [];
    const artifactBindings: ArtifactBinding[] = [];
    for (const execution of executions) {
        const config = configById.get(execution.processorId)!;
        if (
            !config.capabilities.includes("artifact") ||
            execution.result.artifacts.length === 0
        ) {
            continue;
        }
        const checked = await publishWorldProcessorArtifactSet({
            projectRoot: options.projectRoot,
            config,
            execution,
            mode: "check",
        });
        artifactChecks.push(checked);
        artifactBindings.push(
            Object.freeze({
                processorId: execution.processorId,
                artifactSetId: checked.artifactSetId,
                manifestContentHash: checked.manifestContentHash,
            }),
        );
    }
    const logicalManifest: ProcessedWorldLogicalManifest = Object.freeze({
        schemaVersion: 1,
        worldName: options.worldName,
        pipeline,
        sourceIdentity: snapshot.sourceIdentity,
        worldContentHash,
        mutationPlanHash,
        processors: Object.freeze(
            executions.map((execution) =>
                Object.freeze({
                    id: execution.processorId,
                    providerRevision: execution.providerRevision,
                    logicalInputHash: execution.logicalInputHash,
                }),
            ),
        ),
        artifacts: Object.freeze(artifactBindings),
    });
    return Object.freeze({
        snapshot,
        executions,
        mutations,
        mutationPlanHash,
        worldContentHash,
        logicalManifest,
        worldBuildId: hashCanonicalJson(logicalManifest),
        artifactChecks: Object.freeze(artifactChecks),
        diagnostics,
    });
}

function validateCapabilities(
    executions: readonly WorldProcessorExecutionResult[],
    configById: ReadonlyMap<string, ResolvedWorldProcessorConfig>,
): void {
    for (const execution of executions) {
        const config = configById.get(execution.processorId)!;
        if (
            execution.result.artifacts.length > 0 &&
            !config.capabilities.includes("artifact")
        ) {
            throw new Error(
                `World processor ${config.id} emitted artifacts without the artifact capability.`,
            );
        }
        if (
            execution.result.mutations.length > 0 &&
            !config.capabilities.includes("transform")
        ) {
            throw new Error(
                `World processor ${config.id} emitted mutations without the transform capability.`,
            );
        }
    }
}

function selectProcessorConfigs(
    allConfigs: readonly ResolvedWorldProcessorConfig[],
    worldName: string,
    processorIds: readonly string[] | undefined,
    pipeline: WorldProcessorPipelineIntent,
): readonly ResolvedWorldProcessorConfig[] {
    const eligible = allConfigs.filter(
        (config) =>
            config.sourceWorld === worldName && appliesOn(config, pipeline),
    );
    if (!processorIds || processorIds.length === 0)
        return Object.freeze(eligible);
    const byId = new Map(eligible.map((config) => [config.id, config]));
    const selected = new Set<string>();
    const visit = (id: string): void => {
        const config = byId.get(id);
        if (!config) throw new Error(`Unknown world processor ${id}.`);
        if (selected.has(id)) return;
        selected.add(id);
        for (const dependency of config.dependsOn) visit(dependency);
    };
    for (const id of processorIds) visit(id);
    return Object.freeze(eligible.filter((config) => selected.has(config.id)));
}

function appliesOn(
    config: ResolvedWorldProcessorConfig,
    pipeline: WorldProcessorPipelineIntent,
): boolean {
    switch (pipeline) {
        case "dev":
            return config.applyOn.dev;
        case "build":
            return config.applyOn.build;
        case "package":
            return config.applyOn.package;
        case "check":
            return config.applyOn.check;
        case "world-build":
            return config.applyOn.worldBuild;
        case "world-push":
            return config.applyOn.worldPush;
    }
}

async function publishProcessedSet(
    sourceWorldDirectory: string,
    setDirectory: string,
    logicalManifest: ProcessedWorldLogicalManifest,
    worldBuildId: string,
    options: BuildProcessedWorldOptions,
): Promise<void> {
    const parent = path.dirname(setDirectory);
    await mkdir(parent, { recursive: true });
    const staging = path.join(parent, `.${worldBuildId}.${randomUUID()}.tmp`);
    try {
        await cp(sourceWorldDirectory, path.join(staging, "world"), {
            recursive: true,
            errorOnExist: true,
            force: false,
        });
        const worldFiles = await inventoryFiles(path.join(staging, "world"));
        const manifest: ProcessedWorldManifestV1 = Object.freeze({
            ...logicalManifest,
            worldBuildId,
            worldFiles,
        });
        await writeFile(
            path.join(staging, "manifest.json"),
            canonicalJson(manifest),
            { flag: "wx" },
        );
        if (options.isCurrent && !options.isCurrent()) {
            throw new Error(
                "Processed world build was superseded before publication.",
            );
        }
        await rename(staging, setDirectory);
    } finally {
        await rm(staging, { recursive: true, force: true });
    }
}

async function processedSetIsCurrent(
    setDirectory: string,
    logicalManifest: ProcessedWorldLogicalManifest,
    worldBuildId: string,
): Promise<boolean> {
    let parsed: ProcessedWorldManifestV1;
    try {
        parsed = JSON.parse(
            await readFile(path.join(setDirectory, "manifest.json"), "utf8"),
        ) as ProcessedWorldManifestV1;
    } catch {
        return false;
    }
    const {
        worldFiles,
        worldBuildId: parsedBuildId,
        ...parsedLogical
    } = parsed;
    if (
        parsedBuildId !== worldBuildId ||
        canonicalJson(parsedLogical) !== canonicalJson(logicalManifest) ||
        !Array.isArray(worldFiles)
    ) {
        return false;
    }
    const actual = await inventoryFiles(path.join(setDirectory, "world")).catch(
        () => undefined,
    );
    return !!actual && canonicalJson(actual) === canonicalJson(worldFiles);
}

async function hashLogicalWorld(worldDirectory: string): Promise<string> {
    const hash = createHash("sha256");
    for (const entry of await inventoryFiles(worldDirectory, "db")) {
        hash.update(entry.path).update("\0");
        hash.update(String(entry.size)).update("\0");
        hash.update(entry.contentHash).update("\n");
    }
    const db = new LevelDB(path.join(worldDirectory, "db"), {
        createIfMissing: false,
        bufferKeys: true,
    });
    await db.open();
    try {
        for await (const [rawKey, rawValue] of db.getIterator({
            keys: true,
            values: true,
            keyAsBuffer: true,
            valueAsBuffer: true,
        })) {
            const key = Buffer.from(rawKey as Uint8Array);
            const value = Buffer.from(rawValue as Uint8Array);
            const sizes = Buffer.alloc(8);
            sizes.writeUInt32LE(key.length, 0);
            sizes.writeUInt32LE(value.length, 4);
            hash.update(sizes).update(key).update(value);
        }
    } finally {
        await db.close();
    }
    return hash.digest("hex");
}

async function inventoryFiles(
    root: string,
    excludedTopLevel?: string,
): Promise<readonly WorldFileInventoryEntry[]> {
    const result: WorldFileInventoryEntry[] = [];
    await visit("");
    return Object.freeze(
        result.sort((left, right) => left.path.localeCompare(right.path)),
    );

    async function visit(relativeDirectory: string): Promise<void> {
        const entries = await readdir(path.join(root, relativeDirectory), {
            withFileTypes: true,
        });
        entries.sort((left, right) => left.name.localeCompare(right.name));
        for (const entry of entries) {
            const relativePath = path
                .join(relativeDirectory, entry.name)
                .replace(/\\/g, "/");
            if (!relativeDirectory && entry.name === excludedTopLevel) continue;
            if (entry.isDirectory()) {
                await visit(relativePath);
            } else if (entry.isFile()) {
                const absolutePath = path.join(root, relativePath);
                const details = await stat(absolutePath);
                result.push(
                    Object.freeze({
                        path: relativePath,
                        size: details.size,
                        contentHash: await hashFile(absolutePath),
                    }),
                );
            } else {
                throw new Error(
                    `Processed world contains unsupported entry ${relativePath}.`,
                );
            }
        }
    }
}

async function hashFile(filePath: string): Promise<string> {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(filePath)) hash.update(chunk);
    return hash.digest("hex");
}

async function writeAudit(
    projectRoot: string,
    config: ResolvedWorldProcessorConfig,
    execution: WorldProcessorExecutionResult,
): Promise<void> {
    const target = path.resolve(projectRoot, config.auditOutputPath!);
    await mkdir(path.dirname(target), { recursive: true });
    await replaceFileAtomically(
        target,
        canonicalJson({
            schemaVersion: 1,
            processorId: execution.processorId,
            providerRevision: execution.providerRevision,
            logicalInputHash: execution.logicalInputHash,
            diagnostics: execution.result.diagnostics,
            ...(execution.result.audit === undefined
                ? {}
                : { audit: execution.result.audit }),
        }),
    );
}

async function replaceFileAtomically(
    target: string,
    contents: string,
): Promise<void> {
    await mkdir(path.dirname(target), { recursive: true });
    const temporary = path.join(
        path.dirname(target),
        `.${path.basename(target)}.${randomUUID()}.tmp`,
    );
    try {
        await writeFile(temporary, contents, { flag: "wx" });
        await rename(temporary, target);
    } finally {
        await rm(temporary, { force: true });
    }
}

async function copyExplicitOutput(
    source: string,
    outputDirectory: string,
): Promise<void> {
    if (await exists(outputDirectory)) {
        throw new Error(
            `Explicit processed-world output already exists: ${outputDirectory}.`,
        );
    }
    const parent = path.dirname(outputDirectory);
    await mkdir(parent, { recursive: true });
    const staging = path.join(
        parent,
        `.${path.basename(outputDirectory)}.${randomUUID()}.tmp`,
    );
    try {
        await cp(source, staging, {
            recursive: true,
            errorOnExist: true,
            force: false,
        });
        await rename(staging, outputDirectory);
    } finally {
        await rm(staging, { recursive: true, force: true });
    }
}

function assertOutputDoesNotOverlapSource(
    sourceWorldDirectory: string,
    outputDirectory: string | undefined,
): void {
    if (!outputDirectory) return;
    const source = path.resolve(sourceWorldDirectory);
    const output = path.resolve(outputDirectory);
    const sourceToOutput = path.relative(source, output);
    const outputToSource = path.relative(output, source);
    if (
        source === output ||
        (!sourceToOutput.startsWith("..") &&
            !path.isAbsolute(sourceToOutput)) ||
        (!outputToSource.startsWith("..") && !path.isAbsolute(outputToSource))
    ) {
        throw new Error(
            "Processed-world output must not overlap the authored source world.",
        );
    }
}

async function fileEquals(target: string, contents: string): Promise<boolean> {
    try {
        return (await readFile(target, "utf8")) === contents;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
    }
}

async function exists(target: string): Promise<boolean> {
    return !!(await stat(target).catch(() => undefined));
}

function throwIfAborted(signal: AbortSignal): void {
    if (signal.aborted) {
        throw signal.reason instanceof Error
            ? signal.reason
            : new DOMException(
                  "Processed world build was aborted.",
                  "AbortError",
              );
    }
}
