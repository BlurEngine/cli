import {
    access,
    copyFile,
    mkdir,
    readFile,
    readdir,
    rm,
    stat,
    writeFile,
} from "node:fs/promises";
import path from "node:path";

export async function exists(targetPath: string): Promise<boolean> {
    try {
        await access(targetPath);
        return true;
    } catch {
        return false;
    }
}

export async function isDirectoryEmpty(targetPath: string): Promise<boolean> {
    if (!(await exists(targetPath))) return true;
    const entries = await readdir(targetPath);
    return entries.length === 0;
}

export async function isDirectoryEmptyExcept(
    targetPath: string,
    ignoredNames: string[] = [],
): Promise<boolean> {
    if (!(await exists(targetPath))) return true;
    const ignored = new Set(ignoredNames);
    const entries = await readdir(targetPath);
    return entries.filter((entry) => !ignored.has(entry)).length === 0;
}

export async function isDirectory(targetPath: string): Promise<boolean> {
    try {
        return (await stat(targetPath)).isDirectory();
    } catch {
        return false;
    }
}

export async function ensureDirectory(targetPath: string): Promise<void> {
    await mkdir(targetPath, { recursive: true });
}

export async function ensureParentDirectory(targetPath: string): Promise<void> {
    await ensureDirectory(path.dirname(targetPath));
}

export async function writeText(
    targetPath: string,
    content: string,
): Promise<void> {
    await ensureParentDirectory(targetPath);
    await writeFile(targetPath, content, "utf8");
}

export async function writeJson(
    targetPath: string,
    value: unknown,
): Promise<void> {
    const rendered = `${JSON.stringify(value, null, 2)}\n`;
    await writeText(targetPath, rendered);
}

export async function readText(targetPath: string): Promise<string> {
    return readFile(targetPath, "utf8");
}

export async function readJson<T>(targetPath: string): Promise<T> {
    const raw = await readText(targetPath);
    return JSON.parse(raw) as T;
}

export async function removeDirectory(targetPath: string): Promise<void> {
    await rm(targetPath, { recursive: true, force: true });
}

export async function removePath(targetPath: string): Promise<void> {
    await rm(targetPath, { recursive: true, force: true });
}

async function copyDirectoryContents(
    sourcePath: string,
    destinationPath: string,
): Promise<void> {
    const entries = await readdir(sourcePath, { withFileTypes: true });

    for (const entry of entries) {
        const source = path.join(sourcePath, entry.name);
        const destination = path.join(destinationPath, entry.name);

        if (entry.isDirectory()) {
            await ensureDirectory(destination);
            await copyDirectoryContents(source, destination);
            continue;
        }

        if (entry.isFile()) {
            await ensureParentDirectory(destination);
            await copyFile(source, destination);
            continue;
        }

        const entryStat = await stat(source);
        if (entryStat.isDirectory()) {
            await ensureDirectory(destination);
            await copyDirectoryContents(source, destination);
            continue;
        }

        await ensureParentDirectory(destination);
        await copyFile(source, destination);
    }
}

export async function copyDirectory(
    sourcePath: string,
    destinationPath: string,
): Promise<void> {
    await removeDirectory(destinationPath);
    await ensureDirectory(destinationPath);
    await copyDirectoryContents(sourcePath, destinationPath);
}

export async function removeFilesNamed(
    rootPath: string,
    fileName: string,
): Promise<void> {
    if (!(await exists(rootPath))) return;

    const entries = await readdir(rootPath, { withFileTypes: true });
    for (const entry of entries) {
        const targetPath = path.join(rootPath, entry.name);
        if (entry.isDirectory()) {
            await removeFilesNamed(targetPath, fileName);
            continue;
        }

        if (entry.isFile() && entry.name === fileName) {
            await rm(targetPath, { force: true });
        }
    }
}

export async function listDirectories(targetPath: string): Promise<string[]> {
    if (!(await exists(targetPath))) return [];
    const entries = await readdir(targetPath, { withFileTypes: true });
    return entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
}
