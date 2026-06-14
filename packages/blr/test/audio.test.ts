import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { runAudioConvertCommand } from "../src/commands/audio.js";
import { loadBlurConfig } from "../src/config.js";
import { buildProject } from "../src/runtime.js";
import {
    createTempDirectory,
    readJsonFile,
    readTextFile,
    writeJsonFile,
} from "./helpers.js";

function createBehaviorManifest(projectName: string) {
    return {
        format_version: 2,
        header: {
            name: `${projectName} Behavior Pack`,
            description: `${projectName} behavior pack`,
            uuid: "11111111-1111-1111-1111-111111111111",
            version: [0, 1, 0],
            min_engine_version: [1, 26, 0],
        },
        modules: [
            {
                description: "Behavior resources",
                type: "data",
                uuid: "22222222-2222-2222-2222-222222222222",
                version: [0, 1, 0],
            },
            {
                description: "Script resources",
                language: "javascript",
                type: "script",
                uuid: "55555555-5555-5555-5555-555555555555",
                version: [0, 1, 0],
                entry: "scripts/main.js",
            },
        ],
        dependencies: [
            {
                module_name: "@minecraft/server",
                version: "2.3.0",
            },
        ],
    };
}

async function createMinimalScriptProject(projectRoot: string): Promise<void> {
    await mkdir(path.join(projectRoot, "behavior_packs", "game"), {
        recursive: true,
    });
    await mkdir(path.join(projectRoot, "src"), {
        recursive: true,
    });
    await writeFile(
        path.join(projectRoot, "src", "main.ts"),
        [
            "globalThis.__audioBootOrder ??= [];",
            'globalThis.__audioBootOrder.push("runtime");',
            "",
        ].join("\n"),
        "utf8",
    );
    await writeJsonFile(path.join(projectRoot, "package.json"), {
        name: "audio-project",
        private: true,
        type: "module",
        dependencies: {
            "@blurengine/bebe": "0.0.0",
        },
    });
    await writeJsonFile(
        path.join(projectRoot, "behavior_packs", "game", "manifest.json"),
        createBehaviorManifest("audio-project"),
    );
    await writeJsonFile(path.join(projectRoot, "blr.config.json"), {
        schemaVersion: 1,
        projectVersion: 1,
        namespace: "test_pack",
        runtime: {
            entry: "src/main.ts",
            outFile: "dist/scripts/main.js",
        },
    });
}

