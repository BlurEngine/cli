import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
    copyFile,
    lstat,
    mkdir,
    mkdtemp,
    readdir,
    rm,
    stat,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { WorldSourceIdentity } from "../world-processing.js";

export type WorldSourceInventoryEntry = {
    readonly relativePath: string;
    readonly size: number;
    readonly mtimeMs: number;
    readonly contentHash: string;
};

export type VerifiedWorldSnapshot = {
    readonly worldDirectory: string;
    readonly dbPath: string;
    readonly sourceIdentity: WorldSourceIdentity;
    readonly inventory: readonly WorldSourceInventoryEntry[];
};

export type VerifiedWorldSnapshotHooks = {
    /** Test/debug seam run after the copy and before source re-inventory. */
    readonly afterCopy?: () => void | Promise<void>;
};

export type VerifiedWorldSnapshotOptions = {
    readonly worldName: string;
    readonly sourceWorldDirectory: string;
    readonly sourceRevision?: string;
    readonly sourceVersion?: string;
    readonly tempRoot?: string;
    readonly signal?: AbortSignal;
    readonly hooks?: VerifiedWorldSnapshotHooks;
};

export async function withVerifiedWorldSnapshot<T>(
    options: VerifiedWorldSnapshotOptions,
    operation: (snapshot: VerifiedWorldSnapshot) => Promise<T>,
): Promise<T> {
    const sourceWorldDirectory = path.resolve(options.sourceWorldDirectory);
    const dbStat = await stat(path.join(sourceWorldDirectory, "db")).catch(
        () => undefined,
    );
    if (!dbStat?.isDirectory()) {
        throw new Error(
            `Cannot snapshot ${options.worldName} because its db directory is missing.`,
        );
    }

    const tempRoot = path.resolve(
        options.tempRoot ??
            path.join(os.tmpdir(), "blurengine-world-snapshots"),
    );
    await mkdir(tempRoot, { recursive: true });
    throwIfAborted(options.signal);
    const before = await inventoryWorld(sourceWorldDirectory, options.signal);
    throwIfAborted(options.signal);

    const runDirectory = await mkdtemp(path.join(tempRoot, "snapshot-"));
    const snapshotWorldDirectory = path.join(runDirectory, "world");
    try {
        await copyVerifiedDirectory(
            sourceWorldDirectory,
            snapshotWorldDirectory,
            options.signal,
        );
        await options.hooks?.afterCopy?.();
        throwIfAborted(options.signal);

        const [snapshotInventory, after] = await Promise.all([
            inventoryWorld(snapshotWorldDirectory, options.signal),
            inventoryWorld(sourceWorldDirectory, options.signal),
        ]);
        if (!inventoriesEqual(before, after, true)) {
            throw new Error(
                `World source ${options.worldName} changed while the verified snapshot was being created.`,
            );
        }
        if (!inventoriesEqual(before, snapshotInventory, false)) {
            throw new Error(
                `Verified snapshot for ${options.worldName} does not match its source inventory.`,
            );
        }

        const inventory = Object.freeze(
            snapshotInventory.map((entry) => Object.freeze(entry)),
        );
        const snapshot = Object.freeze({
            worldDirectory: snapshotWorldDirectory,
            dbPath: path.join(snapshotWorldDirectory, "db"),
            sourceIdentity: Object.freeze({
                worldName: options.worldName,
                contentHash: hashLogicalInventory(snapshotInventory),
                ...(options.sourceRevision
                    ? { sourceRevision: options.sourceRevision }
                    : {}),
                ...(options.sourceVersion
                    ? { sourceVersion: options.sourceVersion }
                    : {}),
            }),
            inventory,
        });
        return await operation(snapshot);
    } finally {
        await removeSnapshotDirectory(runDirectory, tempRoot);
    }
}

