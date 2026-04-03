import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { loadBlurConfig } from "../src/config.js";
import {
    listWorldVersionSelectionCandidates,
    runWorldPullCommand,
    resolveWorldVersionsCommandWorldName,
} from "../src/commands/world.js";
import { createTempDirectory, writeJsonFile } from "./helpers.js";

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
    overrides: Record<string, unknown> = {},
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
    await writeJsonFile(path.join(projectRoot, "blr.config.json"), {
        schemaVersion: 1,
        projectVersion: 1,
        namespace: "bc_df",
        dev: {
            localServer: {
                worldName: "Shared World",
            },
        },
        ...overrides,
    });
}

test("listWorldVersionSelectionCandidates merges tracked and local worlds", async (t) => {
    const projectRoot = await createTempDirectory(t, "blr-world-command-");
    await createMinimalProject(projectRoot);
    await mkdir(path.join(projectRoot, "worlds", "Local Only"), {
        recursive: true,
    });
    await mkdir(path.join(projectRoot, "worlds", "Shared World"), {
        recursive: true,
    });
    await writeJsonFile(path.join(projectRoot, "worlds", "worlds.json"), {
        schemaVersion: 1,
        worlds: [
            {
                name: "Shared World",
                remoteFingerprint: "sha256:shared",
                versionId: "ver-shared",
            },
            {
                name: "Tracked Only",
                remoteFingerprint: "sha256:tracked",
                versionId: "ver-tracked",
            },
        ],
    });

    const candidates = await listWorldVersionSelectionCandidates(projectRoot);
    assert.deepEqual(candidates, [
        { name: "Local Only", local: true, tracked: false },
        { name: "Shared World", local: true, tracked: true },
        { name: "Tracked Only", local: false, tracked: true },
    ]);
});

test("resolveWorldVersionsCommandWorldName prompts from tracked and local world candidates when no name is provided", async (t) => {
    const projectRoot = await createTempDirectory(t, "blr-world-command-");
    await createMinimalProject(projectRoot);
    await mkdir(path.join(projectRoot, "worlds", "Local Only"), {
        recursive: true,
    });
    await mkdir(path.join(projectRoot, "worlds", "Shared World"), {
        recursive: true,
    });
    await writeJsonFile(path.join(projectRoot, "worlds", "worlds.json"), {
        schemaVersion: 1,
        worlds: [
            {
                name: "Shared World",
                remoteFingerprint: "sha256:shared",
                versionId: "ver-shared",
            },
            {
                name: "Tracked Only",
                remoteFingerprint: "sha256:tracked",
                versionId: "ver-tracked",
            },
        ],
    });
    const { config } = await loadBlurConfig(projectRoot);

    let promptCalls = 0;
    const selected = await resolveWorldVersionsCommandWorldName({
        projectRoot,
        config,
        canPrompt: () => true,
        prompt: async (question) => {
            promptCalls += 1;
            const promptQuestion = question as unknown as Record<
                string,
                unknown
            >;
            const choices = promptQuestion.choices as Array<
                Record<string, unknown>
            >;
            assert.deepEqual(
                choices.map((choice) => choice.title),
                [
                    "Local Only (local)",
                    "Shared World (local, tracked)",
                    "Tracked Only (tracked)",
                ],
            );
            assert.equal(promptQuestion.initial, 1);
            return { worldName: "Tracked Only" } as any;
        },
    });

    assert.equal(promptCalls, 1);
    assert.equal(selected, "Tracked Only");
});

test("resolveWorldVersionsCommandWorldName stays deterministic for json output", async (t) => {
    const projectRoot = await createTempDirectory(t, "blr-world-command-");
    await createMinimalProject(projectRoot);
    const { config } = await loadBlurConfig(projectRoot);

    const selected = await resolveWorldVersionsCommandWorldName({
        projectRoot,
        config,
        jsonOutput: true,
        canPrompt: () => true,
        prompt: async () => {
            throw new Error("prompt should not be used for json output");
        },
    });

    assert.equal(selected, "Shared World");
});

test("runWorldPullCommand fails while the same world is being watched by an active local-server session", async (t) => {
    const projectRoot = await createTempDirectory(t, "blr-world-command-");
    await createMinimalProject(projectRoot, {
        world: {
            backend: "s3",
            s3: {
                bucket: "mpl-worlds",
                region: "eu-west-2",
                keyPrefix: "worlds",
            },
        },
    });
    await mkdir(path.join(projectRoot, ".blr", "state"), { recursive: true });
    await writeJsonFile(
        path.join(projectRoot, ".blr", "state", "world-state.json"),
        {
            schemaVersion: 1,
            worlds: [],
            localServerSession: {
                processId: process.pid,
                worldName: "Shared World",
                watchWorld: true,
                startedAt: new Date("2026-04-03T10:00:00Z").toISOString(),
            },
        },
    );

    const previousCwd = process.cwd();
    t.after(() => {
        process.chdir(previousCwd);
    });
    process.chdir(projectRoot);

    await assert.rejects(
        () => runWorldPullCommand(undefined, {}),
        /Cannot pull "Shared World" while local-server watch-world is active/i,
    );
});
