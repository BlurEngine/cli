import path from "node:path";
import { assertProjectRelativePath } from "../project-paths.js";
import type {
    BlurConfigWorldProcessorFile,
    ResolvedWorldProcessorConfig,
    WorldProcessorApplyOn,
    WorldProcessorCapability,
} from "../types.js";
import { assertValidWorldName } from "../world.js";

const PORTABLE_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const CAPABILITIES = new Set<WorldProcessorCapability>([
    "observer",
    "artifact",
    "transform",
]);

export function normalizeWorldProcessorConfigs(
    input: unknown,
    projectRoot: string,
    source = "worldProcessors",
): readonly ResolvedWorldProcessorConfig[] {
    if (input === undefined) return Object.freeze([]);
    if (!Array.isArray(input)) {
        throw new Error(`${source} must be an array.`);
    }

    const ids = new Set<string>();
    const outputOwners = new Map<string, string>();
    const configs = input.map((value, index) => {
        const itemSource = `${source}[${index}]`;
        const record = expectRecord(value, itemSource);
        const id = expectPortableId(record.id, `${itemSource}.id`);
        if (ids.has(id)) {
            throw new Error(`Duplicate world processor id "${id}".`);
        }
        ids.add(id);

        const capabilities = normalizeCapabilities(
            record.capabilities,
            `${itemSource}.capabilities`,
        );
        const outputRoot = normalizeOptionalProjectPath(
            record.outputRoot,
            projectRoot,
            `${itemSource}.outputRoot`,
        );
        const payloadFileNames = normalizePayloadFileNames(
            record.payloadFileNames,
            projectRoot,
            itemSource,
        );
        if (capabilities.includes("artifact") && !outputRoot) {
            throw new Error(
                `${itemSource}.outputRoot is required for artifact processors.`,
            );
        }
        if (
            capabilities.includes("artifact") &&
            Object.keys(payloadFileNames).length === 0
        ) {
            throw new Error(
                `${itemSource}.payloadFileNames must declare at least one artifact payload.`,
            );
        }

        const runtimePointerPath = normalizeOptionalProjectPath(
            record.runtimePointerPath,
            projectRoot,
            `${itemSource}.runtimePointerPath`,
        );
        if (
            runtimePointerPath !== undefined &&
            !runtimePointerPath.endsWith(".ts") &&
            !runtimePointerPath.endsWith(".json")
        ) {
            throw new Error(
                `${itemSource}.runtimePointerPath must end in .ts or .json.`,
            );
        }
        const auditOutputPath = normalizeOptionalProjectPath(
            record.auditOutputPath,
            projectRoot,
            `${itemSource}.auditOutputPath`,
        );
        const config: ResolvedWorldProcessorConfig = Object.freeze({
            id,
            module: normalizeModule(record.module, projectRoot, itemSource),
            export:
                expectOptionalNonEmptyString(
                    record.export,
                    `${itemSource}.export`,
                ) ?? "default",
            sourceWorld: assertValidWorldName(
                expectNonEmptyString(
                    record.sourceWorld,
                    `${itemSource}.sourceWorld`,
                ),
                `${itemSource}.sourceWorld`,
            ),
            capabilities: Object.freeze(capabilities),
            dependsOn: Object.freeze(
                normalizeStringArray(
                    record.dependsOn,
                    `${itemSource}.dependsOn`,
                ).map((dependency, dependencyIndex) =>
                    expectPortableId(
                        dependency,
                        `${itemSource}.dependsOn[${dependencyIndex}]`,
                    ),
                ),
            ),
            inputPaths: Object.freeze(
                normalizeStringArray(
                    record.inputPaths,
                    `${itemSource}.inputPaths`,
                ).map((inputPath, inputIndex) =>
                    assertProjectRelativePath(
                        projectRoot,
                        inputPath,
                        `${itemSource}.inputPaths[${inputIndex}]`,
                    ),
                ),
            ),
            ...(outputRoot ? { outputRoot } : {}),
            payloadFileNames: Object.freeze(payloadFileNames),
            ...(runtimePointerPath ? { runtimePointerPath } : {}),
            ...(auditOutputPath ? { auditOutputPath } : {}),
            applyOn: Object.freeze(
                normalizeApplyOn(record.applyOn, `${itemSource}.applyOn`),
            ),
        });

        for (const payloadPath of Object.values(payloadFileNames)) {
            claimOutput(
                outputOwners,
                path.posix.join(outputRoot ?? "", payloadPath),
                id,
            );
        }
        if (runtimePointerPath) {
            claimOutput(outputOwners, runtimePointerPath, id);
        }
        if (auditOutputPath) {
            claimOutput(outputOwners, auditOutputPath, id);
        }
        return config;
    });

    for (const config of configs) {
        for (const dependency of config.dependsOn) {
            if (!ids.has(dependency)) {
                throw new Error(
                    `World processor "${config.id}" depends on unknown processor "${dependency}".`,
                );
            }
            if (dependency === config.id) {
                throw new Error(
                    `World processor "${config.id}" cannot depend on itself.`,
                );
            }
        }
    }
    return Object.freeze(configs);
}

