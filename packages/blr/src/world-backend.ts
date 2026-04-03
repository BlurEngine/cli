import path from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { readdir } from "node:fs/promises";
import {
    DeleteObjectCommand,
    GetBucketVersioningCommand,
    GetObjectCommand,
    HeadObjectCommand,
    ListObjectsV2Command,
    ListObjectVersionsCommand,
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
    exists,
    isDirectory,
    removeDirectory,
} from "./fs.js";
import {
    buildTrackedProjectWorldFingerprint,
    readTrackedProjectWorld,
    type TrackedProjectWorldEntry,
    upsertTrackedProjectWorld,
} from "./project-world-state.js";
import {
    markProjectWorldMaterializedFromRemote,
    readMaterializedProjectWorldRemoteState,
} from "./world-internal-state.js";
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
    cacheDirectory: string;
    legacyCacheDirectory: string;
    bucket: string;
    region: string;
    endpoint: string;
    keyPrefix: string;
    keyNamespace: string;
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
    versionId?: string;
    debug?: DebugLogger;
};

type PushWorldOptions = {
    forceLock?: boolean;
    unlock?: boolean;
    reason?: string;
    allowRemoteConflict?: boolean;
    debug?: DebugLogger;
};

type ReleaseWorldLockOptions = {
    force?: boolean;
    debug?: DebugLogger;
};

export type WorldVersioningMode =
    | "enabled"
    | "disabled"
    | "suspended"
    | "unknown";

export type WorldVersioningStatus = {
    mode: WorldVersioningMode;
    available: boolean;
    detail?: string;
};

export type RemoteWorldObjectMetadata = {
    versionId?: string;
    etag?: string;
    lastModified?: string;
    size?: number;
    isLatest?: boolean;
    pushMetadataRecorded: boolean;
    pushedBy?: string;
    pushedAt?: string;
    pushReason?: string;
    pushMetadataAvailable?: boolean;
    pushMetadataDetail?: string;
};

export type ListedRemoteWorld = {
    worldName: string;
    objectKey: string;
    versioning: WorldVersioningStatus;
    latestObject?: RemoteWorldObjectMetadata;
};

export type RemoteWorldVersionEntry = {
    worldName: string;
    objectKey: string;
    versionId?: string;
    isLatest: boolean;
    etag?: string;
    lastModified?: string;
    size?: number;
    pushMetadataRecorded: boolean;
    pushedBy?: string;
    pushedAt?: string;
    pushReason?: string;
    pushMetadataAvailable?: boolean;
    pushMetadataDetail?: string;
};

export type WorldObjectMetadataSupport = {
    available: boolean;
    detail?: string;
};

export type PushWorldResult = {
    context: ResolvedWorldS3Context;
    versioning: WorldVersioningStatus;
    versionId?: string;
};

export type PullWorldResult = {
    context: ResolvedWorldS3Context;
    versionId: string;
};

export type TrackedWorldBinding = {
    entry?: TrackedProjectWorldEntry;
    currentFingerprint: string;
    matchesCurrentRemote: boolean;
};

export type WorldPushConflictKind =
    | "missing-tracked-version"
    | "remote-fingerprint-drift"
    | "remote-version-mismatch";

export class WorldPushRemoteConflictError extends Error {
    kind: WorldPushConflictKind;
    worldName: string;
    trackedVersionId?: string;
    latestRemoteVersionId?: string;
    trackedRemoteFingerprint?: string;
    currentRemoteFingerprint: string;

    constructor(input: {
        kind: WorldPushConflictKind;
        worldName: string;
        trackedVersionId?: string;
        latestRemoteVersionId?: string;
        trackedRemoteFingerprint?: string;
        currentRemoteFingerprint: string;
        message: string;
    }) {
        super(input.message);
        this.name = "WorldPushRemoteConflictError";
        this.kind = input.kind;
        this.worldName = input.worldName;
        this.trackedVersionId = input.trackedVersionId;
        this.latestRemoteVersionId = input.latestRemoteVersionId;
        this.trackedRemoteFingerprint = input.trackedRemoteFingerprint;
        this.currentRemoteFingerprint = input.currentRemoteFingerprint;
    }
}

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
        cacheDirectory: string;
        versioning: WorldVersioningStatus;
        latestObject?: RemoteWorldObjectMetadata;
        tracked?: {
            versionId: string;
            remoteFingerprint: string;
            matchesCurrentRemote: boolean;
        };
        materializedRemote?: {
            versionId: string;
            remoteFingerprint: string;
            materializedAt: string;
            matchesCurrentRemote: boolean;
        };
        lock?: WorldLockRecord;
        remoteObjectExists?: boolean;
    };
};

