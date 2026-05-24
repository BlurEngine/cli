import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { loadBlurConfig } from "../src/config.js";
import { buildProject } from "../src/runtime.js";
import {
    createBebeLinkEventHandler,
    resolveBebeAssetSourcePaths,
    saveBebeZoneDraft,
} from "../src/bebe-tooling.js";
import {
    createTempDirectory,
    readJsonFile,
    readTextFile,
    writeJsonFile,
} from "./helpers.js";

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
        ],
    };
}

async function createMinimalScriptProject(projectRoot: string): Promise<void> {
    await mkdir(path.join(projectRoot, "behavior_packs", "game"), {
        recursive: true,
    });
    await mkdir(path.join(projectRoot, "src"), {
        recursive: true,
    });
    await writeFile(
        path.join(projectRoot, "src", "main.ts"),
        [
            "globalThis.__zoneBootOrder ??= [];",
            'globalThis.__zoneBootOrder.push("runtime");',
            "",
        ].join("\n"),
        "utf8",
    );
    await writeJsonFile(path.join(projectRoot, "package.json"), {
        name: "zone-project",
        private: true,
        type: "module",
        dependencies: {
            "@blurengine/bebe": "0.0.0",
        },
    });
    await writeJsonFile(
        path.join(projectRoot, "behavior_packs", "game", "manifest.json"),
        createBehaviorManifest("zone-project"),
    );
    await writeJsonFile(path.join(projectRoot, "blr.config.json"), {
        schemaVersion: 1,
        projectVersion: 1,
        namespace: "bc_df",
        runtime: {
            entry: "src/main.ts",
            outFile: "dist/scripts/main.js",
        },
    });
}

async function createBebeZonesStub(projectRoot: string): Promise<void> {
    const packageRoot = path.join(
        projectRoot,
        "node_modules",
        "@blurengine",
        "bebe",
    );
    await mkdir(path.join(packageRoot, "tooling"), { recursive: true });
    await writeJsonFile(path.join(packageRoot, "package.json"), {
        name: "@blurengine/bebe",
        version: "0.0.0",
        type: "module",
        exports: {
            ".": "./index.js",
            "./tooling/node": "./tooling/node.js",
        },
    });
    await writeFile(
        path.join(packageRoot, "index.js"),
        [
            "export const Zones = {",
            "  load(pack) {",
            "    globalThis.__zoneBootOrder ??= [];",
            "    globalThis.__zoneBootOrder.push('zones');",
            "    globalThis.__loadedZonePack = pack;",
            "  },",
            "};",
            "",
        ].join("\n"),
        "utf8",
    );
    await writeFile(
        path.join(packageRoot, "tooling", "node.js"),
        [
            "const projectCompilerTag = 'project-installed-bebe';",
            "function normaliseBlock(block) {",
            "  return Array.isArray(block)",
            "    ? { x: block[0], y: block[1], z: block[2] }",
            "    : block;",
            "}",
            "export const PROJECT_ZONES_FILE = 'zones.json';",
            "export const ZONE_DRAFT_SAVE_EVENT = 'bebe.zones.saveDraft';",
            "export function normalizeZonePack(input) {",
            "  const pack = input && typeof input === 'object' ? input : {};",
            "  if (!Array.isArray(pack.zones)) throw new Error('zones.json.zones must be an array.');",
            "  return {",
            "    zones: pack.zones.map((zone) => ({",
            "      ...zone,",
            "      extent: zone.extent.kind === 'block'",
            "        ? { ...zone.extent, block: normaliseBlock(zone.extent.block) }",
            "        : zone.extent,",
            "    })),",
            "    ...(pack.scope ? { scope: pack.scope } : {}),",
            "    ...(pack.compiled ? { compiled: pack.compiled } : {}),",
            "  };",
            "}",
            "export function createBebeTooling() {",
            "  return {",
            "    assetCompilers: [{",
            "      id: 'bebe:zones',",
            "      sourcePaths: ['zones.json'],",
            "      outputPath: 'generated/bebe/zones.json',",
            "      compile(input) {",
            "        return {",
            "          output: {",
            "            compiledBy: projectCompilerTag,",
            "            zones: input.sourceJson.zones.map((zone) => ({",
            "              ...zone,",
            "              extent: zone.extent.kind === 'block'",
            "                ? { ...zone.extent, block: normaliseBlock(zone.extent.block) }",
            "                : zone.extent,",
            "            })),",
            "          },",
            "        };",
            "      },",
            "      renderBootstrap(input) {",
            "        return [",
            "          'import { Zones } from \"@blurengine/bebe\";',",
            "          `import __bebeZones from ${JSON.stringify(input.outputImportSpecifier)};`,",
            "          'Zones.load(__bebeZones);',",
            "        ];",
            "      },",
            "    }],",
            "  };",
            "}",
            "",
        ].join("\n"),
        "utf8",
    );
}

