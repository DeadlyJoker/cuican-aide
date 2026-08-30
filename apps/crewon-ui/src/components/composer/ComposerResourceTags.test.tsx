import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { ComposerResourceTags } from "./ComposerResourceTags";

describe("ComposerResourceTags", () => {
  it("renders distinct removable file and image tags", () => {
    const markup = renderToStaticMarkup(
      <ComposerResourceTags
        resources={[
          {
            id: "/repo/README.md",
            kind: "file",
            label: "文件",
            name: "README.md",
          },
          {
            id: "/repo/docs",
            kind: "folder",
            label: "文件夹",
            name: "docs",
          },
          {
            id: "agent-platform://knowledge_bases/10",
            kind: "knowledge",
            label: "知识库",
            name: "产品知识库",
          },
          { id: "clipboard-1", kind: "image", label: "图片", name: "截图.png" },
        ]}
        onRemove={vi.fn()}
      />,
    );

    expect(markup).toMatchSnapshot();
  });
});
