import assert from "node:assert/strict";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import type { NBT } from "prismarine-nbt";
import { runWorldLevelDatEditCommand } from "../src/commands/world.js";
import { editBedrockLevelDatInteractively } from "../src/level-dat-editor.js";
import { PromptAbortedError, PromptExitedError } from "../src/prompt.js";
import {
    createBedrockLevelDatDump,
    parseBedrockLevelDat,
    readBedrockLevelDatFile,
    serializeBedrockLevelDat,
} from "../src/level-dat.js";
import {
    createTempDirectory,
    readJsonFile,
    runBuiltCli,
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
                type: "data",
                uuid: "22222222-2222-2222-2222-222222222222",
                version: [0, 1, 0],
            },
        ],
    };
}

async function createMinimalProject(
    projectRoot: string,
    worldName = "Shared World",
): Promise<void> {
    await mkdir(path.join(projectRoot, "behavior_packs", "example-pack"), {
        recursive: true,
    });
    await writeJsonFile(path.join(projectRoot, "package.json"), {
        name: "example-project",
        private: true,
    });
    await writeJsonFile(
        path.join(
            projectRoot,
            "behavior_packs",
            "example-pack",
            "manifest.json",
        ),
        createBehaviorManifest("example-project"),
    );
    await writeJsonFile(path.join(projectRoot, "blr.config.json"), {
        schemaVersion: 1,
        projectVersion: 1,
        namespace: "bc_df",
        dev: {
            localServer: {
                worldName,
            },
        },
    });
}

function createSampleLevelDatNbt(worldName: string): NBT {
    return {
        name: "",
        type: "compound",
        value: {
            LevelName: {
                type: "string",
                value: worldName,
            },
            GameType: {
                type: "int",
                value: 1,
            },
            Difficulty: {
                type: "int",
                value: 2,
            },
            abilities: {
                type: "compound",
                value: {
                    mayfly: {
                        type: "byte",
                        value: 1,
                    },
                },
            },
        },
    };
}

function createInteractiveEditorSampleNbt(worldName: string): NBT {
    return {
        name: "",
        type: "compound",
        value: {
            LevelName: {
                type: "string",
                value: worldName,
            },
            Time: {
                type: "long",
                value: [0, 12133],
            },
            abilities: {
                type: "compound",
                value: {
                    mayfly: {
                        type: "byte",
                        value: 1,
                    },
                },
            },
        },
    };
}

function createPromptSequence(responses: Array<Record<string, unknown>>) {
    let index = 0;
    return (async () => {
        const response = responses[index];
        assert.ok(
            response,
            `Unexpected prompt invocation at index ${index}. Responses exhausted.`,
        );
        index += 1;
        return response as any;
    }) as any;
}

async function writeWorldLevelDat(
    projectRoot: string,
    worldName: string,
): Promise<string> {
    const worldDirectory = path.join(projectRoot, "worlds", worldName);
    await mkdir(path.join(worldDirectory, "db"), { recursive: true });
    const levelDatPath = path.join(worldDirectory, "level.dat");
    await writeFile(
        levelDatPath,
        serializeBedrockLevelDat({
            storageVersion: 10,
            data: createSampleLevelDatNbt(worldName),
        }),
    );
    return levelDatPath;
}

test("parseBedrockLevelDat round-trips Bedrock header and little-endian NBT", () => {
    const serialized = serializeBedrockLevelDat({
        storageVersion: 10,
        data: createSampleLevelDatNbt("Shared World"),
    });

    const parsed = parseBedrockLevelDat(serialized);

    assert.equal(parsed.storageVersion, 10);
    assert.equal(parsed.payloadLength, serialized.length - 8);
    assert.deepEqual(parsed.data, createSampleLevelDatNbt("Shared World"));
    assert.deepEqual(createBedrockLevelDatDump(parsed, "simplified"), {
        fileType: "bedrock-level-dat",
        nbtFormat: "little",
        storageVersion: 10,
        payloadLength: serialized.length - 8,
        rootName: "",
        data: {
            LevelName: "Shared World",
            GameType: 1,
            Difficulty: 2,
            abilities: {
                mayfly: 1,
            },
        },
    });
});