function normalizeModule(
    input: unknown,
    projectRoot: string,
    source: string,
): string {
    const value = expectNonEmptyString(input, `${source}.module`);
    if (value.startsWith("./")) {
        return `./${assertProjectRelativePath(projectRoot, value.slice(2), `${source}.module`)}`;
    }
    if (
        value.startsWith(".") ||
        value.startsWith("/") ||
        value.startsWith("file:") ||
        path.isAbsolute(value)
    ) {
        throw new Error(
            `${source}.module must be an explicit ./ project module or a bare package specifier.`,
        );
    }
    return value;
}

function normalizeCapabilities(
    input: unknown,
    source: string,
): WorldProcessorCapability[] {
    if (input === undefined) return ["artifact"];
    if (!Array.isArray(input) || input.length === 0) {
        throw new Error(`${source} must be a non-empty array.`);
    }
    const values: WorldProcessorCapability[] = [];
    for (const [index, value] of input.entries()) {
        if (!CAPABILITIES.has(value as WorldProcessorCapability)) {
            throw new Error(
                `${source}[${index}] must be observer, artifact, or transform.`,
            );
        }
        if (!values.includes(value as WorldProcessorCapability)) {
            values.push(value as WorldProcessorCapability);
        }
    }
    return values;
}

function normalizePayloadFileNames(
    input: unknown,
    projectRoot: string,
    source: string,
): Record<string, string> {
    if (input === undefined) return {};
    const record = expectRecord(input, `${source}.payloadFileNames`);
    const result: Record<string, string> = {};
    const paths = new Set<string>();
    for (const [artifactId, fileNameInput] of Object.entries(record)) {
        expectPortableId(artifactId, `${source}.payloadFileNames key`);
        const fileName = assertProjectRelativePath(
            projectRoot,
            expectNonEmptyString(
                fileNameInput,
                `${source}.payloadFileNames.${artifactId}`,
            ),
            `${source}.payloadFileNames.${artifactId}`,
        );
        if (fileName === "manifest.json" || fileName.startsWith("sets/")) {
            throw new Error(
                `${source}.payloadFileNames.${artifactId} uses a reserved artifact path.`,
            );
        }
        if (paths.has(fileName)) {
            throw new Error(
                `${source}.payloadFileNames contains duplicate path "${fileName}".`,
            );
        }
        paths.add(fileName);
        result[artifactId] = fileName;
    }
    return result;
}

function normalizeApplyOn(
    input: unknown,
    source: string,
): WorldProcessorApplyOn {
    const defaults: WorldProcessorApplyOn = {
        dev: true,
        build: true,
        package: true,
        check: true,
        worldBuild: true,
        worldPush: true,
    };
    if (input === undefined) return defaults;
    const record = expectRecord(input, source);
    return {
        dev: expectOptionalBoolean(record.dev, `${source}.dev`) ?? defaults.dev,
        build:
            expectOptionalBoolean(record.build, `${source}.build`) ??
            defaults.build,
        package:
            expectOptionalBoolean(record.package, `${source}.package`) ??
            defaults.package,
        check:
            expectOptionalBoolean(record.check, `${source}.check`) ??
            defaults.check,
        worldBuild:
            expectOptionalBoolean(record.worldBuild, `${source}.worldBuild`) ??
            defaults.worldBuild,
        worldPush:
            expectOptionalBoolean(record.worldPush, `${source}.worldPush`) ??
            defaults.worldPush,
    };
}

function claimOutput(
    owners: Map<string, string>,
    outputPath: string,
    id: string,
): void {
    const owner = owners.get(outputPath);
    if (owner && owner !== id) {
        throw new Error(
            `world processor output path "${outputPath}" is claimed by both "${owner}" and "${id}".`,
        );
    }
    owners.set(outputPath, id);
}

function normalizeOptionalProjectPath(
    input: unknown,
    projectRoot: string,
    source: string,
): string | undefined {
    const value = expectOptionalNonEmptyString(input, source);
    return value === undefined
        ? undefined
        : assertProjectRelativePath(projectRoot, value, source);
}

function normalizeStringArray(input: unknown, source: string): string[] {
    if (input === undefined) return [];
    if (!Array.isArray(input)) throw new Error(`${source} must be an array.`);
    return input.map((value, index) =>
        expectNonEmptyString(value, `${source}[${index}]`),
    );
}

function expectPortableId(input: unknown, source: string): string {
    const value = expectNonEmptyString(input, source);
    if (!PORTABLE_ID.test(value) || WINDOWS_RESERVED.test(value)) {
        throw new Error(
            `${source} must be one portable lowercase segment using letters, digits, underscores, or hyphens.`,
        );
    }
    return value;
}

function expectRecord(input: unknown, source: string): Record<string, unknown> {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
        throw new Error(`${source} must be an object.`);
    }
    return input as Record<string, unknown>;
}

function expectNonEmptyString(input: unknown, source: string): string {
    if (typeof input !== "string" || input.trim().length === 0) {
        throw new Error(`${source} must be a non-empty string.`);
    }
    return input.trim();
}

function expectOptionalNonEmptyString(
    input: unknown,
    source: string,
): string | undefined {
    return input === undefined
        ? undefined
        : expectNonEmptyString(input, source);
}

function expectOptionalBoolean(
    input: unknown,
    source: string,
): boolean | undefined {
    if (input === undefined) return undefined;
    if (typeof input !== "boolean")
        throw new Error(`${source} must be a boolean.`);
    return input;
}
