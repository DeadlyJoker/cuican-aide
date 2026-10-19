import assert from "node:assert/strict";
import test from "node:test";
import { copyMaterialByteChunk } from "./material-byte-snapshot.ts";

test("large-media chunks respect native offsets without supplied accessors or species", () => {
  const backing = new Uint8Array([9, 1, 2, 3, 4, 9]);
  const input = new Uint8Array(backing.buffer, 1, 4);
  for (const key of [
    "byteLength",
    "byteOffset",
    "buffer",
    "subarray",
    "constructor",
    Symbol.iterator,
  ])
    Object.defineProperty(input, key, {
      get() {
        throw new Error("caller hook executed");
      },
    });
  const chunk = copyMaterialByteChunk(input, 1, 2);
  assert.deepEqual([...chunk], [2, 3]);
  backing[2] = 8;
  assert.deepEqual([...chunk], [2, 3]);
  assert.throws(() => copyMaterialByteChunk(new Proxy(input, {}), 0, 1));
  for (const [start, size] of [
    [-1, 1],
    [0, 65537],
    [3, 2],
    [0, 0],
    [NaN, 1],
  ])
    assert.throws(() => copyMaterialByteChunk(input, start!, size!));
});
