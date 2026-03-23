import path from "node:path";
import { DEFAULT_PROJECT_WORLDS_ROOT } from "./constants.js";
import { isDirectory } from "./fs.js";
import type { BlurProject } from "./types.js";

export type ResolvedWorldSelection = {
    worldName: string;
    worldSourcePath: string;
};

export function assertValidWorldName(value: string, source: string): string {
    const worldName = value.trim();
    if (worldName.length === 0) {
        throw new Error(`${source} must not be empty.`);
    }
    if (worldName === "." || worldName === "..") {
        throw new Error(`${source} must not be "." or "..".`);
    }
    if (/[<>:"/\\|?*\x00-\x1F]/.test(worldName)) {
        throw new Error(
            `${source} contains characters that are unsafe for a project world name.`,
        );
    }
    if (/[. ]$/.test(worldName)) {
        throw new Error(`${source} must not end with a space or period.`);
    }
    return worldName;
}

export function defaultProjectWorldSourcePath(worldName: string): string {
    return path.posix.join(DEFAULT_PROJECT_WORLDS_ROOT, worldName);
}

function normalizeProjectRelativePath(targetPath: string): string {
    const normalized = targetPath.replace(/\\/g, "/").replace(/\/+/g, "/");
    if (normalized === "/") {
        return normalized;
    }
    return normalized.replace(/\/$/, "");
}

export function resolveConfiguredWorldSourcePath(
    config: BlurProject,
    worldName: string,
): string {
    if (worldName === config.dev.localServer.worldName) {
        return config.dev.localServer.worldSourcePath;
    }
    return defaultProjectWorldSourcePath(worldName);
}

export function resolveSelectedWorld(
    config: BlurProject,
    explicitWorldName?: string,
): ResolvedWorldSelection {
    const worldName = assertValidWorldName(
        explicitWorldName?.trim() || config.dev.localServer.worldName,
        explicitWorldName ? "world" : "dev.localServer.worldName",
    );

    return {
        worldName,
        worldSourcePath: resolveConfiguredWorldSourcePath(config, worldName),
    };
}

export function usesDefaultWorldSourcePath(
    worldName: string,
    worldSourcePath: string,
): boolean {
    return (
        normalizeProjectRelativePath(worldSourcePath) ===
        normalizeProjectRelativePath(defaultProjectWorldSourcePath(worldName))
    );
}

export function resolveProjectWorldSourceDirectory(
    projectRoot: string,
    worldSourcePath: string,
): string {
    return path.resolve(projectRoot, worldSourcePath);
}

export async function assertValidProjectWorldSource(
    projectRoot: string,
    worldSourcePath: string,
    operation: string,
): Promise<string> {
    const worldSourceDirectory = resolveProjectWorldSourceDirectory(
        projectRoot,
        worldSourcePath,
    );
    if (!(await isDirectory(worldSourceDirectory))) {
        throw new Error(
            `Cannot ${operation} because ${worldSourcePath} does not exist as a directory.`,
        );
    }

    const dbDirectory = path.join(worldSourceDirectory, "db");
    if (!(await isDirectory(dbDirectory))) {
        throw new Error(
            `Cannot ${operation} because ${worldSourcePath} does not contain a valid Bedrock world. Expected ${path.posix.join(worldSourcePath.replace(/\\/g, "/"), "db")}.`,
        );
    }

    return worldSourceDirectory;
}

export function appendWorldSourceHint(
    config: BlurProject,
    worldName: string,
    message: string,
): string {
    if (config.world.backend !== "s3") {
        return message;
    }

    return `${message} Run "blr world pull ${worldName}" first to materialize the configured remote world source locally.`;
}
