import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import type { ResolvedWorldProcessorConfig } from "../src/world-processing.js";
import { buildProcessedWorld } from "../src/world-processing/processor-build.js";
import { withBedrockWorldObservations } from "../src/world-processing/observation-facade.js";
import { withVerifiedWorldSnapshot } from "../src/world-processing/world-snapshot.js";
import {
    createBedrockHeightmapDb,
    createBedrockTerrainDb,
} from "./world-image-helpers.js";
import { createTempDirectory } from "./helpers.js";

test("buildProcessedWorld publishes a content-addressed world and check is project-read-only", async (t) => {
    const projectRoot = await createTempDirectory(t, "blr-processed-world-");
    const worldName = "Bedrock level";
    const sourceWorldDirectory = path.join(projectRoot, "worlds", worldName);
    await createFixtureWorld(sourceWorldDirectory);
    await mkdir(path.join(projectRoot, "tooling"), { recursive: true });
    const providerPath = path.join(projectRoot, "tooling", "processor.ts");
    await writeFile(providerPath, processorSource("minecraft:gold_block"));
    const config = processorConfig({
        auditOutputPath: "planning/fixture.audit.json",
    });
    const sourceBefore = await inventory(sourceWorldDirectory);

    const built = await buildProcessedWorld({
        projectRoot,
        worldName,
        sourceWorldDirectory,
        configs: [config],
        mode: "bake",
        audit: true,
        signal: new AbortController().signal,
    });
    assert.equal(built.status, "built");
    assert.match(built.worldBuildId, /^[a-f0-9]{64}$/);
    assert.equal(
        await stat(built.worldDirectory).then((item) => item.isDirectory()),
        true,
    );
    assert.deepEqual(await inventory(sourceWorldDirectory), sourceBefore);
    assert.equal(await blockType(built.worldDirectory), "minecraft:gold_block");
    assert.equal(
        JSON.parse(await readFile(built.pointerPath, "utf8")).worldBuildId,
        built.worldBuildId,
    );
    assert.equal(
        JSON.parse(
            await readFile(
                path.join(built.setDirectory, "manifest.json"),
                "utf8",
            ),
        ).mutationPlanHash,
        built.mutationPlanHash,
    );
    assert.deepEqual(
        JSON.parse(
            await readFile(
                path.join(projectRoot, "planning", "fixture.audit.json"),
                "utf8",
            ),
        ).audit,
        { observedTypeId: "minecraft:stone" },
    );

    const projectBeforeCheck = await inventory(projectRoot);
    const checked = await buildProcessedWorld({
        projectRoot,
        worldName,
        sourceWorldDirectory,
        configs: [config],
        mode: "check",
        signal: new AbortController().signal,
    });
    assert.equal(checked.status, "current");
    assert.equal(checked.worldBuildId, built.worldBuildId);
    assert.deepEqual(await inventory(projectRoot), projectBeforeCheck);

    await writeFile(providerPath, processorSource("minecraft:diamond_block"));
    const stale = await buildProcessedWorld({
        projectRoot,
        worldName,
        sourceWorldDirectory,
        configs: [config],
        mode: "check",
        signal: new AbortController().signal,
    });
    assert.equal(stale.status, "stale");
    assert.deepEqual(await inventory(sourceWorldDirectory), sourceBefore);
});

test("buildProcessedWorld writes configured audits for transform-only processors", async (t) => {
    const projectRoot = await createTempDirectory(t, "blr-transform-audit-");
    const worldName = "Bedrock level";
    const sourceWorldDirectory = path.join(projectRoot, "worlds", worldName);
    await createFixtureWorld(sourceWorldDirectory);
    await mkdir(path.join(projectRoot, "tooling"), { recursive: true });
    await writeFile(
        path.join(projectRoot, "tooling", "processor.ts"),
        transformOnlySource(),
    );
    const auditOutputPath = "planning/transform.audit.json";

    await buildProcessedWorld({
        projectRoot,
        worldName,
        sourceWorldDirectory,
        configs: [
            processorConfig({
                capabilities: ["transform"],
                auditOutputPath,
            }),
        ],
        mode: "bake",
        audit: true,
        signal: new AbortController().signal,
    });

    assert.deepEqual(
        JSON.parse(
            await readFile(path.join(projectRoot, auditOutputPath), "utf8"),
        ).audit,
        { kind: "transform-only" },
    );
});

