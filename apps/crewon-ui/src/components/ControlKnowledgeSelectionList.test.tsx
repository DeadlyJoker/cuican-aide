import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ControlKnowledgeSelectionList } from "./ControlKnowledgeSelectionList";

describe("ControlKnowledgeSelectionList", () => {
  it("snapshots immutable selections as visibly non-executable", () => {
    const markup = renderToStaticMarkup(
      <ControlKnowledgeSelectionList
        selections={[
          {
            executable: false,
            reason: "durable_knowledge_reference_not_supported",
            reference: {
              contentDigest: "sha256:knowledge-1",
              knowledgeId: "knowledge-1",
            },
            sourceId: "thread:thread-1",
            title: "Launch decision",
          },
        ]}
      />,
    );
    expect(markup).toMatchSnapshot();
    expect(markup).toContain("disabled");
    expect(markup).toContain("暂不可用于任务");
  });

  it("omits the section when Control has no Knowledge resources", () => {
    expect(
      renderToStaticMarkup(<ControlKnowledgeSelectionList selections={[]} />),
    ).toBe("");
  });
});
