import path from "node:path";

const GLOB_SEGMENT_PATTERN = /[*?[\]{}()!+@]/;

function normalizeProjectRelativePath(targetPath: string): string {
    return targetPath
        .replace(/\\/g, "/")
        .replace(/\/+/g, "/")
        .replace(/^\.\//, "");
}

export function assertProjectRelativePath(
    projectRoot: string,
    targetPath: string,
    source: string,
    options: {
        allowEmpty?: boolean;
        allowGlob?: boolean;
    } = {},
): string {
    const trimmed = targetPath.trim();
    if (trimmed.length === 0) {
        if (options.allowEmpty) {
            return "";
        }
        throw new Error(`${source} must not be empty.`);
    }

    if (trimmed.includes("\0")) {
        throw new Error(`${source} must not contain null bytes.`);
    }

    if (path.isAbsolute(trimmed)) {
        throw new Error(
            `${source} must stay within the project and cannot be absolute.`,
        );
    }

    const normalized = normalizeProjectRelativePath(trimmed);
    const segments = normalized
        .split("/")
        .filter((segment) => segment.length > 0);

    if (segments.some((segment) => segment === "..")) {
        throw new Error(
            `${source} must stay within the project and cannot traverse parent directories.`,
        );
    }

    if (
        !options.allowGlob &&
        segments.some((segment) => GLOB_SEGMENT_PATTERN.test(segment))
    ) {
        throw new Error(
            `${source} must be a concrete project-relative path, not a glob pattern.`,
        );
    }

    if (!options.allowGlob) {
        const resolved = path.resolve(projectRoot, normalized);
        const relative = path.relative(projectRoot, resolved);
        if (relative.startsWith("..") || path.isAbsolute(relative)) {
            throw new Error(`${source} must stay within the project root.`);
        }
    }

    return normalized;
}
