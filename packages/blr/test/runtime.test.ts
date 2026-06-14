import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { loadBlurConfig } from "../src/config.js";
import { buildProject } from "../src/runtime.js";
import {
    createTempDirectory,
    readJsonFile,
    readTextFile,
    writeJsonFile,
} from "./helpers.js";

function createResourceManifest(projectName: string) {
    return {
        format_version: 2,
        header: {
            name: `${projectName} Resource Pack`,
            description: `${projectName} resource pack`,
            uuid: "33333333-3333-3333-3333-333333333333",
            version: [0, 1, 0],
            min_engine_version: [1, 26, 0],
        },
        modules: [
            {
                type: "resources",
                uuid: "44444444-4444-4444-4444-444444444444",
                version: [0, 1, 0],
            },
        ],
    };
}

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
                description: "Behavior resources",
                type: "data",
                uuid: "22222222-2222-2222-2222-222222222222",
                version: [0, 1, 0],
            },
            {
                description: "Script resources",
                language: "javascript",
                type: "script",
                uuid: "55555555-5555-5555-5555-555555555555",
                version: [0, 1, 0],
                entry: "scripts/main.js",
            },
        ],
        dependencies: [
            {
                module_name: "@minecraft/server",
                version: "2.3.0",
            },
            {
                module_name: "@minecraft/server-net",
                version: "1.0.0-beta",
            },
        ],
    };
}

async function createMinimalResourceProject(
    projectRoot: string,
): Promise<void> {
    await mkdir(path.join(projectRoot, "resource_packs", "example-pack"), {
        recursive: true,
    });
    await writeJsonFile(path.join(projectRoot, "package.json"), {
        name: "example-project",
        private: true,
    });
    await writeJsonFile(
        path.join(
            projectRoot,
            "resource_packs",
            "example-pack",
            "manifest.json",
        ),
        createResourceManifest("example-project"),
    );
    await writeJsonFile(path.join(projectRoot, "blr.config.json"), {
        schemaVersion: 1,
        projectVersion: 1,
        namespace: "test_pack",
        minecraft: {
            targetVersion: "1.26.11.1",
        },
    });
}

async function createMinimalScriptProject(projectRoot: string): Promise<void> {
    await mkdir(path.join(projectRoot, "behavior_packs", "game"), {
        recursive: true,
    });
    await mkdir(path.join(projectRoot, "resource_packs", "assets"), {
        recursive: true,
    });
    await mkdir(path.join(projectRoot, "src"), {
        recursive: true,
    });
    await writeFile(
        path.join(projectRoot, "src", "main.ts"),
        'console.warn("single authored main");\n',
        "utf8",
    );
    await writeJsonFile(path.join(projectRoot, "package.json"), {
        name: "script-project",
        private: true,
        type: "module",
    });
    await writeJsonFile(
        path.join(projectRoot, "behavior_packs", "game", "manifest.json"),
        createBehaviorManifest("script-project"),
    );
    await writeJsonFile(
        path.join(projectRoot, "resource_packs", "assets", "manifest.json"),
        createResourceManifest("script-project"),
    );
    await writeJsonFile(path.join(projectRoot, "blr.config.json"), {
        schemaVersion: 1,
        projectVersion: 1,
        namespace: "test_pack",
        runtime: {
            entry: "src/main.ts",
            outFile: "dist/scripts/main.js",
        },
    });
}

