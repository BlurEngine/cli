import assert from "node:assert/strict";
import test from "node:test";

import { loadMcbeLeveldbHelpers } from "../src/mcbe-leveldb-adapter.js";

test("the LevelDB helper boundary never mutates caller-owned chunk indices", async () => {
    const helpers = await loadMcbeLeveldbHelpers();
    const indices = { dimension: "overworld" as const, x: 12, z: -7 };

    helpers.generateChunkKeyFromIndices(indices, "Data3D");

    assert.deepEqual(indices, { dimension: "overworld", x: 12, z: -7 });
});
