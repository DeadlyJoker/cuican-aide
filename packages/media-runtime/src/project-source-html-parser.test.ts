import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  parseProjectSourceFile,
  ProjectSourceImportError,
} from "./project-source-import.ts";

function html(value: string) {
  return parseProjectSourceFile({
    fileName: "原文.html",
    format: "html",
    bytes: Buffer.from(value),
  });
}
function hasCode(code: string) {
  return (error: unknown) =>
    error instanceof ProjectSourceImportError && error.code === code;
}

test("HTML parses entities and malformed tree nesting while excluding non-story content without resources", () => {
  const document = `<!doctype html><html><head><title>后台标题</title><style>body{color:red}</style></head><body>
  <nav>站点导航</nav><h1>第一章 &amp; 雨😀夜</h1><p>人物 <em>A</em>&nbsp;与 B。<br>下一行<p>下一段&#x1F600;
  <script>globalThis.fetch('https://should-never-be-called.example')</script><template>隐藏模板</template>
  <iframe src="https://should-never-be-called.example">远端页面</iframe><img src="https://should-never-be-called.example/p.png">
  <div hidden>隐藏元素</div><div aria-hidden="true">无障碍隐藏</div><footer>页脚</footer>
  <h2>第二章 重逢</h2><p>结尾 &lt;标签&gt;。</body></html>`;
  const parsed = html(document);
  const story = parsed.chunks.map((chunk) => chunk.content).join("");
  assert.equal(
    story,
    "第一章 & 雨😀夜\n人物 A 与 B。\n下一行\n下一段😀\n第二章 重逢\n结尾 <标签>。",
  );
  assert.deepEqual(
    parsed.chapters.map((chapter) => chapter.title),
    ["第一章 & 雨😀夜", "第二章 重逢"],
  );
  assert.equal(
    parsed.chapters[1]!.startOffset,
    [...story.slice(0, story.indexOf("第二章"))].length,
  );
  assert.equal(parsed.chapters[0]!.endOffset, parsed.chapters[1]!.startOffset);
  assert.equal(parsed.chapters[1]!.endOffset, [...story].length);
  assert.equal(
    parsed.fileDigest,
    `sha256:${createHash("sha256").update(document).digest("hex")}`,
  );
  assert.equal(
    parsed.digest,
    `sha256:${createHash("sha256").update(story).digest("hex")}`,
  );
});

test("HTML preserves preformatted story layout, inline adjacency, and introductions before chapter headings", () => {
  const parsed = html(
    "<p>前言</p><h2>第一章 <em>雨夜</em></h2><p>甲<strong>乙</strong> 丙 <span>丁</span></p><pre>  行一\n\t行二</pre><h2>第二章</h2><p>结尾</p>",
  );
  const story = parsed.chunks.map((chunk) => chunk.content).join("");
  assert.equal(
    story,
    "前言\n第一章 雨夜\n甲乙 丙 丁\n  行一\n\t行二\n第二章\n结尾",
  );
  assert.deepEqual(
    parsed.chapters.map((chapter) => chapter.title),
    ["正文", "第一章 雨夜", "第二章"],
  );
  assert.equal(parsed.chapters[1]!.startOffset, 3);
});

test("script/style/head-only documents are empty and entity controls cannot disguise binary content", () => {
  for (const document of [
    "<head><title>标题</title></head><body><script>alert(1)</script><style>body{}</style></body>",
    "<template><p>不是正文</p></template>",
    "<div hidden>hidden</div>",
  ])
    assert.throws(
      () => html(document),
      hasCode("project_source_import_empty_text"),
    );
  for (const entity of ["&#0;", "&#xD800;", "&#x7F;", "&#xFFFF;"])
    assert.throws(
      () => html(`<p>正文${entity}</p>`),
      hasCode("project_source_import_control_content"),
    );
});

test("HTML tree depth and node counts are bounded before constructing an unbounded document", () => {
  assert.throws(
    () => html(`${"<div>".repeat(300)}故事${"</div>".repeat(300)}`),
    hasCode("project_source_import_html_depth_limit"),
  );
  assert.throws(
    () => html("<p>x</p>".repeat(100_001)),
    hasCode("project_source_import_html_node_limit"),
  );
});
