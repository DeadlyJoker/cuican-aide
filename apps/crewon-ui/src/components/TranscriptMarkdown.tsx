import type { ReactNode } from "react";

function renderInlineMarkdown(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index));
    }

    const token = match[0];
    if (token.startsWith("`")) {
      nodes.push(<code key={`${match.index}-code`}>{token.slice(1, -1)}</code>);
    } else {
      nodes.push(
        <strong key={`${match.index}-strong`}>{token.slice(2, -2)}</strong>,
      );
    }
    lastIndex = match.index + token.length;
  }

  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }

  return nodes;
}

function flushParagraph(blocks: ReactNode[], lines: string[], key: string) {
  if (lines.length === 0) {
    return;
  }

  blocks.push(<p key={key}>{renderInlineMarkdown(lines.join(" "))}</p>);
  lines.length = 0;
}

export function renderMarkdown(text: string) {
  const blocks: ReactNode[] = [];
  const paragraphLines: string[] = [];
  const listItems: string[] = [];
  const orderedItems: string[] = [];
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let codeLines: string[] | undefined;

  function flushLists(index: number) {
    if (listItems.length > 0) {
      blocks.push(
        <ul key={`ul-${index}`}>
          {listItems.splice(0).map((item, itemIndex) => (
            <li key={itemIndex}>{renderInlineMarkdown(item)}</li>
          ))}
        </ul>,
      );
    }

    if (orderedItems.length > 0) {
      blocks.push(
        <ol key={`ol-${index}`}>
          {orderedItems.splice(0).map((item, itemIndex) => (
            <li key={itemIndex}>{renderInlineMarkdown(item)}</li>
          ))}
        </ol>,
      );
    }
  }

  lines.forEach((line, index) => {
    if (line.trim().startsWith("```")) {
      if (codeLines !== undefined) {
        blocks.push(<pre key={`code-${index}`}>{codeLines.join("\n")}</pre>);
        codeLines = undefined;
        return;
      }

      flushParagraph(blocks, paragraphLines, `p-${index}`);
      flushLists(index);
      codeLines = [];
      return;
    }

    if (codeLines !== undefined) {
      codeLines.push(line);
      return;
    }

    const trimmed = line.trim();
    if (!trimmed) {
      flushParagraph(blocks, paragraphLines, `p-${index}`);
      flushLists(index);
      return;
    }

    const heading = /^(#{1,3})\s+(.+)$/.exec(trimmed);
    if (heading) {
      flushParagraph(blocks, paragraphLines, `p-${index}`);
      flushLists(index);
      const level = heading[1].length;
      const content = renderInlineMarkdown(heading[2]);
      blocks.push(
        level === 1 ? (
          <h3 key={`h-${index}`}>{content}</h3>
        ) : (
          <h4 key={`h-${index}`}>{content}</h4>
        ),
      );
      return;
    }

    const unordered = /^[-*]\s+(.+)$/.exec(trimmed);
    if (unordered) {
      flushParagraph(blocks, paragraphLines, `p-${index}`);
      if (orderedItems.length > 0) {
        flushLists(index);
      }
      listItems.push(unordered[1]);
      return;
    }

    const ordered = /^\d+\.\s+(.+)$/.exec(trimmed);
    if (ordered) {
      flushParagraph(blocks, paragraphLines, `p-${index}`);
      if (listItems.length > 0) {
        flushLists(index);
      }
      orderedItems.push(ordered[1]);
      return;
    }

    if (trimmed.startsWith(">")) {
      flushParagraph(blocks, paragraphLines, `p-${index}`);
      flushLists(index);
      blocks.push(
        <blockquote key={`quote-${index}`}>
          {renderInlineMarkdown(trimmed.replace(/^>\s?/, ""))}
        </blockquote>,
      );
      return;
    }

    paragraphLines.push(trimmed);
  });

  if (codeLines !== undefined) {
    blocks.push(<pre key="code-final">{codeLines.join("\n")}</pre>);
  }
  flushParagraph(blocks, paragraphLines, "p-final");
  flushLists(lines.length);

  return <div className="markdown-content">{blocks}</div>;
}
