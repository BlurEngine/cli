import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { loadBlurConfig } from "../src/config.js";
import { readConfiguredMinecraftTargetVersion } from "../src/minecraft-config.js";
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

test("loadBlurConfig defaults dev.watch.paths to runtime and pack sources only", async (t) => {
    const projectRoot = await createTempDirectory(t, "blr-config-");
    await createMinimalProject(projectRoot, {
        schemaVersion: 1,
        projectVersion: 1,
        namespace: "bc_df",
    });

    const { config } = await loadBlurConfig(projectRoot);
    assert.deepEqual(config.dev.watch.paths, [
        "src/**/*",
        "behavior_packs/**/*",
        "resource_packs/**/*",
    ]);
});

test("loadBlurConfig accepts package.defaultTarget package formats", async (t) => {
    for (const target of ["mctemplate", "mcworld", "mcaddon"]) {
        const projectRoot = await createTempDirectory(t, "blr-config-");
        await createMinimalProject(projectRoot, {
            schemaVersion: 1,
            projectVersion: 1,
            namespace: "bc_df",
            package: {
                defaultTarget: target,
            },
        });

        const { config } = await loadBlurConfig(projectRoot);
        assert.equal(config.package.defaultTarget, target);
    }
});

test("loadBlurConfig preserves the authored pack minEngineVersion", async (t) => {
    const projectRoot = await createTempDirectory(t, "blr-config-");
    await createMinimalProject(projectRoot, {
        schemaVersion: 1,
        projectVersion: 1,
        namespace: "bc_df",
        minecraft: {
            targetVersion: "1.26.11.1",
        },
    });

    const { config } = await loadBlurConfig(projectRoot);
    assert.deepEqual(config.minecraft.minEngineVersion, [1, 26, 11]);
    assert.deepEqual(config.packs.behavior?.minEngineVersion, [1, 26, 0]);
});

test("readConfiguredMinecraftTargetVersion respects environment overrides", async (t) => {
    const projectRoot = await createTempDirectory(t, "blr-config-");
    await createMinimalProject(projectRoot, {
        schemaVersion: 1,
        projectVersion: 1,
        namespace: "bc_df",
        minecraft: {
            targetVersion: "1.26.0.2",
        },
    });

    const previousTargetVersion = process.env.BLR_MINECRAFT_TARGETVERSION;
    process.env.BLR_MINECRAFT_TARGETVERSION = "1.26.11.1";
    t.after(() => {
        if (typeof previousTargetVersion === "undefined") {
            delete process.env.BLR_MINECRAFT_TARGETVERSION;
            return;
        }
        process.env.BLR_MINECRAFT_TARGETVERSION = previousTargetVersion;
    });

    assert.equal(
        await readConfiguredMinecraftTargetVersion(
            path.join(projectRoot, "blr.config.json"),
            "1.26.0.2",
        ),
        "1.26.11.1",
    );

    const { config } = await loadBlurConfig(projectRoot);
    assert.equal(config.minecraft.targetVersion, "1.26.11.1");
});

test("loadBlurConfig respects environment overrides for local-server worldSync modes", async (t) => {
    const projectRoot = await createTempDirectory(t, "blr-config-");
    await createMinimalProject(projectRoot, {
        schemaVersion: 1,
        projectVersion: 1,
        namespace: "bc_df",
        dev: {
            localServer: {
                worldSync: {
                    projectWorldMode: "prompt",
                    runtimeWorldMode: "prompt",
                },
            },
        },
    });

    const previousProjectMode =
        process.env.BLR_DEV_LOCALSERVER_WORLDSYNC_PROJECTWORLDMODE;
    const previousRuntimeMode =
        process.env.BLR_DEV_LOCALSERVER_WORLDSYNC_RUNTIMEWORLDMODE;
    process.env.BLR_DEV_LOCALSERVER_WORLDSYNC_PROJECTWORLDMODE = "auto";
    process.env.BLR_DEV_LOCALSERVER_WORLDSYNC_RUNTIMEWORLDMODE = "backup";
    t.after(() => {
        if (typeof previousProjectMode === "undefined") {
            delete process.env.BLR_DEV_LOCALSERVER_WORLDSYNC_PROJECTWORLDMODE;
        } else {
            process.env.BLR_DEV_LOCALSERVER_WORLDSYNC_PROJECTWORLDMODE =
                previousProjectMode;
        }

        if (typeof previousRuntimeMode === "undefined") {
            delete process.env.BLR_DEV_LOCALSERVER_WORLDSYNC_RUNTIMEWORLDMODE;
        } else {
            process.env.BLR_DEV_LOCALSERVER_WORLDSYNC_RUNTIMEWORLDMODE =
                previousRuntimeMode;
        }
    });

    const { config } = await loadBlurConfig(projectRoot);
    assert.equal(config.dev.localServer.worldSync.projectWorldMode, "auto");
    assert.equal(config.dev.localServer.worldSync.runtimeWorldMode, "backup");
});
