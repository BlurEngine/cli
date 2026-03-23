import path from "node:path";
import {
    BASELINE_BEBE_DEPENDENCIES,
    BASELINE_DEPENDENCIES,
    BASELINE_DEV_DEPENDENCIES,
} from "../constants.js";
import { loadBlurConfig } from "../config.js";
import { exists, readJson, writeJson } from "../fs.js";
import { syncManagedProjectInstructions } from "../project-instructions.js";
import { upgradeProjectScaffold } from "../project-upgrade.js";
import { getCliPackageVersion } from "../utils.js";

type UpgradeCommandOptions = {
    dryRun?: boolean;
    refreshAgents?: boolean;
    refreshDependencies?: boolean;
};

type PackageJson = {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
};

type Change = {
    scope: "dependencies" | "devDependencies";
    name: string;
    from: string | undefined;
    to: string;
};

function applyBaselineVersions(pkg: PackageJson, cliVersion: string): Change[] {
    const changes: Change[] = [];
    const dependencies: Record<string, string> = {
        ...(pkg.dependencies ?? {}),
    };
    const devDependencies: Record<string, string> = {
        ...(pkg.devDependencies ?? {}),
    };

    const dependencyBaseline = Object.fromEntries(
        Object.entries(BASELINE_DEPENDENCIES).map(([name, version]) => [
            name,
            version,
        ]),
    );
    if (typeof dependencies["@blurengine/bebe"] === "string") {
        Object.assign(dependencyBaseline, BASELINE_BEBE_DEPENDENCIES);
    }
    const devDependencyBaseline = {
        ...BASELINE_DEV_DEPENDENCIES,
        "@blurengine/cli": `^${cliVersion}`,
    };

    for (const [name, version] of Object.entries(dependencyBaseline)) {
        const current = dependencies[name];
        if (typeof current === "string" && current.startsWith("file:")) {
            continue;
        }
        if (current !== version) {
            changes.push({
                scope: "dependencies",
                name,
                from: current,
                to: version,
            });
            dependencies[name] = version;
        }
    }

    for (const [name, version] of Object.entries(devDependencyBaseline)) {
        const current = devDependencies[name];
        if (typeof current === "string" && current.startsWith("file:")) {
            continue;
        }
        if (current !== version) {
            changes.push({
                scope: "devDependencies",
                name,
                from: current,
                to: version,
            });
            devDependencies[name] = version;
        }
    }

    pkg.dependencies = dependencies;
    pkg.devDependencies = devDependencies;
    return changes;
}

function printChanges(changes: Change[], dryRun: boolean): void {
    if (changes.length === 0) {
        console.log(
            "[upgrade] Project is already aligned with current baseline.",
        );
        return;
    }

    console.log(
        `[upgrade] ${dryRun ? "Planned" : "Applied"} changes (${changes.length}):`,
    );
    for (const change of changes) {
        const from =
            typeof change.from === "string" ? change.from : "(missing)";
        console.log(
            `  ${change.scope}.${change.name}: ${from} -> ${change.to}`,
        );
    }
}

export async function runUpgradeCommand(
    options: UpgradeCommandOptions,
): Promise<void> {
    const packageJsonPath = path.resolve(process.cwd(), "package.json");
    if (!(await exists(packageJsonPath))) {
        throw new Error("Cannot find package.json in current directory.");
    }
    const projectRoot = process.cwd();
    const { config } = await loadBlurConfig(projectRoot, {
        allowProjectVersionMismatch: true,
    });
    const refreshAgents = options.refreshAgents ?? config.upgrade.refreshAgents;
    const refreshDependencies =
        options.refreshDependencies ?? config.upgrade.refreshDependencies;

    const scaffoldUpgrade = await upgradeProjectScaffold(
        projectRoot,
        packageJsonPath,
        Boolean(options.dryRun),
    );
    if (scaffoldUpgrade.migrationChanges.length > 0) {
        console.log(
            `[upgrade] ${
                options.dryRun ? "Planned" : "Applied"
            } project migrations (${scaffoldUpgrade.migrationChanges.length}):`,
        );
        for (const change of scaffoldUpgrade.migrationChanges) {
            if (change.scope === "projectVersion") {
                console.log(`  projectVersion: ${change.from} -> ${change.to}`);
                continue;
            }
            if (change.action === "move") {
                console.log(
                    `  ${change.fileName}: moved to server/${change.fileName}`,
                );
                continue;
            }
            console.log(`  ${change.fileName}: removed duplicate root file`);
        }
    }
    for (const change of scaffoldUpgrade.managedFileChanges) {
        if (change.scope === "packageScripts") {
            console.log(
                `[upgrade] ${options.dryRun ? "Planned" : "Applied"} managed package scripts (${change.changes.length}):`,
            );
            for (const scriptChange of change.changes) {
                const from =
                    typeof scriptChange.from === "string"
                        ? scriptChange.from
                        : "(missing)";
                console.log(
                    `  scripts.${scriptChange.name}: ${from} -> ${scriptChange.to}`,
                );
            }
            continue;
        }
        if (change.scope === "configSchema") {
            console.log(
                `[upgrade] ${options.dryRun ? "Planned" : "Applied"} blr.config.json schema reference.`,
            );
            continue;
        }
        console.log(
            `[upgrade] ${options.dryRun ? "Planned" : "Applied"} managed .gitignore block.`,
        );
    }

    let changes: Change[] = [];
    if (refreshDependencies) {
        const cliVersion = await getCliPackageVersion();
        const packageJson = await readJson<PackageJson>(packageJsonPath);
        changes = applyBaselineVersions(packageJson, cliVersion);
        printChanges(changes, Boolean(options.dryRun));

        if (!options.dryRun && changes.length > 0) {
            await writeJson(packageJsonPath, packageJson);
            console.log("[upgrade] package.json updated.");
        }
    } else {
        console.log("[upgrade] Dependency refresh disabled.");
    }

    if (options.dryRun) {
        console.log(
            `[upgrade] Managed AGENTS refresh ${
                refreshAgents
                    ? "skipped during dry-run"
                    : "disabled for this run"
            }.`,
        );
        return;
    }

    if (!refreshAgents) {
        console.log("[upgrade] Managed AGENTS refresh disabled.");
        return;
    }

    try {
        await syncManagedProjectInstructions(projectRoot, import.meta.url);
        console.log("[upgrade] Managed AGENTS refreshed.");
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[upgrade] ${message}`);
    }
}
