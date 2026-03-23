import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createTempDirectory, readJsonFile, readTextFile } from "./helpers.js";

type SchemaShape = {
    $schema?: string;
    $id?: string;
    title?: string;
    description?: string;
    definitions?: Record<string, unknown>;
};

const packageRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
);
const packagedSchemaPath = path.join(
    packageRoot,
    "schema",
    "blr.config.schema.json",
);

test("generate-config-schema emits the packaged draft-07 schema with config descriptions", async (t) => {
    const workspace = await createTempDirectory(t, "blr-schema-");
    const outputPath = path.join(workspace, "blr.config.schema.json");
    const result = spawnSync(
        process.execPath,
        [path.join(packageRoot, "scripts", "generate-config-schema.mjs")],
        {
            cwd: packageRoot,
            encoding: "utf8",
            env: {
                ...process.env,
                BLR_CONFIG_SCHEMA_OUTPUT: outputPath,
            },
        },
    );

    assert.equal(result.status, 0, result.stderr);

    const schema = await readJsonFile<SchemaShape>(outputPath);
    const generatedText = await readTextFile(outputPath);
    const packagedText = await readTextFile(packagedSchemaPath);
    const definitions = schema.definitions as Record<string, any> | undefined;
    const rootDefinition = definitions?.BlurConfigFile;

    assert.equal(schema.$schema, "http://json-schema.org/draft-07/schema#");
    assert.equal(
        schema.$id,
        "https://blurengine.dev/schema/blr.config.schema.json",
    );
    assert.equal(schema.title, "BlurEngine Config");
    assert.equal(
        schema.description,
        "Project-level configuration for a BlurEngine Bedrock project.",
    );
    assert.equal(generatedText, packagedText);
    assert.equal(
        rootDefinition?.properties?.minecraft?.description,
        "Project-level Minecraft targeting defaults.",
    );
});
