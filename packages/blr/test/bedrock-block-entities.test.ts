import assert from "node:assert/strict";
import test from "node:test";
import NBT from "prismarine-nbt";
import {
    decodeBedrockBlockEntities,
    decodeSignOrientation,
    normalizeSignText,
} from "../src/world-processing/bedrock-block-entities.js";

test("normalizeSignText preserves arbitrary rows and empty values while normalising line endings", () => {
    assert.deepEqual(normalizeSignText("~\r\n@object\rlamppost\n\n"), {
        rawText: "~\r\n@object\rlamppost\n\n",
        normalizedText: "~\n@object\nlamppost\n\n",
        lines: ["~", "@object", "lamppost", ""],
    });
    assert.deepEqual(normalizeSignText("id\n@custom\na\n\nb\n\n"), {
        rawText: "id\n@custom\na\n\nb\n\n",
        normalizedText: "id\n@custom\na\n\nb\n\n",
        lines: ["id", "@custom", "a", "", "b", ""],
    });
    assert.deepEqual(normalizeSignText("single"), {
        rawText: "single",
        normalizedText: "single",
        lines: ["single"],
    });
});

test("decodeBedrockBlockEntities preserves both sign faces independently", async () => {
    const raw = writeBlockEntities([
        {
            id: { type: "string", value: "Sign" },
            x: { type: "int", value: -219 },
            y: { type: "int", value: 80 },
            z: { type: "int", value: 1448 },
            FrontText: signText("~\n@object\nlamppost\n\n"),
            BackText: signText("back.id\n@other\na\nb"),
            IsWaxed: { type: "byte", value: 0 },
        },
    ]);

    const [entity] = await decodeBedrockBlockEntities(raw);
    assert.equal(entity?.id, "Sign");
    assert.deepEqual(entity?.location, { x: -219, y: 80, z: 1448 });
    assert.deepEqual(entity?.signFaces, [
        {
            face: "front",
            rawText: "~\n@object\nlamppost\n\n",
            normalizedText: "~\n@object\nlamppost\n\n",
            lines: ["~", "@object", "lamppost", ""],
        },
        {
            face: "back",
            rawText: "back.id\n@other\na\nb",
            normalizedText: "back.id\n@other\na\nb",
            lines: ["back.id", "@other", "a", "b"],
        },
    ]);
});

test("decodeSignOrientation maps every standing and wall state without rounding", () => {
    const expectedStanding = [
        0, 22.5, 45, 67.5, 90, 112.5, 135, 157.5, 180, -157.5, -135, -112.5,
        -90, -67.5, -45, -22.5,
    ];
    for (let state = 0; state < 16; state += 1) {
        assert.deepEqual(
            decodeSignOrientation({
                typeId: "minecraft:spruce_standing_sign",
                states: { ground_sign_direction: state },
                version: 18_488_832,
            }),
            {
                kind: "standing",
                groundSignDirection: state,
                yawDegrees: expectedStanding[state],
            },
        );
    }

    const wallYaws = new Map([
        [2, 180],
        [3, 0],
        [4, 90],
        [5, -90],
    ]);
    for (const [state, yawDegrees] of wallYaws) {
        assert.deepEqual(
            decodeSignOrientation({
                typeId: "minecraft:spruce_wall_sign",
                states: { facing_direction: state },
                version: 18_488_832,
            }),
            { kind: "wall", facingDirection: state, yawDegrees },
        );
    }
});

test("decodeSignOrientation rejects malformed sign states and preserves hanging-sign state", () => {
    assert.throws(
        () =>
            decodeSignOrientation({
                typeId: "minecraft:standing_sign",
                states: { ground_sign_direction: 16 },
                version: 0,
            }),
        /ground_sign_direction.*0\.\.15/i,
    );
    assert.throws(
        () =>
            decodeSignOrientation({
                typeId: "minecraft:wall_sign",
                states: { facing_direction: 1 },
                version: 0,
            }),
        /facing_direction.*2, 3, 4, or 5/i,
    );
    assert.deepEqual(
        decodeSignOrientation({
            typeId: "minecraft:oak_hanging_sign",
            states: { attached_bit: true, ground_sign_direction: 7 },
            version: 0,
        }),
        {
            kind: "hanging",
            states: { attached_bit: true, ground_sign_direction: 7 },
        },
    );
    assert.equal(
        decodeSignOrientation({
            typeId: "minecraft:stone",
            states: {},
            version: 0,
        }),
        undefined,
    );
});

function signText(text: string): NbtCompound {
    return {
        type: "compound",
        value: {
            Text: { type: "string", value: text },
            IgnoreLighting: { type: "byte", value: 0 },
            SignTextColor: { type: "int", value: -16_777_216 },
        },
    };
}

type NbtCompound = {
    type: "compound";
    value: Record<string, unknown>;
};

function writeBlockEntities(
    values: readonly Record<string, unknown>[],
): Buffer {
    return Buffer.concat(
        values.map((value) =>
            NBT.writeUncompressed(
                {
                    name: "",
                    type: "compound",
                    value,
                } as Parameters<typeof NBT.writeUncompressed>[0],
                "little",
            ),
        ),
    );
}
