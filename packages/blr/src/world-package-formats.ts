import type { WorldPackageFormat } from "./types.js";

export const DEFAULT_WORLD_PACKAGE_FORMAT: WorldPackageFormat = "tar.gz";

export const SUPPORTED_WORLD_PACKAGE_FORMATS = [
    "tar.gz",
    "zip",
    "mcworld",
] as const satisfies readonly WorldPackageFormat[];

const WORLD_PACKAGE_FORMAT_SET = new Set<string>(
    SUPPORTED_WORLD_PACKAGE_FORMATS,
);

export function isWorldPackageFormat(
    value: unknown,
): value is WorldPackageFormat {
    return typeof value === "string" && WORLD_PACKAGE_FORMAT_SET.has(value);
}

export function formatSupportedWorldPackageFormats(): string {
    return SUPPORTED_WORLD_PACKAGE_FORMATS.join(", ");
}
