import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { exists, readText, writeText } from "./fs.js";

const MANAGED_AGENTS_MARKER = "<!-- Managed by @blurengine/cli -->";
const ROOT_AGENTS_FILE = "AGENTS.md";
const PROJECT_AGENTS_FILE = "AGENTS.project.md";

type StandardDocument = {
    fileName: string;
    content: string;
};

function resolvePackageRoot(importMetaUrl: string): string {
    return path.resolve(fileURLToPath(new URL(".", importMetaUrl)), "..", "..");
}

function normalizeLineEndings(content: string): string {
    return content.replace(/\r\n/g, "\n");
}

function renderProjectAgentsStub(): string {
    return [
        "# Project Agent Rules",
        "",
        "Add project-specific instructions here.",
        "",
        "Examples:",
        "",
        "- gameplay rules unique to this project",
        "- naming conventions beyond BlurEngine defaults",
        "- content boundaries or migration requirements",
        "",
        "This file is user-owned and should not be overwritten by `blr upgrade`.",
        "",
    ].join("\n");
}

function renderManagedAgentsFile(standards: StandardDocument[]): string {
    const managedSections = standards.flatMap((document, index) => {
        const lines = [
            `## Managed Standard: ${document.fileName}`,
            "",
            document.content,
        ];
        if (index < standards.length - 1) {
            lines.push("", "---", "");
        }
        return lines;
    });

    return [
        MANAGED_AGENTS_MARKER,
        "",
        "# BlurEngine Project Instructions",
        "",
        "This file is managed by `@blurengine/cli`.",
        "",
        "If `AGENTS.project.md` exists, read it after this file. It contains project-specific rules that refine or override the shared BlurEngine defaults.",
        "",
        "Instruction precedence for this project should be treated as:",
        "",
        "1. direct user instructions",
        "2. `AGENTS.project.md`",
        "3. the managed instructions in this file",
        "",
        "Do not put project-specific instructions in this file. Put them in `AGENTS.project.md`.",
        "",
        "## Managed Standards",
        "",
        "The sections below are compiled from the packaged BlurEngine standards and refreshed by `blr upgrade`.",
        "",
        ...managedSections,
        "",
    ].join("\n");
}

async function listStandardSourceFiles(packageRoot: string): Promise<string[]> {
    const sourceDirectory = path.join(packageRoot, "docs", "standards");
    if (!(await exists(sourceDirectory))) {
        throw new Error(
            `Cannot find packaged standards directory: ${sourceDirectory}`,
        );
    }

    const entries = await readdir(sourceDirectory, { withFileTypes: true });
    return entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
        .map((entry) => path.join(sourceDirectory, entry.name))
        .sort((left, right) => left.localeCompare(right));
}

async function loadStandardDocuments(
    packageRoot: string,
): Promise<StandardDocument[]> {
    const sourceFiles = await listStandardSourceFiles(packageRoot);
    return Promise.all(
        sourceFiles.map(async (sourceFile) => ({
            fileName: path.basename(sourceFile),
            content: normalizeLineEndings((await readText(sourceFile)).trim()),
        })),
    );
}

async function resolveProjectAgentsContent(
    projectRoot: string,
): Promise<string> {
    const projectAgentsPath = path.join(projectRoot, PROJECT_AGENTS_FILE);
    if (await exists(projectAgentsPath)) {
        return normalizeLineEndings(await readText(projectAgentsPath)).trim();
    }

    return renderProjectAgentsStub().trim();
}

export async function syncManagedProjectInstructions(
    projectRoot: string,
    importMetaUrl: string,
): Promise<void> {
    const packageRoot = resolvePackageRoot(importMetaUrl);
    const rootAgentsPath = path.join(projectRoot, ROOT_AGENTS_FILE);
    const projectAgentsPath = path.join(projectRoot, PROJECT_AGENTS_FILE);
    const standards = await loadStandardDocuments(packageRoot);
    const projectAgentsContent = await resolveProjectAgentsContent(projectRoot);

    await writeText(rootAgentsPath, renderManagedAgentsFile(standards));
    await writeText(
        projectAgentsPath,
        `${projectAgentsContent.replace(/\n*$/, "\n")}`,
    );
}
