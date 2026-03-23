import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(scriptDirectory, "..");
const workspaceRoot = path.resolve(packageRoot, "..", "..");

const legalFiles = ["LICENSE", "NOTICE"];

for (const fileName of legalFiles) {
    const sourcePath = path.join(workspaceRoot, fileName);
    const targetPath = path.join(packageRoot, fileName);
    await mkdir(path.dirname(targetPath), { recursive: true });
    await copyFile(sourcePath, targetPath);
}

console.log("[legal] Synced LICENSE and NOTICE into packages/blr");