async function createBebeAudioStub(projectRoot: string): Promise<void> {
    const packageRoot = path.join(
        projectRoot,
        "node_modules",
        "@blurengine",
        "bebe",
    );
    await mkdir(path.join(packageRoot, "internal", "audio"), {
        recursive: true,
    });
    await mkdir(path.join(packageRoot, "tooling"), { recursive: true });
    await writeJsonFile(path.join(packageRoot, "package.json"), {
        name: "@blurengine/bebe",
        version: "0.0.0",
        type: "module",
        exports: {
            ".": "./index.js",
            "./internal/audio/player": "./internal/audio/player.js",
            "./tooling/node": "./tooling/node.js",
        },
    });
    await writeFile(
        path.join(packageRoot, "index.js"),
        [
            "export const Audio = {",
            "  load(pack) {",
            "    globalThis.__audioBootOrder ??= [];",
            "    globalThis.__audioBootOrder.push('audio');",
            "    globalThis.__loadedAudioPack = pack;",
            "  },",
            "};",
            "",
        ].join("\n"),
        "utf8",
    );
    await writeFile(
        path.join(packageRoot, "internal", "audio", "player.js"),
        [
            "export function installAudioPlayerCommand(options) {",
            "  globalThis.__audioPlayerOptions = options;",
            "}",
            "",
        ].join("\n"),
        "utf8",
    );
    await writeFile(
        path.join(packageRoot, "tooling", "node.js"),
        [
            "export function createBebeTooling() {",
            "  return {",
            "    assetCompilers: [{",
            "      id: 'bebe:audio',",
            "      sourcePaths: ['audio'],",
            "      sourceKind: 'text',",
            "      sourceMode: 'collection',",
            "      sourceFileExtensions: ['.baud'],",
            "      outputPath: 'generated/bebe/audio.json',",
            "      artifactOutputPaths: [{ target: 'scripts', outputPath: 'generated/bebe/audio.visuals.json' }],",
            "      compile(input) {",
            "        const files = input.sourceFiles.map((file) => ({",
            "          relativePath: file.relativePath,",
            "          text: file.text,",
            "        }));",
            "        return {",
            "          output: {",
            "            compiledBy: 'project-installed-bebe',",
            "            files,",
            "          },",
            "          artifacts: input.pipeline === 'dev' ? [{",
            "            target: 'scripts',",
            "            outputPath: 'generated/bebe/audio.visuals.json',",
            "            output: { visualBy: 'project-installed-bebe', files },",
            "          }] : [],",
            "        };",
            "      },",
            "      renderBootstrap(input) {",
            "        return [",
            "          'import { Audio } from \"@blurengine/bebe\";',",
            "          `import __bebeAudio from ${JSON.stringify(input.outputImportSpecifier)};`,",
            "          'Audio.load(__bebeAudio);',",
            "        ];",
            "      },",
            "    }],",
            "  };",
            "}",
            "",
            "export function convertMidiToBaud(data, options) {",
            "  const soundId = typeof options.soundId === 'string' ? options.soundId : 'note.harp';",
            "  const policyLine = options.profile || options.policy ? `# ${JSON.stringify({ profile: options.profile, policy: options.policy })}` : undefined;",
            "  return [",
            "    `cue ${options.cueId} t${options.tempo ?? 120}`,",
            "    `@right ${soundId} o5 l8 v88`,",
            "    `c`,",
            "    ...(policyLine ? [policyLine] : []),",
            "    '',",
            "  ].join('\\n');",
            "}",
            "",
            "export function convertMidiToBaudWithDiagnostics(data, options) {",
            "  const diagnostics = [];",
            "  if (options.cueId === 'with.drop') {",
            "    diagnostics.push({",
            "      kind: 'droppedPart',",
            "      midiChannel: 6,",
            "      noteCount: 12,",
            "      program: 53,",
            "      programName: 'Choir Aahs',",
            "      reason: 'unsupportedProgram',",
            "    });",
            "  }",
            "  if (options.cueId === 'with.optimize') {",
            "    diagnostics.push({",
            "      kind: 'optimizedPlayback',",
            "      noteCount: 4,",
            "      profile: 'minecraft',",
            "      reason: 'duplicateNote',",
            "    });",
            "  }",
            "  return {",
            "    baud: convertMidiToBaud(data, options),",
            "    diagnostics,",
            "  };",
            "}",
            "",
        ].join("\n"),
        "utf8",
    );
}

async function createStaleBebeToolingStub(projectRoot: string): Promise<void> {
    const packageRoot = path.join(
        projectRoot,
        "node_modules",
        "@blurengine",
        "bebe",
    );
    await mkdir(path.join(packageRoot, "tooling"), { recursive: true });
    await writeJsonFile(path.join(packageRoot, "package.json"), {
        name: "@blurengine/bebe",
        version: "0.0.0",
        type: "module",
        exports: {
            ".": "./index.js",
            "./tooling/node": "./tooling/node.js",
        },
    });
    await writeFile(path.join(packageRoot, "index.js"), "", "utf8");
    await writeFile(
        path.join(packageRoot, "tooling", "node.js"),
        [
            "export function createBebeTooling() {",
            "  return {",
            "    assetCompilers: [{",
            "      id: 'bebe:zones',",
            "      sourcePaths: ['zones.json'],",
            "      outputPath: 'generated/zones.json',",
            "      compile() { return { output: { zones: [] } }; },",
            "    }],",
            "  };",
            "}",
            "",
        ].join("\n"),
        "utf8",
    );
}

