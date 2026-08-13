import { createHash } from "node:crypto";
import type { WorldDerivedJsonValue } from "../world-processing.js";

export function canonicalJson(input: unknown): string {
    return `${JSON.stringify(normalizeJson(input), null, 2)}\n`;
}

export function hashCanonicalJson(input: unknown): string {
    return createHash("sha256").update(canonicalJson(input)).digest("hex");
}

export function normalizeJson(
    input: unknown,
    source = "value",
): WorldDerivedJsonValue {
    if (
        input === null ||
        typeof input === "string" ||
        typeof input === "boolean"
    ) {
        return input;
    }
    if (typeof input === "number") {
        if (!Number.isFinite(input)) {
            throw new Error(`${source} contains a non-finite number.`);
        }
        return Object.is(input, -0) ? 0 : input;
    }
    if (Array.isArray(input)) {
        return Object.freeze(
            input.map((value, index) =>
                normalizeJson(value, `${source}[${index}]`),
            ),
        );
    }
    if (input && typeof input === "object") {
        const prototype = Object.getPrototypeOf(input);
        if (prototype !== Object.prototype && prototype !== null) {
            throw new Error(`${source} must contain only plain JSON objects.`);
        }
        const result: Record<string, WorldDerivedJsonValue> = {};
        for (const key of Object.keys(
            input as Record<string, unknown>,
        ).sort()) {
            const value = (input as Record<string, unknown>)[key];
            if (value === undefined) {
                throw new Error(`${source}.${key} must not be undefined.`);
            }
            result[key] = normalizeJson(value, `${source}.${key}`);
        }
        return Object.freeze(result);
    }
    throw new Error(`${source} contains unsupported ${typeof input} data.`);
}
