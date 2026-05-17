import assert from "node:assert/strict";
import {
    access,
    mkdir,
    readFile,
    rename as renamePath,
    rm,
    writeFile,
} from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import AdmZip from "adm-zip";
import {
    BdsPtyOutputFilter,
    BdsScriptingLogCompactor,
    backupRuntimeWorldForBdsStartup,
    bootstrapProjectWorldSourceFromBds,
    captureAllowlistFromBds,
    capturePermissionsFromBds,
    ensureBds,
    prefetchBdsArchive,
    replaceBdsServerDirectory,
    resolveBdsOutputRelayMode,
} from "../src/bds.js";
import { createTempDirectory } from "./helpers.js";

async function pathExists(targetPath: string): Promise<boolean> {
    try {
        await access(targetPath);
        return true;
    } catch {
        return false;
    }
}

test("BdsScriptingLogCompactor removes blank lines immediately after scripting logs", () => {
    const compactor = new BdsScriptingLogCompactor();
    const output =
        compactor.write(
            [
                "[2026-05-11 20:15:38:587 INFO] [Scripting] spawn minecraft:xp_orb Spawned []\n",
                "\n",
                "[2026-05-11 20:15:38:587 INFO] Server started.\n",
                "\n",
            ].join(""),
        ) + compactor.end();

    assert.equal(
        output,
        [
            "[2026-05-11 20:15:38:587 INFO] [Scripting] spawn minecraft:xp_orb Spawned []\n",
            "[2026-05-11 20:15:38:587 INFO] Server started.\n",
            "\n",
        ].join(""),
    );
});

test("BdsScriptingLogCompactor handles chunk boundaries and preserves non-scripting spacing", () => {
    const compactor = new BdsScriptingLogCompactor();
    const output =
        compactor.write(
            "[2026-05-11 20:15:38:587 INFO] [Scripting] itemStart",
        ) +
        compactor.write("Use minecraft:fishing_rod SupaaaaaaHam 0\r\n\r\n") +
        compactor.write(
            "[2026-05-11 20:15:38:588 INFO] Player connected\r\n\r\n",
        ) +
        compactor.end();

    assert.equal(
        output,
        [
            "[2026-05-11 20:15:38:587 INFO] [Scripting] itemStartUse minecraft:fishing_rod SupaaaaaaHam 0\r\n",
            "[2026-05-11 20:15:38:588 INFO] Player connected\r\n",
            "\r\n",
        ].join(""),
    );
});

test("BdsScriptingLogCompactor removes ANSI-only blank lines after scripting logs", () => {
    const compactor = new BdsScriptingLogCompactor();
    const output =
        compactor.write(
            [
                "\u001B[33m[2026-05-11 21:03:17:525 WARN] [Scripting] [Fishing] catch player=SupaaaaaaHam\u001B[39m\r\n",
                "\u001B[39m\r\n",
                "[2026-05-11 21:03:17:525 INFO] [Scripting] spawn minecraft:item Spawned []\r\n",
            ].join(""),
        ) + compactor.end();

    assert.equal(
        output,
        [
            "\u001B[33m[2026-05-11 21:03:17:525 WARN] [Scripting] [Fishing] catch player=SupaaaaaaHam\u001B[39m\r\n",
            "\u001B[39m[2026-05-11 21:03:17:525 INFO] [Scripting] spawn minecraft:item Spawned []\r\n",
        ].join(""),
    );
});

test("BdsScriptingLogCompactor preserves ANSI reset from suppressed blank lines", () => {
    const compactor = new BdsScriptingLogCompactor();
    const output =
        compactor.write(
            [
                "\u001B[33m[2026-05-11 23:24:09:108 WARN] [Scripting] [Fishing] reel player=SupaaaaaaHam\r\n",
                "\u001B[39m\r\n",
                "[2026-05-11 23:24:09:108 INFO] [Scripting] after itemUse minecraft:fishing_rod SupaaaaaaHam\r\n",
            ].join(""),
        ) + compactor.end();

    assert.equal(
        output,
        [
            "\u001B[33m[2026-05-11 23:24:09:108 WARN] [Scripting] [Fishing] reel player=SupaaaaaaHam\r\n",
            "\u001B[39m[2026-05-11 23:24:09:108 INFO] [Scripting] after itemUse minecraft:fishing_rod SupaaaaaaHam\r\n",
        ].join(""),
    );
});