test("audio convert writes MIDI-derived BAUD through project-installed Bebe tooling", async (t) => {
    const projectRoot = await createTempDirectory(t, "blr-audio-convert-");
    await createMinimalScriptProject(projectRoot);
    await createBebeAudioStub(projectRoot);
    await writeFile(
        path.join(projectRoot, "source.mid"),
        Uint8Array.of(0x4d, 0x54, 0x68, 0x64),
    );

    const originalCwd = process.cwd();
    process.chdir(projectRoot);
    try {
        await runAudioConvertCommand("source.mid", {
            cue: "boss.theme",
            out: "audio/boss.theme.baud",
            sound: "note.pling",
            tempo: 180,
        });
    } finally {
        process.chdir(originalCwd);
    }

    assert.equal(
        await readTextFile(path.join(projectRoot, "audio", "boss.theme.baud")),
        "cue boss.theme t180\n@right note.pling o5 l8 v88\nc\n",
    );
});

test("audio convert passes MIDI playback profile and policy overrides", async (t) => {
    const projectRoot = await createTempDirectory(
        t,
        "blr-audio-convert-profile-",
    );
    await createMinimalScriptProject(projectRoot);
    await createBebeAudioStub(projectRoot);
    await writeFile(
        path.join(projectRoot, "source.mid"),
        Uint8Array.of(0x4d, 0x54, 0x68, 0x64),
    );

    const originalCwd = process.cwd();
    process.chdir(projectRoot);
    try {
        await runAudioConvertCommand("source.mid", {
            cue: "profile.test",
            lowBassGap: 6,
            lowBassPitch: 38,
            maxPressure: 5.5,
            maxSimultaneous: 6,
            profile: "compact",
        });
    } finally {
        process.chdir(originalCwd);
    }

    assert.equal(
        await readTextFile(
            path.join(projectRoot, "audio", "profile.test.baud"),
        ),
        [
            "cue profile.test t120",
            "@right note.harp o5 l8 v88",
            "c",
            '# {"profile":"compact","policy":{"lowBassMinimumPitch":38,"lowBassMinimumTickGap":6,"maxSimultaneousNotes":6,"maxWeightedPressure":5.5}}',
            "",
        ].join("\n"),
    );
});

test("audio convert reports dropped unsupported MIDI parts", async (t) => {
    const projectRoot = await createTempDirectory(
        t,
        "blr-audio-convert-dropped-",
    );
    await createMinimalScriptProject(projectRoot);
    await createBebeAudioStub(projectRoot);
    await writeFile(
        path.join(projectRoot, "source.mid"),
        Uint8Array.of(0x4d, 0x54, 0x68, 0x64),
    );

    const warnings: string[] = [];
    const originalCwd = process.cwd();
    const originalWarn = console.warn;
    process.chdir(projectRoot);
    console.warn = (message?: unknown): void => {
        warnings.push(String(message));
    };
    try {
        await runAudioConvertCommand("source.mid", {
            cue: "with.drop",
        });
    } finally {
        console.warn = originalWarn;
        process.chdir(originalCwd);
    }

    assert.deepEqual(warnings, [
        "[audio] Dropped unsupported MIDI parts:",
        "[audio]   ch6 Choir Aahs: 12 notes",
    ]);
});

test("audio convert reports optimized MIDI playback reductions", async (t) => {
    const projectRoot = await createTempDirectory(
        t,
        "blr-audio-convert-optimized-",
    );
    await createMinimalScriptProject(projectRoot);
    await createBebeAudioStub(projectRoot);
    await writeFile(
        path.join(projectRoot, "source.mid"),
        Uint8Array.of(0x4d, 0x54, 0x68, 0x64),
    );

    const logs: string[] = [];
    const originalCwd = process.cwd();
    const originalLog = console.log;
    process.chdir(projectRoot);
    console.log = (message?: unknown): void => {
        logs.push(String(message));
    };
    try {
        await runAudioConvertCommand("source.mid", {
            cue: "with.optimize",
        });
    } finally {
        console.log = originalLog;
        process.chdir(originalCwd);
    }

    assert.deepEqual(logs.slice(1), [
        "[audio] Optimized MIDI playback:",
        "[audio]   minecraft duplicate-note: 4 notes",
    ]);
});

