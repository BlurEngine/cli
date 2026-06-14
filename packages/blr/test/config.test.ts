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
        namespace: "test_pack",
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
        namespace: "test_pack",
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

test("loadBlurConfig enables local-server scripting log compaction by default", async (t) => {
    const projectRoot = await createTempDirectory(t, "blr-config-");
    await createMinimalProject(projectRoot, {
        schemaVersion: 1,
        projectVersion: 1,
        namespace: "test_pack",
    });

    const { config } = await loadBlurConfig(projectRoot);
    assert.equal(config.dev.localServer.compactScriptingLogs, true);
});

test("loadBlurConfig respects configured local-server scripting log compaction", async (t) => {
    const projectRoot = await createTempDirectory(t, "blr-config-");
    await createMinimalProject(projectRoot, {
        schemaVersion: 1,
        projectVersion: 1,
        namespace: "test_pack",
        dev: {
            localServer: {
                compactScriptingLogs: false,
            },
        },
    });

    const { config } = await loadBlurConfig(projectRoot);
    assert.equal(config.dev.localServer.compactScriptingLogs, false);
});

test("loadBlurConfig respects environment overrides for local-server scripting log compaction", async (t) => {
    const projectRoot = await createTempDirectory(t, "blr-config-");
    await createMinimalProject(projectRoot, {
        schemaVersion: 1,
        projectVersion: 1,
        namespace: "test_pack",
    });

    const previousCompactScriptingLogs =
        process.env.BLR_DEV_LOCALSERVER_COMPACTSCRIPTINGLOGS;
    process.env.BLR_DEV_LOCALSERVER_COMPACTSCRIPTINGLOGS = "false";
    t.after(() => {
        if (typeof previousCompactScriptingLogs === "undefined") {
            delete process.env.BLR_DEV_LOCALSERVER_COMPACTSCRIPTINGLOGS;
            return;
        }
        process.env.BLR_DEV_LOCALSERVER_COMPACTSCRIPTINGLOGS =
            previousCompactScriptingLogs;
    });

    const { config } = await loadBlurConfig(projectRoot);
    assert.equal(config.dev.localServer.compactScriptingLogs, false);
});

test("loadBlurConfig defaults local-server Link settings", async (t) => {
    const projectRoot = await createTempDirectory(t, "blr-config-");
    await createMinimalProject(projectRoot, {
        schemaVersion: 1,
        projectVersion: 1,
        namespace: "test_pack",
    });

    const { config } = await loadBlurConfig(projectRoot);
    assert.deepEqual(config.dev.localServer.link, {
        enabled: true,
        host: "localhost",
        port: 19144,
        dashboard: {
            enabled: true,
        },
    });
});

test("loadBlurConfig respects configured local-server Link settings", async (t) => {
    const projectRoot = await createTempDirectory(t, "blr-config-");
    await createMinimalProject(projectRoot, {
        schemaVersion: 1,
        projectVersion: 1,
        namespace: "test_pack",
        dev: {
            localServer: {
                link: {
                    enabled: false,
                    host: "0.0.0.0",
                    port: 19999,
                    dashboard: {
                        enabled: false,
                    },
                },
            },
        },
    });

    const { config } = await loadBlurConfig(projectRoot);
    assert.deepEqual(config.dev.localServer.link, {
        enabled: false,
        host: "0.0.0.0",
        port: 19999,
        dashboard: {
            enabled: false,
        },
    });
});