test("parseBedrockLevelDat rejects payload length mismatch", () => {
    const serialized = serializeBedrockLevelDat({
        storageVersion: 10,
        data: createSampleLevelDatNbt("Shared World"),
    });
    serialized.writeUInt32LE(serialized.length, 4);

    assert.throws(
        () => parseBedrockLevelDat(serialized),
        /declares .* payload bytes but the file contains/i,
    );
});

test("blr world level-dat dump prints simplified json by default", async (t) => {
    const projectRoot = await createTempDirectory(t, "blr-level-dat-");
    await createMinimalProject(projectRoot);
    const levelDatPath = await writeWorldLevelDat(projectRoot, "Shared World");

    const result = runBuiltCli(["world", "level-dat", "dump"], projectRoot);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    const dumped = JSON.parse(result.stdout) as Record<string, unknown>;
    assert.equal(dumped.fileType, "bedrock-level-dat");
    assert.equal(dumped.nbtFormat, "little");
    assert.equal(dumped.storageVersion, 10);
    assert.equal(dumped.rootName, "");
    assert.deepEqual(dumped.data, {
        LevelName: "Shared World",
        GameType: 1,
        Difficulty: 2,
        abilities: {
            mayfly: 1,
        },
    });
    assert.ok(
        (await readFile(levelDatPath)).length > 8,
        "expected test world level.dat to be written",
    );
});

test("blr world level-dat dump accepts a path-like positional argument", async (t) => {
    const projectRoot = await createTempDirectory(t, "blr-level-dat-");
    await createMinimalProject(projectRoot, "Bedrock level");
    await writeWorldLevelDat(projectRoot, "Bedrock level");
    const worldDirectoryArgument = `${path.join(".", "worlds", "Bedrock level")}${path.sep}"`;

    const result = runBuiltCli(
        ["world", "level-dat", "dump", worldDirectoryArgument],
        projectRoot,
    );

    assert.equal(result.status, 0, result.stderr);
    const dumped = JSON.parse(result.stdout) as Record<string, unknown>;
    assert.equal(dumped.fileType, "bedrock-level-dat");
    assert.deepEqual(dumped.data, {
        LevelName: "Bedrock level",
        GameType: 1,
        Difficulty: 2,
        abilities: {
            mayfly: 1,
        },
    });
});

test("blr world level-dat dump supports typed output written to a file", async (t) => {
    const projectRoot = await createTempDirectory(t, "blr-level-dat-");
    await createMinimalProject(projectRoot, "Creative Sandbox");
    const levelDatPath = await writeWorldLevelDat(
        projectRoot,
        "Creative Sandbox",
    );
    const outputPath = path.join(
        projectRoot,
        ".tmp",
        "creative-level-dat.json",
    );

    const result = runBuiltCli(
        [
            "world",
            "level-dat",
            "dump",
            "--path",
            levelDatPath,
            "--format",
            "typed",
            "--output",
            outputPath,
        ],
        projectRoot,
    );

    assert.equal(result.status, 0, result.stderr);
    assert.match(
        result.stdout,
        /Wrote level\.dat dump for "Creative Sandbox" to .*creative-level-dat\.json\./i,
    );

    const dumped = await readJsonFile<Record<string, any>>(outputPath);
    assert.equal(dumped.fileType, "bedrock-level-dat");
    assert.equal(dumped.nbtFormat, "little");
    assert.equal(dumped.storageVersion, 10);
    assert.equal(dumped.data.name, "");
    assert.equal(dumped.data.type, "compound");
    assert.equal(dumped.data.value.LevelName.type, "string");
    assert.equal(dumped.data.value.LevelName.value, "Creative Sandbox");
    assert.equal(dumped.data.value.abilities.type, "compound");
    assert.equal(dumped.data.value.abilities.value.mayfly.type, "byte");
    assert.equal(dumped.data.value.abilities.value.mayfly.value, 1);
});

