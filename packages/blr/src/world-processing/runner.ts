import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
    ResolvedWorldProcessorConfig,
    WorldObservationFacade,
    WorldProcessorInputFile,
    WorldProcessorMaterializedLogicalInput,
    WorldProcessorMode,
    WorldProcessorPipelineIntent,
    WorldProcessorResult,
    WorldSourceIdentity,
} from "../world-processing.js";
import {
    canonicalJson,
    hashCanonicalJson,
    normalizeJson,
} from "./canonical-json.js";
import { loadWorldProcessorProvider } from "./provider-loader.js";

const WORLD_PROCESSOR_SCHEMA_REVISION = "world-processing-runner-v1";

export type RunWorldProcessorGraphOptions = {
    readonly projectRoot: string;
    readonly configs: readonly ResolvedWorldProcessorConfig[];
    readonly sourceIdentity: WorldSourceIdentity;
    readonly observations: WorldObservationFacade;
    readonly pipeline: WorldProcessorPipelineIntent;
    readonly mode: WorldProcessorMode;
    readonly signal: AbortSignal;
    readonly cacheRoot: string;
};

export type WorldProcessorExecutionResult = {
    readonly processorId: string;
    readonly providerRevision: string;
    readonly logicalInputHash: string;
    readonly cacheHit: boolean;
    readonly result: WorldProcessorResult;
};

export async function runWorldProcessorGraph(
    options: RunWorldProcessorGraphOptions,
): Promise<readonly WorldProcessorExecutionResult[]> {
    throwIfAborted(options.signal);
    const ordered = orderProcessorConfigs(options.configs);
    const completed = new Map<string, WorldProcessorExecutionResult>();
    const results: WorldProcessorExecutionResult[] = [];

    for (const config of ordered) {
        throwIfAborted(options.signal);
        if (!appliesTo(config, options.pipeline)) continue;
        if (config.sourceWorld !== options.sourceIdentity.worldName) {
            throw new Error(
                `World processor ${config.id} selects ${config.sourceWorld}, but the graph snapshot is ${options.sourceIdentity.worldName}.`,
            );
        }
        const loaded = await loadWorldProcessorProvider({
            projectRoot: options.projectRoot,
            module: config.module,
            exportName: config.export,
        });
        const dependencies = Object.freeze(
            Object.fromEntries(
                [...config.dependsOn]
                    .sort()
                    .map((id) => [id, completed.get(id)?.result]),
            ),
        ) as Readonly<Record<string, WorldProcessorResult>>;
        for (const dependency of config.dependsOn) {
            if (!dependencies[dependency]) {
                throw new Error(
                    `World processor ${config.id} dependency ${dependency} did not execute for ${options.pipeline}.`,
                );
            }
        }
        const prepared = await prepareLogicalInputs({
            projectRoot: options.projectRoot,
            config,
            sourceIdentity: options.sourceIdentity,
            bundleHash: loaded.providerContentHash,
            implementationRevision: loaded.processor.implementationRevision,
            declarations: loaded.processor.logicalInputs,
            dependencies,
        });
        const logicalInputHash = hashCanonicalJson(prepared.logicalInputs);
        const cachePath = path.join(
            options.cacheRoot,
            "world-processing",
            config.id,
            `${logicalInputHash}.json`,
        );
        const cached = await readCache(cachePath, logicalInputHash);
        let result: WorldProcessorResult;
        let cacheHit = false;
        if (cached) {
            result = cached;
            cacheHit = true;
        } else {
            throwIfAborted(options.signal);
            const rawResult = await loaded.processor.run({
                config,
                sourceIdentity: options.sourceIdentity,
                observations: options.observations,
                inputFiles: prepared.inputFiles,
                logicalInputs: prepared.logicalInputs,
                dependencies,
                signal: options.signal,
            });
            result = normalizeProcessorResult(rawResult, config.id);
            if (
                canonicalJson(result.logicalInputs) !==
                canonicalJson(prepared.logicalInputs)
            ) {
                throw new Error(
                    `World processor ${config.id} result logicalInputs must exactly echo the materialized input list.`,
                );
            }
            if (options.mode === "bake") {
                await writeCache(cachePath, logicalInputHash, result);
            }
        }
        const execution = Object.freeze({
            processorId: config.id,
            providerRevision: loaded.processor.implementationRevision,
            logicalInputHash,
            cacheHit,
            result,
        });
        completed.set(config.id, execution);
        results.push(execution);
    }
    return Object.freeze(results);
}

type PreparedInputs = {
    readonly logicalInputs: readonly WorldProcessorMaterializedLogicalInput[];
    readonly inputFiles: readonly WorldProcessorInputFile[];
};

