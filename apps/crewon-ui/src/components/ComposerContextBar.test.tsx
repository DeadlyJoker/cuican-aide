import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { ComposerContextBar } from "./ComposerContextBar";

describe("ComposerContextBar", () => {
  it("omits unavailable thread settings in the Control-only composition", () => {
    const markup = renderToStaticMarkup(
      <ComposerContextBar
        connectionStatusLabel="Connected"
        connectionTone="connected"
        cwd="/repo/frontend"
        noWorkspaceSelectedLabel="No workspace"
        retryConnectionLabel="Retry"
        threadSettingsLabel="Thread settings"
        onRetryConnection={vi.fn()}
        onThreadSettings={null}
      />,
    );

    expect(markup).not.toContain("Thread settings");
    expect(markup).toMatchSnapshot();
  });
});