test("editBedrockLevelDatInteractively updates nested scalar tags and long values", async (t) => {
    const prompt = createPromptSequence([
        {
            choice: {
                kind: "field",
                fieldName: "LevelName",
            },
        },
        {
            value: "Renamed World",
        },
        {
            choice: {
                kind: "field",
                fieldName: "Time",
            },
        },
        {
            value: "12134",
        },
        {
            choice: {
                kind: "field",
                fieldName: "abilities",
            },
        },
        {
            choice: {
                kind: "field",
                fieldName: "mayfly",
            },
        },
        {
            value: false,
        },
        {
            choice: {
                kind: "up",
            },
        },
        {
            choice: {
                kind: "save",
            },
        },
    ]);
    t.mock.method(console, "log", () => {});
    const levelDat = {
        data: createInteractiveEditorSampleNbt("Shared World"),
    };

    const result = await editBedrockLevelDatInteractively({
        worldName: "Shared World",
        levelDat,
        prompt,
    });

    assert.deepEqual(result, {
        saved: true,
        changed: true,
        changedPaths: ["LevelName", "Time", "abilities.mayfly"],
    });
    assert.equal(levelDat.data.value.LevelName?.type, "string");
    assert.equal(levelDat.data.value.LevelName?.value, "Renamed World");
    assert.equal(levelDat.data.value.Time?.type, "long");
    assert.deepEqual(levelDat.data.value.Time?.value, [0, 12134]);
    assert.equal(levelDat.data.value.abilities?.type, "compound");
    assert.equal(levelDat.data.value.abilities?.value.mayfly?.type, "byte");
    assert.equal(levelDat.data.value.abilities?.value.mayfly?.value, 0);
});

test("editBedrockLevelDatInteractively prefixes menu actions without changing field labels", async (t) => {
    let autocompletePrompt: Record<string, unknown> | undefined;
    const prompt = (async (questions: unknown) => {
        const promptRecord = questions as Record<string, unknown>;
        if (promptRecord.name === "choice") {
            autocompletePrompt = promptRecord;
            return {
                choice: {
                    kind: "save",
                },
            } as any;
        }

        throw new Error(`Unexpected prompt: ${String(promptRecord.name)}`);
    }) as any;
    t.mock.method(console, "log", () => {});

    const result = await editBedrockLevelDatInteractively({
        worldName: "Shared World",
        levelDat: {
            data: createInteractiveEditorSampleNbt("Shared World"),
        },
        prompt,
    });

    assert.deepEqual(result, {
        saved: true,
        changed: false,
        changedPaths: [],
    });
    assert.ok(
        autocompletePrompt,
        "expected the editor to render a choice prompt",
    );
    const choices = autocompletePrompt.choices as Array<
        Record<string, unknown>
    >;
    assert.ok(Array.isArray(choices));
    const titles = choices.map((choice) => String(choice.title));
    assert.deepEqual(titles.slice(0, 3), [
        "[x] Exit editor",
        "[+] Add a field to this compound",
        "[-] Remove a field from this compound",
    ]);
    assert.ok(
        titles.includes('LevelName (string) "Shared World"'),
        "expected raw field labels to stay unchanged",
    );
});

test("editBedrockLevelDatInteractively offers a back option in remove mode", async (t) => {
    let removePrompt: Record<string, unknown> | undefined;
    let choicePromptCount = 0;
    const prompt = (async (questions: unknown) => {
        const promptRecord = questions as Record<string, unknown>;
        if (promptRecord.name === "choice") {
            choicePromptCount += 1;
            if (choicePromptCount === 1) {
                return {
                    choice: {
                        kind: "remove",
                    },
                } as any;
            }
            return {
                choice: {
                    kind: "save",
                },
            } as any;
        }
        if (promptRecord.name === "fieldName") {
            removePrompt = promptRecord;
            return {
                fieldName: "__blr_back__",
            } as any;
        }

        throw new Error(`Unexpected prompt: ${String(promptRecord.name)}`);
    }) as any;
    t.mock.method(console, "log", () => {});

    const result = await editBedrockLevelDatInteractively({
        worldName: "Shared World",
        levelDat: {
            data: createInteractiveEditorSampleNbt("Shared World"),
        },
        prompt,
    });

    assert.deepEqual(result, {
        saved: true,
        changed: false,
        changedPaths: [],
    });
    assert.ok(removePrompt, "expected the remove-field picker to render");
    const choices = removePrompt.choices as Array<Record<string, unknown>>;
    assert.ok(Array.isArray(choices));
    assert.equal(String(choices[0]?.title), "[..] Back to compound");
});