test("audio convert keeps output inside the project audio directory", async (t) => {
    const projectRoot = await createTempDirectory(
        t,
        "blr-audio-convert-outside-",
    );
    await createMinimalScriptProject(projectRoot);
    await createBebeAudioStub(projectRoot);
    await writeFile(
        path.join(projectRoot, "source.mid"),
        Uint8Array.of(0x4d, 0x54, 0x68, 0x64),
    );

    const originalCwd = process.cwd();
    process.chdir(projectRoot);
    try {
        await assert.rejects(
            () =>
                runAudioConvertCommand("source.mid", {
                    out: "generated/source.baud",
                }),
            /audio convert output must be under audio\//,
        );
    } finally {
        process.chdir(originalCwd);
    }
});

test("audio convert rejects unsupported input file extensions", async (t) => {
    const projectRoot = await createTempDirectory(
        t,
        "blr-audio-convert-extension-",
    );
    await createMinimalScriptProject(projectRoot);
    await createBebeAudioStub(projectRoot);
    await writeFile(path.join(projectRoot, "source.txt"), "not midi", "utf8");

    const originalCwd = process.cwd();
    process.chdir(projectRoot);
    try {
        await assert.rejects(
            () => runAudioConvertCommand("source.txt", {}),
            /audio convert input must use the \.mid or \.midi extension/,
        );
    } finally {
        process.chdir(originalCwd);
    }
});

test("audio convert rejects non-positive tempo values", async (t) => {
    const projectRoot = await createTempDirectory(
        t,
        "blr-audio-convert-tempo-",
    );
    await createMinimalScriptProject(projectRoot);
    await createBebeAudioStub(projectRoot);
    await writeFile(
        path.join(projectRoot, "source.mid"),
        Uint8Array.of(0x4d, 0x54, 0x68, 0x64),
    );

    const originalCwd = process.cwd();
    process.chdir(projectRoot);
    try {
        await assert.rejects(
            () => runAudioConvertCommand("source.mid", { tempo: 0 }),
            /audio convert tempo must be a positive integer/,
        );
    } finally {
        process.chdir(originalCwd);
    }
});

test("audio convert requires Bebe tooling with MIDI conversion support", async (t) => {
    const projectRoot = await createTempDirectory(
        t,
        "blr-audio-convert-stale-",
    );
    await createMinimalScriptProject(projectRoot);
    await createStaleBebeToolingStub(projectRoot);
    await writeFile(
        path.join(projectRoot, "source.mid"),
        Uint8Array.of(0x4d, 0x54, 0x68, 0x64),
    );

    const originalCwd = process.cwd();
    process.chdir(projectRoot);
    try {
        await assert.rejects(
            () => runAudioConvertCommand("source.mid", {}),
            /@blurengine\/bebe\/tooling\/node must export convertMidiToBaud\(\) for audio MIDI conversion/,
        );
    } finally {
        process.chdir(originalCwd);
    }
});

