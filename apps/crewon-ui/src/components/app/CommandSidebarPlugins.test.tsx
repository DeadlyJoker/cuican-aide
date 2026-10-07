// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { CommandSidebarPlugins } from "./CommandSidebarPlugins";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
it("collapses plugins without navigating, retains the selected module, and reveals an externally selected module", async () => {
  const container = document.createElement("div"),
    root = createRoot(container),
    onOpen = vi.fn();
  const render = async (active: boolean) =>
    act(async () =>
      root.render(
        <CommandSidebarPlugins
          locale="zh"
          modules={[{ id: "short", label: "AI 短剧", active, onOpen }]}
        />,
      ),
    );
  try {
    await render(false);
    const toggle = container.querySelector<HTMLButtonElement>(
      "button[aria-expanded]",
    )!;
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    await act(async () => toggle.click());
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('[data-host-module-target="short"]')!
        .click(),
    );
    expect(onOpen).toHaveBeenCalledTimes(1);
    await render(true);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelector('[aria-current="page"]')?.textContent).toBe(
      "AI 短剧",
    );
    await act(async () => toggle.click());
    await render(true);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.textContent).toContain("AI 短剧");
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(
      container.innerHTML.replace(
        /id="[^"]+"|aria-controls="[^"]+"/g,
        'id="group"',
      ),
    ).toMatchSnapshot();
  } finally {
    await act(async () => root.unmount());
  }
});
