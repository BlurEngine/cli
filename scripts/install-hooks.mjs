import {
    chmodSync,
    copyFileSync,
    existsSync,
    mkdirSync,
    readFileSync,
    statSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDirectory, "..");
const gitDirectory = path.join(repoRoot, ".git");
const sourceHook = path.join(repoRoot, "tools", "hooks", "pre-commit");

function resolveGitDirectory(gitPath) {
    if (!existsSync(gitPath)) {
        return undefined;
    }

    const stats = statSync(gitPath);
    if (stats.isDirectory()) {
        return gitPath;
    }

    const content = readFileSync(gitPath, "utf8").trim();
    const match = /^gitdir:\s*(.+)$/i.exec(content);
    if (!match) {
        throw new Error(`[hooks] Unsupported .git file format at ${gitPath}.`);
    }
    return path.resolve(repoRoot, match[1]);
}

const resolvedGitDirectory = resolveGitDirectory(gitDirectory);

if (!resolvedGitDirectory) {
    console.warn("[hooks] Skipping hook installation because .git is missing.");
    process.exit(0);
}

const targetHooksDirectory = path.join(resolvedGitDirectory, "hooks");
const targetHook = path.join(targetHooksDirectory, "pre-commit");

mkdirSync(targetHooksDirectory, { recursive: true });
copyFileSync(sourceHook, targetHook);
chmodSync(targetHook, 0o755);
console.log("[hooks] Installed .git/hooks/pre-commit");
