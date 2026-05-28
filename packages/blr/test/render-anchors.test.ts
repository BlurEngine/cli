import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { loadBlurConfig } from "../src/config.js";
import { buildProject } from "../src/runtime.js";
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
                description: "Resource assets",
                type: "resources",
                uuid: "44444444-4444-4444-4444-444444444444",
                version: [0, 1, 0],
            },
        ],
    };
}

async function createMinimalRenderAnchorProject(
    projectRoot: string,
): Promise<void> {
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
        [
            "globalThis.__renderAnchorBootOrder ??= [];",
            'globalThis.__renderAnchorBootOrder.push("runtime");',
            "",
        ].join("\n"),
        "utf8",
    );
    await writeJsonFile(path.join(projectRoot, "package.json"), {
        name: "render-anchor-project",
        private: true,
        type: "module",
        dependencies: {
            "@blurengine/bebe": "0.0.0",
        },
    });
    await writeJsonFile(
        path.join(projectRoot, "behavior_packs", "game", "manifest.json"),
        createBehaviorManifest("render-anchor-project"),
    );
    await writeJsonFile(
        path.join(projectRoot, "resource_packs", "assets", "manifest.json"),
        createResourceManifest("render-anchor-project"),
    );
    await writeJsonFile(path.join(projectRoot, "blr.config.json"), {
        schemaVersion: 1,
        projectVersion: 1,
        namespace: "demo",
        runtime: {
            entry: "src/main.ts",
            outFile: "dist/scripts/main.js",
        },
    });
}

async function createBebeRenderAnchorsStub(projectRoot: string): Promise<void> {
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
            "export const RenderAnchors = {",
            "  load(pack) {",
            "    globalThis.__renderAnchorBootOrder ??= [];",
            "    globalThis.__renderAnchorBootOrder.push('render-anchors');",
            "    globalThis.__loadedRenderAnchorPack = pack;",
            "  },",
            "  start() {",
            "    globalThis.__renderAnchorBootOrder ??= [];",
            "    globalThis.__renderAnchorBootOrder.push('render-anchors-start');",
            "  },",
            "};",
            "",
        ].join("\n"),
        "utf8",
    );
    await writeFile(
        path.join(packageRoot, "tooling", "node.js"),
        [
            "export function createBebeTooling() {",
            "  return {",
            "    assetCompilers: [{",
            "      id: 'bebe:render-anchors',",
            "      sourcePaths: ['render-anchors.json'],",
            "      outputPath: 'generated/bebe/render-anchors.json',",
            "      compile(input) {",
            "        return {",
            "          output: { anchors: input.sourceJson.anchors },",
            "          artifacts: [",
            "            {",
            "              target: 'behaviorPack',",
            "              outputPath: 'entities/bebe/render_anchor.json',",
            "              output: { generated: 'behavior' },",
            "            },",
            "            {",
            "              target: 'resourcePack',",
            "              outputPath: 'entity/bebe/render_anchor.entity.json',",
            "              output: { generated: 'resource' },",
            "            },",
            "          ],",
            "        };",
            "      },",
            "      renderBootstrap(input) {",
            "        return [",
            "          'import { RenderAnchors } from \"@blurengine/bebe\";',",
            "          `import __bebeRenderAnchors from ${JSON.stringify(input.outputImportSpecifier)};`,",
            "          'RenderAnchors.load(__bebeRenderAnchors);',",
            "          'RenderAnchors.start();',",
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

test("render-anchor Bebe artifacts are staged into behavior and resource packs", async (t) => {
    const projectRoot = await createTempDirectory(t, "blr-render-anchors-");
    await createMinimalRenderAnchorProject(projectRoot);
    await createBebeRenderAnchorsStub(projectRoot);
    await writeJsonFile(path.join(projectRoot, "render-anchors.json"), {
        anchors: [
            {
                id: "harbour.crane",
                entity: "demo:crane",
                location: [320, 80, -48],
            },
        ],
    });

    const { config } = await loadBlurConfig(projectRoot);
    await buildProject(projectRoot, config, {
        production: false,
        link: { enabled: false },
    });

    const bakedPack = await readJsonFile(
        path.join(
            projectRoot,
            "dist",
            "generated",
            "bebe",
            "render-anchors.json",
        ),
    );
    assert.deepEqual(bakedPack, {
        anchors: [
            {
                id: "harbour.crane",
                entity: "demo:crane",
                location: [320, 80, -48],
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
                "entities",
                "bebe",
                "render_anchor.json",
            ),
        ),
        { generated: "behavior" },
    );
    assert.deepEqual(
        await readJsonFile(
            path.join(
                projectRoot,
                "dist",
                "stage",
                "bds_behavior_packs",
                "game",
                "entities",
                "bebe",
                "render_anchor.json",
            ),
        ),
        { generated: "behavior" },
    );
    assert.deepEqual(
        await readJsonFile(
            path.join(
                projectRoot,
                "dist",
                "stage",
                "resource_packs",
                "assets",
                "entity",
                "bebe",
                "render_anchor.entity.json",
            ),
        ),
        { generated: "resource" },
    );

    const runtimeBundle = await readTextFile(
        path.join(projectRoot, "dist", "scripts", "main.js"),
    );
    assert.match(runtimeBundle, /RenderAnchors\.load/);
    assert.match(runtimeBundle, /RenderAnchors\.start/);

    const globals = globalThis as typeof globalThis & {
        __loadedRenderAnchorPack?: unknown;
        __renderAnchorBootOrder?: string[];
    };
    delete globals.__loadedRenderAnchorPack;
    delete globals.__renderAnchorBootOrder;
    await import(
        `${pathToFileURL(path.join(projectRoot, "dist", "scripts", "main.js")).href}?render-anchor-test=${Date.now()}`
    );
    assert.deepEqual(globals.__renderAnchorBootOrder, [
        "render-anchors",
        "render-anchors-start",
        "runtime",
    ]);
    assert.deepEqual(globals.__loadedRenderAnchorPack, bakedPack);
});

test("render-anchor assets require project-installed Bebe tooling", async (t) => {
    const projectRoot = await createTempDirectory(
        t,
        "blr-render-anchors-no-tooling-",
    );
    await createMinimalRenderAnchorProject(projectRoot);
    await writeJsonFile(path.join(projectRoot, "render-anchors.json"), {
        anchors: [],
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
        "export const RenderAnchors = { load() {}, start() {} };\n",
        "utf8",
    );

    const { config } = await loadBlurConfig(projectRoot);
    await assert.rejects(
        () =>
            buildProject(projectRoot, config, {
                production: false,
                link: { enabled: false },
            }),
        /render-anchors\.json requires @blurengine\/bebe\/tooling\/node/,
    );
});
