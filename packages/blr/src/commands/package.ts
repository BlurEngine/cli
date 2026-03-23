import { createHash } from "node:crypto";
import path from "node:path";
import AdmZip from "adm-zip";
import { resolvePackFeatureSelection } from "../content.js";
import { loadBlurConfig } from "../config.js";
import { createDebugLogger, resolveDebugEnabled } from "../debug.js";
import {
    copyDirectory,
    ensureDirectory,
    exists,
    readJson,
    removeDirectory,
    removeFilesNamed,
    writeJson,
} from "../fs.js";
import { DEFAULT_PACK_VERSION } from "../constants.js";
import { buildProject, resolveBuildArtifacts } from "../runtime.js";
import type { BlurProject, PackageTarget, VersionTuple } from "../types.js";
import {
    appendWorldSourceHint,
    assertValidProjectWorldSource,
    resolveSelectedWorld,
    resolveProjectWorldSourceDirectory,
} from "../world.js";

type PackageCommandOptions = {
    production?: boolean;
    world?: string;
    includeBehaviorPack?: boolean;
    includeResourcePack?: boolean;
    debug?: boolean;
};

const SUPPORTED_PACKAGE_TARGETS: PackageTarget[] = ["world-template"];

type WorldTemplateManifest = {
    format_version: 2;
    header: {
        name: string;
        description: string;
        version: VersionTuple;
        lock_template_options: true;
        base_game_version: VersionTuple;
        uuid: string;
    };
    modules: Array<{
        version: VersionTuple;
        type: "world_template";
        uuid: string;
    }>;
};

function createDeterministicUuid(seed: string): string {
    const hash = createHash("sha1").update(seed).digest("hex");
    const bytes = hash.slice(0, 32).split("");
    bytes[12] = "5";
    const variant = Number.parseInt(bytes[16] ?? "0", 16);
    bytes[16] = ((variant & 0x3) | 0x8).toString(16);
    return `${bytes.slice(0, 8).join("")}-${bytes.slice(8, 12).join("")}-${bytes.slice(12, 16).join("")}-${bytes.slice(16, 20).join("")}-${bytes.slice(20, 32).join("")}`;
}

function ensureVersionTupleFromProjectVersion(
    value: string,
    fallback: VersionTuple,
): VersionTuple {
    const match = value.match(/^(\d+)\.(\d+)\.(\d+)/);
    if (!match) {
        return fallback;
    }

    return [
        Number.parseInt(match[1], 10),
        Number.parseInt(match[2], 10),
        Number.parseInt(match[3], 10),
    ];
}

function toWorldTemplateManifest(
    config: BlurProject,
    worldName: string,
): WorldTemplateManifest {
    const version = ensureVersionTupleFromProjectVersion(
        config.project.version,
        config.packs.behavior?.version ??
            config.packs.resource?.version ??
            DEFAULT_PACK_VERSION,
    );
    const baseGameVersion = config.minecraft.minEngineVersion;
    const displayName =
        worldName === config.dev.localServer.worldName
            ? config.project.name
            : `${config.project.name} (${worldName})`;
    return {
        format_version: 2,
        header: {
            name: displayName,
            description: config.project.description,
            version,
            lock_template_options: true,
            base_game_version: baseGameVersion,
            uuid: createDeterministicUuid(
                `${config.project.packageName}:world-template:${worldName}:header`,
            ),
        },
        modules: [
            {
                version,
                type: "world_template",
                uuid: createDeterministicUuid(
                    `${config.project.packageName}:world-template:${worldName}:module`,
                ),
            },
        ],
    };
}

function createWorldTemplatePackFolderName(
    packName: string,
    suffix: "bp" | "rp",
): string {
    const sanitized = packName.toLowerCase().replace(/[^a-z0-9]/g, "");
    const base = sanitized.length > 0 ? sanitized : "pack";
    const maxBaseLength = Math.max(1, 10 - suffix.length);
    return `${base.slice(0, maxBaseLength)}${suffix}`;
}

