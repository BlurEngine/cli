#!/usr/bin/env node
import { Command, InvalidOptionArgumentError } from "commander";
import { runBuildCommand } from "./commands/build.js";
import { runCleanCommand } from "./commands/clean.js";
import { runCreateCommand } from "./commands/create.js";
import { runDevCommand } from "./commands/dev.js";
import {
    runMinecraftCheckCommand,
    runMinecraftUpdateCommand,
} from "./commands/minecraft.js";
import { runPackageCommand } from "./commands/package.js";
import {
    resolveSystemOutputFormat,
    runSystemDoctorCommand,
    runSystemInfoCommand,
} from "./commands/system.js";
import { runUpgradeCommand } from "./commands/upgrade.js";
import {
    runWorldCaptureCommand,
    runWorldLockCommand,
    runWorldPullCommand,
    runWorldPushCommand,
    runWorldStatusCommand,
    runWorldUnlockCommand,
    runWorldUseCommand,
} from "./commands/world.js";
import { isPromptCancelledError } from "./prompt.js";

function parseOptionalBoolean(value: string | boolean | undefined): boolean {
    if (value === undefined || value === true) return true;
    if (typeof value === "boolean") return value;
    const normalized = value.trim().toLowerCase();
    if (
        normalized === "true" ||
        normalized === "1" ||
        normalized === "yes" ||
        normalized === "on"
    ) {
        return true;
    }
    if (
        normalized === "false" ||
        normalized === "0" ||
        normalized === "no" ||
        normalized === "off"
    ) {
        return false;
    }
    throw new InvalidOptionArgumentError(
        `Expected boolean value for option, received "${value}". Use true or false.`,
    );
}

