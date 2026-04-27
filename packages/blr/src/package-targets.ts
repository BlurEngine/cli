import type { PackageTarget } from "./types.js";

export const DEFAULT_PACKAGE_TARGET: PackageTarget = "mctemplate";

export const SUPPORTED_PACKAGE_TARGETS = [
    "mctemplate",
    "mcworld",
    "mcaddon",
] as const satisfies readonly PackageTarget[];

export const PACKAGE_TARGETS_REQUIRING_WORLD = [
    "mctemplate",
    "mcworld",
] as const satisfies readonly PackageTarget[];

const PACKAGE_TARGET_SET = new Set<string>(SUPPORTED_PACKAGE_TARGETS);

export function isPackageTarget(value: unknown): value is PackageTarget {
    return typeof value === "string" && PACKAGE_TARGET_SET.has(value);
}

export function formatSupportedPackageTargets(): string {
    return SUPPORTED_PACKAGE_TARGETS.join(", ");
}
