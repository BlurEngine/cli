import assert from "node:assert/strict";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { build } from "esbuild";
import type { ResolvedWorldProcessorConfig } from "../src/world-processing.js";
import {
    publishWorldProcessorArtifactSet,
    type PublishWorldProcessorArtifactSetOptions,
} from "../src/world-processing/artifact-set.js";
import {
    canonicalJson,
    hashCanonicalJson,
} from "../src/world-processing/canonical-json.js";
import type { WorldProcessorExecutionResult } from "../src/world-processing/runner.js";
import { createTempDirectory } from "./helpers.js";

test("canonicalJson uses finite lexically ordered LF JSON and exact lowercase SHA-256", () => {
    assert.equal(
        canonicalJson({ z: -0, a: { b: 2, a: 1 } }),
        `{
  "a": {
    "a": 1,
    "b": 2
  },
  "z": 0
}\n`,
    );
    assert.equal(
        hashCanonicalJson({ z: -0, a: { b: 2, a: 1 } }),
        "efca8531df3b03b9474059758ded1f4d6bab28508e91390a4772a780f36be073",
    );
    assert.throws(() => canonicalJson({ bad: Number.NaN }), /non-finite/i);
    assert.throws(() => canonicalJson({ bad: undefined }), /undefined/i);
});

