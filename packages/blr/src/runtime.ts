import path from "node:path";
import { build } from "esbuild";
import {
    resolvePackFeatureSelection,
    type PackFeatureSelectionOverride,
} from "./content.js";
import {
    DEFAULT_DIST_PACKAGES_ROOT,
    DEFAULT_DIST_STAGE_ROOT,
} from "./constants.js";
import type { DebugLogger } from "./debug.js";
import {
    copyDirectory,
    ensureDirectory,
    exists,
    removeDirectory,
    removeFilesNamed,
} from "./fs.js";
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
};

export type ResolvedBuildArtifacts = {
    distRoot: string;
    stageRoot: string;
    packagesRoot: string;
    runtimeOutFilePath: string;
    runtimeScriptsDirectory: string;
    behaviorPackName?: string;
    resourcePackName?: string;
    stageBehaviorPackDirectory?: string;
    stageBehaviorScriptsDirectory?: string;
    stageResourcePackDirectory?: string;
};

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
    return {
        distRoot,
        stageRoot,
        packagesRoot: path.resolve(projectRoot, DEFAULT_DIST_PACKAGES_ROOT),
        runtimeOutFilePath: path.resolve(projectRoot, config.runtime.outFile),
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
    if (config.packs.behavior && artifacts.stageBehaviorPackDirectory) {
        behaviorSource = path.resolve(
            projectRoot,
            config.packs.behavior.directory,
        );
        await copyDirectory(
            behaviorSource,
            artifacts.stageBehaviorPackDirectory,
        );
        await removeFilesNamed(
            artifacts.stageBehaviorPackDirectory,
            ".gitkeep",
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
        resourceSource,
        stageResourcePackDirectory: artifacts.stageResourcePackDirectory,
    });
}

async function syncBuiltScriptsIntoStage(
    artifacts: ResolvedBuildArtifacts,
    debug?: DebugLogger,
): Promise<void> {
    if (!artifacts.stageBehaviorScriptsDirectory) {
        throw new Error(
            "Cannot sync built scripts because no staged behavior pack is present.",
        );
    }

    if (!(await exists(artifacts.runtimeScriptsDirectory))) {
        throw new Error(
            `Built scripts directory does not exist: ${path.relative(process.cwd(), artifacts.runtimeScriptsDirectory)}`,
        );
    }

    if (
        artifacts.runtimeScriptsDirectory ===
        artifacts.stageBehaviorScriptsDirectory
    ) {
        debug?.log(
            "build",
            "runtime bundle already targets staged behavior pack scripts",
            {
                stageBehaviorScriptsDirectory:
                    artifacts.stageBehaviorScriptsDirectory,
            },
        );
        return;
    }

    await copyDirectory(
        artifacts.runtimeScriptsDirectory,
        artifacts.stageBehaviorScriptsDirectory,
    );
    debug?.log("build", "synced built scripts into staged behavior pack", {
        source: artifacts.runtimeScriptsDirectory,
        destination: artifacts.stageBehaviorScriptsDirectory,
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
            logLevel: "silent",
        });

        await syncBuiltScriptsIntoStage(artifacts, options.debug);
    } else {
        await removeDirectory(artifacts.runtimeScriptsDirectory);
    }

    options.debug?.log("build", "build completed", {
        entry: hasRuntimeEntry ? config.runtime.entry : "(none)",
        outFile: config.runtime.outFile,
        stageBehaviorPackDirectory: artifacts.stageBehaviorPackDirectory
            ? path.relative(projectRoot, artifacts.stageBehaviorPackDirectory)
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
