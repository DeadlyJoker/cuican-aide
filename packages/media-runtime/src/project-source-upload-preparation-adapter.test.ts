import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type {
  ProjectSourceUploadBytePort,
  ProjectSourceUploadParserPort,
} from "@crewon/application";
import {
  ProjectSourceUploadPreparationAdapter,
  ProjectSourceUploadAdapterError,
  PROJECT_SOURCE_UPLOAD_NORMALIZATION_PARSER_VERSION,
} from "./project-source-upload-preparation-adapter.ts";
import { ProjectSourceImportError } from "./project-source-import.ts";

const hash = (input: string | Uint8Array) =>
  `sha256:${createHash("sha256").update(input).digest("hex")}`;
const hasCode = (code: string) => (error: unknown) =>
  (error instanceof ProjectSourceUploadAdapterError ||
    error instanceof ProjectSourceImportError) &&
  error.code === code;
const partOptions = { maximumBytes: 65_536, expectedBytes: null };

test("one immutable host adapter implements the bounded byte and actual parser ports", async () => {
  const adapter = new ProjectSourceUploadPreparationAdapter();
  const bytes: ProjectSourceUploadBytePort = adapter;
  const parser: ProjectSourceUploadParserPort = adapter;
  assert.equal(
    parser.normalizationParserVersion,
    PROJECT_SOURCE_UPLOAD_NORMALIZATION_PARSER_VERSION,
  );
  assert.ok(parser.normalizationParserVersion.length <= 128);
  assert.match(parser.normalizationParserVersion, /utf8\+utf16bom/);
  assert.match(parser.normalizationParserVersion, /scalar-offsets/);
  assert.match(parser.normalizationParserVersion, /parse5@8\.0\.0$/);
  assert.ok(Object.isFrozen(adapter));
  const raw = Buffer.from("第一章 夜航\r\n😀初见");
  const captured = bytes.capture(raw, partOptions);
  raw.fill(0);
  const result = await parser.parse({
    fileName: "小说.txt",
    format: "txt",
    bytes: captured,
  });
  assert.equal(result.fileDigest, bytes.sha256(captured));
  assert.equal(result.digest, hash("第一章 夜航\n😀初见"));
  assert.notEqual(result.digest, result.fileDigest);
  assert.equal(result.byteLength, captured.length);
  assert.equal(result.characterLength, [..."第一章 夜航\n😀初见"].length);
  assert.deepEqual(
    result.chapters.map((c) => c.title),
    ["第一章 夜航"],
  );
  assert.ok(Object.isFrozen(result.chunks[0]));
});

test("native snapshots ignore caller byteLength/length/buffer/offset/iterator getters", () => {
  const adapter = new ProjectSourceUploadPreparationAdapter();
  let invoked = 0;
  const original = new Uint8Array([1, 2, 3]);
  for (const name of ["byteLength", "length", "buffer", "byteOffset"])
    Object.defineProperty(original, name, {
      get() {
        invoked++;
        throw new Error("getter_must_not_run");
      },
    });
  Object.defineProperty(original, Symbol.iterator, {
    get() {
      invoked++;
      throw new Error("iterator_must_not_run");
    },
  });
  const captured = adapter.capture(original, {
    maximumBytes: 3,
    expectedBytes: 3,
  });
  assert.deepEqual(captured, new Uint8Array([1, 2, 3]));
  assert.notEqual(captured, original);
  original[0] = 9;
  assert.equal(captured[0], 1);
  assert.equal(adapter.sha256(original), hash(new Uint8Array([9, 2, 3])));
  assert.equal(invoked, 0);
});

test("byte and options proxies/accessors are rejected before any traps execute", () => {
  const adapter = new ProjectSourceUploadPreparationAdapter();
  let trapped = 0;
  const proxy = new Proxy(new Uint8Array([1]), {
    get() {
      trapped++;
      throw new Error("proxy_get");
    },
    getPrototypeOf() {
      trapped++;
      throw new Error("proxy_prototype");
    },
    ownKeys() {
      trapped++;
      throw new Error("proxy_keys");
    },
  });
  assert.throws(
    () => adapter.capture(proxy, partOptions),
    hasCode("project_source_upload_adapter_bytes_invalid"),
  );
  assert.throws(
    () => adapter.sha256(proxy),
    hasCode("project_source_upload_adapter_bytes_invalid"),
  );
  const options = Object.defineProperty({}, "maximumBytes", {
    enumerable: true,
    get() {
      trapped++;
      return 1;
    },
  });
  assert.throws(
    () => adapter.capture(new Uint8Array([1]), options as typeof partOptions),
    hasCode("project_source_upload_adapter_options_invalid"),
  );
  assert.throws(
    () =>
      adapter.capture(
        new Uint8Array([1]),
        new Proxy(partOptions, {
          ownKeys() {
            trapped++;
            return [];
          },
        }),
      ),
    hasCode("project_source_upload_adapter_options_invalid"),
  );
  assert.equal(trapped, 0);
});

