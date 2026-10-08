import { defaultTreeAdapter, parse } from "parse5";
import type { DefaultTreeAdapterTypes, TreeAdapter } from "parse5";
import type { ProjectSourceHeading } from "./project-source-import-types.ts";
import { addHeading } from "./project-source-text-chapters.ts";
import {
  sourceImportFailure,
  sourceScalarLength,
} from "./project-source-import-validation.ts";

const excluded = new Set([
  "head",
  "script",
  "style",
  "template",
  "noscript",
  "iframe",
  "object",
  "embed",
  "svg",
  "math",
  "canvas",
  "audio",
  "video",
  "nav",
  "header",
  "footer",
  "aside",
  "form",
  "button",
  "input",
  "select",
  "textarea",
]);
const blocks = new Set([
  "address",
  "article",
  "blockquote",
  "dd",
  "div",
  "dl",
  "dt",
  "figcaption",
  "figure",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "li",
  "main",
  "ol",
  "p",
  "pre",
  "section",
  "table",
  "tr",
  "ul",
]);

/** parse5 implements HTML's tree construction and entity rules; this adapter adds ingestion budgets. */
function boundedTreeAdapter(): TreeAdapter<DefaultTreeAdapterTypes.DefaultTreeAdapterMap> {
  let count = 0;
  const depth = new WeakMap<object, number>();
  function created<T extends object>(node: T): T {
    if (++count > 200_000)
      sourceImportFailure("project_source_import_html_node_limit");
    depth.set(node, 0);
    return node;
  }
  function child(parent: object, node: object) {
    const level = (depth.get(parent) ?? 0) + 1;
    if (level > 256)
      sourceImportFailure("project_source_import_html_depth_limit");
    depth.set(node, level);
  }
  return {
    ...defaultTreeAdapter,
    createDocument: () => created(defaultTreeAdapter.createDocument()),
    createDocumentFragment: () =>
      created(defaultTreeAdapter.createDocumentFragment()),
    createElement: (tag, namespace, attrs) =>
      created(defaultTreeAdapter.createElement(tag, namespace, attrs)),
    createCommentNode: (data) =>
      created(defaultTreeAdapter.createCommentNode(data)),
    createTextNode: (value) =>
      created(defaultTreeAdapter.createTextNode(value)),
    appendChild(parent, node) {
      child(parent, node);
      defaultTreeAdapter.appendChild(parent, node);
    },
    insertBefore(parent, node, before) {
      child(parent, node);
      defaultTreeAdapter.insertBefore(parent, node, before);
    },
    insertText(parent, text) {
      if (
        !parent.childNodes.at(-1) ||
        !defaultTreeAdapter.isTextNode(parent.childNodes.at(-1)!)
      )
        created({});
      defaultTreeAdapter.insertText(parent, text);
    },
    insertTextBefore(parent, text, before) {
      const previous = parent.childNodes[parent.childNodes.indexOf(before) - 1];
      if (!previous || !defaultTreeAdapter.isTextNode(previous)) created({});
      defaultTreeAdapter.insertTextBefore(parent, text, before);
    },
  };
}

class StoryText {
  readonly parts: string[] = [];
  length = 0;
  #bytes = 0;
  #last = "";
  #spacePending = false;

  boundary() {
    this.#spacePending = false;
    if (this.length > 0 && this.#last !== "\n") this.#append("\n");
  }
  text(text: string, preformatted: boolean) {
    if (preformatted) {
      if (this.#spacePending && this.length > 0 && this.#last !== "\n")
        this.#append(" ");
      this.#spacePending = false;
      this.#append(text.replace(/\r\n?/gu, "\n"));
      return;
    }
    const collapsed = text.replace(/[ \t\r\n\f\u00a0]+/gu, " ");
    const core = collapsed.replace(/^ +| +$/gu, "");
    if (!core) {
      if (this.length > 0 && this.#last !== "\n") this.#spacePending = true;
      return;
    }
    if (
      (this.#spacePending || collapsed.startsWith(" ")) &&
      this.length > 0 &&
      this.#last !== "\n"
    )
      this.#append(" ");
    this.#append(core);
    this.#spacePending = collapsed.endsWith(" ");
  }
  #append(text: string) {
    if (!text) return;
    this.#bytes += Buffer.byteLength(text);
    if (this.#bytes > 20_000_000)
      sourceImportFailure("project_source_import_text_limit");
    this.length += sourceScalarLength(text);
    this.parts.push(text);
    this.#last = text.at(-1)!;
  }
}

type Node = DefaultTreeAdapterTypes.Node;
type Frame = Readonly<{
  node: Node;
  pre: boolean;
  exit?: boolean;
  headingStart?: number;
  headingPart?: number;
}>;

/** Inert AST extraction: no DOM execution, stylesheet evaluation, URL fetching, or resource readers. */
export function sourceHtmlStory(
  text: string,
): Readonly<{ text: string; headings: readonly ProjectSourceHeading[] }> {
  const tree = parse(text, {
    scriptingEnabled: false,
    treeAdapter: boundedTreeAdapter(),
    onParseError(error) {
      if (
        [
          "null-character-reference",
          "surrogate-character-reference",
          "noncharacter-character-reference",
          "control-character-reference",
        ].includes(error.code)
      )
        sourceImportFailure("project_source_import_control_content");
    },
  });
  const writer = new StoryText();
  const headings: ProjectSourceHeading[] = [];
  const stack: Frame[] = [{ node: tree, pre: false }];
  while (stack.length) {
    const frame = stack.pop()!;
    const node = frame.node;
    const element = defaultTreeAdapter.isElementNode(node) ? node : null;
    if (frame.exit) {
      if (frame.headingStart !== undefined) {
        const title = writer.parts.slice(frame.headingPart!).join("").trim();
        addHeading(headings, title, frame.headingStart);
      }
      if (element && blocks.has(element.tagName)) writer.boundary();
      continue;
    }
    if (defaultTreeAdapter.isTextNode(node)) {
      writer.text(node.value, frame.pre);
      continue;
    }
    if (element) {
      if (
        excluded.has(element.tagName) ||
        element.attrs.some(
          (attr) =>
            attr.name === "hidden" ||
            (attr.name === "aria-hidden" &&
              attr.value.toLowerCase() === "true"),
        )
      )
        continue;
      if (element.tagName === "br") {
        writer.boundary();
        continue;
      }
      if (blocks.has(element.tagName)) writer.boundary();
    }
    if (!("childNodes" in node)) continue;
    const pre = frame.pre || element?.tagName === "pre";
    const heading = element !== null && /^h[1-6]$/u.test(element.tagName);
    stack.push({
      node,
      pre,
      exit: true,
      ...(heading
        ? { headingStart: writer.length, headingPart: writer.parts.length }
        : {}),
    });
    for (let index = node.childNodes.length - 1; index >= 0; index--)
      stack.push({ node: node.childNodes[index]!, pre });
  }
  return Object.freeze({
    text: writer.parts.join("").trimEnd(),
    headings: Object.freeze(headings),
  });
}
