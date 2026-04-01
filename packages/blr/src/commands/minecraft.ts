import { loadBlurConfig } from "../config.js";
import { createDebugLogger, resolveDebugEnabled } from "../debug.js";
import { writeMinecraftTargetVersion } from "../minecraft-config.js";
import { resolveMinecraftVersionStatus } from "../minecraft-version.js";
import { runPrompt } from "../prompt.js";

type MinecraftCommandOptions = {
    yes?: boolean;
    debug?: boolean;
};

function renderStatusMessage(
    status: Awaited<ReturnType<typeof resolveMinecraftVersionStatus>>,
): string[] {
    const lines = [
        `[minecraft] Channel: ${status.channel}`,
        `[minecraft] Configured targetVersion: ${status.configuredVersion}`,
        `[minecraft] Latest ${status.channel} dedicated-server version: ${status.latestVersion}`,
    ];

    if (status.looksLikeChannelMismatch) {
        lines.push(
            `[minecraft] Warning: ${status.configuredVersion} appears to resolve on ${status.oppositeChannel}, not ${status.channel}.`,
        );
    } else if (!status.artifactAvailable) {
        lines.push(
            `[minecraft] Warning: ${status.configuredVersion} could not be resolved on the ${status.channel} dedicated-server channel.`,
        );
    }

    if (status.outdated) {
        lines.push(`[minecraft] Update available.`);
    } else if (status.artifactAvailable) {
        lines.push(
            "[minecraft] targetVersion is current for the configured channel.",
        );
    }

    return lines;
}

export async function runMinecraftCheckCommand(
    options: MinecraftCommandOptions,
): Promise<void> {
    const { config } = await loadBlurConfig(process.cwd());
    const debug = createDebugLogger(resolveDebugEnabled(options.debug));
    const status = await resolveMinecraftVersionStatus(
        config.minecraft.channel,
        config.minecraft.targetVersion,
        debug,
    );

    for (const line of renderStatusMessage(status)) {
        console.log(line);
    }
}

export async function runMinecraftUpdateCommand(
    options: MinecraftCommandOptions,
): Promise<void> {
    const { config, configPath } = await loadBlurConfig(process.cwd());
    const debug = createDebugLogger(resolveDebugEnabled(options.debug));
    const status = await resolveMinecraftVersionStatus(
        config.minecraft.channel,
        config.minecraft.targetVersion,
        debug,
    );

    for (const line of renderStatusMessage(status)) {
        console.log(line);
    }

    if (!status.outdated) {
        if (status.artifactAvailable) {
            console.log("[minecraft] No update applied.");
            return;
        }
        console.log(
            `[minecraft] Updating to ${status.latestVersion} is recommended because the configured version does not currently resolve.`,
        );
    }

    if (!options.yes) {
        const answers = await runPrompt({
            type: "confirm",
            name: "confirm",
            message: `Current: ${status.configuredVersion}\nNext: ${status.latestVersion}\nUpdate targetVersion?`,
            initial: true,
        });
        if (!answers.confirm) {
            console.log("[minecraft] No update applied.");
            return;
        }
    }

    await writeMinecraftTargetVersion(configPath, status.latestVersion);
    console.log(
        `[minecraft] Updated minecraft.targetVersion to ${status.latestVersion}.`,
    );
}
