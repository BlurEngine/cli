import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(scriptDirectory, "..");
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

function quoteWindowsArgument(argument) {
    if (!/[\s"]/u.test(argument)) {
        return argument;
    }

    return `"${argument
        .replace(/(\\*)"/g, '$1$1\\"')
        .replace(/(\\+)$/g, "$1$1")}"`;
}

function run(command, args, cwd) {
    const pathKey =
        process.platform === "win32"
            ? (Object.keys(process.env).find(
                  (key) => key.toLowerCase() === "path",
              ) ?? "Path")
            : "PATH";
    const envPath = process.env[pathKey] ?? process.env.PATH ?? "";
    const env = {
        ...process.env,
        [pathKey]: `${path.dirname(process.execPath)}${path.delimiter}${envPath}`,
    };

    const result =
        process.platform === "win32"
            ? spawnSync(
                  process.env.ComSpec ?? "cmd.exe",
                  [
                      "/d",
                      "/s",
                      "/c",
                      [
                          quoteWindowsArgument(command),
                          ...args.map(quoteWindowsArgument),
                      ].join(" "),
                  ],
                  {
                      cwd,
                      encoding: "utf8",
                      stdio: "pipe",
                      env,
                  },
              )
            : spawnSync(command, args, {
                  cwd,
                  encoding: "utf8",
                  stdio: "pipe",
                  env,
              });

    if (result.status !== 0 || result.error) {
        process.stdout.write(result.stdout ?? "");
        process.stderr.write(result.stderr ?? "");
        throw new Error(
            `Command failed (${result.status ?? "unknown"}): ${command} ${args.join(" ")}${result.error ? `\n${result.error.message}` : ""}`,
        );
    }

    return result.stdout ?? "";
}

function getPackedFilename(packOutput) {
    const lines = packOutput
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
    const filename = [...lines].reverse().find((line) => line.endsWith(".tgz"));
    assert.ok(
        filename,
        `Unable to determine packed tarball filename from output:\n${packOutput}`,
    );
    return filename;
}

function parsePackDryRunManifest(output) {
    const lines = output.split(/\r?\n/);
    const startIndex = lines.findIndex((line) => line.trim() === "[");
    const endIndex = lines.findIndex(
        (line, index) => index >= startIndex && line.trim() === "]",
    );

    assert.notEqual(
        startIndex,
        -1,
        `Unable to locate npm pack JSON output:\n${output}`,
    );
    assert.notEqual(
        endIndex,
        -1,
        `Unable to locate the end of npm pack JSON output:\n${output}`,
    );

    const jsonText = lines.slice(startIndex, endIndex + 1).join("\n");
    const parsed = JSON.parse(jsonText);
    assert.ok(
        Array.isArray(parsed) && parsed.length > 0,
        "npm pack JSON output was empty.",
    );
    return parsed[0];
}

async function rewriteGeneratedCliDependency(projectRoot, tarballPath) {
    const packageJsonPath = path.join(projectRoot, "package.json");
    const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
    const tarballSpecifier = `file:${tarballPath.replace(/\\/g, "/")}`;

    for (const dependencyField of [
        "dependencies",
        "devDependencies",
        "optionalDependencies",
    ]) {
        const dependencies = packageJson[dependencyField];
        if (
            dependencies &&
            typeof dependencies === "object" &&
            "@blurengine/cli" in dependencies
        ) {
            dependencies["@blurengine/cli"] = tarballSpecifier;
        }
    }

    await writeFile(
        packageJsonPath,
        `${JSON.stringify(packageJson, null, 2)}\n`,
        "utf8",
    );
}

async function main() {
    const dryRunOutput = run(
        npmCommand,
        ["pack", "--ignore-scripts", "--dry-run", "--json"],
        packageRoot,
    );
    const dryRunManifest = parsePackDryRunManifest(dryRunOutput);
    const packedFiles = new Set(
        dryRunManifest.files.map((entry) => entry.path),
    );
    assert.ok(
        packedFiles.has("LICENSE"),
        "Packed tarball must include LICENSE.",
    );
    assert.ok(packedFiles.has("NOTICE"), "Packed tarball must include NOTICE.");
    assert.ok(
        packedFiles.has("README.md"),
        "Packed tarball must include a package README.",
    );

    const smokeRoot = await mkdtemp(path.join(os.tmpdir(), "blr-pack-smoke-"));

    try {
        const packOutput = run(
            npmCommand,
            ["pack", "--ignore-scripts", "--pack-destination", smokeRoot],
            packageRoot,
        );
        const tarballFilename = getPackedFilename(packOutput);
        const tarballPath = path.join(smokeRoot, tarballFilename);

        run(npmCommand, ["init", "-y"], smokeRoot);
        run(npmCommand, ["install", tarballPath], smokeRoot);

        const installedCliEntry = path.join(
            smokeRoot,
            "node_modules",
            "@blurengine",
            "cli",
            "dist",
            "blr.js",
        );

        run(
            process.execPath,
            [
                installedCliEntry,
                "create",
                "smoke-project",
                "--namespace",
                "smoke_test",
                "--yes",
                "--no-install",
            ],
            smokeRoot,
        );

        const projectRoot = path.join(smokeRoot, "smoke-project");
        await rewriteGeneratedCliDependency(projectRoot, tarballPath);
        run(npmCommand, ["install"], projectRoot);
        run(npmCommand, ["run", "build"], projectRoot);

        const generatedPackage = JSON.parse(
            await readFile(path.join(projectRoot, "package.json"), "utf8"),
        );
        assert.equal(generatedPackage.name, "smoke-project");
    } finally {
        await rm(smokeRoot, { recursive: true, force: true });
    }
}

await main();