test("audio BAUD files are collected, baked, staged, and loaded before runtime", async (t) => {
    const projectRoot = await createTempDirectory(t, "blr-audio-build-");
    await createMinimalScriptProject(projectRoot);
    await createBebeAudioStub(projectRoot);
    await mkdir(path.join(projectRoot, "audio", "events"), {
        recursive: true,
    });
    const lateSourceText =
        "cue reward.success t120\n@lead note.harp o4 l4 v80\nc\n";
    await writeFile(
        path.join(projectRoot, "audio", "events", "a.baud"),
        lateSourceText,
        "utf8",
    );
    const earlySourceText =
        "cue reward.warning t90\n@lead note.bell o4 l4 v70\ng\n";
    await writeFile(
        path.join(projectRoot, "audio", "events", "Z.baud"),
        earlySourceText,
        "utf8",
    );
    await writeFile(
        path.join(projectRoot, "audio", "ignore.txt"),
        "this is not BAUD\n",
        "utf8",
    );

    const { config } = await loadBlurConfig(projectRoot);
    await buildProject(projectRoot, config, {
        production: false,
        link: { enabled: false },
    });

    const bakedPack = await readJsonFile(
        path.join(projectRoot, "dist", "generated", "bebe", "audio.json"),
    );
    assert.deepEqual(bakedPack, {
        compiledBy: "project-installed-bebe",
        files: [
            {
                relativePath: "audio/events/Z.baud",
                text: earlySourceText,
            },
            {
                relativePath: "audio/events/a.baud",
                text: lateSourceText,
            },
        ],
    });
    assert.deepEqual(
        await readJsonFile(
            path.join(
                projectRoot,
                "dist",
                "stage",
                "behavior_packs",
                "game",
                "scripts",
                "generated",
                "bebe",
                "audio.json",
            ),
        ),
        bakedPack,
    );
    assert.deepEqual(
        await readJsonFile(
            path.join(
                projectRoot,
                "dist",
                "stage",
                "bds_behavior_packs",
                "game",
                "scripts",
                "generated",
                "bebe",
                "audio.json",
            ),
        ),
        bakedPack,
    );
    assert.equal(
        existsSync(
            path.join(
                projectRoot,
                "dist",
                "generated",
                "bebe",
                "audio.visuals.json",
            ),
        ),
        false,
    );
    assert.equal(
        existsSync(
            path.join(
                projectRoot,
                "dist",
                "stage",
                "behavior_packs",
                "game",
                "scripts",
                "generated",
                "bebe",
                "audio.visuals.json",
            ),
        ),
        false,
    );
    assert.equal(
        existsSync(
            path.join(
                projectRoot,
                "dist",
                "stage",
                "bds_behavior_packs",
                "game",
                "scripts",
                "generated",
                "bebe",
                "audio.visuals.json",
            ),
        ),
        false,
    );

    const runtimeBundle = await readTextFile(
        path.join(projectRoot, "dist", "scripts", "main.js"),
    );
    assert.match(runtimeBundle, /Audio\.load/);
    assert.doesNotMatch(runtimeBundle, /audio\.visuals\.json/);

    const globals = globalThis as typeof globalThis & {
        __loadedAudioPack?: unknown;
        __audioBootOrder?: string[];
    };
    delete globals.__loadedAudioPack;
    delete globals.__audioBootOrder;
    await import(
        `${pathToFileURL(path.join(projectRoot, "dist", "scripts", "main.js")).href}?audio-test=${Date.now()}`
    );
    assert.deepEqual(globals.__audioBootOrder, ["audio", "runtime"]);
    assert.deepEqual(globals.__loadedAudioPack, bakedPack);
});

