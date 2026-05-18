import { type BedrockDimension } from "./mcbe-leveldb-adapter.js";

export type WorldImageDimension = "overworld" | "nether" | "end";
export type BedrockWorldImageDimension = BedrockDimension;

export function normalizeWorldImageDimension(
    value: string | undefined,
    source = "dimension",
): WorldImageDimension {
    const normalized = (value ?? "overworld").trim().toLowerCase();
    if (
        normalized === "overworld" ||
        normalized === "nether" ||
        normalized === "end"
    ) {
        return normalized;
    }
    if (normalized === "the_end" || normalized === "the-end") {
        return "end";
    }

    throw new Error(
        `${source} must be one of: overworld, nether, end. Received "${value}".`,
    );
}

export function toBedrockDimension(
    dimension: WorldImageDimension | undefined,
): BedrockWorldImageDimension {
    switch (dimension ?? "overworld") {
        case "nether":
            return "nether";
        case "end":
            return "the_end";
        case "overworld":
        default:
            return "overworld";
    }
}

export function normalizeChunkDimension(
    dimension: BedrockDimension | number,
): BedrockWorldImageDimension | undefined {
    if (dimension === "overworld" || dimension === 0) return "overworld";
    if (dimension === "nether" || dimension === 1) return "nether";
    if (dimension === "the_end" || dimension === 2) return "the_end";
    return undefined;
}