test("zone assets are baked by project-installed Bebe tooling and loaded before the runtime entry", async (t) => {
    const projectRoot = await createTempDirectory(t, "blr-zones-build-");
    await createMinimalScriptProject(projectRoot);
    await createBebeZonesStub(projectRoot);
    await writeJsonFile(path.join(projectRoot, "zones.json"), {
        zones: [
            {
                id: "spawn",
                dimension: "minecraft:overworld",
                extent: { kind: "block", block: [0, 64, 0] },
            },
        ],
    });

    const { config } = await loadBlurConfig(projectRoot);
    await buildProject(projectRoot, config, {
        production: false,
        link: { enabled: false },
    });

    const bakedPack = await readJsonFile(
        path.join(projectRoot, "dist", "generated", "bebe", "zones.json"),
    );
    assert.deepEqual(bakedPack, {
        compiledBy: "project-installed-bebe",
        zones: [
            {
                id: "spawn",
                dimension: "minecraft:overworld",
                extent: { kind: "block", block: { x: 0, y: 64, z: 0 } },
            },
        ],
    });
    assert.deepEqual(
        await readJsonFile(
            path.join(
                projectRoot,
                "dist",
                "stage",
                "behavior_packs",
                "game",
                "scripts",
                "generated",
                "bebe",
                "zones.json",
            ),
        ),
        bakedPack,
    );
    assert.deepEqual(
        await readJsonFile(
            path.join(
                projectRoot,
                "dist",
                "stage",
                "bds_behavior_packs",
                "game",
                "scripts",
                "generated",
                "bebe",
                "zones.json",
            ),
        ),
        bakedPack,
    );

    const runtimeBundle = await readTextFile(
        path.join(projectRoot, "dist", "scripts", "main.js"),
    );
    assert.match(runtimeBundle, /Zones\.load/);
    assert.match(runtimeBundle, /__zoneBootOrder/);

    const globals = globalThis as typeof globalThis & {
        __loadedZonePack?: unknown;
        __zoneBootOrder?: string[];
    };
    delete globals.__loadedZonePack;
    delete globals.__zoneBootOrder;
    await import(
        `${pathToFileURL(path.join(projectRoot, "dist", "scripts", "main.js")).href}?zone-test=${Date.now()}`
    );
    assert.deepEqual(globals.__zoneBootOrder, ["zones", "runtime"]);
    assert.deepEqual(globals.__loadedZonePack, bakedPack);
});

test("zone assets require project-installed Bebe tooling", async (t) => {
    const projectRoot = await createTempDirectory(t, "blr-zones-no-tooling-");
    await createMinimalScriptProject(projectRoot);
    await writeJsonFile(path.join(projectRoot, "zones.json"), {
        zones: [],
    });
    const packageRoot = path.join(
        projectRoot,
        "node_modules",
        "@blurengine",
        "bebe",
    );
    await mkdir(packageRoot, { recursive: true });
    await writeJsonFile(path.join(packageRoot, "package.json"), {
        name: "@blurengine/bebe",
        version: "0.0.0",
        type: "module",
        exports: {
            ".": "./index.js",
        },
    });
    await writeFile(
        path.join(packageRoot, "index.js"),
        "export const Zones = { load() {} };\n",
        "utf8",
    );

    const { config } = await loadBlurConfig(projectRoot);
    await assert.rejects(
        () =>
            buildProject(projectRoot, config, {
                production: false,
                link: { enabled: false },
            }),
        /zones\.json requires @blurengine\/bebe\/tooling\/node/,
    );
});

