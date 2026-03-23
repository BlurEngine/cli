import { access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(scriptDirectory, "..");
const distEntry = path.join(packageRoot, "dist", "blr.js");
const schemaPath = path.join(packageRoot, "schema", "blr.config.schema.json");
const noticePath = path.join(packageRoot, "NOTICE");

async function exists(targetPath) {
    try {
        await access(targetPath);
        return true;
    } catch {
        return false;
    }
}

function runBuild() {
    const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
    const result = spawnSync(npmCommand, ["run", "build"], {
        cwd: packageRoot,
        stdio: "inherit",
    });
    if (result.status !== 0 || result.error) {
        process.exit(result.status ?? 1);
    }
}

if (
    (await exists(distEntry)) &&
    (await exists(schemaPath)) &&
    (await exists(noticePath))
) {
    console.log("[prepare] Package artifacts already present, skipping build.");
    process.exit(0);
}

runBuild();
