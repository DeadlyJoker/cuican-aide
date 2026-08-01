import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { CommandTeamCapabilityCreateDialog } from "./CommandTeamCapabilityCreateDialog";

describe("CommandTeamCapabilityCreateDialog", () => {
  it.each(["workflow" as const, "experts" as const])(
    "snapshots the %s creation boundary",
    (kind) => {
      const workspaceCwd =
        kind === "workflow" ? "/repo/team" : "/repo/single-chat";
    const markup = renderToStaticMarkup(
      <CommandTeamCapabilityCreateDialog
        kind={kind}
        workspaceCwd={workspaceCwd}
        onClose={vi.fn()}
        onSubmit={vi.fn()}
      />,
    );

      if (kind === "workflow") {
        expect(markup).toContain("云端执行边界");
        expect(markup).toContain("Agent Platform 云端");
        expect(markup).not.toContain(workspaceCwd);
      } else {
        expect(markup).toContain("团长单聊工作空间");
        expect(markup).toContain(workspaceCwd);
      }
    expect(markup).toMatchSnapshot();
    },
  );
});
