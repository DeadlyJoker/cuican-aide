import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { CapabilityDock } from "./CapabilityDock";

describe("CapabilityDock", () => {
  it("renders actionable pushed panels without a legacy tool launcher", () => {
    const markup = renderToStaticMarkup(
      <CapabilityDock
        locale="en"
        panel={{
          actions: [{ id: "approve", label: "Approve", tone: "primary" }],
          body: "Waiting for approval.",
          title: "Approval request",
        }}
        onPanelAction={vi.fn()}
      />,
    );

    expect(markup).toContain("Approval request");
    expect(markup).toContain("Approve");
    expect(markup).not.toContain('role="toolbar"');
    expect(markup).not.toMatch(/Terminal|Browser|Files|Review|Side chat/);
  });

  it("does not expose legacy terminal panels", () => {
    const markup = renderToStaticMarkup(
      <CapabilityDock
        locale="en"
        panel={{ body: "shell", commandInput: true, title: "Terminal" }}
      />,
    );

    expect(markup).toContain("No available panel");
    expect(markup).not.toContain("capability-command-form");
    expect(markup).not.toContain(">Terminal<");
  });
});
