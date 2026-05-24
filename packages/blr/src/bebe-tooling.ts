import { copyFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { DebugLogger } from "./debug.js";
import {
    ensureDirectory,
    exists,
    readJson,
    readText,
    removePath,
    writeText,
    writeJson,
} from "./fs.js";

export type BebePipelineIntent = "dev" | "build" | "package" | "check";

type ProjectPackageJson = {
    dependencies?: Record<string, unknown>;
    devDependencies?: Record<string, unknown>;
    optionalDependencies?: Record<string, unknown>;
    peerDependencies?: Record<string, unknown>;
};

type BebeToolingDiagnostic = {
    readonly code?: unknown;
    readonly category?: unknown;
    readonly message?: unknown;
    readonly severity?: unknown;
    readonly sourcePath?: unknown;
};

type BebeToolingDiagnosticSeverity = "ignore" | "warn" | "error";

type BebeAssetCompilerResult = {
    readonly output?: unknown;
    readonly diagnostics?: readonly BebeToolingDiagnostic[];
};

type BebeAssetCompiler = {
    readonly id: string;
    readonly sourcePaths: readonly string[];
    readonly outputPath: string;
    compile(input: {
        readonly pipeline: BebePipelineIntent;
        readonly projectRoot: string;
        readonly sourceJson: unknown;
        readonly sourcePath: string;
        diagnosticSeverity?(
            category: string,
        ): BebeToolingDiagnosticSeverity | undefined;
    }): BebeAssetCompilerResult;
    renderBootstrap?(input: {
        readonly outputImportSpecifier: string;
        readonly outputPath: string;
    }): readonly string[];
};

type BebeTooling = {
    readonly assetCompilers: readonly BebeAssetCompiler[];
};

type BebeToolingModule = {
    createBebeTooling?: () => BebeTooling;
    normalizeZonePack?: (
        input: unknown,
        options?: { readonly source?: string },
    ) => unknown;
    PROJECT_ZONES_FILE?: unknown;
    ZONE_DRAFT_SAVE_EVENT?: unknown;
};

type BakedBebeAsset = {
    readonly compilerId: string;
    readonly outputPath: string;
    readonly sourcePath: string;
};

export type BakedBebeAssets = {
    readonly bootstrapLines: readonly string[];
    readonly outputs: readonly BakedBebeAsset[];
};

export type BakeBebeAssetsOptions = {
    readonly debug?: DebugLogger;
    readonly distRoot: string;
    readonly hasRuntimeEntry: boolean;
    readonly pipeline: BebePipelineIntent;
    readonly projectRoot: string;
    readonly resolveDiagnosticSeverity?: (
        category: string,
    ) => BebeToolingDiagnosticSeverity | undefined;
    readonly stageScriptsDirectories: readonly string[];
};

export type SaveBebeZoneDraftResult = {
    readonly changed: boolean;
    readonly sourcePath: string;
    readonly zoneCount: number;
};

export type BebeLinkEventHandlerInput = {
    readonly kind: string;
    readonly data?: unknown;
};

export type BebeLinkEventHandlerContext = {
    readonly key: string;
    readonly ns: string;
};

export type BebeLinkEventHandlerOptions = {
    readonly eventKind?: string;
    readonly log?: (message: string) => void;
    readonly projectRoot: string;
    readonly warn?: (message: string) => void;
};

const BEBE_PACKAGE_NAME = "@blurengine/bebe";
const BEBE_TOOLING_NODE_SUBPATH = "@blurengine/bebe/tooling/node";
const KNOWN_BEBE_ASSET_SOURCE_PATHS = ["zones.json"];
const LEGACY_ZONE_OUTPUT_PATHS = [path.posix.join("generated", "zones.json")];
const DEFAULT_ZONE_DRAFT_SAVE_EVENT = "bebe.zones.saveDraft";

export function toProjectImportSpecifier(
    projectRoot: string,
    targetPath: string,
): string {
    const relativePath = path
        .relative(projectRoot, targetPath)
        .replace(/\\/g, "/");
    return relativePath.startsWith(".") ? relativePath : `./${relativePath}`;
}

export async function resolveBebeAssetSourcePaths(
    projectRoot: string,
): Promise<string[]> {
    const toolingModulePath =
        await resolveProjectBebeToolingModulePath(projectRoot);
    if (!toolingModulePath) {
        const existingKnownSources: string[] = [];
        for (const sourcePath of KNOWN_BEBE_ASSET_SOURCE_PATHS) {
            if (await exists(path.resolve(projectRoot, sourcePath))) {
                existingKnownSources.push(sourcePath);
            }
        }

        return existingKnownSources;
    }

    const tooling = await loadBebeTooling(toolingModulePath);
    const sourcePaths = new Set<string>();
    for (const compiler of tooling.assetCompilers) {
        for (const sourcePath of compiler.sourcePaths) {
            sourcePaths.add(
                normalizeAssetRelativePath(
                    sourcePath,
                    `${compiler.id}.sourcePaths`,
                ),
            );
        }
    }

    return [...sourcePaths];
}

export async function bakeBebeAssets(
    options: BakeBebeAssetsOptions,
): Promise<BakedBebeAssets> {
    const toolingModulePath = await resolveProjectBebeToolingModulePath(
        options.projectRoot,
    );
    if (!toolingModulePath) {
        await assertNoKnownBebeAssetSourcesWithoutTooling(options.projectRoot);
        return {
            bootstrapLines: [],
            outputs: [],
        };
    }

    const tooling = await loadBebeTooling(toolingModulePath);
    const bootstrapLines: string[] = [];
    const outputs: BakedBebeAsset[] = [];

    for (const compiler of tooling.assetCompilers) {
        const outputPath = normalizeAssetRelativePath(
            compiler.outputPath,
            `${compiler.id}.outputPath`,
        );
        const outputAbsolutePath = path.resolve(options.distRoot, outputPath);
        const source = await findFirstExistingSource(
            options.projectRoot,
            compiler.sourcePaths,
        );

        if (!source) {
            await removeBakedAssetOutput(
                outputAbsolutePath,
                outputPath,
                options.stageScriptsDirectories,
            );
            continue;
        }

        if (compiler.renderBootstrap && !options.hasRuntimeEntry) {
            throw new Error(
                `${source.relativePath} requires a runtime entry so @blurengine/bebe can load baked assets.`,
            );
        }

        const sourceJson = await readJson<unknown>(source.absolutePath);
        const result = compileBebeAsset(compiler, {
            pipeline: options.pipeline,
            projectRoot: options.projectRoot,
            sourceJson,
            sourcePath: source.absolutePath,
            diagnosticSeverity: options.resolveDiagnosticSeverity,
        });
        emitBebeToolingDiagnostics(result.diagnostics, {
            compilerId: compiler.id,
            pipeline: options.pipeline,
            resolveDiagnosticSeverity: options.resolveDiagnosticSeverity,
            sourcePath: source.relativePath,
        });

        if (!Object.hasOwn(result, "output")) {
            await removeBakedAssetOutput(
                outputAbsolutePath,
                outputPath,
                options.stageScriptsDirectories,
            );
            continue;
        }

        await writeJson(outputAbsolutePath, result.output);
        await syncBakedAssetIntoStage(
            outputAbsolutePath,
            outputPath,
            options.stageScriptsDirectories,
        );
        await removeLegacyZoneOutputs(
            options.distRoot,
            options.stageScriptsDirectories,
        );

        outputs.push({
            compilerId: compiler.id,
            outputPath: outputAbsolutePath,
            sourcePath: source.absolutePath,
        });
        if (compiler.renderBootstrap) {
            bootstrapLines.push(
                ...compiler.renderBootstrap({
                    outputImportSpecifier: toProjectImportSpecifier(
                        options.projectRoot,
                        outputAbsolutePath,
                    ),
                    outputPath,
                }),
            );
        }

        options.debug?.log("build", "baked Bebe asset", {
            compilerId: compiler.id,
            sourcePath: source.relativePath,
            outputPath,
        });
    }

    return {
        bootstrapLines,
        outputs,
    };
}

export function createBebeLinkEventHandler(
    options: BebeLinkEventHandlerOptions,
): (
    event: BebeLinkEventHandlerInput,
    context: BebeLinkEventHandlerContext,
) => Promise<void> {
    const eventKind = options.eventKind ?? DEFAULT_ZONE_DRAFT_SAVE_EVENT;
    return async (event) => {
        if (event.kind !== eventKind) {
            return;
        }

        try {
            const result = await saveBebeZoneDraft(
                options.projectRoot,
                event.data,
            );
            const relativePath = path
                .relative(options.projectRoot, result.sourcePath)
                .replace(/\\/g, "/");
            options.log?.(
                `[dev] ${relativePath} ${
                    result.changed ? "saved" : "unchanged"
                } from Bebe Link.`,
            );
        } catch (error) {
            const message =
                error instanceof Error ? error.message : String(error);
            const warn = options.warn ?? options.log;
            warn?.(
                `[dev] Warning: Bebe Link could not save zones.json (${message}).`,
            );
        }
    };
}

export async function saveBebeZoneDraft(
    projectRoot: string,
    payload: unknown,
): Promise<SaveBebeZoneDraftResult> {
    const toolingModulePath =
        await resolveProjectBebeToolingModulePath(projectRoot);
    if (!toolingModulePath) {
        throw new Error(
            `Bebe zone draft saves require ${BEBE_TOOLING_NODE_SUBPATH}. Update @blurengine/bebe so blr can validate zone source through the project-installed tooling surface.`,
        );
    }

    const module = await loadBebeToolingModule(toolingModulePath);
    if (typeof module.normalizeZonePack !== "function") {
        throw new Error(
            `${BEBE_TOOLING_NODE_SUBPATH} must export normalizeZonePack() for zone draft saves.`,
        );
    }

    const sourcePath = normalizeAssetRelativePath(
        typeof module.PROJECT_ZONES_FILE === "string"
            ? module.PROJECT_ZONES_FILE
            : KNOWN_BEBE_ASSET_SOURCE_PATHS[0],
        "PROJECT_ZONES_FILE",
    );
    const normalized = normalizeBebeZonePack(
        module.normalizeZonePack(extractZoneDraftPack(payload), {
            source: sourcePath,
        }),
    );
    const sourcePack = createZoneSourcePack(normalized);
    const targetPath = path.resolve(projectRoot, sourcePath);
    const rendered = `${JSON.stringify(sourcePack, null, 2)}\n`;
    const current = (await exists(targetPath))
        ? await readText(targetPath)
        : undefined;

    if (current === rendered) {
        return {
            changed: false,
            sourcePath: targetPath,
            zoneCount: normalized.zones.length,
        };
    }

    await writeText(targetPath, rendered);

    return {
        changed: true,
        sourcePath: targetPath,
        zoneCount: normalized.zones.length,
    };
}

async function resolveProjectBebeToolingModulePath(
    projectRoot: string,
): Promise<string | undefined> {
    const packageJsonPath = path.join(projectRoot, "package.json");
    if (!(await exists(packageJsonPath))) {
        return undefined;
    }

    const packageJson = await readJson<ProjectPackageJson>(packageJsonPath);
    if (!declaresBebe(packageJson)) {
        return undefined;
    }

    try {
        return createRequire(packageJsonPath).resolve(
            BEBE_TOOLING_NODE_SUBPATH,
        );
    } catch {
        return undefined;
    }
}

function declaresBebe(packageJson: ProjectPackageJson): boolean {
    return [
        packageJson.dependencies,
        packageJson.devDependencies,
        packageJson.optionalDependencies,
        packageJson.peerDependencies,
    ].some((dependencies) =>
        Boolean(dependencies && BEBE_PACKAGE_NAME in dependencies),
    );
}

async function assertNoKnownBebeAssetSourcesWithoutTooling(
    projectRoot: string,
): Promise<void> {
    for (const sourcePath of KNOWN_BEBE_ASSET_SOURCE_PATHS) {
        if (await exists(path.resolve(projectRoot, sourcePath))) {
            throw new Error(
                `${sourcePath} requires ${BEBE_TOOLING_NODE_SUBPATH}. Update @blurengine/bebe so blr can bake Bebe assets through the project-installed tooling surface.`,
            );
        }
    }
}

async function loadBebeTooling(modulePath: string): Promise<BebeTooling> {
    const module = await loadBebeToolingModule(modulePath);
    const tooling = module.createBebeTooling?.();
    if (!tooling || !Array.isArray(tooling.assetCompilers)) {
        throw new Error(
            `${BEBE_TOOLING_NODE_SUBPATH} must export createBebeTooling() with an assetCompilers array.`,
        );
    }

    return tooling;
}

async function loadBebeToolingModule(
    modulePath: string,
): Promise<BebeToolingModule> {
    return (await import(pathToFileURL(modulePath).href)) as BebeToolingModule;
}

async function findFirstExistingSource(
    projectRoot: string,
    sourcePaths: readonly string[],
): Promise<
    | {
          readonly absolutePath: string;
          readonly relativePath: string;
      }
    | undefined
> {
    for (const sourcePath of sourcePaths) {
        const relativePath = normalizeAssetRelativePath(
            sourcePath,
            "sourcePath",
        );
        const absolutePath = path.resolve(projectRoot, relativePath);
        if (await exists(absolutePath)) {
            return {
                absolutePath,
                relativePath,
            };
        }
    }

    return undefined;
}

function normalizeAssetRelativePath(input: string, source: string): string {
    if (typeof input !== "string" || input.trim().length === 0) {
        throw new Error(`${source} must be a project-relative path.`);
    }
    const normalized = path.posix.normalize(input.trim().replace(/\\/g, "/"));
    if (
        normalized === "." ||
        path.posix.isAbsolute(normalized) ||
        normalized === ".." ||
        normalized.startsWith("../")
    ) {
        throw new Error(`${source} must stay inside the project.`);
    }

    return normalized;
}

type NormalizedBebeZonePack = {
    readonly zones: readonly unknown[];
    readonly scope?: unknown;
};

function extractZoneDraftPack(payload: unknown): unknown {
    if (isRecord(payload) && "pack" in payload) {
        return payload.pack;
    }

    return payload;
}

function normalizeBebeZonePack(input: unknown): NormalizedBebeZonePack {
    const record = expectRecord(input, "normalizeZonePack result");
    if (!Array.isArray(record.zones)) {
        throw new Error("normalizeZonePack result.zones must be an array.");
    }

    return {
        zones: record.zones,
        ...("scope" in record && record.scope !== undefined
            ? { scope: record.scope }
            : {}),
    };
}

function createZoneSourcePack(pack: NormalizedBebeZonePack): {
    readonly zones: readonly unknown[];
    readonly scope?: unknown;
} {
    return pack.scope === undefined
        ? { zones: pack.zones }
        : { zones: pack.zones, scope: pack.scope };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function expectRecord(value: unknown, source: string): Record<string, unknown> {
    if (!isRecord(value)) {
        throw new Error(`${source} must be an object.`);
    }

    return value;
}

function compileBebeAsset(
    compiler: BebeAssetCompiler,
    input: Parameters<BebeAssetCompiler["compile"]>[0],
): BebeAssetCompilerResult {
    try {
        return compiler.compile(input);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(
            `${path.relative(input.projectRoot, input.sourcePath)} could not be compiled by ${compiler.id}: ${message}`,
        );
    }
}

function emitBebeToolingDiagnostics(
    diagnostics: readonly BebeToolingDiagnostic[] | undefined,
    context: {
        readonly compilerId: string;
        readonly pipeline: BebePipelineIntent;
        readonly resolveDiagnosticSeverity?: (
            category: string,
        ) => BebeToolingDiagnosticSeverity | undefined;
        readonly sourcePath: string;
    },
): void {
    for (const diagnostic of diagnostics ?? []) {
        const category =
            typeof diagnostic.category === "string"
                ? diagnostic.category
                : undefined;
        const configuredSeverity = category
            ? context.resolveDiagnosticSeverity?.(category)
            : undefined;
        const diagnosticSeverity =
            diagnostic.severity === "ignore" ||
            diagnostic.severity === "warn" ||
            diagnostic.severity === "error"
                ? diagnostic.severity
                : "error";
        const severity = configuredSeverity ?? diagnosticSeverity;
        if (severity === "ignore") {
            continue;
        }

        const message =
            typeof diagnostic.message === "string"
                ? diagnostic.message
                : "Bebe tooling reported a diagnostic.";
        const code =
            typeof diagnostic.code === "string" ? ` ${diagnostic.code}` : "";
        const prefix = `[${context.pipeline}] ${context.compilerId}${code}:`;
        if (severity === "warn") {
            console.warn(`${prefix} ${message}`);
            continue;
        }

        throw new Error(`${prefix} ${message}`);
    }
}

async function syncBakedAssetIntoStage(
    sourcePath: string,
    outputPath: string,
    stageScriptsDirectories: readonly string[],
): Promise<void> {
    for (const scriptsDirectory of stageScriptsDirectories) {
        const destination = path.join(scriptsDirectory, outputPath);
        await ensureDirectory(path.dirname(destination));
        await copyFile(sourcePath, destination);
    }
}

async function removeBakedAssetOutput(
    outputAbsolutePath: string,
    outputPath: string,
    stageScriptsDirectories: readonly string[],
): Promise<void> {
    await removePath(outputAbsolutePath);
    for (const scriptsDirectory of stageScriptsDirectories) {
        await removePath(path.join(scriptsDirectory, outputPath));
    }
}

async function removeLegacyZoneOutputs(
    distRoot: string,
    stageScriptsDirectories: readonly string[],
): Promise<void> {
    for (const outputPath of LEGACY_ZONE_OUTPUT_PATHS) {
        await removePath(path.join(distRoot, outputPath));
        for (const scriptsDirectory of stageScriptsDirectories) {
            await removePath(path.join(scriptsDirectory, outputPath));
        }
    }
}
