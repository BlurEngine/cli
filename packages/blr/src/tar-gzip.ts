import { once } from "node:events";
import { createReadStream, createWriteStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { Writable } from "node:stream";
import { createGzip } from "node:zlib";
import { ensureParentDirectory } from "./fs.js";

type TarEntry = {
    absolutePath: string;
    archivePath: string;
    directory: boolean;
    mode: number;
    size: number;
};

async function writeStreamChunk(
    stream: Writable,
    chunk: Buffer,
): Promise<void> {
    if (!stream.write(chunk)) {
        await once(stream, "drain");
    }
}

function writeAscii(
    buffer: Buffer,
    value: string,
    offset: number,
    length: number,
): void {
    buffer.write(value.slice(0, length), offset, length, "ascii");
}

function writeOctal(
    buffer: Buffer,
    value: number,
    offset: number,
    length: number,
): void {
    const rendered = Math.trunc(value)
        .toString(8)
        .padStart(length - 1, "0");
    writeAscii(buffer, rendered.slice(-(length - 1)), offset, length - 1);
    buffer[offset + length - 1] = 0;
}

function splitTarPath(archivePath: string): {
    name: string;
    prefix: string;
} {
    const encoded = Buffer.byteLength(archivePath, "utf8");
    if (encoded <= 100) {
        return { name: archivePath, prefix: "" };
    }

    const segments = archivePath.split("/");
    for (let index = 1; index < segments.length; index += 1) {
        const prefix = segments.slice(0, index).join("/");
        const name = segments.slice(index).join("/");
        if (
            Buffer.byteLength(prefix, "utf8") <= 155 &&
            Buffer.byteLength(name, "utf8") <= 100
        ) {
            return { name, prefix };
        }
    }

    throw new Error(
        `Cannot write ${archivePath} to tar.gz because the archive path is too long.`,
    );
}

function createTarHeader(entry: TarEntry): Buffer {
    const header = Buffer.alloc(512, 0);
    const { name, prefix } = splitTarPath(entry.archivePath);

    writeAscii(header, name, 0, 100);
    writeOctal(header, entry.mode, 100, 8);
    writeOctal(header, 0, 108, 8);
    writeOctal(header, 0, 116, 8);
    writeOctal(header, entry.directory ? 0 : entry.size, 124, 12);
    writeOctal(header, 0, 136, 12);
    header.fill(0x20, 148, 156);
    header[156] = entry.directory ? "5".charCodeAt(0) : "0".charCodeAt(0);
    writeAscii(header, "ustar", 257, 6);
    writeAscii(header, "00", 263, 2);
    writeAscii(header, prefix, 345, 155);

    let checksum = 0;
    for (const byte of header) {
        checksum += byte;
    }
    writeAscii(header, checksum.toString(8).padStart(6, "0"), 148, 6);
    header[154] = 0;
    header[155] = 0x20;

    return header;
}

async function collectTarEntries(
    sourceDirectory: string,
    currentDirectory = sourceDirectory,
    relativeDirectory = "",
): Promise<TarEntry[]> {
    const entries = await readdir(currentDirectory, { withFileTypes: true });
    const collected: TarEntry[] = [];

    for (const entry of entries.sort((left, right) =>
        left.name.localeCompare(right.name),
    )) {
        const absolutePath = path.join(currentDirectory, entry.name);
        const relativePath = path.posix.join(
            relativeDirectory,
            entry.name.replace(/\\/g, "/"),
        );
        const entryStat = await stat(absolutePath);

        if (entryStat.isDirectory()) {
            collected.push({
                absolutePath,
                archivePath: `${relativePath}/`,
                directory: true,
                mode: entryStat.mode & 0o777,
                size: 0,
            });
            collected.push(
                ...(await collectTarEntries(
                    sourceDirectory,
                    absolutePath,
                    relativePath,
                )),
            );
            continue;
        }

        if (entryStat.isFile()) {
            collected.push({
                absolutePath,
                archivePath: relativePath,
                directory: false,
                mode: entryStat.mode & 0o777,
                size: entryStat.size,
            });
        }
    }

    return collected;
}

export async function writeTarGzipFromDirectory(
    sourceDirectory: string,
    outputFile: string,
): Promise<void> {
    await ensureParentDirectory(outputFile);

    const gzip = createGzip();
    const output = createWriteStream(outputFile);
    gzip.pipe(output);

    try {
        for (const entry of await collectTarEntries(sourceDirectory)) {
            await writeStreamChunk(gzip, createTarHeader(entry));

            if (!entry.directory) {
                for await (const chunk of createReadStream(
                    entry.absolutePath,
                )) {
                    await writeStreamChunk(gzip, Buffer.from(chunk));
                }

                const paddingSize = (512 - (entry.size % 512)) % 512;
                if (paddingSize > 0) {
                    await writeStreamChunk(gzip, Buffer.alloc(paddingSize));
                }
            }
        }

        await writeStreamChunk(gzip, Buffer.alloc(1024));
        gzip.end();
        await once(output, "finish");
    } catch (error) {
        gzip.destroy();
        output.destroy();
        throw error;
    }
}
