import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

hljs.registerLanguage("bash", bash);
hljs.registerLanguage("css", css);
hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("json", json);
hljs.registerLanguage("markdown", markdown);
hljs.registerLanguage("python", python);
hljs.registerLanguage("rust", rust);
hljs.registerLanguage("sql", sql);
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("yaml", yaml);

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  bash: "bash",
  css: "css",
  htm: "xml",
  html: "xml",
  js: "javascript",
  json: "json",
  jsonl: "json",
  jsx: "javascript",
  md: "markdown",
  mjs: "javascript",
  py: "python",
  rs: "rust",
  sh: "bash",
  sql: "sql",
  svg: "xml",
  toml: "yaml",
  ts: "typescript",
  tsx: "typescript",
  xml: "xml",
  yaml: "yaml",
  yml: "yaml",
  zsh: "bash",
};

export function workbenchCodeLanguage(path: string): string | null {
  const filename = path.replace(/\\/g, "/").split("/").pop()?.toLowerCase();
  if (!filename) {
    return null;
  }
  if (["dockerfile", "makefile"].includes(filename)) {
    return "bash";
  }
  const extension = filename.includes(".") ? filename.split(".").pop() : null;
  return extension ? (LANGUAGE_BY_EXTENSION[extension] ?? null) : null;
}

export function highlightWorkbenchCode(content: string, path: string): string {
  const language = workbenchCodeLanguage(path);
  if (!language) {
    return hljs.highlightAuto(content).value;
  }
  return hljs.highlight(content, { language }).value;
}

export function CommandWorkbenchCode({
  content,
  path,
}: {
  content: string;
  path: string;
}) {
  const lines = content.split("\n");
  const highlighted = highlightWorkbenchCode(content, path);
  return (
    <div className="command-file-code" role="region" aria-label={path}>
      <pre className="command-file-line-numbers" aria-hidden="true">
        {lines.map((_, index) => (
          <span key={index}>{index + 1}</span>
        ))}
      </pre>
      <pre className="command-file-highlighted-code">
        <code dangerouslySetInnerHTML={{ __html: highlighted }} />
      </pre>
    </div>
  );
}
