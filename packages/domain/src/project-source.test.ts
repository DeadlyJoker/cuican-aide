import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  assertProjectSourceChapterIdentity,
  assertProjectSourceChunkIdentity,
  parseProjectSource,
  parseProjectSourceChapter,
  parseProjectSourceChunk,
  PROJECT_SOURCE_MAX_FILE_BYTES,
  PROJECT_SOURCE_MAX_PAGE_CHUNKS,
  ProjectSourceError,
  projectSourceScalarLength,
  readProjectSourcePage,
  type ProjectSource,
  type ProjectSourceChunk,
  type ReadProjectSourcePageInput,
} from "./project-source.ts";

const scope = { tenantId: "tenant", spaceId: "space", projectId: "project" };
const at = "2026-10-08T00:00:00.000Z";
const hash = (text: string) =>
  `sha256:${createHash("sha256").update(text).digest("hex")}`;

function sourceFor(content: string): ProjectSource {
  return parseProjectSource({
    schemaVersion: "crewon.project-source.v1",
    ...scope,
    revision: 1,
    digest: hash(content),
    fileDigest: hash(content),
    fileName: "原著.txt",
    format: "txt",
    byteLength: new TextEncoder().encode(content).length,
    characterLength: projectSourceScalarLength(content),
    createdByActorId: "actor",
    createdAt: at,
  });
}

function chunk(
  content: string,
  index = 0,
  startOffset = 0,
): ProjectSourceChunk {
  return parseProjectSourceChunk({
    ...scope,
    sourceRevision: 1,
    index,
    startOffset,
    content,
    digest: hash(content),
  });
}

function chunksFor(content: string, size: number): ProjectSourceChunk[] {
  const points = [...content];
  const chunks: ProjectSourceChunk[] = [];
  for (let offset = 0; offset < points.length; offset += size)
    chunks.push(
      chunk(
        points.slice(offset, offset + size).join(""),
        chunks.length,
        offset,
      ),
    );
  return chunks;
}

function windowFor(
  chunks: readonly ProjectSourceChunk[],
  startOffset: number,
  endOffset: number,
) {
  return chunks.filter(
    (item) =>
      item.startOffset < endOffset &&
      item.startOffset + projectSourceScalarLength(item.content) > startOffset,
  );
}

function hasCode(code: string) {
  return (error: unknown) =>
    error instanceof ProjectSourceError && error.code === code;
}

const source = sourceFor("A😀中\n故事结束");
const first = chunk("A😀中");
const chapter = parseProjectSourceChapter({
  ...scope,
  sourceRevision: 1,
  chapterId: "chapter-1",
  title: "第一章",
  startOffset: 0,
  endOffset: source.characterLength,
});

test("source manifests detach their input and contain no source text", () => {
  const mutable = { ...source };
  const parsed = parseProjectSource(mutable);
  mutable.fileName = "changed.txt";
  mutable.projectId = "changed";
  assert.equal(parsed.fileName, "原著.txt");
  assert.equal(parsed.projectId, "project");
  assert.notEqual(parsed, source);
  assert.ok(Object.isFrozen(parsed));
  assert.ok(!Object.hasOwn(parsed, "content"));
  assert.throws(
    () => parseProjectSource({ ...source, content: "whole novel" }),
    hasCode("project_source_fields_invalid"),
  );
  const { fileDigest: _fileDigest, ...missingFileDigest } = source;
  assert.throws(
    () => parseProjectSource(missingFileDigest),
    hasCode("project_source_fields_invalid"),
  );
  assert.throws(
    () =>
      parseProjectSource({
        ...source,
        schemaVersion: "crewon.project-source.v2",
      }),
    hasCode("project_source_schema_unsupported"),
  );
  assert.throws(
    () => parseProjectSource({ ...source, format: "pdf" }),
    hasCode("project_source_format_invalid"),
  );
  for (const format of ["txt", "md", "html"])
    assert.equal(parseProjectSource({ ...source, format }).format, format);
});

