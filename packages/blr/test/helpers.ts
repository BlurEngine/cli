import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(testDirectory, "..");

export async function createTempDirectory(
    t: TestContext,
    prefix = "blr-test-",
): Promise<string> {
    const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
    t.after(async () => {
        const currentDirectory = path.resolve(process.cwd());
        const resolvedDirectory = path.resolve(directory);
        if (
            currentDirectory === resolvedDirectory ||
            currentDirectory.startsWith(`${resolvedDirectory}${path.sep}`)
        ) {
            process.chdir(os.tmpdir());
        }
        await rm(directory, { recursive: true, force: true });
    });
    return directory;
}

export async function copyFixtureProject(
    t: TestContext,
    fixtureName: string,
): Promise<string> {
    const root = await createTempDirectory(t, `blr-fixture-${fixtureName}-`);
    const source = path.join(testDirectory, "fixtures", fixtureName);
    const destination = path.join(root, fixtureName);
    await cp(source, destination, { recursive: true });
    return destination;
}

export async function readJsonFile<T>(targetPath: string): Promise<T> {
    return JSON.parse(await readFile(targetPath, "utf8")) as T;
}

export async function readTextFile(targetPath: string): Promise<string> {
    return readFile(targetPath, "utf8");
}

export async function writeJsonFile(
    targetPath: string,
    value: unknown,
): Promise<void> {
    await writeFile(targetPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function createJsonResponse(payload: unknown, status = 200): Response {
    return new Response(JSON.stringify(payload), {
        status,
        headers: {
            "content-type": "application/json",
        },
    });
}

export function createEmptyResponse(status = 200): Response {
    return new Response(null, { status });
}

export function assertDefined<T>(
    value: T | undefined,
    message: string,
): NonNullable<T> {
    assert.notEqual(value, undefined, message);
    return value as NonNullable<T>;
}

export function getBuiltCliEntry(): string {
    return path.join(packageRoot, "dist", "blr.js");
}

export function runBuiltCli(
    args: string[],
    cwd: string,
    options: {
        env?: NodeJS.ProcessEnv;
    } = {},
): SpawnSyncReturns<string> {
    const inheritedEnv = { ...process.env };
    delete inheritedEnv.INIT_CWD;

    return spawnSync(process.execPath, [getBuiltCliEntry(), ...args], {
        cwd,
        encoding: "utf8",
        env: {
            ...inheritedEnv,
            BLR_CREATE_SKIP_REMOTE_MINECRAFT_VERSION_LOOKUP: "1",
            ...options.env,
        },
    });
}
