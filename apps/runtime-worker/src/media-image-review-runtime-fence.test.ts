import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SqliteRunStore } from "@crewon/store";
import { mediaImageReviewRuntimeFence } from "./media-image-review-runtime-fence.ts";

test("media review requires the original SQLite owner even for transparent instrumentation", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "crewon-review-owner-"));
  const store = new SqliteRunStore(join(directory, "store.sqlite"));
  t.after(async () => {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  });
  assert.equal(typeof mediaImageReviewRuntimeFence(store), "function");
  assert.throws(
    () => mediaImageReviewRuntimeFence(new Proxy(store, {})),
    /media_image_review_original_store_required/u,
  );
});
