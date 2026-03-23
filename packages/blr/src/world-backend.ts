import path from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import {
    DeleteObjectCommand,
    GetObjectCommand,
    HeadObjectCommand,
    PutObjectCommand,
    S3Client,
    S3ServiceException,
} from "@aws-sdk/client-s3";
import AdmZip from "adm-zip";
import {
    BLR_ENV_WORLD_ACTOR,
    DEFAULT_WORLD_S3_LOCK_TTL_SECONDS,
} from "./constants.js";
import type { DebugLogger } from "./debug.js";
import {
    copyDirectory,
    ensureDirectory,
    isDirectory,
    removeDirectory,
    writeJson,
} from "./fs.js";
import type { BlurProject } from "./types.js";
import { getCliPackageVersion } from "./utils.js";
import {
    assertValidProjectWorldSource,
    resolveConfiguredWorldSourcePath,
    resolveProjectWorldSourceDirectory,
} from "./world.js";

type WorldActor = {
    userName: string;
    hostName: string;
    processId: number;
};

type WorldLockRecord = {
    schemaVersion: 1;
    projectName: string;
    packageName: string;
    worldName: string;
    actor: WorldActor;
    command: string;
    reason: string;
    createdAt: string;
    expiresAt: string;
    cliVersion: string;
};

type RemoteLockSnapshot = {
    lock?: WorldLockRecord;
    etag?: string;
};

type AcquiredWorldLock = {
    lock: WorldLockRecord;
    releaseOnFailure: boolean;
};

type ResolvedWorldS3Context = {
    worldName: string;
    worldSourcePath: string;
    worldSourceDirectory: string;
    cacheRoot: string;
    archivePath: string;
    extractedDirectory: string;
    metadataPath: string;
    bucket: string;
    region: string;
    endpoint: string;
    keyPrefix: string;
    projectPrefix: boolean;
    forcePathStyle: boolean;
    objectKey: string;
    lockKey: string;
};

type AcquireWorldLockOptions = {
    force?: boolean;
    reason?: string;
    ttlSeconds?: number;
    command: string;
    debug?: DebugLogger;
};

type PullWorldOptions = {
    lock?: boolean;
    forceLock?: boolean;
    reason?: string;
    debug?: DebugLogger;
};

type PushWorldOptions = {
    forceLock?: boolean;
    unlock?: boolean;
    reason?: string;
    debug?: DebugLogger;
};

type ReleaseWorldLockOptions = {
    force?: boolean;
    debug?: DebugLogger;
};

export type WorldStatus = {
    backend: "local" | "s3";
    worldName: string;
    worldSourcePath: string;
    worldSourceDirectory: string;
    local: {
        exists: boolean;
        valid: boolean;
        dbDirectory: string;
    };
    s3?: {
        bucket: string;
        region: string;
        endpoint: string;
        keyPrefix: string;
        projectPrefix: boolean;
        forcePathStyle: boolean;
        objectKey: string;
        lockKey: string;
        cacheRoot: string;
        archivePath: string;
        extractedDirectory: string;
        lock?: WorldLockRecord;
        remoteObjectExists?: boolean;
    };
};

function toObjectKeySegment(value: string, fallback: string): string {
    const trimmed = value.trim();
    const normalized = trimmed
        .replace(/[\\/]+/g, " - ")
        .replace(/\s+/g, " ")
        .trim();
    return normalized.length > 0 ? normalized : fallback;
}

