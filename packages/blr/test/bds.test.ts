import assert from "node:assert/strict";
import { access } from "node:fs/promises";
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
