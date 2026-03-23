import path from "node:path";
import { createDebugLogger, resolveDebugEnabled } from "../debug.js";
import { loadBlurConfig } from "../config.js";
import { resolveMachineSettings } from "../environment.js";
import { buildProject, runLocalDeploy } from "../runtime.js";

type BuildCommandOptions = {
    production?: boolean;
    localDeploy?: boolean;
    localDeployBehaviorPack?: boolean;
    localDeployResourcePack?: boolean;
    minecraftProduct?: string;
    minecraftDevelopmentPath?: string;
    debug?: boolean;
};

export async function runBuildCommand(
    options: BuildCommandOptions,
): Promise<void> {
    const { projectRoot, config } = await loadBlurConfig(process.cwd());
    const production = Boolean(options.production);
    const shouldDeploy = Boolean(options.localDeploy);
    const debug = createDebugLogger(resolveDebugEnabled(options.debug));
    const machine = resolveMachineSettings(
        projectRoot,
        {
            minecraftProduct: options.minecraftProduct as any,
            minecraftDevelopmentPath: options.minecraftDevelopmentPath,
        },
        {
            minecraftChannel: config.minecraft.channel,
            bdsVersion: config.minecraft.targetVersion,
        },
    );

    debug.log("build", "resolved build command", {
        projectRoot,
        production,
        shouldDeploy,
    });

    const artifacts = await buildProject(projectRoot, config, {
        production,
        debug,
    });
    const buildSummary =
        config.runtime.entry.trim().length > 0
            ? `Staged ${config.runtime.entry} -> ${path.relative(projectRoot, artifacts.stageRoot)}`
            : `Staged pack content -> ${path.relative(projectRoot, artifacts.stageRoot)}`;
    console.log(`[build] ${buildSummary}${production ? " (production)" : ""}`);

    if (shouldDeploy) {
        await runLocalDeploy(
            projectRoot,
            config,
            machine,
            {
                copy: {
                    behaviorPack: options.localDeployBehaviorPack,
                    resourcePack: options.localDeployResourcePack,
                },
            },
            debug,
        );
        console.log("[build] local-deploy completed.");
    }
}
