import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { CommandTeamCapabilityCreateDialog } from "./CommandTeamCapabilityCreateDialog";

describe("CommandTeamCapabilityCreateDialog", () => {
  it.each([
    ["workflow" as const, "/repo/team", "群聊运行工作空间"],
    ["experts" as const, "/repo/single-chat", "团长单聊工作空间"],
  ])("snapshots the %s creation boundary", (kind, workspaceCwd, label) => {
    const markup = renderToStaticMarkup(
      <CommandTeamCapabilityCreateDialog
        kind={kind}
        workspaceCwd={workspaceCwd}
        onClose={vi.fn()}
        onSubmit={vi.fn()}
      />,
    );

    expect(markup).toContain(label);
    expect(markup).toContain(workspaceCwd);
    expect(markup).toMatchSnapshot();
  });
});
