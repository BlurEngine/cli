import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createGenerator } from "ts-json-schema-generator";
import prettier from "prettier";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(scriptDirectory, "..");
const schemaDirectory = path.join(packageRoot, "schema");
const defaultSchemaPath = path.join(schemaDirectory, "blr.config.schema.json");
const schemaPath = process.env.BLR_CONFIG_SCHEMA_OUTPUT?.trim()
    ? path.resolve(process.env.BLR_CONFIG_SCHEMA_OUTPUT.trim())
    : defaultSchemaPath;
const typeName = "BlurConfigFile";

const generator = createGenerator({
    path: path.join(packageRoot, "src", "types.ts"),
    tsconfig: path.join(packageRoot, "tsconfig.json"),
    type: typeName,
    expose: "export",
    jsDoc: "extended",
    additionalProperties: false,
    skipTypeCheck: false,
});

// ts-json-schema-generator currently emits draft-07 schemas natively.
// Keep that output as-is unless we intentionally move to a generator or
// conversion pipeline that fully supports a newer draft end to end.
const schema = generator.createSchema(typeName);
schema.$id = "https://blurengine.dev/schema/blr.config.schema.json";
schema.title = "BlurEngine Config";
schema.description =
    "Project-level configuration for a BlurEngine Bedrock project.";

const formattedSchema = await prettier.format(
    `${JSON.stringify(schema, null, 2)}\n`,
    {
        filepath: schemaPath,
    },
);

await mkdir(schemaDirectory, { recursive: true });
await writeFile(schemaPath, formattedSchema, "utf8");
console.log(`[schema] Generated ${path.relative(packageRoot, schemaPath)}`);