async function prepareLogicalInputs(input: {
    readonly projectRoot: string;
    readonly config: ResolvedWorldProcessorConfig;
    readonly sourceIdentity: WorldSourceIdentity;
    readonly bundleHash: string;
    readonly implementationRevision: string;
    readonly declarations: readonly import("../world-processing.js").WorldProcessorDeclaredLogicalInput[];
    readonly dependencies: Readonly<Record<string, WorldProcessorResult>>;
}): Promise<PreparedInputs> {
    const logicalInputs: WorldProcessorMaterializedLogicalInput[] = [
        {
            id: "blr:world",
            kind: "world",
            contentHash: input.sourceIdentity.contentHash,
        },
        {
            id: "blr:provider",
            kind: "provider",
            contentHash: input.bundleHash,
        },
        {
            id: "blr:provider-revision",
            kind: "provider",
            contentHash: hashCanonicalJson(input.implementationRevision),
        },
        {
            id: "blr:config",
            kind: "value",
            contentHash: hashCanonicalJson(input.config),
        },
        {
            id: "blr:schema",
            kind: "schema",
            contentHash: hashCanonicalJson(WORLD_PROCESSOR_SCHEMA_REVISION),
        },
    ];
    for (const dependency of Object.keys(input.dependencies).sort()) {
        logicalInputs.push({
            id: `blr:dependency:${dependency}`,
            kind: "value",
            contentHash: hashCanonicalJson(input.dependencies[dependency]),
        });
    }

    const configuredPaths = new Set(input.config.inputPaths);
    const declaredPaths = new Set<string>();
    const inputFiles: WorldProcessorInputFile[] = [];
    for (const declaration of input.declarations) {
        if (declaration.id.startsWith("blr:")) {
            throw new Error(
                `World processor ${input.config.id} logical input ${declaration.id} uses the reserved blr: prefix.`,
            );
        }
        if (declaration.kind === "value") {
            logicalInputs.push({
                id: declaration.id,
                kind: "value",
                contentHash: hashCanonicalJson(declaration.value),
            });
            continue;
        }
        if (!configuredPaths.has(declaration.path)) {
            throw new Error(
                `World processor ${input.config.id} declares file ${declaration.path}, but it is not listed in inputPaths.`,
            );
        }
        if (declaredPaths.has(declaration.path)) {
            throw new Error(
                `World processor ${input.config.id} declares file ${declaration.path} more than once.`,
            );
        }
        declaredPaths.add(declaration.path);
        const absolutePath = path.resolve(input.projectRoot, declaration.path);
        const bytes = await readFile(absolutePath);
        const contentHash = sha256(bytes);
        logicalInputs.push({
            id: declaration.id,
            kind: "file",
            contentHash,
        });
        inputFiles.push(
            Object.freeze({
                id: declaration.id,
                relativePath: declaration.path,
                contentHash,
                size: bytes.byteLength,
                read: async () => new Uint8Array(bytes),
            }),
        );
    }
    for (const configuredPath of configuredPaths) {
        if (!declaredPaths.has(configuredPath)) {
            throw new Error(
                `World processor ${input.config.id} inputPaths includes ${configuredPath}, but the provider does not declare it as a logical input.`,
            );
        }
    }
    logicalInputs.sort((left, right) => left.id.localeCompare(right.id));
    return Object.freeze({
        logicalInputs: Object.freeze(
            logicalInputs.map((entry) => Object.freeze(entry)),
        ),
        inputFiles: Object.freeze(inputFiles),
    });
}

function normalizeProcessorResult(
    input: unknown,
    processorId: string,
): WorldProcessorResult {
    const normalized = normalizeJson(
        input,
        `world processor ${processorId} result`,
    );
    if (
        !normalized ||
        Array.isArray(normalized) ||
        typeof normalized !== "object"
    ) {
        throw new Error(
            `World processor ${processorId} result must be an object.`,
        );
    }
    const result = normalized as Record<string, unknown>;
    for (const field of [
        "logicalInputs",
        "artifacts",
        "diagnostics",
        "mutations",
    ]) {
        if (!Array.isArray(result[field])) {
            throw new Error(
                `World processor ${processorId} result.${field} must be an array.`,
            );
        }
    }
    return normalized as unknown as WorldProcessorResult;
}

async function readCache(
    cachePath: string,
    logicalInputHash: string,
): Promise<WorldProcessorResult | undefined> {
    let raw: string;
    try {
        raw = await readFile(cachePath, "utf8");
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT")
            return undefined;
        throw error;
    }
    try {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        if (
            parsed.schemaVersion !== 1 ||
            parsed.logicalInputHash !== logicalInputHash ||
            typeof parsed.resultHash !== "string"
        ) {
            return undefined;
        }
        const result = normalizeProcessorResult(parsed.result, "cached");
        if (hashCanonicalJson(result) !== parsed.resultHash) return undefined;
        return result;
    } catch {
        return undefined;
    }
}

async function writeCache(
    cachePath: string,
    logicalInputHash: string,
    result: WorldProcessorResult,
): Promise<void> {
    const directory = path.dirname(cachePath);
    await mkdir(directory, { recursive: true });
    const temporaryPath = path.join(
        directory,
        `.${path.basename(cachePath)}.${randomUUID()}.tmp`,
    );
    const contents = canonicalJson({
        schemaVersion: 1,
        logicalInputHash,
        resultHash: hashCanonicalJson(result),
        result,
    });
    try {
        await writeFile(temporaryPath, contents, { flag: "wx" });
        await rename(temporaryPath, cachePath);
    } finally {
        await rm(temporaryPath, { force: true });
    }
}

function orderProcessorConfigs(
    configs: readonly ResolvedWorldProcessorConfig[],
): readonly ResolvedWorldProcessorConfig[] {
    const byId = new Map(configs.map((config) => [config.id, config]));
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const result: ResolvedWorldProcessorConfig[] = [];
    const visit = (id: string): void => {
        if (visited.has(id)) return;
        if (visiting.has(id)) {
            throw new Error(`World processor dependency cycle includes ${id}.`);
        }
        const config = byId.get(id);
        if (!config)
            throw new Error(`Unknown world processor dependency ${id}.`);
        visiting.add(id);
        for (const dependency of [...config.dependsOn].sort())
            visit(dependency);
        visiting.delete(id);
        visited.add(id);
        result.push(config);
    };
    for (const id of [...byId.keys()].sort()) visit(id);
    return Object.freeze(result);
}

function appliesTo(
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

function sha256(input: Uint8Array): string {
    return createHash("sha256").update(input).digest("hex");
}

function throwIfAborted(signal: AbortSignal): void {
    if (signal.aborted) {
        throw signal.reason instanceof Error
            ? signal.reason
            : new DOMException(
                  "World processor run was aborted.",
                  "AbortError",
              );
    }
}
