import assert from "node:assert/strict";
import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { loadBlurConfig } from "../src/config.js";
import { BLR_ENV_BDS_VERSION } from "../src/constants.js";
import {
    assertDevWorldProcessingCompatibility,
    buildRemoteWorldSyncFailureMessage,
    createWorldProcessorWatchPlan,
    mergePipelineModes,
    resolveRuntimeWorldDecision,
    resolveProjectWatchChangeAction,
    resolveLocalServerLinkOptions,
    runDevCommand,
    resolveDevLocalServerVersionSource,
    shouldUseInteractiveDevConfiguration,
} from "../src/commands/dev.js";
import { writeRuntimeWorldSeedState } from "../src/world-internal-state.js";
import { computeProjectWorldSourceIdentity } from "../src/world-source-identity.js";
import {
    createJsonResponse,
    createTempDirectory,
    writeJsonFile,
} from "./helpers.js";

type BebeAssetWatchConfig = {
    readonly sourcePaths: readonly string[];
    readonly watchPatterns: readonly string[];
};

type WatchPlan = {
    readonly patterns: readonly string[];
    readonly roots: readonly string[];
    matches(targetPath: string): boolean;
};

type BebeToolingTestModule = typeof import("../src/bebe-tooling.js") & {
    resolveBebeAssetWatchConfig?: (
        projectRoot: string,
    ) => Promise<BebeAssetWatchConfig>;
};

type DevWatchTestModule = typeof import("../src/commands/dev.js") & {
    createWatchPlan?: (patterns: readonly string[]) => WatchPlan;
};

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