test("BdsPtyOutputFilter removes ConPTY preamble while preserving ANSI colors", () => {
    const filter = new BdsPtyOutputFilter();
    const output =
        filter.write(
            "\u001B[2J\u001B[m\u001B[H\u001B[31m[INFO] colored\u001B[39m\r\n",
        ) + filter.end();

    assert.equal(output, "\u001B[31m[INFO] colored\u001B[39m\r\n");
});

test("BdsPtyOutputFilter removes split ConPTY preamble before first log text", () => {
    const filter = new BdsPtyOutputFilter();
    const output =
        filter.write("\u001B]0;bedrock_server.exe\u0007") +
        filter.write("\u001B[?25h") +
        filter.write("\u001B[2J\u001B[m") +
        filter.write("\u001B[H\u001B[32m[INFO] first\u001B[39m\r\n") +
        filter.end();

    assert.equal(output, "\u001B[32m[INFO] first\u001B[39m\r\n");
});

test("BdsPtyOutputFilter removes cursor movement after output starts while preserving ANSI colors", () => {
    const filter = new BdsPtyOutputFilter();
    const output =
        filter.write("[INFO] started\r\n") +
        filter.write("\u001B[H\u001B[2J\u001B[33m[INFO] next\u001B[39m\r\n") +
        filter.end();

    assert.equal(
        output,
        "[INFO] started\r\n\u001B[33m[INFO] next\u001B[39m\r\n",
    );
});

test("resolveBdsOutputRelayMode uses a PTY for compacted TTY output when available", () => {
    assert.equal(
        resolveBdsOutputRelayMode({
            compactScriptingLogs: true,
            stdoutIsTTY: true,
            stderrIsTTY: true,
            ptyAvailable: true,
        }),
        "pty",
    );
});

test("resolveBdsOutputRelayMode falls back to pipes when PTY support is unavailable", () => {
    assert.equal(
        resolveBdsOutputRelayMode({
            compactScriptingLogs: true,
            stdoutIsTTY: true,
            stderrIsTTY: true,
            ptyAvailable: false,
        }),
        "pipe",
    );
});

test("replaceBdsServerDirectory retries after Windows EPERM when the destination reappears", async (t) => {
    const projectRoot = await createTempDirectory(t, "blr-bds-replace-");
    const stagingDirectory = path.join(projectRoot, "server.tmp-test");
    const serverDirectory = path.join(projectRoot, "server");
    const runtimeExecutablePath = path.join(
        serverDirectory,
        "bedrock_server.exe",
    );

    await mkdir(stagingDirectory, { recursive: true });
    await writeFile(
        path.join(stagingDirectory, "bedrock_server.exe"),
        "stock executable",
    );

    let renameAttempts = 0;
    const removedDirectories: string[] = [];

    await replaceBdsServerDirectory(stagingDirectory, serverDirectory, {
        retryDelaysMs: [0],
        async removeDirectory(targetPath) {
            removedDirectories.push(path.basename(targetPath));
            await rm(targetPath, { recursive: true, force: true });
        },
        async renameDirectory(sourcePath, destinationPath) {
            renameAttempts += 1;
            if (renameAttempts === 1) {
                await mkdir(destinationPath, { recursive: true });
                await writeFile(path.join(destinationPath, "stale.txt"), "");
                const error = new Error(
                    `EPERM: operation not permitted, rename '${sourcePath}' -> '${destinationPath}'`,
                ) as NodeJS.ErrnoException;
                error.code = "EPERM";
                throw error;
            }

            await renamePath(sourcePath, destinationPath);
        },
    });

    assert.equal(renameAttempts, 2);
    assert.deepEqual(removedDirectories, ["server", "server"]);
    assert.equal(
        await readFile(runtimeExecutablePath, "utf8"),
        "stock executable",
    );
    assert.equal(
        await pathExists(path.join(serverDirectory, "stale.txt")),
        false,
    );
    assert.equal(await pathExists(stagingDirectory), false);
});

test("ensureBds does not leave a versioned server directory behind after an invalid archive response", async (t) => {
    const projectRoot = await createTempDirectory(t, "blr-bds-invalid-");
    const version = "9.9.9.9";
    const serverDirectory = path.join(
        projectRoot,
        ".blr",
        "bds",
        version,
        "server",
    );
    const serverRootDirectory = path.join(projectRoot, ".blr", "bds", version);
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
                    serverDirectory: `.blr/bds/${version}/server`,
                },
            } as any,
        ),
        /not a valid ZIP archive/i,
    );

    assert.equal(await pathExists(serverDirectory), false);
    assert.equal(await pathExists(serverRootDirectory), false);
    assert.equal(await pathExists(cacheZipPath), false);
});

