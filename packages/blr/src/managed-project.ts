export const MANAGED_PACKAGE_SCRIPTS = {
    dev: "blr dev",
    build: "blr build",
    package: "blr package",
    minecraft: "blr minecraft",
    system: "blr system",
    world: "blr world",
    clean: "blr clean",
    upgrade: "blr upgrade",
} as const;

const GITIGNORE_MANAGED_BEGIN = "# BEGIN MANAGED BY @blurengine/cli";
const GITIGNORE_MANAGED_END = "# END MANAGED BY @blurengine/cli";
const MANAGED_GITIGNORE_LINES = [
    "node_modules/",
    "dist/",
    ".blr/",
    "worlds/",
    ".tmp-*",
    ".env.local",
    ".DS_Store",
] as const;

type PackageJsonLike = {
    scripts?: Record<string, string>;
};

export type ManagedPackageScriptChange = {
    name: string;
    from: string | undefined;
    to: string;
};

export function applyManagedPackageScripts(
    pkg: PackageJsonLike,
): ManagedPackageScriptChange[] {
    const scripts: Record<string, string> = { ...(pkg.scripts ?? {}) };
    const changes: ManagedPackageScriptChange[] = [];

    for (const [name, value] of Object.entries(MANAGED_PACKAGE_SCRIPTS)) {
        const current = scripts[name];
        if (current !== value) {
            changes.push({ name, from: current, to: value });
            scripts[name] = value;
        }
    }

    pkg.scripts = scripts;
    return changes;
}

function normalizeLineEndings(content: string): string {
    return content.replace(/\r\n/g, "\n");
}

function stripManagedGitIgnoreBlock(lines: string[]): string[] {
    const result: string[] = [];
    let insideManagedBlock = false;

    for (const line of lines) {
        if (line === GITIGNORE_MANAGED_BEGIN) {
            insideManagedBlock = true;
            continue;
        }
        if (line === GITIGNORE_MANAGED_END) {
            insideManagedBlock = false;
            continue;
        }
        if (insideManagedBlock) {
            continue;
        }
        result.push(line);
    }

    return result;
}

export function renderManagedGitIgnore(): string {
    return [
        GITIGNORE_MANAGED_BEGIN,
        ...MANAGED_GITIGNORE_LINES,
        GITIGNORE_MANAGED_END,
        "",
    ].join("\n");
}

export function reconcileManagedGitIgnore(
    currentContent: string | undefined,
): string {
    const normalized = normalizeLineEndings(currentContent ?? "");
    const existingLines = stripManagedGitIgnoreBlock(normalized.split("\n"));
    const filteredUserLines = existingLines.filter(
        (line) =>
            !MANAGED_GITIGNORE_LINES.includes(
                line as (typeof MANAGED_GITIGNORE_LINES)[number],
            ),
    );

    while (filteredUserLines[0] === "") {
        filteredUserLines.shift();
    }
    while (filteredUserLines[filteredUserLines.length - 1] === "") {
        filteredUserLines.pop();
    }

    const nextLines = [
        GITIGNORE_MANAGED_BEGIN,
        ...MANAGED_GITIGNORE_LINES,
        GITIGNORE_MANAGED_END,
        ...(filteredUserLines.length > 0 ? ["", ...filteredUserLines] : []),
        "",
    ];

    return `${nextLines.join("\n")}`;
}