function toCacheSegment(value: string, fallback: string): string {
    const trimmed = value.trim();
    const normalized = trimmed
        .replace(/[<>:"/\\|?*\x00-\x1F]/g, "-")
        .replace(/\s+/g, " ")
        .trim();
    return normalized.length > 0 ? normalized : fallback;
}

function joinObjectKey(...segments: Array<string | undefined>): string {
    return segments
        .map((segment) => (segment ?? "").trim())
        .filter((segment) => segment.length > 0)
        .join("/");
}

function getWorldActor(): WorldActor {
    return {
        userName:
            process.env[BLR_ENV_WORLD_ACTOR] ??
            process.env.USERNAME ??
            process.env.USER ??
            "unknown-user",
        hostName:
            process.env.COMPUTERNAME ?? process.env.HOSTNAME ?? "unknown-host",
        processId: process.pid,
    };
}

function isSameActor(left: WorldActor, right: WorldActor): boolean {
    return left.userName === right.userName && left.hostName === right.hostName;
}

function isLockExpired(lock: WorldLockRecord, now = Date.now()): boolean {
    const expiresAt = Date.parse(lock.expiresAt);
    return !Number.isFinite(expiresAt) || expiresAt <= now;
}

function formatLockActor(lock: WorldLockRecord): string {
    return `${lock.actor.userName}@${lock.actor.hostName}`;
}

function createWorldLockRecord(
    config: BlurProject,
    worldName: string,
    actor: WorldActor,
    ttlSeconds: number,
    cliVersion: string,
    options: Pick<AcquireWorldLockOptions, "command" | "reason">,
): WorldLockRecord {
    const createdAt = new Date();
    return {
        schemaVersion: 1,
        projectName: config.project.name,
        packageName: config.project.packageName,
        worldName,
        actor,
        command: options.command,
        reason: options.reason?.trim() ?? "",
        createdAt: createdAt.toISOString(),
        expiresAt: new Date(
            createdAt.getTime() + ttlSeconds * 1000,
        ).toISOString(),
        cliVersion,
    };
}

function requireS3WorldBackend(config: BlurProject): void {
    if (config.world.backend !== "s3") {
        throw new Error(
            'World backend is not configured for S3. Set world.backend to "s3" in blr.config.json.',
        );
    }
    if (config.world.s3.bucket.trim().length === 0) {
        throw new Error(
            "world.s3.bucket must be configured in blr.config.json.",
        );
    }
}

function createS3ClientForWorld(config: BlurProject): S3Client {
    const region =
        config.world.s3.region.trim() ||
        process.env.AWS_REGION ||
        process.env.AWS_DEFAULT_REGION ||
        "us-east-1";
    return new S3Client({
        region,
        endpoint: config.world.s3.endpoint.trim() || undefined,
        forcePathStyle: config.world.s3.forcePathStyle,
    });
}

function resolveWorldS3Context(
    projectRoot: string,
    config: BlurProject,
    worldName: string,
): ResolvedWorldS3Context {
    requireS3WorldBackend(config);

    const worldSourcePath = resolveConfiguredWorldSourcePath(config, worldName);
    const worldSourceDirectory = resolveProjectWorldSourceDirectory(
        projectRoot,
        worldSourcePath,
    );
    const region =
        config.world.s3.region.trim() ||
        process.env.AWS_REGION ||
        process.env.AWS_DEFAULT_REGION ||
        "us-east-1";
    const keyPrefix = config.world.s3.keyPrefix.trim();
    const projectSegment = toObjectKeySegment(config.project.name, "project");
    const worldSegment = toObjectKeySegment(worldName, "world");
    const keyNamespace = joinObjectKey(
        keyPrefix,
        config.world.s3.projectPrefix ? projectSegment : undefined,
    );
    const objectFileName = `${worldSegment}.zip`;
    const lockFileName = `${worldSegment}.lock.json`;
    const cacheSegments = [
        toCacheSegment(config.world.s3.bucket.trim(), "bucket"),
        ...keyNamespace
            .split("/")
            .filter((segment) => segment.length > 0)
            .map((segment) => toCacheSegment(segment, "segment")),
        toCacheSegment(worldSegment, "world"),
    ];
    const cacheRoot = path.resolve(
        projectRoot,
        ".blr",
        "cache",
        "worlds",
        "s3",
        ...cacheSegments,
    );

    return {
        worldName,
        worldSourcePath,
        worldSourceDirectory,
        cacheRoot,
        archivePath: path.join(cacheRoot, "world.zip"),
        extractedDirectory: path.join(cacheRoot, "source"),
        metadataPath: path.join(cacheRoot, "metadata.json"),
        bucket: config.world.s3.bucket.trim(),
        region,
        endpoint: config.world.s3.endpoint.trim(),
        keyPrefix,
        projectPrefix: config.world.s3.projectPrefix,
        forcePathStyle: config.world.s3.forcePathStyle,
        objectKey: joinObjectKey(keyNamespace, objectFileName),
        lockKey: joinObjectKey(keyNamespace, lockFileName),
    };
}

async function bodyToBuffer(body: unknown): Promise<Buffer> {
    const candidate = body as
        | { transformToByteArray?: () => Promise<Uint8Array> }
        | AsyncIterable<Uint8Array | Buffer | string>
        | undefined;

    if (!candidate) {
        return Buffer.alloc(0);
    }

    if (typeof (candidate as any).transformToByteArray === "function") {
        return Buffer.from(await (candidate as any).transformToByteArray());
    }

    const chunks: Buffer[] = [];
    for await (const chunk of candidate as AsyncIterable<
        Uint8Array | Buffer | string
    >) {
        if (Buffer.isBuffer(chunk)) {
            chunks.push(chunk);
            continue;
        }
        if (typeof chunk === "string") {
            chunks.push(Buffer.from(chunk));
            continue;
        }
        chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
}

async function readRemoteLock(
    client: S3Client,
    context: ResolvedWorldS3Context,
): Promise<RemoteLockSnapshot> {
    try {
        const response = await client.send(
            new GetObjectCommand({
                Bucket: context.bucket,
                Key: context.lockKey,
            }),
        );
        const body = await bodyToBuffer(response.Body);
        if (body.length === 0) {
            return {
                etag: response.ETag,
            };
        }
        return {
            lock: JSON.parse(body.toString("utf8")) as WorldLockRecord,
            etag: response.ETag,
        };
    } catch (error) {
        if (
            error instanceof S3ServiceException &&
            (error.name === "NoSuchKey" ||
                error.$metadata.httpStatusCode === 404)
        ) {
            return {};
        }
        throw error;
    }
}

function isConditionalWriteFailure(error: unknown): boolean {
    return (
        error instanceof S3ServiceException &&
        (error.name === "PreconditionFailed" ||
            error.name === "ConditionalRequestConflict" ||
            error.$metadata.httpStatusCode === 409 ||
            error.$metadata.httpStatusCode === 412)
    );
}

async function writeRemoteLock(
    client: S3Client,
    context: ResolvedWorldS3Context,
    lock: WorldLockRecord,
    conditions: { ifMatch?: string; ifNoneMatch?: string } = {},
): Promise<void> {
    await client.send(
        new PutObjectCommand({
            Bucket: context.bucket,
            Key: context.lockKey,
            Body: JSON.stringify(lock, null, 2),
            ContentType: "application/json",
            IfMatch: conditions.ifMatch,
            IfNoneMatch: conditions.ifNoneMatch,
        }),
    );
}

async function deleteRemoteLock(
    client: S3Client,
    context: ResolvedWorldS3Context,
    etag?: string,
): Promise<void> {
    await client.send(
        new DeleteObjectCommand({
            Bucket: context.bucket,
            Key: context.lockKey,
            IfMatch: etag,
        }),
    );
}

async function remoteWorldObjectExists(
    client: S3Client,
    context: ResolvedWorldS3Context,
): Promise<boolean> {
    try {
        await client.send(
            new HeadObjectCommand({
                Bucket: context.bucket,
                Key: context.objectKey,
            }),
        );
        return true;
    } catch (error) {
        if (
            error instanceof S3ServiceException &&
            (error.name === "NotFound" ||
                error.$metadata.httpStatusCode === 404)
        ) {
            return false;
        }
        throw error;
    }
}

async function writeCacheMetadata(
    context: ResolvedWorldS3Context,
    value: Record<string, unknown>,
): Promise<void> {
    await ensureDirectory(context.cacheRoot);
    await writeJson(context.metadataPath, value);
}

async function createWorldArchive(
    sourceDirectory: string,
    archivePath: string,
): Promise<void> {
    await ensureDirectory(path.dirname(archivePath));
    await removeDirectory(archivePath);
    const archive = new AdmZip();
    archive.addLocalFolder(sourceDirectory);
    archive.writeZip(archivePath);
}

async function extractWorldArchive(
    archivePath: string,
    extractedDirectory: string,
): Promise<void> {
    await removeDirectory(extractedDirectory);
    await ensureDirectory(extractedDirectory);
    const archive = new AdmZip(archivePath);
    archive.extractAllTo(extractedDirectory, true);
}

export async function acquireRemoteWorldLock(
    projectRoot: string,
    config: BlurProject,
    worldName: string,
    options: AcquireWorldLockOptions,
): Promise<AcquiredWorldLock> {
    const context = resolveWorldS3Context(projectRoot, config, worldName);
    const client = createS3ClientForWorld(config);
    const actor = getWorldActor();
    const existing = await readRemoteLock(client, context);
    const now = Date.now();
    let releaseOnFailure = true;

    if (existing.lock) {
        const expired = isLockExpired(existing.lock, now);
        const sameActor = isSameActor(existing.lock.actor, actor);
        if (!expired && !sameActor && !options.force) {
            throw new Error(
                `World "${worldName}" is locked by ${formatLockActor(existing.lock)} until ${existing.lock.expiresAt}.`,
            );
        }

        if (expired && !sameActor) {
            options.debug?.log("world", "stealing expired remote world lock", {
                worldName,
                previousActor: formatLockActor(existing.lock),
                expiredAt: existing.lock.expiresAt,
            });
        }

        if (sameActor) {
            releaseOnFailure = false;
        }
    }

    const cliVersion = await getCliPackageVersion();
    const ttlSeconds = Math.max(
        60,
        Number(
            options.ttlSeconds ??
                config.world.s3.lockTtlSeconds ??
                DEFAULT_WORLD_S3_LOCK_TTL_SECONDS,
        ) || DEFAULT_WORLD_S3_LOCK_TTL_SECONDS,
    );
    const lock = createWorldLockRecord(
        config,
        worldName,
        actor,
        ttlSeconds,
        cliVersion,
        options,
    );
    try {
        if (existing.lock) {
            if (!existing.etag) {
                throw new Error(
                    `Cannot update world lock for "${worldName}" because the remote lock ETag is missing.`,
                );
            }
            await writeRemoteLock(client, context, lock, {
                ifMatch: existing.etag,
            });
        } else {
            await writeRemoteLock(client, context, lock, { ifNoneMatch: "*" });
        }
    } catch (error) {
        if (isConditionalWriteFailure(error)) {
            throw new Error(
                `World "${worldName}" lock changed while trying to acquire it. Retry the command.`,
            );
        }
        throw error;
    }
    options.debug?.log("world", "acquired remote world lock", {
        worldName,
        bucket: context.bucket,
        lockKey: context.lockKey,
        actor: formatLockActor(lock),
        expiresAt: lock.expiresAt,
    });
    return {
        lock,
        releaseOnFailure,
    };
}

export async function releaseRemoteWorldLock(
    projectRoot: string,
    config: BlurProject,
    worldName: string,
    options: ReleaseWorldLockOptions = {},
): Promise<void> {
    const context = resolveWorldS3Context(projectRoot, config, worldName);
    const client = createS3ClientForWorld(config);
    const existing = await readRemoteLock(client, context);
    if (!existing.lock) {
        options.debug?.log("world", "remote world lock already absent", {
            worldName,
            lockKey: context.lockKey,
        });
        return;
    }

    const actor = getWorldActor();
    if (!options.force && !isSameActor(existing.lock.actor, actor)) {
        throw new Error(
            `Cannot unlock world "${worldName}" because it is locked by ${formatLockActor(existing.lock)}.`,
        );
    }

    try {
        await deleteRemoteLock(client, context, existing.etag);
    } catch (error) {
        if (isConditionalWriteFailure(error)) {
            throw new Error(
                `World "${worldName}" lock changed while trying to release it. Retry the command.`,
            );
        }
        throw error;
    }
    options.debug?.log("world", "released remote world lock", {
        worldName,
        lockKey: context.lockKey,
        forced: Boolean(options.force),
    });
}

export async function pullWorldFromS3(
    projectRoot: string,
    config: BlurProject,
    worldName: string,
    options: PullWorldOptions = {},
): Promise<ResolvedWorldS3Context> {
    const context = resolveWorldS3Context(projectRoot, config, worldName);
    const client = createS3ClientForWorld(config);
    const remoteExists = await remoteWorldObjectExists(client, context);
    if (!remoteExists) {
        throw new Error(
            `Remote world object does not exist: s3://${context.bucket}/${context.objectKey}`,
        );
    }

    let lockHandle: AcquiredWorldLock | undefined;
    if (options.lock !== false) {
        lockHandle = await acquireRemoteWorldLock(
            projectRoot,
            config,
            worldName,
            {
                command: "pull",
                force: options.forceLock,
                reason: options.reason,
                debug: options.debug,
            },
        );
    }

    try {
        const response = await client.send(
            new GetObjectCommand({
                Bucket: context.bucket,
                Key: context.objectKey,
            }),
        );
        const payload = await bodyToBuffer(response.Body);
        if (payload.length === 0) {
            throw new Error(
                `Remote world object is empty: s3://${context.bucket}/${context.objectKey}`,
            );
        }

        await ensureDirectory(context.cacheRoot);
        await writeFile(context.archivePath, payload);
        await extractWorldArchive(
            context.archivePath,
            context.extractedDirectory,
        );
        if (!(await isDirectory(path.join(context.extractedDirectory, "db")))) {
            throw new Error(
                `Remote world object does not contain a valid Bedrock world: s3://${context.bucket}/${context.objectKey}`,
            );
        }
        await copyDirectory(
            context.extractedDirectory,
            context.worldSourceDirectory,
        );
        await writeCacheMetadata(context, {
            backend: "s3",
            bucket: context.bucket,
            objectKey: context.objectKey,
            pulledAt: new Date().toISOString(),
            bytes: payload.length,
            worldName,
        });
        options.debug?.log("world", "pulled world from s3", {
            worldName,
            bucket: context.bucket,
            objectKey: context.objectKey,
            archivePath: context.archivePath,
            worldSourceDirectory: context.worldSourceDirectory,
        });

        return context;
    } catch (error) {
        if (lockHandle?.releaseOnFailure) {
            try {
                await releaseRemoteWorldLock(projectRoot, config, worldName, {
                    debug: options.debug,
                });
            } catch (unlockError) {
                options.debug?.log(
                    "world",
                    "failed to release remote world lock after pull failure",
                    {
                        worldName,
                        error:
                            unlockError instanceof Error
                                ? unlockError.message
                                : String(unlockError),
                    },
                );
            }
        }
        throw error;
    }
}

export async function pushWorldToS3(
    projectRoot: string,
    config: BlurProject,
    worldName: string,
    options: PushWorldOptions = {},
): Promise<ResolvedWorldS3Context> {
    const context = resolveWorldS3Context(projectRoot, config, worldName);
    const client = createS3ClientForWorld(config);

    await assertValidProjectWorldSource(
        projectRoot,
        context.worldSourcePath,
        `push world "${worldName}"`,
    );

    await acquireRemoteWorldLock(projectRoot, config, worldName, {
        command: "push",
        force: options.forceLock,
        reason: options.reason,
        debug: options.debug,
    });

    await createWorldArchive(context.worldSourceDirectory, context.archivePath);
    const payload = await readFile(context.archivePath);
    await client.send(
        new PutObjectCommand({
            Bucket: context.bucket,
            Key: context.objectKey,
            Body: payload,
            ContentType: "application/zip",
        }),
    );

    await writeCacheMetadata(context, {
        backend: "s3",
        bucket: context.bucket,
        objectKey: context.objectKey,
        pushedAt: new Date().toISOString(),
        bytes: payload.byteLength,
        worldName,
    });

    options.debug?.log("world", "pushed world to s3", {
        worldName,
        bucket: context.bucket,
        objectKey: context.objectKey,
        archivePath: context.archivePath,
        worldSourceDirectory: context.worldSourceDirectory,
    });

    if (options.unlock ?? true) {
        await releaseRemoteWorldLock(projectRoot, config, worldName, {
            debug: options.debug,
        });
    }

    return context;
}

export async function describeWorldStatus(
    projectRoot: string,
    config: BlurProject,
    worldName: string,
    debug?: DebugLogger,
): Promise<WorldStatus> {
    const worldSourcePath = resolveConfiguredWorldSourcePath(config, worldName);
    const worldSourceDirectory = resolveProjectWorldSourceDirectory(
        projectRoot,
        worldSourcePath,
    );
    const dbDirectory = path.join(worldSourceDirectory, "db");
    const localExists = await isDirectory(worldSourceDirectory);
    const localValid = localExists && (await isDirectory(dbDirectory));

    if (config.world.backend !== "s3") {
        return {
            backend: "local",
            worldName,
            worldSourcePath,
            worldSourceDirectory,
            local: {
                exists: localExists,
                valid: localValid,
                dbDirectory,
            },
        };
    }

    const context = resolveWorldS3Context(projectRoot, config, worldName);
    const client = createS3ClientForWorld(config);
    const [lock, remoteObjectExists] = await Promise.all([
        readRemoteLock(client, context),
        remoteWorldObjectExists(client, context),
    ]);

    debug?.log("world", "resolved world status", {
        worldName,
        bucket: context.bucket,
        objectKey: context.objectKey,
        lockKey: context.lockKey,
        remoteObjectExists,
        lockPresent: Boolean(lock.lock),
    });

    return {
        backend: "s3",
        worldName,
        worldSourcePath,
        worldSourceDirectory,
        local: {
            exists: localExists,
            valid: localValid,
            dbDirectory,
        },
        s3: {
            bucket: context.bucket,
            region: context.region,
            endpoint: context.endpoint,
            keyPrefix: context.keyPrefix,
            projectPrefix: context.projectPrefix,
            forcePathStyle: context.forcePathStyle,
            objectKey: context.objectKey,
            lockKey: context.lockKey,
            cacheRoot: context.cacheRoot,
            archivePath: context.archivePath,
            extractedDirectory: context.extractedDirectory,
            lock: lock.lock,
            remoteObjectExists,
        },
    };
}