test("buildProcessedWorld narrows processors, copies an explicit output, and rejects unsafe or invalid builds", async (t) => {
    const projectRoot = await createTempDirectory(t, "blr-processed-options-");
    const worldName = "Bedrock level";
    const sourceWorldDirectory = path.join(projectRoot, "worlds", worldName);
    await createFixtureWorld(sourceWorldDirectory);
    await mkdir(path.join(projectRoot, "tooling"), { recursive: true });
    await writeFile(
        path.join(projectRoot, "tooling", "processor.ts"),
        processorSource("minecraft:gold_block"),
    );
    await writeFile(
        path.join(projectRoot, "tooling", "unused.ts"),
        artifactOnlySource(),
    );
    const explicitOutput = path.join(projectRoot, "dist", "processed-world");
    const selected = await buildProcessedWorld({
        projectRoot,
        worldName,
        sourceWorldDirectory,
        configs: [
            processorConfig(),
            processorConfig({
                id: "unused",
                module: "./tooling/unused.ts",
                capabilities: ["artifact"],
                outputRoot: "src/generated/unused",
                runtimePointerPath: "src/generated/unused/current.generated.ts",
            }),
        ],
        processorIds: ["fixture"],
        outputDirectory: explicitOutput,
        mode: "bake",
        signal: new AbortController().signal,
    });
    assert.deepEqual(selected.processorIds, ["fixture"]);
    assert.equal(await blockType(explicitOutput), "minecraft:gold_block");
    await assert.rejects(
        () =>
            buildProcessedWorld({
                projectRoot,
                worldName,
                sourceWorldDirectory,
                configs: [],
                mode: "check",
                signal: new AbortController().signal,
            }),
        /no world processors/i,
    );
    await assert.rejects(
        () =>
            buildProcessedWorld({
                projectRoot,
                worldName,
                sourceWorldDirectory,
                configs: [processorConfig()],
                processorIds: ["missing"],
                mode: "check",
                signal: new AbortController().signal,
            }),
        /unknown world processor missing/i,
    );
    await assert.rejects(
        () =>
            buildProcessedWorld({
                projectRoot,
                worldName,
                sourceWorldDirectory,
                configs: [processorConfig()],
                outputDirectory: sourceWorldDirectory,
                mode: "bake",
                signal: new AbortController().signal,
            }),
        /authored source/i,
    );
});

async function createFixtureWorld(worldDirectory: string): Promise<void> {
    await mkdir(worldDirectory, { recursive: true });
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

function processorConfig(
    overrides: Partial<ResolvedWorldProcessorConfig> = {},
): ResolvedWorldProcessorConfig {
    return {
        id: "fixture",
        module: "./tooling/processor.ts",
        export: "createProcessor",
        sourceWorld: "Bedrock level",
        capabilities: ["artifact", "transform"],
        dependsOn: [],
        inputPaths: [],
        outputRoot: "src/generated/fixture",
        payloadFileNames: { result: "result.json" },
        runtimePointerPath: "src/generated/fixture/current.generated.ts",
        applyOn: {
            dev: true,
            build: true,
            package: true,
            check: true,
            worldBuild: true,
            worldPush: true,
        },
        ...overrides,
    };
}

function processorSource(replacementTypeId: string): string {
    return `
export function createProcessor() {
  return {
    implementationRevision: "fixture-v1",
    logicalInputs: [],
    async run(input) {
      let observed;
      for await (const block of input.observations.blocks({
        dimension: "overworld",
        bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } },
        includeAir: true
      })) {
        if (block.layer === 0) observed = block;
      }
      if (!observed) throw new Error("fixture block missing");
      return {
        logicalInputs: input.logicalInputs,
        artifacts: [{ id: "result", value: { source: observed.palette.typeId } }],
        audit: { observedTypeId: observed.palette.typeId },
        diagnostics: [],
        mutations: [{
          kind: "set-block",
          opId: "replace",
          dimension: "overworld",
          location: { x: 0, y: 0, z: 0 },
          layer: 0,
          expectedPalette: observed.palette,
          replacement: {
            kind: "literal",
            palette: { typeId: ${JSON.stringify(replacementTypeId)}, states: {}, version: observed.palette.version }
          },
          blockEntityPolicy: "require-absent"
        }]
      };
    }
  };
}
`;
}

function artifactOnlySource(): string {
    return `
export function createProcessor() {
  return {
    implementationRevision: "unused-v1",
    logicalInputs: [],
    async run(input) {
      return { logicalInputs: input.logicalInputs, artifacts: [{ id: "result", value: true }], diagnostics: [], mutations: [] };
    }
  };
}
`;
}

function transformOnlySource(): string {
    return `
export function createProcessor() {
  return {
    implementationRevision: "transform-v1",
    logicalInputs: [],
    async run(input) {
      return {
        logicalInputs: input.logicalInputs,
        artifacts: [],
        audit: { kind: "transform-only" },
        diagnostics: [],
        mutations: []
      };
    }
  };
}
`;
}

async function blockType(worldDirectory: string): Promise<string | undefined> {
    return withVerifiedWorldSnapshot(
        {
            worldName: "fixture",
            sourceWorldDirectory: worldDirectory,
        },
        async (snapshot) => {
            let typeId: string | undefined;
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
                            typeId = observation.palette.typeId;
                    }
                },
            );
            return typeId;
        },
    );
}

async function inventory(root: string): Promise<readonly string[]> {
    const result: string[] = [];
    await visit("");
    return result.sort();

    async function visit(relativeDirectory: string): Promise<void> {
        for (const entry of await readdir(path.join(root, relativeDirectory), {
            withFileTypes: true,
        })) {
            const relativePath = path
                .join(relativeDirectory, entry.name)
                .replace(/\\/g, "/");
            if (entry.isDirectory()) {
                await visit(relativePath);
            } else {
                const hash = createHash("sha256");
                for await (const chunk of createReadStream(
                    path.join(root, relativePath),
                )) {
                    hash.update(chunk);
                }
                result.push(`${relativePath}:${hash.digest("hex")}`);
            }
        }
    }
}
