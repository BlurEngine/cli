import type {
    ResolvedWorldProcessorConfig,
    WorldProcessorApplyOn,
    WorldProcessorCapability,
} from "./types.js";
import {
    canonicalJson,
    hashCanonicalJson,
} from "./world-processing/canonical-json.js";

export type {
    BlurConfigWorldProcessorFile,
    ResolvedWorldProcessorConfig,
    WorldProcessorApplyOn,
    WorldProcessorCapability,
} from "./types.js";

export type WorldProcessorPipelineIntent =
    | "dev"
    | "build"
    | "package"
    | "check"
    | "world-build"
    | "world-push";

/** Canonical JSON bytes used for immutable world-processor artifacts. */
export function canonicalizeWorldDerivedJson(input: unknown): string {
    return canonicalJson(input);
}

/** Lowercase SHA-256 of {@link canonicalizeWorldDerivedJson}. */
export function hashWorldDerivedJson(input: unknown): string {
    return hashCanonicalJson(input);
}

export type WorldProcessorMode = "check" | "bake";
export type WorldDimensionId = "overworld" | "nether" | "the_end";
export type WorldBlockStateValue = boolean | number | string;
export type WorldDerivedJsonPrimitive = boolean | number | string | null;
export type WorldDerivedJsonValue =
    | WorldDerivedJsonPrimitive
    | readonly WorldDerivedJsonValue[]
    | { readonly [key: string]: WorldDerivedJsonValue };

export type WorldBlockLocation = {
    readonly x: number;
    readonly y: number;
    readonly z: number;
};

/** Inclusive integer world bounds. */
export type WorldBlockBounds = {
    readonly min: WorldBlockLocation;
    readonly max: WorldBlockLocation;
};

export type WorldBlockPaletteEntry = {
    readonly typeId: string;
    readonly states: Readonly<Record<string, WorldBlockStateValue>>;
    readonly version: number;
};

export type WorldStandingSignOrientation = {
    readonly kind: "standing";
    readonly groundSignDirection:
        | 0
        | 1
        | 2
        | 3
        | 4
        | 5
        | 6
        | 7
        | 8
        | 9
        | 10
        | 11
        | 12
        | 13
        | 14
        | 15;
    readonly yawDegrees: number;
};

export type WorldWallSignOrientation = {
    readonly kind: "wall";
    readonly facingDirection: 2 | 3 | 4 | 5;
    readonly yawDegrees: number;
};

export type WorldHangingSignOrientation = {
    readonly kind: "hanging";
    readonly states: Readonly<Record<string, WorldBlockStateValue>>;
};

export type WorldSignOrientation =
    | WorldStandingSignOrientation
    | WorldWallSignOrientation
    | WorldHangingSignOrientation;

export type WorldSignFaceObservation = {
    readonly face: "front" | "back";
    readonly rawText: string;
    readonly normalizedText: string;
    readonly lines: readonly string[];
};

export type WorldBlockEntityObservation = {
    readonly id: string;
    readonly location: WorldBlockLocation;
    readonly value: WorldDerivedJsonValue;
    readonly signFaces?: readonly WorldSignFaceObservation[];
};

export type WorldBlockObservation = {
    readonly dimension: WorldDimensionId;
    readonly location: WorldBlockLocation;
    readonly layer: number;
    readonly palette: WorldBlockPaletteEntry;
    readonly blockEntity?: WorldBlockEntityObservation;
    readonly signOrientation?: WorldSignOrientation;
};

export type WorldSignBlockEntityObservation = Omit<
    WorldBlockEntityObservation,
    "id" | "signFaces"
> & {
    readonly id: "Sign";
    readonly signFaces: readonly WorldSignFaceObservation[];
};

export type WorldSignObservation = Omit<
    WorldBlockObservation,
    "blockEntity" | "layer" | "signOrientation"
> & {
    readonly layer: 0;
    readonly blockEntity: WorldSignBlockEntityObservation;
    readonly signOrientation: WorldSignOrientation;
};

export type WorldObservationQuery = {
    readonly dimension: WorldDimensionId;
    readonly bounds: WorldBlockBounds;
    readonly typeIds?: readonly string[];
    readonly includeAir?: boolean;
};

export type WorldSignObservationQuery = {
    readonly dimension?: WorldDimensionId;
    readonly bounds?: WorldBlockBounds;
};

export interface WorldObservationFacade {
    blocks(query: WorldObservationQuery): AsyncIterable<WorldBlockObservation>;
    /** Streams coherent sign blocks by their block entities without scanning a world volume. */
    signs(
        query?: WorldSignObservationQuery,
    ): AsyncIterable<WorldSignObservation>;
}

export type WorldSourceIdentity = {
    readonly worldName: string;
    readonly contentHash: string;
    readonly sourceRevision?: string;
    readonly sourceVersion?: string;
};

export type WorldProcessorDeclaredLogicalInput =
    | {
          readonly id: string;
          readonly kind: "value";
          readonly value: string;
      }
    | {
          readonly id: string;
          readonly kind: "file";
          readonly path: string;
      };

export type WorldProcessorMaterializedLogicalInput = {
    readonly id: string;
    readonly kind: "value" | "file" | "world" | "provider" | "schema";
    readonly contentHash: string;
};

export interface WorldProcessorInputFile {
    readonly id: string;
    readonly relativePath: string;
    readonly contentHash: string;
    readonly size: number;
    read(): Promise<Uint8Array>;
}

