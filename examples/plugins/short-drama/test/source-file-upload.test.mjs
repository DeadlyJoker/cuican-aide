import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { sourceUploadFixture } from "./source-upload-ui.test-support.mjs";
const request = (file, progress = () => {}) => ({
  file,
  signal: new AbortController().signal,
  progress,
});
test("native File import uses actual whole/part digests and separate 64KiB byte calls, then only accepts actual ready", async () => {
  const f = sourceUploadFixture(),
    driver = f.create(),
    bytes = new TextEncoder().encode("雨😀夜".repeat(7000)),
    progress = [];
  try {
    const file = new File([bytes], "雨夜.md"),
      prepared = await driver.uploadFile(
        request(file, (value) => progress.push(value)),
      );
    assert.equal(
      prepared.fileDigest,
      "sha256:" + createHash("sha256").update(bytes).digest("hex"),
    );
    assert.equal(f.rawCalls.length, Math.ceil(bytes.byteLength / 65536));
    assert.equal(f.rawCalls[0].bytes.byteLength, 65536);
    assert.equal(f.rawCalls.at(-1).bytes.byteLength, bytes.byteLength % 65536);
    assert.deepEqual(
      Buffer.concat(f.rawCalls.map((c) => Buffer.from(c.bytes))),
      Buffer.from(bytes),
    );
    assert.equal(
      f.calls.some((c) => "bytes" in c.input || "content" in c.input),
      false,
    );
    assert.equal(f.calls.filter((c) => c.action.endsWith("prepare")).length, 1);
    assert.equal(progress.at(-1).phase, "preparing");
    assert.equal(f.upload.phase, "ready");
    const again = await driver.uploadFile(
      request(new File([bytes], "雨夜.md")),
    );
    assert.deepEqual(again, prepared);
    assert.equal(f.begins.size, 1);
    assert.equal(f.rawCalls.length, 2);
  } finally {
    driver.dispose();
  }
});
test("lost raw acknowledgement resumes the same begin key/upload and skips the actually acknowledged part", async () => {
  const f = sourceUploadFixture(),
    driver = f.create(),
    bytes = new Uint8Array(65537).fill(65),
    file = new File([bytes], "story.txt");
  try {
    f.loseNextPartReply();
    await assert.rejects(driver.uploadFile(request(file)), /lost_raw_response/);
    const first = f.calls.find((c) => c.action.endsWith("begin")).input,
      id = f.upload.uploadId;
    const result = await driver.uploadFile(
      request(new File([bytes], "story.txt")),
    );
    assert.equal(result.uploadId, id);
    assert.deepEqual(
      f.calls.filter((c) => c.action.endsWith("begin"))[1].input,
      first,
    );
    assert.deepEqual(
      f.rawCalls.map((c) => c.locator.partIndex),
      [0, 1],
    );
    assert.equal(f.begins.size, 1);
  } finally {
    driver.dispose();
  }
});
test("prepare polling is bounded and explicit cancel uses the acknowledged revision without a new upload", async () => {
  const f = sourceUploadFixture({ pending: true }),
    driver = f.create(),
    file = new File(["雨夜"], "story.txt");
  try {
    await assert.rejects(
      driver.uploadFile(request(file)),
      (e) => e.code === "project_source_upload_preparation_pending",
    );
    assert.equal(f.calls.filter((c) => c.action.endsWith("status")).length, 16);
    const current = f.upload;
    await driver.cancelUpload();
    const cancel = f.calls.find((c) => c.action.endsWith("cancel"));
    assert.deepEqual(cancel.input, {
      uploadId: current.uploadId,
      expectedRevision: current.revision,
    });
    assert.equal(f.upload.phase, "cancelled");
    assert.equal(f.begins.size, 1);
  } finally {
    driver.dispose();
  }
});
test("pending preparation reaches ready only through actual status, while normalization rejection keeps its exact user feedback", async () => {
  const ready = sourceUploadFixture({ readyAfterPoll: 2 }),
    driver = ready.create();
  const rejected = sourceUploadFixture({
      rejectedCode: "project_source_import_text_limit",
    }),
    rejectingDriver = rejected.create();
  try {
    const actual = await driver.uploadFile(
      request(new File(["雨夜"], "story.txt")),
    );
    assert.equal(actual.uploadId, ready.upload.uploadId);
    assert.equal(ready.upload.phase, "ready");
    await assert.rejects(
      rejectingDriver.uploadFile(request(new File(["雨夜"], "story.txt"))),
      (e) =>
        e.code === "project_source_import_text_limit" &&
        e.message.includes("UTF-8 后超过 20MB"),
    );
    assert.equal(rejected.upload.phase, "rejected");
    assert.equal(
      rejected.calls.filter((c) => c.action.endsWith("prepare")).length,
      1,
    );
  } finally {
    driver.dispose();
    rejectingDriver.dispose();
  }
});
test("actual original-byte bound and native slots reject oversized, empty or getter-spoofed files before begin", async () => {
  const f = sourceUploadFixture(),
    driver = f.create();
  let touched = 0;
  try {
    await assert.rejects(
      driver.uploadFile(
        request(new File([new Uint8Array(20000001)], "large.txt")),
      ),
      (e) => e.code === "project_source_import_file_limit",
    );
    await assert.rejects(
      driver.uploadFile(request(new File([], "empty.txt"))),
      (e) => e.code === "project_source_import_file_limit",
    );
    await assert.rejects(
      driver.uploadFile(
        request({
          get name() {
            touched++;
            return "fake.txt";
          },
          get size() {
            touched++;
            return 1;
          },
          async arrayBuffer() {
            touched++;
            return new ArrayBuffer(1);
          },
        }),
      ),
      (e) => e.code === "project_source_import_file_invalid",
    );
    assert.equal(touched, 0);
    assert.equal(f.calls.length, 0);
  } finally {
    driver.dispose();
  }
});