test("loadBlurConfig respects environment overrides for local-server Link settings", async (t) => {
    const projectRoot = await createTempDirectory(t, "blr-config-");
    await createMinimalProject(projectRoot, {
        schemaVersion: 1,
        projectVersion: 1,
        namespace: "test_pack",
    });

    const previousEnabled = process.env.BLR_DEV_LOCALSERVER_LINK_ENABLED;
    const previousHost = process.env.BLR_DEV_LOCALSERVER_LINK_HOST;
    const previousPort = process.env.BLR_DEV_LOCALSERVER_LINK_PORT;
    const previousDashboardEnabled =
        process.env.BLR_DEV_LOCALSERVER_LINK_DASHBOARD_ENABLED;
    process.env.BLR_DEV_LOCALSERVER_LINK_ENABLED = "false";
    process.env.BLR_DEV_LOCALSERVER_LINK_HOST = "0.0.0.0";
    process.env.BLR_DEV_LOCALSERVER_LINK_PORT = "19999";
    process.env.BLR_DEV_LOCALSERVER_LINK_DASHBOARD_ENABLED = "false";
    t.after(() => {
        if (typeof previousEnabled === "undefined") {
            delete process.env.BLR_DEV_LOCALSERVER_LINK_ENABLED;
        } else {
            process.env.BLR_DEV_LOCALSERVER_LINK_ENABLED = previousEnabled;
        }
        if (typeof previousHost === "undefined") {
            delete process.env.BLR_DEV_LOCALSERVER_LINK_HOST;
        } else {
            process.env.BLR_DEV_LOCALSERVER_LINK_HOST = previousHost;
        }
        if (typeof previousPort === "undefined") {
            delete process.env.BLR_DEV_LOCALSERVER_LINK_PORT;
        } else {
            process.env.BLR_DEV_LOCALSERVER_LINK_PORT = previousPort;
        }
        if (typeof previousDashboardEnabled === "undefined") {
            delete process.env.BLR_DEV_LOCALSERVER_LINK_DASHBOARD_ENABLED;
        } else {
            process.env.BLR_DEV_LOCALSERVER_LINK_DASHBOARD_ENABLED =
                previousDashboardEnabled;
        }
    });

    const { config } = await loadBlurConfig(projectRoot);
    assert.deepEqual(config.dev.localServer.link, {
        enabled: false,
        host: "0.0.0.0",
        port: 19999,
        dashboard: {
            enabled: false,
        },
    });
});

test("loadBlurConfig defaults dev.watch.paths to runtime source only", async (t) => {
    const projectRoot = await createTempDirectory(t, "blr-config-");
    await createMinimalProject(projectRoot, {
        schemaVersion: 1,
        projectVersion: 1,
        namespace: "test_pack",
    });

    const { config } = await loadBlurConfig(projectRoot);
    assert.deepEqual(config.dev.watch.paths, ["src/**/*"]);
});

test("loadBlurConfig defaults Bebe missing-reference diagnostics by pipeline", async (t) => {
    const projectRoot = await createTempDirectory(t, "blr-config-");
    await createMinimalProject(projectRoot, {
        schemaVersion: 1,
        projectVersion: 1,
        namespace: "test_pack",
    });

    const { config } = await loadBlurConfig(projectRoot);
    assert.deepEqual(config.bebe.diagnostics.missingReferences, {
        dev: "warn",
        build: "error",
        package: "error",
        check: "error",
    });
    assert.deepEqual(config.bebe.zoneEditor, {
        dev: true,
        package: false,
    });
});

test("loadBlurConfig respects configured Bebe missing-reference diagnostics", async (t) => {
    const projectRoot = await createTempDirectory(t, "blr-config-");
    await createMinimalProject(projectRoot, {
        schemaVersion: 1,
        projectVersion: 1,
        namespace: "test_pack",
        bebe: {
            diagnostics: {
                missingReferences: {
                    dev: "ignore",
                    build: "warn",
                    package: "error",
                    check: "warn",
                },
            },
        },
    });

    const { config } = await loadBlurConfig(projectRoot);
    assert.deepEqual(config.bebe.diagnostics.missingReferences, {
        dev: "ignore",
        build: "warn",
        package: "error",
        check: "warn",
    });
});

test("loadBlurConfig respects configured Bebe zone editor injection policy", async (t) => {
    const projectRoot = await createTempDirectory(t, "blr-config-");
    await createMinimalProject(projectRoot, {
        schemaVersion: 1,
        projectVersion: 1,
        namespace: "test_pack",
        bebe: {
            zoneEditor: {
                dev: false,
                package: true,
            },
        },
    });

    const { config } = await loadBlurConfig(projectRoot);
    assert.deepEqual(config.bebe.zoneEditor, {
        dev: false,
        package: true,
    });
});

