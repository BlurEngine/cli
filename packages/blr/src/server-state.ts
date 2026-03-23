import path from "node:path";

export const PROJECT_SERVER_STATE_ROOT = "server";

type ProjectServerStateFile = "allowlist.json" | "permissions.json";

export function resolveProjectServerStatePath(
    projectRoot: string,
    fileName: ProjectServerStateFile,
): string {
    return path.join(projectRoot, PROJECT_SERVER_STATE_ROOT, fileName);
}
