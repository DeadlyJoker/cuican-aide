import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  parseProjectSource,
  parseProjectSourceChunk,
  parseProjectSourceChapter,
  readProjectSourcePage,
} from "@crewon/domain";
import {
  parseProjectSourceFile,
  ProjectSourceImportError,
} from "./project-source-import.ts";
import type { ParsedProjectSourceFile } from "./project-source-import.ts";

function hash(value: string | Uint8Array) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
function hasCode(code: string) {
  return (error: unknown) =>
    error instanceof ProjectSourceImportError && error.code === code;
}
function text(result: ParsedProjectSourceFile) {
  return result.chunks.map((chunk) => chunk.content).join("");
}
function txt(value: string) {
  return parseProjectSourceFile({
    fileName: "小说.txt",
    format: "txt",
    bytes: Buffer.from(value),
  });
}

test("TXT parsing snapshots real bytes, normalizes line endings and returns only immutable source data", () => {
  const original = "前言😀\r\n第一章 夜航\r第一段\n第二章 重逢\n终点";
  const bytes = Buffer.from(original);
  const parsed = parseProjectSourceFile({
    fileName: "小说.TXT",
    format: "txt",
    bytes,
  });
  const normalized = original.replace(/\r\n?/gu, "\n");
  bytes.fill(0);
  assert.equal(text(parsed), normalized);
  assert.equal(parsed.byteLength, Buffer.byteLength(original));
  assert.equal(parsed.characterLength, [...normalized].length);
  assert.equal(parsed.fileDigest, hash(original));
  assert.equal(parsed.digest, hash(normalized));
  assert.notEqual(parsed.fileDigest, parsed.digest);
  assert.deepEqual(
    Object.keys(parsed).sort(),
    [
      "fileName",
      "format",
      "byteLength",
      "characterLength",
      "digest",
      "fileDigest",
      "chunks",
      "chapters",
    ].sort(),
  );
  assert.deepEqual(
    parsed.chapters.map((chapter) => chapter.title),
    ["正文", "第一章 夜航", "第二章 重逢"],
  );
  assert.equal(parsed.chapters[1]!.startOffset, [..."前言😀\n"].length);
  assert.equal(
    parsed.chapters[1]!.endOffset,
    [...normalized.slice(0, normalized.indexOf("第二章"))].length,
  );
  assert.equal(parsed.chapters.at(-1)!.endOffset, parsed.characterLength);
  assert.equal(parsed.chapters[0]!.chapterId, "chapter-000001");
  for (const value of [
    parsed,
    parsed.chunks,
    parsed.chunks[0],
    parsed.chapters,
    parsed.chapters[0],
  ])
    assert.ok(Object.isFrozen(value));
  assert.deepEqual(txt(normalized).chapters, parsed.chapters);
});

test("UTF8 BOM and UTF16 LE/BE BOM prove original file hash while keeping the same normalized source", () => {
  const story = "第一章 雨😀夜\r\nCafé e\u0301\n尾声 重逢";
  const normalized = story.replace(/\r\n?/gu, "\n");
  const le = Buffer.concat([
    Buffer.from([0xff, 0xfe]),
    Buffer.from(story, "utf16le"),
  ]);
  const be = Buffer.concat([
    Buffer.from([0xfe, 0xff]),
    Buffer.from(story, "utf16le").swap16(),
  ]);
  const utf8Bom = Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from(story),
  ]);
  for (const bytes of [le, be, utf8Bom, Buffer.from(story)]) {
    const result = parseProjectSourceFile({
      fileName: "书.txt",
      format: "txt",
      bytes,
    });
    assert.equal(text(result), normalized);
    assert.equal(result.digest, hash(normalized));
    assert.equal(result.fileDigest, hash(bytes));
    assert.equal(result.byteLength, bytes.length);
    assert.ok(text(result).includes("e\u0301"));
    assert.equal(result.chapters[0]!.title, "第一章 雨😀夜");
  }
});

