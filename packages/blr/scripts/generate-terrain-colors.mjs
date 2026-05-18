#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { format, resolveConfig } from "prettier";
import {
    createTerrainColorArtifacts,
    findBedrockSamplesDirectory,
    loadDotEnvLocal,
} from "./lib/terrain-color-generator.mjs";

const packageRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
);
const repoRoot = path.resolve(packageRoot, "..", "..");

const generatedDirectory = path.join(packageRoot, "src", "generated");
const outputFiles = {
    terrainColors: path.join(generatedDirectory, "bedrock-terrain-colors.ts"),
    biomeTints: path.join(generatedDirectory, "bedrock-biome-tints.ts"),
    paletteAudit: path.join(
        generatedDirectory,
        "bedrock-terrain-palette-audit.ts",
    ),
};

try {
    const options = parseArgs(process.argv.slice(2));
    const dotEnvLocal = await loadDotEnvLocal(repoRoot);
    const env = { ...dotEnvLocal, ...process.env };
    const bedrockSamplesRoot = await findBedrockSamplesDirectory({
        repoRoot,
        explicitPath: options.bedrockSamples,
        env,
    });
    const artifacts = await formatArtifacts(
        await createTerrainColorArtifacts({ bedrockSamplesRoot }),
    );

    if (options.check) {
        await checkGeneratedArtifacts(artifacts);
    } else {
        await writeGeneratedArtifacts(artifacts);
        console.log(
            `[terrain-colors] Generated Bedrock terrain colors from ${bedrockSamplesRoot}.`,
        );
    }
} catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
}

function parseArgs(args) {
    const options = {
        check: false,
        bedrockSamples: undefined,
    };

    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index];
        if (arg === "--check") {
            options.check = true;
            continue;
        }
        if (arg === "--bedrock-samples") {
            const value = args[index + 1];
            if (!value || value.startsWith("--")) {
                throw new Error("Missing value for --bedrock-samples.");
            }
            options.bedrockSamples = value;
            index += 1;
            continue;
        }
        throw new Error(`Unknown argument: ${arg}`);
    }

    return options;
}

async function writeGeneratedArtifacts(artifacts) {
    await mkdir(generatedDirectory, { recursive: true });
    await writeFile(outputFiles.terrainColors, artifacts.terrainColors);
    await writeFile(outputFiles.biomeTints, artifacts.biomeTints);
    await writeFile(outputFiles.paletteAudit, artifacts.paletteAudit);
}

async function formatArtifacts(artifacts) {
    return {
        terrainColors: await formatGeneratedSource(
            artifacts.terrainColors,
            outputFiles.terrainColors,
        ),
        biomeTints: await formatGeneratedSource(
            artifacts.biomeTints,
            outputFiles.biomeTints,
        ),
        paletteAudit: await formatGeneratedSource(
            artifacts.paletteAudit,
            outputFiles.paletteAudit,
        ),
    };
}

async function formatGeneratedSource(source, filePath) {
    return format(source, {
        ...((await resolveConfig(filePath)) ?? {}),
        filepath: filePath,
        parser: "typescript",
    });
}

async function checkGeneratedArtifacts(artifacts) {
    const mismatches = [];
    await assertGeneratedFileCurrent(
        outputFiles.terrainColors,
        artifacts.terrainColors,
        mismatches,
    );
    await assertGeneratedFileCurrent(
        outputFiles.biomeTints,
        artifacts.biomeTints,
        mismatches,
    );
    await assertGeneratedFileCurrent(
        outputFiles.paletteAudit,
        artifacts.paletteAudit,
        mismatches,
    );

    if (mismatches.length > 0) {
        throw new Error(
            [
                "Generated terrain color artifacts are out of date.",
                "Run npm run generate:terrain-colors.",
                `Changed files: ${mismatches.join(", ")}`,
            ].join(" "),
        );
    }

    console.log(
        "[terrain-colors] Generated Bedrock terrain colors are current.",
    );
}

async function assertGeneratedFileCurrent(filePath, expected, mismatches) {
    let actual;
    try {
        actual = await readFile(filePath, "utf8");
    } catch {
        mismatches.push(path.relative(repoRoot, filePath));
        return;
    }

    if (actual !== expected) {
        mismatches.push(path.relative(repoRoot, filePath));
    }
}