test("publishWorldProcessorArtifactSet writes immutable payloads, a detached manifest, and a Node-compatible pointer", async (t) => {
    const projectRoot = await createTempDirectory(t, "blr-artifact-set-");
    const options = createPublishOptions(projectRoot, 1);
    const missing = await publishWorldProcessorArtifactSet({
        ...options,
        mode: "check",
    });
    assert.equal(missing.status, "stale");
    await assert.rejects(
        () => readdir(path.join(projectRoot, "src/generated/train")),
        (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT",
    );
    const published = await publishWorldProcessorArtifactSet(options);
    assert.equal(published.status, "published");
    assert.match(published.artifactSetId, /^[a-f0-9]{64}$/);
    assert.match(published.manifestContentHash, /^[a-f0-9]{64}$/);

    const setDirectory = path.join(
        projectRoot,
        "src/generated/train/sets",
        published.artifactSetId,
    );
    const manifest = JSON.parse(
        await readFile(path.join(setDirectory, "manifest.json"), "utf8"),
    ) as { members: Array<{ id: string; fileName: string }> };
    assert.deepEqual(
        manifest.members.map((member) => member.id),
        ["path-pack", "route-pack"],
    );
    assert.equal(
        manifest.members.some((member) => member.fileName === "manifest.json"),
        false,
    );
    const pointerPath = path.join(
        projectRoot,
        "src/generated/train/current.generated.ts",
    );
    const pointer = await readFile(pointerPath, "utf8");
    assert.match(pointer, /with \{ type: "json" \}/);
    assert.match(pointer, new RegExp(published.artifactSetId));
    await build({
        entryPoints: [pointerPath],
        absWorkingDir: projectRoot,
        bundle: true,
        platform: "node",
        format: "esm",
        write: false,
        logLevel: "silent",
    });

    const checked = await publishWorldProcessorArtifactSet({
        ...options,
        mode: "check",
    });
    assert.equal(checked.status, "current");
    assert.deepEqual(
        (
            await readdir(path.join(projectRoot, "src/generated/train/sets"))
        ).sort(),
        [published.artifactSetId],
    );
});

test("publishWorldProcessorArtifactSet writes a canonical JSON runtime pointer outside source code", async (t) => {
    const projectRoot = await createTempDirectory(
        t,
        "blr-artifact-json-pointer-",
    );
    const base = createPublishOptions(projectRoot, 1);
    const pointerPath =
        "world-data/Bedrock level/generated/train/current.generated.json";
    const published = await publishWorldProcessorArtifactSet({
        ...base,
        config: {
            ...base.config,
            outputRoot: "world-data/Bedrock level/generated/train",
            runtimePointerPath: pointerPath,
        },
    });

    const pointerBytes = await readFile(
        path.join(projectRoot, pointerPath),
        "utf8",
    );
    const pointer = JSON.parse(pointerBytes) as {
        artifactSetId: string;
        members: Record<
            string,
            {
                contentHash: string;
                fileName: string;
                id: string;
                value: unknown;
            }
        >;
    };
    assert.equal(pointer.artifactSetId, published.artifactSetId);
    assert.deepEqual(pointer.members["path-pack"]?.value, {
        paths: [{ id: "main", points: [[0, 0, 1]] }],
        schemaVersion: 1,
    });
    assert.equal(
        pointerBytes,
        canonicalJson(pointer),
        "the JSON pointer must use BLR's canonical JSON contract",
    );

    const checked = await publishWorldProcessorArtifactSet({
        ...base,
        config: {
            ...base.config,
            outputRoot: "world-data/Bedrock level/generated/train",
            runtimePointerPath: pointerPath,
        },
        mode: "check",
    });
    assert.equal(checked.status, "current");
});

test("artifact publication rejects mismatched payloads and generic hash references", async (t) => {
    const projectRoot = await createTempDirectory(t, "blr-artifact-errors-");
    const base = createPublishOptions(projectRoot, 1);
    await assert.rejects(
        () =>
            publishWorldProcessorArtifactSet({
                ...base,
                execution: {
                    ...base.execution,
                    result: {
                        ...base.execution.result,
                        artifacts: base.execution.result.artifacts.slice(0, 1),
                    },
                },
            }),
        /must return exactly.*path-pack.*route-pack/i,
    );
    const route = base.execution.result.artifacts[1]!;
    await assert.rejects(
        () =>
            publishWorldProcessorArtifactSet({
                ...base,
                execution: {
                    ...base.execution,
                    result: {
                        ...base.execution.result,
                        artifacts: [
                            base.execution.result.artifacts[0]!,
                            {
                                ...route,
                                value: { pathContentHash: "wrong" },
                            },
                        ],
                    },
                },
            }),
        /hash reference.*pathContentHash.*does not match/i,
    );
});

test("failed or stale publication preserves the old coherent pointer and detects immutable-set corruption", async (t) => {
    const projectRoot = await createTempDirectory(t, "blr-artifact-atomic-");
    const firstOptions = createPublishOptions(projectRoot, 1);
    const first = await publishWorldProcessorArtifactSet(firstOptions);
    const pointerPath = path.join(
        projectRoot,
        "src/generated/train/current.generated.ts",
    );
    const oldPointer = await readFile(pointerPath, "utf8");

    await assert.rejects(
        () =>
            publishWorldProcessorArtifactSet({
                ...createPublishOptions(projectRoot, 2),
                hooks: {
                    beforePointerReplace: () => {
                        throw new Error("injected pointer failure");
                    },
                },
            }),
        /injected pointer failure/i,
    );
    assert.equal(await readFile(pointerPath, "utf8"), oldPointer);

    const stale = await publishWorldProcessorArtifactSet({
        ...createPublishOptions(projectRoot, 3),
        isCurrent: () => false,
    });
    assert.equal(stale.status, "stale");
    assert.equal(await readFile(pointerPath, "utf8"), oldPointer);

    const firstPath = path.join(
        projectRoot,
        "src/generated/train/sets",
        first.artifactSetId,
        "path-pack.json",
    );
    await writeFile(firstPath, "corrupt\n");
    await assert.rejects(
        () => publishWorldProcessorArtifactSet(firstOptions),
        /immutable artifact set.*does not match/i,
    );
});

function createPublishOptions(
    projectRoot: string,
    revision: number,
): PublishWorldProcessorArtifactSetOptions {
    const pathValue = {
        schemaVersion: 1,
        paths: [{ id: "main", points: [[0, 0, revision]] }],
    };
    const pathContentHash = hashCanonicalJson(pathValue);
    const execution: WorldProcessorExecutionResult = {
        processorId: "project-route",
        providerRevision: "train-route-v1",
        logicalInputHash: `logical-${revision}`,
        cacheHit: false,
        result: {
            logicalInputs: [],
            artifacts: [
                { id: "path-pack", value: pathValue },
                {
                    id: "route-pack",
                    value: { schemaVersion: 1, pathContentHash },
                    hashReferences: [
                        {
                            artifactId: "path-pack",
                            jsonPointer: "/pathContentHash",
                        },
                    ],
                },
            ],
            diagnostics: [],
            mutations: [],
        },
    };
    return {
        projectRoot,
        config: processorConfig(),
        execution,
        mode: "bake",
    };
}

function processorConfig(): ResolvedWorldProcessorConfig {
    return {
        id: "project-route",
        module: "./tooling/route/provider.ts",
        export: "createProvider",
        sourceWorld: "Bedrock level",
        capabilities: ["artifact"],
        dependsOn: [],
        inputPaths: [],
        outputRoot: "src/generated/train",
        payloadFileNames: {
            "path-pack": "path-pack.json",
            "route-pack": "route-pack.json",
        },
        runtimePointerPath: "src/generated/train/current.generated.ts",
        applyOn: {
            dev: true,
            build: true,
            package: true,
            check: true,
            worldBuild: true,
            worldPush: true,
        },
    };
}