async function createInternalBebeLinkBdsStub(
    projectRoot: string,
): Promise<void> {
    const packageRoot = path.join(
        projectRoot,
        "node_modules",
        "@blurengine",
        "bebe",
    );
    await mkdir(path.join(packageRoot, "internal", "link"), {
        recursive: true,
    });
    await mkdir(path.join(packageRoot, "internal", "audio"), {
        recursive: true,
    });
    await mkdir(path.join(packageRoot, "internal", "zones"), {
        recursive: true,
    });
    await writeJsonFile(path.join(packageRoot, "package.json"), {
        name: "@blurengine/bebe",
        version: "0.0.0",
        type: "module",
        exports: {
            ".": "./index.js",
            "./internal/link/bds": "./internal/link/bds.js",
            "./internal/audio/player": "./internal/audio/player.js",
            "./internal/zones/editor": "./internal/zones/editor.js",
        },
    });
    await writeFile(
        path.join(packageRoot, "index.js"),
        [
            "export const Link = {",
            "  event(kind, data) {",
            "    console.warn('fake link event', kind, data);",
            "    return Promise.resolve({ ok: true });",
            "  },",
            "  snapshot(kind, data) {",
            "    console.warn('fake link snapshot', kind, data);",
            "  },",
            "  on(kind, handler) {",
            "    console.warn('fake link handler', kind, handler);",
            "    return () => {};",
            "  },",
            "  isAvailable() { return true; },",
            "  capabilities() { return ['events']; },",
            "  status() { return { available: true, capabilities: ['events'] }; },",
            "};",
            "export class Context {",
            "  constructor() {",
            "    globalThis.__blrLinkContextCreated = true;",
            "  }",
            "  use() { return () => {}; }",
            "}",
            "",
        ].join("\n"),
        "utf8",
    );
    await writeFile(
        path.join(packageRoot, "internal", "link", "bds.js"),
        [
            "export function installBdsLinkTransport(options) {",
            "  globalThis.__blrLinkOptions = options;",
            "}",
            "",
        ].join("\n"),
        "utf8",
    );
    await writeFile(
        path.join(packageRoot, "internal", "audio", "player.js"),
        [
            "export function installAudioPlayerCommand(options) {",
            "  globalThis.__blrAudioPlayerInstalled = (globalThis.__blrAudioPlayerInstalled ?? 0) + 1;",
            "  globalThis.__blrAudioPlayerOptions = options;",
            "}",
            "",
        ].join("\n"),
        "utf8",
    );
    await writeFile(
        path.join(packageRoot, "internal", "zones", "editor.js"),
        [
            "export function installZoneEditor(options) {",
            "  globalThis.__blrZoneEditorInstalled = (globalThis.__blrZoneEditorInstalled ?? 0) + 1;",
            "  globalThis.__blrZoneEditorOptions = options;",
            "}",
            "",
        ].join("\n"),
        "utf8",
    );
}

test("buildProject preserves the authored pack manifest min_engine_version in staged output", async (t) => {
    const projectRoot = await createTempDirectory(t, "blr-runtime-");
    await createMinimalResourceProject(projectRoot);

    const { config } = await loadBlurConfig(projectRoot);
    await buildProject(projectRoot, config, {
        production: false,
    });

    const stagedManifest = await readJsonFile<{
        header?: {
            min_engine_version?: number[];
        };
    }>(
        path.join(
            projectRoot,
            "dist",
            "stage",
            "resource_packs",
            "example-pack",
            "manifest.json",
        ),
    );

    assert.deepEqual(config.minecraft.minEngineVersion, [1, 26, 11]);
    assert.deepEqual(stagedManifest.header?.min_engine_version, [1, 26, 0]);
});

test("buildProject stages separate offline and BDS behavior-pack variants from one runtime entry", async (t) => {
    const projectRoot = await createTempDirectory(t, "blr-runtime-variants-");
    await createMinimalScriptProject(projectRoot);

    const { config } = await loadBlurConfig(projectRoot);
    await buildProject(projectRoot, config, {
        production: false,
    });

    const offlineManifest = await readJsonFile<{
        dependencies?: Array<{ module_name?: string }>;
    }>(
        path.join(
            projectRoot,
            "dist",
            "stage",
            "behavior_packs",
            "game",
            "manifest.json",
        ),
    );
    const bdsManifest = await readJsonFile<{
        dependencies?: Array<{ module_name?: string }>;
    }>(
        path.join(
            projectRoot,
            "dist",
            "stage",
            "bds_behavior_packs",
            "game",
            "manifest.json",
        ),
    );

    assert.equal(
        offlineManifest.dependencies?.some(
            (entry) => entry.module_name === "@minecraft/server-net",
        ),
        false,
    );
    assert.equal(
        bdsManifest.dependencies?.some(
            (entry) => entry.module_name === "@minecraft/server-net",
        ),
        true,
    );

    assert.equal(
        await readTextFile(
            path.join(
                projectRoot,
                "dist",
                "stage",
                "behavior_packs",
                "game",
                "scripts",
                "main.js",
            ),
        ),
        await readTextFile(
            path.join(projectRoot, "dist", "scripts", "main.js"),
        ),
    );
    assert.equal(
        await readTextFile(
            path.join(
                projectRoot,
                "dist",
                "stage",
                "bds_behavior_packs",
                "game",
                "scripts",
                "main.js",
            ),
        ),
        await readTextFile(
            path.join(projectRoot, "dist", "scripts", "main.bds.js"),
        ),
    );
    await assert.rejects(
        readJsonFile(
            path.join(
                projectRoot,
                "dist",
                "stage",
                "bds_resource_packs",
                "assets",
                "manifest.json",
            ),
        ),
    );
});

