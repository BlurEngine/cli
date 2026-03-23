import path from "node:path";
import {
    BLR_CONFIG_FILE,
    BLR_CONFIG_SCHEMA_PATH,
    CURRENT_PROJECT_VERSION,
} from "./constants.js";
import {
    applyManagedPackageScripts,
    reconcileManagedGitIgnore as reconcileManagedGitIgnoreContent,
    type ManagedPackageScriptChange,
} from "./managed-project.js";
import {
    exists,
    readJson,
    readText,
    removePath,
    writeJson,
    writeText,
} from "./fs.js";
import { resolveProjectServerStatePath } from "./server-state.js";
import type { BlurConfigFile } from "./types.js";

type PackageJsonShape = {
    scripts?: Record<string, string>;
};

type ManagedFileChange =
    | {
          scope: "packageScripts";
          changes: ManagedPackageScriptChange[];
      }
    | {
          scope: "gitignore";
      }
    | {
          scope: "configSchema";
      };

type MigrationChange =
    | {
          scope: "serverState";
          fileName: "allowlist.json" | "permissions.json";
          action: "move" | "remove-duplicate";
      }
    | {
          scope: "projectVersion";
          from: number;
          to: number;
      };

export type ProjectUpgradeResult = {
    startingProjectVersion: number;
    targetProjectVersion: number;
    migrationChanges: MigrationChange[];
    managedFileChanges: ManagedFileChange[];
};

function ensureMutableRecord(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return {};
    }
    return value as Record<string, unknown>;
}

function normalizeText(content: string): string {
    return content.replace(/\r\n/g, "\n").trimEnd();
}

async function migrateServerStateFile(
    projectRoot: string,
    fileName: "allowlist.json" | "permissions.json",
    dryRun: boolean,
): Promise<MigrationChange | undefined> {
    const legacyPath = path.join(projectRoot, fileName);
    if (!(await exists(legacyPath))) {
        return undefined;
    }

    const targetPath = resolveProjectServerStatePath(projectRoot, fileName);
    if (await exists(targetPath)) {
        const [legacyContent, targetContent] = await Promise.all([
            readText(legacyPath),
            readText(targetPath),
        ]);
        if (normalizeText(legacyContent) !== normalizeText(targetContent)) {
            throw new Error(
                `Cannot migrate ${fileName} because both ${legacyPath} and ${targetPath} exist with different contents. Resolve the conflict manually, keep the server/ version, and rerun "blr upgrade".`,
            );
        }
        if (!dryRun) {
            await removePath(legacyPath);
        }
        return {
            scope: "serverState",
            fileName,
            action: "remove-duplicate",
        };
    }

    if (!dryRun) {
        await writeText(targetPath, await readText(legacyPath));
        await removePath(legacyPath);
    }
    return {
        scope: "serverState",
        fileName,
        action: "move",
    };
}

async function runProjectMigrations(
    projectRoot: string,
    rawConfig: Record<string, unknown>,
    startingProjectVersion: number,
    dryRun: boolean,
): Promise<MigrationChange[]> {
    const changes: MigrationChange[] = [];
    let currentVersion = startingProjectVersion;

    if (currentVersion < 1) {
        const allowlistChange = await migrateServerStateFile(
            projectRoot,
            "allowlist.json",
            dryRun,
        );
        if (allowlistChange) {
            changes.push(allowlistChange);
        }

        const permissionsChange = await migrateServerStateFile(
            projectRoot,
            "permissions.json",
            dryRun,
        );
        if (permissionsChange) {
            changes.push(permissionsChange);
        }

        changes.push({
            scope: "projectVersion",
            from: currentVersion,
            to: 1,
        });
        currentVersion = 1;
    }

    rawConfig.projectVersion = CURRENT_PROJECT_VERSION;
    return changes;
}

async function reconcileManagedConfigMetadata(
    configPath: string,
    dryRun: boolean,
): Promise<ManagedFileChange | undefined> {
    const rawConfig = ensureMutableRecord(await readJson<unknown>(configPath));
    const currentSchema =
        typeof rawConfig.$schema === "string" ? rawConfig.$schema : "";
    if (currentSchema === BLR_CONFIG_SCHEMA_PATH) {
        return undefined;
    }
    rawConfig.$schema = BLR_CONFIG_SCHEMA_PATH;
    if (!dryRun) {
        await writeJson(configPath, rawConfig satisfies BlurConfigFile);
    }
    return { scope: "configSchema" };
}

async function reconcileManagedPackageJson(
    packageJsonPath: string,
    dryRun: boolean,
): Promise<ManagedFileChange | undefined> {
    const packageJson = await readJson<PackageJsonShape>(packageJsonPath);
    const changes = applyManagedPackageScripts(packageJson);
    if (changes.length === 0) {
        return undefined;
    }
    if (!dryRun) {
        await writeJson(packageJsonPath, packageJson);
    }
    return {
        scope: "packageScripts",
        changes,
    };
}

async function reconcileManagedGitIgnoreFile(
    projectRoot: string,
    dryRun: boolean,
): Promise<ManagedFileChange | undefined> {
    const gitIgnorePath = path.join(projectRoot, ".gitignore");
    const currentContent = (await exists(gitIgnorePath))
        ? await readText(gitIgnorePath)
        : undefined;
    const nextContent = reconcileManagedGitIgnoreContent(currentContent);
    if (currentContent === nextContent) {
        return undefined;
    }
    if (!dryRun) {
        await writeText(gitIgnorePath, nextContent);
    }
    return { scope: "gitignore" };
}

export async function upgradeProjectScaffold(
    projectRoot: string,
    packageJsonPath: string,
    dryRun: boolean,
): Promise<ProjectUpgradeResult> {
    const configPath = path.join(projectRoot, BLR_CONFIG_FILE);
    const rawConfig = ensureMutableRecord(await readJson<unknown>(configPath));
    const startingProjectVersion =
        typeof rawConfig.projectVersion === "number" &&
        Number.isInteger(rawConfig.projectVersion)
            ? rawConfig.projectVersion
            : 0;

    const migrationChanges = await runProjectMigrations(
        projectRoot,
        rawConfig,
        startingProjectVersion,
        dryRun,
    );
    if (!dryRun && migrationChanges.length > 0) {
        await writeJson(configPath, rawConfig satisfies BlurConfigFile);
    }

    const managedFileChanges: ManagedFileChange[] = [];
    const configMetadataChange = await reconcileManagedConfigMetadata(
        configPath,
        dryRun,
    );
    if (configMetadataChange) {
        managedFileChanges.push(configMetadataChange);
    }
    const packageJsonChange = await reconcileManagedPackageJson(
        packageJsonPath,
        dryRun,
    );
    if (packageJsonChange) {
        managedFileChanges.push(packageJsonChange);
    }
    const gitIgnoreChange = await reconcileManagedGitIgnoreFile(
        projectRoot,
        dryRun,
    );
    if (gitIgnoreChange) {
        managedFileChanges.push(gitIgnoreChange);
    }

    return {
        startingProjectVersion,
        targetProjectVersion: CURRENT_PROJECT_VERSION,
        migrationChanges,
        managedFileChanges,
    };
}
