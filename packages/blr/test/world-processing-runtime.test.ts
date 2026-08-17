import assert from "node:assert/strict";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { loadBlurConfig } from "../src/config.js";
import { buildProject } from "../src/runtime.js";
import {
    createBedrockHeightmapDb,
    createBedrockTerrainDb,
} from "./world-image-helpers.js";
import { createTempDirectory, writeJsonFile } from "./helpers.js";

test("buildProject publishes world-derived artifacts before staging pack content", async (t) => {
    const projectRoot = await createTempDirectory(t, "blr-runtime-processors-");
    await createProject(projectRoot);
    const { config } = await loadBlurConfig(projectRoot);
    const artifacts = await buildProject(projectRoot, config, {
        production: true,
        pipeline: "build",
    });
    assert.ok(artifacts.stageBehaviorPackDirectory);
    const resultPath = await findFile(
        path.join(artifacts.stageBehaviorPackDirectory, "generated", "sets"),
        "result.json",
    );
    assert.deepEqual(JSON.parse(await readFile(resultPath, "utf8")), {
        bakedBeforeStage: true,
    });
});

async function createProject(projectRoot: string): Promise<void> {
    const behaviorRoot = path.join(projectRoot, "behavior_packs", "game");
    const worldRoot = path.join(projectRoot, "worlds", "Bedrock level");
    await mkdir(behaviorRoot, { recursive: true });
    await mkdir(path.join(projectRoot, "tooling"), { recursive: true });
    await mkdir(worldRoot, { recursive: true });
    await writeJsonFile(path.join(projectRoot, "package.json"), {
        name: "processor-runtime-fixture",
        private: true,
    });
    await writeJsonFile(path.join(behaviorRoot, "manifest.json"), {
        format_version: 2,
        header: {
            name: "Game",
            description: "Game",
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
    });
    await writeJsonFile(path.join(projectRoot, "blr.config.json"), {
        schemaVersion: 1,
        projectVersion: 1,
        namespace: "fixture",
        dev: { localServer: { worldName: "Bedrock level" } },
        worldProcessors: [
            {
                id: "pack-artifact",
                module: "./tooling/processor.mjs",
                export: "createProcessor",
                sourceWorld: "Bedrock level",
                capabilities: ["artifact"],
                outputRoot: "behavior_packs/game/generated",
                payloadFileNames: { result: "result.json" },
                applyOn: { build: true },
            },
        ],
    });
    await writeFile(
        path.join(projectRoot, "tooling", "processor.mjs"),
        `export function createProcessor() { return { implementationRevision: "v1", logicalInputs: [], async run(input) { return { logicalInputs: input.logicalInputs, artifacts: [{ id: "result", value: { bakedBeforeStage: true } }], diagnostics: [], mutations: [] }; } }; }\n`,
    );
    await writeFile(path.join(worldRoot, "levelname.txt"), "Fixture\n");
    const dbPath = path.join(worldRoot, "db");
    await createBedrockHeightmapDb(dbPath, [
        { chunkX: 0, chunkZ: 0, baseHeight: 1 },
    ]);
    await createBedrockTerrainDb(dbPath, [
        {
            chunkX: 0,
            chunkZ: 0,
            subChunkY: 0,
            blockName: "minecraft:stone",
            localX: 0,
            localY: 0,
            localZ: 0,
        },
    ]);
}

async function findFile(root: string, name: string): Promise<string> {
    for (const entry of await readdir(root, { withFileTypes: true })) {
        const target = path.join(root, entry.name);
        if (entry.isDirectory()) {
            const nested = await findFile(target, name).catch(() => undefined);
            if (nested) return nested;
        } else if (entry.name === name) {
            return target;
        }
    }
    throw new Error(`Could not find ${name} under ${root}.`);
}