test("manifest limits distinguish original decimal byte size from normalized scalar count", () => {
  assert.equal(PROJECT_SOURCE_MAX_FILE_BYTES, 20_000_000);
  assert.equal(
    parseProjectSource({ ...source, byteLength: 20_000_000 }).byteLength,
    20_000_000,
  );
  assert.equal(
    parseProjectSource({
      ...source,
      byteLength: 1,
      characterLength: 99_999_999,
    }).characterLength,
    99_999_999,
  );
  for (const byteLength of [
    0,
    -1,
    20_000_001,
    1.5,
    Number.MAX_SAFE_INTEGER + 1,
  ])
    assert.throws(
      () => parseProjectSource({ ...source, byteLength }),
      hasCode("project_source_range_invalid"),
    );
  for (const byteLength of [NaN, Infinity])
    assert.throws(
      () => parseProjectSource({ ...source, byteLength }),
      hasCode("project_source_json_invalid"),
    );
  for (const key of ["revision", "characterLength"])
    for (const value of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])
      assert.throws(
        () => parseProjectSource({ ...source, [key]: value }),
        hasCode("project_source_range_invalid"),
      );
});

test("HTML metadata preserves separate raw-file and normalized-text identities without claiming parsing", () => {
  const raw = "<p>A😀</p>";
  const normalized = "A😀";
  const html = parseProjectSource({
    ...sourceFor(normalized),
    format: "html",
    fileName: "原著.html",
    fileDigest: hash(raw),
    byteLength: new TextEncoder().encode(raw).length,
  });
  assert.notEqual(html.fileDigest, html.digest);
  assert.equal(html.characterLength, 2);
  assert.equal(html.byteLength, 12);
  const page = readProjectSourcePage({
    source: html,
    chunks: [chunk(normalized)],
    startOffset: 0,
    limit: 10,
  });
  assert.equal(page.content, normalized);
  assert.equal(page.endOffset, 2);
  assert.equal(page.nextOffset, null);
});

test("manifest and chunk digest validators validate syntax, leaving verification to the store", () => {
  const unverifiedDigest = `sha256:${"0".repeat(64)}`;
  assert.equal(
    parseProjectSource({
      ...source,
      digest: unverifiedDigest,
      fileDigest: unverifiedDigest,
    }).digest,
    unverifiedDigest,
  );
  const unverifiedChunk = parseProjectSourceChunk({
    ...first,
    digest: unverifiedDigest,
  });
  assert.doesNotThrow(() =>
    assertProjectSourceChunkIdentity(source, unverifiedChunk),
  );
  for (const digest of [
    "0".repeat(64),
    `sha256:${"A".repeat(64)}`,
    "sha256:123",
    "md5:abc",
  ])
    for (const key of ["digest", "fileDigest"])
      assert.throws(
        () => parseProjectSource({ ...source, [key]: digest }),
        hasCode("project_source_digest_invalid"),
      );
});

test("file names, canonical timestamps and actors use bounded exact metadata", () => {
  assert.equal(
    parseProjectSource({ ...source, fileName: "文".repeat(255) }).fileName
      .length,
    255,
  );
  for (const fileName of [
    "",
    " bad.txt",
    "bad.txt ",
    ".",
    "..",
    "../book.txt",
    "a/b.txt",
    "a\\b.txt",
    "bad\n.txt",
    "文".repeat(256),
  ])
    assert.throws(
      () => parseProjectSource({ ...source, fileName }),
      hasCode("project_source_file_name_invalid"),
    );
  assert.throws(
    () => parseProjectSource({ ...source, createdAt: "2026-10-08" }),
    hasCode("project_source_timestamp_invalid"),
  );
  assert.throws(
    () => parseProjectSource({ ...source, createdByActorId: "" }),
    hasCode("project_source_identity_invalid"),
  );
});

