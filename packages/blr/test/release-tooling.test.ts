import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

type PackageJson = {
    packageManager?: string;
    devDependencies?: Record<string, string>;
};

type ChangesetConfig = {
    $schema?: string;
};

const packageRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
);
const workspaceRoot = path.resolve(packageRoot, "..", "..");

async function readJson<T>(filePath: string): Promise<T> {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
}

test("release tooling uses the Changesets v3 action contract", async () => {
    const packageJson = await readJson<PackageJson>(
        path.join(workspaceRoot, "package.json"),
    );
    const changesetConfig = await readJson<ChangesetConfig>(
        path.join(workspaceRoot, ".changeset", "config.json"),
    );
    const publishWorkflow = await readFile(
        path.join(workspaceRoot, ".github", "workflows", "publish.yml"),
        "utf8",
    );

    assert.match(
        packageJson.packageManager ?? "",
        /^npm@(?:1[1-9]|[2-9]\d|10\.(?:9|[1-9]\d))(?:\.|$)/,
    );
    assert.match(
        packageJson.devDependencies?.["@changesets/cli"] ?? "",
        /^\^3\./,
    );
    assert.match(
        packageJson.devDependencies?.["@changesets/changelog-github"] ?? "",
        /^\^1\./,
    );
    assert.equal(
        changesetConfig.$schema,
        "https://unpkg.com/@changesets/config@4.0.0/schema.json",
    );

    assert.match(publishWorkflow, /uses: changesets\/action@v2/);
    assert.match(
        publishWorkflow,
        /github-token: \$\{\{ secrets\.GITHUB_TOKEN \}\}/,
    );
    assert.match(publishWorkflow, /commit-message: "chore: version packages"/);
    assert.match(publishWorkflow, /pr-title: "chore: version packages"/);
    assert.match(publishWorkflow, /version-script: npm run version-packages/);
    assert.doesNotMatch(publishWorkflow, /^\s+commit:/m);
    assert.doesNotMatch(publishWorkflow, /^\s+title:/m);
    assert.doesNotMatch(publishWorkflow, /^\s+version:/m);
});