test("buildProject injects Bebe Link transport only into the BDS runtime bundle", async (t) => {
    const projectRoot = await createTempDirectory(t, "blr-runtime-link-");
    await createMinimalScriptProject(projectRoot);
    await createInternalBebeLinkBdsStub(projectRoot);
    await writeJsonFile(path.join(projectRoot, "package.json"), {
        name: "script-project",
        private: true,
        type: "module",
        dependencies: {
            "@blurengine/bebe": "0.0.0",
        },
    });

    const { config } = await loadBlurConfig(projectRoot);
    await buildProject(projectRoot, config, {
        production: false,
        link: {
            baseUrl: "http://127.0.0.1:19999",
        },
    });

    const offlineBundle = await readTextFile(
        path.join(projectRoot, "dist", "scripts", "main.js"),
    );
    const bdsBundle = await readTextFile(
        path.join(projectRoot, "dist", "scripts", "main.bds.js"),
    );

    assert.equal(offlineBundle.includes("127.0.0.1:19999"), false);
    assert.equal(bdsBundle.includes("127.0.0.1:19999"), true);
    assert.equal(bdsBundle.includes("__blrLinkContext"), true);
    assert.match(bdsBundle, /installBdsLinkTransport\(\{[^}]*context:/su);
});

test("buildProject injects the Bebe zone editor for dev builds", async (t) => {
    const projectRoot = await createTempDirectory(t, "blr-runtime-editor-dev-");
    await createMinimalScriptProject(projectRoot);
    await createInternalBebeLinkBdsStub(projectRoot);
    await writeJsonFile(path.join(projectRoot, "package.json"), {
        name: "script-project",
        private: true,
        type: "module",
        dependencies: {
            "@blurengine/bebe": "0.0.0",
        },
    });

    const { config } = await loadBlurConfig(projectRoot);
    await buildProject(projectRoot, config, {
        production: false,
        pipeline: "dev",
    });

    const offlineBundle = await readTextFile(
        path.join(projectRoot, "dist", "scripts", "main.js"),
    );
    const bdsBundle = await readTextFile(
        path.join(projectRoot, "dist", "scripts", "main.bds.js"),
    );

    assert.equal(offlineBundle.includes("__blrZoneEditorInstalled"), true);
    assert.equal(bdsBundle.includes("__blrZoneEditorInstalled"), true);
    assert.match(offlineBundle, /commandNamespace:\s*"test_pack"/);
    assert.match(bdsBundle, /commandNamespace:\s*"test_pack"/);
    assert.match(offlineBundle, /commandPermissionLevel:\s*0/);
    assert.match(bdsBundle, /commandPermissionLevel:\s*0/);
});

test("buildProject injects the Bebe audio player command for dev builds", async (t) => {
    const projectRoot = await createTempDirectory(t, "blr-runtime-audio-dev-");
    await createMinimalScriptProject(projectRoot);
    await createInternalBebeLinkBdsStub(projectRoot);
    await writeJsonFile(path.join(projectRoot, "package.json"), {
        name: "script-project",
        private: true,
        type: "module",
        dependencies: {
            "@blurengine/bebe": "0.0.0",
        },
    });

    const { config } = await loadBlurConfig(projectRoot);
    await buildProject(projectRoot, config, {
        production: false,
        pipeline: "dev",
    });

    const offlineBundle = await readTextFile(
        path.join(projectRoot, "dist", "scripts", "main.js"),
    );
    const bdsBundle = await readTextFile(
        path.join(projectRoot, "dist", "scripts", "main.bds.js"),
    );

    assert.equal(offlineBundle.includes("__blrAudioPlayerInstalled"), true);
    assert.equal(bdsBundle.includes("__blrAudioPlayerInstalled"), true);
    assert.match(offlineBundle, /installAudioPlayerCommand/);
    assert.match(bdsBundle, /installAudioPlayerCommand/);
    assert.match(offlineBundle, /commandNamespace:\s*"test_pack"/);
    assert.match(bdsBundle, /commandNamespace:\s*"test_pack"/);
    assert.match(offlineBundle, /commandPermissionLevel:\s*0/);
    assert.match(bdsBundle, /commandPermissionLevel:\s*0/);
    assert.match(offlineBundle, /logger:\s*console/);
    assert.match(bdsBundle, /logger:\s*console/);
});

test("buildProject skips the Bebe zone editor when dev injection is disabled", async (t) => {
    const projectRoot = await createTempDirectory(
        t,
        "blr-runtime-editor-dev-off-",
    );
    await createMinimalScriptProject(projectRoot);
    await createInternalBebeLinkBdsStub(projectRoot);
    await writeJsonFile(path.join(projectRoot, "package.json"), {
        name: "script-project",
        private: true,
        type: "module",
        dependencies: {
            "@blurengine/bebe": "0.0.0",
        },
    });
    const configPath = path.join(projectRoot, "blr.config.json");
    const configFile = await readJsonFile<Record<string, unknown>>(configPath);
    await writeJsonFile(configPath, {
        ...configFile,
        bebe: {
            zoneEditor: {
                dev: false,
            },
        },
    });

    const { config } = await loadBlurConfig(projectRoot);
    await buildProject(projectRoot, config, {
        production: false,
        pipeline: "dev",
    });

    const offlineBundle = await readTextFile(
        path.join(projectRoot, "dist", "scripts", "main.js"),
    );
    const bdsBundle = await readTextFile(
        path.join(projectRoot, "dist", "scripts", "main.bds.js"),
    );

    assert.equal(offlineBundle.includes("__blrZoneEditorInstalled"), false);
    assert.equal(bdsBundle.includes("__blrZoneEditorInstalled"), false);
});

test("buildProject skips the Bebe audio player command for package builds", async (t) => {
    const projectRoot = await createTempDirectory(
        t,
        "blr-runtime-audio-package-off-",
    );
    await createMinimalScriptProject(projectRoot);
    await createInternalBebeLinkBdsStub(projectRoot);
    await writeJsonFile(path.join(projectRoot, "package.json"), {
        name: "script-project",
        private: true,
        type: "module",
        dependencies: {
            "@blurengine/bebe": "0.0.0",
        },
    });

    const { config } = await loadBlurConfig(projectRoot);
    await buildProject(projectRoot, config, {
        production: false,
        pipeline: "package",
    });

    const offlineBundle = await readTextFile(
        path.join(projectRoot, "dist", "scripts", "main.js"),
    );
    const bdsBundle = await readTextFile(
        path.join(projectRoot, "dist", "scripts", "main.bds.js"),
    );

    assert.equal(offlineBundle.includes("__blrAudioPlayerInstalled"), false);
    assert.equal(bdsBundle.includes("__blrAudioPlayerInstalled"), false);
});

test("buildProject skips the Bebe zone editor for package builds by default", async (t) => {
    const projectRoot = await createTempDirectory(
        t,
        "blr-runtime-editor-package-off-",
    );
    await createMinimalScriptProject(projectRoot);
    await createInternalBebeLinkBdsStub(projectRoot);
    await writeJsonFile(path.join(projectRoot, "package.json"), {
        name: "script-project",
        private: true,
        type: "module",
        dependencies: {
            "@blurengine/bebe": "0.0.0",
        },
    });

    const { config } = await loadBlurConfig(projectRoot);
    await buildProject(projectRoot, config, {
        production: false,
        pipeline: "package",
    });

    const offlineBundle = await readTextFile(
        path.join(projectRoot, "dist", "scripts", "main.js"),
    );
    const bdsBundle = await readTextFile(
        path.join(projectRoot, "dist", "scripts", "main.bds.js"),
    );

    assert.equal(offlineBundle.includes("__blrZoneEditorInstalled"), false);
    assert.equal(bdsBundle.includes("__blrZoneEditorInstalled"), false);
});

test("buildProject can include the Bebe zone editor in package builds", async (t) => {
    const projectRoot = await createTempDirectory(
        t,
        "blr-runtime-editor-package-on-",
    );
    await createMinimalScriptProject(projectRoot);
    await createInternalBebeLinkBdsStub(projectRoot);
    await writeJsonFile(path.join(projectRoot, "package.json"), {
        name: "script-project",
        private: true,
        type: "module",
        dependencies: {
            "@blurengine/bebe": "0.0.0",
        },
    });
    const configPath = path.join(projectRoot, "blr.config.json");
    const configFile = await readJsonFile<Record<string, unknown>>(configPath);
    await writeJsonFile(configPath, {
        ...configFile,
        bebe: {
            zoneEditor: {
                package: true,
            },
        },
    });

    const { config } = await loadBlurConfig(projectRoot);
    await buildProject(projectRoot, config, {
        production: false,
        pipeline: "package",
    });

    const offlineBundle = await readTextFile(
        path.join(projectRoot, "dist", "scripts", "main.js"),
    );
    const bdsBundle = await readTextFile(
        path.join(projectRoot, "dist", "scripts", "main.bds.js"),
    );

    assert.equal(offlineBundle.includes("__blrZoneEditorInstalled"), true);
    assert.equal(bdsBundle.includes("__blrZoneEditorInstalled"), true);
    assert.match(offlineBundle, /commandPermissionLevel:\s*1/);
    assert.match(bdsBundle, /commandPermissionLevel:\s*1/);
});

test("buildProject strips direct Bebe Link usage from the offline runtime bundle", async (t) => {
    const projectRoot = await createTempDirectory(t, "blr-runtime-strip-link-");
    await createMinimalScriptProject(projectRoot);
    await createInternalBebeLinkBdsStub(projectRoot);
    await writeJsonFile(path.join(projectRoot, "package.json"), {
        name: "script-project",
        private: true,
        type: "module",
        dependencies: {
            "@blurengine/bebe": "0.0.0",
        },
    });
    await writeFile(
        path.join(projectRoot, "src", "main.ts"),
        [
            'import { Link as RuntimeLink } from "@blurengine/bebe";',
            'import * as Bebe from "@blurengine/bebe";',
            "",
            "function collectWorldSnapshot() {",
            '    console.warn("offline should not collect Link snapshot");',
            "    return { players: 1 };",
            "}",
            "",
            'RuntimeLink.event("world.snapshot", collectWorldSnapshot());',
            'Bebe.Link.event("namespace.snapshot", collectWorldSnapshot());',
            'RuntimeLink.snapshot("world.latest", collectWorldSnapshot(), { key: "overworld" });',
            'Bebe.Link.snapshot("namespace.latest", collectWorldSnapshot());',
            'RuntimeLink.on("project.message", (event) => {',
            '    console.warn("offline should not keep Link handler", event.data);',
            "});",
            "",
            "async function boot() {",
            '    RuntimeLink.event("boot.result", collectWorldSnapshot());',
            "    const status = RuntimeLink.status();",
            "    const capabilities = RuntimeLink.capabilities();",
            '    const available = RuntimeLink.isAvailable("events");',
            '    console.warn("runtime kept", status.available, capabilities.length, available);',
            "}",
            "",
            "void boot();",
            "",
        ].join("\n"),
        "utf8",
    );

    const { config } = await loadBlurConfig(projectRoot);
    await buildProject(projectRoot, config, {
        production: false,
        link: {
            baseUrl: "http://127.0.0.1:19999",
        },
    });

    const offlineBundle = await readTextFile(
        path.join(projectRoot, "dist", "scripts", "main.js"),
    );
    const bdsBundle = await readTextFile(
        path.join(projectRoot, "dist", "scripts", "main.bds.js"),
    );

    assert.equal(offlineBundle.includes("runtime kept"), true);
    assert.equal(offlineBundle.includes("world.snapshot"), false);
    assert.equal(offlineBundle.includes("namespace.snapshot"), false);
    assert.equal(offlineBundle.includes("world.latest"), false);
    assert.equal(offlineBundle.includes("namespace.latest"), false);
    assert.equal(offlineBundle.includes("boot.result"), false);
    assert.equal(offlineBundle.includes("project.message"), false);
    assert.equal(
        offlineBundle.includes("offline should not collect Link snapshot"),
        false,
    );
    assert.equal(
        offlineBundle.includes("offline should not keep Link handler"),
        false,
    );

    assert.equal(bdsBundle.includes("world.snapshot"), true);
    assert.equal(bdsBundle.includes("namespace.snapshot"), true);
    assert.equal(bdsBundle.includes("world.latest"), true);
    assert.equal(bdsBundle.includes("namespace.latest"), true);
    assert.equal(bdsBundle.includes("boot.result"), true);
    assert.equal(bdsBundle.includes("project.message"), true);
    assert.equal(
        bdsBundle.includes("offline should not collect Link snapshot"),
        true,
    );
    assert.equal(
        bdsBundle.includes("offline should not keep Link handler"),
        true,
    );
});

test("buildProject fails clearly when Bebe Link usage cannot be stripped from the offline runtime bundle", async (t) => {
    const projectRoot = await createTempDirectory(
        t,
        "blr-runtime-link-unsupported-",
    );
    await createMinimalScriptProject(projectRoot);
    await createInternalBebeLinkBdsStub(projectRoot);
    await writeJsonFile(path.join(projectRoot, "package.json"), {
        name: "script-project",
        private: true,
        type: "module",
        dependencies: {
            "@blurengine/bebe": "0.0.0",
        },
    });
    await writeFile(
        path.join(projectRoot, "src", "main.ts"),
        [
            'import { Link } from "@blurengine/bebe";',
            "",
            "const send = Link.event;",
            'send("world.snapshot", { players: 1 });',
            "",
        ].join("\n"),
        "utf8",
    );

    const { config } = await loadBlurConfig(projectRoot);
    await assert.rejects(
        () =>
            buildProject(projectRoot, config, {
                production: false,
            }),
        /Cannot strip Bebe Link usage from the offline bundle/,
    );
});