test("all public records reject malformed Unicode and getters without invoking them", () => {
  assert.equal(projectSourceScalarLength("A😀中"), 3);
  for (const malformed of ["\ud800", "\udfff", "a\ud800b", "😀\udfff"])
    assert.throws(
      () => projectSourceScalarLength(malformed),
      hasCode("project_source_unicode_invalid"),
    );
  for (const malformed of ["\ud800", "\udfff"]) {
    assert.throws(
      () => parseProjectSource({ ...source, fileName: malformed }),
      hasCode("project_source_json_invalid"),
    );
    assert.throws(
      () => parseProjectSourceChunk({ ...first, content: malformed }),
      hasCode("project_source_json_invalid"),
    );
    assert.throws(
      () => parseProjectSourceChapter({ ...chapter, title: malformed }),
      hasCode("project_source_json_invalid"),
    );
  }
  let invoked = false;
  const withGetter = Object.defineProperty({ ...source }, "fileName", {
    enumerable: true,
    get() {
      invoked = true;
      return "surprise.txt";
    },
  });
  assert.throws(
    () => parseProjectSource(withGetter),
    hasCode("project_source_json_invalid"),
  );
  assert.equal(invoked, false);
  assert.throws(
    () => parseProjectSource({ ...source, [Symbol("injected")]: "value" }),
    hasCode("project_source_json_invalid"),
  );
  assert.throws(
    () =>
      parseProjectSource(
        Object.assign(Object.create({ injected: true }), source),
      ),
    hasCode("project_source_json_invalid"),
  );
});

test("chunks are immutable nonempty records bounded by UTF8 bytes and ordinal offsets", () => {
  assert.ok(Object.isFrozen(first));
  assert.notEqual(parseProjectSourceChunk(first), first);
  assert.equal(chunk("a".repeat(4_096)).content.length, 4_096);
  assert.equal(
    projectSourceScalarLength(chunk("😀".repeat(1_024)).content),
    1_024,
  );
  assert.equal(chunk("\n\t ").content, "\n\t ");
  assert.throws(
    () => chunk("😀".repeat(1_025)),
    hasCode("project_source_chunk_limit"),
  );
  assert.throws(
    () => chunk("a".repeat(4_097)),
    hasCode("project_source_chunk_content_invalid"),
  );
  assert.throws(
    () => chunk(""),
    hasCode("project_source_chunk_content_invalid"),
  );
  assert.throws(
    () => parseProjectSourceChunk({ ...first, schemaVersion: "unexpected" }),
    hasCode("project_source_fields_invalid"),
  );
  for (const [index, startOffset] of [
    [0, 1],
    [1, 0],
    [1, 4_097],
    [4, 3],
  ])
    assert.throws(
      () => chunk("a", index, startOffset),
      hasCode("project_source_chunk_offset_invalid"),
    );
  for (const [index, startOffset] of [
    [-1, 0],
    [0, -1],
    [0.5, 0],
    [0, Number.MAX_SAFE_INTEGER + 1],
  ])
    assert.throws(
      () => chunk("a", index, startOffset),
      hasCode("project_source_range_invalid"),
    );
  assert.throws(
    () => chunk("ab", Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER),
    hasCode("project_source_chunk_offset_invalid"),
  );
});

test("chapters retain their own identity and half-open scalar ranges", () => {
  assert.ok(Object.isFrozen(chapter));
  assert.notEqual(parseProjectSourceChapter(chapter), chapter);
  assert.equal(
    parseProjectSourceChapter({ ...chapter, title: "a".repeat(320) }).title
      .length,
    320,
  );
  assert.equal(
    parseProjectSourceChapter({ ...chapter, title: "😀".repeat(160) }).title
      .length,
    320,
  );
  for (const title of [
    "",
    " leading",
    "trailing ",
    "a".repeat(321),
    "😀".repeat(161),
  ])
    assert.throws(
      () => parseProjectSourceChapter({ ...chapter, title }),
      hasCode("project_source_chapter_title_invalid"),
    );
  for (const endOffset of [0, chapter.startOffset, -1])
    assert.throws(
      () => parseProjectSourceChapter({ ...chapter, endOffset }),
      (error) => error instanceof ProjectSourceError,
    );
  assert.throws(
    () =>
      parseProjectSourceChapter({ ...chapter, startOffset: 4, endOffset: 3 }),
    hasCode("project_source_chapter_range_invalid"),
  );
  assert.throws(
    () => parseProjectSourceChapter({ ...chapter, episodeId: "episode-1" }),
    hasCode("project_source_fields_invalid"),
  );
  assert.doesNotThrow(() =>
    assertProjectSourceChapterIdentity(source, chapter),
  );
  assert.throws(
    () =>
      assertProjectSourceChapterIdentity(source, {
        ...chapter,
        endOffset: source.characterLength + 1,
      }),
    hasCode("project_source_chapter_range_invalid"),
  );
});

