import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
    createBedrockHeightmapDb,
    createBedrockTerrainDb,
} from "./world-image-helpers.js";
import { createTempDirectory, runBuiltCli, writeJsonFile } from "./helpers.js";

test("built cli world build bakes and checks the selected processed lineage", async (t) => {
    const projectRoot = await createTempDirectory(t, "blr-world-build-cli-");
    await createProject(projectRoot);
    const sourceLevelName = path.join(
        projectRoot,
        "worlds",
        "Bedrock level",
        "levelname.txt",
    );
    const sourceBefore = await readFile(sourceLevelName);

    const baked = runBuiltCli(["world", "build", "--json"], projectRoot);
    assert.equal(baked.status, 0, baked.stderr);
    const result = JSON.parse(baked.stdout) as {
        status: string;
        worldBuildId: string;
        worldDirectory: string;
    };
    assert.equal(result.status, "built");
    assert.match(result.worldBuildId, /^[a-f0-9]{64}$/);
    assert.deepEqual(await readFile(sourceLevelName), sourceBefore);

    const checked = runBuiltCli(
        ["world", "build", "--check", "--json"],
        projectRoot,
    );
    assert.equal(checked.status, 0, checked.stderr);
    assert.equal(JSON.parse(checked.stdout).status, "current");
});

test("built cli world build check is a read-only no-op without applicable processors", async (t) => {
    const projectRoot = await createTempDirectory(t, "blr-world-build-empty-");
    await mkdir(path.join(projectRoot, "behavior_packs", "fixture"), {
        recursive: true,
    });
    await writeJsonFile(path.join(projectRoot, "package.json"), {
        name: "world-build-empty",
        private: true,
    });
    await writeJsonFile(
        path.join(projectRoot, "behavior_packs", "fixture", "manifest.json"),
        {
            format_version: 2,
            header: {
                name: "Fixture",
                description: "Fixture",
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
    await writeJsonFile(path.join(projectRoot, "blr.config.json"), {
        schemaVersion: 1,
        projectVersion: 1,
        namespace: "fixture",
    });

    const checked = runBuiltCli(
        ["world", "build", "--check", "--json"],
        projectRoot,
    );
    assert.equal(checked.status, 0, checked.stderr);
    assert.deepEqual(JSON.parse(checked.stdout), {
        status: "current",
        worldName: "Bedrock level",
        processorIds: [],
        diagnostics: [],
    });
    await assert.rejects(readFile(path.join(projectRoot, ".blr")));
});

async function createProject(projectRoot: string): Promise<void> {
    await mkdir(path.join(projectRoot, "behavior_packs", "fixture"), {
        recursive: true,
    });
    await mkdir(path.join(projectRoot, "tooling"), { recursive: true });
    const worldDirectory = path.join(projectRoot, "worlds", "Bedrock level");
    await mkdir(worldDirectory, { recursive: true });
    await writeJsonFile(path.join(projectRoot, "package.json"), {
        name: "world-build-fixture",
        private: true,
    });
    await writeJsonFile(
        path.join(projectRoot, "behavior_packs", "fixture", "manifest.json"),
        {
            format_version: 2,
            header: {
                name: "Fixture",
                description: "Fixture",
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
    await writeJsonFile(path.join(projectRoot, "blr.config.json"), {
        schemaVersion: 1,
        projectVersion: 1,
        namespace: "fixture",
        dev: { localServer: { worldName: "Bedrock level" } },
        worldProcessors: [
            {
                id: "fixture",
                module: "./tooling/processor.mjs",
                export: "createProcessor",
                sourceWorld: "Bedrock level",
                capabilities: ["transform"],
                applyOn: { worldBuild: true },
            },
        ],
    });
    await writeFile(
        path.join(projectRoot, "tooling", "processor.mjs"),
        `export function createProcessor() { return { implementationRevision: "v1", logicalInputs: [], async run(input) { let block; for await (const value of input.observations.blocks({ dimension: "overworld", bounds: { min: {x:0,y:0,z:0}, max:{x:0,y:0,z:0} }, includeAir: true })) if (value.layer === 0) block = value; return { logicalInputs: input.logicalInputs, artifacts: [], diagnostics: [], mutations: [{ kind: "set-block", opId: "gold", dimension: "overworld", location: {x:0,y:0,z:0}, layer: 0, expectedPalette: block.palette, replacement: { kind: "literal", palette: { typeId: "minecraft:gold_block", states: {}, version: block.palette.version } }, blockEntityPolicy: "require-absent" }] }; } }; }\n`,
    );
    await writeFile(path.join(worldDirectory, "levelname.txt"), "Fixture\n");
    const dbPath = path.join(worldDirectory, "db");
    await createBedrockHeightmapDb(dbPath, [
        { chunkX: 0, chunkZ: 0, baseHeight: 1 },
    ]);
    await createBedrockTerrainDb(dbPath, [
        {
            chunkX: 0,
            chunkZ: 0,
            subChunkY: 0,
            blockName: "minecraft:stone",
            version: 18_488_832,
            localX: 0,
            localY: 0,
            localZ: 0,
        },
    ]);
}
