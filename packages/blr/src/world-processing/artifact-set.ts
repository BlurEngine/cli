import { randomUUID } from "node:crypto";
import {
    mkdir,
    readFile,
    readdir,
    rename,
    rm,
    stat,
    writeFile,
} from "node:fs/promises";
import path from "node:path";
import type {
    ResolvedWorldProcessorConfig,
    WorldDerivedArtifactSetManifestV1,
    WorldDerivedArtifactSetMemberV1,
    WorldDerivedJsonValue,
    WorldProcessorArtifact,
} from "../world-processing.js";
import type { WorldProcessorExecutionResult } from "./runner.js";
import { canonicalJson, hashCanonicalJson } from "./canonical-json.js";

export type PublishWorldProcessorArtifactSetOptions = {
    readonly projectRoot: string;
    readonly config: ResolvedWorldProcessorConfig;
    readonly execution: WorldProcessorExecutionResult;
    readonly mode: "check" | "bake";
    readonly isCurrent?: () => boolean;
    readonly hooks?: {
        readonly beforePointerReplace?: () => void | Promise<void>;
    };
};

export type PublishedWorldProcessorArtifactSet = {
    readonly status: "current" | "published" | "stale";
    readonly artifactSetId: string;
    readonly manifestContentHash: string;
    readonly setDirectory: string;
    readonly pointerPath?: string;
};

type PreparedPayload = WorldDerivedArtifactSetMemberV1 & {
    readonly bytes: Buffer;
    readonly value: WorldDerivedJsonValue;
};

export async function publishWorldProcessorArtifactSet(
    options: PublishWorldProcessorArtifactSetOptions,
): Promise<PublishedWorldProcessorArtifactSet> {
    const prepared = prepareArtifactSet(options);
    const outputRoot = path.resolve(
        options.projectRoot,
        options.config.outputRoot!,
    );
    const setDirectory = path.join(
        outputRoot,
        "sets",
        prepared.manifest.artifactSetId,
    );
    const pointerPath = options.config.runtimePointerPath
        ? path.resolve(options.projectRoot, options.config.runtimePointerPath)
        : undefined;
    const pointerBytes = pointerPath
        ? Buffer.from(
              renderPointer(
                  pointerPath,
                  setDirectory,
                  prepared.manifest,
                  prepared.manifestContentHash,
                  prepared.payloads,
              ),
          )
        : undefined;
    const setCurrent = await artifactSetMatches(
        setDirectory,
        prepared.payloads,
        prepared.manifestBytes,
    );
    const pointerCurrent = pointerPath
        ? await fileMatches(pointerPath, pointerBytes!)
        : true;

    if (options.mode === "check") {
        return Object.freeze({
            status: setCurrent && pointerCurrent ? "current" : "stale",
            artifactSetId: prepared.manifest.artifactSetId,
            manifestContentHash: prepared.manifestContentHash,
            setDirectory,
            ...(pointerPath ? { pointerPath } : {}),
        });
    }

    if (await pathExists(setDirectory)) {
        if (!setCurrent) {
            throw new Error(
                `Existing immutable artifact set ${prepared.manifest.artifactSetId} does not match its canonical payloads.`,
            );
        }
    } else {
        await publishImmutableSet(
            setDirectory,
            prepared.payloads,
            prepared.manifestBytes,
        );
    }
    if (pointerCurrent) {
        return Object.freeze({
            status: "current",
            artifactSetId: prepared.manifest.artifactSetId,
            manifestContentHash: prepared.manifestContentHash,
            setDirectory,
            ...(pointerPath ? { pointerPath } : {}),
        });
    }
    if (pointerPath && pointerBytes) {
        if (options.isCurrent && !options.isCurrent()) {
            return staleResult();
        }
        await options.hooks?.beforePointerReplace?.();
        if (options.isCurrent && !options.isCurrent()) {
            return staleResult();
        }
        await replacePointer(pointerPath, pointerBytes);
    }
    return Object.freeze({
        status: "published",
        artifactSetId: prepared.manifest.artifactSetId,
        manifestContentHash: prepared.manifestContentHash,
        setDirectory,
        ...(pointerPath ? { pointerPath } : {}),
    });

    function staleResult(): PublishedWorldProcessorArtifactSet {
        return Object.freeze({
            status: "stale",
            artifactSetId: prepared.manifest.artifactSetId,
            manifestContentHash: prepared.manifestContentHash,
            setDirectory,
            ...(pointerPath ? { pointerPath } : {}),
        });
    }
}