test("chunk and chapter identity checks reject each cross-scope and stale-revision reference", () => {
  assert.doesNotThrow(() => assertProjectSourceChunkIdentity(source, first));
  for (const key of ["tenantId", "spaceId", "projectId"] as const) {
    assert.throws(
      () =>
        assertProjectSourceChunkIdentity(source, { ...first, [key]: "other" }),
      hasCode("project_source_scope_mismatch"),
    );
    assert.throws(
      () =>
        assertProjectSourceChapterIdentity(source, {
          ...chapter,
          [key]: "other",
        }),
      hasCode("project_source_scope_mismatch"),
    );
  }
  assert.throws(
    () =>
      assertProjectSourceChunkIdentity(source, { ...first, sourceRevision: 2 }),
    hasCode("project_source_revision_mismatch"),
  );
  assert.throws(
    () =>
      assertProjectSourceChapterIdentity(source, {
        ...chapter,
        sourceRevision: 2,
      }),
    hasCode("project_source_revision_mismatch"),
  );
  assert.throws(
    () =>
      assertProjectSourceChunkIdentity(
        source,
        chunk("abc", 1, source.characterLength - 1),
      ),
    hasCode("project_source_chunk_range_invalid"),
  );
  assert.throws(
    () =>
      assertProjectSourceChunkIdentity(
        source,
        chunk("a", 1, source.characterLength),
      ),
    hasCode("project_source_chunk_range_invalid"),
  );
});

test("bounded pages slice Unicode scalar ranges across chunks and accept middle-of-book windows", () => {
  const text = "开😀场\nA中B🚀尾声";
  const manifest = sourceFor(text);
  const chunks = chunksFor(text, 3);
  const page = readProjectSourcePage({
    source: manifest,
    chunks: chunks.slice(1),
    startOffset: 4,
    limit: 5,
  });
  assert.deepEqual(page, {
    sourceRevision: 1,
    startOffset: 4,
    endOffset: 9,
    content: [...text].slice(4, 9).join(""),
    nextOffset: 9,
  });
  assert.ok(Object.isFrozen(page));
  const final = readProjectSourcePage({
    source: manifest,
    chunks: chunks.slice(-1),
    startOffset: 9,
    limit: 1_024,
  });
  assert.equal(final.content, [...text].slice(9).join(""));
  assert.equal(final.nextOffset, null);
});

test("paging a large source uses individual windows and neither omits nor duplicates Unicode scalars", () => {
  const text = "甲😀\n乙A🚀".repeat(500);
  const manifest = sourceFor(text);
  const chunks = chunksFor(text, 97);
  let offset = 0;
  const contents: string[] = [];
  while (offset < manifest.characterLength) {
    const page = readProjectSourcePage({
      source: manifest,
      chunks: windowFor(
        chunks,
        offset,
        Math.min(offset + 1_024, manifest.characterLength),
      ),
      startOffset: offset,
      limit: 1_024,
    });
    assert.ok(projectSourceScalarLength(page.content) <= 1_024);
    assert.equal(
      page.endOffset - page.startOffset,
      projectSourceScalarLength(page.content),
    );
    contents.push(page.content);
    offset = page.nextOffset ?? manifest.characterLength;
  }
  assert.equal(contents.join(""), text);
  assert.deepEqual(
    readProjectSourcePage({
      source: manifest,
      chunks: [],
      startOffset: offset,
      limit: 1,
    }),
    {
      sourceRevision: 1,
      startOffset: offset,
      endOffset: offset,
      content: "",
      nextOffset: null,
    },
  );
});