export type WorldProcessorDiagnostic = {
    readonly code: string;
    readonly severity: "info" | "warning" | "error";
    readonly message: string;
    readonly location?: WorldBlockLocation;
};

export type WorldDerivedArtifactHashReference = {
    readonly artifactId: string;
    readonly jsonPointer: string;
};

export type WorldProcessorArtifact = {
    readonly id: string;
    readonly value: WorldDerivedJsonValue;
    readonly hashReferences?: readonly WorldDerivedArtifactHashReference[];
};

export type WorldDerivedArtifactSetMemberV1 = {
    readonly id: string;
    readonly fileName: string;
    readonly contentHash: string;
};

export type WorldDerivedArtifactSetManifestV1 = {
    readonly schemaVersion: 1;
    readonly artifactSetId: string;
    readonly logicalInputHash: string;
    readonly providerId: string;
    readonly providerRevision: string;
    /** Payload members only. The detached manifest never hashes itself. */
    readonly members: readonly WorldDerivedArtifactSetMemberV1[];
};

export type WorldDerivedArtifactSetPointerMember<T> =
    WorldDerivedArtifactSetMemberV1 & {
        readonly value: T;
    };

export type WorldDerivedArtifactSetPointer<
    TPayloads extends Readonly<Record<string, unknown>>,
> = {
    readonly schemaVersion: 1;
    readonly artifactSetId: string;
    readonly logicalInputHash: string;
    readonly providerId: string;
    readonly providerRevision: string;
    readonly manifestContentHash: string;
    readonly members: {
        readonly [K in keyof TPayloads]: WorldDerivedArtifactSetPointerMember<
            TPayloads[K]
        >;
    };
};

export type WorldPaletteReplacement =
    | {
          readonly kind: "literal";
          readonly palette: WorldBlockPaletteEntry;
      }
    | {
          readonly kind: "observed";
          readonly dimension: WorldDimensionId;
          readonly location: WorldBlockLocation;
          readonly layer: number;
      };

export type WorldBlockEntityPolicy =
    | "require-absent"
    | "preserve-compatible"
    | "remove";

export type WorldSetBlockMutation = {
    readonly kind: "set-block";
    readonly opId: string;
    readonly dimension: WorldDimensionId;
    readonly location: WorldBlockLocation;
    readonly layer: number;
    readonly expectedPalette: WorldBlockPaletteEntry;
    readonly replacement: WorldPaletteReplacement;
    readonly blockEntityPolicy: WorldBlockEntityPolicy;
};

export type WorldRemoveBlockEntityMutation = {
    readonly kind: "remove-block-entity";
    readonly opId: string;
    readonly dimension: WorldDimensionId;
    readonly location: WorldBlockLocation;
    readonly expectedId: string;
};

export type WorldReplaceBlocksMutation = {
    readonly kind: "replace-blocks";
    readonly opId: string;
    readonly dimension: WorldDimensionId;
    readonly bounds: WorldBlockBounds;
    readonly layer: number;
    readonly matchPalette: WorldBlockPaletteEntry;
    readonly replacement: WorldPaletteReplacement;
    readonly blockEntityPolicy: WorldBlockEntityPolicy;
};

export type WorldConsumeSignMutation = {
    readonly kind: "consume-sign";
    readonly opId: string;
    readonly dimension: WorldDimensionId;
    readonly location: WorldBlockLocation;
    readonly expectedPalette: WorldBlockPaletteEntry;
    readonly expectedBlockEntityId: "Sign";
    readonly replacement: WorldPaletteReplacement;
    readonly otherLayerPolicy: "preserve";
};

export type WorldMutation =
    | WorldSetBlockMutation
    | WorldRemoveBlockEntityMutation
    | WorldReplaceBlocksMutation
    | WorldConsumeSignMutation;

export type WorldMutationPlan = {
    readonly version: 1;
    readonly mutations: readonly WorldMutation[];
};

export type WorldProcessorInput = {
    readonly config: ResolvedWorldProcessorConfig;
    readonly sourceIdentity: WorldSourceIdentity;
    readonly observations: WorldObservationFacade;
    readonly inputFiles: readonly WorldProcessorInputFile[];
    readonly logicalInputs: readonly WorldProcessorMaterializedLogicalInput[];
    readonly dependencies: Readonly<Record<string, WorldProcessorResult>>;
    readonly signal: AbortSignal;
};

export type WorldProcessorResult = {
    readonly logicalInputs: readonly WorldProcessorMaterializedLogicalInput[];
    readonly artifacts: readonly WorldProcessorArtifact[];
    /** Optional rich, canonical JSON written only when the caller requests an audit. */
    readonly audit?: WorldDerivedJsonValue;
    readonly diagnostics: readonly WorldProcessorDiagnostic[];
    readonly mutations: readonly WorldMutation[];
};

export interface WorldProcessor {
    readonly implementationRevision: string;
    readonly logicalInputs: readonly WorldProcessorDeclaredLogicalInput[];
    run(input: WorldProcessorInput): Promise<WorldProcessorResult>;
}

export type WorldProcessorFactory = () => WorldProcessor;

export function defineWorldProcessor(
    factory: WorldProcessorFactory,
): WorldProcessorFactory {
    return factory;
}

// Keep config vocabulary reachable from the SDK without creating a runtime
// dependency on the config loader.
export type WorldProcessorConfigVocabulary = {
    readonly capability: WorldProcessorCapability;
    readonly applyOn: WorldProcessorApplyOn;
};