async function packageWorldTemplate(
    projectRoot: string,
    config: BlurProject,
    worldName: string,
    worldSourcePath: string,
    includeSelection: {
        behaviorPack: boolean;
        resourcePack: boolean;
    },
): Promise<{
    workspaceRoot: string;
    outputFile: string;
}> {
    const artifacts = resolveBuildArtifacts(projectRoot, config);
    const worldTemplateSource = resolveProjectWorldSourceDirectory(
        projectRoot,
        worldSourcePath,
    );

    const workspaceRoot = path.join(artifacts.packagesRoot, "world_template");
    const behaviorPackFolderName = artifacts.behaviorPackName
        ? createWorldTemplatePackFolderName(artifacts.behaviorPackName, "bp")
        : undefined;
    const resourcePackFolderName = artifacts.resourcePackName
        ? createWorldTemplatePackFolderName(artifacts.resourcePackName, "rp")
        : undefined;
    const outputBaseName =
        worldName === config.dev.localServer.worldName
            ? config.project.packName
            : `${config.project.packName}-${worldName.replace(/[<>:"/\\|?*\x00-\x1F]+/g, "-")}`;
    const outputFile = path.join(
        artifacts.packagesRoot,
        `${outputBaseName}.mctemplate`,
    );

    await removeDirectory(workspaceRoot);
    await ensureDirectory(artifacts.packagesRoot);
    await copyDirectory(worldTemplateSource, workspaceRoot);
    if (
        includeSelection.behaviorPack &&
        artifacts.stageBehaviorPackDirectory &&
        behaviorPackFolderName
    ) {
        await copyDirectory(
            artifacts.stageBehaviorPackDirectory,
            path.join(workspaceRoot, "behavior_packs", behaviorPackFolderName),
        );
    }
    if (
        includeSelection.resourcePack &&
        artifacts.stageResourcePackDirectory &&
        resourcePackFolderName
    ) {
        await copyDirectory(
            artifacts.stageResourcePackDirectory,
            path.join(workspaceRoot, "resource_packs", resourcePackFolderName),
        );
    }
    await removeFilesNamed(workspaceRoot, ".gitkeep");

    await writeJson(
        path.join(workspaceRoot, "manifest.json"),
        toWorldTemplateManifest(config, worldName),
    );
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

    if (config.packs.behavior) {
        await syncPackReferenceFile(
            path.join(workspaceRoot, "world_behavior_packs.json"),
            config.packs.behavior.headerUuid,
            includeSelection.behaviorPack
                ? {
                      pack_id: config.packs.behavior.headerUuid,
                      version: config.packs.behavior.version,
                  }
                : undefined,
        );
    }
    if (config.packs.resource) {
        await syncPackReferenceFile(
            path.join(workspaceRoot, "world_resource_packs.json"),
            config.packs.resource.headerUuid,
            includeSelection.resourcePack
                ? {
                      pack_id: config.packs.resource.headerUuid,
                      version: config.packs.resource.version,
                  }
                : undefined,
        );
    }

    const archive = new AdmZip();
    archive.addLocalFolder(workspaceRoot, "world_template");
    await removeDirectory(outputFile);
    archive.writeZip(outputFile);

    return {
        workspaceRoot,
        outputFile,
    };
}

export async function runPackageCommand(
    requestedTarget: string | undefined,
    options: PackageCommandOptions,
): Promise<void> {
    const { projectRoot, config } = await loadBlurConfig(process.cwd());
    const debug = createDebugLogger(resolveDebugEnabled(options.debug));
    const production = Boolean(options.production);
    const selectedWorld = resolveSelectedWorld(config, options.world);
    const includeSelection = resolvePackFeatureSelection(
        config.automation.package.worldTemplate.include,
        {
            behaviorPack: options.includeBehaviorPack,
            resourcePack: options.includeResourcePack,
        },
    );
    const target =
        requestedTarget ??
        config.package.defaultTarget ??
        (SUPPORTED_PACKAGE_TARGETS.length === 1
            ? SUPPORTED_PACKAGE_TARGETS[0]
            : undefined);

    if (!target) {
        throw new Error(
            "No package target was provided and blr.config.json does not define package.defaultTarget.",
        );
    }

    if (!SUPPORTED_PACKAGE_TARGETS.includes(target as PackageTarget)) {
        throw new Error(
            `Unsupported package target "${target}". Supported targets: ${SUPPORTED_PACKAGE_TARGETS.join(", ")}.`,
        );
    }

    debug.log("package", "resolved package command", {
        projectRoot,
        target,
        production,
        selectedWorld,
        includeSelection,
        requestedTarget: requestedTarget ?? null,
        defaultTarget: config.package.defaultTarget ?? null,
    });

    if (target === "world-template") {
        try {
            await assertValidProjectWorldSource(
                projectRoot,
                selectedWorld.worldSourcePath,
                "package world-template",
            );
        } catch (error) {
            const message =
                error instanceof Error ? error.message : String(error);
            throw new Error(
                appendWorldSourceHint(config, selectedWorld.worldName, message),
            );
        }
    }

    await buildProject(projectRoot, config, { production, debug });

    const packaged = await packageWorldTemplate(
        projectRoot,
        config,
        selectedWorld.worldName,
        selectedWorld.worldSourcePath,
        includeSelection,
    );
    console.log(
        `[package] Created ${path.relative(projectRoot, packaged.outputFile)} from ${path.relative(projectRoot, packaged.workspaceRoot)}`,
    );
}
