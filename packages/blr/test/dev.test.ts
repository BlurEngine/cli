import assert from "node:assert/strict";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { BLR_ENV_BDS_VERSION } from "../src/constants.js";
import {
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
