import assert from "node:assert/strict";
import { mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { S3Client, S3ServiceException } from "@aws-sdk/client-s3";
import AdmZip from "adm-zip";
import {
    runWorldListCommand,
    runWorldPushCommand,
    runWorldVersionsCommand,
} from "../src/commands/world.js";
import { loadBlurConfig } from "../src/config.js";
import { exists } from "../src/fs.js";
import { buildTrackedProjectWorldFingerprint } from "../src/project-world-state.js";
import {
    describeWorldStatus,
    listRemoteWorldVersionsFromS3,
    listRemoteWorldsFromS3,
    pullWorldFromS3,
    pushWorldToS3,
    WorldPushRemoteConflictError,
} from "../src/world-backend.js";
import { createTempDirectory, readJsonFile, writeJsonFile } from "./helpers.js";

function createBehaviorManifest(projectName: string) {
    return {
        format_version: 2,
        header: {
            name: `${projectName} Behavior Pack`,
            description: `${projectName} behavior pack`,
            uuid: "11111111-1111-1111-1111-111111111111",
            version: [0, 1, 0],
            min_engine_version: [1, 26, 0],
        },
        modules: [
            {
                type: "data",
                uuid: "22222222-2222-2222-2222-222222222222",
                version: [0, 1, 0],
            },
        ],
    };
}

async function createMinimalProject(
    projectRoot: string,
    config: Record<string, unknown>,
): Promise<void> {
    await mkdir(path.join(projectRoot, "behavior_packs", "example-pack"), {
        recursive: true,
    });
    await writeJsonFile(path.join(projectRoot, "package.json"), {
        name: "example-project",
        private: true,
    });
    await writeJsonFile(
        path.join(
            projectRoot,
            "behavior_packs",
            "example-pack",
            "manifest.json",
        ),
        createBehaviorManifest("example-project"),
    );
    await writeJsonFile(path.join(projectRoot, "blr.config.json"), config);
}

function createS3Error(
    name: string,
    httpStatusCode: number,
): S3ServiceException {
    return new S3ServiceException({
        name,
        $fault: "server",
        $metadata: {
            httpStatusCode,
        },
        message: name,
    });
}

function createWorldArchiveBuffer(): Buffer {
    const archive = new AdmZip();
    archive.addFile("db/.keep", Buffer.alloc(0));
    archive.addFile("levelname.txt", Buffer.from("hello"));
    return archive.toBuffer();
}

function isLockObjectKey(key: string | undefined): boolean {
    return typeof key === "string" && key.endsWith(".lock.json");
}

test("listRemoteWorldsFromS3 lists world zip objects and ignores lock or unrelated keys", async (t) => {
    const projectRoot = await createTempDirectory(t, "blr-world-list-");
    await createMinimalProject(projectRoot, {
        schemaVersion: 1,
        projectVersion: 1,
        namespace: "bc_df",
        world: {
            backend: "s3",
            s3: {
                bucket: "mpl-worlds",
                region: "eu-west-2",
                keyPrefix: "worlds",
            },
        },
    });
    const { config } = await loadBlurConfig(projectRoot);

    const originalSend = (S3Client.prototype as any).send;
    (S3Client.prototype as any).send = async (command: any) => {
        switch (command.constructor.name) {
            case "GetBucketVersioningCommand":
                return { Status: "Suspended" };
            case "ListObjectsV2Command":
                return {
                    Contents: [
                        { Key: "worlds/Bedrock level.zip" },
                        { Key: "worlds/Bedrock level.lock.json" },
                        { Key: "worlds/Creative Sandbox.zip" },
                        { Key: "worlds/nested/ignored.zip" },
                        { Key: "other-prefix/Nope.zip" },
                    ],
                    IsTruncated: false,
                };
            default:
                throw new Error(
                    `Unexpected command ${command.constructor.name}`,
                );
        }
    };
    t.after(() => {
        (S3Client.prototype as any).send = originalSend;
    });

    const worlds = await listRemoteWorldsFromS3(projectRoot, config);
    assert.deepEqual(
        worlds.map((entry) => entry.worldName),
        ["Bedrock level", "Creative Sandbox"],
    );
    assert.equal(worlds[0]?.versioning.available, false);
    assert.equal(worlds[0]?.latestObject, undefined);
    assert.match(
        worlds[0]?.versioning.detail ?? "",
        /bucket versioning is suspended/i,
    );
});

test("listRemoteWorldsFromS3 respects projectPrefix namespaces", async (t) => {
    const projectRoot = await createTempDirectory(t, "blr-world-list-prefix-");
    await createMinimalProject(projectRoot, {
        schemaVersion: 1,
        projectVersion: 1,
        namespace: "bc_df",
        world: {
            backend: "s3",
            s3: {
                bucket: "mpl-worlds",
                region: "eu-west-2",
                keyPrefix: "worlds",
                projectPrefix: true,
            },
        },
    });
    const { config } = await loadBlurConfig(projectRoot);
    const expectedProjectSegment = config.project.name;

    const originalSend = (S3Client.prototype as any).send;
    (S3Client.prototype as any).send = async (command: any) => {
        switch (command.constructor.name) {
            case "GetBucketVersioningCommand":
                return { Status: "Suspended" };
            case "ListObjectsV2Command":
                return {
                    Contents: [
                        {
                            Key: `worlds/${expectedProjectSegment}/Bedrock level.zip`,
                        },
                        { Key: "worlds/other-project/Other.zip" },
                    ],
                    IsTruncated: false,
                };
            default:
                throw new Error(
                    `Unexpected command ${command.constructor.name}`,
                );
        }
    };
    t.after(() => {
        (S3Client.prototype as any).send = originalSend;
    });

    const worlds = await listRemoteWorldsFromS3(projectRoot, config);
    assert.deepEqual(
        worlds.map((entry) => entry.worldName),
        ["Bedrock level"],
    );
});

test("listRemoteWorldVersionsFromS3 lists object versions when bucket versioning is enabled", async (t) => {
    const projectRoot = await createTempDirectory(t, "blr-world-versions-");
    await createMinimalProject(projectRoot, {
        schemaVersion: 1,
        projectVersion: 1,
        namespace: "bc_df",
        world: {
            backend: "s3",
            s3: {
                bucket: "mpl-worlds",
                region: "eu-west-2",
                keyPrefix: "worlds",
            },
        },
    });
    const { config } = await loadBlurConfig(projectRoot);

    const originalSend = (S3Client.prototype as any).send;
    (S3Client.prototype as any).send = async (command: any) => {
        switch (command.constructor.name) {
            case "GetBucketVersioningCommand":
                return { Status: "Enabled" };
            case "ListObjectVersionsCommand":
                return {
                    Versions: [
                        {
                            Key: "worlds/Bedrock level.zip",
                            VersionId: "ver-new",
                            IsLatest: true,
                            ETag: '"etag-new"',
                            LastModified: new Date("2026-04-01T12:00:00Z"),
                            Size: 128,
                        },
                        {
                            Key: "worlds/Bedrock level.zip",
                            VersionId: "ver-old",
                            IsLatest: false,
                            ETag: '"etag-old"',
                            LastModified: new Date("2026-03-31T12:00:00Z"),
                            Size: 64,
                        },
                    ],
                    IsTruncated: false,
                };
            case "HeadObjectCommand":
                return {
                    VersionId: command.input.VersionId,
                    Metadata:
                        command.input.VersionId === "ver-new"
                            ? {
                                  "blr-actor": "supah@devbox",
                                  "blr-reason": "publish latest world",
                                  "blr-pushed-at": "2026-04-01T12:00:00.000Z",
                              }
                            : {},
                };
            default:
                throw new Error(
                    `Unexpected command ${command.constructor.name}`,
                );
        }
    };
    t.after(() => {
        (S3Client.prototype as any).send = originalSend;
    });

    const listed = await listRemoteWorldVersionsFromS3(
        projectRoot,
        config,
        "Bedrock level",
    );
    assert.deepEqual(
        listed.versions.map((entry) => entry.versionId),
        ["ver-new", "ver-old"],
    );
    assert.equal(listed.pushMetadataSupport.available, true);
    assert.equal(listed.versions[0]?.isLatest, true);
    assert.equal(listed.versions[0]?.pushedBy, "supah@devbox");
    assert.equal(listed.versions[0]?.pushReason, "publish latest world");
    assert.equal(listed.versions[0]?.pushMetadataRecorded, true);
    assert.equal(listed.versions[1]?.pushMetadataRecorded, false);
});

test("listRemoteWorldVersionsFromS3 degrades cleanly when a version metadata lookup fails", async (t) => {
    const projectRoot = await createTempDirectory(
        t,
        "blr-world-versions-metadata-failure-",
    );
    await createMinimalProject(projectRoot, {
        schemaVersion: 1,
        projectVersion: 1,
        namespace: "bc_df",
        world: {
            backend: "s3",
            s3: {
                bucket: "mpl-worlds",
                region: "eu-west-2",
                keyPrefix: "worlds",
            },
        },
    });
    const { config } = await loadBlurConfig(projectRoot);

    const originalSend = (S3Client.prototype as any).send;
    (S3Client.prototype as any).send = async (command: any) => {
        switch (command.constructor.name) {
            case "GetBucketVersioningCommand":
                return { Status: "Enabled" };
            case "ListObjectVersionsCommand":
                return {
                    Versions: [
                        {
                            Key: "worlds/Bedrock level.zip",
                            VersionId: "null",
                            IsLatest: false,
                            ETag: '"etag-null"',
                            LastModified: new Date("2026-03-31T12:00:00Z"),
                            Size: 64,
                        },
                    ],
                    IsTruncated: false,
                };
            case "HeadObjectCommand":
                throw new Error("UnknownError");
            default:
                throw new Error(
                    `Unexpected command ${command.constructor.name}`,
                );
        }
    };
    t.after(() => {
        (S3Client.prototype as any).send = originalSend;
    });

    const listed = await listRemoteWorldVersionsFromS3(
        projectRoot,
        config,
        "Bedrock level",
    );
    assert.equal(listed.pushMetadataSupport.available, false);
    assert.match(
        listed.pushMetadataSupport.detail ?? "",
        /could not read push metadata/i,
    );
    assert.equal(listed.versions[0]?.versionId, "null");
    assert.equal(listed.versions[0]?.pushMetadataAvailable, false);
});

test("listRemoteWorldVersionsFromS3 falls back to the current object metadata for the latest version", async (t) => {
    const projectRoot = await createTempDirectory(
        t,
        "blr-world-versions-latest-metadata-fallback-",
    );
    await createMinimalProject(projectRoot, {
        schemaVersion: 1,
        projectVersion: 1,
        namespace: "bc_df",
        world: {
            backend: "s3",
            s3: {
                bucket: "mpl-worlds",
                region: "eu-west-2",
                keyPrefix: "worlds",
            },
        },
    });
    const { config } = await loadBlurConfig(projectRoot);

    const originalSend = (S3Client.prototype as any).send;
    (S3Client.prototype as any).send = async (command: any) => {
        switch (command.constructor.name) {
            case "GetBucketVersioningCommand":
                return { Status: "Enabled" };
            case "ListObjectVersionsCommand":
                return {
                    Versions: [
                        {
                            Key: "worlds/Bedrock level.zip",
                            VersionId: "ver-new",
                            IsLatest: true,
                            ETag: '"etag-new"',
                            LastModified: new Date("2026-04-01T12:00:00Z"),
                            Size: 128,
                        },
                    ],
                    IsTruncated: false,
                };
            case "HeadObjectCommand":
                if (typeof command.input.VersionId === "string") {
                    throw new Error("UnknownError");
                }
                return {
                    VersionId: "ver-new",
                    Metadata: {
                        "blr-actor": "supah@devbox",
                        "blr-reason": "publish latest world",
                        "blr-pushed-at": "2026-04-01T12:00:00.000Z",
                    },
                };
            default:
                throw new Error(
                    `Unexpected command ${command.constructor.name}`,
                );
        }
    };
    t.after(() => {
        (S3Client.prototype as any).send = originalSend;
    });

    const listed = await listRemoteWorldVersionsFromS3(
        projectRoot,
        config,
        "Bedrock level",
    );
    assert.equal(listed.versions[0]?.versionId, "ver-new");
    assert.equal(listed.versions[0]?.pushedBy, "supah@devbox");
    assert.equal(listed.versions[0]?.pushReason, "publish latest world");
    assert.equal(listed.versions[0]?.pushMetadataRecorded, true);
});

test("listRemoteWorldVersionsFromS3 fails cleanly when bucket versioning is unavailable", async (t) => {
    const projectRoot = await createTempDirectory(t, "blr-world-versions-off-");
    await createMinimalProject(projectRoot, {
        schemaVersion: 1,
        projectVersion: 1,
        namespace: "bc_df",
        world: {
            backend: "s3",
            s3: {
                bucket: "mpl-worlds",
                region: "eu-west-2",
                keyPrefix: "worlds",
            },
        },
    });
    const { config } = await loadBlurConfig(projectRoot);

    const originalSend = (S3Client.prototype as any).send;
    (S3Client.prototype as any).send = async (command: any) => {
        switch (command.constructor.name) {
            case "GetBucketVersioningCommand":
                return { Status: "Suspended" };
            default:
                throw new Error(
                    `Unexpected command ${command.constructor.name}`,
                );
        }
    };
    t.after(() => {
        (S3Client.prototype as any).send = originalSend;
    });

    await assert.rejects(
        () =>
            listRemoteWorldVersionsFromS3(projectRoot, config, "Bedrock level"),
        /Remote world version features are unavailable/,
    );
});

test("listRemoteWorldsFromS3 reports why versioning could not be verified", async (t) => {
    const projectRoot = await createTempDirectory(
        t,
        "blr-world-list-versioning-detail-",
    );
    await createMinimalProject(projectRoot, {
        schemaVersion: 1,
        projectVersion: 1,
        namespace: "bc_df",
        world: {
            backend: "s3",
            s3: {
                bucket: "mpl-worlds",
                region: "eu-west-2",
                keyPrefix: "worlds",
            },
        },
    });
    const { config } = await loadBlurConfig(projectRoot);

    const originalSend = (S3Client.prototype as any).send;
    (S3Client.prototype as any).send = async (command: any) => {
        switch (command.constructor.name) {
            case "GetBucketVersioningCommand":
                throw createS3Error("AccessDenied", 403);
            case "ListObjectsV2Command":
                return {
                    Contents: [{ Key: "worlds/Bedrock level.zip" }],
                    IsTruncated: false,
                };
            default:
                throw new Error(
                    `Unexpected command ${command.constructor.name}`,
                );
        }
    };
    t.after(() => {
        (S3Client.prototype as any).send = originalSend;
    });

    const worlds = await listRemoteWorldsFromS3(projectRoot, config);
    assert.equal(worlds[0]?.versioning.available, false);
    assert.match(worlds[0]?.versioning.detail ?? "", /s3:GetBucketVersioning/i);
});

test("pullWorldFromS3 persists the selected project pin and status keeps the tracked version separate from the latest remote version", async (t) => {
    const projectRoot = await createTempDirectory(t, "blr-world-pull-");
    await createMinimalProject(projectRoot, {
        schemaVersion: 1,
        projectVersion: 1,
        namespace: "bc_df",
        world: {
            backend: "s3",
            s3: {
                bucket: "mpl-worlds",
                region: "eu-west-2",
                keyPrefix: "worlds",
            },
        },
    });
    const { config } = await loadBlurConfig(projectRoot);
    const archiveBuffer = createWorldArchiveBuffer();
    let latestVersionId = "ver-old";

    const originalSend = (S3Client.prototype as any).send;
    (S3Client.prototype as any).send = async (command: any) => {
        switch (command.constructor.name) {
            case "GetBucketVersioningCommand":
                return { Status: "Enabled" };
            case "HeadObjectCommand":
                return {
                    VersionId: command.input.VersionId ?? latestVersionId,
                    ETag: '"etag-head"',
                    LastModified: new Date("2026-04-01T12:00:00Z"),
                    ContentLength: archiveBuffer.byteLength,
                };
            case "GetObjectCommand":
                if (isLockObjectKey(command.input.Key)) {
                    throw createS3Error("NoSuchKey", 404);
                }
                return {
                    Body: {
                        async transformToByteArray() {
                            return new Uint8Array(archiveBuffer);
                        },
                    },
                    VersionId: command.input.VersionId ?? latestVersionId,
                    ETag: '"etag-get"',
                    LastModified: new Date("2026-04-01T12:00:00Z"),
                };
            case "PutObjectCommand":
                return { ETag: '"etag-lock"' };
            case "DeleteObjectCommand":
                return {};
            default:
                throw new Error(
                    `Unexpected command ${command.constructor.name}`,
                );
        }
    };
    t.after(() => {
        (S3Client.prototype as any).send = originalSend;
    });

    const pulled = await pullWorldFromS3(projectRoot, config, "Bedrock level", {
        versionId: "ver-old",
    });
    const cachedFiles = await readdir(pulled.context.cacheDirectory);
    assert.equal(
        await exists(path.join(pulled.context.cacheDirectory, "metadata.json")),
        false,
    );
    assert.equal(pulled.versionId, "ver-old");
    assert.equal(
        cachedFiles.some((entry) => entry.endsWith(".zip")),
        true,
    );

    const trackedWorlds = await readJsonFile<{
        schemaVersion: number;
        worlds: Array<{
            name: string;
            remoteFingerprint: string;
            versionId: string;
        }>;
    }>(path.join(projectRoot, "worlds", "worlds.json"));
    assert.equal(trackedWorlds.schemaVersion, 1);
    assert.equal(trackedWorlds.worlds[0]?.name, "Bedrock level");
    assert.equal(trackedWorlds.worlds[0]?.versionId, "ver-old");
    assert.match(trackedWorlds.worlds[0]?.remoteFingerprint ?? "", /^sha256:/);

    latestVersionId = "ver-new";
    const status = await describeWorldStatus(
        projectRoot,
        config,
        "Bedrock level",
    );
    assert.equal(status.backend, "s3");
    assert.equal(status.s3?.versioning.available, true);
    assert.equal(status.s3?.latestObject?.versionId, "ver-new");
    assert.equal(status.s3?.materializedRemote?.versionId, "ver-old");
    assert.equal(status.s3?.tracked?.versionId, "ver-old");
    assert.equal(status.s3?.tracked?.matchesCurrentRemote, true);
    assert.equal(status.s3?.materializedRemote?.matchesCurrentRemote, true);
});

test("pullWorldFromS3 downloads a versioned world without requiring a versioned metadata head request", async (t) => {
    const projectRoot = await createTempDirectory(
        t,
        "blr-world-pull-versioned-get-",
    );
    await createMinimalProject(projectRoot, {
        schemaVersion: 1,
        projectVersion: 1,
        namespace: "bc_df",
        world: {
            backend: "s3",
            s3: {
                bucket: "mpl-worlds",
                region: "eu-west-2",
                keyPrefix: "worlds",
            },
        },
    });
    const { config } = await loadBlurConfig(projectRoot);
    const archiveBuffer = createWorldArchiveBuffer();

    const originalSend = (S3Client.prototype as any).send;
    (S3Client.prototype as any).send = async (command: any) => {
        switch (command.constructor.name) {
            case "GetBucketVersioningCommand":
                return { Status: "Enabled" };
            case "HeadObjectCommand":
                if (typeof command.input.VersionId === "string") {
                    throw new Error(
                        "blr should not use HeadObject to pull a specific world version",
                    );
                }
                return {
                    VersionId: "ver-latest",
                    ETag: '"etag-head"',
                    LastModified: new Date("2026-04-01T12:00:00Z"),
                    ContentLength: archiveBuffer.byteLength,
                };
            case "GetObjectCommand":
                if (isLockObjectKey(command.input.Key)) {
                    throw createS3Error("NoSuchKey", 404);
                }
                assert.equal(command.input.VersionId, "ver-old");
                return {
                    Body: {
                        async transformToByteArray() {
                            return new Uint8Array(archiveBuffer);
                        },
                    },
                    VersionId: "ver-old",
                    ETag: '"etag-get"',
                    LastModified: new Date("2026-04-01T12:00:00Z"),
                };
            case "PutObjectCommand":
                return { ETag: '"etag-lock"' };
            case "DeleteObjectCommand":
                return {};
            default:
                throw new Error(
                    `Unexpected command ${command.constructor.name}`,
                );
        }
    };
    t.after(() => {
        (S3Client.prototype as any).send = originalSend;
    });

    const pulled = await pullWorldFromS3(projectRoot, config, "Bedrock level", {
        versionId: "ver-old",
    });
    assert.equal(pulled.versionId, "ver-old");
});

test("describeWorldStatus reports a useful message when the backend cannot inspect the remote world object", async (t) => {
    const projectRoot = await createTempDirectory(
        t,
        "blr-world-status-unknown-error-",
    );
    await createMinimalProject(projectRoot, {
        schemaVersion: 1,
        projectVersion: 1,
        namespace: "bc_df",
        world: {
            backend: "s3",
            s3: {
                bucket: "mpl-worlds",
                region: "eu-west-2",
                keyPrefix: "worlds",
            },
        },
    });
    const { config } = await loadBlurConfig(projectRoot);

    const originalSend = (S3Client.prototype as any).send;
    (S3Client.prototype as any).send = async (command: any) => {
        switch (command.constructor.name) {
            case "GetBucketVersioningCommand":
                return { Status: "Enabled" };
            case "GetObjectCommand":
                if (isLockObjectKey(command.input.Key)) {
                    throw createS3Error("NoSuchKey", 404);
                }
                throw new Error(
                    `Unexpected command ${command.constructor.name}`,
                );
            case "HeadObjectCommand":
                throw new Error("UnknownError");
            default:
                throw new Error(
                    `Unexpected command ${command.constructor.name}`,
                );
        }
    };
    t.after(() => {
        (S3Client.prototype as any).send = originalSend;
    });

    await assert.rejects(
        () => describeWorldStatus(projectRoot, config, "Bedrock level"),
        /could not inspect remote world object .* because the S3 backend returned an unknown error/i,
    );
});

test("describeWorldStatus reports tracked-world fingerprint drift when the project pin belongs to a different remote target", async (t) => {
    const projectRoot = await createTempDirectory(t, "blr-world-status-drift-");
    await createMinimalProject(projectRoot, {
        schemaVersion: 1,
        projectVersion: 1,
        namespace: "bc_df",
        world: {
            backend: "s3",
            s3: {
                bucket: "mpl-worlds",
                region: "eu-west-2",
                keyPrefix: "worlds",
            },
        },
    });
    const { config } = await loadBlurConfig(projectRoot);
    await mkdir(path.join(projectRoot, "worlds"), { recursive: true });
    await writeJsonFile(path.join(projectRoot, "worlds", "worlds.json"), {
        schemaVersion: 1,
        worlds: [
            {
                name: "Bedrock level",
                remoteFingerprint: "sha256:wrong",
                versionId: "ver-old",
            },
        ],
    });

    const originalSend = (S3Client.prototype as any).send;
    (S3Client.prototype as any).send = async (command: any) => {
        switch (command.constructor.name) {
            case "GetBucketVersioningCommand":
                return { Status: "Enabled" };
            case "HeadObjectCommand":
                return {
                    VersionId: "ver-new",
                    ETag: '"etag-head"',
                    LastModified: new Date("2026-04-01T12:00:00Z"),
                    ContentLength: 128,
                };
            case "GetObjectCommand":
                if (isLockObjectKey(command.input.Key)) {
                    throw createS3Error("NoSuchKey", 404);
                }
                throw new Error(
                    `Unexpected world object read for ${command.input.Key}`,
                );
            default:
                throw new Error(
                    `Unexpected command ${command.constructor.name}`,
                );
        }
    };
    t.after(() => {
        (S3Client.prototype as any).send = originalSend;
    });

    const status = await describeWorldStatus(
        projectRoot,
        config,
        "Bedrock level",
    );
    assert.equal(status.s3?.tracked?.versionId, "ver-old");
    assert.equal(status.s3?.tracked?.matchesCurrentRemote, false);
    assert.equal(status.s3?.tracked?.remoteFingerprint, "sha256:wrong");
});

test("pushWorldToS3 returns the pushed version id and writes the minimal tracked world pin when bucket versioning is enabled", async (t) => {
    const projectRoot = await createTempDirectory(t, "blr-world-push-");
    await createMinimalProject(projectRoot, {
        schemaVersion: 1,
        projectVersion: 1,
        namespace: "bc_df",
        world: {
            backend: "s3",
            s3: {
                bucket: "mpl-worlds",
                region: "eu-west-2",
                keyPrefix: "worlds",
            },
        },
    });
    const { config } = await loadBlurConfig(projectRoot);
    const worldSourceDirectory = path.join(
        projectRoot,
        "worlds",
        "Bedrock level",
    );
    await mkdir(path.join(worldSourceDirectory, "db"), { recursive: true });

    const originalSend = (S3Client.prototype as any).send;
    (S3Client.prototype as any).send = async (command: any) => {
        switch (command.constructor.name) {
            case "GetBucketVersioningCommand":
                return { Status: "Enabled" };
            case "HeadObjectCommand":
                throw createS3Error("NotFound", 404);
            case "GetObjectCommand":
                if (isLockObjectKey(command.input.Key)) {
                    throw createS3Error("NoSuchKey", 404);
                }
                throw new Error(
                    `Unexpected command ${command.constructor.name}`,
                );
            case "PutObjectCommand":
                if (isLockObjectKey(command.input.Key)) {
                    return { ETag: '"etag-lock"' };
                }
                return {
                    VersionId: "ver-pushed",
                    ETag: '"etag-pushed"',
                };
            case "DeleteObjectCommand":
                return {};
            default:
                throw new Error(
                    `Unexpected command ${command.constructor.name}`,
                );
        }
    };
    t.after(() => {
        (S3Client.prototype as any).send = originalSend;
    });

    const pushed = await pushWorldToS3(projectRoot, config, "Bedrock level", {
        forceLock: true,
    });
    const expectedFingerprint = buildTrackedProjectWorldFingerprint({
        backend: "s3",
        bucket: "mpl-worlds",
        endpoint: "",
        objectKey: "worlds/Bedrock level.zip",
    });

    assert.equal(pushed.versioning.available, true);
    assert.equal(pushed.versionId, "ver-pushed");

    const trackedWorlds = await readJsonFile<{
        schemaVersion: number;
        worlds: Array<{
            name: string;
            remoteFingerprint: string;
            versionId: string;
        }>;
    }>(path.join(projectRoot, "worlds", "worlds.json"));
    assert.equal(trackedWorlds.schemaVersion, 1);
    assert.equal(trackedWorlds.worlds[0]?.name, "Bedrock level");
    assert.equal(trackedWorlds.worlds[0]?.versionId, "ver-pushed");
    assert.equal(
        trackedWorlds.worlds[0]?.remoteFingerprint,
        expectedFingerprint,
    );
});

test("pullWorldFromS3 rejects when bucket versioning is unavailable", async (t) => {
    const projectRoot = await createTempDirectory(
        t,
        "blr-world-pull-nonversioned-",
    );
    await createMinimalProject(projectRoot, {
        schemaVersion: 1,
        projectVersion: 1,
        namespace: "bc_df",
        world: {
            backend: "s3",
            s3: {
                bucket: "mpl-worlds",
                region: "eu-west-2",
                keyPrefix: "worlds",
            },
        },
    });
    const { config } = await loadBlurConfig(projectRoot);

    const originalSend = (S3Client.prototype as any).send;
    (S3Client.prototype as any).send = async (command: any) => {
        switch (command.constructor.name) {
            case "GetBucketVersioningCommand":
                return { Status: "Suspended" };
            default:
                throw new Error(
                    `Unexpected command ${command.constructor.name}`,
                );
        }
    };
    t.after(() => {
        (S3Client.prototype as any).send = originalSend;
    });

    await assert.rejects(
        () => pullWorldFromS3(projectRoot, config, "Bedrock level"),
        /Remote world version features are unavailable/,
    );
    assert.equal(
        await exists(path.join(projectRoot, "worlds", "worlds.json")),
        false,
    );
});

test("pushWorldToS3 rejects when bucket versioning is unavailable", async (t) => {
    const projectRoot = await createTempDirectory(
        t,
        "blr-world-push-nonversioned-",
    );
    await createMinimalProject(projectRoot, {
        schemaVersion: 1,
        projectVersion: 1,
        namespace: "bc_df",
        world: {
            backend: "s3",
            s3: {
                bucket: "mpl-worlds",
                region: "eu-west-2",
                keyPrefix: "worlds",
            },
        },
    });
    const { config } = await loadBlurConfig(projectRoot);
    const worldSourceDirectory = path.join(
        projectRoot,
        "worlds",
        "Bedrock level",
    );
    await mkdir(path.join(worldSourceDirectory, "db"), { recursive: true });

    const originalSend = (S3Client.prototype as any).send;
    (S3Client.prototype as any).send = async (command: any) => {
        switch (command.constructor.name) {
            case "GetBucketVersioningCommand":
                return { Status: "Suspended" };
            default:
                throw new Error(
                    `Unexpected command ${command.constructor.name}`,
                );
        }
    };
    t.after(() => {
        (S3Client.prototype as any).send = originalSend;
    });

    await assert.rejects(
        () => pushWorldToS3(projectRoot, config, "Bedrock level"),
        /Remote world version features are unavailable/,
    );
    assert.equal(
        await exists(path.join(projectRoot, "worlds", "worlds.json")),
        false,
    );
});

test("pushWorldToS3 rejects when the project does not track a remote world version and the remote already has a latest version", async (t) => {
    const projectRoot = await createTempDirectory(
        t,
        "blr-world-push-conflict-untracked-",
    );
    await createMinimalProject(projectRoot, {
        schemaVersion: 1,
        projectVersion: 1,
        namespace: "bc_df",
        world: {
            backend: "s3",
            s3: {
                bucket: "mpl-worlds",
                region: "eu-west-2",
                keyPrefix: "worlds",
            },
        },
    });
    const { config } = await loadBlurConfig(projectRoot);
    const worldSourceDirectory = path.join(
        projectRoot,
        "worlds",
        "Bedrock level",
    );
    await mkdir(path.join(worldSourceDirectory, "db"), { recursive: true });

    const originalSend = (S3Client.prototype as any).send;
    (S3Client.prototype as any).send = async (command: any) => {
        switch (command.constructor.name) {
            case "GetBucketVersioningCommand":
                return { Status: "Enabled" };
            case "HeadObjectCommand":
                return {
                    VersionId: "ver-remote",
                    ETag: '"etag-head"',
                    LastModified: new Date("2026-04-01T12:00:00Z"),
                    ContentLength: 128,
                };
            case "GetObjectCommand":
                if (isLockObjectKey(command.input.Key)) {
                    throw createS3Error("NoSuchKey", 404);
                }
                throw new Error(
                    `Unexpected command ${command.constructor.name}`,
                );
            case "PutObjectCommand":
                if (isLockObjectKey(command.input.Key)) {
                    return { ETag: '"etag-lock"' };
                }
                throw new Error(
                    "World object upload should not run after conflict",
                );
            case "DeleteObjectCommand":
                return {};
            default:
                throw new Error(
                    `Unexpected command ${command.constructor.name}`,
                );
        }
    };
    t.after(() => {
        (S3Client.prototype as any).send = originalSend;
    });

    await assert.rejects(
        () => pushWorldToS3(projectRoot, config, "Bedrock level"),
        (error: unknown) => {
            assert.ok(error instanceof WorldPushRemoteConflictError);
            assert.equal(error.kind, "missing-tracked-version");
            assert.match(
                error.message,
                /does not track a remote world version/i,
            );
            return true;
        },
    );
});

test("pushWorldToS3 rejects when the tracked project pin does not match the latest remote version", async (t) => {
    const projectRoot = await createTempDirectory(
        t,
        "blr-world-push-conflict-version-",
    );
    await createMinimalProject(projectRoot, {
        schemaVersion: 1,
        projectVersion: 1,
        namespace: "bc_df",
        world: {
            backend: "s3",
            s3: {
                bucket: "mpl-worlds",
                region: "eu-west-2",
                keyPrefix: "worlds",
            },
        },
    });
    const { config } = await loadBlurConfig(projectRoot);
    const worldSourceDirectory = path.join(
        projectRoot,
        "worlds",
        "Bedrock level",
    );
    await mkdir(path.join(worldSourceDirectory, "db"), { recursive: true });
    await writeJsonFile(path.join(projectRoot, "worlds", "worlds.json"), {
        schemaVersion: 1,
        worlds: [
            {
                name: "Bedrock level",
                remoteFingerprint: buildTrackedProjectWorldFingerprint({
                    backend: "s3",
                    bucket: "mpl-worlds",
                    endpoint: "",
                    objectKey: "worlds/Bedrock level.zip",
                }),
                versionId: "ver-old",
            },
        ],
    });

    const originalSend = (S3Client.prototype as any).send;
    (S3Client.prototype as any).send = async (command: any) => {
        switch (command.constructor.name) {
            case "GetBucketVersioningCommand":
                return { Status: "Enabled" };
            case "HeadObjectCommand":
                return {
                    VersionId: "ver-new",
                    ETag: '"etag-head"',
                    LastModified: new Date("2026-04-01T12:00:00Z"),
                    ContentLength: 128,
                };
            case "GetObjectCommand":
                if (isLockObjectKey(command.input.Key)) {
                    throw createS3Error("NoSuchKey", 404);
                }
                throw new Error(
                    `Unexpected command ${command.constructor.name}`,
                );
            case "PutObjectCommand":
                if (isLockObjectKey(command.input.Key)) {
                    return { ETag: '"etag-lock"' };
                }
                throw new Error(
                    "World object upload should not run after conflict",
                );
            case "DeleteObjectCommand":
                return {};
            default:
                throw new Error(
                    `Unexpected command ${command.constructor.name}`,
                );
        }
    };
    t.after(() => {
        (S3Client.prototype as any).send = originalSend;
    });

    await assert.rejects(
        () => pushWorldToS3(projectRoot, config, "Bedrock level"),
        (error: unknown) => {
            assert.ok(error instanceof WorldPushRemoteConflictError);
            assert.equal(error.kind, "remote-version-mismatch");
            assert.match(error.message, /latest remote version is ver-new/i);
            return true;
        },
    );
});

test("runWorldPushCommand prints the pushed version id on success", async (t) => {
    const projectRoot = await createTempDirectory(t, "blr-world-push-output-");
    await createMinimalProject(projectRoot, {
        schemaVersion: 1,
        projectVersion: 1,
        namespace: "bc_df",
        world: {
            backend: "s3",
            s3: {
                bucket: "mpl-worlds",
                region: "eu-west-2",
                keyPrefix: "worlds",
            },
        },
        dev: {
            localServer: {
                worldName: "Bedrock level",
            },
        },
    });
    const worldSourceDirectory = path.join(
        projectRoot,
        "worlds",
        "Bedrock level",
    );
    await mkdir(path.join(worldSourceDirectory, "db"), { recursive: true });

    const previousCwd = process.cwd();
    process.chdir(projectRoot);
    t.after(() => {
        process.chdir(previousCwd);
    });

    const logLines: string[] = [];
    const originalLog = console.log;
    console.log = (message?: unknown) => {
        logLines.push(String(message));
    };
    t.after(() => {
        console.log = originalLog;
    });

    const originalSend = (S3Client.prototype as any).send;
    (S3Client.prototype as any).send = async (command: any) => {
        switch (command.constructor.name) {
            case "GetBucketVersioningCommand":
                return { Status: "Enabled" };
            case "HeadObjectCommand":
                throw createS3Error("NotFound", 404);
            case "GetObjectCommand":
                if (isLockObjectKey(command.input.Key)) {
                    throw createS3Error("NoSuchKey", 404);
                }
                throw new Error(
                    `Unexpected command ${command.constructor.name}`,
                );
            case "PutObjectCommand":
                if (isLockObjectKey(command.input.Key)) {
                    return { ETag: '"etag-lock"' };
                }
                return {
                    VersionId: "ver-pushed",
                    ETag: '"etag-pushed"',
                };
            case "DeleteObjectCommand":
                return {};
            default:
                throw new Error(
                    `Unexpected command ${command.constructor.name}`,
                );
        }
    };
    t.after(() => {
        (S3Client.prototype as any).send = originalSend;
    });

    await runWorldPushCommand(undefined, {});
    assert.match(logLines[0] ?? "", /as version ver-pushed/);
});

test("runWorldVersionsCommand shows push actor metadata when it is recorded and stays quiet for versions without it", async (t) => {
    const projectRoot = await createTempDirectory(
        t,
        "blr-world-versions-output-",
    );
    await createMinimalProject(projectRoot, {
        schemaVersion: 1,
        projectVersion: 1,
        namespace: "bc_df",
        world: {
            backend: "s3",
            s3: {
                bucket: "mpl-worlds",
                region: "eu-west-2",
                keyPrefix: "worlds",
            },
        },
        dev: {
            localServer: {
                worldName: "Bedrock level",
            },
        },
    });

    const previousCwd = process.cwd();
    process.chdir(projectRoot);
    t.after(() => {
        process.chdir(previousCwd);
    });

    const logLines: string[] = [];
    const warnLines: string[] = [];
    const originalLog = console.log;
    const originalWarn = console.warn;
    console.log = (message?: unknown) => {
        logLines.push(String(message));
    };
    console.warn = (message?: unknown) => {
        warnLines.push(String(message));
    };
    t.after(() => {
        console.log = originalLog;
        console.warn = originalWarn;
    });

    const originalSend = (S3Client.prototype as any).send;
    (S3Client.prototype as any).send = async (command: any) => {
        switch (command.constructor.name) {
            case "GetBucketVersioningCommand":
                return { Status: "Enabled" };
            case "ListObjectVersionsCommand":
                return {
                    Versions: [
                        {
                            Key: "worlds/Bedrock level.zip",
                            VersionId: "ver-new",
                            IsLatest: true,
                            ETag: '"etag-new"',
                            LastModified: new Date("2026-04-01T12:00:00Z"),
                            Size: 128,
                        },
                        {
                            Key: "worlds/Bedrock level.zip",
                            VersionId: "ver-old",
                            IsLatest: false,
                            ETag: '"etag-old"',
                            LastModified: new Date("2026-03-31T12:00:00Z"),
                            Size: 64,
                        },
                    ],
                    IsTruncated: false,
                };
            case "HeadObjectCommand":
                return {
                    VersionId: command.input.VersionId,
                    Metadata:
                        command.input.VersionId === "ver-new"
                            ? {
                                  "blr-actor": "supah@devbox",
                                  "blr-reason": "publish latest world",
                              }
                            : {},
                };
            default:
                throw new Error(
                    `Unexpected command ${command.constructor.name}`,
                );
        }
    };
    t.after(() => {
        (S3Client.prototype as any).send = originalSend;
    });

    await runWorldVersionsCommand(undefined, {});
    assert.equal(logLines[0], '[world] Remote versions for "Bedrock level":');
    assert.match(logLines[1] ?? "", /ver-new latest .* by supah@devbox/);
    assert.match(logLines[1] ?? "", /\(publish latest world\)/);
    assert.equal(warnLines.length, 0);
});

test("runWorldVersionsCommand skips author output instead of failing when version metadata cannot be read", async (t) => {
    const projectRoot = await createTempDirectory(
        t,
        "blr-world-versions-metadata-warning-",
    );
    await createMinimalProject(projectRoot, {
        schemaVersion: 1,
        projectVersion: 1,
        namespace: "bc_df",
        world: {
            backend: "s3",
            s3: {
                bucket: "mpl-worlds",
                region: "eu-west-2",
                keyPrefix: "worlds",
            },
        },
        dev: {
            localServer: {
                worldName: "Bedrock level",
            },
        },
    });

    const previousCwd = process.cwd();
    process.chdir(projectRoot);
    t.after(() => {
        process.chdir(previousCwd);
    });

    const logLines: string[] = [];
    const warnLines: string[] = [];
    const originalLog = console.log;
    const originalWarn = console.warn;
    console.log = (message?: unknown) => {
        logLines.push(String(message));
    };
    console.warn = (message?: unknown) => {
        warnLines.push(String(message));
    };
    t.after(() => {
        console.log = originalLog;
        console.warn = originalWarn;
    });

    const originalSend = (S3Client.prototype as any).send;
    (S3Client.prototype as any).send = async (command: any) => {
        switch (command.constructor.name) {
            case "GetBucketVersioningCommand":
                return { Status: "Enabled" };
            case "ListObjectVersionsCommand":
                return {
                    Versions: [
                        {
                            Key: "worlds/Bedrock level.zip",
                            VersionId: "null",
                            IsLatest: false,
                            ETag: '"etag-null"',
                            LastModified: new Date("2026-03-31T12:00:00Z"),
                            Size: 64,
                        },
                    ],
                    IsTruncated: false,
                };
            case "HeadObjectCommand":
                throw new Error("UnknownError");
            default:
                throw new Error(
                    `Unexpected command ${command.constructor.name}`,
                );
        }
    };
    t.after(() => {
        (S3Client.prototype as any).send = originalSend;
    });

    await runWorldVersionsCommand(undefined, {});
    assert.match(logLines[1] ?? "", /null \(pre-versioning object\)/);
    assert.equal(warnLines.length, 0);
});

test("runWorldVersionsCommand shows the latest actor when the backend only returns metadata for the current object", async (t) => {
    const projectRoot = await createTempDirectory(
        t,
        "blr-world-versions-command-latest-metadata-fallback-",
    );
    await createMinimalProject(projectRoot, {
        schemaVersion: 1,
        projectVersion: 1,
        namespace: "bc_df",
        world: {
            backend: "s3",
            s3: {
                bucket: "mpl-worlds",
                region: "eu-west-2",
                keyPrefix: "worlds",
            },
        },
        dev: {
            localServer: {
                worldName: "Bedrock level",
            },
        },
    });

    const previousCwd = process.cwd();
    process.chdir(projectRoot);
    t.after(() => {
        process.chdir(previousCwd);
    });

    const logLines: string[] = [];
    const warnLines: string[] = [];
    const originalLog = console.log;
    const originalWarn = console.warn;
    console.log = (message?: unknown) => {
        logLines.push(String(message));
    };
    console.warn = (message?: unknown) => {
        warnLines.push(String(message));
    };
    t.after(() => {
        console.log = originalLog;
        console.warn = originalWarn;
    });

    const originalSend = (S3Client.prototype as any).send;
    (S3Client.prototype as any).send = async (command: any) => {
        switch (command.constructor.name) {
            case "GetBucketVersioningCommand":
                return { Status: "Enabled" };
            case "ListObjectVersionsCommand":
                return {
                    Versions: [
                        {
                            Key: "worlds/Bedrock level.zip",
                            VersionId: "ver-new",
                            IsLatest: true,
                            ETag: '"etag-new"',
                            LastModified: new Date("2026-04-01T12:00:00Z"),
                            Size: 128,
                        },
                    ],
                    IsTruncated: false,
                };
            case "HeadObjectCommand":
                if (typeof command.input.VersionId === "string") {
                    throw new Error("UnknownError");
                }
                return {
                    VersionId: "ver-new",
                    Metadata: {
                        "blr-actor": "supah@devbox",
                        "blr-reason": "publish latest world",
                    },
                };
            default:
                throw new Error(
                    `Unexpected command ${command.constructor.name}`,
                );
        }
    };
    t.after(() => {
        (S3Client.prototype as any).send = originalSend;
    });

    await runWorldVersionsCommand(undefined, {});
    assert.match(logLines[1] ?? "", /ver-new latest .* by supah@devbox/);
    assert.equal(warnLines.length, 0);
});

test("runWorldPushCommand fails clearly in non-interactive mode when the remote has newer world state than the project pin", async (t) => {
    const projectRoot = await createTempDirectory(
        t,
        "blr-world-push-noninteractive-conflict-",
    );
    await createMinimalProject(projectRoot, {
        schemaVersion: 1,
        projectVersion: 1,
        namespace: "bc_df",
        world: {
            backend: "s3",
            s3: {
                bucket: "mpl-worlds",
                region: "eu-west-2",
                keyPrefix: "worlds",
            },
        },
        dev: {
            localServer: {
                worldName: "Bedrock level",
            },
        },
    });
    const worldSourceDirectory = path.join(
        projectRoot,
        "worlds",
        "Bedrock level",
    );
    await mkdir(path.join(worldSourceDirectory, "db"), { recursive: true });

    const previousCwd = process.cwd();
    process.chdir(projectRoot);
    t.after(() => {
        process.chdir(previousCwd);
    });

    const originalSend = (S3Client.prototype as any).send;
    (S3Client.prototype as any).send = async (command: any) => {
        switch (command.constructor.name) {
            case "GetBucketVersioningCommand":
                return { Status: "Enabled" };
            case "HeadObjectCommand":
                return {
                    VersionId: "ver-remote",
                    ETag: '"etag-head"',
                    LastModified: new Date("2026-04-01T12:00:00Z"),
                    ContentLength: 128,
                };
            case "GetObjectCommand":
                if (isLockObjectKey(command.input.Key)) {
                    throw createS3Error("NoSuchKey", 404);
                }
                throw new Error(
                    `Unexpected command ${command.constructor.name}`,
                );
            case "PutObjectCommand":
                if (isLockObjectKey(command.input.Key)) {
                    return { ETag: '"etag-lock"' };
                }
                throw new Error(
                    "World object upload should not run after conflict",
                );
            case "DeleteObjectCommand":
                return {};
            default:
                throw new Error(
                    `Unexpected command ${command.constructor.name}`,
                );
        }
    };
    t.after(() => {
        (S3Client.prototype as any).send = originalSend;
    });

    await assert.rejects(
        () => runWorldPushCommand(undefined, {}),
        /Re-run the command in an interactive terminal if you really want to push anyway\./,
    );
});

test("runWorldListCommand shows version-unavailable output and prints the versioning note", async (t) => {
    const projectRoot = await createTempDirectory(t, "blr-world-list-output-");
    await createMinimalProject(projectRoot, {
        schemaVersion: 1,
        projectVersion: 1,
        namespace: "bc_df",
        world: {
            backend: "s3",
            s3: {
                bucket: "mpl-worlds",
                region: "eu-west-2",
                keyPrefix: "worlds",
            },
        },
        dev: {
            localServer: {
                worldName: "Bedrock level",
            },
        },
    });

    const previousCwd = process.cwd();
    process.chdir(projectRoot);
    t.after(() => {
        process.chdir(previousCwd);
    });

    const logLines: string[] = [];
    const warnLines: string[] = [];
    const originalLog = console.log;
    const originalWarn = console.warn;
    console.log = (message?: unknown) => {
        logLines.push(String(message));
    };
    console.warn = (message?: unknown) => {
        warnLines.push(String(message));
    };
    t.after(() => {
        console.log = originalLog;
        console.warn = originalWarn;
    });

    const originalSend = (S3Client.prototype as any).send;
    (S3Client.prototype as any).send = async (command: any) => {
        switch (command.constructor.name) {
            case "GetBucketVersioningCommand":
                throw createS3Error("AccessDenied", 403);
            case "ListObjectsV2Command":
                return {
                    Contents: [{ Key: "worlds/Bedrock level.zip" }],
                    IsTruncated: false,
                };
            default:
                throw new Error(
                    `Unexpected command ${command.constructor.name}`,
                );
        }
    };
    t.after(() => {
        (S3Client.prototype as any).send = originalSend;
    });

    await runWorldListCommand({});
    assert.equal(logLines[0], "[world] Remote worlds:");
    assert.match(logLines[1] ?? "", /Bedrock level \(version unavailable\)/);
    assert.match(warnLines[0] ?? "", /s3:GetBucketVersioning/i);
});
