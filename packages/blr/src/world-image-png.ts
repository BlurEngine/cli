import { writeFile } from "node:fs/promises";
import { PNG } from "pngjs";
import { ensureParentDirectory } from "./fs.js";

export type RgbaImageData = {
    width: number;
    height: number;
    data: Uint8Array;
};

export async function writePngImage(
    image: RgbaImageData,
    outputPath: string,
): Promise<void> {
    if (image.width <= 0 || image.height <= 0) {
        throw new Error("Cannot write a PNG with empty dimensions.");
    }
    if (image.data.length !== image.width * image.height * 4) {
        throw new Error(
            `Cannot write PNG because image data length ${image.data.length} does not match ${image.width}x${image.height} RGBA pixels.`,
        );
    }

    const png = new PNG({
        width: image.width,
        height: image.height,
    });
    Buffer.from(image.data).copy(png.data);

    await ensureParentDirectory(outputPath);
    await writeFile(outputPath, PNG.sync.write(png));
}
