import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
    loadWorldProcessorProvider,
    type LoadedWorldProcessorProvider,
} from "../src/world-processing/provider-loader.js";
import { createTempDirectory } from "./helpers.js";

test("loadWorldProcessorProvider bundles trusted project TypeScript and its local graph", async (t) => {
    const projectRoot = await createTempDirectory(t, "blr-provider-");
    await mkdir(path.join(projectRoot, "tooling"), { recursive: true });
    await writeFile(
        path.join(projectRoot, "tooling", "value.ts"),
        `export const value = "first";\n`,
    );
    await writeFile(
        path.join(projectRoot, "tooling", "provider.ts"),
        providerSource("createProvider"),
    );

    const first = await load(projectRoot, "createProvider");
    assert.equal(first.processor.implementationRevision, "provider-v1");
    assert.deepEqual(first.processor.logicalInputs, [
        { id: "solver", kind: "value", value: "solver-v1" },
    ]);
    assert.match(first.bundleHash, /^[a-f0-9]{64}$/);
    assert.match(first.providerContentHash, /^[a-f0-9]{64}$/);
    assert.ok(
        first.localInputs.some((entry) =>
            entry.relativePath.endsWith("tooling/provider.ts"),
        ),
    );
    assert.ok(
        first.localInputs.some((entry) =>
            entry.relativePath.endsWith("tooling/value.ts"),
        ),
    );

    await writeFile(
        path.join(projectRoot, "tooling", "value.ts"),
        `export const value = "second";\n`,
    );
    const second = await load(projectRoot, "createProvider");
    assert.notEqual(second.bundleHash, first.bundleHash);
    assert.notEqual(second.providerContentHash, first.providerContentHash);
});

test("loadWorldProcessorProvider rejects missing exports and invalid contracts", async (t) => {
    const projectRoot = await createTempDirectory(t, "blr-provider-errors-");
    await writeFile(
        path.join(projectRoot, "provider.ts"),
        `export const notAFactory = 1;\n`,
    );
    await assert.rejects(
        () => load(projectRoot, "missing"),
        /does not export.*missing/i,
    );
    await assert.rejects(
        () => load(projectRoot, "notAFactory"),
        /must be a function/i,
    );

    await writeFile(
        path.join(projectRoot, "provider.ts"),
        `export function invalid() { return { implementationRevision: "", logicalInputs: [], run: 1 }; }\n`,
    );
    await assert.rejects(
        () => load(projectRoot, "invalid"),
        /implementationRevision.*non-empty/i,
    );
});

async function load(
    projectRoot: string,
    exportName: string,
): Promise<LoadedWorldProcessorProvider> {
    return loadWorldProcessorProvider({
        projectRoot,
        module: "./tooling/provider.ts".replace(
            "tooling/provider.ts",
            (await fileExists(path.join(projectRoot, "tooling", "provider.ts")))
                ? "tooling/provider.ts"
                : "provider.ts",
        ),
        exportName,
    });
}

async function fileExists(filePath: string): Promise<boolean> {
    try {
        await import("node:fs/promises").then(({ stat }) => stat(filePath));
        return true;
    } catch {
        return false;
    }
}

function providerSource(exportName: string): string {
    return `
import { value } from "./value.js";
export function ${exportName}() {
  return {
    implementationRevision: "provider-v1",
    logicalInputs: [{ id: "solver", kind: "value", value: "solver-v1" }],
    async run(input) {
      return {
        logicalInputs: input.logicalInputs,
        artifacts: [{ id: "value", value }],
        diagnostics: [],
        mutations: []
      };
    }
  };
}
`;
}
