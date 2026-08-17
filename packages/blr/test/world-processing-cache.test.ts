import assert from "node:assert/strict";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import type {
    ResolvedWorldProcessorConfig,
    WorldObservationFacade,
} from "../src/world-processing.js";
import { runWorldProcessorGraph } from "../src/world-processing/runner.js";
import { createTempDirectory } from "./helpers.js";

const emptyObservations: WorldObservationFacade = {
    async *blocks() {},
    async *signs() {},
};

test("runWorldProcessorGraph caches by complete logical identity and check mode stays read-only", async (t) => {
    const projectRoot = await createTempDirectory(t, "blr-runner-cache-");
    await mkdir(path.join(projectRoot, "tooling"), { recursive: true });
    await writeFile(path.join(projectRoot, "input.json"), `{"value":1}\n`);
    await writeFile(
        path.join(projectRoot, "tooling", "provider.ts"),
        countingProviderSource(),
    );
    const config = processorConfig({
        id: "counter",
        inputPaths: ["input.json"],
    });
    const cacheRoot = path.join(projectRoot, ".blr", "cache");
    const base = {
        projectRoot,
        configs: [config],
        sourceIdentity: {
            worldName: "Bedrock level",
            contentHash: "world-one",
        },
        observations: emptyObservations,
        pipeline: "build" as const,
        signal: new AbortController().signal,
        cacheRoot,
    };

    const first = await runWorldProcessorGraph({ ...base, mode: "bake" });
    const [cacheFile] = await readdir(
        path.join(cacheRoot, "world-processing", "counter"),
    );
    assert.ok(cacheFile);
    await writeFile(
        path.join(cacheRoot, "world-processing", "counter", cacheFile),
        "{corrupt",
    );
    const recovered = await runWorldProcessorGraph({ ...base, mode: "bake" });
    const second = await runWorldProcessorGraph({ ...base, mode: "bake" });
    assert.equal(first[0]?.cacheHit, false);
    assert.equal(recovered[0]?.cacheHit, false);
    assert.equal(second[0]?.cacheHit, true);
    assert.deepEqual(recovered[0]?.result, second[0]?.result);
    assert.equal(first[0]?.result.artifacts[0]?.value, 1);
    assert.equal(recovered[0]?.result.artifacts[0]?.value, 2);

    await writeFile(path.join(projectRoot, "input.json"), `{"value":2}\n`);
    const changedInput = await runWorldProcessorGraph({
        ...base,
        mode: "bake",
    });
    assert.equal(changedInput[0]?.cacheHit, false);
    assert.equal(changedInput[0]?.result.artifacts[0]?.value, 3);

    const checkRoot = path.join(projectRoot, "check-cache");
    const checked = await runWorldProcessorGraph({
        ...base,
        sourceIdentity: {
            worldName: "Bedrock level",
            contentHash: "world-two",
        },
        cacheRoot: checkRoot,
        mode: "check",
    });
    assert.equal(checked[0]?.cacheHit, false);
    assert.equal(await directoryIsEmpty(checkRoot), true);
});

test("processor outputs and logical identity are independent of the invoking pipeline", async (t) => {
    const projectRoot = await createTempDirectory(t, "blr-runner-pipeline-");
    await mkdir(path.join(projectRoot, "tooling"), { recursive: true });
    await writeFile(
        path.join(projectRoot, "tooling", "provider.ts"),
        pipelineIndependentProviderSource(),
    );
    const config = processorConfig({ id: "portable" });
    const base = {
        projectRoot,
        configs: [config],
        sourceIdentity: {
            worldName: "Bedrock level",
            contentHash: "world",
        },
        observations: emptyObservations,
        mode: "bake" as const,
        signal: new AbortController().signal,
        cacheRoot: path.join(projectRoot, ".blr", "cache"),
    };

    const built = await runWorldProcessorGraph({
        ...base,
        pipeline: "build",
    });
    const worldBuilt = await runWorldProcessorGraph({
        ...base,
        pipeline: "world-build",
    });

    assert.equal(worldBuilt[0]?.cacheHit, true);
    assert.equal(worldBuilt[0]?.logicalInputHash, built[0]?.logicalInputHash);
    assert.deepEqual(built[0]?.result.artifacts[0]?.value, [
        "config",
        "dependencies",
        "inputFiles",
        "logicalInputs",
        "observations",
        "signal",
        "sourceIdentity",
    ]);
});

