import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
    canonicalizeWorldDerivedJson,
    defineWorldProcessor,
    hashWorldDerivedJson,
    type WorldProcessor,
    type WorldProcessorFactory,
    type WorldSignObservationQuery,
    type WorldSignOrientation,
} from "../src/world-processing.js";

test("world processor SDK canonicalizes and hashes artifact values", () => {
    const value = { z: -0, a: [3, { b: true, a: "first" }] };

    assert.equal(
        canonicalizeWorldDerivedJson(value),
        '{\n  "a": [\n    3,\n    {\n      "a": "first",\n      "b": true\n    }\n  ],\n  "z": 0\n}\n',
    );
    assert.match(hashWorldDerivedJson(value), /^[0-9a-f]{64}$/);
    assert.equal(
        hashWorldDerivedJson(value),
        hashWorldDerivedJson({ a: [3, { a: "first", b: true }], z: 0 }),
    );
});

test("defineWorldProcessor preserves the supported factory contract", () => {
    const processor: WorldProcessor = {
        implementationRevision: "locations-v1",
        logicalInputs: [
            {
                id: "location-schema",
                kind: "value",
                value: "1",
            },
        ],
        async run(input) {
            assert.equal("pipeline" in input, false);
            assert.equal("mode" in input, false);
            return {
                logicalInputs: input.logicalInputs,
                artifacts: [],
                diagnostics: [],
                mutations: [],
            };
        },
    };
    const factory: WorldProcessorFactory = defineWorldProcessor(
        () => processor,
    );

    assert.equal(factory(), processor);
});

test("world sign orientation preserves the exact standing and wall domains", () => {
    const orientations: readonly WorldSignOrientation[] = [
        { kind: "standing", groundSignDirection: 15, yawDegrees: -22.5 },
        { kind: "wall", facingDirection: 4, yawDegrees: 90 },
        { kind: "hanging", states: { attached: true } },
    ];

    assert.deepEqual(orientations[0], {
        kind: "standing",
        groundSignDirection: 15,
        yawDegrees: -22.5,
    });
    assert.deepEqual(orientations[1], {
        kind: "wall",
        facingDirection: 4,
        yawDegrees: 90,
    });
});

test("world sign queries can cover a whole dimension without a volume box", () => {
    const wholeWorld: WorldSignObservationQuery = { dimension: "overworld" };
    const bounded: WorldSignObservationQuery = {
        bounds: {
            min: { x: -16, y: -64, z: -16 },
            max: { x: 16, y: 320, z: 16 },
        },
    };

    assert.deepEqual(wholeWorld, { dimension: "overworld" });
    assert.equal(bounded.bounds?.max.y, 320);
});

test("package metadata publishes the world-processing runtime and declarations", async () => {
    const packageJson = JSON.parse(
        await readFile(
            path.resolve(import.meta.dirname, "..", "package.json"),
            "utf8",
        ),
    ) as {
        exports?: Record<string, unknown>;
    };

    assert.deepEqual(packageJson.exports?.["./world-processing"], {
        types: "./dist/world-processing.d.ts",
        import: "./dist/world-processing.js",
    });
});