test("audio dev builds stage visual sidecars and pass them to the dev command", async (t) => {
    const projectRoot = await createTempDirectory(t, "blr-audio-visuals-dev-");
    await createMinimalScriptProject(projectRoot);
    await createBebeAudioStub(projectRoot);
    await mkdir(path.join(projectRoot, "audio"), { recursive: true });
    const sourceText =
        "cue reward.success t120\n@lead note.harp o4 l4 v80\nc\n";
    await writeFile(
        path.join(projectRoot, "audio", "reward.baud"),
        sourceText,
        "utf8",
    );

    const { config } = await loadBlurConfig(projectRoot);
    await buildProject(projectRoot, config, {
        production: false,
        link: { enabled: false },
        pipeline: "dev",
    });

    const visualPack = await readJsonFile(
        path.join(
            projectRoot,
            "dist",
            "generated",
            "bebe",
            "audio.visuals.json",
        ),
    );
    assert.deepEqual(visualPack, {
        visualBy: "project-installed-bebe",
        files: [
            {
                relativePath: "audio/reward.baud",
                text: sourceText,
            },
        ],
    });
    assert.deepEqual(
        await readJsonFile(
            path.join(
                projectRoot,
                "dist",
                "stage",
                "behavior_packs",
                "game",
                "scripts",
                "generated",
                "bebe",
                "audio.visuals.json",
            ),
        ),
        visualPack,
    );
    assert.deepEqual(
        await readJsonFile(
            path.join(
                projectRoot,
                "dist",
                "stage",
                "bds_behavior_packs",
                "game",
                "scripts",
                "generated",
                "bebe",
                "audio.visuals.json",
            ),
        ),
        visualPack,
    );

    const runtimeBundle = await readTextFile(
        path.join(projectRoot, "dist", "scripts", "main.js"),
    );
    assert.match(runtimeBundle, /audio\.visuals\.json/);

    const globals = globalThis as typeof globalThis & {
        __audioPlayerOptions?: { visualPack?: unknown };
    };
    delete globals.__audioPlayerOptions;
    await import(
        `${pathToFileURL(path.join(projectRoot, "dist", "scripts", "main.js")).href}?audio-visuals-test=${Date.now()}`
    );
    const audioPlayerOptions = (
        globalThis as typeof globalThis & {
            __audioPlayerOptions?: { visualPack?: unknown };
        }
    ).__audioPlayerOptions;
    assert.deepEqual(audioPlayerOptions?.visualPack, visualPack);
});

test("audio sources require project-installed Bebe tooling that claims audio", async (t) => {
    const projectRoot = await createTempDirectory(t, "blr-stale-audio-");
    await createMinimalScriptProject(projectRoot);
    await createStaleBebeToolingStub(projectRoot);
    await mkdir(path.join(projectRoot, "audio"), { recursive: true });
    await writeFile(
        path.join(projectRoot, "audio", "cue.baud"),
        "cue cue t120\n@lead note.harp o4 l4 v80\nc\n",
        "utf8",
    );

    const { config } = await loadBlurConfig(projectRoot);
    await assert.rejects(
        () =>
            buildProject(projectRoot, config, {
                production: false,
                link: { enabled: false },
            }),
        /audio requires @blurengine\/bebe\/tooling\/node with an asset compiler that declares audio/,
    );
});

test("audio directories without BAUD files are rejected", async (t) => {
    const projectRoot = await createTempDirectory(t, "blr-empty-audio-");
    await createMinimalScriptProject(projectRoot);
    await createBebeAudioStub(projectRoot);
    await mkdir(path.join(projectRoot, "audio"), { recursive: true });
    await writeFile(
        path.join(projectRoot, "audio", "cue.txt"),
        "cue cue t120\n",
        "utf8",
    );

    const { config } = await loadBlurConfig(projectRoot);
    await assert.rejects(
        () =>
            buildProject(projectRoot, config, {
                production: false,
                link: { enabled: false },
            }),
        /audio must contain at least one \.baud file for bebe:audio/,
    );
});

test("root audio.baud is rejected in favour of the audio directory", async (t) => {
    const projectRoot = await createTempDirectory(t, "blr-root-audio-baud-");
    await createMinimalScriptProject(projectRoot);
    await createBebeAudioStub(projectRoot);
    await writeFile(path.join(projectRoot, "audio.baud"), "cue root\n", "utf8");

    const { config } = await loadBlurConfig(projectRoot);
    await assert.rejects(
        () =>
            buildProject(projectRoot, config, {
                production: false,
                link: { enabled: false },
            }),
        /audio\.baud is not supported; put BAUD files under audio\//,
    );
});