test("runWorldProcessorGraph orders dependencies canonically and supplies their results", async (t) => {
    const projectRoot = await createTempDirectory(t, "blr-runner-graph-");
    await mkdir(path.join(projectRoot, "tooling"), { recursive: true });
    await writeFile(
        path.join(projectRoot, "tooling", "provider.ts"),
        graphProviderSource(),
    );
    const configs = [
        processorConfig({ id: "second", dependsOn: ["first"] }),
        processorConfig({ id: "first" }),
    ];
    const results = await runWorldProcessorGraph({
        projectRoot,
        configs,
        sourceIdentity: {
            worldName: "Bedrock level",
            contentHash: "world",
        },
        observations: emptyObservations,
        pipeline: "build",
        mode: "check",
        signal: new AbortController().signal,
        cacheRoot: path.join(projectRoot, ".cache"),
    });
    assert.deepEqual(
        results.map((result) => result.processorId),
        ["first", "second"],
    );
    assert.deepEqual(results[1]?.result.artifacts[0]?.value, ["first"]);
});

test("runWorldProcessorGraph rejects dynamic logical inputs, cycles, corrupt cache, and cancellation", async (t) => {
    const projectRoot = await createTempDirectory(t, "blr-runner-errors-");
    await mkdir(path.join(projectRoot, "tooling"), { recursive: true });
    await writeFile(
        path.join(projectRoot, "tooling", "provider.ts"),
        invalidLogicalInputProviderSource(),
    );
    const config = processorConfig({ id: "invalid" });
    const common = {
        projectRoot,
        sourceIdentity: {
            worldName: "Bedrock level",
            contentHash: "world",
        },
        observations: emptyObservations,
        pipeline: "build" as const,
        mode: "bake" as const,
        cacheRoot: path.join(projectRoot, ".cache"),
    };
    await assert.rejects(
        () =>
            runWorldProcessorGraph({
                ...common,
                configs: [config],
                signal: new AbortController().signal,
            }),
        /result logicalInputs must exactly echo/i,
    );

    await assert.rejects(
        () =>
            runWorldProcessorGraph({
                ...common,
                configs: [
                    processorConfig({ id: "a", dependsOn: ["b"] }),
                    processorConfig({ id: "b", dependsOn: ["a"] }),
                ],
                signal: new AbortController().signal,
            }),
        /dependency cycle/i,
    );

    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
        () =>
            runWorldProcessorGraph({
                ...common,
                configs: [config],
                signal: controller.signal,
            }),
        /aborted/i,
    );
});

function processorConfig(
    overrides: Partial<ResolvedWorldProcessorConfig> & { id: string },
): ResolvedWorldProcessorConfig {
    const { id, ...rest } = overrides;
    return {
        id,
        module: "./tooling/provider.ts",
        export: "createProcessor",
        sourceWorld: "Bedrock level",
        capabilities: ["artifact"],
        dependsOn: [],
        inputPaths: [],
        outputRoot: "src/generated/test",
        payloadFileNames: { result: "result.json" },
        runtimePointerPath: "src/generated/test/current.generated.ts",
        applyOn: {
            dev: true,
            build: true,
            package: true,
            check: true,
            worldBuild: true,
            worldPush: true,
        },
        ...rest,
    };
}

function countingProviderSource(): string {
    return `
const state = globalThis;
export function createProcessor() {
  return {
    implementationRevision: "counter-v1",
    logicalInputs: [{ id: "input", kind: "file", path: "input.json" }],
    async run(input) {
      state.__blrCounter = (state.__blrCounter ?? 0) + 1;
      return {
        logicalInputs: input.logicalInputs,
        artifacts: [{ id: "result", value: state.__blrCounter }],
        diagnostics: [],
        mutations: []
      };
    }
  };
}
`;
}

function graphProviderSource(): string {
    return `
export function createProcessor() {
  return {
    implementationRevision: "graph-v1",
    logicalInputs: [],
    async run(input) {
      return {
        logicalInputs: input.logicalInputs,
        artifacts: [{ id: "result", value: Object.keys(input.dependencies) }],
        diagnostics: [],
        mutations: []
      };
    }
  };
}
`;
}

function invalidLogicalInputProviderSource(): string {
    return `
export function createProcessor() {
  return {
    implementationRevision: "invalid-v1",
    logicalInputs: [],
    async run(input) {
      return {
        logicalInputs: [...input.logicalInputs, { id: "dynamic", kind: "value", contentHash: "bad" }],
        artifacts: [], diagnostics: [], mutations: []
      };
    }
  };
}
`;
}

function pipelineIndependentProviderSource(): string {
    return `
export function createProcessor() {
  return {
    implementationRevision: "portable-v1",
    logicalInputs: [],
    async run(input) {
      return {
        logicalInputs: input.logicalInputs,
        artifacts: [{ id: "result", value: Object.keys(input).sort() }],
        diagnostics: [],
        mutations: []
      };
    }
  };
}
`;
}

async function directoryIsEmpty(directory: string): Promise<boolean> {
    try {
        return (await readdir(directory)).length === 0;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === "ENOENT";
    }
}
