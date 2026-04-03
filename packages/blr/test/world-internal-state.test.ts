import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
    clearLocalServerSession,
    clearRuntimeWorldSeedState,
    markProjectWorldMaterializedFromRemote,
    readActiveLocalServerSession,
    readMaterializedProjectWorldRemoteState,
    readRuntimeWorldSeedState,
    writeLocalServerSession,
    writeRuntimeWorldSeedState,
} from "../src/world-internal-state.js";
import { readJsonFile, writeJsonFile, createTempDirectory } from "./helpers.js";

test("world internal state round-trips project and runtime entries in sorted order", async (t) => {
    const projectRoot = await createTempDirectory(t, "blr-world-state-");

    await markProjectWorldMaterializedFromRemote(projectRoot, {
        worldName: "Zulu World",
        remoteFingerprint: "sha256:zulu",
        versionId: "ver-zulu",
        materializedAt: "2026-04-03T10:00:00.000Z",
    });
    await markProjectWorldMaterializedFromRemote(projectRoot, {
        worldName: "Alpha World",
        remoteFingerprint: "sha256:alpha",
        versionId: "ver-alpha",
        materializedAt: "2026-04-03T09:00:00.000Z",
    });
    await writeRuntimeWorldSeedState(projectRoot, {
        worldName: "Alpha World",
        sourceIdentity: "sha256:project-alpha",
        seededAt: "2026-04-03T11:00:00.000Z",
    });

    assert.deepEqual(
        await readMaterializedProjectWorldRemoteState(
            projectRoot,
            "Alpha World",
        ),
        {
            remoteFingerprint: "sha256:alpha",
            versionId: "ver-alpha",
            materializedAt: "2026-04-03T09:00:00.000Z",
        },
    );
    assert.deepEqual(
        await readRuntimeWorldSeedState(projectRoot, "Alpha World"),
        {
            sourceIdentity: "sha256:project-alpha",
            seededAt: "2026-04-03T11:00:00.000Z",
        },
    );

    const state = await readJsonFile<{
        schemaVersion: number;
        worlds: Array<{ name: string }>;
    }>(path.join(projectRoot, ".blr", "state", "world-state.json"));
    assert.equal(state.schemaVersion, 1);
    assert.deepEqual(
        state.worlds.map((entry) => entry.name),
        ["Alpha World", "Zulu World"],
    );
});

test("clearRuntimeWorldSeedState keeps the materialized project world pin intact", async (t) => {
    const projectRoot = await createTempDirectory(t, "blr-world-state-");

    await markProjectWorldMaterializedFromRemote(projectRoot, {
        worldName: "Bedrock level",
        remoteFingerprint: "sha256:remote",
        versionId: "ver-remote",
        materializedAt: "2026-04-03T10:00:00.000Z",
    });
    await writeRuntimeWorldSeedState(projectRoot, {
        worldName: "Bedrock level",
        sourceIdentity: "sha256:project",
        seededAt: "2026-04-03T11:00:00.000Z",
    });

    await clearRuntimeWorldSeedState(projectRoot, "Bedrock level");

    assert.deepEqual(
        await readMaterializedProjectWorldRemoteState(
            projectRoot,
            "Bedrock level",
        ),
        {
            remoteFingerprint: "sha256:remote",
            versionId: "ver-remote",
            materializedAt: "2026-04-03T10:00:00.000Z",
        },
    );
    assert.equal(
        await readRuntimeWorldSeedState(projectRoot, "Bedrock level"),
        undefined,
    );
});

test("local-server session state round-trips and clears cleanly", async (t) => {
    const projectRoot = await createTempDirectory(t, "blr-world-state-");

    await writeLocalServerSession(projectRoot, {
        processId: process.pid,
        worldName: "Bedrock level",
        watchWorld: true,
        startedAt: "2026-04-03T12:00:00.000Z",
    });

    assert.deepEqual(await readActiveLocalServerSession(projectRoot), {
        processId: process.pid,
        worldName: "Bedrock level",
        watchWorld: true,
        startedAt: "2026-04-03T12:00:00.000Z",
    });

    await clearLocalServerSession(projectRoot);

    const state = await readJsonFile<{
        schemaVersion: number;
        worlds: Array<unknown>;
        localServerSession?: unknown;
    }>(path.join(projectRoot, ".blr", "state", "world-state.json"));
    assert.equal(state.schemaVersion, 1);
    assert.deepEqual(state.worlds, []);
    assert.equal(state.localServerSession, undefined);
});

test("malformed world internal state falls back to empty state instead of throwing", async (t) => {
    const projectRoot = await createTempDirectory(t, "blr-world-state-");
    await mkdir(path.join(projectRoot, ".blr", "state"), { recursive: true });
    await writeJsonFile(
        path.join(projectRoot, ".blr", "state", "world-state.json"),
        {
            schemaVersion: 1,
            worlds: [
                {
                    name: "",
                    materializedRemote: {
                        remoteFingerprint: "sha256:bad",
                        versionId: "ver-bad",
                        materializedAt: "2026-04-03T10:00:00.000Z",
                    },
                },
            ],
            localServerSession: {
                processId: 0,
                worldName: "Bedrock level",
                watchWorld: true,
                startedAt: "2026-04-03T12:00:00.000Z",
            },
        },
    );

    assert.equal(
        await readMaterializedProjectWorldRemoteState(
            projectRoot,
            "Bedrock level",
        ),
        undefined,
    );
    assert.equal(await readActiveLocalServerSession(projectRoot), undefined);
});
