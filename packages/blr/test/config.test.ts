import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { loadBlurConfig } from "../src/config.js";
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

test("loadBlurConfig rejects runtime.entry paths that escape the project root", async (t) => {
    const projectRoot = await createTempDirectory(t, "blr-config-");
    await createMinimalProject(projectRoot, {
        schemaVersion: 1,
        projectVersion: 1,
        namespace: "bc_df",
        runtime: {
            entry: "../escape.ts",
        },
    });

    await assert.rejects(
        () => loadBlurConfig(projectRoot),
        /runtime.entry must stay within the project and cannot traverse parent directories\./,
    );
});

test("loadBlurConfig derives the default worldSourcePath from dev.localServer.worldName", async (t) => {
    const projectRoot = await createTempDirectory(t, "blr-config-");
    await createMinimalProject(projectRoot, {
        schemaVersion: 1,
        projectVersion: 1,
        namespace: "bc_df",
        dev: {
            localServer: {
                worldName: "Creative Sandbox",
            },
        },
    });

    const { config } = await loadBlurConfig(projectRoot);
    assert.equal(config.dev.localServer.worldName, "Creative Sandbox");
    assert.equal(
        config.dev.localServer.worldSourcePath,
        "worlds/Creative Sandbox",
    );
    assert.equal(config.features.behaviorPack, true);
    assert.equal(config.features.resourcePack, false);
});
