import { createDebugLogger, resolveDebugEnabled } from "../debug.js";
import {
    collectSystemDoctorReport,
    collectSystemInfo,
    renderSystemDoctor,
    renderSystemInfo,
    type SystemOutputFormat,
} from "../system.js";

type SystemCommandOptions = {
    format?: string;
    includePaths?: boolean;
    includeRemote?: boolean;
    debug?: boolean;
};

export function resolveSystemOutputFormat(
    value: string | undefined,
): SystemOutputFormat {
    if (!value) {
        return "text";
    }
    if (value === "text" || value === "json" || value === "markdown") {
        return value;
    }
    throw new Error(
        `Unsupported format \"${value}\". Use text, json, or markdown.`,
    );
}

export async function runSystemInfoCommand(
    options: SystemCommandOptions,
): Promise<void> {
    const debug = createDebugLogger(resolveDebugEnabled(options.debug));
    const info = await collectSystemInfo(process.cwd(), {
        includePaths: options.includePaths,
        includeRemote: options.includeRemote,
        debug,
    });
    process.stdout.write(
        renderSystemInfo(info, resolveSystemOutputFormat(options.format)),
    );
}

export async function runSystemDoctorCommand(
    options: SystemCommandOptions,
): Promise<void> {
    const debug = createDebugLogger(resolveDebugEnabled(options.debug));
    const report = await collectSystemDoctorReport(process.cwd(), {
        includePaths: options.includePaths,
        includeRemote: options.includeRemote,
        debug,
    });
    process.stdout.write(
        renderSystemDoctor(report, resolveSystemOutputFormat(options.format)),
    );
    if (!report.ok) {
        process.exitCode = 1;
    }
}