test("actual 20 MB byte ownership/hash and each 64 KiB request limit are independent", () => {
  const adapter = new ProjectSourceUploadPreparationAdapter();
  const original = new Uint8Array(20_000_000).fill(65);
  const captured = adapter.capture(original, {
    maximumBytes: 20_000_000,
    expectedBytes: 20_000_000,
  });
  assert.equal(captured.length, 20_000_000);
  assert.equal(adapter.sha256(captured), hash(original));
  original[0] = 66;
  assert.equal(captured[0], 65);
  assert.notEqual(adapter.sha256(original), adapter.sha256(captured));
  assert.equal(
    adapter.capture(new Uint8Array(65_536), partOptions).length,
    65_536,
  );
  for (const raw of [
    new Uint8Array(0),
    new Uint8Array(65_537),
    new Uint8Array(20_000_001),
  ])
    assert.throws(
      () => adapter.capture(raw, partOptions),
      hasCode("project_source_upload_adapter_bytes_invalid"),
    );
  for (const options of [
    { maximumBytes: 20_000_001, expectedBytes: null },
    { maximumBytes: 65_536, expectedBytes: 65_537 },
    { maximumBytes: 65_536, expectedBytes: 0 },
    { maximumBytes: 1.5, expectedBytes: null },
    { maximumBytes: 65_536, expectedBytes: null, authority: "caller" },
  ])
    assert.throws(
      () => adapter.capture(new Uint8Array([1]), options),
      hasCode("project_source_upload_adapter_options_invalid"),
    );
  assert.throws(
    () =>
      adapter.capture(new Uint8Array([1]), {
        maximumBytes: 3,
        expectedBytes: 3,
      }),
    hasCode("project_source_upload_adapter_bytes_invalid"),
  );
});

test("actual MD/HTML workflows preserve raw hash, normalized text and independent chapter offsets", async () => {
  const adapter = new ProjectSourceUploadPreparationAdapter();
  const md = Buffer.from(
    "前言😀\r\n# 第一章 雨夜\r\n段落 <b>原样</b>\n## 第二章 重逢\n尾声",
  );
  const parsedMd = await adapter.parse({
    fileName: "小说.md",
    format: "md",
    bytes: md,
  });
  assert.equal(parsedMd.fileDigest, hash(md));
  assert.match(parsedMd.chunks.map((c) => c.content).join(""), /<b>原样<\/b>/u);
  assert.deepEqual(
    parsedMd.chapters.map((c) => c.title),
    ["正文", "第一章 雨夜", "第二章 重逢"],
  );
  assert.equal(parsedMd.chapters[1]!.startOffset, [..."前言😀\n"].length);
  const html = Buffer.from(
    '<!DOCTYPE html><html><head><title>不算正文</title></head><body><h1>第一章 &amp; 夜航</h1><p>😀&nbsp;初见</p><script>throw new Error("must not execute")</script><h2>第二章</h2><p>重逢</p></body></html>',
  );
  const parsedHtml = await adapter.parse({
    fileName: "小说.html",
    format: "html",
    bytes: html,
  });
  const normalized = parsedHtml.chunks.map((c) => c.content).join("");
  assert.equal(parsedHtml.fileDigest, hash(html));
  assert.equal(parsedHtml.digest, hash(normalized));
  assert.notEqual(parsedHtml.digest, parsedHtml.fileDigest);
  assert.ok(
    !normalized.includes("不算正文") &&
      !normalized.includes("must not execute"),
  );
  assert.deepEqual(
    parsedHtml.chapters.map((c) => c.title),
    ["第一章 & 夜航", "第二章"],
  );
  assert.equal(
    parsedHtml.chapters[1]!.startOffset,
    [...normalized.slice(0, normalized.indexOf("第二章"))].length,
  );
});

test("original BOM encodings and known content errors are passed through without broad fault remapping", async () => {
  const adapter = new ProjectSourceUploadPreparationAdapter();
  const text = "第一章 夜航\r\n😀初见";
  const raw = Buffer.concat([
    Buffer.from([0xfe, 0xff]),
    Buffer.from(text, "utf16le").swap16(),
  ]);
  const parsed = await adapter.parse({
    fileName: "书.txt",
    format: "txt",
    bytes: raw,
  });
  assert.equal(parsed.fileDigest, hash(raw));
  assert.equal(parsed.digest, hash(text.replaceAll("\r\n", "\n")));
  for (const [bytes, code] of [
    [new Uint8Array([0xc0, 0xaf]), "project_source_import_encoding_invalid"],
    [Buffer.from("\0binary"), "project_source_import_control_content"],
    [Buffer.from("\n\t "), "project_source_import_empty_text"],
    [
      Buffer.from("<!doctype html><html><body>story</body></html>"),
      "project_source_import_format_mismatch",
    ],
  ] as const)
    await assert.rejects(
      adapter.parse({ fileName: "书.txt", format: "txt", bytes }),
      hasCode(code),
    );
  // Invalid host envelope stays an exact parser input fault, not a generic content rejection.
  await assert.rejects(
    adapter.parse({
      fileName: "书.txt",
      format: "txt",
      bytes: Buffer.from("原文"),
      owner: "fake",
    } as never),
    hasCode("project_source_import_fields_invalid"),
  );
});

test("UTF16 under the raw limit which expands past 20 MB UTF8 is rejected with the known explicit code", async () => {
  const adapter = new ProjectSourceUploadPreparationAdapter();
  const raw = Buffer.concat([
    Buffer.from([0xff, 0xfe]),
    Buffer.from("汉".repeat(6_666_667), "utf16le"),
  ]);
  assert.ok(raw.length < 20_000_000);
  await assert.rejects(
    adapter.parse({ fileName: "书.txt", format: "txt", bytes: raw }),
    hasCode("project_source_import_text_limit"),
  );
});