test("editBedrockLevelDatInteractively treats escape as back inside child compounds", async (t) => {
    let choicePromptCount = 0;
    const prompt = (async (questions: unknown) => {
        const promptRecord = questions as Record<string, unknown>;
        if (promptRecord.name !== "choice") {
            throw new Error(`Unexpected prompt: ${String(promptRecord.name)}`);
        }

        choicePromptCount += 1;
        if (choicePromptCount === 1) {
            return {
                choice: {
                    kind: "field",
                    fieldName: "abilities",
                },
            } as any;
        }
        if (choicePromptCount === 2) {
            throw new PromptExitedError();
        }

        return {
            choice: {
                kind: "save",
            },
        } as any;
    }) as any;
    t.mock.method(console, "log", () => {});

    const result = await editBedrockLevelDatInteractively({
        worldName: "Shared World",
        levelDat: {
            data: createInteractiveEditorSampleNbt("Shared World"),
        },
        prompt,
    });

    assert.deepEqual(result, {
        saved: true,
        changed: false,
        changedPaths: [],
    });
});

test("editBedrockLevelDatInteractively rethrows ctrl+c instead of treating it as back", async (t) => {
    let choicePromptCount = 0;
    const prompt = (async (questions: unknown) => {
        const promptRecord = questions as Record<string, unknown>;
        if (promptRecord.name !== "choice") {
            throw new Error(`Unexpected prompt: ${String(promptRecord.name)}`);
        }

        choicePromptCount += 1;
        if (choicePromptCount === 1) {
            return {
                choice: {
                    kind: "field",
                    fieldName: "abilities",
                },
            } as any;
        }

        throw new PromptAbortedError();
    }) as any;
    t.mock.method(console, "log", () => {});

    await assert.rejects(
        () =>
            editBedrockLevelDatInteractively({
                worldName: "Shared World",
                levelDat: {
                    data: createInteractiveEditorSampleNbt("Shared World"),
                },
                prompt,
            }),
        (error: unknown) => error instanceof PromptAbortedError,
    );
});

test("editBedrockLevelDatInteractively adds and removes fields inside compounds", async (t) => {
    const prompt = createPromptSequence([
        {
            choice: {
                kind: "add",
            },
        },
        {
            tagType: "string",
        },
        {
            fieldName: "BiomeOverride",
        },
        {
            value: "minecraft:plains",
        },
        {
            choice: {
                kind: "field",
                fieldName: "abilities",
            },
        },
        {
            choice: {
                kind: "add",
            },
        },
        {
            tagType: "int",
        },
        {
            fieldName: "flightBoost",
        },
        {
            value: "2",
        },
        {
            choice: {
                kind: "remove",
            },
        },
        {
            fieldName: "mayfly",
        },
        {
            remove: true,
        },
        {
            choice: {
                kind: "up",
            },
        },
        {
            choice: {
                kind: "save",
            },
        },
    ]);
    t.mock.method(console, "log", () => {});
    const levelDat = {
        data: createInteractiveEditorSampleNbt("Shared World"),
    };

    const result = await editBedrockLevelDatInteractively({
        worldName: "Shared World",
        levelDat,
        prompt,
    });

    assert.deepEqual(result, {
        saved: true,
        changed: true,
        changedPaths: [
            "BiomeOverride",
            "abilities.flightBoost",
            "abilities.mayfly",
        ],
    });
    assert.equal(levelDat.data.value.BiomeOverride?.type, "string");
    assert.equal(levelDat.data.value.BiomeOverride?.value, "minecraft:plains");
    assert.equal(levelDat.data.value.abilities?.type, "compound");
    assert.equal(levelDat.data.value.abilities?.value.flightBoost?.type, "int");
    assert.equal(levelDat.data.value.abilities?.value.flightBoost?.value, 2);
    assert.equal(levelDat.data.value.abilities?.value.mayfly, undefined);
});

