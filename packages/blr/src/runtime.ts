import { copyFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { build, type Loader, type Plugin } from "esbuild";
import {
    resolvePackFeatureSelection,
    type PackFeatureSelectionOverride,
} from "./content.js";
import {
    BASELINE_DEPENDENCIES,
    DEFAULT_DIST_PACKAGES_ROOT,
    DEFAULT_DIST_STAGE_ROOT,
    DEFAULT_LINK_SERVER_HOST,
    DEFAULT_LINK_SERVER_PORT,
} from "./constants.js";
import type { DebugLogger } from "./debug.js";
import {
    copyDirectory,
    ensureDirectory,
    exists,
    readJson,
    readText,
    removeDirectory,
    removeFilesNamed,
    writeJson,
} from "./fs.js";
import { stripOfflineBebeLink } from "./link-strip.js";
import type {
    BlurMachineSettings,
    BlurProject,
    MinecraftProduct,
} from "./types.js";

export type MinecraftDevelopmentRootResolution = {
    explicitPath?: string;
    attemptedRoots: Array<{
        product: MinecraftProduct;
        path: string;
        exists: boolean;
    }>;
    resolvedRoot?: string;
};

type BuildProjectOptions = {
    production: boolean;
    debug?: DebugLogger;
    link?: {
        baseUrl?: string;
        enabled?: boolean;
        logReady?: boolean;
    };
};

export type ResolvedBuildArtifacts = {
    distRoot: string;
    stageRoot: string;
    packagesRoot: string;
    runtimeOutFilePath: string;
    runtimeBdsOutFilePath: string;
    runtimeScriptsDirectory: string;
    behaviorPackName?: string;
    resourcePackName?: string;
    stageBehaviorPackDirectory?: string;
    stageBehaviorScriptsDirectory?: string;
    stageBdsBehaviorPackDirectory?: string;
    stageBdsBehaviorScriptsDirectory?: string;
    stageResourcePackDirectory?: string;
};

type PackManifestDependency = Record<string, unknown> & {
    module_name?: unknown;
};

type PackManifest = Record<string, unknown> & {
    dependencies?: unknown;
};

const SERVER_ONLY_MANIFEST_MODULES = new Set([
    "@minecraft/server-admin",
    "@minecraft/server-net",
]);
const RUNTIME_SOURCE_FILTER = /\.[cm]?[jt]sx?$/;

function stripVersionRange(version: string): string {
    return version.replace(/^[~^]/u, "");
}

function toBdsRuntimeOutFilePath(runtimeOutFilePath: string): string {
    const extension = path.extname(runtimeOutFilePath);
    if (extension.length === 0) {
        return `${runtimeOutFilePath}.bds`;
    }

    return `${runtimeOutFilePath.slice(0, -extension.length)}.bds${extension}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readManifestDependencies(
    manifest: PackManifest,
): PackManifestDependency[] {
    if (!Array.isArray(manifest.dependencies)) {
        return [];
    }

    return manifest.dependencies.filter(isRecord);
}

function ensureManifestDependency(
    dependencies: PackManifestDependency[],
    moduleName: keyof typeof BASELINE_DEPENDENCIES,
): void {
    if (
        dependencies.some((dependency) => dependency.module_name === moduleName)
    ) {
        return;
    }

    dependencies.push({
        module_name: moduleName,
        version: stripVersionRange(BASELINE_DEPENDENCIES[moduleName]),
    });
}

async function updateBehaviorManifestForVariant(
    behaviorPackDirectory: string,
    variant: "bds" | "offline",
): Promise<void> {
    const manifestPath = path.join(behaviorPackDirectory, "manifest.json");
    if (!(await exists(manifestPath))) {
        return;
    }

    const manifest = await readJson<PackManifest>(manifestPath);
    const dependencies = readManifestDependencies(manifest);

    if (variant === "offline") {
        manifest.dependencies = dependencies.filter((dependency) => {
            const moduleName = dependency.module_name;
            return (
                typeof moduleName !== "string" ||
                !SERVER_ONLY_MANIFEST_MODULES.has(moduleName)
            );
        });
    } else {
        ensureManifestDependency(dependencies, "@minecraft/server-net");
        manifest.dependencies = dependencies;
    }

    await writeJson(manifestPath, manifest);
}

function toImportSpecifier(projectRoot: string, targetPath: string): string {
    const relativePath = path
        .relative(projectRoot, targetPath)
        .replace(/\\/g, "/");
    return relativePath.startsWith(".") ? relativePath : `./${relativePath}`;
}

function resolveDefaultLinkBaseUrl(): string {
    return `http://${DEFAULT_LINK_SERVER_HOST}:${DEFAULT_LINK_SERVER_PORT}`;
}

function isProjectRuntimeSource(
    projectRoot: string,
    filePath: string,
): boolean {
    const resolvedRoot = path.resolve(projectRoot);
    const resolvedFile = path.resolve(filePath);
    if (resolvedFile.includes(`${path.sep}node_modules${path.sep}`)) {
        return false;
    }

    return (
        resolvedFile === resolvedRoot ||
        resolvedFile.startsWith(`${resolvedRoot}${path.sep}`)
    );
}

function getEsbuildLoader(filePath: string): Loader {
    const extension = path.extname(filePath);
    switch (extension) {
        case ".js":
        case ".mjs":
        case ".cjs":
            return "js";
        case ".jsx":
            return "jsx";
        case ".tsx":
            return "tsx";
        case ".ts":
        case ".mts":
        case ".cts":
        default:
            return "ts";
    }
}

function createOfflineLinkStripPlugin(projectRoot: string): Plugin {
    return {
        name: "bebe-offline-link-strip",
        setup(buildContext) {
            buildContext.onLoad(
                {
                    filter: RUNTIME_SOURCE_FILTER,
                },
                async (args) => {
                    if (!isProjectRuntimeSource(projectRoot, args.path)) {
                        return undefined;
                    }

                    const sourceText = await readText(args.path);
                    return {
                        contents: stripOfflineBebeLink(sourceText, args.path),
                        loader: getEsbuildLoader(args.path),
                        resolveDir: path.dirname(args.path),
                    };
                },
            );
        },
    };
}

async function hasResolvableBebeLinkBds(projectRoot: string): Promise<boolean> {
    const packageJsonPath = path.join(projectRoot, "package.json");
    if (!(await exists(packageJsonPath))) {
        return false;
    }

    const packageJson = await readJson<{
        dependencies?: Record<string, unknown>;
        devDependencies?: Record<string, unknown>;
        optionalDependencies?: Record<string, unknown>;
        peerDependencies?: Record<string, unknown>;
    }>(packageJsonPath);
    const declaresBebe = [
        packageJson.dependencies,
        packageJson.devDependencies,
        packageJson.optionalDependencies,
        packageJson.peerDependencies,
    ].some((dependencies) =>
        Boolean(dependencies && "@blurengine/bebe" in dependencies),
    );
    if (!declaresBebe) {
        return false;
    }

    try {
        createRequire(packageJsonPath).resolve(
            "@blurengine/bebe/internal/link/bds",
        );
        return true;
    } catch {
        return false;
    }
}

async function createBdsRuntimeBuildEntry(
    projectRoot: string,
    entryPath: string,
    options: BuildProjectOptions,
): Promise<{
    contents?: string;
    sourcefile?: string;
}> {
    if (
        options.link?.enabled === false ||
        !(await hasResolvableBebeLinkBds(projectRoot))
    ) {
        return {};
    }

    const baseUrl = options.link?.baseUrl ?? resolveDefaultLinkBaseUrl();
    const userEntrySpecifier = toImportSpecifier(projectRoot, entryPath);
    const linkOptions = [
        `baseUrl: ${JSON.stringify(baseUrl)}`,
        "context: __blrLinkContext",
    ];
    if (options.link?.logReady) {
        linkOptions.push("logger: console");
    }

    return {
        contents: [
            'import { Context } from "@blurengine/bebe";',
            'import { installBdsLinkTransport } from "@blurengine/bebe/internal/link/bds";',
            "const __blrLinkContext = new Context();",
            `installBdsLinkTransport({ ${linkOptions.join(", ")} });`,
            `void import(${JSON.stringify(userEntrySpecifier)});`,
            "",
        ].join("\n"),
        sourcefile: "bebe-link-bds-entry.js",
    };
}

function getGameDeploymentRootPaths(
    customDeploymentPath: string,
): Record<MinecraftProduct, string | undefined> {
    const localAppDataPath = process.env.LOCALAPPDATA;
    const appDataPath = process.env.APPDATA;
    return {
        BedrockGDK: appDataPath
            ? path.resolve(
                  appDataPath,
                  "Minecraft Bedrock/Users/Shared/games/com.mojang",
              )
            : undefined,
        PreviewGDK: appDataPath
            ? path.resolve(
                  appDataPath,
                  "Minecraft Bedrock Preview/Users/Shared/games/com.mojang",
              )
            : undefined,
        BedrockUWP: localAppDataPath
            ? path.resolve(
                  localAppDataPath,
                  "Packages/Microsoft.MinecraftUWP_8wekyb3d8bbwe/LocalState/games/com.mojang",
              )
            : undefined,
        PreviewUWP: localAppDataPath
            ? path.resolve(
                  localAppDataPath,
                  "Packages/Microsoft.MinecraftWindowsBeta_8wekyb3d8bbwe/LocalState/games/com.mojang",
              )
            : undefined,
        Custom:
            customDeploymentPath.length > 0 ? customDeploymentPath : undefined,
    };
}

export async function describeMinecraftDevelopmentRootResolution(
    projectRoot: string,
    config: BlurProject,
    machine: BlurMachineSettings,
): Promise<MinecraftDevelopmentRootResolution> {
    const explicitPath = machine.localDeploy.minecraftDevelopmentPath.trim();
    if (explicitPath.length > 0) {
        const resolvedRoot = path.isAbsolute(explicitPath)
            ? explicitPath
            : path.resolve(projectRoot, explicitPath);
        return {
            explicitPath,
            attemptedRoots: [
                {
                    product: "Custom",
                    path: resolvedRoot,
                    exists: await exists(resolvedRoot),
                },
            ],
            resolvedRoot,
        };
    }

    const roots = getGameDeploymentRootPaths("");
    const product = machine.localDeploy.minecraftProduct;
    const preferredOrder: MinecraftProduct[] =
        product === "auto"
            ? config.minecraft.channel === "preview"
                ? ["PreviewGDK", "PreviewUWP", "BedrockGDK", "BedrockUWP"]
                : ["BedrockGDK", "BedrockUWP", "PreviewGDK", "PreviewUWP"]
            : [product];
    const attemptedRoots: MinecraftDevelopmentRootResolution["attemptedRoots"] =
        [];

    for (const candidate of preferredOrder) {
        const root = roots[candidate];
        if (!root) {
            continue;
        }
        const rootExists = await exists(root);
        attemptedRoots.push({
            product: candidate,
            path: root,
            exists: rootExists,
        });
        if (rootExists) {
            return {
                attemptedRoots,
                resolvedRoot: root,
            };
        }
    }

    return {
        attemptedRoots,
    };
}

async function resolveMinecraftDevelopmentRoot(
    projectRoot: string,
    config: BlurProject,
    machine: BlurMachineSettings,
): Promise<string> {
    const resolution = await describeMinecraftDevelopmentRootResolution(
        projectRoot,
        config,
        machine,
    );
    if (resolution.resolvedRoot) {
        return resolution.resolvedRoot;
    }

    const attemptedDescription =
        resolution.attemptedRoots.length > 0
            ? ` Checked: ${resolution.attemptedRoots.map((attempt) => `${attempt.product}: ${attempt.path}`).join("; ")}.`
            : "";
    throw new Error(
        `Unable to resolve the Minecraft development root.${attemptedDescription} Use BLR_MACHINE_LOCALDEPLOY_MINECRAFTDEVELOPMENTPATH, BLR_MACHINE_LOCALDEPLOY_MINECRAFTPRODUCT, or the matching CLI flags.`,
    );
}

export function resolveBuildArtifacts(
    projectRoot: string,
    config: BlurProject,
): ResolvedBuildArtifacts {
    const distRoot = path.resolve(projectRoot, "dist");
    const stageRoot = path.resolve(projectRoot, DEFAULT_DIST_STAGE_ROOT);
    const behaviorPackName = config.packs.behavior
        ? path.posix.basename(config.packs.behavior.directory)
        : undefined;
    const resourcePackName = config.packs.resource
        ? path.posix.basename(config.packs.resource.directory)
        : undefined;
    const stageBehaviorPackDirectory = behaviorPackName
        ? path.join(stageRoot, "behavior_packs", behaviorPackName)
        : undefined;
    const stageBdsBehaviorPackDirectory = behaviorPackName
        ? path.join(stageRoot, "bds_behavior_packs", behaviorPackName)
        : undefined;
    const runtimeOutFilePath = path.resolve(
        projectRoot,
        config.runtime.outFile,
    );
    return {
        distRoot,
        stageRoot,
        packagesRoot: path.resolve(projectRoot, DEFAULT_DIST_PACKAGES_ROOT),
        runtimeOutFilePath,
        runtimeBdsOutFilePath: toBdsRuntimeOutFilePath(runtimeOutFilePath),
        runtimeScriptsDirectory: path.resolve(
            projectRoot,
            path.dirname(config.runtime.outFile),
        ),
        behaviorPackName,
        resourcePackName,
        stageBehaviorPackDirectory,
        stageBehaviorScriptsDirectory: stageBehaviorPackDirectory
            ? path.join(stageBehaviorPackDirectory, "scripts")
            : undefined,
        stageBdsBehaviorPackDirectory,
        stageBdsBehaviorScriptsDirectory: stageBdsBehaviorPackDirectory
            ? path.join(stageBdsBehaviorPackDirectory, "scripts")
            : undefined,
        stageResourcePackDirectory: resourcePackName
            ? path.join(stageRoot, "resource_packs", resourcePackName)
            : undefined,
    };
}

async function stageProjectContent(
    projectRoot: string,
    config: BlurProject,
    artifacts: ResolvedBuildArtifacts,
    debug?: DebugLogger,
): Promise<void> {
    await removeDirectory(artifacts.stageRoot);
    await ensureDirectory(artifacts.stageRoot);

    let behaviorSource: string | undefined;
    if (
        config.packs.behavior &&
        artifacts.stageBehaviorPackDirectory &&
        artifacts.stageBdsBehaviorPackDirectory
    ) {
        behaviorSource = path.resolve(
            projectRoot,
            config.packs.behavior.directory,
        );
        await copyDirectory(
            behaviorSource,
            artifacts.stageBehaviorPackDirectory,
        );
        await copyDirectory(
            behaviorSource,
            artifacts.stageBdsBehaviorPackDirectory,
        );
        await removeFilesNamed(
            artifacts.stageBehaviorPackDirectory,
            ".gitkeep",
        );
        await removeFilesNamed(
            artifacts.stageBdsBehaviorPackDirectory,
            ".gitkeep",
        );
        await updateBehaviorManifestForVariant(
            artifacts.stageBehaviorPackDirectory,
            "offline",
        );
        await updateBehaviorManifestForVariant(
            artifacts.stageBdsBehaviorPackDirectory,
            "bds",
        );
    }

    let resourceSource: string | undefined;
    if (config.packs.resource && artifacts.stageResourcePackDirectory) {
        resourceSource = path.resolve(
            projectRoot,
            config.packs.resource.directory,
        );
        await copyDirectory(
            resourceSource,
            artifacts.stageResourcePackDirectory,
        );
        await removeFilesNamed(
            artifacts.stageResourcePackDirectory,
            ".gitkeep",
        );
    }

    debug?.log("build", "staged project pack content", {
        behaviorSource,
        stageBehaviorPackDirectory: artifacts.stageBehaviorPackDirectory,
        stageBdsBehaviorPackDirectory: artifacts.stageBdsBehaviorPackDirectory,
        resourceSource,
        stageResourcePackDirectory: artifacts.stageResourcePackDirectory,
    });
}

async function copySourceMapIfPresent(
    sourceFilePath: string,
    stageBehaviorScriptsDirectory: string,
): Promise<void> {
    const sourceMapPath = `${sourceFilePath}.map`;
    if (!(await exists(sourceMapPath))) {
        return;
    }

    await copyFile(
        sourceMapPath,
        path.join(stageBehaviorScriptsDirectory, path.basename(sourceMapPath)),
    );
}

async function syncBuiltScriptIntoStage(
    sourceFilePath: string,
    stageBehaviorScriptsDirectory: string | undefined,
    outputFileName: string,
    debug?: DebugLogger,
): Promise<void> {
    if (!stageBehaviorScriptsDirectory) {
        throw new Error(
            "Cannot sync built scripts because no staged behavior pack is present.",
        );
    }

    if (!(await exists(sourceFilePath))) {
        throw new Error(
            `Built script file does not exist: ${path.relative(process.cwd(), sourceFilePath)}`,
        );
    }

    await ensureDirectory(stageBehaviorScriptsDirectory);
    const targetFilePath = path.join(
        stageBehaviorScriptsDirectory,
        outputFileName,
    );

    if (path.resolve(sourceFilePath) === path.resolve(targetFilePath)) {
        debug?.log(
            "build",
            "runtime bundle already targets staged behavior pack scripts",
            {
                targetFilePath,
            },
        );
        await copySourceMapIfPresent(
            sourceFilePath,
            stageBehaviorScriptsDirectory,
        );
        return;
    }

    await copyFile(sourceFilePath, targetFilePath);
    await copySourceMapIfPresent(sourceFilePath, stageBehaviorScriptsDirectory);
    debug?.log("build", "synced built scripts into staged behavior pack", {
        source: sourceFilePath,
        destination: targetFilePath,
    });
}

export async function ensureStagedBuildArtifacts(
    projectRoot: string,
    config: BlurProject,
): Promise<ResolvedBuildArtifacts> {
    const artifacts = resolveBuildArtifacts(projectRoot, config);
    if (
        artifacts.stageBehaviorPackDirectory &&
        !(await exists(artifacts.stageBehaviorPackDirectory))
    ) {
        throw new Error(
            "Missing staged behavior pack output. Run `blr build` or `blr dev` first.",
        );
    }
    if (
        artifacts.stageBdsBehaviorPackDirectory &&
        !(await exists(artifacts.stageBdsBehaviorPackDirectory))
    ) {
        throw new Error(
            "Missing staged BDS behavior pack output. Run `blr build` or `blr dev` first.",
        );
    }
    if (
        artifacts.stageResourcePackDirectory &&
        !(await exists(artifacts.stageResourcePackDirectory))
    ) {
        throw new Error(
            "Missing staged resource pack output. Run `blr build` or `blr dev` first.",
        );
    }
    return artifacts;
}

export async function buildProject(
    projectRoot: string,
    config: BlurProject,
    options: BuildProjectOptions,
): Promise<ResolvedBuildArtifacts> {
    const artifacts = resolveBuildArtifacts(projectRoot, config);
    const hasRuntimeEntry = config.runtime.entry.trim().length > 0;
    const entryPath = hasRuntimeEntry
        ? path.resolve(projectRoot, config.runtime.entry)
        : "";
    options.debug?.log("build", "starting build", {
        entry: hasRuntimeEntry ? config.runtime.entry : "(none)",
        outFile: config.runtime.outFile,
        bdsOutFile: path.relative(projectRoot, artifacts.runtimeBdsOutFilePath),
        stageRoot: path.relative(projectRoot, artifacts.stageRoot),
        production: options.production,
        externalModules: config.runtime.externalModules,
    });

    if (hasRuntimeEntry && !(await exists(entryPath))) {
        throw new Error(`Entry file does not exist: ${config.runtime.entry}`);
    }
    if (hasRuntimeEntry && !artifacts.stageBehaviorScriptsDirectory) {
        throw new Error("Runtime scripts require a behavior pack.");
    }
    if (hasRuntimeEntry && !artifacts.stageBdsBehaviorScriptsDirectory) {
        throw new Error("Runtime scripts require a BDS behavior pack.");
    }

    await stageProjectContent(projectRoot, config, artifacts, options.debug);
    if (hasRuntimeEntry) {
        await ensureDirectory(path.dirname(artifacts.runtimeOutFilePath));

        await build({
            entryPoints: [entryPath],
            outfile: artifacts.runtimeOutFilePath,
            bundle: true,
            format: "esm",
            platform: "neutral",
            target: config.runtime.target,
            sourcemap: config.runtime.sourcemap,
            minify: options.production,
            external: config.runtime.externalModules,
            plugins: [createOfflineLinkStripPlugin(projectRoot)],
            logLevel: "silent",
        });

        const bdsEntry = await createBdsRuntimeBuildEntry(
            projectRoot,
            entryPath,
            options,
        );
        await build({
            ...(bdsEntry.contents
                ? {
                      stdin: {
                          contents: bdsEntry.contents,
                          loader: "js",
                          resolveDir: projectRoot,
                          sourcefile: bdsEntry.sourcefile,
                      },
                  }
                : {
                      entryPoints: [entryPath],
                  }),
            outfile: artifacts.runtimeBdsOutFilePath,
            bundle: true,
            format: "esm",
            platform: "neutral",
            target: config.runtime.target,
            sourcemap: config.runtime.sourcemap,
            minify: options.production,
            external: config.runtime.externalModules,
            logLevel: "silent",
        });

        const stagedScriptFileName = path.basename(
            artifacts.runtimeOutFilePath,
        );
        await syncBuiltScriptIntoStage(
            artifacts.runtimeOutFilePath,
            artifacts.stageBehaviorScriptsDirectory,
            stagedScriptFileName,
            options.debug,
        );
        await syncBuiltScriptIntoStage(
            artifacts.runtimeBdsOutFilePath,
            artifacts.stageBdsBehaviorScriptsDirectory,
            stagedScriptFileName,
            options.debug,
        );
    } else {
        await removeDirectory(artifacts.runtimeScriptsDirectory);
    }

    options.debug?.log("build", "build completed", {
        entry: hasRuntimeEntry ? config.runtime.entry : "(none)",
        outFile: config.runtime.outFile,
        stageBehaviorPackDirectory: artifacts.stageBehaviorPackDirectory
            ? path.relative(projectRoot, artifacts.stageBehaviorPackDirectory)
            : undefined,
        stageBdsBehaviorPackDirectory: artifacts.stageBdsBehaviorPackDirectory
            ? path.relative(
                  projectRoot,
                  artifacts.stageBdsBehaviorPackDirectory,
              )
            : undefined,
        stageResourcePackDirectory: artifacts.stageResourcePackDirectory
            ? path.relative(projectRoot, artifacts.stageResourcePackDirectory)
            : undefined,
        bundledScripts: hasRuntimeEntry,
    });

    return artifacts;
}

export async function cleanProject(projectRoot: string): Promise<void> {
    await removeDirectory(path.resolve(projectRoot, "dist"));
}

export async function runLocalDeploy(
    projectRoot: string,
    config: BlurProject,
    machine: BlurMachineSettings,
    options: {
        copy?: PackFeatureSelectionOverride;
    } = {},
    debug?: DebugLogger,
): Promise<void> {
    const artifacts = await ensureStagedBuildArtifacts(projectRoot, config);
    const copySelection = resolvePackFeatureSelection(
        config.automation.localDeploy.copy,
        options.copy,
    );
    const deployRoot = await resolveMinecraftDevelopmentRoot(
        projectRoot,
        config,
        machine,
    );
    const behaviorDestination = artifacts.behaviorPackName
        ? path.join(
              deployRoot,
              "development_behavior_packs",
              artifacts.behaviorPackName,
          )
        : undefined;
    const resourceDestination = artifacts.resourcePackName
        ? path.join(
              deployRoot,
              "development_resource_packs",
              artifacts.resourcePackName,
          )
        : undefined;

    debug?.log("deploy", "resolved local deploy paths", {
        deployRoot,
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
