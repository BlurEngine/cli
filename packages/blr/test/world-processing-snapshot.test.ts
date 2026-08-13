import assert from "node:assert/strict";
import {
    mkdir,
    readFile,
    readdir,
    symlink,
    unlink,
    utimes,
    writeFile,
} from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { withVerifiedWorldSnapshot } from "../src/world-processing/world-snapshot.js";
import { createTempDirectory } from "./helpers.js";

test("withVerifiedWorldSnapshot copies and verifies an immutable source without exposing it as the DB input", async (t) => {
    const root = await createTempDirectory(t, "blr-world-snapshot-");
    const source = await createWorldSource(root);
    const tempRoot = path.join(root, "snapshots");
    const before = await readFile(path.join(source, "db", "000001.ldb"));

    const identity = await withVerifiedWorldSnapshot(
        {
            worldName: "Bedrock level",
            sourceWorldDirectory: source,
            tempRoot,
            sourceRevision: "sha256:tracked",
            sourceVersion: "version-1",
        },
        async (snapshot) => {
            assert.notEqual(snapshot.worldDirectory, source);
            assert.ok(snapshot.worldDirectory.startsWith(tempRoot));
            assert.equal(
                await readFile(
                    path.join(snapshot.dbPath, "000001.ldb"),
                    "utf8",
                ),
                "database bytes",
            );
            assert.equal(snapshot.sourceIdentity.worldName, "Bedrock level");
            assert.match(snapshot.sourceIdentity.contentHash, /^[a-f0-9]{64}$/);
            assert.equal(
                snapshot.sourceIdentity.sourceRevision,
                "sha256:tracked",
            );
            assert.equal(snapshot.sourceIdentity.sourceVersion, "version-1");
            return snapshot.sourceIdentity;
        },
    );

    assert.equal(identity.worldName, "Bedrock level");
    assert.deepEqual(
        await readFile(path.join(source, "db", "000001.ldb")),
        before,
    );
    assert.deepEqual(await readdir(tempRoot), []);
});

test("withVerifiedWorldSnapshot detects same-byte source rewrites through mtime quiescence and cleans up", async (t) => {
    const root = await createTempDirectory(t, "blr-world-snapshot-race-");
    const source = await createWorldSource(root);
    const tempRoot = path.join(root, "snapshots");
    const sourceFile = path.join(source, "levelname.txt");

    await assert.rejects(
        () =>
            withVerifiedWorldSnapshot(
                {
                    worldName: "Bedrock level",
                    sourceWorldDirectory: source,
                    tempRoot,
                    hooks: {
                        afterCopy: async () => {
                            const data = await readFile(sourceFile);
                            await writeFile(sourceFile, data);
                            const later = new Date(Date.now() + 5_000);
                            await utimes(sourceFile, later, later);
                        },
                    },
                },
                async () => undefined,
            ),
        /changed while the verified snapshot was being created/i,
    );
    assert.deepEqual(await readdir(tempRoot), []);
});

test("withVerifiedWorldSnapshot rejects symlinks and cleans up after operation failures or cancellation", async (t) => {
    const root = await createTempDirectory(t, "blr-world-snapshot-errors-");
    const source = await createWorldSource(root);
    const tempRoot = path.join(root, "snapshots");
    const external = path.join(root, "external.txt");
    await writeFile(external, "outside");
    try {
        await symlink(external, path.join(source, "linked.txt"), "file");
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EPERM") {
            t.skip("This Windows environment cannot create test symlinks.");
            return;
        }
        throw error;
    }
    await assert.rejects(
        () =>
            withVerifiedWorldSnapshot(
                {
                    worldName: "Bedrock level",
                    sourceWorldDirectory: source,
                    tempRoot,
                },
                async () => undefined,
            ),
        /symbolic link/i,
    );
    assert.deepEqual(await readdir(tempRoot), []);

    await unlink(path.join(source, "linked.txt"));
    await writeFile(path.join(source, "linked.txt"), "regular");
    await assert.rejects(
        () =>
            withVerifiedWorldSnapshot(
                {
                    worldName: "Bedrock level",
                    sourceWorldDirectory: source,
                    tempRoot,
                },
                async () => {
                    throw new Error("operation failed");
                },
            ),
        /operation failed/i,
    );
    assert.deepEqual(await readdir(tempRoot), []);

    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
        () =>
            withVerifiedWorldSnapshot(
                {
                    worldName: "Bedrock level",
                    sourceWorldDirectory: source,
                    tempRoot,
                    signal: controller.signal,
                },
                async () => undefined,
            ),
        /aborted/i,
    );
    assert.deepEqual(await readdir(tempRoot), []);
});

async function createWorldSource(root: string): Promise<string> {
    const source = path.join(root, "worlds", "Bedrock level");
    await mkdir(path.join(source, "db"), { recursive: true });
    await writeFile(path.join(source, "db", "CURRENT"), "MANIFEST-000001\n");
    await writeFile(path.join(source, "db", "000001.ldb"), "database bytes");
    await writeFile(path.join(source, "levelname.txt"), "Bedrock level\n");
    return source;
}
