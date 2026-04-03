import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { computeProjectWorldSourceIdentity } from "../src/world-source-identity.js";
import { createTempDirectory } from "./helpers.js";

test("computeProjectWorldSourceIdentity returns undefined when the world source has no db directory", async (t) => {
    const projectRoot = await createTempDirectory(t, "blr-world-identity-");
    const worldSourceDirectory = path.join(
        projectRoot,
        "worlds",
        "Bedrock level",
    );
    await mkdir(worldSourceDirectory, { recursive: true });
    await writeFile(path.join(worldSourceDirectory, "levelname.txt"), "hello");

    assert.equal(
        await computeProjectWorldSourceIdentity(worldSourceDirectory),
        undefined,
    );
});

test("computeProjectWorldSourceIdentity is stable for unchanged content and changes after edits", async (t) => {
    const projectRoot = await createTempDirectory(t, "blr-world-identity-");
    const worldSourceDirectory = path.join(
        projectRoot,
        "worlds",
        "Bedrock level",
    );
    await mkdir(path.join(worldSourceDirectory, "db"), { recursive: true });
    await writeFile(path.join(worldSourceDirectory, "levelname.txt"), "hello");

    const firstIdentity =
        await computeProjectWorldSourceIdentity(worldSourceDirectory);
    const secondIdentity =
        await computeProjectWorldSourceIdentity(worldSourceDirectory);

    assert.ok(firstIdentity);
    assert.equal(secondIdentity, firstIdentity);

    await new Promise((resolve) => setTimeout(resolve, 20));
    await writeFile(
        path.join(worldSourceDirectory, "levelname.txt"),
        "hello again",
    );

    const nextIdentity =
        await computeProjectWorldSourceIdentity(worldSourceDirectory);
    assert.ok(nextIdentity);
    assert.notEqual(nextIdentity, firstIdentity);
});
