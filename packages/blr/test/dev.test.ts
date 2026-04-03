import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { loadBlurConfig } from "../src/config.js";
import { BLR_ENV_BDS_VERSION } from "../src/constants.js";
import {
    buildRemoteWorldSyncFailureMessage,
    resolveDevLocalServerVersionSource,
    shouldUseInteractiveDevConfiguration,
} from "../src/commands/dev.js";
import { createTempDirectory, writeJsonFile } from "./helpers.js";

async function writeConfigFile(
    projectRoot: string,
    config: Record<string, unknown>,
): Promise<string> {
    const configPath = path.join(projectRoot, "blr.config.json");
    await writeJsonFile(configPath, config);
    return configPath;
}

function preserveEnv(t: TestContext, name: string): void {
    const previousValue = process.env[name];
    t.after(() => {
        if (typeof previousValue === "undefined") {
            delete process.env[name];
            return;
        }
        process.env[name] = previousValue;
    });
}

async function createConfigLoadProject(
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
        {
            format_version: 2,
            header: {
                name: "Example",
                description: "Example behavior pack",
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
        },
    );
    await writeJsonFile(path.join(projectRoot, "blr.config.json"), config);
}

test("shouldUseInteractiveDevConfiguration is disabled by default", () => {
    assert.equal(shouldUseInteractiveDevConfiguration({}), false);
});

test("shouldUseInteractiveDevConfiguration respects explicit interactive overrides", () => {
    assert.equal(
        shouldUseInteractiveDevConfiguration({ interactive: true }),
        true,
    );
    assert.equal(
        shouldUseInteractiveDevConfiguration({ interactive: false }),
        false,
    );
});

test("resolveDevLocalServerVersionSource reports config-file targetVersion when no overrides are active", async (t) => {
    const projectRoot = await createTempDirectory(t, "blr-dev-source-");
    const configPath = await writeConfigFile(projectRoot, {
        schemaVersion: 1,
        projectVersion: 1,
        namespace: "bc_df",
        minecraft: {
            targetVersion: "1.26.0.2",
        },
    });

    preserveEnv(t, BLR_ENV_BDS_VERSION);
    preserveEnv(t, "BLR_MINECRAFT_TARGETVERSION");
    delete process.env[BLR_ENV_BDS_VERSION];
    delete process.env.BLR_MINECRAFT_TARGETVERSION;

    assert.equal(
        await resolveDevLocalServerVersionSource(configPath, {}),
        "config-file-target-version",
    );
});

test("resolveDevLocalServerVersionSource reports config-env targetVersion when BLR_MINECRAFT_TARGETVERSION is set", async (t) => {
    const projectRoot = await createTempDirectory(t, "blr-dev-source-");
    const configPath = await writeConfigFile(projectRoot, {
        schemaVersion: 1,
        projectVersion: 1,
        namespace: "bc_df",
        minecraft: {
            targetVersion: "1.26.0.2",
        },
    });

    preserveEnv(t, BLR_ENV_BDS_VERSION);
    preserveEnv(t, "BLR_MINECRAFT_TARGETVERSION");
    delete process.env[BLR_ENV_BDS_VERSION];
    process.env.BLR_MINECRAFT_TARGETVERSION = "1.26.11.1";

    assert.equal(
        await resolveDevLocalServerVersionSource(configPath, {}),
        "config-env-target-version",
    );
});

test("resolveDevLocalServerVersionSource reports machine-env bdsVersion when BLR_MACHINE_LOCALSERVER_BDSVERSION is set", async (t) => {
    const projectRoot = await createTempDirectory(t, "blr-dev-source-");
    const configPath = await writeConfigFile(projectRoot, {
        schemaVersion: 1,
        projectVersion: 1,
        namespace: "bc_df",
        minecraft: {
            targetVersion: "1.26.0.2",
        },
    });

    preserveEnv(t, BLR_ENV_BDS_VERSION);
    preserveEnv(t, "BLR_MINECRAFT_TARGETVERSION");
    process.env[BLR_ENV_BDS_VERSION] = "1.26.12.1";
    process.env.BLR_MINECRAFT_TARGETVERSION = "1.26.11.1";

    assert.equal(
        await resolveDevLocalServerVersionSource(configPath, {}),
        "machine-env-bds-version",
    );
});

test("resolveDevLocalServerVersionSource reports cli bdsVersion when --bds-version is passed", async (t) => {
    const projectRoot = await createTempDirectory(t, "blr-dev-source-");
    const configPath = await writeConfigFile(projectRoot, {
        schemaVersion: 1,
        projectVersion: 1,
        namespace: "bc_df",
    });

    preserveEnv(t, BLR_ENV_BDS_VERSION);
    preserveEnv(t, "BLR_MINECRAFT_TARGETVERSION");
    process.env[BLR_ENV_BDS_VERSION] = "1.26.12.1";
    process.env.BLR_MINECRAFT_TARGETVERSION = "1.26.11.1";

    assert.equal(
        await resolveDevLocalServerVersionSource(configPath, {
            bdsVersion: "1.26.13.1",
        }),
        "cli-bds-version",
    );
});

test("loadBlurConfig defaults local-server worldSync modes to prompt", async (t) => {
    const projectRoot = await createTempDirectory(t, "blr-dev-world-sync-");
    await createConfigLoadProject(projectRoot, {
        schemaVersion: 1,
        projectVersion: 1,
        namespace: "bc_df",
    });

    const { config } = await loadBlurConfig(projectRoot);
    assert.equal(config.dev.localServer.worldSync.projectWorldMode, "prompt");
    assert.equal(config.dev.localServer.worldSync.runtimeWorldMode, "prompt");
});

test("loadBlurConfig respects configured local-server worldSync modes", async (t) => {
    const projectRoot = await createTempDirectory(
        t,
        "blr-dev-world-sync-configured-",
    );
    await createConfigLoadProject(projectRoot, {
        schemaVersion: 1,
        projectVersion: 1,
        namespace: "bc_df",
        dev: {
            localServer: {
                worldSync: {
                    projectWorldMode: "auto",
                    runtimeWorldMode: "backup",
                },
            },
        },
    });

    const { config } = await loadBlurConfig(projectRoot);
    assert.equal(config.dev.localServer.worldSync.projectWorldMode, "auto");
    assert.equal(config.dev.localServer.worldSync.runtimeWorldMode, "backup");
});

test("buildRemoteWorldSyncFailureMessage replaces raw unknown backend errors with a helpful dev warning", () => {
    assert.match(
        buildRemoteWorldSyncFailureMessage({
            worldName: "Bedrock level",
            error: new Error("UnknownError"),
        }),
        /could not synchronize remote world "Bedrock level" because the S3 backend returned an unknown error/i,
    );
    assert.match(
        buildRemoteWorldSyncFailureMessage({
            worldName: "Bedrock level",
            error: new Error(
                "blr could not inspect remote world object s3://mpl-worlds/worlds/Bedrock level.zip because the S3 backend returned an unknown error. This backend may not fully support this request, or the active credentials may not allow it.",
            ),
        }),
        /Continuing without remote world sync\./,
    );
});
