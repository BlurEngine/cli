import { createHash } from "node:crypto";
import { copyFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import AdmZip from "adm-zip";
import { resolvePackFeatureSelection } from "../content.js";
import { loadBlurConfig } from "../config.js";
import { createDebugLogger, resolveDebugEnabled } from "../debug.js";
import {
    copyDirectory,
    ensureDirectory,
    ensureParentDirectory,
    exists,
    readJson,
    removeDirectory,
    removeFilesNamed,
    writeJson,
} from "../fs.js";
import { DEFAULT_PACK_VERSION } from "../constants.js";
import {
    DEFAULT_PACKAGE_TARGET,
    formatSupportedPackageTargets,
    isPackageTarget,
    PACKAGE_TARGETS_REQUIRING_WORLD,
} from "../package-targets.js";
import {
    buildProject,
    resolveBuildArtifacts,
    type ResolvedBuildArtifacts,
} from "../runtime.js";
import { writeTarGzipFromDirectory } from "../tar-gzip.js";
import type {
    BlurProject,
    PackageTarget,
    VersionTuple,
    WorldPackageFormat,
} from "../types.js";
import {
    appendWorldSourceHint,
    assertValidProjectWorldSource,
    resolveSelectedWorld,
    resolveProjectWorldSourceDirectory,
} from "../world.js";
import {
    DEFAULT_WORLD_PACKAGE_FORMAT,
    formatSupportedWorldPackageFormats,
    isWorldPackageFormat,
} from "../world-package-formats.js";
import {
    exportWorldImage,
    normalizeWorldImageFileName,
    type ExportedWorldImageFile,
    type ExportWorldImageResult,
} from "../world-image.js";

type PackageCommandOptions = {
    production?: boolean;
    world?: string;
    worldFormat?: string;
    includeBehaviorPack?: boolean;
    includeResourcePack?: boolean;
    debug?: boolean;
};

type StandalonePackKind = "behavior" | "resource";
type WorkspacePackageTarget = Exclude<PackageTarget, "world" | "assets">;

type PackageTargetDefinition = {
    workspaceDirectoryName: string;
    outputExtension: "mctemplate" | "mcworld" | "mcaddon" | "mcpack";
    archiveRoot?: string;
    includeWorld: boolean;
    writeWorldTemplateManifest: boolean;
    standalonePack?: StandalonePackKind;
};

const PACKAGE_TARGET_DEFINITIONS: Record<
    WorkspacePackageTarget,
    PackageTargetDefinition
> = {
    mctemplate: {
        workspaceDirectoryName: "world_template",
        outputExtension: "mctemplate",
        archiveRoot: "world_template",
        includeWorld: true,
        writeWorldTemplateManifest: true,
    },
    mcworld: {
        workspaceDirectoryName: "mcworld",
        outputExtension: "mcworld",
        includeWorld: true,
        writeWorldTemplateManifest: false,
    },
    mcaddon: {
        workspaceDirectoryName: "mcaddon",
        outputExtension: "mcaddon",
        includeWorld: false,
        writeWorldTemplateManifest: false,
    },
    "behavior-pack": {
        workspaceDirectoryName: "behavior_pack",
        outputExtension: "mcpack",
        includeWorld: false,
        writeWorldTemplateManifest: false,
        standalonePack: "behavior",
    },
    "resource-pack": {
        workspaceDirectoryName: "resource_pack",
        outputExtension: "mcpack",
        includeWorld: false,
        writeWorldTemplateManifest: false,
        standalonePack: "resource",
    },
};

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

type AssetsPackageManifest = {
    schemaVersion: 1;
    assets: Array<{
        type: "world-image";
        variant: string;
        worldName: string;
        dimension: string;
        path: string;
        width: number;
        height: number;
        processedWorld: ExportWorldImageResult["processedWorld"];
        chunkCount: number;
        columnCount: number;
        minHeight: number;
        maxHeight: number;
        terrainColumnCount?: number;
        terrainDiagnostics?: ExportWorldImageResult["terrainDiagnostics"];
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
                `${config.project.packageName}:mctemplate:${worldName}:header`,
            ),
        },
        modules: [
            {
                version,
                type: "world_template",
                uuid: createDeterministicUuid(
                    `${config.project.packageName}:mctemplate:${worldName}:module`,
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

function createPackageOutputBaseName(
    config: BlurProject,
    worldName: string,
    includeWorld: boolean,
): string {
    if (!includeWorld || worldName === config.dev.localServer.worldName) {
        return config.project.packName;
    }

    return `${config.project.packName}-${worldName.replace(/[<>:"/\\|?*\x00-\x1F]+/g, "-")}`;
}

function createStandalonePackOutputBaseName(
    packName: string,
    packKind: StandalonePackKind,
): string {
    return `${packName}-${packKind}`;
}

function createWorldPackageOutputBaseName(worldName: string): string {
    return `${worldName.replace(/[<>:"/\\|?*\x00-\x1F]+/g, "-")}-world`;
}

function resolveWorldPackageFormat(
    requestedFormat: string | undefined,
    config: BlurProject,
): WorldPackageFormat {
    const normalizedRequestedFormat = requestedFormat?.trim();
    if (normalizedRequestedFormat) {
        if (isWorldPackageFormat(normalizedRequestedFormat)) {
            return normalizedRequestedFormat;
        }

        throw new Error(
            `Unsupported world package format "${normalizedRequestedFormat}". Supported formats: ${formatSupportedWorldPackageFormats()}.`,
        );
    }

    return config.package.world.format ?? DEFAULT_WORLD_PACKAGE_FORMAT;
}

const WORLD_PACKAGE_IGNORED_FILE_NAMES = new Set([
    ".ds_store",
    ".gitkeep",
    "thumbs.db",
]);

const WORLD_PACKAGE_IGNORED_DIRECTORY_NAMES = new Set([
    ".world_backup",
    ".world_backups",
    "backup",
    "backups",
    "world_backup",
    "world_backups",
    "worlds_backup",
    "worlds_backups",
]);

function isTimestampedWorldBackupDirectory(entryName: string): boolean {
    return /\.\d{8}T\d{6}Z(?:-\d+)?$/i.test(entryName);
}

function shouldSkipWorldPackageEntry(
    entryName: string,
    isDirectory: boolean,
): boolean {
    const normalized = entryName.toLowerCase();
    if (WORLD_PACKAGE_IGNORED_FILE_NAMES.has(normalized)) {
        return true;
    }
    if (normalized.includes(".blr-backup-")) {
        return true;
    }
    if (
        isDirectory &&
        (WORLD_PACKAGE_IGNORED_DIRECTORY_NAMES.has(normalized) ||
            isTimestampedWorldBackupDirectory(entryName))
    ) {
        return true;
    }
    return normalized.endsWith(".bak") || normalized.endsWith(".tmp");
}

async function copyRawWorldPackageDirectory(
    sourcePath: string,
    destinationPath: string,
): Promise<void> {
    await ensureDirectory(destinationPath);

    const entries = await readdir(sourcePath, { withFileTypes: true });
    for (const entry of entries) {
        if (shouldSkipWorldPackageEntry(entry.name, entry.isDirectory())) {
            continue;
        }

        const sourceEntryPath = path.join(sourcePath, entry.name);
        const destinationEntryPath = path.join(destinationPath, entry.name);

        if (entry.isDirectory()) {
            await copyRawWorldPackageDirectory(
                sourceEntryPath,
                destinationEntryPath,
            );
            continue;
        }

        const entryStat = await stat(sourceEntryPath);
        if (entryStat.isDirectory()) {
            await copyRawWorldPackageDirectory(
                sourceEntryPath,
                destinationEntryPath,
            );
            continue;
        }

        if (entryStat.isFile()) {
            await ensureParentDirectory(destinationEntryPath);
            await copyFile(sourceEntryPath, destinationEntryPath);
        }
    }
}

async function writeWorldPackageArchive(
    workspaceRoot: string,
    outputFile: string,
    format: WorldPackageFormat,
): Promise<void> {
    if (format === "tar.gz") {
        await writeTarGzipFromDirectory(workspaceRoot, outputFile);
        return;
    }

    const archive = new AdmZip();
    archive.addLocalFolder(workspaceRoot);
    await ensureParentDirectory(outputFile);
    archive.writeZip(outputFile);
}

async function packageRawWorldTarget(
    projectRoot: string,
    config: BlurProject,
    worldName: string,
    worldSourcePath: string,
    format: WorldPackageFormat,
): Promise<{
    workspaceRoot: string;
    outputFile: string;
}> {
    const artifacts = resolveBuildArtifacts(projectRoot, config);
    const workspaceRoot = path.join(artifacts.packagesRoot, "world");
    const outputFile = path.join(
        artifacts.packagesRoot,
        `${createWorldPackageOutputBaseName(worldName)}.${format}`,
    );

    await removeDirectory(workspaceRoot);
    await ensureDirectory(artifacts.packagesRoot);
    await copyRawWorldPackageDirectory(
        resolveProjectWorldSourceDirectory(projectRoot, worldSourcePath),
        workspaceRoot,
    );
    await removeDirectory(outputFile);
    await writeWorldPackageArchive(workspaceRoot, outputFile, format);

    return {
        workspaceRoot,
        outputFile,
    };
}

async function packageAssetsTarget(
    projectRoot: string,
    config: BlurProject,
    worldName: string,
    worldSourcePath: string,
): Promise<{
    workspaceRoot: string;
    outputFile: string;
}> {
    const artifacts = resolveBuildArtifacts(projectRoot, config);
    const workspaceRoot = path.join(artifacts.packagesRoot, "assets");
    const outputFile = path.join(artifacts.packagesRoot, "assets.zip");
    const manifest: AssetsPackageManifest = {
        schemaVersion: 1,
        assets: [],
    };

    await removeDirectory(workspaceRoot);
    await ensureDirectory(workspaceRoot);
    await ensureDirectory(artifacts.packagesRoot);

    if (config.package.assets.worldImage.enabled) {
        const fileName = normalizeWorldImageFileName(
            config.package.assets.worldImage.fileName,
            "package.assets.worldImage.fileName",
        );
        const imageOutputPath = path.join(
            workspaceRoot,
            "worlds",
            worldName,
            fileName,
        );
        const exported = await exportWorldImage({
            worldSourceDirectory: resolveProjectWorldSourceDirectory(
                projectRoot,
                worldSourcePath,
            ),
            outputPath: imageOutputPath,
            dimension: config.package.assets.worldImage.dimension,
            scale: config.package.assets.worldImage.scale,
        });
        for (const output of exported.outputs) {
            manifest.assets.push(
                toWorldImageAssetManifestEntry(
                    workspaceRoot,
                    worldName,
                    exported,
                    output,
                ),
            );
        }
    }

    await writeJson(path.join(workspaceRoot, "assets.json"), manifest);

    const archive = new AdmZip();
    archive.addLocalFolder(workspaceRoot);
    await removeDirectory(outputFile);
    archive.writeZip(outputFile);

    return {
        workspaceRoot,
        outputFile,
    };
}

function toWorldImageAssetManifestEntry(
    workspaceRoot: string,
    worldName: string,
    exported: ExportWorldImageResult,
    output: ExportedWorldImageFile,
): AssetsPackageManifest["assets"][number] {
    return {
        type: "world-image",
        variant: output.variant,
        worldName,
        dimension: exported.dimension,
        path: path
            .relative(workspaceRoot, output.outputPath)
            .replace(/\\/g, "/"),
        width: output.width,
        height: output.height,
        processedWorld: exported.processedWorld,
        chunkCount: exported.chunkCount,
        columnCount: exported.columnCount,
        minHeight: exported.minHeight,
        maxHeight: exported.maxHeight,
        ...(output.variant === "terrain"
            ? {
                  terrainColumnCount: exported.terrainColumnCount,
                  terrainDiagnostics: exported.terrainDiagnostics,
              }
            : {}),
    };
}

async function copySelectedProjectPacks(
    artifacts: ResolvedBuildArtifacts,
    workspaceRoot: string,
    includeSelection: {
        behaviorPack: boolean;
        resourcePack: boolean;
    },
): Promise<{
    behaviorPackIncluded: boolean;
    resourcePackIncluded: boolean;
}> {
    const behaviorPackFolderName = artifacts.behaviorPackName
        ? createWorldTemplatePackFolderName(artifacts.behaviorPackName, "bp")
        : undefined;
    const resourcePackFolderName = artifacts.resourcePackName
        ? createWorldTemplatePackFolderName(artifacts.resourcePackName, "rp")
        : undefined;
    let behaviorPackIncluded = false;
    let resourcePackIncluded = false;

    if (
        includeSelection.behaviorPack &&
        artifacts.stageBehaviorPackDirectory &&
        behaviorPackFolderName
    ) {
        await copyDirectory(
            artifacts.stageBehaviorPackDirectory,
            path.join(workspaceRoot, "behavior_packs", behaviorPackFolderName),
        );
        behaviorPackIncluded = true;
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
        resourcePackIncluded = true;
    }

    return {
        behaviorPackIncluded,
        resourcePackIncluded,
    };
}

async function syncPackReferenceFile(
    filePath: string,
    packId: string,
    nextEntry?: Record<string, unknown>,
): Promise<void> {
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
}

async function syncWorldPackReferences(
    config: BlurProject,
    workspaceRoot: string,
    includeSelection: {
        behaviorPack: boolean;
        resourcePack: boolean;
    },
): Promise<void> {
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
}

function addWorkspaceToArchive(
    archive: AdmZip,
    workspaceRoot: string,
    archiveRoot: string | undefined,
): void {
    if (archiveRoot) {
        archive.addLocalFolder(workspaceRoot, archiveRoot);
        return;
    }

    archive.addLocalFolder(workspaceRoot);
}

async function packageProjectTarget(
    target: WorkspacePackageTarget,
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
    const targetDefinition = PACKAGE_TARGET_DEFINITIONS[target];
    const artifacts = resolveBuildArtifacts(projectRoot, config);
    const workspaceRoot = path.join(
        artifacts.packagesRoot,
        targetDefinition.workspaceDirectoryName,
    );
    const standalonePackName =
        targetDefinition.standalonePack === "behavior"
            ? artifacts.behaviorPackName
            : targetDefinition.standalonePack === "resource"
              ? artifacts.resourcePackName
              : undefined;
    const outputBaseName = targetDefinition.standalonePack
        ? createStandalonePackOutputBaseName(
              standalonePackName ?? config.project.packName,
              targetDefinition.standalonePack,
          )
        : createPackageOutputBaseName(
              config,
              worldName,
              targetDefinition.includeWorld,
          );
    const outputFile = path.join(
        artifacts.packagesRoot,
        `${outputBaseName}.${targetDefinition.outputExtension}`,
    );

    await removeDirectory(workspaceRoot);
    await ensureDirectory(artifacts.packagesRoot);
    if (targetDefinition.standalonePack) {
        const packSource =
            targetDefinition.standalonePack === "behavior"
                ? artifacts.stageBehaviorPackDirectory
                : artifacts.stageResourcePackDirectory;
        if (!packSource || !standalonePackName) {
            throw new Error(
                `Cannot package ${target} because no staged ${targetDefinition.standalonePack} pack is available.`,
            );
        }
        await copyDirectory(packSource, workspaceRoot);
    } else {
        if (targetDefinition.includeWorld) {
            await copyDirectory(
                resolveProjectWorldSourceDirectory(
                    projectRoot,
                    worldSourcePath,
                ),
                workspaceRoot,
            );
        } else {
            await ensureDirectory(workspaceRoot);
        }

        const copiedPacks = await copySelectedProjectPacks(
            artifacts,
            workspaceRoot,
            includeSelection,
        );

        if (
            target === "mcaddon" &&
            !copiedPacks.behaviorPackIncluded &&
            !copiedPacks.resourcePackIncluded
        ) {
            throw new Error(
                "Cannot package mcaddon because no staged packs are selected for inclusion.",
            );
        }
    }

    await removeFilesNamed(workspaceRoot, ".gitkeep");

    if (targetDefinition.writeWorldTemplateManifest) {
        await writeJson(
            path.join(workspaceRoot, "manifest.json"),
            toWorldTemplateManifest(config, worldName),
        );
    }

    if (targetDefinition.includeWorld) {
        await syncWorldPackReferences(config, workspaceRoot, includeSelection);
    }

    const archive = new AdmZip();
    addWorkspaceToArchive(archive, workspaceRoot, targetDefinition.archiveRoot);
    await removeDirectory(outputFile);
    archive.writeZip(outputFile);

    return {
        workspaceRoot,
        outputFile,
    };
}

function normalizeRequestedPackageTargets(
    requestedTargets: string | string[] | undefined,
): string[] {
    if (Array.isArray(requestedTargets)) {
        return requestedTargets
            .map((target) => target.trim())
            .filter((target) => target.length > 0);
    }
    const requestedTarget = requestedTargets?.trim() ?? "";
    return requestedTarget.length > 0 ? [requestedTarget] : [];
}

function parsePackageTargets(values: string[]): PackageTarget[] {
    const targets: PackageTarget[] = [];
    const seen = new Set<PackageTarget>();

    for (const value of values) {
        if (!isPackageTarget(value)) {
            throw new Error(
                `Unsupported package target "${value}". Supported targets: ${formatSupportedPackageTargets()}.`,
            );
        }

        if (!seen.has(value)) {
            targets.push(value);
            seen.add(value);
        }
    }

    return targets;
}

function resolvePackageTargets(
    requestedTargets: string | string[] | undefined,
    config: BlurProject,
): PackageTarget[] {
    const normalizedRequestedTargets =
        normalizeRequestedPackageTargets(requestedTargets);
    if (normalizedRequestedTargets.length > 0) {
        return parsePackageTargets(normalizedRequestedTargets);
    }
    if (config.package.defaultTargets?.length) {
        return config.package.defaultTargets;
    }
    if (config.package.defaultTarget) {
        return [config.package.defaultTarget];
    }
    return [DEFAULT_PACKAGE_TARGET];
}

function packageTargetRequiresWorld(
    target: PackageTarget,
    config: BlurProject,
): boolean {
    if (target === "assets") {
        return config.package.assets.worldImage.enabled;
    }

    return (
        PACKAGE_TARGETS_REQUIRING_WORLD as readonly PackageTarget[]
    ).includes(target);
}

export async function runPackageCommand(
    requestedTargets: string | string[] | undefined,
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
    const targets = resolvePackageTargets(requestedTargets, config);
    const worldPackageFormat = resolveWorldPackageFormat(
        options.worldFormat,
        config,
    );

    debug.log("package", "resolved package command", {
        projectRoot,
        targets,
        worldPackageFormat,
        production,
        selectedWorld,
        includeSelection,
        requestedTargets: requestedTargets ?? null,
        defaultTarget: config.package.defaultTarget ?? null,
        defaultTargets: config.package.defaultTargets ?? null,
    });

    if (targets.some((target) => packageTargetRequiresWorld(target, config))) {
        try {
            await assertValidProjectWorldSource(
                projectRoot,
                selectedWorld.worldSourcePath,
                `package ${targets.join(", ")}`,
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

    for (const target of targets) {
        const packaged =
            target === "world"
                ? await packageRawWorldTarget(
                      projectRoot,
                      config,
                      selectedWorld.worldName,
                      selectedWorld.worldSourcePath,
                      worldPackageFormat,
                  )
                : target === "assets"
                  ? await packageAssetsTarget(
                        projectRoot,
                        config,
                        selectedWorld.worldName,
                        selectedWorld.worldSourcePath,
                    )
                  : await packageProjectTarget(
                        target,
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
}
