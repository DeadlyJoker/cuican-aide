import assert from "node:assert/strict";
import test from "node:test";

import {
  assertNode24Version,
  assertReleaseNodeMetadata,
} from "./stage-desktop-runtime.mjs";

test("accepts only the Node 24 runtime ABI", () => {
  assert.doesNotThrow(() => assertNode24Version("v24.18.1\n"));
  assert.throws(
    () => assertNode24Version("v22.22.0\n"),
    /must be a Node 24 executable/u,
  );
});

test("release staging binds the distributable runtime to target and digest", () => {
  const digest = "a".repeat(64);
  const input = {
    actualSha256: digest,
    declaredSha256: digest,
    declaredTarget: "aarch64-apple-darwin",
    distributable: "1",
    target: "aarch64-apple-darwin",
  };
  assert.doesNotThrow(() => assertReleaseNodeMetadata(input));
  assert.throws(
    () =>
      assertReleaseNodeMetadata({
        ...input,
        declaredTarget: "x86_64-pc-windows-msvc",
      }),
    /must exactly match/u,
  );
  assert.throws(
    () =>
      assertReleaseNodeMetadata({ ...input, declaredSha256: "b".repeat(64) }),
    /does not match/u,
  );
  assert.throws(
    () => assertReleaseNodeMetadata({ ...input, distributable: undefined }),
    /CREWON_NODE_DISTRIBUTABLE=1/u,
  );
});