test("strict decoders reject bad, truncated, overlong and surrogate byte encodings", () => {
  for (const bytes of [
    Buffer.from([0xe6, 0x96]),
    Buffer.from([0xc0, 0xaf]),
    Buffer.from([0xed, 0xa0, 0x80]),
    Buffer.from([0xff, 0xfe, 0x41]),
    Buffer.from([0xff, 0xfe, 0x00, 0xd8]),
    Buffer.from([0xfe, 0xff, 0xdc, 0x00]),
    Buffer.from([0x80]),
    Buffer.from([0xff]),
  ]) {
    assert.throws(
      () =>
        parseProjectSourceFile({ fileName: "书.txt", format: "txt", bytes }),
      hasCode("project_source_import_encoding_invalid"),
    );
  }
  assert.throws(
    () =>
      parseProjectSourceFile({
        fileName: "书.txt",
        format: "txt",
        bytes: Buffer.from("story", "utf16le"),
      }),
    hasCode("project_source_import_control_content"),
  );
});

test("controls, binary signatures, unsupported formats, suffix spoofing and empty body fail before persistence", () => {
  for (const value of ["正文\u0000", "正文\u001b", "正文\u007f", "正文\u0085"])
    assert.throws(
      () => txt(value),
      hasCode("project_source_import_control_content"),
    );
  for (const bytes of [
    Buffer.alloc(0),
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from(" \t\r\n "),
  ]) {
    assert.throws(
      () =>
        parseProjectSourceFile({ fileName: "书.txt", format: "txt", bytes }),
      hasCode(
        bytes.length === 0
          ? "project_source_import_empty_file"
          : "project_source_import_empty_text",
      ),
    );
  }
  for (const format of ["txt", "md", "html"] as const) {
    assert.throws(
      () =>
        parseProjectSourceFile({
          fileName: `书.${format}`,
          format,
          bytes: Buffer.from("%PDF-1.7\nstory"),
        }),
      hasCode("project_source_import_binary_content"),
    );
    assert.throws(
      () =>
        parseProjectSourceFile({
          fileName: `书.${format}`,
          format,
          bytes: Buffer.from('<?xml version="1.0"?><book>story</book>'),
        }),
      hasCode("project_source_import_format_mismatch"),
    );
  }
  assert.throws(
    () => txt("<!doctype html><html><body>story</body></html>"),
    hasCode("project_source_import_format_mismatch"),
  );
  assert.throws(
    () => txt("<p>story</p>"),
    hasCode("project_source_import_format_mismatch"),
  );
  assert.throws(
    () =>
      parseProjectSourceFile({
        fileName: "书.md",
        format: "md",
        bytes: Buffer.from("<html><body>story</body></html>"),
      }),
    hasCode("project_source_import_format_mismatch"),
  );
  assert.throws(
    () =>
      parseProjectSourceFile({
        fileName: "书.txt.exe",
        format: "txt",
        bytes: Buffer.from("story"),
      }),
    hasCode("project_source_import_format_mismatch"),
  );
  assert.throws(
    () =>
      parseProjectSourceFile({
        fileName: "书.html",
        format: "txt",
        bytes: Buffer.from("story"),
      }),
    hasCode("project_source_import_format_mismatch"),
  );
  assert.throws(
    () =>
      parseProjectSourceFile({
        fileName: "../书.txt",
        format: "txt",
        bytes: Buffer.from("story"),
      }),
    hasCode("project_source_import_file_name_invalid"),
  );
  assert.throws(
    () =>
      parseProjectSourceFile({
        fileName: "书.pdf",
        format: "pdf" as never,
        bytes: Buffer.from("story"),
      }),
    hasCode("project_source_import_format_invalid"),
  );
});

