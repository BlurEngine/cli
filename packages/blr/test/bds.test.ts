import assert from "node:assert/strict";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { ensureBds } from "../src/bds.js";
import { createTempDirectory } from "./helpers.js";

async function pathExists(targetPath: string): Promise<boolean> {
    try {
        await access(targetPath);
        return true;
    } catch {
        return false;
    }
}

test("ensureBds does not leave a versioned server directory behind after an invalid archive response", async (t) => {
    const projectRoot = await createTempDirectory(t, "blr-bds-invalid-");
    const version = "9.9.9.9";
    const serverDirectory = path.join(projectRoot, ".blr", "bds", version);
    const cacheZipPath = path.join(
        projectRoot,
        ".blr",
        "cache",
        "bds",
        `bedrock-server-${version}-win.zip`,
    );

    t.mock.method(
        globalThis,
        "fetch",
        async () =>
            new Response("<html>not a zip</html>", {
                status: 200,
                headers: {
                    "content-type": "text/html",
                },
            }),
    );

    await assert.rejects(
        ensureBds(
            projectRoot,
            {
                minecraft: {
                    channel: "stable",
                },
                dev: {
                    localServer: {
                        worldName: "Bedrock level",
                        worldSourcePath: "worlds/Bedrock level",
                        defaultPermissionLevel: "member",
                        gamemode: "survival",
                        allowlist: [],
                        operators: [],
                    },
                },
                world: {
                    backend: "local",
                },
            } as any,
            {
                localServer: {
                    bdsVersion: version,
                    platform: "win",
                    cacheDirectory: ".blr/cache/bds",
                    serverDirectory: `.blr/bds/${version}`,
                },
            } as any,
        ),
        /not a valid ZIP archive/i,
    );

    assert.equal(await pathExists(serverDirectory), false);
    assert.equal(await pathExists(cacheZipPath), false);
});

test("ensureBds applies server/bedrock_server.exe as a custom local-server override without downloading", async (t) => {
    const projectRoot = await createTempDirectory(t, "blr-bds-custom-");
    const version = "1.26.3.1";
    const runtimeServerDirectory = path.join(
        projectRoot,
        ".blr",
        "bds",
        version,
        "server",
    );
    const runtimeExecutablePath = path.join(
        runtimeServerDirectory,
        "bedrock_server.exe",
    );
    const customExecutablePath = path.join(
        projectRoot,
        "server",
        "bedrock_server.exe",
    );

    await mkdir(path.join(runtimeServerDirectory, "config", "default"), {
        recursive: true,
    });
    await writeFile(runtimeExecutablePath, "stock executable");
    await writeFile(
        path.join(runtimeServerDirectory, "server.properties"),
        "level-name=Bedrock level\n",
    );
    await mkdir(path.dirname(customExecutablePath), { recursive: true });
    await writeFile(customExecutablePath, "custom executable");

    t.mock.method(globalThis, "fetch", async () => {
        throw new Error("fetch should not be called");
    });

    const state = await ensureBds(
        projectRoot,
        {
            minecraft: {
                channel: "stable",
            },
            dev: {
                localServer: {
                    worldName: "Bedrock level",
                    worldSourcePath: "worlds/Bedrock level",
                    defaultPermissionLevel: "member",
                    gamemode: "survival",
                    allowlist: [],
                    operators: [],
                },
            },
            world: {
                backend: "local",
            },
        } as any,
        {
            localServer: {
                bdsVersion: version,
                platform: "win",
                cacheDirectory: ".blr/cache/bds",
                serverDirectory: `.blr/bds/${version}/server`,
            },
        } as any,
    );

    assert.equal(
        await readFile(runtimeExecutablePath, "utf8"),
        "custom executable",
    );
    assert.equal(state.customExecutableInjected, true);
    assert.equal(state.customExecutableSourcePath, customExecutablePath);
});