test("authored runtime code cannot import Bebe node tooling", async (t) => {
    const projectRoot = await createTempDirectory(
        t,
        "blr-zones-runtime-guard-",
    );
    await createMinimalScriptProject(projectRoot);
    await writeFile(
        path.join(projectRoot, "src", "main.ts"),
        [
            'import { createBebeTooling } from "@blurengine/bebe/tooling/node";',
            "void createBebeTooling;",
            "",
        ].join("\n"),
        "utf8",
    );

    const { config } = await loadBlurConfig(projectRoot);
    await assert.rejects(
        () =>
            buildProject(projectRoot, config, {
                production: false,
                link: { enabled: false },
            }),
        /Runtime code cannot import @blurengine\/bebe\/tooling/,
    );
});

test("Bebe asset source paths are discovered from project-installed tooling", async (t) => {
    const projectRoot = await createTempDirectory(t, "blr-zones-sources-");
    await createMinimalScriptProject(projectRoot);
    await createBebeZonesStub(projectRoot);

    assert.deepEqual(await resolveBebeAssetSourcePaths(projectRoot), [
        "zones.json",
    ]);
});

test("zone draft saves are normalised through project-installed Bebe tooling", async (t) => {
    const projectRoot = await createTempDirectory(t, "blr-zones-save-");
    await createMinimalScriptProject(projectRoot);
    await createBebeZonesStub(projectRoot);

    const result = await saveBebeZoneDraft(projectRoot, {
        pack: {
            zones: [
                {
                    id: "spawn",
                    dimension: "minecraft:overworld",
                    extent: { kind: "block", block: [0, 64, 0] },
                },
            ],
            compiled: {
                stale: true,
            },
        },
    });

    assert.equal(result.changed, true);
    assert.equal(result.zoneCount, 1);
    assert.deepEqual(await readJsonFile(path.join(projectRoot, "zones.json")), {
        zones: [
            {
                id: "spawn",
                dimension: "minecraft:overworld",
                extent: { kind: "block", block: { x: 0, y: 64, z: 0 } },
            },
        ],
    });

    const noop = await saveBebeZoneDraft(projectRoot, {
        zones: [
            {
                id: "spawn",
                dimension: "minecraft:overworld",
                extent: { kind: "block", block: [0, 64, 0] },
            },
        ],
    });

    assert.equal(noop.changed, false);
    assert.equal(noop.zoneCount, 1);
});

test("Bebe Link zone draft save events write the source zones file", async (t) => {
    const projectRoot = await createTempDirectory(t, "blr-zones-link-save-");
    await createMinimalScriptProject(projectRoot);
    await createBebeZonesStub(projectRoot);
    const logs: string[] = [];
    const handler = createBebeLinkEventHandler({
        projectRoot,
        log(message) {
            logs.push(message);
        },
    });

    await handler(
        {
            kind: "bebe.zones.saveDraft",
            data: {
                pack: {
                    zones: [
                        {
                            id: "arena",
                            dimension: "minecraft:overworld",
                            extent: { kind: "infinite" },
                        },
                    ],
                },
            },
        },
        {
            key: "default",
            ns: "bds",
        },
    );

    assert.deepEqual(await readJsonFile(path.join(projectRoot, "zones.json")), {
        zones: [
            {
                id: "arena",
                dimension: "minecraft:overworld",
                extent: { kind: "infinite" },
            },
        ],
    });
    assert.deepEqual(logs, ["[dev] zones.json saved from Bebe Link."]);
});
