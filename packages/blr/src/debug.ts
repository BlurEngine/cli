import { BLR_ENV_DEBUG } from "./constants.js";

export type DebugLogger = {
    enabled: boolean;
    log: (scope: string, message: string, details?: unknown) => void;
};

function parseBoolean(value: string | undefined): boolean | undefined {
    if (!value) {
        return undefined;
    }

    const normalized = value.trim().toLowerCase();
    if (normalized.length === 0) {
        return undefined;
    }
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
    return true;
}

export function resolveDebugEnabled(explicit: boolean | undefined): boolean {
    if (typeof explicit === "boolean") {
        return explicit;
    }
    return parseBoolean(process.env[BLR_ENV_DEBUG]) ?? false;
}

export function createDebugLogger(enabled: boolean): DebugLogger {
    return {
        enabled,
        log(scope, message, details) {
            if (!enabled) {
                return;
            }

            const prefix = `[debug:${scope}] ${message}`;
            if (typeof details === "undefined") {
                console.log(prefix);
                return;
            }

            if (typeof details === "string") {
                console.log(`${prefix} ${details}`);
                return;
            }

            console.log(prefix);
            console.log(JSON.stringify(details, null, 2));
        },
    };
}