async function createBebeAssetWatchProject(projectRoot: string): Promise<void> {
    const packageRoot = path.join(
        projectRoot,
        "node_modules",
        "@blurengine",
        "bebe",
    );
    await mkdir(path.join(packageRoot, "tooling"), { recursive: true });
    await writeJsonFile(path.join(projectRoot, "package.json"), {
        name: "watch-project",
        private: true,
        type: "module",
        dependencies: {
            "@blurengine/bebe": "0.0.0",
        },
    });
    await writeJsonFile(path.join(packageRoot, "package.json"), {
        name: "@blurengine/bebe",
        version: "0.0.0",
        type: "module",
        exports: {
            "./tooling/node": "./tooling/node.js",
        },
    });
    await writeFile(
        path.join(packageRoot, "tooling", "node.js"),
        [
            "export function createBebeTooling() {",
            "  return {",
            "    assetCompilers: [",
            "      {",
            "        id: 'bebe:zones',",
            "        sourcePaths: ['zones.json'],",
            "        outputPath: 'generated/bebe/zones.json',",
            "        compile() { return { output: {} }; },",
            "      },",
            "      {",
            "        id: 'bebe:audio',",
            "        sourcePaths: ['audio'],",
            "        sourceKind: 'text',",
            "        sourceMode: 'collection',",
            "        sourceFileExtensions: ['.baud'],",
            "        outputPath: 'generated/bebe/audio.json',",
            "        compile() { return { output: {} }; },",
            "      },",
            "    ],",
            "  };",
            "}",
            "",
        ].join("\n"),
        "utf8",
    );
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
        namespace: "test_pack",
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
        namespace: "test_pack",
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
        namespace: "test_pack",
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
        namespace: "test_pack",
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

test("resolveLocalServerLinkOptions follows local-server selection and config", async (t) => {
    const projectRoot = await createTempDirectory(t, "blr-dev-link-");
    await createConfigLoadProject(projectRoot, {
        schemaVersion: 1,
        projectVersion: 1,
        namespace: "test_pack",
        dev: {
            localServer: {
                link: {
                    enabled: true,
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
    assert.deepEqual(resolveLocalServerLinkOptions(config, true), {
        host: "0.0.0.0",
        port: 19999,
        dashboardEnabled: false,
    });
    assert.equal(resolveLocalServerLinkOptions(config, false), undefined);

    config.dev.localServer.link.enabled = false;
    assert.equal(resolveLocalServerLinkOptions(config, true), undefined);
});

test("loadBlurConfig defaults local-server worldSync modes to prompt", async (t) => {
    const projectRoot = await createTempDirectory(t, "blr-dev-world-sync-");
    await createConfigLoadProject(projectRoot, {
        schemaVersion: 1,
        projectVersion: 1,
        namespace: "test_pack",
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
        namespace: "test_pack",
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

test("resolveRuntimeWorldDecision labels stale runtime worlds when preserve mode keeps them", async (t) => {
    const worldName = "Bedrock level";
    const projectRoot = await createTempDirectory(t, "blr-dev-runtime-stale-");
    await createConfigLoadProject(projectRoot, {
        schemaVersion: 1,
        projectVersion: 1,
        namespace: "test_pack",
        dev: {
            localServer: {
                worldName,
                worldSync: {
                    runtimeWorldMode: "preserve",
                },
            },
        },
    });

    const worldSourceDirectory = path.join(projectRoot, "worlds", worldName);
    const runtimeWorldDirectory = path.join(
        projectRoot,
        ".blr",
        "bds",
        "server",
        "worlds",
        worldName,
    );
    await mkdir(path.join(worldSourceDirectory, "db"), { recursive: true });
    await mkdir(runtimeWorldDirectory, { recursive: true });
    await writeFile(path.join(worldSourceDirectory, "db", "CURRENT"), "new");
    await writeRuntimeWorldSeedState(projectRoot, {
        worldName,
        sourceIdentity: "sha256:previous-project-world",
    });

    const { config } = await loadBlurConfig(projectRoot);
    const decision = await resolveRuntimeWorldDecision({
        projectRoot,
        config,
        runtimeState: {
            channel: "stable",
            version: "1.26.0.2",
            platform: "linux",
            cacheDirectory: path.join(projectRoot, ".blr", "bds", "cache"),
            serverDirectory: path.join(projectRoot, ".blr", "bds", "server"),
            worldName,
            worldSourcePath: `worlds/${worldName}`,
            worldDirectory: runtimeWorldDirectory,
            worldSourceDirectory,
            executablePath: path.join(
                projectRoot,
                ".blr",
                "bds",
                "server",
                "bedrock_server",
            ),
            zipPath: path.join(projectRoot, ".blr", "bds", "cache", "bds.zip"),
            customExecutableInjected: false,
        },
    });

    assert.equal(decision.action, "preserve");
    assert.match(
        decision.note ?? "",
        /Project world source is newer or different than the local-server world last seeded for "Bedrock level"/,
    );
    assert.match(
        decision.note ?? "",
        /dev\.localServer\.worldSync\.runtimeWorldMode=preserve/,
    );
});

test("resolveRuntimeWorldDecision refreshes runtime worlds in replace mode even when the last seed matches", async (t) => {
    const worldName = "Bedrock level";
    const projectRoot = await createTempDirectory(t, "blr-dev-runtime-force-");
    await createConfigLoadProject(projectRoot, {
        schemaVersion: 1,
        projectVersion: 1,
        namespace: "test_pack",
        dev: {
            localServer: {
                worldName,
                worldSync: {
                    runtimeWorldMode: "replace",
                },
            },
        },
    });

    const worldSourceDirectory = path.join(projectRoot, "worlds", worldName);
    const runtimeWorldDirectory = path.join(
        projectRoot,
        ".blr",
        "bds",
        "server",
        "worlds",
        worldName,
    );
    await mkdir(path.join(worldSourceDirectory, "db"), { recursive: true });
    await mkdir(path.join(runtimeWorldDirectory, "db"), { recursive: true });
    await writeFile(path.join(worldSourceDirectory, "db", "CURRENT"), "new");
    await writeFile(path.join(runtimeWorldDirectory, "db", "CURRENT"), "old");
    const sourceIdentity =
        await computeProjectWorldSourceIdentity(worldSourceDirectory);
    assert.ok(sourceIdentity);
    await writeRuntimeWorldSeedState(projectRoot, {
        worldName,
        sourceIdentity,
    });

    const { config } = await loadBlurConfig(projectRoot);
    const decision = await resolveRuntimeWorldDecision({
        projectRoot,
        config,
        runtimeState: {
            channel: "stable",
            version: "1.26.0.2",
            platform: "linux",
            cacheDirectory: path.join(projectRoot, ".blr", "bds", "cache"),
            serverDirectory: path.join(projectRoot, ".blr", "bds", "server"),
            worldName,
            worldSourcePath: `worlds/${worldName}`,
            worldDirectory: runtimeWorldDirectory,
            worldSourceDirectory,
            executablePath: path.join(
                projectRoot,
                ".blr",
                "bds",
                "server",
                "bedrock_server",
            ),
            zipPath: path.join(projectRoot, ".blr", "bds", "cache", "bds.zip"),
            customExecutableInjected: false,
        },
    });

    assert.equal(decision.action, "replace");
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
                "blr could not inspect remote world object s3://example-worlds/worlds/Bedrock level.zip because the S3 backend returned an unknown error. This backend may not fully support this request, or the active credentials may not allow it.",
            ),
        }),
        /Continuing without remote world sync\./,
    );
});

test("resolveProjectWatchChangeAction reloads source changes, syncs pack changes, and ignores non-runtime changes", () => {
    assert.deepEqual(resolveProjectWatchChangeAction("src/main.ts"), {
        kind: "reload",
        pipelineMode: "reload",
    });
    assert.deepEqual(resolveProjectWatchChangeAction("src/main.js"), {
        kind: "reload",
        pipelineMode: "reload",
    });
    assert.deepEqual(resolveProjectWatchChangeAction("src/main.mjs"), {
        kind: "reload",
        pipelineMode: "reload",
    });
    assert.deepEqual(resolveProjectWatchChangeAction("src/main.test.ts"), {
        kind: "ignore",
        message:
            "[dev] change ignored: src/main.test.ts. Test files do not trigger dev reloads.",
    });
    assert.deepEqual(resolveProjectWatchChangeAction("src/main.test.js"), {
        kind: "ignore",
        message:
            "[dev] change ignored: src/main.test.js. Test files do not trigger dev reloads.",
    });
    assert.deepEqual(resolveProjectWatchChangeAction("src/main.test.mjs"), {
        kind: "ignore",
        message:
            "[dev] change ignored: src/main.test.mjs. Test files do not trigger dev reloads.",
    });
    assert.deepEqual(
        resolveProjectWatchChangeAction(
            "behavior_packs/example-pack/entities/example_entity.json",
        ),
        {
            kind: "sync",
            pipelineMode: "start",
        },
    );
    assert.deepEqual(
        resolveProjectWatchChangeAction(
            "resource_packs/example-pack/textures/entity/example_entity.png",
        ),
        {
            kind: "sync",
            pipelineMode: "start",
        },
    );
    assert.deepEqual(resolveProjectWatchChangeAction("blr.config.json"), {
        kind: "ignore",
        message:
            "[dev] change ignored: blr.config.json. Restart dev to apply it.",
    });
    assert.deepEqual(resolveProjectWatchChangeAction("package.json"), {
        kind: "ignore",
        message: "[dev] change ignored: package.json. Restart dev to apply it.",
    });
    assert.deepEqual(
        resolveProjectWatchChangeAction("zones.json", {
            assetSourcePaths: ["zones.json"],
        }),
        {
            kind: "reload",
            pipelineMode: "reload",
        },
    );
    assert.deepEqual(
        resolveProjectWatchChangeAction("render-anchors.json", {
            assetSourcePaths: ["zones.json", "render-anchors.json"],
        }),
        {
            kind: "reload",
            pipelineMode: "reload",
        },
    );
    assert.deepEqual(
        resolveProjectWatchChangeAction("audio/events/reward.baud", {
            assetSourcePaths: ["audio"],
        }),
        {
            kind: "reload",
            pipelineMode: "reload",
        },
    );
    assert.deepEqual(
        resolveProjectWatchChangeAction("zones.json.bak", {
            assetSourcePaths: ["zones.json"],
        }),
        {
            kind: "ignore",
            message:
                "[dev] change ignored: zones.json.bak. Only files under src/ trigger dev reloads.",
        },
    );
    assert.deepEqual(resolveProjectWatchChangeAction("scripts/shared.ts"), {
        kind: "ignore",
        message:
            "[dev] change ignored: scripts/shared.ts. Only files under src/ trigger dev reloads.",
    });
});

test("processed dev worlds reject runtime-to-source capture", () => {
    assert.throws(
        () =>
            assertDevWorldProcessingCompatibility({
                watchWorld: true,
                worldName: "Bedrock level",
                worldProcessors: [
                    {
                        id: "locations",
                        sourceWorld: "Bedrock level",
                        capabilities: ["artifact", "transform"],
                        applyOn: { dev: true },
                    },
                ],
            }),
        /processed play mode.*watch-world.*authored world/i,
    );

    assert.doesNotThrow(() =>
        assertDevWorldProcessingCompatibility({
            watchWorld: true,
            worldName: "Bedrock level",
            worldProcessors: [
                {
                    id: "locations",
                    sourceWorld: "Bedrock level",
                    capabilities: ["artifact"],
                    applyOn: { dev: true },
                },
            ],
        }),
    );
});

test("world processor watch plans cover config, provider, declared inputs, and authored world changes", () => {
    const plan = createWorldProcessorWatchPlan({
        worldSourcePath: "worlds/Bedrock level",
        processors: [
            {
                module: "./tooling/locations/processor.ts",
                inputPaths: ["tooling/locations/catalogue.json"],
            },
        ],
    });

    assert.equal(plan.matches("blr.config.json"), true);
    assert.equal(plan.matches("worlds/worlds.json"), true);
    assert.equal(plan.matches("tooling/locations/processor.ts"), true);
    assert.equal(plan.matches("tooling/locations/parser.ts"), true);
    assert.equal(plan.matches("tooling/locations/catalogue.json"), true);
    assert.equal(plan.matches("worlds/Bedrock level/db/000001.ldb"), true);
    assert.equal(plan.matches("src/main.ts"), false);
});

test("world processor watch changes request a safe restart and config refresh", () => {
    assert.deepEqual(
        resolveProjectWatchChangeAction("tooling/locations/processor.ts", {
            worldProcessorPaths: ["tooling/locations/**/*"],
        }),
        { kind: "restart", pipelineMode: "restart", reloadConfig: false },
    );
    assert.deepEqual(
        resolveProjectWatchChangeAction("blr.config.json", {
            worldProcessorPaths: ["tooling/locations/**/*"],
        }),
        { kind: "restart", pipelineMode: "restart", reloadConfig: true },
    );
});

test("Bebe collection asset sources expand dev watch coverage for nested files", async (t) => {
    const projectRoot = await createTempDirectory(t, "blr-dev-bebe-watch-");
    await createBebeAssetWatchProject(projectRoot);

    const bebeModule =
        (await import("../src/bebe-tooling.js")) as BebeToolingTestModule;
    const resolveBebeAssetWatchConfig = bebeModule.resolveBebeAssetWatchConfig;
    assert.equal(typeof resolveBebeAssetWatchConfig, "function");
    const watchConfig = await resolveBebeAssetWatchConfig(projectRoot);
    assert.deepEqual(watchConfig, {
        sourcePaths: ["zones.json", "audio"],
        watchPatterns: ["zones.json", "audio", "audio/**/*.baud"],
    });

    const devModule =
        (await import("../src/commands/dev.js")) as DevWatchTestModule;
    const createWatchPlan = devModule.createWatchPlan;
    assert.equal(typeof createWatchPlan, "function");
    const watchPlan = createWatchPlan(watchConfig.watchPatterns);
    assert.deepEqual(watchPlan.patterns, [
        "zones.json",
        "audio",
        "audio/**/*.baud",
    ]);
    assert.deepEqual(watchPlan.roots, ["zones.json", "audio"]);
    assert.equal(watchPlan.matches("zones.json"), true);
    assert.equal(watchPlan.matches("audio/events/reward.baud"), true);
    assert.equal(watchPlan.matches("audio/ignore.txt"), false);
});

test("mergePipelineModes keeps the strongest queued pipeline mode", () => {
    assert.equal(mergePipelineModes(undefined, "start"), "start");
    assert.equal(mergePipelineModes("start", "reload"), "reload");
    assert.equal(mergePipelineModes("reload", "start"), "reload");
    assert.equal(mergePipelineModes("reload", "restart"), "restart");
});

test("runDevCommand exits immediately when local-server is the only selected action and its configured BDS version is unavailable", async (t) => {
    const projectRoot = await createTempDirectory(t, "blr-dev-invalid-bds-");
    await createConfigLoadProject(projectRoot, {
        schemaVersion: 1,
        projectVersion: 1,
        namespace: "test_pack",
        minecraft: {
            channel: "stable",
            targetVersion: "1.26.12.02",
        },
    });

    const previousCwd = process.cwd();
    process.chdir(projectRoot);
    t.after(() => {
        process.chdir(previousCwd);
    });

    const logLines: string[] = [];
    const errorLines: string[] = [];
    t.mock.method(console, "log", (message?: unknown) => {
        logLines.push(String(message));
    });
    t.mock.method(console, "error", (message?: unknown) => {
        errorLines.push(String(message));
    });

    t.mock.method(
        globalThis,
        "fetch",
        async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input);
            if (url.includes("/api/v1.0/download/links")) {
                return createJsonResponse({
                    result: {
                        links: [
                            {
                                downloadType: "serverBedrockWindows",
                                downloadUrl:
                                    "https://www.minecraft.net/bedrockdedicatedserver/bin-win/bedrock-server-1.26.11.1.zip",
                            },
                            {
                                downloadType: "serverBedrockLinux",
                                downloadUrl:
                                    "https://www.minecraft.net/bedrockdedicatedserver/bin-linux/bedrock-server-1.26.11.1.zip",
                            },
                        ],
                    },
                });
            }

            void init;
            return new Response(null, { status: 404 });
        },
    );

    await runDevCommand({});

    assert.ok(
        errorLines.some((line) =>
            /Local server was disabled because BDS version 1\.26\.12\.(?:02|2) is not available on the stable channel\./i.test(
                line,
            ),
        ),
    );
    assert.ok(
        !logLines.some((line) =>
            /Continuing without local server because BDS version/i.test(line),
        ),
    );
    assert.ok(!logLines.includes("[dev] Configuration:"));
    await assert.rejects(access(path.join(projectRoot, "dist")), /ENOENT/);
});