test("page bounds, coverage, scope and continuity fail closed", () => {
  const manifest = sourceFor("a😀bc中de🚀fg");
  const chunks = chunksFor("a😀bc中de🚀fg", 3);
  const input = { source: manifest, chunks, startOffset: 0, limit: 9 };
  for (const limit of [0, -1, 1_025, 0.5])
    assert.throws(
      () => readProjectSourcePage({ ...input, limit }),
      hasCode("project_source_range_invalid"),
    );
  for (const startOffset of [-1, 0.5, manifest.characterLength + 1])
    assert.throws(
      () => readProjectSourcePage({ ...input, startOffset }),
      hasCode("project_source_range_invalid"),
    );
  assert.throws(
    () => readProjectSourcePage({ ...input, chunks: [] }),
    hasCode("project_source_page_coverage_invalid"),
  );
  assert.throws(
    () => readProjectSourcePage({ ...input, chunks: [chunks[0]!] }),
    hasCode("project_source_page_coverage_invalid"),
  );
  assert.throws(
    () => readProjectSourcePage({ ...input, chunks: chunks.slice(1) }),
    hasCode("project_source_page_coverage_invalid"),
  );
  assert.throws(
    () =>
      readProjectSourcePage({
        ...input,
        chunks: chunks.slice(0, 1),
        startOffset: 3,
        limit: 1,
      }),
    hasCode("project_source_page_coverage_invalid"),
  );
  for (const changed of [
    { ...chunks[1]!, index: 2 },
    { ...chunks[1]!, startOffset: 4 },
    { ...chunks[1]!, startOffset: 2 },
  ])
    assert.throws(
      () => readProjectSourcePage({ ...input, chunks: [chunks[0]!, changed] }),
      hasCode("project_source_window_continuity_invalid"),
    );
  assert.throws(
    () => readProjectSourcePage({ ...input, chunks: [...chunks].reverse() }),
    hasCode("project_source_window_continuity_invalid"),
  );
  for (const key of ["tenantId", "spaceId", "projectId"] as const)
    assert.throws(
      () =>
        readProjectSourcePage({
          ...input,
          chunks: [{ ...chunks[0]!, [key]: "other" }],
        }),
      hasCode("project_source_scope_mismatch"),
    );
  assert.throws(
    () =>
      readProjectSourcePage({
        ...input,
        chunks: [{ ...chunks[0]!, sourceRevision: 2 }],
      }),
    hasCode("project_source_revision_mismatch"),
  );
  assert.throws(
    () =>
      readProjectSourcePage({
        ...input,
        startOffset: manifest.characterLength,
      }),
    hasCode("project_source_window_invalid"),
  );
});

test("page input cannot smuggle extra fields, oversized windows, sparse arrays or accessor side effects", () => {
  const input: ReadProjectSourcePageInput = {
    source,
    chunks: [first],
    startOffset: 0,
    limit: 1,
  };
  assert.throws(
    () =>
      readProjectSourcePage({
        ...input,
        rawText: "whole book",
      } as ReadProjectSourcePageInput),
    hasCode("project_source_fields_invalid"),
  );
  assert.throws(
    () =>
      readProjectSourcePage({
        ...input,
        chunks: Array(PROJECT_SOURCE_MAX_PAGE_CHUNKS + 1).fill(first),
      }),
    hasCode("project_source_window_invalid"),
  );
  assert.throws(
    () => readProjectSourcePage({ ...input, chunks: Array(2) }),
    hasCode("project_source_json_invalid"),
  );
  let invoked = false;
  const getterChunks = Object.defineProperty([first], "0", {
    get() {
      invoked = true;
      return first;
    },
  });
  assert.throws(
    () => readProjectSourcePage({ ...input, chunks: getterChunks }),
    hasCode("project_source_json_invalid"),
  );
  const getterEnvelope = Object.defineProperty({ ...input }, "source", {
    get() {
      invoked = true;
      return source;
    },
  });
  assert.throws(
    () => readProjectSourcePage(getterEnvelope),
    hasCode("project_source_json_invalid"),
  );
  assert.equal(invoked, false);
  const extraChunks = Object.assign([first], { injected: true });
  assert.throws(
    () => readProjectSourcePage({ ...input, chunks: extraChunks }),
    hasCode("project_source_json_invalid"),
  );
  assert.throws(
    () => readProjectSourcePage({ ...input, [Symbol("injected")]: true }),
    hasCode("project_source_json_invalid"),
  );
});
