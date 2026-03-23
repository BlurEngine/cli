import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Language, PackageManager, VersionTuple } from "./types.js";

export function parsePackageManager(
    value: string | undefined,
): PackageManager | undefined {
    if (!value) return undefined;
    if (
        value === "npm" ||
        value === "pnpm" ||
        value === "yarn" ||
        value === "bun"
    )
        return value;
    return undefined;
}

export function parseLanguage(value: string | undefined): Language | undefined {
    if (!value) return undefined;
    if (value === "ts" || value === "js") return value;
    return undefined;
}

export function inferPackageManager(value: string | undefined): PackageManager {
    if (!value) return "npm";
    const normalized = value.split("@")[0];
    return parsePackageManager(normalized) ?? "npm";
}

export function normalizeNamespace(value: string): string {
    return value.trim().toLowerCase();
}

export function assertValidNamespace(namespace: string): void {
    const ok = /^[a-z0-9_]+$/.test(namespace);
    if (!ok) {
        throw new Error(
            "Namespace must match ^[a-z0-9_]+$. Example: my_game, blurengine, test123.",
        );
    }
}

export function toKebabCase(value: string): string {
    return value
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
}

export function toPackageName(value: string): string {
    const kebab = toKebabCase(value);
    return kebab.length > 0 ? kebab : "blurengine-project";
}

export function toPackName(value: string): string {
    const kebab = toKebabCase(value);
    return kebab.length > 0 ? kebab : "blurenginepack";
}

export function resolvePmExecutable(packageManager: PackageManager): string {
    if (process.platform === "win32") {
        return `${packageManager}.cmd`;
    }
    return packageManager;
}

export async function getCliPackageVersion(): Promise<string> {
    try {
        const here = fileURLToPath(new URL(".", import.meta.url));
        const packageJsonPath = path.resolve(here, "..", "package.json");
        const raw = await readFile(packageJsonPath, "utf8");
        const parsed = JSON.parse(raw) as { version?: string };
        return parsed.version ?? "0.1.0";
    } catch {
        return "0.1.0";
    }
}

export function dedupeStrings(values: string[]): string[] {
    const result: string[] = [];
    const seen = new Set<string>();
    for (const value of values) {
        if (seen.has(value)) continue;
        seen.add(value);
        result.push(value);
    }
    return result;
}

export function parseMinecraftVersion(value: string | undefined):
    | {
          normalized: string;
          minEngineVersion: VersionTuple;
      }
    | undefined {
    if (!value) {
        return undefined;
    }

    const trimmed = value.trim();
    const match = /^(\d+)\.(\d+)\.(\d+)(?:\.(\d+))?$/.exec(trimmed);
    if (!match) {
        return undefined;
    }

    return {
        normalized: match[4]
            ? `${match[1]}.${match[2]}.${match[3]}.${match[4]}`
            : `${match[1]}.${match[2]}.${match[3]}`,
        minEngineVersion: [
            Number.parseInt(match[1], 10),
            Number.parseInt(match[2], 10),
            Number.parseInt(match[3], 10),
        ],
    };
}