test("loadBlurConfig respects environment overrides for Bebe zone editor injection", async (t) => {
    const projectRoot = await createTempDirectory(t, "blr-config-");
    await createMinimalProject(projectRoot, {
        schemaVersion: 1,
        projectVersion: 1,
        namespace: "test_pack",
    });

    const previousDev = process.env.BLR_BEBE_ZONEEDITOR_DEV;
    const previousPackage = process.env.BLR_BEBE_ZONEEDITOR_PACKAGE;
    process.env.BLR_BEBE_ZONEEDITOR_DEV = "false";
    process.env.BLR_BEBE_ZONEEDITOR_PACKAGE = "true";
    t.after(() => {
        if (typeof previousDev === "undefined") {
            delete process.env.BLR_BEBE_ZONEEDITOR_DEV;
        } else {
            process.env.BLR_BEBE_ZONEEDITOR_DEV = previousDev;
        }
        if (typeof previousPackage === "undefined") {
            delete process.env.BLR_BEBE_ZONEEDITOR_PACKAGE;
        } else {
            process.env.BLR_BEBE_ZONEEDITOR_PACKAGE = previousPackage;
        }
    });

    const { config } = await loadBlurConfig(projectRoot);
    assert.deepEqual(config.bebe.zoneEditor, {
        dev: false,
        package: true,
    });
});

test("loadBlurConfig accepts package.defaultTarget package formats", async (t) => {
    for (const target of [
        "mctemplate",
        "mcworld",
        "mcaddon",
        "behavior-pack",
        "resource-pack",
        "world",
        "assets",
    ]) {
        const projectRoot = await createTempDirectory(t, "blr-config-");
        await createMinimalProject(projectRoot, {
            schemaVersion: 1,
            projectVersion: 1,
            namespace: "test_pack",
            package: {
                defaultTarget: target,
            },
        });

        const { config } = await loadBlurConfig(projectRoot);
        assert.equal(config.package.defaultTarget, target);
    }
});

test("loadBlurConfig maps the bds behavior package default target alias to behavior-pack", async (t) => {
    const projectRoot = await createTempDirectory(t, "blr-config-");
    await createMinimalProject(projectRoot, {
        schemaVersion: 1,
        projectVersion: 1,
        namespace: "test_pack",
        package: {
            defaultTarget: "bds-behavior-pack",
        },
    });

    const { config } = await loadBlurConfig(projectRoot);
    assert.equal(config.package.defaultTarget, "behavior-pack");
});

test("loadBlurConfig accepts package.defaultTargets package formats", async (t) => {
    const projectRoot = await createTempDirectory(t, "blr-config-");
    await createMinimalProject(projectRoot, {
        schemaVersion: 1,
        projectVersion: 1,
        namespace: "test_pack",
        package: {
            defaultTargets: ["behavior-pack", "resource-pack"],
        },
    });

    const { config } = await loadBlurConfig(projectRoot);
    assert.deepEqual(config.package.defaultTargets, [
        "behavior-pack",
        "resource-pack",
    ]);
});

test("loadBlurConfig maps bds behavior package default target aliases to behavior-pack", async (t) => {
    const projectRoot = await createTempDirectory(t, "blr-config-");
    await createMinimalProject(projectRoot, {
        schemaVersion: 1,
        projectVersion: 1,
        namespace: "test_pack",
        package: {
            defaultTargets: ["bds-behavior-pack", "resource-pack"],
        },
    });

    const { config } = await loadBlurConfig(projectRoot);
    assert.deepEqual(config.package.defaultTargets, [
        "behavior-pack",
        "resource-pack",
    ]);
});

test("loadBlurConfig accepts package.world.format", async (t) => {
    const projectRoot = await createTempDirectory(t, "blr-config-");
    await createMinimalProject(projectRoot, {
        schemaVersion: 1,
        projectVersion: 1,
        namespace: "test_pack",
        package: {
            world: {
                format: "zip",
            },
        },
    });

    const { config } = await loadBlurConfig(projectRoot);
    assert.equal(config.package.world.format, "zip");
    assert.equal(config.package.world.layout, "bedrock-root");
});