test("prefetchBdsArchive does not leave a versioned server directory behind after a 404 response", async (t) => {
    const projectRoot = await createTempDirectory(t, "blr-bds-prefetch-404-");
    const version = "9.9.9.9";
    const serverRootDirectory = path.join(projectRoot, ".blr", "bds", version);
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
        async () => new Response(null, { status: 404 }),
    );

    await assert.rejects(
        prefetchBdsArchive(
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
        ),
        /Failed to download BDS 9\.9\.9\.9 .* \(404\)\./i,
    );

    assert.equal(await pathExists(serverRootDirectory), false);
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

test("ensureBds overlays server/server.properties onto the runtime file while keeping managed dev settings", async (t) => {
    const projectRoot = await createTempDirectory(t, "blr-bds-properties-");
    const version = "1.26.3.1";
    const runtimeServerDirectory = path.join(
        projectRoot,
        ".blr",
        "bds",
        version,
        "server",
    );
    const runtimePropertiesPath = path.join(
        runtimeServerDirectory,
        "server.properties",
    );
    const projectPropertiesPath = path.join(
        projectRoot,
        "server",
        "server.properties",
    );

    await mkdir(path.join(runtimeServerDirectory, "config", "default"), {
        recursive: true,
    });
    await writeFile(
        path.join(runtimeServerDirectory, "bedrock_server.exe"),
        "stock executable",
    );
    await writeFile(
        runtimePropertiesPath,
        [
            "server-name=Stock Server",
            "compression-threshold=1",
            "allow-cheats=false",
            "allow-list=false",
            "level-name=Bedrock level",
            "default-player-permission-level=operator",
            "gamemode=creative",
            "",
        ].join("\n"),
    );
    await mkdir(path.dirname(projectPropertiesPath), { recursive: true });
    await writeFile(
        projectPropertiesPath,
        [
            "# project overrides",
            "server-name=Team Server",
            "texturepack-required=true",
            "allow-cheats=false",
            "",
        ].join("\n"),
    );

    t.mock.method(globalThis, "fetch", async () => {
        throw new Error("fetch should not be called");
    });

    await ensureBds(
        projectRoot,
        {
            minecraft: {
                channel: "stable",
            },
            dev: {
                localServer: {
                    worldName: "Creative Sandbox",
                    worldSourcePath: "worlds/Creative Sandbox",
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

    const text = await readFile(runtimePropertiesPath, "utf8");
    assert.match(text, /^server-name=Team Server$/m);
    assert.match(text, /^texturepack-required=true$/m);
    assert.match(text, /^compression-threshold=1$/m);
    assert.match(text, /^allow-cheats=true$/m);
    assert.match(text, /^allow-list=true$/m);
    assert.match(text, /^level-name=Creative Sandbox$/m);
    assert.match(text, /^default-player-permission-level=member$/m);
    assert.match(text, /^gamemode=survival$/m);
    assert.match(text, /^content-log-file-enabled=true$/m);
    assert.match(text, /^content-log-console-output-enabled=true$/m);
});

test("prefetchBdsArchive downloads the archive without extracting the server", async (t) => {
    const projectRoot = await createTempDirectory(t, "blr-bds-prefetch-");
    const version = "1.26.3.1";
    const cacheZipPath = path.join(
        projectRoot,
        ".blr",
        "cache",
        "bds",
        `bedrock-server-${version}-win.zip`,
    );
    const runtimeExecutablePath = path.join(
        projectRoot,
        ".blr",
        "bds",
        version,
        "server",
        "bedrock_server.exe",
    );

    const archive = new AdmZip();
    archive.addFile("bedrock_server.exe", Buffer.from("stock executable"));
    archive.addFile(
        "server.properties",
        Buffer.from("level-name=Bedrock level\n"),
    );

    t.mock.method(
        globalThis,
        "fetch",
        async () =>
            new Response(new Uint8Array(archive.toBuffer()), {
                status: 200,
                headers: {
                    "content-type": "application/zip",
                },
            }),
    );

    await prefetchBdsArchive(
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

    assert.equal(await pathExists(cacheZipPath), true);
    assert.equal(await pathExists(runtimeExecutablePath), false);
});

test("prefetchBdsArchive reports download progress while fetching the archive", async (t) => {
    const projectRoot = await createTempDirectory(t, "blr-bds-progress-");
    const version = "1.26.3.1";
    const events: string[] = [];

    const archive = new AdmZip();
    archive.addFile("bedrock_server.exe", Buffer.from("stock executable"));
    archive.addFile(
        "server.properties",
        Buffer.from("level-name=Bedrock level\n"),
    );
    const payload = new Uint8Array(archive.toBuffer());

    t.mock.method(
        globalThis,
        "fetch",
        async () =>
            new Response(payload, {
                status: 200,
                headers: {
                    "content-type": "application/zip",
                    "content-length": String(payload.byteLength),
                },
            }),
    );

    await prefetchBdsArchive(
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
        {
            reporter: {
                onDownloadStart(progress) {
                    events.push(`start:${progress.totalBytes ?? 0}`);
                },
                onDownloadProgress(progress) {
                    events.push(`progress:${progress.bytesReceived}`);
                },
                onDownloadComplete(progress) {
                    events.push(`complete:${progress.bytesReceived}`);
                },
            },
        },
    );

    assert.equal(events[0], `start:${payload.byteLength}`);
    assert.match(events[1] ?? "", /^progress:\d+$/);
    assert.equal(events.at(-1), `complete:${payload.byteLength}`);
});

test("bootstrapProjectWorldSourceFromBds copies an existing runtime world into the project source when the source is missing", async (t) => {
    const projectRoot = await createTempDirectory(t, "blr-bds-bootstrap-copy-");
    const runtimeWorldDirectory = path.join(
        projectRoot,
        ".blr",
        "bds",
        "1.26.3.1",
        "server",
        "worlds",
        "Bedrock level",
    );
    const worldSourceDirectory = path.join(
        projectRoot,
        "worlds",
        "Bedrock level",
    );

    await mkdir(path.join(runtimeWorldDirectory, "db"), { recursive: true });
    await writeFile(path.join(runtimeWorldDirectory, "levelname.txt"), "hello");

    const result = await bootstrapProjectWorldSourceFromBds({
        channel: "stable",
        version: "1.26.3.1",
        platform: "win",
        cacheDirectory: path.join(projectRoot, ".blr", "cache", "bds"),
        serverDirectory: path.join(
            projectRoot,
            ".blr",
            "bds",
            "1.26.3.1",
            "server",
        ),
        worldName: "Bedrock level",
        worldSourcePath: "worlds/Bedrock level",
        worldDirectory: runtimeWorldDirectory,
        worldSourceDirectory,
        executablePath: path.join(
            projectRoot,
            ".blr",
            "bds",
            "1.26.3.1",
            "server",
            "bedrock_server.exe",
        ),
        zipPath: path.join(
            projectRoot,
            ".blr",
            "cache",
            "bds",
            "bedrock-server-1.26.3.1-win.zip",
        ),
        customExecutableInjected: false,
    });

    assert.equal(result, "copied");
    assert.equal(await pathExists(path.join(worldSourceDirectory, "db")), true);
    assert.equal(
        await readFile(
            path.join(worldSourceDirectory, "levelname.txt"),
            "utf8",
        ),
        "hello",
    );
});

test("bootstrapProjectWorldSourceFromBds waits when neither a valid project source nor runtime world exists yet", async (t) => {
    const projectRoot = await createTempDirectory(t, "blr-bds-bootstrap-wait-");
    const worldSourceDirectory = path.join(
        projectRoot,
        "worlds",
        "Bedrock level",
    );

    await mkdir(worldSourceDirectory, { recursive: true });
    await writeFile(path.join(worldSourceDirectory, ".gitkeep"), "");

    const result = await bootstrapProjectWorldSourceFromBds({
        channel: "stable",
        version: "1.26.3.1",
        platform: "win",
        cacheDirectory: path.join(projectRoot, ".blr", "cache", "bds"),
        serverDirectory: path.join(
            projectRoot,
            ".blr",
            "bds",
            "1.26.3.1",
            "server",
        ),
        worldName: "Bedrock level",
        worldSourcePath: "worlds/Bedrock level",
        worldDirectory: path.join(
            projectRoot,
            ".blr",
            "bds",
            "1.26.3.1",
            "server",
            "worlds",
            "Bedrock level",
        ),
        worldSourceDirectory,
        executablePath: path.join(
            projectRoot,
            ".blr",
            "bds",
            "1.26.3.1",
            "server",
            "bedrock_server.exe",
        ),
        zipPath: path.join(
            projectRoot,
            ".blr",
            "cache",
            "bds",
            "bedrock-server-1.26.3.1-win.zip",
        ),
        customExecutableInjected: false,
    });

    assert.equal(result, "waiting-for-runtime");
    assert.equal(
        await pathExists(path.join(worldSourceDirectory, ".gitkeep")),
        true,
    );
    assert.equal(
        await pathExists(path.join(worldSourceDirectory, "db")),
        false,
    );
});

test("captureAllowlistFromBds copies runtime allowlist state back into the project server directory", async (t) => {
    const projectRoot = await createTempDirectory(
        t,
        "blr-bds-capture-allowlist-",
    );
    const serverDirectory = path.join(
        projectRoot,
        ".blr",
        "bds",
        "1.26.3.1",
        "server",
    );
    await mkdir(serverDirectory, { recursive: true });
    await writeFile(
        path.join(serverDirectory, "allowlist.json"),
        '[{"xuid":"1","name":"Supah","ignoresPlayerLimit":false}]',
    );

    await captureAllowlistFromBds(projectRoot, serverDirectory);

    assert.equal(
        await readFile(
            path.join(projectRoot, "server", "allowlist.json"),
            "utf8",
        ),
        '[{"xuid":"1","name":"Supah","ignoresPlayerLimit":false}]',
    );
});

test("capturePermissionsFromBds copies runtime permissions state back into the project server directory", async (t) => {
    const projectRoot = await createTempDirectory(
        t,
        "blr-bds-capture-permissions-",
    );
    const serverDirectory = path.join(
        projectRoot,
        ".blr",
        "bds",
        "1.26.3.1",
        "server",
    );
    await mkdir(serverDirectory, { recursive: true });
    await writeFile(
        path.join(serverDirectory, "permissions.json"),
        '[{"xuid":"1","permission":"operator"}]',
    );

    await capturePermissionsFromBds(projectRoot, serverDirectory);

    assert.equal(
        await readFile(
            path.join(projectRoot, "server", "permissions.json"),
            "utf8",
        ),
        '[{"xuid":"1","permission":"operator"}]',
    );
});

test("backupRuntimeWorldForBdsStartup moves the runtime world into a timestamped backup folder", async (t) => {
    const projectRoot = await createTempDirectory(t, "blr-bds-backup-");
    const runtimeWorldDirectory = path.join(
        projectRoot,
        ".blr",
        "bds",
        "1.26.3.1",
        "server",
        "worlds",
        "Bedrock level",
    );
    await mkdir(path.join(runtimeWorldDirectory, "db"), { recursive: true });
    await writeFile(path.join(runtimeWorldDirectory, "levelname.txt"), "hello");

    const backupPath = await backupRuntimeWorldForBdsStartup({
        channel: "stable",
        version: "1.26.3.1",
        platform: "win",
        cacheDirectory: path.join(projectRoot, ".blr", "cache", "bds"),
        serverDirectory: path.join(
            projectRoot,
            ".blr",
            "bds",
            "1.26.3.1",
            "server",
        ),
        worldName: "Bedrock level",
        worldSourcePath: "worlds/Bedrock level",
        worldDirectory: runtimeWorldDirectory,
        worldSourceDirectory: path.join(projectRoot, "worlds", "Bedrock level"),
        executablePath: path.join(
            projectRoot,
            ".blr",
            "bds",
            "1.26.3.1",
            "server",
            "bedrock_server.exe",
        ),
        zipPath: path.join(
            projectRoot,
            ".blr",
            "cache",
            "bds",
            "bedrock-server-1.26.3.1-win.zip",
        ),
        customExecutableInjected: false,
    });

    assert.ok(backupPath);
    assert.equal(await pathExists(runtimeWorldDirectory), false);
    assert.equal(await pathExists(backupPath), true);
    assert.match(path.basename(backupPath), /^Bedrock level\.\d{8}T\d{6}Z$/);
    assert.equal(
        await readFile(path.join(backupPath, "levelname.txt"), "utf8"),
        "hello",
    );
});
