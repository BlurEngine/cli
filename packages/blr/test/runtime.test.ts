import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { loadBlurConfig } from "../src/config.js";
import { buildProject } from "../src/runtime.js";
import { createTempDirectory, readJsonFile, writeJsonFile } from "./helpers.js";

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
        namespace: "bc_df",
        minecraft: {
            targetVersion: "1.26.11.1",
        },
    });
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
