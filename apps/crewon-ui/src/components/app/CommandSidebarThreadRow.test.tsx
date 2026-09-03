import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { CommandTaskStatusIndicator } from "./CommandSidebarThreadRow";
import type { CommandSidebarThreadState } from "./commandSidebarThreadPresentation";

function renderIndicator(state: CommandSidebarThreadState): string {
  return renderToStaticMarkup(
    <CommandTaskStatusIndicator
      label={state}
      state={state}
      updatedLabel="刚刚"
    />,
  );
}

describe("CommandTaskStatusIndicator", () => {
  it("renders only unread completion, interaction, and failure as lights", () => {
    const markup = {
      completedUnread: renderIndicator("completedUnread"),
      completedViewed: renderIndicator("completedViewed"),
      failedUnread: renderIndicator("failedUnread"),
      failedViewed: renderIndicator("failedViewed"),
      pendingUnread: renderIndicator("pendingUnread"),
      pendingViewed: renderIndicator("pendingViewed"),
      running: renderIndicator("running"),
    };

    expect(markup.completedUnread).toContain("is-completed-unread");
    expect(markup.failedUnread).toContain("is-failed-unread");
    expect(markup.pendingUnread).toContain("is-pending-unread");
    expect(markup.completedViewed).toContain("command-thread-status-time");
    expect(markup.failedViewed).toContain("command-thread-status-time");
    expect(markup.pendingViewed).toContain("command-thread-status-time");
    expect(markup.running).toContain("command-thread-status-time");
    expect(markup).toMatchSnapshot();
  });
});
