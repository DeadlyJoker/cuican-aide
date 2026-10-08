import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  parseProjectSourceFile,
  ProjectSourceImportError,
} from "./project-source-import.ts";

function hasCode(code: string) {
  return (error: unknown) =>
    error instanceof ProjectSourceImportError && error.code === code;
}

test("actual decimal 20MB Unicode source retains all scalars in independently hashed safe chunks", () => {
  const bytes = Buffer.from("😀".repeat(5_000_000));
  assert.equal(bytes.length, 20_000_000);
  const parsed = parseProjectSourceFile({
    fileName: "最大原文.txt",
    format: "txt",
    bytes,
  });
  assert.equal(parsed.byteLength, 20_000_000);
  assert.equal(parsed.characterLength, 5_000_000);
  const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  assert.equal(parsed.fileDigest, digest);
  assert.equal(parsed.digest, digest);
  const aggregate = createHash("sha256");
  let offset = 0;
  for (const chunk of parsed.chunks) {
    assert.equal(chunk.startOffset, offset);
    assert.ok(Buffer.byteLength(chunk.content) <= 4_096);
    assert.equal(
      chunk.digest,
      `sha256:${createHash("sha256").update(chunk.content).digest("hex")}`,
    );
    const count = chunk.content.length / 2;
    assert.equal([...chunk.content].length, count);
    offset += count;
    aggregate.update(chunk.content);
  }
  assert.equal(offset, 5_000_000);
  assert.equal(`sha256:${aggregate.digest("hex")}`, digest);
  assert.deepEqual(parsed.chapters, [
    {
      chapterId: "chapter-000001",
      title: "正文",
      startOffset: 0,
      endOffset: 5_000_000,
    },
  ]);
  assert.equal(parsed.chunks.length, Math.ceil(20_000_000 / 4_096));
});

test("raw files above 20MB and UTF16 normalized text above 20MB are independently refused", () => {
  assert.throws(
    () =>
      parseProjectSourceFile({
        fileName: "超限.txt",
        format: "txt",
        bytes: Buffer.alloc(20_000_001, 0x61),
      }),
    hasCode("project_source_import_file_limit"),
  );
  const utf16 = Buffer.concat([
    Buffer.from([0xff, 0xfe]),
    Buffer.from("文".repeat(6_666_667), "utf16le"),
  ]);
  assert.ok(utf16.length < 20_000_000);
  assert.throws(
    () =>
      parseProjectSourceFile({
        fileName: "编码扩展.txt",
        format: "txt",
        bytes: utf16,
      }),
    hasCode("project_source_import_text_limit"),
  );
});
