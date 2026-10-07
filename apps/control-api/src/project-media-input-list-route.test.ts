import assert from "node:assert/strict";
import test from "node:test";
import { mediaInputControlFixture } from "./project-media-input.test-support.ts";
import { assetTestOptions } from "../../../packages/store/src/project-asset.test-support.ts";
for (const backend of ["sqlite", "postgres"] as const) {
  test(
    `${backend}: input catalog pages use the original project metadata and never execute media`,
    assetTestOptions(backend),
    async (t) => {
      const f = await mediaInputControlFixture(t, backend);
      const a = await f.save();
      assert.equal(a.statusCode, 200, a.body);
      const b = await f.save(f.app, {
        ...f.command(),
        idempotencyKey: "second-input",
      });
      assert.equal(b.statusCode, 200, b.body);
      const read = (suffix: string) =>
        f.app.inject({
          method: "GET",
          url: f.root + suffix,
          headers: {
            authorization: f.headers().authorization,
            origin: f.headers().origin,
          },
        });
      const first = await read("?limit=1");
      assert.equal(first.statusCode, 200, first.body);
      assert.equal(first.json().inputs.length, 1);
      assert.equal(
        first.json().nextMediaInputId,
        first.json().inputs[0].mediaInputId,
      );
      const second = await read(
        `?limit=1&afterMediaInputId=${encodeURIComponent(first.json().nextMediaInputId)}`,
      );
      assert.equal(second.statusCode, 200, second.body);
      assert.equal(second.json().inputs.length, 1);
      assert.equal(second.json().nextMediaInputId, null);
      assert.notEqual(
        second.json().inputs[0].mediaInputId,
        first.json().inputs[0].mediaInputId,
      );
      const all = await read("");
      assert.equal(all.json().inputs.length, 2);
      const loaded = await f.app.inject({
        method: "GET",
        url: `${f.root}/${encodeURIComponent(second.json().inputs[0].mediaInputId)}`,
        headers: f.headers(),
      });
      assert.equal(loaded.statusCode, 200, loaded.body);
      await f.noExecution();
    },
  );
  test(
    `${backend}: catalog rejects foreign identity, missing read purpose, and malformed cursors`,
    assetTestOptions(backend),
    async (t) => {
      const f = await mediaInputControlFixture(t, backend);
      const read = (suffix = "", headers = f.headers()) =>
        f.app.inject({ method: "GET", url: f.root + suffix, headers });
      assert.equal(
        (await read("", { ...f.headers(), authorization: "" })).statusCode,
        401,
      );
      for (const account of [1, 2, 3])
        assert.ok(
          (await read("", f.headers("read", account))).statusCode >= 400,
        );
      for (const suffix of [
        "?limit=0",
        "?limit=17",
        "?limit=01",
        "?limit=1.0",
        "?limit=1&limit=2",
        "?afterMediaInputId=",
        "?afterMediaInputId=x&afterMediaInputId=y",
        "?owner=other",
        `?afterMediaInputId=${"x".repeat(513)}`,
      ])
        assert.equal((await read(suffix)).statusCode, 400, suffix);
      f.mediaPolicy.read = false;
      assert.equal((await read()).statusCode, 403);
      await f.noExecution();
    },
  );
}
