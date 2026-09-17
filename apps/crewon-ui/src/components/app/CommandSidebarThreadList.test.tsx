// @ts-expect-error Vitest runs in Node; the browser bundle omits Node types.
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "../ui/tooltip";
import { CommandSidebarThreadList } from "./CommandSidebarThreadList";
import type { CommandLinkedThread } from "./CommandWorkspaceChrome";

const threads: CommandLinkedThread[] = Array.from(
  { length: 8 },
  (_, index) => ({
    id: `thread-${index}`,
    cwd: "/workspace",
    title: `会话 ${index}`,
    preview: "",
    updatedAt: 100 - index,
    updatedLabel: "刚刚",
  }),
);
function renderList({ expanded = false, items = threads } = {}) {
  return renderToStaticMarkup(
    <TooltipProvider>
      <CommandSidebarThreadList
        threads={items}
        expanded={expanded}
        onToggleExpanded={vi.fn()}
        selectedThreadId="thread-7"
        archiveLabel="归档会话"
        onArchive={vi.fn()}
        onOpen={vi.fn()}
        workspaceLabel="测试空间"
        showMoreLabel={(count) => `展开更多（${count}）`}
        showFewerLabel="收起"
      />
    </TooltipProvider>,
  );
}
const renderedIds = (markup: string) =>
  Array.from(
    markup.matchAll(/data-linked-thread-id="([^"]+)"/g),
    (match) => match[1],
  );

describe("workspace recent conversations", () => {
  it("defaults to the first five in the supplied recency order with an accessible disclosure", () => {
    const markup = renderList();
    expect(renderedIds(markup)).toEqual(
      threads.slice(0, 5).map((thread) => thread.id),
    );
    expect(markup).toContain("展开更多（3）");
    expect(markup).toContain('aria-expanded="false"');
    const controlledId = markup.match(/aria-controls="([^"]+)"/)?.[1];
    expect(controlledId).toBeTruthy();
    expect(markup).toContain(`id="${controlledId}" hidden=""`);
    expect(markup).toMatchSnapshot();
  });
  it("shows all older conversations in order, including selection and archive actions", () => {
    const markup = renderList({ expanded: true });
    expect(renderedIds(markup)).toEqual(threads.map((thread) => thread.id));
    expect(markup).toContain('aria-expanded="true"');
    expect(markup).toContain('aria-label="测试空间：收起"');
    expect(markup).toContain('data-selected="true"');
    expect(markup).toContain('data-archive-thread-id="thread-7"');
    expect(renderedIds(renderList())).toHaveLength(5);
    expect(threads).toHaveLength(8);
    expect(markup).toMatchSnapshot();
  });
  it.each([0, 1, 5])(
    "omits unnecessary disclosure for %i conversations",
    (count) => {
      const markup = renderList({
        items: threads.slice(0, count),
        expanded: true,
      });
      expect(renderedIds(markup)).toHaveLength(count);
      expect(markup).not.toContain("sidebar-threads-disclosure");
    },
  );
  it("uses compact sidebar styling with explicit hidden and keyboard-focus states", () => {
    expect(
      readFileSync(
        new URL("./CommandSidebarThreadList.css", import.meta.url),
        "utf8",
      ),
    ).toMatchSnapshot();
  });
});
