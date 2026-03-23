import path from "node:path";
import { exists, readText } from "./fs.js";

const DOT_ENV_LOCAL_FILE = ".env.local";
const loadedEnvironmentFiles = new Set<string>();

function isValidEnvironmentKey(value: string): boolean {
    return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

function stripInlineComment(value: string): string {
    let escaped = false;
    for (let index = 0; index < value.length; index += 1) {
        const character = value[index];
        if (escaped) {
            escaped = false;
            continue;
        }
        if (character === "\\") {
            escaped = true;
            continue;
        }
        if (character === "#") {
            const previous = index === 0 ? "" : value[index - 1];
            if (/\s/.test(previous) || index === 0) {
                return value.slice(0, index).trimEnd();
            }
        }
    }
    return value.trim();
}

function parseEnvironmentValue(rawValue: string): string {
    const trimmed = rawValue.trim();
    if (
        (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
        (trimmed.startsWith("'") && trimmed.endsWith("'"))
    ) {
        const quote = trimmed[0];
        const inner = trimmed.slice(1, -1);
        if (quote === '"') {
            return inner
                .replace(/\\n/g, "\n")
                .replace(/\\r/g, "\r")
                .replace(/\\t/g, "\t")
                .replace(/\\"/g, '"')
                .replace(/\\\\/g, "\\");
        }
        return inner.replace(/\\'/g, "'").replace(/\\\\/g, "\\");
    }

    return stripInlineComment(trimmed);
}

function parseEnvironmentLine(
    line: string,
    lineNumber: number,
    filePath: string,
): [string, string] | undefined {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) {
        return undefined;
    }

    const withoutExport = trimmed.startsWith("export ")
        ? trimmed.slice(7).trimStart()
        : trimmed;
    const separatorIndex = withoutExport.indexOf("=");
    if (separatorIndex <= 0) {
        throw new Error(
            `${filePath}:${lineNumber} contains an invalid environment assignment.`,
        );
    }

    const key = withoutExport.slice(0, separatorIndex).trim();
    if (!isValidEnvironmentKey(key)) {
        throw new Error(
            `${filePath}:${lineNumber} contains an invalid environment variable name "${key}".`,
        );
    }

    const rawValue = withoutExport.slice(separatorIndex + 1);
    return [key, parseEnvironmentValue(rawValue)];
}

async function loadEnvironmentFile(filePath: string): Promise<void> {
    if (loadedEnvironmentFiles.has(filePath)) {
        return;
    }

    const content = await readText(filePath);
    const normalized = content.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
    const lines = normalized.split("\n");

    for (let index = 0; index < lines.length; index += 1) {
        const parsed = parseEnvironmentLine(
            lines[index] ?? "",
            index + 1,
            filePath,
        );
        if (!parsed) {
            continue;
        }

        const [key, value] = parsed;
        if (typeof process.env[key] === "undefined") {
            process.env[key] = value;
        }
    }

    loadedEnvironmentFiles.add(filePath);
}

export async function loadClosestDotEnvLocal(
    startDirectory: string,
): Promise<string | undefined> {
    let current = path.resolve(startDirectory);

    while (true) {
        const candidate = path.join(current, DOT_ENV_LOCAL_FILE);
        if (await exists(candidate)) {
            await loadEnvironmentFile(candidate);
            return candidate;
        }

        const parent = path.dirname(current);
        if (parent === current) {
            return undefined;
        }
        current = parent;
    }
}
