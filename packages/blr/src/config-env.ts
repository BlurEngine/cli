type EnvValueKind = "string" | "boolean" | "number" | "stringArray";

type ConfigEnvSpec = {
    path: string[];
    kind: EnvValueKind;
};

const CONFIG_ENV_SPECS: ConfigEnvSpec[] = [
    { path: ["namespace"], kind: "string" },
    { path: ["minecraft", "channel"], kind: "string" },
    { path: ["minecraft", "targetVersion"], kind: "string" },
    { path: ["upgrade", "refreshAgents"], kind: "boolean" },
    { path: ["upgrade", "refreshDependencies"], kind: "boolean" },
    { path: ["world", "backend"], kind: "string" },
    { path: ["world", "s3", "bucket"], kind: "string" },
    { path: ["world", "s3", "region"], kind: "string" },
    { path: ["world", "s3", "endpoint"], kind: "string" },
    { path: ["world", "s3", "keyPrefix"], kind: "string" },
    { path: ["world", "s3", "projectPrefix"], kind: "boolean" },
    { path: ["world", "s3", "forcePathStyle"], kind: "boolean" },
    { path: ["world", "s3", "lockTtlSeconds"], kind: "number" },
    { path: ["package", "defaultTarget"], kind: "string" },
    {
        path: ["package", "worldTemplate", "include", "behaviorPack"],
        kind: "boolean",
    },
    {
        path: ["package", "worldTemplate", "include", "resourcePack"],
        kind: "boolean",
    },
    { path: ["runtime", "entry"], kind: "string" },
    { path: ["runtime", "outFile"], kind: "string" },
    { path: ["runtime", "target"], kind: "string" },
    { path: ["runtime", "sourcemap"], kind: "boolean" },
    { path: ["runtime", "externalModules"], kind: "stringArray" },
    { path: ["dev", "watch", "paths"], kind: "stringArray" },
    { path: ["dev", "watch", "debounceMs"], kind: "number" },
    { path: ["dev", "watch", "scriptsEnabledByDefault"], kind: "boolean" },
    { path: ["dev", "watch", "worldEnabledByDefault"], kind: "boolean" },
    { path: ["dev", "watch", "allowlistEnabledByDefault"], kind: "boolean" },
    { path: ["dev", "localDeploy", "enabledByDefault"], kind: "boolean" },
    { path: ["dev", "localDeploy", "copy", "behaviorPack"], kind: "boolean" },
    { path: ["dev", "localDeploy", "copy", "resourcePack"], kind: "boolean" },
    { path: ["dev", "localServer", "enabledByDefault"], kind: "boolean" },
    { path: ["dev", "localServer", "worldName"], kind: "string" },
    { path: ["dev", "localServer", "worldSourcePath"], kind: "string" },
    { path: ["dev", "localServer", "restartOnWorldChange"], kind: "boolean" },
    { path: ["dev", "localServer", "copy", "behaviorPack"], kind: "boolean" },
    { path: ["dev", "localServer", "copy", "resourcePack"], kind: "boolean" },
    { path: ["dev", "localServer", "attach", "behaviorPack"], kind: "boolean" },
    { path: ["dev", "localServer", "attach", "resourcePack"], kind: "boolean" },
    { path: ["dev", "localServer", "allowlist"], kind: "stringArray" },
    { path: ["dev", "localServer", "operators"], kind: "stringArray" },
    { path: ["dev", "localServer", "defaultPermissionLevel"], kind: "string" },
    { path: ["dev", "localServer", "gamemode"], kind: "string" },
];

function resolveEnvString(name: string): string | undefined {
    const value = process.env[name]?.trim();
    return value && value.length > 0 ? value : undefined;
}

function parseBooleanEnv(name: string, value: string): boolean {
    const normalized = value.trim().toLowerCase();
    if (
        normalized === "true" ||
        normalized === "1" ||
        normalized === "yes" ||
        normalized === "on"
    ) {
        return true;
    }
    if (
        normalized === "false" ||
        normalized === "0" ||
        normalized === "no" ||
        normalized === "off"
    ) {
        return false;
    }
    throw new Error(
        `${name} must be a boolean value. Use true/false, 1/0, yes/no, or on/off.`,
    );
}

function parseNumberEnv(name: string, value: string): number {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
        throw new Error(`${name} must be a numeric value.`);
    }
    return parsed;
}

function parseStringArrayEnv(value: string): string[] {
    return value
        .split(/[\r\n,]+/)
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
}

function parseEnvValue(
    spec: ConfigEnvSpec,
    envName: string,
    value: string,
): unknown {
    switch (spec.kind) {
        case "boolean":
            return parseBooleanEnv(envName, value);
        case "number":
            return parseNumberEnv(envName, value);
        case "stringArray":
            return parseStringArrayEnv(value);
        case "string":
            return value;
        default:
            return value;
    }
}

function ensureObject(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return {};
    }
    return value as Record<string, unknown>;
}

function setNestedValue(
    target: Record<string, unknown>,
    path: string[],
    value: unknown,
): void {
    let current = target;
    for (let index = 0; index < path.length - 1; index += 1) {
        const segment = path[index];
        const next = ensureObject(current[segment]);
        current[segment] = next;
        current = next;
    }
    current[path[path.length - 1]] = value;
}

export function configPathToEnvName(path: string[]): string {
    return `BLR_${path.map((segment) => segment.toUpperCase()).join("_")}`;
}

export function applyBlurConfigEnvironmentOverrides(
    input: Record<string, unknown>,
): Record<string, unknown> {
    const target = { ...input };

    for (const spec of CONFIG_ENV_SPECS) {
        const envName = configPathToEnvName(spec.path);
        const envValue = resolveEnvString(envName);
        if (typeof envValue === "undefined") {
            continue;
        }

        setNestedValue(
            target,
            spec.path,
            parseEnvValue(spec, envName, envValue),
        );
    }

    return target;
}