async function main(): Promise<void> {
    const program = new Command();

    program.name("blr").description("BlurEngine project CLI");
    program.showHelpAfterError();

    program
        .command("create")
        .description("Scaffold a new BlurEngine project.")
        .argument("[projectName]", "Name of the project directory to create")
        .option("--namespace <namespace>", "Required project namespace")
        .option("--package-manager <packageManager>", "npm | pnpm | yarn | bun")
        .option(
            "--behavior-pack [enabled]",
            "Generate or skip the behavior pack scaffold (default: true when omitted)",
            parseOptionalBoolean,
        )
        .option(
            "--resource-pack [enabled]",
            "Generate or skip the resource pack scaffold (default: true when omitted)",
            parseOptionalBoolean,
        )
        .option(
            "--scripts [enabled]",
            "Generate or skip scripting source and behavior-pack script setup (default: true when omitted)",
            parseOptionalBoolean,
        )
        .option(
            "--bebe [enabled]",
            "Generate or skip @blurengine/bebe scaffolding when scripting is enabled (default: false when omitted)",
            parseOptionalBoolean,
        )
        .option("--language <language>", "ts | js")
        .option("--yes", "Skip prompts and require flags/arguments", false)
        .option("--force", "Replace existing non-empty target directory", false)
        .option("--install", "Install dependencies after scaffolding")
        .option("--no-install", "Skip dependency installation")
        .action(
            async (
                projectName: string | undefined,
                opts: Record<string, unknown>,
            ) => {
                await runCreateCommand(projectName, opts as any);
            },
        );

    program
        .command("dev")
        .description("Run the interactive or one-shot development workflow.")
        .option(
            "--interactive [enabled]",
            "Enable or disable interactive checklist (default: true when omitted)",
            parseOptionalBoolean,
        )
        .option(
            "--local-deploy [enabled]",
            "Enable or disable local deployment step (falls back to config when omitted)",
            parseOptionalBoolean,
        )
        .option(
            "--local-deploy-behavior-pack [enabled]",
            "Enable or disable behavior-pack deployment for this run",
            parseOptionalBoolean,
        )
        .option(
            "--local-deploy-resource-pack [enabled]",
            "Enable or disable resource-pack deployment for this run",
            parseOptionalBoolean,
        )
        .option(
            "--local-server [enabled]",
            "Enable or disable local server step (falls back to config when omitted)",
            parseOptionalBoolean,
        )
        .option(
            "--local-server-behavior-pack [enabled]",
            "Enable or disable behavior-pack sync into the local server for this run",
            parseOptionalBoolean,
        )
        .option(
            "--local-server-resource-pack [enabled]",
            "Enable or disable resource-pack sync into the local server for this run",
            parseOptionalBoolean,
        )
        .option(
            "--attach-behavior-pack [enabled]",
            "Enable or disable behavior-pack attachment in local-server world pack hooks for this run",
            parseOptionalBoolean,
        )
        .option(
            "--attach-resource-pack [enabled]",
            "Enable or disable resource-pack attachment in local-server world pack hooks for this run",
            parseOptionalBoolean,
        )
        .option(
            "--watch [enabled]",
            "Enable or disable watch mode (default: true when omitted)",
            parseOptionalBoolean,
        )
        .option(
            "--watch-scripts [enabled]",
            "Enable or disable source/packs watch and rebuild-reload behavior",
            parseOptionalBoolean,
        )
        .option(
            "--watch-world [enabled]",
            "Enable or disable runtime world capture back into the project world source",
            parseOptionalBoolean,
        )
        .option(
            "--watch-allowlist [enabled]",
            "Enable or disable runtime allowlist capture back into project state",
            parseOptionalBoolean,
        )
        .option(
            "--production [enabled]",
            "Enable or disable production bundling (default: false when omitted)",
            parseOptionalBoolean,
        )
        .option(
            "--minecraft-product <product>",
            "Override local deploy target: BedrockUWP | PreviewUWP | BedrockGDK | PreviewGDK | Custom | auto",
        )
        .option(
            "--minecraft-development-path <path>",
            "Override local deploy root for this run",
        )
        .option(
            "--bds-version <version>",
            "Override the BDS version for this run",
        )
        .option(
            "--bds-platform <platform>",
            "Override BDS platform: win | linux | auto",
        )
        .option(
            "--bds-cache-dir <path>",
            "Override BDS cache directory for this run",
        )
        .option(
            "--bds-server-dir <path>",
            "Override BDS server directory for this run",
        )
        .option(
            "--world <worldName>",
            "Override the active world for this dev run",
        )
        .option(
            "--restart-on-world-change [enabled]",
            "Enable or disable full server restart when the project world source changes",
            parseOptionalBoolean,
        )
        .option(
            "--debug [enabled]",
            "Enable or disable debug logs for dev lifecycle activity",
            parseOptionalBoolean,
        )
        .action(async (opts: Record<string, unknown>) => {
            await runDevCommand(opts as any);
        });

    program
        .command("build")
        .description("Run one-shot build tasks.")
        .option(
            "--production [enabled]",
            "Enable or disable production bundling (default: false when omitted)",
            parseOptionalBoolean,
        )
        .option(
            "--local-deploy [enabled]",
            "Enable or disable local deployment after build (default: false when omitted)",
            parseOptionalBoolean,
        )
        .option(
            "--local-deploy-behavior-pack [enabled]",
            "Enable or disable behavior-pack deployment for this run",
            parseOptionalBoolean,
        )
        .option(
            "--local-deploy-resource-pack [enabled]",
            "Enable or disable resource-pack deployment for this run",
            parseOptionalBoolean,
        )
        .option(
            "--minecraft-product <product>",
            "Override local deploy target: BedrockUWP | PreviewUWP | BedrockGDK | PreviewGDK | Custom | auto",
        )
        .option(
            "--minecraft-development-path <path>",
            "Override local deploy root for this run",
        )
        .option(
            "--debug [enabled]",
            "Enable or disable debug logs for build/deploy activity",
            parseOptionalBoolean,
        )
        .action(async (opts: Record<string, unknown>) => {
            await runBuildCommand(opts as any);
        });

    program
        .command("package")
        .description("Produce distributable project artifacts.")
        .argument(
            "[target]",
            "Packaging target. Currently supported: world-template",
        )
        .option(
            "--production [enabled]",
            "Enable or disable production bundling before packaging (default: false when omitted)",
            parseOptionalBoolean,
        )
        .option(
            "--world <worldName>",
            "Override the active world for this packaging run",
        )
        .option(
            "--include-behavior-pack [enabled]",
            "Enable or disable behavior-pack inclusion for this packaging run",
            parseOptionalBoolean,
        )
        .option(
            "--include-resource-pack [enabled]",
            "Enable or disable resource-pack inclusion for this packaging run",
            parseOptionalBoolean,
        )
        .option(
            "--debug [enabled]",
            "Enable or disable debug logs for packaging activity",
            parseOptionalBoolean,
        )
        .action(async (target: string, opts: Record<string, unknown>) => {
            await runPackageCommand(target, opts as any);
        });

    const minecraft = program
        .command("minecraft")
        .description(
            "Manage project Minecraft target-version convenience workflows.",
        );

    const system = program
        .command("system")
        .description(
            "Print safe support diagnostics about the current CLI environment and project.",
        );

    system
        .command("info")
        .description(
            "Print safe environment and project context details for support reports.",
        )
        .option(
            "--format <format>",
            "text | json | markdown",
            resolveSystemOutputFormat,
        )
        .option(
            "--include-paths [enabled]",
            "Include redacted filesystem paths in the output",
            parseOptionalBoolean,
        )
        .option(
            "--include-remote [enabled]",
            "Include remote world backend coordinates when available",
            parseOptionalBoolean,
        )
        .option(
            "--debug [enabled]",
            "Enable or disable debug logs for system diagnostics",
            parseOptionalBoolean,
        )
        .action(async (opts: Record<string, unknown>) => {
            await runSystemInfoCommand(opts as any);
        });

    system
        .command("doctor")
        .description(
            "Run project diagnostics and report actionable warnings or failures.",
        )
        .option(
            "--format <format>",
            "text | json | markdown",
            resolveSystemOutputFormat,
        )
        .option(
            "--include-paths [enabled]",
            "Include redacted filesystem paths in the output",
            parseOptionalBoolean,
        )
        .option(
            "--include-remote [enabled]",
            "Include remote world backend coordinates when available",
            parseOptionalBoolean,
        )
        .option(
            "--debug [enabled]",
            "Enable or disable debug logs for system diagnostics",
            parseOptionalBoolean,
        )
        .action(async (opts: Record<string, unknown>) => {
            await runSystemDoctorCommand(opts as any);
        });

    minecraft
        .command("check")
        .description(
            "Check the configured targetVersion against the latest Bedrock dedicated-server version for the current channel.",
        )
        .option(
            "--debug [enabled]",
            "Enable or disable debug logs for Minecraft version checks",
            parseOptionalBoolean,
        )
        .action(async (opts: Record<string, unknown>) => {
            await runMinecraftCheckCommand(opts as any);
        });

    minecraft
        .command("update")
        .description(
            "Update minecraft.targetVersion to the latest Bedrock dedicated-server version for the current channel.",
        )
        .option("--yes", "Apply the update without confirmation", false)
        .option(
            "--debug [enabled]",
            "Enable or disable debug logs for Minecraft version checks",
            parseOptionalBoolean,
        )
        .action(async (opts: Record<string, unknown>) => {
            await runMinecraftUpdateCommand(opts as any);
        });

    const world = program
        .command("world")
        .description("Manage project world sources and remote backends.");

    world
        .command("use")
        .description("Set the active project world in blr.config.json.")
        .argument(
            "[worldName]",
            "World name. Defaults to dev.localServer.worldName",
        )
        .option(
            "--debug [enabled]",
            "Enable or disable debug logs for world backend activity",
            parseOptionalBoolean,
        )
        .action(
            async (
                worldName: string | undefined,
                opts: Record<string, unknown>,
            ) => {
                await runWorldUseCommand(worldName, opts as any);
            },
        );

    world
        .command("status")
        .description(
            "Describe the configured project world source and remote backend status.",
        )
        .argument(
            "[worldName]",
            "World name. Defaults to dev.localServer.worldName",
        )
        .option(
            "--debug [enabled]",
            "Enable or disable debug logs for world backend activity",
            parseOptionalBoolean,
        )
        .action(
            async (
                worldName: string | undefined,
                opts: Record<string, unknown>,
            ) => {
                await runWorldStatusCommand(worldName, opts as any);
            },
        );

    world
        .command("pull")
        .description(
            "Pull a world from the configured remote backend into the project world source.",
        )
        .argument(
            "[worldName]",
            "World name. Defaults to dev.localServer.worldName",
        )
        .option(
            "--lock [enabled]",
            "Acquire or skip the remote lock while pulling (default: true)",
            parseOptionalBoolean,
        )
        .option(
            "--force-lock [enabled]",
            "Steal the remote world lock when necessary",
            parseOptionalBoolean,
        )
        .option(
            "--reason <reason>",
            "Optional lock reason recorded in remote lock metadata",
        )
        .option(
            "--debug [enabled]",
            "Enable or disable debug logs for world backend activity",
            parseOptionalBoolean,
        )
        .action(
            async (
                worldName: string | undefined,
                opts: Record<string, unknown>,
            ) => {
                await runWorldPullCommand(worldName, opts as any);
            },
        );

    world
        .command("capture")
        .description(
            "Capture the current runtime BDS world into the project world source.",
        )
        .argument(
            "[worldName]",
            "World name. Defaults to dev.localServer.worldName",
        )
        .option(
            "--force [enabled]",
            "Replace the existing project world source when it is already populated",
            parseOptionalBoolean,
        )
        .option(
            "--bds-version <version>",
            "Override the BDS version for this run",
        )
        .option(
            "--bds-platform <platform>",
            "Override BDS platform: win | linux | auto",
        )
        .option(
            "--bds-cache-dir <path>",
            "Override BDS cache directory for this run",
        )
        .option(
            "--bds-server-dir <path>",
            "Override BDS server directory for this run",
        )
        .option(
            "--debug [enabled]",
            "Enable or disable debug logs for world backend activity",
            parseOptionalBoolean,
        )
        .action(
            async (
                worldName: string | undefined,
                opts: Record<string, unknown>,
            ) => {
                await runWorldCaptureCommand(worldName, opts as any);
            },
        );

    world
        .command("push")
        .description(
            "Push the project world source to the configured remote backend.",
        )
        .argument(
            "[worldName]",
            "World name. Defaults to dev.localServer.worldName",
        )
        .option(
            "--unlock [enabled]",
            "Release the remote lock after a successful push (default: true)",
            parseOptionalBoolean,
        )
        .option(
            "--force-lock [enabled]",
            "Steal the remote world lock when necessary",
            parseOptionalBoolean,
        )
        .option(
            "--reason <reason>",
            "Optional lock reason recorded in remote lock metadata",
        )
        .option(
            "--debug [enabled]",
            "Enable or disable debug logs for world backend activity",
            parseOptionalBoolean,
        )
        .action(
            async (
                worldName: string | undefined,
                opts: Record<string, unknown>,
            ) => {
                await runWorldPushCommand(worldName, opts as any);
            },
        );

    world
        .command("lock")
        .description(
            "Acquire the remote world lock without transferring world data.",
        )
        .argument(
            "[worldName]",
            "World name. Defaults to dev.localServer.worldName",
        )
        .option(
            "--force [enabled]",
            "Force lock acquisition when another actor currently holds the lock",
            parseOptionalBoolean,
        )
        .option(
            "--ttl-seconds <seconds>",
            "Override the remote lock TTL for this run",
        )
        .option(
            "--reason <reason>",
            "Optional lock reason recorded in remote lock metadata",
        )
        .option(
            "--debug [enabled]",
            "Enable or disable debug logs for world backend activity",
            parseOptionalBoolean,
        )
        .action(
            async (
                worldName: string | undefined,
                opts: Record<string, unknown>,
            ) => {
                await runWorldLockCommand(worldName, opts as any);
            },
        );

    world
        .command("unlock")
        .description("Release the remote world lock.")
        .argument(
            "[worldName]",
            "World name. Defaults to dev.localServer.worldName",
        )
        .option(
            "--force [enabled]",
            "Force unlock even when another actor currently owns the lock",
            parseOptionalBoolean,
        )
        .option(
            "--debug [enabled]",
            "Enable or disable debug logs for world backend activity",
            parseOptionalBoolean,
        )
        .action(
            async (
                worldName: string | undefined,
                opts: Record<string, unknown>,
            ) => {
                await runWorldUnlockCommand(worldName, opts as any);
            },
        );

    program
        .command("clean")
        .description("Run one-shot clean tasks.")
        .action(async () => {
            await runCleanCommand();
        });

    program
        .command("upgrade")
        .description("Upgrade project dependencies.")
        .option(
            "--dry-run [enabled]",
            "Preview changes only",
            parseOptionalBoolean,
        )
        .option(
            "--refresh-dependencies [enabled]",
            "Enable or disable dependency baseline refresh for this run",
            parseOptionalBoolean,
        )
        .option(
            "--refresh-agents [enabled]",
            "Enable or disable managed AGENTS.md refresh for this run",
            parseOptionalBoolean,
        )
        .action(
            async (opts: {
                dryRun?: boolean;
                refreshDependencies?: boolean;
                refreshAgents?: boolean;
            }) => {
                await runUpgradeCommand(opts);
            },
        );

    await program.parseAsync(process.argv);
}

main().catch((error: unknown) => {
    if (isPromptCancelledError(error)) {
        process.exit(130);
    }
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exit(1);
});
