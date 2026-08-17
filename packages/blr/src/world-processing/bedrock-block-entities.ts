import type {
    WorldBlockEntityObservation,
    WorldBlockPaletteEntry,
    WorldDerivedJsonValue,
    WorldSignFaceObservation,
    WorldSignOrientation,
} from "../world-processing.js";
import { loadMcbeLeveldbHelpers } from "../mcbe-leveldb-adapter.js";

export type NormalizedSignText = Omit<WorldSignFaceObservation, "face">;

export function normalizeSignText(rawText: string): NormalizedSignText {
    const normalizedText = rawText.replace(/\r\n?/g, "\n");
    const rowsText = normalizedText.endsWith("\n")
        ? normalizedText.slice(0, -1)
        : normalizedText;
    return Object.freeze({
        rawText,
        normalizedText,
        lines: Object.freeze(rowsText.split("\n")),
    });
}

export async function decodeBedrockBlockEntities(
    rawValue: Uint8Array,
): Promise<readonly WorldBlockEntityObservation[]> {
    const helpers = await loadMcbeLeveldbHelpers();
    const parsed = await helpers.entryContentTypeToFormatMap.BlockEntity.parse(
        Buffer.from(rawValue.buffer, rawValue.byteOffset, rawValue.byteLength),
    );
    const values = parsed.value.blockEntities.value.value;
    return Object.freeze(
        values.map((value, index) =>
            normalizeBlockEntity(value, `blockEntities[${index}]`),
        ),
    );
}

export function decodeSignOrientation(
    palette: WorldBlockPaletteEntry,
): WorldSignOrientation | undefined {
    if (palette.typeId.includes("hanging_sign")) {
        return Object.freeze({
            kind: "hanging",
            states: palette.states,
        });
    }
    if (palette.typeId.endsWith("standing_sign")) {
        const state = palette.states.ground_sign_direction;
        if (
            typeof state !== "number" ||
            !Number.isInteger(state) ||
            state < 0 ||
            state > 15
        ) {
            throw new Error(
                `${palette.typeId} ground_sign_direction must be an integer in 0..15.`,
            );
        }
        const yaw = state * 22.5;
        return Object.freeze({
            kind: "standing",
            groundSignDirection: state as 0,
            yawDegrees: yaw > 180 ? yaw - 360 : yaw,
        });
    }
    if (palette.typeId.endsWith("wall_sign")) {
        const state = palette.states.facing_direction;
        if (
            !Number.isInteger(state) ||
            (state !== 2 && state !== 3 && state !== 4 && state !== 5)
        ) {
            throw new Error(
                `${palette.typeId} facing_direction must be 2, 3, 4, or 5.`,
            );
        }
        const yawByState: Readonly<Record<2 | 3 | 4 | 5, number>> = {
            2: 180,
            3: 0,
            4: 90,
            5: -90,
        };
        return Object.freeze({
            kind: "wall",
            facingDirection: state,
            yawDegrees: yawByState[state],
        });
    }
    return undefined;
}

function normalizeBlockEntity(
    value: Record<string, unknown>,
    source: string,
): WorldBlockEntityObservation {
    const id = readNbtString(value.id, `${source}.id`);
    const location = Object.freeze({
        x: readNbtNumber(value.x, `${source}.x`),
        y: readNbtNumber(value.y, `${source}.y`),
        z: readNbtNumber(value.z, `${source}.z`),
    });
    if (
        !Number.isInteger(location.x) ||
        !Number.isInteger(location.y) ||
        !Number.isInteger(location.z)
    ) {
        throw new Error(`${source} coordinates must be integers.`);
    }
    const normalizedValue = normalizeNbtCompound(value, source);
    const signFaces = id === "Sign" ? readSignFaces(value, source) : undefined;
    return Object.freeze({
        id,
        location,
        value: normalizedValue,
        ...(signFaces ? { signFaces } : {}),
    });
}