function prepareArtifactSet(options: PublishWorldProcessorArtifactSetOptions): {
    readonly payloads: readonly PreparedPayload[];
    readonly manifest: WorldDerivedArtifactSetManifestV1;
    readonly manifestBytes: Buffer;
    readonly manifestContentHash: string;
} {
    if (!options.config.outputRoot) {
        throw new Error(
            `World processor ${options.config.id} has no artifact outputRoot.`,
        );
    }
    if (options.execution.processorId !== options.config.id) {
        throw new Error(
            `Artifact execution ${options.execution.processorId} does not match config ${options.config.id}.`,
        );
    }
    const expectedIds = Object.keys(options.config.payloadFileNames).sort();
    const artifacts = new Map<string, WorldProcessorArtifact>();
    for (const artifact of options.execution.result.artifacts) {
        if (artifacts.has(artifact.id)) {
            throw new Error(
                `World processor returned duplicate artifact ${artifact.id}.`,
            );
        }
        artifacts.set(artifact.id, artifact);
    }
    const actualIds = [...artifacts.keys()].sort();
    if (canonicalJson(actualIds) !== canonicalJson(expectedIds)) {
        throw new Error(
            `World processor ${options.config.id} must return exactly configured payloads ${expectedIds.join(
                ", ",
            )}; received ${actualIds.join(", ") || "none"}.`,
        );
    }
    const payloads = expectedIds.map((id) => {
        const artifact = artifacts.get(id)!;
        const bytes = Buffer.from(canonicalJson(artifact.value));
        return Object.freeze({
            id,
            fileName: options.config.payloadFileNames[id]!,
            contentHash: hashCanonicalJson(artifact.value),
            bytes,
            value: artifact.value,
        });
    });
    const hashes = new Map(
        payloads.map((payload) => [payload.id, payload.contentHash]),
    );
    for (const artifact of artifacts.values()) {
        for (const reference of artifact.hashReferences ?? []) {
            const expectedHash = hashes.get(reference.artifactId);
            if (!expectedHash) {
                throw new Error(
                    `Artifact ${artifact.id} hash reference names unknown artifact ${reference.artifactId}.`,
                );
            }
            const actual = resolveJsonPointer(
                artifact.value,
                reference.jsonPointer,
            );
            if (actual !== expectedHash) {
                throw new Error(
                    `Artifact ${artifact.id} hash reference ${reference.jsonPointer} does not match ${reference.artifactId}.`,
                );
            }
        }
    }
    const members: readonly WorldDerivedArtifactSetMemberV1[] = Object.freeze(
        payloads.map(({ id, fileName, contentHash }) =>
            Object.freeze({ id, fileName, contentHash }),
        ),
    );
    const descriptor = {
        schemaVersion: 1 as const,
        logicalInputHash: options.execution.logicalInputHash,
        providerId: options.config.id,
        providerRevision: options.execution.providerRevision,
        members,
    };
    const artifactSetId = hashCanonicalJson(descriptor);
    const manifest: WorldDerivedArtifactSetManifestV1 = Object.freeze({
        ...descriptor,
        artifactSetId,
    });
    const manifestBytes = Buffer.from(canonicalJson(manifest));
    return Object.freeze({
        payloads: Object.freeze(payloads),
        manifest,
        manifestBytes,
        manifestContentHash: hashCanonicalJson(manifest),
    });
}

async function publishImmutableSet(
    setDirectory: string,
    payloads: readonly PreparedPayload[],
    manifestBytes: Buffer,
): Promise<void> {
    const setsDirectory = path.dirname(setDirectory);
    await mkdir(setsDirectory, { recursive: true });
    const stagingDirectory = path.join(
        setsDirectory,
        `.staging-${path.basename(setDirectory)}-${randomUUID()}`,
    );
    try {
        await mkdir(stagingDirectory, { recursive: false });
        for (const payload of payloads) {
            const outputPath = path.join(stagingDirectory, payload.fileName);
            await mkdir(path.dirname(outputPath), { recursive: true });
            await writeFile(outputPath, payload.bytes, { flag: "wx" });
        }
        await writeFile(
            path.join(stagingDirectory, "manifest.json"),
            manifestBytes,
            { flag: "wx" },
        );
        await rename(stagingDirectory, setDirectory);
    } finally {
        await rm(stagingDirectory, { recursive: true, force: true });
    }
}

async function replacePointer(
    pointerPath: string,
    pointerBytes: Buffer,
): Promise<void> {
    await mkdir(path.dirname(pointerPath), { recursive: true });
    const temporaryPath = path.join(
        path.dirname(pointerPath),
        `.${path.basename(pointerPath)}.${randomUUID()}.tmp`,
    );
    try {
        await writeFile(temporaryPath, pointerBytes, { flag: "wx" });
        await rename(temporaryPath, pointerPath);
    } finally {
        await rm(temporaryPath, { force: true });
    }
}

