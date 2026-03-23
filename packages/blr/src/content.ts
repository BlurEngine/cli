import type { PackFeatureSelection } from "./types.js";

export type PackFeatureSelectionOverride = Partial<PackFeatureSelection>;

export function resolvePackFeatureSelection(
    base: PackFeatureSelection,
    override: PackFeatureSelectionOverride = {},
): PackFeatureSelection {
    return {
        behaviorPack:
            typeof override.behaviorPack === "boolean"
                ? override.behaviorPack
                : base.behaviorPack,
        resourcePack:
            typeof override.resourcePack === "boolean"
                ? override.resourcePack
                : base.resourcePack,
    };
}