function readSignFaces(
    value: Record<string, unknown>,
    source: string,
): readonly WorldSignFaceObservation[] {
    const faces: WorldSignFaceObservation[] = [];
    for (const [field, face] of [
        ["FrontText", "front"],
        ["BackText", "back"],
    ] as const) {
        const textCompound = readOptionalNbtCompound(
            value[field],
            `${source}.${field}`,
        );
        if (!textCompound) continue;
        const text = readNbtString(
            textCompound.Text,
            `${source}.${field}.Text`,
        );
        faces.push(Object.freeze({ face, ...normalizeSignText(text) }));
    }
    return Object.freeze(faces);
}

function normalizeNbtCompound(
    input: Record<string, unknown>,
    source: string,
): WorldDerivedJsonValue {
    const result: Record<string, WorldDerivedJsonValue> = {};
    for (const key of Object.keys(input).sort()) {
        result[key] = normalizeNbtTag(input[key], `${source}.${key}`);
    }
    return Object.freeze(result);
}

function normalizeNbtTag(
    input: unknown,
    source: string,
): WorldDerivedJsonValue {
    const tag = readNbtTag(input, source);
    if (tag.type === "compound") {
        if (
            !tag.value ||
            typeof tag.value !== "object" ||
            Array.isArray(tag.value)
        ) {
            throw new Error(`${source} is not an NBT compound.`);
        }
        return normalizeNbtCompound(
            tag.value as Record<string, unknown>,
            source,
        );
    }
    if (tag.type === "list") {
        const list = tag.value as
            | { type?: unknown; value?: unknown }
            | undefined;
        if (
            !list ||
            typeof list.type !== "string" ||
            !Array.isArray(list.value)
        ) {
            throw new Error(`${source} is not an NBT list.`);
        }
        return Object.freeze(
            list.value.map((entry, index) =>
                normalizeNbtTag(
                    { type: list.type, value: entry },
                    `${source}[${index}]`,
                ),
            ),
        );
    }
    if (/Array$/i.test(tag.type)) {
        const arrayValue =
            tag.value && typeof tag.value === "object" && "value" in tag.value
                ? (tag.value as { value: unknown }).value
                : tag.value;
        if (!Array.isArray(arrayValue) && !ArrayBuffer.isView(arrayValue)) {
            throw new Error(`${source} is not an NBT array.`);
        }
        return Object.freeze(Array.from(arrayValue as ArrayLike<number>));
    }
    if (typeof tag.value === "bigint") return tag.value.toString();
    if (
        typeof tag.value === "string" ||
        typeof tag.value === "boolean" ||
        (typeof tag.value === "number" && Number.isFinite(tag.value))
    ) {
        return tag.value;
    }
    throw new Error(`${source} has unsupported NBT type ${tag.type}.`);
}

function readOptionalNbtCompound(
    input: unknown,
    source: string,
): Record<string, unknown> | undefined {
    if (input === undefined) return undefined;
    const tag = readNbtTag(input, source);
    if (
        tag.type !== "compound" ||
        !tag.value ||
        typeof tag.value !== "object" ||
        Array.isArray(tag.value)
    ) {
        throw new Error(`${source} is not an NBT compound.`);
    }
    return tag.value as Record<string, unknown>;
}

function readNbtString(input: unknown, source: string): string {
    const tag = readNbtTag(input, source);
    if (tag.type !== "string" || typeof tag.value !== "string") {
        throw new Error(`${source} is not an NBT string.`);
    }
    return tag.value;
}

function readNbtNumber(input: unknown, source: string): number {
    const tag = readNbtTag(input, source);
    if (typeof tag.value !== "number" || !Number.isFinite(tag.value)) {
        throw new Error(`${source} is not a finite NBT number.`);
    }
    return tag.value;
}

function readNbtTag(
    input: unknown,
    source: string,
): { readonly type: string; readonly value: unknown } {
    if (
        !input ||
        typeof input !== "object" ||
        !("type" in input) ||
        !("value" in input) ||
        typeof (input as { type?: unknown }).type !== "string"
    ) {
        throw new Error(`${source} is not a valid NBT tag.`);
    }
    return input as { readonly type: string; readonly value: unknown };
}
