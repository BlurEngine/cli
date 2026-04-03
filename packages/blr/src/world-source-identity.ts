import { createHash } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";

async function appendDirectorySignature(
    rootDirectory: string,
    currentDirectory: string,
    hasher: ReturnType<typeof createHash>,
): Promise<void> {
    const entries = await readdir(currentDirectory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
        const fullPath = path.join(currentDirectory, entry.name);
        const relativePath = path
            .relative(rootDirectory, fullPath)
            .split(path.sep)
            .join("/");

        if (entry.isDirectory()) {
            hasher.update(`dir:${relativePath}\n`);
            await appendDirectorySignature(rootDirectory, fullPath, hasher);
            continue;
        }

        if (!entry.isFile()) {
            continue;
        }

        const entryStat = await stat(fullPath);
        hasher.update(
            `file:${relativePath}:${entryStat.size}:${entryStat.mtimeMs}\n`,
        );
    }
}

export async function computeProjectWorldSourceIdentity(
    worldSourceDirectory: string,
): Promise<string | undefined> {
    const dbDirectory = path.join(worldSourceDirectory, "db");
    const dbStat = await stat(dbDirectory).catch(() => undefined);
    if (!dbStat?.isDirectory()) {
        return undefined;
    }

    const hasher = createHash("sha256");
    await appendDirectorySignature(
        worldSourceDirectory,
        worldSourceDirectory,
        hasher,
    );
    return `sha256:${hasher.digest("hex")}`;
}
