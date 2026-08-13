import { createHash, randomUUID } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import type {
    WorldProcessor,
    WorldProcessorDeclaredLogicalInput,
} from "../world-processing.js";

export type LoadedWorldProcessorInput = {
    readonly relativePath: string;
    readonly contentHash: string;
};

export type LoadedWorldProcessorProvider = {
    readonly processor: WorldProcessor;
    readonly bundleHash: string;
    readonly providerContentHash: string;
    readonly localInputs: readonly LoadedWorldProcessorInput[];
};

export type LoadWorldProcessorProviderOptions = {
    readonly projectRoot: string;
    readonly module: string;
    readonly exportName: string;
};

export async function loadWorldProcessorProvider(
    options: LoadWorldProcessorProviderOptions,
): Promise<LoadedWorldProcessorProvider> {
    const entryPath = resolveProviderModule(options);
    const bundle = await build({
        entryPoints: [entryPath],
        absWorkingDir: options.projectRoot,
        bundle: true,
        platform: "node",
        format: "esm",
        target: "node22",
        write: false,
        metafile: true,
        logLevel: "silent",
        sourcemap: false,
    });
    const output = bundle.outputFiles?.[0];
    if (!output) {
        throw new Error(
            `World processor ${options.module} produced no bundle.`,
        );
    }
    const bundleBytes = Buffer.from(output.contents);
    const bundleHash = sha256(bundleBytes);
    const localInputs = await collectLocalInputs(
        options.projectRoot,
        bundle.metafile?.inputs ?? {},
    );
    const providerContentHash = sha256(
        Buffer.from(JSON.stringify({ bundleHash, localInputs })),
    );

    const tempFile = path.join(
        os.tmpdir(),
        `blr-world-processor-${bundleHash}-${randomUUID()}.mjs`,
    );
    try {
        await writeFile(tempFile, bundleBytes, { flag: "wx" });
        const moduleValue = (await import(
            `${pathToFileURL(tempFile).href}?run=${randomUUID()}`
        )) as Record<string, unknown>;
        const factory = moduleValue[options.exportName];
        if (factory === undefined) {
            throw new Error(
                `World processor module ${options.module} does not export ${options.exportName}.`,
            );
        }
        if (typeof factory !== "function") {
            throw new Error(
                `World processor export ${options.exportName} must be a function.`,
            );
        }
        const processor = (factory as () => unknown)();
        assertProcessor(processor, options);
        return Object.freeze({
            processor,
            bundleHash,
            providerContentHash,
            localInputs: Object.freeze(localInputs),
        });
    } finally {
        await rm(tempFile, { force: true });
    }
}

function resolveProviderModule(
    options: LoadWorldProcessorProviderOptions,
): string {
    if (options.module.startsWith("./")) {
        return path.resolve(options.projectRoot, options.module.slice(2));
    }
    const require = createRequire(
        path.join(options.projectRoot, "package.json"),
    );
    return require.resolve(options.module);
}

async function collectLocalInputs(
    projectRoot: string,
    inputs: Record<string, unknown>,
): Promise<LoadedWorldProcessorInput[]> {
    const result: LoadedWorldProcessorInput[] = [];
    for (const inputPath of Object.keys(inputs).sort()) {
        if (inputPath.startsWith("<")) continue;
        const absolutePath = path.isAbsolute(inputPath)
            ? inputPath
            : path.resolve(projectRoot, inputPath);
        const bytes = await readFile(absolutePath);
        result.push(
            Object.freeze({
                relativePath: path
                    .relative(projectRoot, absolutePath)
                    .replace(/\\/g, "/"),
                contentHash: sha256(bytes),
            }),
        );
    }
    return result;
}

function assertProcessor(
    input: unknown,
    options: LoadWorldProcessorProviderOptions,
): asserts input is WorldProcessor {
    if (!input || typeof input !== "object") {
        throw new Error(
            `World processor factory ${options.exportName} must return an object.`,
        );
    }
    const record = input as Record<string, unknown>;
    if (
        typeof record.implementationRevision !== "string" ||
        record.implementationRevision.trim().length === 0
    ) {
        throw new Error(
            `World processor implementationRevision must be a non-empty string.`,
        );
    }
    if (!Array.isArray(record.logicalInputs)) {
        throw new Error(`World processor logicalInputs must be an array.`);
    }
    if (typeof record.run !== "function") {
        throw new Error(`World processor run must be a function.`);
    }
    validateDeclaredInputs(record.logicalInputs);
}

function validateDeclaredInputs(
    inputs: readonly WorldProcessorDeclaredLogicalInput[],
): void {
    const ids = new Set<string>();
    for (const [index, input] of inputs.entries()) {
        if (!input || typeof input !== "object") {
            throw new Error(
                `World processor logicalInputs[${index}] is invalid.`,
            );
        }
        if (typeof input.id !== "string" || input.id.length === 0) {
            throw new Error(
                `World processor logicalInputs[${index}].id must be non-empty.`,
            );
        }
        if (ids.has(input.id)) {
            throw new Error(
                `Duplicate world processor logical input ${input.id}.`,
            );
        }
        ids.add(input.id);
        if (input.kind === "value") {
            if (typeof input.value !== "string") {
                throw new Error(
                    `Logical value input ${input.id} must be a string.`,
                );
            }
        } else if (input.kind === "file") {
            if (typeof input.path !== "string" || input.path.length === 0) {
                throw new Error(
                    `Logical file input ${input.id} must name a path.`,
                );
            }
        } else {
            throw new Error(
                `World processor logicalInputs[${index}] has an unsupported kind.`,
            );
        }
    }
}

function sha256(input: Uint8Array): string {
    return createHash("sha256").update(input).digest("hex");
}