test("loadBlurConfig accepts package.world.layout", async (t) => {
    const projectRoot = await createTempDirectory(t, "blr-config-");
    await createMinimalProject(projectRoot, {
        schemaVersion: 1,
        projectVersion: 1,
        namespace: "test_pack",
        package: {
            world: {
                layout: "com",
            },
        },
    });

    const { config } = await loadBlurConfig(projectRoot);
    assert.equal(config.package.world.layout, "com");
});

test("loadBlurConfig accepts package.assets.worldImage options", async (t) => {
    const projectRoot = await createTempDirectory(t, "blr-config-");
    await createMinimalProject(projectRoot, {
        schemaVersion: 1,
        projectVersion: 1,
        namespace: "test_pack",
        package: {
            assets: {
                worldImage: {
                    enabled: false,
                    dimension: "nether",
                    scale: 3,
                    fileName: "nether-map.png",
                },
            },
        },
    });

    const { config } = await loadBlurConfig(projectRoot);
    assert.deepEqual(config.package.assets.worldImage, {
        enabled: false,
        dimension: "nether",
        scale: 3,
        fileName: "nether-map.png",
    });
});

test("loadBlurConfig respects environment overrides for package world format", async (t) => {
    const projectRoot = await createTempDirectory(t, "blr-config-");
    await createMinimalProject(projectRoot, {
        schemaVersion: 1,
        projectVersion: 1,
        namespace: "test_pack",
        package: {
            world: {
                format: "zip",
            },
        },
    });

    const previousWorldFormat = process.env.BLR_PACKAGE_WORLD_FORMAT;
    process.env.BLR_PACKAGE_WORLD_FORMAT = "mcworld";
    t.after(() => {
        if (typeof previousWorldFormat === "undefined") {
            delete process.env.BLR_PACKAGE_WORLD_FORMAT;
            return;
        }
        process.env.BLR_PACKAGE_WORLD_FORMAT = previousWorldFormat;
    });

    const { config } = await loadBlurConfig(projectRoot);
    assert.equal(config.package.world.format, "mcworld");
});

test("loadBlurConfig respects environment overrides for package world layout", async (t) => {
    const projectRoot = await createTempDirectory(t, "blr-config-");
    await createMinimalProject(projectRoot, {
        schemaVersion: 1,
        projectVersion: 1,
        namespace: "test_pack",
        package: {
            world: {
                layout: "bedrock-root",
            },
        },
    });

    const previousWorldLayout = process.env.BLR_PACKAGE_WORLD_LAYOUT;
    process.env.BLR_PACKAGE_WORLD_LAYOUT = "com";
    t.after(() => {
        if (typeof previousWorldLayout === "undefined") {
            delete process.env.BLR_PACKAGE_WORLD_LAYOUT;
            return;
        }
        process.env.BLR_PACKAGE_WORLD_LAYOUT = previousWorldLayout;
    });

    const { config } = await loadBlurConfig(projectRoot);
    assert.equal(config.package.world.layout, "com");
});

test("loadBlurConfig respects environment overrides for package defaultTargets", async (t) => {
    const projectRoot = await createTempDirectory(t, "blr-config-");
    await createMinimalProject(projectRoot, {
        schemaVersion: 1,
        projectVersion: 1,
        namespace: "test_pack",
    });

    const previousDefaultTargets = process.env.BLR_PACKAGE_DEFAULTTARGETS;
    process.env.BLR_PACKAGE_DEFAULTTARGETS = "behavior-pack,resource-pack";
    t.after(() => {
        if (typeof previousDefaultTargets === "undefined") {
            delete process.env.BLR_PACKAGE_DEFAULTTARGETS;
            return;
        }
        process.env.BLR_PACKAGE_DEFAULTTARGETS = previousDefaultTargets;
    });

    const { config } = await loadBlurConfig(projectRoot);
    assert.deepEqual(config.package.defaultTargets, [
        "behavior-pack",
        "resource-pack",
    ]);
});

test("loadBlurConfig preserves the authored pack minEngineVersion", async (t) => {
    const projectRoot = await createTempDirectory(t, "blr-config-");
    await createMinimalProject(projectRoot, {
        schemaVersion: 1,
        projectVersion: 1,
        namespace: "test_pack",
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
        namespace: "test_pack",
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
        namespace: "test_pack",
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