function renderPointer(
    pointerPath: string,
    setDirectory: string,
    manifest: WorldDerivedArtifactSetManifestV1,
    manifestContentHash: string,
    payloads: readonly PreparedPayload[],
): string {
    if (path.extname(pointerPath).toLowerCase() === ".json") {
        return canonicalJson({
            schemaVersion: manifest.schemaVersion,
            artifactSetId: manifest.artifactSetId,
            logicalInputHash: manifest.logicalInputHash,
            providerId: manifest.providerId,
            providerRevision: manifest.providerRevision,
            manifestContentHash,
            members: Object.fromEntries(
                payloads.map((payload) => [
                    payload.id,
                    {
                        id: payload.id,
                        fileName: payload.fileName,
                        contentHash: payload.contentHash,
                        value: payload.value,
                    },
                ]),
            ),
        });
    }

    const imports = payloads
        .map((payload, index) => {
            const target = path.join(setDirectory, payload.fileName);
            let specifier = path
                .relative(path.dirname(pointerPath), target)
                .replace(/\\/g, "/");
            if (!specifier.startsWith(".")) specifier = `./${specifier}`;
            return `import payload${index} from ${JSON.stringify(
                specifier,
            )} with { type: "json" };`;
        })
        .join("\n");
    const members = payloads
        .map(
            (payload, index) => `        ${JSON.stringify(payload.id)}: {
            id: ${JSON.stringify(payload.id)},
            fileName: ${JSON.stringify(payload.fileName)},
            contentHash: ${JSON.stringify(payload.contentHash)},
            value: payload${index},
        },`,
        )
        .join("\n");
    return `${imports}

export const worldDerivedArtifactSet = {
    schemaVersion: 1,
    artifactSetId: ${JSON.stringify(manifest.artifactSetId)},
    logicalInputHash: ${JSON.stringify(manifest.logicalInputHash)},
    providerId: ${JSON.stringify(manifest.providerId)},
    providerRevision: ${JSON.stringify(manifest.providerRevision)},
    manifestContentHash: ${JSON.stringify(manifestContentHash)},
    members: {
${members}
    },
} as const;

export default worldDerivedArtifactSet;
`;
}

function resolveJsonPointer(
    value: WorldDerivedJsonValue,
    pointer: string,
): WorldDerivedJsonValue | undefined {
    if (pointer === "") return value;
    if (!pointer.startsWith("/")) {
        throw new Error(`JSON pointer ${pointer} must start with /.`);
    }
    let current: WorldDerivedJsonValue | undefined = value;
    for (const encoded of pointer.slice(1).split("/")) {
        const key = encoded.replace(/~1/g, "/").replace(/~0/g, "~");
        if (Array.isArray(current)) {
            if (!/^(?:0|[1-9][0-9]*)$/.test(key)) return undefined;
            current = current[Number(key)];
        } else if (current && typeof current === "object") {
            current = (
                current as Readonly<Record<string, WorldDerivedJsonValue>>
            )[key];
        } else {
            return undefined;
        }
    }
    return current;
}

async function artifactSetMatches(
    setDirectory: string,
    payloads: readonly PreparedPayload[],
    manifestBytes: Buffer,
): Promise<boolean> {
    if (!(await pathExists(setDirectory))) return false;
    const expected = new Map<string, Buffer>([
        ...payloads.map(
            (payload) => [payload.fileName, payload.bytes] as const,
        ),
        ["manifest.json", manifestBytes],
    ]);
    const actualFiles = await listFiles(setDirectory);
    if (
        canonicalJson(actualFiles) !==
        canonicalJson([...expected.keys()].sort())
    ) {
        return false;
    }
    for (const [fileName, bytes] of expected) {
        if (!(await fileMatches(path.join(setDirectory, fileName), bytes))) {
            return false;
        }
    }
    return true;
}

async function listFiles(root: string): Promise<string[]> {
    const result: string[] = [];
    await visit("");
    return result.sort();

    async function visit(relativeDirectory: string): Promise<void> {
        const children = await readdir(path.join(root, relativeDirectory), {
            withFileTypes: true,
        });
        for (const child of children) {
            const relativePath = path.join(relativeDirectory, child.name);
            if (child.isDirectory()) await visit(relativePath);
            else if (child.isFile())
                result.push(relativePath.replace(/\\/g, "/"));
            else result.push(`${relativePath.replace(/\\/g, "/")}:unsupported`);
        }
    }
}

async function fileMatches(
    filePath: string,
    expected: Buffer,
): Promise<boolean> {
    try {
        return (await readFile(filePath)).equals(expected);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
    }
}

async function pathExists(targetPath: string): Promise<boolean> {
    return Boolean(await stat(targetPath).catch(() => undefined));
}