test("Markdown retains source syntax and inline HTML while identifying headings outside code fences", () => {
  const story =
    "前言😀\n# 第一章 雨夜 #\n人物 **A** 与 <em>B</em>。\n```md\n# 代码中的标题\n```\n第二章 重逢\n==========\n正文\n~~~\n第三章\n------\n~~~\n## 终章\n结尾";
  const result = parseProjectSourceFile({
    fileName: "书.markdown",
    format: "md",
    bytes: Buffer.from(story),
  });
  assert.equal(text(result), story);
  assert.deepEqual(
    result.chapters.map((chapter) => chapter.title),
    ["正文", "第一章 雨夜", "第二章 重逢", "终章"],
  );
  for (const [index, marker] of [
    [1, "# 第一章"],
    [2, "第二章 重逢"],
    [3, "## 终章"],
  ] as const)
    assert.equal(
      result.chapters[index]!.startOffset,
      [...story.slice(0, story.indexOf(marker))].length,
    );
  assert.equal(result.chapters[2]!.endOffset, result.chapters[3]!.startOffset);
  assert.equal(result.digest, hash(story));
});

test("chapter-like TXT titles without separator and title tabs retain real scalar ranges", () => {
  const source = "第１章夜航\nA😀\n第二章\t重逢\n结尾";
  const parsed = txt(source);
  assert.deepEqual(
    parsed.chapters.map((chapter) => chapter.title),
    ["第１章夜航", "第二章 重逢"],
  );
  assert.equal(
    parsed.chapters[1]!.startOffset,
    [..."第１章夜航\nA😀\n"].length,
  );
  assert.equal(text(parsed), source);
});

test("typed-array snapshots and command fields reject malicious accessors without invocation", () => {
  let calls = 0;
  const input = {
    fileName: "书.txt",
    format: "txt" as const,
    bytes: Buffer.from("story"),
  };
  const getter = Object.defineProperty({ ...input }, "bytes", {
    enumerable: true,
    get() {
      calls++;
      throw new Error("not data");
    },
  });
  assert.throws(
    () => parseProjectSourceFile(getter),
    hasCode("project_source_import_fields_invalid"),
  );
  assert.equal(calls, 0);
  assert.throws(
    () => parseProjectSourceFile(new Proxy(input, {})),
    hasCode("project_source_import_input_invalid"),
  );
  assert.throws(
    () =>
      parseProjectSourceFile({ ...input, bytes: new Proxy(input.bytes, {}) }),
    hasCode("project_source_import_bytes_invalid"),
  );
  const extra = { ...input, text: "injected" };
  assert.throws(
    () => parseProjectSourceFile(extra),
    hasCode("project_source_import_fields_invalid"),
  );
  assert.throws(
    () => parseProjectSourceFile({ ...input, bytes: "story" as never }),
    hasCode("project_source_import_bytes_invalid"),
  );
});

test("parsed data binds to existing source records and preserves actual Unicode window coverage", () => {
  const parsed = txt("第一章\n" + "甲😀é".repeat(2_000) + "\n第二章\n结尾");
  const scope = { tenantId: "tenant", spaceId: "space", projectId: "project" };
  const { chunks, chapters, ...manifest } = parsed;
  const source = parseProjectSource({
    schemaVersion: "crewon.project-source.v1",
    ...scope,
    ...manifest,
    revision: 1,
    createdByActorId: "human",
    createdAt: "2026-10-08T00:00:00.000Z",
  });
  const boundChunks = chunks.map((chunk) =>
    parseProjectSourceChunk({ ...scope, sourceRevision: 1, ...chunk }),
  );
  const boundChapters = chapters.map((chapter) =>
    parseProjectSourceChapter({ ...scope, sourceRevision: 1, ...chapter }),
  );
  assert.equal(boundChapters[0]!.endOffset, boundChapters[1]!.startOffset);
  const startOffset = chunks[1]!.startOffset - 2,
    limit = 10;
  const window = boundChunks.filter(
    (chunk) =>
      chunk.startOffset < startOffset + limit &&
      chunk.startOffset + [...chunk.content].length > startOffset,
  );
  const page = readProjectSourcePage({
    source,
    chunks: window,
    startOffset,
    limit,
  });
  assert.equal(
    page.content,
    [...text(parsed)].slice(startOffset, startOffset + limit).join(""),
  );
  for (const chunk of parsed.chunks)
    assert.equal(chunk.digest, hash(chunk.content));
});
