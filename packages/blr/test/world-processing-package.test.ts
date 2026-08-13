import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { runPackageCommand } from "../src/commands/package.js";
import { withBedrockWorldObservations } from "../src/world-processing/observation-facade.js";
import { withVerifiedWorldSnapshot } from "../src/world-processing/world-snapshot.js";
import {
    createBedrockHeightmapDb,
    createBedrockTerrainDb,
} from "./world-image-helpers.js";
import { createTempDirectory, writeJsonFile } from "./helpers.js";

test("package world targets consume one processed world while preserving the authored source", async (t) => {
    const projectRoot = await createTempDirectory(t, "blr-package-processed-");
    await createProject(projectRoot);
    const source = path.join(projectRoot, "worlds", "Bedrock level");
    const before = await inventory(source);
    const previous = process.cwd();
    process.chdir(projectRoot);
    try {
        await runPackageCommand("world", { worldFormat: "zip" });
    } finally {
        process.chdir(previous);
    }
    const workspace = path.join(projectRoot, "dist", "packages", "world");
    assert.equal(await blockType(workspace), "minecraft:diamond_block");
    assert.deepEqual(await inventory(source), before);
});

test("package targets without a world do not execute transform-only processors", async (t) => {
    const projectRoot = await createTempDirectory(
        t,
        "blr-package-no-world-processing-",
    );
    await createProject(projectRoot);
    await writeFile(
        path.join(projectRoot, "tooling", "processor.mjs"),
        `export function createProcessor() { return { implementationRevision: "v1", logicalInputs: [], async run() { throw new Error("transform-only processor must not run"); } }; }\n`,
    );
    const previous = process.cwd();
    process.chdir(projectRoot);
    try {
        await runPackageCommand("behavior-pack", {});
    } finally {
        process.chdir(previous);
    }
});

async function createProject(projectRoot: string): Promise<void> {
    const behaviorRoot = path.join(projectRoot, "behavior_packs", "game");
    const worldRoot = path.join(projectRoot, "worlds", "Bedrock level");
    await mkdir(behaviorRoot, { recursive: true });
    await mkdir(path.join(projectRoot, "tooling"), { recursive: true });
    await mkdir(worldRoot, { recursive: true });
    await writeJsonFile(path.join(projectRoot, "package.json"), {
        name: "processed-package",
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
                id: "package-transform",
                module: "./tooling/processor.mjs",
                export: "createProcessor",
                sourceWorld: "Bedrock level",
                capabilities: ["transform"],
                applyOn: { package: true },
            },
        ],
    });
    await writeFile(
        path.join(projectRoot, "tooling", "processor.mjs"),
        `export function createProcessor() { return { implementationRevision: "v1", logicalInputs: [], async run(input) { let block; for await (const value of input.observations.blocks({ dimension: "overworld", bounds: { min: {x:0,y:0,z:0}, max:{x:0,y:0,z:0} }, includeAir:true })) if (value.layer === 0) block = value; return { logicalInputs: input.logicalInputs, artifacts: [], diagnostics: [], mutations: [{ kind:"set-block", opId:"diamond", dimension:"overworld", location:{x:0,y:0,z:0}, layer:0, expectedPalette:block.palette, replacement:{kind:"literal", palette:{typeId:"minecraft:diamond_block",states:{},version:block.palette.version}}, blockEntityPolicy:"require-absent" }] }; } }; }\n`,
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

async function blockType(worldDirectory: string): Promise<string | undefined> {
    return withVerifiedWorldSnapshot(
        { worldName: "fixture", sourceWorldDirectory: worldDirectory },
        async (snapshot) => {
            let result: string | undefined;
            await withBedrockWorldObservations(
                { dbPath: snapshot.dbPath },
                async (observations) => {
                    for await (const observation of observations.blocks({
                        dimension: "overworld",
                        bounds: {
                            min: { x: 0, y: 0, z: 0 },
                            max: { x: 0, y: 0, z: 0 },
                        },
                    })) {
                        if (observation.layer === 0)
                            result = observation.palette.typeId;
                    }
                },
            );
            return result;
        },
    );
}

async function inventory(root: string): Promise<readonly string[]> {
    const result: string[] = [];
    await visit("");
    return result.sort();
    async function visit(relative: string): Promise<void> {
        for (const entry of await readdir(path.join(root, relative), {
            withFileTypes: true,
        })) {
            const child = path.join(relative, entry.name);
            if (entry.isDirectory()) {
                await visit(child);
            } else {
                const hash = createHash("sha256");
                for await (const chunk of createReadStream(
                    path.join(root, child),
                ))
                    hash.update(chunk);
                result.push(
                    `${child.replace(/\\/g, "/")}:${hash.digest("hex")}`,
                );
            }
        }
    }
}