test("runWorldLevelDatEditCommand saves edits and writes a backup", async (t) => {
    const projectRoot = await createTempDirectory(t, "blr-level-dat-edit-");
    await createMinimalProject(projectRoot);
    const levelDatPath = await writeWorldLevelDat(projectRoot, "Shared World");
    const previousWorkingDirectory = process.cwd();
    process.chdir(projectRoot);
    t.after(() => {
        process.chdir(previousWorkingDirectory);
    });
    const prompt = createPromptSequence([
        {
            choice: {
                kind: "field",
                fieldName: "LevelName",
            },
        },
        {
            value: "Edited World",
        },
        {
            choice: {
                kind: "field",
                fieldName: "abilities",
            },
        },
        {
            choice: {
                kind: "field",
                fieldName: "mayfly",
            },
        },
        {
            value: false,
        },
        {
            choice: {
                kind: "up",
            },
        },
        {
            choice: {
                kind: "save",
            },
        },
    ]);
    t.mock.method(console, "log", () => {});

    await runWorldLevelDatEditCommand(
        undefined,
        {},
        {
            canPrompt: () => true,
            prompt,
        },
    );

    const saved = await readBedrockLevelDatFile(levelDatPath);
    const simplified = createBedrockLevelDatDump(saved, "simplified");
    assert.deepEqual(simplified.data, {
        LevelName: "Edited World",
        GameType: 1,
        Difficulty: 2,
        abilities: {
            mayfly: 0,
        },
    });

    const worldDirectoryEntries = await readdir(path.dirname(levelDatPath));
    const backupFileName = worldDirectoryEntries.find((entry) =>
        entry.startsWith("level.dat.blr-backup-"),
    );
    assert.ok(backupFileName, "expected a timestamped level.dat backup");
    const backup = await readBedrockLevelDatFile(
        path.join(path.dirname(levelDatPath), backupFileName),
    );
    const backupDump = createBedrockLevelDatDump(backup, "simplified");
    assert.deepEqual(backupDump.data, {
        LevelName: "Shared World",
        GameType: 1,
        Difficulty: 2,
        abilities: {
            mayfly: 1,
        },
    });
});

test("runWorldLevelDatEditCommand saves added and removed fields", async (t) => {
    const projectRoot = await createTempDirectory(t, "blr-level-dat-edit-");
    await createMinimalProject(projectRoot);
    const levelDatPath = await writeWorldLevelDat(projectRoot, "Shared World");
    const previousWorkingDirectory = process.cwd();
    process.chdir(projectRoot);
    t.after(() => {
        process.chdir(previousWorkingDirectory);
    });
    const prompt = createPromptSequence([
        {
            choice: {
                kind: "add",
            },
        },
        {
            tagType: "compound",
        },
        {
            fieldName: "experiments",
        },
        {
            choice: {
                kind: "field",
                fieldName: "experiments",
            },
        },
        {
            choice: {
                kind: "add",
            },
        },
        {
            tagType: "byte",
        },
        {
            fieldName: "gametest",
        },
        {
            value: "1",
        },
        {
            choice: {
                kind: "up",
            },
        },
        {
            choice: {
                kind: "remove",
            },
        },
        {
            fieldName: "Difficulty",
        },
        {
            remove: true,
        },
        {
            choice: {
                kind: "save",
            },
        },
    ]);
    t.mock.method(console, "log", () => {});

    await runWorldLevelDatEditCommand(
        undefined,
        {},
        {
            canPrompt: () => true,
            prompt,
        },
    );

    const saved = await readBedrockLevelDatFile(levelDatPath);
    const simplified = createBedrockLevelDatDump(saved, "simplified");
    assert.deepEqual(simplified.data, {
        LevelName: "Shared World",
        GameType: 1,
        abilities: {
            mayfly: 1,
        },
        experiments: {
            gametest: 1,
        },
    });

    const worldDirectoryEntries = await readdir(path.dirname(levelDatPath));
    const backupFileName = worldDirectoryEntries.find((entry) =>
        entry.startsWith("level.dat.blr-backup-"),
    );
    assert.ok(backupFileName, "expected a timestamped level.dat backup");
    const backup = await readBedrockLevelDatFile(
        path.join(path.dirname(levelDatPath), backupFileName),
    );
    const backupDump = createBedrockLevelDatDump(backup, "simplified");
    assert.deepEqual(backupDump.data, {
        LevelName: "Shared World",
        GameType: 1,
        Difficulty: 2,
        abilities: {
            mayfly: 1,
        },
    });
});
