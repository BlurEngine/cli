import { loadBlurConfig } from "../config.js";
import { cleanProject } from "../runtime.js";

export async function runCleanCommand(): Promise<void> {
    const { projectRoot } = await loadBlurConfig(process.cwd());
    await cleanProject(projectRoot);
    console.log("[clean] Removed dist/");
}
