import { copyFile, readdir, stat } from "node:fs/promises";
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
    readonly artifacts?: readonly BebeAssetCompilerArtifact[];
    readonly diagnostics?: readonly BebeToolingDiagnostic[];
};

type BebeAssetCompilerArtifact = {
    readonly target: "behaviorPack" | "resourcePack" | "scripts";
    readonly outputPath: string;
    readonly output: unknown;
};

type BebeAssetCompilerArtifactOutputPath = {
    readonly target: BebeAssetCompilerArtifact["target"];
    readonly outputPath: string;
};

type BebeAssetSourceKind = "json" | "text";
type BebeAssetSourceMode = "single" | "collection";

type BebeAssetSourceFile = {
    readonly relativePath: string;
    readonly absolutePath: string;
    readonly text: string;
};

type BebeAssetCompiler = {
    readonly id: string;
    readonly sourcePaths: readonly string[];
    readonly outputPath: string;
    readonly sourceKind?: BebeAssetSourceKind;
    readonly sourceMode?: BebeAssetSourceMode;
    readonly sourceFileExtensions?: readonly string[];
    readonly artifactOutputPaths?: readonly BebeAssetCompilerArtifactOutputPath[];
    compile(input: {
        readonly pipeline: BebePipelineIntent;
        readonly projectRoot: string;
        readonly sourceJson?: unknown;
        readonly sourceText?: string;
        readonly sourceFiles?: readonly BebeAssetSourceFile[];
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
    convertMidiToBaud?: (
        data: Uint8Array,
        options: BebeMidiToBaudOptions,
    ) => string;
    convertMidiToBaudWithDiagnostics?: (
        data: Uint8Array,
        options: BebeMidiToBaudOptions,
    ) => unknown | Promise<unknown>;
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

export type BebeAssetWatchConfig = {
    readonly sourcePaths: readonly string[];
    readonly watchPatterns: readonly string[];
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
    readonly stageBehaviorPackDirectories: readonly string[];
    readonly stageResourcePackDirectory?: string;
    readonly stageScriptsDirectories: readonly string[];
};

export type SaveBebeZoneDraftResult = {
    readonly changed: boolean;
    readonly sourcePath: string;
    readonly zoneCount: number;
};

export type BebeMidiToBaudLayerId = "right" | "inner" | "left";

export type BebeMidiToBaudProfile = "compact" | "minecraft" | "raw";

export type BebeMidiToBaudPolicyOptions = {
    readonly lowBassMinimumPitch?: number;
    readonly lowBassMinimumTickGap?: number;
    readonly maxSimultaneousNotes?: number;
    readonly maxWeightedPressure?: number;
};

export type BebeMidiToBaudOptions = {
    readonly cueId: string;
    readonly lineLength?: number;
    readonly policy?: BebeMidiToBaudPolicyOptions;
    readonly profile?: BebeMidiToBaudProfile;
    readonly soundId?: string | Partial<Record<BebeMidiToBaudLayerId, string>>;
    readonly tempo?: number;
    readonly volumes?: Partial<Record<BebeMidiToBaudLayerId, number>>;
};

export type BebeMidiToBaudDiagnostic =
    | {
          readonly kind: "mappedPart";
          readonly midiChannel: number;
          readonly noteCount: number;
          readonly program?: number;
          readonly programName?: string;
          readonly soundId: string;
          readonly voiceId: string;
      }
    | {
          readonly kind: "droppedPart";
          readonly midiChannel: number;
          readonly noteCount: number;
          readonly program?: number;
          readonly programName?: string;
          readonly reason: "unsupportedProgram" | "unsupportedPercussion";
      }
    | {
          readonly kind: "optimizedPlayback";
          readonly noteCount: number;
          readonly profile: BebeMidiToBaudProfile;
          readonly reason:
              | "duplicateNote"
              | "lowBassDensity"
              | "pressureBudget"
              | "simultaneousBudget";
      };

export type BebeMidiToBaudConversion = {
    readonly baud: string;
    readonly diagnostics: readonly BebeMidiToBaudDiagnostic[];
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
const KNOWN_BEBE_ASSET_SOURCE_PATHS = [
    "zones.json",
    "render-anchors.json",
    "audio",
];
const DISALLOWED_BEBE_ASSET_SOURCE_PATHS = [
    {
        path: "audio.baud",
        message: "audio.baud is not supported; put BAUD files under audio/.",
    },
];
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
        return resolveExistingKnownBebeAssetSourcePaths(projectRoot);
    }

    const tooling = await loadBebeTooling(toolingModulePath);
    return [...resolveBebeAssetWatchConfigFromTooling(tooling).sourcePaths];
}

export async function resolveBebeAssetWatchConfig(
    projectRoot: string,
): Promise<BebeAssetWatchConfig> {
    const toolingModulePath =
        await resolveProjectBebeToolingModulePath(projectRoot);
    if (!toolingModulePath) {
        const sourcePaths =
            await resolveExistingKnownBebeAssetSourcePaths(projectRoot);
        return {
            sourcePaths,
            watchPatterns: sourcePaths,
        };
    }

    const tooling = await loadBebeTooling(toolingModulePath);
    return resolveBebeAssetWatchConfigFromTooling(tooling);
}

export async function bakeBebeAssets(
    options: BakeBebeAssetsOptions,
): Promise<BakedBebeAssets> {
    await assertNoDisallowedBebeAssetSources(options.projectRoot);

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
    await assertKnownBebeAssetSourcesClaimedByTooling(
        options.projectRoot,
        tooling,
    );
    const bootstrapLines: string[] = [];
    const outputs: BakedBebeAsset[] = [];

    for (const compiler of tooling.assetCompilers) {
        const outputPath = normalizeAssetRelativePath(
            compiler.outputPath,
            `${compiler.id}.outputPath`,
        );
        const artifactOutputPaths = normalizeArtifactOutputPaths(
            compiler.artifactOutputPaths ?? [],
            compiler.id,
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
            await removeBakedAssetArtifacts(artifactOutputPaths, options);
            continue;
        }

        if (compiler.renderBootstrap && !options.hasRuntimeEntry) {
            throw new Error(
                `${source.relativePath} requires a runtime entry so @blurengine/bebe can load baked assets.`,
            );
        }

        const sourceInput = await readBebeAssetCompilerSourceInput(
            compiler,
            source,
            options.projectRoot,
        );
        const result = compileBebeAsset(compiler, {
            pipeline: options.pipeline,
            projectRoot: options.projectRoot,
            ...sourceInput,
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
            await removeBakedAssetArtifacts(artifactOutputPaths, options);
            continue;
        }

        await removeBakedAssetArtifacts(artifactOutputPaths, options);
        await writeJson(outputAbsolutePath, result.output);
        outputs.push(
            ...(await syncBebeAssetArtifacts(result.artifacts, options, {
                compilerId: compiler.id,
                sourcePath: source.absolutePath,
            })),
        );
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

export async function convertProjectMidiToBaud(
    projectRoot: string,
    data: Uint8Array,
    options: BebeMidiToBaudOptions,
): Promise<string> {
    return (
        await convertProjectMidiToBaudWithDiagnostics(
            projectRoot,
            data,
            options,
        )
    ).baud;
}

export async function convertProjectMidiToBaudWithDiagnostics(
    projectRoot: string,
    data: Uint8Array,
    options: BebeMidiToBaudOptions,
): Promise<BebeMidiToBaudConversion> {
    const toolingModulePath =
        await resolveProjectBebeToolingModulePath(projectRoot);
    if (!toolingModulePath) {
        throw new Error(
            `MIDI conversion requires ${BEBE_TOOLING_NODE_SUBPATH}. Update @blurengine/bebe so blr can convert MIDI through the project-installed tooling surface.`,
        );
    }

    const module = await loadBebeToolingModule(toolingModulePath);
    if (typeof module.convertMidiToBaudWithDiagnostics === "function") {
        return normalizeMidiToBaudConversion(
            await module.convertMidiToBaudWithDiagnostics(data, options),
        );
    }

    if (typeof module.convertMidiToBaud !== "function") {
        throw new Error(
            `${BEBE_TOOLING_NODE_SUBPATH} must export convertMidiToBaud() for audio MIDI conversion.`,
        );
    }

    return {
        baud: module.convertMidiToBaud(data, options),
        diagnostics: [],
    };
}

function normalizeMidiToBaudConversion(
    input: unknown,
): BebeMidiToBaudConversion {
    if (!input || typeof input !== "object") {
        throw new Error(
            `${BEBE_TOOLING_NODE_SUBPATH} returned an invalid MIDI conversion result.`,
        );
    }

    const conversion = input as {
        readonly baud?: unknown;
        readonly diagnostics?: unknown;
    };
    if (
        typeof conversion.baud !== "string" ||
        !Array.isArray(conversion.diagnostics)
    ) {
        throw new Error(
            `${BEBE_TOOLING_NODE_SUBPATH} returned an invalid MIDI conversion result.`,
        );
    }

    return {
        baud: conversion.baud,
        diagnostics:
            conversion.diagnostics as readonly BebeMidiToBaudDiagnostic[],
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

async function assertKnownBebeAssetSourcesClaimedByTooling(
    projectRoot: string,
    tooling: BebeTooling,
): Promise<void> {
    const claimedSourcePaths = new Set(
        resolveBebeAssetWatchConfigFromTooling(tooling).sourcePaths,
    );
    for (const sourcePath of KNOWN_BEBE_ASSET_SOURCE_PATHS) {
        const normalizedSourcePath = normalizeAssetRelativePath(
            sourcePath,
            "known Bebe asset source path",
        );
        if (
            !claimedSourcePaths.has(normalizedSourcePath) &&
            (await exists(path.resolve(projectRoot, normalizedSourcePath)))
        ) {
            throw new Error(
                `${normalizedSourcePath} requires ${BEBE_TOOLING_NODE_SUBPATH} with an asset compiler that declares ${normalizedSourcePath}. Update @blurengine/bebe so blr can bake Bebe assets through the project-installed tooling surface.`,
            );
        }
    }
}

async function assertNoDisallowedBebeAssetSources(
    projectRoot: string,
): Promise<void> {
    for (const disallowedSource of DISALLOWED_BEBE_ASSET_SOURCE_PATHS) {
        if (await exists(path.resolve(projectRoot, disallowedSource.path))) {
            throw new Error(disallowedSource.message);
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

async function readBebeAssetCompilerSourceInput(
    compiler: BebeAssetCompiler,
    source: {
        readonly absolutePath: string;
        readonly relativePath: string;
    },
    projectRoot: string,
): Promise<
    Pick<
        Parameters<BebeAssetCompiler["compile"]>[0],
        "sourceFiles" | "sourceJson" | "sourceText"
    >
> {
    const sourceKind = compiler.sourceKind ?? "json";
    const sourceMode = compiler.sourceMode ?? "single";

    if (sourceMode === "collection") {
        if (sourceKind === "json") {
            throw new Error(
                `JSON source collections are not supported by ${compiler.id}.`,
            );
        }

        return {
            sourceFiles: await collectTextSourceFiles(
                compiler,
                source,
                projectRoot,
            ),
        };
    }

    if (sourceKind === "text") {
        return {
            sourceText: await readText(source.absolutePath),
        };
    }

    return {
        sourceJson: await readJson<unknown>(source.absolutePath),
    };
}

async function collectTextSourceFiles(
    compiler: BebeAssetCompiler,
    source: {
        readonly absolutePath: string;
        readonly relativePath: string;
    },
    projectRoot: string,
): Promise<BebeAssetSourceFile[]> {
    const sourceStats = await stat(source.absolutePath);
    if (!sourceStats.isDirectory()) {
        throw new Error(
            `${source.relativePath} must be a directory for ${compiler.id}.`,
        );
    }

    const sourceFileExtensions = new Set(compiler.sourceFileExtensions ?? []);
    const sourceFiles: BebeAssetSourceFile[] = [];
    await collectTextSourceFilesFromDirectory(
        source.absolutePath,
        projectRoot,
        sourceFileExtensions,
        sourceFiles,
    );
    sourceFiles.sort((left, right) =>
        compareCodePointLexically(left.relativePath, right.relativePath),
    );
    if (sourceFileExtensions.size > 0 && sourceFiles.length === 0) {
        throw new Error(
            `${source.relativePath} must contain at least one ${[
                ...sourceFileExtensions,
            ].join(", ")} file for ${compiler.id}.`,
        );
    }

    return sourceFiles;
}

async function resolveExistingKnownBebeAssetSourcePaths(
    projectRoot: string,
): Promise<string[]> {
    const existingKnownSources: string[] = [];
    for (const sourcePath of KNOWN_BEBE_ASSET_SOURCE_PATHS) {
        if (await exists(path.resolve(projectRoot, sourcePath))) {
            existingKnownSources.push(sourcePath);
        }
    }

    return existingKnownSources;
}

function resolveBebeAssetWatchConfigFromTooling(
    tooling: BebeTooling,
): BebeAssetWatchConfig {
    const sourcePaths = new Set<string>();
    const watchPatterns = new Set<string>();
    for (const compiler of tooling.assetCompilers) {
        const sourceMode = compiler.sourceMode ?? "single";
        for (const sourcePath of compiler.sourcePaths) {
            const normalizedSourcePath = normalizeAssetRelativePath(
                sourcePath,
                `${compiler.id}.sourcePaths`,
            );
            sourcePaths.add(normalizedSourcePath);
            watchPatterns.add(normalizedSourcePath);
            if (sourceMode === "collection") {
                for (const pattern of createCollectionWatchPatterns(
                    normalizedSourcePath,
                    compiler.sourceFileExtensions ?? [],
                )) {
                    watchPatterns.add(pattern);
                }
            }
        }
    }

    return {
        sourcePaths: [...sourcePaths],
        watchPatterns: [...watchPatterns],
    };
}

function createCollectionWatchPatterns(
    sourcePath: string,
    extensions: readonly string[],
): string[] {
    if (extensions.length === 0) {
        return [`${sourcePath}/**/*`];
    }

    return extensions.map((extension) => `${sourcePath}/**/*${extension}`);
}

function compareCodePointLexically(left: string, right: string): number {
    const leftCodePoints = Array.from(left);
    const rightCodePoints = Array.from(right);
    const length = Math.min(leftCodePoints.length, rightCodePoints.length);
    for (let index = 0; index < length; index += 1) {
        const difference =
            leftCodePoints[index].codePointAt(0)! -
            rightCodePoints[index].codePointAt(0)!;
        if (difference !== 0) {
            return difference;
        }
    }

    return leftCodePoints.length - rightCodePoints.length;
}

async function collectTextSourceFilesFromDirectory(
    directory: string,
    projectRoot: string,
    sourceFileExtensions: ReadonlySet<string>,
    sourceFiles: BebeAssetSourceFile[],
): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        const absolutePath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
            await collectTextSourceFilesFromDirectory(
                absolutePath,
                projectRoot,
                sourceFileExtensions,
                sourceFiles,
            );
            continue;
        }

        if (!entry.isFile()) {
            continue;
        }

        const extension = path.extname(entry.name);
        if (
            sourceFileExtensions.size > 0 &&
            !sourceFileExtensions.has(extension)
        ) {
            continue;
        }

        sourceFiles.push({
            absolutePath,
            relativePath: path
                .relative(projectRoot, absolutePath)
                .replace(/\\/g, "/"),
            text: await readText(absolutePath),
        });
    }
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

function normalizeArtifactOutputPaths(
    artifactOutputPaths: readonly BebeAssetCompilerArtifactOutputPath[],
    compilerId: string,
): BebeAssetCompilerArtifactOutputPath[] {
    return artifactOutputPaths.map((artifact, index) => {
        if (
            artifact.target !== "behaviorPack" &&
            artifact.target !== "resourcePack" &&
            artifact.target !== "scripts"
        ) {
            throw new Error(
                `${compilerId}.artifactOutputPaths[${index}].target is not supported.`,
            );
        }

        return {
            target: artifact.target,
            outputPath: normalizeAssetRelativePath(
                artifact.outputPath,
                `${compilerId}.artifactOutputPaths[${index}].outputPath`,
            ),
        };
    });
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

async function syncBebeAssetArtifacts(
    artifacts: readonly BebeAssetCompilerArtifact[] | undefined,
    options: Pick<
        BakeBebeAssetsOptions,
        | "distRoot"
        | "stageBehaviorPackDirectories"
        | "stageResourcePackDirectory"
        | "stageScriptsDirectories"
    >,
    context: {
        readonly compilerId: string;
        readonly sourcePath: string;
    },
): Promise<BakedBebeAsset[]> {
    const outputs: BakedBebeAsset[] = [];

    for (const artifact of artifacts ?? []) {
        const outputPath = normalizeAssetRelativePath(
            artifact.outputPath,
            "artifact.outputPath",
        );
        if (artifact.target === "behaviorPack") {
            if (options.stageBehaviorPackDirectories.length === 0) {
                throw new Error(
                    `Cannot write Bebe behavior-pack artifact ${outputPath} because no staged behavior pack is present.`,
                );
            }
            for (const directory of options.stageBehaviorPackDirectories) {
                await writeJson(
                    path.join(directory, outputPath),
                    artifact.output,
                );
            }
            continue;
        }

        if (artifact.target === "resourcePack") {
            if (!options.stageResourcePackDirectory) {
                throw new Error(
                    `Cannot write Bebe resource-pack artifact ${outputPath} because no staged resource pack is present.`,
                );
            }
            await writeJson(
                path.join(options.stageResourcePackDirectory, outputPath),
                artifact.output,
            );
            continue;
        }

        if (artifact.target === "scripts") {
            const outputAbsolutePath = path.resolve(
                options.distRoot,
                outputPath,
            );
            await writeJson(outputAbsolutePath, artifact.output);
            await syncBakedAssetIntoStage(
                outputAbsolutePath,
                outputPath,
                options.stageScriptsDirectories,
            );
            outputs.push({
                compilerId: context.compilerId,
                outputPath: outputAbsolutePath,
                sourcePath: context.sourcePath,
            });
            continue;
        }

        throw new Error(`Unsupported Bebe artifact target: ${artifact.target}`);
    }

    return outputs;
}

async function removeBakedAssetArtifacts(
    artifactOutputPaths: readonly BebeAssetCompilerArtifactOutputPath[],
    options: Pick<
        BakeBebeAssetsOptions,
        | "distRoot"
        | "stageBehaviorPackDirectories"
        | "stageResourcePackDirectory"
        | "stageScriptsDirectories"
    >,
): Promise<void> {
    for (const artifact of artifactOutputPaths) {
        const outputPath = artifact.outputPath;
        if (artifact.target === "behaviorPack") {
            for (const directory of options.stageBehaviorPackDirectories) {
                await removePath(path.join(directory, outputPath));
            }
            continue;
        }

        if (artifact.target === "resourcePack") {
            if (options.stageResourcePackDirectory) {
                await removePath(
                    path.join(options.stageResourcePackDirectory, outputPath),
                );
            }
            continue;
        }

        if (artifact.target === "scripts") {
            await removePath(path.resolve(options.distRoot, outputPath));
            for (const directory of options.stageScriptsDirectories) {
                await removePath(path.join(directory, outputPath));
            }
            continue;
        }

        throw new Error(`Unsupported Bebe artifact target: ${artifact.target}`);
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