const WORLD_OBJECT_METADATA_KEYS = {
    actor: "blr-actor",
    pushedAt: "blr-pushed-at",
    reason: "blr-reason",
    cliVersion: "blr-cli-version",
    projectName: "blr-project-name",
    packageName: "blr-package-name",
} as const;

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

function encodeCacheVersionId(versionId: string): string {
    const trimmed = versionId.trim();
    if (trimmed.length === 0) {
        return "unknown-version";
    }
    if (trimmed === "null") {
        return "null";
    }
    return Buffer.from(trimmed, "utf8").toString("base64url");
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

function versioningUnavailableMessage(reason?: string): string {
    if (typeof reason === "string" && reason.trim().length > 0) {
        return `Remote world version features are unavailable because ${reason.trim()}.`;
    }
    return "Remote world version features are unavailable because bucket versioning is not enabled or could not be verified for this backend.";
}

function isUnknownS3BackendError(error: unknown): boolean {
    if (error instanceof S3ServiceException) {
        return (
            error.name === "UnknownError" ||
            error.message.trim().toLowerCase() === "unknownerror"
        );
    }

    if (error instanceof Error) {
        return (
            error.name === "UnknownError" ||
            error.message.trim().toLowerCase() === "unknownerror"
        );
    }

    return false;
}

function describeS3ObjectTarget(options: {
    bucket: string;
    key: string;
    versionId?: string;
    label: string;
}): string {
    if (typeof options.versionId === "string" && options.versionId.length > 0) {
        return `${options.label} version ${options.versionId} at s3://${options.bucket}/${options.key}`;
    }
    return `${options.label} s3://${options.bucket}/${options.key}`;
}

function buildS3ObjectRequestFailureMessage(options: {
    action: string;
    bucket: string;
    key: string;
    versionId?: string;
    label: string;
    requiredPermission?: string;
    error: unknown;
}): string {
    const target = describeS3ObjectTarget({
        bucket: options.bucket,
        key: options.key,
        versionId: options.versionId,
        label: options.label,
    });

    if (options.error instanceof S3ServiceException) {
        if (
            options.error.name === "AccessDenied" ||
            options.error.name === "UnauthorizedOperation" ||
            options.error.$metadata.httpStatusCode === 401 ||
            options.error.$metadata.httpStatusCode === 403
        ) {
            const permissionHint =
                typeof options.requiredPermission === "string" &&
                options.requiredPermission.length > 0
                    ? ` Ensure the active credentials allow ${options.requiredPermission}.`
                    : "";
            return `blr could not ${options.action} ${target} (${options.error.name}).${permissionHint}`;
        }

        if (isUnknownS3BackendError(options.error)) {
            return `blr could not ${options.action} ${target} because the S3 backend returned an unknown error. This backend may not fully support this request, or the active credentials may not allow it.`;
        }

        if (
            typeof options.error.message === "string" &&
            options.error.message.trim().length > 0
        ) {
            return `blr could not ${options.action} ${target} (${options.error.name}: ${options.error.message.trim()})`;
        }

        return `blr could not ${options.action} ${target} (${options.error.name})`;
    }

    if (options.error instanceof Error) {
        if (options.error.name === "CredentialsProviderError") {
            return `blr could not load S3 credentials to ${options.action} ${target}.`;
        }

        if (isUnknownS3BackendError(options.error)) {
            return `blr could not ${options.action} ${target} because the S3 backend returned an unknown error. This backend may not fully support this request, or the active credentials may not allow it.`;
        }

        if (options.error.message.trim().length > 0) {
            return `blr could not ${options.action} ${target} (${options.error.name}: ${options.error.message.trim()})`;
        }

        return `blr could not ${options.action} ${target} (${options.error.name})`;
    }

    return `blr could not ${options.action} ${target}`;
}

function resolveVersioningProbeFailureDetail(
    error: unknown,
    context: ResolvedWorldS3Context,
): string {
    if (isUnknownS3BackendError(error)) {
        return `blr could not verify bucket versioning for ${context.bucket} because the S3 backend returned an unknown error. This backend may not fully support GetBucketVersioning, or the active credentials may not allow it.`;
    }

    if (error instanceof S3ServiceException) {
        if (
            error.name === "AccessDenied" ||
            error.name === "UnauthorizedOperation" ||
            error.$metadata.httpStatusCode === 401 ||
            error.$metadata.httpStatusCode === 403
        ) {
            return `blr could not read bucket versioning for ${context.bucket} (${error.name}). Ensure the active credentials allow s3:GetBucketVersioning`;
        }

        if (
            error.name === "NotImplemented" ||
            error.name === "XNotImplemented"
        ) {
            return "this S3 backend does not support bucket versioning detection";
        }

        if (
            typeof error.message === "string" &&
            error.message.trim().length > 0
        ) {
            return `blr could not verify bucket versioning for ${context.bucket} (${error.name}: ${error.message.trim()})`;
        }

        return `blr could not verify bucket versioning for ${context.bucket} (${error.name})`;
    }

    if (error instanceof Error) {
        if (error.name === "CredentialsProviderError") {
            return "blr could not load S3 credentials to verify bucket versioning";
        }
        if (error.message.trim().length > 0) {
            return `blr could not verify bucket versioning (${error.name}: ${error.message.trim()})`;
        }
        return `blr could not verify bucket versioning (${error.name})`;
    }

    return "blr could not verify bucket versioning";
}

function normalizeS3Timestamp(value: Date | undefined): string | undefined {
    return value instanceof Date ? value.toISOString() : undefined;
}

function normalizeS3Metadata(value: {
    VersionId?: string;
    ETag?: string;
    LastModified?: Date;
    ContentLength?: number;
    IsLatest?: boolean;
    Metadata?: Record<string, string>;
}): RemoteWorldObjectMetadata {
    const metadata = value.Metadata ?? {};
    const pushedBy = metadata[WORLD_OBJECT_METADATA_KEYS.actor];
    const pushedAt = metadata[WORLD_OBJECT_METADATA_KEYS.pushedAt];
    const pushReason = metadata[WORLD_OBJECT_METADATA_KEYS.reason];
    const pushMetadataRecorded =
        typeof pushedBy === "string" ||
        typeof pushedAt === "string" ||
        typeof pushReason === "string";

    return {
        versionId: value.VersionId,
        etag: value.ETag,
        lastModified: normalizeS3Timestamp(value.LastModified),
        size:
            typeof value.ContentLength === "number"
                ? value.ContentLength
                : undefined,
        isLatest: value.IsLatest,
        pushMetadataRecorded,
        pushedBy,
        pushedAt,
        pushReason,
        pushMetadataAvailable: true,
    };
}

function resolveObjectMetadataFailureDetail(
    error: unknown,
    versionId?: string,
): string {
    const versionLabel =
        typeof versionId === "string" && versionId.length > 0
            ? `version ${versionId}`
            : "an unspecified version";

    if (error instanceof S3ServiceException) {
        if (
            typeof error.message === "string" &&
            error.message.trim().length > 0
        ) {
            return `blr could not read push metadata for ${versionLabel} (${error.name}: ${error.message.trim()})`;
        }
        return `blr could not read push metadata for ${versionLabel} (${error.name})`;
    }

    if (error instanceof Error) {
        if (error.message.trim().length > 0) {
            return `blr could not read push metadata for ${versionLabel} (${error.name}: ${error.message.trim()})`;
        }
        return `blr could not read push metadata for ${versionLabel} (${error.name})`;
    }

    return `blr could not read push metadata for ${versionLabel}`;
}

function createWorldObjectMetadata(input: {
    actor: WorldActor;
    projectName: string;
    packageName: string;
    cliVersion: string;
    reason?: string;
}): Record<string, string> {
    const metadata: Record<string, string> = {
        [WORLD_OBJECT_METADATA_KEYS.actor]: `${input.actor.userName}@${input.actor.hostName}`,
        [WORLD_OBJECT_METADATA_KEYS.pushedAt]: new Date().toISOString(),
        [WORLD_OBJECT_METADATA_KEYS.cliVersion]: input.cliVersion,
        [WORLD_OBJECT_METADATA_KEYS.projectName]: input.projectName,
        [WORLD_OBJECT_METADATA_KEYS.packageName]: input.packageName,
    };
    const trimmedReason = input.reason?.trim();
    if (trimmedReason) {
        metadata[WORLD_OBJECT_METADATA_KEYS.reason] = trimmedReason;
    }
    return metadata;
}

async function persistTrackedProjectWorldState(
    projectRoot: string,
    context: ResolvedWorldS3Context,
    value: {
        versionId: string;
    },
): Promise<void> {
    await upsertTrackedProjectWorld(projectRoot, {
        name: context.worldName,
        remoteFingerprint: buildTrackedProjectWorldFingerprint({
            backend: "s3",
            bucket: context.bucket,
            endpoint: context.endpoint,
            objectKey: context.objectKey,
        }),
        versionId: value.versionId,
    });
}

function resolveTrackedWorldBinding(
    context: ResolvedWorldS3Context,
    entry?: TrackedProjectWorldEntry,
): TrackedWorldBinding {
    const currentFingerprint = buildTrackedProjectWorldFingerprint({
        backend: "s3",
        bucket: context.bucket,
        endpoint: context.endpoint,
        objectKey: context.objectKey,
    });
    return {
        entry,
        currentFingerprint,
        matchesCurrentRemote:
            typeof entry?.remoteFingerprint === "string" &&
            entry.remoteFingerprint === currentFingerprint,
    };
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
    const cacheDirectory = path.resolve(
        projectRoot,
        ".blr",
        "cache",
        "worlds",
        toCacheSegment(config.world.s3.bucket.trim(), "bucket"),
        toCacheSegment(worldSegment, "world"),
    );
    const legacyCacheDirectory = path.resolve(
        projectRoot,
        ".blr",
        "cache",
        "worlds",
        "s3",
        toCacheSegment(config.world.s3.bucket.trim(), "bucket"),
        ...keyNamespace
            .split("/")
            .filter((segment) => segment.length > 0)
            .map((segment) => toCacheSegment(segment, "segment")),
        toCacheSegment(worldSegment, "world"),
    );

    return {
        worldName,
        worldSourcePath,
        worldSourceDirectory,
        cacheDirectory,
        legacyCacheDirectory,
        bucket: config.world.s3.bucket.trim(),
        region,
        endpoint: config.world.s3.endpoint.trim(),
        keyPrefix,
        keyNamespace,
        projectPrefix: config.world.s3.projectPrefix,
        forcePathStyle: config.world.s3.forcePathStyle,
        objectKey: joinObjectKey(keyNamespace, objectFileName),
        lockKey: joinObjectKey(keyNamespace, lockFileName),
    };
}

function resolveCachedWorldArchivePath(
    context: ResolvedWorldS3Context,
    versionId: string,
): string {
    return path.join(
        context.cacheDirectory,
        `${encodeCacheVersionId(versionId)}.zip`,
    );
}

function resolveTemporaryWorldArchivePath(
    context: ResolvedWorldS3Context,
): string {
    return path.join(context.cacheDirectory, ".upload.tmp.zip");
}

function resolveTemporaryExtractedWorldDirectory(
    context: ResolvedWorldS3Context,
): string {
    return path.join(context.cacheDirectory, ".extract");
}

async function pruneWorldCacheDirectory(
    context: ResolvedWorldS3Context,
): Promise<void> {
    if (await exists(context.legacyCacheDirectory)) {
        await removeDirectory(context.legacyCacheDirectory);
    }
    if (!(await exists(context.cacheDirectory))) {
        return;
    }

    const entries = await readdir(context.cacheDirectory, {
        withFileTypes: true,
    });
    for (const entry of entries) {
        const targetPath = path.join(context.cacheDirectory, entry.name);
        if (entry.isDirectory() || !entry.name.endsWith(".zip")) {
            await removeDirectory(targetPath);
        }
    }
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
        throw new Error(
            buildS3ObjectRequestFailureMessage({
                action: "read",
                bucket: context.bucket,
                key: context.lockKey,
                label: "remote world lock",
                requiredPermission: "s3:GetObject",
                error,
            }),
        );
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

async function resolveWorldVersioningStatus(
    client: S3Client,
    context: ResolvedWorldS3Context,
): Promise<WorldVersioningStatus> {
    try {
        const response = await client.send(
            new GetBucketVersioningCommand({
                Bucket: context.bucket,
            }),
        );
        if (response.Status === "Enabled") {
            return { mode: "enabled", available: true };
        }
        if (response.Status === "Suspended") {
            return {
                mode: "suspended",
                available: false,
                detail: versioningUnavailableMessage(
                    `bucket versioning is suspended for ${context.bucket}`,
                ),
            };
        }
        return {
            mode: "disabled",
            available: false,
            detail: versioningUnavailableMessage(
                `bucket versioning is not enabled for ${context.bucket}`,
            ),
        };
    } catch (error) {
        return {
            mode: "unknown",
            available: false,
            detail: versioningUnavailableMessage(
                resolveVersioningProbeFailureDetail(error, context),
            ),
        };
    }
}

function assertWorldVersioningAvailable(status: WorldVersioningStatus): void {
    if (!status.available) {
        throw new Error(status.detail ?? versioningUnavailableMessage());
    }
}

async function readRemoteWorldObjectMetadata(
    client: S3Client,
    context: ResolvedWorldS3Context,
    versionId?: string,
): Promise<RemoteWorldObjectMetadata | undefined> {
    try {
        const response = await client.send(
            new HeadObjectCommand({
                Bucket: context.bucket,
                Key: context.objectKey,
                VersionId: versionId,
            }),
        );
        return normalizeS3Metadata(response);
    } catch (error) {
        if (
            error instanceof S3ServiceException &&
            (error.name === "NotFound" ||
                error.name === "NoSuchKey" ||
                error.$metadata.httpStatusCode === 404)
        ) {
            return undefined;
        }
        throw new Error(
            buildS3ObjectRequestFailureMessage({
                action: "inspect",
                bucket: context.bucket,
                key: context.objectKey,
                versionId,
                label: "remote world object",
                requiredPermission: "s3:GetObject",
                error,
            }),
        );
    }
}

async function readTrackedWorldBinding(
    projectRoot: string,
    context: ResolvedWorldS3Context,
): Promise<TrackedWorldBinding> {
    const tracked = await readTrackedProjectWorld(
        projectRoot,
        context.worldName,
    );
    return resolveTrackedWorldBinding(context, tracked);
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

function getWorldNamespacePrefix(context: ResolvedWorldS3Context): string {
    return context.keyNamespace.length > 0 ? `${context.keyNamespace}/` : "";
}

function worldNameFromObjectKey(
    context: ResolvedWorldS3Context,
    objectKey: string,
): string | undefined {
    const prefix = getWorldNamespacePrefix(context);
    if (prefix.length > 0 && !objectKey.startsWith(prefix)) {
        return undefined;
    }

    const relativeKey =
        prefix.length > 0 ? objectKey.slice(prefix.length) : objectKey;
    if (relativeKey.includes("/")) {
        return undefined;
    }
    if (!relativeKey.endsWith(".zip")) {
        return undefined;
    }

    const worldName = relativeKey.slice(0, -4).trim();
    return worldName.length > 0 ? worldName : undefined;
}

export async function listRemoteWorldsFromS3(
    projectRoot: string,
    config: BlurProject,
    explicitWorldName?: string,
): Promise<ListedRemoteWorld[]> {
    const seedWorldName = explicitWorldName ?? config.dev.localServer.worldName;
    const context = resolveWorldS3Context(projectRoot, config, seedWorldName);
    const client = createS3ClientForWorld(config);
    const versioning = await resolveWorldVersioningStatus(client, context);
    const prefix = getWorldNamespacePrefix(context);
    const worlds = new Map<string, ListedRemoteWorld>();
    let continuationToken: string | undefined;

    do {
        const response = await client.send(
            new ListObjectsV2Command({
                Bucket: context.bucket,
                Prefix: prefix || undefined,
                ContinuationToken: continuationToken,
            }),
        );
        for (const entry of response.Contents ?? []) {
            if (!entry.Key) {
                continue;
            }
            const worldName = worldNameFromObjectKey(context, entry.Key);
            if (!worldName || worlds.has(worldName)) {
                continue;
            }

            const worldContext = resolveWorldS3Context(
                projectRoot,
                config,
                worldName,
            );
            worlds.set(worldName, {
                worldName,
                objectKey: worldContext.objectKey,
                versioning,
                latestObject: versioning.available
                    ? await readRemoteWorldObjectMetadata(client, worldContext)
                    : undefined,
            });
        }
        continuationToken = response.IsTruncated
            ? response.NextContinuationToken
            : undefined;
    } while (continuationToken);

    return Array.from(worlds.values()).sort((left, right) =>
        left.worldName.localeCompare(right.worldName),
    );
}

export async function listRemoteWorldVersionsFromS3(
    projectRoot: string,
    config: BlurProject,
    worldName: string,
): Promise<{
    context: ResolvedWorldS3Context;
    versioning: WorldVersioningStatus;
    pushMetadataSupport: WorldObjectMetadataSupport;
    versions: RemoteWorldVersionEntry[];
}> {
    const context = resolveWorldS3Context(projectRoot, config, worldName);
    const client = createS3ClientForWorld(config);
    const versioning = await resolveWorldVersioningStatus(client, context);
    assertWorldVersioningAvailable(versioning);

    const versions: RemoteWorldVersionEntry[] = [];
    let keyMarker: string | undefined;
    let versionIdMarker: string | undefined;

    do {
        const response = await client.send(
            new ListObjectVersionsCommand({
                Bucket: context.bucket,
                Prefix: context.objectKey,
                KeyMarker: keyMarker,
                VersionIdMarker: versionIdMarker,
            }),
        );
        for (const entry of response.Versions ?? []) {
            if (entry.Key !== context.objectKey) {
                continue;
            }
            versions.push({
                worldName,
                objectKey: context.objectKey,
                versionId: entry.VersionId,
                isLatest: Boolean(entry.IsLatest),
                etag: entry.ETag,
                lastModified: normalizeS3Timestamp(entry.LastModified),
                size: entry.Size,
                pushMetadataRecorded: false,
            });
        }
        keyMarker = response.IsTruncated ? response.NextKeyMarker : undefined;
        versionIdMarker = response.IsTruncated
            ? response.NextVersionIdMarker
            : undefined;
    } while (keyMarker || versionIdMarker);

    let pushMetadataSupport: WorldObjectMetadataSupport = {
        available: true,
    };
    let latestObjectMetadata: RemoteWorldObjectMetadata | undefined;

    try {
        latestObjectMetadata = await readRemoteWorldObjectMetadata(
            client,
            context,
        );
    } catch {
        latestObjectMetadata = undefined;
    }

    const enrichedVersions = await Promise.all(
        versions.map(async (version) => {
            let metadata: RemoteWorldObjectMetadata | undefined;
            try {
                metadata = await readRemoteWorldObjectMetadata(
                    client,
                    context,
                    version.versionId,
                );
            } catch (error) {
                const canUseLatestObjectMetadata =
                    version.isLatest &&
                    latestObjectMetadata &&
                    (latestObjectMetadata.pushMetadataRecorded ||
                        (typeof latestObjectMetadata.versionId === "string" &&
                            latestObjectMetadata.versionId ===
                                version.versionId) ||
                        (typeof latestObjectMetadata.versionId !== "string" &&
                            typeof version.versionId !== "string"));

                if (canUseLatestObjectMetadata) {
                    metadata = latestObjectMetadata;
                } else {
                    const detail = resolveObjectMetadataFailureDetail(
                        error,
                        version.versionId,
                    );
                    if (pushMetadataSupport.available) {
                        pushMetadataSupport = {
                            available: false,
                            detail,
                        };
                    }
                    return {
                        ...version,
                        pushMetadataRecorded: false,
                        pushMetadataAvailable: false,
                        pushMetadataDetail: detail,
                    } satisfies RemoteWorldVersionEntry;
                }
            }

            if (!metadata) {
                const detail = resolveObjectMetadataFailureDetail(
                    new Error("MissingMetadata"),
                    version.versionId,
                );
                if (pushMetadataSupport.available) {
                    pushMetadataSupport = {
                        available: false,
                        detail,
                    };
                }
                return {
                    ...version,
                    pushMetadataRecorded: false,
                    pushMetadataAvailable: false,
                    pushMetadataDetail: detail,
                } satisfies RemoteWorldVersionEntry;
            }

            return {
                ...version,
                pushMetadataRecorded: metadata?.pushMetadataRecorded ?? false,
                pushedBy: metadata?.pushedBy,
                pushedAt: metadata?.pushedAt,
                pushReason: metadata?.pushReason,
                pushMetadataAvailable: metadata?.pushMetadataAvailable ?? true,
                pushMetadataDetail: metadata?.pushMetadataDetail,
            } satisfies RemoteWorldVersionEntry;
        }),
    );

    return {
        context,
        versioning,
        pushMetadataSupport,
        versions: enrichedVersions,
    };
}

function buildMissingTrackedVersionMessage(input: {
    worldName: string;
    latestRemoteVersionId?: string;
}): string {
    return input.latestRemoteVersionId
        ? `Project does not track a remote world version for "${input.worldName}". The latest remote version is ${input.latestRemoteVersionId}. Pull that world first or confirm that you want to push without a tracked base version.`
        : `Project does not track a remote world version for "${input.worldName}". Pull the remote world first or confirm that you want to push without a tracked base version.`;
}

function buildRemoteFingerprintDriftMessage(input: {
    worldName: string;
    trackedVersionId: string;
}): string {
    return `Project "${input.worldName}" tracks remote world version ${input.trackedVersionId}, but that pin belongs to a different remote world configuration than the current blr.config.json. Review the remote change and confirm before pushing.`;
}

function buildRemoteVersionMismatchMessage(input: {
    worldName: string;
    trackedVersionId: string;
    latestRemoteVersionId: string;
}): string {
    return `Project "${input.worldName}" tracks remote world version ${input.trackedVersionId}, but the latest remote version is ${input.latestRemoteVersionId}. Pull the latest remote world first or confirm that you want to push over newer remote work.`;
}

function assertTrackedWorldSafeToPush(input: {
    worldName: string;
    tracked: TrackedWorldBinding;
    latestRemoteVersionId?: string;
}): void {
    if (!input.latestRemoteVersionId) {
        return;
    }

    if (!input.tracked.entry?.versionId) {
        throw new WorldPushRemoteConflictError({
            kind: "missing-tracked-version",
            worldName: input.worldName,
            latestRemoteVersionId: input.latestRemoteVersionId,
            currentRemoteFingerprint: input.tracked.currentFingerprint,
            message: buildMissingTrackedVersionMessage({
                worldName: input.worldName,
                latestRemoteVersionId: input.latestRemoteVersionId,
            }),
        });
    }

    if (!input.tracked.matchesCurrentRemote) {
        throw new WorldPushRemoteConflictError({
            kind: "remote-fingerprint-drift",
            worldName: input.worldName,
            trackedVersionId: input.tracked.entry.versionId,
            trackedRemoteFingerprint: input.tracked.entry.remoteFingerprint,
            latestRemoteVersionId: input.latestRemoteVersionId,
            currentRemoteFingerprint: input.tracked.currentFingerprint,
            message: buildRemoteFingerprintDriftMessage({
                worldName: input.worldName,
                trackedVersionId: input.tracked.entry.versionId,
            }),
        });
    }

    if (input.tracked.entry.versionId !== input.latestRemoteVersionId) {
        throw new WorldPushRemoteConflictError({
            kind: "remote-version-mismatch",
            worldName: input.worldName,
            trackedVersionId: input.tracked.entry.versionId,
            latestRemoteVersionId: input.latestRemoteVersionId,
            trackedRemoteFingerprint: input.tracked.entry.remoteFingerprint,
            currentRemoteFingerprint: input.tracked.currentFingerprint,
            message: buildRemoteVersionMismatchMessage({
                worldName: input.worldName,
                trackedVersionId: input.tracked.entry.versionId,
                latestRemoteVersionId: input.latestRemoteVersionId,
            }),
        });
    }
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
): Promise<PullWorldResult> {
    const context = resolveWorldS3Context(projectRoot, config, worldName);
    const client = createS3ClientForWorld(config);
    const versioning = await resolveWorldVersioningStatus(client, context);
    assertWorldVersioningAvailable(versioning);

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
        let response;
        try {
            response = await client.send(
                new GetObjectCommand({
                    Bucket: context.bucket,
                    Key: context.objectKey,
                    VersionId: options.versionId,
                }),
            );
        } catch (error) {
            if (
                error instanceof S3ServiceException &&
                (error.name === "NotFound" ||
                    error.name === "NoSuchKey" ||
                    error.$metadata.httpStatusCode === 404)
            ) {
                throw new Error(
                    `Remote world object does not exist: s3://${context.bucket}/${context.objectKey}`,
                );
            }

            throw new Error(
                buildS3ObjectRequestFailureMessage({
                    action: "download",
                    bucket: context.bucket,
                    key: context.objectKey,
                    versionId: options.versionId,
                    label: "remote world object",
                    requiredPermission: "s3:GetObject",
                    error,
                }),
            );
        }

        const remoteMetadata = normalizeS3Metadata({
            VersionId: response.VersionId ?? options.versionId,
            ETag: response.ETag,
            LastModified: response.LastModified,
            ContentLength: response.ContentLength,
            Metadata: response.Metadata,
        });
        const payload = await bodyToBuffer(response.Body);
        if (payload.length === 0) {
            throw new Error(
                `Remote world object is empty: s3://${context.bucket}/${context.objectKey}`,
            );
        }

        const resolvedVersionId =
            response.VersionId ?? remoteMetadata.versionId ?? options.versionId;
        if (!resolvedVersionId) {
            throw new Error(
                `Remote world version ID is missing for s3://${context.bucket}/${context.objectKey}.`,
            );
        }

        const archivePath = resolveCachedWorldArchivePath(
            context,
            resolvedVersionId,
        );
        const extractedDirectory =
            resolveTemporaryExtractedWorldDirectory(context);

        await ensureDirectory(context.cacheDirectory);
        await writeFile(archivePath, payload);
        await extractWorldArchive(archivePath, extractedDirectory);
        try {
            if (!(await isDirectory(path.join(extractedDirectory, "db")))) {
                throw new Error(
                    `Remote world object does not contain a valid Bedrock world: s3://${context.bucket}/${context.objectKey}`,
                );
            }
            await copyDirectory(
                extractedDirectory,
                context.worldSourceDirectory,
            );
        } finally {
            await removeDirectory(extractedDirectory);
        }
        await pruneWorldCacheDirectory(context);
        await persistTrackedProjectWorldState(projectRoot, context, {
            versionId: resolvedVersionId,
        });
        await markProjectWorldMaterializedFromRemote(projectRoot, {
            worldName,
            remoteFingerprint: buildTrackedProjectWorldFingerprint({
                backend: "s3",
                bucket: context.bucket,
                endpoint: context.endpoint,
                objectKey: context.objectKey,
            }),
            versionId: resolvedVersionId,
        });
        options.debug?.log("world", "pulled world from s3", {
            worldName,
            bucket: context.bucket,
            objectKey: context.objectKey,
            versionId: resolvedVersionId,
            archivePath,
            worldSourceDirectory: context.worldSourceDirectory,
        });

        return {
            context,
            versionId: resolvedVersionId,
        };
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
): Promise<PushWorldResult> {
    const context = resolveWorldS3Context(projectRoot, config, worldName);
    const client = createS3ClientForWorld(config);
    const versioning = await resolveWorldVersioningStatus(client, context);
    assertWorldVersioningAvailable(versioning);
    await assertValidProjectWorldSource(
        projectRoot,
        context.worldSourcePath,
        `push world "${worldName}"`,
    );

    const lockHandle = await acquireRemoteWorldLock(
        projectRoot,
        config,
        worldName,
        {
            command: "push",
            force: options.forceLock,
            reason: options.reason,
            debug: options.debug,
        },
    );
    let shouldReleaseLock = true;

    const archivePath = resolveTemporaryWorldArchivePath(context);

    try {
        const [latestRemote, tracked] = await Promise.all([
            readRemoteWorldObjectMetadata(client, context),
            readTrackedWorldBinding(projectRoot, context),
        ]);

        if (!options.allowRemoteConflict) {
            assertTrackedWorldSafeToPush({
                worldName,
                tracked,
                latestRemoteVersionId: latestRemote?.versionId,
            });
        }

        await createWorldArchive(context.worldSourceDirectory, archivePath);
        const payload = await readFile(archivePath);
        const response = await client.send(
            new PutObjectCommand({
                Bucket: context.bucket,
                Key: context.objectKey,
                Body: payload,
                ContentType: "application/zip",
                Metadata: createWorldObjectMetadata({
                    actor: lockHandle.lock.actor,
                    projectName: config.project.name,
                    packageName: config.project.packageName,
                    cliVersion: lockHandle.lock.cliVersion,
                    reason: options.reason ?? lockHandle.lock.reason,
                }),
            }),
        );
        if (!response.VersionId) {
            throw new Error(
                `Remote world version ID is missing after pushing s3://${context.bucket}/${context.objectKey}.`,
            );
        }

        await persistTrackedProjectWorldState(projectRoot, context, {
            versionId: response.VersionId,
        });
        await markProjectWorldMaterializedFromRemote(projectRoot, {
            worldName,
            remoteFingerprint: buildTrackedProjectWorldFingerprint({
                backend: "s3",
                bucket: context.bucket,
                endpoint: context.endpoint,
                objectKey: context.objectKey,
            }),
            versionId: response.VersionId,
        });
        options.debug?.log("world", "pushed world to s3", {
            worldName,
            bucket: context.bucket,
            objectKey: context.objectKey,
            versionId: response.VersionId,
            archivePath,
            worldSourceDirectory: context.worldSourceDirectory,
        });
        await removeDirectory(archivePath);
        await pruneWorldCacheDirectory(context);

        if (options.unlock ?? true) {
            await releaseRemoteWorldLock(projectRoot, config, worldName, {
                debug: options.debug,
            });
        } else {
            shouldReleaseLock = false;
        }

        return {
            context,
            versioning,
            versionId: response.VersionId,
        };
    } catch (error) {
        if (shouldReleaseLock && lockHandle.releaseOnFailure) {
            try {
                await releaseRemoteWorldLock(projectRoot, config, worldName, {
                    debug: options.debug,
                });
            } catch (unlockError) {
                options.debug?.log(
                    "world",
                    "failed to release remote world lock after push failure",
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
        await removeDirectory(archivePath);
        throw error;
    }
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
    const [lock, versioning, latestObject, tracked, materializedRemote] =
        await Promise.all([
            readRemoteLock(client, context),
            resolveWorldVersioningStatus(client, context),
            readRemoteWorldObjectMetadata(client, context),
            readTrackedWorldBinding(projectRoot, context),
            readMaterializedProjectWorldRemoteState(projectRoot, worldName),
        ]);
    const remoteObjectExists = Boolean(latestObject);

    debug?.log("world", "resolved world status", {
        worldName,
        bucket: context.bucket,
        objectKey: context.objectKey,
        lockKey: context.lockKey,
        versioning,
        trackedVersionId: tracked.entry?.versionId,
        trackedMatchesCurrentRemote: tracked.matchesCurrentRemote,
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
            cacheDirectory: context.cacheDirectory,
            versioning,
            latestObject,
            tracked: tracked.entry
                ? {
                      versionId: tracked.entry.versionId,
                      remoteFingerprint: tracked.entry.remoteFingerprint,
                      matchesCurrentRemote: tracked.matchesCurrentRemote,
                  }
                : undefined,
            materializedRemote: materializedRemote
                ? {
                      versionId: materializedRemote.versionId,
                      remoteFingerprint: materializedRemote.remoteFingerprint,
                      materializedAt: materializedRemote.materializedAt,
                      matchesCurrentRemote:
                          materializedRemote.remoteFingerprint ===
                          tracked.currentFingerprint,
                  }
                : undefined,
            lock: lock.lock,
            remoteObjectExists,
        },
    };
}