async function inventoryWorld(
    root: string,
    signal?: AbortSignal,
): Promise<WorldSourceInventoryEntry[]> {
    const entries: WorldSourceInventoryEntry[] = [];
    await visit("");
    return entries.sort((left, right) =>
        left.relativePath.localeCompare(right.relativePath),
    );

    async function visit(relativeDirectory: string): Promise<void> {
        throwIfAborted(signal);
        const absoluteDirectory = path.join(root, relativeDirectory);
        const children = await readdir(absoluteDirectory, {
            withFileTypes: true,
        });
        children.sort((left, right) => left.name.localeCompare(right.name));
        for (const child of children) {
            throwIfAborted(signal);
            const relativePath = path
                .join(relativeDirectory, child.name)
                .replace(/\\/g, "/");
            const absolutePath = path.join(root, relativePath);
            const details = await lstat(absolutePath);
            if (details.isSymbolicLink()) {
                throw new Error(
                    `World source contains symbolic link ${relativePath}; verified snapshots do not follow links.`,
                );
            }
            if (details.isDirectory()) {
                await visit(relativePath);
            } else if (details.isFile()) {
                entries.push({
                    relativePath,
                    size: details.size,
                    mtimeMs: details.mtimeMs,
                    contentHash: await hashFile(absolutePath, signal),
                });
            } else {
                throw new Error(
                    `World source contains unsupported filesystem entry ${relativePath}.`,
                );
            }
        }
    }
}

async function copyVerifiedDirectory(
    sourceRoot: string,
    destinationRoot: string,
    signal?: AbortSignal,
): Promise<void> {
    await mkdir(destinationRoot, { recursive: true });
    await copyChildren("");

    async function copyChildren(relativeDirectory: string): Promise<void> {
        throwIfAborted(signal);
        const children = await readdir(
            path.join(sourceRoot, relativeDirectory),
            {
                withFileTypes: true,
            },
        );
        children.sort((left, right) => left.name.localeCompare(right.name));
        for (const child of children) {
            throwIfAborted(signal);
            const relativePath = path.join(relativeDirectory, child.name);
            const sourcePath = path.join(sourceRoot, relativePath);
            const destinationPath = path.join(destinationRoot, relativePath);
            const details = await lstat(sourcePath);
            if (details.isSymbolicLink()) {
                throw new Error(
                    `World source contains symbolic link ${relativePath.replace(/\\/g, "/")}; verified snapshots do not follow links.`,
                );
            }
            if (details.isDirectory()) {
                await mkdir(destinationPath, { recursive: true });
                await copyChildren(relativePath);
            } else if (details.isFile()) {
                await copyFile(sourcePath, destinationPath);
            } else {
                throw new Error(
                    `World source contains unsupported filesystem entry ${relativePath.replace(/\\/g, "/")}.`,
                );
            }
        }
    }
}

async function hashFile(
    filePath: string,
    signal?: AbortSignal,
): Promise<string> {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(filePath, { signal })) {
        hash.update(chunk);
    }
    return hash.digest("hex");
}

function inventoriesEqual(
    left: readonly WorldSourceInventoryEntry[],
    right: readonly WorldSourceInventoryEntry[],
    includeMtime: boolean,
): boolean {
    return (
        left.length === right.length &&
        left.every((entry, index) => {
            const candidate = right[index];
            return (
                candidate?.relativePath === entry.relativePath &&
                candidate.size === entry.size &&
                candidate.contentHash === entry.contentHash &&
                (!includeMtime || candidate.mtimeMs === entry.mtimeMs)
            );
        })
    );
}

function hashLogicalInventory(
    inventory: readonly WorldSourceInventoryEntry[],
): string {
    const hash = createHash("sha256");
    for (const entry of inventory) {
        hash.update(entry.relativePath);
        hash.update("\0");
        hash.update(String(entry.size));
        hash.update("\0");
        hash.update(entry.contentHash);
        hash.update("\n");
    }
    return hash.digest("hex");
}

async function removeSnapshotDirectory(
    runDirectory: string,
    tempRoot: string,
): Promise<void> {
    const relative = path.relative(tempRoot, runDirectory);
    if (
        relative.length === 0 ||
        relative.startsWith("..") ||
        path.isAbsolute(relative)
    ) {
        throw new Error("Refusing to remove a snapshot outside its temp root.");
    }
    await rm(runDirectory, { recursive: true, force: true });
}

function throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) {
        throw signal.reason instanceof Error
            ? signal.reason
            : new DOMException("World snapshot was aborted.", "AbortError");
    }
}
